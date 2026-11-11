// Coin lists for the left sidebar (Solana only, so every coin can be bought for real):
//   crypto    – every coin by market-cap rank (CoinGecko; Solana tokens from Jupiter as a fallback)
//   top       – trending Solana coins ranked by our quick score (the old Opportunities list)
//   trending  – Jupiter's top trending (last hour)
//   held      – most holders (Jupiter: top traded / organic / trending, sorted by holders)
//   graduated – pump.fun coins that finished their bonding curve (PumpSwap pools, GeckoTerminal)
//   bonding   – pump.fun coins still on their bonding curve (GeckoTerminal)
//   community – what TRADING//RUST users bought most this week (our own records)
import { cachedJson, fromDexScreener, fromGeckoPool, type PairInfo } from "./data.js";
import { createStore } from "./store.js";
import { scanOpportunities } from "./scan.js";

export const LIST_KINDS = ["crypto", "top", "trending", "held", "graduated", "bonding", "community"] as const;
export type ListKind = (typeof LIST_KINDS)[number];
export type ListCoin = {
  mint: string; symbol: string; name: string; icon?: string; priceUsd: number; mcap: number; change24h: number;
  holders?: number; volume24h?: number; liquidity?: number; verified?: boolean; buys?: number; buyers?: number;
  pair?: PairInfo; // known pool (bonding / graduated / community lists)
  score?: number | null; verdict?: "BUY ZONE" | "WAIT" | "AVOID"; why?: string; // Top list: the quick chart score
  rank?: number; query?: string; // Crypto list: market-cap rank; search text to find its chart
};

const store = createStore();
const STABLE = /^(USDC|USDT|USD1|PYUSD|USDS|USDE|FDUSD|DAI|USDG|EURC|USDH|UXD|USDY|SUSD|USX|USDC\.E|USDT\.E|AUSD|USDU)$/i;
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY?.trim() ? { "x-api-key": process.env.JUPITER_API_KEY.trim() } : {});
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function jup(path: string): Promise<any[]> {
  const d = await cachedJson<any[]>(`https://api.jup.ag/tokens/v2/${path}`, 90_000, { headers: jupHeaders() });
  return Array.isArray(d) ? d : [];
}
const fromJup = (t: any): ListCoin => ({
  mint: t.id, symbol: t.symbol ?? "?", name: t.name ?? "", icon: t.icon || undefined,
  priceUsd: n(t.usdPrice), mcap: n(t.mcap ?? t.fdv), change24h: n(t.stats24h?.priceChange),
  holders: t.holderCount ?? undefined, volume24h: n(t.stats24h?.buyVolume) + n(t.stats24h?.sellVolume),
  liquidity: n(t.liquidity), verified: !!t.isVerified,
});
const notStable = (c: ListCoin) => !STABLE.test(c.symbol);

