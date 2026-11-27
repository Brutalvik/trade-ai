// The real-money auto-pilot: the AI agent trading a customer's own Solana wallet, with no click per
// trade, inside limits the customer sets.
//
// How it is kept safe:
//  - It decides in an account of its own ("<username>~real", engine.ts), never the paper account.
//    Its agent is an ordinary auto-pick agent; every trade it makes is copied here with real money,
//    or skipped when a limit says no.
//  - Signing: the customer allows it once, from the browser, through MoonPay's "ephemeral signer":
//    MoonPay lets a key this server holds sign for their Solana wallet (only that wallet, until a
//    date at most 31 days away, revocable any time). The key pair is made here; only its public half
//    leaves the server, the private half is kept encrypted (AES-256-GCM). Every signature MoonPay
//    returns is checked against the wallet's own public key before anything is sent.
//  - Limits, all enforced here (MoonPay enforces no amounts): an amount per trade, a total spent per
//    day, a loss per day after which it pauses until the next day (UTC), Solana coins only, 0.01 SOL
//    always kept for network fees (live.ts), and MoonPay's daily signature allowance (a buy needs
//    room for its sale as well).
//  - Stopping (or switching to Paper, or withdrawing the permission) sells what it holds first.
//
// Settings (Vercel): MOONX_SECRET_KEY (moon_sk_..., required: MoonPay's signing route needs it),
// AUTOPILOT=off (emergency switch), AUTOPILOT_DAILY_SIGNATURES (default 10: MoonPay's test
// organisation allows 10 a day), AUTOPILOT_KEY (optional: what the stored keys are encrypted with;
// else derived from MOONX_SECRET_KEY), MOONX_API_URL (default https://api.moonx-dev.com).
import crypto from "node:crypto";
import { createStore } from "./store.js";
import { audit } from "./audit.js";
import * as engine from "./engine.js";
import * as live from "./live.js";
import * as moonwallet from "./moonwallet.js";
import { can, firstPlanWith, UpgradeNeeded, type PlanId, type Role } from "./plans.js";
import { prices, WSOL } from "./wallet.js";

const store = () => createStore();

// ---------- Settings ----------
export type Limits = { perTradeUsd: number; dailySpendUsd: number; dailyLossUsd: number };
export const DEFAULT_LIMITS: Limits = { perTradeUsd: 25, dailySpendUsd: 100, dailyLossUsd: 25 };
export const dailySignatures = () => (Number(process.env.AUTOPILOT_DAILY_SIGNATURES) >= 2 ? Math.floor(Number(process.env.AUTOPILOT_DAILY_SIGNATURES)) : 10);
const MAX_GRANT_MS = 31 * 86_400_000;
export function autopilotConfig(): { on: boolean; reason: string | null } {
  const off = (reason: string) => ({ on: false, reason });
  if (process.env.AUTOPILOT?.trim().toLowerCase() === "off") return off("The real auto-pilot is switched off on the server (AUTOPILOT=off).");
  const mx = moonwallet.moonxConfig();
  if (!mx.on) return off(`Wallets are not switched on: ${mx.reason}`);
  const sk = process.env.MOONX_SECRET_KEY?.trim() ?? "";
  if (!sk) return off("The real auto-pilot needs MOONX_SECRET_KEY in Vercel: the wallet app's secret key (moon_sk_...), from MoonPay's Embedded Wallets dashboard, Developer, API Keys.");
  if (!sk.startsWith("moon_sk_")) return off("MOONX_SECRET_KEY is not the wallet app's secret key: it should start with moon_sk_.");
  return { on: true, reason: null };
}

