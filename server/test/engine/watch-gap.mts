// The minute boundary, as deployed: a scheduler calls once a minute and each call watches the
// account for most of that minute under a lock (engine.watch). This scenario runs the engine
// exactly that way (no timer of its own, the account in Supabase, the scheduler's calls made by
// the test at 0 s, 60 s, 120 s...) with one trade open, and records when that trade was checked.
// What it guards: no call of the scheduler may go unwatched, and an open trade may never go long
// without a check, also when an AI answer is still on its way as a watch ends, and also when
// several agents make each round of checks slow. Before v0.72.0 a watch that ran a second past
// its minute made the next call give up: with five agents every second minute went unwatched
// and the trade went 66 seconds without a check.
//   SC=calm      nothing is asked of the AI: the trade just sits there
//   SC=thinking  a second agent starts 42 s into the first minute and its AI takes AI_MS to answer
//   SC=winner    the trade is up past its +5% minimum, so its AI is asked again and again
//                whether to hold; each answer takes AI_MS
//   SC=crowd     AGENTS agents in all: the one with the trade, and the others each watching a
//                coin of their own for a price to buy at (their AI answers at once)
// AI_MS = how long an AI answer takes (default 20000). MINUTES = how many scheduler calls (3).
// LATE_MS = how long after the full minute the scheduler's call reaches the watch (500).
// MAX_GAP_S = the longest the open trade may go unchecked (calm 8, thinking 14, winner 10, crowd 15).
// With ten agents (SC=crowd AGENTS=10 MINUTES=6 MAX_GAP_S=35) no call is lost either, but when
// the other nine all ask their AI in the same minute the trade's price check waits behind their
// chart loading at the price source (one request a second): 27 s was measured. That is a limit
// of the price queue, not of the watch; it is why the default bound is not asked of ten agents.
// APP_OPEN=1 = the app is open in a browser as well: it nudges the server every 20 seconds
// (engine.heartbeat, an 18-second watch), beside the scheduler's calls.
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|SKIP_UPSTASH/.test(k)) delete process.env[k];
process.env.VERCEL = "1"; // as deployed: the engine starts no timer; only the scheduler's call makes it look
process.env.ANTHROPIC_API_KEY = "fake";
process.env.ANTHROPIC_BASE_URL = "http://fake-claude.local";
process.env.OWNER_USERNAME = "tester";
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
await fakeSupabase();

const SC = process.env.SC ?? "calm";
const AI_MS = Number(process.env.AI_MS ?? 20_000);
const MINUTES = Number(process.env.MINUTES ?? 3);
const LATE_MS = Number(process.env.LATE_MS ?? 500);
const MAX_GAP_S = Number(process.env.MAX_GAP_S ?? ({ calm: 8, thinking: 14, winner: 10, crowd: 15 } as Record<string, number>)[SC] ?? 15);
const APP_OPEN = process.env.APP_OPEN === "1";
const AGENTS = SC === "crowd" ? Math.max(2, Number(process.env.AGENTS ?? 5)) : 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------- the fake market: two coins ----------
type Coin = { symbol: string; mint: string; pool: string; price: number };
const WCH: Coin = { symbol: "WCH", mint: "WatchMint1111pump", pool: "WatchPool1111", price: 1.0 }; // the coin that is bought and held
const THK: Coin = { symbol: "THK", mint: "ThinkMint1111pump", pool: "ThinkPool1111", price: 1.0 }; // the coin a second agent thinks about
const coins = [WCH, THK];
for (let i = 2; i < AGENTS; i++) coins.push({ symbol: `THK${i}`, mint: `Think${i}Mint1111pump`, pool: `Think${i}Pool1111`, price: 1.0 }); // (crowd: one coin for each further agent)
let flat = false; // true = the 5-second candles show a steady price (once the trade is open, nothing moves)
const jupToken = (c: Coin) => ({
  id: c.mint, symbol: c.symbol, name: `${c.symbol} coin`, icon: "", usdPrice: c.price, mcap: 5e6, fdv: 5e6, liquidity: 400_000, holderCount: 4200,
  organicScore: 72, graduatedAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18, devBalancePercentage: 0.5, devMints: 1 },
  stats5m: { priceChange: 1.2, holderChange: 0.6, liquidityChange: 0.4, buyVolume: 60_000, sellVolume: 35_000, numOrganicBuyers: 30, numTraders: 400 },
  stats1h: { priceChange: 14, holderChange: 3, buyVolume: 300_000, sellVolume: 220_000, buyOrganicVolume: 40_000, sellOrganicVolume: 30_000, numOrganicBuyers: 80, numTraders: 1500 },
  tags: ["verified"],
});
const dexPair = (c: Coin) => ({ chainId: "solana", dexId: "test", pairAddress: c.pool, baseToken: { address: c.mint, symbol: c.symbol, name: `${c.symbol} coin` }, priceUsd: String(c.price), priceChange: { m5: 1.2, h1: 14, h24: 30 }, volume: { m5: 95_000, h1: 520_000, h24: 3e6 }, txns: { h1: { buys: 900, sells: 600 } }, liquidity: { usd: 400_000 }, marketCap: 5e6 });

