// MoonPay: buying crypto with a card or Apple Pay into a customer's own wallet, recorded in the
// customers' transactions table (wallettx.ts). The server's side only: the browser shows the
// app's own screens, with MoonPay's frames for the steps no app may handle itself (typing a card
// number, the bank's card check, the Apple Pay button, the email code).
//
// The one rule: about money, the server believes MoonPay, asked directly, never the browser.
//  - A purchase is started by the server, with the customer's wallet address from the server's
//    own record (startBuy). The browser cannot choose where the crypto goes.
//  - When the browser reports "MoonPay finished, its number is X", the server asks MoonPay for X
//    with the secret key and checks it is this customer's purchase into this customer's wallet
//    before recording it (linkBuy).
//  - MoonPay's messages (webhooks) count only with MoonPay's signature, are saved before they are
//    acknowledged (an unsaved one is refused, so MoonPay sends it again), and the same message
//    twice counts once.
//  - Every minute the server asks MoonPay again about every purchase that is not finished, and
//    looks for purchases the browser never reported (reconcile). A lost message or a closed tab
//    cannot lose a purchase.
//
// Settings (Vercel, never in chat): MOONPAY_SECRET_KEY (sk_test_... or sk_live_...),
// MOONPAY_PUBLISHABLE_KEY (pk_test_... / pk_live_...), MOONPAY_WEBHOOK_KEY (from the Developers
// page). Live keys work only with MOONPAY_LIVE=yes as well, so a live key cannot be used by
// mistake. MOONPAY_MAX_BUY (default 500) caps one purchase in the fiat currency.
import crypto from "node:crypto";
import { createStore } from "./store.js";
import { TX_ID_RE, myTransactions, newTxId, openTransactions, recordUpdate, startTx } from "./wallettx.js";
import type { WalletTx, WalletTxFields, WalletTxStatus, WalletTxUpdate } from "./wallettx-core.js";

const store = () => createStore();
export const PROVIDER = "moonpay";
const API = () => (process.env.MOONPAY_API_URL?.trim() || "https://api.moonpay.com").replace(/\/+$/, "");

// ---------- Settings ----------
export type MoonPayConfig = { on: boolean; mode: "sandbox" | "live" | null; reason: string | null; secretKey: string; publishableKey: string; webhookKey: string };
export function config(): MoonPayConfig {
  const secretKey = process.env.MOONPAY_SECRET_KEY?.trim() ?? "", publishableKey = process.env.MOONPAY_PUBLISHABLE_KEY?.trim() ?? "", webhookKey = process.env.MOONPAY_WEBHOOK_KEY?.trim() ?? "";
  const off = (reason: string): MoonPayConfig => ({ on: false, mode: null, reason, secretKey: "", publishableKey: "", webhookKey: "" });
  if (!secretKey && !publishableKey) return off("MoonPay is not set up (no keys).");
  const mode = secretKey.startsWith("sk_test_") ? "sandbox" : secretKey.startsWith("sk_live_") ? "live" : null;
  if (!mode) return off("MOONPAY_SECRET_KEY must be MoonPay's secret key (sk_test_... or sk_live_...).");
  const pk = mode === "sandbox" ? "pk_test_" : "pk_live_";
  if (!publishableKey.startsWith(pk)) return off(`MOONPAY_PUBLISHABLE_KEY must be the ${mode} publishable key (${pk}...), the same mode as the secret key.`);
  if (/^wk_(test|live)_/.test(webhookKey) && !webhookKey.startsWith(mode === "sandbox" ? "wk_test_" : "wk_live_")) return off("MOONPAY_WEBHOOK_KEY is for the other mode than the secret key.");
  if (mode === "live" && process.env.MOONPAY_LIVE?.trim().toLowerCase() !== "yes") return off("Live MoonPay keys are set, but MOONPAY_LIVE=yes is not: real payments stay off until it is.");
  return { on: true, mode, reason: null, secretKey, publishableKey, webhookKey };
}
// For the status page and the app: never a key, only whether it is on and why not.
export const publicStatus = () => {
  const c = config();
  return { on: c.on, mode: c.mode, reason: c.reason, webhooks: c.on && !!c.webhookKey, publishableKey: c.on ? c.publishableKey : null };
};
export const maxBuy = () => (Number(process.env.MOONPAY_MAX_BUY) > 0 ? Number(process.env.MOONPAY_MAX_BUY) : 500);

