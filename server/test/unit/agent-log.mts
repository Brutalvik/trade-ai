// The agents' log is kept for a week (src/botlog.ts): every line an agent writes is appended to
// a list per account and day, the app reads a stretch of it (today, or the last 7 days) in pages,
// and lines older than the week leave through the archive function (not stored for now).
// Runs on the Supabase store (a real Postgres engine in memory, see pg-fake.mts).
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|SKIP_UPSTASH|KEEP_LOG_ARCHIVE/.test(k)) delete process.env[k];
process.env.VERCEL = "1"; // no local 5-second loop: this test only starts and stops agents, it never trades
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
const fake = await fakeSupabase();

// A clock the test moves from day to day.
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 10, 10, 10, 0, 0); // 10 Nov 2026, 10:00 UTC
let now = BASE;
const realNow = Date.now.bind(Date);
const started = realNow();
Date.now = () => now + (realNow() - started);

const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
const botlog = await import(new URL("../../src/botlog.ts", import.meta.url).href);
const { newStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const store = newStore();
await engine.ensureStore();

const cfg = (symbol: string) => ({ chain: "solana", pool: `${symbol}Pool1111`, symbol, tf: "5m", positionPct: 100, minConfidence: 0, analyzeEverySec: 300, checkEverySec: 5, maxDrawdownPct: 25, breakEvenAtPct: 5, goalUsd: 1e9, pick: "agent", budgetUsd: 100 });
// One day's work: the agent is started and stopped (two log lines), and the account is saved.
const oneDay = (key: string, symbol: string) => engine.withAccount(key, async () => {
  await engine.sync();
  engine.startBot(cfg(symbol), "1", 10);
  await engine.flush();
  now += 60_000;
  engine.stopBot("Stopped by user", "1");
  await engine.flush();
});
const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
const dayKey = (key: string, ms: number) => `botlog:${key}:${new Date(ms).toISOString().slice(0, 10)}`;

// ---------- One day ----------
await oneDay("tester", "AAA");
{
  const r = await botlog.logHistory("tester", dayStart(Date.now()), Date.now());
  expect("the lines an agent writes are in the day's log, newest first", r.lines.map((l: any) => l.msg.slice(0, 13)), ["Agent stopped", "Agent started"]);
  expect("each line says which agent wrote it, on which coin, and how it should look", [r.lines[1].bot, r.lines[1].sym, r.lines[1].level, r.more], ["1", "AAA", "good", false]);
  expect("one write per save: two saves, two entries in the day's list", await store.listLen(dayKey("tester", BASE)), 2);
}
await oneDay("someone-else", "ZZZ");
expect("every account has its own log", [(await botlog.logHistory("tester", 0, Date.now())).lines.length, (await botlog.logHistory("someone-else", 0, Date.now())).lines.map((l: any) => l.sym).join()], [2, "ZZZ,ZZZ"]);

// ---------- Ten days: day 0 (above) to day 9 ----------
for (let d = 1; d <= 9; d++) {
  now = BASE + d * DAY;
  await oneDay("tester", `C${d}`);
}
{
  const today = dayStart(Date.now());
  const day = await botlog.logHistory("tester", today, Date.now());
  expect("today's log: only today's lines", day.lines.map((l: any) => l.sym), ["C9", "C9"]);
  const week = await botlog.logHistory("tester", today - 6 * DAY, Date.now());
  expect("the last 7 days: today and the six days before it, newest first", [week.lines.length, [...new Set(week.lines.map((l: any) => l.sym))].join(), week.more], [14, "C9,C8,C7,C6,C5,C4,C3", false]);
  const all = await botlog.logHistory("tester", 0, Date.now());
  expect("asking for more than the week gives the week that is kept (today and the 7 UTC days before it)", [all.lines.length, all.lines.at(-1).sym], [16, "C2"]);
  expect("lines older than that have left the log (cleared with the first write of each new day)", [await store.listLen(dayKey("tester", BASE)), await store.listLen(dayKey("tester", BASE + DAY)), await store.listLen(dayKey("tester", BASE + 2 * DAY))], [0, 0, 2]);
  expect("the account itself still carries the agent's newest lines (at most 200)", await engine.withAccount("tester", async () => { await engine.sync(); return [engine.getState().bot.log.length, engine.getState().bot.log[0].msg.slice(0, 13)]; }), [20, "Agent stopped"]);

  // In pages of 5.
  const seen: any[] = [];
  let to = Date.now(), pages = 0, more = true;
  while (more && pages < 10) {
    const p = await botlog.logHistory("tester", today - 6 * DAY, to, 5);
    for (const l of p.lines) if (!seen.some((x) => x.t === l.t && x.msg === l.msg)) seen.push(l);
    more = p.more;
    to = p.lines.at(-1)?.t ?? to;
    pages++;
  }
  expect("in pages: every line of the week arrives once, and the last page says there is no more", [seen.length, pages <= 5, seen.every((l, i) => i === 0 || seen[i - 1].t >= l.t)], [14, true, true]);
}

// ---------- The archive function ----------
{
  const user = "archiver";
  const old = Date.now() - 10 * DAY, older = Date.now() - 12 * DAY, kept = Date.now() - 3 * DAY;
  const line = (t: number, msg: string) => [{ t, bot: "1", msg, level: "info" }];
  await store.listPush(dayKey(user, old), line(old, "ten days ago"));
  await store.listPush(dayKey(user, older), line(older, "twelve days ago"));
  await store.listPush(dayKey(user, kept), line(kept, "three days ago"));
  const first = await botlog.archiveLogs(user, Date.now());
  expect("the archive function clears the day lists older than the week and leaves the week alone", [first, await store.listLen(dayKey(user, old)), await store.listLen(dayKey(user, older)), await store.listLen(dayKey(user, kept))], [{ days: 2, entries: 2, stored: false }, 0, 0, 1]);
  expect("for now the old lines are not kept anywhere (paper trading)", [await store.listLen(`botlog-archive:${user}:${new Date(old).toISOString().slice(0, 7)}`), await store.listLen(`botlog-archive:${user}:${new Date(older).toISOString().slice(0, 7)}`)], [0, 0]);
  expect("run again, it finds nothing left to clear", await botlog.archiveLogs(user, Date.now()), { days: 0, entries: 0, stored: false });

  // Switched on (KEEP_LOG_ARCHIVE=1): the old lines are appended to the month's archive list first.
  process.env.KEEP_LOG_ARCHIVE = "1";
  await store.listPush(dayKey(user, old), line(old, "ten days ago, again"));
  const second = await botlog.archiveLogs(user, Date.now());
  const month = `botlog-archive:${user}:${new Date(old).toISOString().slice(0, 7)}`;
  expect("with the archive switched on, the old lines are moved to the month's archive list", [second, await store.listLen(dayKey(user, old)), (await store.listRange<any[]>(month, 0, 9)).flat().map((l) => l.msg)], [{ days: 1, entries: 1, stored: true }, 0, ["ten days ago, again"]]);
  delete process.env.KEEP_LOG_ARCHIVE;
}

// ---------- A write that fails is not lost ----------
{
  now = BASE + 20 * DAY;
  await engine.withAccount("retry", async () => {
    await engine.sync();
    await engine.flush();
    fake.fail("network"); // the database stops answering
    engine.startBot(cfg("RRR"), "1", 10);
    await engine.flush(); // neither the account nor the line can be written
    fake.fail(null);
    now += 60_000;
    engine.stopBot("Stopped by user", "1");
    await engine.flush();
  });
  const r = await botlog.logHistory("retry", 0, Date.now());
  expect("lines whose write failed go out with the next save", r.lines.map((l: any) => l.msg.slice(0, 13)), ["Agent stopped", "Agent started"]);
}
// ---------- Decisions: what a line decided is kept with it ----------
{
  now = BASE + 30 * DAY;
  const user = "decider";
  await engine.withAccount(user, async () => {
    await engine.sync();
    engine.startBot(cfg("DDD"), "1", 10);
    await engine.flush();
    now += 60_000;
    engine.stopBot("Stopped by user", "1");
    await engine.flush();
  });
  // Lines as the log held them before decisions were kept (no record with them), a line that
  // decides nothing, and one written with its decision.
  const t = Date.now();
  const oldBuy = "BUY QFREE $297.18 @ $1.000 (buy-now order (up to $1.002)). Exit below $0.9500 (risking about $17.41, 0.2% of the account); at $1.150 it starts trailing. A round trip of this size in this pool costs about 0.7%.";
  const oldLoss = "SELL QMIDD @ $1.000: Exit: the price fell all the way back to the buy price (best was +14.1% after fees). P&L $-2.81";
  const oldWin = "SELL QAAA @ $1.100: The AI sold: support broke. P&L +$89.12";
  await botlog.keepLogLines(user, [
    { t: t + 1000, bot: "2", sym: "QFREE", msg: oldBuy, level: "good" },
    { t: t + 2000, bot: "2", sym: "QMIDD", msg: oldLoss, level: "bad" },
    { t: t + 3000, bot: "2", sym: "QAAA", msg: oldWin, level: "good" },
    { t: t + 4000, bot: "2", sym: "QAAA", msg: "Asking the AI for a new plan (starting up)...", level: "info" },
    { t: t + 5000, bot: "2", sym: "QZZZ", msg: "Plan: AVOID (30% sure). The AI advises staying out.", level: "info", d: { act: "skip", coin: "QZZZ", why: "fading volume" } },
  ]);
  now += 60_000;
  const all = await botlog.logHistory(user, 0, Date.now());
  const dec = await botlog.logHistory(user, 0, Date.now(), 500, Date.now(), true);
  expect("the full log is as before: every line, and a line written before decisions were kept has none", [all.lines.length, all.lines.filter((l: any) => l.d).map((l: any) => l.d.act)], [7, ["skip", "stop", "start"]]);
  expect("asked for decisions only, the log leaves out the lines that decided nothing", dec.lines.map((l: any) => l.d?.act), ["skip", "exit", "exit", "enter", "stop", "start"]);
  const by = (act: string, coin: string) => dec.lines.find((l: any) => l.d.act === act && l.d.coin === coin)?.d;
  // (The database keeps a record's fields in its own order, so they are compared one by one.)
  expect("starting and stopping an agent are kept as decisions, with the coin and a short reason", [by("start", "DDD"), by("stop", "DDD")].map((d: any) => [d?.act, d?.coin, d?.why]), [["start", "DDD", "agent with a $100 budget"], ["stop", "DDD", "Stopped by user"]]);
  expect("an old buy is read from its sentence: the coin, the money put in, the order and its cost", by("enter", "QFREE"), { act: "enter", coin: "QFREE", usd: 297.18, why: "buy-now order (up to $1.002) \u00b7 costs 0.7%" });
  expect("an old sale at a loss: the coin, the loss, the reason", by("exit", "QMIDD"), { act: "exit", coin: "QMIDD", pnl: -2.81, why: "Exit: the price fell all the way back to the buy price (best was +14.1% after fees)" });
  expect("an old sale at a profit", by("exit", "QAAA"), { act: "exit", coin: "QAAA", pnl: 89.12, why: "The AI sold: support broke" });
  const two = await botlog.logHistory(user, 0, Date.now(), 2, Date.now(), true);
  expect("decisions come in pages too: the newest two, and word that there are more", [two.lines.map((l: any) => l.d.act), two.more], [["skip", "exit"], true]);
  // The reading of old sentences, on its own.
  const of = (msg: string) => botlog.decisionOf({ msg });
  expect("your own limit buy and a protected sale are read too", [of("LIMIT BUY ABC $50.00 @ $0.9900 (your limit $1.000).")?.act, of("PROTECTED SELL ABC @ $1.200: fell 5% from its high of $1.300 (+20.0% from your buy). P&L +$9.50")],
    ["enter", { act: "exit", coin: "ABC", pnl: 9.5, why: "fell 5% from its high of $1.300 (+20.0% from your buy)" }]);
  expect("nothing else is guessed from a sentence", [of("Plan: BUY NOW (70% sure). Standing orders: buy now up to $1.002."), of("Auto-pick: chose QAAA (the scouts' score 81 of 100)."), of("QAAA is at its stop-loss $0.95 (now $0.94)."), of("")], [null, null, null, null]);
  expect("a decision kept with the line is used as it is, whatever the sentence says", botlog.decisionOf({ msg: oldBuy, d: { act: "pick", coin: "X", why: "y" } }), { act: "pick", coin: "X", why: "y" });
  expect("a reason is made to fit one line: single spaces, no full stop, cut with a mark", [botlog.shortWhy("  Fading   volume under\nresistance; no edge.  "), botlog.shortWhy("x".repeat(200), 20).length, botlog.shortWhy("x".repeat(200), 20).endsWith("\u2026")], ["Fading volume under resistance; no edge", 20, true]);
}
finish();
