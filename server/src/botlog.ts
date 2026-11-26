// The agents' log, kept for a week.
//
// The account itself carries only each agent's newest 200 lines (it is saved every few seconds,
// so it has to stay small). Every line is also appended here, to a list per account and day
// (botlog:<account>:<yyyy-mm-dd>, UTC days, one list entry per save: a batch of lines), so the
// app can show today's whole log or the last 7 days, read only when someone asks for it.
//
// Lines older than that leave the log through archiveLogs(). Where they go is decided there:
// today (paper trading) they are not kept. With KEEP_LOG_ARCHIVE=1 they are appended to a list
// per account and month (botlog-archive:<account>:<yyyy-mm>) before they leave.
import { createStore } from "./store.js";

const store = createStore();

// What a line decided, for the one-line view of the log ("Decisions" in the app): bought, sold,
// did not trade and why, chose a coin, waits. It is written with the line, where the decision is
// made (engine.ts log(msg, level, d)), so the view never has to read it back out of a sentence.
//   enter     bought            usd = the money put in, of = what the agent had to trade with
//   exit      sold              pnl = profit or loss in dollars, pct = the same in % of the money put in
//   skip      its AI was asked and stayed out, or its order did not have the odds
//   filtered  ruled out before the AI was asked (the scouts, the numbers, the cost of trading)
//   order     it has an order waiting at a price
//   pick      an auto-pick agent took a coin        left = it let its coin go
//   wait      an auto-pick agent has no coin it can take
//   lock      a trade reached its minimum profit    start / stop = the agent itself
export type DecisionAct = "enter" | "exit" | "skip" | "filtered" | "order" | "pick" | "left" | "wait" | "lock" | "start" | "stop";
// by = for a coin that was ruled out or let go: which check did it (the scouts, the numbers, the cost of trading).
export type Decision = { act: DecisionAct; coin?: string; why: string; by?: "scouts" | "numbers" | "cost"; usd?: number; of?: number; pnl?: number; pct?: number };
export type LogLine = { t: number; bot: string; sym?: string; msg: string; level: "info" | "good" | "bad"; d?: Decision };

// A reason short enough for one line: single spaces, no full stop at the end, cut at `max`.
export function shortWhy(text: string, max = 150): string {
  const x = String(text ?? "").replace(/\s+/g, " ").trim().replace(/[\s.;:,]+$/, "");
  return x.length > max ? `${x.slice(0, max - 1).trimEnd()}\u2026` : x;
}

// Lines written before decisions were kept with them (v0.69) carry none. A buy and a sale can
// still be told from their sentence, which has had one fixed shape since the log began; nothing
// else is guessed. Those lines leave the log within a week.
const OLD_BUY = /^(?:LIMIT )?BUY (\S+) \$([\d,]*\.?\d+) @ \S+ \((.+?)\)\.(?: Exit below .*)?$/;
const OLD_SELL = /^(?:PROTECTED |LIMIT )?SELL (\S+)(.*)\. P&L \+?\$(-?[\d,]*\.?\d+)$/;
export function decisionOf(line: Pick<LogLine, "msg" | "d">): Decision | null {
  if (line.d && typeof line.d.act === "string") return line.d;
  const msg = String(line.msg ?? "");
  const b = OLD_BUY.exec(msg);
  if (b) {
    const cost = /costs about ([\d.]+)%/.exec(msg);
    return { act: "enter", coin: b[1], usd: Number(b[2].replace(/,/g, "")), why: shortWhy(`${b[3]}${cost ? ` \u00b7 costs ${cost[1]}%` : ""}`) };
  }
  const x = OLD_SELL.exec(msg);
  if (x) return { act: "exit", coin: x[1], pnl: Number(x[3].replace(/,/g, "")), why: shortWhy(x[2].replace(/^ (?:\d+% )?@ \S+:? ?/, "")) };
  return null;
}
export const LOG_KEEP_DAYS = 7;
const DAY = 86_400_000;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
const listKey = (user: string, day: string) => `botlog:${user.toLowerCase()}:${day}`;
const archiveKey = (user: string, day: string) => `botlog-archive:${user.toLowerCase()}:${day.slice(0, 7)}`;
// The log covers today and the LOG_KEEP_DAYS UTC days before it: that holds "the last 7 days" of
// any time zone (7 local days reach back at most 7 x 24 hours).
const oldestKept = (now: number) => dayStart(now) - LOG_KEEP_DAYS * DAY;