// ---------- Webhook signatures ----------
// Moonpay-Signature-V2: "t=<unix seconds>,s=<hex>", s = HMAC-SHA256 of "<t>.<raw body>" with the
// webhook key. Checked on the raw bytes, compared in constant time.
export function verifySignature(rawBody: Buffer | string, header: string | undefined | null, key: string): { ok: boolean; t: number | null; why?: string } {
  if (!key) return { ok: false, t: null, why: "no webhook key set" };
  if (!header) return { ok: false, t: null, why: "no Moonpay-Signature-V2 header" };
  const parts = Object.fromEntries(header.split(",").map((p) => { const i = p.indexOf("="); return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : [p.trim(), ""]; }));
  const t = Number(parts.t), s = String(parts.s ?? "");
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/i.test(s)) return { ok: false, t: null, why: "malformed signature header" };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const want = crypto.createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${parts.t}.`, "utf8"), body])).digest();
  const got = Buffer.from(s, "hex");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, t, why: "signature does not match" };
  // (No tight time window: a replayed message changes nothing, because the server asks MoonPay
  // for the transaction itself and the same message counts once. Only a time far ahead is refused.)
  if (t * 1000 > Date.now() + 10 * 60_000) return { ok: false, t, why: "signed in the future" };
  return { ok: true, t };
}

// ---------- MoonPay's API (secret key) ----------
class MoonPayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const c = config();
  if (!c.on) throw new Error(c.reason ?? "MoonPay is off.");
  const res = await fetch(`${API()}${path}`, {
    method,
    headers: { "X-Api-Key": c.secretKey, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text)?.message ?? msg; } catch { /* not JSON */ }
    throw new MoonPayError(`MoonPay ${res.status}: ${msg || res.statusText}${res.status === 404 && /\/platform\//.test(path) ? " (if this is a whole feature, MoonPay may not have switched it on for the account yet)" : ""}`, res.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}
const MP_ID_RE = /^[A-Za-z0-9_-]{3,80}$/; // (only letters, digits, - and _: it goes into a URL path)
export async function fetchTransaction(id: string): Promise<any> {
  if (!MP_ID_RE.test(id)) throw new Error("Not a MoonPay transaction id.");
  return api<any>("GET", `/platform/v1/transactions/${encodeURIComponent(id)}`);
}
// A customer's purchases (as MoonPay knows them) since a time, oldest pages first, at most `max`.
export async function fetchCustomerTransactions(externalCustomerId: string, sinceMs: number, max = 100): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ externalCustomerId, startDate: new Date(sinceMs).toISOString(), limit: "50", ...(cursor ? { cursor } : {}) });
    const page: any = await api<any>("GET", `/platform/v1/transactions?${q}`);
    out.push(...(Array.isArray(page?.data) ? page.data : Array.isArray(page?.transactions) ? page.transactions : Array.isArray(page) ? page : []));
    cursor = page?.pageInfo?.nextCursor ?? null;
  } while (cursor && out.length < max);
  return out.slice(0, max);
}

