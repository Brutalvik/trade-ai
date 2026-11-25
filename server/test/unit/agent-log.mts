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
finish();
