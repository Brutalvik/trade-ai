// Agents: each agent trades ONE coin with its own budget, and its AI decides. On start it asks the
// AI at once (every timeframe, chart patterns, a study of the coin's history, the scouts' reading,
// your trade journal): buy now, buy at a level, or stay out. The budget is its only limit.
// This panel lists your agents; "+ New Agent" opens a window with the top opportunities (scored
// by the eight scouts) and the coin search.
import { useEffect, useState } from "react";
import { Modal, useAccess } from "./Account";
import { CoinSearch } from "./CoinSearch";
import { findCoinPair } from "./CoinList";
import { MaCrossChips } from "./MaCross";
import { allBots, api, fmtPrice, fmtUsd, type AgentCoin, type AppState, type BotConfig, type BotSlot, type CheckedOrder, type FcKey, type OrderPrediction, type PairInfo } from "./api";

const DEFAULT_BUDGET = 1000;
type Notify = (m: string, bad?: boolean) => void;
// The settings an agent starts with (the Balanced preset's safety limits; its own entry/exit rules).
type Defaults = Pick<BotConfig, "positionPct" | "minConfidence" | "analyzeEverySec" | "maxDrawdownPct" | "breakEvenAtPct" | "trailPct" | "cooldownMin" | "dailyLossPct" | "maxDrop1hPct" | "riskPerTradePct" | "lockPct">;

const modeName = (c: BotConfig | null) => (c?.pick === "agent" ? "Agent" : c?.pick === "auto" ? "Auto-pick bot" : c?.pick === "newcoins" ? "New coins bot" : c?.pick === "agents" ? "Scout bot" : "AI-plan bot");

// The coin's picture, or its first letter when there is none (or the picture won't load).
function Avatar({ src, symbol }: { src?: string; symbol: string }) {
  const [bad, setBad] = useState("");
  return src && bad !== src ? <img src={src} alt="" onError={() => setBad(src)} /> : <>{symbol.slice(0, 1).toUpperCase()}</>;
}

// A request from elsewhere in the app (the chart's "Start agent on X" button).
export type AgentRequest = { kind: "start"; pair: PairInfo } | { kind: "open"; pool: string };

