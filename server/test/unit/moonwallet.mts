// Customers' MoonPay wallets (src/moonwallet.ts): a wallet gets on file only when MoonPay's
// sign-in tokens check out (signed by MoonPay's key for this app, not expired, the right kind,
// the same person, the account's email) AND the wallet signed the server's one-time message.
// MoonPay is faked by a key made here: its public half is served as MoonPay's published keys.
import { check, expect, finish } from "../check.mts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-mw-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|_UPSTASH|MOONPAY|MOONX/.test(k)) delete process.env[k];
delete process.env.VERCEL;
const mw = await import(new URL("../../src/moonwallet.ts", import.meta.url).href);

// ---------- settings ----------
expect("without keys, wallets are off and say so", [mw.moonxConfig().on, mw.moonxConfig().reason], [false, "MoonPay wallets are not set up (no MOONX_PUBLISHABLE_KEY)."]);
process.env.MOONX_PUBLISHABLE_KEY = "moon_pk_test_abc";
expect("the app's id is needed too (it pins whose tokens count)", mw.moonxConfig().reason, "MOONX_APP_ID (the wallet app's id, from its dashboard) is not set.");
process.env.MOONX_APP_ID = "app_trading_rust";
expect("with both: on, in sandbox", [mw.moonxConfig().on, mw.moonxConfig().mode], [true, "sandbox"]);
process.env.MOONX_PUBLISHABLE_KEY = "moon_pk_live_abc";
check("a live key alone does not switch them on", !mw.moonxConfig().on && /MOONPAY_LIVE=yes/.test(mw.moonxConfig().reason), mw.moonxConfig().reason);
process.env.MOONX_PUBLISHABLE_KEY = "moon_pk_test_abc";

// ---------- a Solana wallet's own signature ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const toB58 = (b: Buffer) => { let n = BigInt("0x" + (b.toString("hex") || "0")); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x !== 0) break; s = "1" + s; } return s; };
expect("base58 as Solana writes it ('hello world')", mw.base58("StV1DL6CwTryKyV").toString(), "hello world");
const wallet = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { address: toB58(raw), sign: (m: string) => crypto.sign(null, Buffer.from(m, "utf8"), privateKey) };
};
const w1 = wallet(), w2 = wallet();
const msg = "TRADING//RUST: connect this wallet";
expect("a wallet's signature of the message checks out, in base58 or base64", [mw.signedBy(w1.address, msg, toB58(w1.sign(msg))), mw.signedBy(w1.address, msg, w1.sign(msg).toString("base64"))], [true, true]);
expect("...another wallet's signature does not, nor one of another message, nor rubbish", [mw.signedBy(w1.address, msg, toB58(w2.sign(msg))), mw.signedBy(w1.address, msg + ".", toB58(w1.sign(msg))), mw.signedBy(w1.address, msg, "zzz"), mw.signedBy("not-an-address", msg, toB58(w1.sign(msg)))], [false, false, false, false]);

