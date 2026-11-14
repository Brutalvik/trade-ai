// Prediction engine for agents.
//
// For one exact order (entry, stop, the minimum-profit level, time limit) it estimates the chance
// that the price reaches the minimum-profit level before the stop, three independent ways, all
// from the coin's own candles:
//   - Parallel worlds: a thousand possible next hours, rebuilt from stretches of the coin's own
//     recent candles (a block bootstrap), once assuming no trend and once assuming the recent
//     trend carries on at half its pace. Every world is traded with the bot's real exit rules.
//   - This coin lately: how often the same order shape worked from every starting point in the
//     last day of 5-minute candles.
//   - Look-alikes: the past moments most like right now, and what happened after them.
// The AI's own estimate (and a panel of AI forecasters) is then combined with these, and every
// forecast is later scored against what really happened, which is what corrects each forecaster
// over time. Nothing in this file calls the network.
import type { Candle } from "./data.js";

export type OrderKind = "buy_now" | "buy_dip" | "buy_breakout";
// An order as percentages, so it can be replayed at any past moment.
export type Shape = {
  offsetPct: number; // entry vs the price now (0 = buy now, negative = a dip, positive = a breakout)
  upPct: number; // entry -> the minimum-profit level
  downPct: number; // entry -> the stop (a positive number)
  holdMin: number; // time limit after buying
  waitMin: number; // how long the order may wait to be filled (0 = immediate)
};
export type SimResult = {
  filledPct: number; // worlds in which the order was filled at all
  pWin: number; // of the filled worlds: reached the minimum-profit level before the stop (0-100)
  pStop: number;
  pNone: number; // neither in time: sold at the time limit
  evPct: number; // average result of a filled world after costs
  winNetPct: number; // average result of the worlds that reached the level (held with the exit rule)
  noneNetPct: number; // average result of the worlds that ran out of time
  minutesToWin: number | null; // typical time to reach the level
};
export type ConePoint = { min: number; lo: number; mid: number; hi: number }; // prices; lo/hi = the middle 80% of worlds
export type Tally = { n: number; wins: number; stops: number; none: number; unfilled: number };
export type Forecast = {
  shape: Shape;
  truncated: boolean; // the time limit was longer than the history can simulate
  assumed: boolean; // the coin has hardly ever reached this order's level lately, so it was judged as a buy at that level
  worlds: { pWin: number; trend: SimResult; flat: SimResult; trendShare: number; paths: number; from: string } | null;
  baseRate: { pWin: number; tally: Tally; hours: number } | null;
  lookalikes: { pWin: number; n: number; wins: number; next60: { mid: number; lo: number; hi: number } | null } | null;
  weights: { worlds: number; lookalikes: number; baseRate: number };
  numbers: number; // the three combined (0-100)
  winNetPct: number; // what reaching the level is worth on average, after costs (rule exit)
  stopShare: number; // of the worlds that failed: the share that hit the stop (the rest ran out of time)
  noneNetPct: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const quantile = (sorted: ArrayLike<number>, q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

// Small seeded generator: the same candles and order always give the same forecast.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (c: Candle[], salt: number) => {
  const last = c[c.length - 1];
  return (Math.imul(last?.time ?? 1, 2654435761) ^ Math.imul(c.length, 40503) ^ Math.round(Math.log(Math.max(last?.close ?? 1, 1e-12)) * 1e6) ^ Math.imul(salt + 1, 97)) >>> 0;
};

// ---------- Candles as moves ----------
// Each candle as log moves from the previous close: where it closed, and how far its high and low reached.
type Steps = { n: number; c: Float64Array; h: Float64Array; l: Float64Array; mean: number; scale: number };
function toSteps(candles: Candle[], recent: number): Steps | null {
  const ok = candles.filter((x) => x.close > 0 && x.high > 0 && x.low > 0);
  const n = ok.length - 1;
  if (n < 40) return null;
  const c = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n);
  const ranges: number[] = [];
  for (let i = 1; i <= n; i++) {
    const prev = ok[i - 1].close;
    const rc = Math.log(ok[i].close / prev);
    c[i - 1] = rc;
    h[i - 1] = Math.max(Math.log(ok[i].high / prev), rc, 0);
    l[i - 1] = Math.min(Math.log(ok[i].low / prev), rc, 0);
    ranges.push(h[i - 1] - l[i - 1]);
  }
  // A single bad print can leave a wick many times the normal range: cap wicks at 6x the typical range.
  const typ = Math.max(median(ranges), 1e-9);
  let sum = 0, absAll = 0, absRecent = 0;
  for (let i = 0; i < n; i++) {
    h[i] = Math.min(h[i], Math.max(c[i], 0) + 6 * typ);
    l[i] = Math.max(l[i], Math.min(c[i], 0) - 6 * typ);
    sum += c[i];
    absAll += Math.abs(c[i]);
    if (i >= n - recent) absRecent += Math.abs(c[i]);
  }
  absAll /= n;
  absRecent /= Math.min(recent, n);
  // Swings come in clusters, but a burst also fades back toward normal: lean part of the way to the last hour.
  const scale = absAll > 0 ? clamp((0.4 * absRecent + 0.6 * absAll) / absAll, 0.6, 1.5) : 1;
  return { n, c, h, l, mean: sum / n, scale };
}

