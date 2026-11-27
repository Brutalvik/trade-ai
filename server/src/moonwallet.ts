// Customers' MoonPay wallets (MoonPay Embedded Wallets; "MoonX" in MoonPay's packages). The
// wallet on file is the one purchases are delivered to (moonpay.ts reads `moonpay-wallet:<key>`),
// so it is never taken from the browser alone. The customer signs in to MoonPay's wallet in the
// app's own screen (an emailed code from MoonPay), which makes the wallet on their device. Then:
//  - their MoonPay sign-in tokens must check out against MoonPay's published public keys (signed
//    by MoonPay, for this app, not expired, access and identity token of the same person), and
//    name the same email as their account;
//  - and the wallet must sign a one-time message from the server (checked here with the wallet's
//    own public key, which is its address).
// Once a wallet is on file, another one is never put in its place by these routes.
// (Making a customer's wallet in advance from the server would need MoonPay's server kit; it is not
// used: MoonPay makes the wallet when the customer signs up.)
//
// Settings (Vercel): MOONX_PUBLISHABLE_KEY (moon_pk_test_... / moon_pk_live_...), MOONX_APP_ID (the
// wallet app's id, from its dashboard), MOONX_ISSUER (default https://x-api.moonpay.com).
// A live key (moon_pk_live_) is enough on its own: signing in and making a wallet move no money.
// MOONPAY_LIVE=yes stays the switch for real payments only (moonpay.ts); a real trade from the wallet
// is approved by the customer in the browser and capped (REAL_MAX_TRADE_USD).
import crypto from "node:crypto";
import { createStore } from "./store.js";

const store = () => createStore();
export type MoonWallet = { address: string; chain: "solana"; via: "proven"; moonxUserId: string | null; at: number };
const walletKey = (key: string) => `moonpay-wallet:${key}`;
const challengeKey = (key: string) => `moonpay-wallet-challenge:${key}`;

