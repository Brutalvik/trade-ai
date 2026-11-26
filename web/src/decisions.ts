// The one-line view of the agents' log ("Decisions"): only the lines that decided something, one
// short line each: when, what (bought, sold, stayed out...), which coin, the size or the result,
// and the reason. Made to be read in the morning. "Everything" is the full log, as before.
//
// What a line decided is written with it on the server, where the decision is made
// (server/src/botlog.ts, Decision): nothing here reads a decision out of a sentence.
import type { Decision, DecisionAct, LogLine } from "./api";

// In the app's own words (the log says BUY and SELL; these are the same things, past tense).
export const ACT_LABEL: Record<DecisionAct, string> = {
  enter: "BOUGHT", exit: "SOLD", skip: "STAYED OUT", filtered: "RULED OUT", order: "WAITING",
  pick: "CHOSE", left: "LEFT", wait: "NO COIN", lock: "LOCKED", start: "STARTED", stop: "STOPPED",
};
// What each one means, for the tag's tooltip.
export const ACT_HINT: Record<DecisionAct, string> = {
  enter: "It bought.",
  exit: "It sold. The figure is the trade's result after all costs.",
  skip: "Its AI was asked and did not buy: it saw no bet worth taking, or its order did not have the odds.",
  filtered: "Ruled out before its AI was asked, at no AI cost: by the scouts, by the numbers, or because trading the coin costs too much.",
  order: "It has an order waiting at a price.",
  pick: "An auto-pick agent took this coin.",
  left: "An auto-pick agent let this coin go.",
  wait: "An auto-pick agent has no coin it can take. Waiting costs no AI tokens.",
  lock: "The trade reached its minimum profit, which is now locked as its exit.",
  start: "The agent was started.",
  stop: "The agent stopped.",
};

// One row of the view. n > 1: the same agent decided the same thing about the same coin n times
// in a row (it looks again every five minutes); `from` is the time of the first, `t` of the last,
// and the reason shown is the latest one.
export type DecisionRow = { key: string; t: number; from: number; n: number; bot: string; coin: string; d: Decision };

const REPEATS = new Set<DecisionAct>(["skip", "filtered", "order", "wait"]);

// lines: any order. Rows: newest first.
export function decisionRows(lines: LogLine[]): DecisionRow[] {
  const rows: DecisionRow[] = [];
  const last = new Map<string, DecisionRow>(); // per agent: the row its previous (newer) decision is in
  for (const l of [...lines].filter((x) => x.d && typeof x.d.act === "string").sort((a, b) => b.t - a.t)) {
    const d = l.d!;
    const coin = d.coin ?? l.sym ?? "";
    const prev = last.get(l.bot);
    if (prev && REPEATS.has(d.act) && prev.d.act === d.act && prev.coin === coin) {
      prev.n++;
      prev.from = l.t;
      continue;
    }
    const row: DecisionRow = { key: `${l.t}|${l.bot}|${d.act}|${coin}`, t: l.t, from: l.t, n: 1, bot: l.bot, coin, d };
    rows.push(row);
    last.set(l.bot, row);
  }
  return rows;
}

const money = (v: number) => `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (v: number) => `${v > 0.004 ? "+" : v < -0.004 ? "-" : ""}${money(Math.abs(v) < 0.005 ? 0 : v)}`;

// The figure at the right of a row: the size of a buy, the result of a sale, or what it came to.
export function figureOf(d: Decision): string {
  if (d.act === "enter") return typeof d.usd === "number" ? `${money(d.usd)}${typeof d.of === "number" && d.usd < d.of - 0.5 ? ` of ${money(d.of)}` : ""}` : "bought";
  if (d.act === "exit") return typeof d.pnl === "number" ? `${signed(d.pnl)}${typeof d.pct === "number" ? ` (${d.pct > 0 ? "+" : ""}${d.pct.toFixed(1)}%)` : ""}` : "sold";
  return { skip: "not traded", filtered: "not traded", order: "order waiting", pick: "new coin", left: "coin let go", wait: "waiting", lock: "profit locked", start: "started", stop: "stopped" }[d.act];
}

// The row's colour: green for a buy, a locked profit and a sale at a profit, red for a sale at a
// loss, amber for "did not trade", blue for the rest.
export function toneOf(d: Decision): "up" | "down" | "warn" | "info" {
  if (d.act === "exit") return (d.pnl ?? 0) >= 0 ? "up" : "down";
  if (d.act === "enter" || d.act === "lock") return "up";
  if (d.act === "skip" || d.act === "filtered" || d.act === "left" || d.act === "stop") return "warn";
  return "info";
}

// The line above the rows: what the rows add up to.
export function decisionSummary(rows: DecisionRow[]) {
  const exits = rows.filter((r) => r.d.act === "exit");
  return {
    bought: rows.filter((r) => r.d.act === "enter").length,
    sold: exits.length,
    won: exits.filter((r) => (r.d.pnl ?? 0) > 0).length,
    lost: exits.filter((r) => (r.d.pnl ?? 0) < 0).length,
    pnl: Math.round(exits.reduce((s, r) => s + (r.d.pnl ?? 0), 0) * 100) / 100,
    notTraded: rows.filter((r) => r.d.act === "skip" || r.d.act === "filtered").reduce((s, r) => s + r.n, 0),
  };
}
export function summaryText(rows: DecisionRow[]): string {
  const s = decisionSummary(rows);
  const parts = [
    `${s.bought} bought`,
    s.sold ? `${s.sold} sold (${s.won} at a profit, ${s.lost} at a loss): ${signed(s.pnl)} in all` : "0 sold",
    `${s.notTraded} time${s.notTraded === 1 ? "" : "s"} not traded`,
  ];
  return parts.join(" · ");
}
