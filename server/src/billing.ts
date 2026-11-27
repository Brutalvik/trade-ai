// Paying for plans and AI token packs, by card, through Stripe. A module of its own (the owner:
// "use it as a separate contract"): the rest of the app only sees an account's plan change or AI
// tokens added (auth.ts setPlanFromBilling / addTokensFromBilling), and its own Subscription
// Terms, which a customer accepts before paying (TERMS_VERSION; the app shows them).
//
// How it stays honest:
//  - Card details never touch this app: customers pay on Stripe's own page (Checkout), and
//    change their card, see invoices or cancel on Stripe's billing page (the customer portal).
//  - A plan is given or taken away only on what Stripe itself says: a signed webhook
//    (Stripe-Signature, checked here), after which the subscription is read again from Stripe.
//    Nothing the browser sends changes a plan.
//  - Rules: an upgrade takes effect at once (Stripe charges the difference for the rest of the
//    period); a downgrade or a cancellation at the end of the period already paid; a failed renewal
//    keeps the plan while Stripe retries the card (its own retry schedule), and ends it when Stripe
//    gives up. An account given its plan by an admin is never downgraded by billing.
//  - Prices come from plans.ts. Stripe's prices are made on first use, found again by their
//    lookup keys (trading_rust_<plan>_<month|year>, trading_rust_<pack>); a price changed in
//    plans.ts makes a new Stripe price for new customers (existing ones keep theirs until they change plan).
//
// Settings (Vercel): STRIPE_SECRET_KEY (sk_test_... / sk_live_..., or a restricted rk_ key),
// STRIPE_WEBHOOK_SECRET (whsec_..., from the webhook endpoint https://<app>/api/billing/webhook),
// STRIPE_LIVE=yes for a live key (real cards are charged only then), APP_URL (default
// https://trade-ai-rust.vercel.app: where Stripe sends customers back), STRIPE_TAX_CODE (the
// products' tax category, default txcd_10103000 "Software as a service, personal use": Stripe's
// Managed Payments, on by default on new accounts, needs one to work out sales tax),
// STRIPE_API_VERSION (default the version this was tested against, below), STRIPE_PUBLISHABLE_KEY
// (pk_test_... / pk_live_..., the same mode as the secret key: with it, customers pay on the app's own
// checkout form, in its own window; without it, on Stripe's own page).
import crypto from "node:crypto";
import { createStore } from "./store.js";
import { PLAN_ORDER, PLANS, TOKEN_PACKS, YEARLY_MONTHS_PAID, planOf, type PlanId } from "./plans.js";
import * as auth from "./auth.js";
import { audit } from "./audit.js";
import { billingKey, forgetAllowance, type PaidPeriod } from "./allowance.js";

const store = () => createStore();
export const TERMS_VERSION = "2026-11-27";

