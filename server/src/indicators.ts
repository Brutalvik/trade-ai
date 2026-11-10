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

  return {
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
