// Opportunity scanner: trending coins ranked by a quick score, each with a rule-based
// buy/sell plan. No AI cost. Used by the Opportunities tab and by the bot's auto-pick
// mode (which then asks Claude about the best few).
//
// Speed: the trending list already carries each coin's price changes (5m/1h/6h/24h),
// volumes and buy/sell counts, so the score and plan are computed from that one
// response: O(n) work, no per-coin candle requests (those used to take ~2 s each,
// one after another). Results are cached per chain for 30 s.
import { getTrending, SCAN_CHAINS, type PairInfo } from "./data.js";

export type ScanChain = (typeof SCAN_CHAINS)[number];
export type Plan = { verdict: "BUY ZONE" | "WAIT" | "AVOID"; buyBelow: number; sellAt: number; exitBelow: number; buyBy: number; sellBy: number; netGainPct: number; why: string };
export type ScanRow = { pair: PairInfo; score: number | null; plan: Plan | null };
type ScanResult = { source: "trending" | "boosted"; chain: ScanChain; rows: ScanRow[] };

// Score from -100 (avoid) to +100 (strong), from the coin's own stats.
export function quickScore(p: PairInfo): { score: number; why: string } | null {
  if (!(p.priceUsd > 0)) return null;
  const { m5, h1, h6 } = p.change;
  const reasons: string[] = [];
  let score = 0;
  // Trend over the last hour and 6 hours.
  score += h1 > 0 ? 20 : -20;
  score += h6 > 0 ? 15 : -15;
  // A crash is not a dip (same rule as the bot).
  if (h1 <= -10) {
    score -= 40;
    reasons.push(`down ${Math.abs(h1).toFixed(0)}% in 1h`);
  }
  // Already pumped hard: chasing is risky.
  if (h1 >= 40 || m5 >= 15) {
    score -= 25;
    reasons.push("overheated");
  }
  // Buyers vs sellers in the last hour.
  const buys = p.buys1h ?? 0, sells = p.sells1h ?? 0;
  if (buys + sells >= 20) {
    const share = buys / (buys + sells);
    if (share >= 0.55) {
      score += 20;
      reasons.push(`${Math.round(share * 100)}% of trades are buys`);
    } else if (share <= 0.45) {
      score -= 20;
      reasons.push(`sellers dominate (${Math.round((1 - share) * 100)}%)`);
    }
  }
  // Volume speeding up (last 5 min vs the hourly pace) on a rising price, or drying up.
  const pace = (p.volume1h ?? 0) / 12;
  if (pace > 0) {
    const ratio = (p.volume5m ?? 0) / pace;
    if (ratio >= 1.5 && m5 > 0) {
      score += 15;
      reasons.push("rising volume");
    } else if (ratio < 0.5) {
      score -= 10;
      reasons.push("volume drying up");
    }
  }
  score = Math.max(-100, Math.min(100, score));
  const trend = h1 > 0 && h6 > 0 ? "Uptrend" : h1 < 0 && h6 < 0 ? "Downtrend" : "Mixed trend";
  return { score, why: `${trend} (1h ${h1 >= 0 ? "+" : ""}${h1.toFixed(1)}%, 6h ${h6 >= 0 ? "+" : ""}${h6.toFixed(1)}%)${reasons.length ? `, ${reasons.join(", ")}` : ""}.` };
}

export function quickPlan(p: PairInfo, score: number, why: string, costPct: number): Plan {
  const price = p.priceUsd;
  // Volatility estimate from recent moves (stands in for ATR): room for normal wiggles.
  const volPct = Math.max(Math.abs(p.change.m5) * 2, Math.abs(p.change.h1) / 3, 1.5);
  const riskPct = Math.max(1.5 * volPct, 2);
  const rewardPct = 2 * riskPct + costPct; // aim for 2x the risk, after fees
  const buyBelow = price * (1 - Math.min(volPct, 5) / 200); // a small pullback, never above the price
  const exitBelow = buyBelow * (1 - riskPct / 100);
  const sellAt = buyBelow * (1 + rewardPct / 100);
  const holdMin = Math.min(360, Math.max(30, (rewardPct / Math.max(volPct / 3, 0.05)) * 5));
  const now = Date.now();
  const verdict = score >= 50 ? "BUY ZONE" : score <= -30 ? "AVOID" : "WAIT";
  return { verdict, buyBelow, sellAt, exitBelow, buyBy: now + 15 * 60_000, sellBy: now + (15 + holdMin) * 60_000, netGainPct: rewardPct - costPct, why };
}

const cache = new Map<string, { at: number; result: ScanResult }>();
const CACHE_MS = 30_000;

export async function scanOpportunities(chain: string, costPct: number, minLiquidityUsd = 20_000): Promise<ScanResult> {
  if (!(SCAN_CHAINS as readonly string[]).includes(chain)) throw new Error(`Unknown chain "${chain}"`);
  const key = `${chain}:${costPct}:${minLiquidityUsd}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const { pairs, source } = await getTrending(chain);
  const rows: ScanRow[] = pairs
    .filter((p) => p.liquidityUsd > minLiquidityUsd)
    .slice(0, 12)
    .map((pair) => {
      const q = quickScore(pair);
      return { pair, score: q?.score ?? null, plan: q ? quickPlan(pair, q.score, q.why, costPct) : null };
    })
    .sort((a, b) => (b.score ?? -999) - (a.score ?? -999));
  const result: ScanResult = { source, chain: chain as ScanChain, rows };
  cache.set(key, { at: Date.now(), result });
  return result;
}
