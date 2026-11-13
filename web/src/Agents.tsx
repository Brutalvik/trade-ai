// Agents: each agent trades ONE coin with its own budget, and its AI decides. On start it asks the
// AI at once (every timeframe, chart patterns, a study of the coin's history, the scouts' reading,
// your trade journal): buy now, buy at a level, or stay out. The budget is its only limit.
// This panel lists your agents; "+ New Agent" opens a window with the top opportunities (scored
// by the eight scouts) and the coin search.
import { useEffect, useState } from "react";
import { Modal, useAccess } from "./Account";
import { CoinSearch } from "./CoinSearch";
import { findCoinPair } from "./CoinList";
import { allBots, api, fmtPrice, fmtUsd, type AgentCoin, type AppState, type BotConfig, type BotSlot, type PairInfo } from "./api";

const DEFAULT_BUDGET = 1000;
type Notify = (m: string, bad?: boolean) => void;
// The settings an agent starts with (the Balanced preset's safety limits; its own entry/exit rules).
type Defaults = Pick<BotConfig, "positionPct" | "minConfidence" | "analyzeEverySec" | "maxDrawdownPct" | "breakEvenAtPct" | "trailPct" | "cooldownMin" | "dailyLossPct" | "maxDrop1hPct" | "riskPerTradePct" | "lockPct">;

const modeName = (c: BotConfig | null) => (c?.pick === "agent" ? "Agent" : c?.pick === "auto" ? "Auto-pick bot" : c?.pick === "newcoins" ? "New coins bot" : c?.pick === "agents" ? "Scout bot" : "AI-plan bot");

export function AgentsPanel({ state, limit, notify, refresh, onOpen, defaults }: { state: AppState | null; limit: number; notify: Notify; refresh: () => void; onOpen: (chain: string, pool: string) => void; defaults: Defaults }) {
  const access = useAccess();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null); // the agent whose window is open
  const slots = allBots(state);
  const running = slots.filter((b) => b.bot.running);
  const ids = Array.from({ length: Math.max(limit, 1) }, (_, i) => String(i + 1));
  const busy = (id: string) => slots.find((b) => b.id === id)?.bot.running || state?.positions.some((p) => p.source === "bot" && (p.botId ?? "1") === id);
  const freeId = ids.find((id) => !busy(id));
  const canAdd = limit > 0 && !!freeId;
  const opened = running.find((b) => b.id === openId);
  return (
    <div className="panel agents-panel">
      <div className="panel-title">
        <span>AGENTS <span className="muted small">{running.length}/{Math.max(limit, 0)}{(state?.locked ?? 0) > 0.005 ? ` · ${fmtUsd(state!.locked!)} locked` : ""}</span></span>
        <button className="btn buy agents-new" onClick={() => (limit <= 0 ? access.openPlans() : canAdd ? setAdding(true) : notify(`Your plan includes ${limit} agent${limit > 1 ? "s" : ""}. Stop one first, or see Plans for more.`, true))}>
          + New Agent
        </button>
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
      {adding && freeId && <NewAgentModal slotId={freeId} state={state} defaults={defaults} notify={notify} onClose={() => setAdding(false)} onStarted={() => { setAdding(false); refresh(); }} takenPools={running.map((b) => b.bot.config?.pool ?? "")} />}
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
  const order = c?.orders.find((o) => !o.warning) ?? c?.orders[0];
  const okRes = plan?.results.find((r) => r.ok);
  const reasoning = okRes && okRes.ok ? okRes.signal.reasoning : "";
  const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Agents ask the AI again at least every 10 minutes (and on a 4% move, or when the plan runs out).
  const nextLook = c ? Math.min(c.expiresAt, (bot.lastAnalysisAt || Date.now()) + (isAgent ? 600 : (cfg?.analyzeEverySec ?? 1800)) * 1000) : 0;
  // Where it is in its loop: 0 the AI is deciding, 1 waiting for its level, 2 in a trade.
  const stage = pos ? 2 : !c ? 0 : 1;
  const paused = !pos && !!bot.blocked;
  const status = pos
    ? `In a trade since ${at(pos.openedAt)}: bought at ${fmtPrice(pos.entryPrice)}, exit ${pos.stopLoss ? fmtPrice(pos.stopLoss) : "–"}, target ${pos.target ? fmtPrice(pos.target) : "–"}`
    : bot.blocked
      ? `Paused: ${bot.blocked}`
      : !c
        ? "The AI is reading the charts and deciding…"
        : c.stance === "AVOID" || !order
          ? `The AI sees no bet worth taking right now${order ? ` (closest: ${order.kind === "buy_breakout" ? "above" : "at"} ${fmtPrice(order.triggerPrice)}, ${order.winChancePct}% win chance)` : ""}. It looks again by ${at(nextLook)}, or sooner if the price moves 4%.`
          : order.kind === "buy_now"
            ? `The AI says buy now (up to ${fmtPrice(order.triggerPrice)}): ${order.winChancePct}% win chance`
            : `The AI will buy ${order.kind === "buy_breakout" ? "a breakout above" : "a dip to"} ${fmtPrice(order.triggerPrice)}: ${order.winChancePct}% win chance`;
  return { bot, id, cfg, isAgent, pos, trades, sells, realized, pnl, budget, L, chain, pool, symbol, stage, paused, status, plan: c, order, reasoning, nextLook };
}