// ---------- Records ----------
type Settings = { on: boolean; limits: Limits; startedAt?: number; stoppedAt?: number; stopReason?: string; pausedDay?: string };
type Signer = { apiPub: string; privEnc: string; walletId: string; address: string; expiresAt: number; at: number; dead?: string };
type Day = { spent: number; pnl: number; sigs: number; buys: number; sells: number };
// What the auto-pilot holds for one of its agent's trades (key: the agent's position id).
type Holding = {
  positionId: string; mint: string; symbol: string; raw: string; costUsd: number; at: number;
  status: "open" | "failed"; error?: string;
  sellPending?: { fraction: number; closed: boolean; tries: number; error: string; at: number };
};
const settingsKey = (k: string) => `autopilot:${k}`;
const signerKey = (k: string) => `autopilot-signer:${k}`;
const pendingKey = (k: string) => `autopilot-pending-signer:${k}`;
const holdingsKey = (k: string) => `autopilot-holdings:${k}`;
const today = () => new Date().toISOString().slice(0, 10);
const dayKey = (k: string, d = today()) => `autopilot-day:${k}:${d}`;
const KEYS = "autopilot-accounts"; // customers who ever switched it on (the scheduler looks at these)

const shadow = (owner: string) => `${owner.toLowerCase()}${engine.REAL_SUFFIX}`;
export const agentAccount = shadow;
// Its agent's account as the app shows an account (Real mode's Agent log and Pipeline tabs read it).
export async function agentState(owner: string, access: { plan: PlanId; role: Role }) {
  return engine.withAccount(shadow(owner), async () => {
    await engine.ensureMigrated();
    await engine.sync();
    return engine.getState();
  }, access);
}
async function settings(owner: string): Promise<Settings> {
  return (await store().kvGet<Settings>(settingsKey(owner))) ?? { on: false, limits: { ...DEFAULT_LIMITS } };
}
const putSettings = (owner: string, s: Settings) => store().kvSet(settingsKey(owner), s);
async function day(owner: string): Promise<Day> {
  return (await store().kvGet<Day>(dayKey(owner))) ?? { spent: 0, pnl: 0, sigs: 0, buys: 0, sells: 0 };
}
const putDay = (owner: string, d: Day) => store().kvSet(dayKey(owner), d, { ttlMs: 3 * 86_400_000 });
async function holdings(owner: string): Promise<Record<string, Holding>> {
  return (await store().kvGet<Record<string, Holding>>(holdingsKey(owner))) ?? {};
}
const putHoldings = (owner: string, h: Record<string, Holding>) => store().kvSet(holdingsKey(owner), h);
async function remember(owner: string) {
  const list = (await store().kvGet<string[]>(KEYS)) ?? [];
  if (!list.includes(owner)) await store().kvSet(KEYS, [...list, owner]);
}

// The limits a customer may set: at least $10 a trade (an agent's smallest budget), no more than the
// app's cap on any real trade; the day's total at least one trade; the day's loss at least $1.
export function checkLimits(l: Partial<Limits>): Limits {
  const n = (v: unknown) => Math.round(Number(v) * 100) / 100;
  const perTradeUsd = n(l.perTradeUsd), dailySpendUsd = n(l.dailySpendUsd), dailyLossUsd = n(l.dailyLossUsd);
  const max = live.maxTradeUsd();
  if (!(perTradeUsd >= 10)) throw new Error("The amount per trade must be at least $10.");
  if (perTradeUsd > max) throw new Error(`The amount per trade can be at most $${max} while real trading is new.`);
  if (!(dailySpendUsd >= perTradeUsd)) throw new Error("The day's total must be at least one trade's amount.");
  if (dailySpendUsd > 10_000) throw new Error("The day's total can be at most $10,000.");
  if (!(dailyLossUsd >= 1)) throw new Error("The loss that pauses it must be at least $1.");
  if (dailyLossUsd > dailySpendUsd) throw new Error("The loss that pauses it can't be more than the day's total.");
  return { perTradeUsd, dailySpendUsd, dailyLossUsd };
}

// ---------- The signing key ----------
// Kept encrypted: AES-256-GCM with a key derived from AUTOPILOT_KEY (else MOONX_SECRET_KEY).
function encKey() {
  const secret = process.env.AUTOPILOT_KEY?.trim() || process.env.MOONX_SECRET_KEY?.trim() || "";
  if (!secret) throw new Error(autopilotConfig().reason ?? "No key to keep the auto-pilot's signing key with.");
  return Buffer.from(crypto.hkdfSync("sha256", secret, "trading-rust-autopilot", "signer-key", 32));
}
function seal(hex: string): string {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(Buffer.from(hex, "hex")), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}
function unseal(s: string): string {
  const [iv, tag, ct] = s.split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("hex");
}
function newKeyPair(): { pub: string; priv: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("hex");
  return { pub, priv };
}

