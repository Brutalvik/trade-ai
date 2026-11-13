// Agents: each agent trades ONE coin with its own budget. It studies that coin's history, learns
// which entry pattern really made +10% after fees there, and buys when the pattern appears.
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

export function AgentsPanel({ state, limit, notify, refresh, onOpen, defaults, onClassic }: { state: AppState | null; limit: number; notify: Notify; refresh: () => void; onOpen: (chain: string, pool: string) => void; defaults: Defaults; onClassic: () => void }) {
  const access = useAccess();
  const [adding, setAdding] = useState(false);
  const slots = allBots(state);
  const running = slots.filter((b) => b.bot.running);
  const ids = Array.from({ length: Math.max(limit, 1) }, (_, i) => String(i + 1));
  const busy = (id: string) => slots.find((b) => b.id === id)?.bot.running || state?.positions.some((p) => p.source === "bot" && (p.botId ?? "1") === id);
  const freeId = ids.find((id) => !busy(id));
  const canAdd = limit > 0 && !!freeId;
  return (
    <div className="panel agents-panel">
      <div className="panel-title">
        <span>AGENTS <span className="muted small">{running.length}/{Math.max(limit, 0)}</span></span>
        <button className="btn buy agents-new" onClick={() => (limit <= 0 ? access.openPlans() : canAdd ? setAdding(true) : notify(`Your plan includes ${limit} agent${limit > 1 ? "s" : ""}. Stop one first, or see Plans for more.`, true))}>
          + New Agent
        </button>
      </div>
      {running.length ? (
        <div className="agent-list">
          {running.map((b) => <AgentCard key={b.id} slot={b} state={state} notify={notify} refresh={refresh} onOpen={onOpen} />)}
        </div>
      ) : (
        <p className="muted small agents-empty">
          {limit <= 0
            ? "Agents trade one coin each, on their own. They're included from the AI Starter plan."
            : "No agents yet. An agent trades one coin with the money you give it: it studies the coin's history, learns which pattern has paid there, and buys only when that pattern appears."}
        </p>
      )}
      <button className="link agents-classic" onClick={onClassic}>Classic bot view</button>
      {adding && freeId && <NewAgentModal slotId={freeId} state={state} defaults={defaults} notify={notify} onClose={() => setAdding(false)} onStarted={() => { setAdding(false); refresh(); }} takenPools={running.map((b) => b.bot.config?.pool ?? "")} />}
    </div>
  );
}