const STAGES = ["AI deciding", "Waiting for its price", "In a trade"];
// The "it's running" bar: a light sweeps along it while the agent works; amber and still when paused.
function RunBar({ stage, paused, labels = false }: { stage: number; paused: boolean; labels?: boolean }) {
  return (
    <div className={`run-bar ${paused ? "paused" : ""} s${stage}`} role="status" aria-label={paused ? "Agent paused" : `Agent running: ${STAGES[stage]}`}>
      <div className="run-track"><i /></div>
      {labels ? (
        <div className="run-steps">
          {STAGES.map((n, i) => <span key={n} className={i === stage ? "now" : i < stage ? "done" : ""}>{n}</span>)}
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
        <span className={`agent-avatar ${a.pos ? "live" : a.paused ? "idle" : ""}`}>{a.pos?.imageUrl ? <img src={a.pos.imageUrl} alt="" /> : a.symbol.slice(0, 1).toUpperCase()}</span>
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
          <span className={`agent-avatar big ${a.pos ? "live" : a.paused ? "idle" : ""}`}>{a.pos?.imageUrl ? <img src={a.pos.imageUrl} alt="" /> : a.symbol.slice(0, 1).toUpperCase()}</span>
          <span className="agent-name">
            <b>{a.symbol}</b>
            <small>{modeName(a.cfg)} · running {ranText}</small>
          </span>
          <span className={`agent-pnl big ${a.pnl >= 0 ? "up" : "down"}`}>
            {a.pnl >= 0 ? "+" : ""}{fmtUsd(a.pnl)}
            {a.isAgent ? <small>{((a.pnl / a.budget) * 100).toFixed(1)}% of budget</small> : null}
          </span>
        </div>
        <RunBar stage={a.stage} paused={a.paused} labels />
        <p className="agent-now">{a.status}</p>
        <div className="agent-stats">
          {a.isAgent ? <div><small>Budget</small><b>{fmtUsd(a.budget)}</b></div> : null}
          {a.isAgent ? <div><small>Funds now</small><b>{fmtUsd(a.budget + a.realized)}</b></div> : null}
          {a.isAgent ? <div><small>Locked cash</small><b>{fmtUsd(state?.locks?.find((l) => l.id === a.id)?.usd ?? 0)}</b></div> : null}
          <div><small>Trades</small><b>{a.sells.length}</b></div>
          <div><small>Profitable</small><b>{a.sells.length ? `${wins} of ${a.sells.length}` : "–"}</b></div>
          {a.order && !a.pos ? <div><small>{a.order.kind === "buy_now" ? "Buys now up to" : a.order.kind === "buy_breakout" ? "Buys above" : "Buys at"}</small><b>{fmtPrice(a.order.triggerPrice)}</b></div> : null}
          {a.order && !a.pos ? <div><small>Exit / target</small><b>{fmtPrice(a.order.stopLoss)} / {fmtPrice(a.order.target)}</b></div> : null}
        </div>
        {a.plan ? (
          <>
            <div className="label-sm">The AI's decision</div>
            <div className={`agent-learned ${a.plan.stance === "AVOID" ? "" : "has"}`}>
              <b>{a.plan.stance === "BUY_NOW" ? "Buy now" : a.plan.stance === "AVOID" ? "Stay out for now" : "Buy at its level"}</b> · {a.plan.confidence}% sure{a.order && a.plan.stance !== "AVOID" ? ` · ${a.order.winChancePct}% win chance · aims for +${a.order.netRewardPct.toFixed(1)}% after fees, risks ${a.order.netRiskPct.toFixed(1)}%` : ""}
              {a.reasoning ? <><br />{a.reasoning}</> : null}
              {!a.pos && a.nextLook ? <><br /><span className="muted">Next look by {new Date(a.nextLook).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, or sooner on a 4% move or when an order fills.</span></> : null}
            </div>
          </>
        ) : null}
        {a.isAgent && L ? (
          <>
            <div className="label-sm">{a.symbol}'s history, as given to the AI</div>
            <div className="agent-learned">{L.summary}</div>
            {L.table.length ? (
              <table className="agent-table">
                <thead><tr><th>Pattern</th><th>Chart</th><th className="num">Past trades</th><th className="num">Won</th><th className="num">Average after fees</th></tr></thead>
                <tbody>
                  {L.table.map((t) => (
                    <tr key={`${t.key}${t.tf}`}>
                      <td>{t.label}</td><td>{t.tf}</td><td className="num">{t.trades}</td><td className="num">{t.wins}</td>
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

function NewAgentModal({ slotId, state, defaults, notify, onClose, onStarted, takenPools }: { slotId: string; state: AppState | null; defaults: Defaults; notify: Notify; onClose: () => void; onStarted: () => void; takenPools: string[] }) {
  const [scan, setScan] = useState<{ scanned: number; pass: number; coins: AgentCoin[] } | null>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<PairInfo | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [budget, setBudget] = useState(String(DEFAULT_BUDGET));
  const [starting, setStarting] = useState(false);
  useEffect(() => {
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
        ...defaults, chain: pick.chain, pool: pick.pool, symbol: pick.symbol, tf: "5m", checkEverySec: 5, goalUsd: 1e9,
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
    <Modal title="New agent" onClose={onClose} wide
      foot={
        <>
          <span className="muted small agent-foot-note">{problem || `${fmtUsd(amount)} will be locked for this agent: it leaves your Available cash, and stays in your equity.`}</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn buy" onClick={() => void start()} disabled={!!problem || starting}>{starting ? "Starting…" : pick ? `Start agent on ${pick.symbol}` : "Start agent"}</button>
        </>
      }>
      <div className="new-agent">
        <p className="muted small">One agent trades one coin. The moment it starts, its AI reads every timeframe, the chart patterns, the coin's history and your past trades, and decides: <b>buy now</b>, buy at a level, or stay out. Each trade aims for <b>+10% after all fees</b>.</p>
        <CoinSearch className="in-modal" placeholder="Search any coin by ticker, name or address…" notify={notify} onSelect={setPick} autoFocus />
        {pick ? (
          <div className="agent-picked">
            {pick.imageUrl ? <img src={pick.imageUrl} alt="" /> : <span className="sr-noicon">{pick.symbol.slice(0, 1)}</span>}
            <span><b>{pick.symbol}</b> <small className="muted">{pick.name} · {fmtPrice(pick.priceUsd)}</small></span>
            <button className="chip" onClick={() => setPick(null)}>Change</button>
          </div>
        ) : null}
        <div className="agent-form">
          <label>
            <span>Budget (paper money)</span>
            <div className="agent-budget"><i>$</i><input type="number" min={10} step={50} value={budget} onChange={(e) => setBudget(e.target.value)} /></div>
            <div className="agent-quick">{[250, 500, 1000, 2500].map((v) => <button key={v} type="button" className={`chip ${amount === v ? "on" : ""}`} onClick={() => setBudget(String(v))}>${v.toLocaleString()}</button>)}</div>
          </label>
          <p className="muted small agent-form-note">Its AI decides when to buy and sell. There is no daily loss limit, cool-down or other brake: <b>the budget is the only limit</b>, so give it only what you're ready to lose.</p>
        </div>
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
      </div>
    </Modal>
  );
}
