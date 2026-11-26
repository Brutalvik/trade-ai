// MoonPay purchases (src/moonpay.ts) against a pretend MoonPay API and the real database code
// (supabase/schema.sql on a Postgres engine in memory). What is checked is the rule the module is
// built on: about money the server believes MoonPay, asked directly with the secret key, and
// never the browser. The webhook is tested over HTTP, through the server's real route, because
// its signature is checked on the raw bytes.
import { check, expect, finish } from "../check.mts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-mp-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|_UPSTASH|CRON_SECRET|ANTHROPIC|OPENAI|PRIVY|MOONPAY/.test(k)) delete process.env[k];
process.env.VERCEL = "1"; // as deployed: the server opens no port of its own and runs no timer
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
await fakeSupabase();

// ---------- a pretend MoonPay ----------
type MpTx = { id: string; status: string; createdAt: string; updatedAt: string; externalCustomerId?: string; externalTransactionId?: string; wallet: { address: string }; source: { amount: number; asset: { code: string } }; destination: { amount: number; asset: { code: string } }; fees?: any; transactionHash?: string | null; customer?: { id: string } };
const mp = new Map<string, MpTx>();
const asked: string[] = [];
let mpDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.host !== "api.moonpay.com") return realFetch(input, init);
  asked.push(`${u.pathname}${u.search ? "?" : ""}`);
  const headers = new Headers(init?.headers);
  if (headers.get("x-api-key") !== "sk_test_secret") return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  if (mpDown) return new Response("{}", { status: 503 });
  const one = u.pathname.match(/^\/platform\/v1\/transactions\/([^/]+)$/);
  if (one) return mp.has(one[1]) ? Response.json(mp.get(one[1])) : new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
  if (u.pathname === "/platform/v1/transactions") {
    const ext = u.searchParams.get("externalCustomerId"), since = Date.parse(u.searchParams.get("startDate") ?? "");
    // Like the real sandbox (seen 26 Nov 2026): a customer MoonPay has never seen is "not found", not an empty list.
    if (ext && ![...mp.values()].some((t) => t.externalCustomerId === ext)) return new Response(JSON.stringify({ code: "not_found", message: "Not found" }), { status: 404 });
    return Response.json({ data: [...mp.values()].filter((t) => (!ext || t.externalCustomerId === ext) && (!Number.isFinite(since) || Date.parse(t.createdAt) >= since)), pageInfo: { nextCursor: null } });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

let offset = 0; // moves the server's clock (the database keeps real time)
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + offset;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const mpTx = (id: string, o: Partial<MpTx>): MpTx => ({ id, status: "pending", createdAt: iso(), updatedAt: iso(), wallet: { address: "WalletAda1111" }, source: { amount: 50, asset: { code: "USD" } }, destination: { amount: 0.31, asset: { code: "SOL" } }, ...o });

const moonpay = await import(new URL("../../src/moonpay.ts", import.meta.url).href);
const wallettx = await import(new URL("../../src/wallettx.ts", import.meta.url).href);
const { createStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const store = createStore();

// ---------- settings ----------
expect("with no keys MoonPay is off, and says so", [moonpay.config().on, moonpay.config().reason], [false, "MoonPay is not set up (no keys)."]);
process.env.MOONPAY_SECRET_KEY = "sk_live_x"; process.env.MOONPAY_PUBLISHABLE_KEY = "pk_live_x";
check("live keys alone do not switch real payments on", !moonpay.config().on && /MOONPAY_LIVE=yes/.test(moonpay.config().reason), moonpay.config().reason);
process.env.MOONPAY_SECRET_KEY = "sk_test_secret"; process.env.MOONPAY_PUBLISHABLE_KEY = "pk_live_x";
check("a test secret key with a live publishable key is refused", !moonpay.config().on && /same mode/.test(moonpay.config().reason), moonpay.config().reason);
process.env.MOONPAY_PUBLISHABLE_KEY = "pk_test_public"; process.env.MOONPAY_WEBHOOK_KEY = "wk_test_hooks";
expect("test keys of one kind: on, in sandbox", [moonpay.config().on, moonpay.config().mode], [true, "sandbox"]);
expect("the status the app may see names no secret", ["sk_test_secret", "wk_test_hooks"].some((k) => JSON.stringify(moonpay.publicStatus()).includes(k)), false);

// ---------- signatures ----------
const sign = (body: string, key = "wk_test_hooks", t = Math.floor(Date.now() / 1000)) => `t=${t},s=${crypto.createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
const b = '{"type":"transaction_updated","data":{"id":"x"}}';
expect("MoonPay's signature on the exact bytes is accepted", moonpay.verifySignature(b, sign(b), "wk_test_hooks").ok, true);
expect("...one changed character is not", moonpay.verifySignature(b.replace("x", "y"), sign(b), "wk_test_hooks").why, "signature does not match");
expect("...nor another key's signature", moonpay.verifySignature(b, sign(b, "wk_test_other"), "wk_test_hooks").why, "signature does not match");
expect("...nor a missing or broken header", [moonpay.verifySignature(b, undefined, "k").why, moonpay.verifySignature(b, "t=1,s=zz", "k").why], ["no Moonpay-Signature-V2 header", "malformed signature header"]);
expect("...nor one signed an hour in the future", moonpay.verifySignature(b, sign(b, "wk_test_hooks", Math.floor(Date.now() / 1000) + 3600), "wk_test_hooks").why, "signed in the future");

// ---------- starting a purchase ----------
await store.kvSet("moonpay-wallet:ada", { address: "WalletAda1111", chain: "solana", via: "test", at: Date.now() });
const fail = (p: Promise<unknown>) => p.then(() => "accepted", (e: Error) => e.message);
expect("a purchase needs a currency, a coin, and an amount within the limits", [
  await fail(moonpay.startBuy("ada", { fiatCurrency: "xyz", asset: "sol", fiatAmount: 50 })),
  await fail(moonpay.startBuy("ada", { fiatCurrency: "usd", asset: "doge", fiatAmount: 50 })),
  await fail(moonpay.startBuy("ada", { fiatCurrency: "usd", asset: "sol", fiatAmount: 5 })),
  await fail(moonpay.startBuy("ada", { fiatCurrency: "usd", asset: "sol", fiatAmount: 5000 })),
], ["Choose a currency to pay in.", "Choose a coin to buy.", "The smallest purchase is 20.", "The largest purchase is 500 at a time."]);
expect("a customer without a wallet cannot start one", await fail(moonpay.startBuy("bob", { fiatCurrency: "usd", asset: "sol", fiatAmount: 50 })), "Your wallet is not set up yet.");
const buy = await moonpay.startBuy("ada", { fiatCurrency: "USD", asset: "sol", fiatAmount: "50", walletAddress: "AttackerWallet999" });
expect("the purchase goes to the wallet in the server's record, whatever the browser sends", [buy.walletAddress, (await wallettx.myTransactions("ada", null, 5))[0].walletAddress, (await wallettx.myTransactions("ada", null, 5))[0].status], ["WalletAda1111", "WalletAda1111", "started"]);
check("MoonPay knows the customer by a reference that says nothing about them", /^cus_[0-9a-f]{24}$/.test(buy.customerRef) && buy.customerRef === (await moonpay.customerRef("ada")), buy.customerRef);
const ref = buy.customerRef, bobRef = await moonpay.customerRef("bob");
expect("a customer MoonPay has never seen has no purchases (MoonPay answers 'not found' for them)", await moonpay.fetchCustomerTransactions(ref, Date.now() - 86_400_000), []);

// ---------- the browser reports MoonPay's transaction ----------
mp.set("mp_bob", mpTx("mp_bob", { externalCustomerId: bobRef, wallet: { address: "WalletAda1111" } }));
expect("a transaction MoonPay does not list under this customer is refused", await fail(moonpay.linkBuy("ada", buy.id, "mp_bob")), "MoonPay does not list that transaction under this customer (yet). It will be picked up by itself if it is theirs.");
mp.set("mp_other_wallet", mpTx("mp_other_wallet", { externalCustomerId: ref, wallet: { address: "SomeoneElse222" } }));
expect("...and so is one into another wallet", await fail(moonpay.linkBuy("ada", buy.id, "mp_other_wallet")), "MoonPay's transaction does not match this purchase: it pays into another wallet.");
mp.set("mp_1", mpTx("mp_1", { externalCustomerId: ref, status: "pending" }));
const linked = await moonpay.linkBuy("ada", buy.id, "mp_1");
expect("this customer's transaction into this customer's wallet is linked, with MoonPay's status", [linked.applied, linked.tx?.status, linked.tx?.providerId], [true, "pending", "mp_1"]);
expect("a purchase cannot be linked to a second transaction", await fail(moonpay.linkBuy("ada", buy.id, "mp_other_wallet")), "That purchase is already linked to another MoonPay transaction.");
expect("another customer cannot link to it", await fail(moonpay.linkBuy("bob", buy.id, "mp_1")), "Unknown purchase.");

// ---------- MoonPay's messages, through the real route ----------
const app = (await import(new URL("../../src/index.ts", import.meta.url).href)).default;
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const hook = async (msg: unknown, o: { sig?: string | null; id?: string; type?: string } = {}) => {
  const body = typeof msg === "string" ? msg : JSON.stringify(msg);
  const headers: Record<string, string> = { "content-type": o.type ?? "application/json" };
  if (o.sig !== null) headers["moonpay-signature-v2"] = o.sig ?? sign(body);
  if (o.id) headers["webhook-id"] = o.id;
  const res = await fetch(`${base}/api/moonpay/webhook`, { method: "POST", headers, body });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const completed = { ...mp.get("mp_1")!, status: "completed", updatedAt: iso(Date.now() + 60_000), transactionHash: "SolSig999", destination: { amount: 0.312, asset: { code: "SOL" } } };
const msg = { type: "transaction_updated", data: { ...completed, externalTransactionId: buy.id }, externalCustomerId: ref };
expect("a message without MoonPay's signature is refused, and changes nothing", [(await hook(msg, { sig: null })).status, (await wallettx.myTransaction("ada", buy.id))!.tx.status], [400, "pending"]);
expect("...so is one signed with another key", (await hook(msg, { sig: sign(JSON.stringify(msg), "wk_test_forged") })).status, 400);
mp.set("mp_1", completed); // (what MoonPay's API says from now on)
const h1 = await hook(msg, { id: "wh_1" });
await new Promise((r) => setTimeout(r, 300)); // (the re-check after answering)
const after1 = (await wallettx.myTransaction("ada", buy.id))!;
expect("a signed message is saved and answered; the purchase is completed, with what was delivered", [h1.status, after1.tx.status, after1.tx.cryptoAmount, after1.tx.txHash], [200, "completed", 0.312, "SolSig999"]);
check("...and MoonPay was asked for the transaction itself after answering", asked.filter((a) => a === "/platform/v1/transactions/mp_1").length >= 2, asked);
const h2 = await hook(msg, { id: "wh_1" });
expect("the same message delivered again counts once", [h2.status, h2.body.duplicate], [200, true]);
const sameBytes = JSON.stringify(msg);
expect("...also when MoonPay sends it as plain text rather than JSON", (await hook(sameBytes, { id: "wh_1b", type: "text/plain" })).status, 200);
const late = { type: "transaction_updated", data: { ...mp.get("mp_1")!, status: "pending", updatedAt: iso(Date.now() - 60_000), externalTransactionId: buy.id }, externalCustomerId: ref };
await hook(late, { id: "wh_old" });
expect("a 'pending' that arrives late does not undo 'completed'", (await wallettx.myTransaction("ada", buy.id))!.tx.status, "completed");
expect("a message about something other than a purchase is acknowledged and ignored", (await hook({ type: "identity_check_updated", data: { id: "c1" } }, { id: "wh_x" })).body, { ok: true, ignored: "identity_check_updated" });
const events = (await wallettx.myTransaction("ada", buy.id))!.events.map((e: any) => `${e.source}:${e.applied ? "applied" : e.note}`);
check("every message about the purchase is kept with why it did or did not count", events.includes("webhook:applied") && events.some((e: string) => e.startsWith("webhook:older news")), events);

// ---------- the minute check ----------
const lost = await moonpay.startBuy("ada", { fiatCurrency: "usd", asset: "sol", fiatAmount: 30 });
mp.set("mp_2", mpTx("mp_2", { externalCustomerId: ref, status: "completed", source: { amount: 30, asset: { code: "USD" } } })); // the browser never reported it
mp.set("mp_3", mpTx("mp_3", { externalCustomerId: ref, status: "completed", wallet: { address: "ElsewhereWallet333" } })); // bought into another wallet
const forgotten = await moonpay.startBuy("ada", { fiatCurrency: "usd", asset: "sol", fiatAmount: 25 });
offset = 3 * 60_000; // three minutes later
let tally = await moonpay.reconcile(10_000);
const mine = await wallettx.myTransactions("ada", null, 20);
const row = (id: string) => mine.find((t: any) => t.id === id);
expect("a purchase the browser never reported is found at MoonPay and linked to the purchase started", [row(lost.id)?.providerId, row(lost.id)?.status], ["mp_2", "completed"]);
const found = mine.find((t: any) => t.providerId === "mp_3");
check("a purchase at MoonPay the app did not start is recorded too, and flagged: it went into another wallet", !!found && found.status === "completed" && /not the customer's wallet/.test(found.flag ?? ""), found);
expect("the purchase that never reached MoonPay is still open", row(forgotten.id)?.status, "started");
check("what the check did", tally.linked === 1 && tally.found >= 1 && tally.errors === 0, tally);
offset = 25 * 3_600_000; // a day later
tally = await moonpay.reconcile(10_000);
expect("after a day it is closed as expired, with why", [(await wallettx.myTransaction("ada", forgotten.id))!.tx.status, (await wallettx.myTransaction("ada", forgotten.id))!.tx.failureReason], ["expired", "The payment was never completed at MoonPay."]);
mpDown = true;
expect("...but when MoonPay's list itself does not work, that is an error, never an empty list", await moonpay.fetchCustomerTransactions("cus_000000000000000000000000", 0).then(() => "empty", (e: Error) => e.message.slice(0, 11)), "MoonPay 503");
const pend = await moonpay.startBuy("ada", { fiatCurrency: "usd", asset: "sol", fiatAmount: 40 });
mp.set("mp_4", mpTx("mp_4", { externalCustomerId: ref, createdAt: iso(), status: "pending" }));
offset += 3 * 60_000;
tally = await moonpay.reconcile(10_000);
expect("when MoonPay does not answer, nothing is changed or lost: it is asked again next time", [(await wallettx.myTransaction("ada", pend.id))!.tx.status, tally.errors > 0], ["started", true]);
mpDown = false;
offset += 2 * 60_000;
await moonpay.reconcile(10_000);
expect("...and next time it is linked", (await wallettx.myTransaction("ada", pend.id))!.tx.providerId, "mp_4");

// ---------- the customer's own list, through the real route ----------
const signup = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "carol", email: "carol@example.test", password: "correct horse battery 9", firstName: "Carol", lastName: "Test" }) });
const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0];
const list = await fetch(`${base}/api/wallet/transactions`, { headers: { cookie } }).then((r) => r.json() as any);
expect("a signed-in customer gets their own transactions only (Carol has none; Ada's are not shown)", [list.transactions?.length, list.moonpay?.on], [0, true]);
expect("signed out: nothing", (await fetch(`${base}/api/wallet/transactions`)).status, 401);
const one = await fetch(`${base}/api/wallet/transactions/${buy.id}`, { headers: { cookie } });
expect("another customer's transaction cannot be opened by its id", one.status, 404);
check("what the customer sees never carries MoonPay's raw record", !JSON.stringify((await wallettx.myTransactions("ada", null, 5))[0]).includes('"detail"'), "");

server.close();
finish();
