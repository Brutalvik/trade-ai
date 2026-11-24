// The server's own routes while the database is missing, blocked, and then working: the status
// page always answers and says what is wrong, nothing that reads logins runs on a database that
// is not ready, and the scheduler's call never looks like a failure (a scheduler that sees
// failures for long enough switches the job off, and the bot would stay off after the fix).
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|SKIP_UPSTASH|CRON_SECRET|ANTHROPIC|OPENAI|PRIVY/.test(k)) delete process.env[k];
process.env.VERCEL = "1"; // as deployed: no local timer, and the app does not open its own port
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
const { fakeUpstash, sampleOldData } = await import(new URL("../upstash-fake.mts", import.meta.url).href);
const supa = await fakeSupabase({ schema: false }); // the project exists; the script has not been run
process.env.KV_REST_API_URL = "https://old.upstash.test";
process.env.KV_REST_API_TOKEN = "old-token";
const upstash = fakeUpstash("https://old.upstash.test", sampleOldData(), { blocked: true });

const app = (await import(new URL("../../src/index.ts", import.meta.url).href)).default;
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const NOT_SET_UP = "The Supabase database is not set up yet: run server/supabase/schema.sql once in the Supabase SQL editor. (Already done? Then check that the Data API is switched on in the Supabase dashboard, under Integrations > Data API.)";

// ---- 1. the database's tables are not there yet ----
let st = await call("GET", "/api/status");
expect("the status page answers, and says what is missing", [st.status, st.body.storage, st.body.storageError, st.body.activeAccounts, st.body.storageEnvNames], [200, "supabase", NOT_SET_UP, null, ["KV_REST_API_TOKEN", "KV_REST_API_URL", "SUPABASE_SECRET_KEY", "SUPABASE_URL"]]);
check("...without giving away any setting's value", !JSON.stringify(st.body).includes("sb_secret") && !JSON.stringify(st.body).includes("old-token"), "");
expect("sign-in routes wait: asking who is signed in gets a plain 'not ready', not a stranger's empty account", [(await call("GET", "/api/auth/me")).status, (await call("GET", "/api/auth/me")).body], [503, { error: NOT_SET_UP }]);
expect("...and so do sign-up, the account view and the admin pages", [(await call("POST", "/api/auth/signup", { username: "eve", email: "eve@example.test", password: "correct horse battery", firstName: "E", lastName: "V" })).status, (await call("GET", "/api/state")).status, (await call("GET", "/api/admin/users")).status], [503, 503, 503]);
let tick = await call("GET", "/api/bot/tick");
expect("the scheduler's call gets a normal reply that says the bot could not run", [tick.status, tick.body], [200, { ok: false, error: NOT_SET_UP }]);
expect("what needs no database still works (the plans)", (await call("GET", "/api/plans")).status, 200);

// ---- 2. the script has been run, but the old database still refuses to be read ----
await supa.runSchema();
st = await call("GET", "/api/status");
check("now the status page says the old data cannot be copied yet, and what to do", st.status === 200 && /^Moving to the new database: .*Unblock it in the Upstash console, or set SKIP_UPSTASH_COPY=1 in Vercel to start with empty accounts\.$/.test(st.body.storageError) && !st.body.storageError.includes("command was"), st.body.storageError);
tick = await call("GET", "/api/bot/tick");
expect("the scheduler's call still gets a normal reply", [tick.status, tick.body.ok, typeof tick.body.error], [200, false, "string"]);
expect("nobody can sign up into the empty database meanwhile", [(await call("POST", "/api/auth/signup", { username: "eve", email: "eve@example.test", password: "correct horse battery", firstName: "E", lastName: "V" })).status, Number((await supa.db.query("select count(*) as n from public.trade_kv")).rows[0].n)], [503, 0]);

// ---- 3. the old database is unblocked ----
upstash.block(false);
st = await call("GET", "/api/status");
expect("the next request copies the data, and the status page is clean: one account with a running agent", [st.status, st.body.storageError, st.body.activeAccounts, st.body.storageEnvNames], [200, undefined, 1, undefined]);
check("...and reports the storage traffic", st.body.storageStats?.calls?.trade_selfcheck >= 1 && st.body.storageStats.receivedBytes > 0, st.body.storageStats?.calls);
const me = await call("GET", "/api/auth/me");
expect("sign-in routes answer again (nobody is signed in here)", [me.status, me.body?.user ?? null], [200, null]);
const taken = await call("POST", "/api/auth/signup", { username: "ada", email: "ada2@example.test", password: "correct horse battery", firstName: "A", lastName: "D" });
check("the logins came across: the copied username is taken", taken.status >= 400 && /taken/i.test(taken.body?.error ?? ""), taken.body);
expect("the owner recorded in the old database is still the owner", (await supa.db.query("select value -> 'v' as v from public.trade_kv where key = 'owner'")).rows[0].v, "ada");
tick = await call("GET", "/api/bot/tick");
expect("the scheduler's call starts the bot for the copied account", [tick.status, tick.body.ok, tick.body.accounts], [200, true, 1]);
const callsAfter = upstash.calls;
await call("GET", "/api/status");
await call("GET", "/api/state");
expect("the old database is not asked again", upstash.calls, callsAfter);
await new Promise((r) => setTimeout(r, 300));
server.close();
finish();
