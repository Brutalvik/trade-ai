// The Supabase store on its own: the real SQL (supabase/schema.sql on a Postgres engine in
// memory) behind the store's own HTTP calls. What a server copy sends and gets back is counted,
// because keeping that small is why the store is built the way it is.
import { check, expect, finish } from "../check.mts";
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE/.test(k)) delete process.env[k];
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
const { createStore, newStore, supabaseStore, storageEnvNames } = await import(new URL("../../src/store.ts", import.meta.url).href);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The same value whatever order its keys are in (an account's parts are put back together in their own order).
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// ---- which store is used ----
expect("without database settings the local file is used", newStore().kind, "file");
process.env.SUPABASE_URL = "https://x.supabase.test";
process.env.SUPABASE_ANON_KEY = "public-key";
expect("the public (anon) key alone is not enough: the server needs the secret key", newStore().kind, "file");
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL = "https://x.supabase.test";
process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x";
expect("...nor is the publishable key", newStore().kind, "file");
process.env.SUPABASE_SECRET_KEY = "sb_secret_x";
expect("the URL and the secret key, as Vercel's Supabase integration names them, are enough", newStore().kind, "supabase");
for (const k of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) delete process.env[k];
process.env.STORAGE_SUPABASE_URL = "https://x.supabase.test/";
process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY = "secret";
expect("the settings are also found under a prefix, and under the older key name", [newStore().kind, storageEnvNames().filter((n: string) => n.includes("SUPABASE"))], ["supabase", ["STORAGE_SUPABASE_SERVICE_ROLE_KEY", "STORAGE_SUPABASE_URL"]]);
delete process.env.STORAGE_SUPABASE_URL;
delete process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

const fake = await fakeSupabase();
process.env.KV_REST_API_URL = "https://old.upstash.test";
process.env.KV_REST_API_TOKEN = "old";
const store = createStore();
expect("with both databases set up, Supabase is the store", [store.kind, createStore() === store], ["supabase", true]);
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
expect("it is set up and closed to the public keys", await store.check(), { accounts: 0 });
// The setup script is one command: a SQL tool that sends a whole script as a single prepared
// statement refuses several ("cannot insert multiple commands into a prepared statement").
const { PGlite } = await import("@electric-sql/pglite");
const script = (await import("node:fs")).readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const plain = new PGlite(); // a Postgres without Supabase's roles
expect("the setup script runs as a single prepared statement, and again, on a plain Postgres too", [await plain.query(script).then(() => "ran", (e: Error) => e.message), await plain.query(script).then(() => "ran", (e: Error) => e.message), (await plain.query<any>("select public.trade_selfcheck() as c")).rows[0].c.tables], ["ran", "ran", 4]);
const half = new PGlite();
expect("if it fails part-way, nothing is left half-made", [await half.query(script.replace("perform pg_notify('pgrst', 'reload schema');", "perform no_such_function();")).then(() => "ran", (e: Error) => e.message), (await half.query<any>("select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'trade%'")).rows[0].n], ["function no_such_function() does not exist", 0]);
// The public roles themselves, asked directly in the database: nothing to read, nothing to run.
const asRole = async (role: string, sql: string) => fake.db.transaction(async (tx: any) => { await tx.exec(`set local role ${role}`); return (await tx.query(sql)).rows; }).then(() => "allowed", (e: Error) => e.message);
expect("the public roles can neither read the tables nor run the functions", [await asRole("anon", "select * from public.trade_kv"), await asRole("authenticated", "select * from public.trade_accounts"), await asRole("anon", "select public.trade_kv_get('auth:secret')"), await asRole("authenticated", "select public.trade_account_load('ada', '{}')")], ["permission denied for table trade_kv", "permission denied for table trade_accounts", "permission denied for function trade_kv_get", "permission denied for function trade_account_load"]);
expect("the new-style secret key travels in the apikey header alone, and not as a browser", [fake.calls.at(-1).status, fake.calls.every((c: any) => c.status === 200)], [200, true]);

// ---- small records ----
const values: unknown[] = ["text", "0123", 42, 0, true, false, { a: 1, b: [1, "2", null] }, [1, 2, 3], "", "{\"looks\":\"like json\"}"];
for (let i = 0; i < values.length; i++) await store.kvSet(`v${i}`, values[i]);
expect("a record comes back exactly as it was written (text stays text, numbers stay numbers)", await Promise.all(values.map((_v, i) => store.kvGet(`v${i}`))), values);
expect("a record that was never written is null", await store.kvGet("nothing"), null);
expect("write-if-new writes once, then refuses", [await store.kvSet("once", 1, { nx: true }), await store.kvSet("once", 2, { nx: true }), await store.kvGet("once")], [true, false, 1]);
expect("a plain write replaces it", [await store.kvSet("once", 3), await store.kvGet("once")], [true, 3]);
await store.kvSet("short", "x", { ttlMs: 60 });
const early = await store.kvGet("short");
await sleep(90);
expect("a record with a time limit is gone after it, and can then be written as new", [early, await store.kvGet("short"), await store.kvSet("short", "y", { nx: true, ttlMs: 5000 }), await store.kvGet("short")], ["x", null, true, "y"]);
expect("a plain write takes the time limit off again", [await store.kvSet("short", "z"), (await fake.db.query("select expires_at from public.trade_kv where key = 'short'")).rows[0].expires_at], [true, null]);
await store.kvDel("once");
expect("a deleted record is gone", await store.kvGet("once"), null);

const cut = "Bought \u{1F680}".slice(0, 8); // a message shortened in the middle of an emoji
await store.kvSet("odd-text", { note: cut, nul: "a\u0000b" });
await store.listPush("odd-list", { note: cut });
expect("text Postgres cannot keep (half an emoji, a NUL character) is cleaned instead of failing the write", [await store.kvGet("odd-text"), await store.listRange("odd-list", 0, 0)], [{ nul: "ab", note: "Bought \uFFFD" }, [{ note: "Bought \uFFFD" }]]);

// ---- the accounts as a readable table ----
await store.kvSet("user:ada", { username: "Ada", firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", salt: "", hash: "", passVer: 1, createdAt: 1795600000000, avatarUrl: null, privyId: "did:privy:abc", solanaAddress: "So1anaAddr" });
await store.kvSet("user:bob", { username: "bob", firstName: "Bob", lastName: "B", email: "bob@example.test", salt: "5a17", hash: "c0ffee", passVer: 2, createdAt: 1795600060000, avatarUrl: null, plan: "pro", role: "admin" });
const users = (await fake.db.query("select * from public.trade_users order by username")).rows as any[];
expect("the trade_users view lists every account, however it signs in, without the password fields", [users.map((u) => [u.username, u.email, u.first_name, u.last_name, u.signs_in_with, u.privy_id, u.wallet, u.plan, u.role]), Object.keys(users[0]).some((k) => /hash|salt|pass/i.test(k)), new Date(users[0].created_at).toISOString()], [[["Ada", "ada@example.test", "Ada", "Lovelace", "privy", "did:privy:abc", "So1anaAddr", "free", "user"], ["bob", "bob@example.test", "Bob", "B", "password", null, null, "pro", "admin"]], false, "2026-11-25T09:46:40.000Z"]);
expect("...and it is as closed to the public roles as the tables are", [await asRole("anon", "select * from public.trade_users"), await asRole("authenticated", "select * from public.trade_users"), await asRole("service_role", "select count(*) from public.trade_users")], ["permission denied for view trade_users", "permission denied for view trade_users", "allowed"]);
await store.kvDel("user:ada");
await store.kvDel("user:bob");

// ---- locks ----
expect("a lock is taken once", [await store.lock("watch:a", 5000), await store.lock("watch:a", 5000), await store.lock("watch:b", 5000)], [true, false, true]);
await store.unlock("watch:a");
expect("...and again after it is given back", await store.lock("watch:a", 60), true);
await sleep(90);
expect("...or after it ran out by itself", await store.lock("watch:a", 5000), true);
expect("a lock is not a record the app can read by that name", await store.kvGet("watch:a"), null);

// ---- lists ----
for (let i = 0; i < 7; i++) await store.listPush("ledger:u", { n: i, side: i % 2 ? "SELL" : "BUY" });
await store.listPush("mixed", "a string");
await store.listPush("mixed", 5);
await store.listPush("mixed", [1, 2]);
await store.listPush("mixed", { $v: "an object that looks wrapped" });
expect("a list keeps its order and its length", [await store.listLen("ledger:u"), (await store.listRange<any>("ledger:u", 0, 6)).map((x) => x.n)], [7, [0, 1, 2, 3, 4, 5, 6]]);
expect("a range includes both ends; past the end is simply shorter; an empty list is empty", [(await store.listRange<any>("ledger:u", 2, 4)).map((x) => x.n), (await store.listRange<any>("ledger:u", 5, 99)).map((x) => x.n), await store.listRange("none", 0, 9), await store.listLen("none")], [[2, 3, 4], [5, 6], [], 0]);
expect("entries that are not plain objects come back as they were", await store.listRange("mixed", 0, 9), ["a string", 5, [1, 2], { $v: "an object that looks wrapped" }]);
expect("a plain object is stored as it is, so history can be read with SQL", (await fake.db.query("select value ->> 'side' as side from public.trade_list where key = 'ledger:u' order by id limit 2")).rows.map((r: any) => r.side), ["BUY", "SELL"]);
await store.listReplace("copy", [{ n: 1 }, { n: 2 }, { n: 3 }], true);
await store.listReplace("copy", [{ n: 4 }, { n: 5 }], false);
expect("a batch goes to the end of a list in its order", (await store.listRange<any>("copy", 0, 9)).map((x) => x.n), [1, 2, 3, 4, 5]);
await store.listReplace("copy", [{ n: 9 }], true);
expect("...and a batch that starts over replaces the list", (await store.listRange<any>("copy", 0, 9)).map((x) => x.n), [9]);

// ---- accounts ----
const trade = (i: number) => ({ id: `t${i}`, time: 1794000000000 + i * 60_000, side: i % 2 ? "SELL" : "BUY", symbol: "FOOD", pool: "2XhQqpPoolAddressForTests", price: 0.0123 + i * 1e-6, qty: 81234.5 + i, usd: 1000 + i, feeUsd: 9.87, slippagePct: 0.5, reason: "Profit exit: sold at about +5.1% after fees (best was +7.4%), at the exit the AI set", pnlUsd: i % 2 ? 51.2 : undefined, strategy: "agents", botId: "1" });
const account = (cash: number, trades = 1000) => ({
  mode: "paper", cash, startCash: 1000, peakEquity: 1200, resetAt: 5, positions: [{ id: "p1", symbol: "FOOD", qty: 5, entryPrice: 1, stopLoss: 0.95 }], orders: [], settings: { feePct: 1, slippagePct: 0.5 },
  trades: Array.from({ length: trades }, (_x, i) => trade(i)),
  equity: Array.from({ length: 2000 }, (_x, i) => ({ t: 1794000000000 + i * 30_000, v: 1000 + Math.sin(i / 9) * 40 })),
  bot: { running: true, log: Array.from({ length: 120 }, (_x, i) => ({ t: 1794000000000 + i * 1000, msg: `FOOD: asked the AI for a plan (${i}); it wants to wait for a dip to $0.0119 before buying`, kind: "info" })) },
  lastSignal: null,
});
expect("an account that was never saved: nothing, and no version", [await store.load("ada"), await store.rev("ada"), await store.loadRev("ada")], [null, null, { value: null, rev: null }]);
const doc = account(1000);
const size = Buffer.byteLength(JSON.stringify(doc));
let mark = fake.calls.length;
expect("the first save makes version 1", await store.save(doc, "ada"), 1);
const sentFirst = fake.calls.slice(mark).reduce((s: number, c: any) => s + c.sent, 0);
check(`the account (${Math.round(size / 1024)} KB of JSON) travels gzipped: under a fifth of that`, sentFirst < size / 5, `${Math.round(sentFirst / 1024)} KB sent`);
expect("it is kept in three parts", (await fake.db.query("select name from public.trade_account_parts where key = 'ada' order by name")).rows.map((r: any) => r.name), ["equity", "main", "trades"]);
expect("the version is a few bytes to ask for", [await store.rev("ada"), fake.calls.at(-1).received < 10], [1, true]);

// another server copy
const other = newStore();
mark = fake.calls.length;
const first = await other.loadRev("ada");
const fullLoad = fake.received(mark);
expect("another server copy loads exactly what was saved", [first.rev, canon(first.value) === canon(doc)], [1, true]);
doc.cash = 950;
doc.bot.log.push({ t: 1, msg: "bought", kind: "good" });
mark = fake.calls.length;
expect("a save that changes little makes version 2", await store.save(doc, "ada"), 2);
const sentSmall = fake.calls.slice(mark).reduce((s: number, c: any) => s + c.sent, 0);
check("...and sends only the part that changed (the 1,000 trades and the equity curve stay where they are)", sentSmall < sentFirst / 4, `${Math.round(sentSmall / 1024)} KB against ${Math.round(sentFirst / 1024)} KB the first time`);
mark = fake.calls.length;
const again = await other.loadRev<any>("ada");
const smallLoad = fake.received(mark);
expect("the other copy sees the change", [again.rev, again.value.cash, again.value.bot.log.length, again.value.trades.length, again.value.equity.length], [2, 950, 121, 1000, 2000]);
check("...and is sent only the changed part, not the whole account again", smallLoad < fullLoad / 4, `${Math.round(smallLoad / 1024)} KB against ${Math.round(fullLoad / 1024)} KB for the whole account`);
mark = fake.calls.length;
const same = await other.loadRev<any>("ada");
check("loading an account that did not change brings back no part at all", same.rev === 2 && fake.received(mark) < 400 && canon(same.value) === canon(again.value), `${fake.received(mark)} bytes`);

// a stale copy saves over a newer one: the whole account is what the last saver had (as before)
const theirs = again.value;
theirs.trades = [...theirs.trades, trade(5000)]; // the other copy makes a trade
theirs.cash = 900;
expect("the other copy saves a trade: version 3", await other.save(theirs, "ada"), 3);
mark = fake.calls.length;
doc.cash = 940; // this copy has not looked since; it still holds 1,000 trades
expect("this copy, not having looked since, saves its own state: version 4 (the database refuses the short form once, and everything is sent)", [await store.save(doc, "ada"), fake.count("trade_account_save", mark), fake.calls.slice(mark).map((c: any) => c.status)], [4, 2, [400, 200]]);
const final = await newStore().loadRev<any>("ada");
expect("what is stored is exactly the last saver's account, never a mix of the two", [final.value.cash, final.value.trades.length, canon(final.value) === canon(doc)], [940, 1000, true]);
expect("a part that is no longer in the account is removed", [await store.save({ cash: 1, trades: [trade(1)] }, "ada"), (await fake.db.query("select name from public.trade_account_parts where key = 'ada' order by name")).rows.map((r: any) => r.name), canon(await newStore().load("ada")) === canon({ cash: 1, trades: [trade(1)] })], [5, ["main", "trades"], true]);
expect("a value that is not an object can be an account too (the copy from the old database must not choke)", [await store.save("just text", "odd"), await newStore().load("odd"), await store.save(null, "odd2"), await newStore().load("odd2")], [1, "just text", 1, null]);
expect("the single shared account from before logins has its own place", [await store.save({ cash: 7 }), await newStore().load(), await newStore().load("ada") !== null], [1, { cash: 7 }, true]);

// ---- when something is wrong, the message says what to do ----
fake.fail({ status: 401, body: JSON.stringify({ message: "Invalid API key" }) });
expect("a refused key", await store.kvGet("x").catch((e: Error) => e.message), "Supabase refused the server's key: the SUPABASE_SECRET_KEY setting (SUPABASE_SERVICE_ROLE_KEY on older projects) must be the project's secret key, and server/supabase/schema.sql must have been run.");
fake.fail({ status: 503, body: "upstream connect error" });
mark = fake.calls.length;
expect("the database briefly unwell: a read is asked once more, then says so", [await store.kvGet("x").catch((e: Error) => e.message), fake.calls.length - mark], ["Supabase (trade_kv_get): upstream connect error", 2]);
mark = fake.calls.length;
expect("...a write that adds to a list is not repeated blindly", [await store.listPush("ledger:u", { n: 99 }).catch((e: Error) => e.message), fake.calls.length - mark], ["Supabase (trade_list_push): upstream connect error", 1]);
fake.fail("network");
expect("no answer at all", String(await store.rev("ada").catch((e: Error) => e.message)).startsWith("The database (Supabase) did not answer"), true);
fake.fail(null);
expect("...and it works again once the database is back", [await store.rev("ada"), await store.listLen("ledger:u")], [5, 7]);
await fake.db.exec("alter table public.trade_kv disable row level security");
expect("tables left open are refused, with what to do", await store.check().catch((e: Error) => e.message), "The Supabase tables are open to the public keys: run server/supabase/schema.sql again in the Supabase SQL editor (it closes them).");
await fake.runSchema();
expect("...and running the script again closes them, without touching the data", [await store.check(), await store.rev("ada"), await store.listLen("ledger:u")], [{ accounts: 4 }, 5, 7]);
// ---- the self-test the server runs once on a new database ----
const before = fake.calls.length;
await store.selfTest();
const loadCall = fake.calls.slice(before).find((c: any) => c.fn === "trade_account_load");
check("the self-test saves an account and a list entry and reads them back from the database itself", fake.count("trade_account_save", before) === 1 && JSON.stringify(loadCall?.args.p_have) === "{}" && fake.count("trade_list_push", before) === 1 && (await newStore().load<any>("~selftest")).trades[0].text === "caf\u00e9 \u{1F680}", { calls: fake.calls.slice(before).map((c: any) => c.fn) });
await fake.db.exec("create or replace function public.trade_list_range(p_key text, p_start bigint, p_stop bigint) returns jsonb language sql stable as $$ select '[{\"nonce\":\"something else\"}]'::jsonb $$");
expect("...and it fails loudly if what comes back is not what went in", await store.selfTest().then(() => "passed", (e: Error) => e.message), "Supabase self-test failed: what was saved did not come back the same. Nothing was served from it.");
await fake.runSchema(); // the real function back
const s = store.stats();
check("the store counts its own traffic", s.calls.trade_account_save >= 5 && s.calls.trade_kv_get > 10 && s.sentBytes > 1000 && s.receivedBytes > 1000, { calls: Object.keys(s.calls).length, sentKB: Math.round(s.sentBytes / 1024), receivedKB: Math.round(s.receivedBytes / 1024) });

// a project where the script was never run
const empty = await fakeSupabase({ url: "https://empty.supabase.test", key: "k2", schema: false, setEnv: false });
const bare = supabaseStore(empty.url, empty.key);
expect("a database that was never set up says so", [await bare.kvGet("x").catch((e: Error) => e.message), await bare.check().catch((e: Error) => e.message)], Array(2).fill("The Supabase database is not set up yet: run server/supabase/schema.sql once in the Supabase SQL editor. (Already done? Then check that the Data API is switched on in the Supabase dashboard, under Integrations > Data API.)"));
await empty.runSchema();
expect("...and works as soon as the script has been run (no restart needed)", [await bare.check(), await bare.kvSet("a", 1), await bare.kvGet("a")], [{ accounts: 0 }, true, 1]);
expect("a wrong key is refused by the database", await supabaseStore(empty.url, "not-the-key").kvGet("a").catch((e: Error) => e.message.slice(0, 34)), "Supabase refused the server's key:");

// ---- how the key is sent ----
const legacy = await fakeSupabase({ url: "https://legacy.supabase.test", key: "eyJhbGciOi.legacy.jwt", setEnv: false });
const legacyStore = supabaseStore(legacy.url, legacy.key);
expect("an older JWT key (service_role) is sent as a bearer token as well, first time", [await legacyStore.kvSet("a", 1), await legacyStore.kvGet("a"), legacy.calls.map((c: any) => c.status)], [true, 1, [200, 200]]);
const lenient = await fakeSupabase({ url: "https://other.supabase.test", key: "sb_secret_other", bearer: "required", setEnv: false });
const adapt = supabaseStore(lenient.url, lenient.key);
expect("if the database wants the key the other way round, the store finds out once and remembers", [await adapt.kvSet("a", 2), await adapt.kvGet("a"), await adapt.listLen("x"), lenient.calls.map((c: any) => c.status)], [true, 2, 0, [401, 200, 200, 200]]);
// Two secret keys in the settings, as Vercel's integration gives them: the new one is used first.
const both = await fakeSupabase({ url: "https://both.supabase.test", key: "sb_secret_new", setEnv: false });
const newFirst = supabaseStore(both.url, ["sb_secret_new", "eyJ.old.jwt"]);
expect("with both kinds of key, the new one is used and accepted first time", [await newFirst.kvSet("a", 3), both.calls.map((c: any) => c.status), newFirst.stats().auth], [true, [200], { key: "secret", header: "apikey" }]);
const retired = await fakeSupabase({ url: "https://retired.supabase.test", key: "eyJ.old.jwt", setEnv: false }); // a project that accepts only the older key
const fallBack = supabaseStore(retired.url, ["sb_secret_refused", "eyJ.old.jwt"]);
expect("if the database refuses the new key both ways, the older one is tried, works, and is kept", [await fallBack.kvSet("a", 4), await fallBack.kvGet("a"), retired.calls.map((c: any) => c.status), fallBack.stats().auth], [true, 4, [401, 401, 200, 200], { key: "service_role", header: "apikey+bearer" }]);
process.env.SUPABASE_URL = "https://both.supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJ.old.jwt";
process.env.SUPABASE_SECRET_KEY = "sb_secret_new";
const fromSettings = newStore();
expect("...and that order is what the settings give: SUPABASE_SECRET_KEY before SUPABASE_SERVICE_ROLE_KEY", [await fromSettings.kvGet("a"), fromSettings.stats().auth], [3, { key: "secret", header: "apikey" }]);
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"]) delete process.env[k];
const racing = supabaseStore(lenient.url, lenient.key); // a server copy that has not found out yet, hit by three requests at once
expect("...also when several requests find out at the same moment: every one of them gets through", await Promise.all([racing.kvGet("a"), racing.kvGet("a"), racing.listLen("x")]), [2, 2, 0]);
finish();