// ---------- Parallel worlds ----------
// Log price vs now, one row per world: the high, low and close of every step.
type Paths = { n: number; steps: number; hi: Float32Array; lo: Float32Array; cl: Float32Array };
// `keep` = how much of the recent drift carries on: 0 = no trend, 0.5 = the trend continues at half its pace
// (a few hours' average move is a noisy guide to the next hour, so it is never carried on in full).
function simulate(S: Steps, steps: number, n: number, seed: number, keep: number, block: number): Paths {
  const hi = new Float32Array(n * steps), lo = new Float32Array(n * steps), cl = new Float32Array(n * steps);
  const rand = rng(seed);
  const drift = S.mean * (1 - keep);
  const span = Math.max(1, S.n - block + 1);
  for (let p = 0; p < n; p++) {
    let pos = 0, s = 0;
    const base = p * steps;
    while (s < steps) {
      const start = Math.floor(rand() * span);
      for (let k = 0; k < block && s < steps; k++, s++) {
        const j = Math.min(S.n - 1, start + k);
        hi[base + s] = pos + (S.h[j] - drift) * S.scale;
        lo[base + s] = pos + (S.l[j] - drift) * S.scale;
        pos += (S.c[j] - drift) * S.scale;
        cl[base + s] = pos;
      }
    }
  }
  return { n, steps, hi, lo, cl };
}

