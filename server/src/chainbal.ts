// What is in a customer's wallets, on each network, read from public blockchain nodes. Only the
// wallet's public address is sent to them (it is public on the blockchain anyway). A network that
// does not answer shows no figure (null), never a made-up zero.
import type { Chain, ChainWallet } from "./moonwallet.js";

export type BalanceRow = { network: string; symbol: string; amount: number | null; usd?: number | null; test?: boolean };

// The Ethereum wallet's one address works on all of these (the "EVM" networks), each with its own coin.
export const EVM_NETWORKS = [
  { network: "Ethereum", symbol: "ETH", rpc: "https://ethereum-rpc.publicnode.com" },
  { network: "BNB Chain", symbol: "BNB", rpc: "https://bsc-rpc.publicnode.com" },
  { network: "Base", symbol: "ETH", rpc: "https://base-rpc.publicnode.com" },
  { network: "Polygon", symbol: "POL", rpc: "https://polygon-bor-rpc.publicnode.com" },
  { network: "Arbitrum", symbol: "ETH", rpc: "https://arbitrum-one-rpc.publicnode.com" },
  { network: "Optimism", symbol: "ETH", rpc: "https://optimism-rpc.publicnode.com" },
  { network: "Avalanche", symbol: "AVAX", rpc: "https://avalanche-c-chain-rpc.publicnode.com" },
];
// In test mode MoonPay delivers test coins on test networks: SOL on Solana's devnet, ETH on Sepolia.
const SEPOLIA = "https://ethereum-sepolia-rpc.publicnode.com";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

let get = async (url: string, init?: RequestInit): Promise<any> => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
export function __setFetchForTests(f: (url: string, init?: RequestInit) => Promise<any>) {
  get = f;
  cache.clear();
  priceCache = null;
}

// Dollar prices: Coinbase's public rates (one call for all the coins), TRX from OKX (Coinbase has
// none). Kept a minute. A coin with no price counts as unknown in the total, never as zero.
let priceCache: { at: number; px: Record<string, number> } | null = null;
export async function usdPrices(): Promise<Record<string, number>> {
  if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache.px;
  const px: Record<string, number> = {};
  try {
    const rates = (await get("https://api.coinbase.com/v2/exchange-rates?currency=USD"))?.data?.rates ?? {};
    for (const sym of ["SOL", "ETH", "BNB", "POL", "AVAX", "BTC", "USDT", "USDC"]) {
      const r = Number(rates[sym]);
      if (r > 0) px[sym] = 1 / r;
    }
  } catch { /* no prices from Coinbase just now */ }
  try {
    const last = Number((await get("https://www.okx.com/api/v5/market/ticker?instId=TRX-USDT"))?.data?.[0]?.last);
    if (last > 0) px.TRX = last * (px.USDT ?? 1);
  } catch { /* no TRX price just now */ }
  if (Object.keys(px).length) priceCache = { at: Date.now(), px };
  return px;
}
// The dollar value of everything in the wallets. Test coins are worth nothing and are left out.
// complete = false when a network did not answer or a coin held has no price (the total is then a floor).
export function totalUsd(b: Partial<Record<Chain, BalanceRow[]>>): { totalUsd: number; complete: boolean } {
  let total = 0, complete = true;
  for (const rows of Object.values(b)) for (const r of rows ?? []) {
    if (r.test) continue;
    if (r.amount === null) { complete = false; continue; }
    if (r.amount === 0) continue;
    if (typeof r.usd === "number") total += r.usd;
    else complete = false;
  }
  return { totalUsd: Math.round(total * 100) / 100, complete };
}
const safe = async (f: () => Promise<number | null>): Promise<number | null> => {
  try {
    const v = await f();
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
};
const evmBalance = (rpc: string, address: string) =>
  safe(async () => {
    const j = await get(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }) });
    return typeof j?.result === "string" ? Number(BigInt(j.result)) / 1e18 : null;
  });
const solBalance = (address: string, sandbox: boolean) =>
  safe(async () => {
    const url = sandbox ? "https://api.devnet.solana.com" : process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
    const j = await get(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }) });
    return typeof j?.result?.value === "number" ? j.result.value / 1e9 : null;
  });

async function rowsFor(w: ChainWallet, sandbox: boolean): Promise<BalanceRow[]> {
  if (w.chain === "solana") return [{ network: sandbox ? "Solana test network (devnet)" : "Solana", symbol: "SOL", amount: await solBalance(w.address, sandbox), ...(sandbox ? { test: true } : {}) }];
  if (w.chain === "ethereum") {
    const rows = await Promise.all(EVM_NETWORKS.map(async (n) => ({ network: n.network, symbol: n.symbol, amount: await evmBalance(n.rpc, w.address) })));
    return sandbox ? [...rows, { network: "Ethereum test network (Sepolia)", symbol: "ETH", amount: await evmBalance(SEPOLIA, w.address), test: true }] : rows;
  }
  if (w.chain === "bitcoin") {
    const amount = await safe(async () => {
      const j = await get(`https://mempool.space/api/address/${encodeURIComponent(w.address)}`);
      const s = (x: any) => (Number(x?.funded_txo_sum) || 0) - (Number(x?.spent_txo_sum) || 0);
      return j?.chain_stats ? (s(j.chain_stats) + s(j.mempool_stats)) / 1e8 : null;
    });
    return [{ network: "Bitcoin", symbol: "BTC", amount }];
  }
  // Tron: TRX, and USDT (the coin most people hold on Tron). An account never used has no record: 0.
  const acct = await get(`https://api.trongrid.io/v1/accounts/${encodeURIComponent(w.address)}`).catch(() => null);
  const rec = Array.isArray(acct?.data) ? acct.data[0] : undefined;
  const trx = acct && Array.isArray(acct.data) ? (Number(rec?.balance) || 0) / 1e6 : null;
  const usdtRaw = acct && Array.isArray(acct.data) ? (rec?.trc20 ?? []).map((t: Record<string, string>) => t[TRON_USDT]).find((v: unknown) => v !== undefined) ?? "0" : null;
  return [
    { network: "Tron", symbol: "TRX", amount: trx },
    { network: "Tron", symbol: "USDT", amount: usdtRaw === null ? null : Number(usdtRaw) / 1e6 },
  ];
}

// Each wallet's balances (kept 30 seconds per wallet, so reopening the window does not ask again).
const cache = new Map<string, { at: number; rows: BalanceRow[] }>();
export async function balances(wallets: ChainWallet[], sandbox: boolean, fresh = false): Promise<Partial<Record<Chain, BalanceRow[]>>> {
  const out: Partial<Record<Chain, BalanceRow[]>> = {};
  const pricesP = usdPrices().catch(() => ({} as Record<string, number>));
  await Promise.all(wallets.map(async (w) => {
    const k = `${w.chain}:${w.address}:${sandbox}`;
    const hit = cache.get(k);
    if (!fresh && hit && Date.now() - hit.at < 30_000) return void (out[w.chain] = hit.rows);
    const rows = await rowsFor(w, sandbox);
    if (rows.some((r) => r.amount !== null)) cache.set(k, { at: Date.now(), rows });
    out[w.chain] = rows;
  }));
  const px = await pricesP;
  for (const rows of Object.values(out)) for (const r of rows ?? [])
    r.usd = r.test || r.amount === null || px[r.symbol] === undefined ? null : Math.round(r.amount * px[r.symbol] * 100) / 100;
  return out;
}
