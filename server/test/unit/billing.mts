// Paying for plans by card (src/billing.ts), against a pretend Stripe (its API and its signed
// webhooks), and the owner's plans (src/plans.ts). A plan changes only on what Stripe says.
import { check, expect, finish } from "../check.mts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-bill-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|_UPSTASH|CRON_SECRET|ANTHROPIC|OPENAI|MOONPAY|MOONX|STRIPE|BILLING|APP_URL/.test(k)) delete process.env[k];
delete process.env.VERCEL;
process.env.STRIPE_API_URL = "https://stripe.fake.test";

// ---------- a pretend Stripe ----------
let n = 0;
const nid = (p: string) => `${p}_${(++n).toString().padStart(6, "0")}`;
const prices: any[] = [], customers: any[] = [], sessions = new Map<string, any>(), subs = new Map<string, any>();
const idem = new Map<string, any>();
const updates: any[] = [];
let portalConfigs = 0;
const versions = new Set<string>(); // the Stripe-Version every call sent
const productUpdates: { id: string; tax_code: string | null }[] = [];
const nested = (q: URLSearchParams, key: string) => q.get(key);
globalThis.fetch = (async (input: any, init?: any) => {
  const u = new URL(String(input));
  if (u.host !== "stripe.fake.test") throw new Error(`no network in this test: ${u.host}`);
  const h = new Headers(init?.headers);
  if (h.get("authorization") !== "Bearer sk_test_fake") return Response.json({ error: { message: "bad key" } }, { status: 401 });
  versions.add(String(h.get("stripe-version")));
  const key = h.get("idempotency-key");
  if (key && idem.has(key)) return Response.json(idem.get(key));
  const q = new URLSearchParams(init?.method === "POST" ? String(init?.body ?? "") : u.search);
  const p = u.pathname;
  const out = (o: any) => { if (key) idem.set(key, o); return Response.json(o); };
  if (p === "/v1/prices" && init?.method === "GET") return Response.json({ data: prices.filter((x) => x.lookup_key === q.get("lookup_keys[]") && x.active) });
  if (p === "/v1/prices") {
    const lk = q.get("lookup_key");
    if (q.get("transfer_lookup_key") === "true") for (const x of prices) if (x.lookup_key === lk) x.lookup_key = null;
    const price = { id: nid("price"), active: true, currency: q.get("currency"), unit_amount: Number(q.get("unit_amount")), lookup_key: lk, recurring: q.get("recurring[interval]") ? { interval: q.get("recurring[interval]") } : null, product: { id: nid("prod"), tax_code: q.get("product_data[tax_code]") } };
    prices.push(price);
    return out(price);
  }
  const prod = /^\/v1\/products\/(prod_\w+)$/.exec(p);
  if (prod && init?.method === "POST") {
    productUpdates.push({ id: prod[1], tax_code: q.get("tax_code") });
    for (const x of prices) if (x.product?.id === prod[1]) x.product.tax_code = q.get("tax_code");
    return out({ id: prod[1], tax_code: q.get("tax_code") });
  }
  if (p === "/v1/customers") { const c = { id: nid("cus"), email: q.get("email"), metadata: { user: q.get("metadata[user]") } }; customers.push(c); return out(c); }
  if (p === "/v1/checkout/sessions" && init?.method === "POST") {
    const inApp = q.get("ui_mode") === "elements" || q.get("ui_mode") === "embedded_page";
    const s = { id: nid("cs"), url: inApp ? null : `https://checkout.stripe.test/${n}`, client_secret: inApp ? `cs_secret_${n}` : null, ui_mode: q.get("ui_mode") ?? "hosted_page", managed: q.get("managed_payments[enabled]"), return_url: q.get("return_url"), success_url: q.get("success_url"), mode: q.get("mode"), customer: q.get("customer"), client_reference_id: q.get("client_reference_id"), price: q.get("line_items[0][price]"), payment_status: "unpaid", subscription: null as string | null,
      metadata: { user: q.get("metadata[user]"), kind: q.get("metadata[kind]"), pack: q.get("metadata[pack]") ?? undefined, plan: q.get("metadata[plan]") ?? undefined }, subMeta: { user: q.get("subscription_data[metadata][user]") } };
    sessions.set(s.id, s);
    return out(s);
  }
  const cs = /^\/v1\/checkout\/sessions\/(cs_\w+)$/.exec(p);
  if (cs) return Response.json(sessions.get(cs[1]));
  const sub = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(p);
  if (sub && init?.method === "POST") {
    const s = subs.get(sub[1]);
    if (q.get("items[0][price]")) s.items.data[0].price = prices.find((x) => x.id === q.get("items[0][price]"));
    if (q.get("cancel_at_period_end")) s.cancel_at_period_end = q.get("cancel_at_period_end") === "true";
    updates.push({ id: s.id, price: nested(q, "items[0][price]"), proration: q.get("proration_behavior"), cancel: q.get("cancel_at_period_end") });
    return out(s);
  }
  if (sub) return Response.json(subs.get(sub[1]));
  if (p === "/v1/billing_portal/configurations") { portalConfigs++; return out({ id: "bpc_1" }); }
  if (p === "/v1/billing_portal/sessions") return Response.json({ url: `https://billing.stripe.test/${q.get("customer")}` });
  return Response.json({ error: { message: `not faked: ${p}` } }, { status: 404 });
}) as typeof fetch;
// Paying on Stripe's page: the session is paid, a subscription made for a plan.
const DAY = 86_400_000;
function pay(sessionId: string) {
  const s = sessions.get(sessionId);
  s.payment_status = "paid";
  if (s.mode === "subscription") {
    const id = nid("sub");
    subs.set(id, { id, customer: s.customer, status: "active", cancel_at_period_end: false, metadata: s.subMeta, latest_invoice: { id: nid("in"), status: "paid" }, items: { data: [{ id: nid("si"), price: prices.find((x) => x.id === s.price), current_period_start: Math.floor(Date.now() / 1000), current_period_end: Math.floor((Date.now() + 30 * DAY) / 1000) }] } });
    s.subscription = id;
  }
  return s;
}
const SECRET = "whsec_test_fake";
const signed = (ev: any, secret = SECRET, t = Math.floor(Date.now() / 1000)) => {
  const raw = Buffer.from(JSON.stringify(ev));
  return { raw, headers: { "stripe-signature": `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}` } };
};
let evN = 0;
const event = (type: string, object: any) => ({ id: `evt_${++evN}`, type, data: { object } });

const { createStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const store = createStore();
const plans = await import(new URL("../../src/plans.ts", import.meta.url).href);
const billing = await import(new URL("../../src/billing.ts", import.meta.url).href);
const auth = await import(new URL("../../src/auth.ts", import.meta.url).href);
const allowance = await import(new URL("../../src/allowance.ts", import.meta.url).href);
const fail = (p: Promise<unknown>) => p.then(() => "accepted", (e: Error) => e.message);
const send = async (ev: any, secret?: string, t?: number) => { const s = signed(ev, secret, t); return billing.webhook(s.raw, s.headers); };
const planNow = async (u: string) => auth.planOfUser(u);
const changes: string[] = [];
billing.onPlanChanged(async (u: string, before: string, after: string) => { changes.push(`${u}:${before}->${after}`); });

// ---------- the owner's plans ----------
expect("four plans, at the owner's prices: Free, Starter $19, AI Pro $59, AI Max $149", plans.PLAN_ORDER.map((id: string) => [plans.PLANS[id].name, plans.PLANS[id].priceUsd]), [["Free", 0], ["Starter", 19], ["AI Pro", 59], ["AI Max", 149]]);
expect("a year is 11 months ($209, $649, $1,639)", ["starter", "pro", "max"].map((id) => plans.PLANS[id].priceUsd * plans.YEARLY_MONTHS_PAID), [209, 649, 1639]);
expect("agents at once and AI tokens a month: 1 and 1.5M, 3 and 5M, 10 and 13M", ["starter", "pro", "max"].map((id) => [plans.PLANS[id].bots, plans.PLANS[id].aiTokens]), [[1, 1_500_000], [3, 5_000_000], [10, 13_000_000]]);
expect("trade charges: 0.5% on Free; 200 free then 0.15% on Starter; none on AI Pro and AI Max", ["free", "starter", "pro", "max"].map((id) => [plans.PLANS[id].feePct, Number.isFinite(plans.PLANS[id].freeTrades) ? plans.PLANS[id].freeTrades : "all"]), [[0.5, 0], [0.15, 200], [0, "all"], [0, "all"]]);
expect("token packs: 2M $20, 5M $50, 10M $100", plans.TOKEN_PACKS.map((k: any) => [k.tokens, k.priceUsd]), [[2e6, 20], [5e6, 50], [1e7, 100]]);
expect("2 app tokens = 1 Claude token (the owner's rate)", plans.APP_TOKENS_PER_API_TOKEN, 2);
expect("auto-pick (and the real auto-pilot) is included from AI Pro", plans.firstPlanWith("bot.autopick"), "pro");
expect("an account still marked with the old Member plan counts as Starter", plans.planOf("member").id, "starter");

// ---------- switched off until Stripe's keys are set ----------
check("off without keys, saying what to set", !billing.billingConfig().on && /STRIPE_SECRET_KEY/.test(billing.billingConfig().reason), billing.billingConfig().reason);
process.env.STRIPE_SECRET_KEY = "pk_test_publishable";
check("...a publishable key in its place is named", /publishable key/.test(billing.billingConfig().reason), billing.billingConfig().reason);
process.env.STRIPE_SECRET_KEY = "sk_live_real";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
check("a live key is not used without STRIPE_LIVE=yes (real cards)", /STRIPE_LIVE=yes/.test(billing.billingConfig().reason), billing.billingConfig().reason);
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
expect("on in test mode with a test key and the webhook secret", billing.billingConfig(), { on: true, mode: "test", reason: null });

// ---------- subscribing ----------
await store.kvSet("user:ada", { username: "ada", firstName: "Ada", lastName: "L", email: "ada@example.test", salt: "", hash: "", passVer: 1, createdAt: Date.now(), avatarUrl: null });
await store.kvSet("user:bob", { username: "bob", firstName: "Bob", lastName: "B", email: "bob@example.test", salt: "", hash: "", passVer: 1, createdAt: Date.now(), avatarUrl: null, plan: "max" });
const T = billing.TERMS_VERSION;
expect("the Subscription Terms must be accepted first", await fail(billing.checkout("ada", { plan: "starter", interval: "month" })), "Please read and accept the Subscription Terms first.");
expect("the Free plan is not bought", await fail(billing.checkout("ada", { plan: "free", interval: "month", terms: T })), "Choose a paid plan.");
const c1 = await billing.checkout("ada", { plan: "starter", interval: "month", terms: T });
check("Starter monthly: Stripe's payment page", /^https:\/\/checkout\.stripe\.test\//.test(c1.url), c1);
const s1 = [...sessions.values()].at(-1);
expect("...for $19 a month, the price found again by its lookup key, for this account", [prices.find((x) => x.id === s1.price)?.unit_amount, prices.find((x) => x.id === s1.price)?.lookup_key, s1.client_reference_id], [1900, "trading_rust_starter_month", "ada"]);
await billing.checkout("ada", { plan: "starter", interval: "year", terms: T });
expect("yearly: $209 (11 months), one Stripe customer for the account", [prices.find((x) => x.lookup_key === "trading_rust_starter_year")?.unit_amount, customers.length], [20900, 1]);
expect("nothing changes before Stripe says it is paid", await planNow("ada"), "free");

// ---------- Stripe's word: signed webhooks ----------
pay(s1.id);
const done = event("checkout.session.completed", sessions.get(s1.id));
expect("refused: a webhook not signed with the secret", (await send(done, "whsec_other")).status, 400);
expect("refused: a signed webhook from long ago (replayed)", (await send(done, SECRET, Math.floor(Date.now() / 1000) - 3600)).status, 400);
expect("accepted: paid, and the account is on Starter (the subscription read again from Stripe)", [(await send(done)).status, await planNow("ada")], [200, "starter"]);
expect("...the same event again changes nothing", [((await send(done)).body as any).repeat, changes], [true, ["ada:free->starter"]]);
let st = await billing.status("ada");
check("...the subscription shows: monthly, renewing in about 30 days", st.subscription?.interval === "month" && Math.abs((st.subscription?.periodEnd ?? 0) - (Date.now() + 30 * DAY)) < 60_000, st.subscription);
expect("someone else's payment page cannot be confirmed by this account", await fail(billing.confirm("bob", { sessionId: s1.id })), "That payment is not yours.");

// Up: at once, the difference charged now.
const up = await billing.checkout("ada", { plan: "pro", interval: "month", terms: T });
expect("upgrading a running subscription: AI Pro at once, Stripe charging the difference now", [(up as any).changed, updates.at(-1).proration, await planNow("ada"), changes.at(-1)], [true, "always_invoice", "pro", "ada:starter->pro"]);
// Down: at the end of the period paid.
await billing.change("ada", { plan: "starter", interval: "month" });
st = await billing.status("ada");
expect("downgrading: Starter from the next renewal (nothing refunded now), AI Pro kept until then", [updates.at(-1).proration, await planNow("ada"), st.subscription?.keep?.plan], ["none", "pro", "pro"]);
await store.kvSet("billing:ada", { ...(await store.kvGet("billing:ada")), keep: { plan: "pro", until: Date.now() - 1000 } }); // (the period has ended)
const subId = st.subscription && (await store.kvGet("billing:ada")).subscriptionId;
await send(event("customer.subscription.updated", subs.get(subId)));
expect("...at the renewal, Starter", [await planNow("ada"), changes.at(-1)], ["starter", "ada:pro->starter"]);
// Cancel: kept until the end, then Free.
await billing.cancel("ada");
expect("cancelling: nothing ends now (the plan stays until the period's end)", [updates.at(-1).cancel, await planNow("ada"), (await billing.status("ada")).subscription?.cancelAtPeriodEnd], ["true", "starter", true]);
subs.get(subId).status = "past_due";
await send(event("invoice.payment_failed", { id: "in_1", customer: subs.get(subId).customer, subscription: subId }));
expect("a failed renewal keeps the plan while Stripe retries the card", await planNow("ada"), "starter");
subs.get(subId).status = "canceled";
await send(event("customer.subscription.deleted", subs.get(subId)));
expect("...and when the subscription ends, Free", [await planNow("ada"), changes.at(-1)], ["free", "ada:starter->free"]);

// An admin's plan is never taken away by billing.
const cb = await billing.checkout("bob", { plan: "starter", interval: "month", terms: T });
pay([...sessions.values()].at(-1).id);
await send(event("checkout.session.completed", [...sessions.values()].at(-1)));
expect("an account an admin put on AI Max that subscribes to Starter keeps AI Max", [!!cb, await planNow("bob")], [true, "max"]);
const bobSub = (await store.kvGet("billing:bob")).subscriptionId;
subs.get(bobSub).status = "canceled";
await send(event("customer.subscription.deleted", subs.get(bobSub)));
expect("...and keeps it when that subscription ends", await planNow("bob"), "max");

// ---------- AI token packs ----------
expect("a token pack also needs the Subscription Terms", await fail(billing.buyPack("ada", { pack: "pack5m" })), "Please read and accept the Subscription Terms first.");
const pk = await billing.buyPack("ada", { pack: "pack5m", terms: T });
const ps = pay([...sessions.values()].at(-1).id);
expect("a pack is a one-time payment of $50", [!!pk.url, ps.mode, prices.find((x) => x.id === ps.price)?.unit_amount], [true, "payment", 5000]);
await send(event("checkout.session.completed", ps));
await send(event("checkout.session.completed", { ...ps })); // (Stripe sends it again, with another event id)
expect("paid: 5M AI tokens added once, however often Stripe says so", await store.kvGet("topup:ada"), 5_000_000);
expect("back from Stripe's page, the app is told it was a pack (not the plan the account is on)", (await billing.confirm("ada", { sessionId: ps.id })).paid, { kind: "pack", tokens: 5_000_000 });

// ---------- Stripe's billing page ----------
const pt = await billing.portal("ada");
await billing.portal("ada");
expect("Manage billing opens Stripe's page for the account; its settings are made once", [/^https:\/\/billing\.stripe\.test\/cus_/.test(pt.url), portalConfigs], [true, 1]);
expect("an account that never paid has no billing page", await fail(billing.portal("carol")), "You have no billing yet: choose a plan first.");
// Stripe's Managed Payments (on by default on new accounts) works out sales tax from each product's
// tax category: every product gets one, and every call names the API version this was tested on.
expect("every product made has a tax category (SaaS, personal use)", [...new Set(prices.filter((x) => x.product).map((x) => x.product.tax_code))], ["txcd_10103000"]);
prices.push({ id: "price_old", active: true, currency: "usd", unit_amount: 10_000, lookup_key: "trading_rust_pack10m", recurring: null, product: { id: "prod_old", tax_code: null } });
await billing.buyPack("ada", { pack: "pack10m", terms: T });
expect("...a product made before that, without one, is given it when it is next sold", productUpdates.filter((x) => x.id === "prod_old"), [{ id: "prod_old", tax_code: "txcd_10103000" }]);
expect("every call to Stripe names the API version it was tested against", [...versions], ["2026-11-18.endive"]);
// ---------- The AI allowance starts again only for a plan being paid for (the owner's rule) ----------
await store.kvSet("user:dora", { username: "dora", firstName: "Dora", lastName: "D", email: "dora@example.test", salt: "", hash: "", passVer: 1, createdAt: Date.now(), avatarUrl: null });
expect("without a subscription: by the calendar month, as before", (await allowance.allowanceOf("dora")).id, plans.month());
await billing.checkout("dora", { plan: "pro", interval: "month", terms: T });
const sd = pay([...sessions.values()].at(-1).id);
await send(event("checkout.session.completed", sd));
const dsub = subs.get(sd.subscription);
let al = await allowance.allowanceOf("dora");
expect("paid monthly: its allowance runs by the paid month, and starts again when the renewal is paid", [/^p\d+-0$/.test(al.id), al.why, al.resetsAt], [true, "renewal", 1000 * dsub.items.data[0].current_period_end]);
await store.kvSet(`usage:dora:${al.id}`, 5_000_000);
expect("...its use is counted in that month (all 5M used: none left)", (await auth.tokenUsage("dora", "pro", "user")).left, 0);
// The renewal: Stripe starts the next month, but its invoice is not paid yet.
const item = dsub.items.data[0];
Object.assign(item, { current_period_start: item.current_period_end, current_period_end: item.current_period_end + 30 * 86_400 });
dsub.latest_invoice = { id: nid("in"), status: "open" };
await send(event("customer.subscription.updated", dsub));
expect("a new month whose invoice is not paid yet: no new allowance", [(await allowance.allowanceOf("dora")).id, (await auth.tokenUsage("dora", "pro", "user")).left], [al.id, 0]);
dsub.status = "past_due";
await send(event("invoice.payment_failed", { id: dsub.latest_invoice.id, subscription: dsub.id }));
const due = allowance.allowanceCycle(await store.kvGet("billing:dora"), Date.now() + 31 * DAY);
expect("the payment failed: it does not start again until a payment goes through", [due.id, due.resetsAt, due.why], [al.id, null, "payment"]);
dsub.status = "active";
dsub.latest_invoice.status = "paid";
await send(event("invoice.paid", { id: dsub.latest_invoice.id, subscription: dsub.id }));
const al2 = await allowance.allowanceOf("dora", Date.now() + 31 * DAY);
expect("paid: the new month's allowance starts (all of it)", [al2.id !== al.id, (await store.kvGet(`usage:dora:${al2.id}`)) ?? 0], [true, 0]);
await billing.cancel("dora");
expect("renewal cancelled: what is left lasts until the plan ends, then it does not start again", (await allowance.allowanceOf("dora", Date.now() + 31 * DAY)).why, "ends");

// ---------- Paying in the app's own window, on its own form (Stripe's secure card fields in it) ----------
expect("without the publishable key, customers pay on Stripe's page (asked for the form or not)", [billing.publishableKey(), "url" in (await billing.buyPack("ada", { pack: "pack2m", terms: T, embedded: true }))], [null, true]);
process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_wrongmode";
expect("...a publishable key of the other mode (live with a test secret key) is not used", billing.publishableKey(), null);
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_app";
expect("with it, the app's status gives it to the browser (it is public by design)", (await billing.status("ada")).publishableKey, "pk_test_app");
const emb = await billing.buyPack("ada", { pack: "pack2m", terms: T, embedded: true });
const es = [...sessions.values()].at(-1);
expect("a pack paid on the app's own form: an elements session, its client secret to the browser, back to the app if a payment method must leave it", [emb.clientSecret, emb.sessionId, emb.publishableKey, es.ui_mode, /billing=done&session_id=\{CHECKOUT_SESSION_ID\}$/.test(es.return_url), es.success_url], [es.client_secret, es.id, "pk_test_app", "elements", true, null]);
expect("...with Stripe's Managed Payments off for it (it allows only Stripe's own page or form)", es.managed, "false");
await store.kvSet("user:erin", { username: "erin", firstName: "Erin", lastName: "E", email: "erin@example.test", salt: "", hash: "", passVer: 1, createdAt: Date.now(), avatarUrl: null });
const ep = await billing.checkout("erin", { plan: "starter", interval: "year", terms: T, embedded: true });
expect("...a new plan too", ["clientSecret" in ep, [...sessions.values()].at(-1).ui_mode], [true, "elements"]);
expect("...and Stripe's page still when the app does not ask for the form", "url" in (await billing.buyPack("ada", { pack: "pack2m", terms: T })), true);
delete process.env.STRIPE_PUBLISHABLE_KEY;

finish();
