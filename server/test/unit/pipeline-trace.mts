// The Pipeline's coin trace (web/src/pipelineTrace.ts): for each coin, how far its latest attempt
// got through SCAN -> CHECK -> AI PLAN -> SIZE -> EXECUTE -> LOG, and what each step did, from the
// decisions kept with the log (their own figures, or for older lines what their reason says).
import { expect, finish } from "../check.mts";
const { coinTraces } = await import(new URL("../../../web/src/pipelineTrace.ts", import.meta.url).href);

const T = Date.UTC(2026, 10, 27, 12, 0, 0);
const line = (min: number, d: Record<string, unknown>, msg = "") => ({ t: T + min * 60_000, bot: "1", msg, level: "info", d });
const lines = [
  // bought: every step done
  line(1, { act: "pick", coin: "MIHAO", score: 84, costPct: 0.18, why: "the scouts' score 84 of 100, costs 0.18% to trade with its $9,870.67" }),
  line(3, { act: "enter", coin: "MIHAO", usd: 9870.67, of: 9870.67, price: 0.0047, winPct: 68, needPct: 55, costPct: 0.18, why: "breakout · 68% chance, needs 55%" }),
  // ruled out by the numbers
  line(4, { act: "pick", coin: "HYPE", score: 76, costPct: 0.2, why: "the scouts' score 76 of 100" }),
  line(5, { act: "filtered", coin: "HYPE", by: "numbers", why: "the numbers: moves less than the 10% it needs" }),
  // the AI stayed out
  line(6, { act: "pick", coin: "FLOAT", score: 70, why: "the scouts' score 70 of 100" }),
  line(7, { act: "skip", coin: "FLOAT", winPct: 41, needPct: 55, why: "no clear setup · closest: a dip to $0.0021, 41% chance, needs 55%" }),
  // an order waiting (an older line: the figures are read from its reason)
  line(8, { act: "order", coin: "ZEC", why: "waits for a dip to $512.3 (58% chance, needs 55%)" }),
  // bought and sold (older lines: figures from the reason and the line)
  line(9, { act: "enter", coin: "ORE", usd: 1000, why: "breakout · 64% chance, needs 55%" }, "BUY ORE $1000.00 @ $0.01230 (breakout)."),
  line(20, { act: "exit", coin: "ORE", pnl: 12.5, pct: 1.3, why: "profit exit" }, "SELL ORE @ $0.01250: profit exit. P&L +$12.50"),
  // lines that are not about a coin's trade are left out
  line(21, { act: "wait", why: "no coin is free" }),
];
const tr = coinTraces(lines, { scanned: 231 });
const by = (c: string) => tr.find((x: any) => x.coin === c);
expect("one trace per coin, the newest first", tr.map((x: any) => x.coin), ["ORE", "ZEC", "FLOAT", "HYPE", "MIHAO"]);
expect("a bought coin: Executed (6/6), its entry price and size", [by("MIHAO").chip, by("MIHAO").reached, by("MIHAO").entry], ["Executed (6/6)", 6, { price: 0.0047, usd: 9870.67 }]);
expect("...each step passed, with the mockup's words", by("MIHAO").steps.map((s: any) => s.pill), ["PASSED", "PASSED", "APPROVED", "SIZED", "FILLED", "RECORDED"]);
expect("...and its figures: score, checks, odds, size, fill price, its entry in the log", by("MIHAO").steps.map((s: any) => s.figure), ["84 / 100", "3 / 3 Clear", "68% Win Odds", "$9,870.67", "$0.004700", "Entry #02"]);
expect("...the scan says how many coins were scanned", by("MIHAO").steps[0].line, "Found MIHAO across 231 coins");
expect("a coin ruled out: Stopped Step 2, by which check, and nothing after it", [by("HYPE").chip, by("HYPE").steps[1].pill, by("HYPE").steps[1].line, by("HYPE").steps.slice(2, 5).map((s: any) => s.state)], ["Stopped Step 2", "RULED OUT", "Ruled out by the numbers", ["todo", "todo", "todo"]]);
expect("a coin its AI stayed out of: Skipped Step 3, with the odds it had and needed", [by("FLOAT").chip, by("FLOAT").steps[2].pill, by("FLOAT").steps[2].figure, by("FLOAT").steps[2].caption], ["Skipped Step 3", "STAYED OUT", "41% Win Odds", "needs 55%"]);
expect("an order waiting at a price (read from an older line's reason)", [by("ZEC").chip, by("ZEC").steps[2].pill, by("ZEC").steps[2].line, by("ZEC").steps[2].figure], ["Waiting Step 3", "WAITING", "Waits for $512.3", "58% Win Odds"]);
expect("bought and sold: Sold (6/6), the result and the sale price", [by("ORE").chip, by("ORE").steps[4].pill, by("ORE").steps[4].figure, by("ORE").steps[4].caption], ["Sold (6/6)", "SOLD", "+$12.50", "+1.3% · sold @ $0.01250"]);
expect("...an older buy's price is read from its line", by("ORE").entry, { price: 0.0123, usd: 1000 });
expect("a coin an agent was put on by hand has no scouts' pick: chosen for its agent", by("ORE").steps[0].line, "ORE chosen for its agent");
const again = coinTraces([...lines, line(30, { act: "pick", coin: "MIHAO", score: 90, why: "the scouts' score 90 of 100" })]);
expect("taken again from the list: the trace starts over from that pick", [again.find((x: any) => x.coin === "MIHAO").chip, again.find((x: any) => x.coin === "MIHAO").steps[0].figure], ["Scanned (1/6)", "90 / 100"]);
expect("nothing traded in the stretch: no traces", coinTraces([line(1, { act: "wait", why: "no coin" })]), []);
finish();
