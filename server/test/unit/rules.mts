// The trade rules shared by the live engine and the back-tester (src/rules.ts): paper fills, the
// stop-loss that waits for the price to settle, the minimum-profit lock, the exit that follows
// the high, breakouts, and the back-tester's replay of them. The engine scenarios (test/engine)
// check the same behaviour end to end; the numbers here are the ones those scenarios produce.
import { breakoutHoldSec, chaseLimitPct, EXIT_LIVE, EXIT_V058, fillBuy, fillSell, levelFor, netPct, ruleTrailPct, stepAgentTrade, stopCheck, type ExitDesign, type TradeState } from "../../src/rules.ts";
import { simulate } from "../../src/backtest/sim.ts";
import { metrics } from "../../src/backtest/metrics.ts";
import { COSTS, DESIGNS, strategy } from "../../src/backtest/strategies.ts";
import { loadFixtures, measuredRoundTripPct, type Fixture } from "../../src/backtest/fixtures.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); };
const expect = (name: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); check(name, ok, ok ? (got as any) : `${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`); };
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// ---- the live design is the one this file pins ----
expect("the bot runs the v0.58.0 exit design", EXIT_LIVE, EXIT_V058);
expect("its numbers", [EXIT_V058.minNetPct, EXIT_V058.lockAtNetPct, EXIT_V058.stopConfirmMs, EXIT_V058.stopCrash, ruleTrailPct(EXIT_V058), EXIT_V058.timeLimit], [5, 5, 8000, 1.5, 2.5, false]);

// ---- paper fills: 1% fee + 0.5% slippage a side ----
const side = { feePct: 1, slipPct: 0.5 };
const b = fillBuy(1000, 1, side);
expect("a $1,000 buy at $1: fills at $1.005, $10 fee", [r4(b.fillPrice), r4(b.feeUsd), r4(b.qty)], [1.005, 10, r4(990 / 1.005)]);
const sl = fillSell(b.qty, 1.2, side);
expect("selling it at $1.20: fills at $1.194, 1% fee off the proceeds", [r4(sl.fillPrice), r4(sl.net)], [1.194, r4(b.qty * 1.194 * 0.99)]);
expect("levels: +5% after 3% costs is 8% above the entry, and back", [r4(levelFor(1.005, 5, 3)), r4(netPct(1.005, 1.0854, 3))], [1.0854, 5]);

// ---- the stop-loss: bought at 1.005, stop 0.95 ----
const T = 1_800_000_000_000;
const P = { entry: 1.005, stop: 0.95 };
expect("first seen under the stop: armed, not sold", stopCheck({ ...P, price: 0.94, now: T }, EXIT_V058), { action: "arm", crash: false });
expect("5 s later, still under: wait", stopCheck({ ...P, price: 0.94, underSince: T, now: T + 5000 }, EXIT_V058), { action: "wait", crash: false });
expect("10 s later, still under: sell", stopCheck({ ...P, price: 0.94, underSince: T, now: T + 10_000 }, EXIT_V058), { action: "sell", crash: false });
expect("back above the stop: cleared", stopCheck({ ...P, price: 0.96, underSince: T, now: T + 5000 }, EXIT_V058), { action: "clear", crash: false });
expect("a fall to 1.5x the planned loss (0.9225) sells at once", stopCheck({ ...P, price: 0.92, now: T }, EXIT_V058), { action: "sell", crash: true });
expect("just above that level it still waits", stopCheck({ ...P, price: 0.923, now: T }, EXIT_V058).action, "arm");

// ---- one trade, check by check (5 s apart), as the engine scenarios play it ----
const play = (prices: number[], d: ExitDesign, start: Partial<TradeState> = {}, atr?: number) => {
  let s: TradeState = { entry: 1.005, stop: 0.95, best: 1.005, ...start };
  const log: string[] = [];
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const r = stepAgentTrade(s, { price: p, low: p, high: p, peakHigh: p, closeLow: p }, T + i * 5000, 3, d, atr);
    s = r.state;
    log.push(...r.events);
    if (r.sale) return { sale: `${r.sale.why} @ ${r4(r.sale.at)}`, at: i, log, s };
  }
  return { sale: null, at: -1, log, s };
};
const wick = play([0.94, 1.0, 1.0, 0.94, 0.94, 0.94], EXIT_V058);
expect("a wick under the stop that bounces does not sell; staying under does, about 10 s later", [wick.sale, wick.at, wick.log.filter((e) => e.startsWith("stop"))], ["stop @ 0.94", 5, ["stop_armed", "stop_cleared", "stop_armed"]]);
expect("a crash sells on the first check", [play([0.9], EXIT_V058).sale, play([0.9], EXIT_V058).at], ["crash @ 0.9", 0]);
const min = play([1.06, 1.03, 1.092, 1.08], EXIT_V058);
expect("+5.7% locks the +5% floor (1.0854); a fall straight back sells there", [min.sale, min.log.includes("locked"), r4(min.s.pm!.floor)], ["profit_exit @ 1.08", true, 1.0854]);
const noai = play([1.092, 1.12, 1.10, 1.09], EXIT_V058);
expect("with no AI the exit follows 2.5% behind the high: 1.12 -> 1.092, sold at 1.09", [noai.sale, r4(noai.s.stop)], ["profit_exit @ 1.09", 1.092]);
expect("under the minimum nothing is locked and nothing is sold", [play([1.06, 1.03, 1.07, 1.02], EXIT_V058).sale, play([1.06, 1.03], EXIT_V058).s.pm], [null, undefined]);
// The designs the back-tester can run next to the live one.
const late = play([1.092, 1.08, 0.94, 0.94, 0.94], DESIGNS.late);
expect("floor locked at +10%: touching +5% locks nothing, so the trade can still end at its stop", [late.sale, late.log.includes("locked")], ["stop @ 0.94", false]);
const lateWin = play([1.14, 1.20, 1.15], DESIGNS.late, {}, 2);
expect("...and a trade that gets to +10% is locked at +5% and followed 3.6% behind (1.8 x a 2% swing)", [lateWin.sale, r4(lateWin.s.pm!.floor), lateWin.s.pm!.trailPct], ["profit_exit @ 1.15", 1.0854, 3.6]);
const be = play([1.092, 1.03], DESIGNS.breakeven);
expect("break-even design: at +5% the stop moves to break-even after costs (1.0352), so the fall back ends flat, not at a loss", [be.sale, r4(be.s.stop), be.log.includes("soft_locked")], ["profit_exit @ 1.03", 1.0352, true]);
const sellBy = T + 12_000;
expect("the time limit is off in the live design and on in the 'timed' one", [play([1.01, 1.01, 1.01, 1.01], EXIT_V058, { sellBy }).sale, play([1.01, 1.01, 1.01, 1.01], DESIGNS.timed, { sellBy }).sale], [null, "time @ 1.01"]);
expect("the adaptive distance: 1.8 x the 5-minute swing, never under 2.5% or over 12%", [1, 2, 4, 10, undefined].map((a) => ruleTrailPct(DESIGNS.adaptive, a)), [2.5, 3.6, 7.2, 12, 2.5]);

