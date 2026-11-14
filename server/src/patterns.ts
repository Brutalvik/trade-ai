// Chart patterns, found by code (no AI): tight ranges, breakouts, flags, double bottoms/tops,
// trend structure, stretched prices. Each pattern is also back-tested on the same chart: every
// earlier time it appeared, did the price go on to gain 2 ATR before losing 1.5 ATR?
// The AI gets both: what's on the chart now, and how that pattern has played out on this coin.
import { isSecondsTf, type Candle, type Timeframe } from "./data.js";
import { crossOf, MA_FAST, MA_SLOW, movingAverage, TF_SECONDS } from "./macross.js";

export type Bias = "up" | "down" | "neutral";
export type PatternHit = { key: string; label: string; bias: Bias; level?: number; note: string };
export type PatternStat = { seen: number; worked: number; avgPct: number };
export type FramePatterns = { tf: string; hits: (PatternHit & { stat?: PatternStat })[] };

type Ctx = { c: Candle[]; atr: number[]; ema21: number[]; rsi: number[]; volAvg: number[]; maFast: (number | null)[]; maSlow: (number | null)[] };

function prep(c: Candle[]): Ctx {
  const atr: number[] = [];
  let a = 0;
  c.forEach((x, i) => {
    const tr = i ? Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)) : x.high - x.low;
    a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14;
    atr.push(a);
  });
  const ema21: number[] = [];
  const k = 2 / 22;
  c.forEach((x, i) => ema21.push(i ? x.close * k + ema21[i - 1] * (1 - k) : x.close));
  const rsi: number[] = [];
  let g = 0, l = 0;
  c.forEach((x, i) => {
    if (!i) return rsi.push(50);
    const d = x.close - c[i - 1].close;
    g = (g * 13 + Math.max(d, 0)) / 14;
    l = (l * 13 + Math.max(-d, 0)) / 14;
    rsi.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
  });
  const volAvg: number[] = [];
  c.forEach((_, i) => {
    const s = c.slice(Math.max(0, i - 20), i);
    volAvg.push(s.length ? s.reduce((t, x) => t + x.volume, 0) / s.length : 0);
  });
  const closes = c.map((x) => x.close);
  return { c, atr, ema21, rsi, volAvg, maFast: movingAverage(closes, MA_FAST), maSlow: movingAverage(closes, MA_SLOW) };
}

// The moving-average crossover (macross.ts) on candle i: did the fast average cross the slow one there?
function maCrossAt({ maFast, maSlow }: Ctx, i: number): "BUY" | "SELL" | null {
  if (i < 1) return null;
  const f = maFast[i], s = maSlow[i], pf = maFast[i - 1], ps = maSlow[i - 1];
  if (f === null || s === null || pf === null || ps === null) return null;
  const x = crossOf(pf, ps, f, s);
  return x === "HOLD" ? null : x;
}
const isMaCross = (key: string) => key === "ma_cross_up" || key === "ma_cross_down";

const hi = (c: Candle[], a: number, b: number) => Math.max(...c.slice(a, b).map((x) => x.high));
const lo = (c: Candle[], a: number, b: number) => Math.min(...c.slice(a, b).map((x) => x.low));

// Swing points: a candle whose high (low) is the highest (lowest) of 2 candles on each side.
function swings(c: Candle[], end: number, kind: "high" | "low", count: number) {
  const out: { i: number; p: number }[] = [];
  for (let i = end - 3; i >= 2 && out.length < count; i--) {
    const v = kind === "high" ? c[i].high : c[i].low;
    const ok = [-2, -1, 1, 2].every((d) => (kind === "high" ? c[i + d].high <= v : c[i + d].low >= v));
    if (ok) out.push({ i, p: v });
  }
  return out; // newest first
}

const pct = (a: number, b: number) => ((a - b) / b) * 100;
const RANGE = 20;

