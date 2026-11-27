// Signing up and signing in with MoonPay (its wallet sign-in), through the server's real routes:
// the server checks MoonPay's tokens itself (against MoonPay's published keys, faked here by a key
// made in this test), asks MoonPay which wallet belongs to the person, and links or creates the
// account. Nothing about who someone is, or which wallet is theirs, is taken from the browser.
import { check, expect, finish } from "../check.mts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-mpsi-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|_UPSTASH|CRON_SECRET|ANTHROPIC|OPENAI|PRIVY|MOONPAY|MOONX/.test(k)) delete process.env[k];
process.env.VERCEL = "1";
process.env.MOONX_PUBLISHABLE_KEY = "moon_pk_test_app";
process.env.MOONX_APP_ID = "app_tr";
process.env.SOLANA_RPC_URL = "https://rpc.fake.test";
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
await fakeSupabase();
const { createStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const store = createStore();

// ---------- a pretend MoonPay wallet service ----------
const mpKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const forger = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const people: Record<string, { status: string; wallets: { wallet_type: string; public_address: string; created_at: string }[]; as?: string }> = {};
// A made-up Solana address: Solana's alphabet has no 0, O, I or lowercase l (the server refuses those).
const A = (tag: string) => (tag + "x".repeat(44)).slice(0, 44);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.host === "rpc.fake.test") { // Solana: every wallet holds 1 SOL and no tokens
    const b = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({ jsonrpc: "2.0", id: b.id, result: { value: b.method === "getBalance" ? 1e9 : [] } });
  }
  if (u.host === "api.dexscreener.com") return new Response("{}", { status: 503 }); // (prices are best-effort)
  if (u.host !== "x-api.moonpay.com") return realFetch(input, init); // the app itself, and the pretend database
  if (u.pathname === "/v0/sdk/.well-known/jwks/app_tr") return Response.json({ keys: [{ ...(mpKey.publicKey.export({ format: "jwk" }) as any), kid: "k1", alg: "ES256" }] });
  if (u.pathname === "/v0/sdk/auth/users/public/me") {
    const h = new Headers(init?.headers);
    if (h.get("authorization") !== "PublicToken moon_pk_test_app") return new Response("{}", { status: 401 });
    const tok = String(h.get("x-moonx-access-token") ?? "");
    let sub = "";
    try { sub = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).sub; } catch { return new Response("{}", { status: 401 }); }
    const p = people[sub];
    return p ? Response.json({ user_id: p.as ?? sub, status: p.status, wallets: p.wallets, emails: [] }) : new Response("{}", { status: 401 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims: Record<string, unknown>, key = mpKey.privateKey) => {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "k1" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};
const tokens = (sub: string, email: string, o: { aud?: string; key?: crypto.KeyObject; exp?: number; name?: string } = {}) => ({
  accessToken: jwt({ iss: "https://x-api.moonpay.com", aud: o.aud ?? "app_tr", sub, sid: "s", iat: now(), exp: o.exp ?? now() + 3600 }, o.key),
  identityToken: jwt({ iss: "https://x-api.moonpay.com", aud: o.aud ?? "app_tr", sub, tt: "identity", email, name: o.name ?? "Ada Lovelace", given_name: "Ada", family_name: "Lovelace", iat: now(), exp: now() + 36000 }, o.key),
});
const sol = (a: string, at = "2026-11-26T10:00:00Z") => ({ wallet_type: "solana", public_address: a, created_at: at });

const app = (await import(new URL("../../src/index.ts", import.meta.url).href)).default;
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (p: string, body?: unknown, cookie = "") => {
  const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
};

// ---------- a new customer ----------
people.mx_ada = { status: "active", wallets: [sol(A("ADA"))] };
const t = tokens("mx_ada", "Ada@Example.test");
const first = await call("/api/auth/moonpay-login", t);
expect("a new person signed in with MoonPay is asked for a username, with their name and email from MoonPay", [first.body.needsProfile, first.body.email, first.body.firstName, first.body.lastName, first.cookie], [true, "ada@example.test", "Ada", "Lovelace", ""]);
const made = await call("/api/auth/moonpay-complete", { ...t, username: "ada", firstName: "Ada", lastName: "Lovelace" });
check("...then the account is made and they are signed in", made.status === 200 && made.body.user?.username === "ada" && !!made.cookie, made.body);
const w = await call("/api/moonpay/wallet", undefined, made.cookie);
expect("their MoonPay wallet is on file from the start, as MoonPay itself names it", [w.body.wallet?.address, w.body.wallet?.moonxUserId], [A("ADA"), "mx_ada"]);
const again = await call("/api/auth/moonpay-login", tokens("mx_ada", "ada@example.test"));
check("signing in again goes straight in", again.status === 200 && again.body.user?.username === "ada" && !!again.cookie, again.body);
people.mx_eve = { status: "active", wallets: [] };
expect("the username cannot be taken twice", (await call("/api/auth/moonpay-complete", { ...tokens("mx_eve", "eve@example.test"), username: "ada", firstName: "Eve", lastName: "X" })).body.error, "That username is taken");

// ---------- an existing account (made with a password) is linked by the email MoonPay proved ----------
const pw = await call("/api/auth/signup", { username: "bob", email: "bob@example.test", password: "correct horse battery 9", firstName: "Bob", lastName: "Builder" });
check("(an account made the old way, with a password)", pw.status === 200, pw.body);
const rw = async (cookie: string) => { const r = (await call("/api/real/wallet", undefined, cookie)).body; return [r.address, r.via]; };
expect("real trades: no wallet at all, no trading wallet", await rw(pw.cookie), [null, null]);
await store.kvSet("user:bob", { ...(await store.kvGet("user:bob")), solanaAddress: A("BBPRIVY") }); // (as a Privy sign-in left it)
expect("real trades: before a MoonPay wallet is on file, from the previous (Privy) wallet", await rw(pw.cookie), [A("BBPRIVY"), "previous"]);
people.mx_bob = { status: "active", wallets: [sol(A("BBNEW"), "2026-11-26T12:00:00Z"), sol(A("BBPREV"), "2026-11-26T09:00:00Z")] };
const bob = await call("/api/auth/moonpay-login", tokens("mx_bob", "bob@example.test"));
expect("signing in with MoonPay with the same email lands in that account", bob.body.user?.username, "bob");
expect("its wallet on file is the first one MoonPay made for them", (await call("/api/moonpay/wallet", undefined, bob.cookie)).body.wallet?.address, A("BBPREV"));
expect("real trades: from then on, from the MoonPay wallet (the server decides, not the browser)", await rw(bob.cookie), [A("BBPREV"), "moonpay"]);
expect("...whose balance is read from Solana", (await call("/api/real/wallet", undefined, bob.cookie)).body.holdings?.[0]?.amount, 1);
expect("...and the previous wallet still shows in the previous-wallet view", (await call("/api/wallet", undefined, bob.cookie)).body.address, A("BBPRIVY"));

// ---------- refused ----------
const err = async (b: unknown) => (await call("/api/auth/moonpay-login", b)).body.error as string;
check("refused: tokens signed by someone else than MoonPay", /could not be confirmed \(signature does not match\)/.test(await err(tokens("mx_ada", "ada@example.test", { key: forger.privateKey }))), "");
check("refused: tokens for another app", /issued for another app/.test(await err(tokens("mx_ada", "ada@example.test", { aud: "app_other" }))), "");
check("refused: expired tokens", /expired/.test(await err(tokens("mx_ada", "ada@example.test", { exp: now() - 300 }))), "");
check("refused: an access token of one person with the identity token of another", /different people's/.test(await err({ accessToken: tokens("mx_ada", "ada@example.test").accessToken, identityToken: tokens("mx_bob", "bob@example.test").identityToken })), "");
people.mx_swap = { status: "active", wallets: [sol(A("SWAP"))], as: "mx_someone_else" };
expect("refused: MoonPay's own record names another person than the tokens", await err(tokens("mx_swap", "swap@example.test")), "MoonPay's sign-in could not be confirmed (it names another person). Sign in again.");
people.mx_ghost = { status: "active", wallets: [] };
const ghost = tokens("mx_ghost", "ghost@example.test");
people.mx_blocked = { status: "blacklisted", wallets: [sol(A("BLKD"))] };
expect("refused: a MoonPay account that is blocked", await err(tokens("mx_blocked", "blocked@example.test")), "This MoonPay account cannot be used. Contact support.");
expect("refused: nothing at all", await err({}), "MoonPay's sign-in could not be confirmed (not a token). Sign in again.");
const g = await call("/api/auth/moonpay-login", ghost);
expect("a person with no wallet yet can still sign up (the wallet is added when it exists)", g.body.needsProfile, true);
const gm = await call("/api/auth/moonpay-complete", { ...ghost, username: "ghost", firstName: "G", lastName: "H" });
expect("...no wallet on file yet", (await call("/api/moonpay/wallet", undefined, gm.cookie)).body.wallet, null);
people.mx_ghost.wallets.push(sol(A("GHST")));
expect("once MoonPay has made it, the same sign-in puts it on file", (await call("/api/moonpay/wallet/sync", ghost, gm.cookie)).body.wallet?.address, A("GHST"));
expect("another person's MoonPay sign-in cannot put their wallet on this account", (await call("/api/moonpay/wallet/sync", tokens("mx_bob", "bob@example.test"), gm.cookie)).body.error, "Sign in to MoonPay with the same email as your account.");
people.mx_ghost.wallets.unshift(sol(A("XTRA"), "2026-11-25T00:00:00Z"));
expect("a wallet on file is never replaced by another", (await call("/api/moonpay/wallet/sync", ghost, gm.cookie)).body.wallet?.address, A("GHST"));
expect("signed out, the wallet cannot be synced at all", (await call("/api/moonpay/wallet/sync", ghost)).body.error, "Sign in first.");
delete process.env.MOONX_PUBLISHABLE_KEY;
expect("real trades: with MoonPay wallets switched off, from the previous wallet again", await rw(bob.cookie), [A("BBPRIVY"), "previous"]);
expect("switched off, a MoonPay sign-in says so plainly", await err(tokens("mx_ada", "ada@example.test")), "Signing in with MoonPay is not switched on. MoonPay wallets are not set up (no MOONX_PUBLISHABLE_KEY).");
server.close();

// The browser's Sign in button (web/src/MoonPaySignIn.tsx): MoonPay's kit shows its email / Google /
// Apple window only when start() is not given a walletChainType (with one, it waits for an outside
// wallet and nothing shows, as happened on the live site on 27 Nov 2026).
{
  const web = fs.readFileSync(new URL("../../../web/src/MoonPaySignIn.tsx", import.meta.url), "utf8");
  const starts = [...web.matchAll(/mx\.start\(([^)]*)\)/g)].map((m) => m[1]);
  expect("Sign in asks MoonPay for its email / Google / Apple window, with no outside-wallet setting", [starts.length > 0, starts.every((a) => a.includes("loginMethods") && !a.includes("walletChainType"))], [true, true]);
}
finish();
