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
  vetoes: string[]; // any deal-breaker: never bought by the scouts' own mode (structural + timing)
  structural: string[]; // deal-breakers about what the coin IS: who holds it, who can mint or freeze it, how deep and how real its market is
  timing: string[]; // deal-breakers about what it is DOING this minute (dumping, flat, spiking): a question of when, not of which coin
  quality: number; // 0-100 from the four scouts that describe the coin itself: real trading, holders, the dev, liquidity
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

  // What the coin IS. An agent's quality gate refuses its coin on these (see qualityGate).
  const structural: string[] = [];
  if (audit.mintAuthorityDisabled === false) structural.push("the creator can still mint new tokens");
  if (audit.freezeAuthorityDisabled === false) structural.push("the creator can freeze wallets");
  if (dev > 10) structural.push(`the dev holds ${dev.toFixed(0)}%`);
  if (top > 45) structural.push(`the top 10 wallets own ${top.toFixed(0)}%`);
  if (liq < 50_000) structural.push(`thin liquidity ($${Math.round(liq / 1000)}K): fees and slippage would eat the trade`);
  if (liqCh5 < -15) structural.push(`liquidity fell ${Math.abs(liqCh5).toFixed(0)}% in 5 min (possible rug)`);
  if (vol1h > 0 && orgScore < 25) structural.push(`mostly bot volume (organic score ${Math.round(orgScore)})`);
  if (ageMin !== null && ageMin < 20) structural.push("launched minutes ago");
  // What it is DOING this minute. These decide when the scouts' own mode buys, not whether a coin is
  // fit to trade: an agent's AI may buy a dip in a coin that is flat or falling right now.
  const timing: string[] = [];
  if (ch5 <= -6) timing.push(`dumping now (${ch5.toFixed(1)}% in 5 min)`);
  if (ch1 < 3) timing.push(`no upward move to ride (${ch1 >= 0 ? "+" : ""}${ch1.toFixed(1)}% in 1h)`);
  if (ch5 >= 15 || ch1 >= 150) timing.push("already spiking: buying here usually buys the top");
  if (vol1h < 30_000) timing.push("too little trading");
  const vetoes = [...structural, ...timing];
  const quality = Math.round((a.organic.score * 1.4 + a.holders.score + a.dev.score + a.liquidity.score) / 4.4);

  const wsum = AGENT_KEYS.reduce((s, k) => s + WEIGHTS[k], 0);
  const total = Math.round(AGENT_KEYS.reduce((s, k) => s + a[k].score * WEIGHTS[k], 0) / wsum);
  return {
    mint: t.id, symbol: t.symbol ?? "?", name: t.name ?? "", icon: t.icon || undefined,
    priceUsd: n(t.usdPrice), mcap, liquidity: liq, ageMin: ageMin === null ? null : Math.round(ageMin),
    change5m: ch5, change1h: ch1, agents: a, total, vetoes, structural, timing, quality,
  };
}

// ---------- Quality gate: is an agent's coin fit to trade at all? ----------
// Checked before the AI is asked for a plan, at no AI cost. A coin is refused for a structural
// deal-breaker, or when its quality score is under the agent's minimum. Timing is not part of
// it, and neither is the scouts' total (65 to be picked by the scouts' own mode): on 14 real
// coins none scored 65, 11 tripped a timing veto, and the coin that then ran 30x scored 63.
// The default minimum is deliberately low: the score has not been measured against results yet
// (the scouts' inputs have no history to back-test on), so every look logs it for that.
export const QUALITY_MIN = 45;
export type CoinGate = { ok: boolean; quality: number; min: number; reasons: string[] };
export function qualityGate(c: AgentCoin, min = QUALITY_MIN): CoinGate {
  const reasons = [...c.structural];
  if (c.quality < min) reasons.push(`its quality score is ${c.quality}, under the ${min} this agent asks for (real trading ${Math.round(c.agents.organic.score)}, holders ${Math.round(c.agents.holders.score)}, dev ${Math.round(c.agents.dev.score)}, liquidity ${Math.round(c.agents.liquidity.score)}, each out of 100)`);
  return { ok: reasons.length === 0, quality: c.quality, min, reasons };
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
  lastScan = { at: Date.now(), coins, scanned: seen.size };
  return lastScan;
}
// The last scan, if it is recent: read without asking the data source again (an agent's AI look
// must not wait behind four list requests for a reading it can work out from the coin itself).
let lastScan: AgentScan | null = null;
export const recentScan = (maxAgeMs = 5 * 60_000): AgentScan | null => (lastScan && Date.now() - lastScan.at < maxAgeMs ? lastScan : null);

