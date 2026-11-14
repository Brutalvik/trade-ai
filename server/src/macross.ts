// Moving-average crossover: a fast average of the closing prices crossing a slow one.
//   BUY   the fast average was at or below the slow one on the candle before, and is above it now
//   SELL  the fast average was at or above the slow one on the candle before, and is below it now
//   HOLD  no crossover between those two candles
// It is worked out on CLOSED candles only. A candle that is still forming changes until it
// closes, and a signal read from it can appear and vanish again; so the check is made once for
// every new candle, at its close.
// This is one more signal for the decision model, not a decision: the model gets the signal and
// the two averages next to everything else it reads (see ai.ts and patterns.ts).
import { getCandlesWithSource, type Candle, type CandleSource, type Timeframe } from "./data.js";

export type MaKind = "sma" | "ema";
export type CrossSignal = "BUY" | "SELL" | "HOLD";
export type MaCrossOptions = {
  fast?: number; // candles in the fast average (default 20)
  slow?: number; // candles in the slow average (default 50)
  kind?: MaKind; // simple average (default) or exponential
  stepSec?: number; // length of one candle in seconds: lets a candle that is still forming be left out
  nowSec?: number; // "now" for that check (default: the clock)
};
export type MaCross = {
  signal: CrossSignal;
  ready: boolean; // false = too few closed candles to have both averages on two candles in a row (signal is HOLD)
  kind: MaKind;
  fastPeriod: number;
  slowPeriod: number;
  fast: number | null; // the fast average on the newest closed candle (t)
  slow: number | null; // the slow average on it
  prevFast: number | null; // the same on the candle before (t-1)
  prevSlow: number | null;
  spreadPct: number | null; // how far the fast average is above (+) or below (-) the slow one, in %
  trend: "up" | "down" | "flat" | null; // where the fast average is now: above, below or on the slow one
  price: number | null; // the close of the newest closed candle
  time: number | null; // that candle's time (unix seconds), when candles were given
  used: number; // closed candles the averages were worked out from
  // The most recent crossover in the data (candlesAgo 0 = on the newest closed candle).
  lastCross: { signal: "BUY" | "SELL"; candlesAgo: number; time: number | null; price: number } | null;
  note: string; // the same in one plain sentence
};

export const MA_FAST = 20;
export const MA_SLOW = 50;
export const TF_SECONDS: Record<Timeframe, number> = { "1s": 1, "5s": 5, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

// The average of the last `period` values at every position (null until there are enough).
// "ema" starts from the simple average of the first `period` values, as charting tools do.
export function movingAverage(values: readonly number[], period: number, kind: MaKind = "sma"): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (!(period >= 1) || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let avg = sum / period;
  out[period - 1] = avg;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    if (kind === "ema") avg = values[i] * k + avg * (1 - k);
    else {
      sum += values[i] - values[i - period];
      avg = sum / period;
    }
    out[i] = avg;
  }
  return out;
}

// The rule itself, on two candles in a row: (t-1) and (t).
export function crossOf(prevFast: number, prevSlow: number, fast: number, slow: number): CrossSignal {
  if (prevFast <= prevSlow && fast > slow) return "BUY";
  if (prevFast >= prevSlow && fast < slow) return "SELL";
  return "HOLD";
}

const money = (n: number) => `$${Number(n.toPrecision(5))}`;