// GeckoTerminal pools on one DEX (pump-fun = bonding curve, pumpswap = graduated), busiest first.
async function geckoPools(dex: string): Promise<ListCoin[]> {
  const d = await cachedJson<any>(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/${dex}/pools?page=1&sort=h24_volume_usd_desc&include=base_token`, 90_000, { retries: 0 });
  const images = new Map<string, string>();
  for (const inc of d.included ?? []) if (inc.type === "token" && inc.attributes?.image_url && inc.attributes.image_url !== "missing.png") images.set(inc.id, inc.attributes.image_url);
  const out: ListCoin[] = [];
  const seen = new Set<string>();
  for (const pool of d.data ?? []) {
    const p = fromGeckoPool(pool);
    if (!p || !p.tokenAddress || seen.has(p.tokenAddress)) continue;
    if (!/ \/ SOL$/.test(String(pool.attributes?.name ?? ""))) continue; // coin / SOL pools only
    seen.add(p.tokenAddress);
    const icon = images.get(pool.relationships?.base_token?.data?.id ?? "");
    out.push({ mint: p.tokenAddress, symbol: p.symbol, name: p.name, icon, priceUsd: p.priceUsd, mcap: p.marketCap, change24h: p.change.h24, volume24h: p.volume24h, liquidity: p.liquidityUsd, pair: { ...p, imageUrl: icon ?? p.imageUrl } });
  }
  return out;
}

// ---------- Community: what our users bought this week ----------
const weekKey = (t = Date.now()) => `community:${Math.floor(t / (7 * 86_400_000))}`;
type CommunityRow = { mint: string; symbol: string; pool: string; buys: number; users: string[] };

export async function noteCommunityBuy(user: string, p: { chain: string; tokenAddress?: string; symbol: string; pool: string }) {
  if (p.chain !== "solana" || !p.tokenAddress) return;
  try {
    const k = weekKey();
    const map = (await store.kvGet<Record<string, CommunityRow>>(k)) ?? {};
    const row = map[p.tokenAddress] ?? { mint: p.tokenAddress, symbol: p.symbol, pool: p.pool, buys: 0, users: [] };
    row.buys += 1;
    if (!row.users.includes(user) && row.users.length < 500) row.users.push(user);
    map[p.tokenAddress] = row;
    await store.kvSet(k, map, { ttlMs: 15 * 86_400_000 });
  } catch (e) {
    console.error("[community] write failed:", e);
  }
}

async function community(): Promise<ListCoin[]> {
  const map = { ...((await store.kvGet<Record<string, CommunityRow>>(weekKey(Date.now() - 7 * 86_400_000))) ?? {}) };
  // This week first; last week fills in so the list isn't empty on Mondays.
  for (const [mint, row] of Object.entries((await store.kvGet<Record<string, CommunityRow>>(weekKey())) ?? {})) {
    const prev = map[mint];
    map[mint] = prev ? { ...row, buys: row.buys + prev.buys, users: [...new Set([...row.users, ...prev.users])] } : row;
  }
  const rows = Object.values(map).sort((a, b) => b.users.length - a.users.length || b.buys - a.buys).slice(0, 30);
  if (!rows.length) return [];
  const pairs = await cachedJson<any[]>(`https://api.dexscreener.com/tokens/v1/solana/${rows.map((r) => r.mint).join(",")}`, 60_000).catch(() => []);
  const best = new Map<string, PairInfo>();
  for (const p of (pairs ?? []).map(fromDexScreener)) {
    const cur = best.get(p.tokenAddress);
    if (!cur || p.liquidityUsd > cur.liquidityUsd) best.set(p.tokenAddress, p);
  }
  return rows.flatMap((r) => {
    const p = best.get(r.mint);
    if (!p) return [];
    return [{ mint: r.mint, symbol: p.symbol, name: p.name, icon: p.imageUrl, priceUsd: p.priceUsd, mcap: p.marketCap, change24h: p.change.h24, volume24h: p.volume24h, liquidity: p.liquidityUsd, buys: r.buys, buyers: r.users.length, pair: p }];
  });
}

export async function coinList(kind: string): Promise<{ kind: ListKind; coins: ListCoin[] }> {
  if (!(LIST_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown list "${kind}"`);
  const k = kind as ListKind;
  let coins: ListCoin[] = [];
  if (k === "crypto") {
    // Every coin by market-cap rank (CoinGecko); if it's busy, the biggest Solana tokens instead.
    try {
      const cg = await cachedJson<any[]>("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h", 300_000, { retries: 0 });
      coins = (Array.isArray(cg) ? cg : []).map((x) => ({
        mint: `cg:${x.id}`, symbol: String(x.symbol ?? "").toUpperCase(), name: x.name ?? "", icon: x.image || undefined,
        priceUsd: n(x.current_price), mcap: n(x.market_cap), change24h: n(x.price_change_percentage_24h), volume24h: n(x.total_volume),
        rank: x.market_cap_rank ?? undefined, query: String(x.symbol ?? "").toUpperCase(),
      }));
    } catch {
      coins = [];
    }
    if (!coins.length) coins = (await jup("toporganicscore/24h?limit=100")).map(fromJup).filter((c) => notStable(c) && (c.liquidity ?? 0) > 100_000).sort((a, b) => b.mcap - a.mcap);
  } else if (k === "top") {
    // The old Opportunities list: trending Solana coins ranked by a quick score from their own stats.
    const scan = await scanOpportunities("solana", 3);
    coins = scan.rows.map((r) => ({
      mint: r.pair.tokenAddress, symbol: r.pair.symbol, name: r.pair.name, icon: r.pair.imageUrl, priceUsd: r.pair.priceUsd, mcap: r.pair.marketCap,
      change24h: r.pair.change.h24, volume24h: r.pair.volume24h, liquidity: r.pair.liquidityUsd, pair: r.pair,
      score: r.score, verdict: r.plan?.verdict, why: r.plan?.why,
    }));
    // The trending source has no pictures: fill them in from DexScreener (one call).
    const missing = coins.filter((c) => !c.icon).map((c) => c.mint).slice(0, 30);
    if (missing.length) {
      const pairs = await cachedJson<any[]>(`https://api.dexscreener.com/tokens/v1/solana/${missing.join(",")}`, 300_000).catch(() => []);
      const img = new Map<string, string>();
      for (const p of pairs ?? []) if (p?.info?.imageUrl && p.baseToken?.address) img.set(p.baseToken.address, p.info.imageUrl);
      for (const c of coins) if (!c.icon && img.has(c.mint)) { c.icon = img.get(c.mint); if (c.pair) c.pair = { ...c.pair, imageUrl: c.icon }; }
    }
  } else if (k === "trending") {
    coins = (await jup("toptrending/1h?limit=100")).map(fromJup).filter(notStable);
  } else if (k === "held") {
    const lists = await Promise.all(["toporganicscore/24h?limit=100", "toptraded/24h?limit=100", "toptrending/24h?limit=100"].map((p) => jup(p).catch(() => [])));
    const seen = new Map<string, ListCoin>();
    for (const t of lists.flat()) if (t?.id && !seen.has(t.id)) seen.set(t.id, fromJup(t));
    coins = [...seen.values()].filter((c) => notStable(c) && (c.holders ?? 0) > 0).sort((a, b) => (b.holders ?? 0) - (a.holders ?? 0));
  } else if (k === "graduated") {
    coins = await geckoPools("pumpswap");
  } else if (k === "bonding") {
    coins = await geckoPools("pump-fun");
  } else {
    coins = await community();
  }
  return { kind: k, coins: coins.slice(0, k === "crypto" ? 100 : 50) };
}

// ---------- Search (like fomo): real coins first, copycats last ----------
// Crypto: big coins by market rank (CoinGecko) whose ticker or name matches, at their real price.
// Tokens: Solana tokens from Jupiter's token search, verified first, then by real trading activity
// (organic score) and liquidity; dust tokens are dropped. Addresses go straight to DexScreener.
const looksLikeAddress = (q: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q) || /^0x[0-9a-fA-F]{40}$/.test(q);

export async function searchCoins(q: string): Promise<{ crypto: ListCoin[]; tokens: ListCoin[]; address: boolean }> {
  const query = q.trim();
  if (query.length < 2 || looksLikeAddress(query)) return { crypto: [], tokens: [], address: looksLikeAddress(query) };
  const up = query.toUpperCase();
  const low = query.toLowerCase();
  const [cryptoList, found] = await Promise.all([
    coinList("crypto").then((r) => r.coins).catch(() => [] as ListCoin[]),
    cachedJson<any[]>(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(query)}`, 60_000, { headers: jupHeaders() }).catch(() => [] as any[]),
  ]);
  const crypto = cryptoList
    .filter((c) => c.symbol === up || c.name.toLowerCase() === low || (query.length >= 3 && c.name.toLowerCase().startsWith(low)))
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .slice(0, 3);
  const raw = Array.isArray(found) ? found : [];
  const score = (t: any) => n(t.organicScore);
  const tokens = raw
    .filter((t) => t?.id && (t.isVerified || n(t.liquidity) >= 1_000))
    .sort((a, b) =>
      Number(!!b.isVerified) - Number(!!a.isVerified) ||
      score(b) - score(a) ||
      n(b.liquidity) - n(a.liquidity))
    .slice(0, 12)
    .map((t) => ({ ...fromJup(t), organic: score(t) }));
  return { crypto, tokens, address: false };
}