// Each detector looks only at candles up to index i (so it can be back-tested).
const DETECTORS: { key: string; label: string; bias: Bias; find: (x: Ctx, i: number) => { level?: number; note: string } | null }[] = [
  {
    key: "range_breakout",
    label: "Breakout from a range, with volume",
    bias: "up",
    find: ({ c, volAvg }, i) => {
      if (i < RANGE + 2) return null;
      const top = hi(c, i - RANGE - 1, i - 1);
      const bottom = lo(c, i - RANGE - 1, i - 1);
      const vol = (c[i].volume + c[i - 1].volume) / 2;
      if (c[i].close > top && c[i - 1].close <= top * 1.002 && vol > 1.8 * (volAvg[i - 1] || Infinity))
        return { level: top, note: `closed above the ${RANGE}-candle high ${sig(top)} (range ${pct(top, bottom).toFixed(1)}% tall) on ${(vol / volAvg[i - 1]).toFixed(1)}x volume` };
      return null;
    },
  },
  {
    key: "range_breakdown",
    label: "Breakdown below a range, with volume",
    bias: "down",
    find: ({ c, volAvg }, i) => {
      if (i < RANGE + 2) return null;
      const bottom = lo(c, i - RANGE - 1, i - 1);
      const vol = (c[i].volume + c[i - 1].volume) / 2;
      if (c[i].close < bottom && c[i - 1].close >= bottom * 0.998 && vol > 1.8 * (volAvg[i - 1] || Infinity))
        return { level: bottom, note: `closed below the ${RANGE}-candle low ${sig(bottom)} on ${(vol / volAvg[i - 1]).toFixed(1)}x volume` };
      return null;
    },
  },
  {
    key: "squeeze",
    label: "Tight range (coiling before a move)",
    bias: "neutral",
    find: ({ c, atr }, i) => {
      if (i < 100) return null;
      const h = hi(c, i - RANGE + 1, i + 1), l = lo(c, i - RANGE + 1, i + 1);
      const width = h - l;
      // typical width of a 20-candle window over the previous 80 candles
      let sum = 0, n = 0;
      for (let j = i - 80; j <= i - RANGE; j += 5) { sum += hi(c, j - RANGE + 1, j + 1) - lo(c, j - RANGE + 1, j + 1); n++; }
      const typical = sum / n;
      if (width < 0.55 * typical && width < 4 * atr[i]) return { level: h, note: `last ${RANGE} candles stayed between ${sig(l)} and ${sig(h)}, about half the usual swing: a breakout above ${sig(h)} or a break below ${sig(l)} often follows` };
      return null;
    },
  },
  {
    key: "bull_flag",
    label: "Bull flag (strong push, shallow pause)",
    bias: "up",
    find: ({ c, atr }, i) => {
      if (i < 20) return null;
      // a push of 4+ ATR within 6 candles, ending 3-10 candles ago
      for (let end = i - 3; end >= i - 10; end--) {
        const start = end - 6;
        const lowP = lo(c, start, end + 1), highP = c[end].high;
        if (highP < hi(c, start, i + 1)) continue; // the push high must still be the high
        const push = highP - lowP;
        if (push < 4 * atr[end]) continue;
        const pullLow = lo(c, end + 1, i + 1);
        const retrace = (highP - pullLow) / push;
        const pushVol = c.slice(start, end + 1).reduce((s, x) => s + x.volume, 0) / (end - start + 1);
        const flagVol = c.slice(end + 1, i + 1).reduce((s, x) => s + x.volume, 0) / (i - end);
        if (retrace > 0.1 && retrace < 0.5 && flagVol < 0.7 * pushVol)
          return { level: highP, note: `pushed ${pct(highP, lowP).toFixed(1)}% then pulled back only ${(retrace * 100).toFixed(0)}% on lighter volume; a move above ${sig(highP)} continues it` };
      }
      return null;
    },
  },
  {
    key: "double_bottom",
    label: "Double bottom",
    bias: "up",
    find: ({ c, atr }, i) => {
      const lows = swings(c, i + 1, "low", 2);
      if (lows.length < 2) return null;
      const [b, a] = lows;
      if (b.i - a.i < 6 || Math.abs(b.p - a.p) > atr[i] * 0.8) return null;
      const neck = hi(c, a.i, b.i + 1);
      if (c[i].close > neck && c[i - 1].close <= neck) return { level: neck, note: `two lows near ${sig(Math.min(a.p, b.p))}, price just closed above the middle peak ${sig(neck)}` };
      return null;
    },
  },
  {
    key: "double_top",
    label: "Double top",
    bias: "down",
    find: ({ c, atr }, i) => {
      const highs = swings(c, i + 1, "high", 2);
      if (highs.length < 2) return null;
      const [b, a] = highs;
      if (b.i - a.i < 6 || Math.abs(b.p - a.p) > atr[i] * 0.8) return null;
      const neck = lo(c, a.i, b.i + 1);
      if (c[i].close < neck && c[i - 1].close >= neck) return { level: neck, note: `two highs near ${sig(Math.max(a.p, b.p))}, price just closed below the middle dip ${sig(neck)}` };
      return null;
    },
  },
  {
    key: "uptrend",
    label: "Higher highs and higher lows",
    bias: "up",
    find: ({ c }, i) => {
      const H = swings(c, i + 1, "high", 2), L = swings(c, i + 1, "low", 2);
      if (H.length < 2 || L.length < 2) return null;
      if (H[0].p > H[1].p && L[0].p > L[1].p && c[i].close > L[0].p) return { level: L[0].p, note: `last swing low ${sig(L[0].p)} is above the one before (${sig(L[1].p)}); the trend holds while price stays above ${sig(L[0].p)}` };
      return null;
    },
  },
  {
    key: "downtrend",
    label: "Lower highs and lower lows",
    bias: "down",
    find: ({ c }, i) => {
      const H = swings(c, i + 1, "high", 2), L = swings(c, i + 1, "low", 2);
      if (H.length < 2 || L.length < 2) return null;
      if (H[0].p < H[1].p && L[0].p < L[1].p && c[i].close < H[0].p) return { level: H[0].p, note: `last swing high ${sig(H[0].p)} is below the one before (${sig(H[1].p)}); falling until price gets back above ${sig(H[0].p)}` };
      return null;
    },
  },
  {
    key: "stretched",
    label: "Stretched far above its average (pullback risk)",
    bias: "down",
    find: ({ c, atr, ema21, rsi }, i) => {
      if (i < 30) return null;
      if ((c[i].close - ema21[i]) / (atr[i] || Infinity) > 3 && rsi[i] > 75) return { level: ema21[i], note: `price is ${((c[i].close - ema21[i]) / atr[i]).toFixed(1)} ATR above its 21-candle average with RSI ${rsi[i].toFixed(0)}; chasing here often buys the top` };
      return null;
    },
  },
  // The moving-average crossover strategy: a BUY signal when the 20-candle average crosses above
  // the 50-candle average, a SELL signal when it crosses below (closed candles only).
  {
    key: "ma_cross_up",
    label: `Moving averages crossed up (${MA_FAST} over ${MA_SLOW}): BUY signal`,
    bias: "up",
    find: (x, i) => (maCrossAt(x, i) === "BUY" ? { level: x.maSlow[i]!, note: `the ${MA_FAST}-candle average (${sig(x.maFast[i]!)}) crossed above the ${MA_SLOW}-candle average (${sig(x.maSlow[i]!)})` } : null),
  },
  {
    key: "ma_cross_down",
    label: `Moving averages crossed down (${MA_FAST} under ${MA_SLOW}): SELL signal`,
    bias: "down",
    find: (x, i) => (maCrossAt(x, i) === "SELL" ? { level: x.maSlow[i]!, note: `the ${MA_FAST}-candle average (${sig(x.maFast[i]!)}) crossed below the ${MA_SLOW}-candle average (${sig(x.maSlow[i]!)})` } : null),
  },
];

