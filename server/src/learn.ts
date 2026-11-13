// An agent's learning: replay five entry patterns over its own coin's history (5-minute and
// 1-hour candles) with the exact trade rules it will use live (target +10% after all fees, exit
// 4-7% below sized to the coin's swings, time limit), and keep the pattern that really made money.
// Live, the agent buys when that pattern appears on the newest closed candle.
import type { Candle } from "./data.js";

export const STRATS = [
  { key: "breakout", label: "Breakout with volume" },
  { key: "pullback", label: "Pullback to the trend line" },
  { key: "squeeze", label: "Breakout from a tight range" },
  { key: "flag", label: "Bull flag" },
  { key: "rebound", label: "RSI rebound" },
] as const;
export type StratKey = (typeof STRATS)[number]["key"];
export type StratResult = { key: StratKey; label: string; tf: string; trades: number; wins: number; avgNetPct: number; winChancePct: number };
export type Learned = {
  at: number;
  netTargetPct: number;
  table: StratResult[]; // every pattern on every timeframe, best first
  best: StratResult | null; // the pattern the agent trades (null = nothing has an edge yet)
  summary: string;
};

type Series = { c: Candle[]; ema9: number[]; ema21: number[]; rsi: number[]; atr: number[]; volAvg: number[] };
function series(c: Candle[]): Series {
  const ema = (n: number) => { const k = 2 / (n + 1); const o: number[] = []; c.forEach((x, i) => o.push(i ? x.close * k + o[i - 1] * (1 - k) : x.close)); return o; };
  const rsi: number[] = []; let g = 0, l = 0;
  c.forEach((x, i) => { if (!i) return rsi.push(50); const d = x.close - c[i - 1].close; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; rsi.push(l === 0 ? 100 : 100 - 100 / (1 + g / l)); });
  const atr: number[] = []; let a = 0;
  c.forEach((x, i) => { const tr = i ? Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)) : x.high - x.low; a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14; atr.push(a); });
  const volAvg: number[] = []; let sum = 0;
  c.forEach((x, i) => { sum += x.volume; if (i >= 20) sum -= c[i - 20].volume; volAvg.push(sum / Math.min(i + 1, 20)); });
  return { c, ema9: ema(9), ema21: ema(21), rsi, atr, volAvg };
}
const hi = (c: Candle[], a: number, b: number) => { let m = -Infinity; for (let i = Math.max(0, a); i < b; i++) m = Math.max(m, c[i].high); return m; };
const lo = (c: Candle[], a: number, b: number) => { let m = Infinity; for (let i = Math.max(0, a); i < b; i++) m = Math.min(m, c[i].low); return m; };

// Does the pattern fire on candle i (using candles up to i only)?
export function fires(key: StratKey, s: Series, i: number): boolean {
  const { c, ema9, ema21, rsi, atr, volAvg } = s;
  if (i < 30) return false;
  const x = c[i];
  switch (key) {
    case "breakout":
      return x.close > hi(c, i - 20, i) && x.volume > 1.8 * (volAvg[i - 1] || Infinity) && x.close > x.open;
    case "pullback":
      return ema9[i] > ema21[i] && ema21[i] > ema21[i - 5] && x.low <= ema21[i] * 1.004 && x.close > ema21[i] && x.close > x.open;
    case "squeeze": {
      const width = hi(c, i - 20, i) - lo(c, i - 20, i);
      return width < 4 * atr[i - 1] && x.close > hi(c, i - 20, i) && x.close > x.open;
    }
    case "flag": {
      for (let end = i - 3; end >= i - 8; end--) {
        const lowP = lo(c, end - 6, end + 1), highP = c[end].high;
        if (highP < hi(c, end - 6, i)) continue;
        const push = highP - lowP;
        if (push < 4 * atr[end]) continue;
        const retrace = (highP - lo(c, end + 1, i)) / push;
        if (retrace > 0.1 && retrace < 0.5 && x.close > c[i - 1].high) return true;
      }
      return false;
    }
    case "rebound":
      return rsi[i - 1] < 32 && rsi[i] > rsi[i - 1] + 4 && x.close > c[i - 1].high;
  }
}

