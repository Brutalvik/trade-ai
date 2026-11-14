// The same buys under several exit designs.
//
// In a normal run an agent holds one trade at a time, so a design that sells sooner also buys
// again sooner, and every buy pays the round trip: its row differs in how often it bought as well
// as in how it sold. Here every test buy is replayed on its own under each design, so the designs
// are judged on exactly the same buys: what does this exit rule make of a buy?
import type { ExitDesign } from "../rules.js";
import type { Fixture } from "./fixtures.js";
import { simulate, type Entry, type SimOptions, type SimTrade } from "./sim.js";

export type PairedBuy = { symbol: string; time: number; by: Record<string, SimTrade> };

// Every buy the first design would make, with what each design made of it. Whether a buy is made
// at all (the size cap, the floor on the numbers) is decided once, with the first design.
export function pairedBuys(fixtures: Fixture[], entries: (fx: Fixture) => Entry[], designs: Record<string, ExitDesign>, opt: Omit<SimOptions, "design">): PairedBuy[] {
  const keys = Object.keys(designs);
  const { minNumbersPct: _decidedOnce, ...rest } = opt;
  const out: PairedBuy[] = [];
  for (const fx of fixtures) {
    for (const e of entries(fx)) {
      const first = simulate(fx, [e], { ...opt, design: designs[keys[0]] })[0];
      if (!first) continue;
      const by: Record<string, SimTrade> = { [keys[0]]: first };
      for (const k of keys.slice(1)) {
        const t = simulate(fx, [e], { ...rest, design: designs[k] })[0];
        if (t && t.entryTime === first.entryTime) by[k] = t;
      }
      if (Object.keys(by).length === keys.length) out.push({ symbol: fx.symbol, time: first.entryTime, by });
    }
  }
  return out;
}

export type PairedStat = {
  key: string; name: string; buys: number;
  winRatePct: number; avgWinPct: number; avgLossPct: number; perBuyPct: number; medianHeldMin: number; openAtEndPct: number;
  // Against the first design, on the same buys: the average difference per buy, the range that
  // difference falls in 95 times out of 100 when the buys are redrawn, and the coins it did
  // better and worse on.
  diffPct: number; lo: number; hi: number; coinsBetter: number; coinsWorse: number;
  // The buys that got as far as the first design's lock: their average result under this design,
  // and how many of them still ended at a loss. And the average of the buys that did not get that far.
  reached: { buys: number; avgPct: number; lost: number; avgLostPct: number };
  rest: { buys: number; avgPct: number };
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// The 95% range of the average difference. Whole blocks (one coin, one 6-hour stretch) are drawn
// together, because buys a few minutes apart ride the same price move and are not independent.
// The draws are seeded, so a run always prints the same range.
function range(buys: PairedBuy[], diffs: number[]) {
  const blocks = new Map<string, number[]>();
  buys.forEach((b, i) => {
    const k = `${b.symbol}:${Math.floor(b.time / 21_600)}`;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(diffs[i]);
  });
  const bl = [...blocks.values()];
  if (bl.length < 2) return { lo: 0, hi: 0 };
  let seed = 12345;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means: number[] = [];
  for (let i = 0; i < 4000; i++) {
    let s = 0, n = 0;
    for (let j = 0; j < bl.length; j++) for (const v of bl[Math.floor(rnd() * bl.length)]) { s += v; n++; }
    means.push(n ? s / n : 0);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(means.length * 0.025)], hi: means[Math.floor(means.length * 0.975)] };
}