// ---- breakouts ----
expect("a breakout must hold 15 s, or as long as the AI asked, at most 90 s", [0, 30, 200].map(breakoutHoldSec), [15, 30, 90]);
expect("it is not bought more than 2% past its level, or half the stop distance if that is less", [r4(chaseLimitPct(1.02, 0.97)), r4(chaseLimitPct(1.02, 1.0)), r4(chaseLimitPct(1.02, 1.015))], [2, r4((0.02 / 1.02) * 50), 0.5]);

// ---- the back-tester replays the same rules ----
const mk = (prices: number[], t0 = 1_800_000_000): Fixture => ({
  symbol: "TST", pool: "TestPool", savedAt: "", liquidityUsd: 400_000, roundTripPct: { "100": 0.8, "1000": 1.7 },
  candles: { "5s": prices.map((p, i) => ({ time: t0 + i * 5, open: p, high: p, low: p, close: p, volume: 1 })), "5m": [] },
});
const flat = (n: number, p = 1) => Array.from({ length: n }, () => p);
const run = (prices: number[], design = EXIT_V058) => simulate(mk(prices), [{ time: 1_800_000_000, stopPct: 5.47, maxHoldMin: 240 }], { tf: "5s", design, cost: COSTS.flat, budgetUsd: 1000 });
const t1 = run([...flat(3), 0.94, ...flat(3), ...flat(4, 0.94), ...flat(3)]);
expect("replay: the wick is survived, the real fall is sold after the confirmation at about $0.94", [t1.length, t1[0]?.why, r4(t1[0]?.exit)], [1, "stop", r4(0.94 * 0.995)]);
const t2 = run([...flat(3), 1.06, 1.092, 1.12, 1.10, 1.09, ...flat(3, 1.09)]);
expect("replay: the profit exit matches the engine scenario (sold at $1.0846, about +5.5% after fees)", [t2[0]?.why, r4(t2[0]?.exit), Math.round(t2[0]?.pnlUsd)], ["profit_exit", 1.0846, 58]);
expect("costs: the flat model is 3%; the measured one grows with the trade's size", [COSTS.flat.roundTripPct(mk([1]), 1000), r4(measuredRoundTripPct(mk([1]), 100)), r4(measuredRoundTripPct(mk([1]), 1000)), r4(measuredRoundTripPct(mk([1]), 550))], [3, 0.8, 1.7, 1.25]);
const capped = simulate(mk([...flat(3), 1.06, 1.092, 1.08, ...flat(3, 1.08)]), [{ time: 1_800_000_000, stopPct: 5, maxHoldMin: 240 }], { tf: "5s", design: EXIT_V058, cost: COSTS.measured, budgetUsd: 1000, sizeCapPct: 1.25 });
expect("a size cap invests only what keeps the round trip under the cap ($550 here)", [Math.round(capped[0]?.usd), r4(capped[0]?.costPct)], [550, 1.25]);
const m = metrics([...t1, ...t2], 2, 1000);
expect("metrics: one loss, one win", [m.trades, m.winRatePct, m.exits], [2, 50, { stop: 1, profit_exit: 1 }]);
check("...with a profit factor, a net return and the return without the best trades", m.profitFactor > 0 && m.profitFactor < 1 && m.netReturnPct < 0 && m.netReturnNoTop3Pct === 0 && m.maxDrawdownPct > 0, { pf: r4(m.profitFactor), net: r4(m.netReturnPct), dd: r4(m.maxDrawdownPct) });

// ---- the saved fixtures load and run ----
const fx = loadFixtures();
check("the candle fixtures are in the repo (at least 5 coins, with 1-minute candles)", fx.filter((f) => (f.candles["1m"]?.length ?? 0) >= 500).length >= 5, `${fx.length} coins`);
const s15 = strategy("every:15");
const all = fx.flatMap((f) => simulate(f, s15.entries(f), { tf: "1m", design: EXIT_V058, cost: COSTS.flat, budgetUsd: 1000 }));
check("a back-test over them produces trades with sane results", all.length > 50 && all.every((t) => Number.isFinite(t.pnlUsd) && t.netPct > -60 && t.usd > 0), `${all.length} trades`);
check("entries from a studied pattern work too", fx.flatMap((f) => simulate(f, strategy("pattern:macross").entries(f), { tf: "1m", design: EXIT_V058, cost: COSTS.flat, budgetUsd: 1000 })).length > 5, "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
