// The pipeline view: the work every agent's trade goes through, shown as six steps that each say
// what they did. SCAN -> CHECK -> AI -> SIZE -> EXEC -> LOG.
//
// It is a view, nothing more: it changes nothing about how the agents trade. Every figure comes
// from what is already kept: the decisions written with the log lines (server/src/botlog.ts,
// Decision), the scouts' latest list, and the account's open trades.
//
// Which step a decision belongs to:
//   scan   an auto-pick agent took a coin from the scouts' list, or found none it could take
//   check  ruled out before the AI was asked (by the scouts, by the numbers, by the cost of
//          trading), or a coin let go for its cost
//   ai     its AI stayed out, or an order did not have the odds; an order waiting at a price
//   size   how much went into a buy (all of what the agent had, or less where trading is dear)
//   exec   bought, sold, minimum profit locked
//   log    every decision, whatever the step
import type { Decision, DecisionAct, LogLine } from "./api";
import { ACT_LABEL } from "./decisions";

export type StepKey = "scan" | "check" | "ai" | "size" | "exec" | "log";
export type Step = {
  key: StepKey;
  short: string; // in the flow line
  name: string;
  role: string; // what the step does
  rule: string; // the one rule it never breaks
  figure: string; // its main number
  caption: string; // what the number is made of
  last: { t: number; text: string } | null; // the newest thing it did
  on: boolean; // it did something in the last few minutes
};
export type PipelineInput = {
  lines: LogLine[]; // the stretch being looked at (any order); lines without a decision are ignored
  now: number;
  scan?: { scanned: number; passing: number; top: string[] } | null; // the scouts' latest list, if it could be read
  open: number; // the agents' open trades right now
  running: number; // agents running right now
};

