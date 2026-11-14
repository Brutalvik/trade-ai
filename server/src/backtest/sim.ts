// Replays an agent's trades on saved candles with the bot's own rules (rules.ts).
//
// - On 5-second candles the replay is exact: every candle is one of the bot's 5-second checks and
//   goes through stepAgentTrade, the same function the live engine's rule layer is built from
//   (the stop-loss that waits about 10 seconds, the minimum-profit lock, the exit that follows the
//   high, the time limit).
// - On 1-minute and longer candles the path inside a candle is unknown, so the replay is a
//   cautious approximation with the same levels: a candle that touches an exit is sold there, and
//   exits are checked before that candle's gains are counted.
//
// What is NOT replayed: the AI. Entries come from a rule (strategies.ts), a stop is a fixed
// distance, and a winning trade is managed by the rule the bot falls back on when the AI cannot
// be asked.
import type { Candle } from "../data.js";
import { exitInForce, fillBuy, fillSell, levelFor, lockDue, lockedFloor, netPct, ruleTrailPct, stepAgentTrade, type ExitDesign, type Sale, type SideCost, type TradeState } from "../rules.js";
import { TF_SEC, type Fixture } from "./fixtures.js";

// A buy signal: at `time` (unix seconds) the strategy says buy at the next price.
export type Entry = { time: number; stopPct: number; maxHoldMin: number; tag?: string };
export type CostModel = { name: string; roundTripPct: (fx: Fixture, usd: number) => number };
export type SimOptions = {
  tf: string; // the candles replayed: "5s" (exact) or "1m" / "5m" (approximation)
  design: ExitDesign;
  cost: CostModel;
  budgetUsd: number; // the agent's budget; each buy invests all of its funds (budget plus what it made or lost)
  sizeCapPct?: number; // invest only as much as keeps the round-trip cost at or under this
};
export type SimTrade = {
  symbol: string; tag?: string; entryTime: number; exitTime: number; entry: number; exit: number; usd: number;
  pnlUsd: number; netPct: number; costPct: number; why: Sale["why"] | "end"; heldMin: number; bestNetPct: number;
};

// The coin's usual 5-minute swing (ATR% of 5-minute candles), known at a given time.
function atr5m(c5: Candle[]) {
  const times: number[] = [], vals: number[] = [];
  let a = 0;
  for (let i = 1; i < c5.length; i++) {
    const tr = Math.max(c5[i].high - c5[i].low, Math.abs(c5[i].high - c5[i - 1].close), Math.abs(c5[i].low - c5[i - 1].close));
    a = i <= 14 ? (a * (i - 1) + tr) / i : (a * 13 + tr) / 14;
    if (i >= 14 && c5[i].close > 0) {
      times.push(c5[i].time + 300); // known once this candle has closed
      vals.push((a / c5[i].close) * 100);
    }
  }
  return (t: number): number | undefined => {
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? vals[ans] : undefined;
  };
}

// The largest amount (at most `funds`) whose round trip costs no more than the cap; 0 if even $10 costs more.
export function sizeFor(fx: Fixture, funds: number, cost: CostModel, capPct?: number): number {
  if (!capPct || cost.roundTripPct(fx, funds) <= capPct) return funds;
  if (cost.roundTripPct(fx, 10) > capPct) return 0;
  let lo = 10, hi = funds;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cost.roundTripPct(fx, mid) <= capPct) lo = mid; else hi = mid;
  }
  return Math.floor(lo * 100) / 100;
}