function sig(n: number) {
  return String(Number(n.toPrecision(5)));
}

// How a pattern played out each earlier time it appeared on this chart: from that candle's close,
// did the price reach +2 ATR before -1.5 ATR (bullish), or -2 ATR before +1.5 ATR (bearish)?
const HORIZON = 24;
function backtest(x: Ctx, d: (typeof DETECTORS)[number]): PatternStat {
  const { c, atr } = x;
  let seen = 0, worked = 0, sum = 0, lastHit = -99;
  for (let i = 30; i < c.length - 2; i++) {
    if (i - lastHit < 6) continue; // one count per appearance
    if (!d.find(x, i)) continue;
    lastHit = i;
    const entry = c[i].close, a = atr[i];
    const up = d.bias !== "down";
    const win = up ? entry + 2 * a : entry - 2 * a;
    const lose = up ? entry - 1.5 * a : entry + 1.5 * a;
    let res = 0, decided = false;
    for (let j = i + 1; j <= Math.min(c.length - 1, i + HORIZON); j++) {
      const hitLose = up ? c[j].low <= lose : c[j].high >= lose;
      const hitWin = up ? c[j].high >= win : c[j].low <= win;
      if (hitLose) { res = -1; decided = true; break; } // judge the stop first (cautious)
      if (hitWin) { res = 1; decided = true; break; }
    }
    if (!decided && i + HORIZON >= c.length) continue; // not enough candles after it yet
    seen++;
    if (res === 1) worked++;
    const endP = c[Math.min(c.length - 1, i + HORIZON)].close;
    sum += pct(endP, entry) * (up ? 1 : -1);
  }
  return { seen, worked, avgPct: seen ? sum / seen : 0 };
}

