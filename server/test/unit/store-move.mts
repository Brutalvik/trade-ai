// The one-time move from Upstash to Supabase, and the server's start-up check around it:
// nothing is served from the new database before the old one's data is in it (or the owner has
// said to start empty), and a half-finished copy is finished, not doubled, on the next try.
// The copy happens only when asked for (COPY_FROM_UPSTASH=1). MODE=skip runs the default
// instead: the server starts on Supabase with empty accounts and never asks the old database.
import { check, expect, finish } from "../check.mts";
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|_UPSTASH/.test(k)) delete process.env[k];
const SKIP = process.env.MODE === "skip";
process.env.STORE_RETRY_MS = "0"; // these tests fix the database and look again at once
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
const { fakeUpstash, sampleOldData, UPSTASH_LIMIT: LIMIT } = await import(new URL("../upstash-fake.mts", import.meta.url).href);
const fake = await fakeSupabase({ schema: false }); // the project exists, the script has not been run yet
const { newStore, copyFromUpstash } = await import(new URL("../../src/store.ts", import.meta.url).href);
const { strings, lists } = sampleOldData();
// The same value whatever order its keys are in (Postgres keeps a JSON object's keys in its own order).
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);

// ---- the copy itself, against a stand-in with the five reads it uses ----
let blocked = false, failRangeOnce = false, reads = 0;
const gate = () => {
  reads++;
  if (blocked) throw new Error(`${LIMIT}, command was: [["scan","0"]]`);
};
const old = {
  async scan(cursor: string | number, o: { match: string; count: number }) {
    gate();
    const all = [...strings.keys(), ...lists.keys()].filter((k) => k.startsWith(o.match.replace(/\*$/, ""))).sort();
    const at = Number(cursor), next = at + 3; // small pages, so the paging is exercised
    return [next >= all.length ? "0" : String(next), all.slice(at, next)] as [string, string[]];
  },
  async get(k: string) { gate(); return strings.get(k)?.v ?? null; },
  async pttl(k: string) { gate(); return strings.has(k) ? (strings.get(k)!.ttl ?? -1) : -2; },
  async llen(k: string) { gate(); return lists.get(k)?.length ?? 0; },
  async lrange(k: string, a: number, b: number) {
    gate();
    if (failRangeOnce && a > 0) { failRangeOnce = false; throw new Error("socket hang up"); }
    return (lists.get(k) ?? []).slice(a, b + 1);
  },
};
const arrived = async (to: any, db: any) => {
  const ada = await to.load("ada");
  expect("accounts arrive whole", [ada.cash, ada.trades.length, ada.bot.config.symbol, ada.positions[0].symbol, await to.load("bob")], [812.5, 40, "FOOD", "FOOD", { cash: 1000, trades: [] }]);
  expect("records arrive as the app read them: logins, the owner, the Stop/Reset record, usage, the list of running accounts", [(await to.kvGet("user:ada")).hash, await to.kvGet("email:ada@example.test"), await to.kvGet("auth:secret"), await to.kvGet("owner"), await to.kvGet("migrated-to-accounts"), await to.kvGet("active-accounts"), canon(await to.kvGet("ctl:ada")), await to.kvGet("usage:ada:2026-11")], ["scrypt$abc", "ada", "00ff11ee22dd33cc", "ada", true, ["ada"], { resetAt: 7, stops: { "2": 99 } }, 1234567]);
  const ttl = Number((await db.query("select extract(epoch from (expires_at - now())) as s from public.trade_kv where key = 'lists:week'")).rows[0].s);
  check("a record with a time limit keeps the time it had left", ttl > 86_000 && ttl <= 86_400, `${Math.round(ttl)} s`);
  const ledger = await to.listRange("ledger:ada", 0, 5000);
  expect("the trade ledger arrives complete and in order", [await to.listLen("ledger:ada"), ledger.length, ledger.every((x: any, i: number) => x.n === i), await to.listLen("audit:ada"), await to.listLen("audit:bob")], [1234, 1234, true, 30, 0]);
  expect("locks are left behind", Number((await db.query("select count(*) as n from public.trade_kv where key like '%watch:ada%'")).rows[0].n), 0);
};