// ---------- One coin's live data (for an agent's AI) ----------
// The same Jupiter record the scouts use, looked up for a single token, so every agent's AI
// gets buyers vs sellers, holders and safety data even when its coin isn't in the trending lists.
export const SOL_MINT = "So11111111111111111111111111111111111111112";
// One request returns the coin and SOL together (Jupiter accepts several mints, comma-separated),
// so the coin's data and the market backdrop cost a single lookup.
async function lookup(mint: string): Promise<any[]> {
  const q = mint === SOL_MINT ? SOL_MINT : `${encodeURIComponent(mint)},${SOL_MINT}`;
  const d = await cachedJson<any[]>(`https://api.jup.ag/tokens/v2/search?query=${q}`, 30_000, { headers: jupHeaders(), retries: 0 });
  return Array.isArray(d) ? d : [];
}
export async function tokenInfo(mint: string): Promise<any | null> {
  if (!mint) return null;
  try {
    return (await lookup(mint)).find((t) => t?.id === mint) ?? null;
  } catch {
    return null;
  }
}

const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
const sgn = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
function window(label: string, s: any): string | null {
  if (!s) return null;
  const buy = n(s.buyVolume), sell = n(s.sellVolume);
  if (!(buy + sell > 0)) return null;
  return `- ${label}: price ${sgn(n(s.priceChange))}; ${usd(buy)} bought vs ${usd(sell)} sold (${Math.round((buy / (buy + sell)) * 100)}% buys); ${n(s.numBuys)} buys / ${n(s.numSells)} sells by ${n(s.numTraders)} traders; net buyers ${n(s.numNetBuyers) >= 0 ? "+" : ""}${n(s.numNetBuyers)}; real (organic) buyers ${n(s.numOrganicBuyers)}; volume ${sgn(n(s.volumeChange), 0)} vs the previous window; liquidity ${sgn(n(s.liquidityChange))}; holders ${sgn(n(s.holderChange))}`;
}
// Buyers vs sellers, holders and safety for one token, as text for the AI.
export function flowText(t: any): string {
  const audit = t.audit ?? {};
  const lines = [window("last 5 min", t.stats5m), window("last hour", t.stats1h), window("last 6 hours", t.stats6h)].filter(Boolean);
  const safety = `Holders ${n(t.holderCount).toLocaleString()}; top 10 wallets own ${n(audit.topHoldersPercentage).toFixed(0)}%; dev holds ${n(audit.devBalancePercentage).toFixed(1)}% (${n(audit.devMints)} launches by this dev); organic score ${Math.round(n(t.organicScore))}/100; total liquidity ${usd(n(t.liquidity))}; mint authority ${audit.mintAuthorityDisabled === false ? "STILL ENABLED" : "disabled"}, freeze authority ${audit.freezeAuthorityDisabled === false ? "STILL ENABLED" : "disabled"}.`;
  return `Buyers vs sellers (on-chain, all pools):\n${lines.join("\n") || "- no flow data"}\n${safety}`;
}
// What the wider market is doing: most Solana tokens follow SOL's mood.
// Pass the coin being looked at so both come from the same request.
export async function marketText(withMint = SOL_MINT): Promise<string> {
  let sol: any = null;
  try {
    sol = (await lookup(withMint || SOL_MINT)).find((t) => t?.id === SOL_MINT) ?? null;
  } catch { /* optional */ }
  if (!sol) return "";
  const p = (s: any) => sgn(n(s?.priceChange));
  return `Market backdrop: SOL $${n(sol.usdPrice).toFixed(2)}: ${p(sol.stats5m)} in 5 min, ${p(sol.stats1h)} in 1h, ${p(sol.stats6h)} in 6h, ${p(sol.stats24h)} in 24h.`;
}