// MoonPay's signing route (its server kit, loaded only when a signature is needed). Tests replace it.
type SignFn = (p: { apiPubHex: string; apiPrivHex: string; walletId: string; payloadHex: string }) => Promise<string>;
let signImpl: SignFn = async (p) => {
  const { MoonXClient } = await import("@moon-x/node-sdk");
  const mx = moonwallet.moonxConfig();
  const base = (process.env.MOONX_API_URL?.trim() || "https://api.moonx-dev.com").replace(/\/+$/, "");
  const client = new MoonXClient({ publishableKey: mx.publishableKey, secretKey: process.env.MOONX_SECRET_KEY!.trim(), issuer: base, baseUrl: base });
  const r = await client.ephemeralSigners.sign({ apiPubHex: p.apiPubHex, apiPrivHex: p.apiPrivHex, walletId: p.walletId, rawSigningPayloadHex: p.payloadHex });
  const sig = r.signature?.signature;
  if (!sig) throw new Error(`MoonPay signed in an unexpected way (${r.scheme}).`);
  return sig;
};
export function __setSignerForTests(f: SignFn | null) {
  if (f) signImpl = f;
}

// ---------- Signing a Solana transaction ----------
function compactU16(b: Buffer, at: number): { n: number; len: number } {
  let n = 0, len = 0;
  for (;;) {
    const byte = b[at + len];
    if (byte === undefined) throw new Error("Bad transaction");
    n |= (byte & 0x7f) << (7 * len);
    len++;
    if (!(byte & 0x80)) return { n, len };
  }
}
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
// Puts the wallet's signature (from MoonPay, through the granted signer) into Jupiter's unsigned
// transaction, after checking it really is the wallet's signature of exactly this transaction.
export async function signTransaction(txB64: string, signer: Signer, sign: (payloadHex: string) => Promise<string>): Promise<string> {
  const buf = Buffer.from(txB64, "base64");
  const sigs = compactU16(buf, 0);
  const msgAt = sigs.len + 64 * sigs.n;
  const msg = buf.subarray(msgAt);
  let i = msg[0] & 0x80 ? 1 : 0; // a versioned message starts with its version
  const required = msg[i];
  i += 3;
  const keys = compactU16(msg, i);
  i += keys.len;
  const me = moonwallet.base58(signer.address);
  let slot = -1;
  for (let k = 0; k < Math.min(required, keys.n); k++) if (msg.subarray(i + 32 * k, i + 32 * k + 32).equals(me)) slot = k;
  if (slot < 0 || slot >= sigs.n) throw new Error("This transaction is not for the auto-pilot's wallet.");
  const sig = Buffer.from(await sign(msg.toString("hex")), "hex");
  const pub = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, me]), format: "der", type: "spki" });
  if (sig.length !== 64 || !crypto.verify(null, msg, pub, sig)) throw new Error("MoonPay's signature does not check out for this wallet: nothing was sent.");
  sig.copy(buf, sigs.len + 64 * slot);
  return buf.toString("base64");
}

