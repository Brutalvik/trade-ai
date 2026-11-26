// Which coin should an idle auto-pick agent take? Compares ways of choosing on saved candles.
//
//   npm run backtest:pick                                the 14 coins saved with the back-tester (13 Nov 2026)
//   npm run backtest:pick -- --dir backtest/sets/2026-11-25-list
//                                                        another saved set (a folder of fixtures; with a
//                                                        universe.json beside them, the scouts' order of that day)
//   Options: --step <minutes between decision times, 15>   --budget <usd, 1000>   --take <coins chosen each time, 3>
//            --cheap <"cheap to trade": a round trip of the whole budget costs at most this %, 1.5>
//
// At every decision time, for every coin: what the numbers said about plain buy-now orders, worked
// out as the live order check does it (ai.ts checkOrders with predict.ts) from candles that had
// closed by then, nothing later; then that buy replayed with the live rules on 5-second candles
// (sim.ts). The AI is not replayed: these are buys with no skill, so every row shows what a way of
// choosing the coin is worth on its own. The range after "vs any coin" is a 95% range that redraws
// whole 6-hour blocks of decision times (buys a few minutes apart ride the same move).
//
// What it showed on 25 Nov 2026 (three sets, 3,819 buys; per buy with a fixed 5% stop, choosing 3):
//   any coin                              -2.20 / -1.95 / -2.09
//   by the numbers' margin                -1.98 / +1.91 / -0.61   picks the cheapest, quietest coins; follows whether they trended
//   the scouts' order (the agents' rule)  -2.49 / +0.53 / -0.76
//   the scouts' order, cheap coins only   -1.17 / +2.76 / +0.09   ahead of any coin on all three (+0.91, +4.63, +2.21; each
//                                                                 range clear of zero): the engine's AUTO_MAX_COST_PCT
//   the cheapest coins first              -1.77 / +2.16 / -2.05   cheap alone is not it: the cheapest are the quietest
//   ...cheap AND past the numbers' check  -1.31 / -1.01 / -2.37   worse than cheap alone on all three: on cheap coins the
//                                                                 moments the numbers call lively were the worse ones to buy
//                                                                 (-2.44 / -0.69 / -2.29 a buy, against -0.98 / +3.90 / -0.22),
//                                                                 and only 4.5 / 0.7 / 1.9 coins pass both at one time. So a
//                                                                 shared "quality step" must not pre-select coins by the numbers;
//                                                                 that check stays a gate before a paid AI look (measured 26 Nov).
// The sets: the repo's fixtures (13 Nov), backtest/sets/2026-11-25-fresh, backtest/sets/2026-11-25-list.
// A set for another day is saved with `npm run backtest:list -- <folder> <how many coins>`.
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "../data.js";
import { countedWin, desk, expected } from "../predict.js";
import { EXIT_LIVE, ruleTrailPct } from "../rules.js";
import { loadFixtures, measuredRoundTripPct } from "./fixtures.js";
import { simulate, sizeFor, type CostModel } from "./sim.js";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback; };
const DIR = opt("dir", "");
const STEP_MIN = Number(opt("step", "15")), BUDGET = Number(opt("budget", "1000")), TAKE = Number(opt("take", "3")), CHEAP = Number(opt("cheap", "1.5"));
const CAP = 2.5, MIN_NET = EXIT_LIVE.minNetPct, STOPS = [3, 5, 8, 12], HOLDS = [60, 180], MIN_COINS = 5;
// The engine's free check on the numbers before an agent's AI is asked (bestCase): some plain
// order must have at least FLOOR% by the numbers alone, and pass with an AI that is AI_CEILING% sure.
const FLOOR = 10, AI_CEILING = 95;
const cost: CostModel = { name: "measured", roundTripPct: measuredRoundTripPct };

// ---------- the looks: every coin at every decision time ----------
type Shape = { stop: number; hold: number; numbers: number; need: number; margin: number };
// ready = the coin passed that free check at that moment (a "quality step" would hand it to an agent).
type Look = { symbol: string; pool: string; t: number; costPct: number; usd: number; scoutQ: number | null; shapes: Shape[]; ready: boolean; netPct: number; bestNetPct: number };

