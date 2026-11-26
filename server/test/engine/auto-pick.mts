// Engine scenario: auto-pick agents. Several agents that choose their own coins from the scouts'
// list, against a fake market with several coins and a scripted AI, in real 5-second steps.
// Started by test/run.mts with SC=<scenario>:
//   rotate  two agents take the two best coins; after a winning trade an agent chooses again and
//           starts its next trade with its budget, never more; after a losing trade it leaves
//           that coin alone and trades with what is left of its budget
//   wait    "only coins that pass every scout check": with one such coin and three agents, two
//           wait at no AI cost, and one of them takes the next coin the moment it passes
//   idle    an agent whose coin gives it no order to place moves on after ten minutes, if another
//           coin is free, and stays where it is if none is
//   nolist  the scouts' list stops answering: an agent whose trade has just closed carries on
//           with the coin it has
//   cost    a coin that is too expensive for an agent's money is passed over: a $1,000 agent takes
//           the best coin it can afford, a $300 agent can afford one the $1,000 agent cannot, an
//           agent with nothing affordable waits at no AI cost, and an agent whose coin is (or
//           becomes) clearly too expensive leaves it without its AI being asked
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SC = process.env.SC ?? "rotate";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-"));
process.chdir(dir);
delete process.env.VERCEL;
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE/.test(k)) delete process.env[k];
if (process.env.STORE === "supabase") await (await import(new URL("../pg-fake.mts", import.meta.url).href)).fakeSupabase();
process.env.ANTHROPIC_API_KEY = "fake";
process.env.ANTHROPIC_BASE_URL = "http://fake-claude.local";

let offset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + offset;

// ---------- The fake market: several coins, each with its own price and its own scouts' reading ----------
// side = the money on each side of the pool Jupiter's quotes come from, when Jupiter answers
// (scenario "cost"): a round trip of $1,000 costs about 0.6% + 200,000 / side there.
type Coin = { mint: string; pool: string; symbol: string; price: number; ch1: number; ch5: number; top: number; organic: number; listed: boolean; side: number };
const coin = (symbol: string, over: Partial<Coin> = {}): Coin => ({ mint: `${symbol}Mint1111pump`, pool: `${symbol}Pool1111`, symbol, price: 1.0, ch1: 14, ch5: 1.2, top: 18, organic: 80, listed: true, side: 1_000_000, ...over });
const coins: Coin[] = [];
const bySymbol = (s: string) => coins.find((c) => c.symbol === s)!;
const SOL = "So11111111111111111111111111111111111111112";
const jupToken = (c: Coin) => ({
  id: c.mint, symbol: c.symbol, name: `${c.symbol} coin`, icon: "", usdPrice: c.price, mcap: 5e6, fdv: 5e6, liquidity: 400_000, holderCount: 4200,
  organicScore: c.organic, graduatedAt: new Date(realNow() - 20 * 3600_000).toISOString(),
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: c.top, devBalancePercentage: 0.5, devMints: 1 },
  stats5m: { priceChange: c.ch5, holderChange: 0.6, liquidityChange: 0.4, buyVolume: 60_000, sellVolume: 35_000, numOrganicBuyers: 30, numTraders: 400 },
  stats1h: { priceChange: c.ch1, holderChange: 3, buyVolume: 300_000, sellVolume: 220_000, buyOrganicVolume: 40_000, sellOrganicVolume: 30_000, numOrganicBuyers: 80, numTraders: 1500 },
  tags: ["verified"],
});
const dexPair = (c: Coin) => ({ chainId: "solana", dexId: "test", pairAddress: c.pool, baseToken: { address: c.mint, symbol: c.symbol, name: `${c.symbol} coin` }, priceUsd: String(c.price), priceChange: { m5: c.ch5, h1: c.ch1, h24: 30 }, volume: { m5: 95_000, h1: 520_000, h24: 3e6 }, txns: { h1: { buys: 900, sells: 600 } }, liquidity: { usd: 400_000 }, marketCap: 5e6 });

