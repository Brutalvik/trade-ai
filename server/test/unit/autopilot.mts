// The real-money auto-pilot (src/autopilot.ts): its agent's trades are copied with real money from
// the customer's own Solana wallet, inside their limits, signed through MoonPay's signer (faked
// here: a key made in this test stands in for the wallet), sent through Jupiter (faked here: it
// accepts only a transaction really signed by the wallet). Nothing here touches a real network.
import { check, expect, finish } from "../check.mts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-ap-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|_UPSTASH|CRON_SECRET|ANTHROPIC|OPENAI|PRIVY|MOONPAY|MOONX|AUTOPILOT|JUP/.test(k)) delete process.env[k];
delete process.env.VERCEL;
process.env.MOONX_PUBLISHABLE_KEY = "moon_pk_test_app";
process.env.MOONX_APP_ID = "app_tr";
process.env.SOLANA_RPC_URL = "https://rpc.fake.test";
process.env.JUPITER_API_URL = "https://jup.fake.test/swap/v2";
process.env.AUTOPILOT_DAILY_SIGNATURES = "8";

// ---------- the customer's wallet (its key stands in for MoonPay's signing) ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const toB58 = (b: Buffer) => { let n = BigInt("0x" + (b.toString("hex") || "0")); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x !== 0) break; s = "1" + s; } return s; };
const wallet = crypto.generateKeyPairSync("ed25519");
const walletPub = wallet.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const ADDR = toB58(walletPub);
const MINT = toB58(crypto.randomBytes(32)), WSOL = "So11111111111111111111111111111111111111112";