// ---------- Settings ----------
export function moonxConfig() {
  const publishableKey = process.env.MOONX_PUBLISHABLE_KEY?.trim() ?? "", appId = process.env.MOONX_APP_ID?.trim() ?? "";
  const issuer = (process.env.MOONX_ISSUER?.trim() || "https://x-api.moonpay.com").replace(/\/+$/, "");
  const off = (reason: string) => ({ on: false, mode: null as "sandbox" | "live" | null, reason, publishableKey: "", appId: "", issuer });
  if (!publishableKey) return off("MoonPay wallets are not set up (no MOONX_PUBLISHABLE_KEY).");
  // MoonPay's wallet keys start with moon_pk_ (its own kit checks no more than that). One marked
  // moon_pk_live_ is live; any other is treated as a test key. The common mix-ups are named
  // precisely, and the value itself is never shown.
  if (/^["']|["']$/.test(publishableKey)) return off("MOONX_PUBLISHABLE_KEY has quotes around it in Vercel: remove them.");
  if (publishableKey.startsWith("moon_sk_") || publishableKey.startsWith("sk_")) return off("MOONX_PUBLISHABLE_KEY holds a SECRET key: replace it with the wallet app's publishable key (moon_pk_...), from the Embedded Wallets dashboard, Developer, API Keys. (The server never sends this value anywhere.)");
  if (publishableKey.startsWith("pk_")) return off("MOONX_PUBLISHABLE_KEY holds MoonPay's buying key (pk_...): use the wallet app's publishable key (moon_pk_...), from the Embedded Wallets dashboard, Developer, API Keys.");
  if (!publishableKey.startsWith("moon_pk_")) return off("MOONX_PUBLISHABLE_KEY is not a MoonPay wallet key: it should start with moon_pk_ (Embedded Wallets dashboard, Developer, API Keys).");
  const mode = publishableKey.startsWith("moon_pk_live_") ? "live" : "sandbox";
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(appId)) return off("MOONX_APP_ID (the wallet app's id, from its dashboard) is not set.");
  return { on: true, mode, reason: null as string | null, publishableKey, appId, issuer };
}
export const moonxStatus = () => {
  const c = moonxConfig();
  return { on: c.on, mode: c.mode, reason: c.reason, publishableKey: c.on ? c.publishableKey : null, appId: c.on ? c.appId : null };
};

// ---------- Proving a wallet: its own signature ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("not base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
// Did the Solana wallet `address` sign exactly `message`? (A Solana address is the wallet's
// ed25519 public key.) The signature may come as base58 (Solana's way) or base64.
export function signedBy(address: string, message: string, signature: string): boolean {
  try {
    const pub = base58(address);
    if (pub.length !== 32) return false;
    let sig: Buffer;
    try { sig = base58(signature); } catch { sig = Buffer.from(signature, "base64"); }
    if (sig.length !== 64) sig = Buffer.from(signature, "base64");
    if (sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------- The four wallets ----------
// MoonPay makes one wallet per kind for a person: Solana; Ethereum (one address that also works on
// BNB Chain, Base, Polygon, Arbitrum, Optimism and Avalanche); Bitcoin; Tron. Each is kept on file
// on its own (the Solana one where it always was, which buying and real trades read), and the first
// one of a kind stays: another is never put in its place.
export const CHAINS = ["solana", "ethereum", "bitcoin", "tron"] as const;
export type Chain = (typeof CHAINS)[number];
export type ChainWallet = { address: string; chain: Chain; via: "proven" | "pregenerated"; moonxUserId: string | null; at: number };
export const ADDRESS: Record<Chain, RegExp> = {
  solana: SOLANA_ADDRESS,
  ethereum: /^0x[0-9a-fA-F]{40}$/,
  bitcoin: /^(bc1[02-9ac-hj-np-z]{8,87}|tb1[02-9ac-hj-np-z]{8,87}|[13mn2][1-9A-HJ-NP-Za-km-z]{25,39})$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};
const chainKey = (chain: Chain, key: string) => (chain === "solana" ? walletKey(key) : `moonpay-wallet-${chain}:${key}`);
// The account's wallets on file, in the order above (kinds not made yet are left out).
export async function myWallets(key: string): Promise<ChainWallet[]> {
  const got = await Promise.all(CHAINS.map((c) => store().kvGet<ChainWallet>(chainKey(c, key))));
  return got.filter((w): w is ChainWallet => !!w?.address);
}
// Puts each wallet MoonPay names for the person on file, unless one of that kind is there already.
export async function keepMoonWallets(key: string, wallets: Partial<Record<Chain, string>>, moonxUserId: string | null, via: ChainWallet["via"] = "proven"): Promise<ChainWallet[]> {
  for (const chain of CHAINS) {
    const address = wallets[chain];
    if (!address || !ADDRESS[chain].test(address)) continue;
    await store().kvSet(chainKey(chain, key), { address, chain, via, moonxUserId, at: Date.now() } satisfies ChainWallet, { nx: true });
  }
  return myWallets(key);
}

// ---------- MoonPay's sign-in tokens ----------
// MoonPay's wallet service answers on two hosts: x-api.moonpay.com (/v0/...) and api.moonx-dev.com
// (MoonPay's browser kit talks to that one, and the wallet dashboard shows its key address). On
// 26 Nov 2026 both served the same signing key for the app, so a token naming either host counts;
// what proves it is the signature with the app's own key and the audience (this app).
const MOONPAY_ISSUERS = ["https://x-api.moonpay.com", "https://api.moonx-dev.com"];
// ES256 JWTs signed with the wallet app's key, published at <issuer>/v0/sdk/.well-known/jwks/<app id>
// (fetched at most every 5 minutes, and again at once for a key id it does not know: MoonPay
// rotating its key). Checked: the signature, the issuer, the audience (this app), the expiry,
// the token type (an identity token never passes as an access token, nor the other way round),
// and that both tokens are the same person's.
type Jwk = { kid?: string; kty: string; crv?: string; x?: string; y?: string; alg?: string };
let jwks: { at: number; keys: Jwk[] } | null = null;
let fetchJwks = async (url: string): Promise<Jwk[]> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`MoonPay's public keys: HTTP ${r.status}`);
  const j: any = await r.json();
  return Array.isArray(j?.keys) ? j.keys : [];
};
export function __setJwksFetchForTests(f: (url: string) => Promise<Jwk[]>) {
  fetchJwks = f;
  jwks = null;
}
async function keyFor(kid: string | undefined): Promise<Jwk | null> {
  const c = moonxConfig();
  const url = `${c.issuer}/v0/sdk/.well-known/jwks/${encodeURIComponent(c.appId)}`;
  const find = () => jwks?.keys.find((k) => k.kty === "EC" && k.crv === "P-256" && (!kid || k.kid === kid)) ?? null;
  if (!jwks || Date.now() - jwks.at > 5 * 60_000) jwks = { at: Date.now(), keys: await fetchJwks(url) };
  let k = find();
  if (!k && Date.now() - jwks.at > 30_000) { jwks = { at: Date.now(), keys: await fetchJwks(url) }; k = find(); }
  return k;
}
const b64url = (s: string) => Buffer.from(s, "base64url");
export async function verifyToken(token: string, kind: "access" | "identity"): Promise<Record<string, any>> {
  const c = moonxConfig();
  if (!c.on) throw new Error(c.reason ?? "MoonPay wallets are off.");
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new Error("not a token");
  let header: any, claims: any;
  try {
    header = JSON.parse(b64url(parts[0]).toString("utf8"));
    claims = JSON.parse(b64url(parts[1]).toString("utf8"));
  } catch {
    throw new Error("not a token");
  }
  if (header?.alg !== "ES256") throw new Error("not signed the expected way");
  const jwk = await keyFor(header.kid);
  if (!jwk) throw new Error("not signed by MoonPay's key for this app");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
  const ok = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), { key, dsaEncoding: "ieee-p1363" }, b64url(parts[2]));
  if (!ok) throw new Error("signature does not match");
  const now = Date.now() / 1000;
  const iss = String(claims.iss ?? "").replace(/\/+$/, "");
  if (iss !== c.issuer && !MOONPAY_ISSUERS.includes(iss)) throw new Error("not issued by MoonPay's wallet service");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(c.appId)) throw new Error("issued for another app");
  if (!(typeof claims.exp === "number" && claims.exp > now - 30)) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) throw new Error("not valid yet");
  if (!claims.sub) throw new Error("names no one");
  if (kind === "identity" ? claims.tt !== "identity" : claims.tt !== undefined && claims.tt !== "access") throw new Error(`not an ${kind} token`);
  return claims;
}
export async function verifySession(accessToken: string, identityToken: string): Promise<{ sub: string; email: string | null; name: string | null; givenName: string | null; familyName: string | null }> {
  const a = await verifyToken(accessToken, "access");
  const i = await verifyToken(identityToken, "identity");
  if (a.sub !== i.sub) throw new Error("the two tokens are different people's");
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { sub: String(a.sub), email: str(i.email), name: str(i.name), givenName: str(i.given_name), familyName: str(i.family_name) };
}

