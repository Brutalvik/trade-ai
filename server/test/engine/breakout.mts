// Engine scenario: the real bot engine runs against a fake market and a scripted AI, in real
// 5-second steps. Started by test/run.mts with SC=<scenario>.
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SC = process.env.SC ?? "win";
if (SC === "touch") process.env.QUIET = "1"; // a quiet coin: the AI names a breakout level, the odds refuse it, then the price gets there
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
let aiCalls = 0;
let panelCalls = 0;
let planCalls = 0;
let briefSeen = false;
let agentSystem = false;

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
    const out = body.includes("Scouting agents")
      ? { approve, winChancePct: approve ? 58 : 30, reason: approve ? "Clean uptrend with real buyers and room to the target." : "Fading volume under resistance." }
      : body.includes("manage the exit")
        ? { hold: false, winChancePct: 20, target: 1.1, lastExit: 0.9, extraMinutes: 10, reason: "Support broke." }
        : (planCalls++, agentSystem = agentSystem || body.includes("active short-term crypto trader"), { stance: "AVOID", confidence: 55, riskLevel: "HIGH", reasoning: "Running hard; only worth it if it clears the high.", orders: [{ kind: "buy_breakout", triggerPrice: price * 1.02, confirmSeconds: 0, minVolumeRatio: Number(process.env.VOLREQ ?? 0), stopLoss: price * 0.95, target: price * 1.02 * 1.15, maxHoldMinutes: 120, winChancePct: Number(process.env.AIWIN ?? 60) }], cancelBelow: 0, cancelAbove: 0, validMinutes: 20 });
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
engine.startBot({ chain: "solana", pool: POOL, symbol: "AGT", tf: "5m", positionPct: 100, minConfidence: 45, analyzeEverySec: 1800, checkEverySec: 5, maxDrawdownPct: 25, goalUsd: 1e9, pick: "agent", budgetUsd: 1000, trailPct: 3, riskPerTradePct: 0, dailyLossPct: 10, cooldownMin: 30, breakEvenAtPct: 6, lockPct: 50, strongMode: true, rewardRule: true, disabled: [] } as any);
await waitPlan("agent starts: the AI labels it AVOID but gives a breakout order above 1.02", () => !!engine.getState().lastSignal);
console.log("   agent instructions used:", agentSystem, "| stance the bot follows:", engine.getState().lastSignal?.consensus.stance, "| plan calls:", planCalls);
if (SC === "touch") {
  console.log("   the breakout order is refused:", !!(engine.getState().lastSignal as any)?.consensus.orders[0]?.warning, "| plan calls:", planCalls);
  await step(6, "1.03, above the refused breakout level, seconds after the plan: too soon to ask again", 1.03);
  console.log("   plan calls right after the touch:", planCalls, "(expect 1)");
  expect("reaching a refused level seconds after the plan does not ask again", planCalls, 1);
  offset += 50_000;
  await step(14, "still 1.03, 50 s after the plan: the agent looks again at once", 1.03);
  console.log("   plan calls after the touch:", planCalls, "(expect 2)");
  expect("50 s after the plan, reaching the level makes the agent look again at once", planCalls, 2);
  await step(12, "still 1.03: the new plan's levels are away from the price, so no more asks", 1.03);
  console.log("   plan calls a little later:", planCalls, "(expect 2) | open:", engine.getState().positions.length);
  expect("and then no more asks, and nothing bought", [planCalls, engine.getState().positions.length], [2, 0]);
} else if (SC === "move") {
  console.log("   this coin's usual 5-minute swing:", (engine.getState().lastSignal as any)?.atrPct?.toFixed(2) + "%");
  await step(8, "0.955 (-4.5%) seconds after the plan: too soon, no new ask", 0.955);
  console.log("   plan calls right after the move:", planCalls, "(expect 1)");
  expect("a 4.5% move seconds after the plan does not ask again", planCalls, 1);
  offset += 100_000;
  await step(14, "still 0.955, 100 s later: must ask the AI again", 0.955);
  console.log("   plan calls:", planCalls);
  check("100 s later the same move makes the agent ask again", planCalls >= 2, planCalls);
} else {
  if (SC === "spike") {
    await step(7, "1.03: a spike above the breakout level", 1.03);
    await step(16, "1.00: it fell straight back within seconds: NOT a breakout, nothing is bought", 1.0);
  } else if (SC === "chase") {
    await step(22, "1.06: it ran 3.9% past the breakout level: not chased, the AI is asked again", 1.06);
    offset += 35_000;
    await step(12, "still 1.06", 1.06);
    console.log("   plan calls:", planCalls, "(expect 2: asked again instead of chasing)");
    check("a breakout that ran past its level is not chased: the AI is asked again", planCalls === 2 && engine.getState().positions.length === 0, { planCalls, open: engine.getState().positions.length });
  } else {
    await step(7, "1.03: crosses the breakout level: bought only once it has held there 15 s", 1.03);
    console.log("   open after 7 s above the level:", engine.getState().positions.length, "(expect 0)");
    expect("a breakout is not bought the moment it crosses its level", engine.getState().positions.length, 0);
    await step(18, "still 1.03: the breakout held, so it buys (even though the label said AVOID)", 1.03);
  }
  console.log("   open:", engine.getState().positions.length);
}
const s = engine.getState();
console.log(`RESULT ${SC}: AI calls ${aiCalls} | trades: ${s.trades.slice().reverse().map((t) => `${t.side} $${t.usd.toFixed(0)} @ ${t.price.toFixed(4)}${t.pnlUsd !== undefined ? ` (P&L $${t.pnlUsd.toFixed(2)}, ${t.reason})` : ` (${t.reason})`}`).join(" | ") || "none"} | open=${s.positions.length}`);
console.log("agent log:", JSON.stringify(s.bot.agentLog?.map((d: any) => `${d.symbol} ${d.ok ? "OK" : "SKIP"}: ${d.why}`)));
{
  const logs = s.bot.log.map((l) => l.msg).join("\n");
  check("the agent's own instructions were used", agentSystem, "");
  if (SC === "spike") check("a spike that falls straight back is not bought", s.trades.length === 0 && s.positions.length === 0, { trades: s.trades.length });
  if (SC === "chase") check("the log explains why it did not chase", logs.includes("past the breakout level"), "");
  if (SC === "buy" && !process.env.VOLREQ) check("a breakout that holds is bought (even though the AI's label said AVOID)", s.positions.length === 1 && s.trades.length === 1 && s.trades[0].reason.includes("breakout above"), s.trades.map((t) => t.reason));
  if (SC === "buy" && process.env.VOLREQ) check("a breakout without the volume the AI asked for is not bought, and the log says why", s.positions.length === 0 && logs.includes("trading volume"), { open: s.positions.length });
}
engine.stopBot("test over");
await engine.flush();
finish();