// Candles that had closed by `t` (their start plus their length is at or before t): the last `keep`.
function closedBy(c: Candle[], t: number, len: number, keep: number): Candle[] {
  let lo = 0, hi = c.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid].time + len <= t) lo = mid + 1; else hi = mid; }
  return c.slice(Math.max(0, lo - keep), lo);
}
// The coin's usual 5-minute swing (ATR% of 5-minute candles), as sim.ts and the engine work it out.
function atrPct(c5: Candle[]): number | undefined {
  let a = 0;
  for (let i = 1; i < c5.length; i++) {
    const tr = Math.max(c5[i].high - c5[i].low, Math.abs(c5[i].high - c5[i - 1].close), Math.abs(c5[i].low - c5[i - 1].close));
    a = i <= 14 ? (a * (i - 1) + tr) / i : (a * 13 + tr) / 14;
  }
  const last = c5[c5.length - 1];
  return c5.length > 14 && last?.close > 0 ? (a / last.close) * 100 : undefined;
}

const fixtures = loadFixtures(undefined, DIR ? path.resolve(DIR) : undefined).filter((fx) => (fx.candles["5s"]?.length ?? 0) >= 1000 && (fx.candles["5m"]?.length ?? 0) >= 110);
if (!fixtures.length) { console.error(`No fixtures with 5-second candles in ${DIR || "the repo's fixture folder"}.`); process.exit(1); }
const order = DIR && fs.existsSync(path.join(path.resolve(DIR), "universe.json")) ? (JSON.parse(fs.readFileSync(path.join(path.resolve(DIR), "universe.json"), "utf8")) as { coins: { pool: string; symbol: string; rank: number }[] }) : null;
const t0 = Math.min(...fixtures.map((fx) => fx.candles["5s"][0].time)), t1 = Math.max(...fixtures.map((fx) => fx.candles["5s"][fx.candles["5s"].length - 1].time));
const grid: number[] = [];
for (let t = Math.ceil(t0 / (STEP_MIN * 60)) * STEP_MIN * 60; t <= t1; t += STEP_MIN * 60) grid.push(t);

const all: Look[] = [];
for (const fx of fixtures) {
  const c5s = fx.candles["5s"], c1 = fx.candles["1m"] ?? [], c5 = fx.candles["5m"] ?? [];
  const usd = sizeFor(fx, BUDGET, cost, CAP);
  if (usd < 10) continue;
  const costPct = cost.roundTripPct(fx, usd);
  for (const t of grid) {
    if (t < c5s[0].time + 600 || t > c5s[c5s.length - 1].time - 3600) continue; // inside the coin's own data, with an hour after
    const k1 = closedBy(c1, t, 60, 300), k5 = closedBy(c5, t, 300, 300);
    if (k1.length < 150 && k5.length < 100) continue;
    const D = desk(k1, k5, costPct, ruleTrailPct(EXIT_LIVE, atrPct(k5)));
    if (!D.ready) continue;
    const shapes: Shape[] = [];
    for (const stop of STOPS) for (const hold of HOLDS) {
      const f = D.forecast({ offsetPct: 0, upPct: costPct + MIN_NET, downPct: stop, holdMin: hold, waitMin: 0 });
      if (!f) continue;
      const need = expected(f.numbers, countedWin(f.winNetPct, MIN_NET), stop + costPct, f).needPct;
      shapes.push({ stop, hold, numbers: f.numbers, need, margin: f.numbers - need });
    }
    if (!shapes.length) continue;
    // The buy itself, with one order for every coin (a 5% stop), so only the coin differs between rows.
    const tr = simulate(fx, [{ time: t, stopPct: 5, maxHoldMin: 180 }], { tf: "5s", design: EXIT_LIVE, cost, budgetUsd: BUDGET, sizeCapPct: CAP })[0];
    const ready = shapes.some((sh) => sh.numbers >= FLOOR && 0.5 * AI_CEILING + 0.5 * sh.numbers >= sh.need);
    if (tr) all.push({ symbol: fx.symbol, pool: fx.pool, t, costPct, usd, scoutQ: fx.scouts?.quality ?? null, shapes, ready, netPct: tr.netPct, bestNetPct: tr.bestNetPct });
  }
}

