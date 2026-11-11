// Real trades from the user's own Solana wallet (Privy embedded wallet), through Jupiter Swap V2.
//
// 1. quote:   the server asks Jupiter for an order (an unsigned swap transaction for the user's
//             wallet), checks balances and limits, and keeps the order for 2 minutes.
// 2. sign:    the browser shows the summary; the user approves and signs it with Privy.
//             The server never holds keys and can't sign anything.
// 3. execute: the server checks the signed transaction is exactly the one it quoted, then hands it
//             to Jupiter, which broadcasts it. The result (with its on-chain signature) is recorded.
//
// Settings (Vercel): JUPITER_API_KEY (optional, raises Jupiter's rate limit),
// JUP_REFERRAL_ACCOUNT (optional: turns the platform fee on), REAL_MAX_TRADE_USD (default 100).
import { createStore } from "./store.js";
import { audit } from "./audit.js";
import { month, planOf, type PlanId } from "./plans.js";
import { BASE58, prices, rpc, USDC, WSOL } from "./wallet.js";
import { noteCommunityBuy } from "./lists.js";

const store = createStore();
const JUP = () => (process.env.JUPITER_API_URL?.trim() || "https://api.jup.ag/swap/v2").replace(/\/$/, "");
const jupHeaders = (): Record<string, string> => ({ "content-type": "application/json", ...(process.env.JUPITER_API_KEY?.trim() ? { "x-api-key": process.env.JUPITER_API_KEY.trim() } : {}) });
export const maxTradeUsd = () => (Number(process.env.REAL_MAX_TRADE_USD) > 0 ? Number(process.env.REAL_MAX_TRADE_USD) : 100);
const SOL_RESERVE = 10_000_000n; // 0.01 SOL kept back for network fees when paying with SOL
const QUOTE_TTL_MS = 120_000;

export type Pay = "SOL" | "USDC";
const PAY_MINT: Record<Pay, string> = { SOL: WSOL, USDC };
const PAY_DEC: Record<Pay, number> = { SOL: 9, USDC: 6 };

export type RealUser = { key: string; plan: PlanId; solanaAddress?: string | null; tradeMode?: string };
type Pending = {
  key: string; owner: string; tx: string; side: "BUY" | "SELL"; pay: Pay; mint: string; symbol: string;
  inputMint: string; outputMint: string; inAmount: string; outAmount: string; inDec: number; outDec: number;
  usd: number | null; feeBps: number; at: number;
};
export type RealTrade = {
  t: number; side: "BUY" | "SELL"; symbol: string; mint: string; pay: Pay; status: "Success" | "Failed";
  signature: string | null; inAmount: number; outAmount: number; inSymbol: string; outSymbol: string;
  usd: number | null; feeBps: number; error?: string;
};

const ui = (raw: string | bigint, dec: number) => Number(BigInt(raw)) / 10 ** dec;

// Raw balance (smallest units) of one mint in the wallet; SOL is the native balance.
async function balanceRaw(owner: string, mint: string): Promise<{ raw: bigint; decimals: number }> {
  if (mint === WSOL) {
    const r = await rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
    return { raw: BigInt(r.value), decimals: 9 };
  }
  const r = await rpc<{ value: any[] }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  let raw = 0n;
  let decimals = -1;
  for (const acc of r.value ?? []) {
    const ta = acc.account?.data?.parsed?.info?.tokenAmount;
    if (!ta) continue;
    raw += BigInt(ta.amount);
    decimals = Number(ta.decimals);
  }
  return { raw, decimals: decimals >= 0 ? decimals : await tokenDecimals(mint) };
}

const decCache = new Map<string, number>([[WSOL, 9], [USDC, 6]]);
async function tokenDecimals(mint: string) {
  const hit = decCache.get(mint);
  if (hit !== undefined) return hit;
  const r = await rpc<{ value: { decimals: number } }>("getTokenSupply", [mint]);
  decCache.set(mint, r.value.decimals);
  return r.value.decimals;
}

// The platform fee on a real trade (Jupiter referral fee: 50-255 bps, Jupiter keeps 20% of it).
// Off until JUP_REFERRAL_ACCOUNT is set; plan allowances of free trades apply first.
async function platformFee(key: string, plan: PlanId): Promise<{ bps: number; note: string }> {
  const p = planOf(plan);
  if (p.feePct <= 0) return { bps: 0, note: `No platform fee on ${p.name}` };
  const used = (await store.kvGet<number>(`real-count:${key}:${month()}`)) ?? 0;
  if (used < p.freeTrades) return { bps: 0, note: `Free trade (${used + 1} of ${p.freeTrades} this month)` };
  const bps = Math.round(p.feePct * 100);
  if (!process.env.JUP_REFERRAL_ACCOUNT?.trim()) return { bps: 0, note: "No platform fee" };
  if (bps < 50) return { bps: 0, note: `No platform fee on ${p.name}` }; // below Jupiter's referral minimum
  return { bps: Math.min(255, bps), note: `${p.feePct}% platform fee` };
}