// ---------- a pretend Solana node, DexScreener and Jupiter ----------
let lamports = 10n * 1_000_000_000n, tokens = 0n; // the wallet's SOL and coin
let sellPx = 0.01; // the coin's price when it is sold (bought at 0.01; SOL at $100)
const orders = new Map<string, { side: "BUY" | "SELL"; inAmount: bigint; outAmount: bigint; message: Buffer }>();
let jupFails = false, executed = 0, nOrder = 0;
// An unsigned transaction with the wallet as its only signer (a v0 message).
function unsignedTx(taker: Buffer) {
  const message = Buffer.concat([Buffer.from([0x80, 1, 0, 1, 2]), taker, crypto.randomBytes(32), crypto.randomBytes(32), Buffer.from([0, 0])]);
  return { tx: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]), message };
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.host === "rpc.fake.test") {
    const b = JSON.parse(String(init?.body ?? "{}"));
    if (b.method === "getBalance") return Response.json({ jsonrpc: "2.0", id: b.id, result: { value: Number(lamports) } });
    if (b.method === "getTokenAccountsByOwner") return Response.json({ jsonrpc: "2.0", id: b.id, result: { value: tokens > 0n ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: tokens.toString(), decimals: 6 } } } } } }] : [] } });
    if (b.method === "getTokenSupply") return Response.json({ jsonrpc: "2.0", id: b.id, result: { value: { decimals: 6 } } });
    return Response.json({ jsonrpc: "2.0", id: b.id, result: null });
  }
  if (u.host === "api.dexscreener.com") {
    const pairs = [{ chainId: "solana", baseToken: { address: WSOL, symbol: "SOL", name: "Solana" }, priceUsd: "100", liquidity: { usd: 1e9 }, pairAddress: "p1" }, { chainId: "solana", baseToken: { address: MINT, symbol: "COIN", name: "Coin" }, priceUsd: "0.01", liquidity: { usd: 1e6 }, pairAddress: "p2" }];
    return Response.json({ pairs });
  }
  if (u.host === "jup.fake.test" && u.pathname.endsWith("/order")) {
    const q = u.searchParams, amount = BigInt(q.get("amount")!);
    const side = q.get("inputMint") === MINT ? "SELL" : "BUY";
    const out = side === "BUY" ? (amount * 100n * 1_000_000n) / (1_000_000_000n) * 100n : BigInt(Math.floor((Number(amount) / 1e6) * sellPx / 100 * 1e9));
    const { tx, message } = unsignedTx(Buffer.from(walletPub));
    const requestId = `rq${++nOrder}`;
    orders.set(requestId, { side, inAmount: amount, outAmount: out, message });
    return Response.json({ transaction: tx.toString("base64"), requestId, inAmount: amount.toString(), outAmount: out.toString() });
  }
  if (u.host === "jup.fake.test" && u.pathname.endsWith("/execute")) {
    const b = JSON.parse(String(init?.body ?? "{}"));
    const o = orders.get(b.requestId);
    const tx = Buffer.from(b.signedTransaction, "base64");
    const sig = tx.subarray(1, 65), msg = tx.subarray(65);
    const good = !!o && msg.equals(o.message) && crypto.verify(null, msg, wallet.publicKey, sig);
    if (!good) return Response.json({ status: "Failed", error: "bad signature" }, { status: 400 });
    if (jupFails) return Response.json({ status: "Failed", error: "slippage exceeded" });
    executed++;
    if (o!.side === "BUY") { lamports -= o!.inAmount; tokens += o!.outAmount; } else { tokens -= o!.inAmount; lamports += o!.outAmount; }
    return Response.json({ status: "Success", signature: `sig${executed}`, inputAmountResult: o!.inAmount.toString(), outputAmountResult: o!.outAmount.toString() });
  }
  if (u.host === "x-api.moonpay.com" && u.pathname === "/v0/sdk/auth/users/public/me") {
    const tok = String(new Headers(init?.headers).get("x-moonx-access-token") ?? "");
    const sub = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).sub;
    return Response.json({ user_id: sub, status: "active", wallets: [{ id: "w-sol", wallet_type: "solana", public_address: ADDR, created_at: "2026-11-27T10:00:00Z" }, { id: "w-eth", wallet_type: "ethereum", public_address: "0x52908400098527886E0F7030069857D2E4169EE7", created_at: "2026-11-27T10:00:00Z" }] });
  }
  if (u.host === "rpc.fake.test" || /dexscreener|jup|moonpay|moonx/.test(u.host)) return new Response("{}", { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

// MoonPay's sign-in tokens, made with a key that stands in for MoonPay's.
const mpKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims: Record<string, unknown>) => {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "k1" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: mpKey.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};
const tokensFor = (sub: string, email: string) => ({
  accessToken: jwt({ iss: "https://x-api.moonpay.com", aud: "app_tr", sub, sid: "s", iat: now(), exp: now() + 3600 }),
  identityToken: jwt({ iss: "https://x-api.moonpay.com", aud: "app_tr", sub, tt: "identity", email, iat: now(), exp: now() + 3600 }),
});

const { createStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const store = createStore();
const mw = await import(new URL("../../src/moonwallet.ts", import.meta.url).href);
mw.__setJwksFetchForTests(async () => [{ ...(mpKey.publicKey.export({ format: "jwk" }) as any), kid: "k1", alg: "ES256" }]);
const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
const ap = await import(new URL("../../src/autopilot.ts", import.meta.url).href);
const live = await import(new URL("../../src/live.ts", import.meta.url).href);
engine.onRealTrade(ap.onAgentTrade); // (as the server does on start: index.ts)
const fail = (p: Promise<unknown>) => p.then(() => "accepted", (e: Error) => e.message);

// ---------- switched off until the secret key is set ----------
expect("off without MoonPay's wallet secret key, and it says what to set", [ap.autopilotConfig().on, /MOONX_SECRET_KEY/.test(ap.autopilotConfig().reason)], [false, true]);
process.env.MOONX_SECRET_KEY = "moon_pk_test_wrongkind";
check("...a publishable key in its place is named as the wrong kind", /should start with moon_sk_/.test(ap.autopilotConfig().reason), ap.autopilotConfig().reason);
process.env.MOONX_SECRET_KEY = "moon_sk_test_secret";
expect("on with it", ap.autopilotConfig(), { on: true, reason: null });
process.env.AUTOPILOT = "off";
check("AUTOPILOT=off switches it off at once (the emergency switch)", !ap.autopilotConfig().on, ap.autopilotConfig().reason);
delete process.env.AUTOPILOT;

// ---------- limits ----------
expect("limits the customer may set: $10 to the per-trade cap, a day's total of at least a trade, a loss of at most the day's total", [
  await fail(Promise.resolve().then(() => ap.checkLimits({ perTradeUsd: 5, dailySpendUsd: 100, dailyLossUsd: 25 }))),
  await fail(Promise.resolve().then(() => ap.checkLimits({ perTradeUsd: 500, dailySpendUsd: 1000, dailyLossUsd: 25 }))),
  await fail(Promise.resolve().then(() => ap.checkLimits({ perTradeUsd: 25, dailySpendUsd: 20, dailyLossUsd: 5 }))),
  await fail(Promise.resolve().then(() => ap.checkLimits({ perTradeUsd: 25, dailySpendUsd: 100, dailyLossUsd: 200 }))),
  ap.checkLimits({ perTradeUsd: 25, dailySpendUsd: 100, dailyLossUsd: 25 }),
], ["The amount per trade must be at least $10.", "The amount per trade can be at most $100 while real trading is new.", "The day's total must be at least one trade's amount.", "The loss that pauses it can't be more than the day's total.", { perTradeUsd: 25, dailySpendUsd: 100, dailyLossUsd: 25 }]);
expect("the defaults the owner chose: $25 a trade, $100 a day, pause after a $25 loss", ap.DEFAULT_LIMITS, { perTradeUsd: 25, dailySpendUsd: 100, dailyLossUsd: 25 });

// ---------- the account ----------
await store.kvSet("user:ada", { username: "ada", firstName: "Ada", lastName: "L", email: "ada@example.test", salt: "", hash: "", passVer: 1, createdAt: Date.now(), avatarUrl: null, moonxId: "mx_ada", plan: "max", tradeMode: "real" });
await store.kvSet("moonpay-wallet:ada", { address: ADDR, chain: "solana", via: "proven", moonxUserId: "mx_ada", at: Date.now() });
const access = { plan: "max", role: "user" };

// ---------- allowing it ----------
expect("it cannot start before it is allowed", await fail(ap.start("ada", access, { tradeMode: "real" })), "Allow automatic trading first.");
const g = await ap.grantStart("ada");
check("allowing starts with a key pair made on the server: only its public half goes to the browser", /^[0-9a-f]{64}$/.test(g.apiPubHex) && g.address === ADDR && g.expiresAt > Date.now() + 29 * 86_400_000, g);
const pending = JSON.stringify(await store.kvGet("autopilot-pending-signer:ada"));
check("...its private half is kept encrypted, never as it is", !/[0-9a-f]{64}/.test(pending.replace(g.apiPubHex, "")), pending.slice(0, 80));
expect("refused: a permission over another wallet than the account's Solana wallet", await fail(ap.grantFinish("ada", { email: "ada@example.test", moonxId: "mx_ada" }, { apiPubHex: g.apiPubHex, walletId: "w-eth", expiresAt: g.expiresAt, ...tokensFor("mx_ada", "ada@example.test") })), "The permission must be for your Solana wallet.");
expect("refused: someone else's MoonPay sign-in", await fail(ap.grantFinish("ada", { email: "ada@example.test", moonxId: "mx_ada" }, { apiPubHex: g.apiPubHex, walletId: "w-sol", expiresAt: g.expiresAt, ...tokensFor("mx_eve", "eve@example.test") })), "Sign in to MoonPay with the same email as your account.");
expect("refused: a permission longer than 31 days", await fail(ap.grantFinish("ada", { email: "ada@example.test", moonxId: "mx_ada" }, { apiPubHex: g.apiPubHex, walletId: "w-sol", expiresAt: Date.now() + 60 * 86_400_000, ...tokensFor("mx_ada", "ada@example.test") })), "The permission must end between an hour and 31 days from now.");
const allowed = await ap.grantFinish("ada", { email: "ada@example.test", moonxId: "mx_ada" }, { apiPubHex: g.apiPubHex, walletId: "w-sol", expiresAt: g.expiresAt, ...tokensFor("mx_ada", "ada@example.test") });
expect("allowed: for the account's Solana wallet, until the date", [allowed.allowed?.address, allowed.allowed?.expiresAt], [ADDR, g.expiresAt]);

// The pretend MoonPay: signs with the wallet's key, only for the granted key and wallet.
let signMode: "ok" | "wrong" | "gone" | "busy" = "ok";
let signed = 0;
ap.__setSignerForTests(async (p: any) => {
  if (p.apiPubHex !== g.apiPubHex || p.walletId !== "w-sol") throw new Error("unknown signer");
  if (signMode === "gone") throw new Error("410 signer_not_provisioned");
  if (signMode === "busy") throw new Error("429 rate limited");
  signed++;
  const payload = Buffer.from(p.payloadHex, "hex");
  return (signMode === "wrong" ? crypto.sign(null, Buffer.from("something else"), wallet.privateKey) : crypto.sign(null, payload, wallet.privateKey)).toString("hex");
});

// ---------- starting ----------
expect("not in Paper mode", await fail(ap.start("ada", access, { tradeMode: "paper" })), "Switch to Real in your profile first.");
expect("not on a plan without auto-pick agents", await fail(ap.start("ada", { plan: "free", role: "user" }, { tradeMode: "real" })), "Your plan doesn't include auto-pick agents. See Plans to upgrade.");
const started = await ap.start("ada", access, { tradeMode: "real" });
expect("started: its agent runs in an account of its own (never the paper account)", [started.on, started.agent.running], [true, true]);
const paper = await engine.withAccount("ada", async () => { await engine.sync(); const s = engine.getState(); return [s.bot.running, (s.bots ?? []).some((b: any) => b.bot.running)]; });
expect("...the paper account's agents are untouched", paper, [false, false]);

// ---------- the agent's trades, copied ----------
const shadow = "ada~real";
const ev = (side: "BUY" | "SELL", id: string, extra: Record<string, unknown> = {}) => ({ side, positionId: id, mint: MINT, symbol: "COIN", chain: "solana", usd: 40, price: 0.01, ...extra });
const t1 = await ap.onAgentTrade(shadow, ev("BUY", "pos1"));
expect("its agent's buy becomes a real buy of the per-trade amount (not the agent's $40), signed through MoonPay, sent through Jupiter", [t1?.status, t1?.side, t1?.usd, t1?.auto, executed, signed], ["Success", "BUY", 25, true, 1, 1]);
let st = await ap.status("ada");
expect("today: $25 spent, one signature, the coin held", [st.today.spentUsd, st.today.signatures, st.holding.map((h: any) => [h.symbol, h.costUsd])], [25, 1, [["COIN", 25]]]);
expect("...and it shows in the account's real trades (the Profile's Real trades)", (await live.realTrades("ada")).filter((t: any) => t.auto).length, 1);

await ap.setLimits("ada", { perTradeUsd: 25, dailySpendUsd: 30, dailyLossUsd: 25 });
const t2 = await ap.onAgentTrade(shadow, ev("BUY", "pos2"));
expect("a buy is cut to what is left of the day's total ($30 - $25 = $5)", t2?.usd, 5);
const t3 = await ap.onAgentTrade(shadow, ev("BUY", "pos3"));
expect("once the day's total is spent, its agent's buys are not copied", [t3, executed], [null, 2]);

// Sales: the same share of what the auto-pilot bought, at a lower price (a loss).
sellPx = 0.008;
const half = await ap.onAgentTrade(shadow, ev("SELL", "pos1", { fraction: 0.5, closed: false }));
const boughtRaw = BigInt(t1!.outRaw);
expect("its agent selling half sells exactly half of the coins bought for that trade", [half?.status, half?.inRaw], ["Success", (boughtRaw / 2n).toString()]);
const rest = await ap.onAgentTrade(shadow, ev("SELL", "pos1", { fraction: 1, closed: true }));
expect("...closing sells the rest", [rest?.status, (BigInt(rest!.inRaw) + BigInt(half!.inRaw)).toString()], ["Success", boughtRaw.toString()]);
st = await ap.status("ada");
expect("the day's result counts the real loss ($25 bought, sold for $20)", st.today.pnlUsd, -5);
expect("coins the customer held before are never sold: the sales were only what it bought", tokens.toString(), t2!.outRaw);

// The day's loss limit.
await ap.setLimits("ada", { perTradeUsd: 25, dailySpendUsd: 100, dailyLossUsd: 5 });
sellPx = 0.002;
await ap.onAgentTrade(shadow, ev("SELL", "pos2", { closed: true }));
st = await ap.status("ada");
expect("a loss past the day's limit pauses it at once for the rest of the day", [st.paused, /loss reached/.test(st.stopReason ?? "")], [true, true]);
for (let i = 0; i < 30 && (await ap.status("ada")).agent.running; i++) await new Promise((r) => setTimeout(r, 100));
expect("...and its agent stops", (await ap.status("ada")).agent.running, false);
const afterPause = await ap.onAgentTrade(shadow, ev("BUY", "pos4"));
expect("...no buy is copied while it is paused", [afterPause, executed], [null, 5]);
expect("...and it cannot be started again today", /Paused for today/.test(await fail(ap.start("ada", access, { tradeMode: "real" }))), true);

// A new day: the pause ends on the scheduler's next minute.
const today = new Date().toISOString().slice(0, 10);
await store.kvSet(`autopilot-day:ada:${today}`, { spent: 0, pnl: 0, sigs: 5, buys: 0, sells: 0 });
await store.kvSet("autopilot:ada", { ...(await store.kvGet("autopilot:ada")), pausedDay: "2026-01-01" });
await ap.everyMinute();
st = await ap.status("ada");
expect("the next day it starts again by itself", [st.on, st.paused, st.agent.running], [true, false, true]);

// MoonPay's signature allowance (8 a day here): a buy needs room for its sale too.
await store.kvSet(`autopilot-day:ada:${today}`, { spent: 0, pnl: 0, sigs: 7, buys: 0, sells: 0 });
const noRoom = await ap.onAgentTrade(shadow, ev("BUY", "pos5"));
expect("with one signature left, no buy is made (its sale would have none)", [noRoom, executed], [null, 5]);
await store.kvSet(`autopilot-day:ada:${today}`, { spent: 0, pnl: 0, sigs: 0, buys: 0, sells: 0 });

// A buy that fails, then its sale.
sellPx = 0.01;
await ap.setLimits("ada", { perTradeUsd: 25, dailySpendUsd: 100, dailyLossUsd: 25 });
jupFails = true;
const bad = await ap.onAgentTrade(shadow, ev("BUY", "pos6"));
jupFails = false;
const badSell = await ap.onAgentTrade(shadow, ev("SELL", "pos6", { closed: true }));
expect("a buy that did not go through: its later sale is skipped (nothing real was bought)", [bad, badSell, executed], [null, null, 5]);

// A signature that does not check out is never sent.
signMode = "wrong";
const forged = await ap.onAgentTrade(shadow, ev("BUY", "pos7"));
expect("a signature that is not the wallet's for exactly this transaction: nothing is sent to Jupiter", [forged, executed], [null, 5]);
signMode = "ok";

// A sale that fails is tried again on the scheduler's minute.
const pos8 = await ap.onAgentTrade(shadow, ev("BUY", "pos8"));
jupFails = true;
await ap.onAgentTrade(shadow, ev("SELL", "pos8", { closed: true }));
st = await ap.status("ada");
check("a sale that did not go through is kept, and shown", !!st.holding.find((h: any) => h.sellError), st.holding);
jupFails = false;
await store.kvSet("autopilot-holdings:ada", Object.fromEntries(Object.entries((await store.kvGet("autopilot-holdings:ada")) as Record<string, any>).map(([k, v]) => [k, v.sellPending ? { ...v, sellPending: { ...v.sellPending, at: 0 } } : v])));
await ap.everyMinute();
st = await ap.status("ada");
expect("...and sold on the next minute", [pos8?.status, st.holding.length], ["Success", 0]);

// MoonPay losing the permission.
signMode = "gone";
await ap.onAgentTrade(shadow, ev("BUY", "pos9"));
st = await ap.status("ada");
expect("when MoonPay no longer holds the permission, it says to allow it again", [st.allowed, /allow automatic trading again/.test(st.allowProblem ?? "")], [null, true]);
signMode = "ok";

// Stopping sells what it holds; withdrawing forgets the key.
await store.kvSet("autopilot-signer:ada", { ...(await store.kvGet("autopilot-signer:ada")), dead: undefined });
await ap.start("ada", access, { tradeMode: "real" }).catch(() => null);
const p10 = await engine.withAccount(shadow, async () => {
  await engine.sync();
  return engine.buy({ chain: "solana", pool: "pool10", symbol: "COIN", priceUsd: 0.01, dex: "x", url: "", liquidityUsd: 1e6, volume24h: 0, change24h: 0 } as any, 25, "bot", "test", { botId: "1", tokenMint: MINT });
});
await engine.withAccount(shadow, () => engine.settleSteps());
st = await ap.status("ada");
expect("its agent buying in its own account is copied by itself (the engine hands the trade over)", [p10.side, st.holding.length], ["BUY", 1]);
const stopped = await ap.stop("ada", "Stopped by you", access);
expect("stopping sells what it holds, then stops its agent", [stopped.on, stopped.holding.length, stopped.agent.running], [false, 0, false]);
const gone = await ap.revoke("ada", access);
expect("withdrawing the permission forgets the key (the browser also asks MoonPay to revoke it)", [gone.apiPubHex, gone.allowed, await store.kvGet("autopilot-signer:ada")], [g.apiPubHex, null, null]);
const noKey = await ap.onAgentTrade(shadow, ev("BUY", "pos11"));
expect("...after which nothing more is bought", [noKey, executed], [null, executed]);

// A paper account's agent is never copied.
let paperCopied = false;
engine.onRealTrade(async () => { paperCopied = true; });
await engine.withAccount("ada", async () => {
  await engine.sync();
  engine.buy({ chain: "solana", pool: "poolP", symbol: "COIN", priceUsd: 0.01, dex: "x", url: "", liquidityUsd: 1e6, volume24h: 0, change24h: 0 } as any, 25, "bot", "test", { botId: "1", tokenMint: MINT });
  await engine.settleSteps();
});
expect("a paper account's agent trading is never copied with real money", paperCopied, false);
finish();