// ---------- the scripted AI ----------
let aiCalls = 0, planCalls = 0, holdCalls = 0;
const aiLog: { at: number; kind: string; ms: number }[] = []; // every AI question: when it was asked and how long the answer took
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch; // the fake Supabase is already in it
let t0 = 0; // when the scheduler's first counted call is made
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("fake-claude.local")) {
    aiCalls++;
    const body = String(init?.body ?? "");
    const say = async (kind: string, ms: number, out: unknown) => {
      aiLog.push({ at: Date.now(), kind, ms });
      await sleep(ms);
      return json({ id: `m${aiCalls}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    };
    if (body.includes("independent forecasters")) return say("forecast", 0, { chances: [70, 70], reason: "Test forecaster." });
    if (body.includes("managing an open trade that is in profit")) {
      holdCalls++;
      return say("hold or sell", AI_MS, { action: "HOLD", exitPrice: 0, trailPct: 3, targetPrice: WCH.price * 1.1, recheckSeconds: 20, confidence: 68, reason: "Higher lows and buyers in control: give it room." });
    }
    planCalls++;
    if (body.includes("THK")) return say("plan for another agent", SC === "crowd" ? 0 : AI_MS, { stance: "AVOID", confidence: 30, riskLevel: "HIGH", reasoning: "Fading volume under resistance; no edge right now.", orders: [{ kind: "buy_dip", triggerPrice: 0.9, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: 0.84, target: 1.03, maxHoldMinutes: 120, winChancePct: 30 }], cancelBelow: 0, cancelAbove: 0, validMinutes: 30 });
    return say("plan", 0, { stance: "BUY_NOW", confidence: 70, riskLevel: "MEDIUM", reasoning: "Breakout holding on rising volume with room above.", orders: [{ kind: "buy_now", triggerPrice: 1.002, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: 0.95, target: 1.6, maxHoldMinutes: 180, winChancePct: 62 }], cancelBelow: 0, cancelAbove: 0, validMinutes: 60 });
  }
  if (url.includes("api.jup.ag/swap/")) return new Response("{}", { status: 503 }); // costs come from the fake pool's depth
  if (url.includes("api.jup.ag/tokens/v2/search")) {
    const q = decodeURIComponent(new URL(url).searchParams.get("query") ?? "").split(",");
    return json(coins.filter((c) => q.includes(c.mint)).map(jupToken));
  }
  if (url.includes("api.jup.ag/tokens/v2/")) return json(coins.map(jupToken));
  if (url.includes("api.dexscreener.com/tokens/v1/solana/")) {
    const mints = url.split("/").pop()!.split(",");
    return json(coins.filter((c) => mints.includes(c.mint)).map(dexPair));
  }
  if (url.includes("api.dexscreener.com/latest/dex/pairs")) {
    const pool = url.split("/").pop()!;
    return json({ pairs: coins.filter((c) => c.pool === pool).map(dexPair) });
  }
  if (url.includes("coinmarketcap.com")) {
    const u = new URL(url);
    const c = coins.find((x) => x.mint === u.searchParams.get("address")) ?? WCH;
    const price = c.price;
    const interval = u.searchParams.get("interval");
    const step = interval === "5s" ? 5_000 : interval === "1min" ? 60_000 : interval === "15min" ? 900_000 : interval === "1h" ? 3_600_000 : interval === "1d" ? 86_400_000 : 300_000;
    const last = Math.floor(Date.now() / step) * step;
    const N = 300, CYC = 44;
    const shape = (k: number) => (k < 24 ? 1 + Math.sin(k * 2.1) * 0.004 : k === 24 ? 1.03 : k < 33 ? 1.03 + (k - 24) * 0.02 : 1.19 - (k - 33) * (0.19 / 11));
    const rows = Array.from({ length: N }, (_, i) => {
      const t = last - (N - 1 - i) * step;
      if (flat && step === 5_000) return [price, price, price, price, 900, t, 5];
      if (i === N - 1) return [price, price * 1.002, price * 0.998, price, 900, t, 5];
      const k = ((i - (N - 2 - 24)) % CYC + CYC) % CYC;
      const scale = price / 1.03;
      const cl = shape(k) * scale, o = shape(k === 0 ? 0 : k - 1) * scale;
      return [o, Math.max(o, cl) * 1.002, Math.min(o, cl) * 0.998, cl, k === 24 ? 4000 : 800, t, 5];
    });
    return json({ data: rows, status: { error_code: "0" } });
  }
  if (url.includes("geckoterminal.com")) return new Response("{}", { status: 503 });
  return realFetch(input, init);
}) as typeof fetch;

const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
const KEY = "tester";
const cfgOf = (c: Coin) => ({ chain: "solana", pool: c.pool, symbol: c.symbol, tf: "5m", positionPct: 100, minConfidence: 45, analyzeEverySec: 1800, checkEverySec: 5, maxDrawdownPct: 25, goalUsd: 1e9, pick: "agent", budgetUsd: 1000, trailPct: 3, riskPerTradePct: 0, dailyLossPct: 10, cooldownMin: 30, breakEvenAtPct: 6, lockPct: 50, strongMode: true, rewardRule: true, disabled: [] });
const inAccount = <T>(fn: () => T | Promise<T>): Promise<T> => engine.withAccount(KEY, async () => fn());
const st = () => inAccount(() => engine.getState() as any);

await engine.ensureMigrated();
await inAccount(async () => {
  await engine.sync();
  engine.reset(1000 * Math.max(3, AGENTS + 1)); // (room for every agent's $1,000 budget)
  await engine.flush();
  engine.startBot(cfgOf(WCH) as any, "1", 10);
  await engine.flush();
});

// ---- before the clock starts: the agent asks its AI and buys ----
for (let i = 0; i < 4 && !(await st()).positions.length; i++) await engine.watchAll(25_000, "scheduler");
expect("(setup) the agent has bought, and the trade is open", (await st()).positions.length, 1);
flat = true;
if (SC === "crowd") {
  // The other agents, each on its own coin: their AI says to stay out but leaves a price to buy at, so each keeps watching its coin.
  await inAccount(async () => { for (let i = 1; i < AGENTS; i++) engine.startBot(cfgOf(coins[i]) as any, String(i + 1), 10); await engine.flush(); });
  for (let i = 0; i < 6 && planCalls < AGENTS; i++) await engine.watchAll(25_000, "scheduler");
  expect(`(setup) all ${AGENTS} agents are running and each has asked its AI once`, [(await st()).bots.filter((b: any) => b.bot.running).length + 1, planCalls], [AGENTS, AGENTS]);
}
if (SC === "winner") WCH.price = 1.09; // the trade is up about 9%: past its minimum profit, so its AI manages the exit

// ---- the scheduler: a call every minute, each watching for 55 seconds ----
// When the open trade was checked: read from the agent's own record of its last check.
const checks: number[] = [];
let sampling = true;
const sampler = (async () => {
  let last = 0;
  while (sampling) {
    const at = (await st()).bot.lastTickAt ?? 0;
    if (at !== last && at >= t0) { checks.push(at); last = at; }
    await sleep(200);
  }
})();
type Call = { n: number; at: number; ended: number; ticks: number; reason: string; waitedMs: number };
const calls: Promise<Call>[] = [];
t0 = Date.now();
const sec = (t: number) => ((t - t0) / 1000).toFixed(1);
if (SC === "thinking") void sleep(42_000).then(() => inAccount(async () => { engine.startBot(cfgOf(THK) as any, "2", 10); await engine.flush(); console.log(`   ${sec(Date.now())} s  a second agent is started (its AI will take ${AI_MS / 1000} s to answer)`); }));
let nudges = 0, nudgesThatWatched = 0;
if (APP_OPEN) void (async () => {
  for (let at = t0 + 7_000; at < t0 + MINUTES * 60_000; at += 20_000) { // (the page's own rhythm, not in step with the scheduler)
    await sleep(at - Date.now());
    nudges++;
    void inAccount(() => engine.heartbeat()).then((r: any) => { if (r?.ticks) nudgesThatWatched++; }, () => {});
  }
})();
for (let n = 0; n < MINUTES; n++) {
  await sleep(t0 + n * 60_000 + LATE_MS - Date.now());
  const at = Date.now();
  calls.push(engine.watchAll(engine.WATCH_MS, "scheduler").then((w: any) => ({ n: n + 1, at, ended: Date.now(), ticks: w.results[0]?.ticks ?? 0, reason: w.results[0]?.reason ?? "no account on the list", waitedMs: w.results[0]?.waitedMs ?? 0 })));
}
const done = await Promise.all(calls);
const endAt = t0 + MINUTES * 60_000; // the stretch that is judged: from the first call to a minute after the last
await sleep(endAt - Date.now());
sampling = false;
await sampler;

// ---- what happened ----
console.log(`\nscenario ${SC}${SC === "calm" ? "" : SC === "crowd" ? `, ${AGENTS} agents` : `, an AI answer takes ${AI_MS / 1000} s`}; the scheduler's call reaches the watch ${LATE_MS} ms after the minute`);
for (const c of done) console.log(`   call ${c.n} at ${sec(c.at).padStart(6)} s: ${c.ticks ? `${c.waitedMs ? `waited ${(c.waitedMs / 1000).toFixed(1)} s for the watch before it, then ` : ""}${String(c.ticks).padStart(2)} rounds, watched until ${sec(c.ended).padStart(6)} s` : "NOT WATCHED"} (${c.reason})`);
for (const a of aiLog.filter((x) => x.at >= t0)) console.log(`   AI asked at ${sec(a.at).padStart(6)} s (${a.kind}), answered at ${sec(a.at + a.ms).padStart(6)} s`);
const within = checks.filter((t) => t <= endAt);
const marks = [t0, ...within, endAt];
const gaps = marks.slice(1).map((t, i) => ({ from: marks[i], to: t, s: (t - marks[i]) / 1000 }));
const longest = gaps.reduce((m, g) => (g.s > m.s ? g : m), gaps[0]);
const long = gaps.filter((g) => g.s > 12);
console.log(`   the open trade was checked ${within.length} times in ${MINUTES} minutes; stretches without a check longer than 12 s: ${long.length ? long.map((g) => `${g.s.toFixed(0)} s (from ${sec(g.from)} s to ${sec(g.to)} s)`).join(", ") : "none"}`);
const refused = done.filter((c) => !c.ticks).length;
if (APP_OPEN) console.log(`   the open app nudged the server ${nudges} times; ${nudgesThatWatched} of those kept watch themselves`);
console.log(`RESULT ${SC} ai=${AI_MS / 1000}s late=${LATE_MS}ms: calls ${done.length}, not watched ${refused}, checks ${within.length}, longest stretch without a check ${longest.s.toFixed(1)} s (from ${sec(longest.from)} s) | AI questions ${aiCalls} (plans ${planCalls}, hold-or-sell ${holdCalls}) | trade still open: ${(await st()).positions.length === 1}`);

expect("the trade is still open at the end (nothing here should sell it)", (await st()).positions.length, 1);
if (!APP_OPEN) expect("every one of the scheduler's calls got to watch", refused, 0); // (with the app open, its own watches may be the ones running)
check(`the open trade never went longer than ${MAX_GAP_S} s without a check`, longest.s <= MAX_GAP_S, `${longest.s.toFixed(1)} s, from ${sec(longest.from)} s to ${sec(longest.to)} s`);
await inAccount(async () => { for (let i = 1; i <= Math.max(2, AGENTS); i++) engine.stopBot("test over", String(i)); await engine.flush(); });
finish();