// ---------- MoonPay's tokens ----------
const mp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...(mp.publicKey.export({ format: "jwk" }) as any), kid: "k1", alg: "ES256" };
let jwksAsked = 0;
mw.__setJwksFetchForTests(async (url: string) => { jwksAsked++; if (!url.endsWith("/v0/sdk/.well-known/jwks/app_trading_rust")) throw new Error(`wrong address ${url}`); return [jwk]; });
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims: Record<string, unknown>, o: { key?: crypto.KeyObject; kid?: string; alg?: string } = {}) => {
  const h = Buffer.from(JSON.stringify({ alg: o.alg ?? "ES256", typ: "JWT", kid: o.kid ?? "k1" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: o.key ?? mp.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${s}`;
};
const base = { iss: "https://x-api.moonpay.com", aud: "app_trading_rust", sub: "mx_user_1", sid: "s1", iat: now(), exp: now() + 3600 };
const access = (c: Record<string, unknown> = {}, o = {}) => jwt({ ...base, ...c }, o);
const identity = (c: Record<string, unknown> = {}, o = {}) => jwt({ ...base, tt: "identity", email: "Ada@Example.test", exp: now() + 36000, ...c }, o);
const why = (p: Promise<unknown>) => p.then(() => "accepted", (e: Error) => e.message);
expect("MoonPay's tokens for this app check out, and say who it is", await mw.verifySession(access(), identity()), { sub: "mx_user_1", email: "Ada@Example.test" });
expect("refused: signed with another key", await why(mw.verifyToken(access({}, { key: other.privateKey }), "access")), "signature does not match");
expect("refused: a changed token", await why(mw.verifyToken(access().replace(/\.([^.]+)\./, (_m, p) => `.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "someone_else" })).toString("base64url")}.`), "access")), "signature does not match");
expect("refused: issued for another app", await why(mw.verifyToken(access({ aud: "app_someone_else" }), "access")), "issued for another app");
expect("refused: issued by someone else than MoonPay's wallet service", await why(mw.verifyToken(access({ iss: "https://evil.example" }), "access")), "not issued by MoonPay's wallet service");
expect("refused: expired", await why(mw.verifyToken(access({ exp: now() - 120 }), "access")), "expired");
expect("refused: an identity token passed as an access token, and the other way round", [await why(mw.verifyToken(identity(), "access")), await why(mw.verifyToken(access(), "identity"))], ["not an access token", "not an identity token"]);
expect("refused: the two tokens are different people's", await why(mw.verifySession(access(), identity({ sub: "mx_user_2" }))), "the two tokens are different people's");
expect("refused: not signed the expected way", await why(mw.verifyToken(access({}, { alg: "HS256" }), "access")), "not signed the expected way");
const asked = jwksAsked;
expect("refused: a key MoonPay does not publish (asked again once in case it was just rotated)", await why(mw.verifyToken(access({}, { kid: "k9" }), "access")), "not signed by MoonPay's key for this app");
check("MoonPay's published keys are remembered, not fetched for every token", jwksAsked <= asked + 1 && jwksAsked <= 3, jwksAsked);

// ---------- connecting a wallet ----------
const ada = { email: "ada@example.test" };
expect("no wallet on file yet", await mw.myWallet("ada"), null);
let ch = await mw.walletChallenge("ada");
check("the message to sign names the account and a one-time code, and expires in 10 minutes", /Account: ada\nCode: [0-9a-f]{32}\n/.test(ch.message) && ch.expiresAt - Date.now() <= 600_000, ch.message);
expect("refused: MoonPay's sign-in for another email", await why(mw.proveWallet("ada", ada, { address: w1.address, signature: toB58(w1.sign(ch.message)), accessToken: access(), identityToken: identity({ email: "eve@example.test" }) })), "Sign in to MoonPay's wallet with the same email as your account.");
expect("...and that message cannot be used again", await why(mw.proveWallet("ada", ada, { address: w1.address, signature: toB58(w1.sign(ch.message)), accessToken: access(), identityToken: identity() })), "The check expired. Try again.");
ch = await mw.walletChallenge("ada");
expect("refused: the signature is another wallet's", await why(mw.proveWallet("ada", ada, { address: w1.address, signature: toB58(w2.sign(ch.message)), accessToken: access(), identityToken: identity() })), "The wallet's signature does not match.");
ch = await mw.walletChallenge("ada");
check("refused: MoonPay's sign-in cannot be confirmed (a forged token)", /^MoonPay's sign-in could not be confirmed/.test(await why(mw.proveWallet("ada", ada, { address: w1.address, signature: toB58(w1.sign(ch.message)), accessToken: access({}, { key: other.privateKey }), identityToken: identity() }))), "");
ch = await mw.walletChallenge("ada");
const on = await mw.proveWallet("ada", ada, { address: w1.address, signature: toB58(w1.sign(ch.message)), accessToken: access(), identityToken: identity() });
expect("MoonPay's sign-in, the same email, the wallet's own signature: the wallet is on file", [on.address, on.moonxUserId, on.via], [w1.address, "mx_user_1", "proven"]);
ch = await mw.walletChallenge("ada");
expect("another wallet is never put in its place", await why(mw.proveWallet("ada", ada, { address: w2.address, signature: toB58(w2.sign(ch.message)), accessToken: access(), identityToken: identity() })), "A different wallet is already on file for this account.");
expect("the wallet on file is still the first", (await mw.myWallet("ada"))?.address, w1.address);
finish();
