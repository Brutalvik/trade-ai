// AI tokens (src/auth.ts tokenUsage, src/plans.ts): what an account has left, counted in app tokens
// (2 per Claude token), and the answer when they run out, which makes the app open its top-up window.
import { expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-tokens-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|_UPSTASH|CRON_SECRET|ANTHROPIC|OPENAI|MOONPAY|MOONX|STRIPE|BILLING/.test(k)) delete process.env[k];
delete process.env.VERCEL;

const { createStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const store = createStore();
const plans = await import(new URL("../../src/plans.ts", import.meta.url).href);
const auth = await import(new URL("../../src/auth.ts", import.meta.url).href);
const m = plans.month();

expect("2 app tokens are 1 Claude token (the owner's 50% margin)", plans.APP_TOKENS_PER_API_TOKEN, 2);

await store.kvSet(`usage:ada:${m}`, 1_000_000);
let u = await auth.tokenUsage("ada", "pro", "user");
expect("AI Pro, 1M used: 4M of the 5M left, no top-up", [u.used, u.limit, u.topup, u.left], [1_000_000, 5_000_000, 0, 4_000_000]);

await store.kvSet(`usage:ada:${m}`, 5_000_000);
u = await auth.tokenUsage("ada", "pro", "user");
expect("all of the month's allowance used, no top-up: nothing left (the app opens its top-up window)", u.left, 0);

await store.kvSet("topup:ada", 2_000_000);
u = await auth.tokenUsage("ada", "pro", "user");
expect("...a 2M pack bought: 2M left", [u.left, u.topup], [2_000_000, 2_000_000]);

expect("a plan without AI has none left, whatever top-up it holds (top-ups don't add AI to a plan)", (await auth.tokenUsage("ada", "free", "user")).left, 0);
expect("an admin's tokens are unlimited", [(await auth.tokenUsage("ada", "pro", "admin")).left, (await auth.tokenUsage("ada", "pro", "admin")).limit], [-1, -1]);

const next = new Date(u.resetsAt);
expect("the allowance starts again on the 1st of next month (UTC)", [next.getUTCDate(), next.getUTCHours(), plans.month(u.resetsAt) > m], [1, 0, true]);
expect("...from the last moment of a year to January", new Date(plans.nextMonthStart(Date.UTC(2026, 11, 31, 23, 59))).toISOString(), "2027-01-01T00:00:00.000Z");

// When the allowance starts again (allowance.ts): only for a plan being paid for.
const A = await import(new URL("../../src/allowance.ts", import.meta.url).href);
const at = (iso: string) => Date.parse(iso);
const day = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));
const monthly = { subscriptionId: "sub_1", status: "active", cancelAtPeriodEnd: false, paid: { start: at("2026-11-27T10:00:00Z"), end: at("2026-12-27T10:00:00Z"), interval: "month" } };
let c = A.allowanceCycle(null, at("2026-11-15T00:00:00Z"));
expect("a plan with no subscription (set by an admin): a new allowance on the 1st, as before", [c.id, day(c.resetsAt), c.why], ["2026-11", "2026-12-01", "month"]);
c = A.allowanceCycle(monthly, at("2026-12-01T00:00:00Z"));
expect("paid monthly (from Nov 27): no new allowance on Dec 1; it starts again when the renewal is paid on Dec 27", [c.id, day(c.resetsAt), c.why], [A.allowanceCycle(monthly, at("2026-11-28T00:00:00Z")).id, "2026-12-27", "renewal"]);
c = A.allowanceCycle({ ...monthly, status: "past_due" }, at("2027-01-05T00:00:00Z"));
expect("...the renewal not paid (card declined): the same allowance goes on, and it does not start again", [c.id, c.resetsAt, c.why], [A.allowanceCycle(monthly, at("2026-11-28T00:00:00Z")).id, null, "payment"]);
c = A.allowanceCycle({ ...monthly, cancelAtPeriodEnd: true }, at("2026-12-10T00:00:00Z"));
expect("...renewal cancelled: no new allowance; the plan ends on Dec 27", [day(c.resetsAt), c.why], ["2026-12-27", "ends"]);
const yearly = { subscriptionId: "sub_2", status: "active", cancelAtPeriodEnd: false, paid: { start: at("2026-01-31T09:00:00Z"), end: at("2027-01-31T09:00:00Z"), interval: "year" } };
const ids = ["2026-02-10", "2026-03-15", "2026-03-31T10:00:00Z"].map((d) => A.allowanceCycle(yearly, at(d.length === 10 ? `${d}T00:00:00Z` : d)).id);
expect("paid yearly (from Jan 31): a new allowance every month of the paid year (Feb 28, then Mar 31...)", [ids[0] !== ids[1], ids[1] !== ids[2], ids.map((x) => x.split("-").at(-1))], [true, true, ["0", "1", "2"]]);
c = A.allowanceCycle({ ...yearly, cancelAtPeriodEnd: true }, at("2026-06-15T00:00:00Z"));
expect("...renewal cancelled: still every month until the paid year ends", [day(c.resetsAt), c.why], ["2026-06-30", "month"]);
c = A.allowanceCycle(yearly, at("2027-01-15T00:00:00Z"));
expect("...its last month: the next one comes with the yearly renewal, when paid", [day(c.resetsAt), c.why, c.id.split("-").at(-1)], ["2027-01-31", "renewal", "11"]);
c = A.allowanceCycle({ ...yearly, status: "past_due" }, at("2027-03-01T00:00:00Z"));
expect("...the yearly renewal not paid: no new months", [c.id.split("-").at(-1), c.resetsAt, c.why], ["11", null, "payment"]);
expect("months that are shorter keep to their last day (Jan 31 + 1 month = Feb 28)", new Date(A.addMonths(at("2026-01-31T09:00:00Z"), 1)).toISOString(), "2026-02-28T09:00:00.000Z");

const e = new plans.TokensNeeded();
expect("out of tokens: the answer says so with topup (the app opens the token packs, no error text)", [e.topup, /AI tokens/.test(e.message)], [true, true]);
finish();