// Who MoonPay says the signed-in person is, and their wallets: MoonPay's own record, asked with the
// person's access token (GET <issuer>/v0/sdk/auth/users/public/me). The wallet the app keeps on file
// comes from here, never from the browser.
export async function moonxMe(accessToken: string): Promise<{ userId: string; status: string | null; solana: string | null; wallets: Partial<Record<Chain, string>>; ids: Partial<Record<Chain, string>> }> {
  const c = moonxConfig();
  if (!c.on) throw new Error(c.reason ?? "MoonPay wallets are off.");
  const r = await fetch(`${c.issuer}/v0/sdk/auth/users/public/me`, { headers: { Authorization: `PublicToken ${c.publishableKey}`, "X-MoonX-Access-Token": accessToken, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`MoonPay could not confirm the sign-in (HTTP ${r.status}).`);
  const j: any = await r.json();
  const all: any[] = Array.isArray(j?.wallets) ? j.wallets : [];
  const wallets: Partial<Record<Chain, string>> = {}, ids: Partial<Record<Chain, string>> = {};
  for (const chain of CHAINS) {
    const of = all.filter((w) => w?.wallet_type === chain && ADDRESS[chain].test(String(w?.public_address ?? "")));
    of.sort((x, y) => Date.parse(x?.created_at ?? "") - Date.parse(y?.created_at ?? "")); // (the first one made)
    if (of[0]) wallets[chain] = String(of[0].public_address);
    if (of[0]?.id) ids[chain] = String(of[0].id); // MoonPay's own id for the wallet (the auto-pilot's signer is granted over it)
  }
  return { userId: String(j?.user_id ?? ""), status: j?.status ? String(j.status) : null, solana: wallets.solana ?? null, wallets, ids };
}
// A sign-in with MoonPay, fully checked: MoonPay's tokens (checked here against its published keys),
// then MoonPay's own record of the same person, who must be active. Returns who it is and their
// Solana wallet (null when they have none yet).
export async function moonxSignIn(accessToken: string, identityToken: string) {
  const c = moonxConfig();
  if (!c.on) throw new Error(`Signing in with MoonPay is not switched on. ${c.reason ?? ""}`.trim());
  let s;
  try {
    s = await verifySession(String(accessToken ?? ""), String(identityToken ?? ""));
  } catch (e: any) {
    throw new Error(`MoonPay's sign-in could not be confirmed (${e?.message ?? e}). Sign in again.`);
  }
  const me = await moonxMe(String(accessToken));
  if (me.userId !== s.sub) throw new Error("MoonPay's sign-in could not be confirmed (it names another person). Sign in again.");
  if (me.status && me.status !== "active") throw new Error("This MoonPay account cannot be used. Contact support.");
  return { ...s, email: s.email?.toLowerCase() ?? null, wallet: me.solana, wallets: me.wallets, walletIds: me.ids };
}
// Puts the person's MoonPay wallet on file for the account (from MoonPay's own record), unless one
// is there already: the first one stays, another is never put in its place.
export async function keepMoonWallet(key: string, address: string, moonxUserId: string): Promise<MoonWallet> {
  if (!SOLANA_ADDRESS.test(address)) throw new Error("That is not a Solana wallet address.");
  const w: MoonWallet = { address, chain: "solana", via: "proven", moonxUserId, at: Date.now() };
  if (await store().kvSet(walletKey(key), w, { nx: true })) return w;
  return (await myWallet(key))!;
}

// ---------- The wallet on file ----------
export async function myWallet(key: string): Promise<MoonWallet | null> {
  return store().kvGet<MoonWallet>(walletKey(key));
}
// Puts a wallet on file, unless one is there already (then that one counts: a different one is refused).
async function keep(key: string, w: MoonWallet): Promise<MoonWallet> {
  if (await store().kvSet(walletKey(key), w, { nx: true })) return w;
  const had = (await myWallet(key))!;
  if (had.address !== w.address) throw new Error("A different wallet is already on file for this account.");
  return had;
}

type Who = { email: string };
// A one-time message for the customer's wallet to sign (valid 10 minutes, used once).
export async function walletChallenge(key: string): Promise<{ message: string; expiresAt: number }> {
  const nonce = crypto.randomBytes(16).toString("hex"), expiresAt = Date.now() + 10 * 60_000;
  const message = `TRADING//RUST: connect this wallet to my account.\nAccount: ${key}\nCode: ${nonce}\nValid until: ${new Date(expiresAt).toISOString()}`;
  await store().kvSet(challengeKey(key), { message, expiresAt }, { ttlMs: 10 * 60_000 });
  return { message, expiresAt };
}
// The customer signed in to MoonPay's wallet and signed the message: put that wallet on file.
export async function proveWallet(key: string, user: Who, body: { address?: string; signature?: string; accessToken?: string; identityToken?: string }) {
  const address = String(body.address ?? ""), signature = String(body.signature ?? "");
  if (!SOLANA_ADDRESS.test(address)) throw new Error("That is not a Solana wallet address.");
  const ch = await store().kvGet<{ message: string; expiresAt: number }>(challengeKey(key));
  if (!ch || ch.expiresAt < Date.now()) throw new Error("The check expired. Try again.");
  await store().kvDel(challengeKey(key)); // one try per message, right or wrong
  if (!body.accessToken || !body.identityToken) throw new Error("Sign in to MoonPay's wallet first.");
  let s;
  try {
    s = await verifySession(body.accessToken, body.identityToken);
  } catch (e: any) {
    throw new Error(`MoonPay's sign-in could not be confirmed (${e?.message ?? e}). Sign in to the wallet again.`);
  }
  if (!s.email || s.email.toLowerCase() !== user.email.toLowerCase()) throw new Error("Sign in to MoonPay's wallet with the same email as your account.");
  if (!signedBy(address, ch.message, signature)) throw new Error("The wallet's signature does not match.");
  return keep(key, { address, chain: "solana", via: "proven", moonxUserId: s.sub, at: Date.now() });
}

// ---------- Balance ----------
// SOL in the wallet. In sandbox MoonPay delivers test coins on Solana's test network (devnet).
export async function solBalance(address: string, sandbox: boolean): Promise<number | null> {
  const url = sandbox ? "https://api.devnet.solana.com" : process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }), signal: AbortSignal.timeout(10_000) });
    const j: any = await r.json();
    return typeof j?.result?.value === "number" ? j.result.value / 1e9 : null;
  } catch {
    return null;
  }
}
