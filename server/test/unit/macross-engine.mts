// The moving-average crossover, end to end, against the real engine with a fake market and a
// scripted AI: the signal must reach the AI on every chart from 1 minute up (not the 5-second
// chart), be listed with the chart patterns and its record, be saved with the plan for the app,
// be replayed in an agent's study of its coin, and come back from the endpoint's function.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-"));
process.chdir(dir);
delete process.env.VERCEL;
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS/.test(k)) delete process.env[k];
process.env.ANTHROPIC_API_KEY = "fake";
process.env.ANTHROPIC_BASE_URL = "http://fake-claude.local";

const POOL = "MaPool11111", MINT = "MaMint11111pump";
const price = 1.0;
const N = 300;
// Two price paths (index -> price). "v": falls for a long time, then climbs (the fast average
// crosses UP some candles after the low). "peak": climbs, then falls (it crosses DOWN after the top).
const v = (j: number) => (j < 400 ? 2 - j * 0.002 : 1.2 + (j - 400) * 0.004);
const peak = (j: number) => (j < 400 ? 1 + j * 0.002 : 1.8 - (j - 400) * 0.004);
const sma = (f: (j: number) => number, n: number, i: number) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += f(k); return s / n; };
const crossAt = (f: (j: number) => number, up: boolean) => { for (let i = 401; i < 700; i++) { const a = sma(f, 20, i - 1) - sma(f, 50, i - 1), b = sma(f, 20, i) - sma(f, 50, i); if (up ? a <= 0 && b > 0 : a >= 0 && b < 0) return i; } throw new Error("no crossover in the test path"); };
const UP = crossAt(v, true), DOWN = crossAt(peak, false);
// Which path each chart shows, and how many closed candles ago its crossover happened.
const CHARTS: Record<string, { f: (j: number) => number; at: number; ago: number; n: number }> = {
  "5s": { f: v, at: UP, ago: 0, n: N },
  "1min": { f: peak, at: DOWN, ago: 5, n: N },
  "5min": { f: v, at: UP, ago: 0, n: N },
  "1h": { f: v, at: UP, ago: 40, n: N },
  "1d": { f: v, at: UP, ago: 0, n: 40 }, // a young coin: too few daily candles for the 50-candle average
};
const STEP: Record<string, number> = { "5s": 5_000, "1min": 60_000, "5min": 300_000, "1h": 3_600_000, "1d": 86_400_000 };