// Trades one order in every world with the bot's rules: the stop until the minimum-profit level
// is reached, then that level is locked as the exit and the exit follows `trailPct` behind the high.
function evaluate(P: Paths, stepMin: number, sh: Shape, costPct: number, trailPct: number): SimResult {
  const entry = Math.log(1 + sh.offsetPct / 100);
  const stop = entry + Math.log(1 - sh.downPct / 100);
  const level = entry + Math.log(1 + sh.upPct / 100);
  const trail = Math.log(1 - trailPct / 100);
  const immediate = Math.abs(sh.offsetPct) < 0.05 || sh.waitMin <= 0;
  const wait = immediate ? 0 : Math.max(1, Math.ceil(sh.waitMin / stepMin));
  const hold = Math.max(1, Math.ceil(sh.holdMin / stepMin));
  const net = (exit: number) => (Math.exp(exit - entry) - 1) * 100 - costPct;
  let filled = 0, wins = 0, stops = 0, none = 0, sumAll = 0, sumWin = 0, sumNone = 0;
  const winSteps: number[] = [];
  for (let p = 0; p < P.n; p++) {
    const b = p * P.steps;
    let s0 = 0;
    if (!immediate) {
      let fill = -1;
      for (let s = 0; s < Math.min(wait, P.steps); s++) {
        if (sh.offsetPct < 0 ? P.lo[b + s] <= entry : P.hi[b + s] >= entry) { fill = s; break; }
      }
      if (fill < 0) continue; // never filled: no trade in this world
      filled++;
      if (sh.offsetPct < 0 && P.lo[b + fill] <= stop) { stops++; sumAll += net(stop); continue; } // fell straight through
      s0 = fill + 1;
    } else filled++;
    const end = Math.min(s0 + hold, P.steps);
    let reached = -1, lost = false;
    for (let s = s0; s < end; s++) {
      if (P.lo[b + s] <= stop) { lost = true; break; } // both in one candle: counted as the stop
      if (P.hi[b + s] >= level) { reached = s; break; }
    }
    if (lost) { stops++; sumAll += net(stop); continue; }
    if (reached < 0) {
      const r = end > s0 ? net(P.cl[b + end - 1]) : -costPct;
      none++; sumAll += r; sumNone += r;
      continue;
    }
    // Reached: the minimum is locked, the exit follows the high.
    let best = P.hi[b + reached];
    let line = Math.max(level, best + trail);
    let exit = NaN;
    if (P.cl[b + reached] <= line) exit = line;
    for (let s = reached + 1; Number.isNaN(exit) && s < P.steps; s++) {
      if (P.lo[b + s] <= line) { exit = line; break; }
      if (P.hi[b + s] > best) { best = P.hi[b + s]; line = Math.max(level, best + trail); }
      if (P.cl[b + s] <= line) exit = line;
    }
    if (Number.isNaN(exit)) exit = Math.max(line, P.cl[b + P.steps - 1]);
    const r = net(exit);
    wins++; sumAll += r; sumWin += r;
    winSteps.push(reached - s0 + 1);
  }
  const pct = (x: number) => (filled ? (x / filled) * 100 : 0);
  return {
    filledPct: (filled / P.n) * 100,
    pWin: pct(wins), pStop: pct(stops), pNone: pct(none),
    evPct: filled ? sumAll / filled : 0,
    winNetPct: wins ? sumWin / wins : sh.upPct - costPct,
    noneNetPct: none ? sumNone / none : -costPct,
    minutesToWin: winSteps.length ? median(winSteps) * stepMin : null,
  };
}
const mix = (a: SimResult, b: SimResult, wa: number): SimResult => {
  const w = (x: number, y: number) => x * wa + y * (1 - wa);
  return {
    filledPct: w(a.filledPct, b.filledPct), pWin: w(a.pWin, b.pWin), pStop: w(a.pStop, b.pStop), pNone: w(a.pNone, b.pNone), evPct: w(a.evPct, b.evPct),
    winNetPct: w(a.winNetPct, b.winNetPct), noneNetPct: w(a.noneNetPct, b.noneNetPct),
    minutesToWin: a.minutesToWin === null ? b.minutesToWin : b.minutesToWin === null ? a.minutesToWin : w(a.minutesToWin, b.minutesToWin),
  };
};

// ---------- What really happened after a moment in the history ----------
export type Outcome = "win" | "stop" | "none" | "unfilled";
// Walks the candles after index `i` for an order with absolute prices. null = not decided yet
// (the candles end before the stop, the level or the time limit).
export function replay(c: Candle[], i: number, o: { immediate: boolean; dip: boolean; entry: number; stop: number; level: number; wait: number; hold: number }): Outcome | null {
  let k = i + 1;
  if (!o.immediate) {
    let fill = -1;
    for (let j = i + 1; j <= i + o.wait; j++) {
      if (j >= c.length) return null;
      if (o.dip ? c[j].low <= o.entry : c[j].high >= o.entry) { fill = j; break; }
    }
    if (fill < 0) return "unfilled";
    if (o.dip && c[fill].low <= o.stop) return "stop";
    k = fill + 1;
  }
  for (let j = k; j < k + o.hold; j++) {
    if (j >= c.length) return null;
    if (c[j].low <= o.stop) return "stop"; // both in one candle: counted as the stop
    if (c[j].high >= o.level) return "win";
  }
  return "none";
}
const steps = (sh: Shape, stepMin: number) => {
  const immediate = Math.abs(sh.offsetPct) < 0.05 || sh.waitMin <= 0;
  return { immediate, wait: immediate ? 0 : Math.max(1, Math.ceil(sh.waitMin / stepMin)), hold: Math.max(1, Math.ceil(sh.holdMin / stepMin)) };
};
function outcomeAt(c: Candle[], i: number, sh: Shape, stepMin: number): Outcome | null {
  const entry = c[i].close * (1 + sh.offsetPct / 100);
  return replay(c, i, { ...steps(sh, stepMin), dip: sh.offsetPct < 0, entry, stop: entry * (1 - sh.downPct / 100), level: entry * (1 + sh.upPct / 100) });
}
// A coin with no direction reaches +up before -down with chance down / (up + down).
const coinFlip = (sh: Shape) => clamp(sh.downPct / (sh.upPct + sh.downPct), 0.02, 0.98);