// ---------- small statistics ----------
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (v: number, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}%` : "n/a");
const share = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : "n/a");
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function blockRange(times: number[], vals: number[], seed = 7) {
  const blocks = new Map<number, number[]>();
  times.forEach((t, i) => { if (!Number.isFinite(vals[i])) return; const k = Math.floor(t / 21_600); if (!blocks.has(k)) blocks.set(k, []); blocks.get(k)!.push(vals[i]); });
  const bl = [...blocks.values()];
  if (bl.length < 2) return { lo: NaN, hi: NaN };
  const rand = rng(seed), draws: number[] = [];
  for (let d = 0; d < 4000; d++) { let s = 0, n = 0; for (let i = 0; i < bl.length; i++) for (const v of bl[Math.floor(rand() * bl.length)]) { s += v; n++; } draws.push(s / Math.max(1, n)); }
  draws.sort((a, b) => a - b);
  return { lo: draws[Math.floor(0.025 * draws.length)], hi: draws[Math.floor(0.975 * draws.length)] };
}

// ---------- ways of choosing ----------
const fixedShape = (l: Look) => l.shapes.find((s) => s.stop === 5 && s.hold === 180) ?? l.shapes[0];
const rank = new Map<string, number>((order?.coins ?? []).map((c) => [c.pool, c.rank]));
// The scouts' order: a coin's place on that day's list when it was saved, else its quality score.
const scoutScore = (l: Look) => (rank.has(l.pool) ? -rank.get(l.pool)! : l.scoutQ ?? -1);
const top = (ls: Look[], k: number, score: (l: Look) => number) => [...ls].sort((a, b) => score(b) - score(a) || a.symbol.localeCompare(b.symbol)).slice(0, k);
const ways: { name: string; pick: (ls: Look[]) => Look[] }[] = [
  { name: "by the numbers' margin (chance minus need)", pick: (ls) => top(ls, TAKE, (l) => fixedShape(l).margin) },
  { name: "the scouts' order (the agents' rule before v0.68)", pick: (ls) => top(ls, TAKE, scoutScore) },
  { name: `the scouts' order, coins costing at most ${CHEAP}%`, pick: (ls) => top(ls.filter((l) => l.costPct <= CHEAP), TAKE, scoutScore) },
  { name: "the cheapest coins first", pick: (ls) => top(ls, TAKE, (l) => -l.costPct) },
  { name: `...at most ${CHEAP}% and past the numbers' free check`, pick: (ls) => top(ls.filter((l) => l.costPct <= CHEAP && l.ready), TAKE, scoutScore) },
  { name: "past the numbers' free check, any cost", pick: (ls) => top(ls.filter((l) => l.ready), TAKE, scoutScore) },
];

const byTime = new Map<number, Look[]>();
for (const l of all) { if (!byTime.has(l.t)) byTime.set(l.t, []); byTime.get(l.t)!.push(l); }
const times = [...byTime.keys()].filter((t) => byTime.get(t)!.length >= MIN_COINS).sort((a, b) => a - b);
if (!times.length) { console.error("Not enough coins with data at the same time to compare ways of choosing (need at least 5)."); process.exit(1); }
const line = (name: string, picks: Look[], diffs?: number[]) => {
  const r = diffs ? blockRange(times, diffs) : null;
  console.log(`  ${name.padEnd(50)} ${String(picks.length).padStart(5)} buys | per buy ${pct(mean(picks.map((p) => p.netPct))).padStart(7)} | reached +5% ${share(picks.filter((p) => p.bestNetPct >= MIN_NET).length / Math.max(1, picks.length)).padStart(4)} | cost ${mean(picks.map((p) => p.costPct)).toFixed(2)}%, invests $${mean(picks.map((p) => p.usd)).toFixed(0)}${diffs && r ? ` | vs any coin ${pct(mean(diffs.filter(Number.isFinite)))} (${pct(r.lo)} to ${pct(r.hi)})` : ""}`);
};
const coins = [...new Set(all.map((l) => l.symbol))];
console.log(`\n${DIR || "the repo's fixtures"}: ${coins.length} coins (${coins.join(", ")})`);
console.log(`${times.length} decision times ${STEP_MIN} minutes apart with at least ${MIN_COINS} coins to choose from, ${new Date(times[0] * 1000).toISOString().slice(0, 16)} to ${new Date(times[times.length - 1] * 1000).toISOString().slice(0, 16)} UTC; budget $${BUDGET}; a buy with no skill and a 5% stop under the live exit rules\n`);
console.log(`-- choosing ${TAKE} coin${TAKE > 1 ? "s" : ""} at each decision time --`);
line("any coin (choosing with no information)", times.flatMap((t) => byTime.get(t)!));
for (const w of ways) {
  const picks: Look[] = [], diffs: number[] = [];
  for (const t of times) {
    const ls = byTime.get(t)!, chosen = w.pick(ls);
    picks.push(...chosen);
    diffs.push(mean(chosen.map((c) => c.netPct)) - mean(ls.map((l) => l.netPct)));
  }
  line(w.name, picks, diffs);
}

