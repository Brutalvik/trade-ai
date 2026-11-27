// The Pipeline tab: one coin at a time, traced through the six steps every agent trade goes
// through. SCAN -> CHECK -> AI PLAN -> SIZE -> EXECUTE -> LOG. Pick a coin above to trace it.
//
// A view only: it changes nothing about how the agents trade. The traces come from the decisions
// kept with the log (pipelineTrace.ts); the scouts' list gives how many coins were scanned and the
// coins' pictures. It moves with the trading: the step bar lights up to the step the coin reached,
// the step it is at breathes, and when the coin moves on, that step's card flashes. (All still for
// people who ask for less motion.)
import { useEffect, useRef, useState } from "react";
import { useAgentLog } from "./agentLog";
import { aiText, api, fmtPrice, fmtUsd, type AppState } from "./api";
import { coinTraces, type CoinTrace, type TraceKey } from "./pipelineTrace";

type Scan = { scanned: number; icons: Record<string, string> };

const STEP: Record<TraceKey, { bar: string; card: string; idle: string }> = {
  scan: { bar: "Scan", card: "Scanner", idle: "Eight scouts score every busy Solana coin." },
  check: { bar: "Check", card: "Quality check", idle: "Holders, movement and the cost of trading, before any AI." },
  ai: { bar: "AI Plan", card: "AI & odds", idle: "The AI reads the charts; each order must have the odds." },
  size: { bar: "Size", card: "Sizer", idle: "The agent's budget, less where trading costs over 2.5%." },
  exec: { bar: "Execute", card: "Executor", idle: "Buys, watches every 5 seconds, locks +5% after costs." },
  log: { bar: "Log", card: "Logger", idle: "Every decision written down with its reason, for a week." },
};
const KEYS: TraceKey[] = ["scan", "check", "ai", "size", "exec", "log"];

