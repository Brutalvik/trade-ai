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
  return { on: c.on, mode: c.mode, reason: c.reason, webhooks: c.on && !!c.webhookKey, publishableKey: c.on ? c.publishableKey : null, minBuy: MIN_BUY, maxBuy: maxBuy() };
};
export const MIN_BUY = 20;
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
    throw new MoonPayError(`MoonPay ${res.status}: ${msg || res.statusText}${res.status === 404 && /^\/platform\/v1\/[a-z-]+(\?|$)/.test(path) ? " (MoonPay may not have switched this feature on for the account yet)" : ""}`, res.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}
const MP_ID_RE = /^[A-Za-z0-9_-]{3,80}$/; // (only letters, digits, - and _: it goes into a URL path)
export async function fetchTransaction(id: string): Promise<any> {
  if (!MP_ID_RE.test(id)) throw new Error("Not a MoonPay transaction id.");
  return api<any>("GET", `/platform/v1/transactions/${encodeURIComponent(id)}`);
}
// A purchase made in MoonPay's own window is MoonPay's older ("widget") API's. Its lists (filtered
// by our reference or the customer's) are server-to-server calls with the secret key in the
// Authorization header; one purchase by MoonPay's own number is a public call with the publishable
// key (the secret key is refused there, seen 26 Nov 2026). Both answers come from MoonPay itself.
async function classic<T>(path: string, how: "secret" | "public" = "secret"): Promise<T> {
  const c = config();
  if (!c.on) throw new Error(c.reason ?? "MoonPay is off.");
  const url = how === "public" ? `${API()}${path}${path.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(c.publishableKey)}` : `${API()}${path}`;
  const res = await fetch(url, { headers: { ...(how === "secret" ? { Authorization: `Api-Key ${c.secretKey}` } : {}), Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text)?.message ?? msg; } catch { /* not JSON */ }
    throw new MoonPayError(`MoonPay ${res.status}: ${msg || res.statusText}`, res.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}
export async function fetchAny(id: string): Promise<any> {
  try {
    return await fetchTransaction(id);
  } catch (e) {
    if (!(e instanceof MoonPayError && e.status === 404)) throw e;
    return classic<any>(`/v1/transactions/${encodeURIComponent(id)}`, "public");
  }
}
// MoonPay's purchases that carry our reference (externalTransactionId): from our own signed link
// only. Asked with the secret key through the list filtered by our reference (the look-up at
// /v1/transactions/ext/{id} refuses the secret key, seen 26 Nov 2026).
export async function fetchByOurId(ourId: string): Promise<any[]> {
  if (!TX_ID_RE.test(ourId)) return [];
  const r = await classic<any>(`/v1/transactions?externalTransactionId=${encodeURIComponent(ourId)}`);
  return Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [];
}
// A customer's purchases (as MoonPay knows them) since a time, oldest pages first, at most `max`.
// MoonPay answers "not found" (404) for a customer it has never seen, which is every customer
// before their first purchase (seen in the sandbox on 26 Nov 2026): that is "no purchases", but
// only once the list itself is known to work (asked without a customer, at most every 10
// minutes), so a list that is down or switched off is never mistaken for an empty one.
let listWorksAt = 0;
async function listWorks() {
  if (Date.now() - listWorksAt < 10 * 60_000) return true;
  await api<any>("GET", "/platform/v1/transactions?limit=1"); // throws if it does not work
  listWorksAt = Date.now();
  return true;
}
export async function fetchCustomerTransactions(externalCustomerId: string, sinceMs: number, max = 100): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ externalCustomerId, startDate: new Date(sinceMs).toISOString(), limit: "50", ...(cursor ? { cursor } : {}) });
    const page: any = await api<any>("GET", `/platform/v1/transactions?${q}`).catch(async (e) => {
      if (e instanceof MoonPayError && e.status === 404 && !cursor && (await listWorks())) return { data: [], pageInfo: { nextCursor: null } };
      throw e;
    });
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
type WalletRec = { address: string; chain: string; via: string; at: number };
export async function customerWallet(key: string): Promise<WalletRec | null> {
  return store().kvGet<WalletRec>(`moonpay-wallet:${key}`);
}