export function pairedStats(buys: PairedBuy[], designs: Record<string, ExitDesign>): PairedStat[] {
  const keys = Object.keys(designs), base = keys[0];
  // (a hair of tolerance: on longer candles the best price is set to the lock level itself, and the way back to a percentage rounds)
  const got = (b: PairedBuy) => b.by[base].bestNetPct >= designs[base].lockAtNetPct - 1e-6;
  const reached = buys.filter(got), others = buys.filter((b) => !got(b));
  const coins = [...new Set(buys.map((b) => b.symbol))];
  return keys.map((k) => {
    const nets = buys.map((b) => b.by[k].netPct);
    const wins = nets.filter((v) => v > 0), losses = nets.filter((v) => v <= 0);
    const diffs = buys.map((b) => b.by[k].netPct - b.by[base].netPct);
    const byCoin = coins.map((c) => mean(diffs.filter((_, i) => buys[i].symbol === c)));
    const held = buys.map((b) => b.by[k].heldMin).sort((a, b) => a - b);
    const r = reached.map((b) => b.by[k].netPct), lost = r.filter((v) => v < 0);
    return {
      key: k, name: designs[k].name, buys: buys.length,
      winRatePct: nets.length ? (wins.length / nets.length) * 100 : 0, avgWinPct: mean(wins), avgLossPct: mean(losses), perBuyPct: mean(nets),
      medianHeldMin: held.length ? held[Math.floor(held.length / 2)] : 0,
      openAtEndPct: buys.length ? (buys.filter((b) => b.by[k].why === "end").length / buys.length) * 100 : 0,
      diffPct: mean(diffs), ...(k === base ? { lo: 0, hi: 0 } : range(buys, diffs)),
      coinsBetter: byCoin.filter((d) => d > 0.005).length, coinsWorse: byCoin.filter((d) => d < -0.005).length,
      reached: { buys: r.length, avgPct: mean(r), lost: lost.length, avgLostPct: mean(lost) },
      rest: { buys: others.length, avgPct: mean(others.map((b) => b.by[k].netPct)) },
    };
  });
}

const pct = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
const time = (min: number) => (min >= 120 ? `${(min / 60).toFixed(1)} h` : `${min.toFixed(0)} min`);

// The report: every design on all the buys, then on the buys that reached the first design's lock.
export function pairedLines(buys: PairedBuy[], designs: Record<string, ExitDesign>): string[] {
  const stats = pairedStats(buys, designs);
  if (!buys.length) return ["No test buys."];
  const base = stats[0], lockAt = designs[base.key].lockAtNetPct, w = 34;
  const out = [
    `${"exit design".padEnd(w)} ${"won".padStart(5)} ${"avg win".padStart(8)} ${"avg loss".padStart(9)} ${"per buy".padStart(8)} ${"held".padStart(8)} ${"open at end".padStart(11)} ${"against the first".padStart(18)} ${"95% range".padStart(18)} ${"coins better / worse".padStart(20)}`,
    ...stats.map((s, i) => `${s.name.slice(0, w).padEnd(w)} ${`${s.winRatePct.toFixed(0)}%`.padStart(5)} ${pct(s.avgWinPct, 1).padStart(8)} ${pct(s.avgLossPct, 1).padStart(9)} ${pct(s.perBuyPct).padStart(8)} ${time(s.medianHeldMin).padStart(8)} ${`${s.openAtEndPct.toFixed(0)}%`.padStart(11)} ${(i ? pct(s.diffPct) : "").padStart(18)} ${(i ? `${pct(s.lo)} to ${pct(s.hi)}` : "").padStart(18)} ${(i ? `${s.coinsBetter} / ${s.coinsWorse}` : "").padStart(20)}`),
    "",
    `${base.reached.buys} of the ${buys.length} buys (${((base.reached.buys / buys.length) * 100).toFixed(0)}%) got as far as +${lockAt}% after costs; ${base.rest.buys} did not. What each design made of the two groups:`,
    `${"exit design".padEnd(w)} ${`reached +${lockAt}%`.padStart(12)} ${"ended at a loss".padStart(16)} ${"average of those".padStart(17)} ${"did not reach it".padStart(17)}`,
    ...stats.map((s) => `${s.name.slice(0, w).padEnd(w)} ${pct(s.reached.avgPct).padStart(12)} ${`${s.reached.lost} (${s.reached.buys ? ((s.reached.lost / s.reached.buys) * 100).toFixed(0) : 0}%)`.padStart(16)} ${(s.reached.lost ? pct(s.reached.avgLostPct, 1) : "-").padStart(17)} ${pct(s.rest.avgPct).padStart(17)}`),
    "",
    "per buy = the average result of one buy after costs | held = the middle holding time | open at end = still open when the data ran out (closed at the last price)",
    "against the first = the average difference per buy from the first design, on the same buys | 95% range = where that difference falls 95 times out of 100 when the buys are redrawn (a range that includes 0 means no proven difference)",
  ];
  return out;
}
