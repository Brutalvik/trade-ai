// Engine scenario: the real bot engine runs against a fake market and a scripted AI, in real
// 5-second steps. Started by test/run.mts with SC=<scenario>.
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SC = process.env.SC ?? "win";
if (SC === "quiet") process.env.QUIET = "1"; // a coin that barely moves: the AI says buy, the numbers say it can't get there
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
const LIQ = SC === "thin" ? 80_000 : 400_000; // the pool's liquidity: a thin pool makes a large trade expensive
let aiCalls = 0;
let panelCalls = 0;
let planCalls = 0;
let briefSeen = false;

const jupToken = () => ({
  id: MINT, symbol: "AGT", name: "Agent Test", icon: "", usdPrice: price, mcap: 5e6, fdv: 5e6, liquidity: LIQ, holderCount: 4200,
  organicScore: 72, graduatedAt: new Date(realNow() - 20 * 3600_000).toISOString(),
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: SC === "scouts" ? 60 : 18, devBalancePercentage: 0.5, devMints: 1 }, // "scouts": ten wallets own 60% of the coin
  stats5m: { priceChange: 1.2, holderChange: 0.6, liquidityChange: 0.4, buyVolume: 60_000, sellVolume: 35_000, numOrganicBuyers: 30, numTraders: 400 },
  stats1h: { priceChange: 14, holderChange: 3, buyVolume: 300_000, sellVolume: 220_000, buyOrganicVolume: 40_000, sellOrganicVolume: 30_000, numOrganicBuyers: 80, numTraders: 1500 },
  tags: ["verified"],
});
const dexPair = () => ({ chainId: "solana", dexId: "test", pairAddress: POOL, baseToken: { address: MINT, symbol: "AGT", name: "Agent Test" }, priceUsd: String(price), priceChange: { m5: 1.2, h1: 14, h24: 30 }, volume: { m5: 95_000, h1: 520_000, h24: 3e6 }, txns: { h1: { buys: 900, sells: 600 } }, liquidity: { usd: LIQ }, marketCap: 5e6 });

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
    const out = body.includes("Scouting agents")
      ? { approve, winChancePct: approve ? 58 : 30, reason: approve ? "Clean uptrend with real buyers and room to the target." : "Fading volume under resistance." }
      : body.includes("manage the exit")
        ? { hold: false, winChancePct: 20, target: 1.1, lastExit: 0.9, extraMinutes: 10, reason: "Support broke." }
        : SC === "avoid"
          ? { stance: "AVOID", confidence: 30, riskLevel: "HIGH", reasoning: "Fading volume under resistance; no edge right now.", orders: [{ kind: "buy_dip", triggerPrice: price * 0.9, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: price * 0.84, target: price * 1.03, maxHoldMinutes: 120, winChancePct: 30 }], cancelBelow: 0, cancelAbove: 0, validMinutes: 30 }
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
engine.reset(1000);
engine.startBot({ chain: "solana", pool: POOL, symbol: "AGT", tf: "5m", positionPct: 100, minConfidence: 45, analyzeEverySec: 1800, checkEverySec: 5, maxDrawdownPct: 25, goalUsd: 1e9, pick: "agent", budgetUsd: 1000, ...(process.env.MINNUM ? { minNumbersPct: Number(process.env.MINNUM) } : {}), trailPct: 3, riskPerTradePct: 0, dailyLossPct: 10, cooldownMin: 30, breakEvenAtPct: 6, lockPct: 50, strongMode: true, rewardRule: true, disabled: [] } as any);
await waitPlan("agent starts: the AI is asked at once", () => engine.getState().positions.length > 0 || (SC === "avoid" || SC === "quiet" || SC === "scouts") && !!engine.getState().lastSignal);
console.log("   plan calls:", planCalls, "| brief reached the AI:", briefSeen, "| open:", engine.getState().positions.length, "| blocked:", engine.getState().bot.blocked);
if (SC === "scouts") {
  // Ten wallets own 60% of this coin: the scouts rule it out before the AI is asked.
  const g: any = engine.getState();
  expect("the scouts refuse the coin before the AI is asked: no AI call, nothing bought", [aiCalls, g.positions.length, g.lastSignal?.consensus.stance, g.lastSignal?.gate?.kind], [0, 0, "AVOID", "scouts"]);
  check("the plan and the agent's log give the scouts' exact reason", g.lastSignal?.gate?.reasons.join() === "the top 10 wallets own 60%" && g.bot.log.some((l: any) => l.msg.includes("The scouts ruled AGT out") && l.msg.includes("the top 10 wallets own 60%") && l.msg.includes("no AI tokens spent")), g.lastSignal?.gate);
  await step(8, "still 1.00: the agent stays out and still does not ask its AI", 1.0);
  expect("it keeps standing aside at no cost", [aiCalls, engine.getState().positions.length], [0, 0]);
  // You choose to trade it anyway: the gate is switched off for this agent, and the AI is asked at once.
  engine.setQualityGate(false, "1");
  for (let i = 0; i < 160 && engine.getState().positions.length === 0; i++) { await sleep(250); showLogs(); }
  check("with the gate switched off the AI is asked and the agent trades", planCalls >= 1 && engine.getState().positions.length === 1 && (engine.getState().bot.config as any).disabled.includes("qualityGate"), { planCalls, open: engine.getState().positions.length });
}
if (SC === "quiet" && process.env.MANUAL) {
  // Your own Analyze on the agent's coin: answered to you, but never traded on by the agent.
  const before = (engine.getState().lastSignal as any)?.at;
  const r: any = await engine.runAnalysis("solana", POOL, "5m");
  console.log("   your own Analyze answered:", r.consensus.stance, "| judged as an agent order:", !!r.consensus.orders[0]?.prediction);
  await step(12, "after your own Analyze: the agent keeps its own (refused) plan and does not buy", 1.0);
  const sig: any = engine.getState().lastSignal;
  console.log("   manual: agent's plan unchanged:", sig?.at === before, "| agent's stance:", sig?.consensus.stance, "| open:", engine.getState().positions.length);
  check("your own Analyze is answered", ["BUY_NOW", "WAIT_FOR_TRIGGER", "AVOID"].includes(r.consensus.stance), r.consensus.stance);
  check("it does not replace the agent's plan, and the agent does not buy on it", sig?.at === before && engine.getState().positions.length === 0, { same: sig?.at === before, open: engine.getState().positions.length });
}
if (SC === "wick") {
  // bought at 1.005 with the stop at 0.95: one dip under the stop that bounces back must not sell
  await step(6, "0.94: under the stop for a few seconds", 0.94);
  await step(12, "1.00: bounced straight back: the trade must still be open", 1.0);
  console.log("   wick: open after a dip that bounced:", engine.getState().positions.length, "(expect 1)");
  check("a dip under the stop that bounces straight back does not end the trade", engine.getState().positions.length === 1 && !engine.getState().trades.some((t) => t.side === "SELL"), { open: engine.getState().positions.length });
  await step(18, "0.94 again, and it stays there: sold after about 10 s", 0.94);
  console.log("   wick: open after it stayed under the stop:", engine.getState().positions.length, "(expect 0)");
}
if (SC === "crash") {
  await step(8, "0.90: far under the stop (more than 1.5x the planned loss): sold at once", 0.9);
  console.log("   crash: open:", engine.getState().positions.length, "(expect 0)");
  check("a fall to 1.5x the planned loss sells at once", engine.getState().positions.length === 0 && engine.getState().trades.some((t) => t.side === "SELL" && /^Stop-loss hit/.test(t.reason)), { open: engine.getState().positions.length });
}
if (SC === "lose") {
  await step(8, "0.85: below the stop (a 15% loss on the whole $1,000: more than the old 10% daily limit)", 0.85);
  console.log("   blocked:", engine.getState().bot.blocked, "| running:", engine.getState().bot.running);
  offset += 3 * 60_000; console.log("   ...clock +3 min");
  await step(14, "0.86: the AI is asked again and may buy again (no daily-limit pause, no cool-down)", 0.86);
  console.log("   blocked:", engine.getState().bot.blocked, "| running:", engine.getState().bot.running, "| open:", engine.getState().positions.length);
}
if (SC === "win") {
  await step(7, "1.16: past the target: sells half", 1.16);
  await step(7, "1.10: trails out", 1.10);
  console.log("   running after a profitable trade:", engine.getState().bot.running);
}
{
  const fc: any = engine.getState().fc;
  const sig: any = engine.getState().lastSignal;
  console.log("   prediction:", JSON.stringify(sig?.consensus.orders.map((o: any) => o.prediction ? { chance: o.prediction.pWin, needs: o.prediction.needPct, used: !o.warning, parts: o.prediction.parts.map((p: any) => `${p.key} ${p.pct}`).join(", ") } : null)));
  console.log("   scoreboard:", JSON.stringify({ scored: fc?.stats.scored ?? 0, waiting: fc?.waiting, taken: fc?.stats.taken, refused: fc?.stats.refused, last: fc?.last?.map((x: any) => `${x.kind} ${x.pWin}% ${x.passed ? "used" : "refused"} -> ${x.out}`) }), "| panel calls:", panelCalls);
}
const s = engine.getState();
console.log(`RESULT ${SC}: AI calls ${aiCalls} | trades: ${s.trades.slice().reverse().map((t) => `${t.side} $${t.usd.toFixed(0)} @ ${t.price.toFixed(4)}${t.pnlUsd !== undefined ? ` (P&L $${t.pnlUsd.toFixed(2)}, ${t.reason})` : ` (${t.reason})`}`).join(" | ") || "none"} | open=${s.positions.length}`);
console.log("agent log:", JSON.stringify(s.bot.agentLog?.map((d: any) => `${d.symbol} ${d.ok ? "OK" : "SKIP"}: ${d.why}`)));
{
  const sells = s.trades.filter((t) => t.side === "SELL"), buys = s.trades.filter((t) => t.side === "BUY");
  const logs = s.bot.log.map((l) => l.msg).join("\n");
  if (!(SC === "quiet" && process.env.MINNUM !== "0")) check("the agent's brief reached the AI", briefSeen, "");
  if (SC === "lose") {
    check("stopped out once, at a loss, after the AI's second look", sells.length === 1 && /^Stop-loss hit/.test(sells[0].reason) && (sells[0].pnlUsd ?? 0) < -100, sells.map((t) => `${t.reason} ${t.pnlUsd?.toFixed(2)}`));
    check("no daily limit and no cool-down: still running, and it bought again", s.bot.running && !s.bot.blocked && buys.length === 2 && s.positions.length === 1, { running: s.bot.running, blocked: s.bot.blocked, buys: buys.length, open: s.positions.length });
    expect("the losing trade is on the scoreboard as a real miss", (s as any).fc?.stats.taken, { n: 1, hits: 0 });
  }
  if (SC === "wick") {
    check("the log says it bounced", logs.includes("bounced back above its stop-loss"), "");
    check("staying under the stop sells after the confirmation, near where the price settled", sells.length === 1 && /^Stop-loss hit/.test(sells[0].reason) && Math.abs(sells[0].price - 0.9353) < 0.01, sells.map((t) => `${t.reason} @ ${t.price.toFixed(4)}`));
  }
  if (SC === "crash") check("exactly one sale", sells.length === 1, sells.length);
  if (SC === "thin") {
    // $80,000 of liquidity: all $1,000 would cost 0.6% + 5% = 5.6% for the round trip. Under the 2.5% cap fits about $379.
    const p: any = s.positions[0];
    check("in a thin pool the agent invests only what keeps the round trip under 2.5%", buys.length === 1 && buys[0].usd > 340 && buys[0].usd < 400 && p?.costPct <= 2.5 && p?.costPct > 2.3, { usd: buys[0]?.usd, costPct: p?.costPct });
    check("the rest of its budget stays set aside for it", Math.round((s as any).locked) === Math.round(1000 - buys[0].usd) && Math.round((s as any).available) === 0, { locked: (s as any).locked, available: (s as any).available });
    check("the log says why it bought less", logs.includes("because all of it would cost 5.6%"), "");
    check("the plan was judged with that cost", Math.abs(((s.lastSignal as any)?.cost?.pct ?? 0) - p?.costPct) < 0.01 && (s.lastSignal as any)?.cost?.fullPct === 5.6, (s.lastSignal as any)?.cost);
  }
  if (SC === "quiet") {
    check("a coin that barely moves: the prediction check refuses the buy", s.trades.length === 0 && s.positions.length === 0 && s.lastSignal?.consensus.stance === "AVOID", { trades: s.trades.length, stance: s.lastSignal?.consensus.stance });
    if (process.env.MINNUM !== "0") {
      // The numbers give no order even a 10% chance (the floor), so the agent's AI is not asked.
      const mine = aiCalls - (process.env.MANUAL ? 1 : 0); // your own Analyze (the manual scenario) does ask the AI
      expect("the numbers rule a buy out before the AI is asked: no AI call by the agent, no panel", [mine, panelCalls, (s.lastSignal as any)?.gate?.kind], [0, 0, "numbers"]);
      check("the plan says why, with the best the numbers gave", /The numbers rule out a buy right now, so the AI was not asked .*no plain order has even a 10% chance.*\(the best is (under 1|\d+)%\)/.test(s.lastSignal?.consensus.note ?? ""), s.lastSignal?.consensus.note);
      check("the forecast desk is still shown, and the agent's log says it once", !!(s.lastSignal as any)?.desk && s.bot.log.filter((l) => l.msg.includes("The numbers rule out a buy")).length === 1, "");
    } else {
      check("the forecaster panel is not asked about an order that cannot pass", panelCalls === 0, panelCalls);
      check("the refused order carries its prediction", !!(s.lastSignal as any)?.consensus.orders[0]?.prediction && !!(s.lastSignal as any)?.consensus.orders[0]?.warning, "");
    }
  }
}
engine.stopBot("test over");
await engine.flush();
finish();