export function simulate(fx: Fixture, entries: Entry[], opt: SimOptions): SimTrade[] {
  const c = fx.candles[opt.tf] ?? [];
  const step = TF_SEC[opt.tf] ?? 60;
  const exact = opt.tf === "5s";
  const atr = atr5m(fx.candles["5m"] ?? []);
  const out: SimTrade[] = [];
  const queue = entries.filter((e) => c.length && e.time >= c[0].time && e.time < c[c.length - 1].time).sort((a, b) => a.time - b.time);
  let next = 0;
  let funds = opt.budgetUsd;
  let pos: { st: TradeState; qty: number; usd: number; side: SideCost; costPct: number; openedAt: number; tag?: string } | null = null;

  const close = (k: number, sale: { why: SimTrade["why"]; at: number }) => {
    const p = pos!;
    const f = fillSell(p.qty, sale.at, p.side);
    const pnl = f.net - p.usd;
    funds += pnl;
    out.push({
      symbol: fx.symbol, tag: p.tag, entryTime: p.openedAt, exitTime: c[k].time + step, entry: p.st.entry, exit: f.fillPrice, usd: p.usd,
      pnlUsd: pnl, netPct: (pnl / p.usd) * 100, costPct: p.costPct, why: sale.why, heldMin: (c[k].time + step - p.openedAt) / 60, bestNetPct: netPct(p.st.entry, p.st.best, p.costPct),
    });
    pos = null;
  };

  for (let k = 0; k < c.length; k++) {
    const x = c[k];
    if (!pos) {
      // Signals that came while a trade was open are gone (one trade at a time, like an agent).
      let sig: Entry | null = null;
      while (next < queue.length && queue[next].time <= x.time) sig = queue[next++];
      if (!sig || x.time - sig.time > Math.max(step, 60) || !(x.open > 0)) continue; // a stale signal is not acted on
      if (funds < Math.max(10, opt.budgetUsd * 0.1)) break; // the agent stops when its budget is used up
      const usd = sizeFor(fx, Math.floor(funds * 100) / 100, opt.cost, opt.sizeCapPct);
      if (usd < 10) continue; // too thin a pool for any size under the cost cap
      const costPct = opt.cost.roundTripPct(fx, usd);
      // Half the round trip on each side. With the flat model the split is the app's own 1% fee + 0.5% slippage.
      const side: SideCost = opt.cost.name === "flat" ? { feePct: costPct / 3, slipPct: costPct / 6 } : { feePct: 0, slipPct: costPct / 2 };
      const b = fillBuy(usd, x.open, side);
      pos = { st: { entry: b.fillPrice, stop: b.fillPrice * (1 - sig.stopPct / 100), best: b.fillPrice, sellBy: (x.time + sig.maxHoldMin * 60) * 1000 }, qty: b.qty, usd, side, costPct, openedAt: x.time, tag: sig.tag };
      if (exact) continue; // the buy happens at this check; the next check is the first to manage it
    }
    const p = pos!;
    const a = atr(x.time);
    if (exact) {
      const r = stepAgentTrade(p.st, { price: x.close, low: x.low, high: x.high, peakHigh: x.close, closeLow: x.close }, (x.time + step) * 1000, p.costPct, opt.design, a);
      p.st = r.state;
      if (r.sale) close(k, r.sale);
      continue;
    }
    // Longer candles: the same levels, judged cautiously (see the note at the top of this file).
    const s = p.st, d = opt.design;
    if (x.low <= s.stop) { close(k, { why: s.pm || s.stop >= s.entry ? "profit_exit" : "stop", at: Math.min(s.stop, x.open) }); continue; }
    if (d.timeLimit && !s.pm && s.sellBy && (x.time + step) * 1000 > s.sellBy) { close(k, { why: "time", at: x.close }); continue; }
    const touched = netPct(s.entry, x.high, p.costPct); // the bot's 5-second closes would have come close to this high
    if (!s.pm && d.softLock && !s.soft && touched >= d.softLock.atNetPct) {
      s.stop = Math.max(s.stop, levelFor(s.entry, d.softLock.floorNetPct, p.costPct));
      s.soft = true;
    }
    if (!s.pm && lockDue(touched, d)) {
      s.pm = { floor: lockedFloor(s.entry, p.costPct, s.stop, d), trailPct: ruleTrailPct(d, a), byRule: true };
      s.best = Math.max(s.best, levelFor(s.entry, d.lockAtNetPct, p.costPct));
    }
    s.best = Math.max(s.best, x.close);
    if (s.pm) {
      s.pm.trailPct = ruleTrailPct(d, a);
      const bestNet = netPct(s.entry, s.best, p.costPct);
      if (d.ratchet && bestNet >= d.ratchet.fromNetPct) s.pm.floor = Math.max(s.pm.floor, levelFor(s.entry, bestNet * d.ratchet.keep, p.costPct));
      s.stop = exitInForce(s.pm.floor, s.best, s.pm.trailPct);
    }
  }
  if (pos) close(c.length - 1, { why: "end", at: c[c.length - 1].close }); // still open when the data ends: closed at the last price
  return out;
}
