// Agents: eight rule-based scouts that score every busy Solana coin from free Jupiter data
// (no AI cost per coin), then a chart check on the best few. The bot's Agents mode buys the
// strongest coin that passes every veto, aiming for at least +10% after all fees.
//
//   TREND      rank in Jupiter's trending lists (5 min and 1 hour)
//   VOLUME     last-5-minute volume vs the hourly pace, and buy pressure
//   ORGANIC    real traders vs bot/wash volume (Jupiter's organic score and organic buyers)
//   HOLDERS    holder count and growth; how much the top wallets own
//   DEV        the creator's share, serial launches, mint/freeze authority
//   LIQUIDITY  enough depth for the trade, and no liquidity being pulled
//   MOMENTUM   rising over the hour, but not spiking or dumping right now
//   FRESH      coin age: past the launch chaos, still early in its life
// A coin trips a VETO for any deal-breaker (it is never bought, whatever its score).
import { cachedJson } from "./data.js";

export const AGENT_KEYS = ["trend", "volume", "organic", "holders", "dev", "liquidity", "momentum", "fresh"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];
export type AgentRead = { score: number; note: string };
export type AgentCoin = {
  mint: string; symbol: string; name: string; icon?: string;
  priceUsd: number; mcap: number; liquidity: number; ageMin: number | null;
  change5m: number; change1h: number;
  agents: Record<AgentKey, AgentRead>;
  total: number; // 0-100, weighted
  vetoes: string[]; // any deal-breaker: never bought
};
export type AgentScan = { at: number; coins: AgentCoin[]; scanned: number };

