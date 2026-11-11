// The user's real Solana wallet (read-only): SOL and token balances with USD values.
// Balances come from a Solana RPC (SOLANA_RPC_URL, e.g. Helius; the public endpoint is the
// fallback and is rate-limited). Prices come from DexScreener. Nothing here moves money.
import { cachedJson } from "./data.js";

const RPC = () => process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Solana RPC ${r.status}${r.status === 429 || r.status === 403 ? " (busy: add a Helius RPC URL as SOLANA_RPC_URL)" : ""}`);
  const j = await r.json();
  if (j.error) throw new Error(`Solana RPC: ${j.error.message ?? "error"}`);
  return j.result as T;
}

export type Holding = { mint: string; symbol: string; name: string; amount: number; priceUsd: number | null; valueUsd: number | null; imageUrl?: string; pool?: string; chain?: string };
export type WalletView = { address: string; holdings: Holding[]; totalUsd: number; updatedAt: number; rpc: "custom" | "public" };

// Best (most liquid) DexScreener price per token mint, up to 30 mints per request.
async function prices(mints: string[]) {
  const out = new Map<string, { priceUsd: number; symbol: string; name: string; imageUrl?: string; pool: string }>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const j = await cachedJson<any>(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, 30_000, { retries: 1 });
      for (const p of j.pairs ?? []) {
        if (p.chainId !== "solana") continue;
        const mint = p.baseToken?.address;
        if (!chunk.includes(mint)) continue;
        const liq = Number(p.liquidity?.usd ?? 0);
        const cur = out.get(mint) as any;
        if (Number.isFinite(Number(p.priceUsd)) && Number(p.priceUsd) > 0 && (!cur || liq > cur._liq))
          out.set(mint, Object.assign({ priceUsd: Number(p.priceUsd), symbol: p.baseToken.symbol, name: p.baseToken.name, imageUrl: p.info?.imageUrl, pool: p.pairAddress }, { _liq: liq }));
      }
    } catch {
      // prices are best-effort: balances still show without them
    }
  }
  return out;
}

const cache = new Map<string, { at: number; view: WalletView }>();

export async function walletView(address: string, fresh = false): Promise<WalletView> {
  if (!BASE58.test(address)) throw new Error("No Solana wallet on this account yet");
  const hit = cache.get(address);
  if (!fresh && hit && Date.now() - hit.at < 15_000) return hit.view;

  const [lamports, ...tokenLists] = await Promise.all([
    rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]),
    rpc<{ value: any[] }>("getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed", commitment: "confirmed" }]),
    rpc<{ value: any[] }>("getTokenAccountsByOwner", [address, { programId: TOKEN_2022 }, { encoding: "jsonParsed", commitment: "confirmed" }]),
  ]);
  // Sum each mint across its token accounts; skip empty ones.
  const amounts = new Map<string, number>();
  for (const list of tokenLists)
    for (const acc of list.value ?? []) {
      const info = acc.account?.data?.parsed?.info;
      const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
      if (info?.mint && amt > 0) amounts.set(info.mint, (amounts.get(info.mint) ?? 0) + amt);
    }
  const sol = lamports.value / 1e9;
  const px = await prices([WSOL, ...amounts.keys()]);
  const stable = (m: string) => m === USDC || m === USDT;
  const holdings: Holding[] = [];
  const solPx = px.get(WSOL)?.priceUsd ?? null;
  holdings.push({ mint: WSOL, symbol: "SOL", name: "Solana", amount: sol, priceUsd: solPx, valueUsd: solPx === null ? null : sol * solPx, chain: "solana" });
  for (const [mint, amount] of amounts) {
    const p = px.get(mint);
    const price = stable(mint) ? 1 : (p?.priceUsd ?? null);
    holdings.push({
      mint, amount, priceUsd: price, valueUsd: price === null ? null : amount * price,
      symbol: mint === WSOL ? "wSOL" : mint === USDC ? "USDC" : mint === USDT ? "USDT" : (p?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`),
      name: mint === WSOL ? "Wrapped SOL" : mint === USDC ? "USD Coin" : mint === USDT ? "Tether USD" : (p?.name ?? "Unknown token"),
      imageUrl: p?.imageUrl, pool: p?.pool, chain: "solana",
    });
  }
  holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const view: WalletView = {
    address,
    holdings,
    totalUsd: holdings.reduce((s, h) => s + (Number.isFinite(h.valueUsd) ? (h.valueUsd as number) : 0), 0),
    updatedAt: Date.now(),
    rpc: process.env.SOLANA_RPC_URL ? "custom" : "public",
  };
  cache.set(address, { at: Date.now(), view });
  return view;
}
