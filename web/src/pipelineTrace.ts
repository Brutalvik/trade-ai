// The Pipeline's coin trace: for each coin the agents looked at, how far it got through the six
// steps (SCAN -> CHECK -> AI PLAN -> SIZE -> EXECUTE -> LOG), and what each step did, from the
// decisions kept with the log. A view only: nothing here changes how the agents trade.
//
// A coin's trace is its latest attempt: the decisions about it since an agent last took it from
// the scouts' list (or, for a coin an agent was put on by hand, since its last sale or start).
// The figures are the decision's own (score, costPct, winPct, needPct, price: since v0.80) or,
// for older lines, read from the reason the engine wrote; a figure that is not there shows as "—".
import type { Decision, LogLine } from "./api";

export type TraceKey = "scan" | "check" | "ai" | "size" | "exec" | "log";
export type TraceState = "done" | "stopped" | "waiting" | "todo";
export type TraceStep = {
  key: TraceKey;
  state: TraceState;
  pill: string; // PASSED, RULED OUT, APPROVED, STAYED OUT, WAITING, SIZED, FILLED, SOLD, RECORDED, or "—"
  line: string; // what happened, in a few words
  figure: string;
  caption: string;
  t: number | null;
  event: string; // the footer: what it led to
};
export type Outcome = "executed" | "sold" | "stopped" | "skipped" | "waiting" | "scanned";
export type CoinTrace = {
  coin: string;
  lastT: number;
  outcome: Outcome;
  reached: number; // 1-6: the furthest step it got to
  chip: string; // "Executed (6/6)", "Stopped Step 2", "Skipped Step 3", "Waiting Step 3"
  entry: { price: number | null; usd: number | null } | null;
  steps: TraceStep[];
};

// How amounts are written (the Pipeline passes the app's, which show the person's currency; dollars by default).
let money = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let price = (v: number) => `$${v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : v.toPrecision(4)}`;
const num = (re: RegExp, s: string) => { const m = re.exec(s); return m ? Number(m[1].replace(/,/g, "")) : undefined; };
// The figures of a decision: its own, else what its reason (and line) say.
function figs(d: Decision, msg = "") {
  const w = `${d.why ?? ""} ${msg}`;
  return {
    score: d.score ?? num(/score (\d+)(?: of |\/)100/, w),
    costPct: d.costPct ?? num(/costs?(?: about)? ([\d.]+)%/, w),
    winPct: d.winPct ?? num(/(\d+)% chance/, w),
    needPct: d.needPct ?? num(/needs (\d+)%/, w),
    price: d.price ?? num(/@ \$([\d.,eE+-]+)/, msg) ?? num(/(?:dip to|breakout above) \$([\d.,eE+-]+)/, w),
  };
}
const BY: Record<string, string> = { scouts: "the scouts", numbers: "the numbers", cost: "the cost" };