// ---------- The scripted AI ----------
let aiCalls = 0, planCalls = 0;
const plansFor: Record<string, number> = {};
const staysOut = new Set<string>(); // coins the AI says to stay out of
let listsDown = false; // the scouts' lists come back empty (as when the data source does not answer)
// Jupiter answers quotes only in scenario "cost". Elsewhere it does not, so nothing can be
// measured, and an agent then never passes over a coin for its cost (as before that rule).
let jupiterUp = false, quotes = 0;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("fake-claude.local")) {
    aiCalls++;
    const body = String(init?.body ?? "");
    const about = coins.find((c) => body.includes(c.symbol));
    let out: unknown;
    if (body.includes("independent forecasters")) out = { chances: [70, 70], reason: "Test forecaster." };
    else if (body.includes("manage the exit")) out = { hold: false, winChancePct: 20, target: 1.1, lastExit: 0.9, extraMinutes: 10, reason: "Support broke." };
    else {
      planCalls++;
      if (about) plansFor[about.symbol] = (plansFor[about.symbol] ?? 0) + 1;
      const p = about?.price ?? 1;
      out = about && staysOut.has(about.symbol)
        ? { stance: "AVOID", confidence: 30, riskLevel: "HIGH", reasoning: "Fading volume under resistance; no edge right now.", orders: [{ kind: "buy_dip", triggerPrice: p * 0.9, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: p * 0.84, target: p * 1.03, maxHoldMinutes: 120, winChancePct: 30 }], cancelBelow: 0, cancelAbove: 0, validMinutes: 30 }
        : { stance: "BUY_NOW", confidence: 70, riskLevel: "MEDIUM", reasoning: "Breakout holding on rising volume with room above.", orders: [{ kind: "buy_now", triggerPrice: p * 1.002, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: p * 0.95, target: p * 1.15, maxHoldMinutes: 180, winChancePct: 62 }], cancelBelow: 0, cancelAbove: 0, validMinutes: 60 };
    }
    return json({ id: `m${aiCalls}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }
  if (url.includes("api.jup.ag/swap/")) {
    if (!jupiterUp) return new Response("{}", { status: 503 }); // no Jupiter quotes: costs come from the fake pool's depth
    // A plain pool with `side` dollars on each side and a 0.3% fee per swap (raw amounts, 6 decimals both ways).
    const u = new URL(url);
    const buying = u.searchParams.get("inputMint") === USDC;
    const c = coins.find((x) => x.mint === u.searchParams.get(buying ? "outputMint" : "inputMint"));
    if (!c) return new Response("{}", { status: 404 });
    quotes++;
    const amount = Number(u.searchParams.get("amount"));
    const sideCoins = c.side / c.price, put = (amount / 1e6) * (1 - 0.003);
    const out = buying ? (sideCoins * put) / (c.side + put) : (c.side * put) / (sideCoins + put);
    return json({ inAmount: String(amount), outAmount: String(Math.floor(out * 1e6)), priceImpactPct: "0" });
  }
  if (url.includes("api.jup.ag/tokens/v2/search")) {
    const q = decodeURIComponent(new URL(url).searchParams.get("query") ?? "").split(",");
    return json([...coins.filter((c) => q.includes(c.mint)).map(jupToken), { id: SOL, symbol: "SOL", usdPrice: 150, stats5m: { priceChange: 0.1 }, stats1h: { priceChange: 0.4 }, stats6h: { priceChange: 1 }, stats24h: { priceChange: 2 } }]);
  }
  if (url.includes("api.jup.ag/tokens/v2/")) return json(listsDown ? [] : coins.filter((c) => c.listed).map(jupToken)); // the trending lists the scouts read, best first
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
    const c = coins.find((x) => x.mint === u.searchParams.get("address"));
    const price = c?.price ?? 1;
    const interval = u.searchParams.get("interval");
    const step = interval === "5s" ? 5_000 : interval === "1min" ? 60_000 : interval === "1h" ? 3_600_000 : interval === "1d" ? 86_400_000 : 300_000;
    const last = Math.floor(Date.now() / step) * step;
    const N = 300, CYC = 44;
    // shape[k] = price multiple inside one cycle: 24 flat candles, a breakout, a rally, a drift back
    const shape = (k: number) => (k < 24 ? 1 + Math.sin(k * 2.1) * 0.004 : k === 24 ? 1.03 : k < 33 ? 1.03 + (k - 24) * 0.02 : 1.19 - (k - 33) * (0.19 / 11));
    const rows = Array.from({ length: N }, (_, i) => {
      const t = last - (N - 1 - i) * step;
      if (i === N - 1) return [price, price * 1.002, price * 0.998, price, 900, t, 5]; // forming candle
      const k = ((i - (N - 2 - 24)) % CYC + CYC) % CYC; // the newest closed candle (N-2) is a breakout (k = 24)
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
const { scoreCoin } = await import(new URL("../../src/agents.ts", import.meta.url).href);
await engine.sync();
engine.reset(10_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s`;
const slots = () => { const s: any = engine.getState(); return [{ id: "1", bot: s.bot, lastSignal: s.lastSignal }, ...s.bots] as any[]; };
const agent = (id: string) => slots().find((b) => b.id === id)!;
const on = (id: string): string => agent(id)?.bot.config?.symbol ?? "";
const holding = (id: string) => (engine.getState() as any).positions.find((p: any) => p.source === "bot" && (p.botId ?? "1") === id);
const seenLog = new Map<string, number>();
const showLogs = () => {
  for (const b of slots()) {
    const log = b.bot.log, had = seenLog.get(b.id) ?? 0;
    for (const l of log.slice(0, log.length - had).reverse()) console.log(`   ${at()}  agent ${b.id}: ${l.msg.slice(0, 260)}`);
    seenLog.set(b.id, log.length);
  }
};
// Wait (in real time, the engine checking every 5 seconds) until `done`, at most `max` seconds.
const until = async (note: string, done: () => boolean, max = 90) => {
  console.log(`${at()} [${note}]`);
  let i = 0;
  for (; i < max * 4 && !done(); i++) { await sleep(250); showLogs(); }
  console.log(`   ${at()}  ${done() ? "ready" : "NOT READY (timed out)"} after ${(i / 4).toFixed(0)}s`);
  for (let k = 0; k < 4; k++) { await sleep(250); showLogs(); }
  return done();
};
// The scouts' lists are remembered for 45 seconds (and each coin's own record for 30): moving the
// clock on a minute makes the next look read them again.
const refreshLists = () => { offset += 61_000; };
const base: any = { tf: "5m", positionPct: 100, minConfidence: 0, analyzeEverySec: 1800, checkEverySec: 5, maxDrawdownPct: 25, goalUsd: 1e9, pick: "agent", trailPct: 3, riskPerTradePct: 0, dailyLossPct: 10, cooldownMin: 30, breakEvenAtPct: 6, lockPct: 50, strongMode: false, rewardRule: false, disabled: [] };
const logOf = (id: string) => agent(id).bot.log.map((l: any) => l.msg).join("\n");

if (SC === "rotate") {
  coins.push(coin("QAAA", { organic: 90 }), coin("QBBB", { organic: 75 }), coin("QCCC", { ch1: 1 }), coin("QDDD", { top: 60, organic: 95 }));
  const scores = coins.map((c, i) => { const s = scoreCoin(jupToken(c), i); return `${c.symbol} ${s.total}${s.vetoes.length ? ` (${s.vetoes[0]})` : " passes"}`; });
  console.log("   the scouts' reading:", scores.join(" | "));
  const r = engine.startAutoAgents(base, [1000, 1000], false, 10);
  expect("two auto-pick agents are started in the first two free slots, each with its own budget locked", [r.started, (engine.getState() as any).locked, (engine.getState() as any).available], [["1", "2"], 2000, 8000]);
  await until("the two agents each take a coin and buy", () => !!holding("1") && !!holding("2"), 120);
  const first = [on("1"), on("2")].sort();
  expect("they take the two best coins on the list, one each: never the same coin, never the one with a deal-breaker", first, ["QAAA", "QBBB"]);
  check("each bought with its whole budget", [holding("1"), holding("2")].every((p: any) => Math.abs(p.costUsd - 1000) < 0.01), [holding("1")?.costUsd, holding("2")?.costUsd]);
  check("the log says which coin was chosen and why", /Auto-pick: chose Q(AAA|BBB) \(the scouts' score \d+ of 100, passes every scout check\)/.test(logOf("1")), "");
  const idA = on("1") === "QAAA" ? "1" : "2", idB = idA === "1" ? "2" : "1";

  // A new coin appears at the top of the list, and QAAA runs: its agent sells at a profit and chooses again.
  coins.unshift(coin("QEEE", { organic: 95 }));
  bySymbol("QAAA").price = 1.16;
  await until("QAAA at 1.16: the minimum profit locks", () => !!holding(idA)?.pm, 40);
  bySymbol("QAAA").price = 1.10;
  bySymbol("QAAA").ch5 = -8; // ...and it is dumping now, so it no longer passes
  refreshLists();
  await until("QAAA falls back to 1.10: sold at a profit, and the agent chooses again", () => on(idA) === "QEEE" && !!holding(idA), 150);
  const s1: any = engine.getState();
  const win = s1.trades.find((t: any) => t.side === "SELL" && (t.botId ?? "1") === idA);
  check("its trade closed at a profit", (win?.pnlUsd ?? 0) > 20, win?.pnlUsd);
  expect("after its trade it chose again: the new best coin that is free", on(idA), "QEEE");
  const nextBuy = s1.trades.find((t: any) => t.side === "BUY" && t.symbol === "QEEE");
  check("its next trade starts with its budget, never more: the profit is not added to it", !!nextBuy && Math.abs(nextBuy.usd - 1000) < 0.01, nextBuy?.usd);
  check("the profit went back to the account's available cash", Math.abs(s1.available - (8000 + win.pnlUsd)) < 0.5, { available: s1.available, profit: win?.pnlUsd });
  check("the log says it chose again after its trade", /Auto-pick: after its trade, chose QEEE/.test(logOf(idA)), "");

  // QBBB falls through its stop: a loss. Its agent leaves QBBB alone and trades on with what is left.
  bySymbol("QBBB").price = 0.90;
  refreshLists();
  await until("QBBB at 0.90: stopped out, and the agent chooses again", () => !holding(idB) && !!on(idB) && on(idB) !== "QBBB", 150);
  await until("...and buys its next coin", () => !!holding(idB), 120);
  const s2: any = engine.getState();
  const loss = s2.trades.find((t: any) => t.side === "SELL" && (t.botId ?? "1") === idB);
  check("its trade closed at a loss", (loss?.pnlUsd ?? 0) < -50, loss?.pnlUsd);
  check("after a losing trade it does not take the same coin again (it rests for half an hour)", on(idB) !== "QBBB" && on(idB) !== "QEEE" && on(idB) !== "QDDD", on(idB));
  const reBuy = s2.trades.find((t: any) => t.side === "BUY" && (t.botId ?? "1") === idB && t.symbol === on(idB));
  check("it trades on with what is left of its budget: the loss is not topped up", !!reBuy && Math.abs(reBuy.usd - (1000 + loss.pnlUsd)) < 0.5, { bought: reBuy?.usd, left: 1000 + (loss?.pnlUsd ?? 0) });
  check("no agent was ever on the coin with a deal-breaker", !slots().some((b) => /QDDD/.test(b.bot.log.map((l: any) => l.msg).join(" "))) && !s2.trades.some((t: any) => t.symbol === "QDDD"), "");
  check("two agents never held the same coin", new Set(s2.positions.map((p: any) => p.pool)).size === s2.positions.length, s2.positions.map((p: any) => p.symbol));
}

if (SC === "wait") {
  coins.push(coin("QAAA", { organic: 90 }), coin("QCCC", { ch1: 1 }), coin("QFFF", { organic: 85, listed: false }));
  const r = engine.startAutoAgents(base, [500, 300, 200], true, 10);
  expect("three agents are started, asked to take only coins that pass every scout check", [r.started, (engine.getState() as any).locked], [["1", "2", "3"], 1000]);
  await until("one coin passes: one agent takes it and buys, the other two wait", () => slots().filter((b) => b.bot.config?.pool).length === 1 && (engine.getState() as any).positions.length === 1 && slots().filter((b) => b.bot.running && b.bot.auto?.note).length === 2, 120);
  const waiting = slots().filter((b) => b.bot.running && !b.bot.config?.pool);
  expect("one agent is on the coin that passes; the other two have none", [slots().filter((b) => b.bot.config?.symbol === "QAAA").length, waiting.length], [1, 2]);
  check("a waiting agent says why, on its card and in its log", waiting.every((b) => /pass(es)? every scout check right now/.test(b.bot.auto?.note ?? "") && /no AI cost/.test(b.bot.auto.note) && b.bot.log.some((l: any) => l.msg.startsWith("Auto-pick: "))), waiting.map((b) => b.bot.auto?.note));
  expect("only the agent with a coin asked its AI: waiting costs no AI tokens", Object.keys(plansFor), ["QAAA"]);
  check("a waiting agent's budget stays set aside for it", Math.abs((engine.getState() as any).locked - waiting.reduce((s2, b) => s2 + b.bot.config.budgetUsd, 0)) < 0.01, (engine.getState() as any).locks);
  check("the coin that only fails a timing check is not taken in this mode", !slots().some((b) => b.bot.config?.symbol === "QCCC"), "");
  const before = planCalls;
  await sleep(12_000); showLogs();
  expect("while they wait, nothing more is asked of the AI for them", planCalls - before <= 1, true);

  // Another coin starts to pass: one of the waiting agents takes it at its next look.
  bySymbol("QFFF").listed = true;
  refreshLists();
  await until("a second coin passes: a waiting agent takes it", () => slots().some((b) => b.bot.config?.symbol === "QFFF"), 90);
  expect("the next coin that passes is taken by one waiting agent, and the third still waits", [slots().filter((b) => b.bot.config?.symbol === "QFFF").length, slots().filter((b) => b.bot.running && !b.bot.config?.pool).length], [1, 1]);
}

if (SC === "idle") {
  coins.push(coin("QXXX", { organic: 95 }), coin("QYYY", { organic: 70 }));
  staysOut.add("QXXX");
  const r = engine.startAutoAgents(base, [1000], false, 10);
  expect("one auto-pick agent is started", r.started, ["1"]);
  await until("it takes the best coin, and its AI says to stay out", () => on("1") === "QXXX" && agent("1").lastSignal?.consensus.stance === "AVOID", 90);
  expect("it is on the best coin, with no order to place", [on("1"), (engine.getState() as any).positions.length], ["QXXX", 0]);
  await sleep(11_000); showLogs();
  expect("a few seconds without an order are no reason to leave", on("1"), "QXXX");
  offset += engine.AUTO_IDLE_MS + 30_000; console.log("   ...clock +10.5 min");
  await until("ten minutes with no order to place: it moves to the next coin that is free", () => on("1") === "QYYY", 120);
  expect("it moved on to the next coin", on("1"), "QYYY");
  check("the log says why it moved", /Auto-pick: QXXX gave it no order to place for \d+ minutes, so it moved on and chose QYYY/.test(logOf("1")), logOf("1").split("\n").find((l: string) => l.startsWith("Auto-pick")));
  await until("on the new coin its AI says buy, and it buys", () => !!holding("1"), 120);
  expect("it trades the coin it moved to", holding("1")?.symbol, "QYYY");
  check("the coin it left is not tried again for half an hour", ((engine.getState() as any).bot.autoSkip?.[bySymbol("QXXX").mint] ?? 0) > Date.now() + 20 * 60_000, (engine.getState() as any).bot.autoSkip);

  // With nowhere else to go, an agent stays on its coin.
  engine.stopBot("test: second part", "1");
  const p: any = holding("1");
  if (p) engine.sell(p.id, 1.0, 1, "test: closing");
  coins.length = 0;
  coins.push(coin("QZZZ", { organic: 95 }));
  staysOut.add("QZZZ");
  refreshLists();
  const r2 = engine.startAutoAgents(base, [500], false, 10);
  await until("a single coin on the list, and its AI says to stay out", () => on(r2.started[0]) === "QZZZ" && agent(r2.started[0]).lastSignal?.consensus.stance === "AVOID", 90);
  offset += engine.AUTO_IDLE_MS + 30_000; console.log("   ...clock +10.5 min");
  await sleep(14_000); showLogs();
  expect("with no other coin free it stays on its coin and keeps looking", [on(r2.started[0]), agent(r2.started[0]).bot.running], ["QZZZ", true]);
}

if (SC === "nolist") {
  coins.push(coin("QAAA", { organic: 90 }), coin("QBBB", { organic: 75 }));
  engine.startAutoAgents(base, [1000], false, 10);
  await until("it takes the best coin and buys", () => !!holding("1"), 120);
  expect("it is on the best coin, in a trade", [on("1"), holding("1")?.symbol], ["QAAA", "QAAA"]);
  // The scouts' lists stop answering; then its trade closes at a profit.
  listsDown = true;
  bySymbol("QAAA").price = 1.16;
  await until("QAAA at 1.16: the minimum profit locks", () => !!holding("1")?.pm, 40);
  bySymbol("QAAA").price = 1.10;
  refreshLists();
  await until("sold at a profit while the scouts' list cannot be read", () => /could not be loaded after its trade/.test(logOf("1")), 150);
  const s1: any = engine.getState();
  check("its trade closed at a profit", (s1.trades.find((t: any) => t.side === "SELL")?.pnlUsd ?? 0) > 20, s1.trades.find((t: any) => t.side === "SELL")?.pnlUsd);
  expect("with the list unreadable after its trade, it keeps the coin it has and keeps running", [on("1"), agent("1").bot.running], ["QAAA", true]);
  check("its log says so", /Auto-pick: the scouts' list could not be loaded after its trade, so it stays on QAAA for now/.test(logOf("1")), "");
  await until("it trades that coin again", () => s1 && (engine.getState() as any).trades.filter((t: any) => t.side === "BUY" && t.symbol === "QAAA").length === 2, 120);
  expect("and it carries on trading it: a second buy of the same coin, with its budget and never more", [(engine.getState() as any).trades.filter((t: any) => t.side === "BUY" && t.symbol === "QAAA").length, Math.round((engine.getState() as any).trades.find((t: any) => t.side === "BUY").usd)], [2, 1000]);
  // A waiting agent (no coin) keeps asking for the list and says why it waits.
  const r2 = engine.startAutoAgents(base, [500], false, 10);
  await until("a new agent, with the list still unreadable, waits", () => /could not be loaded/.test(agent(r2.started[0]).bot.auto?.note ?? ""), 60);
  expect("an agent with no coin waits while the list cannot be read, and takes a coin when it can", [on(r2.started[0]), /could not be loaded just now/.test(agent(r2.started[0]).bot.auto?.note ?? "")], ["", true]);
  listsDown = false;
  refreshLists();
  await until("the list is back: the waiting agent takes the next coin", () => on(r2.started[0]) === "QBBB", 90);
  expect("when the list is back it takes the best coin that is free", on(r2.started[0]), "QBBB");
}

if (SC === "cost") {
  // Jupiter answers here, so what a coin costs to trade is measured. A round trip of $1,000 costs
  // about 3.8% on QDEAR, 1.7% on QMIDD and 0.8% on QCHEP; of $300, about 1.6% on QDEAR and 0.9% on
  // QMIDD. The scouts rank them QDEAR, QMIDD, QCHEP.
  jupiterUp = true;
  const costs = await import(new URL("../../src/costs.ts", import.meta.url).href);
  coins.push(coin("QDEAR", { organic: 95, side: 60_000 }), coin("QMIDD", { organic: 85, side: 180_000 }), coin("QCHEP", { organic: 75, side: 1_000_000 }));
  const scores = coins.map((c, i) => { const sc = scoreCoin(jupToken(c), i); return `${c.symbol} ${sc.total}${sc.vetoes.length ? ` (${sc.vetoes[0]})` : " passes"}`; });
  console.log("   the scouts' reading:", scores.join(" | "));
  const autoLine = (id: string, re: RegExp) => logOf(id).split("\n").find((l: string) => re.test(l));
  const costOf = (id: string) => (agent(id).bot.costCurve ? Math.round(costs.costAt(agent(id).bot.costCurve, 1000) * 10) / 10 : null);
  const noteOf = (id: string): string => agent(id).bot.auto?.note ?? "";

  // One agent with $1,000.
  const [a1] = engine.startAutoAgents(base, [1000], false, 10).started;
  check("the start message says that coins too expensive for its money are passed over", /passing over a coin where buying and selling its money would cost more than 1\.5%/.test(logOf(a1)), logOf(a1));
  await until("it measures the two coins at the top of the list: both are too expensive for $1,000", () => /finding out what the free coins/.test(noteOf(a1)), 90);
  check("its card says what it is doing, and that it costs no AI tokens",
    /^it is finding out what the free coins on the list cost to trade with its \$1,000: 2 so far are too expensive\. Too expensive means that buying and selling there would cost more than 1\.5% of the trade \(QDEAR, QMIDD\)\. It goes on in half a minute, at no AI cost$/.test(noteOf(a1)), noteOf(a1));
  expect("one look measures two coins at most (four quotes each), so pricing the list never holds up the agents' own looks", [on(a1), quotes], ["", 8]);
  offset += 31_000; console.log("   ...clock +31 s");
  await until("half a minute later it measures the third coin, can afford it, takes it and buys", () => !!holding(a1), 150);
  expect("the $1,000 agent passes over the two coins higher on the list and takes the best one it can afford", on(a1), "QCHEP");
  check("its log says what its coin costs to trade and which coins it passed over, with their cost",
    /Auto-pick: chose QCHEP \(the scouts' score \d+ of 100, passes every scout check\)\. Buying and selling its \$1,000 there costs about 0\.8%\. It passed over QDEAR \(3\.8%\) and QMIDD \(1\.7%\), higher on the list: more than the 1\.5% it accepts\. Its AI reads the charts now\./.test(logOf(a1)), autoLine(a1, /^Auto-pick: chose/));
  check("it bought with its whole budget, and the trade is charged the cost that was measured", Math.abs(holding(a1).costUsd - 1000) < 0.01 && Math.abs(holding(a1).costPct - 0.8) < 0.06, [holding(a1)?.costUsd, holding(a1)?.costPct]);
  expect("its AI was asked about the coin it took, never about the two it passed over", Object.keys(plansFor), ["QCHEP"]);
  expect("three coins measured in all, once each", quotes, 12);
  // What each line decided is kept with it (for the app's one-line log).
  const decided = (id: string, act: string, coin?: string) => agent(id).bot.log.map((l: any) => l.d).filter((d: any) => d && d.act === act && (coin === undefined || d.coin === coin));
  check("choosing the coin is kept as a decision: its score, its cost, and what was passed over", decided(a1, "pick", "QCHEP").some((d: any) => /^the scouts' score \d+ of 100, costs 0\.8% to trade with its \$1,000; passed over QDEAR \(3\.8%\) and QMIDD \(1\.7%\)$/.test(d.why)), decided(a1, "pick"));
  check("while it was measuring, having no coin yet was kept as a decision too", decided(a1, "wait").some((d: any) => /^finding out what the free coins cost to trade with its \$1,000 \(2 too expensive so far\)$/.test(d.why)), decided(a1, "wait"));
  check("the buy is kept as a decision with its size", decided(a1, "enter", "QCHEP").some((d: any) => Math.abs(d.usd - 1000) < 0.01 && d.of === 1000 && /costs 0\.8% to trade$/.test(d.why)), decided(a1, "enter"));

  // A second agent, with $300: a small trade moves the price less.
  const [a2] = engine.startAutoAgents(base, [300], false, 10).started;
  await until("an agent with $300 takes a coin and buys", () => !!holding(a2), 120);
  expect("the $300 agent can afford a coin the $1,000 agent cannot: it takes the second on the list", on(a2), "QMIDD");
  check("its log does the same sums for its own money",
    /Auto-pick: chose QMIDD \(the scouts' score \d+ of 100, passes every scout check\)\. Buying and selling its \$300 there costs about 0\.9%\. It passed over QDEAR \(1\.6%\), higher on the list: more than the 1\.5% it accepts\. Its AI reads the charts now\./.test(logOf(a2)), autoLine(a2, /^Auto-pick: chose/));
  check("it bought with its whole budget at the cost measured for $300", Math.abs(holding(a2).costUsd - 300) < 0.01 && Math.abs(holding(a2).costPct - 0.94) < 0.06, [holding(a2)?.costUsd, holding(a2)?.costPct]);
  expect("what one agent measured the next one reads: no new quotes", quotes, 12);

  // Two more $1,000 agents: nothing is left that they can afford, so they wait.
  const [w1, w2] = engine.startAutoAgents(base, [1000, 1000], false, 10).started;
  await until("two more $1,000 agents have nothing they can afford, and wait", () => [w1, w2].every((id) => /too expensive for its/.test(noteOf(id))), 60);
  expect("they have no coin", [on(w1), on(w2)], ["", ""]);
  check("a waiting agent's card says why: the coins are with your other agents or too expensive for its money, and waiting costs no AI tokens",
    /^the 3 coins that are fit to trade right now are with your other agents \(2\) or too expensive for its \$1,000 \(1\)\. Too expensive means that buying and selling there would cost more than 1\.5% of the trade \(QDEAR\)\. It waits, at no AI cost, and looks again every half minute$/.test(noteOf(w1)), noteOf(w1));
  expect("the AI was still never asked about the expensive coin", Object.keys(plansFor).sort(), ["QCHEP", "QMIDD"]);
  check("waiting with no coin it can afford is kept as a decision, in a few words", decided(w1, "wait").some((d: any) => d.why === "no coin free: 2 with your other agents, 1 too expensive for its $1,000 (QDEAR)"), decided(w1, "wait"));
  check("their budgets stay set aside for them", Math.abs((engine.getState() as any).locked - 2000) < 0.01, (engine.getState() as any).locked);
  expect("...and they measured nothing again", quotes, 12);

  // A coin they can afford appears. Its AI will say to stay out, so the agent that takes it sits there with no order.
  staysOut.add("QNEWW");
  coins.push(coin("QNEWW", { organic: 70, side: 1_000_000 }));
  refreshLists();
  await until("a coin they can afford is listed: one of them measures it and takes it", () => [w1, w2].some((id) => on(id) === "QNEWW"), 120);
  const mover = on(w1) === "QNEWW" ? w1 : w2, waiter = mover === w1 ? w2 : w1;
  await until("...and the other one sees it is taken", () => /your other agents \(3\)/.test(noteOf(waiter)), 60);
  expect("one takes the new coin, the other still waits", [on(mover), on(waiter)], ["QNEWW", ""]);
  check("the waiting agent's card shows the new count", /are with your other agents \(3\) or too expensive for its \$1,000 \(1\)/.test(noteOf(waiter)), noteOf(waiter));
  expect("...but its log is not written again when only a count in the reason moves", agent(waiter).bot.log.filter((l: any) => /^Auto-pick: the \d+ coins/.test(l.msg)).length, 1);
  expect("the new coin was measured once, by the agent that took it", quotes, 16);
  await until("on the new coin its AI says to stay out", () => agent(mover).lastSignal?.consensus.stance === "AVOID", 90);

  // The next steps move the clock ten minutes at a time. The fake market draws its candles from
  // the clock, which would shake the two open trades, so they are closed first and their coins
  // leave the list. Two coins are left: QDEAR (too expensive) and QNEWW (the agent's own).
  for (const id of [a1, a2]) {
    engine.stopBot("test: next part", id);
    const p: any = holding(id);
    if (p) engine.sell(p.id, 1.0, 1, "test: closing");
  }
  bySymbol("QMIDD").listed = false;
  bySymbol("QCHEP").listed = false;
  refreshLists();
  await sleep(7_000); showLogs();
  expect("(two coins are listed now; the agent on QNEWW is still there, the other still waits)", [on(mover), on(waiter)], ["QNEWW", ""]);

  // The coin's pool thins a little: $1,000 now costs about 1.7% there, just over the line.
  let asked = plansFor.QNEWW ?? 0;
  bySymbol("QNEWW").side = 180_000;
  offset += 10.5 * 60_000; console.log("   ...QNEWW's pool thins: $1,000 costs about 1.7% there now; clock +10.5 min (a measurement stands for ten)");
  await until("its AI looks again, with the cost measured again", () => (plansFor.QNEWW ?? 0) > asked, 120);
  await sleep(7_000); showLogs();
  expect("a coin that drifts just over the line does not send its agent away: it leaves only when clearly over (by 0.5 points)", [on(mover), costOf(mover)], ["QNEWW", 1.7]);

  // The pool thins a lot: $1,000 now costs about 4.4% there. Its AI is not asked about it any more, and it leaves.
  asked = plansFor.QNEWW ?? 0;
  bySymbol("QNEWW").side = 50_000;
  offset += 10.5 * 60_000; console.log("   ...QNEWW's pool thins much more: $1,000 costs about 4.4% there now; clock +10.5 min");
  await until("at its next look the cost is measured, and its AI is not asked", () => /The AI was not asked after all/.test(logOf(mover)), 120);
  check("its log says why the AI was not asked, and that no AI tokens were spent", /The AI was not asked after all \(no AI tokens spent\): buying and selling its \$1,000 on QNEWW costs about 4\.4% now, more than the 1\.5% it accepts\. It looks for another coin\./.test(logOf(mover)), autoLine(mover, /not asked after all/));
  expect("its AI was not asked about the coin once it was clearly too expensive", (plansFor.QNEWW ?? 0) - asked, 0);
  check("its AI staying out, and the coin being ruled out for its cost, are kept as decisions", decided(mover, "skip", "QNEWW").length >= 1 && decided(mover, "filtered", "QNEWW").some((d: any) => d.why === "the cost: trading its $1,000 there costs 4.4% now, it accepts 1.5%"), [decided(mover, "skip"), decided(mover, "filtered")]);
  refreshLists();
  await until("it leaves the coin", () => on(mover) === "", 90);
  expect("an agent whose coin becomes clearly too expensive for its money leaves it, and waits for one it can afford", [on(mover), agent(mover).bot.running, holding(mover) ?? null], ["", true, null]);
  check("its log says why", /Auto-pick: left QNEWW: buying and selling its \$1,000 on QNEWW costs about 4\.4%, more than the 1\.5% it accepts\. No other coin is free for it right now\./.test(logOf(mover)), autoLine(mover, /^Auto-pick: left/));
  check("the coin is not put to rest for the account's other agents: one with less money may afford it", !((engine.getState() as any).bot.autoSkip ?? {})[bySymbol("QNEWW").mint], (engine.getState() as any).bot.autoSkip);
  check("leaving the coin is kept as a decision", decided(mover, "left", "QNEWW").some((d: any) => d.why === "the cost: trading its $1,000 there costs 4.4%, it accepts 1.5%; no other coin is free"), decided(mover, "left"));
  check("what was measured is kept with the account for all its agents", ["QDEAR", "QNEWW"].every((sym) => (engine.getState() as any).bot.autoCost?.[bySymbol(sym).mint]?.source === "jupiter"), Object.keys((engine.getState() as any).bot.autoCost ?? {}));

  // Agents that were started before this rule existed sit on whatever was best, whatever it cost.
  // Two agents are started with the rule switched off; their AI says to stay out, so they sit with no order.
  engine.stopBot("test: next part", mover);
  engine.stopBot("test: next part", waiter);
  staysOut.add("QDEAR");
  const [y, z] = engine.startAutoAgents({ ...base, autoMaxCostPct: 0 }, [1000, 1000], false, 10).started;
  await until("two agents with the rule switched off take the two free coins, whatever they cost", () => [y, z].every((id) => !!on(id) && agent(id).lastSignal?.consensus.stance === "AVOID"), 150);
  expect("with the rule off for an agent, it takes the best coin that is free, whatever it costs (as before this rule)", [on(y), on(z), costOf(y), costOf(z)], ["QDEAR", "QNEWW", 3.8, 4.4]);

  // The rule now applies to the first of them, and no coin it can afford is free.
  const since = Date.now();
  asked = plansFor.QDEAR ?? 0;
  delete agent(y).bot.config.autoMaxCostPct;
  await until("the agent sitting on the coin that is too expensive leaves it", () => on(y) === "", 60);
  expect("an agent already sitting on a coin that is too expensive for its money leaves it at its next check, and waits", [on(y), agent(y).bot.running], ["", true]);
  check("its log says why", /Auto-pick: left QDEAR: buying and selling its \$1,000 on QDEAR costs about 3\.8%, more than the 1\.5% it accepts\. No other coin is free for it right now\./.test(logOf(y)), autoLine(y, /^Auto-pick: left/));
  check("it did not wait the ten minutes an agent gives a coin that has no order for it", Date.now() - since < 60_000, `${Math.round((Date.now() - since) / 1000)} s`);
  await sleep(12_000); showLogs();
  expect("while it waits, its AI is asked nothing more about that coin", (plansFor.QDEAR ?? 0) - asked, 0);

  // The rule now applies to the second, and this time a coin it can afford is free.
  engine.stopBot("test: last part", y);
  coins.push(coin("QFREE", { organic: 50, side: 1_000_000 }));
  refreshLists();
  delete agent(z).bot.config.autoMaxCostPct;
  await until("with a coin it can afford free, the other agent moves to it", () => on(z) === "QFREE", 120);
  expect("it moved to the coin it can afford instead of waiting", on(z), "QFREE");
  check("its log says why it moved, what the new coin costs, and what it passed over",
    /Auto-pick: buying and selling its \$1,000 on QNEWW costs about 4\.4%, more than the 1\.5% it accepts, so it moved on and chose QFREE \(the scouts' score \d+ of 100[^)]*\)\. Buying and selling its \$1,000 there costs about 0\.8%\. It passed over QDEAR \(3\.8%\), higher on the list: more than the 1\.5% it accepts\. Its AI reads the charts now\./.test(logOf(z)), autoLine(z, /moved on and chose/));
  check("the coin it left for its cost is not put to rest either", !((engine.getState() as any).bot.autoSkip ?? {})[bySymbol("QNEWW").mint], (engine.getState() as any).bot.autoSkip);
  check("moving to another coin is kept as one decision that says what it left and why", decided(z, "pick", "QFREE").some((d: any) => /^left QNEWW: it costs 4\.4% to trade; the scouts' score \d+ of 100, costs 0\.8% to trade with its \$1,000; passed over QDEAR \(3\.8%\)$/.test(d.why)), decided(z, "pick"));

  // Two agents started together, two coins nobody has measured: one coin is measured at a time,
  // and the agent that has to wait for its turn looks again in a few seconds, not in half a minute.
  coins.push(coin("QTWOA", { organic: 45, side: 1_000_000 }), coin("QTWOB", { organic: 40, side: 1_000_000 }));
  for (const sym of ["QTWOA", "QTWOB"]) staysOut.add(sym);
  refreshLists();
  const q0 = quotes;
  let sawTurn = "";
  const [p1, p2] = engine.startAutoAgents(base, [1000, 1000], false, 10).started;
  await until("two agents started together each measure a coin, one after the other, and take it", () => { for (const id of [p1, p2]) if (/in a few seconds/.test(noteOf(id))) sawTurn = noteOf(id); return !!on(p1) && !!on(p2); }, 90);
  expect("each took one of the two coins", [on(p1), on(p2)].sort(), ["QTWOA", "QTWOB"]);
  check("the one that found the other's measurement under way waited for its turn, and said it would go on in a few seconds", /^it is finding out what the free coins on the list cost to trade with its \$1,000.* It goes on in a few seconds, at no AI cost$/.test(sawTurn), sawTurn);
  expect("two coins were measured, once each", quotes - q0, 8);
}

{
  const s: any = engine.getState();
  console.log(`RESULT ${SC}: AI calls ${aiCalls} (plans ${JSON.stringify(plansFor)}) | trades: ${s.trades.slice().reverse().map((t: any) => `${t.side} ${t.symbol} $${t.usd.toFixed(0)}${t.pnlUsd !== undefined ? ` (P&L $${t.pnlUsd.toFixed(2)})` : ""} by ${t.botId ?? "1"}`).join(" | ") || "none"} | open=${s.positions.length}`);
}
for (const b of slots()) if (b.bot.running) engine.stopBot("test over", b.id);
await engine.flush();
finish();