const ON_MS = 3 * 60_000;
const money = (v: number) => `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (v: number) => `${v > 0.004 ? "+" : v < -0.004 ? "-" : ""}${money(Math.abs(v) < 0.005 ? 0 : v)}`;
const n = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;
const times = (k: number) => (k === 1 ? "once" : `${k.toLocaleString("en-US")} times`);

// Who ruled a coin out, from how the reason begins (the engine writes "the scouts: ...",
// "the numbers: ...", "the cost: ..."; an order dropped for its cost begins "its order is dropped").
export function ruledOutBy(d: Decision): "scouts" | "numbers" | "cost" | "other" {
  const w = d.why ?? "";
  return w.startsWith("the scouts:") ? "scouts" : w.startsWith("the numbers:") ? "numbers" : w.startsWith("the cost:") || w.startsWith("its order is dropped:") ? "cost" : "other";
}

export function pipelineSteps(input: PipelineInput): Step[] {
  const ds = input.lines.filter((l) => l.d && typeof l.d.act === "string").sort((a, b) => b.t - a.t);
  const of = (acts: DecisionAct[]) => ds.filter((l) => acts.includes(l.d!.act));
  const lastOf = (ls: LogLine[]) => (ls.length ? { t: ls[0].t, text: `${ACT_LABEL[ls[0].d!.act]}${ls[0].d!.coin ?? ls[0].sym ? ` ${ls[0].d!.coin ?? ls[0].sym}` : ""}: ${ls[0].d!.why}` } : null);
  const on = (ls: LogLine[]) => ls.length > 0 && input.now - ls[0].t < ON_MS;

  const picks = of(["pick"]), waits = of(["wait"]);
  const out = of(["filtered", "left"]);
  const by = { scouts: 0, numbers: 0, cost: 0, other: 0 };
  for (const l of out) by[ruledOutBy(l.d!)]++;
  const outCoins = new Set(out.map((l) => l.d!.coin ?? l.sym ?? "")).size;
  const skips = of(["skip"]), orders = of(["order"]);
  const buys = of(["enter"]), sells = of(["exit"]), locks = of(["lock"]);
  const cut = buys.filter((l) => typeof l.d!.usd === "number" && typeof l.d!.of === "number" && l.d!.usd! < l.d!.of! - 0.5);
  const won = sells.filter((l) => (l.d!.pnl ?? 0) > 0).length, lost = sells.filter((l) => (l.d!.pnl ?? 0) < 0).length;
  const net = sells.reduce((s, l) => s + (l.d!.pnl ?? 0), 0);
  const scanStep = [...picks, ...waits].sort((a, b) => b.t - a.t), aiStep = [...skips, ...orders].sort((a, b) => b.t - a.t), execStep = [...buys, ...sells, ...locks].sort((a, b) => b.t - a.t);
  const lastBuy = buys[0]?.d;

  return [
    {
      key: "scan", short: "SCAN", name: "Scanner",
      role: "Eight scouts score every busy Solana coin, and auto-pick agents take their coins from that list.",
      rule: "Flags only, never trades.",
      figure: input.scan ? `${input.scan.scanned.toLocaleString("en-US")} scanned` : n(picks.length, "coin chosen", "coins chosen"),
      caption: `${input.scan ? `${input.scan.passing} of the top ${input.scan.top.length} pass every check${input.scan.top.length ? ` · top: ${input.scan.top.slice(0, 3).join(", ")}` : ""} · ` : ""}chose a coin ${times(picks.length)} · found none free ${times(waits.length)}`,
      last: lastOf(scanStep), on: on(scanStep),
    },
    {
      key: "check", short: "CHECK", name: "Quality check",
      role: "Before an agent's AI is asked: who holds the coin, whether it moves enough, and what trading it costs.",
      rule: "Nothing is bought before it passes.",
      figure: `${out.length.toLocaleString("en-US")} ruled out`,
      caption: out.length ? `${n(outCoins, "coin")} · by the scouts ${by.scouts} · by the numbers ${by.numbers} · by the cost ${by.cost}${by.other ? ` · other ${by.other}` : ""}` : "nothing ruled out in this stretch",
      last: lastOf(out), on: on(out),
    },
    {
      key: "ai", short: "AI", name: "AI and odds",
      role: "The agent's AI reads the charts and plans; the order check then judges the odds of each order.",
      rule: "An order is used only if its chance beats what it needs.",
      figure: `${skips.length.toLocaleString("en-US")} stayed out`,
      caption: `${n(buys.length, "order")} approved and bought · ${n(orders.length, "plan")} waiting at a price`,
      last: lastOf(aiStep), on: on(aiStep),
    },
    {
      key: "size", short: "SIZE", name: "Sizer",
      role: "Decides how much goes into a trade.",
      rule: "The agent's budget, never more; less where trading would cost over 2.5%.",
      figure: lastBuy && typeof lastBuy.usd === "number" ? money(lastBuy.usd) : "–",
      caption: buys.length ? `the latest size · ${n(buys.length, "trade")} sized: ${buys.length - cut.length} in full, ${cut.length} cut down for the cost` : "no trade sized in this stretch",
      last: buys.length ? { t: buys[0].t, text: `${lastBuy!.coin ?? ""}: ${typeof lastBuy!.of !== "number" ? money(lastBuy!.usd ?? 0) : (lastBuy!.usd ?? 0) < lastBuy!.of - 0.5 ? `${money(lastBuy!.usd ?? 0)} of the ${money(lastBuy!.of)} it had, cut down for the cost` : `all ${money(lastBuy!.of)} it had`}`.trim() } : null,
      on: on(buys),
    },
    {
      key: "exec", short: "EXEC", name: "Executor",
      role: "Buys, watches every trade every 5 seconds, and sells.",
      rule: "A stop or a profit exit waits about 10 seconds; +5% after costs is locked.",
      figure: `${input.open} open`,
      caption: `bought ${buys.length} · sold ${sells.length}${sells.length ? ` (${won} at a profit, ${lost} at a loss): ${signed(net)}` : ""} · minimum profit locked ${times(locks.length)}`,
      last: lastOf(execStep), on: on(execStep) || input.open > 0,
    },
    {
      key: "log", short: "LOG", name: "Logger",
      role: "Writes down every decision with its reason.",
      rule: "No trade without a reason.",
      figure: n(ds.length, "decision"),
      caption: "kept for 7 days · read them one line each under Agent log",
      last: lastOf(ds), on: on(ds),
    },
  ];
}