// ---------- Settings ----------
export function billingConfig(): { on: boolean; mode: "test" | "live" | null; reason: string | null } {
  const off = (reason: string) => ({ on: false, mode: null, reason });
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "", hook = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  if (process.env.BILLING?.trim().toLowerCase() === "off") return off("Billing is switched off on the server (BILLING=off).");
  if (!key) return off("Billing needs STRIPE_SECRET_KEY in Vercel (Stripe dashboard, Developers, API keys: the secret key, sk_test_... first).");
  if (/^["']|["']$/.test(key)) return off("STRIPE_SECRET_KEY has quotes around it in Vercel: remove them.");
  if (key.startsWith("pk_")) return off("STRIPE_SECRET_KEY holds Stripe's publishable key (pk_...): use the secret key (sk_...).");
  if (!/^(sk|rk)_(test|live)_/.test(key)) return off("STRIPE_SECRET_KEY is not a Stripe secret key: it should start with sk_test_ or sk_live_.");
  if (!hook.startsWith("whsec_")) return off("Billing needs STRIPE_WEBHOOK_SECRET in Vercel (whsec_..., from the webhook endpoint .../api/billing/webhook in Stripe).");
  const mode = /_live_/.test(key) ? "live" : "test";
  if (mode === "live" && process.env.STRIPE_LIVE?.trim().toLowerCase() !== "yes") return off("A live Stripe key is set, but STRIPE_LIVE=yes is not: real cards are charged only with both.");
  return { on: true, mode, reason: null };
}
// The publishable key for Stripe's form inside the app (public by design), when it is set and of the
// same mode as the secret key; null = customers pay on Stripe's own page instead.
export function publishableKey(): string | null {
  const c = billingConfig();
  const pk = process.env.STRIPE_PUBLISHABLE_KEY?.trim() ?? "";
  return c.on && pk.startsWith(`pk_${c.mode}_`) ? pk : null;
}
// Where the customer pays. In the app's window, on the app's own checkout form (the owner's choice,
// 2026-11-27): ui_mode "elements", Stripe's secure card fields placed in it (card details go to Stripe
// only), and the app's own summary, total and Pay button. Stripe's Managed Payments (Stripe as the
// seller, adding sales tax) allows only Stripe's page or its embedded form, so it is off for these
// payments: no sales tax is added (until Stripe Tax is set up, which needs the business's head
// office address in Stripe). Without the publishable key: Stripe's own page, as before.
type Paid = { url: string } | { clientSecret: string; sessionId: string; publishableKey: string };
function surface(inApp: unknown) {
  const back = `${appUrl()}/app?billing=done&session_id={CHECKOUT_SESSION_ID}`;
  return inApp && publishableKey()
    ? { ui_mode: "elements", return_url: back, managed_payments: { enabled: false } }
    : { success_url: back, cancel_url: `${appUrl()}/app?billing=cancelled` };
}
const paidAt = (s: any): Paid => (s.client_secret && !s.url ? { clientSecret: String(s.client_secret), sessionId: String(s.id), publishableKey: publishableKey()! } : { url: String(s.url) });
const appUrl = () => (process.env.APP_URL?.trim() || "https://trade-ai-rust.vercel.app").replace(/\/+$/, "");

// ---------- Stripe's API (form-encoded, over HTTPS) ----------
const API = () => (process.env.STRIPE_API_URL?.trim() || "https://api.stripe.com").replace(/\/+$/, "");
// Pinned, so a change of the account's default API version never changes what these calls get.
const API_VERSION = () => process.env.STRIPE_API_VERSION?.trim() || "2026-11-18.endive";
const TAX_CODE = () => process.env.STRIPE_TAX_CODE?.trim() || "txcd_10103000";
export function formOf(v: unknown, prefix = "", out = new URLSearchParams()): URLSearchParams {
  if (v === undefined || v === null) return out;
  if (Array.isArray(v)) v.forEach((x, i) => formOf(x, `${prefix}[${i}]`, out));
  else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) formOf(x, prefix ? `${prefix}[${k}]` : k, out);
  else out.append(prefix, String(v));
  return out;
}
export class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}
async function stripe<T = any>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const c = billingConfig();
  if (!c.on) throw new Error(c.reason!);
  const qs = method === "GET" && body ? `?${formOf(body).toString()}` : "";
  const r = await fetch(`${API()}/v1${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY!.trim()}`,
      "Stripe-Version": API_VERSION(),
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" && body ? formOf(body).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new StripeError(j?.error?.message ?? `Stripe answered ${r.status}`, r.status, j?.error?.code);
  return j as T;
}

// ---------- Prices (made on first use, from plans.ts) ----------
export type Interval = "month" | "year";
const planKey = (plan: PlanId, interval: Interval) => `trading_rust_${plan}_${interval}`;
const packKey = (id: string) => `trading_rust_${id}`;
const planCents = (plan: PlanId, interval: Interval) => Math.round(PLANS[plan].priceUsd * (interval === "year" ? YEARLY_MONTHS_PAID : 1) * 100);
const priceIds = new Map<string, { id: string; at: number }>();
async function priceFor(lookupKey: string, cents: number, name: string, recurring?: Interval): Promise<string> {
  const hit = priceIds.get(lookupKey);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.id;
  const found = await stripe<{ data: any[] }>("GET", "/prices", { "lookup_keys[]": lookupKey, active: true, limit: 1, "expand[]": "data.product" });
  const p = found.data?.[0];
  let id: string;
  if (p && p.unit_amount === cents && p.currency === "usd" && (p.recurring?.interval ?? null) === (recurring ?? null)) {
    id = p.id;
    // A product made before it had a tax category gets one (Stripe needs it to work out the tax).
    const product = typeof p.product === "object" ? p.product : null;
    if (product?.id && product.tax_code !== TAX_CODE() && (product.tax_code?.id ?? null) !== TAX_CODE()) await stripe("POST", `/products/${encodeURIComponent(product.id)}`, { tax_code: TAX_CODE() });
  } else {
    const made = await stripe("POST", "/prices", {
      currency: "usd", unit_amount: cents, lookup_key: lookupKey, transfer_lookup_key: true,
      ...(recurring ? { recurring: { interval: recurring } } : {}),
      product_data: { name, tax_code: TAX_CODE() },
    }, `price-${lookupKey}-${cents}-${TAX_CODE()}`);
    id = made.id;
  }
  priceIds.set(lookupKey, { id, at: Date.now() });
  return id;
}
const planPrice = (plan: PlanId, interval: Interval) => priceFor(planKey(plan, interval), planCents(plan, interval), `TRADING//RUST ${PLANS[plan].name} (${interval === "year" ? "yearly" : "monthly"})`, interval);
// Which plan and period a Stripe price is (from its lookup key; null = not one of ours).
export function planOfPrice(price: any): { plan: PlanId; interval: Interval } | null {
  const m = /^trading_rust_(starter|pro|max)_(month|year)$/.exec(String(price?.lookup_key ?? ""));
  return m ? { plan: m[1] as PlanId, interval: m[2] as Interval } : null;
}
const rank = (p: PlanId) => PLAN_ORDER.indexOf(p);