// ---------- Allowing it (the browser asks MoonPay to grant the signer) ----------
export async function grantStart(owner: string): Promise<{ apiPubHex: string; address: string; expiresAt: number }> {
  const c = autopilotConfig();
  if (!c.on) throw new Error(c.reason!);
  const w = await moonwallet.myWallet(owner);
  if (!w) throw new Error("Your wallets aren't made yet: open Wallet and sign in once to finish making them.");
  const k = newKeyPair();
  await store().kvSet(pendingKey(owner), { apiPub: k.pub, privEnc: seal(k.priv), at: Date.now() }, { ttlMs: 15 * 60_000 });
  // The browser grants it over this Solana wallet only, for 30 days.
  return { apiPubHex: k.pub, address: w.address, expiresAt: Date.now() + 30 * 86_400_000 };
}
// The browser granted it: MoonPay's sign-in tokens prove who it is, and MoonPay's own record which
// wallet the grant is over (it must be the Solana wallet on file for this account).
export async function grantFinish(owner: string, user: { email: string; moonxId?: string }, body: any) {
  const c = autopilotConfig();
  if (!c.on) throw new Error(c.reason!);
  const pending = await store().kvGet<{ apiPub: string; privEnc: string; at: number }>(pendingKey(owner));
  if (!pending || pending.apiPub !== String(body?.apiPubHex ?? "")) throw new Error("This permission request expired. Start again.");
  const m = await moonwallet.moonxSignIn(body?.accessToken, body?.identityToken);
  const mine = (user.moonxId && user.moonxId === m.sub) || (!!m.email && m.email === user.email.toLowerCase());
  if (!mine) throw new Error("Sign in to MoonPay with the same email as your account.");
  const w = await moonwallet.myWallet(owner);
  if (!w || m.wallets.solana !== w.address) throw new Error("MoonPay names another Solana wallet than the one on file for your account.");
  const walletId = String(body?.walletId ?? "");
  if (!walletId || m.walletIds.solana !== walletId) throw new Error("The permission must be for your Solana wallet.");
  const expiresAt = Number(body?.expiresAt);
  if (!(expiresAt > Date.now() + 3_600_000 && expiresAt <= Date.now() + MAX_GRANT_MS)) throw new Error("The permission must end between an hour and 31 days from now.");
  const signer: Signer = { apiPub: pending.apiPub, privEnc: pending.privEnc, walletId, address: w.address, expiresAt, at: Date.now() };
  await store().kvSet(signerKey(owner), signer);
  await store().kvDel(pendingKey(owner));
  await remember(owner);
  await audit(owner, "autopilot.allow", `Real auto-pilot allowed to sign for ${w.address.slice(0, 4)}…${w.address.slice(-4)} until ${new Date(expiresAt).toISOString().slice(0, 10)}`, { apiPub: signer.apiPub, expiresAt });
  return status(owner);
}
// Withdraws the permission: what it holds is sold first, then the key is forgotten. The browser
// also asks MoonPay to revoke the signer (with the public key returned here).
export async function revoke(owner: string, access?: Access) {
  const s = await store().kvGet<Signer>(signerKey(owner));
  await stop(owner, "Permission withdrawn", access).catch(() => null);
  await store().kvDel(signerKey(owner));
  await audit(owner, "autopilot.revoke", "Real auto-pilot permission withdrawn", { apiPub: s?.apiPub ?? null });
  return { apiPubHex: s?.apiPub ?? null, ...(await status(owner)) };
}