function AgentCard({ slot, state, notify, refresh, onOpen }: { slot: BotSlot; state: AppState | null; notify: Notify; refresh: () => void; onOpen: (chain: string, pool: string) => void }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const { bot, id } = slot;
  const cfg = bot.config;
  const isAgent = cfg?.pick === "agent";
  const pos = state?.positions.find((p) => p.source === "bot" && (p.botId ?? "1") === id);
  const since = bot.startedAt ?? 0;
  const realized = (state?.trades ?? []).filter((t) => t.source === "bot" && (t.botId ?? "1") === id && t.side === "SELL" && t.time >= since).reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const open$ = pos ? pos.qty * pos.lastPrice - pos.costUsd : 0;
  const pnl = realized + open$;
  const budget = cfg?.budgetUsd ?? DEFAULT_BUDGET;
  const L = bot.learned;
  const chain = pos?.chain ?? (cfg?.pick === "auto" || cfg?.pick === "agents" ? bot.target?.chain : cfg?.chain);
  const pool = pos?.pool ?? (cfg?.pick === "auto" || cfg?.pick === "agents" ? bot.target?.pool : cfg?.pool);
  const symbol = pos?.symbol ?? (cfg?.pick === "auto" || cfg?.pick === "agents" ? bot.target?.symbol ?? "Scanning" : cfg?.symbol) ?? "?";
  const status = pos
    ? `Holding since ${new Date(pos.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: bought at ${fmtPrice(pos.entryPrice)}, exit ${pos.stopLoss ? fmtPrice(pos.stopLoss) : "–"}, target ${pos.target ? fmtPrice(pos.target) : "–"}`
    : bot.blocked
      ? `Paused: ${bot.blocked}`
      : isAgent
        ? L
          ? L.best ? `Watching for "${L.best.label}" on the ${L.best.tf} chart` : "No pattern with an edge yet: watching, relearns every hour"
          : "Studying the coin's history…"
        : "Running";
  const stop = async () => {
    setStopping(true);
    try {
      await api.stopBot(id);
      notify(`${isAgent ? "Agent" : "Bot"} on ${symbol} stopped${pos ? ". Its open trade stays in Positions: close it there if you want out." : ""}`);
      refresh();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setStopping(false);
    }
  };
  return (
    <div className={`agent-card ${pos ? "holding" : ""}`}>
      <div className="agent-top">
        <span className={`agent-avatar ${pos ? "live" : L && !L.best && isAgent ? "idle" : ""}`}>{pos?.imageUrl ? <img src={pos.imageUrl} alt="" /> : symbol.slice(0, 1).toUpperCase()}</span>
        <span className="agent-name">
          <b>{symbol}</b>
          <small>{modeName(cfg)}{isAgent ? ` · ${fmtUsd(budget)} budget` : ""}</small>
        </span>
        <span className={`agent-pnl ${pnl >= 0 ? "up" : "down"}`}>
          {pnl >= 0 ? "+" : ""}{fmtUsd(pnl)}
          {isAgent ? <small>{((pnl / budget) * 100).toFixed(1)}%</small> : null}
        </span>
      </div>
      <div className="agent-status">{status}</div>
      {isAgent && L ? <div className={`agent-learned ${L.best ? "has" : ""}`}>{L.summary}</div> : null}
      <div className="agent-actions">
        {chain && pool ? <button className="chip" onClick={() => onOpen(chain, pool)}>View chart</button> : null}
        {isAgent && L?.table.length ? <button className="chip" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Hide" : "What it learned"}</button> : null}
        <button className="chip danger" onClick={() => void stop()} disabled={stopping}>{stopping ? "Stopping…" : "Stop"}</button>
      </div>
      {open && L ? (
        <table className="agent-table">
          <thead><tr><th>Pattern</th><th>Chart</th><th className="num">Trades</th><th className="num">Won</th><th className="num">Avg after fees</th></tr></thead>
          <tbody>
            {L.table.map((t) => (
              <tr key={`${t.key}${t.tf}`} className={L.best && t.key === L.best.key && t.tf === L.best.tf ? "best" : ""}>
                <td>{t.label}</td><td>{t.tf}</td><td className="num">{t.trades}</td><td className="num">{t.wins}</td>
                <td className={`num ${t.avgNetPct >= 0 ? "up" : "down"}`}>{t.avgNetPct >= 0 ? "+" : ""}{t.avgNetPct.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function NewAgentModal({ slotId, state, defaults, notify, onClose, onStarted, takenPools }: { slotId: string; state: AppState | null; defaults: Defaults; notify: Notify; onClose: () => void; onStarted: () => void; takenPools: string[] }) {
  const [scan, setScan] = useState<{ scanned: number; pass: number; coins: AgentCoin[] } | null>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<PairInfo | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [budget, setBudget] = useState(String(DEFAULT_BUDGET));
  const [aiCheck, setAiCheck] = useState(true);
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
  const cash = state?.cash ?? 0;
  const amount = Number(budget);
  const taken = pick ? takenPools.includes(pick.pool) : false;
  const problem = !pick ? "Pick a coin" : taken ? `An agent is already trading ${pick.symbol}` : !(amount >= 10) ? "Budget must be at least $10" : amount > cash ? `Only ${fmtUsd(cash)} cash available` : "";
  const start = async () => {
    if (!pick || problem) return;
    setStarting(true);
    try {
      const cfg: BotConfig = {
        ...defaults, chain: pick.chain, pool: pick.pool, symbol: pick.symbol, tf: "5m", checkEverySec: 5, goalUsd: 1e9,
        pick: "agent", budgetUsd: amount, agentAiCheck: aiCheck, strongMode: true, rewardRule: true, disabled: [],
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
          <span className="muted small agent-foot-note">{problem || `It will only invest this budget, in ${pick?.symbol}, on your paper account.`}</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn buy" onClick={() => void start()} disabled={!!problem || starting}>{starting ? "Starting…" : pick ? `Start agent on ${pick.symbol}` : "Start agent"}</button>
        </>
      }>
      <div className="new-agent">
        <p className="muted small">One agent trades one coin. It studies the coin's price history, learns which entry pattern has really made <b>+10% after all fees</b> there, and buys only when that pattern appears. If nothing has paid on that coin, it waits.</p>
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
          <label className="check small">
            <input type="checkbox" checked={aiCheck} onChange={(e) => setAiCheck(e.target.checked)} />
            <span>One AI check before each buy <small className="muted">(a small AI call per trade, not per scan)</small></span>
          </label>
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
