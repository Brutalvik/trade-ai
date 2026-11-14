// The entry gate, with exact numbers: an agent's order is used only if the combined chance
// (its AI, the numbers, the forecaster panel, each corrected for its record) beats what it needs.
import { checkOrders, orderKey } from "../../src/ai.ts";
import { resolve, score, type Forecast, type ForecastRec, type FcStats } from "../../src/predict.ts";

const sim = (pWin: number) => ({ filledPct: 100, pWin, pStop: 100 - pWin, pNone: 0, evPct: 0, winNetPct: 6, noneNetPct: -3, minutesToWin: 30 });
// The numbers say 40%; reaching the level is worth +6%; every miss is a full stop.
const numbers: Forecast = {
  shape: { offsetPct: 0, upPct: 8, downPct: 5, holdMin: 180, waitMin: 0 }, truncated: false, assumed: false,
  worlds: { pWin: 40, trend: sim(40), flat: sim(40), trendShare: 0.15, paths: 4000, from: "test" },
  baseRate: null, lookalikes: null, weights: { worlds: 1, lookalikes: 0, baseRate: 0 }, numbers: 40, winNetPct: 6, stopShare: 1, noneNetPct: -3,
};
const order = (ai: number) => ({ kind: "buy_now" as const, triggerPrice: 1, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: 0.95, target: 1.15, maxHoldMinutes: 180, winChancePct: ai });
let pass = 0, fail = 0;
const expect = (name: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`); };
const judge = (ai: number, extra: any = {}) => {
  const o = order(ai);
  const r = checkOrders([o], 3, { minNetPct: 5, predict: () => numbers, ...extra });
  const c = r.kept[0] ?? r.warned[0];
  return { used: r.kept.length === 1, chance: Math.round(c.prediction!.pWin), needs: Math.round(c.prediction!.needPct) };
};
// loss 8% (5% stop + 3% costs); the simulated win of 6% is counted as 5.5% -> needs 8 / 13.5 = 59%
expect("AI 80% + numbers 40% -> 60%: used", judge(80), { used: true, chance: 60, needs: 59 });
expect("AI 70% + numbers 40% -> 55%: the numbers veto it", judge(70), { used: false, chance: 55, needs: 59 });
const panel = (pct: number) => ({ panel: new Map([[orderKey(order(80)), { pct, votes: [{ who: "Skeptic", pct, reason: "test" }] }]]) });
expect("AI 80%, panel 20%, numbers 40% -> 51%: the panel vetoes it", judge(80, panel(20)), { used: false, chance: 51, needs: 59 });
expect("AI 80%, panel 85%, numbers 40% -> 61%: used", judge(80, panel(85)), { used: true, chance: 61, needs: 59 });
// a record of over-calling: the AI said 60% on average over 30 forecasts and 30% happened
const stats: FcStats = { ai: { n: 30, sumP: 18, hits: 9, brier: 30 * 0.3 } };
const corrected = judge(80, { stats });
expect("AI 80% with a record of calling 60% when 30% happens: corrected down, not used", { used: corrected.used, lower: corrected.chance < 60 }, { used: false, lower: true });
// a record of UNDER-calling (said 41% on average, 62% happened: a hot streak) must not raise anything
const hot: FcStats = { ai: { n: 30, sumP: 12.3, hits: 18.6, brier: 30 * 0.25 }, worlds: { n: 30, sumP: 15, hits: 18.6, brier: 30 * 0.25 } };
expect("a hot streak marks nobody up: AI 70% + numbers 40% stays 55%, not used", judge(70, { stats: hot }), { used: false, chance: 55, needs: 59 });
// no history to simulate: the AI alone, still corrected for its record
const alone = checkOrders([order(80)], 3, { minNetPct: 5, predict: () => null });
expect("no candle history -> judged on the AI alone", { used: alone.kept.length === 1, chance: Math.round(alone.kept[0]?.prediction?.pWin ?? -1), parts: alone.kept[0]?.prediction?.parts.length }, { used: true, chance: 80, parts: 1 });
// classic (non-agent) orders are untouched
const classic = checkOrders([order(62)], 3);
expect("classic order: no prediction attached, judged as before", { used: classic.kept.length === 1, prediction: classic.kept[0]?.prediction ?? null, win: classic.kept[0]?.winChancePct }, { used: true, prediction: null, win: 62 });

// ---- scoring a forecast against the candles that followed ----
const T0 = 1_800_000_000;
const candle = (i: number, lo: number, hi: number) => ({ time: T0 + i * 60, open: 1, high: hi, low: lo, close: 1, volume: 1 });
const rec = (over: Partial<ForecastRec> = {}): ForecastRec => ({ id: "a", at: (T0 + 30) * 1000, pool: "p", symbol: "S", kind: "buy_now", entry: 1, stop: 0.95, level: 1.08, waitMin: 0, holdMin: 5, p: { ai: 70, worlds: 30, combined: 50 }, passed: true, ...over });
const flat = (n: number) => Array.from({ length: n }, (_, i) => candle(i, 0.99, 1.01));
expect("reaches the level first -> win", resolve(rec(), [...flat(3), candle(3, 0.99, 1.09)], 60), "win");
expect("hits the stop first -> stop", resolve(rec(), [...flat(2), candle(2, 0.94, 1.0), candle(3, 0.99, 1.09)], 60), "stop");
expect("level and stop in one candle -> counted as the stop", resolve(rec(), [candle(0, 0.99, 1.01), candle(1, 0.94, 1.09)], 60), "stop");
expect("neither inside the time limit -> none", resolve(rec(), flat(8), 60), "none");
expect("time limit not over yet -> still waiting", resolve(rec(), flat(4), 60), null);
expect("a dip order that never fills -> not scored", resolve(rec({ kind: "buy_dip", entry: 0.97, stop: 0.93, level: 1.05, waitMin: 3 }), flat(8), 60), "unfilled");
expect("a dip order that fills, then reaches the level -> win", resolve(rec({ kind: "buy_dip", entry: 0.97, stop: 0.93, level: 1.05, waitMin: 3 }), [candle(0, 0.99, 1.01), candle(1, 0.965, 1.0), candle(2, 0.97, 1.06)], 60), "win");
expect("a forecast older than the candles -> can't be checked", resolve(rec({ at: (T0 - 600) * 1000 }), flat(8), 60), null);
let st: FcStats = {};
st = score(st, rec(), "win", true); // a trade the agent really made
st = score(st, rec({ passed: false }), "stop");
expect("scoreboard after a real winning trade and an order it did not buy that missed", { scored: st.scored, aiN: Math.round(st.ai!.n * 100) / 100, aiHits: Math.round(st.ai!.hits * 100) / 100, taken: st.taken, refused: st.refused }, { scored: 2, aiN: 2, aiHits: 1, taken: { n: 1, hits: 1 }, refused: { n: 1, hits: 0 } });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