// ---------- Start, stop, limits ----------
type Access = { plan: PlanId; role: Role };
const BASE = {
  positionPct: 100, minConfidence: 0, analyzeEverySec: 1800, maxDrawdownPct: 25, breakEvenAtPct: 6, trailPct: 3, cooldownMin: 30, dailyLossPct: 10,
  maxDrop1hPct: 10, riskPerTradePct: 0, lockPct: 50, tf: "5m", checkEverySec: 5, goalUsd: 1e9, pick: "agent", strongMode: false, rewardRule: false,
  disabled: ["dailyLossPct", "cooldownMin", "maxDrawdownPct", "minConfidence", "maxDrop1hPct", "riskPerTradePct"],
};
export async function setLimits(owner: string, body: any) {
  const s = await settings(owner);
  s.limits = checkLimits({ ...s.limits, ...body });
  await putSettings(owner, s);
  await audit(owner, "autopilot.limits", `Real auto-pilot limits: $${s.limits.perTradeUsd} a trade, $${s.limits.dailySpendUsd} a day, pause after a $${s.limits.dailyLossUsd} loss`, s.limits as unknown as Record<string, unknown>);
  // A running agent trades with the new amount from its next trade.
  if (s.on) await startAgent(owner, s.limits, await accessOf(owner)).catch(() => null);
  return status(owner);
}
async function accessOf(owner: string): Promise<Access> {
  const u = await store().kvGet<{ plan?: PlanId; role?: Role }>(`user:${owner}`);
  return { plan: (u?.plan ?? "free") as PlanId, role: (u?.role ?? "user") as Role };
}
// (Re)starts the auto-pilot's one agent in its own account, with the per-trade amount as its budget.
async function startAgent(owner: string, limits: Limits, access: Access) {
  await engine.withAccount(shadow(owner), async () => {
    await engine.ensureMigrated();
    await engine.sync();
    const st = engine.getState();
    for (const b of [{ id: "1", bot: st.bot }, ...(st.bots ?? [])]) {
      if (b.bot.running) engine.stopBot("Restarted with new limits", b.id);
      if (b.id !== "1" && !st.positions.some((p) => p.source === "bot" && p.botId === b.id)) engine.removeBot(b.id);
    }
    if (engine.getState().available < limits.perTradeUsd) engine.reset(10_000); // (its own practice cash only)
    engine.startAutoAgents(BASE as unknown as engine.BotConfig, [limits.perTradeUsd], false, 1);
    await engine.flush();
  }, access);
}
export async function start(owner: string, access: Access, user: { tradeMode?: string }) {
  const c = autopilotConfig();
  if (!c.on) throw new Error(c.reason!);
  if (!can(access.plan, access.role, "bot.autopick")) throw new UpgradeNeeded("The auto-pilot runs an auto-pick agent, which is included from AI Pro.", firstPlanWith("bot.autopick"));
  if (user.tradeMode !== "real") throw new Error("Switch to Real in your profile first.");
  const signer = await usableSigner(owner);
  if (!signer) throw new Error("Allow automatic trading first.");
  const s = await settings(owner);
  const d = await day(owner);
  if (d.pnl <= -s.limits.dailyLossUsd) throw new Error(`Paused for today: it lost $${(-d.pnl).toFixed(2)}, your limit is $${s.limits.dailyLossUsd}. It can start again tomorrow (UTC).`);
  await startAgent(owner, s.limits, access);
  Object.assign(s, { on: true, startedAt: Date.now(), stopReason: undefined, pausedDay: undefined });
  await putSettings(owner, s);
  await remember(owner);
  await audit(owner, "autopilot.start", `Real auto-pilot started: $${s.limits.perTradeUsd} a trade, $${s.limits.dailySpendUsd} a day`, s.limits as unknown as Record<string, unknown>);
  return status(owner);
}
// Stops its agent; what it holds is sold first (its agent's trades are closed, which sells them for
// real). keepOn = a pause for the day (it starts again the next day).
export async function stop(owner: string, reason = "Stopped by you", access?: Access, keepOn = false) {
  const acc = access ?? (await accessOf(owner));
  await engine.withAccount(shadow(owner), async () => {
    await engine.ensureMigrated();
    await engine.sync();
    const st = engine.getState();
    for (const p of [...st.positions]) if (p.source === "bot") engine.sell(p.id, p.lastPrice, 1, `Auto-pilot: ${reason}`);
    for (const b of [{ id: "1", bot: st.bot }, ...(st.bots ?? [])]) if (b.bot.running) engine.stopBot(`Auto-pilot: ${reason}`, b.id);
    await engine.settleSteps(); // the sales above, for real
    await engine.flush();
  }, acc);
  const s = await settings(owner);
  if (s.on || keepOn) {
    Object.assign(s, keepOn ? { pausedDay: today(), stopReason: reason } : { on: false, stoppedAt: Date.now(), stopReason: reason, pausedDay: undefined });
    await putSettings(owner, s);
    await audit(owner, keepOn ? "autopilot.pause" : "autopilot.stop", `Real auto-pilot ${keepOn ? "paused for today" : "stopped"}: ${reason}`, { reason });
  }
  return status(owner);
}
async function usableSigner(owner: string): Promise<Signer | null> {
  const s = await store().kvGet<Signer>(signerKey(owner));
  return s && !s.dead && s.expiresAt > Date.now() ? s : null;
}