// ---------- This coin lately ----------
// The same order shape started at every past candle whose whole window is already known.
function tally(c: Candle[], sh: Shape, stepMin: number, from: number, to: number): Tally {
  const t: Tally = { n: 0, wins: 0, stops: 0, none: 0, unfilled: 0 };
  for (let i = from; i <= to; i++) {
    const r = outcomeAt(c, i, sh, stepMin);
    if (r === null) continue;
    if (r === "unfilled") { t.unfilled++; continue; }
    t.n++;
    if (r === "win") t.wins++;
    else if (r === "stop") t.stops++;
    else t.none++;
  }
  return t;
}
// Overlapping windows are not independent: count them as (span / window) separate samples and
// lean on the no-direction figure when there are few.
// `prior` = the chance with no information (the no-trend worlds when there are any).
function shrunk(t: Tally, sh: Shape, stepMin: number, prior = 0.9 * coinFlip(sh)): number {
  const { wait, hold } = steps(sh, stepMin);
  const independent = Math.max(1, Math.min(t.n, (t.n + t.unfilled) / Math.max(1, (wait + hold) / 2)));
  const rate = t.n ? t.wins / t.n : 0;
  return (rate * independent + prior * 4) / (independent + 4);
}

// ---------- Look-alikes ----------
const W = [1, 1, 0.8, 1, 0.7, 0.6, 0.5];
// What the chart looked like at each candle: recent moves (in units of the coin's own swings),
// where the price sits in its range, the volume surge and whether swings are growing.
function features(c: Candle[]): (number[] | null)[] {
  const n = c.length;
  const r = new Float64Array(n);
  for (let i = 1; i < n; i++) r[i] = c[i].close > 0 && c[i - 1].close > 0 ? Math.log(c[i].close / c[i - 1].close) : 0;
  const out: (number[] | null)[] = new Array(n).fill(null);
  for (let i = 36; i < n; i++) {
    let s36 = 0, s6 = 0;
    for (let k = i - 35; k <= i; k++) s36 += r[k] * r[k];
    for (let k = i - 5; k <= i; k++) s6 += r[k] * r[k];
    const sig = Math.max(Math.sqrt(s36 / 36), 1e-6), sig6 = Math.max(Math.sqrt(s6 / 6), 1e-6);
    const move = (k: number) => clamp(Math.log(c[i].close / c[i - k].close) / (sig * Math.sqrt(k)), -4, 4);
    let hi = -Infinity, lo = Infinity, v3 = 0, v24 = 0;
    for (let k = Math.max(0, i - 47); k <= i; k++) { hi = Math.max(hi, c[k].high); lo = Math.min(lo, c[k].low); }
    for (let k = i - 2; k <= i; k++) v3 += c[k].volume;
    for (let k = i - 23; k <= i; k++) v24 += c[k].volume;
    out[i] = [
      move(3), move(12), move(36),
      hi > lo ? ((c[i].close - lo) / (hi - lo)) * 2 - 1 : 0,
      clamp(Math.log((v3 / 3 + 1e-9) / (v24 / 24 + 1e-9)), -2.5, 2.5),
      clamp(Math.log(sig6 / sig), -2, 2),
      clamp(r[i] / sig, -4, 4),
    ];
  }
  return out;
}
// The `k` past moments most like candle `at`, at least half an hour apart, among start points <= `to`.
function nearest(F: (number[] | null)[], at: number, to: number, k: number): number[] {
  const me = F[at];
  if (!me) return [];
  const d: { i: number; d: number }[] = [];
  for (let i = 36; i <= to; i++) {
    const f = F[i];
    if (!f) continue;
    let s = 0;
    for (let q = 0; q < W.length; q++) s += W[q] * (f[q] - me[q]) ** 2;
    d.push({ i, d: s });
  }
  d.sort((a, b) => a.d - b.d);
  const picked: number[] = [];
  for (const x of d) {
    if (picked.every((p) => Math.abs(p - x.i) >= 6)) picked.push(x.i);
    if (picked.length >= k) break;
  }
  return picked;
}
function lookalike(c: Candle[], F: (number[] | null)[], at: number, to: number, sh: Shape, stepMin: number, prior: number, k = 12): { p: number; n: number; wins: number; picked: number[] } | null {
  const picked = nearest(F, at, to, k);
  let n = 0, wins = 0;
  for (const i of picked) {
    const r = outcomeAt(c, i, sh, stepMin);
    if (r === null || r === "unfilled") continue;
    n++;
    if (r === "win") wins++;
  }
  if (n < 5) return null;
  return { p: (wins + 12 * prior) / (n + 12), n, wins, picked };
}