// ---------- MoonPay's records -> ours ----------
// Platform statuses: pending, completed, failed. The older widget wording (webhooks) also uses
// waitingPayment and waitingAuthorization, which are "pending" here.
export function statusOf(s: unknown): WalletTxStatus {
  const v = String(s ?? "").toLowerCase();
  if (v === "completed") return "completed";
  if (v === "failed") return "failed";
  if (v === "cancelled" || v === "canceled") return "cancelled";
  if (v === "refunded") return "refunded";
  return "pending";
}
const amt = (v: any) => (v === null || v === undefined ? undefined : typeof v === "object" ? (v.amount ?? undefined) : v);
const code = (v: any) => (v === null || v === undefined ? undefined : typeof v === "string" ? v : (v.code ?? v.asset?.code ?? v.currencyCode ?? undefined));
const networkOf = (c: string | undefined) => {
  const u = (c ?? "").toUpperCase();
  return u === "SOL" || u.endsWith("_SOL") ? "solana" : u === "ETH" || u.endsWith("_ETH") ? "ethereum" : u.endsWith("_BASE") ? "base" : u === "BTC" ? "bitcoin" : undefined;
};
// A transaction as MoonPay's API gives it (or as a webhook carries it), as our fields.
export function fromMoonPay(t: any): { providerId: string; status: WalletTxStatus; providerStatus: string; providerAt: number | null; externalTransactionId: string | null; externalCustomerId: string | null; customerId: string | null; fields: WalletTxFields } {
  const crypto = code(t?.destination?.asset) ?? code(t?.currency) ?? t?.currencyCode;
  const fiat = code(t?.source?.asset) ?? code(t?.baseCurrency) ?? t?.baseCurrencyCode;
  const failed = Array.isArray(t?.stages) ? t.stages.find((s: any) => s?.status === "failed")?.failureReason : undefined;
  const at = Date.parse(String(t?.updatedAt ?? ""));
  return {
    providerId: String(t?.id ?? ""),
    status: statusOf(t?.status),
    providerStatus: String(t?.status ?? ""),
    providerAt: Number.isFinite(at) ? at : null,
    externalTransactionId: t?.externalTransactionId ?? null,
    externalCustomerId: t?.externalCustomerId ?? null,
    customerId: t?.customer?.id ?? t?.customerId ?? null,
    fields: {
      fiatCurrency: fiat ? String(fiat).toLowerCase() : undefined,
      fiatAmount: amt(t?.source) ?? t?.baseCurrencyAmount,
      cryptoCurrency: crypto ? String(crypto).toLowerCase() : undefined,
      network: networkOf(crypto) ?? t?.currency?.metadata?.networkCode ?? undefined,
      cryptoAmount: amt(t?.destination) ?? t?.quoteCurrencyAmount,
      feeAmount: amt(t?.fees?.moonpay) ?? t?.feeAmount,
      networkFeeAmount: amt(t?.fees?.network) ?? t?.networkFeeAmount,
      extraFeeAmount: amt(t?.fees?.ecosystem) ?? amt(t?.fees?.partner) ?? t?.extraFeeAmount,
      walletAddress: t?.wallet?.address ?? t?.walletAddress ?? undefined,
      txHash: t?.transactionHash ?? t?.cryptoTransactionId ?? undefined,
      failureReason: failed ?? t?.failureReason ?? undefined,
      detail: t,
    },
  };
}

// ---------- The customer at MoonPay ----------
// MoonPay knows a customer by an id of ours that says nothing about them (not the username).
type CustomerRec = { ext: string; at: number };
export async function customerRef(key: string): Promise<string> {
  const k = `moonpay-customer:${key}`;
  const had = await store().kvGet<CustomerRec>(k);
  if (had?.ext) return had.ext;
  const ext = `cus_${crypto.randomBytes(12).toString("hex")}`;
  if (await store().kvSet(k, { ext, at: Date.now() } satisfies CustomerRec, { nx: true })) await store().kvSet(`moonpay-ext:${ext}`, key);
  return (await store().kvGet<CustomerRec>(k))!.ext; // (another request may have made it first: theirs counts)
}
const customerOf = async (ext: string | null | undefined) => (ext && /^cus_[0-9a-f]{24}$/.test(ext) ? store().kvGet<string>(`moonpay-ext:${ext}`) : null);

// The customer's wallet the app buys into (kept by the server: see wallets in phase 1's next step).
type WalletRec = { address: string; chain: "solana"; via: string; at: number };
export async function customerWallet(key: string): Promise<WalletRec | null> {
  return store().kvGet<WalletRec>(`moonpay-wallet:${key}`);
}