// real = the real auto-pilot's own agent (Real mode), else the paper account's agents.
export function Pipeline({ state, onOpenLog, real = false }: { state: AppState | null; onOpenLog: () => void; real?: boolean }) {
  const [range, setRange] = useState<"today" | "week">("today");
  const { lines, more, busy, err, bots, midnight } = useAgentLog(state, range, true, real);
  const [scan, setScan] = useState<Scan | null>(null);
  useEffect(() => {
    let off = false;
    const load = () => api.agents()
      .then((s) => { if (!off) setScan({ scanned: s.scanned, icons: Object.fromEntries(s.coins.filter((c) => c.icon).map((c) => [c.symbol, c.icon!])) }); })
      .catch(() => { /* the trace goes without it */ });
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      off = true;
      window.clearInterval(id);
    };
  }, []);
  const running = bots.filter((b) => b.bot.running).length;
  const icons: Record<string, string> = { ...(scan?.icons ?? {}) };
  for (const b of bots) if (b.bot.config?.symbol && b.bot.config.imageUrl) icons[b.bot.config.symbol] = b.bot.config.imageUrl;
  const traces = coinTraces(lines, { scanned: scan?.scanned ?? null, money: (v) => fmtUsd(v), price: fmtPrice });
  const [picked, setPicked] = useState<string | null>(null);
  const tr = traces.find((t) => t.coin === picked) ?? traces[0] ?? null;
  const flash = useFlash(tr);
  const when = (t: number) => `${t >= midnight ? "" : `${new Date(t).toLocaleDateString([], { weekday: "short" })} `}${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  const reached = tr?.reached ?? 0;
  return (
    <div className="pf">
      <div className="pf-bar">
        <div className="pf-range" role="group" aria-label="Which days to show">
          <button className={range === "today" ? "on" : ""} aria-pressed={range === "today"} onClick={() => setRange("today")}>Today</button>
          <button className={range === "week" ? "on" : ""} aria-pressed={range === "week"} onClick={() => setRange("week")}>Last 7 days</button>
        </div>
        <span className={`pf-live ${running ? "on" : ""}`} title={err ? `The earlier lines could not be loaded (${err})` : undefined}>
          <i aria-hidden="true" />Auto-Pilot · <b>{running ? "Active Trace" : "Idle"}</b>{busy ? " · loading…" : more ? " · more loading" : ""}
        </span>
      </div>

      <div className="pf-tracebar">
        <span className="pf-tracelabel">Tracing coin:</span>
        <div className="pf-chips" role="listbox" aria-label="Coins to trace">
          {traces.slice(0, 8).map((t) => (
            <button key={t.coin} role="option" aria-selected={t === tr} className={`pf-chip o-${t.outcome} ${t === tr ? "on" : ""}`} onClick={() => setPicked(t.coin)}>
              <CoinIcon src={icons[t.coin]} symbol={t.coin} />
              <b>{t.coin}</b> · <span>{t.chip}</span>
            </button>
          ))}
          {!traces.length && <span className="muted small">No coin in this stretch yet: start an agent, and every coin it looks at shows here.</span>}
        </div>
        {tr && (
          <span className="pf-traceinfo">
            <b>{tr.coin}</b> · Solana{tr.entry?.price ? <> · Entry {fmtPrice(tr.entry.price)}</> : null}{tr.entry?.usd ? <> · Size {fmtUsd(tr.entry.usd)}</> : null}
          </span>
        )}
      </div>

      <div className="pf-steps" aria-label="The steps of this coin's trade">
        {KEYS.map((k, i) => {
          const st = tr?.steps[i];
          const mark = !st || st.state === "todo" ? "" : st.state === "done" ? "✓" : st.state === "stopped" ? "✕" : "…";
          return [
            i ? <span key={`a-${k}`} className={`pf-arrow ${i < reached ? "lit" : ""}`} aria-hidden="true" /> : null,
            <span key={k} className={`pf-stepnode s-${k} st-${st?.state ?? "todo"} ${i + 1 === reached ? "cur" : ""}`}>
              <small>Step {i + 1}</small>
              <b>{STEP[k].bar} {mark && <em className={`m-${st?.state}`}>{mark}</em>}</b>
            </span>,
          ];
        })}
      </div>

      <div className="pf-cards">
        {KEYS.map((k, i) => {
          const st = tr?.steps[i];
          return (
            <div key={k} className={`pf-card s-${k} st-${st?.state ?? "todo"} ${i + 1 === reached && running ? "on" : ""} ${flash === k ? "flash" : ""}`}>
              {k === "ai" && <span className="pf-ai-badge" aria-hidden="true">AI</span>}
              {k === "ai" && <svg className="pf-brain" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1Zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>}
              <div className="pf-name"><span>Step {i + 1} ·</span> {STEP[k].card}</div>
              <span className={`pf-pill p-${st?.state ?? "todo"}`}>{st ? st.pill : "—"}{st?.state === "done" ? " ✓" : st?.state === "stopped" ? " ✕" : ""}</span>
              <div className="pf-what">{st ? st.line : STEP[k].idle}</div>
              <div className="pf-figbox">
                <div className="pf-fig">{st ? st.figure : "—"}</div>
                <div className="pf-cap">{st ? aiText(st.caption) : ""}</div>
              </div>
              <div className="pf-when">{st?.t ? <><span className="mono">{when(st.t)}</span> · {st.event}</> : <span className="muted">{st ? "—" : "Waiting for a coin"}</span>}</div>
            </div>
          );
        })}
      </div>

      <div className="pf-foot">
        <span className="muted tiny">Click any coin above to trace each step the Auto-Pilot AI took, from discovery to execution. A view only: it changes nothing about how the agents trade.</span>
        <button className="link-btn" onClick={onOpenLog}>Inspect full Agent log →</button>
      </div>
    </div>
  );
}

function CoinIcon({ src, symbol }: { src?: string; symbol: string }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? <img className="pf-coin" src={src} alt="" onError={() => setBad(true)} /> : <span className="pf-coin letter" aria-hidden="true">{symbol.slice(0, 1)}</span>;
}

// The step a traced coin has just reached flashes when it gets there (not on the first look, and
// not when another coin is picked).
function useFlash(tr: CoinTrace | null): TraceKey | null {
  const seen = useRef<{ coin: string; t: number } | null>(null);
  const [key, setKey] = useState<TraceKey | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = tr ? { coin: tr.coin, t: tr.lastT } : null;
    if (!tr || !before || before.coin !== tr.coin || tr.lastT <= before.t) return;
    const newest = [...tr.steps].filter((s) => s.t !== null && s.key !== "log").sort((a, b) => (b.t ?? 0) - (a.t ?? 0))[0];
    setKey(newest?.key ?? "log");
    const id = window.setTimeout(() => setKey(null), 1600);
    return () => window.clearTimeout(id);
  }, [tr?.coin, tr?.lastT]); // eslint-disable-line react-hooks/exhaustive-deps
  return key;
}