// The signal for a list of closing prices or candles (oldest first, as the app keeps them).
export function maCrossover(input: readonly number[] | readonly Candle[], opts: MaCrossOptions = {}): MaCross {
  const fastPeriod = Math.floor(opts.fast ?? MA_FAST), slowPeriod = Math.floor(opts.slow ?? MA_SLOW);
  if (!(fastPeriod >= 1 && slowPeriod > fastPeriod)) throw new Error("The fast average must be shorter than the slow one");
  const kind: MaKind = opts.kind === "ema" ? "ema" : "sma";
  const candles: Candle[] | null = input.length && typeof input[0] !== "number" ? (input as Candle[]).slice() : null;
  if (candles && opts.stepSec) {
    // Leave out a candle that has not closed yet.
    const now = opts.nowSec ?? Date.now() / 1000;
    while (candles.length && candles[candles.length - 1].time + opts.stepSec > now) candles.pop();
  }
  const closes = candles ? candles.map((c) => c.close) : (input as number[]).filter((v) => Number.isFinite(v));
  const f = movingAverage(closes, fastPeriod, kind), s = movingAverage(closes, slowPeriod, kind);
  const t = closes.length - 1;
  const base = { kind, fastPeriod, slowPeriod, used: closes.length, price: t >= 0 ? closes[t] : null, time: candles && t >= 0 ? candles[t].time : null };
  if (t < 1 || f[t] === null || s[t] === null || f[t - 1] === null || s[t - 1] === null)
    return { ...base, signal: "HOLD", ready: false, fast: t >= 0 ? f[t] : null, slow: t >= 0 ? s[t] : null, prevFast: null, prevSlow: null, spreadPct: null, trend: null, lastCross: null, note: `Not enough closed candles yet for the ${fastPeriod}/${slowPeriod} averages (needs ${slowPeriod + 1}, has ${closes.length}).` };
  const fast = f[t]!, slow = s[t]!, prevFast = f[t - 1]!, prevSlow = s[t - 1]!;
  const signal = crossOf(prevFast, prevSlow, fast, slow);
  let lastCross: MaCross["lastCross"] = null;
  for (let i = t; i >= 1 && !lastCross; i--) {
    if (f[i - 1] === null || s[i - 1] === null) break;
    const x = crossOf(f[i - 1]!, s[i - 1]!, f[i]!, s[i]!);
    if (x !== "HOLD") lastCross = { signal: x, candlesAgo: t - i, time: candles ? candles[i].time : null, price: closes[i] };
  }
  const spreadPct = slow > 0 ? ((fast - slow) / slow) * 100 : 0;
  const trend = fast > slow ? "up" : fast < slow ? "down" : "flat";
  const where = `the ${fastPeriod}-candle average (${money(fast)}) is ${Math.abs(spreadPct).toFixed(2)}% ${fast >= slow ? "above" : "below"} the ${slowPeriod}-candle average (${money(slow)})`;
  const note = signal === "BUY" ? `BUY signal: the ${fastPeriod}-candle average (${money(fast)}) crossed above the ${slowPeriod}-candle average (${money(slow)}) on the newest closed candle.`
    : signal === "SELL" ? `SELL signal: the ${fastPeriod}-candle average (${money(fast)}) crossed below the ${slowPeriod}-candle average (${money(slow)}) on the newest closed candle.`
      : `No crossover on the newest closed candle: ${where}${lastCross ? `; the last crossover was a ${lastCross.signal} ${lastCross.candlesAgo} candle${lastCross.candlesAgo === 1 ? "" : "s"} ago at ${money(lastCross.price)}` : "; no crossover in the candles given"}.`;
  return { ...base, signal, ready: true, fast, slow, prevFast, prevSlow, spreadPct, trend, lastCross, note };
}

// The same for a coin's market: reads its candles and returns the signal from the newest closed
// ones (100 by default), with where the candles came from.
export type MaCrossReport = MaCross & { chain: string; pool: string; tf: Timeframe; source: CandleSource };
export async function fetchMaCrossover(chain: string, pool: string, tf: Timeframe = "5m", opts: MaCrossOptions & { candles?: number } = {}): Promise<MaCrossReport> {
  const want = Math.max((opts.slow ?? MA_SLOW) + 2, Math.min(1000, Math.floor(opts.candles ?? 100)));
  // Asked for the way the chart and the AI ask (300 candles), so one request to the data source
  // serves all three; the signal then uses the newest `want` candles that have closed.
  const r = await getCandlesWithSource(chain, pool, tf, Math.max(300, want + 1));
  const step = TF_SECONDS[tf] ?? 300;
  const closed = r.candles.filter((c) => c.time + step <= Date.now() / 1000).slice(-want);
  return { ...maCrossover(closed, { fast: opts.fast, slow: opts.slow, kind: opts.kind }), chain, pool, tf, source: r.origin };
}

// The signal as the app shows it (one per chart), kept with the AI's plan.
export type MaView = { tf: string; signal: CrossSignal; trend: "up" | "down" | "flat"; spreadPct: number; fast: number; slow: number; last?: { signal: "BUY" | "SELL"; candlesAgo: number; price: number; time: number | null } };
export function maView(tf: string, m: MaCross | null): MaView | null {
  if (!m?.ready || m.fast === null || m.slow === null || m.spreadPct === null || !m.trend) return null;
  return { tf, signal: m.signal, trend: m.trend, spreadPct: Number(m.spreadPct.toFixed(2)), fast: m.fast, slow: m.slow, ...(m.lastCross ? { last: m.lastCross } : {}) };
}