// ---------- Copying the agent's trades ----------
const chains = new Map<string, Promise<unknown>>();
// One customer's real trades go out one after another (a sale never overtakes its buy).
function queue<T>(owner: string, job: () => Promise<T>): Promise<T> {
  const next = (chains.get(owner) ?? Promise.resolve()).then(job, job);
  chains.set(owner, next.catch(() => null));
  return next;
}
const note = (owner: string, summary: string, data: Record<string, unknown> = {}) => audit(owner, "autopilot.skip", `Real auto-pilot: ${summary}`, data).catch(() => null);
const realUser = async (owner: string, wallet: string): Promise<live.RealUser> => ({ key: owner, plan: (await accessOf(owner)).plan, solanaAddress: wallet, tradeMode: "real" });

async function signWith(owner: string, signer: Signer, txB64: string, d: Day) {
  d.sigs++; // counted before asking: a signature MoonPay was asked for counts against its allowance
  await putDay(owner, d);
  try {
    return await signTransaction(txB64, signer, (payloadHex) => signImpl({ apiPubHex: signer.apiPub, apiPrivHex: unseal(signer.privEnc), walletId: signer.walletId, payloadHex }));
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/signer_not_provisioned|410/.test(msg)) await store().kvSet(signerKey(owner), { ...signer, dead: "MoonPay no longer holds the permission: allow automatic trading again." });
    if (/rate.?limit|429|too many/i.test(msg)) { d.sigs = Math.max(d.sigs, dailySignatures()); await putDay(owner, d); }
    throw e;
  }
}

export async function onAgentTrade(shadowKey: string, ev: engine.MirrorEvent) {
  const owner = engine.ownerOf(shadowKey);
  return queue(owner, () => (ev.side === "BUY" ? copyBuy(owner, ev) : copySell(owner, ev)));
}

async function copyBuy(owner: string, ev: engine.MirrorEvent) {
  const s = await settings(owner);
  const h = await holdings(owner);
  const skip = async (why: string) => {
    h[ev.positionId] = { positionId: ev.positionId, mint: ev.mint ?? "", symbol: ev.symbol, raw: "0", costUsd: 0, at: Date.now(), status: "failed", error: why };
    await putHoldings(owner, h);
    await note(owner, `skipped buying ${ev.symbol}: ${why}`, { positionId: ev.positionId });
    return null;
  };
  if (!autopilotConfig().on) return skip(autopilotConfig().reason!);
  if (!s.on || s.pausedDay === today()) return skip("it is not running");
  if (ev.chain !== "solana" || !ev.mint || !moonwallet.ADDRESS.solana.test(ev.mint)) return skip("only Solana coins are traded");
  const user = await store().kvGet<{ tradeMode?: string }>(`user:${owner}`);
  if (user?.tradeMode !== "real") return skip("your account is in Paper mode");
  const signer = await usableSigner(owner);
  const wallet = await moonwallet.myWallet(owner);
  if (!signer || !wallet || signer.address !== wallet.address) return skip("automatic trading is not allowed (or the permission ended)");
  if (signer.expiresAt < Date.now() + 3_600_000) return skip("the permission ends within the hour: allow it again to keep trading");
  const d = await day(owner);
  if (d.pnl <= -s.limits.dailyLossUsd) return skip(`today's loss limit ($${s.limits.dailyLossUsd}) is reached`);
  if (d.sigs + 2 > dailySignatures()) return skip(`MoonPay's ${dailySignatures()} signatures for today are used up (a buy keeps one for its sale)`);
  const usd = Math.floor(Math.min(s.limits.perTradeUsd, s.limits.dailySpendUsd - d.spent, ev.usd) * 100) / 100;
  if (!(usd >= 1)) return skip(`today's spending limit ($${s.limits.dailySpendUsd}) is used up`);
  const u = await realUser(owner, wallet.address);
  try {
    let q: Awaited<ReturnType<typeof live.realQuote>>;
    try {
      q = await live.realQuote(u, { side: "BUY", pay: "SOL", mint: ev.mint, symbol: ev.symbol, usd });
    } catch (e: any) {
      if (!/Not enough SOL/.test(String(e?.message))) throw e;
      q = await live.realQuote(u, { side: "BUY", pay: "USDC", mint: ev.mint, symbol: ev.symbol, usd }); // pays with USDC when there is not enough SOL
    }
    const signed = await signWith(owner, signer, q.transaction, d);
    const t = await live.realExecute(u, { requestId: q.requestId, signedTransaction: signed }, { auto: true });
    if (t.status !== "Success" || !t.outRaw || BigInt(t.outRaw) <= 0n) return skip(`the buy did not go through (${t.error ?? "no coins received"})`);
    const spent = t.usd ?? usd;
    Object.assign(d, { spent: d.spent + spent, buys: d.buys + 1 });
    await putDay(owner, d);
    h[ev.positionId] = { positionId: ev.positionId, mint: ev.mint, symbol: ev.symbol, raw: t.outRaw, costUsd: spent, at: Date.now(), status: "open" };
    await putHoldings(owner, h);
    return t;
  } catch (e: any) {
    return skip(String(e?.message ?? e).slice(0, 200));
  }
}

