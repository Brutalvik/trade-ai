// Market data from free public APIs (no keys needed):
//  - DexScreener: token search + live price
//  - GeckoTerminal: OHLCV candles + trending pools
// FOMO (fomo.family) trades on-chain Solana tokens, so the same pools are
// visible here. FOMO itself has no public trading/data API.

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type PairInfo = {
  chain: string;
  pool: string;
  symbol: string;
  name: string;
  tokenAddress: string;
  priceUsd: number;
  change: { m5: number; h1: number; h6: number; h24: number };
  volume24h: number;
  liquidityUsd: number;
  marketCap: number;
  imageUrl?: string;
  dex?: string;
};

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

const TF_MAP: Record<Timeframe, { unit: string; agg: number }> = {
  "1m": { unit: "minute", agg: 1 },
  "5m": { unit: "minute", agg: 5 },
  "15m": { unit: "minute", agg: 15 },
  "1h": { unit: "hour", agg: 1 },
  "4h": { unit: "hour", agg: 4 },
  "1d": { unit: "day", agg: 1 },
};

// DexScreener chain ids -> GeckoTerminal network ids
const GT_NETWORK: Record<string, string> = { solana: "solana", ethereum: "eth", bsc: "bsc", base: "base", arbitrum: "arbitrum" };

const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

// GeckoTerminal's free tier allows ~30 calls/min, so space its calls out.
const GAP_MS: Record<string, number> = { "api.geckoterminal.com": 2200, "api.dexscreener.com": 250 };
const nextSlot = new Map<string, number>();
async function throttle(host: string) {
  const gap = GAP_MS[host] ?? 0;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + gap);
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

async function fetchJson(url: string, retries = 1): Promise<unknown> {
  const host = new URL(url).host;
  await throttle(host);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 429 && retries > 0) {
    await new Promise((r) => setTimeout(r, 4000));
    return fetchJson(url, retries - 1);
  }
  if (!res.ok) throw new Error(`${res.status} from ${host}${res.status === 429 ? " (rate limited, try again shortly)" : ""}`);
  return res.json();
}

async function cachedJson<T>(url: string, ttlMs: number): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  if (!inflight.has(url)) {
    inflight.set(
      url,
      fetchJson(url)
        .then((value) => {
          cache.set(url, { at: Date.now(), value });
          return value;
        })
        .finally(() => inflight.delete(url)),
    );
  }
  try {
    return (await inflight.get(url)) as T;
  } catch (e) {
    if (hit) return hit.value as T; // serve stale data rather than nothing
    throw e;
  }
}

const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

function fromDexScreener(p: any): PairInfo {
  return {
    chain: p.chainId,
    pool: p.pairAddress,
    symbol: p.baseToken?.symbol ?? "?",
    name: p.baseToken?.name ?? "",
    tokenAddress: p.baseToken?.address ?? "",
    priceUsd: num(p.priceUsd),
    change: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
    volume24h: num(p.volume?.h24),
    liquidityUsd: num(p.liquidity?.usd),
    marketCap: num(p.marketCap ?? p.fdv),
    imageUrl: p.info?.imageUrl,
    dex: p.dexId,
  };
}

export async function searchPairs(q: string): Promise<PairInfo[]> {
  const data = await cachedJson<any>(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, 30_000);
  return (data.pairs ?? [])
    .filter((p: any) => GT_NETWORK[p.chainId])
    .map(fromDexScreener)
    .sort((a: PairInfo, b: PairInfo) => b.volume24h - a.volume24h || b.liquidityUsd - a.liquidityUsd)
    .slice(0, 15);
}

export async function getPair(chain: string, pool: string): Promise<PairInfo> {
  const data = await cachedJson<any>(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${pool}`, 4_000);
  const p = data.pairs?.[0] ?? data.pair;
  if (!p) throw new Error("Pair not found");
  return fromDexScreener(p);
}

export async function getCandles(chain: string, pool: string, tf: Timeframe, limit = 300): Promise<Candle[]> {
  const net = GT_NETWORK[chain] ?? chain;
  const { unit, agg } = TF_MAP[tf] ?? TF_MAP["5m"];
  const url = `https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=${limit}&currency=usd`;
  const data = await cachedJson<any>(url, tf === "1m" ? 20_000 : 45_000);
  const list: number[][] = data?.data?.attributes?.ohlcv_list ?? [];
  return list
    .map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v }))
    .sort((a, b) => a.time - b.time);
}

export async function getTrending(chain = "solana"): Promise<PairInfo[]> {
  const net = GT_NETWORK[chain] ?? chain;
  const data = await cachedJson<any>(`https://api.geckoterminal.com/api/v2/networks/${net}/trending_pools?page=1`, 120_000);
  return (data.data ?? []).map((d: any) => {
    const a = d.attributes;
    const baseId: string = d.relationships?.base_token?.data?.id ?? "";
    return {
      chain,
      pool: a.address,
      symbol: String(a.name ?? "?").split(" / ")[0],
      name: a.name,
      tokenAddress: baseId.replace(`${net}_`, ""),
      priceUsd: num(a.base_token_price_usd),
      change: {
        m5: num(a.price_change_percentage?.m5),
        h1: num(a.price_change_percentage?.h1),
        h6: num(a.price_change_percentage?.h6),
        h24: num(a.price_change_percentage?.h24),
      },
      volume24h: num(a.volume_usd?.h24),
      liquidityUsd: num(a.reserve_in_usd),
      marketCap: num(a.market_cap_usd ?? a.fdv_usd),
      dex: d.relationships?.dex?.data?.id,
    } satisfies PairInfo;
  });
}
