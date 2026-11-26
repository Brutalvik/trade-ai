// The Pipeline tab (web/src/pipelineSteps.ts): six steps, each with what it did, worked out from
// the decisions kept with the log, the scouts' latest list and the open trades. A view only.
import { check, expect, finish } from "../check.mts";
const { pipelineSteps, ruledOutBy } = await import(new URL("../../../web/src/pipelineSteps.ts", import.meta.url).href);

const NOW = Date.UTC(2026, 10, 26, 3, 0, 0);
const ago = (min: number) => NOW - min * 60_000;
const line = (min: number, bot: string, d: any, sym?: string) => ({ t: ago(min), bot, ...(sym ? { sym } : {}), msg: `line ${min}`, level: "info", ...(d ? { d } : {}) });
const B = "·";

// A night: two agents. The newest thing is a sale two minutes ago.
const night = [
  line(175, "1", { act: "start", why: "auto-pick agent with a $1,000 budget" }),
  line(174, "1", { act: "wait", why: "finding out what the free coins cost to trade with its $1,000 (2 too expensive so far)" }),
  line(173, "1", { act: "pick", coin: "TROLL", why: "the scouts' score 80 of 100, costs 0.9% to trade with its $1,000" }),
  line(172, "1", { act: "skip", coin: "TROLL", why: "no edge" }),
  line(167, "1", { act: "skip", coin: "TROLL", why: "still ranging" }),
  line(152, "1", { act: "order", coin: "TROLL", why: "waits for a dip to $0.04120 (52% chance, needs 47%)" }),
  line(141, "1", { act: "enter", coin: "TROLL", usd: 1000, of: 1000, why: "pullback" }),
  line(118, "1", { act: "lock", coin: "TROLL", why: "up +5.6% after fees" }),
  line(96, "1", { act: "exit", coin: "TROLL", pnl: 61.2, pct: 6.1, why: "the AI sold" }),
  line(150, "2", { act: "filtered", coin: "PUMPCADE", why: "the scouts: the top 10 wallets own 61%" }),
  line(120, "2", { act: "filtered", coin: "hSOL", why: "the numbers: at most 6%, under the 10% floor" }),
  line(60, "2", { act: "filtered", coin: "hSOL", why: "the numbers: at most 4%, under the 10% floor" }),
  line(40, "2", { act: "filtered", coin: "mihao", why: "the cost: trading its $1,000 there costs 2.3% now, it accepts 1.5%" }),
  line(39, "2", { act: "left", coin: "mihao", why: "the cost: trading its $1,000 there costs 2.3%, it accepts 1.5%; no other coin is free" }),
  line(38, "2", { act: "filtered", coin: "BP", why: "its order is dropped: trading its $1,000 there costs 2.6%, it accepts 1.5%" }),
  line(30, "2", { act: "enter", coin: "CATE", usd: 447.5, of: 1000, why: "higher lows" }),
  line(2, "2", { act: "exit", coin: "CATE", pnl: -12.4, pct: -2.8, why: "Stop-loss hit" }),
  line(1, "2", null), // a line that decided nothing
];
const steps = pipelineSteps({ lines: night, now: NOW, scan: { scanned: 251, passing: 4, top: ["TROLL", "ORE", "CATE", "XMR"] }, open: 0, running: 2 });
const by = (key: string) => steps.find((s: any) => s.key === key);
expect("six steps, in the order a trade goes through them", steps.map((s: any) => `${s.short}=${s.name}`), ["SCAN=Scanner", "CHECK=Quality check", "AI=AI and odds", "SIZE=Sizer", "EXEC=Executor", "LOG=Logger"]);
check("every step says what it does and the rule it never breaks", steps.every((s: any) => s.role.length > 20 && s.rule.length > 10), steps.map((s: any) => s.rule));

expect("the scanner: what the scouts scanned, how many pass, the top of the list, and how often a coin was chosen or none was free",
  [by("scan").figure, by("scan").caption], ["251 scanned", `4 of the top 4 pass every check ${B} top: TROLL, ORE, CATE ${B} chose a coin once ${B} found none free once`]);
expect("the quality check: every time a coin was ruled out or let go, on how many coins, and by whom",
  [by("check").figure, by("check").caption], ["6 ruled out", `4 coins ${B} by the scouts 1 ${B} by the numbers 2 ${B} by the cost 3`]);
