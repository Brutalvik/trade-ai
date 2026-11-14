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

const jupToken = () => ({
  id: MINT, symbol: "AGT", name: "Agent Test", icon: "", usdPrice: price, mcap: 5e6, fdv: 5e6, liquidity: 400_000, holderCount: 4200,
  organicScore: 72, graduatedAt: new Date(realNow() - 20 * 3600_000).toISOString(),
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18, devBalancePercentage: 0.5, devMints: 1 },
  stats5m: { priceChange: 1.2, holderChange: 0.6, liquidityChange: 0.4, buyVolume: 60_000, sellVolume: 35_000, numOrganicBuyers: 30, numTraders: 400 },
  stats1h: { priceChange: 14, holderChange: 3, buyVolume: 300_000, sellVolume: 220_000, buyOrganicVolume: 40_000, sellOrganicVolume: 30_000, numOrganicBuyers: 80, numTraders: 1500 },
  tags: ["verified"],
});
const dexPair = (pool = POOL) => ({ chainId: "solana", dexId: "test", pairAddress: pool, baseToken: { address: "Mint" + pool, symbol: "A" + pool.slice(-2), name: "Agent Test" }, priceUsd: String(price), priceChange: { m5: 1.2, h1: 14, h24: 30 }, volume: { m5: 95_000, h1: 520_000, h24: 3e6 }, txns: { h1: { buys: 900, sells: 600 } }, liquidity: { usd: 400_000 }, marketCap: 5e6 });

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("fake-claude.local")) {
    aiCalls++;
    await new Promise((r) => setTimeout(r, 3000));
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
  if (url.includes("api.jup.ag/tokens/v2/")) return json([jupToken()]);
  if (url.includes("api.dexscreener.com/tokens/v1/solana/")) return json([dexPair()]);
  if (url.includes("api.dexscreener.com/latest/dex/pairs")) return json({ pairs: [dexPair(url.split("/").pop()!.split("?")[0])] });
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

engine.reset(20_000);
const base = { chain: "solana", tf: "5m", positionPct: 100, minConfidence: 0, analyzeEverySec: 600, checkEverySec: 5, maxDrawdownPct: 25, goalUsd: 1e9, pick: "agent", budgetUsd: 1000, trailPct: 3, riskPerTradePct: 0, dailyLossPct: 10, cooldownMin: 30, breakEvenAtPct: 6, lockPct: 50, strongMode: false, rewardRule: false, disabled: [] };
const startedAt = realNow();
for (let i = 1; i <= 10; i++) engine.startBot({ ...base, pool: `Pool${String(i).padStart(2, "0")}`, symbol: `A${String(i).padStart(2, "0")}` } as any, String(i), 10);
let err = "";
try { engine.startBot({ ...base, pool: "Pool11", symbol: "A11" } as any, "11", 10); } catch (e: any) { err = e.message; }
console.log("11th agent:", err || "started (unexpected)");
let firstAll = 0;
for (let i = 0; i < 360 && !firstAll; i++) { await sleep(500); if (engine.getState().positions.length >= 10) firstAll = realNow() - startedAt; }
const st = engine.getState();
console.log(`running ${[st.bot, ...(st.bots ?? []).map((b: any) => b.bot)].filter((b: any) => b.running).length} agents | positions ${st.positions.length} | all bought after ${(firstAll / 1000).toFixed(1)}s (one after another would need 30 s+ of AI time alone) | cash left $${st.cash.toFixed(2)}`);
const s = engine.getState();
console.log(`RESULT ${SC}: AI calls ${aiCalls} | trades: ${s.trades.slice().reverse().map((t) => `${t.side} $${t.usd.toFixed(0)} @ ${t.price.toFixed(4)}${t.pnlUsd !== undefined ? ` (P&L $${t.pnlUsd.toFixed(2)}, ${t.reason})` : ` (${t.reason})`}`).join(" | ") || "none"} | open=${s.positions.length}`);
console.log("agent log:", JSON.stringify(s.bot.agentLog?.map((d: any) => `${d.symbol} ${d.ok ? "OK" : "SKIP"}: ${d.why}`)));
{
  const running = [st.bot, ...(st.bots ?? []).map((b: any) => b.bot)].filter((b: any) => b.running).length;
  expect("an eleventh agent is refused", err, "No free agent slot. Stop an agent first.");
  expect("ten agents run, each on its own coin, and all ten bought", [running, st.positions.length, new Set(st.positions.map((p) => p.pool)).size], [10, 10, 10]);
  check("their AI decisions ran side by side (all bought within 3 minutes)", firstAll > 0 && firstAll < 180_000, `${(firstAll / 1000).toFixed(1)} s`);
}
engine.stopBot("test over");
await engine.flush();
finish();
