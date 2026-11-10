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

type FetchOpts = { retries?: number; headers?: Record<string, string>; allowStale?: boolean };

// After a 429, skip that host for a while so callers fall back immediately.
const coolUntil = new Map<string, number>();

async function fetchJson(url: string, opts: FetchOpts = {}): Promise<unknown> {
  const { retries = 1, headers = {} } = opts;
  const host = new URL(url).host;
  if ((coolUntil.get(host) ?? 0) > Date.now()) throw new Error(`429 from ${host} (cooling down after rate limit)`);
  await throttle(host);
  const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
  if (res.status === 429) coolUntil.set(host, Date.now() + 30_000);
  if (res.status === 429 && retries > 0) {
    coolUntil.delete(host);
    await new Promise((r) => setTimeout(r, 4000));
    return fetchJson(url, { ...opts, retries: retries - 1 });
  }
  if (!res.ok) throw new Error(`${res.status} from ${host}${res.status === 429 ? " (rate limited, try again shortly)" : ""}`);
  return res.json();
}

async function cachedJson<T>(url: string, ttlMs: number, opts: FetchOpts = {}): Promise<T> {
  const { allowStale = true } = opts;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  if (!inflight.has(url)) {
    inflight.set(
      url,
      fetchJson(url, opts)
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
    if (hit && allowStale) return hit.value as T; // serve stale data rather than nothing
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

// ---------- Candles, with fallbacks ----------
// 1. GeckoTerminal (free, exact pool, ~30 calls/min shared per IP)
// 2. CoinMarketCap DEX candles by token address (free, no key needed)
// 3. Coinbase / OKX exchange candles by symbol
// 2 and 3 are only used when their latest price matches the pool's live price
// and their data is current, so a copycat token never borrows a real chart.
// 4. The last candles that loaded successfully

export type CandleSource = "GeckoTerminal" | "CoinMarketCap" | "Coinbase" | "OKX" | "cached";
export type CandleResult = { candles: Candle[]; source: CandleSource; note?: string };

const sortCandles = (c: Candle[]) => c.filter((x) => Number.isFinite(x.close) && x.close > 0).sort((a, b) => a.time - b.time);
const fromOhlcvList = (data: any): Candle[] =>
  sortCandles(((data?.data?.attributes?.ohlcv_list ?? []) as number[][]).map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v })));
const ttlFor = (tf: Timeframe) => (tf === "1m" ? 20_000 : 45_000);

async function fromGeckoTerminal(net: string, pool: string, tf: Timeframe, limit: number) {
  const { unit, agg } = TF_MAP[tf];
  const url = `https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=${limit}&currency=usd`;
  return fromOhlcvList(await cachedJson<any>(url, ttlFor(tf), { retries: 0, allowStale: false }));
}

// CoinMarketCap's public k-line endpoint. Verified behaviour (2026-11):
// it needs the TOKEN address (a pool address returns stale data), works without
// a key only when no from/to range is sent, and returns
// [open, high, low, close, volume, timestamp_ms, traders] oldest-first.
const CMC_PLATFORM: Record<string, string> = { solana: "solana", base: "base", ethereum: "ethereum", bsc: "bsc", arbitrum: "arbitrum" };
const CMC_INTERVAL: Record<Timeframe, string> = { "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1d" };

async function fromCoinMarketCap(chain: string, tokenAddress: string, tf: Timeframe, limit: number) {
  const platform = CMC_PLATFORM[chain];
  if (!platform || !tokenAddress) throw new Error(`no CoinMarketCap platform for ${chain}`);
  const url = `https://pro-api.coinmarketcap.com/public-api/v1/k-line/candles?platform=${platform}&address=${tokenAddress}&interval=${CMC_INTERVAL[tf]}&limit=${Math.min(limit, 300)}`;
  const data = await cachedJson<any>(url, ttlFor(tf), { retries: 0, allowStale: false });
  if (!Array.isArray(data?.data)) throw new Error(data?.status?.error_message ?? "no data");
  return sortCandles(
    (data.data as unknown[][]).map((r) => {
      const ts = Number(r[5]);
      return { time: Math.floor(ts > 1e12 ? ts / 1000 : ts), open: +r[0]!, high: +r[1]!, low: +r[2]!, close: +r[3]!, volume: +r[4]! };
    }),
  );
}

// Exchange tickers for wrapped/bridged tokens.
const EXCHANGE_ALIAS: Record<string, string> = { WSOL: "SOL", WETH: "ETH", WBTC: "BTC", CBBTC: "BTC", WBNB: "BNB" };
const exchangeSymbol = (s: string) => {
  const up = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return EXCHANGE_ALIAS[up] ?? up;
};
const COINBASE_GRAN: Partial<Record<Timeframe, number>> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };
const OKX_BAR: Record<Timeframe, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" };
const missing = new Map<string, number>(); // symbols an exchange doesn't list, remembered for 30 min