export const AGENT_PASS = 65; // minimum total score to be a candidate
const WEIGHTS: Record<AgentKey, number> = { trend: 1, volume: 1.3, organic: 1.4, holders: 1, dev: 1, liquidity: 1, momentum: 1.3, fresh: 0.5 };
const STABLE = /^(USDC|USDT|USD1|PYUSD|USDS|USDE|FDUSD|DAI|USDG|EURC|USDH|SOL|WSOL|JITOSOL|MSOL|BSOL|JUPSOL|INF)$|USD|^W?BTC$|^CBBTC$|^W?ETH$|^ZBTC$|^TBTC$/i;
// Too big to move +13% in a couple of hours: majors and large caps are left out.
const MAX_MCAP = 300e6;

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY?.trim() ? { "x-api-key": process.env.JUPITER_API_KEY.trim() } : {});
async function jup(path: string): Promise<any[]> {
  try {
    const d = await cachedJson<any[]>(`https://api.jup.ag/tokens/v2/${path}`, 45_000, { headers: jupHeaders(), retries: 0 });
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

export function scoreCoin(t: any, trendRank: number | null): AgentCoin {
  const s5 = t.stats5m ?? {}, s1 = t.stats1h ?? {};
  const audit = t.audit ?? {};
  const liq = n(t.liquidity), mcap = n(t.mcap ?? t.fdv);
  const created = Date.parse(t.graduatedAt ?? t.firstPool?.createdAt ?? t.createdAt ?? "");
  const ageMin = Number.isFinite(created) ? Math.max(0, (Date.now() - created) / 60_000) : null;
  const vol5 = n(s5.buyVolume) + n(s5.sellVolume), vol1h = n(s1.buyVolume) + n(s1.sellVolume);
  const pace = vol1h > 0 ? vol5 / (vol1h / 12) : 0; // 1 = normal 5-minute pace for the hour
  const buyShare5 = vol5 > 0 ? n(s5.buyVolume) / vol5 : 0.5;
  const buyShare1h = vol1h > 0 ? n(s1.buyVolume) / vol1h : 0.5;
  const organicVol1h = n(s1.buyOrganicVolume) + n(s1.sellOrganicVolume);
  const organicShare = vol1h > 0 ? organicVol1h / vol1h : 0;
  const orgScore = n(t.organicScore);
  const traders = n(s1.numTraders), orgBuyers = n(s1.numOrganicBuyers);
  const top = n(audit.topHoldersPercentage), dev = n(audit.devBalancePercentage), devLaunches = n(audit.devMints);
  const holders = n(t.holderCount), holderChange1h = n(s1.holderChange);
  const ch5 = n(s5.priceChange), ch1 = n(s1.priceChange), liqCh5 = n(s5.liquidityChange);

  const a: Record<AgentKey, AgentRead> = {
    trend: trendRank !== null
      ? { score: clamp(100 - trendRank * 3), note: `trending #${trendRank + 1}` }
      : { score: 35, note: "not in the trending lists" },
    volume: {
      score: clamp(30 + Math.min(pace, 4) * 15 + (buyShare5 - 0.5) * 120),
      note: `5-min volume ${pace.toFixed(1)}× its hourly pace, ${Math.round(buyShare5 * 100)}% buys`,
    },
    organic: {
      score: clamp(orgScore * 0.8 + Math.min(orgBuyers, 50) * 0.4),
      note: `organic score ${Math.round(orgScore)}, ${Math.round(organicShare * 100)}% real volume, ${orgBuyers} real buyers / ${traders} traders`,
    },
    holders: {
      score: clamp(40 + Math.min(holders, 5000) / 100 + holderChange1h * 2 - Math.max(0, top - 20) * 1.5),
      note: `${holders.toLocaleString()} holders (${holderChange1h >= 0 ? "+" : ""}${holderChange1h.toFixed(1)}% in 1h), top 10 own ${top.toFixed(0)}%`,
    },
    dev: {
      score: clamp(90 - dev * 6 - Math.max(0, devLaunches - 3) * 4 - (audit.mintAuthorityDisabled === false ? 60 : 0) - (audit.freezeAuthorityDisabled === false ? 60 : 0)),
      note: `dev holds ${dev.toFixed(1)}%, ${devLaunches} launches by this dev`,
    },
    liquidity: {
      score: clamp(Math.min(liq / 3000, 80) + (liqCh5 >= 0 ? 20 : Math.max(-40, liqCh5 * 2))),
      note: `$${Math.round(liq / 1000)}K liquidity (${liqCh5 >= 0 ? "+" : ""}${liqCh5.toFixed(1)}% in 5 min)`,
    },
    momentum: {
      // Best: up over the hour and gently up now. Bad: dumping now, or already spiking hard.
      score: clamp(50 + Math.min(ch1, 60) * 0.6 + (ch5 > 0 && ch5 < 8 ? 15 : ch5 >= 8 ? -15 : ch5 * 4) + (buyShare1h - 0.5) * 60),
      note: `${ch1 >= 0 ? "+" : ""}${ch1.toFixed(1)}% in 1h, ${ch5 >= 0 ? "+" : ""}${ch5.toFixed(1)}% in 5 min`,
    },
    fresh: ageMin === null
      ? { score: 50, note: "age unknown" }
      : { score: ageMin < 30 ? 20 : ageMin < 60 * 48 ? 85 : ageMin < 60 * 24 * 14 ? 60 : 40, note: ageMin < 120 ? `${Math.round(ageMin)} min old` : ageMin < 60 * 48 ? `${Math.round(ageMin / 60)} h old` : `${Math.round(ageMin / 1440)} days old` },
  };

  const vetoes: string[] = [];
  if (audit.mintAuthorityDisabled === false) vetoes.push("the creator can still mint new tokens");
  if (audit.freezeAuthorityDisabled === false) vetoes.push("the creator can freeze wallets");
  if (dev > 10) vetoes.push(`the dev holds ${dev.toFixed(0)}%`);
  if (top > 45) vetoes.push(`the top 10 wallets own ${top.toFixed(0)}%`);
  if (liq < 50_000) vetoes.push(`thin liquidity ($${Math.round(liq / 1000)}K): fees and slippage would eat the trade`);
  if (liqCh5 < -15) vetoes.push(`liquidity fell ${Math.abs(liqCh5).toFixed(0)}% in 5 min (possible rug)`);
  if (vol1h > 0 && orgScore < 25) vetoes.push(`mostly bot volume (organic score ${Math.round(orgScore)})`);
  if (ch5 <= -6) vetoes.push(`dumping now (${ch5.toFixed(1)}% in 5 min)`);
  if (ch1 < 3) vetoes.push(`no upward move to ride (${ch1 >= 0 ? "+" : ""}${ch1.toFixed(1)}% in 1h)`);
  if (ch5 >= 15 || ch1 >= 150) vetoes.push("already spiking: buying here usually buys the top");
  if (ageMin !== null && ageMin < 20) vetoes.push("launched minutes ago");
  if (vol1h < 30_000) vetoes.push("too little trading");

  const wsum = AGENT_KEYS.reduce((s, k) => s + WEIGHTS[k], 0);
  const total = Math.round(AGENT_KEYS.reduce((s, k) => s + a[k].score * WEIGHTS[k], 0) / wsum);
  return {
    mint: t.id, symbol: t.symbol ?? "?", name: t.name ?? "", icon: t.icon || undefined,
    priceUsd: n(t.usdPrice), mcap, liquidity: liq, ageMin: ageMin === null ? null : Math.round(ageMin),
    change5m: ch5, change1h: ch1, agents: a, total, vetoes,
  };
}

// Every busy Solana coin, scored by all eight agents (cached ~45 s by the data layer).
export async function scanAgents(): Promise<AgentScan> {
  const lists = await Promise.all([
    jup("toptrending/5m?limit=100"),
    jup("toptrending/1h?limit=100"),
    jup("toptraded/5m?limit=100"),
    jup("toporganicscore/1h?limit=100"),
  ]);
  const rank = new Map<string, number>();
  [...lists[0], ...lists[1]].forEach((t, i) => { if (t?.id && !rank.has(t.id)) rank.set(t.id, i % 100); });
  const seen = new Map<string, any>();
  for (const t of lists.flat()) if (t?.id && !seen.has(t.id)) seen.set(t.id, t);
  const coins = [...seen.values()]
    .filter((t) => !STABLE.test(t.symbol ?? "") && !(t.tags ?? []).some((g: string) => /xstock|stock|rwa/i.test(g)) && n(t.mcap) < MAX_MCAP)
    .map((t) => scoreCoin(t, rank.get(t.id) ?? null))
    .sort((a, b) => (a.vetoes.length ? 1 : 0) - (b.vetoes.length ? 1 : 0) || b.total - a.total);
  return { at: Date.now(), coins, scanned: seen.size };
}