// ---------- The forecast for one order ----------
// Blind tests on real coins (forecasts made at ~2,000 past moments on a dozen trending coins from
// only what was known then, scored against what happened next) settled these:
//   - the no-trend paths were the most accurate of the methods, and carrying the recent trend on
//     (or reversing it) did not help, so the trend-continues paths get a small say;
//   - counting recent outcomes (this coin lately, look-alikes) was noisier, so they get less;
//   - re-weighting by each method's recent record on the same coin made things worse (it chases
//     what just happened), so there is none: the account's scoreboard corrects each forecaster
//     from real outcomes over time instead.
const FINE_STEPS = 240, COARSE_STEPS = 96, WORLDS = 1000, TREND_KEEP = 0.5, TREND_SHARE = 0.15;
const WEIGHTS = { worlds: 0.65, baseRate: 0.25, lookalikes: 0.1 };
export type Desk = ReturnType<typeof desk>;
// Built once per look at a coin: the simulated worlds are shared by every order judged on it.
export function desk(c1: Candle[], c5: Candle[], costPct: number, trailPct: number) {
  const S1 = c1.length >= 150 ? toSteps(c1, 40) : null;
  const S5 = c5.length >= 100 ? toSteps(c5, 12) : null;
  const sets: Record<string, Paths> = {};
  const paths = (fine: boolean, demean: boolean): Paths | null => {
    const S = fine ? S1 : S5;
    if (!S) return null;
    const key = `${fine ? 1 : 5}${demean ? "f" : "t"}`;
    return (sets[key] ??= simulate(S, fine ? FINE_STEPS : COARSE_STEPS, WORLDS, seedOf(fine ? c1 : c5, demean ? 2 : 1), demean ? 0 : TREND_KEEP, fine ? 10 : 4));
  };
  const F = c5.length >= 100 ? features(c5) : [];
  const price = (c1[c1.length - 1] ?? c5[c5.length - 1])?.close ?? 0;

  function forecast(shIn: Shape): Forecast | null {
    if (!(price > 0) || (!S1 && !S5)) return null;
    // The longest window the history can simulate; longer time limits are judged on this much.
    const maxMin = S5 ? (COARSE_STEPS - 12) * 5 : FINE_STEPS - 45;
    const waitMin = Math.abs(shIn.offsetPct) < 0.05 ? 0 : clamp(shIn.waitMin, 0, 120);
    const holdMin = clamp(shIn.holdMin, 5, Math.max(5, maxMin - waitMin));
    const sh: Shape = { ...shIn, waitMin, holdMin, upPct: Math.max(0.1, shIn.upPct), downPct: clamp(shIn.downPct, 0.1, 95) };
    const truncated = holdMin < shIn.holdMin;

    // Parallel worlds: 1-minute candles (the last hours) and 5-minute candles (the last day).
    const from: string[] = [];
    const run = (x: Shape) => {
      const runs: { trend: SimResult; flat: SimResult }[] = [];
      from.length = 0;
      if (S1 && x.waitMin + x.holdMin + 45 <= FINE_STEPS) { runs.push({ trend: evaluate(paths(true, false)!, 1, x, costPct, trailPct), flat: evaluate(paths(true, true)!, 1, x, costPct, trailPct) }); from.push("1-minute"); }
      if (S5) { runs.push({ trend: evaluate(paths(false, false)!, 5, x, costPct, trailPct), flat: evaluate(paths(false, true)!, 5, x, costPct, trailPct) }); from.push("5-minute"); }
      return runs.filter((r) => r.trend.filledPct + r.flat.filledPct > 10); // at least ~5% of the worlds got filled
    };
    let usable = run(sh);
    // A level the coin has hardly ever reached lately (a far dip or breakout): the few worlds that
    // got there say little, and none would mean no forecast at all. Judge it as a buy at that
    // level instead: the same rise and fall from the entry, on the coin's own swings.
    const assumed = !usable.length && waitMin > 0;
    const eff: Shape = assumed ? { ...sh, offsetPct: 0, waitMin: 0 } : sh;
    if (assumed) usable = run(eff);
    let worlds: Forecast["worlds"] = null;
    if (usable.length) {
      const avg = (pick: (r: (typeof usable)[number]) => SimResult) => usable.map(pick).reduce((x, y, i) => mix(x, y, i / (i + 1)));
      const trend = avg((r) => r.trend), flat = avg((r) => r.flat);
      worlds = { pWin: trend.pWin * TREND_SHARE + flat.pWin * (1 - TREND_SHARE), trend, flat, trendShare: TREND_SHARE, paths: WORLDS * 2 * usable.length, from: from.join(" and ") };
    }

    // This coin lately, and the look-alikes (5-minute candles).
    let baseRate: Forecast["baseRate"] = null, lookalikes: Forecast["lookalikes"] = null;
    if (c5.length >= 100) {
      // The same for the counts: an order that was hardly ever filled in the history is counted as a buy at its level.
      let hs = eff;
      let { wait, hold } = steps(hs, 5);
      let last = c5.length - 1 - wait - hold;
      let t = last - 36 >= 30 ? tally(c5, hs, 5, 36, last) : null;
      if (t && t.n < 12 && hs.waitMin > 0) {
        hs = { ...hs, offsetPct: 0, waitMin: 0 };
        ({ wait, hold } = steps(hs, 5));
        last = c5.length - 1 - wait - hold;
        t = last - 36 >= 30 ? tally(c5, hs, 5, 36, last) : null;
      }
      if (t) {
        if (t.n >= 12) {
          const p = shrunk(t, hs, 5, worlds ? worlds.flat.pWin / 100 : undefined);
          baseRate = { pWin: p * 100, tally: t, hours: Math.round(((c5[c5.length - 1].time - c5[36].time) / 3600) * 10) / 10 };
          const la = lookalike(c5, F, c5.length - 1, last, hs, 5, p);
          if (la) {
            const next = la.picked.filter((i) => i + 12 < c5.length).map((i) => (c5[i + 12].close / c5[i].close - 1) * 100).sort((x, y) => x - y);
            lookalikes = { pWin: la.p * 100, n: la.n, wins: la.wins, next60: next.length >= 5 ? { mid: quantile(next, 0.5), lo: next[0], hi: next[next.length - 1] } : null };
          }
        }
      }
    }
    if (!worlds && !baseRate) return null;

    const raw = { worlds: worlds ? WEIGHTS.worlds : 0, lookalikes: lookalikes ? WEIGHTS.lookalikes : 0, baseRate: baseRate ? WEIGHTS.baseRate : 0 };
    const tot = raw.worlds + raw.lookalikes + raw.baseRate;
    const weights = { worlds: raw.worlds / tot, lookalikes: raw.lookalikes / tot, baseRate: raw.baseRate / tot };
    const numbers = (worlds?.pWin ?? 0) * weights.worlds + (lookalikes?.pWin ?? 0) * weights.lookalikes + (baseRate?.pWin ?? 0) * weights.baseRate;
    const f = worlds?.flat;
    const failed = f ? f.pStop + f.pNone : 0;
    return {
      shape: sh, truncated, assumed, worlds, baseRate, lookalikes, weights, numbers: clamp(numbers, 0, 100),
      winNetPct: f ? f.winNetPct : sh.upPct - costPct,
      stopShare: f && failed > 0 ? f.pStop / failed : baseRate && baseRate.tally.stops + baseRate.tally.none > 0 ? baseRate.tally.stops / (baseRate.tally.stops + baseRate.tally.none) : 1,
      noneNetPct: f ? f.noneNetPct : -costPct,
    };
  }

  // Where the price ends up across the no-trend worlds (no trading): the middle 80% of them.
  function cone(minutes: number[]): ConePoint[] {
    const out: ConePoint[] = [];
    for (const m of minutes) {
      const fine = !!S1 && m <= FINE_STEPS;
      if (!fine && (!S5 || m / 5 > COARSE_STEPS)) continue;
      const P = paths(fine, true)!;
      const idx = Math.max(0, Math.round(m / (fine ? 1 : 5)) - 1);
      const v = new Float64Array(P.n);
      for (let p = 0; p < P.n; p++) v[p] = P.cl[p * P.steps + idx];
      v.sort();
      out.push({ min: m, lo: price * Math.exp(quantile(v, 0.1)), mid: price * Math.exp(quantile(v, 0.5)), hi: price * Math.exp(quantile(v, 0.9)) });
    }
    return out;
  }
  return { price, ready: !!(S1 || S5), forecast, cone };
}

