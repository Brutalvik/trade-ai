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
// (Making a customer's wallet in advance from the server needs MoonPay's server kit, whose package
// clashes with Privy's over the "viem" library as of 26 Nov 2026; it can be added when that is fixed.)
//
// Settings (Vercel): MOONX_PUBLISHABLE_KEY (moon_pk_test_... / moon_pk_live_...), MOONX_APP_ID (the
// wallet app's id, from its dashboard), MOONX_ISSUER (default https://x-api.moonpay.com).
// Live keys need MOONPAY_LIVE=yes as well.
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
  const mode = publishableKey.startsWith("moon_pk_test_") ? "sandbox" : publishableKey.startsWith("moon_pk_live_") ? "live" : null;
  if (!mode) return off("MOONX_PUBLISHABLE_KEY must be MoonPay's wallet key (moon_pk_test_... or moon_pk_live_...).");
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(appId)) return off("MOONX_APP_ID (the wallet app's id, from its dashboard) is not set.");
  if (mode === "live" && process.env.MOONPAY_LIVE?.trim().toLowerCase() !== "yes") return off("Live wallet keys are set, but MOONPAY_LIVE=yes is not.");
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

// ---------- MoonPay's sign-in tokens ----------
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
  if (String(claims.iss ?? "").replace(/\/+$/, "") !== c.issuer) throw new Error("not issued by MoonPay's wallet service");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(c.appId)) throw new Error("issued for another app");
  if (!(typeof claims.exp === "number" && claims.exp > now - 30)) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) throw new Error("not valid yet");
  if (!claims.sub) throw new Error("names no one");
  if (kind === "identity" ? claims.tt !== "identity" : claims.tt !== undefined && claims.tt !== "access") throw new Error(`not an ${kind} token`);
  return claims;
}
export async function verifySession(accessToken: string, identityToken: string): Promise<{ sub: string; email: string | null }> {
  const a = await verifyToken(accessToken, "access");
  const i = await verifyToken(identityToken, "identity");
  if (a.sub !== i.sub) throw new Error("the two tokens are different people's");
  return { sub: String(a.sub), email: typeof i.email === "string" ? i.email : null };
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