async function copySell(owner: string, ev: engine.MirrorEvent) {
  const h = await holdings(owner);
  const mine = h[ev.positionId];
  if (!mine) return null;
  if (mine.status !== "open") {
    delete h[ev.positionId]; // its buy was skipped or failed: there is nothing real to sell
    await putHoldings(owner, h);
    return null;
  }
  return sellHolding(owner, h, mine, ev.closed ? 1 : Math.min(1, Math.max(0, ev.fraction ?? 1)), !!ev.closed);
}
async function sellHolding(owner: string, h: Record<string, Holding>, mine: Holding, fraction: number, closed: boolean) {
  const raw = BigInt(mine.raw);
  const sellRaw = closed || fraction >= 0.999 ? raw : (raw * BigInt(Math.round(fraction * 10_000))) / 10_000n;
  const fail = async (why: string) => {
    mine.sellPending = { fraction, closed, tries: (mine.sellPending?.tries ?? 0) + 1, error: why, at: Date.now() };
    await putHoldings(owner, h);
    await note(owner, `selling ${mine.symbol} did not go through (it will be tried again): ${why}`, { positionId: mine.positionId });
    return null;
  };
  if (sellRaw <= 0n) return null;
  const signer = await usableSigner(owner);
  const wallet = await moonwallet.myWallet(owner);
  if (!autopilotConfig().on) return fail(autopilotConfig().reason!);
  if (!signer || !wallet || signer.address !== wallet.address) return fail("automatic trading is no longer allowed: sell it on the trade panel, or allow it again");
  const d = await day(owner);
  if (d.sigs + 1 > dailySignatures()) return fail(`MoonPay's ${dailySignatures()} signatures for today are used up`);
  const u = await realUser(owner, wallet.address);
  try {
    const q = await live.realQuote(u, { side: "SELL", pay: "SOL", mint: mine.mint, symbol: mine.symbol }, { rawAmount: sellRaw });
    const signed = await signWith(owner, signer, q.transaction, d);
    const t = await live.realExecute(u, { requestId: q.requestId, signedTransaction: signed }, { auto: true });
    if (t.status !== "Success") return fail(t.error ?? "the sale did not go through");
    const soldRaw = t.inRaw ? BigInt(t.inRaw) : sellRaw;
    const part = raw > 0n ? Number((soldRaw * 1_000_000n) / raw) / 1_000_000 : 1;
    const solPx = (await prices([WSOL]).catch(() => new Map())).get(WSOL)?.priceUsd ?? null;
    const proceeds = solPx ? t.outAmount * solPx : (t.usd ?? 0);
    const cost = mine.costUsd * Math.min(1, part);
    const pnl = Math.round((proceeds - cost) * 100) / 100;
    Object.assign(d, { pnl: Math.round((d.pnl + pnl) * 100) / 100, sells: d.sells + 1 });
    await putDay(owner, d);
    const left = raw - soldRaw;
    if (closed || left <= 0n) delete h[mine.positionId];
    else Object.assign(mine, { raw: left.toString(), costUsd: mine.costUsd - cost, sellPending: undefined });
    await putHoldings(owner, h);
    const s = await settings(owner);
    if (s.on && d.pnl <= -s.limits.dailyLossUsd && s.pausedDay !== today()) {
      // The day's loss limit: paused at once (no buy is copied from here on), then its agent is
      // stopped and what it still holds is sold (not awaited from inside its own queue).
      const why = `today's loss reached $${(-d.pnl).toFixed(2)} (your limit is $${s.limits.dailyLossUsd})`;
      await putSettings(owner, { ...s, pausedDay: today(), stopReason: why });
      void stop(owner, why, undefined, true).catch((e) => console.error("[autopilot] pause:", e));
    }
    return t;
  } catch (e: any) {
    return fail(String(e?.message ?? e).slice(0, 200));
  }
}