// ---------- MoonPay's buying session (its "Platform": the app's own screens with MoonPay's frames) ----------
// One per visit to the buy screen, used once by MoonPay's browser kit. MoonPay knows the customer
// by our reference and checks the device's IP address across its frames.
export const BUYING_OFF = "MoonPay has not switched on buying in your own screens for this account yet.";
export async function createSession(key: string, email: string, deviceIp: string | undefined): Promise<{ sessionToken: string }> {
  const c = config();
  if (!c.on) throw new Error(c.reason ?? "MoonPay is off.");
  const ip = String(deviceIp ?? "").trim();
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw new Error("Your connection's address could not be read; reload the page and try again.");
  const ref = await customerRef(key);
  let r: any;
  try {
    r = await api<any>("POST", "/platform/v1/sessions", { deviceIp: ip, externalCustomerId: ref, ...(email ? { email } : {}) });
  } catch (e) {
    if (e instanceof MoonPayError && e.status === 404) throw new Error(BUYING_OFF);
    throw e;
  }
  if (!r?.sessionToken) throw new Error("MoonPay did not start a session.");
  return { sessionToken: String(r.sessionToken) };
}

// ---------- Buying ----------
const FIATS = ["usd", "eur", "gbp", "cad", "aud"];
// What can be bought, on which network (MoonPay's network code), into which of the customer's four
// wallets. MoonPay's own list decides which of these are offered (buyOptions).
type WalletKind = "solana" | "ethereum" | "bitcoin" | "tron";
const ASSETS: Record<string, { network: string; wallet: WalletKind; label: string }> = {
  sol: { network: "solana", wallet: "solana", label: "SOL (Solana)" },
  usdc_sol: { network: "solana", wallet: "solana", label: "USDC on Solana" },
  eth: { network: "ethereum", wallet: "ethereum", label: "ETH (Ethereum)" },
  usdc: { network: "ethereum", wallet: "ethereum", label: "USDC on Ethereum" },
  usdt: { network: "ethereum", wallet: "ethereum", label: "USDT on Ethereum" },
  bnb_bsc: { network: "binance_smart_chain", wallet: "ethereum", label: "BNB (BNB Chain)" },
  usdt_bsc: { network: "binance_smart_chain", wallet: "ethereum", label: "USDT on BNB Chain" },
  eth_base: { network: "base", wallet: "ethereum", label: "ETH on Base" },
  usdc_base: { network: "base", wallet: "ethereum", label: "USDC on Base" },
  pol_polygon: { network: "polygon", wallet: "ethereum", label: "POL (Polygon)" },
  eth_arbitrum: { network: "arbitrum", wallet: "ethereum", label: "ETH on Arbitrum" },
  eth_optimism: { network: "optimism", wallet: "ethereum", label: "ETH on Optimism" },
  avax_cchain: { network: "avalanche_c_chain", wallet: "ethereum", label: "AVAX (Avalanche)" },
  btc: { network: "bitcoin", wallet: "bitcoin", label: "BTC (Bitcoin)" },
  trx: { network: "tron", wallet: "tron", label: "TRX (Tron)" },
  usdt_trx: { network: "tron", wallet: "tron", label: "USDT on Tron" },
};
// In test mode MoonPay pays test coins on test networks; only those the wallet window can show are
// offered (SOL on Solana's devnet, ETH on Sepolia). Test Bitcoin needs a test-network address.
const SANDBOX_COINS = new Set(["sol", "usdc_sol", "eth"]);
// The customer's wallet of a kind (moonwallet.ts keeps them: the Solana one under moonpay-wallet:<key>).
async function walletOf(key: string, kind: WalletKind): Promise<WalletRec | null> {
  if (kind === "solana") return customerWallet(key);
  return store().kvGet<WalletRec>(`moonpay-wallet-${kind}:${key}`);
}
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
  if (!(fiatAmount >= MIN_BUY)) throw new Error(`The smallest purchase is ${MIN_BUY}.`);
  if (fiatAmount > maxBuy()) throw new Error(`The largest purchase is ${maxBuy()} at a time.`);
  const wallet = await walletOf(key, ASSETS[asset].wallet);
  if (!wallet?.address) throw new Error("Your wallet is not set up yet.");
  // No more than 10 purchases started per customer in an hour (a stuck screen or a script cannot flood the table).
  const recent = await myTransactions(key, null, 20);
  if (recent.filter((t) => t.kind === "buy" && Date.now() - t.createdAt < 3_600_000).length >= 10) throw new Error("Too many purchases started in the last hour. Try again later.");
  const ref = await customerRef(key);
  const tx = await startTx(key, PROVIDER, "buy", { fiatCurrency, fiatAmount, cryptoCurrency: asset, network: ASSETS[asset].network, walletAddress: wallet.address, detail: { customerRef: ref, mode: c.mode } });
  return { id: tx.id, walletAddress: wallet.address, asset, fiatCurrency, fiatAmount, customerRef: ref };
}