// Add lines to the log (one write per day they fall on). The first write of a day also clears
// out what has grown older than a week.
const tidied = new Map<string, string>(); // account -> the day its old lines were last cleared (this server copy)
export async function keepLogLines(user: string, lines: LogLine[], now = Date.now()) {
  if (!lines.length) return;
  const byDay = new Map<string, LogLine[]>();
  for (const l of lines) {
    const d = dayOf(l.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(l);
  }
  for (const [day, batch] of byDay) await store.listPush(listKey(user, day), batch);
  const today = dayOf(now);
  if (tidied.get(user) === today) return;
  tidied.set(user, today);
  try {
    // Another server copy may have done it already today.
    if (await store.kvSet(`botlog-tidied:${user.toLowerCase()}:${today}`, 1, { nx: true, ttlMs: 2 * DAY })) await archiveLogs(user, now);
  } catch (e) {
    tidied.delete(user); // tried again with the next lines
    console.error("[botlog] clearing old lines failed:", e);
  }
}

// The lines from `from` to `to` (both included), newest first, at most `limit` of them.
// more = there are older lines in that stretch that did not fit (ask again with `to` = the
// oldest line's time). Nothing older than the week that is kept is ever returned.
// decisionsOnly = only the lines that decided something, each with its decision (decisionOf).
export async function logHistory(user: string, from: number, to: number, limit = 500, now = Date.now(), decisionsOnly = false): Promise<{ lines: LogLine[]; more: boolean }> {
  const max = Math.min(2000, Math.max(1, Math.floor(limit) || 500));
  const lo = Math.max(Number.isFinite(from) ? from : 0, oldestKept(now));
  const hi = Math.min(Number.isFinite(to) ? to : now, now + DAY);
  const out: LogLine[] = [];
  let more = false;
  scan: for (let d = dayStart(hi); d >= dayStart(lo); d -= DAY) {
    const key = listKey(user, dayOf(d));
    let end = (await store.listLen(key)) - 1;
    while (end >= 0) {
      if (out.length > max) { more = true; break scan; } // enough: at least one more line exists in what was read
      const start = Math.max(0, end - 199);
      const batches = await store.listRange<LogLine[]>(key, start, end);
      for (const b of batches) if (Array.isArray(b)) for (const l of b) if (l && typeof l.t === "number" && l.t >= lo && l.t <= hi) {
        if (!decisionsOnly) out.push(l);
        else { const d = decisionOf(l); if (d) out.push(l.d ? l : { ...l, d }); }
      }
      end = start - 1;
    }
  }
  out.sort((a, b) => b.t - a.t);
  if (out.length > max) {
    out.length = max;
    more = true;
  }
  return { lines: out, more };
}

// The archive: day lists older than the week that is kept leave the log. With KEEP_LOG_ARCHIVE=1
// their lines are first appended to the month's archive list; without it they are not kept (the
// owner's choice for now: paper trading only). lookBackDays = how far behind the week to look
// (an account that was not used for a while still gets cleared).
export async function archiveLogs(user: string, now = Date.now(), lookBackDays = 21): Promise<{ days: number; entries: number; stored: boolean }> {
  const stored = process.env.KEEP_LOG_ARCHIVE === "1";
  let days = 0, entries = 0;
  if (!store.listReplace) return { days, entries, stored: false }; // this store cannot empty a list: nothing is moved
  for (let i = LOG_KEEP_DAYS + 1; i <= LOG_KEEP_DAYS + lookBackDays; i++) {
    const day = dayOf(dayStart(now) - i * DAY);
    const key = listKey(user, day);
    const n = await store.listLen(key);
    if (!n) continue;
    if (stored) for (let s = 0; s < n; s += 200) await store.listReplace(archiveKey(user, day), await store.listRange<LogLine[]>(key, s, Math.min(n, s + 200) - 1), false);
    await store.listReplace(key, [], true);
    days++;
    entries += n;
  }
  return { days, entries, stored };
}