export function AgentsPanel({ state, limit, notify, refresh, onOpen, defaults, request, onRequestDone }: { state: AppState | null; limit: number; notify: Notify; refresh: () => void; onOpen: (chain: string, pool: string) => void; defaults: Defaults; request?: AgentRequest | null; onRequestDone?: () => void }) {
  const access = useAccess();
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState<PairInfo | null>(null); // a coin chosen on the chart: only the budget is asked
  const [openId, setOpenId] = useState<string | null>(null); // the agent whose window is open
  const slots = allBots(state);
  const running = slots.filter((b) => b.bot.running);
  const ids = Array.from({ length: Math.max(limit, 1) }, (_, i) => String(i + 1));
  const busy = (id: string) => slots.find((b) => b.id === id)?.bot.running || state?.positions.some((p) => p.source === "bot" && (p.botId ?? "1") === id);
  const freeId = ids.find((id) => !busy(id));
  const canAdd = limit > 0 && !!freeId;
  const opened = running.find((b) => b.id === openId);
  const full = limit > 0 && !canAdd;
  const fullMsg = `All ${limit} agent${limit > 1 ? "s are" : " is"} running. Stop one first${limit < 10 ? ", or see Plans for more" : ""}.`;
  useEffect(() => {
    if (!request) return;
    if (request.kind === "open") {
      const b = running.find((x) => (x.bot.config?.pool ?? x.bot.target?.pool) === request.pool);
      if (b) setOpenId(b.id);
    } else if (limit <= 0) access.openPlans();
    else if (!canAdd) notify(fullMsg, true);
    else {
      setPreset(request.pair);
      setAdding(true);
    }
    onRequestDone?.();
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="panel agents-panel">
      <div className="panel-title">
        <span className="agents-head">
          <span>AGENTS</span>
          <span className="agents-count">{running.length}/{Math.max(limit, 0)}</span>
          {(state?.locked ?? 0) > 0.005 ? (
            <span className="agents-money">
              {fmtUsd(state!.locked!)}
              <span className="agents-lock" tabIndex={0} role="img" aria-label="The budgets set aside for your agents" data-tip="The budgets set aside for your agents">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
              </span>
            </span>
          ) : null}
        </span>
        {full ? null : (
          <button className="btn buy agents-new" onClick={() => { if (limit <= 0) return access.openPlans(); setPreset(null); setAdding(true); }}>
            + New Agent
          </button>
        )}
      </div>
      {running.length ? (
        <div className="agent-list">
          {running.map((b) => <AgentCard key={b.id} slot={b} state={state} notify={notify} refresh={refresh} onOpen={onOpen} onDetails={() => setOpenId(b.id)} />)}
        </div>
      ) : (
        <p className="muted small agents-empty">
          {limit <= 0
            ? "Agents trade one coin each, on their own. They're included from the AI Starter plan."
            : "No agents yet. An agent trades one coin with the money you give it. Its AI decides when to buy and sell, starting the moment you create it."}
        </p>
      )}
      {adding && freeId && <NewAgentModal slotId={freeId} preset={preset} state={state} defaults={defaults} notify={notify} onClose={() => setAdding(false)} onStarted={() => { setAdding(false); refresh(); }} takenPools={running.map((b) => b.bot.config?.pool ?? "")} />}
      {opened && <AgentModal slot={opened} state={state} notify={notify} refresh={refresh} onOpen={onOpen} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// Everything the card and the window show about one agent.
function useAgent(slot: BotSlot, state: AppState | null) {
  const { bot, id } = slot;
  const cfg = bot.config;
  const isAgent = cfg?.pick === "agent";
  const pos = state?.positions.find((p) => p.source === "bot" && (p.botId ?? "1") === id);
  const since = bot.startedAt ?? 0;
  const trades = (state?.trades ?? []).filter((t) => t.source === "bot" && (t.botId ?? "1") === id && t.time >= since);
  const sells = trades.filter((t) => t.side === "SELL");
  const realized = sells.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const pnl = realized + (pos ? pos.qty * pos.lastPrice - pos.costUsd : 0);
  const budget = cfg?.budgetUsd ?? DEFAULT_BUDGET;
  const L = bot.learned;
  const roams = cfg?.pick === "auto" || cfg?.pick === "agents";
  const chain = pos?.chain ?? (roams ? bot.target?.chain : cfg?.chain);
  const pool = pos?.pool ?? (roams ? bot.target?.pool : cfg?.pool);
  const symbol = pos?.symbol ?? (roams ? bot.target?.symbol ?? "Scanning" : cfg?.symbol) ?? "?";
  // The AI's latest plan for this agent's coin.
  const plan = slot.lastSignal && slot.lastSignal.pool === (cfg?.pool ?? pool) ? slot.lastSignal : slot.lastSignal;
  const c = plan?.consensus;
  // The order it will act on; if none passed, the one that came closest to passing.
  const gap = (o: CheckedOrder) => (o.prediction ? o.prediction.needPct - o.prediction.pWin : 0);
  const order = c?.orders.find((o) => !o.warning) ?? [...(c?.orders ?? [])].sort((x, y) => gap(x) - gap(y))[0];
  const refused = !!order?.warning;
  const watching = refused && !!c?.orders.some((o) => o.kind !== "buy_now"); // it named a dip or breakout level: reaching it makes it look again
  // A "real move" that makes it look again early: 4%, or one of the coin's usual 5-minute swings if that is bigger.
  const moveAt = Math.ceil(Math.max(4, plan?.atrPct ?? 0));
  const okRes = plan?.results.find((r) => r.ok);
  const reasoning = okRes && okRes.ok ? okRes.signal.reasoning : "";
  const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Agents ask the AI again at least every 5 minutes (and at once when the price reaches a level
  // it named, on a real move, or when the plan runs out).
  const nextLook = c ? Math.min(c.expiresAt, (bot.lastAnalysisAt || Date.now()) + (isAgent ? 300 : (cfg?.analyzeEverySec ?? 1800)) * 1000) : 0;
  // Where it is in its loop: 0 the AI is deciding, 1 waiting for its level, 2 in a trade.
  const stage = pos ? 2 : !c ? 0 : 1;
  const paused = !pos && !!bot.blocked;
  // In a trade: profit after fees now, at its best, and at the exit in force.
  // An agent's trade carries its own cost (measured for its size in its pool); before a trade, the cost its plan was judged with.
  const cost = pos?.costPct ?? plan?.cost?.pct ?? state?.roundTripCostPct ?? 3;
  const tradeCost = plan?.cost;
  const netAt = (p: number) => (pos ? ((p - pos.entryPrice) / pos.entryPrice) * 100 - cost : 0);
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const pm = pos?.pm;
  // An agent's order is judged on the combined chance (its AI, the numbers, the forecaster panel).
  // (with one decimal when the two are within a point, so a near miss never reads "41%, needs 41%")
  const chance = (o: CheckedOrder) => {
    const p = o.prediction;
    if (!p) return `${o.winChancePct}% win chance`;
    const close = Math.abs(p.needPct - p.pWin) < 1;
    return `${close ? p.pWin.toFixed(1) : Math.round(p.pWin)}% chance of reaching +5%, needs ${close ? p.needPct.toFixed(1) : Math.ceil(p.needPct)}%`;
  };
  const status = pos
    ? pm
      ? `In profit: ${pct(netAt(pos.lastPrice))} after fees now (best ${pct(netAt(pos.best ?? pos.lastPrice))}). ${pm.by === "ai" ? "The AI is holding for more" : pm.fails ? "The AI can't be reached, so a fixed rule is holding" : "The minimum is locked; asking the AI"}: it sells at ${fmtPrice(pos.stopLoss ?? pm.floor)} (${pct(netAt(pos.stopLoss ?? pm.floor))})${pm.target ? `, expects ${fmtPrice(pm.target)}` : ""}.`
      : `In a trade since ${at(pos.openedAt)}: bought at ${fmtPrice(pos.entryPrice)}, now ${pct(netAt(pos.lastPrice))} after fees. Stop ${pos.stopLoss ? fmtPrice(pos.stopLoss) : "–"}; at ${fmtPrice(pos.entryPrice * (1 + (cost + 5) / 100))} the +5% minimum locks and the AI takes over the exit.`
    : bot.blocked
      ? `Paused: ${bot.blocked}`
      : plan?.gate
        ? `${plan.gate.kind === "scouts" ? `Standing aside: the scouts ruled ${symbol} out (${plan.gate.reasons.join("; ")})` : `Standing aside: the numbers rule out a buy right now (${plan.gate.reasons.join("; ")})`}. Its AI was not asked, so no AI tokens were spent. It checks again by ${at(nextLook)}${plan.gate.kind === "numbers" ? ", or at once on a real move" : ""}.`
      : !c
        ? "The AI is reading the charts and deciding…"
        : c.stance === "AVOID" || !order
          ? `${order?.prediction && order.warning ? "No buy order right now: no setup had good enough odds" : "The AI sees no bet worth taking right now"}${order ? ` (closest: ${order.kind === "buy_breakout" ? "a breakout above" : order.kind === "buy_dip" ? "a dip to" : "buying now at"} ${fmtPrice(order.triggerPrice)}, ${chance(order)})` : ""}. There is no order at that ${order?.kind === "buy_now" ? "price" : "level"}. It looks again by ${at(nextLook)}, or at once if the price ${watching ? "reaches a level it named or " : ""}moves about ${moveAt}%.`
          : order.kind === "buy_now"
            ? `The AI says buy now (up to ${fmtPrice(order.triggerPrice)}): ${chance(order)}`
            : `The AI will buy ${order.kind === "buy_breakout" ? "a breakout above" : "a dip to"} ${fmtPrice(order.triggerPrice)}${order.kind === "buy_breakout" && order.minVolumeRatio > 0 ? `, but only on at least ${order.minVolumeRatio}× the usual trading volume` : ""}: ${chance(order)}`;
  const said = okRes && okRes.ok ? okRes.signal.stance : undefined; // what the AI itself answered, before the check on its odds
  const image = pos?.imageUrl ?? cfg?.imageUrl; // the coin's picture: from its open trade, else kept with the agent
  return { bot, id, cfg, isAgent, pos, trades, sells, realized, pnl, budget, L, chain, pool, symbol, stage, paused, status, plan: c, order, refused, watching, said, moveAt, image, reasoning, nextLook, pm, netAt, pct, desk: plan?.desk, maCross: plan?.maCross, planAt: plan?.at, cost, tradeCost, gate: plan?.gate, gateOff: !!cfg?.disabled?.includes("qualityGate") };
}

// The agent stood aside without asking its AI: the reasons, and (for the scouts) a recorded "trade it anyway".
function GateBox({ a, notify, refresh }: { a: ReturnType<typeof useAgent>; notify: Notify; refresh: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const g = a.gate!;
  const warning = `The scouts ruled ${a.symbol} out: ${g.reasons.join("; ")}. The scouts treat these as deal-breakers. If you go on, the agent's AI is asked about this coin every time, whatever the scouts say, until you turn the gate back on.`;
  const go = async () => {
    setBusy(true);
    try {
      await api.consentOff({ setting: "qualityGate", label: `Coin quality gate (${a.symbol})`, warning, botId: a.id });
      await api.botQualityGate(false, a.id);
      notify(`The AI will be asked about ${a.symbol} now`);
      refresh();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  return (
    <>
      <div className="label-sm">{g.kind === "scouts" ? "Why it is standing aside: the scouts" : "Why it is standing aside: the numbers"}</div>
      <div className="agent-learned gate-box">
        {g.kind === "scouts" ? (
          <>
            <b>The scouts ruled this coin out before the AI was asked.</b> No AI tokens were spent.
            <ul>{g.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            {g.quality !== undefined ? <span className="muted">Quality score {g.quality} of 100 (this agent asks for {g.min ?? 45}). It is checked again every 5 minutes; a coin's holders and liquidity do change.</span> : null}
            {asking ? (
              <div className="gate-confirm">
                <span>{warning}</span>
                <div>
                  <button className="btn sell" disabled={busy} onClick={() => void go()}>{busy ? "Switching…" : "I understand, ask the AI"}</button>
                  <button className="btn" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div><button className="link-btn" onClick={() => setAsking(true)}>Trade it anyway…</button></div>
            )}
          </>
        ) : (
          <>{a.plan?.note}</>
        )}
      </div>
    </>
  );
}

// The prediction behind an agent's order: every forecaster's chance that the price reaches the
// minimum profit before the stop, the combined chance it was judged on, what the numbers alone
// say about buying now, and the scoreboard of past forecasts against what really happened.
const FC_NAME: Record<FcKey, string> = { ai: "The agent's AI", panel: "AI forecaster panel", worlds: "Simulated paths", lookalikes: "Look-alike moments", baseRate: "This coin lately", combined: "Combined" };
function Prediction({ a, state }: { a: ReturnType<typeof useAgent>; state: AppState | null }) {
  const p = a.pos?.prediction ?? a.order?.prediction; // in a trade: the prediction the buy was made on
  const d = a.desk;
  const fc = state?.fc;
  const scored = Math.round(fc?.stats.scored ?? 0);
  if (!a.isAgent || (!p && !d && !scored)) return null;
  const ok = !!p && (!!a.pos || !a.order?.warning);
  const pc = (v: number) => `${Math.round(v)}%`;
  const basis = (x: OrderPrediction["parts"][number]) =>
    x.key === "ai" ? "Its reading of the charts, the buyers and sellers, and the patterns"
      : x.key === "panel" ? (p?.panel ?? []).map((v) => `${v.who} ${v.pct}%`).join(" · ")
        : x.key === "worlds" && p?.worlds ? `${p.worlds.paths.toLocaleString()} paths: ${p.worlds.trend}% if the trend continues, ${p.worlds.flat}% with no trend${p.worlds.minutesToWin ? ` · about ${p.worlds.minutesToWin} min to get there` : ""}`
          : x.key === "lookalikes" ? `${x.note ?? ""} (the past moments most like now)`
            : x.key === "baseRate" ? `${(x.note ?? "").replace("starts in", "starting points in the last")} reached it`
              : x.note ?? "";
  const rows = (["ai", "panel", "worlds", "lookalikes", "baseRate", "combined"] as FcKey[]).map((k) => ({ k, s: fc?.stats[k] })).filter((r) => r.s && r.s.n >= 3);
  const side = (s?: { n: number; hits: number }) => (s && s.n >= 0.5 ? `${Math.round(s.hits)} of ${Math.round(s.n)}` : null);
  return (
    <>
      <div className="label-sm">{a.pos ? "The prediction it bought on" : "Prediction"}</div>
      {p ? (
        <div className={`agent-learned ${ok ? "has" : ""}`}>
          <b>{pc(p.pWin)} chance</b> that the price reaches +5% after fees before the stop · it takes {Math.ceil(p.needPct)}% to be worth buying · <b>{a.pos ? "bought" : ok ? "passes" : "not enough, so it stays out"}</b>
          <div className="fc-meter" role="img" aria-label={`Chance ${pc(p.pWin)}, needs ${Math.ceil(p.needPct)}%`}><i className={ok ? "ok" : ""} style={{ width: `${Math.min(100, p.pWin)}%` }} /><u style={{ left: `${Math.min(100, p.needPct)}%` }} /></div>
          <table className="agent-table fc-table">
            <thead><tr><th>Forecaster</th><th className="num">Chance</th><th className="num">Weight</th><th>Based on</th></tr></thead>
            <tbody>
              {p.parts.map((x) => (
                <tr key={x.key}>
                  <td>{FC_NAME[x.key]}</td>
                  <td className="num">{pc(x.pct)}{Math.abs(x.adjPct - x.pct) >= 1 ? <span className="muted" title="Marked down: this forecaster has been saying more than really happened on your account"> → {pc(x.adjPct)}</span> : null}</td>
                  <td className="num">{pc(x.weight * 100)}</td>
                  <td className="basis">{basis(x)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.panel?.length ? <div className="fc-votes">{p.panel.map((v) => <span key={v.who}><b>{v.who}</b> ({v.pct}%): {v.reason}</span>)}</div> : null}
          <span className="muted">
            Reaching it is worth about +{p.winNetPct.toFixed(1)}% after fees; missing costs about {p.lossPct.toFixed(1)}%.
            {p.parts.some((x) => x.key === "panel") ? "" : " The panel of three AI forecasters is asked only about an order that passes on the AI and the numbers."}
            {p.truncated ? " Judged on the first hours of the hold (its history can't simulate longer)." : ""}
            {p.assumed ? " The coin has hardly ever reached this level lately, so the numbers judge it as a buy at that level." : ""}
          </span>
        </div>
      ) : (
        <div className="agent-learned">{a.pos ? "This trade was opened before predictions were recorded." : a.gate ? "No order to forecast: the agent stood aside before its AI was asked." : d ? "No order to forecast yet." : "No forecast yet: it is made on the AI's next look, once this coin has a few hours of history."}</div>
      )}
      {d && !a.pos ? (
        <div className="agent-learned">
          <b>Buying right now, by the numbers alone</b>: the chance of a {d.upPct.toFixed(1)}% rise (that is +5% after fees) before the stop, within 3 hours.
          <table className="agent-table fc-table">
            <thead><tr><th>Stop</th><th className="num">Simulated paths</th><th className="num">This coin lately</th><th className="num">Look-alikes</th><th className="num">Together</th><th className="num">Needs</th></tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.stopPct}>
                  <td>{r.stopPct}% below</td>
                  <td className="num">{r.worlds === null ? "–" : pc(r.worlds)}</td>
                  <td className="num">{r.baseRate === null ? "–" : pc(r.baseRate)}</td>
                  <td className="num">{r.lookN ?? "–"}</td>
                  <td className={`num ${r.numbers >= r.needPct ? "up" : ""}`}>{pc(r.numbers)}</td>
                  <td className="num">{Math.ceil(r.needPct)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.cone.length ? <span className="muted">Where the simulated paths put the price if there is no trend (the middle 80% of them): {d.cone.map((c) => `in ${c.min >= 60 ? `${c.min / 60} h` : `${c.min} min`} ${fmtPrice(c.lo)} to ${fmtPrice(c.hi)}`).join(" · ")}.{d.next60 ? ` After the past moments most like now, the price an hour later was typically ${d.next60.mid >= 0 ? "+" : ""}${d.next60.mid.toFixed(1)}%.` : ""}</span> : null}
        </div>
      ) : null}
      <div className="agent-learned">
        <b>Scoreboard</b> (all your agents): {scored ? `${scored} forecast${scored === 1 ? "" : "s"} checked against what really happened` : "every forecast is checked against what really happens next; none has finished yet"}{fc?.waiting ? ` · ${fc.waiting} waiting for ${fc.waiting === 1 ? "its" : "their"} outcome` : ""}.
        {scored && (side(fc?.stats.taken) || side(fc?.stats.refused)) ? ` Trades it made: ${side(fc?.stats.taken) ? `${side(fc?.stats.taken)} reached +5% (real results)` : "none scored yet"}. Orders it did not buy: ${side(fc?.stats.refused) ? `${side(fc?.stats.refused)} would have reached it on the chart (a real order can fill worse than the chart shows)` : "none scored yet"}. A forecaster that says more than really happens is marked down; a good streak never marks one up.` : ""}
        {fc?.stats.byQuality && Object.keys(fc.stats.byQuality).length ? ` By the scouts' quality score of the coin: ${["under 45", "45-59", "60-74", "75+"].filter((b) => fc.stats.byQuality![b]).map((b) => `${b}: ${fc.stats.byQuality![b].hits} of ${fc.stats.byQuality![b].n} reached +5%`).join(" · ")}.` : ""}
        {rows.length ? (
          <table className="agent-table fc-table">
            <thead><tr><th>Forecaster</th><th className="num">Said on average</th><th className="num">Happened on the chart</th><th className="num">Forecasts</th></tr></thead>
            <tbody>
              {rows.map(({ k, s }) => (
                <tr key={k}><td>{FC_NAME[k]}</td><td className="num">{pc((s!.sumP / s!.n) * 100)}</td><td className="num">{pc((s!.hits / s!.n) * 100)}</td><td className="num">{Math.round(s!.n)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  );
}

const STAGES = ["AI deciding", "Waiting for its price", "In a trade"];
const STAGES_PROFIT = ["AI deciding", "Waiting for its price", "In profit: AI managing"];
// The "it's running" bar: a light sweeps along it while the agent works; amber and still when paused.
function RunBar({ stage, paused, labels = false, profit = false }: { stage: number; paused: boolean; labels?: boolean; profit?: boolean }) {
  return (
    <div className={`run-bar ${paused ? "paused" : ""} s${stage}`} role="status" aria-label={paused ? "Agent paused" : `Agent running: ${STAGES[stage]}`}>
      <div className="run-track"><i /></div>
      {labels ? (
        <div className="run-steps">
          {(profit ? STAGES_PROFIT : STAGES).map((n, i) => <span key={n} className={i === stage ? "now" : i < stage ? "done" : ""}>{n}</span>)}
          <em>{paused ? "Paused" : "Running"}</em>
        </div>
      ) : null}
    </div>
  );
}

function useStop(a: ReturnType<typeof useAgent>, notify: Notify, refresh: () => void, after?: () => void) {
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      await api.stopBot(a.id);
      notify(`${a.isAgent ? "Agent" : "Bot"} on ${a.symbol} stopped${a.pos ? ". Its open trade stays in Positions: close it there if you want out." : ""}`);
      refresh();
      after?.();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setStopping(false);
    }
  };
  return { stop, stopping };
}

function AgentCard({ slot, state, notify, refresh, onOpen, onDetails }: { slot: BotSlot; state: AppState | null; notify: Notify; refresh: () => void; onOpen: (chain: string, pool: string) => void; onDetails: () => void }) {
  const a = useAgent(slot, state);
  const { stop, stopping } = useStop(a, notify, refresh);
  return (
    <div className={`agent-card ${a.pos ? "holding" : ""}`} role="button" tabIndex={0} aria-label={`Open the ${a.symbol} agent`} onClick={onDetails}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onDetails(); } }}>
      <div className="agent-top">
        <span className={`agent-avatar ${a.pos ? "live" : a.paused ? "idle" : ""}`}><Avatar src={a.image} symbol={a.symbol} /></span>
        <span className="agent-name">
          <b>{a.symbol}</b>
          <small>{modeName(a.cfg)}{a.isAgent ? ` · ${fmtUsd(a.budget)} budget` : ""}</small>
        </span>
        <span className={`agent-pnl ${a.pnl >= 0 ? "up" : "down"}`}>
          {a.pnl >= 0 ? "+" : ""}{fmtUsd(a.pnl)}
          {a.isAgent ? <small>{((a.pnl / a.budget) * 100).toFixed(1)}%</small> : null}
        </span>
      </div>
      <RunBar stage={a.stage} paused={a.paused} />
      <div className="agent-status">{a.status}</div>
      <div className="agent-actions" onClick={(e) => e.stopPropagation()}>
        {a.chain && a.pool ? <button className="chip" onClick={() => onOpen(a.chain!, a.pool!)}>View chart</button> : null}
        <button className="chip" onClick={onDetails}>Details</button>
        <button className="chip danger" onClick={() => void stop()} disabled={stopping}>{stopping ? "Stopping…" : "Stop"}</button>
      </div>
    </div>
  );
}

// The agent's window: what it's doing now, what it learned, its activity and its trades.
function AgentModal({ slot, state, notify, refresh, onOpen, onClose }: { slot: BotSlot; state: AppState | null; notify: Notify; refresh: () => void; onOpen: (chain: string, pool: string) => void; onClose: () => void }) {
  const a = useAgent(slot, state);
  const { stop, stopping } = useStop(a, notify, refresh, onClose);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const ran = Math.max(0, Math.floor((now - (a.bot.startedAt ?? now)) / 1000));
  const ranText = ran >= 3600 ? `${Math.floor(ran / 3600)}h ${Math.floor((ran % 3600) / 60)}m` : `${Math.floor(ran / 60)}m ${String(ran % 60).padStart(2, "0")}s`;
  const wins = a.sells.filter((t) => (t.pnlUsd ?? 0) > 0).length;
  const L = a.L;
  return (
    <Modal title={`${a.symbol} ${a.isAgent ? "agent" : "bot"}`} onClose={onClose} wide
      foot={
        <>
          {a.chain && a.pool ? <button className="btn ghost" onClick={() => { onOpen(a.chain!, a.pool!); onClose(); }}>View chart</button> : null}
          <button className="btn ghost danger-btn" onClick={() => void stop()} disabled={stopping}>{stopping ? "Stopping…" : `Stop ${a.isAgent ? "agent" : "bot"}`}</button>
        </>
      }>
      <div className="agent-modal">
        <div className="agent-top">
          <span className={`agent-avatar big ${a.pos ? "live" : a.paused ? "idle" : ""}`}><Avatar src={a.image} symbol={a.symbol} /></span>
          <span className="agent-name">
            <b>{a.symbol}</b>
            <small>{modeName(a.cfg)} · running {ranText}</small>
          </span>
          <span className={`agent-pnl big ${a.pnl >= 0 ? "up" : "down"}`}>
            {a.pnl >= 0 ? "+" : ""}{fmtUsd(a.pnl)}
            {a.isAgent ? <small>{((a.pnl / a.budget) * 100).toFixed(1)}% of budget</small> : null}
          </span>
        </div>
        <RunBar stage={a.stage} paused={a.paused} labels profit={!!a.pm} />
        <p className="agent-now">{a.status}</p>
        <div className="agent-stats">
          {a.isAgent ? <div><small>Budget</small><b>{fmtUsd(a.budget)}</b></div> : null}
          {a.isAgent ? <div><small>Funds now</small><b>{fmtUsd(a.budget + a.realized)}</b></div> : null}
          {a.isAgent ? <div><small>Locked cash</small><b>{fmtUsd(state?.locks?.find((l) => l.id === a.id)?.usd ?? 0)}</b></div> : null}
          {a.isAgent && a.pos?.costPct !== undefined ? <div data-tip="What buying and later selling this trade's size costs in this coin's pool: pool fees plus the price the trade itself moves, both ways. Measured when it was bought."><small>This trade's cost</small><b>{a.pos.costPct.toFixed(1)}% round trip</b></div> : null}
          {a.isAgent && !a.pos && a.tradeCost ? (
            <div data-tip={`${a.tradeCost.source === "jupiter" ? "Measured with two-way Jupiter quotes" : "Estimated from the pool's depth"} for this size: pool fees plus the price the trade itself moves, both ways.${a.tradeCost.usd < a.tradeCost.funds - 0.5 ? ` All ${fmtUsd(a.tradeCost.funds)} would cost ${a.tradeCost.fullPct.toFixed(1)}%, so it buys less to stay under ${a.tradeCost.capPct}%.` : ""}`}>
              <small>{a.tradeCost.usd < a.tradeCost.funds - 0.5 ? `Buys with (of ${fmtUsd(a.tradeCost.funds)})` : "Next buy costs"}</small>
              <b>{a.tradeCost.usd < a.tradeCost.funds - 0.5 ? `${fmtUsd(a.tradeCost.usd)} · ${a.tradeCost.pct.toFixed(1)}% round trip` : `${a.tradeCost.pct.toFixed(1)}% round trip`}</b>
            </div>
          ) : null}
          <div><small>Trades</small><b>{a.sells.length}</b></div>
          <div><small>Profitable</small><b>{a.sells.length ? `${wins} of ${a.sells.length}` : "–"}</b></div>
          {a.order && !a.pos && !a.refused ? <div><small>{a.order.kind === "buy_now" ? "Buys now up to" : a.order.kind === "buy_breakout" ? (a.order.minVolumeRatio > 0 ? `Buys above, on ${a.order.minVolumeRatio}× volume` : "Buys above") : "Buys at"}</small><b>{fmtPrice(a.order.triggerPrice)}</b></div> : null}
          {a.order && !a.pos && !a.refused ? <div><small>Exit / target</small><b>{fmtPrice(a.order.stopLoss)} / {fmtPrice(a.order.target)}</b></div> : null}
          {a.order && !a.pos && a.refused ? <div><small>Buy order</small><b>None right now</b></div> : null}
          {a.order && !a.pos && a.refused ? <div><small>Closest setup (looks again there)</small><b>{a.order.kind === "buy_breakout" ? "above " : a.order.kind === "buy_dip" ? "dip to " : ""}{fmtPrice(a.order.triggerPrice)}</b></div> : null}
          {a.pos ? <div><small>Now, after fees</small><b className={a.netAt(a.pos.lastPrice) >= 0 ? "up" : "down"}>{a.pct(a.netAt(a.pos.lastPrice))}</b></div> : null}
          {a.pos ? <div><small>Best so far</small><b>{a.pct(a.netAt(a.pos.best ?? a.pos.lastPrice))}</b></div> : null}
          {a.pos ? <div><small>{a.pm ? "Sells at (locked or trailing)" : "Stop-loss"}</small><b>{a.pos.stopLoss ? `${fmtPrice(a.pos.stopLoss)} (${a.pct(a.netAt(a.pos.stopLoss))})` : "–"}</b></div> : null}
          {a.pm?.target ? <div><small>AI expects</small><b>{fmtPrice(a.pm.target)} ({a.pct(a.netAt(a.pm.target))})</b></div> : null}
        </div>
        {a.pos && a.pm ? (
          <>
            <div className="label-sm">The AI's profit management</div>
            <div className={`agent-learned ${a.pm.by === "ai" ? "has" : ""}`}>
              {a.pm.by === "ai" ? (
                <>
                  <b>Holding for more</b>{a.pm.confidence !== undefined ? ` · ${Math.round(a.pm.confidence)}% sure it goes higher` : ""} · exit follows {a.pm.trailPct}% behind the high, never below {fmtPrice(a.pm.floor)} · asked {a.pm.asks} time{a.pm.asks === 1 ? "" : "s"}
                  {a.pm.note ? <><br />{a.pm.note}</> : null}
                </>
              ) : (
                <>The +5% minimum is locked at {fmtPrice(a.pm.floor)}. {a.pm.fails ? "The AI couldn't be reached, so" : "Until the AI answers,"} the exit follows {a.pm.trailPct}% behind the high.</>
              )}
              {a.pm.nextAt ? <><br /><span className="muted">Asked again by {new Date(a.pm.nextAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}, sooner on a new percent or a pullback.</span></> : null}
            </div>
          </>
        ) : null}
        {a.gate && !a.pos ? <GateBox a={a} notify={notify} refresh={refresh} /> : null}
        {a.isAgent && a.gateOff ? (
          <div className="agent-learned">
            <b>Coin quality gate: off.</b> You chose to trade {a.symbol} whatever the scouts say; its AI is asked every time.{" "}
            <button className="link-btn" onClick={() => api.botQualityGate(true, a.id).then(refresh).catch((e) => notify(e.message, true))}>Turn the gate back on</button>
          </div>
        ) : null}
        {a.plan && !a.pos && !a.gate ? (
          <>
            <div className="label-sm">The AI's decision</div>
            <div className={`agent-learned ${a.plan.stance === "AVOID" ? "" : "has"}`}>
              <b>{a.plan.stance === "BUY_NOW" ? "Buy now" : a.plan.stance !== "AVOID" ? "Buy at its level" : a.order?.prediction && a.order.warning ? (a.said === "BUY_NOW" ? "It wanted to buy now, but the odds weren't good enough" : a.said === "WAIT_FOR_TRIGGER" ? "It gave levels to buy at, but the odds at them weren't good enough" : "Stay out: even its best setup has poor odds") : "Stay out for now"}</b> · {a.plan.confidence}% sure{a.order && a.plan.stance !== "AVOID" ? ` · ${a.order.prediction ? `${Math.round(a.order.prediction.pWin)}% combined chance` : `${a.order.winChancePct}% win chance`} · aims for +${a.order.netRewardPct.toFixed(1)}% after fees, risks ${a.order.netRiskPct.toFixed(1)}%` : ""}
              {a.reasoning ? <><br />{a.reasoning}</> : null}
              {!a.pos && a.nextLook ? <><br /><span className="muted">Next look by {new Date(a.nextLook).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, {a.refused ? `or at once if the price ${a.watching ? "reaches a level it named or " : ""}moves about ${a.moveAt}%` : `or sooner if the price moves about ${a.moveAt}%, or when an order fills`}.</span></> : null}
            </div>
          </>
        ) : null}
        <Prediction a={a} state={state} />
        {a.isAgent ? <MaCrossChips items={a.maCross} at={a.planAt} /> : null}
        {a.isAgent && L ? (
          <>
            <div className="label-sm">{a.symbol}'s history, as given to the AI</div>
            <div className="agent-learned">{L.summary}</div>
            {L.table.length ? (
              <table className="agent-table">
                <thead><tr><th>Pattern</th><th>Chart</th><th className="num">Past trades</th><th className="num">Reached +5%</th><th className="num">Then typically ran to</th><th className="num">If sold at +5%</th></tr></thead>
                <tbody>
                  {L.table.map((t) => (
                    <tr key={`${t.key}${t.tf}`}>
                      <td>{t.label}</td><td>{t.tf}</td><td className="num">{t.trades}</td><td className="num">{t.wins}</td>
                      <td className="num">{t.wins && t.runMedPct !== undefined ? `+${t.runMedPct.toFixed(1)}%` : "–"}</td>
                      <td className={`num ${t.avgNetPct >= 0 ? "up" : "down"}`}>{t.avgNetPct >= 0 ? "+" : ""}{t.avgNetPct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : null}
        <div className="label-sm">Activity</div>
        <div className="agent-log">
          {a.bot.log.length ? a.bot.log.slice(0, 14).map((l, i) => (
            <div key={i} className={l.level}><span className="muted mono">{new Date(l.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span> {l.msg}</div>
          )) : <div className="muted">Nothing yet.</div>}
        </div>
        {a.trades.length ? (
          <>
            <div className="label-sm">Its trades</div>
            <table className="agent-table">
              <thead><tr><th>Time</th><th>Side</th><th className="num">Price</th><th className="num">Amount</th><th className="num">P&amp;L</th><th>Why</th></tr></thead>
              <tbody>
                {a.trades.slice(0, 10).map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                    <td className={t.side === "BUY" ? "up" : "down"}>{t.side}</td>
                    <td className="num">{fmtPrice(t.price)}</td><td className="num">{fmtUsd(t.usd)}</td>
                    <td className={`num ${(t.pnlUsd ?? 0) >= 0 ? "up" : "down"}`}>{t.pnlUsd === undefined ? "–" : `${t.pnlUsd >= 0 ? "+" : ""}${fmtUsd(t.pnlUsd)}`}</td>
                    <td className="why">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function NewAgentModal({ slotId, preset, state, defaults, notify, onClose, onStarted, takenPools }: { slotId: string; preset?: PairInfo | null; state: AppState | null; defaults: Defaults; notify: Notify; onClose: () => void; onStarted: () => void; takenPools: string[] }) {
  const [scan, setScan] = useState<{ scanned: number; pass: number; coins: AgentCoin[] } | null>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<PairInfo | null>(preset ?? null);
  const [picking, setPicking] = useState<string | null>(null);
  // Default budget: $1,000, or whatever is available if that is less.
  const free = state?.available ?? state?.cash ?? 0;
  const [budget, setBudget] = useState(String(free >= DEFAULT_BUDGET ? DEFAULT_BUDGET : Math.max(10, Math.floor(free))));
  const quick = !!preset; // opened from the chart: the coin is chosen, only the budget is asked
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (quick) return; // no opportunities list in the quick window
    const load = () => api.agents().then(setScan).catch((e) => setErr(e.message));
    load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, []);
  const choose = async (c: AgentCoin) => {
    setPicking(c.mint);
    try {
      const p = await findCoinPair({ mint: c.mint, symbol: c.symbol, name: c.name, icon: c.icon, priceUsd: c.priceUsd, mcap: c.mcap, change24h: 0 });
      if (p) setPick(p);
      else notify(`No chart found for ${c.symbol} yet`, true);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setPicking(null);
    }
  };
  const cash = state?.available ?? state?.cash ?? 0; // what isn't already locked for other agents
  const amount = Number(budget);
  const taken = pick ? takenPools.includes(pick.pool) : false;
  const problem = !pick ? "Pick a coin" : taken ? `An agent is already trading ${pick.symbol}` : !(amount >= 10) ? "Budget must be at least $10" : amount > cash ? `Only ${fmtUsd(cash)} is available${(state?.locked ?? 0) > 0.005 ? ` (${fmtUsd(state!.locked!)} is locked for your other agents)` : ""}` : "";
  const start = async () => {
    if (!pick || problem) return;
    setStarting(true);
    try {
      const cfg: BotConfig = {
        ...defaults, chain: pick.chain, pool: pick.pool, symbol: pick.symbol, ...(pick.imageUrl ? { imageUrl: pick.imageUrl } : {}), tf: "5m", checkEverySec: 5, goalUsd: 1e9,
        pick: "agent", budgetUsd: amount, strongMode: false, rewardRule: false, minConfidence: 0,
        disabled: ["dailyLossPct", "cooldownMin", "maxDrawdownPct", "minConfidence", "maxDrop1hPct", "riskPerTradePct"],
      };
      await api.startBot(cfg, slotId);
      notify(`Agent started on ${pick.symbol} with ${fmtUsd(amount)}`);
      onStarted();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setStarting(false);
    }
  };
  const top = (scan?.coins ?? []).slice(0, 10);
  return (
    <Modal title={quick && pick ? `Start agent on ${pick.symbol}` : "New agent"} onClose={onClose} wide={!quick} narrow={quick}
      foot={
        <>
          <span className="muted small agent-foot-note">{problem || `${fmtUsd(amount)} will be locked for this agent: it leaves your Available cash, and stays in your equity.`}</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn buy" onClick={() => void start()} disabled={!!problem || starting}>{starting ? "Starting…" : pick ? `Start agent on ${pick.symbol}` : "Start agent"}</button>
        </>
      }>
      <div className="new-agent">
        {quick ? null : (
          <>
        <p className="muted small">One agent trades one coin. The moment it starts, its AI reads every timeframe, the chart patterns, the coin's history and your past trades, and decides: <b>buy now</b>, buy at a level, or stay out. Each trade aims for at least <b>+5% after all fees</b>. Once it gets there that minimum is locked, and the AI decides how long to hold for more and when to sell.</p>
        <CoinSearch className="in-modal" placeholder="Search any coin by ticker, name or address…" notify={notify} onSelect={setPick} autoFocus />
          </>
        )}
        {pick ? (
          <div className="agent-picked">
            {pick.imageUrl ? <img src={pick.imageUrl} alt="" /> : <span className="sr-noicon">{pick.symbol.slice(0, 1)}</span>}
            <span><b>{pick.symbol}</b> <small className="muted">{pick.name} · {fmtPrice(pick.priceUsd)}</small></span>
            {quick ? null : <button className="chip" onClick={() => setPick(null)}>Change</button>}
          </div>
        ) : null}
        <div className={`agent-form ${quick ? "quick" : ""}`}>
          <label>
            <span>Budget (paper money)</span>
            <div className="agent-budget"><i>$</i><input type="number" min={10} step={50} value={budget} onChange={(e) => setBudget(e.target.value)} /></div>
            <div className="agent-quick">{[250, 500, 1000, 2500].map((v) => <button key={v} type="button" className={`chip ${amount === v ? "on" : ""}`} onClick={() => setBudget(String(v))}>${v.toLocaleString()}</button>)}</div>
          </label>
          <p className="muted small agent-form-note">Its AI decides when to buy and sell. There is no daily loss limit, cool-down or other brake: <b>the budget is the only limit</b>, so give it only what you're ready to lose.</p>
        </div>
        {quick ? null : (
          <>
        <div className="label-sm opp-title">Top 10 opportunities right now{scan ? <span className="muted"> · {scan.scanned} coins scanned by 8 scouts</span> : null}</div>
        {err ? <div className="muted small">Couldn't load the opportunities: {err}</div> : !scan ? <div className="muted small">Scanning…</div> : (
          <div className="opp-list">
            {top.map((c, i) => {
              const ok = !c.vetoes.length && c.total >= scan.pass;
              return (
                <button key={c.mint} className={`opp-row ${ok ? "ok" : ""} ${pick?.tokenAddress === c.mint ? "on" : ""}`} onClick={() => void choose(c)} disabled={picking === c.mint}
                  title={Object.entries(c.agents).map(([k, v]) => `${k.toUpperCase()} ${Math.round(v.score)}: ${v.note}`).join("\n")}>
                  <span className="opp-rank">{i + 1}</span>
                  {c.icon ? <img src={c.icon} alt="" /> : <span className="sr-noicon">{c.symbol.slice(0, 1)}</span>}
                  <span className="opp-name"><b>{c.symbol}</b><small>{c.vetoes.length ? c.vetoes[0] : `${c.change1h >= 0 ? "+" : ""}${c.change1h.toFixed(1)}% in 1h · $${Math.round(c.liquidity / 1000)}K liquidity`}</small></span>
                  <span className="opp-bars" aria-hidden="true">{Object.entries(c.agents).map(([k, v]) => <i key={k} style={{ height: `${Math.max(12, v.score)}%` }} className={v.score >= 65 ? "g" : v.score >= 45 ? "a" : "r"} />)}</span>
                  <span className={`opp-score ${ok ? "up" : c.vetoes.length ? "down" : "amber"}`}>{c.total}<small>{ok ? "passes" : c.vetoes.length ? "vetoed" : "below 65"}</small></span>
                </button>
              );
            })}
          </div>
        )}
        <p className="muted tiny">Scores come from eight rule-based scouts (trend, volume, real traders, holders, dev wallet, liquidity, momentum, age). They are not advice, and a high score is not a promise. Hover a row for each scout's reading.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