expect("who ruled a coin out is read from how the engine begins the reason", night.filter((l) => l.d && (l.d.act === "filtered" || l.d.act === "left")).map((l) => ruledOutBy(l.d)), ["scouts", "numbers", "numbers", "cost", "cost", "cost"]);
expect("since v0.71 the decision itself says who ruled the coin out, whatever its reason says", [ruledOutBy({ act: "filtered", by: "cost", why: "anything at all" }), ruledOutBy({ act: "filtered", by: "numbers", why: "the scouts: looks like their line" }), ruledOutBy({ act: "left", by: "scouts", why: "" })], ["cost", "numbers", "scouts"]);
expect("a reason that begins some other way still counts as ruled out", [ruledOutBy({ act: "filtered", why: "something new" }), pipelineSteps({ lines: [line(5, "1", { act: "filtered", coin: "X", why: "something new" })], now: NOW, open: 0, running: 1 })[1].caption], ["other", `1 coin ${B} by the scouts 0 ${B} by the numbers 0 ${B} by the cost 0 ${B} other 1`]);
expect("the AI and the odds: how often it stayed out, how many orders were approved and bought, how many plans wait at a price",
  [by("ai").figure, by("ai").caption], ["2 stayed out", `2 orders approved and bought ${B} 1 plan waiting at a price`]);
expect("the sizer: the latest size, and how many trades were sized in full or cut down for the cost",
  [by("size").figure, by("size").caption, by("size").last.text], ["$447.50", `the latest size ${B} 2 trades sized: 1 in full, 1 cut down for the cost`, "CATE: $447.50 of the $1,000.00 it had, cut down for the cost"]);
expect("...a trade sized in full says so", pipelineSteps({ lines: [line(5, "1", { act: "enter", coin: "ORE", usd: 1000, of: 1000, why: "breakout" })], now: NOW, open: 1, running: 1 })[3].last.text, "ORE: all $1,000.00 it had");
expect("the executor: open trades now, bought, sold with wins and losses and what they came to, minimum profits locked",
  [by("exec").figure, by("exec").caption], ["0 open", `bought 2 ${B} sold 2 (1 at a profit, 1 at a loss): +$48.80 ${B} minimum profit locked once`]);
expect("the logger: every decision, whatever the step (a line that decided nothing is not one)", [by("log").figure, by("log").last.text], ["17 decisions", "SOLD CATE: Stop-loss hit"]);

// The newest thing each step did, and which steps are active.
expect("each step shows the newest thing it did", [by("scan").last.text, by("check").last.text, by("ai").last.text, by("exec").last.text],
  ["CHOSE TROLL: the scouts' score 80 of 100, costs 0.9% to trade with its $1,000", "RULED OUT BP: its order is dropped: trading its $1,000 there costs 2.6%, it accepts 1.5%", "WAITING TROLL: waits for a dip to $0.04120 (52% chance, needs 47%)", "SOLD CATE: Stop-loss hit"]);
expect("...and when", [by("exec").last.t, by("check").last.t], [ago(2), ago(38)]);
expect("a step is active when it did something in the last three minutes", steps.map((s: any) => `${s.short}:${s.on}`), ["SCAN:false", "CHECK:false", "AI:false", "SIZE:false", "EXEC:true", "LOG:true"]);
expect("the executor is also active while a trade is open, however long ago it bought", pipelineSteps({ lines: night.filter((l) => l.t < ago(50)), now: NOW, open: 1, running: 1 }).map((s: any) => `${s.short}:${s.on}`), ["SCAN:false", "CHECK:false", "AI:false", "SIZE:false", "EXEC:true", "LOG:false"]);

// With little to show.
const empty = pipelineSteps({ lines: [], now: NOW, open: 0, running: 0 });
expect("nothing decided yet: every step still stands, with zeros and no newest action",
  empty.map((s: any) => [s.figure, s.last, s.on]), [["0 coins chosen", null, false], ["0 ruled out", null, false], ["0 stayed out", null, false], ["–", null, false], ["0 open", null, false], ["0 decisions", null, false]]);
expect("...and plain captions", [empty[1].caption, empty[3].caption, empty[0].caption], ["nothing ruled out in this stretch", "no trade sized in this stretch", `chose a coin 0 times ${B} found none free 0 times`]);
expect("without the scouts' list the scanner counts the coins chosen", pipelineSteps({ lines: night, now: NOW, scan: null, open: 0, running: 2 })[0].figure, "1 coin chosen");
expect("lines come in any order", pipelineSteps({ lines: [...night].reverse(), now: NOW, open: 0, running: 2 }).map((s: any) => s.figure).slice(1), steps.map((s: any) => s.figure).slice(1));

finish();