async function fromCoinbase(sym: string, tf: Timeframe) {
  const gran = COINBASE_GRAN[tf];
  if (!gran) throw new Error(`Coinbase has no ${tf} candles`);
  const url = `https://api.exchange.coinbase.com/products/${sym}-USD/candles?granularity=${gran}`;
  // Coinbase rows: [time, low, high, open, close, volume]
  const rows = await cachedJson<number[][]>(url, ttlFor(tf), { retries: 0, allowStale: false });
  return sortCandles(rows.map(([t, l, h, o, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v })));
}

async function fromOkx(sym: string, tf: Timeframe, limit: number) {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT&bar=${OKX_BAR[tf]}&limit=${Math.min(limit, 300)}`;
  // OKX rows: [ts ms, open, high, low, close, volume, ...]
  const data = await cachedJson<any>(url, ttlFor(tf), { retries: 0, allowStale: false });
  if (data?.code !== "0" || !Array.isArray(data.data) || !data.data.length) throw new Error(`OKX has no ${sym}-USDT`);
  return sortCandles((data.data as string[][]).map(([t, o, h, l, c, v]) => ({ time: Math.floor(Number(t) / 1000), open: +o, high: +h, low: +l, close: +c, volume: +v })));
}

const lastGood = new Map<string, Candle[]>();

const TF_SECONDS: Record<Timeframe, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
type Hint = { symbol: string; priceUsd: number; tokenAddress?: string };

export async function getCandlesWithSource(chain: string, pool: string, tf: Timeframe, limit = 300, hint?: Hint): Promise<CandleResult> {
  const net = GT_NETWORK[chain] ?? chain;
  if (!TF_MAP[tf]) tf = "5m";
  const key = `${chain}:${pool}:${tf}`;
  const errors: string[] = [];
  const done = (candles: Candle[], source: CandleSource, note?: string): CandleResult => {
    lastGood.set(key, candles);
    return { candles, source, note };
  };

  try {
    const c = await fromGeckoTerminal(net, pool, tf, limit);
    if (c.length) return done(c, "GeckoTerminal");
  } catch (e: any) {
    errors.push(`GeckoTerminal: ${e?.message ?? e}`);
  }

  // Backups aren't for this exact pool, so check price and freshness first.
  let info: Hint | null = null;
  try {
    info = hint?.tokenAddress ? hint : await getPair(chain, pool);
  } catch (e: any) {
    errors.push(`price check: ${e?.message ?? e}`);
  }
  if (info) {
    const sym = exchangeSymbol(info.symbol);
    const backups: [CandleSource, number, () => Promise<Candle[]>, string][] = [
      ["CoinMarketCap", 0.1, () => fromCoinMarketCap(chain, info!.tokenAddress ?? "", tf, limit), "CoinMarketCap token candles (pool data was unavailable)"],
      ["Coinbase", 0.03, () => fromCoinbase(sym, tf), `${sym} exchange candles (pool data was unavailable)`],
      ["OKX", 0.03, () => fromOkx(sym, tf, limit), `${sym} exchange candles (pool data was unavailable)`],
    ];
    for (const [name, maxDiff, fn, note] of backups) {
      const missKey = `${name}:${name === "CoinMarketCap" ? info.tokenAddress : sym}`;
      if ((missing.get(missKey) ?? 0) > Date.now()) continue;
      try {
        const c = await fn();
        const lastC = c.at(-1);
        const diff = info.priceUsd && lastC ? Math.abs(lastC.close - info.priceUsd) / info.priceUsd : 1;
        const fresh = lastC ? Date.now() / 1000 - lastC.time < TF_SECONDS[tf] * 3 + 600 : false;
        if (c.length && diff <= maxDiff && fresh) return done(c, name, note);
        errors.push(`${name}: ${!fresh ? "data is out of date" : "price doesn't match this pool"}`);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // Remember "not listed" answers; retry temporary failures next time.
        if (/^(400|404) |has no|no CoinMarketCap platform/.test(msg)) missing.set(missKey, Date.now() + 30 * 60_000);
        errors.push(`${name}: ${msg}`);
      }
    }
  }

  const stale = lastGood.get(key);
  if (stale?.length) return { candles: stale, source: "cached", note: "Showing the last candles that loaded; live sources are busy." };
  throw new Error(`No candle data right now (${errors.join("; ")})`);
}

export async function getCandles(chain: string, pool: string, tf: Timeframe, limit = 300, hint?: Hint): Promise<Candle[]> {
  return (await getCandlesWithSource(chain, pool, tf, limit, hint)).candles;
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
