// The Pipeline tab: the work every agent's trade goes through, as six steps that each show what
// they did. SCAN -> CHECK -> AI -> SIZE -> EXEC -> LOG.
//
// A view only: it changes nothing about how the agents trade. Its figures come from the decisions
// kept with the log (pipelineSteps.ts works them out), the scouts' latest list and the open trades.
import { useEffect, useState } from "react";
import { useAgentLog } from "./agentLog";
import { aiText, api, type AppState } from "./api";
import { decisionRows, summaryText } from "./decisions";
import { pipelineSteps } from "./pipelineSteps";

type Scan = { scanned: number; passing: number; top: string[] };

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
  const when = (t: number) => `${t >= midnight ? "" : `${new Date(t).toLocaleDateString([], { weekday: "short" })} `}${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return (
    <div className="pipe">
      <div className="log-bar">
        <div className="pipe-flow" aria-label="The steps every trade goes through, in order">
          {steps.map((s, i) => [
            i ? <i key={`to-${s.key}`} aria-hidden="true">{"→"}</i> : null,
            <span key={s.key} className={`pipe-node s-${s.key} ${s.on ? "on" : ""}`} title={`${s.name}: ${s.role}`}>{s.short}</span>,
          ])}
        </div>
        <div className="log-range" role="group" aria-label="Which days to show">
          <button className={`chip ${range === "today" ? "on" : ""}`} aria-pressed={range === "today"} onClick={() => setRange("today")}>Today</button>
          <button className={`chip ${range === "week" ? "on" : ""}`} aria-pressed={range === "week"} onClick={() => setRange("week")}>Last 7 days</button>
        </div>
        <span className="muted tiny">
          {running ? `${running} agent${running === 1 ? "" : "s"} running` : "no agent running"} {"·"} {summaryText(decisionRows(lines))}
          {more ? " (in what is loaded so far)" : ""}{busy ? " · loading…" : ""}{err ? ` · the earlier lines could not be loaded (${err})` : ""}
        </span>
      </div>
      <div className="pipe-steps">
        {steps.map((s) => (
          <div key={s.key} className={`pipe-step s-${s.key} ${s.on ? "on" : ""}`}>
            <div className="pipe-head">
              <span className="pipe-dot" aria-hidden="true" />
              <b>{s.name}</b>
              <em title={s.on ? "It did something in the last few minutes." : "Nothing in the last few minutes."}>{s.on ? "ACTIVE" : "IDLE"}</em>
            </div>
            <div className="pipe-role">{s.role}</div>
            <div className="pipe-rule">{s.rule}</div>
            <div className="pipe-fig">{s.figure}</div>
            <div className="pipe-cap">{s.caption}</div>
            <div className="pipe-last">
              {s.last ? <><span className="mono muted">{when(s.last.t)}</span> {aiText(s.last.text)}</> : <span className="muted">Nothing in this stretch yet.</span>}
            </div>
          </div>
        ))}
      </div>
      <p className="muted tiny pipe-note">
        Every trade goes through these steps, in this order. This is a view of the work your agents already do: it changes nothing about how they trade.{" "}
        <button className="link-btn" onClick={onOpenLog}>Read each decision in the Agent log</button>
      </p>
    </div>
  );
}