function checkUser(u: RealUser) {
  if (u.tradeMode !== "real") throw new Error("Switch to Real in your profile first.");
  if (!u.solanaAddress || !BASE58.test(u.solanaAddress)) throw new Error("Your wallet isn't ready yet. Sign out and back in.");
  return u.solanaAddress;
}

export async function realQuote(u: RealUser, body: any) {
  const owner = checkUser(u);
  const side: "BUY" | "SELL" = body?.side === "SELL" ? "SELL" : "BUY";
  const pay: Pay = body?.pay === "USDC" ? "USDC" : "SOL";
  const mint = String(body?.mint ?? "");
  const symbol = String(body?.symbol ?? "").slice(0, 20) || mint.slice(0, 4);
  if (!BASE58.test(mint)) throw new Error("Pick a Solana coin to trade.");
  if (mint === PAY_MINT[pay]) throw new Error(`You can't trade ${pay} for itself. Pay with the other one.`);
  const max = maxTradeUsd();
  const px = await prices([WSOL, mint]);
  const solPx = px.get(WSOL)?.priceUsd ?? null;
  const tokenPx = px.get(mint)?.priceUsd ?? null;

  let inputMint: string, outputMint: string, amountRaw: bigint, usd: number | null, inDec: number, outDec: number;
  if (side === "BUY") {
    usd = Number(body?.usd);
    if (!(usd >= 1)) throw new Error("Enter at least $1.");
    if (usd > max) throw new Error(`Real trades are limited to $${max} each while real trading is new.`);
    const payPx = pay === "SOL" ? solPx : 1;
    if (!payPx) throw new Error("No SOL price right now. Try again in a moment.");
    inDec = PAY_DEC[pay];
    amountRaw = BigInt(Math.floor((usd / payPx) * 10 ** inDec));
    const bal = await balanceRaw(owner, PAY_MINT[pay]);
    const avail = pay === "SOL" ? bal.raw - SOL_RESERVE : bal.raw;
    if (amountRaw > avail) {
      const haveUsd = Math.max(0, ui(avail > 0n ? avail : 0n, inDec) * payPx);
      throw new Error(`Not enough ${pay}: about $${haveUsd.toFixed(2)} available${pay === "SOL" ? " (0.01 SOL is kept for network fees)" : ""}. Deposit more or pay with the other one.`);
    }
    inputMint = PAY_MINT[pay];
    outputMint = mint;
    outDec = await tokenDecimals(mint);
  } else {
    const pct = Number(body?.pct);
    if (!(pct > 0 && pct <= 100)) throw new Error("Pick how much to sell.");
    const bal = await balanceRaw(owner, mint);
    if (bal.raw === 0n) throw new Error(`You don't hold any ${symbol} in your wallet.`);
    amountRaw = pct >= 100 ? bal.raw : (bal.raw * BigInt(Math.round(pct * 100))) / 10_000n;
    if (amountRaw === 0n) throw new Error("That amount is too small to sell.");
    inDec = bal.decimals;
    usd = tokenPx ? ui(amountRaw, inDec) * tokenPx : null;
    if (usd !== null && usd > max) throw new Error(`Real trades are limited to $${max} each while real trading is new. Sell a smaller part.`);
    inputMint = mint;
    outputMint = PAY_MINT[pay];
    outDec = PAY_DEC[pay];
  }

  const fee = await platformFee(u.key, u.plan);
  const q = new URLSearchParams({ inputMint, outputMint, amount: amountRaw.toString(), taker: owner });
  const slip = Number(body?.slippageBps);
  if (slip >= 1 && slip <= 1000) q.set("slippageBps", String(Math.round(slip)));
  if (fee.bps > 0) {
    q.set("referralAccount", process.env.JUP_REFERRAL_ACCOUNT!.trim());
    q.set("referralFee", String(fee.bps));
  }
  const r = await fetch(`${JUP()}/order?${q}`, { headers: jupHeaders(), signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.transaction) {
    const why = j.errorMessage || j.error || (r.status === 429 ? "Jupiter is busy, try again in a few seconds" : `Jupiter ${r.status}`);
    throw new Error(`Couldn't get a price: ${why}`);
  }
  const pending: Pending = {
    key: u.key, owner, tx: j.transaction, side, pay, mint, symbol, inputMint, outputMint,
    inAmount: String(j.inAmount ?? amountRaw), outAmount: String(j.outAmount ?? 0), inDec, outDec, usd, feeBps: fee.bps, at: Date.now(),
  };
  await store.kvSet(`real-order:${j.requestId}`, pending, { ttlMs: QUOTE_TTL_MS });
  const networkLamports = Number(j.signatureFeeLamports ?? 0) + Number(j.prioritizationFeeLamports ?? 0) + Number(j.rentFeeLamports ?? 0);
  return {
    requestId: String(j.requestId),
    transaction: String(j.transaction),
    side, pay, symbol, mint,
    inAmount: ui(pending.inAmount, inDec),
    outAmount: ui(pending.outAmount, outDec),
    inSymbol: side === "BUY" ? pay : symbol,
    outSymbol: side === "BUY" ? symbol : pay,
    usd,
    priceImpactPct: Number(j.priceImpact ?? 0), // Jupiter V2 gives this in percent already
    slippageBps: j.slippageBps ?? null,
    router: j.router ?? null,
    swapFeeBps: Number(j.feeBps ?? 0),
    platformFee: fee,
    networkFeeSol: networkLamports / 1e9,
    gasless: !!j.gasless,
    expiresAt: Date.now() + 60_000,
    maxTradeUsd: max,
  };
}

// The message part of a serialized transaction (everything after the signatures).
function messageOf(b: Buffer) {
  let n = 0;
  let shift = 0;
  let i = 0;
  for (;;) {
    const byte = b[i++];
    if (byte === undefined) throw new Error("Bad transaction");
    n |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return b.subarray(i + 64 * n);
}

export async function realExecute(u: RealUser, body: any) {
  checkUser(u);
  const requestId = String(body?.requestId ?? "");
  const signed = String(body?.signedTransaction ?? "");
  const p = requestId ? await store.kvGet<Pending>(`real-order:${requestId}`) : null;
  if (!p || p.key !== u.key) throw new Error("This price expired. Get a new one.");
  // Only the exact transaction we quoted may go out, signed by this user's wallet.
  let same = false;
  try {
    same = messageOf(Buffer.from(signed, "base64")).equals(messageOf(Buffer.from(p.tx, "base64")));
  } catch {
    same = false;
  }
  if (!same) throw new Error("The signed transaction doesn't match the price you saw. Get a new one.");
  await store.kvDel(`real-order:${requestId}`); // one use only

  const r = await fetch(`${JUP()}/execute`, {
    method: "POST",
    headers: jupHeaders(),
    body: JSON.stringify({ signedTransaction: signed, requestId }),
    signal: AbortSignal.timeout(60_000),
  });
  const j: any = await r.json().catch(() => ({}));
  const ok = r.ok && j.status === "Success";
  const inRaw = j.inputAmountResult ?? j.totalInputAmount ?? p.inAmount;
  const outRaw = j.outputAmountResult ?? j.totalOutputAmount ?? p.outAmount;
  const trade: RealTrade = {
    t: Date.now(), side: p.side, symbol: p.symbol, mint: p.mint, pay: p.pay, status: ok ? "Success" : "Failed",
    signature: j.signature ?? null,
    inAmount: ui(String(inRaw), p.inDec), outAmount: ui(String(outRaw), p.outDec),
    inSymbol: p.side === "BUY" ? p.pay : p.symbol, outSymbol: p.side === "BUY" ? p.symbol : p.pay,
    usd: p.usd, feeBps: p.feeBps,
    ...(ok ? {} : { error: String(j.error ?? j.errorMessage ?? j.code ?? `Jupiter ${r.status}`).slice(0, 200) }),
  };
  try {
    await store.listPush(`real-trades:${u.key}`, trade);
  } catch (e) {
    console.error("[real] history write failed:", e);
  }
  const what = `${trade.side === "BUY" ? "Bought" : "Sold"} ${trade.side === "BUY" ? trade.outAmount : trade.inAmount} ${trade.symbol} for ${trade.side === "BUY" ? trade.inAmount : trade.outAmount} ${trade.pay}`;
  await audit(u.key, ok ? "trade.real" : "trade.real_failed", ok ? `Real: ${what}` : `Real ${trade.side.toLowerCase()} of ${trade.symbol} failed: ${trade.error}`, trade as unknown as Record<string, unknown>);
  if (ok && p.side === "BUY") await noteCommunityBuy(u.key, { chain: "solana", tokenAddress: p.mint, symbol: p.symbol, pool: "" });
  if (ok) {
    const k = `real-count:${u.key}:${month()}`;
    await store.kvSet(k, ((await store.kvGet<number>(k)) ?? 0) + 1);
  }
  return trade;
}

export async function realTrades(key: string, limit = 50) {
  const k = `real-trades:${key}`;
  const len = await store.listLen(k);
  if (!len) return [];
  return (await store.listRange<RealTrade>(k, Math.max(0, len - limit), len - 1)).reverse();
}