// The exact trade rules used live: stop 4-7% below (beyond the recent swing low), target +net%
// after costs, time limit in candles. Judged cautiously: a candle touching both counts as a loss.
export function stopPctFor(s: Series, i: number) {
  const price = s.c[i].close;
  const swing = lo(s.c, i - 12, i + 1) - s.atr[i] * 0.5;
  return Math.min(7, Math.max(4, ((price - swing) / price) * 100));
}
function simulate(s: Series, key: StratKey, costPct: number, netTarget: number, horizon: number) {
  const out: number[] = [];
  const c = s.c;
  for (let i = 30; i < c.length - 2; i++) {
    if (!fires(key, s, i)) continue;
    const entry = c[i + 1].open; // buy at the next candle's open
    const stop = entry * (1 - stopPctFor(s, i) / 100);
    const target = entry * (1 + (netTarget + costPct) / 100);
    let exit = 0, j = i + 1;
    for (; j < Math.min(c.length, i + 1 + horizon); j++) {
      if (c[j].low <= stop) { exit = stop; break; }
      if (c[j].high >= target) { exit = target; break; }
    }
    if (!exit) {
      if (i + 1 + horizon > c.length) break; // not enough candles after it to judge
      exit = c[Math.min(c.length - 1, i + horizon)].close;
    }
    out.push(((exit - entry) / entry) * 100 - costPct);
    i = j; // no overlapping trades
  }
  return out;
}

export function learn(frames: { tf: "5m" | "1h"; candles: Candle[] }[], costPct: number, netTarget = 10): Learned {
  const table: StratResult[] = [];
  for (const f of frames) {
    if (f.candles.length < 80) continue;
    const s = series(f.candles);
    const horizon = f.tf === "5m" ? 48 : 12; // about 4 hours / 12 hours
    for (const st of STRATS) {
      const r = simulate(s, st.key, costPct, netTarget, horizon);
      if (!r.length) continue;
      const wins = r.filter((x) => x > 0).length;
      table.push({
        key: st.key, label: st.label, tf: f.tf, trades: r.length, wins,
        avgNetPct: r.reduce((a, b) => a + b, 0) / r.length,
        winChancePct: Math.round(((wins + 1) / (r.length + 2)) * 100), // shrunk toward 50% when there are few trades
      });
    }
  }
  // Rank by average result, trusting patterns with more trades (each trade adds confidence).
  const merit = (t: StratResult) => t.avgNetPct * Math.sqrt(Math.min(t.trades, 12));
  table.sort((a, b) => merit(b) - merit(a));
  const best = table.find((t) => t.trades >= 3 && t.avgNetPct > 0.5) ?? null;
  const summary = best
    ? `"${best.label}" on ${best.tf} candles has paid on this coin: ${best.trades} past trades, ${best.wins} reached +${netTarget}% after fees, average ${best.avgNetPct >= 0 ? "+" : ""}${best.avgNetPct.toFixed(1)}% per trade.`
    : `No simple pattern has paid on this coin recently with a +${netTarget}% target after fees${table.length ? ` (closest: "${table[0].label}" on ${table[0].tf}, average ${table[0].avgNetPct >= 0 ? "+" : ""}${table[0].avgNetPct.toFixed(1)}% over ${table[0].trades} trade${table[0].trades === 1 ? "" : "s"})` : ""}.`;
  return { at: Date.now(), netTargetPct: netTarget, table: table.slice(0, 10), best, summary };
}

// Is the learned pattern on the newest closed candle? (the last candle may still be forming)
export function firesNow(best: StratResult, candles: Candle[]): { yes: boolean; closedAt: number; stopPct: number } {
  const s = series(candles);
  const i = candles.length - 2;
  return { yes: i > 30 && fires(best.key, s, i), closedAt: candles[i]?.time ?? 0, stopPct: i > 30 ? stopPctFor(s, i) : 5 };
}

// Where the pattern would trigger from here: the level the agent is watching, with the exit and
// target it would use if bought there. null for patterns with no fixed level (RSI rebound).
export type Watch = { key: StratKey; label: string; tf: string; side: "above" | "below"; price: number; stop: number; target: number; live: boolean; at: number };
export function watchLevel(st: StratResult, candles: Candle[], costPct: number, netTarget: number, live: boolean): Watch | null {
  if (candles.length < 40) return null;
  const s = series(candles);
  const i = candles.length - 2; // newest closed candle
  let price = 0;
  let side: Watch["side"] = "above";
  if (st.key === "breakout" || st.key === "squeeze") price = hi(candles, i - 19, i + 1);
  else if (st.key === "flag") price = hi(candles, i - 7, i + 1);
  else if (st.key === "pullback") { price = s.ema21[i]; side = "below"; }
  else return null;
  if (!(price > 0)) return null;
  const stopPct = stopPctFor(s, i);
  return { key: st.key, label: st.label, tf: st.tf, side, price, stop: price * (1 - stopPct / 100), target: price * (1 + (netTarget + costPct) / 100), live, at: Date.now() };
}