// ---------- Buying ----------
const FIATS = ["usd", "eur", "gbp", "cad", "aud"];
const ASSETS: Record<string, { network: string }> = { sol: { network: "solana" }, usdc_sol: { network: "solana" } };
// The customer confirmed an amount on the app's buy screen: the purchase is started, with the
// wallet from the server's own record. Returns our id, which the browser hands to MoonPay's
// frame as externalTransactionId.
export async function startBuy(key: string, body: any): Promise<{ id: string; walletAddress: string; asset: string; fiatCurrency: string; fiatAmount: number; customerRef: string }> {
  const c = config();
  if (!c.on) throw new Error(c.reason ?? "MoonPay is off.");
  const fiatCurrency = String(body?.fiatCurrency ?? "").toLowerCase();
  const asset = String(body?.asset ?? "").toLowerCase();
  const fiatAmount = Math.round(Number(body?.fiatAmount) * 100) / 100;
  if (!FIATS.includes(fiatCurrency)) throw new Error("Choose a currency to pay in.");
  if (!ASSETS[asset]) throw new Error("Choose a coin to buy.");
  if (!(fiatAmount >= 20)) throw new Error("The smallest purchase is 20.");
  if (fiatAmount > maxBuy()) throw new Error(`The largest purchase is ${maxBuy()} at a time.`);
  const wallet = await customerWallet(key);
  if (!wallet?.address) throw new Error("Your wallet is not set up yet.");
  // No more than 10 purchases started per customer in an hour (a stuck screen or a script cannot flood the table).
  const recent = await myTransactions(key, null, 20);
  if (recent.filter((t) => t.kind === "buy" && Date.now() - t.createdAt < 3_600_000).length >= 10) throw new Error("Too many purchases started in the last hour. Try again later.");
  const ref = await customerRef(key);
  const tx = await startTx(key, PROVIDER, "buy", { fiatCurrency, fiatAmount, cryptoCurrency: asset, network: ASSETS[asset].network, walletAddress: wallet.address, detail: { customerRef: ref, mode: c.mode } });
  return { id: tx.id, walletAddress: wallet.address, asset, fiatCurrency, fiatAmount, customerRef: ref };
}

// The browser reports that MoonPay's frame finished purchase `id` (ours) as MoonPay transaction
// `transactionId`. Nothing is taken from the browser but those two numbers. The server asks
// MoonPay for the customer's purchases (MoonPay lists only those made under this customer's
// reference) and records the transaction only if it is on that list, pays into this customer's
// wallet, and was made after the purchase was started.
export async function linkBuy(key: string, id: string, transactionId: string) {
  if (!TX_ID_RE.test(id) || !MP_ID_RE.test(String(transactionId ?? ""))) throw new Error("Unknown purchase.");
  const mine = (await myTransactions(key, null, 200)).find((t) => t.id === id);
  if (!mine || mine.kind !== "buy" || mine.provider !== PROVIDER) throw new Error("Unknown purchase.");
  if (mine.providerId) {
    if (mine.providerId !== transactionId) throw new Error("That purchase is already linked to another MoonPay transaction.");
    return recheck(id, transactionId, key);
  }
  const ref = await customerRef(key);
  const listed = (await fetchCustomerTransactions(ref, mine.createdAt - 5 * 60_000)).some((t) => String(t?.id) === transactionId);
  if (!listed) throw new Error("MoonPay does not list that transaction under this customer (yet). It will be picked up by itself if it is theirs.");
  const m = fromMoonPay(await fetchTransaction(transactionId));
  const problem = checkTheirs(m, { wallet: mine.walletAddress, startedAt: mine.createdAt, ref });
  if (problem) throw new Error(`MoonPay's transaction does not match this purchase: ${problem}.`);
  return recordUpdate(updateFrom(m, { id, key, source: "check" }));
}
const createdOf = (m: ReturnType<typeof fromMoonPay>) => Date.parse(String((m.fields.detail as any)?.createdAt ?? "")) || m.providerAt || 0;
function checkTheirs(m: ReturnType<typeof fromMoonPay>, want: { wallet: string | null; startedAt: number; ref: string }): string | null {
  if (!m.providerId) return "it has no id";
  if (!m.fields.walletAddress) return "it names no wallet";
  if (want.wallet && m.fields.walletAddress !== want.wallet) return "it pays into another wallet";
  if (m.externalCustomerId && m.externalCustomerId !== want.ref) return "it belongs to another customer";
  if (createdOf(m) && createdOf(m) < want.startedAt - 5 * 60_000) return "it was made before this purchase was started";
  return null;
}
const updateFrom = (m: ReturnType<typeof fromMoonPay>, o: { id?: string | null; key?: string | null; source: WalletTxUpdate["source"]; eventId?: string | null; eventType?: string | null; payload?: unknown; flag?: string }): WalletTxUpdate => ({
  provider: PROVIDER, id: o.id ?? null, providerId: m.providerId, key: o.key ?? null, status: m.status, providerStatus: m.providerStatus, providerAt: m.providerAt,
  fields: { ...m.fields, kind: "buy", ...(o.flag ? { flag: o.flag } : {}) }, source: o.source, eventId: o.eventId ?? (o.source === "check" ? `check:${m.providerId}:${m.providerStatus}:${m.providerAt ?? "-"}` : null), eventType: o.eventType ?? null,
  payload: o.payload ?? (o.source === "check" ? { asked: true } : undefined),
});