// ---------- MoonPay's own payment window ("widget"), shown in the app's modal ----------
// Until MoonPay switches its Platform on for the account, a purchase is paid in MoonPay's own
// window. The server builds the whole link (amount, coin, wallet, our references) and signs it
// with the secret key, so nothing in it can be changed in the browser: MoonPay refuses a link
// whose signature does not match. The amount is locked. The link is also tied to the customer's
// internet address (allowedIpAddress): MoonPay requires it to go live, and this account enforces
// it in sandbox too (seen 26 Nov 2026: its check answers "Missing allowedIpAddress on signed URL").
// What can be bought and paid with comes from MoonPay's own list (kept an hour).
let listCache: { at: number; list: any[] } | null = null;
async function moonpayCurrencies(): Promise<any[]> {
  if (listCache && Date.now() - listCache.at < 3_600_000) return listCache.list;
  const r = await fetch(`${API()}/v3/currencies?apiKey=${encodeURIComponent(config().publishableKey)}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`MoonPay's list of currencies: HTTP ${r.status}`);
  const list = await r.json();
  listCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
  return listCache.list;
}
export async function buyOptions(): Promise<{ coins: { id: string; label: string; wallet: WalletKind }[]; fiats: { code: string; min: number; max: number }[] }> {
  const c = config();
  if (!c.on) return { coins: [], fiats: [] };
  const list = await moonpayCurrencies();
  const coins = Object.keys(ASSETS).filter((code) => {
    const x = list.find((y) => y?.code === code && y?.type === "crypto");
    return x && !x.isSuspended && (c.mode === "live" || (x.supportsTestMode && SANDBOX_COINS.has(code)));
  }).map((id) => ({ id, label: ASSETS[id].label, wallet: ASSETS[id].wallet }));
  const fiats = FIATS.map((code) => list.find((y) => y?.code === code && y?.type === "fiat")).filter(Boolean)
    .map((x: any) => ({ code: String(x.code), min: Math.max(MIN_BUY, Math.ceil(Number(x.minBuyAmount) || 0)), max: Math.min(maxBuy(), Math.floor(Number(x.maxBuyAmount) || maxBuy())) }))
    .filter((f) => f.min <= f.max);
  return { coins, fiats };
}
// The address MoonPay sees: IPv4 as dotted quads, IPv6 in its short lowercase form, IPv4-in-IPv6 unwrapped.
export function canonicalIp(ip: string): string {
  let v = String(ip ?? "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(v)) v = v.slice(7);
  if (v.includes(":")) {
    try { v = new URL(`http://[${v}]/`).hostname.replace(/^\[|\]$/g, ""); } catch { /* left as it is */ }
  }
  return v.toLowerCase();
}
// Loopback and private addresses are what a server on the customer's own machine sees (local
// testing): then the address MoonPay sees is asked of MoonPay itself (server and browser are the
// same machine). On Vercel the customer's public address is always there.
const isPrivateIp = (ip: string) => !ip || ip === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);
// A public address the customer's browser reports as the one MoonPay sees from it (MoonPay's own
// /v4/ip_address, asked from the page). It is the address MoonPay's window checks the link
// against, and it can differ from the one this server sees: the app is reached over IPv4 only, and
// MoonPay over IPv6 when the customer has it (seen 27 Nov 2026: "IP address mismatch on signed
// URL", shown as "Unverified connection"). Anything that is not a public IPv4 or IPv6 address is
// ignored. (A wrong one only spoils the customer's own link, into their own wallet.)
export function reportedPublicIp(v: unknown): string | null {
  const ip = canonicalIp(String(v ?? "").slice(0, 64));
  if (!ip || isPrivateIp(ip)) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split(".").every((o) => Number(o) <= 255) ? ip : null;
  return /^[0-9a-f:.]+$/.test(ip) && ip.includes(":") ? ip : null;
}
async function publicIpFor(observed: string | undefined): Promise<string> {
  const ip = canonicalIp(observed ?? "");
  if (!isPrivateIp(ip)) return ip;
  const r = await fetch(`${API()}/v4/ip_address?apiKey=${encodeURIComponent(config().publishableKey)}`, { signal: AbortSignal.timeout(10_000) });
  const j: any = await r.json().catch(() => ({}));
  const seen = canonicalIp(String(j?.ipAddress ?? ""));
  if (!seen) throw new Error("Your connection's address could not be read; reload the page and try again.");
  return seen;
}
const WIDGET = (mode: string | null) => (mode === "live" ? "https://buy.moonpay.com" : "https://buy-sandbox.moonpay.com");
const PAY_WITH: Record<string, string> = { card: "credit_debit_card", apple_pay: "apple_pay", google_pay: "google_pay" };
// Where a purchase goes: only ever the customer's MoonPay wallet of the coin's kind on file
// (sandbox and live alike).
async function buyInto(key: string, _user?: unknown, kind: WalletKind = "solana"): Promise<{ address: string; which: "moonpay" } | null> {
  const w = await walletOf(key, kind);
  return w?.address ? { address: w.address, which: "moonpay" } : null;
}
export { buyInto as buyDestination };
async function checkRate(key: string) {
  // No more than 10 purchases started per customer in an hour (a stuck screen or a script cannot flood the table).
  const recent = await myTransactions(key, null, 20);
  if (recent.filter((t) => t.kind === "buy" && Date.now() - t.createdAt < 3_600_000).length >= 10) throw new Error("Too many purchases started in the last hour. Try again later.");
}
export async function widgetBuy(key: string, user: { solanaAddress?: string | null }, body: any, deviceIp: string | undefined): Promise<{ id: string; url: string; walletAddress: string; which: string; fiatCurrency: string; fiatAmount: number; asset: string }> {
  const c = config();
  if (!c.on) throw new Error(c.reason ?? "MoonPay is off.");
  const opts = await buyOptions();
  const fiatCurrency = String(body?.fiatCurrency ?? "").toLowerCase(), asset = String(body?.asset ?? "").toLowerCase();
  const fiatAmount = Number(body?.fiatAmount), pay = PAY_WITH[String(body?.payWith ?? "card")] ?? PAY_WITH.card;
  const fiat = opts.fiats.find((f) => f.code === fiatCurrency);
  if (!fiat) throw new Error("Choose a currency to pay in.");
  if (!opts.coins.some((x) => x.id === asset)) throw new Error("Choose a coin to buy.");
  if (!Number.isInteger(fiatAmount)) throw new Error("Use a whole amount, without cents.");
  if (fiatAmount < fiat.min) throw new Error(`The smallest purchase is ${fiat.min} ${fiatCurrency.toUpperCase()}.`);
  if (fiatAmount > fiat.max) throw new Error(`The largest purchase is ${fiat.max} ${fiatCurrency.toUpperCase()} at a time.`);
  const into = await buyInto(key, user, ASSETS[asset].wallet);
  if (!into) throw new Error("Your wallet is not set up yet.");
  await checkRate(key);
  const ref = await customerRef(key);
  const tx = await startTx(key, PROVIDER, "buy", { fiatCurrency, fiatAmount, cryptoCurrency: asset, network: ASSETS[asset].network, walletAddress: into.address, detail: { channel: "widget", customerRef: ref, mode: c.mode, payWith: pay, into: into.which } });
  const q = new URLSearchParams({
    apiKey: c.publishableKey, currencyCode: asset, baseCurrencyCode: fiatCurrency, baseCurrencyAmount: String(fiatAmount), lockAmount: "true",
    walletAddress: into.address, externalTransactionId: tx.id, externalCustomerId: ref, paymentMethod: pay, theme: "dark",
  });
  // The address MoonPay sees from the customer's browser when the page could ask MoonPay, else the one this server sees.
  const ip = reportedPublicIp(body?.seenIp) ?? (await publicIpFor(deviceIp));
  q.set("allowedIpAddress", crypto.createHmac("sha256", c.secretKey).update(ip).digest("base64"));
  const search = `?${q.toString()}`;
  const signature = crypto.createHmac("sha256", c.secretKey).update(search).digest("base64");
  return { id: tx.id, url: `${WIDGET(c.mode)}/${search}&signature=${encodeURIComponent(signature)}`, walletAddress: into.address, which: into.which, fiatCurrency, fiatAmount, asset };
}

// The modal asks how purchase `id` is going. The server asks MoonPay for the purchases carrying
// our reference (only our own signed link can carry it), takes the one under this customer's
// reference paying into this purchase's wallet, and records MoonPay's word. Nothing comes from the
// browser but our id. At most once every 4 seconds per purchase.
const lastCheck = new Map<string, number>();
export async function checkBuy(key: string, id: string): Promise<{ status: string; failureReason: string | null; providerId: string | null }> {
  if (!TX_ID_RE.test(id)) throw new Error("Unknown purchase.");
  const mine = (await myTransactions(key, null, 200)).find((t) => t.id === id);
  if (!mine || mine.kind !== "buy" || mine.provider !== PROVIDER) throw new Error("Unknown purchase.");
  const out = (t: { status: string; failureReason: string | null; providerId: string | null }) => ({ status: t.status, failureReason: t.failureReason, providerId: t.providerId });
  if (mine.final || Date.now() - (lastCheck.get(id) ?? 0) < 4_000) return out(mine);
  lastCheck.set(id, Date.now());
  if (lastCheck.size > 5_000) lastCheck.clear();
  const r = await linkByOurId(key, mine);
  return out(r?.tx ?? mine);
}
async function linkByOurId(key: string, mine: { id: string; providerId: string | null; walletAddress: string | null; createdAt: number }) {
  if (mine.providerId) return recheck(mine.id, mine.providerId, key);
  const ref = await customerRef(key);
  const theirs = (await fetchByOurId(mine.id)).map(fromMoonPay).filter((m) => m.providerId && m.externalTransactionId === mine.id && (!m.externalCustomerId || m.externalCustomerId === ref));
  const m = theirs.filter((x) => !checkTheirs(x, { wallet: mine.walletAddress, startedAt: mine.createdAt, ref })).sort((a, b) => (b.providerAt ?? 0) - (a.providerAt ?? 0))[0];
  return m ? recordUpdate(updateFrom(m, { id: mine.id, key, source: "check", eventId: `link:${m.providerId}` })) : null;
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
  const m = fromMoonPay(await fetchAny(transactionId));
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
  const m = fromMoonPay(await fetchAny(providerId));
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
          if ((tx.detail as any)?.channel === "widget") {
            if (await linkByOurId(tx.key, tx)) out.linked++;
          } else unlinked.set(tx.key, [...(unlinked.get(tx.key) ?? []), tx]);
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