const store = newStore();
await fake.runSchema();
blocked = true;
expect("while the old database refuses to be read, nothing is copied and the reason is passed on", await copyFromUpstash(store, old).catch((e: Error) => e.message.slice(0, LIMIT.length)), LIMIT);
blocked = false;
failRangeOnce = true;
expect("a copy that is interrupted part-way says so", await copyFromUpstash(store, old).catch((e: Error) => e.message), "socket hang up");
const r = await copyFromUpstash(store, old);
expect("run again, it finishes: 2 accounts, 9 records, 3 lists with 1,264 entries (nothing doubled by the interrupted run)", r, { accounts: 2, records: 9, lists: 3, items: 1264 });
await arrived(newStore(), fake.db);
const before = reads;
expect("running it once more changes nothing, and finished lists are not read again", [await copyFromUpstash(store, old), await newStore().listLen("ledger:ada"), reads - before < 30], [r, 1234, true]);

// ---- the server's start-up, with the real Upstash client talking to a stand-in for Upstash's REST API ----
const fresh = await fakeSupabase({ url: "https://second.supabase.test", key: "sb_secret_second", schema: false }); // a new, empty project; the settings now point at it
process.env.KV_REST_API_URL = "https://old.upstash.test";
process.env.KV_REST_API_TOKEN = "old-token";
const upstash = fakeUpstash("https://old.upstash.test", { strings, lists }, { blocked: true });

if (!SKIP) process.env.COPY_FROM_UPSTASH = "1"; // the owner asked for the old data to be brought over
const engine = await import(new URL("../../src/engine.ts", import.meta.url).href); // a server that has just started
expect("the server is on the new database", engine.storeKind(), "supabase");
expect("before the script has been run, the server says what is missing", await engine.ensureStore().catch((e: Error) => e.message), "The Supabase database is not set up yet: run server/supabase/schema.sql once in the Supabase SQL editor. (Already done? Then check that the Data API is switched on in the Supabase dashboard, under Integrations > Data API.)");
await fresh.runSchema();
const flagOf = async () => (await fresh.db.query("select value -> 'v' as v from public.trade_kv where key = 'copied-from-upstash'")).rows[0]?.v;
if (SKIP) {
  await engine.ensureStore();
  const flag = await flagOf();
  expect("with no copy asked for, the server starts on empty accounts at once, never asks the old database (still blocked here), and notes that it started empty", [flag.skipped, flag.why, Number((await fresh.db.query("select count(*) as n from public.trade_accounts where key <> '~selftest'")).rows[0].n), upstash.calls], [true, "COPY_FROM_UPSTASH is not set", 0, 0]);
  process.env.COPY_FROM_UPSTASH = "1";
  upstash.block(false);
  await engine.ensureStore();
  expect("...and asking for the copy later does not overwrite the new accounts: the old database stays unread", [upstash.calls, (await flagOf()).skipped], [0, true]);
  delete process.env.COPY_FROM_UPSTASH;
} else {
  const msg = await engine.ensureStore().catch((e: Error) => e.message);
  check("asked to copy, with the old database still blocked, the server does not start on empty accounts: it says why and what to do", /^Moving to the new database: your accounts and history could not be copied from the old one yet \(.*Fixed plan limits.*\)\. Unblock it in the Upstash console, or remove COPY_FROM_UPSTASH in Vercel to start with empty accounts\.$/.test(msg) && !msg.includes("command was") && upstash.calls > 0, msg);
  expect("...nothing was marked as done, and the lock was given back", Number((await fresh.db.query("select count(*) as n from public.trade_kv where key <> 'selftest'")).rows[0].n), 0);
  upstash.block(false); // the owner unblocked the old database
  await engine.ensureStore();
  const flag = await flagOf();
  expect("once the old database can be read, the server copies everything by itself and notes what it copied", [flag.accounts, flag.records, flag.lists, flag.items, typeof flag.at], [2, 9, 3, 1264, "number"]);
  await arrived(newStore(), fresh.db);
  expect("the agent that was running is still on the scheduler's list, so the bot picks up where it was", await engine.activeAccounts(), ["ada"]);
}
const callsBefore = upstash.calls;
await engine.ensureStore();
await engine.ensureMigrated();
expect("after that the old database is never asked again", upstash.calls, callsBefore);
finish();
