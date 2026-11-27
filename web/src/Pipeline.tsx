// The Pipeline tab: the work every agent's trade goes through, as six stages that each show what
// they did. SCAN -> CHECK -> AI ODDS -> SIZE -> EXEC -> LOG.
//
// A view only: it changes nothing about how the agents trade. Its figures come from the decisions
// kept with the log (pipelineSteps.ts works them out), the scouts' latest list and the open trades.
// It moves with the trading: light runs along the stage strip as far as the stage that last acted,
// a stage that is working breathes, a stage that has just done something flashes and shows its
// new event, and its figure counts to the new value. (All still for people who ask for less motion.)
import { useEffect, useRef, useState } from "react";
import { useAgentLog } from "./agentLog";
import { aiText, api, type AppState } from "./api";
import { decisionRows, decisionSummary } from "./decisions";
import { pipelineSteps, type Step, type StepKey } from "./pipelineSteps";

type Scan = { scanned: number; passing: number; top: string[] };

// How each stage is titled on its card and on the strip, with a line on what it does (the full
// role and the rule it never breaks are in the title's tooltip).
const LOOK: Record<StepKey, { title: string; strip: string; line: string }> = {
  scan: { title: "Scanner", strip: "Scan", line: "8 scouts scoring the busy Solana coins" },
  check: { title: "Quality check", strip: "Check", line: "Holders, movement & cost gate" },
  ai: { title: "AI & odds", strip: "AI odds", line: "AI chart planner & odds check" },
  size: { title: "Sizer", strip: "Size", line: "Agent budget · cost cap 2.5%" },
  exec: { title: "Executor", strip: "Exec", line: "5 s monitor · +5% net profit lock" },
  log: { title: "Logger", strip: "Log", line: "Every decision kept a week" },
};