const bodies: { system: string; user: string }[] = [];
const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json" } });
const dexPair = () => ({ chainId: "solana", dexId: "test", pairAddress: POOL, baseToken: { address: MINT, symbol: "MAT", name: "Ma Test" }, priceUsd: String(price), priceChange: { m5: 1.2, h1: 4, h24: 9 }, volume: { m5: 95_000, h1: 520_000, h24: 3e6 }, txns: { h1: { buys: 900, sells: 600 } }, liquidity: { usd: 400_000 }, marketCap: 5e6 });
const jupToken = () => ({ id: MINT, symbol: "MAT", name: "Ma Test", icon: "", usdPrice: price, mcap: 5e6, fdv: 5e6, liquidity: 400_000, holderCount: 4200, organicScore: 72, graduatedAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18, devBalancePercentage: 0.5, devMints: 1 },
  stats5m: { priceChange: 1.2, holderChange: 0.6, liquidityChange: 0.4, buyVolume: 60_000, sellVolume: 35_000, numOrganicBuyers: 30, numTraders: 400 },
  stats1h: { priceChange: 4, holderChange: 3, buyVolume: 300_000, sellVolume: 220_000, buyOrganicVolume: 40_000, sellOrganicVolume: 30_000, numOrganicBuyers: 80, numTraders: 1500 }, tags: ["verified"] });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("fake-claude.local")) {
    const req = JSON.parse(String(init?.body ?? "{}"));
    const system = typeof req.system === "string" ? req.system : JSON.stringify(req.system ?? "");
    const user = JSON.stringify(req.messages ?? "");
    bodies.push({ system, user });
    const out = user.includes("independent forecasters")
      ? { chances: [60, 60], reason: "Test forecaster." }
      : { stance: "WAIT_FOR_TRIGGER", confidence: 60, riskLevel: "MEDIUM", reasoning: "Test plan.", orders: [{ kind: "buy_breakout", triggerPrice: price * 1.05, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: price * 1.0, target: price * 1.2, maxHoldMinutes: 120, winChancePct: 40 }], cancelBelow: 0, cancelAbove: 0, validMinutes: 30 };
    return json({ id: `m${bodies.length}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }
  if (url.includes("api.jup.ag/tokens/v2/")) return json([jupToken()]);
  if (url.includes("api.dexscreener.com/tokens/v1/solana/")) return json([dexPair()]);
  if (url.includes("api.dexscreener.com/latest/dex/pairs")) return json({ pairs: [dexPair()] });
  if (url.includes("coinmarketcap.com")) {
    const interval = new URL(url).searchParams.get("interval") ?? "5min";
    const ch = CHARTS[interval] ?? CHARTS["5min"], step = STEP[interval] ?? 300_000;
    const last = Math.floor(Date.now() / step) * step; // the candle that is forming now
    const newestClosed = ch.at + ch.ago; // path index shown on the newest closed candle
    const scale = price / ch.f(newestClosed);
    const rows = Array.from({ length: ch.n }, (_, i) => {
      const t = last - (ch.n - 1 - i) * step;
      if (i === ch.n - 1) return [price, price * 1.001, price * 0.999, price, 900, t, 5]; // forming candle, at the live price
      const j = newestClosed - (ch.n - 2 - i);
      const c = ch.f(j) * scale, o = ch.f(j - 1) * scale;
      return [o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c, 800, t, 5];
    });
    return json({ data: rows, status: { error_code: "0" } });
  }
  if (url.includes("geckoterminal.com")) return new Response("{}", { status: 503 });
  return realFetch(input, init);
}) as typeof fetch;

const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
const { fetchMaCrossover } = await import(new URL("../../src/macross.ts", import.meta.url).href);
const { findPatterns, patternTags } = await import(new URL("../../src/patterns.ts", import.meta.url).href);
const { learn } = await import(new URL("../../src/learn.ts", import.meta.url).href);
const { getCandles } = await import(new URL("../../src/data.ts", import.meta.url).href);
let pass = 0, fail = 0;
const expect = (name: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await engine.sync();
engine.reset(10_000);

// ---- 1. Your own Analyze: what the AI is given, and what is saved for the app ----
const r: any = await engine.runAnalysis("solana", POOL, "5m");
const plan = bodies.find((b) => b.user.includes("Chart data on several timeframes"))!;
const text = JSON.parse(plan.user).map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("\n"))).join("\n");
const section = (label: string) => { const i = text.indexOf(`## ${label}`); if (i < 0) return ""; const j = text.indexOf("\n## ", i + 3); return text.slice(i, j < 0 ? i + 4000 : j).split("\nLast ")[0]; };
const line = (label: string) => section(label).split("\n").find((l: string) => l.startsWith("Moving-average crossover")) ?? "";
expect("5-minute chart: BUY signal on the newest closed candle reaches the AI", /^Moving-average crossover \(20- and 50-candle averages of the closes, closed candles only\): BUY signal on the newest closed candle \| MA20 [\d.]+ MA50 [\d.]+: fast is [\d.]+% above slow$/.test(line("5-minute")), true);
expect("1-minute chart: no signal now, a SELL crossover 5 candles ago", /: no crossover on the newest closed candle \| MA20 [\d.]+ MA50 [\d.]+: fast is [\d.]+% below slow \| last crossover: SELL 5 candles ago at [\d.]+$/.test(line("1-minute")), true);
expect("1-hour chart: fast above slow, the BUY crossover was 40 candles ago", /fast is [\d.]+% above slow \| last crossover: BUY 40 candles ago at [\d.]+$/.test(line("1-hour")), true);
expect("5-second chart: no crossover line (noise there)", { has5s: section("5-second").length > 0, line: line("5-second") }, { has5s: true, line: "" });
expect("1-day chart with 40 candles: no line (too little history)", { has1d: section("1-day").length > 0, line: line("1-day") }, { has1d: true, line: "" });
console.log("     5m:", line("5-minute"));
console.log("     1m:", line("1-minute"));
console.log("     1h:", line("1-hour"));
expect("the AI's standing instructions explain the signal", plan.system.includes("A moving-average crossover signal is given on every chart from 1 minute up") && plan.system.includes("never buy or sell on it alone"), true);
const patLine = text.split("\n").find((l: string) => l.startsWith("- 5m: Moving averages crossed up")) ?? "";
expect("listed with the chart patterns, with when it happened", /^- 5m: Moving averages crossed up \(20 over 50\): BUY signal \(bullish\): the 20-candle average \([\d.]+\) crossed above the 50-candle average \([\d.]+\) on the newest closed candle\./.test(patLine), true);
console.log("    ", patLine.slice(0, 330));
const brief = (m: any) => ({ tf: m.tf, signal: m.signal, trend: m.trend, last: m.last ? `${m.last.signal} ${m.last.candlesAgo}` : null });
const wantViews = [{ tf: "1m", signal: "HOLD", trend: "down", last: "SELL 5" }, { tf: "5m", signal: "BUY", trend: "up", last: "BUY 0" }, { tf: "1h", signal: "HOLD", trend: "up", last: "BUY 40" }];
expect("the analysis returns the signal for each chart", (r.maCross ?? []).map(brief), wantViews);
expect("and it is saved with the plan for the app", ((engine.getState().lastSignal as any)?.maCross ?? []).map(brief), wantViews);
expect("the app's pattern chips get it too", patternTags(r.patterns).filter((t: string) => t.includes("Moving averages")), ["1m Moving averages crossed down ↓", "5m Moving averages crossed up ↑"].filter((t) => t.startsWith("5m")));

// ---- 2. The pattern finder: closed candles only, a few candles of memory, never on second charts ----
const c5 = await getCandles("solana", POOL, "5m", 300);
const hit = (tf: string, cs: any[]) => findPatterns(tf, cs).hits.find((h: any) => h.key === "ma_cross_up");
expect("crossover on the newest closed candle (a forming candle on top)", hit("5m", c5)?.note.endsWith("on the newest closed candle"), true);
const nowS = Math.floor(Date.now() / 1000);
const later = (k: number) => { // k more closed candles after the crossover, then a forming one
  const body = c5.slice(0, -1), lastT = body[body.length - 1].time, p = body[body.length - 1].close;
  const extra = Array.from({ length: k }, (_, i) => ({ time: lastT + (i + 1) * 300, open: p, high: p * 1.01, low: p * 0.999, close: p * 1.01, volume: 800 }));
  const shift = k * 300; // keep the newest candle "forming now"
  return [...body, ...extra, { time: lastT + (k + 1) * 300, open: p, high: p, low: p, close: p, volume: 1 }].map((c) => ({ ...c, time: c.time - shift }));
};
expect("two closed candles later it is still listed, with how long ago", hit("5m", later(2))?.note.endsWith("2 closed candles ago"), true);
expect("three closed candles later it is no longer 'now'", hit("5m", later(3)), undefined);
expect("never on a 5-second chart", findPatterns("5s", c5).hits.some((h: any) => h.key.startsWith("ma_cross")), false);
void nowS;

// ---- 3. The agents' study of the coin replays the crossover with their own stop and minimum profit ----
const c1h = await getCandles("solana", POOL, "1h", 300);
const L = learn([{ tf: "5m", candles: c5 }, { tf: "1h", candles: c1h }], 3, 5);
const rows = L.table.filter((t: any) => t.key === "macross");
expect("the study has a row for the crossover", rows.map((t: any) => `${t.label} on ${t.tf}`).sort(), ["Moving-average crossover (20/50) on 1h", "Moving-average crossover (20/50) on 5m"].filter((x) => rows.some((t: any) => x.endsWith(t.tf))));
expect("at least one crossover row", rows.length >= 1, true);
console.log("     study rows:", rows.map((t: any) => `${t.tf}: ${t.trades} past trades, ${t.wins} reached +5%, average ${t.avgNetPct.toFixed(1)}%`).join(" | "));

// ---- 4. The endpoint's function: the payload for a market ----
const p: any = await fetchMaCrossover("solana", POOL, "5m");
expect("payload: BUY with both averages, from the last 100 closed candles", { signal: p.signal, ready: p.ready, used: p.used, kind: p.kind, fastPeriod: p.fastPeriod, slowPeriod: p.slowPeriod, trend: p.trend, crossedUp: p.prevFast <= p.prevSlow && p.fast > p.slow, tf: p.tf, source: p.source, lastCross: p.lastCross?.candlesAgo }, { signal: "BUY", ready: true, used: 100, kind: "sma", fastPeriod: 20, slowPeriod: 50, trend: "up", crossedUp: true, tf: "5m", source: "CoinMarketCap", lastCross: 0 });
console.log("     payload:", JSON.stringify({ ...p, note: undefined }).slice(0, 420));
console.log("     note:", p.note);
const e: any = await fetchMaCrossover("solana", POOL, "1m", { kind: "ema", fast: 9, slow: 21 });
expect("other settings are accepted (EMA 9/21 on 1m)", [e.kind, e.fastPeriod, e.slowPeriod, e.ready, e.tf], ["ema", 9, 21, true, "1m"]);

// ---- 5. An agent: its brief carries the study's crossover rows, its plan the signal ----
engine.reset(1000);
bodies.length = 0;
engine.startBot({ chain: "solana", pool: POOL, symbol: "MAT", tf: "5m", positionPct: 100, minConfidence: 45, analyzeEverySec: 1800, checkEverySec: 5, maxDrawdownPct: 25, goalUsd: 1e9, pick: "agent", budgetUsd: 1000, trailPct: 3, riskPerTradePct: 0, dailyLossPct: 10, cooldownMin: 30, breakEvenAtPct: 6, lockPct: 50, strongMode: true, rewardRule: true, disabled: [] } as any);
for (let i = 0; i < 160 && !bodies.some((b) => b.user.includes("dedicated trading agent")); i++) await sleep(250);
const agentBody = bodies.find((b) => b.user.includes("dedicated trading agent"));
expect("the agent's AI is asked", !!agentBody, true);
const at = JSON.parse(agentBody?.user ?? "[]").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("\n"))).join("\n");
expect("its brief lists how the crossover did on this coin", /- Moving-average crossover \(20\/50\) on (5m|1h): \d+ past trades?, \d+ reached \+5% before the stop/.test(at), true);
expect("its charts carry the signal", at.includes("BUY signal on the newest closed candle"), true);
expect("its instructions explain it", (agentBody?.system ?? "").includes("A moving-average crossover signal is given on every chart from 1 minute up") && (agentBody?.system ?? "").includes("Never buy on it alone"), true);
for (let i = 0; i < 80 && !(engine.getState().lastSignal as any)?.maCross; i++) await sleep(250);
expect("the agent's plan keeps the signal for its window", ((engine.getState().lastSignal as any)?.maCross ?? []).map(brief), wantViews);
engine.stopBot("test over");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