export function findPatterns(tf: string, candles: Candle[]): FramePatterns {
  if (candles.length < 40) return { tf, hits: [] };
  const x = prep(candles);
  const last = candles.length - 1;
  // The newest candle that has closed (the last one is usually still forming): the crossover is
  // read from closed candles only, so it cannot appear and vanish while a candle is being made.
  const step = TF_SECONDS[tf as Timeframe];
  const lastClosed = step && candles[last].time + step > Date.now() / 1000 ? last - 1 : last;
  const hits: FramePatterns["hits"] = [];
  for (const d of DETECTORS) {
    const ma = isMaCross(d.key);
    if (ma && (!step || isSecondsTf(tf as Timeframe))) continue; // not on the 1- and 5-second charts: there it is noise
    // "Now" = on the latest candle, or (for one-candle events) the one or two before it.
    const lookback = d.key === "squeeze" || d.key === "uptrend" || d.key === "downtrend" || d.key === "stretched" || d.key === "bull_flag" ? 0 : 2;
    let found: { level?: number; note: string } | null = null;
    for (let back = 0; back <= lookback && !found; back++) {
      found = d.find(x, (ma ? lastClosed : last) - back);
      if (found && ma) found = { ...found, note: `${found.note} ${back ? `${back} closed candle${back === 1 ? "" : "s"} ago` : "on the newest closed candle"}` };
    }
    if (!found) continue;
    const stat = backtest(x, d);
    hits.push({ key: d.key, label: d.label, bias: d.bias, ...found, ...(stat.seen ? { stat } : {}) });
  }
  return { tf, hits };
}

// For the AI prompt: what's on each chart now, and how each pattern has done on this coin.
export function patternsText(frames: FramePatterns[]): string {
  const lines: string[] = [];
  for (const f of frames) {
    for (const h of f.hits) {
      const s = h.stat;
      const rec = s && s.seen >= 2
        ? ` On this chart it appeared ${s.seen} times before; ${s.worked} of them (${Math.round((s.worked / s.seen) * 100)}%) went on to move 2 ATR ${h.bias === "down" ? "down" : "up"} before 1.5 ATR the other way; average ${s.avgPct >= 0 ? "+" : ""}${s.avgPct.toFixed(1)}% over the next ${HORIZON} candles in that direction.`
        : " Not seen earlier on this chart (no track record).";
      lines.push(`- ${f.tf}: ${h.label} (${h.bias === "up" ? "bullish" : h.bias === "down" ? "bearish" : "neutral"}): ${h.note}.${rec}`);
    }
  }
  if (!lines.length) return "Chart patterns found by code: none clear right now.";
  return `Chart patterns found by code (with how each did earlier on this same chart; use them, but they are not guarantees):\n${lines.join("\n")}`;
}

// Short labels for the app and for recording on trades, e.g. "5m Bull flag ↑".
export function patternTags(frames: FramePatterns[]): string[] {
  return frames.flatMap((f) => f.hits.map((h) => `${f.tf} ${h.label.split(" (")[0].split(",")[0]} ${h.bias === "up" ? "↑" : h.bias === "down" ? "↓" : "↔"}`));
}