// ---------- Combining with the AI, and keeping score ----------
export type FcKey = "ai" | "panel" | "worlds" | "lookalikes" | "baseRate" | "combined";
export const FC_LABEL: Record<FcKey, string> = { ai: "The agent's AI", panel: "AI forecaster panel", worlds: "Simulated paths", lookalikes: "Look-alike moments", baseRate: "This coin lately", combined: "Combined" };
// Running totals per forecaster; older forecasts fade slowly (each new one multiplies the rest by FADE: about the last 200 count).
export type FcStat = { n: number; sumP: number; hits: number; brier: number };
export type FcStats = Partial<Record<FcKey, FcStat>> & { taken?: { n: number; hits: number }; refused?: { n: number; hits: number }; scored?: number };
const FADE = 0.995;
export type Part = { key: FcKey; label: string; pct: number; weight: number; adjPct: number; note?: string };
export type Combined = { pWin: number; parts: Part[]; needPct?: number };

// A forecaster's measured lean (hit rate minus its average forecast) and accuracy, once it has enough scored forecasts.
function record(st: FcStat | undefined) {
  if (!st || st.n < 8) return null;
  const trust = st.n / (st.n + 15);
  return { bias: (st.hits / st.n - st.sumP / st.n) * trust, brier: st.brier / st.n, trust };
}
// Half the weight to the AI side (the agent's AI, plus the panel when it was asked), half to the
// numbers; then each forecaster is corrected for its measured lean and weighted by its accuracy.
export function combineChance(aiPct: number, panelPct: number | null, f: Forecast | null, stats?: FcStats): Combined {
  const parts: Part[] = [];
  const add = (key: FcKey, pct: number, weight: number, note?: string) => parts.push({ key, label: FC_LABEL[key], pct: clamp(pct, 0, 100), weight, adjPct: clamp(pct, 0, 100), ...(note ? { note } : {}) });
  const aiSide = f ? 0.5 : 1;
  if (panelPct === null) add("ai", aiPct, aiSide);
  else { add("ai", aiPct, aiSide * 0.7); add("panel", panelPct, aiSide * 0.3); }
  if (f) {
    if (f.worlds) add("worlds", f.worlds.pWin, 0.5 * f.weights.worlds, `trend continues ${f.worlds.trend.pWin.toFixed(0)}%, no trend ${f.worlds.flat.pWin.toFixed(0)}%`);
    if (f.lookalikes) add("lookalikes", f.lookalikes.pWin, 0.5 * f.weights.lookalikes, `${f.lookalikes.wins} of ${f.lookalikes.n} reached it`);
    if (f.baseRate) add("baseRate", f.baseRate.pWin, 0.5 * f.weights.baseRate, `${f.baseRate.tally.wins} of ${f.baseRate.tally.n} starts in ${f.baseRate.hours.toFixed(0)}h`);
  }
  const recs = parts.map((p) => record(stats?.[p.key]));
  const scored = recs.filter((r): r is NonNullable<typeof r> => !!r);
  const bestBrier = scored.length ? Math.min(...scored.map((r) => r.brier)) : 0;
  parts.forEach((p, i) => {
    const r = recs[i];
    if (!r) return;
    p.adjPct = clamp(p.pct + r.bias * 100, 1, 99);
    p.weight *= Math.exp(-6 * (r.brier - bestBrier) * r.trust);
  });
  const tot = parts.reduce((s, p) => s + p.weight, 0) || 1;
  parts.forEach((p) => (p.weight /= tot));
  return { pWin: clamp(parts.reduce((s, p) => s + p.adjPct * p.weight, 0), 0, 100), parts };
}
// What reaching the minimum-profit level is counted as worth, until the account has its own
// managed winners to measure: the minimum, plus half of what the simulated exit made above it,
// and never more than 3 points above the minimum. The simulation sells exactly at its exit line;
// a real sale on a jumpy coin lands below it, so its figure is an upper bound, not an average.
export const countedWin = (simWinNetPct: number, minNetPct: number) => clamp(minNetPct + 0.5 * (simWinNetPct - minNetPct), minNetPct, minNetPct + 3);

