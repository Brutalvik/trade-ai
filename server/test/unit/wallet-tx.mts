// Customers' real-money transactions: one story, told to the local file store and to the
// database (the real SQL of supabase/schema.sql on a Postgres engine in memory, behind the store's
// own HTTP calls). Both must end the same way, message by message: the database's rules
// (trade_wtx_update) and the file store's (wallettx-core.ts) are two copies of one rule book.
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE/.test(k)) delete process.env[k];
delete process.env.VERCEL;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-wtx-")));
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
const { newStore, supabaseStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const { decide, started } = await import(new URL("../../src/wallettx-core.ts", import.meta.url).href);

const fileStore = newStore(); // (made before the stand-in database exists, so it is the local file)
const fake = await fakeSupabase({ setEnv: false });
const stores: [string, any][] = [["file", fileStore], ["database", supabaseStore(fake.url, fake.key)]];
expect("(the two stores are the local file and the database)", stores.map(([, s]) => s.kind), ["file", "supabase"]);
const T = Date.UTC(2026, 10, 26, 10, 0, 0), MIN = 60_000;
const says = (r: any) => [r.applied, r.duplicate, r.note, r.tx?.status ?? null];

const outcomes: Record<string, unknown[]> = {};
for (const [name, s] of stores) {
  const out: unknown[] = (outcomes[name] = []);
  const up = (u: any) => s.wtxUpdate({ provider: "moonpay", source: "webhook", ...u });
  const t0 = await s.wtxStart("wtx_a", "ada", "moonpay", "buy", { fiatCurrency: "usd", fiatAmount: "50.10", cryptoCurrency: "sol", network: "solana", walletAddress: "W1" });
  out.push(["start", t0.status, t0.fiatAmount, t0.walletAddress]);
  out.push(["start again", (await s.wtxStart("wtx_a", "ada", "moonpay", "buy", {})).status]);
  out.push(["the same id for another customer", await s.wtxStart("wtx_a", "bob", "moonpay", "buy", {}).then(() => "accepted", (e: Error) => /another transaction/.test(e.message) ? "refused" : e.message)]);
  out.push(["pending", ...says(await up({ id: "wtx_a", providerId: "mp_1", key: "ada", status: "pending", providerStatus: "waitingPayment", providerAt: T, eventId: "e1", eventType: "transaction_created" }))]);
  out.push(["the same message again", ...says(await up({ id: "wtx_a", providerId: "mp_1", key: "ada", status: "pending", providerAt: T, eventId: "e1" }))]);
  out.push(["completed", ...says(await up({ id: "wtx_a", providerId: "mp_1", key: "ada", status: "completed", providerStatus: "completed", providerAt: T + 5 * MIN, eventId: "e2", fields: { cryptoAmount: "0.312345678", txHash: "sig111", feeAmount: 3.99, walletAddress: "W1" } }))]);
  out.push(["a late 'pending' after it", ...says(await up({ id: "wtx_a", providerId: "mp_1", status: "pending", providerAt: T + 3 * MIN, eventId: "e3" }))]);
  out.push(["asking again: nothing new", ...says(await up({ id: "wtx_a", providerId: "mp_1", status: "completed", providerAt: T + 5 * MIN, source: "check" }))]);
  out.push(["refunded later", ...says(await up({ id: "wtx_a", providerId: "mp_1", status: "refunded", providerAt: T + 60 * MIN, eventId: "e4" }))]);
  out.push(["a message naming another customer", ...says(await up({ id: "wtx_a", providerId: "mp_1", key: "bob", status: "refunded", providerAt: T + 70 * MIN, eventId: "e5" }))]);
  out.push(["our id and theirs disagree", ...says(await up({ id: "wtx_zz", providerId: "mp_1", key: "ada", status: "refunded", providerAt: T + 75 * MIN, eventId: "e5b", fields: { kind: "buy" } }))]);
  const odd = await up({ providerId: "mp_1", status: "refunded", providerAt: T + 80 * MIN, eventId: "e6", fields: { walletAddress: "W2" } });
  out.push(["found by their id alone, naming another wallet", ...says(odd), odd.tx?.flag, odd.tx?.walletAddress]);
  out.push(["a transaction nobody knows", ...says(await up({ providerId: "mp_404", status: "completed", providerAt: T, eventId: "e7" }))]);
  const rec = await up({ id: "wtx_r", providerId: "chain_sig9", key: "ada", status: "completed", providerAt: T + 90 * MIN, eventId: "e8", fields: { kind: "receive", cryptoCurrency: "usdc", cryptoAmount: 25 } });
  out.push(["crypto arriving: made from the message", ...says(rec), rec.tx?.kind, rec.tx?.cryptoAmount]);
  out.push(["...but not without its customer", ...says(await up({ id: "wtx_q", providerId: "chain_sig10", status: "completed", providerAt: T, eventId: "e9", fields: { kind: "receive" } }))]);
  await s.wtxStart("wtx_s", "ada", "moonpay", "buy", { fiatAmount: 20 });
  const a = await s.wtxGet("ada", "wtx_a");
  out.push(["the record", a.tx.status, a.tx.fiatAmount, a.tx.cryptoAmount, a.tx.feeAmount, a.tx.txHash, a.tx.providerId, a.tx.final]);
  out.push(["its messages", a.events.map((e: any) => `${e.source}/${e.type ?? "-"}:${e.applied ? (e.note ? `applied, ${e.note}` : "applied") : e.note}`)]);
  out.push(["ada's transactions, newest first", (await s.wtxList("ada", null, 10)).map((x: any) => x.id)]);
  out.push(["bob sees none of them", (await s.wtxList("bob", null, 10)).length, await s.wtxGet("bob", "wtx_a")]);
  out.push(["the ones still open", (await s.wtxOpen("moonpay", Date.now() + MIN, 10)).map((x: any) => x.id)]);
  out.push(["a page of one", (await s.wtxList("ada", null, 1)).map((x: any) => x.id)]);
}

const story = outcomes.file;
const lines = [
  "a customer starts a buy: kept as 'started', with the amount exactly as given and the wallet it goes to",
  "starting the same transaction again changes nothing",
  "its id cannot be taken by another customer",
  "MoonPay's first message: pending",
  "the same message again is kept once and changes nothing",
  "completed, with what was delivered and its blockchain record",
  "a 'pending' that arrives late never undoes 'completed'",
  "asking MoonPay again and hearing the same changes nothing",
  "a newer final word (refunded) does change it",
  "a message that names another customer changes nothing",
  "a message whose ids point at two different transactions changes nothing",
  "found by MoonPay's id alone; a different wallet than the one the app gave is flagged for a person",
  "a message about a transaction nobody knows is kept, and changes nothing",
  "crypto arriving in a customer's wallet makes its own row",
  "...but only when the message names the customer",
  "the full record",
  "every message about it is kept, with why it did or did not count",
  "a customer's transactions, newest first",
  "a customer sees only their own",
  "the transactions still open (for the server to ask MoonPay about)",
  "pages",
];
for (let i = 0; i < lines.length; i++) console.log(`   ${lines[i]}: ${JSON.stringify(story[i])}`);
expect("the file store and the database tell the story the same way, step by step", JSON.stringify(outcomes.database), JSON.stringify(outcomes.file));
expect("the story is the right one", JSON.stringify(story), JSON.stringify([
  ["start", "started", 50.1, "W1"],
  ["start again", "started"],
  ["the same id for another customer", "refused"],
  ["pending", true, false, null, "pending"],
  ["the same message again", false, true, "the same message again", null],
  ["completed", true, false, null, "completed"],
  ["a late 'pending' after it", false, false, "older news: it is completed already", "completed"],
  ["asking again: nothing new", false, false, "not newer than what is known", "completed"],
  ["refunded later", true, false, null, "refunded"],
  ["a message naming another customer", false, false, "another customer's transaction", "refunded"],
  ["our id and theirs disagree", false, false, "our id and the provider's id name different transactions", "refunded"],
  ["found by their id alone, naming another wallet", true, false, "the provider names wallet W2, not the one the app gave", "refunded", "the provider names wallet W2, not the one the app gave", "W1"],
  ["a transaction nobody knows", false, false, "no such transaction", null],
  ["crypto arriving: made from the message", true, false, null, "completed", "receive", 25],
  ["...but not without its customer", false, false, "no such transaction", null],
  ["the record", "refunded", 50.1, 0.312345678, 3.99, "sig111", "mp_1", true],
  ["its messages", ["app/started:applied", "app/started:already started", "webhook/transaction_created:applied", "webhook/-:applied", "webhook/-:older news: it is completed already", "check/-:not newer than what is known", "webhook/-:applied", "webhook/-:another customer's transaction", "webhook/-:our id and the provider's id name different transactions", "webhook/-:applied, the provider names wallet W2, not the one the app gave"]],
  ["ada's transactions, newest first", ["wtx_s", "wtx_r", "wtx_a"]],
  ["bob sees none of them", 0, null],
  ["the ones still open", ["wtx_s"]],
  ["a page of one", ["wtx_s"]],
]));

// The same rules on their own (wallettx-core), for the edges the story does not reach.
const base = started("x", "ada", "moonpay", "buy", { walletAddress: "W1" }, T);
expect("a first message with no time of its own is taken", decide(base, { provider: "moonpay", status: "pending", source: "check" }).apply, true);
expect("a message from another provider about it is not", decide(base, { provider: "other", status: "completed", source: "webhook" }).note, "another provider's transaction");
const db = fake.db;
const row = (await db.query("select count(*)::int as n from public.trade_wallet_tx_events where provider = 'moonpay' and event_id = 'e1'")).rows[0] as any;
expect("in the database, the message sent twice is one row", row.n, 1);
const open = (await db.query("select has_table_privilege('anon', 'public.trade_wallet_tx', 'select') as a, has_table_privilege('authenticated', 'public.trade_wallet_tx_events', 'select') as b, has_function_privilege('anon', 'public.trade_wtx_list(text,timestamptz,integer)', 'execute') as c")).rows[0] as any;
expect("the tables and their functions are closed to the public keys", [open.a, open.b, open.c], [false, false, false]);
const chk = await supabaseStore(fake.url, fake.key).check();
check("the database's self-check reports the table", chk.accounts >= 0, chk);
await fake.runSchema();
expect("running the setup file again keeps every transaction", ((await db.query("select count(*)::int as n from public.trade_wallet_tx")).rows[0] as any).n, 3);
finish();
