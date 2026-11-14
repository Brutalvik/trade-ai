// The trade rules an agent's position follows between AI decisions, as pure functions: paper
// fills, the stop-loss that waits for the price to settle, the minimum-profit lock, the exit that
// follows the high, the time limit, and the breakout entry rules.
// The live engine (engine.ts) and the back-tester (backtest/) both call these, so a back-test
// replays exactly what the bot does. Nothing here reads the clock, the network or the account.

// ---------- Exit design ----------
// How a winning trade is protected. `EXIT_LIVE` is what the bot runs; the back-tester can run
// other designs side by side before any of them goes live.
export type ExitDesign = {
  name: string;
  minNetPct: number; // the profit after costs that is locked as the floor
  lockAtNetPct: number; // the best gain after costs at which that floor is locked
  // An earlier, softer lock on the way up (for example break-even after costs once up +5%).
  softLock: { atNetPct: number; floorNetPct: number } | null;
  // How far behind the highest close the exit follows when the AI has not said otherwise:
  // a fixed distance, or a multiple of the coin's usual 5-minute swing (ATR%) within limits.
  trail: { kind: "fixed"; pct: number } | { kind: "atr"; mult: number; minPct: number; maxPct: number };
  // Once the best gain after costs reaches `fromNetPct`, keep at least this share of it.
  ratchet: { fromNetPct: number; keep: number } | null;
  stopConfirmMs: number; // a stop-loss sells only if the price is still at or below it this long after it was first seen there
  stopCrash: number; // ...or at once when the fall reaches this many times the planned loss
  // Sell a trade that has neither stopped out nor locked its minimum once its time is up.
  // Off in the live design: since v0.56.0 an agent's trade has had no time limit (the check sat
  // behind the stop-loss branch and was never reached). Kept off here so a back-test of
  // "v0.58.0" replays what the bot really does; whether to turn it on is decided on numbers.
  timeLimit: boolean;
};
export const EXIT_V058: ExitDesign = { name: "v0.58.0", minNetPct: 5, lockAtNetPct: 5, softLock: null, trail: { kind: "fixed", pct: 2.5 }, ratchet: null, stopConfirmMs: 8_000, stopCrash: 1.5, timeLimit: false };
// Live since v0.62.0: when the AI has not set a distance, the exit follows 1.8 x the coin's usual
// 5-minute swing behind the high (never under 2.5% or over 12%) in place of a fixed 2.5%, so a
// jumpy coin is not sold on its ordinary wiggle. The lock and the time limit are as in v0.58.0.
export const EXIT_LIVE: ExitDesign = { ...EXIT_V058, name: "v0.62.0", trail: { kind: "atr", mult: 1.8, minPct: 2.5, maxPct: 12 } };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

// ---------- Prices and costs ----------
// Profit after the round-trip cost, in %, of selling at `price` what was bought at `entry`.
export const netPct = (entry: number, price: number, costPct: number) => ((price - entry) / entry) * 100 - costPct;
// The price at which a trade bought at `entry` is up `net`% after the round-trip cost.
export const levelFor = (entry: number, net: number, costPct: number) => entry * (1 + (costPct + net) / 100);

// One side of a paper trade. feePct and slipPct are per side; platformPct is the plan's charge.
export type SideCost = { feePct: number; slipPct: number; platformPct?: number };
export function fillBuy(usd: number, price: number, c: SideCost) {
  const feeUsd = usd * (c.feePct / 100);
  const platformFeeUsd = usd * ((c.platformPct ?? 0) / 100);
  const fillPrice = price * (1 + c.slipPct / 100);
  return { fillPrice, qty: (usd - feeUsd - platformFeeUsd) / fillPrice, feeUsd, platformFeeUsd };
}
export function fillSell(qty: number, price: number, c: SideCost) {
  const fillPrice = price * (1 - c.slipPct / 100);
  const gross = qty * fillPrice;
  const feeUsd = gross * (c.feePct / 100);
  const platformFeeUsd = gross * ((c.platformPct ?? 0) / 100);
  return { fillPrice, net: gross - feeUsd - platformFeeUsd, feeUsd, platformFeeUsd };
}

// ---------- Entry: breakouts must be real ----------
export const BREAKOUT_HOLD_SEC = 15; // a breakout must stay above its level at least this long before it is bought
export const BREAKOUT_HOLD_MAX_SEC = 90;
export const BREAKOUT_CHASE_PCT = 2; // ...and is not bought more than this far above the level (or half the stop distance, if that is less)
export const breakoutHoldSec = (confirmSeconds: number) => Math.min(BREAKOUT_HOLD_MAX_SEC, Math.max(BREAKOUT_HOLD_SEC, confirmSeconds || 0));
export const chaseLimitPct = (trigger: number, stop: number) => Math.max(0.5, Math.min(BREAKOUT_CHASE_PCT, (((trigger - stop) / trigger) * 100) / 2));

// ---------- The stop-loss ----------
// Judged on where the price settles, not on one wick: "arm" when the price is first seen at or
// below the stop, "sell" if it is still there `stopConfirmMs` later, "clear" if it bounced back.
// A fall to `stopCrash` times the planned loss sells at once.
export type StopAction = "none" | "arm" | "wait" | "clear" | "sell";
export function stopCheck(p: { entry: number; stop: number; price: number; underSince?: number; now: number }, d: ExitDesign): { action: StopAction; crash: boolean } {
  const crash = p.entry - d.stopCrash * (p.entry - p.stop);
  if (p.price <= crash) return { action: "sell", crash: true };
  if (p.price <= p.stop) return { action: p.underSince === undefined ? "arm" : p.now - p.underSince >= d.stopConfirmMs ? "sell" : "wait", crash: false };
  return { action: p.underSince === undefined ? "none" : "clear", crash: false };
}

