// Opportunity scanner: trending coins ranked by a quick chart score, each with
// a rule-based buy/sell plan. No AI cost. Used by the Opportunities tab and by the
// bot's auto-pick mode (which then asks Claude about the best few).
import { getCandles, getTrending, SCAN_CHAINS, type PairInfo } from "./data.js";
import { snapshot, type Snapshot } from "./indicators.js";

export type ScanChain = (typeof SCAN_CHAINS)[number];
export type ScanRow = { pair: PairInfo; snap: Snapshot | null; plan: Plan | null };

export type Plan = { verdict: "BUY ZONE" | "WAIT" | "AVOID"; buyBelow: number; sellAt: number; exitBelow: number; buyBy: number; sellBy: number; netGainPct: number; why: string };

export function quickPlan(snap: Snapshot, costPct: number, livePrice: number): Plan {
  // Use the live price (candles can lag), so "buy below" is never above what the coin costs now.
  const price = livePrice > 0 ? livePrice : snap.price;
  // Buy on a small pullback toward the fast average, never above the current price.
  const buyBelow = Math.min(price, snap.ema9 < price ? Math.max(snap.ema9, price * 0.985) : price);
  const riskPct = Math.max(1.5 * snap.atrPct, 2); // room for normal wiggles
  const rewardPct = 2 * riskPct + costPct; // aim for 2x the risk, after fees
  const exitBelow = buyBelow * (1 - riskPct / 100);
  const sellAt = buyBelow * (1 + rewardPct / 100);
  // Rough time to reach the target on 5-minute candles, 30 min to 6 h.
  const holdMin = Math.min(360, Math.max(30, (rewardPct / Math.max(snap.atrPct / 3, 0.05)) * 5));
  const now = Date.now();
  const verdict = snap.techScore >= 50 ? "BUY ZONE" : snap.techScore <= -30 ? "AVOID" : "WAIT";
  const why =
    verdict === "BUY ZONE"
      ? `Uptrend with ${snap.volRatio > 1.5 ? "rising volume" : "steady volume"}, RSI ${snap.rsi14.toFixed(0)}.`
      : verdict === "AVOID"
        ? `Downtrend${snap.rsi14 > 75 ? ", overheated" : ""}. Stay away for now.`
        : `No clear direction yet (RSI ${snap.rsi14.toFixed(0)}).`;
  return { verdict, buyBelow, sellAt, exitBelow, buyBy: now + 15 * 60_000, sellBy: now + (15 + holdMin) * 60_000, netGainPct: rewardPct - costPct, why };
}

export async function scanOpportunities(chain: string, costPct: number, minLiquidityUsd = 20_000) {
  if (!(SCAN_CHAINS as readonly string[]).includes(chain)) throw new Error(`Unknown chain "${chain}"`);
  const { pairs, source } = await getTrending(chain);
  const picks = pairs.filter((p) => p.liquidityUsd > minLiquidityUsd).slice(0, 8);
  const rows: ScanRow[] = await Promise.all(
    picks.map(async (p) => {
      try {
        // "no-cmc": a burst of 8 requests would use up CoinMarketCap's small allowance.
        const snap = snapshot(await getCandles(p.chain, p.pool, "5m", 120, p, "no-cmc"));
        return { pair: p, snap, plan: snap ? quickPlan(snap, costPct, p.priceUsd) : null };
      } catch {
        return { pair: p, snap: null, plan: null };
      }
    }),
  );
  rows.sort((a, b) => (b.snap?.techScore ?? -999) - (a.snap?.techScore ?? -999));
  return { source, chain: chain as ScanChain, rows };
}
