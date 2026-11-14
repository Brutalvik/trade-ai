// Engine scenario: the real bot engine runs against a fake market and a scripted AI, in real
// 5-second steps. Started by test/run.mts with SC=<scenario>.
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SC = process.env.SC ?? "win";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-"));
process.chdir(dir);
delete process.env.VERCEL;
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS/.test(k)) delete process.env[k];
process.env.ANTHROPIC_API_KEY = "fake";
process.env.ANTHROPIC_BASE_URL = "http://fake-claude.local";

let offset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + offset;
const POOL = "AgentPool1111", MINT = "AgentMint1111pump";
let price = 1.0;
const B = () => (price < 0.95 ? price : 1.0); // the fake AI's order levels: fixed around $1.00, or around a clearly lower price
let aiCalls = 0;
let panelCalls = 0;
let planCalls = 0;
let briefSeen = false;
let profitCalls = 0;
let profitPrompt = "";

const jupToken = () => ({
  id: MINT, symbol: "AGT", name: "Agent Test", icon: "", usdPrice: price, mcap: 5e6, fdv: 5e6, liquidity: 400_000, holderCount: 4200,
  organicScore: 72, graduatedAt: new Date(realNow() - 20 * 3600_000).toISOString(),
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18, devBalancePercentage: 0.5, devMints: 1 },
  stats5m: { priceChange: 1.2, holderChange: 0.6, liquidityChange: 0.4, buyVolume: 60_000, sellVolume: 35_000, numOrganicBuyers: 30, numTraders: 400 },
  stats1h: { priceChange: 14, holderChange: 3, buyVolume: 300_000, sellVolume: 220_000, buyOrganicVolume: 40_000, sellOrganicVolume: 30_000, numOrganicBuyers: 80, numTraders: 1500 },
  tags: ["verified"],
});
const dexPair = () => ({ chainId: "solana", dexId: "test", pairAddress: POOL, baseToken: { address: MINT, symbol: "AGT", name: "Agent Test" }, priceUsd: String(price), priceChange: { m5: 1.2, h1: 14, h24: 30 }, volume: { m5: 95_000, h1: 520_000, h24: 3e6 }, txns: { h1: { buys: 900, sells: 600 } }, liquidity: { usd: 400_000 }, marketCap: 5e6 });

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("fake-claude.local")) {
    aiCalls++;
    const body = String(init?.body ?? "");
    if (body.includes("independent forecasters")) {
      panelCalls++;
      const pv = Number(process.env.PANEL ?? 70);
      return json({ id: `v${aiCalls}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify({ chances: [pv, pv], reason: "Test forecaster." }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    const approve = SC !== "reject";
    if (body.includes("managing an open trade that is in profit")) {
      profitCalls++;
      if (!profitPrompt) profitPrompt = JSON.parse(body).messages[0].content;
      if (SC === "noai") return new Response("overloaded", { status: 500 });
      const sellNow = SC === "ride" && price >= 1.2;
      const dec = sellNow
        ? { action: "SELL_NOW", exitPrice: 0, trailPct: 2, targetPrice: 0, recheckSeconds: 30, confidence: 20, reason: "Rejected at 1.21 with sellers taking over: the push is done." }
        : { action: "HOLD", exitPrice: SC === "raise" ? price * 0.985 : 0, trailPct: 3, targetPrice: price * 1.1, recheckSeconds: 20, confidence: 68, reason: "Higher lows and buyers in control: give it room." };
      return json({ id: `p${aiCalls}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify(dec) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    const out = body.includes("Scouting agents")
      ? { approve, winChancePct: approve ? 58 : 30, reason: approve ? "Clean uptrend with real buyers and room to the target." : "Fading volume under resistance." }
      : body.includes("manage the exit")
        ? { hold: false, winChancePct: 20, target: 1.1, lastExit: 0.9, extraMinutes: 10, reason: "Support broke." }
        : SC === "avoid"
          ? { stance: "AVOID", confidence: 30, riskLevel: "HIGH", reasoning: "Fading volume under resistance; no edge right now.", orders: [{ kind: "buy_dip", triggerPrice: price * 0.9, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: price * 0.84, target: price * 1.03, maxHoldMinutes: 120, winChancePct: 30 }], cancelBelow: 0, cancelAbove: 0, validMinutes: 30 }
          : planCalls >= 1
            ? { stance: "AVOID", confidence: 20, riskLevel: "HIGH", reasoning: "Test: one trade only.", orders: [], cancelBelow: 0, cancelAbove: 0, validMinutes: 30 }
          : (planCalls++, briefSeen = briefSeen || body.includes("dedicated trading agent"), { stance: "BUY_NOW", confidence: 70, riskLevel: "MEDIUM", reasoning: "Breakout holding on rising volume with room above.", orders: [{ kind: "buy_now", triggerPrice: B() * 1.002, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: B() * 0.95, target: B() * 1.15, maxHoldMinutes: 180, winChancePct: Number(process.env.AIWIN ?? 62) }], cancelBelow: 0, cancelAbove: 0, validMinutes: 60 });
    return json({ id: `m${aiCalls}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }
  if (url.includes("api.jup.ag/swap/")) return new Response("{}", { status: 503 }); // no Jupiter quotes in tests: costs come from the fake pool's depth
  if (url.includes("api.jup.ag/tokens/v2/")) return json([jupToken()]);
  if (url.includes("api.dexscreener.com/tokens/v1/solana/")) return json([dexPair()]);
  if (url.includes("api.dexscreener.com/latest/dex/pairs")) return json({ pairs: [dexPair()] });
  if (url.includes("coinmarketcap.com")) {
    const interval = new URL(url).searchParams.get("interval");
    const step = interval === "5s" ? 5_000 : interval === "1min" ? 60_000 : interval === "1h" ? 3_600_000 : interval === "1d" ? 86_400_000 : 300_000;
    const now = Date.now();
    const last = Math.floor(now / step) * step;
    const N = 300, CYC = 44;
    // shape[k] = price multiple inside one cycle: 24 flat candles, a breakout, a rally, a drift back
    const shape = (k: number) => process.env.QUIET ? 1 + Math.sin(k * 2.1) * 0.002 : k < 24 ? 1 + Math.sin(k * 2.1) * 0.004 : k === 24 ? 1.03 : k < 33 ? 1.03 + (k - 24) * 0.02 : 1.19 - (k - 33) * (0.19 / 11);
    const rows = Array.from({ length: N }, (_, i) => {
      const t = last - (N - 1 - i) * step;
      if (interval === "5s") return [price, price, price, price, 900, t, 5]; // 5-second candles follow the live price
      if (i === N - 1) return [price, price * 1.002, price * 0.998, price, 900, t, 5]; // forming candle
      const k = ((i - (N - 2 - 24)) % CYC + CYC) % CYC; // the newest closed candle (N-2) is a breakout (k = 24)
      const scale = price / 1.03;
      const c = shape(k) * scale, o = shape(k === 0 ? 0 : k - 1) * scale;
      return [o, Math.max(o, c) * 1.002, Math.min(o, c) * 0.998, c, k === 24 ? 4000 : 800, t, 5];
    });
    return json({ data: rows, status: { error_code: "0" } });
  }
  if (url.includes("geckoterminal.com")) return new Response("{}", { status: 503 });
  return realFetch(input, init);
}) as typeof fetch;

const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
await engine.sync();
engine.reset(10_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s`;
let seen = 0;
const showLogs = () => {
  const log = engine.getState().bot.log;
  for (const l of log.slice(0, log.length - seen).reverse()) if (!/^Bot (started|stopped)/.test(l.msg)) console.log(`   ${at()}  log: ${l.msg}`);
  seen = log.length;
};
const step = async (secs: number, note: string, p: number) => {
  price = p;
  console.log(`${at()} price ${p}  [${note}]`);
  for (let i = 0; i < secs * 4; i++) { await sleep(250); showLogs(); }
};

const waitPlan = async (note: string, need: () => boolean, max = 70) => {
  price = 1.0;
  console.log(`${at()} price 1  [${note}]`);
  let i = 0;
  for (; i < max * 4 && !need(); i++) { await sleep(250); showLogs(); }
  console.log(`   ${at()}  ${need() ? "ready" : "NOT READY (timed out)"} after ${(i / 4).toFixed(0)}s`);
  for (let k = 0; k < 8; k++) { await sleep(250); showLogs(); }
};
engine.reset(5000);
engine.startBot({ chain: "solana", pool: POOL, symbol: "AGT", tf: "5m", positionPct: 100, minConfidence: 45, analyzeEverySec: 1800, checkEverySec: 5, maxDrawdownPct: 25, goalUsd: 1e9, pick: "agent", budgetUsd: 1000, trailPct: 3, riskPerTradePct: 0, dailyLossPct: 10, cooldownMin: 30, breakEvenAtPct: 6, lockPct: 50, strongMode: true, rewardRule: true, disabled: [] } as any);
await waitPlan("agent starts: the AI says buy now", () => engine.getState().positions.length > 0);
const P = () => engine.getState().positions[0] as any;
const show = (label: string) => { const p = P(); console.log(`   ${label}: ${p ? `open | exit ${p.stopLoss?.toFixed(4)} | floor ${p.pm?.floor?.toFixed(4) ?? "-"} | trail ${p.pm?.trailPct ?? "-"}% by ${p.pm?.by ?? "-"} | AI asked ${p.pm?.asks ?? 0}x | bought on a ${p.prediction?.pWin ?? "?"}% combined chance (needed ${p.prediction?.needPct ?? "?"}%, ${p.prediction?.parts?.length ?? 0} forecasters)` : "closed"}`); };
await step(7, "1.06 then 1.03: under the minimum, nothing locked, no sale", 1.06);
await step(7, "1.03", 1.03);
show("before the minimum");
await step(8, "1.092 (+5.7% after fees): minimum locked, the AI is asked", 1.092);
show("at +5.7%");
if (SC === "min") {
  await step(8, "1.06: falls straight back: sells at the locked +5% exit (1.066)", 1.06);
} else if (SC === "noai") {
  await step(8, "1.12 (+8.4%): the AI can't be reached: the exit follows 2.5% behind", 1.12);
  show("at 1.12");
  await step(8, "1.10: above the exit (1.092, 2.5% under 1.12): holds", 1.10);
  show("at 1.10");
  await step(8, "1.09: below the 2.5% trailing exit: sells", 1.09);
} else {
  await step(8, "1.088: small dip, still above the locked exit: holds", 1.088);
  show("at 1.088");
  offset += 25_000;
  await step(8, "1.13 (+9.4%)", 1.13);
  offset += 25_000;
  await step(8, "1.16 (+12.4%)", 1.16);
  show("at 1.16");
  await step(8, "1.14: pulls back 1.7% (the old 1% ladder would have sold at 1.156): holds", 1.14);
  show("at 1.14");
  offset += 25_000;
  if (SC === "trail") {
    await step(8, "1.20 (+16.4%)", 1.2);
    show("at 1.20");
    await step(8, "1.15: fell more than 3% from the 1.20 high: sells", 1.15);
  } else {
    await step(10, "1.21 (+17.4%): the AI is asked again and says sell now", 1.21);
  }
}
show("end");
// Let time pass so the next look scores the forecast the buy was made on.
offset += 4 * 60_000;
for (let i = 0; i < 100 && !(engine.getState() as any).fc?.stats.scored; i++) { await sleep(250); showLogs(); }
{
  const fc: any = engine.getState().fc;
  console.log("   scoreboard:", JSON.stringify({ scored: fc?.stats.scored ?? 0, waiting: fc?.waiting, taken: fc?.stats.taken, last: fc?.last?.map((x: any) => `${x.kind} ${x.pWin}% ${x.passed ? "used" : "refused"} -> ${x.out}`) }), "| panel calls:", panelCalls);
}
console.log("   AI profit checks:", profitCalls);
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, profitPrompt);
const s = engine.getState();
console.log(`RESULT ${SC}: AI calls ${aiCalls} | trades: ${s.trades.slice().reverse().map((t) => `${t.side} $${t.usd.toFixed(0)} @ ${t.price.toFixed(4)}${t.pnlUsd !== undefined ? ` (P&L $${t.pnlUsd.toFixed(2)}, ${t.reason})` : ` (${t.reason})`}`).join(" | ") || "none"} | open=${s.positions.length}`);
console.log("agent log:", JSON.stringify(s.bot.agentLog?.map((d: any) => `${d.symbol} ${d.ok ? "OK" : "SKIP"}: ${d.why}`)));
{
  // What must be true at the end of every profit-management scenario.
  const sells = s.trades.filter((t) => t.side === "SELL"), buys = s.trades.filter((t) => t.side === "BUY");
  const r = sells[0]?.reason ?? "", pnl = sells[0]?.pnlUsd ?? 0;
  expect("one buy, one sell, nothing left open", [buys.length, sells.length, s.positions.length], [1, 1, 0]);
  // $400,000 of liquidity: 0.6% fees + 2 x $1,000 / $400,000 each way = 1.6% for the round trip, half on each side.
  expect("the trade paid the pool's own cost for its size (1.6% round trip), not a flat 3%", [Math.round(buys[0].feeUsd * 100) / 100, Math.round(buys[0].price * 1e4) / 1e4], [8, 1]);
  expect("the trade's real result is on the scoreboard as a win", (s as any).fc?.stats.taken, { n: 1, hits: 1 });
  // The fake coin is a sound one (quality 87): its result is filed under that band, for calibrating the quality gate later.
  expect("...filed under the coin's quality score", (s as any).fc?.stats.byQuality, { "75+": { n: 1, hits: 1 } });
  check("the AI was asked to manage the profit", profitCalls >= 1, profitCalls);
  if (SC === "ride") {
    check("the AI's SELL_NOW ends the trade", r.startsWith("AI took profit"), r);
    check("it rode the move (P&L over $150 on $1,000)", pnl > 150, pnl.toFixed(2));
  }
  if (SC === "trail") {
    check("sold at the exit the AI set, following the high", /^Profit exit: .*at the exit the AI set/.test(r), r);
    check("kept most of the run (P&L $115 to $150)", pnl > 115 && pnl < 150, pnl.toFixed(2));
  }
  if (SC === "noai") {
    check("with the AI unreachable, a fixed rule still takes the profit", r.startsWith("Profit exit") && !r.includes("the AI set"), r);
    check("never below the locked minimum (P&L $60 to $85)", pnl > 60 && pnl < 85, pnl.toFixed(2));
  }
  if (SC === "min") {
    check("a fall straight back sells at the locked minimum", r.startsWith("Profit exit"), r);
    check("about +5% after costs (P&L $35 to $56)", pnl > 35 && pnl < 56, pnl.toFixed(2));
  }
}
engine.stopBot("test over");
await engine.flush();
finish();
