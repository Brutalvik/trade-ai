// The one-line view of the agents' log (web/src/decisions.ts): one row per decision, repeats of
// the same decision by the same agent on the same coin folded into one row, the figure at the
// right of each row, its colour, and the line that sums the rows up.
import { expect, finish } from "../check.mts";
const { ACT_LABEL, decisionRows, decisionSummary, figureOf, summaryText, toneOf } = await import(new URL("../../../web/src/decisions.ts", import.meta.url).href);

const T = Date.UTC(2026, 10, 26, 1, 0, 0);
const min = (m: number) => T + m * 60_000;
const line = (m: number, bot: string, d: any, sym?: string) => ({ t: min(m), bot, ...(sym ? { sym } : {}), msg: `line at ${m}`, level: "info", ...(d ? { d } : {}) });
const skip = (coin: string, why = "no edge") => ({ act: "skip", coin, why });
const show = (rows: any[]) => rows.map((r) => `${new Date(r.t).toISOString().slice(11, 16)} ${ACT_LABEL[r.d.act]} ${r.coin} x${r.n}${r.n > 1 ? ` since ${new Date(r.from).toISOString().slice(11, 16)}` : ""} [${r.bot}]`);

// One agent: stays out three times, buys, the minimum locks, sells, stays out twice more.
const night = [
  line(0, "1", { act: "start", coin: "AAA", why: "agent with a $1,000 budget" }),
  line(1, "1", skip("AAA", "first reason")),
  line(2, "1", null), // a line that decided nothing
  line(6, "1", skip("AAA", "second reason")),
  line(11, "1", skip("AAA", "third reason")),
  line(16, "1", { act: "enter", coin: "AAA", usd: 1000, of: 1000, why: "breakout holding" }),
  line(30, "1", { act: "lock", coin: "AAA", why: "up +5.4% after fees" }),
  line(41, "1", { act: "exit", coin: "AAA", pnl: 61.2, pct: 6.1, why: "the AI sold: momentum faded" }),
  line(42, "1", skip("AAA")),
  line(47, "1", skip("AAA", "latest reason")),
];
const rows = decisionRows([...night].reverse()); // (any order in)
expect("one row per decision, newest first; the same decision about the same coin, look after look, is one row with a count and the time of the first",
  show(rows), ["01:47 STAYED OUT AAA x2 since 01:42 [1]", "01:41 SOLD AAA x1 [1]", "01:30 LOCKED AAA x1 [1]", "01:16 BOUGHT AAA x1 [1]", "01:11 STAYED OUT AAA x3 since 01:01 [1]", "01:00 STARTED AAA x1 [1]"]);
expect("a folded row shows the latest reason", [rows[0].d.why, rows[4].d.why], ["latest reason", "third reason"]);
expect("a line that decided nothing is not a row", rows.some((r: any) => r.t === min(2)), false);

// Several agents at once: each agent's repeats fold on their own, however the lines interleave.
const two = decisionRows([
  line(0, "1", skip("AAA")), line(1, "2", skip("BBB")), line(5, "1", skip("AAA")), line(6, "2", skip("BBB")), line(10, "1", skip("AAA")),
  line(11, "2", { act: "filtered", coin: "BBB", why: "the numbers: at most 6%" }), line(12, "2", { act: "filtered", coin: "CCC", why: "the scouts: the dev holds 27%" }),
]);
expect("two agents: each one's repeats are folded separately; another kind of decision, or another coin, starts a new row",
  show(two), ["01:12 RULED OUT CCC x1 [2]", "01:11 RULED OUT BBB x1 [2]", "01:10 STAYED OUT AAA x3 since 01:00 [1]", "01:06 STAYED OUT BBB x2 since 01:01 [2]"]);
expect("buys and sales are never folded, even on the same coin", decisionRows([line(0, "1", { act: "enter", coin: "AAA", usd: 100, why: "a" }), line(1, "1", { act: "enter", coin: "AAA", usd: 100, why: "b" })]).length, 2);
expect("a decision with no coin of its own takes the coin the agent was on, or none", decisionRows([line(0, "1", { act: "wait", why: "no coin free" }), line(1, "2", { act: "stop", why: "Stopped by user" }, "ZZZ")]).map((r: any) => r.coin), ["ZZZ", ""]);

// The figure at the right of a row.
expect("a buy shows the money put in, and what it was taken from when that was more", [figureOf({ act: "enter", usd: 1000, of: 1000, why: "" }), figureOf({ act: "enter", usd: 447.5, of: 1000, why: "" }), figureOf({ act: "enter", usd: 297.18, why: "" })], ["$1,000.00", "$447.50 of $1,000.00", "$297.18"]);
expect("a sale shows its result with a sign, in dollars and in percent", [figureOf({ act: "exit", pnl: 61.2, pct: 6.1, why: "" }), figureOf({ act: "exit", pnl: -52.33, pct: -5.2, why: "" }), figureOf({ act: "exit", pnl: -2.81, why: "" }), figureOf({ act: "exit", pnl: 0.001, pct: 0, why: "" })], ["+$61.20 (+6.1%)", "-$52.33 (-5.2%)", "-$2.81", "$0.00 (0.0%)"]);
expect("the others say what it came to", ["skip", "filtered", "order", "pick", "left", "wait", "lock", "start", "stop"].map((act) => figureOf({ act, why: "" })), ["not traded", "not traded", "order waiting", "new coin", "coin let go", "waiting", "profit locked", "started", "stopped"]);
expect("colours: green for a buy, a locked profit and a sale at a profit; red for a sale at a loss; amber for not trading; blue for the rest",
  [toneOf({ act: "enter", why: "" }), toneOf({ act: "lock", why: "" }), toneOf({ act: "exit", pnl: 3, why: "" }), toneOf({ act: "exit", pnl: 0, why: "" }), toneOf({ act: "exit", pnl: -3, why: "" }), toneOf({ act: "skip", why: "" }), toneOf({ act: "filtered", why: "" }), toneOf({ act: "pick", why: "" }), toneOf({ act: "wait", why: "" })],
  ["up", "up", "up", "up", "down", "warn", "warn", "info", "info"]);

// The line above the rows.
expect("the summary counts buys, sales won and lost, their result, and every time a coin was not traded (folded ones each count)", decisionSummary(rows), { bought: 1, sold: 1, won: 1, lost: 0, pnl: 61.2, notTraded: 5 });
expect("...in words", summaryText(rows), "1 bought \u00b7 1 sold (1 at a profit, 0 at a loss): +$61.20 in all \u00b7 5 times not traded");
expect("nothing sold yet", summaryText(decisionRows([line(0, "1", { act: "enter", coin: "AAA", usd: 100, why: "" }), line(1, "1", skip("BBB"))])), "1 bought \u00b7 0 sold \u00b7 1 time not traded");
expect("no decisions at all", [decisionRows([]), summaryText([])], [[], "0 bought \u00b7 0 sold \u00b7 0 times not traded"]);

finish();