// ---------- Records ----------
// What billing knows of an account. applied = the plan billing last gave it (so billing never takes
// away a plan an admin gave); keep = a plan paid for that stays until a date (after a downgrade);
// paid = the last billing period actually paid (its invoice paid): the monthly AI allowance starts
// again only from a paid period (allowance.ts).
export type BillingRecord = {
  customerId?: string; subscriptionId?: string; plan?: PlanId; interval?: Interval; status?: string;
  periodEnd?: number; cancelAtPeriodEnd?: boolean; keep?: { plan: PlanId; until: number }; applied?: PlanId; updatedAt?: number;
  paid?: PaidPeriod;
};
const recKey = billingKey;
const custKey = (id: string) => `billing-customer:${id}`;
async function record(user: string): Promise<BillingRecord> {
  return (await store().kvGet<BillingRecord>(recKey(user))) ?? {};
}
const putRecord = async (user: string, r: BillingRecord) => {
  await store().kvSet(recKey(user), { ...r, updatedAt: Date.now() });
  forgetAllowance(user);
};

async function customer(user: string): Promise<string> {
  const r = await record(user);
  if (r.customerId) return r.customerId;
  const who = await auth.userEmail(user);
  if (!who) throw new Error("Sign in first.");
  const c = await stripe("POST", "/customers", { email: who.email, name: who.name, metadata: { user: user.toLowerCase() } }, `customer-${user.toLowerCase()}`);
  await store().kvSet(custKey(c.id), user.toLowerCase());
  await putRecord(user, { ...(await record(user)), customerId: c.id });
  return c.id;
}
const userOfCustomer = (id: string) => store().kvGet<string>(custKey(id));

// Someone changes plan (to tell the rest of the app: stop agents beyond the new plan, the real
// auto-pilot without auto-pick). Set in index.ts.
let planChanged: (user: string, before: PlanId, after: PlanId) => Promise<unknown> = async () => null;
export function onPlanChanged(fn: typeof planChanged) {
  planChanged = fn;
}

