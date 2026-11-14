// Sanity checks for the prediction engine on made-up candles with a known answer.
import { desk, combineChance, expected, type Shape } from "../../src/predict.ts";

function gauss(rand: () => number) { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function lcg(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
// n candles of `sec` seconds; each built from 10 sub-steps so highs and lows are real excursions.
function make(n: number, sec: number, sigmaPerMin: number, driftPerMin: number, seed: number, start = 1) {
  const rand = lcg(seed);
  const out = [];
  let p = start;
  const sub = 10, dt = sec / 60 / sub;
  for (let i = 0; i < n; i++) {
    const open = p; let hi = p, lo = p;
    for (let k = 0; k < sub; k++) { p *= Math.exp(driftPerMin * dt + sigmaPerMin * Math.sqrt(dt) * gauss(rand)); hi = Math.max(hi, p); lo = Math.min(lo, p); }
    out.push({ time: 1_700_000_000 + i * sec, open, high: hi, low: lo, close: p, volume: 1000 + 500 * rand() });
  }
  return out;
}
// 5-minute candles covering the same walk as the 1-minute ones would be ideal; independent walks are fine for a sanity check.
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); };
const show = (label: string, c1: any[], c5: any[], sh: Shape) => {
  const t0 = performance.now();
  const d = desk(c1, c5, 3, 2.5);
  const f = d.forecast(sh);
  const ms = performance.now() - t0;
  if (!f) return console.log(label, "-> no forecast");
  const w = f.worlds!;
  console.log(`${label}\n   worlds ${w.pWin.toFixed(1)}% (trend ${w.trend.pWin.toFixed(1)} / flat ${w.flat.pWin.toFixed(1)}; stop ${w.flat.pStop.toFixed(0)} none ${w.flat.pNone.toFixed(0)}; win pays ${w.flat.winNetPct.toFixed(1)}%, none ${w.flat.noneNetPct.toFixed(1)}%, ${w.flat.minutesToWin} min; filled ${w.flat.filledPct.toFixed(0)}%; trendShare ${w.trendShare.toFixed(2)})` +
    `\n   coin lately ${f.baseRate ? `${f.baseRate.pWin.toFixed(1)}% (${f.baseRate.tally.wins}/${f.baseRate.tally.n}, stops ${f.baseRate.tally.stops}, none ${f.baseRate.tally.none}, unfilled ${f.baseRate.tally.unfilled}, ${f.baseRate.hours}h)` : "-"}` +
    ` | look-alikes ${f.lookalikes ? `${f.lookalikes.pWin.toFixed(1)}% (${f.lookalikes.wins}/${f.lookalikes.n})` : "-"}` +
    `\n   weights w ${f.weights.worlds.toFixed(2)} l ${f.weights.lookalikes.toFixed(2)} b ${f.weights.baseRate.toFixed(2)} | numbers ${f.numbers.toFixed(1)}% | ${ms.toFixed(0)} ms`);
  return f;
};
const now: Shape = { offsetPct: 0, upPct: 8, downPct: 5, holdMin: 180, waitMin: 0 };
console.log("theory for no direction, +8% before -5%: 38.5% (less with a time limit)");
const fA = show("A. no direction, 0.35%/min swings", make(300, 60, 0.0035, 0, 1), make(300, 300, 0.0035, 0, 2), now);
const fB = show("B. no direction, quiet coin 0.12%/min", make(300, 60, 0.0012, 0, 3), make(300, 300, 0.0012, 0, 4), now);
const fC = show("C. steady climb +0.03%/min (+1.8%/h)", make(300, 60, 0.0035, 0.0003, 5), make(300, 300, 0.0035, 0.0003, 6), now);
const fD = show("D. falling -0.03%/min", make(300, 60, 0.0035, -0.0003, 7), make(300, 300, 0.0035, -0.0003, 8), now);
const fE = show("E. no direction, tight stop -3%", make(300, 60, 0.0035, 0, 1), make(300, 300, 0.0035, 0, 2), { ...now, downPct: 3 });
show("F. dip order -3% (wait 30 min)", make(300, 60, 0.0035, 0, 1), make(300, 300, 0.0035, 0, 2), { ...now, offsetPct: -3, waitMin: 30 });
show("G. breakout +2% (wait 30 min)", make(300, 60, 0.0035, 0, 1), make(300, 300, 0.0035, 0, 2), { ...now, offsetPct: 2, waitMin: 30 });
const fH = show("H. only 5-minute history", [], make(300, 300, 0.0035, 0, 2), now);
show("I. short history (60 candles)", make(60, 60, 0.0035, 0, 1), make(60, 300, 0.0035, 0, 2), now);
const f = show("J. 24-hour hold (cut to what history allows)", make(300, 60, 0.0035, 0, 1), make(300, 300, 0.0035, 0, 2), { ...now, holdMin: 1440 });
console.log("   truncated:", f?.truncated, "hold used:", f?.shape.holdMin);
check("a coin with no direction: +8% before -5% within 3 hours lands between 8% and 40% (38.5% with no time limit)", !!fA && fA.numbers > 8 && fA.numbers < 40, fA?.numbers.toFixed(1));
check("a quiet coin cannot get there: under 5%", !!fB && fB.numbers < 5, fB?.numbers.toFixed(1));
check("a climbing coin scores higher than a falling one", !!fC && !!fD && fC.numbers > fD.numbers, `${fC?.numbers.toFixed(1)} vs ${fD?.numbers.toFixed(1)}`);
check("a tighter stop lowers the chance", !!fA && !!fE && fE.numbers < fA.numbers, `${fE?.numbers.toFixed(1)} vs ${fA?.numbers.toFixed(1)}`);
check("5-minute history alone still gives a forecast", !!fH, "");
check("a hold longer than the history is cut and flagged", f?.truncated === true && (f?.shape.holdMin ?? 9999) < 1440, { truncated: f?.truncated, hold: f?.shape.holdMin });
const d = desk(make(300, 60, 0.0035, 0, 1), make(300, 300, 0.0035, 0, 2), 3, 2.5);
console.log("cone:", d.cone([15, 60, 180]).map((p) => `${p.min}m ${p.lo.toFixed(3)}-${p.hi.toFixed(3)} (mid ${p.mid.toFixed(3)})`).join(" | "));
const fa = d.forecast(now)!;
const comb = [40, 62, 75].map((ai) => combineChance(ai, null, fa).pWin);
check("a higher AI chance gives a higher combined chance", comb[0] < comb[1] && comb[1] < comb[2], comb.map((x) => x.toFixed(1)));
check("the AI is half the weight: 62% with these numbers lands between them", comb[1] > Math.min(62, fa.numbers) && comb[1] < Math.max(62, fa.numbers), `${comb[1].toFixed(1)} (numbers ${fa.numbers.toFixed(1)})`);
for (const ai of [62, 75, 40]) {
  const c = combineChance(ai, null, fa);
  const e = expected(c.pWin, fa.winNetPct, 8, fa);
  console.log(`AI ${ai}% + numbers ${fa.numbers.toFixed(0)}% -> combined ${c.pWin.toFixed(1)}% | needs ${e.needPct.toFixed(0)}% | EV ${e.evPct.toFixed(2)}% | parts ${c.parts.map((p) => `${p.key} ${p.pct.toFixed(0)}x${p.weight.toFixed(2)}`).join(", ")}`);
}
const c2 = combineChance(62, 48, fa, { ai: { n: 30, sumP: 18.6, hits: 10.5, brier: 8.1 }, worlds: { n: 30, sumP: 11, hits: 10.5, brier: 6.6 } });
console.log("with a panel and a track record (AI said 62% on average, 35% happened):", c2.pWin.toFixed(1), c2.parts.map((p) => `${p.key} ${p.pct.toFixed(0)}->${p.adjPct.toFixed(0)} x${p.weight.toFixed(2)}`).join(", "));
check("a forecaster that over-called (62% said, 35% happened) is marked down, and the panel joins", c2.parts.find((x) => x.key === "ai")!.adjPct < 62 && c2.parts.some((x) => x.key === "panel"), c2.parts.map((x) => `${x.key} ${x.pct.toFixed(0)}->${x.adjPct.toFixed(0)}`));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