// ---------- The minimum-profit lock and the exit that follows the high ----------
// The distance behind the highest close when no AI has set one.
export function ruleTrailPct(d: ExitDesign, atr5mPct?: number) {
  const t = d.trail;
  if (t.kind === "fixed") return t.pct;
  return Math.round(clamp(t.mult * (atr5mPct && atr5mPct > 0 ? atr5mPct : t.minPct / t.mult), t.minPct, t.maxPct) * 10) / 10;
}
// Is it time to lock the minimum profit? (bestNetPct = the best gain so far, after costs)
export const lockDue = (bestNetPct: number, d: ExitDesign) => bestNetPct >= d.lockAtNetPct;
// The floor when it locks: the minimum profit, or the exit already in force if that is higher (an exit is never lowered).
export const lockedFloor = (entry: number, costPct: number, stopNow: number | undefined, d: ExitDesign) => Math.max(levelFor(entry, d.minNetPct, costPct), stopNow ?? 0);
// The exit in force: the locked floor, or the trailing exit when that is higher.
export const exitInForce = (floor: number, best: number, trailPct: number) => Math.max(floor, best * (1 - trailPct / 100));
// Has an exit at or above the entry been reached? Judged on closing prices (and on the latest
// price when the high was set in this same check: the low may have come before it).
export const exitHit = (p: { entry: number; stop: number; price: number; low: number; closeLow: number; newBest: boolean }) =>
  (p.stop >= p.entry ? (p.newBest ? p.price : p.closeLow) : p.low) <= p.stop;

// ---------- One check of an open trade (the rule layer, no AI) ----------
// What the bot sees at a check: the latest price, the low and high touched since the last check,
// and the highest and lowest CLOSE in that window (exits follow closes, not single wicks).
export type Tick = { price: number; low: number; high: number; peakHigh: number; closeLow: number };
export type TradeState = {
  entry: number; // fill price of the buy
  stop: number; // the exit in force: the stop-loss, or the profit exit once the minimum is locked
  best: number; // the highest close so far
  underSince?: number; // when the price was first seen at or below the stop-loss
  soft?: boolean; // the softer first lock has been applied
  pm?: { floor: number; trailPct: number; byRule: boolean }; // set once the minimum profit is locked
  sellBy?: number; // time limit (not used once the minimum is locked)
};
export type StepEvent = "new_best" | "soft_locked" | "locked" | "stop_armed" | "stop_cleared";
export type Sale = { why: "stop" | "crash" | "profit_exit" | "time"; at: number };
export function stepAgentTrade(s0: TradeState, q: Tick, now: number, costPct: number, d: ExitDesign, atr5mPct?: number): { state: TradeState; events: StepEvent[]; sale?: Sale } {
  const s: TradeState = { ...s0, ...(s0.pm ? { pm: { ...s0.pm } } : {}) };
  const events: StepEvent[] = [];
  let newBest = false;
  if (q.peakHigh > s.best) {
    s.best = q.peakHigh;
    newBest = true;
    events.push("new_best");
  }
  const bestNet = netPct(s.entry, s.best, costPct);
  if (!s.pm && d.softLock && !s.soft && bestNet >= d.softLock.atNetPct) {
    s.stop = Math.max(s.stop, levelFor(s.entry, d.softLock.floorNetPct, costPct));
    s.soft = true;
    delete s.underSince;
    events.push("soft_locked");
  }
  if (!s.pm && lockDue(bestNet, d)) {
    s.pm = { floor: lockedFloor(s.entry, costPct, s.stop, d), trailPct: ruleTrailPct(d, atr5mPct), byRule: true };
    delete s.underSince;
    events.push("locked");
  }
  if (s.pm) {
    if (s.pm.byRule) s.pm.trailPct = ruleTrailPct(d, atr5mPct);
    if (d.ratchet && bestNet >= d.ratchet.fromNetPct) s.pm.floor = Math.max(s.pm.floor, levelFor(s.entry, bestNet * d.ratchet.keep, costPct));
    s.stop = exitInForce(s.pm.floor, s.best, s.pm.trailPct);
  }
  if (!s.pm && s.stop < s.entry) {
    const c = stopCheck({ entry: s.entry, stop: s.stop, price: q.price, underSince: s.underSince, now }, d);
    if (c.action === "sell") return { state: s, events, sale: { why: c.crash ? "crash" : "stop", at: q.price } };
    if (c.action === "arm") {
      s.underSince = now;
      events.push("stop_armed");
    } else if (c.action === "clear") {
      delete s.underSince;
      events.push("stop_cleared");
    }
    if (d.timeLimit && s.sellBy && now > s.sellBy) return { state: s, events, sale: { why: "time", at: q.price } };
  } else if (exitHit({ entry: s.entry, stop: s.stop, price: q.price, low: q.low, closeLow: q.closeLow, newBest })) {
    return { state: s, events, sale: { why: "profit_exit", at: Math.min(s.stop, q.price) } };
  } else if (d.timeLimit && !s.pm && s.sellBy && now > s.sellBy) return { state: s, events, sale: { why: "time", at: q.price } };
  return { state: s, events };
}