export function coinTraces(lines: LogLine[], opts: { scanned?: number | null; money?: (usd: number) => string; price?: (usd: number) => string } = {}): CoinTrace[] {
  if (opts.money) money = opts.money;
  if (opts.price) price = opts.price;
  const ds = lines.filter((l) => l.d && typeof l.d.act === "string" && (l.d.coin ?? l.sym)).sort((a, b) => a.t - b.t);
  // Every decision of the stretch, in order: its place is its "entry" number in the log.
  const order = new Map(ds.map((l, i) => [l, i + 1]));
  const byCoin = new Map<string, LogLine[]>();
  for (const l of ds) {
    const c = (l.d!.coin ?? l.sym)!;
    if (!byCoin.has(c)) byCoin.set(c, []);
    byCoin.get(c)!.push(l);
  }
  const out: CoinTrace[] = [];
  for (const [coin, all] of byCoin) {
    // Its latest attempt: from its last pick (or after its last sale, or the start).
    let from = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const a = all[i].d!.act;
      if (a === "pick") { from = i; break; }
      if ((a === "exit" || a === "start") && i < all.length - 1) { from = i + 1; break; }
    }
    const att = all.slice(from).filter((l) => !["start", "stop", "left", "wait"].includes(l.d!.act));
    if (!att.length) continue;
    const find = (acts: string[]) => att.filter((l) => acts.includes(l.d!.act)).at(-1);
    const pick = find(["pick"]), ruled = find(["filtered"]), ai = find(["skip", "order"]), buy = find(["enter"]), sold = find(["exit"]), lock = find(["lock"]);
    const last = att.at(-1)!;
    const steps: TraceStep[] = [];
    const todo = (key: TraceKey): TraceStep => ({ key, state: "todo", pill: "—", line: "Not reached", figure: "—", caption: "", t: null, event: "" });
    const stopPast = (key: TraceKey, why: string): TraceStep => ({ ...todo(key), line: why });

    // 1 SCAN
    const pf = pick ? figs(pick.d!, pick.msg) : null;
    steps.push(pick
      ? { key: "scan", state: "done", pill: "PASSED", line: `Found ${coin}${opts.scanned ? ` across ${opts.scanned} coins` : " on the scouts' list"}`, figure: pf?.score !== undefined ? `${pf.score} / 100` : "Picked", caption: `Scouts' score${pf?.costPct !== undefined ? ` · ${pf.costPct}% cost` : ""}`, t: pick.t, event: "Sent to check" }
      : { key: "scan", state: "done", pill: "PASSED", line: `${coin} chosen for its agent`, figure: "Chosen", caption: "The agent was put on this coin", t: att[0].t, event: "Sent to check" });
    // 2 CHECK
    if (ruled && (!buy || ruled.t > buy.t) && (!ai || ruled.t > ai.t)) {
      const rf = figs(ruled.d!, ruled.msg);
      steps.push({ key: "check", state: "stopped", pill: "RULED OUT", line: `Ruled out by ${BY[ruled.d!.by ?? ""] ?? "a check"}`, figure: ruled.d!.by === "cost" && rf.costPct !== undefined ? `${rf.costPct}% cost` : "Stopped", caption: ruled.d!.why, t: ruled.t, event: "Not traded" });
    } else {
      const cost = buy ? figs(buy.d!, buy.msg).costPct : pf?.costPct;
      const reached = !!(ai || buy);
      steps.push(reached
        ? { key: "check", state: "done", pill: "PASSED", line: "Holders, movement & cost checked", figure: "3 / 3 Clear", caption: `Scouts · numbers · cost${cost !== undefined ? ` (${cost}%)` : ""}`, t: (ai ?? buy)!.t, event: "Cleared for AI" }
        : { ...todo("check"), state: "waiting", pill: "CHECKING", line: "Being checked", t: last.t });
    }
    const stoppedAtCheck = steps[1].state === "stopped";
    // 3 AI PLAN
    if (stoppedAtCheck) steps.push(stopPast("ai", "Not asked: ruled out first"));
    else if (buy) {
      const bf = figs(buy.d!, buy.msg);
      steps.push({ key: "ai", state: "done", pill: "APPROVED", line: "AI read the chart & the odds", figure: bf.winPct !== undefined ? `${bf.winPct}% Win Odds` : "Approved", caption: bf.needPct !== undefined ? `needed ${bf.needPct}%${bf.price ? ` · @ ${price(bf.price)}` : ""}` : "Its order had the odds", t: buy.t, event: "Plan approved" });
    } else if (ai) {
      const af = figs(ai.d!, ai.msg);
      const waiting = ai.d!.act === "order";
      steps.push({ key: "ai", state: waiting ? "waiting" : "stopped", pill: waiting ? "WAITING" : "STAYED OUT", line: waiting ? `Waits for ${af.price ? price(af.price) : "its price"}` : "AI stayed out", figure: af.winPct !== undefined ? `${af.winPct}% Win Odds` : waiting ? "Order set" : "No bet", caption: af.needPct !== undefined ? `needs ${af.needPct}%` : ai.d!.why, t: ai.t, event: waiting ? "Order waiting" : "Not traded" });
    } else steps.push({ ...todo("ai"), state: "waiting", pill: "ASKING", line: "The AI is asked next" });
    // 4 SIZE, 5 EXECUTE
    if (buy) {
      const bf = figs(buy.d!, buy.msg);
      const usd = buy.d!.usd ?? null, of = buy.d!.of ?? null;
      steps.push({ key: "size", state: "done", pill: "SIZED", line: "Agent budget & cost cap", figure: usd !== null ? money(usd) : "Sized", caption: usd !== null && of !== null && usd < of - 0.01 ? `trimmed from ${money(of)} (cost over 2.5%)` : "its full budget (under the 2.5% cost cap)", t: buy.t, event: "Size set" });
      const ex = sold && sold.t >= buy.t ? sold : null;
      if (ex) {
        const xf = figs(ex.d!, ex.msg), pnl = ex.d!.pnl ?? 0;
        steps.push({ key: "exec", state: "done", pill: "SOLD", line: "Bought, watched, sold", figure: `${pnl >= 0 ? "+" : "-"}${money(Math.abs(pnl))}`, caption: `${ex.d!.pct !== undefined ? `${ex.d!.pct >= 0 ? "+" : ""}${ex.d!.pct}% · ` : ""}${xf.price ? `sold @ ${price(xf.price)}` : ex.d!.why}`, t: ex.t, event: "Trade closed" });
      } else {
        steps.push({ key: "exec", state: "done", pill: "FILLED", line: "Bought & armed the 5 s watch", figure: bf.price ? price(bf.price) : "Filled", caption: lock && lock.t > buy.t ? "+5% minimum locked · AI manages the exit" : "10 s stop guard · +5% lock armed", t: buy.t, event: lock && lock.t > buy.t ? "Profit locked" : "Order filled" });
      }
    } else {
      const why = stoppedAtCheck ? "Not reached: ruled out" : steps[2].state === "stopped" ? "Not reached: the AI stayed out" : "Waits for the plan";
      steps.push(stopPast("size", why), stopPast("exec", why));
    }
    // 6 LOG: every decision is written down, whatever happened
    steps.push({ key: "log", state: "done", pill: "RECORDED", line: "Every decision saved with its reason", figure: `Entry #${String(order.get(last) ?? 0).padStart(2, "0")}`, caption: "Kept 7 days in the Agent log", t: last.t, event: "Linked to log" });

    const outcome: Outcome = sold && buy && sold.t >= buy.t ? "sold" : buy ? "executed" : stoppedAtCheck ? "stopped" : ai?.d!.act === "skip" ? "skipped" : ai?.d!.act === "order" ? "waiting" : "scanned";
    const reached = buy ? 6 : stoppedAtCheck ? 2 : ai ? 3 : 1;
    const chip = outcome === "executed" ? "Executed (6/6)" : outcome === "sold" ? "Sold (6/6)" : outcome === "stopped" ? "Stopped Step 2" : outcome === "skipped" ? "Skipped Step 3" : outcome === "waiting" ? "Waiting Step 3" : "Scanned (1/6)";
    out.push({ coin, lastT: last.t, outcome, reached, chip, entry: buy ? { price: figs(buy.d!, buy.msg).price ?? null, usd: buy.d!.usd ?? null } : null, steps });
  }
  return out.sort((a, b) => b.lastT - a.lastT);
}
