// What an account's agents made together, hour by hour, in a table of its own that is linked to
// the account (trade_agent_hours in supabase/schema.sql; store.hoursAdd / hoursGet; the engine's
// keepHours). Every sale an agent makes is counted into its hour exactly once; your own trades are
// not counted; a database that does not have the table yet loses nothing.
// Runs on the Supabase store (a real Postgres engine in memory, see pg-fake.mts).
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|SKIP_UPSTASH/.test(k)) delete process.env[k];
process.env.VERCEL = "1"; // no local 5-second loop: this test makes its trades by hand
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
const fake = await fakeSupabase();

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 10, 10, 10, 5, 0); // 10 Nov 2026, 10:05 UTC
let now = BASE;
const realNow = Date.now.bind(Date);
const started = realNow();
Date.now = () => now + (realNow() - started);

const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
const { newStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const store = newStore();
await engine.ensureStore();
expect("the server sees which setup script the database has, and that the hours table is there", engine.storageStats()?.schema, { version: 3, hours: true, walletTx: true });

const pair = (symbol: string, priceUsd: number) => ({ chain: "solana", pool: `${symbol}Pool1111`, symbol, name: symbol, priceUsd, liquidityUsd: 500_000, tokenAddress: `${symbol}Mint1111` });
// One round trip: bought at $1.00 and sold at `exit`, by an agent (bot) or by hand.
const trade = (symbol: string, usd: number, exit: number, by: { bot?: string } = {}) => {
  const source = by.bot ? "bot" : "manual";
  engine.buy(pair(symbol, 1), usd, source, "test buy", by.bot ? { botId: by.bot } : undefined);
  const pos = engine.getState().positions.find((p: any) => p.symbol === symbol && p.source === source);
  return engine.sell(pos.id, exit, 1, "test sell");
};
const inAccount = <T,>(key: string, fn: () => T | Promise<T>): Promise<T> => engine.withAccount(key, async () => {
  await engine.sync();
  const out = await fn();
  await engine.flush();
  return out;
});
const cents = (v: number) => Math.round(v * 100) / 100;
const hours = (key: string) => engine.withAccount(key, () => engine.agentHours(0, Date.now() + HOUR));

// ---------- One hour, two agents ----------
const sold = await inAccount("worker", () => [trade("AAA", 100, 1.2, { bot: "1" }), trade("BBB", 100, 0.9, { bot: "2" })]);
await inAccount("worker", () => {}); // the marks are saved with the next save
{
  const r = await hours("worker");
  const row = r.rows[0];
  expect("two agents each closed a trade: one row for the hour, with what they made together", [r.ready, r.rows.length, new Date(row.hour).toISOString(), row.trades, row.wins, row.losses, cents(row.pnlUsd)], [true, 1, "2026-11-10T10:00:00.000Z", 2, 1, 1, cents(sold[0].pnlUsd + sold[1].pnlUsd)]);
  expect("and each agent's own share of it, with the coin it traded", [Object.keys(row.agents).sort(), cents(row.agents["1"].pnl), row.agents["1"].wins, row.agents["1"].symbols, cents(row.agents["2"].pnl), row.agents["2"].losses, row.agents["2"].symbols], [["1", "2"], cents(sold[0].pnlUsd), 1, ["AAA"], cents(sold[1].pnlUsd), 1, ["BBB"]]);
  check("the profit is the real one, after costs (a 20% rise made less than $20 on $100)", sold[0].pnlUsd > 10 && sold[0].pnlUsd < 20 && sold[1].pnlUsd < -10, sold.map((t: any) => cents(t.pnlUsd)));
  const marked = await inAccount("worker", () => engine.getState().trades.filter((t: any) => t.side === "SELL").map((t: any) => t.hr));
  expect("each counted sale is marked on the trade, and the mark is saved", marked, [1, 1]);
  const before = fake.count("trade_hour_add");
  await inAccount("worker", () => {});
  await inAccount("worker", () => {});
  expect("a counted sale is never sent again", fake.count("trade_hour_add") - before, 0);
}

// ---------- Your own trades are not the agents' ----------
await inAccount("worker", () => trade("MINE", 50, 1.5));
await inAccount("worker", () => {});
expect("a trade you made by hand is not counted", [(await hours("worker")).rows[0].trades, Object.keys((await hours("worker")).rows[0].agents).length], [2, 2]);

// ---------- The next hour; the same agent on another coin ----------
now = BASE + HOUR;
const later = await inAccount("worker", () => [trade("CCC", 100, 1.1, { bot: "1" }), trade("AAA", 100, 1.3, { bot: "1" })]);
await inAccount("worker", () => {});
{
  const r = await hours("worker");
  expect("a new hour gets its own row, oldest first", r.rows.map((x: any) => [new Date(x.hour).toISOString().slice(11, 16), x.trades]), [["10:00", 2], ["11:00", 2]]);
  expect("an agent that traded two coins in the hour has both listed, and its trades added up", [[...r.rows[1].agents["1"].symbols].sort(), r.rows[1].agents["1"].trades, cents(r.rows[1].agents["1"].pnl), cents(r.rows[1].pnlUsd)], [["AAA", "CCC"], 2, cents(later[0].pnlUsd + later[1].pnlUsd), cents(later[0].pnlUsd + later[1].pnlUsd)]);
  const part = await engine.withAccount("worker", () => engine.agentHours(BASE + HOUR - 5 * 60_000, Date.now()));
  expect("a stretch of time can be asked for", part.rows.map((x: any) => new Date(x.hour).toISOString().slice(11, 16)), ["11:00"]);
}

// ---------- Counting a trade twice changes nothing ----------
{
  const before = (await hours("worker")).rows[1];
  await store.hoursAdd("worker", { tradeId: later[0].id, time: later[0].time, pnlUsd: later[0].pnlUsd, bot: "1", symbol: "CCC" });
  const after = (await hours("worker")).rows[1];
  expect("the same trade sent again (another server copy, a retry) is not counted again", [after.trades, cents(after.pnlUsd)], [before.trades, cents(before.pnlUsd)]);
}

// ---------- Linked to the account ----------
{
  const refused = await store.hoursAdd("nobody", { tradeId: "x1", time: now, pnlUsd: 1, bot: "1", symbol: "X" }).then(() => "written", (e: Error) => e.message);
  check("hours can only be written for an account that exists (the table is linked to the accounts table)", refused !== "written" && /trade_accounts|foreign key/i.test(refused), refused);
  await inAccount("leaver", () => trade("ZZZ", 100, 1.2, { bot: "1" }));
  const had = (await hours("leaver")).rows.length;
  await fake.db.query("delete from public.trade_accounts where key = 'leaver'");
  expect("when an account's row is deleted, its hours go with it", [had, (await store.hoursGet("leaver", 0, Date.now() + HOUR)).length], [1, 0]);
  expect("every account has its own hours", (await store.hoursGet("worker", 0, Date.now() + HOUR)).length, 2);
}

// ---------- A reset is not the end of the record ----------
await inAccount("worker", () => engine.reset(10_000));
expect("resetting the paper account leaves the hours already recorded", (await hours("worker")).rows.length, 2);

// ---------- A database that does not have the table yet ----------
{
  // As the live project is until the new setup script has been run there: no table, no functions.
  await fake.db.query("drop function public.trade_hour_add(text, timestamptz, text, numeric, text, text)");
  await fake.db.query("drop function public.trade_hours(text, timestamptz, timestamptz)");
  await fake.db.query("drop table public.trade_agent_hours");
  now = BASE + 3 * HOUR;
  const t1 = await inAccount("early", () => trade("EEE", 100, 1.2, { bot: "1" }));
  await inAccount("early", () => {});
  const asked = fake.count("trade_hour_add");
  const state1 = await inAccount("early", () => ({ marks: engine.getState().trades.filter((t: any) => t.side === "SELL").map((t: any) => t.hr ?? 0), cash: engine.getState().cash }));
  const r1 = await hours("early");
  expect("without the table the trade itself is made and saved as always; it is only not counted yet", [state1.marks, state1.cash > 10_000, r1.ready, r1.rows.length], [[0], true, false, 0]);
  check("the reason is one a person can act on", /schema\.sql/.test(r1.error ?? ""), r1.error);
  now += 2 * 60_000;
  await inAccount("early", () => trade("FFF", 100, 0.9, { bot: "2" }));
  await inAccount("early", () => {});
  expect("the table is not asked again with every save: it waits ten minutes", fake.count("trade_hour_add") - asked, 0);

  // The owner runs the new setup script; ten minutes later the next save brings the hours up to date.
  await fake.runSchema();
  now += 11 * 60_000;
  await inAccount("early", () => engine.updateSettings({})); // any save: the hours are caught up with it
  await inAccount("early", () => engine.updateSettings({})); // ...and the marks are saved with the next
  const r2 = await hours("early");
  const marks = await inAccount("early", () => engine.getState().trades.filter((t: any) => t.side === "SELL").map((t: any) => t.hr ?? 0));
  expect("once the table is there, the sales made before it are counted, in the hours they happened", [r2.ready, r2.rows.map((x: any) => [new Date(x.hour).toISOString().slice(11, 16), x.trades, x.wins, x.losses]), marks, cents(r2.rows[0].pnlUsd) === cents(t1.pnlUsd + (r2.rows[0].agents["2"]?.pnl ?? 0))], [true, [["13:00", 2, 1, 1]], [1, 1], true]);
}

// ---------- The local file store keeps hours too ----------
{
  for (const k of Object.keys(process.env)) if (/SUPABASE/.test(k)) delete process.env[k];
  delete process.env.VERCEL;
  const local = newStore();
  await local.hoursAdd!("me", { tradeId: "a", time: BASE, pnlUsd: 12.5, bot: "1", symbol: "AAA" });
  await local.hoursAdd!("me", { tradeId: "a", time: BASE, pnlUsd: 12.5, bot: "1", symbol: "AAA" });
  await local.hoursAdd!("me", { tradeId: "b", time: BASE + 60_000, pnlUsd: -4, bot: "2", symbol: "BBB" });
  await local.hoursAdd!("me", { tradeId: "c", time: BASE + HOUR, pnlUsd: 1, bot: "1", symbol: "CCC" });
  const rows = await local.hoursGet!("me", 0, BASE + 2 * HOUR);
  expect("on a computer without a database the same figures are kept in a file", [local.kind, rows.map((r: any) => [r.trades, r.wins, r.losses, r.pnlUsd]), rows[0].agents["1"], (rows[0] as any).ids], ["file", [[2, 1, 1, 8.5], [1, 1, 0, 1]], { pnl: 12.5, trades: 1, wins: 1, losses: 0, symbols: ["AAA"] }, undefined]);
}
finish();
