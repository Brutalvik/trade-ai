// Links Privy (embedded wallets) to this app's own logins ("JWT-based custom auth"):
//  - The server signs a short-lived token (ES256) saying "this is user <username>".
//  - Privy checks it with the public key published at /api/auth/jwks.json, then gives that user
//    their embedded Solana wallet, so they never sign in twice.
// The signing key is made once and kept in the store (no extra setting needed).
import crypto from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import { createStore } from "./store.js";

const store = createStore();
const KEY_NAME = "privy:jwt-key";
type KeyRecord = { kid: string; privateJwk: Record<string, any>; publicJwk: Record<string, any> };

let cached: KeyRecord | null = null;
async function signingKey(): Promise<KeyRecord> {
  if (cached) return cached;
  let rec = await store.kvGet<KeyRecord>(KEY_NAME);
  if (!rec) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const fresh: KeyRecord = {
      kid: crypto.randomBytes(8).toString("hex"),
      privateJwk: privateKey.export({ format: "jwk" }) as Record<string, any>,
      publicJwk: publicKey.export({ format: "jwk" }) as Record<string, any>,
    };
    await store.kvSet(KEY_NAME, fresh, { nx: true }); // first run only
    rec = (await store.kvGet<KeyRecord>(KEY_NAME))!;
  }
  cached = rec;
  return rec;
}

export const privyAppId = () => process.env.PRIVY_APP_ID?.trim() || null;
const ISSUER = "nexus-trade";

// The public key set Privy uses to verify our tokens.
export async function jwks() {
  const k = await signingKey();
  const { kty, crv, x, y } = k.publicJwk as { kty: string; crv: string; x: string; y: string };
  return { keys: [{ kty, crv, x, y, kid: k.kid, alg: "ES256", use: "sig" }] };
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

// A 10-minute token for the signed-in user (sub = their lowercase username).
export async function tokenFor(username: string) {
  const k = await signingKey();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: k.kid };
  const payload = { sub: username.toLowerCase(), iss: ISSUER, aud: privyAppId() ?? undefined, iat: now, exp: now + 600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = crypto.createPrivateKey({ key: k.privateJwk, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return { token: `${input}.${b64url(sig)}`, expiresAt: (now + 600) * 1000 };
}

// ---------- Privy as the login ----------
export type PrivyLogin = { did: string; email?: string; name?: string | null; solanaAddress?: string; method: "email" | "google" | "other" };

let client: PrivyClient | null = null;
function privyClient() {
  const appId = privyAppId();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error("Sign-in isn't set up yet (Privy keys missing)");
  return (client ??= new PrivyClient({ appId, appSecret }));
}

// Verify a Privy access token (from the page) and look up who it is. Throws if invalid.
async function privyLoginFromToken(accessToken: string): Promise<PrivyLogin> {
  if (!accessToken) throw new Error("Missing Privy login");
  const c = privyClient();
  let claims;
  try {
    claims = await c.utils().auth().verifyAccessToken(accessToken);
  } catch {
    throw new Error("Your sign-in expired. Please sign in again.");
  }
  const user = await c.users()._get(claims.user_id);
  const accounts = (user.linked_accounts ?? []) as any[];
  const emailAcc = accounts.find((a) => a.type === "email");
  const google = accounts.find((a) => a.type === "google_oauth");
  const wallet = accounts.find((a) => a.chain_type === "solana" && (a.connector_type === "embedded" || a.wallet_client_type === "privy"));
  return {
    did: claims.user_id,
    email: (emailAcc?.address ?? google?.email)?.toLowerCase(),
    name: google?.name ?? null,
    solanaAddress: wallet?.address,
    method: emailAcc ? "email" : google ? "google" : "other",
  };
}

// Swappable for tests (no network); the app always uses the real check.
let resolver = privyLoginFromToken;
export const resolvePrivyLogin = (token: string) => resolver(token);
export function __setPrivyResolverForTests(fn: (token: string) => Promise<PrivyLogin>) {
  resolver = fn;
}
