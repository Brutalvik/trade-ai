// Back-tester: replays an agent's trades on saved candles with the bot's own rules.
//
//   npm run backtest                                  the comparison table on 1-minute candles
//   npm run backtest -- --tf 5s                       the same on 5-second candles (exact replay of the rules)
//   npm run backtest -- --entries pattern:breakout    entries from one of the study's patterns
//   npm run backtest -- --exit late --cost measured --cap 2.5
//                                                     one run: an exit design, a cost model, a size cap
//   npm run backtest -- --coins food,wif --budget 250 --json out.json
//   npm run backtest -- --paired --tf 5s              exit designs on identical buys: every test buy is replayed
//                                                     on its own under each design (the fair way to compare exits)
//
// Options: --tf 5s|1m|5m   --entries every:<min>|pattern:<key>[:<tf>]   --exit <design>[,<design>]
//          --cost flat|measured   --cap <max round-trip %>   --floor <min chance by the numbers, %>
//          --gate (leave out coins the scouts refused when the fixture was saved)
//          --budget <usd>   --stop <%>   --hold <minutes>   --coins a,b   --json <file>   --per-coin
//          --paired [--exit a,b,c] [--all-coins]   (defaults: real costs, size cap 2.5%, numbers floor 10%,
//          scout-refused coins left out; "lock<N>" is the bot's design with the floor locked at +N%)
// Exit designs and cost models: see strategies.ts. What a back-test cannot do: see sim.ts.
import fs from "node:fs";
import { loadFixtures } from "./fixtures.js";
import { HEADER, metrics, row, type Metrics } from "./metrics.js";
import { pairedBuys, pairedLines } from "./paired.js";
import { simulate, type SimTrade } from "./sim.js";
import { COSTS, DESIGNS, design as designFor, strategy } from "./strategies.js";

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const flag = (name: string) => args.includes(`--${name}`);

const tf = opt("tf", "1m")!;
const budget = Number(opt("budget", "1000"));
const stopPct = Number(opt("stop", "5"));
const hold = Number(opt("hold", "240"));
const strat = strategy(opt("entries", "every:15")!, stopPct, hold);
const fixtures = loadFixtures(opt("coins")?.split(",")).filter((f) => (f.candles[tf]?.length ?? 0) >= 200);
if (!fixtures.length) {
  console.error(`No fixtures with ${tf} candles. Save some with: npm run backtest:fetch -- <pool address>`);
  process.exit(1);
}

const entriesNote = `Entries: ${strat.name} | stop ${opt("entries", "every:15")!.startsWith("pattern") ? "sized by the pattern (4-7%)" : `${stopPct}%`}`;
const replayNote = tf === "5s" ? "exact replay of the rules" : "cautious approximation inside each candle";

// ---------- Exit designs on identical buys ----------
if (flag("paired")) {
  const keys = opt("exit", "live,adaptive-timed,breakeven,lock8,late,lock15")!.split(",");
  const designs = Object.fromEntries(keys.map((k) => {
    const d = designFor(k);
    if (!d) throw new Error(`Unknown exit design "${k}". Use lock<N> or one of: ${Object.keys(DESIGNS).join(", ")}`);
    return [k, d];
  }));
  const cost = COSTS[opt("cost", "measured")!];
  if (!cost) throw new Error(`Unknown cost model "${opt("cost")}". Use one of: ${Object.keys(COSTS).join(", ")}`);
  const cap = Number(opt("cap", "2.5")), floor = Number(opt("floor", "10"));
  const coins = fixtures.filter((fx) => flag("all-coins") || fx.scouts?.ok !== false);
  const buys = pairedBuys(coins, strat.entries, designs, { tf, cost, budgetUsd: budget, ...(cap ? { sizeCapPct: cap } : {}), ...(floor ? { minNumbersPct: floor } : {}) });
  console.log(`${coins.length} coins (${coins.map((f) => f.symbol).join(", ")})${flag("all-coins") ? "" : ", without coins the scouts refused"} | ${tf} candles (${replayNote})`);
  console.log(`${entriesNote} | ${cost.name} costs${cap ? `, size cap ${cap}%` : ""}${floor ? `, numbers floor ${floor}%` : ""} | $${budget} a buy`);
  console.log(`Every test buy is replayed on its own under each design, so all designs are judged on the same ${buys.length} buys.\n`);
  for (const l of pairedLines(buys, designs)) console.log(l);
  const to = opt("json");
  if (to) {
    fs.writeFileSync(to, JSON.stringify({ at: new Date().toISOString(), tf, entries: strat.name, budget, coins: coins.map((f) => f.symbol), designs: keys, buys }, null, 1));
    console.log(`\nSaved to ${to}`);
  }
  process.exit(0);
}

