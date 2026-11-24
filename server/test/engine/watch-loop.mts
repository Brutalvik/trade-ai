// The bot as it runs in production: no timer of its own, a scheduler's call that watches every
// account for a while (engine.watchAll), the account kept in Supabase, and a second server copy
// (the dashboard) reading and writing the same account. Real 5-second steps, a fake market, a
// scripted AI. What the watching server asks the database for is counted.
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|SKIP_UPSTASH/.test(k)) delete process.env[k];
process.env.VERCEL = "1"; // as deployed: the engine starts no timer; only the scheduler's call makes it look
process.env.ANTHROPIC_API_KEY = "fake";
process.env.ANTHROPIC_BASE_URL = "http://fake-claude.local";
process.env.OWNER_USERNAME = "tester"; // the owner's own account: the top plan, so its agent may ask the AI
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
const fake = await fakeSupabase();

const POOL = "WatchPool1111", MINT = "WatchMint1111pump";
let price = 1.0, planCalls = 0, aiCalls = 0;
const jupToken = () => ({
  id: MINT, symbol: "WCH", name: "Watch Test", icon: "", usdPrice: price, mcap: 5e6, fdv: 5e6, liquidity: 400_000, holderCount: 4200,
  organicScore: 72, graduatedAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18, devBalancePercentage: 0.5, devMints: 1 },
  stats5m: { priceChange: 1.2, holderChange: 0.6, liquidityChange: 0.4, buyVolume: 60_000, sellVolume: 35_000, numOrganicBuyers: 30, numTraders: 400 },
  stats1h: { priceChange: 14, holderChange: 3, buyVolume: 300_000, sellVolume: 220_000, buyOrganicVolume: 40_000, sellOrganicVolume: 30_000, numOrganicBuyers: 80, numTraders: 1500 },
  tags: ["verified"],
});
const dexPair = () => ({ chainId: "solana", dexId: "test", pairAddress: POOL, baseToken: { address: MINT, symbol: "WCH", name: "Watch Test" }, priceUsd: String(price), priceChange: { m5: 1.2, h1: 14, h24: 30 }, volume: { m5: 95_000, h1: 520_000, h24: 3e6 }, txns: { h1: { buys: 900, sells: 600 } }, liquidity: { usd: 400_000 }, marketCap: 5e6 });
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch; // the fake Supabase is already in it
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("fake-claude.local")) {
    aiCalls++;
    const body = String(init?.body ?? "");
    const say = (out: unknown) => json({ id: `m${aiCalls}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    if (body.includes("independent forecasters")) return say({ chances: [70, 70], reason: "Test forecaster." });
    if (body.includes("manage the exit")) return say({ hold: false, winChancePct: 20, target: 1.1, lastExit: 0.9, extraMinutes: 10, reason: "Support broke." });
    planCalls++;
    return say({ stance: "BUY_NOW", confidence: 70, riskLevel: "MEDIUM", reasoning: "Breakout holding on rising volume with room above.", orders: [{ kind: "buy_now", triggerPrice: 1.002, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: 0.95, target: 1.15, maxHoldMinutes: 180, winChancePct: 62 }], cancelBelow: 0, cancelAbove: 0, validMinutes: 60 });
  }
  if (url.includes("api.jup.ag/swap/")) return new Response("{}", { status: 503 }); // costs come from the fake pool's depth
  if (url.includes("api.jup.ag/tokens/v2/")) return json([jupToken()]);
  if (url.includes("api.dexscreener.com/tokens/v1/solana/")) return json([dexPair()]);
  if (url.includes("api.dexscreener.com/latest/dex/pairs")) return json({ pairs: [dexPair()] });
  if (url.includes("coinmarketcap.com")) {
    const interval = new URL(url).searchParams.get("interval");
    const step = interval === "5s" ? 5_000 : interval === "1min" ? 60_000 : interval === "15min" ? 900_000 : interval === "1h" ? 3_600_000 : interval === "1d" ? 86_400_000 : 300_000;
    const last = Math.floor(Date.now() / step) * step;
    const N = 300, CYC = 44;
    const shape = (k: number) => (k < 24 ? 1 + Math.sin(k * 2.1) * 0.004 : k === 24 ? 1.03 : k < 33 ? 1.03 + (k - 24) * 0.02 : 1.19 - (k - 33) * (0.19 / 11));
    const rows = Array.from({ length: N }, (_, i) => {
      const t = last - (N - 1 - i) * step;
      if (i === N - 1) return [price, price * 1.002, price * 0.998, price, 900, t, 5];
      const k = ((i - (N - 2 - 24)) % CYC + CYC) % CYC;
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
const { newStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const dash = newStore(); // "the dashboard": another server copy on the same database
const KEY = "tester";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const since = (mark: number) => ({ rev: fake.count("trade_account_rev", mark), load: fake.count("trade_account_load", mark), save: fake.count("trade_account_save", mark), calls: fake.calls.length - mark, kb: Math.round(fake.received(mark) / 102.4) / 10 });
const cfg = { chain: "solana", pool: POOL, symbol: "WCH", tf: "5m", positionPct: 100, minConfidence: 45, analyzeEverySec: 1800, checkEverySec: 5, maxDrawdownPct: 25, goalUsd: 1e9, pick: "agent", budgetUsd: 1000, trailPct: 3, riskPerTradePct: 0, dailyLossPct: 10, cooldownMin: 30, breakEvenAtPct: 6, lockPct: 50, strongMode: true, rewardRule: true, disabled: [] };

await engine.ensureMigrated();
await engine.withAccount(KEY, async () => {
  await engine.sync();
  engine.reset(1000);
  await engine.flush();
  engine.startBot(cfg as any, "1", 10);
  await engine.flush();
});
expect("the account with a running agent is on the scheduler's list", await engine.activeAccounts(), [KEY]);

// ---- the scheduler's first call: the agent asks its AI and buys ----
let mark = fake.calls.length;
let w = await engine.watchAll(40_000, "scheduler");
let m = since(mark);
let stored: any = await dash.load(KEY);
console.log(`window 1: ${w.results[0].ticks} checks, ${w.results[0].reason} | database calls ${m.calls} (version ${m.rev}, loads ${m.load}, saves ${m.save}), ${m.kb} KB received`);
check("the scheduler's call wakes the agent: it asks its AI and buys", w.accounts === 1 && w.results[0].ticks >= 1 && planCalls >= 1 && stored.positions.length === 1 && stored.trades.some((t: any) => t.side === "BUY"), { ticks: w.results[0].ticks, planCalls, open: stored.positions.length });
check("each check asks the database for the version; the watching server never loads its own account back", m.rev >= w.results[0].ticks && m.rev <= w.results[0].ticks + 3 && m.load === 0, m);
expect("the watch lock is given back, and the wake-up is recorded for the dashboard", [await dash.lock(`watch:${KEY}`, 1000), stored.bot.lastWatch?.by], [true, "scheduler"]);
await dash.unlock(`watch:${KEY}`);

// ---- a quiet window with the trade open: what does watching cost? ----
mark = fake.calls.length;
w = await engine.watchAll(30_000, "scheduler");
m = since(mark);
console.log(`window 2 (trade open, price steady): ${w.results[0].ticks} checks | database calls ${m.calls} (version ${m.rev}, loads ${m.load}, saves ${m.save}), ${m.kb} KB received`);
check("an open trade is watched in 5-second steps for the whole window, and that costs a few kilobytes, not the account six times over", m.load === 0 && m.kb < 6 && w.results[0].ticks >= 5 && w.results[0].reason === "window ended", { ...m, ticks: w.results[0].ticks, reason: w.results[0].reason });

// ---- the dashboard (another server copy) reads along ----
mark = fake.calls.length;
const view1: any = (await dash.loadRev(KEY)).value;
const viewAgain = since(mark);
check("the dashboard's copy sees the open trade", view1.positions.length === 1 && view1.bot.running === true, { open: view1.positions.length });

// ---- the price falls through the stop while the scheduler is watching ----
price = 0.9;
mark = fake.calls.length;
w = await engine.watchAll(30_000, "scheduler");
stored = await dash.load(KEY);
console.log(`window 3 (price falls to 0.90): ${w.results[0].ticks} checks, ${w.results[0].reason} | open ${stored.positions.length}, sells ${stored.trades.filter((t: any) => t.side === "SELL").length}`);
check("the stop-loss sale is made and saved", stored.positions.length === 0 && stored.trades.some((t: any) => t.side === "SELL" && t.pnlUsd < 0), { open: stored.positions.length, trades: stored.trades.length });
expect("the permanent trade ledger has the buy and the sale", (await dash.listRange<any>(`ledger:${KEY}`, 0, 9)).map((t) => t.side), ["BUY", "SELL"]);

// ---- Stop pressed on the dashboard while the scheduler's window is running ----
price = 1.0;
const running = engine.watchAll(40_000, "scheduler");
await sleep(7_000);
await engine.withAccount(KEY + "-other", async () => {}); // (nothing: the Stop below goes straight to the database, as another server copy would write it)
const theirs: any = await dash.load(KEY);
const at = Date.now() + 5;
theirs.bot.running = false;
theirs.bot.stoppedAt = at;
await dash.save(theirs, KEY);
await dash.kvSet(`ctl:${KEY}`, { resetAt: theirs.resetAt, stops: { "1": at } });
const t0 = Date.now();
w = await running;
const tookSec = (Date.now() - t0) / 1000;
stored = await dash.load(KEY);
console.log(`window 4 (Stop from the dashboard after 7 s): ended ${tookSec.toFixed(1)} s later, ${w.results[0].reason} | stored: running ${stored.bot.running}, open ${stored.positions.length}`);
check("a Stop from the dashboard ends the watch at its next check and stays stopped", w.results[0].reason === "bot stopped" && tookSec < 12 && stored.bot.running === false, { reason: w.results[0].reason, tookSec, running: stored.bot.running });
const after: any = await engine.watchAll(10_000, "scheduler");
expect("...and the next scheduler call finds nothing to run", [after.accounts === 0 || after.results[0]?.reason === "bot is off", (await dash.load<any>(KEY)).bot.running], [true, false]);

const st = engine.storageStats();
console.log(`storage traffic of this server copy over the whole run: ${JSON.stringify(st.calls)}; sent ${Math.round(st.sentBytes / 1024)} KB, received ${Math.round(st.receivedBytes / 1024)} KB`);
console.log(`(the dashboard copy's one reload of the account: ${viewAgain.kb} KB)`);
finish();
