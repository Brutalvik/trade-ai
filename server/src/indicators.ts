import type { Candle } from "./data.js";

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length <= period) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function atr(c: Candle[], period = 14): number {
  if (c.length < 2) return 0;
  const trs = c.slice(1).map((x, i) => Math.max(x.high - x.low, Math.abs(x.high - c[i].close), Math.abs(x.low - c[i].close)));
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// MACD (12/26/9) on closing prices: the gap between a fast and a slow average ("the MACD line"),
// that gap's own 9-candle average ("the signal line"), and the difference between the two ("the
// histogram"). Above zero and growing = momentum building upward; the histogram changing sign is
// the MACD line crossing its signal line. prevHist = the histogram one candle earlier.
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): { macd: number; signal: number; hist: number; prevHist: number } | null {
  if (closes.length < slow + signal) return null;
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const sig = ema(line, signal);
  return { macd: line.at(-1)!, signal: sig.at(-1)!, hist: line.at(-1)! - sig.at(-1)!, prevHist: line.at(-2)! - sig.at(-2)! };
}

// Bollinger Bands (the last 20 closes, 2 standard deviations either side of their average):
// pctB = where the price sits between the bands (0 = on the lower band, 1 = on the upper; it can
// go outside), widthPct = how far apart the bands are, as % of the middle.
export function bollinger(closes: number[], period = 20, mult = 2): { mid: number; upper: number; lower: number; pctB: number; widthPct: number } | null {
  if (closes.length < period) return null;
  const w = closes.slice(-period);
  const mid = w.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + mult * sd, lower = mid - mult * sd;
  return { mid, upper, lower, pctB: upper > lower ? (closes.at(-1)! - lower) / (upper - lower) : 0.5, widthPct: mid > 0 ? ((upper - lower) / mid) * 100 : 0 };
}

export type Snapshot = {
  price: number;
  ema9: number;
  ema21: number;
  ema50: number;
  rsi14: number;
  atrPct: number;
  volRatio: number; // last 5 candles volume vs prior 20
  change1: number;
  change12: number;
  high50: number;
  low50: number;
  techScore: number; // -100..100 quick heuristic, NOT a prediction
  // MACD: the histogram as % of the price, whether it grew on the last candle, and a cross of the
  // signal line on the last candle. Missing with under 35 candles.
  macdHistPct?: number;
  macdRising?: boolean;
  macdCross?: "up" | "down";
  bbPctB?: number; // Bollinger: 0 = on the lower band, 1 = on the upper
  bbWidthPct?: number; // ...and how wide the bands are, % of the middle
};

export function snapshot(c: Candle[]): Snapshot | null {
  if (c.length < 30) return null;
  const closes = c.map((x) => x.close);
  const price = closes.at(-1)!;
  const e9 = ema(closes, 9).at(-1)!;
  const e21 = ema(closes, 21).at(-1)!;
  const e50 = ema(closes, 50).at(-1)!;
  const r = rsi(closes);
  const a = atr(c);
  const vols = c.map((x) => x.volume);
  const recentVol = vols.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const baseVol = vols.slice(-25, -5).reduce((s, v) => s + v, 0) / 20 || 1;
  const last50 = c.slice(-50);
  const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : 0);

  let score = 0;
  score += e9 > e21 ? 20 : -20;
  score += price > e50 ? 15 : -15;
  score += r < 30 ? 15 : r > 75 ? -20 : r > 50 ? 10 : -5;
  score += recentVol / baseVol > 1.5 ? (pct(price, closes.at(-6)!) > 0 ? 20 : -20) : 0;
  score += pct(price, closes.at(-13)!) > 0 ? 10 : -10;
  const m = macd(closes), bb = bollinger(closes);

  return {
    ...(m && price > 0 ? { macdHistPct: (m.hist / price) * 100, macdRising: m.hist > m.prevHist, ...(m.hist > 0 && m.prevHist <= 0 ? { macdCross: "up" as const } : m.hist < 0 && m.prevHist >= 0 ? { macdCross: "down" as const } : {}) } : {}),
    ...(bb ? { bbPctB: bb.pctB, bbWidthPct: bb.widthPct } : {}),
    price,
    ema9: e9,
    ema21: e21,
    ema50: e50,
    rsi14: r,
    atrPct: (a / price) * 100,
    volRatio: recentVol / baseVol,
    change1: pct(price, closes.at(-2)!),
    change12: pct(price, closes.at(-13)!),
    high50: Math.max(...last50.map((x) => x.high)),
    low50: Math.min(...last50.map((x) => x.low)),
    techScore: Math.max(-100, Math.min(100, score)),
  };
}

// Key price levels on one chart, worked out by code so the AI doesn't have to find them in the
// raw candles: recent swing highs and lows (turning points with 3 candles on each side), the
// volume-weighted average price, and where the price sits in the range.
export type Levels = { swingHighs: number[]; swingLows: number[]; vwap: number; high: number; low: number; fromHighPct: number; fromLowPct: number };
export function keyLevels(c: Candle[], span = 3, keep = 3): Levels | null {
  if (c.length < span * 2 + 5) return null;
  const highs: number[] = [], lows: number[] = [];
  for (let i = c.length - 1 - span; i >= span && (highs.length < keep || lows.length < keep); i--) {
    let isHigh = true, isLow = true;
    for (let d = 1; d <= span; d++) {
      if (c[i - d].high > c[i].high || c[i + d].high > c[i].high) isHigh = false;
      if (c[i - d].low < c[i].low || c[i + d].low < c[i].low) isLow = false;
    }
    // Levels within 0.15% of one already listed are the same level: list it once.
    const fresh = (list: number[], v: number) => !list.some((x) => Math.abs(x - v) / v < 0.0015);
    if (isHigh && highs.length < keep && fresh(highs, c[i].high)) highs.push(c[i].high);
    if (isLow && lows.length < keep && fresh(lows, c[i].low)) lows.push(c[i].low);
  }
  let pv = 0, v = 0;
  for (const x of c) { pv += ((x.high + x.low + x.close) / 3) * x.volume; v += x.volume; }
  const price = c[c.length - 1].close;
  const high = Math.max(...c.map((x) => x.high)), low = Math.min(...c.map((x) => x.low));
  return { swingHighs: highs, swingLows: lows, vwap: v > 0 ? pv / v : price, high, low, fromHighPct: ((price - high) / high) * 100, fromLowPct: ((price - low) / low) * 100 };
}