// ---------- Every minute (the scheduler) ----------
// Sales that did not go through are tried again; a customer paused for yesterday's losses starts again.
export async function everyMinute() {
  if (!autopilotConfig().on) return { checked: 0 };
  const owners = (await store().kvGet<string[]>(KEYS)) ?? [];
  for (const owner of owners) {
    await queue(owner, async () => {
      const h = await holdings(owner);
      for (const mine of Object.values(h)) {
        const p = mine.sellPending;
        if (mine.status === "open" && p && p.tries < 50 && Date.now() - p.at > 60_000) await sellHolding(owner, h, mine, p.fraction, p.closed);
      }
    }).catch((e) => console.error("[autopilot] retry:", e));
    const s = await settings(owner);
    if (s.on && s.pausedDay && s.pausedDay !== today()) {
      const access = await accessOf(owner);
      await startAgent(owner, s.limits, access).then(async () => {
        s.pausedDay = undefined;
        s.stopReason = undefined;
        await putSettings(owner, s);
        await audit(owner, "autopilot.start", "Real auto-pilot started again: a new day", {});
      }).catch((e) => console.error("[autopilot] resume:", e));
    }
  }
  return { checked: owners.length };
}

// ---------- What the app shows ----------
export async function status(owner: string) {
  const c = autopilotConfig();
  const [s, signer, d, h, trades] = await Promise.all([settings(owner), store().kvGet<Signer>(signerKey(owner)), day(owner), holdings(owner), live.realTrades(owner, 100)]);
  const agent = await engine.withAccount(shadow(owner), async () => {
    await engine.sync();
    const st = engine.getState();
    const bots = [{ id: "1", bot: st.bot }, ...(st.bots ?? [])];
    const run = bots.find((b) => b.bot.running);
    return {
      running: !!run,
      watching: run?.bot.config?.symbol || null,
      positions: st.positions.filter((p) => p.source === "bot").map((p) => ({ id: p.id, symbol: p.symbol, entryPrice: p.entryPrice, lastPrice: p.lastPrice, changePct: p.entryPrice > 0 ? ((p.lastPrice - p.entryPrice) / p.entryPrice) * 100 : 0 })),
    };
  }).catch(() => ({ running: false, watching: null, positions: [] as { id: string; symbol: string; entryPrice: number; lastPrice: number; changePct: number }[] }));
  const open = Object.values(h).filter((x) => x.status === "open").map((x) => ({ symbol: x.symbol, costUsd: x.costUsd, at: x.at, changePct: agent.positions.find((p) => p.id === x.positionId)?.changePct ?? null, sellError: x.sellPending?.error ?? null }));
  return {
    available: c.on, reason: c.reason,
    on: s.on, paused: !!s.on && s.pausedDay === today(), stopReason: s.stopReason ?? null, limits: s.limits, maxPerTradeUsd: live.maxTradeUsd(),
    allowed: signer && !signer.dead && signer.expiresAt > Date.now() ? { address: signer.address, expiresAt: signer.expiresAt } : null,
    allowProblem: signer?.dead ?? (signer && signer.expiresAt <= Date.now() ? "The permission has ended: allow automatic trading again." : null),
    today: { spentUsd: d.spent, pnlUsd: d.pnl, signatures: d.sigs, signatureLimit: dailySignatures(), buys: d.buys, sells: d.sells },
    agent: { running: agent.running, watching: agent.watching },
    holding: open,
    trades: trades.filter((t) => t.auto).slice(0, 10),
  };
}
export type AutopilotStatus = Awaited<ReturnType<typeof status>>;