// ---------- Paying ----------
const ACTIVE = new Set(["active", "trialing", "past_due"]); // past_due: Stripe is still retrying the card
function checkPlan(plan: unknown, interval: unknown): { plan: PlanId; interval: Interval } {
  const p = String(plan ?? "") as PlanId, i = String(interval ?? "month") as Interval;
  if (!(p in PLANS) || p === "free") throw new Error("Choose a paid plan.");
  if (i !== "month" && i !== "year") throw new Error("Choose monthly or yearly.");
  return { plan: p, interval: i };
}
async function acceptTerms(user: string, terms: unknown, what: string) {
  if (terms !== TERMS_VERSION) throw new Error("Please read and accept the Subscription Terms first.");
  await audit(user, "billing.terms", `Accepted the Subscription Terms (${TERMS_VERSION}) before ${what}`, { version: TERMS_VERSION });
}
// A new subscription: Stripe's own payment page (the browser goes there).
export async function checkout(user: string, body: any): Promise<Paid | { changed: true; status: Awaited<ReturnType<typeof status>> }> {
  const { plan, interval } = checkPlan(body?.plan, body?.interval);
  const r = await record(user);
  if (r.subscriptionId && r.status && ACTIVE.has(r.status)) return { changed: true, status: await change(user, { plan, interval }) };
  await acceptTerms(user, body?.terms, `subscribing to ${PLANS[plan].name}`);
  const [cust, price] = await Promise.all([customer(user), planPrice(plan, interval)]);
  const s = await stripe("POST", "/checkout/sessions", {
    mode: "subscription", customer: cust, client_reference_id: user.toLowerCase(),
    line_items: [{ price, quantity: 1 }],
    ...surface(body?.embedded),
    metadata: { user: user.toLowerCase(), kind: "plan", plan, interval },
    subscription_data: { metadata: { user: user.toLowerCase(), plan, interval } },
    allow_promotion_codes: true,
  });
  return paidAt(s);
}
// An AI token pack: paid once on Stripe's page; the tokens are added when Stripe says it is paid.
export async function buyPack(user: string, body: any): Promise<Paid> {
  const pack = TOKEN_PACKS.find((k) => k.id === String(body?.pack ?? ""));
  if (!pack) throw new Error("Choose a token pack.");
  await acceptTerms(user, body?.terms, `buying ${pack.tokens.toLocaleString()} AI tokens`);
  const [cust, price] = await Promise.all([customer(user), priceFor(packKey(pack.id), Math.round(pack.priceUsd * 100), `TRADING//RUST ${(pack.tokens / 1e6).toLocaleString()}M AI tokens`)]);
  const s = await stripe("POST", "/checkout/sessions", {
    mode: "payment", customer: cust, client_reference_id: user.toLowerCase(),
    line_items: [{ price, quantity: 1 }],
    ...surface(body?.embedded),
    metadata: { user: user.toLowerCase(), kind: "pack", pack: pack.id, tokens: String(pack.tokens) },
  });
  return paidAt(s);
}
// Another plan or period for a running subscription: up now (Stripe charges the difference), down at
// the end of the period already paid (the plan paid for stays until then).
export async function change(user: string, body: any) {
  const { plan, interval } = checkPlan(body?.plan, body?.interval);
  const r = await record(user);
  if (!r.subscriptionId || !r.status || !ACTIVE.has(r.status)) throw new Error("You have no subscription to change. Choose a plan to subscribe.");
  const sub = await stripe("GET", `/subscriptions/${encodeURIComponent(r.subscriptionId)}`);
  const item = sub.items?.data?.[0];
  const now = planOfPrice(item?.price);
  if (!item || !now) throw new Error("Your subscription could not be read. Try again, or use Manage billing.");
  if (now.plan === plan && now.interval === interval) {
    if (sub.cancel_at_period_end) await stripe("POST", `/subscriptions/${sub.id}`, { cancel_at_period_end: false }); // (choosing it again resumes it)
    return (await sync(sub.id)) ?? status(user);
  }
  const up = rank(plan) > rank(now.plan) || (plan === now.plan && interval === "year");
  const price = await planPrice(plan, interval);
  await stripe("POST", `/subscriptions/${sub.id}`, {
    items: [{ id: item.id, price }],
    proration_behavior: up ? "always_invoice" : "none",
    ...(up ? { payment_behavior: "error_if_incomplete" } : {}),
    cancel_at_period_end: false,
  }, `change-${sub.id}-${plan}-${interval}-${Date.now() >> 16}`);
  if (!up) {
    const until = periodEndOf(sub);
    await putRecord(user, { ...(await record(user)), keep: { plan: (r.keep && r.keep.until > Date.now() && rank(r.keep.plan) > rank(now.plan) ? r.keep.plan : now.plan), until } });
    await audit(user, "billing.event", `Changed to ${PLANS[plan].name} (${interval}ly) from the next renewal; ${PLANS[now.plan].name} stays until ${new Date(until).toISOString().slice(0, 10)}`, { plan, interval, until });
  }
  return (await sync(sub.id)) ?? status(user);
}
export async function cancel(user: string) {
  const r = await record(user);
  if (!r.subscriptionId) throw new Error("You have no subscription.");
  const sub = await stripe("POST", `/subscriptions/${encodeURIComponent(r.subscriptionId)}`, { cancel_at_period_end: true });
  await audit(user, "billing.event", `Cancelled: the plan stays until ${new Date(periodEndOf(sub)).toISOString().slice(0, 10)}, then Free`, {});
  return (await sync(sub.id)) ?? status(user);
}
export async function resume(user: string) {
  const r = await record(user);
  if (!r.subscriptionId) throw new Error("You have no subscription.");
  await stripe("POST", `/subscriptions/${encodeURIComponent(r.subscriptionId)}`, { cancel_at_period_end: false });
  return (await sync(r.subscriptionId)) ?? status(user);
}
// Stripe's billing page: card, invoices, cancel. Its settings are made here once.
export async function portal(user: string): Promise<{ url: string }> {
  const r = await record(user);
  if (!r.customerId) throw new Error("You have no billing yet: choose a plan first.");
  let conf = await store().kvGet<string>("billing-portal-config");
  if (!conf) {
    const c = await stripe("POST", "/billing_portal/configurations", {
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        customer_update: { enabled: true, allowed_updates: ["email", "address"] },
      },
      business_profile: { headline: "TRADING//RUST billing" },
    }, "portal-config-v1");
    conf = String(c.id);
    await store().kvSet("billing-portal-config", conf);
  }
  const s = await stripe("POST", "/billing_portal/sessions", { customer: r.customerId, return_url: `${appUrl()}/app?billing=portal`, configuration: conf });
  return { url: String(s.url) };
}
// Back from Stripe's page: asks Stripe (not the browser) how the payment went, in case its webhook is late.
export async function confirm(user: string, body: any) {
  const id = String(body?.sessionId ?? "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new Error("No payment to check.");
  const s = await stripe("GET", `/checkout/sessions/${encodeURIComponent(id)}`);
  if (String(s.client_reference_id ?? "") !== user.toLowerCase()) throw new Error("That payment is not yours.");
  await handleSession(s);
  // What was paid for, so the app says the right thing (a pack bought on a plan is still a pack).
  const paid = s.mode === "payment" && s.metadata?.kind === "pack" ? { kind: "pack" as const, tokens: TOKEN_PACKS.find((k) => k.id === s.metadata?.pack)?.tokens ?? null } : { kind: "plan" as const };
  return { ...(await status(user)), paid };
}

// ---------- What Stripe says (webhooks) ----------
// Stripe-Signature: t=<unix s>,v1=<hex HMAC-SHA256 of "t.rawBody" with the webhook secret>.
export function verifySignature(raw: Buffer, header: string | undefined, secret: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const parts = String(header ?? "").split(",").map((x) => x.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const v1 = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !v1.length || Math.abs(nowS - t) > 300) return false;
  const want = crypto.createHmac("sha256", secret).update(`${t}.`).update(raw).digest();
  return v1.some((v) => {
    const got = Buffer.from(v, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}
export async function webhook(raw: Buffer, headers: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const c = billingConfig();
  if (!c.on) return { status: 503, body: { error: c.reason } };
  if (!verifySignature(raw, String(headers["stripe-signature"] ?? ""), process.env.STRIPE_WEBHOOK_SECRET!.trim())) return { status: 400, body: { error: "bad signature" } };
  let ev: any;
  try {
    ev = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "not JSON" } };
  }
  const evKey = `billing-event:${ev.id}`;
  if (await store().kvGet(evKey)) return { status: 200, body: { ok: true, repeat: true } };
  const o = ev.data?.object ?? {};
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await handleSession(o);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await sync(o.id);
      break;
    case "invoice.paid":
    case "invoice.payment_failed": {
      const subId = o.subscription ?? o.parent?.subscription_details?.subscription;
      if (subId) await sync(typeof subId === "string" ? subId : subId.id);
      if (ev.type === "invoice.payment_failed") {
        const user = (await userOfCustomer(String(o.customer ?? ""))) ?? null;
        if (user) await audit(user, "billing.event", "A payment did not go through: Stripe will try the card again. Update it under Manage billing.", { invoice: o.id ?? null });
      }
      break;
    }
    default:
      break; // (other events are not needed)
  }
  await store().kvSet(evKey, 1, { ttlMs: 30 * 86_400_000 }); // kept after it was handled: a failed attempt is handled again when Stripe resends it
  return { status: 200, body: { ok: true } };
}
// A finished Checkout: a subscription (read again from Stripe), or a token pack (tokens added once).
async function handleSession(s: any) {
  const user = String(s.client_reference_id ?? s.metadata?.user ?? "") || (await userOfCustomer(String(s.customer ?? "")));
  if (!user) return;
  if (s.customer && !(await userOfCustomer(String(s.customer)))) await store().kvSet(custKey(String(s.customer)), user);
  if (s.mode === "subscription" && s.subscription) return sync(typeof s.subscription === "string" ? s.subscription : s.subscription.id);
  if (s.mode === "payment" && s.metadata?.kind === "pack" && s.payment_status === "paid") {
    const pack = TOKEN_PACKS.find((k) => k.id === s.metadata.pack);
    if (!pack || !(await store().kvSet(`billing-pack:${s.id}`, 1, { nx: true }))) return; // once per payment
    await auth.addTokensFromBilling(user, pack.tokens, `Bought ${pack.tokens.toLocaleString()} AI tokens ($${pack.priceUsd})`);
  }
}
const periodEndOf = (sub: any) => 1000 * Number(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? 0);
const periodStartOf = (sub: any) => 1000 * Number(sub.current_period_start ?? sub.items?.data?.[0]?.current_period_start ?? 0);
// Reads the subscription from Stripe and gives the account the plan it pays for now.
export async function sync(subscriptionId: string) {
  const sub = await stripe("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`, { "expand[]": "latest_invoice" });
  const user = String(sub.metadata?.user ?? "") || (await userOfCustomer(String(sub.customer ?? ""))) || "";
  if (!user) return null;
  const r = await record(user);
  const paid = planOfPrice(sub.items?.data?.[0]?.price);
  const live = ACTIVE.has(String(sub.status));
  const periodEnd = periodEndOf(sub);
  let keep = r.keep && r.keep.until > Date.now() ? r.keep : undefined;
  if (keep && paid && rank(keep.plan) <= rank(paid.plan)) keep = undefined;
  const plan: PlanId = live && paid ? (keep ? keep.plan : paid.plan) : "free";
  const next: BillingRecord = {
    ...r, customerId: String(sub.customer ?? r.customerId ?? ""), subscriptionId: live ? sub.id : sub.id === r.subscriptionId ? undefined : r.subscriptionId,
    plan: paid?.plan, interval: paid?.interval, status: String(sub.status), periodEnd, cancelAtPeriodEnd: !!sub.cancel_at_period_end, keep,
  };
  // The period now running counts as paid only once its invoice is paid (Stripe starts a new period
  // before it charges for it): only then does the AI allowance start again (allowance.ts).
  const invoicePaid = typeof sub.latest_invoice === "object" && sub.latest_invoice?.status === "paid";
  const start = periodStartOf(sub);
  if (String(sub.status) === "active" && invoicePaid && paid && start > 0 && periodEnd > start) next.paid = { start, end: periodEnd, interval: paid.interval };
  // Billing never takes away a plan it did not give: an admin's plan stays when a subscription ends,
  // and a cheaper subscription does not lower a higher plan an admin gave.
  const had = await auth.planOfUser(user);
  const mine = had !== null && had === r.applied;
  if (had !== null && (live ? mine || rank(plan) >= rank(had) : mine)) {
    const why = !live ? `Subscription ended (${sub.status}): Free plan` : keep ? `${PLANS[plan].name} until ${new Date(keep.until).toISOString().slice(0, 10)} (paid for), then ${PLANS[paid!.plan].name}` : `${PLANS[plan].name} (${paid!.interval}ly), paid through Stripe`;
    const ch = await auth.setPlanFromBilling(user, plan, why);
    next.applied = plan;
    if (ch && ch.before !== ch.after) await planChanged(user, ch.before, ch.after).catch((e) => console.error("[billing] after a plan change:", e));
  }
  await putRecord(user, next);
  return status(user);
}

// ---------- What the app shows ----------
export async function status(user: string) {
  const c = billingConfig();
  const r = await record(user);
  return {
    on: c.on, mode: c.mode, reason: c.reason, termsVersion: TERMS_VERSION, publishableKey: publishableKey(),
    plan: (await auth.planOfUser(user)) ?? "free",
    subscription: r.subscriptionId ? { plan: r.plan ?? null, interval: r.interval ?? null, status: r.status ?? null, periodEnd: r.periodEnd ?? null, cancelAtPeriodEnd: !!r.cancelAtPeriodEnd, keep: r.keep && r.keep.until > Date.now() ? r.keep : null } : null,
    canManage: !!r.customerId,
    prices: Object.fromEntries(PLAN_ORDER.filter((p) => PLANS[p].priceUsd > 0).map((p) => [p, { month: planCents(p, "month") / 100, year: planCents(p, "year") / 100, name: planOf(p).name }])),
  };
}
export type BillingStatus = Awaited<ReturnType<typeof status>>;
