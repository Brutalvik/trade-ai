// What a back-test reports: win rate, profit factor, average win and loss, the net return with
// and without its three best trades (a result carried by a few outliers is not a strategy), and
// the worst fall of the combined account from a high.
import type { SimTrade } from "./sim.js";

export type Metrics = {
  coins: number; trades: number;
  winRatePct: number; profitFactor: number; avgWinPct: number; avgLossPct: number;
  netUsd: number; netReturnPct: number; netReturnNoTop3Pct: number; perTradePct: number;
  maxDrawdownPct: number; bestTradePct: number; medianHeldMin: number;
  exits: Record<string, number>;
};

export function metrics(trades: SimTrade[], coins: number, budgetUsd: number): Metrics {
  const capital = Math.max(1, coins * budgetUsd);
  const wins = trades.filter((t) => t.pnlUsd > 0), losses = trades.filter((t) => t.pnlUsd <= 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const netUsd = sum(trades.map((t) => t.pnlUsd));
  const byPnl = [...trades].sort((a, b) => b.pnlUsd - a.pnlUsd);
  const lossUsd = Math.abs(sum(losses.map((t) => t.pnlUsd)));
  // The combined account over time: every coin's agent starts with the budget; P&L lands when a trade closes.
  let equity = capital, peak = capital, dd = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    equity += t.pnlUsd;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, ((peak - equity) / peak) * 100);
  }
  const held = trades.map((t) => t.heldMin).sort((a, b) => a - b);
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.why] = (exits[t.why] ?? 0) + 1;
  return {
    coins, trades: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: lossUsd > 0 ? sum(wins.map((t) => t.pnlUsd)) / lossUsd : wins.length ? Infinity : 0,
    avgWinPct: wins.length ? sum(wins.map((t) => t.netPct)) / wins.length : 0,
    avgLossPct: losses.length ? sum(losses.map((t) => t.netPct)) / losses.length : 0,
    netUsd, netReturnPct: (netUsd / capital) * 100,
    netReturnNoTop3Pct: (sum(byPnl.slice(3).map((t) => t.pnlUsd)) / capital) * 100,
    perTradePct: trades.length ? sum(trades.map((t) => t.netPct)) / trades.length : 0,
    maxDrawdownPct: dd, bestTradePct: byPnl[0]?.netPct ?? 0, medianHeldMin: held.length ? held[Math.floor(held.length / 2)] : 0,
    exits,
  };
}

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
export const HEADER = `${"run".padEnd(46)} ${"trades".padStart(6)} ${"won".padStart(5)} ${"profit f.".padStart(9)} ${"avg win".padStart(8)} ${"avg loss".padStart(9)} ${"per trade".padStart(9)} ${"net return".padStart(10)} ${"no top 3".padStart(9)} ${"max fall".padStart(8)}`;
export function row(name: string, m: Metrics) {
  const pf = Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "inf";
  return `${name.slice(0, 46).padEnd(46)} ${String(m.trades).padStart(6)} ${`${m.winRatePct.toFixed(0)}%`.padStart(5)} ${pf.padStart(9)} ${pct(m.avgWinPct).padStart(8)} ${pct(m.avgLossPct).padStart(9)} ${pct(m.perTradePct, 2).padStart(9)} ${pct(m.netReturnPct).padStart(10)} ${pct(m.netReturnNoTop3Pct).padStart(9)} ${`${m.maxDrawdownPct.toFixed(1)}%`.padStart(8)}`;
}