export function Pipeline({ state, onOpenLog }: { state: AppState | null; onOpenLog: () => void }) {
  const [range, setRange] = useState<"today" | "week">("today");
  const { lines, more, busy, err, bots, midnight } = useAgentLog(state, range, true);
  // The scouts' list (market data, the same for everyone): read when the tab opens and once a
  // minute while it is open. Without it the Scanner says what it can from the log.
  const [scan, setScan] = useState<Scan | null>(null);
  useEffect(() => {
    let off = false;
    const load = () => api.agents()
      .then((s) => { if (!off) setScan({ scanned: s.scanned, passing: s.coins.filter((c) => !c.vetoes.length && c.total >= s.pass).length, top: s.coins.map((c) => c.symbol) }); })
      .catch(() => { /* the Scanner's card goes without it */ });
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      off = true;
      window.clearInterval(id);
    };
  }, []);
  const running = bots.filter((b) => b.bot.running).length;
  const open = (state?.positions ?? []).filter((p) => p.source === "bot").length;
  const steps = pipelineSteps({ lines, now: Date.now(), scan, open, running });
  const s = decisionSummary(decisionRows(lines));
  // How far the light runs along the strip: to the furthest stage that is working now.
  const reach = steps.reduce((r, st, i) => (st.on ? i : r), -1);
  const flashes = useFlashes(steps);
  const when = (t: number) => `${t >= midnight ? "" : `${new Date(t).toLocaleDateString([], { weekday: "short" })} `}${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return (
    <div className="pf">
      <div className="pf-bar">
        <div className="pf-range" role="group" aria-label="Which days to show">
          <button className={range === "today" ? "on" : ""} aria-pressed={range === "today"} onClick={() => setRange("today")}>Today</button>
          <button className={range === "week" ? "on" : ""} aria-pressed={range === "week"} onClick={() => setRange("week")}>Last 7 days</button>
        </div>
        <span className="pf-sum" title={err ? `The earlier lines could not be loaded (${err})` : undefined}>
          Auto-Pilot · <b className={running ? "up" : "pf-idle"}>{running ? `${running} running` : "Idle"}</b> · {s.bought} Bought · {s.sold} Sold · {s.notTraded} Skipped
          {more ? " (so far)" : ""}{busy ? " · loading…" : ""}
        </span>
      </div>

      <div className={`pf-strip ${reach >= 0 ? "live" : ""}`} aria-label="The stages every trade goes through, in order">
        {steps.map((st, i) => [
          i ? <span key={`to-${st.key}`} className={`pf-link ${i <= reach ? "flow" : ""}`} aria-hidden="true"><i>{"→"}</i></span> : null,
          <span key={st.key} className={`pf-node s-${st.key} ${st.on ? "on" : ""} ${flashes.has(st.key) ? "flash" : ""}`} title={`${LOOK[st.key].title}: ${st.role}`}>
            <em>{String(i + 1).padStart(2, "0")}</em> {LOOK[st.key].strip}
          </span>,
        ])}
      </div>

      <div className="pf-cards">
        {steps.map((st, i) => <StageCard key={st.key} st={st} n={i + 1} flash={flashes.has(st.key)} when={when} />)}
      </div>

      <div className="pf-foot">
        <span className="muted tiny">Six stages every agent trade goes through, live from your agents' decisions. A view only: it changes nothing about how they trade.</span>
        <button className="link-btn" onClick={onOpenLog}>Read full decisions in Agent log →</button>
      </div>
    </div>
  );
}

function StageCard({ st, n, flash, when }: { st: Step; n: number; flash: boolean; when: (t: number) => string }) {
  const look = LOOK[st.key];
  return (
    <div className={`pf-card s-${st.key} ${st.on ? "on" : ""} ${flash ? "flash" : ""}`}>
      {st.key === "ai" && <span className="pf-ai-badge" aria-hidden="true">AI</span>}
      <div className="pf-top">
        <span className="pf-n">{String(n).padStart(2, "0")}</span>
        <span className="pf-state" title={st.on ? "It did something in the last few minutes." : "Nothing in the last few minutes."}>{st.on && <i aria-hidden="true" />}{st.on ? "ACTIVE" : "IDLE"}</span>
      </div>
      <div className="pf-title" title={`${st.role} ${st.rule}`}>
        {look.title}
        {st.key === "ai" && <svg className="pf-spark" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" /></svg>}
      </div>
      <div className="pf-line">{look.line}</div>
      <div className="pf-fig"><CountUp text={st.figure} /></div>
      <div className="pf-cap">{st.caption}</div>
      <div className="pf-event" key={st.last?.t ?? 0}>
        <b>Latest event</b>
        <div>{st.last ? <><span className="mono">{when(st.last.t)}</span> · {aiText(st.last.text)}</> : <span className="muted">Nothing in this stretch yet.</span>}</div>
      </div>
    </div>
  );
}

// The stages whose newest event changed since the last look: they flash for a moment.
function useFlashes(steps: Step[]): Set<StepKey> {
  const seen = useRef<Map<StepKey, number> | null>(null);
  const [on, setOn] = useState<Set<StepKey>>(new Set());
  const sig = steps.map((s) => `${s.key}:${s.last?.t ?? 0}`).join("|");
  useEffect(() => {
    const now = new Map(steps.map((s) => [s.key, s.last?.t ?? 0]));
    const before = seen.current;
    seen.current = now;
    if (!before) return; // (the first look shows what is there, without flashing)
    const changed = steps.filter((s) => (s.last?.t ?? 0) > (before.get(s.key) ?? 0)).map((s) => s.key);
    if (!changed.length) return;
    setOn(new Set(changed));
    const id = window.setTimeout(() => setOn(new Set()), 1600);
    return () => window.clearTimeout(id);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return on;
}

// A figure like "231 scanned" or "$9,870.67" counts from its old value to the new one.
function CountUp({ text }: { text: string }) {
  const m = /^([^0-9-]*)(-?[\d,]+(?:\.\d+)?)([\s\S]*)$/.exec(text);
  const target = m ? Number(m[2].replace(/,/g, "")) : NaN;
  const decimals = m && m[2].includes(".") ? m[2].split(".")[1].length : 0;
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const start = from.current;
    from.current = target;
    if (!Number.isFinite(start) || start === target || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return void setShown(target);
    const t0 = performance.now(), ms = 700;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), ease = 1 - (1 - k) ** 3;
      setShown(start + (target - start) * ease);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  if (!m || !Number.isFinite(target)) return <>{text}</>;
  const num = (Number.isFinite(shown) ? shown : target).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return <>{m[1]}{num}{m[3]}</>;
}