// ---------- Webhooks ----------
// One message from MoonPay, already read as raw bytes. Returns the HTTP status to answer with:
// 200 = saved (also a repeat, or something that is not about a purchase); 400 = not MoonPay's
// (bad or missing signature); 503 = not set up, or could not be saved (MoonPay sends it again).
// after = work to finish after answering (asking MoonPay for the transaction itself).
export async function webhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ status: number; body: unknown; after?: () => Promise<unknown> }> {
  const c = config();
  if (!c.on || !c.webhookKey) return { status: 503, body: { error: "MoonPay webhooks are not set up." } };
  const h = (n: string) => { const v = headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
  const sig = verifySignature(raw, h("moonpay-signature-v2"), c.webhookKey);
  if (!sig.ok) return { status: 400, body: { error: `Not accepted: ${sig.why}.` } };
  let msg: any;
  try {
    msg = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "Not JSON." } };
  }
  const type = String(msg?.type ?? "");
  const data = msg?.data ?? {};
  if (!/^transaction_(created|updated|failed)$/.test(type) || !data?.id) return { status: 200, body: { ok: true, ignored: type || "unknown" } }; // (sells and identity checks come in a later phase)
  const m = fromMoonPay({ ...data, externalCustomerId: data.externalCustomerId ?? msg.externalCustomerId });
  const key = await customerOf(m.externalCustomerId);
  const ours = m.externalTransactionId && TX_ID_RE.test(m.externalTransactionId) ? m.externalTransactionId : null;
  const eventId = h("webhook-id") ?? `${type}:${m.providerId}:${data.updatedAt ?? ""}`;
  // A signed message is MoonPay's own word: it is recorded as it is (the rules keep old news from
  // overwriting new), then MoonPay is asked for the transaction itself, after answering.
  // (Only a purchase of ours, named by our id, may be made from the message itself; one the app
  // has not linked yet is matched up by syncCustomer, which compares it with the purchases started.)
  const u = updateFrom(m, { id: ours, key, source: "webhook", eventId, eventType: type, payload: msg });
  if (!ours) u.fields = { ...u.fields, kind: undefined };
  const r = await recordUpdate(u);
  const id = r.tx?.id ?? null;
  const after = r.duplicate ? undefined
    : id ? () => recheck(id, m.providerId, r.tx!.key).catch((e) => console.error("[moonpay] re-check after a message:", e?.message ?? e))
    : key ? () => syncCustomer(key, (m.providerAt ?? Date.now()) - 3_600_000).catch((e) => console.error("[moonpay] matching a message:", e?.message ?? e))
    : undefined;
  return { status: 200, body: { ok: true, duplicate: r.duplicate }, after };
}
async function recheck(id: string, providerId: string, key: string) {
  const m = fromMoonPay(await fetchTransaction(providerId));
  return recordUpdate(updateFrom(m, { id, key, source: "check" }));
}

