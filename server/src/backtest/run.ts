// Back-tester: replays an agent's trades on saved candles with the bot's own rules.
//
//   npm run backtest                                  the comparison table on 1-minute candles
//   npm run backtest -- --tf 5s                       the same on 5-second candles (exact replay of the rules)
//   npm run backtest -- --entries pattern:breakout    entries from one of the study's patterns
//   npm run backtest -- --exit late --cost measured --cap 2.5
//                                                     one run: an exit design, a cost model, a size cap
//   npm run backtest -- --coins food,wif --budget 250 --json out.json
//
// Options: --tf 5s|1m|5m   --entries every:<min>|pattern:<key>[:<tf>]   --exit <design>[,<design>]
//          --cost flat|measured   --cap <max round-trip %>   --budget <usd>   --stop <%>
//          --hold <minutes>   --coins a,b   --json <file>   --per-coin
// Exit designs and cost models: see strategies.ts. What a back-test cannot do: see sim.ts.
import fs from "node:fs";
import { loadFixtures } from "./fixtures.js";
import { HEADER, metrics, row, type Metrics } from "./metrics.js";
import { simulate, type SimTrade } from "./sim.js";
import { COSTS, DESIGNS, strategy } from "./strategies.js";

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

type Run = { name: string; design: string; cost: string; cap?: number };
const one = opt("exit") || opt("cost") || opt("cap");
const runs: Run[] = one
  ? (opt("exit", "v058")!).split(",").map((d) => ({ name: `${d} | ${opt("cost", "flat")} costs${opt("cap") ? ` | size cap ${opt("cap")}%` : ""}`, design: d, cost: opt("cost", "flat")!, ...(opt("cap") ? { cap: Number(opt("cap")) } : {}) }))
  : [
      // The comparison: today's engine first, then one change at a time, then the changes together.
      { name: "v0.58.0: flat 3% costs, lock at +5%, 2.5% trail", design: "v058", cost: "flat" },
      { name: "v0.58.0 with the time limit working", design: "timed", cost: "flat" },
      { name: "real costs, same exits", design: "v058", cost: "measured" },
      { name: "real costs + size cap 2.5%", design: "v058", cost: "measured", cap: 2.5 },
      { name: "flat costs + adaptive trail", design: "adaptive", cost: "flat" },
      { name: "flat costs + break-even at +5%, floor at +8%", design: "breakeven", cost: "flat" },
      { name: "flat costs + floor locked at +10%", design: "late", cost: "flat" },
      { name: "real costs + cap + adaptive trail", design: "adaptive", cost: "measured", cap: 2.5 },
      { name: "real costs + cap + break-even design", design: "breakeven", cost: "measured", cap: 2.5 },
      { name: "real costs + cap + floor locked at +10%", design: "late", cost: "measured", cap: 2.5 },
    ];

const results: { run: Run; m: Metrics; trades: SimTrade[] }[] = [];
for (const r of runs) {
  const design = DESIGNS[r.design], cost = COSTS[r.cost];
  if (!design) throw new Error(`Unknown exit design "${r.design}". Use one of: ${Object.keys(DESIGNS).join(", ")}`);
  if (!cost) throw new Error(`Unknown cost model "${r.cost}". Use one of: ${Object.keys(COSTS).join(", ")}`);
  const trades = fixtures.flatMap((fx) => simulate(fx, strat.entries(fx), { tf, design, cost, budgetUsd: budget, ...(r.cap ? { sizeCapPct: r.cap } : {}) }));
  results.push({ run: r, m: metrics(trades, fixtures.length, budget), trades });
}

const hours = fixtures.reduce((s, f) => { const c = f.candles[tf]; return s + (c[c.length - 1].time - c[0].time) / 3600; }, 0);
console.log(`${fixtures.length} coins (${fixtures.map((f) => f.symbol).join(", ")}) | ${tf} candles, ${hours.toFixed(0)} coin-hours${tf === "5s" ? " (exact replay of the rules)" : " (cautious approximation inside each candle)"}`);
console.log(`Entries: ${strat.name}, one trade at a time per coin | stop ${opt("entries", "every:15")!.startsWith("pattern") ? "sized by the pattern (4-7%)" : `${stopPct}%`} | budget $${budget} per coin, each buy invests the agent's funds\n`);
console.log(HEADER);
for (const r of results) console.log(row(r.run.name, r.m));
console.log(`\nper trade = average result of one trade after costs | net return = total profit on the ${fixtures.length} x $${budget} put in | no top 3 = the same without the three best trades | max fall = worst drop of the combined account from a high`);
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