// What a trade is worth on average: reaching the level pays `winNetPct`; failing costs the stop,
// or (for the share that only ran out of time) the smaller time-limit result.
export function expected(pWinPct: number, winNetPct: number, netRiskPct: number, f: Forecast | null) {
  const stopShare = f ? clamp(f.stopShare, 0, 1) : 1;
  const lossPct = stopShare * netRiskPct + (1 - stopShare) * clamp(-(f?.noneNetPct ?? -netRiskPct), 0, netRiskPct);
  const p = clamp(pWinPct, 0, 100) / 100;
  return { evPct: p * winNetPct - (1 - p) * lossPct, lossPct, needPct: winNetPct + lossPct > 0 ? (lossPct / (winNetPct + lossPct)) * 100 : 100 };
}

// One forecast waiting to be scored.
export type ForecastRec = {
  id: string; at: number; pool: string; symbol: string; kind: OrderKind;
  entry: number; stop: number; level: number; waitMin: number; holdMin: number;
  p: Partial<Record<FcKey, number>>; // each forecaster's chance (0-100) as given
  passed: boolean; // the order passed and was armed
};
// Scores a forecast against the candles since it was made. null = not decided yet.
export function resolve(rec: ForecastRec, candles: Candle[], stepSec: number): Outcome | null {
  // Start from the candle that was forming when the forecast was made.
  let i = -1;
  for (let k = candles.length - 1; k >= 0; k--) if (candles[k].time <= rec.at / 1000) { i = k; break; }
  if (i < 0) return null; // the forecast is older than this history
  const stepMin = stepSec / 60;
  const immediate = rec.kind === "buy_now" || rec.waitMin <= 0;
  return replay(candles, i, { immediate, dip: rec.kind === "buy_dip", entry: rec.entry, stop: rec.stop, level: rec.level, wait: immediate ? 0 : Math.max(1, Math.ceil(rec.waitMin / stepMin)), hold: Math.max(1, Math.ceil(rec.holdMin / stepMin)) });
}
export function score(stats: FcStats, rec: ForecastRec, out: Exclude<Outcome, "unfilled">): FcStats {
  const y = out === "win" ? 1 : 0;
  const next: FcStats = { ...stats, scored: (stats.scored ?? 0) + 1 };
  for (const k of Object.keys(FC_LABEL) as FcKey[]) {
    const old = stats[k];
    const p = rec.p[k];
    const faded = old ? { n: old.n * FADE, sumP: old.sumP * FADE, hits: old.hits * FADE, brier: old.brier * FADE } : { n: 0, sumP: 0, hits: 0, brier: 0 };
    next[k] = typeof p === "number" ? { n: faded.n + 1, sumP: faded.sumP + p / 100, hits: faded.hits + y, brier: faded.brier + (p / 100 - y) ** 2 } : faded;
  }
  const side = rec.passed ? "taken" : "refused";
  const o = stats[side] ?? { n: 0, hits: 0 };
  next[side] = { n: o.n * FADE + 1, hits: o.hits * FADE + y };
  return next;
}
