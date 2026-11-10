import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtBig, fmtPct, fmtPrice, fmtTime, fmtUsd, type Analysis, type AppState, type BotConfig, type Candle, type PairInfo, type Snapshot, type Timeframe } from "./api";
import { Chart } from "./Chart";

const TFS: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
// Official wrapped-SOL mint, so the default never lands on a copycat token.
const DEFAULT_PAIR = { chain: "solana", pool: "", query: "So11111111111111111111111111111111111111112" };

function useInterval(fn: () => void, ms: number, deps: unknown[] = []) {
  useEffect(() => {
    fn();
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export default function App() {
  const [status, setStatus] = useState<{ claude: boolean; openai: boolean } | null>(null);
  const [pair, setPair] = useState<PairInfo | null>(null);
  const [tf, setTf] = useState<Timeframe>("5m");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [source, setSource] = useState<{ source: string; note: string } | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [toast, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);
  const [tab, setTab] = useState<"scanner" | "positions" | "trades" | "log">("scanner");

  const notify = useCallback((msg: string, bad = false) => {
    setToast({ msg, bad });
    setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
    api.search(DEFAULT_PAIR.query).then((r) => { const p = r.find((x) => x.chain === "solana") ?? r[0]; if (p) setPair(p); }).catch((e) => notify(e.message, true));
  }, [notify]);

  useInterval(() => {
    if (!pair) return;
    api
      .candles(pair.chain, pair.pool, tf)
      .then((r) => {
        setCandles(r.candles);
        setSource({ source: r.source, note: r.note });
      })
      .catch((e) => setSource({ source: "unavailable", note: e.message }));
    api.pair(pair.chain, pair.pool).then((p) => setPair((cur) => (cur && cur.pool === p.pool ? { ...cur, ...p } : cur))).catch(() => {});
  }, 15_000, [pair?.pool, tf]);

  useInterval(() => {
    api.state().then(setState).catch(() => {});
  }, 5_000);

  const selectPair = (p: PairInfo) => {
    setPair(p);
    setCandles([]);
    setSource(null);
    setAnalysis(null);
  };

  // Show the bot's last signal on the chart if it is for this pool.
  const sig = analysis?.consensus ?? (state?.lastSignal?.pool === pair?.pool ? state?.lastSignal?.consensus : undefined);
  const results = analysis?.results ?? (state?.lastSignal?.pool === pair?.pool ? state?.lastSignal?.results : undefined);
  const levels = sig && sig.action === "BUY" ? { entry: sig.entryPrice, tp: sig.takeProfit, sl: sig.stopLoss } : {};
  const pairTrades = useMemo(() => (state?.trades ?? []).filter((t) => t.pool === pair?.pool), [state?.trades, pair?.pool]);

  return (
    <div className="app">
      <div className="bg-grid" />
      <TopBar status={status} state={state} onSelect={selectPair} />

      <main className="layout">
        <section className="panel chart-panel">
          <PairHeader pair={pair} tf={tf} setTf={setTf} />
          {candles.length ? <Chart candles={candles} trades={pairTrades} levels={levels} /> : <div className="chart empty">{pair ? "Loading candles..." : "Search a ticker to begin"}</div>}
          <div className="legend">
            <span><i style={{ background: "#00e5ff" }} />EMA 9</span>
            <span><i style={{ background: "#b45cff" }} />EMA 21</span>
            {sig?.action === "BUY" && <span className="muted">Dashed lines: AI entry / take-profit / stop</span>}
            {source && (
              <span className={`source ${source.source === "GeckoTerminal" ? "" : "fallback"}`} title={source.note}>
                Data: {source.source}
                {source.source !== "GeckoTerminal" && source.note ? ` · ${source.note}` : ""}
              </span>
            )}
          </div>
        </section>

        <aside className="side">
          <SignalPanel pair={pair} tf={tf} sig={sig} results={results} cost={state?.roundTripCostPct ?? 3} onResult={setAnalysis} notify={notify} hasAI={!!(status?.claude || status?.openai)} multi={!!(status?.claude && status?.openai)} />
          <TradePanel pair={pair} state={state} notify={notify} refresh={() => api.state().then(setState)} />
        </aside>

        <aside className="side">
          <BotPanel pair={pair} tf={tf} state={state} notify={notify} refresh={() => api.state().then(setState)} multi={!!(status?.claude && status?.openai)} />
          <GoalLadder state={state} />
        </aside>

        <section className="panel bottom">
          <div className="tabs">
            {(["scanner", "positions", "trades", "log"] as const).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t === "scanner" ? "⚡ Opportunities" : t === "positions" ? `Positions (${state?.positions.length ?? 0})` : t === "trades" ? "Trade history" : "Bot log"}
              </button>
            ))}
          </div>
          {tab === "scanner" && <Scanner onSelect={selectPair} />}
          {tab === "positions" && <Positions state={state} notify={notify} refresh={() => api.state().then(setState)} />}
          {tab === "trades" && <Trades state={state} />}
          {tab === "log" && <BotLog state={state} />}
        </section>
      </main>

      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`}>{toast.msg}</div>}
    </div>
  );
}

function TopBar({ status, state, onSelect }: { status: { claude: boolean; openai: boolean } | null; state: AppState | null; onSelect: (p: PairInfo) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<PairInfo[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) return setRes([]);
    const id = setTimeout(() => api.search(q.trim()).then(setRes).catch(() => setRes([])), 300);
    return () => clearTimeout(id);
  }, [q]);

  const eq = state?.equityNow ?? 0;
  const pnl = state ? eq - state.startCash : 0;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">◢◤</span>
        <span>NEXUS<b>//</b>TRADE</span>
      </div>
      <div className="search">
        <input placeholder="Search ticker, name or token address..." value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} />
        {open && res.length > 0 && (
          <div className="dropdown">
            {res.map((p) => (
              <button key={p.pool} onClick={() => { onSelect(p); setQ(""); setOpen(false); }}>
                {p.imageUrl ? <img src={p.imageUrl} alt="" /> : <span className="dot" />}
                <span className="sym">{p.symbol}</span>
                <span className="muted small">{p.chain} · {p.dex} · {p.tokenAddress.slice(0, 4)}…{p.tokenAddress.slice(-4)}</span>
                <span className="right">{fmtPrice(p.priceUsd)}</span>
                <span className="muted small">liq {fmtBig(p.liquidityUsd)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="stats">
        <span className="badge paper">PAPER MODE</span>
        <span className={`ai-dot ${status?.claude ? "on" : ""}`} title="Claude API key">Claude</span>
        {status?.openai && <span className="ai-dot on" title="OpenAI API key">GPT</span>}
        <div className="equity">
          <small>EQUITY</small>
          <b>{fmtUsd(eq)}</b>
          <small className={pnl >= 0 ? "up" : "down"}>{fmtUsd(pnl)}</small>
        </div>
      </div>
    </header>
  );
}

function PairHeader({ pair, tf, setTf }: { pair: PairInfo | null; tf: Timeframe; setTf: (t: Timeframe) => void }) {
  if (!pair) return <div className="pair-head" />;
  return (
    <div className="pair-head">
      <div className="pair-id">
        {pair.imageUrl && <img src={pair.imageUrl} alt="" />}
        <div>
          <h2>{pair.symbol} <span className="muted small">{pair.name}</span></h2>
          <div className="muted small mono">{pair.chain} · {pair.dex} · {pair.pool.slice(0, 6)}…{pair.pool.slice(-4)}</div>
        </div>
        <div className="price">
          <b className="mono">{fmtPrice(pair.priceUsd)}</b>
          <span className={pair.change.h24 >= 0 ? "up" : "down"}>{fmtPct(pair.change.h24)} 24h</span>
        </div>
      </div>
      <div className="kpis">
        <div><small>5m</small><span className={pair.change.m5 >= 0 ? "up" : "down"}>{fmtPct(pair.change.m5)}</span></div>
        <div><small>1h</small><span className={pair.change.h1 >= 0 ? "up" : "down"}>{fmtPct(pair.change.h1)}</span></div>
        <div><small>Vol 24h</small><span>{fmtBig(pair.volume24h)}</span></div>
        <div><small>Liquidity</small><span>{fmtBig(pair.liquidityUsd)}</span></div>
        <div><small>MCap</small><span>{fmtBig(pair.marketCap)}</span></div>
      </div>
      <div className="tf">
        {TFS.map((t) => (
          <button key={t} className={t === tf ? "on" : ""} onClick={() => setTf(t)}>{t}</button>
        ))}
      </div>
    </div>
  );
}

function SignalPanel(props: { pair: PairInfo | null; tf: Timeframe; sig?: Analysis["consensus"]; results?: Analysis["results"]; cost: number; onResult: (a: Analysis) => void; notify: (m: string, bad?: boolean) => void; hasAI: boolean; multi: boolean }) {
  const { pair, tf, sig, results, cost, onResult, notify, hasAI, multi } = props;
  const [loading, setLoading] = useState(false);
  const run = async () => {
    if (!pair) return;
    setLoading(true);
    try {
      onResult(await api.analyze(pair.chain, pair.pool, tf));
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="panel">
      <div className="panel-title">
        <span>AI SIGNAL</span>
        <button className="btn ghost" onClick={run} disabled={!pair || loading || !hasAI}>{loading ? "Analyzing…" : "Analyze"}</button>
      </div>
      {!hasAI && <p className="muted small">Add <code>ANTHROPIC_API_KEY</code> to <code>server/.env</code> to enable Claude analysis.</p>}
      {sig ? (
        <>
          <div className={`verdict ${sig.action.toLowerCase()}`}>
            <span>{sig.action}</span>
            <div className="conf"><div style={{ width: `${sig.confidence}%` }} /></div>
            <small>{sig.confidence}% confidence</small>
          </div>
          {sig.action === "BUY" && (
            <div className="levels">
              <div><small>Entry ≤</small><b className="mono">{fmtPrice(sig.entryPrice)}</b><small>buy by {fmtTime(sig.buyBy)}</small></div>
              <div><small>Take profit</small><b className="mono up">{fmtPrice(sig.takeProfit)}</b><small>sell by {fmtTime(sig.sellBy)}</small></div>
              <div><small>Stop</small><b className="mono down">{fmtPrice(sig.stopLoss)}</b><small>net risk {sig.netRiskPct.toFixed(1)}%</small></div>
            </div>
          )}
          <p className="note">{sig.note} {sig.action === "BUY" && <>Net reward after {cost.toFixed(1)}% costs: <b className="up">{sig.netRewardPct.toFixed(1)}%</b>.</>}</p>
          <div className="models">
            {results?.map((r) => (
              <details key={r.model} className="model">
                <summary>
                  <span>{r.model}</span>
                  {r.ok ? <span className={`tag ${r.signal.action.toLowerCase()}`}>{r.signal.action} {r.signal.confidence}%</span> : <span className="tag sell">ERROR</span>}
                </summary>
                {r.ok ? <p className="small">{r.signal.reasoning} <span className="muted">Risk: {r.signal.riskLevel}. {(r.ms / 1000).toFixed(1)}s</span></p> : <p className="small down">{r.error}</p>}
              </details>
            ))}
          </div>
        </>
      ) : (
        <p className="muted small">Run an analysis to get entry, take-profit and stop levels plus buy-by / sell-by times. {multi ? "Both models must agree before anything is called a BUY." : "Claude only calls BUY when the reward clearly beats the risk after fees."}</p>
      )}
    </div>
  );
}

function TradePanel({ pair, state, notify, refresh }: { pair: PairInfo | null; state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void }) {
  const [usd, setUsd] = useState("5");
  const pos = state?.positions.find((p) => p.pool === pair?.pool && p.source === "manual");
  const buy = async () => {
    if (!pair) return;
    try {
      await api.buy(pair.chain, pair.pool, Number(usd));
      notify(`Bought ${fmtUsd(Number(usd))} of ${pair.symbol} (paper)`);
      refresh();
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  const sell = async (f: number) => {
    if (!pair || !pos) return;
    try {
      await api.sell(pair.chain, pair.pool, pos.id, f);
      notify(`Sold ${f * 100}% of ${pair.symbol} (paper)`);
      refresh();
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  const cash = state?.cash ?? 0;
  return (
    <div className="panel">
      <div className="panel-title"><span>MANUAL TRADE</span><span className="muted small">cash {fmtUsd(cash)}</span></div>
      <div className="amount">
        <span>$</span>
        <input type="number" min="1" step="1" value={usd} onChange={(e) => setUsd(e.target.value)} />
        {[25, 50, 100].map((p) => (
          <button key={p} className="chip" onClick={() => setUsd(((cash * p) / 100).toFixed(2))}>{p}%</button>
        ))}
      </div>
      <div className="row">
        <button className="btn buy" onClick={buy} disabled={!pair}>BUY {pair?.symbol}</button>
        <button className="btn sell" onClick={() => sell(1)} disabled={!pos}>SELL ALL</button>
      </div>
      {pos ? (
        <div className="pos-mini">
          <span>Holding {pos.qty.toPrecision(4)} {pos.symbol}</span>
          <span className={pos.lastPrice >= pos.entryPrice ? "up" : "down"}>{fmtPct(((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100)}</span>
          <button className="chip" onClick={() => sell(0.5)}>Sell 50%</button>
        </div>
      ) : (
        <p className="muted small">Fees {state?.settings.feePct}% + slippage {state?.settings.slippagePct}% per side are simulated.</p>
      )}
    </div>
  );
}

function BotPanel({ pair, tf, state, notify, refresh, multi }: { pair: PairInfo | null; tf: Timeframe; state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void; multi: boolean }) {
  const running = state?.bot.running ?? false;
  const active = state?.bot.config;
  const [cfg, setCfg] = useState({ positionPct: 90, minConfidence: 70, analyzeMin: 15, maxDrawdownPct: 25, breakEvenAtPct: 6, goalUsd: 15 });
  const set = (k: keyof typeof cfg) => (e: React.ChangeEvent<HTMLInputElement>) => setCfg({ ...cfg, [k]: Number(e.target.value) });

  const start = async () => {
    if (!pair) return;
    const full: BotConfig = { chain: pair.chain, pool: pair.pool, symbol: pair.symbol, tf, positionPct: cfg.positionPct, minConfidence: cfg.minConfidence, analyzeEverySec: cfg.analyzeMin * 60, checkEverySec: 20, maxDrawdownPct: cfg.maxDrawdownPct, breakEvenAtPct: cfg.breakEvenAtPct, goalUsd: cfg.goalUsd };
    try {
      await api.startBot(full);
      notify(`Bot started on ${pair.symbol}`);
      refresh();
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  const stop = async () => {
    await api.stopBot();
    refresh();
  };

  return (
    <div className={`panel bot ${running ? "live" : ""}`}>
      <div className="panel-title">
        <span>AUTO-PILOT</span>
        <span className={`pulse ${running ? "on" : ""}`}>{running ? `RUNNING · ${active?.symbol} ${active?.tf}` : "IDLE"}</span>
      </div>
      <div className="grid2">
        <label>Position size %<input type="number" value={cfg.positionPct} onChange={set("positionPct")} disabled={running} /></label>
        <label>Min confidence<input type="number" value={cfg.minConfidence} onChange={set("minConfidence")} disabled={running} /></label>
        <label>AI check every (min)<input type="number" value={cfg.analyzeMin} onChange={set("analyzeMin")} disabled={running} /></label>
        <label>Kill-switch drawdown %<input type="number" value={cfg.maxDrawdownPct} onChange={set("maxDrawdownPct")} disabled={running} /></label>
        <label>Lock break-even at +%<input type="number" value={cfg.breakEvenAtPct} onChange={set("breakEvenAtPct")} disabled={running} /></label>
        <label>Goal $<input type="number" value={cfg.goalUsd} onChange={set("goalUsd")} disabled={running} /></label>
      </div>
      {running ? (
        <button className="btn sell wide" onClick={stop}>STOP BOT</button>
      ) : (
        <button className="btn buy wide" onClick={start} disabled={!pair}>START BOT ON {pair?.symbol ?? "…"}</button>
      )}
      <p className="muted small">{multi ? "Each AI check calls both models (costs a few cents). The bot buys only when both agree, the price is at the planned entry, and reward beats risk after fees." : "Claude is in charge: each check asks Claude (costs a few cents). The bot buys only when Claude says BUY with enough confidence, the price is at the planned entry, and reward beats risk after fees."}</p>
    </div>
  );
}

function GoalLadder({ state }: { state: AppState | null }) {
  const eq = state?.equityNow ?? 0;
  const start = state?.startCash ?? 10;
  const steps = [start, start * 1.5, start * 2, start * 10, start * 100];
  const [cash, setCash] = useState("10");
  return (
    <div className="panel">
      <div className="panel-title"><span>GROWTH LADDER</span><span className="muted small">peak {fmtUsd(state?.peakEquity ?? 0)}</span></div>
      <div className="ladder">
        {steps.map((s, i) => {
          const pct = Math.max(0, Math.min(100, (eq / s) * 100));
          return (
            <div key={i} className={`rung ${eq >= s ? "done" : ""}`}>
              <span className="mono">{fmtUsd(s, 0)}</span>
              <div className="bar"><div style={{ width: `${pct}%` }} /></div>
              <small>{pct.toFixed(0)}%</small>
            </div>
          );
        })}
      </div>
      <div className="row reset">
        <span className="muted small">Reset paper account to</span>
        <input type="number" value={cash} onChange={(e) => setCash(e.target.value)} />
        <button className="chip" onClick={() => confirm("Reset the paper account? Trade history will be cleared.") && api.reset(Number(cash))}>Reset</button>
      </div>
    </div>
  );
}

function Scanner({ onSelect }: { onSelect: (p: PairInfo) => void }) {
  const [rows, setRows] = useState<{ pair: PairInfo; snap: Snapshot | null }[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => {
    setRows(null);
    setErr("");
    api.scan().then(setRows).catch(() => setTimeout(() => api.scan().then(setRows).catch((e) => setErr(e.message)), 8000));
  };
  useEffect(load, []);
  if (err) return <p className="down small pad">{err}</p>;
  if (!rows) return <p className="muted small pad">Scanning trending Solana pools…</p>;
  return (
    <div className="table-wrap">
      <div className="scan-head muted small">Trending pools ranked by a quick technical score (no AI cost). Click one, then press <b>Analyze</b> for a real entry/exit plan. <button className="chip" onClick={load}>Rescan</button></div>
      <table>
        <thead><tr><th>Token</th><th>Price</th><th>5m</th><th>1h</th><th>24h</th><th className="hide-sm">Liquidity</th><th className="hide-sm">RSI</th><th>Score</th><th /></tr></thead>
        <tbody>
          {rows.map(({ pair, snap }) => {
            const score = snap?.techScore;
            const label = score == null ? "n/a" : score >= 50 ? "WATCH BUY" : score <= -30 ? "AVOID" : "NEUTRAL";
            return (
              <tr key={pair.pool} onClick={() => onSelect(pair)}>
                <td><b>{pair.symbol}</b></td>
                <td className="mono">{fmtPrice(pair.priceUsd)}</td>
                <td className={pair.change.m5 >= 0 ? "up" : "down"}>{fmtPct(pair.change.m5)}</td>
                <td className={pair.change.h1 >= 0 ? "up" : "down"}>{fmtPct(pair.change.h1)}</td>
                <td className={pair.change.h24 >= 0 ? "up" : "down"}>{fmtPct(pair.change.h24)}</td>
                <td className="hide-sm">{fmtBig(pair.liquidityUsd)}</td>
                <td className="hide-sm">{snap ? snap.rsi14.toFixed(0) : "–"}</td>
                <td><span className={`tag ${label === "WATCH BUY" ? "buy" : label === "AVOID" ? "sell" : "hold"}`}>{label}{score != null ? ` ${score}` : ""}</span></td>
                <td><button className="chip">Open →</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Positions({ state, notify, refresh }: { state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void }) {
  if (!state?.positions.length) return <p className="muted small pad">No open positions.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Token</th><th>By</th><th>Entry</th><th>Now</th><th>P&L</th><th className="hide-sm">TP / SL</th><th className="hide-sm">Sell by</th><th /></tr></thead>
        <tbody>
          {state.positions.map((p) => {
            const value = p.qty * p.lastPrice;
            const pnl = value - p.costUsd;
            return (
              <tr key={p.id}>
                <td><b>{p.symbol}</b></td>
                <td>{p.source === "bot" ? "🤖 bot" : "manual"}</td>
                <td className="mono">{fmtPrice(p.entryPrice)}</td>
                <td className="mono">{fmtPrice(p.lastPrice)}</td>
                <td className={pnl >= 0 ? "up" : "down"}>{fmtUsd(pnl)} ({fmtPct((pnl / p.costUsd) * 100)})</td>
                <td className="hide-sm mono">{p.takeProfit ? fmtPrice(p.takeProfit) : "–"} / {p.stopLoss ? fmtPrice(p.stopLoss) : "–"}</td>
                <td className="hide-sm">{p.sellBy ? fmtTime(p.sellBy) : "–"}</td>
                <td><button className="chip" onClick={async () => { try { await api.sell(p.chain, p.pool, p.id, 1); notify(`Closed ${p.symbol}`); refresh(); } catch (e: any) { notify(e.message, true); } }}>Close</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Trades({ state }: { state: AppState | null }) {
  if (!state?.trades.length) return <p className="muted small pad">No trades yet.</p>;
  const closed = state.trades.filter((t) => t.pnlUsd != null);
  const wins = closed.filter((t) => t.pnlUsd! > 0).length;
  const fees = state.trades.reduce((s, t) => s + t.feeUsd, 0);
  return (
    <div className="table-wrap">
      <div className="scan-head muted small">Win rate {closed.length ? ((wins / closed.length) * 100).toFixed(0) : 0}% over {closed.length} closed trades · fees paid {fmtUsd(fees)}</div>
      <table>
        <thead><tr><th>Time</th><th>Side</th><th>Token</th><th>Price</th><th>USD</th><th>P&L</th><th className="hide-sm">Reason</th></tr></thead>
        <tbody>
          {state.trades.slice(0, 100).map((t) => (
            <tr key={t.id}>
              <td>{fmtTime(t.time)}</td>
              <td className={t.side === "BUY" ? "up" : "down"}>{t.side}{t.source === "bot" ? " 🤖" : ""}</td>
              <td>{t.symbol}</td>
              <td className="mono">{fmtPrice(t.price)}</td>
              <td>{fmtUsd(t.usd)}</td>
              <td className={t.pnlUsd == null ? "" : t.pnlUsd >= 0 ? "up" : "down"}>{t.pnlUsd == null ? "–" : fmtUsd(t.pnlUsd)}</td>
              <td className="hide-sm muted">{t.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BotLog({ state }: { state: AppState | null }) {
  if (!state?.bot.log.length) return <p className="muted small pad">Bot hasn't run yet.</p>;
  return (
    <div className="log">
      {state.bot.log.map((l, i) => (
        <div key={i} className={l.level}><span className="muted mono">{new Date(l.t).toLocaleTimeString()}</span> {l.msg}</div>
      ))}
    </div>
  );
}