type Run = { name: string; design: string; cost: string; cap?: number; floor?: number; gate?: boolean };
const one = opt("exit") || opt("cost") || opt("cap") || opt("floor") || flag("gate");
const UP = { cost: "measured", cap: 2.5, floor: 10 }; // the upgraded engine's entry side: real costs, the size cap, the floor on the numbers
const runs: Run[] = one
  ? (opt("exit", "v058")!).split(",").map((d) => ({
      name: `${d} | ${opt("cost", "flat")} costs${opt("cap") ? ` | size cap ${opt("cap")}%` : ""}${opt("floor") ? ` | numbers floor ${opt("floor")}%` : ""}${flag("gate") ? " | scouts' gate" : ""}`,
      design: d, cost: opt("cost", "flat")!, ...(opt("cap") ? { cap: Number(opt("cap")) } : {}), ...(opt("floor") ? { floor: Number(opt("floor")) } : {}), ...(flag("gate") ? { gate: true } : {}),
    }))
  : [
      // v0.58.0 first, then each change on top of the last, as they were shipped.
      { name: "1. v0.58.0 (flat 3% costs, lock at +5%, 2.5% trail)", design: "v058", cost: "flat" },
      { name: "2. + real costs for the trade's size", design: "v058", cost: "measured" },
      { name: "3. + size cap (round trip at most 2.5%)", design: "v058", cost: "measured", cap: 2.5 },
      { name: "4. + floor on the numbers (10%)", design: "v058", ...UP },
      { name: "5. + adaptive trail = the engine now", design: "adaptive", ...UP },
      { name: "6. the engine now, without coins the scouts refuse", design: "adaptive", ...UP, gate: true },
      // Exit designs that are NOT live (the owner's call), each on top of row 6.
      { name: "7. row 6 + the order's time limit", design: "adaptive-timed", ...UP, gate: true },
      { name: "8. row 6 + break-even at +5%, +5% floor at +8%", design: "breakeven", ...UP, gate: true },
      { name: "9. row 6 + +5% floor locked only at +10%", design: "late", ...UP, gate: true },
    ];

const results: { run: Run; m: Metrics; trades: SimTrade[] }[] = [];
for (const r of runs) {
  const design = designFor(r.design), cost = COSTS[r.cost];
  if (!design) throw new Error(`Unknown exit design "${r.design}". Use lock<N> or one of: ${Object.keys(DESIGNS).join(", ")}`);
  if (!cost) throw new Error(`Unknown cost model "${r.cost}". Use one of: ${Object.keys(COSTS).join(", ")}`);
  const coins = fixtures.filter((fx) => !r.gate || fx.scouts?.ok !== false); // a coin the scouts refused is not traded at all
  const trades = coins.flatMap((fx) => simulate(fx, strat.entries(fx), { tf, design, cost, budgetUsd: budget, ...(r.cap ? { sizeCapPct: r.cap } : {}), ...(r.floor ? { minNumbersPct: r.floor } : {}) }));
  results.push({ run: r, m: metrics(trades, coins.length, budget), trades });
}

const hours = fixtures.reduce((s, f) => { const c = f.candles[tf]; return s + (c[c.length - 1].time - c[0].time) / 3600; }, 0);
console.log(`${fixtures.length} coins (${fixtures.map((f) => f.symbol).join(", ")}) | ${tf} candles, ${hours.toFixed(0)} coin-hours (${replayNote})`);
console.log(`${entriesNote}, one trade at a time per coin | budget $${budget} per coin, each buy invests the agent's funds\n`);
console.log(HEADER);
for (const r of results) console.log(row(r.run.name, r.m));
console.log(`\nper trade = average result of one trade after costs | net return = total profit on the budgets put in ($${budget} a coin) | no top 3 = the same without the three best trades | max fall = worst drop of the combined account from a high`);
if (!one) console.log("Rows 7 to 9 change when a trade is sold, so they also change how often the agent buys, and every buy here costs money: their rows are not a like-for-like test of the exit. For the exit designs on identical buys: npm run backtest -- --paired --tf 5s");
const refused = fixtures.filter((f) => f.scouts?.ok === false);
if (runs.some((r) => r.gate)) console.log(`Coins the scouts refused when the candles were saved (left out of the rows that say so): ${refused.length ? refused.map((f) => `${f.symbol} (${f.scouts!.reasons[0]})`).join("; ") : "none"}. The scouts' inputs have no history, so this is their verdict at that time, not at each trade.`);
if (flag("per-coin")) {
  for (const r of results) {
    console.log(`\n${r.run.name}`);
    for (const fx of fixtures) {
      const t = r.trades.filter((x) => x.symbol === fx.symbol);
      console.log(`  ${row(fx.symbol, metrics(t, 1, budget))}`);
    }
  }
}
const file = opt("json");
if (file) {
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), tf, entries: strat.name, budget, coins: fixtures.map((f) => f.symbol), runs: results.map((r) => ({ ...r.run, metrics: r.m, trades: r.trades })) }, null, 1));
  console.log(`\nSaved to ${file}`);
}