// How many coins a shared quality step could hand to agents at one moment.
{
  const count = (f: (l: Look) => boolean) => times.map((t) => byTime.get(t)!.filter(f).length);
  const show = (name: string, ns: number[]) => console.log(`  ${name.padEnd(58)} ${mean(ns).toFixed(1)} of ${mean(times.map((t) => byTime.get(t)!.length)).toFixed(1)} coins on average | none ${share(ns.filter((n) => n === 0).length / ns.length).padStart(4)} of the time, 1 or 2 ${share(ns.filter((n) => n === 1 || n === 2).length / ns.length).padStart(4)}, 3 or more ${share(ns.filter((n) => n >= 3).length / ns.length).padStart(4)}`);
  console.log(`\n-- how many coins pass the free checks at one decision time (what a quality step could hand out) --`);
  show(`cost at most ${CHEAP}% for the whole budget`, count((l) => l.costPct <= CHEAP));
  show("past the numbers' free check", count((l) => l.ready));
  show("both", count((l) => l.costPct <= CHEAP && l.ready));
  const both = all.filter((l) => l.costPct <= CHEAP && l.ready), cheapNot = all.filter((l) => l.costPct <= CHEAP && !l.ready);
  console.log(`  buys on cheap coins: past the numbers' check ${both.length} buys, per buy ${pct(mean(both.map((l) => l.netPct)))}, reached +5% ${share(both.filter((l) => l.bestNetPct >= MIN_NET).length / Math.max(1, both.length))} | not past it ${cheapNot.length} buys, per buy ${pct(mean(cheapNot.map((l) => l.netPct)))}, reached +5% ${share(cheapNot.filter((l) => l.bestNetPct >= MIN_NET).length / Math.max(1, cheapNot.length))}`);
}

console.log(`\n-- by what a round trip costs at the agent's size (every coin at every decision time) --`);
for (const [lo, hi, name] of [[0, 1.2, "up to 1.2%"], [1.2, 2.4, "1.2 to 2.4%"], [2.4, 99, "2.4% and over (at the size cap)"]] as const) {
  const ls = all.filter((l) => l.costPct >= lo && l.costPct < hi);
  if (ls.length) console.log(`  ${name.padEnd(32)} ${String(ls.length).padStart(5)} buys on ${[...new Set(ls.map((l) => l.symbol))].length} coins | the numbers ${mean(ls.map((l) => fixedShape(l).numbers)).toFixed(0).padStart(3)}%, an order needs ${mean(ls.map((l) => fixedShape(l).need)).toFixed(0).padStart(3)}% | reached +5% ${share(ls.filter((l) => l.bestNetPct >= MIN_NET).length / ls.length).padStart(4)} | per buy ${pct(mean(ls.map((l) => l.netPct))).padStart(7)}`);
}

console.log(`\n-- the coins, ${order ? "in the scouts' order that day" : "by cost"}: what a round trip of $${BUDGET} costs (the size the 2.5% cap leaves, when it cuts the trade) --`);
const seen = new Map<string, Look>();
for (const l of all) if (!seen.has(l.pool)) seen.set(l.pool, l);
const rows = [...seen.values()].sort((a, b) => (order ? scoutScore(b) - scoutScore(a) : a.costPct - b.costPct));
console.log(`  ${rows.map((l) => `${l.symbol} ${l.costPct.toFixed(1)}%${l.usd < BUDGET - 1 ? ` ($${l.usd.toFixed(0)})` : ""}`).join("   ")}`);
console.log(`  of ${rows.length} coins: ${rows.filter((l) => l.costPct <= CHEAP).length} cost at most ${CHEAP}% for the whole budget; on ${rows.filter((l) => l.usd < BUDGET - 1).length} the size cap cuts the trade down`);
process.exit(0);