// ---------- Asking MoonPay again ----------
// One customer's purchases as MoonPay lists them (made under the customer's reference since
// `sinceMs`), set against the app's records: each known one brought up to date; one the browser
// never reported linked to the purchase the customer started (MoonPay names our id, or: same
// wallet, made after it was started); anything else recorded as a purchase of its own, flagged
// when it went into another wallet than the customer's.
type Tally = { checked: number; linked: number; expired: number; found: number; errors: number };
export async function syncCustomer(key: string, sinceMs: number, out: Tally = { checked: 0, linked: 0, expired: 0, found: 0, errors: 0 }) {
  const ref = await customerRef(key);
  const wallet = (await customerWallet(key))?.address ?? null;
  const theirs = (await fetchCustomerTransactions(ref, sinceMs)).map(fromMoonPay).filter((m) => m.providerId && (!m.externalCustomerId || m.externalCustomerId === ref)).sort((a, b) => createdOf(a) - createdOf(b));
  const mine = await myTransactions(key, null, 200);
  const waiting = mine.filter((t) => t.provider === PROVIDER && t.kind === "buy" && !t.providerId && !t.final).sort((a, b) => a.createdAt - b.createdAt);
  for (const m of theirs) {
    const known = mine.find((t) => t.provider === PROVIDER && t.providerId === m.providerId);
    if (known) {
      await recordUpdate(updateFrom(m, { id: known.id, key, source: "check" }));
      out.checked++;
      continue;
    }
    const byRef = m.externalTransactionId ? waiting.find((t) => t.id === m.externalTransactionId) : undefined;
    const match = byRef ?? waiting.find((t) => !checkTheirs(m, { wallet: t.walletAddress, startedAt: t.createdAt, ref }));
    if (match) {
      await recordUpdate(updateFrom(m, { id: match.id, key, source: "check", eventId: `link:${m.providerId}` }));
      waiting.splice(waiting.indexOf(match), 1);
      out.linked++;
    } else {
      const flag = wallet && m.fields.walletAddress !== wallet ? `bought at MoonPay into ${m.fields.walletAddress ?? "no wallet"}, not the customer's wallet in the app` : undefined;
      await recordUpdate(updateFrom(m, { id: newTxId(), key, source: "check", eventId: `found:${m.providerId}`, flag }));
      out.found++;
    }
  }
  return out;
}

// Every purchase that is not finished is asked about again (each at most once a minute: a check
// that hears nothing new is the same message and counts once), purchases the browser never
// reported are looked for by the customer's reference, and a purchase that never reached MoonPay
// is closed as "expired" after a day. One server copy at a time; stops at `budgetMs`.
export const EXPIRE_STARTED_MS = 24 * 3_600_000;
export async function reconcile(budgetMs = 15_000): Promise<Tally> {
  const out: Tally = { checked: 0, linked: 0, expired: 0, found: 0, errors: 0 };
  if (!config().on) return out;
  const s = store();
  if (!(await s.lock("moonpay-reconcile", budgetMs + 15_000))) return out; // another server copy is at it
  const end = Date.now() + budgetMs;
  try {
    const open = await openTransactions(PROVIDER, 60_000, 25);
    const unlinked = new Map<string, WalletTx[]>();
    for (const tx of open) {
      if (Date.now() > end) break;
      try {
        if (tx.providerId) {
          await recheck(tx.id, tx.providerId, tx.key);
          out.checked++;
        } else if (Date.now() - tx.createdAt > EXPIRE_STARTED_MS) {
          await recordUpdate({ provider: PROVIDER, id: tx.id, key: tx.key, status: "expired", providerStatus: null, providerAt: null, source: "check", eventId: `expire:${tx.id}`, eventType: "expired", payload: { reason: "never reached MoonPay within a day" }, fields: { failureReason: "The payment was never completed at MoonPay." } });
          out.expired++;
        } else if (Date.now() - tx.createdAt > 2 * 60_000) {
          unlinked.set(tx.key, [...(unlinked.get(tx.key) ?? []), tx]);
        }
      } catch (e: any) {
        out.errors++;
        console.error("[moonpay] re-check:", e?.message ?? e);
      }
    }
    for (const [key, txs] of unlinked) {
      if (Date.now() > end) break;
      try {
        await syncCustomer(key, Math.min(...txs.map((t) => t.createdAt)) - 5 * 60_000, out);
      } catch (e: any) {
        out.errors++;
        console.error("[moonpay] looking for unreported purchases:", e?.message ?? e);
      }
    }
  } finally {
    await s.unlock("moonpay-reconcile").catch(() => {});
  }
  return out;
}
