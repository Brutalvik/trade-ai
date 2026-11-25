// What the server asks the database for when it brings an account up to date (engine.sync, run
// on every request and every 5-second check): a version number, and the account itself only when
// another server copy has saved it. Reading the whole account every time is what used up the old
// database's allowance in November 2026.
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-")));
delete process.env.VERCEL;
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|SKIP_UPSTASH/.test(k)) delete process.env[k];
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
const fake = await fakeSupabase();
const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
const { newStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const other = newStore(); // another server copy: its own store on the same database
const KEY = "tester";
const since = (mark: number) => ({ rev: fake.count("trade_account_rev", mark), load: fake.count("trade_account_load", mark), save: fake.count("trade_account_save", mark), bytes: fake.received(mark) });

await engine.ensureStore();
expect("a new project with no old database to copy from starts empty, and notes it", (await other.kvGet<any>("copied-from-upstash"))?.why, "no Upstash settings");

await engine.withAccount(KEY, async () => {
  let mark = fake.calls.length;
  await engine.sync();
  await engine.flush();
  expect("a login's first visit: the account is looked for once, and the new account is saved", [since(mark).load, since(mark).save, engine.getState().cash, await other.rev(KEY)], [1, 1, 10000, 1]);
  expect("a new paper account starts with $10,000", [engine.getState().startCash, engine.getState().peakEquity, engine.getState().equity.at(-1)?.v], [10000, 10000, 10000]);

  // Give the account the bulk a real one has: another copy saves 800 trades and a long equity curve.
  const big: any = await other.load(KEY);
  big.trades = Array.from({ length: 800 }, (_x, i) => ({ id: `t${i}`, time: 1794000000000 + i * 60_000, side: i % 2 ? "SELL" : "BUY", symbol: "FOOD", pool: "PoolAddressForTests", price: 0.0123 + i * 1e-6, qty: 81234.5 + i, usd: 1000 + i, feeUsd: 9.87, reason: "Profit exit: sold at about +5.1% after fees (best was +7.4%)", pnlUsd: 12.5 }));
  big.equity = Array.from({ length: 2000 }, (_x, i) => ({ t: 1794000000000 + i * 30_000, v: 1000 + Math.sin(i / 9) * 40 }));
  await other.save(big, KEY);
  mark = fake.calls.length;
  await engine.sync();
  const whole = since(mark);
  expect("another copy saved: this copy asks the version, sees it changed, and loads the account", [whole.rev, whole.load, engine.getState().trades.length, engine.getState().equity.length], [1, 1, 800, 2000]);

  mark = fake.calls.length;
  for (let i = 0; i < 24; i++) await engine.sync(); // two minutes of 5-second checks with nothing happening
  const quiet = since(mark);
  expect("24 checks with nothing changed: 24 version questions and not one load", [quiet.rev, quiet.load, quiet.save], [24, 0, 0]);
  check("...which is a few bytes each, against the whole account every time before", quiet.bytes < 24 * 8 && whole.bytes > 20_000, `${quiet.bytes} bytes for 24 checks; one load of the whole account is ${Math.round(whole.bytes / 1024)} KB gzipped`);

  // The other copy changes something small (as the bot does when it logs a line or moves a stop).
  const theirs: any = await other.load(KEY);
  theirs.cash = 777;
  await other.save(theirs, KEY);
  mark = fake.calls.length;
  await engine.sync();
  const small = since(mark);
  expect("a small change elsewhere is picked up at the next check", [small.rev, small.load, engine.getState().cash, engine.getState().trades.length], [1, 1, 777, 800]);
  check("...and only the changed part travels, not the trades and the equity curve again", small.bytes < whole.bytes / 5, `${Math.round(small.bytes / 1024 * 10) / 10} KB against ${Math.round(whole.bytes / 1024)} KB`);

  // This copy saves: it already holds what it saved.
  engine.updateSettings({});
  await engine.flush();
  mark = fake.calls.length;
  await engine.sync();
  expect("after its own save this copy does not load the account back", [since(mark).rev, since(mark).load, await other.rev(KEY) === (await other.loadRev(KEY)).rev], [1, 0, true]);

  // A save of this copy still on its way: what it holds is the newest there is.
  engine.updateSettings({});
  mark = fake.calls.length;
  await engine.sync();
  const during = since(mark);
  await engine.flush();
  expect("while its own save is on its way it asks nothing and keeps what it holds", [during.rev, during.load, engine.getState().cash], [0, 0, 777]);

  // The database does not answer.
  fake.fail("network");
  const down = String(await engine.sync().then(() => "no error", (e: Error) => e.message));
  fake.fail(null);
  check("if the database does not answer, the check fails loudly instead of trading on what it holds", down.startsWith("The database (Supabase) did not answer"), down);
  mark = fake.calls.length;
  await engine.sync();
  expect("...and carries on as soon as it is back", [since(mark).rev, since(mark).load, engine.getState().cash], [1, 0, 777]);

  // ---- an account opened with the earlier $1,000 ----
  const earlier = (extra: object = {}) => ({ mode: "paper", startCash: 1000, cash: 420.5, peakEquity: 1012, positions: [{ id: "p1", pool: "P", symbol: "FOOD", qty: 100, entryPrice: 5, lastPrice: 5.5, source: "bot", botId: "1" }], trades: [{ id: "t1", side: "BUY", usd: 500 }], equity: [{ t: 1, v: 1000 }, { t: 2, v: 970.5 }], settings: { feePct: 1, slippagePct: 0.5 }, orders: [], bot: { running: true, config: { pick: "agent", symbol: "FOOD", budgetUsd: 1000 }, log: [], day: { date: "2026-11-25", startEquity: 1000 } }, bots: [], lastSignal: null, ...extra });
  await other.save(earlier(), "opened1000");
  await other.save(earlier({ resetAt: 5 }), "reset1000");
  const seen = async (key: string) => engine.withAccount(key, async () => { await engine.sync(); const g: any = engine.getState(); return [g.startCash, g.cash, g.peakEquity, g.equity.map((e: any) => e.v), g.bot.day?.startEquity ?? null, g.equityNow - g.startCash, g.bot.config.budgetUsd, g.positions.length]; });
  expect("an account opened with the earlier $1,000 and never reset is raised to $10,000: its profit and loss, its trade and its agent's budget are unchanged", await seen("opened1000"), [10000, 9420.5, 10012, [10000, 9970.5], 10000, -29.5, 1000, 1]);
  expect("...once only (looking again changes nothing)", await seen("opened1000"), [10000, 9420.5, 10012, [10000, 9970.5], 10000, -29.5, 1000, 1]);
  expect("an account someone reset to $1,000 on purpose is left alone", (await seen("reset1000")).slice(0, 2), [1000, 420.5]);
  const st = engine.storageStats();
  check("the server reports its own storage traffic", st && st.calls.trade_account_rev >= 28 && st.calls.trade_account_load >= 3 && st.receivedBytes > 0, st && { calls: st.calls, receivedKB: Math.round(st.receivedBytes / 1024) });
});
finish();
