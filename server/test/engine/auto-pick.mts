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
type Coin = { mint: string; pool: string; symbol: string; price: number; ch1: number; ch5: number; top: number; organic: number; listed: boolean };
const coin = (symbol: string, over: Partial<Coin> = {}): Coin => ({ mint: `${symbol}Mint1111pump`, pool: `${symbol}Pool1111`, symbol, price: 1.0, ch1: 14, ch5: 1.2, top: 18, organic: 80, listed: true, ...over });
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
  if (url.includes("api.jup.ag/swap/")) return new Response("{}", { status: 503 }); // no Jupiter quotes in tests: costs come from the fake pool's depth
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

{
  const s: any = engine.getState();
  console.log(`RESULT ${SC}: AI calls ${aiCalls} (plans ${JSON.stringify(plansFor)}) | trades: ${s.trades.slice().reverse().map((t: any) => `${t.side} ${t.symbol} $${t.usd.toFixed(0)}${t.pnlUsd !== undefined ? ` (P&L $${t.pnlUsd.toFixed(2)})` : ""} by ${t.botId ?? "1"}`).join(" | ") || "none"} | open=${s.positions.length}`);
}
for (const b of slots()) if (b.bot.running) engine.stopBot("test over", b.id);
await engine.flush();
finish();
