import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, fmtBig, fmtPct, fmtPrice, fmtTime, fmtUsd, type Analysis, type AppState, type BotConfig, type Candle, type PairInfo, type ScanChain, type CheckedOrder, type Position, type ScanResult, type Status, type Timeframe } from "./api";
import { Chart, type ChartLine } from "./Chart";
import { Footer } from "./Footer";
import { BotTradeNotifications, UpdateBanner } from "./Notifications";
import { isMuted, playTradeSound, setMuted, unlockAudioOnFirstGesture } from "./sounds";
import { saveChart, saveScan, saveState, saveUi, savedChart, savedScan, savedState, savedUi } from "./persist";

const TFS: Timeframe[] = ["1s", "5s", "1m", "5m", "15m", "1h", "4h", "1d"];
const isSeconds = (tf: Timeframe) => tf === "1s" || tf === "5s";
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
  const [status, setStatus] = useState<Status | null>(null);
  // Restore the last session instantly (coin, timeframe, tab, last-seen data); live data replaces it moments later.
  const [pair, setPair] = useState<PairInfo | null>(() => savedUi().pair ?? null);
  const [tf, setTf] = useState<Timeframe>(() => savedUi().tf ?? "5m");
  const [candles, setCandles] = useState<Candle[]>(() => {
    const ui = savedUi();
    return ui.pair ? (savedChart(ui.pair.pool, ui.tf ?? "5m")?.candles ?? []) : [];
  });
  const [source, setSource] = useState<{ source: string; note: string } | null>(() => {
    const ui = savedUi();
    const c = ui.pair ? savedChart(ui.pair.pool, ui.tf ?? "5m") : undefined;
    return c ? { source: c.source, note: "" } : null;
  });
  const [state, setState] = useState<AppState | null>(() => savedState() ?? null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [toast, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);
  const [tab, setTab] = useState<"scanner" | "positions" | "trades" | "log">(() => (savedUi().tab as "scanner" | "positions" | "trades" | "log") ?? "scanner");
  useEffect(() => saveUi({ pair: pair ?? undefined, tf, tab }), [pair, tf, tab]);
  useEffect(() => { if (state) saveState(state); }, [state]);

  const notify = useCallback((msg: string, bad = false) => {
    setToast({ msg, bad });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // Re-check status every minute: AI keys, storage, and whether a newer version is deployed.
  useInterval(() => {
    api.status().then(setStatus).catch(() => {});
  }, 60_000);

  useEffect(() => {
    if (savedUi().pair) return; // a coin from last time is already showing
    api.search(DEFAULT_PAIR.query).then((r) => { const p = r.find((x) => x.chain === "solana") ?? r[0]; if (p) setPair(p); }).catch((e) => notify(e.message, true));
  }, [notify]);

  useInterval(() => {
    if (!pair) return;
    api
      .candles(pair.chain, pair.pool, tf)
      .then((r) => {
        setCandles(r.candles);
        setSource({ source: r.source, note: r.note });
        saveChart(pair.pool, tf, r.candles, r.source);
      })
      .catch((e) => setSource({ source: "unavailable", note: e.message }));
    api.pair(pair.chain, pair.pool).then((p) => setPair((cur) => (cur && cur.pool === p.pool ? { ...cur, ...p } : cur))).catch(() => {});
  }, tf === "1s" ? 3_000 : tf === "5s" ? 5_000 : 15_000, [pair?.pool, tf]);

  useInterval(() => {
    api.state().then(setState).catch(() => {});
  }, state?.bot.running ? 2_000 : 5_000, [state?.bot.running]); // faster while the bot trades, so buys/sells show up quickly

  // On Vercel nothing runs between requests, so while this page is open it nudges
  // the bot every 20 s (the server only does work when a step is actually due).
  const botRunning = state?.bot.running ?? false;
  const anyProtected = state?.positions.some((p) => p.protectPct) ?? false;
  useInterval(() => {
    if (status?.serverless && (botRunning || anyProtected)) api.heartbeat().catch(() => {});
  }, 20_000, [status?.serverless, botRunning, anyProtected]);

  const openPool = (chain: string, pool: string) => api.pair(chain, pool).then(selectPair).catch((e) => notify(e.message, true));

  const selectPair = (p: PairInfo) => {
    setPair(p);
    const c = savedChart(p.pool, tf); // show a recently seen chart instantly if we have it
    setCandles(c?.candles ?? []);
    setSource(c ? { source: c.source, note: "" } : null);
    setAnalysis(null);
  };

  // Show the bot's last signal on the chart if it is for this pool.
  const sig = analysis?.consensus ?? (state?.lastSignal?.pool === pair?.pool ? state?.lastSignal?.consensus : undefined);
  const results = analysis?.results ?? (state?.lastSignal?.pool === pair?.pool ? state?.lastSignal?.results : undefined);
  // Chart lines: the bot's open trade on this coin, otherwise Claude's standing orders.
  const lines = useMemo<ChartLine[]>(() => {
    const guarded = state?.positions.find((p) => p.pool === pair?.pool && p.source === "manual" && p.protectPct && p.peak);
    if (guarded)
      return [
        { price: guarded.entryPrice, color: "#00e5ff", title: "BOUGHT" },
        { price: guarded.peak! * (1 - guarded.protectPct! / 100), color: "#ffc857", title: "PROTECT STOP" },
      ];
    const pos = state?.positions.find((p) => p.pool === pair?.pool && p.source === "bot");
    if (pos) {
      const trail = pos.trailPct ?? 3;
      return [
        { price: pos.entryPrice, color: "#00e5ff", title: "BOUGHT" },
        { price: pos.stopLoss ?? 0, color: "#ff3d71", title: "EXIT" },
        pos.trailing && pos.peak ? { price: pos.peak * (1 - trail / 100), color: "#ffc857", title: "TRAILING STOP" } : { price: pos.target ?? 0, color: "#00f5a0", title: "TARGET" },
      ];
    }
    if (!sig?.orders?.length) return [];
    const out: ChartLine[] = sig.orders.map((o) => ({ price: o.triggerPrice, color: "#00e5ff", title: o.kind === "buy_breakout" ? "BUY ABOVE" : "BUY BELOW" }));
    out.push({ price: sig.orders[0].target, color: "#00f5a0", title: "TARGET" }, { price: sig.orders[0].stopLoss, color: "#ff3d71", title: "EXIT" });
    return out;
  }, [state?.positions, pair?.pool, sig]);
  const pairTrades = useMemo(() => (state?.trades ?? []).filter((t) => t.pool === pair?.pool), [state?.trades, pair?.pool]);

  return (
    <div className="app">
      <div className="bg-grid" />
      <TopBar status={status} state={state} onSelect={selectPair} />
      <BotTradeNotifications state={state} onOpen={openPool} />
      <UpdateBanner serverCommit={status?.commit} />
      {status?.storage === "temp" && (
        <div className="banner">
          <b>The bot can't stay on yet.</b> This server has nowhere permanent to save the bot and your paper account, so they reset. Add the free Upstash Redis database in Vercel (Storage tab), then redeploy. Steps are in the README.
        </div>
      )}

      <main className="layout">
        <section className="panel chart-panel">
          <PairHeader pair={pair} tf={tf} setTf={(t) => { if (t !== tf) { setTf(t); setCandles((pair && savedChart(pair.pool, t)?.candles) || []); } }} />
          {candles.length ? <Chart candles={candles} trades={pairTrades} lines={lines} seconds={isSeconds(tf)} viewKey={`${pair?.pool}:${tf}`} /> : <div className="chart empty">{pair ? "Loading candles..." : "Search a ticker to begin"}</div>}
          <div className="legend">
            <span><i style={{ background: "#00e5ff" }} />EMA 9</span>
            <span><i style={{ background: "#b45cff" }} />EMA 21</span>
            {lines.length > 0 && <span className="muted">Dashed lines: Claude's orders and exits</span>}
            {source && (
              <span className={`source ${source.source === "CoinMarketCap" ? "" : "fallback"}`} title={source.note}>
                {isSeconds(tf) && source.source === "CoinMarketCap" && <span className="live-dot" />}
                Data: {source.source}
                {source.source !== "CoinMarketCap" && source.note ? ` · ${source.note}` : ""}
              </span>
            )}
          </div>
        </section>

        <aside className="side">
          <SignalPanel pair={pair} tf={tf} sig={sig} results={results} cost={state?.roundTripCostPct ?? 3} onResult={setAnalysis} notify={notify} hasAI={!!(status?.claude || status?.openai)} multi={!!(status?.claude && status?.openai)} botMinWin={state?.bot.running ? state.bot.config?.minConfidence : undefined} botWaitForHold={state?.bot.running ? state?.bot.config?.waitForHold : undefined} />
          <TradePanel pair={pair} state={state} notify={notify} refresh={() => api.state().then(setState)} />
        </aside>

        <aside className="side">
          <BotPanel pair={pair} tf={tf} state={state} notify={notify} refresh={() => api.state().then(setState)} multi={!!(status?.claude && status?.openai)} onOpen={openPool} alerts={status?.alerts ?? null} />
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
          {tab === "scanner" && <Scanner onSelect={selectPair} notify={notify} tf={tf} />}
          {tab === "positions" && <Positions state={state} notify={notify} refresh={() => api.state().then(setState)} />}
          {tab === "trades" && <Trades state={state} />}
          {tab === "log" && <BotLog state={state} />}
        </section>
      </main>

      <Footer />
      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`}>{toast.msg}</div>}
    </div>
  );
}

// Speaker button before the PAPER MODE chip: mutes/unmutes the bot's trade sounds.
function SoundToggle() {
  const [muted, setMutedState] = useState(isMuted());
  useEffect(() => unlockAudioOnFirstGesture(), []);
  const toggle = () => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) playTradeSound("buy"); // a quick preview so you know sounds are on
  };
  return (
    <button className="sound-toggle" onClick={toggle} aria-pressed={muted} aria-label={muted ? "Unmute trade sounds" : "Mute trade sounds"} title={muted ? "Trade sounds off (click to turn on)" : "Trade sounds on (click to mute)"}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fillOpacity="0.15" />
        {muted ? (
          <line x1="3" y1="3" x2="21" y2="21" />
        ) : (
          <>
            <path d="M15.5 9a4 4 0 0 1 0 6" />
            <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
          </>
        )}
      </svg>
    </button>
  );
}

function TopBar({ status, state, onSelect }: { status: Status | null; state: AppState | null; onSelect: (p: PairInfo) => void }) {
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
        <SoundToggle />
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

const STANCE_LABEL = { BUY_NOW: "BUY NOW", WAIT_FOR_TRIGGER: "WAITING", AVOID: "AVOID" } as const;

// waitForHold: the bot waits for Claude's hold time before buying (off by default: buys instantly).
export function describeOrder(o: CheckedOrder, waitForHold = false) {
  const hold = waitForHold && o.confirmSeconds > 0;
  if (o.kind === "buy_dip") return `Buy ${hold ? "" : "instantly "}if it dips to ${fmtPrice(o.triggerPrice)}${hold ? ` and holds ${o.confirmSeconds}s` : ""}`;
  if (o.kind === "buy_breakout") return `Buy ${hold ? "" : "instantly "}if it breaks above ${fmtPrice(o.triggerPrice)}${hold ? ` for ${o.confirmSeconds}s` : ""}${o.minVolumeRatio ? ` with ${o.minVolumeRatio}× normal volume` : ""}`;
  return `Buy now, paying up to ${fmtPrice(o.triggerPrice)}`;
}

function OrderCard({ o, minWin, waitForHold }: { o: CheckedOrder; minWin?: number; waitForHold?: boolean }) {
  const below = minWin !== undefined && o.winChancePct < minWin;
  return (
    <div className={`order ${below ? "dim" : ""}`}>
      <b>{describeOrder(o, waitForHold)}</b>
      <span className="tiny">
        <b className={below ? "down" : "up"}>{o.winChancePct}% win chance</b> · expected {o.evPct >= 0 ? "+" : ""}
        {o.evPct.toFixed(1)}% per trade after fees{below ? ` · below your ${minWin}% minimum, won't be used` : ""}
      </span>
      <span className="muted tiny">
        Exit below <span className="down">{fmtPrice(o.stopLoss)}</span> · from <span className="up">{fmtPrice(o.target)}</span> it rides the trend · +{o.netRewardPct.toFixed(1)}% after fees vs {o.netRiskPct.toFixed(1)}% risk · max {Math.round(o.maxHoldMinutes)} min
      </span>
    </div>
  );
}

function SignalPanel(props: { pair: PairInfo | null; tf: Timeframe; sig?: Analysis["consensus"]; results?: Analysis["results"]; cost: number; onResult: (a: Analysis) => void; notify: (m: string, bad?: boolean) => void; hasAI: boolean; multi: boolean; botMinWin?: number; botWaitForHold?: boolean }) {
  const { pair, tf, sig, results, cost, onResult, notify, hasAI, multi, botMinWin, botWaitForHold } = props; // (fees are already applied in each order's numbers)
  const [loading, setLoading] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [glow, setGlow] = useState(false);

  // Claude's explanation for the current plan (shown in the (i) popup).
  const okResult = results?.find((x) => x.ok);
  const explain = (() => {
    const why = okResult && okResult.ok ? okResult.signal.reasoning : "";
    const risk = okResult && okResult.ok ? okResult.signal.riskLevel : "";
    const kind = !sig || sig.stance !== "AVOID"
      ? null
      : sig.note.startsWith("No order passed")
        ? { label: "No profit after fees", tone: "hold", text: `Claude found trades, but none make money after the ~${cost.toFixed(1)}% fees and slippage per trade.` }
        : risk === "EXTREME" || risk === "HIGH"
          ? { label: "Too risky right now", tone: "sell", text: "" }
          : { label: "No clear edge", tone: "hold", text: `The coin may be fine, but its moves are too small or unclear to beat the ~${cost.toFixed(1)}% cost of a trade.` };
    return { why, risk, kind };
  })();

  // A new plan makes the (i) glow until it's opened, or for 60 seconds.
  const planKey = sig ? `${sig.expiresAt}:${sig.stance}:${sig.confidence}` : "";
  useEffect(() => {
    if (!planKey || localStorage.getItem("nexus-seen-plan") === planKey) return setGlow(false);
    setGlow(true);
    const id = setTimeout(() => setGlow(false), 60_000);
    return () => clearTimeout(id);
  }, [planKey]);
  const openInfo = () => {
    setInfoOpen(true);
    setGlow(false);
    if (planKey) localStorage.setItem("nexus-seen-plan", planKey);
  };
  useEffect(() => {
    if (!infoOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setInfoOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [infoOpen]);

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
        <span className="title-actions">
          {sig && (explain.why || sig.note) && (
            <button className={`info-btn ${glow ? "glow" : ""}`} onClick={openInfo} aria-label="Why Claude decided this" title="Why Claude decided this">
              i
            </button>
          )}
          <button className="btn ghost" onClick={run} disabled={!pair || loading || !hasAI}>{loading ? "Analyzing…" : "Analyze"}</button>
        </span>
      </div>
      {infoOpen && sig && createPortal(
        <div className="modal-backdrop" onClick={() => setInfoOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="why-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 id="why-title">Why Claude says {STANCE_LABEL[sig.stance ?? "AVOID"]}</h2>
              <button className="chip" onClick={() => setInfoOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="modal-body why-body">
              <div className="why-kind">
                <span className={`tag ${sig.stance === "BUY_NOW" ? "buy" : sig.stance === "AVOID" ? "sell" : "hold"}`}>{STANCE_LABEL[sig.stance ?? "AVOID"]} · {sig.confidence}%</span>
                {explain.kind && <span className={`tag ${explain.kind.tone}`}>{explain.kind.label}</span>}
                {explain.risk && <span className="muted tiny">Risk: {explain.risk}</span>}
              </div>
              {explain.kind?.text && <p>{explain.kind.text}</p>}
              {explain.why && <p><b>Claude:</b> {explain.why}</p>}
              {sig.note && <p className="muted">{sig.note}</p>}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {!hasAI && <p className="muted small">Add <code>ANTHROPIC_API_KEY</code> to <code>server/.env</code> to enable Claude analysis.</p>}
      {sig ? (
        <>
          <div className={`verdict ${sig.stance === "BUY_NOW" ? "buy" : sig.stance === "AVOID" ? "sell" : "hold"}`}>
            <span>{STANCE_LABEL[sig.stance ?? "AVOID"]}</span>
            <div className="conf"><div style={{ width: `${sig.confidence}%` }} /></div>
            <small>{sig.confidence}% confidence</small>
          </div>
          {sig.orders?.length > 0 && (
            <div className="orders">
              <div className="label-sm">Standing orders: the bot buys on its own the moment one triggers</div>
              {sig.orders.map((o, i) => (
                <OrderCard key={i} o={o} minWin={botMinWin} waitForHold={botWaitForHold} />
              ))}
              <div className="muted tiny">
                Plan cancels{sig.cancelBelow > 0 ? ` below ${fmtPrice(sig.cancelBelow)}` : ""}{sig.cancelAbove > 0 ? `${sig.cancelBelow > 0 ? "," : ""} above ${fmtPrice(sig.cancelAbove)}` : ""}{sig.cancelBelow > 0 || sig.cancelAbove > 0 ? " or" : ""} at {fmtTime(sig.expiresAt)}; then Claude makes a new one.
              </div>
            </div>
          )}
          {explain.kind && (
            <div className="why-kind">
              <span className={`tag ${explain.kind.tone}`}>{explain.kind.label}</span>
              {explain.risk && <span className="muted tiny">Risk: {explain.risk}</span>}
            </div>
          )}
          <div className="models">
            {results?.map((r) => (
              <details key={r.model} className="model">
                <summary>
                  <span>{r.model}</span>
                  {r.ok ? <span className={`tag ${r.signal.stance === "BUY_NOW" ? "buy" : r.signal.stance === "AVOID" ? "sell" : "hold"}`}>{STANCE_LABEL[r.signal.stance]} {r.signal.confidence}%</span> : <span className="tag sell">ERROR</span>}
                </summary>
                {r.ok ? <p className="small">{r.signal.reasoning} <span className="muted">Risk: {r.signal.riskLevel}. {(r.ms / 1000).toFixed(1)}s</span></p> : <p className="small down">{r.error}</p>}
              </details>
            ))}
          </div>
        </>
      ) : (
        <p className="muted small">Press Analyze to get Claude's plan: standing orders (buy now, buy the dip, or buy the breakout) with exit prices and targets. {multi ? "Both models must agree on the plan." : "Orders only count if the gain clearly beats the risk after fees."}</p>
      )}
    </div>
  );
}

// "Protect this trade": a trailing stop on a manual position, watched every 5 s on the server.
function ProtectControl({ pos, notify, refresh, compact = false }: { pos: Position; notify: (m: string, bad?: boolean) => void; refresh: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const set = async (pct: number) => {
    setBusy(true);
    try {
      await api.protect(pos.id, pct);
      notify(pct ? `Protecting ${pos.symbol}: sells if it falls ${pct}% from its high` : `Protection removed from ${pos.symbol}`);
      refresh();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  if (pos.protectPct && pos.peak) {
    const stop = pos.peak * (1 - pos.protectPct / 100);
    const lockedPct = ((stop - pos.entryPrice) / pos.entryPrice) * 100;
    return (
      <div className={`protect on ${compact ? "compact" : ""}`}>
        <span>
          🛡 Sells below <b className="mono">{fmtPrice(stop)}</b>
          {!compact && <> ({pos.protectPct}% under its high of {fmtPrice(pos.peak)}; locks in about {lockedPct >= 0 ? "+" : ""}{lockedPct.toFixed(1)}% before fees)</>}
        </span>
        <button className="chip" disabled={busy} onClick={() => set(0)}>Remove</button>
      </div>
    );
  }
  return (
    <div className={`protect ${compact ? "compact" : ""}`}>
      <span>{compact ? "🛡" : "🛡 Protect this trade: sell if it falls"}</span>
      {[3, 5, 10].map((pct) => (
        <button key={pct} className="chip" disabled={busy} onClick={() => set(pct)}>{pct}%</button>
      ))}
      {!compact && <span className="muted tiny">from its high</span>}
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
        <>
          <div className="pos-mini">
            <span>Holding {pos.qty.toPrecision(4)} {pos.symbol}</span>
            <span className={pos.lastPrice >= pos.entryPrice ? "up" : "down"}>{fmtPct(((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100)}</span>
            <button className="chip" onClick={() => sell(0.5)}>Sell 50%</button>
          </div>
          <ProtectControl pos={pos} notify={notify} refresh={refresh} />
        </>
      ) : (
        <p className="muted small">Fees {state?.settings.feePct}% + slippage {state?.settings.slippagePct}% per side are simulated.</p>
      )}
    </div>
  );
}

type RiskKnobs = { positionPct: number; minConfidence: number; analyzeMin: number; maxDrawdownPct: number; breakEvenAtPct: number; trailPct: number; cooldownMin: number; dailyLossPct: number; maxDrop1hPct: number; riskPerTradePct: number };
const PRESETS: Record<"safe" | "balanced" | "aggressive", RiskKnobs & { label: string; blurb: string }> = {
  safe: { label: "Safe", blurb: "Risks 1% of the account per trade, only orders with good odds, tight emergency brake.", positionPct: 50, minConfidence: 55, analyzeMin: 60, maxDrawdownPct: 15, breakEvenAtPct: 4, trailPct: 2, cooldownMin: 60, dailyLossPct: 5, maxDrop1hPct: 7, riskPerTradePct: 1 },
  balanced: { label: "Balanced", blurb: "Risks 1.5% of the account per trade, decent odds required.", positionPct: 90, minConfidence: 45, analyzeMin: 30, maxDrawdownPct: 25, breakEvenAtPct: 6, trailPct: 3, cooldownMin: 30, dailyLossPct: 10, maxDrop1hPct: 10, riskPerTradePct: 1.5 },
  aggressive: { label: "Aggressive", blurb: "Risks 3% per trade, accepts lower odds, wider brake. Bigger swings both ways.", positionPct: 100, minConfidence: 40, analyzeMin: 20, maxDrawdownPct: 40, breakEvenAtPct: 8, trailPct: 5, cooldownMin: 15, dailyLossPct: 15, maxDrop1hPct: 15, riskPerTradePct: 3 },
};
type PresetKey = keyof typeof PRESETS;
const KNOBS: (keyof RiskKnobs)[] = ["positionPct", "minConfidence", "analyzeMin", "maxDrawdownPct", "breakEvenAtPct", "trailPct", "cooldownMin", "dailyLossPct", "maxDrop1hPct", "riskPerTradePct"];
const matchPreset = (k: RiskKnobs): PresetKey | null => (Object.keys(PRESETS) as PresetKey[]).find((p) => KNOBS.every((n) => PRESETS[p][n] === k[n])) ?? null;

// "Started 2:33:51 PM · running 12m 05s" (ticks every second), or "Stopped … · ran …".
function fmtDuration(ms: number) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d) return `${d}d ${h}h ${pad(m)}m`;
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  return `${m}m ${pad(s)}s`;
}

// "Woken 12 s ago by the scheduler": shows the bot is alive even with this page closed.
function LastCheck({ at, by }: { at: number; by: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ago = Math.max(0, Math.round((now - at) / 1000));
  const stale = ago > 90;
  return (
    <span className={`bot-timer ${stale ? "down" : ""}`} title="Each wake-up starts ~1 minute of price checks every 5 s">
      Woken {ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`} ago by the {by}
      {stale ? " · not being woken: set up the scheduler or keep this page open" : ""}
    </span>
  );
}

function BotTimer({ running, startedAt, stoppedAt }: { running: boolean; startedAt: number | null; stoppedAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (!startedAt) return null;
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (running) {
    return (
      <span className="bot-timer">
        Started {clock(startedAt)} · running <b>{fmtDuration(now - startedAt)}</b>
      </span>
    );
  }
  if (!stoppedAt || stoppedAt < startedAt) return null;
  return (
    <span className="bot-timer">
      Stopped {clock(stoppedAt)} · ran {fmtDuration(stoppedAt - startedAt)}
    </span>
  );
}

// Fees and slippage used for every simulated trade (and for Claude's profit checks).
// Set these to your exchange's real costs (e.g. FOMO's) for realistic results.
// Controlled by the popup: saved when the user presses Confirm.
function TradingCosts({ fee, slip, setFee, setSlip }: { fee: string; slip: string; setFee: (v: string) => void; setSlip: (v: string) => void }) {
  const roundTrip = 2 * ((Number(fee) || 0) + (Number(slip) || 0));
  return (
    <>
      <div className="settings-head">
        <span>Trading costs</span>
        <span className="muted tiny">Applies to all trades once confirmed</span>
      </div>
      <div className="grid2 knobs">
        <label>
          Fee per buy or sell (%)
          <input type="number" step="0.1" min="0" value={fee} onChange={(e) => setFee(e.target.value)} />
          <small>What your exchange charges on each side of a trade. Check FOMO's real fee and enter it here.</small>
        </label>
        <label>
          Slippage per buy or sell (%)
          <input type="number" step="0.1" min="0" value={slip} onChange={(e) => setSlip(e.target.value)} />
          <small>How much worse the fill price usually is than the quoted price. Small coins with thin liquidity slip more.</small>
        </label>
      </div>
      <p className="small">
        A buy plus a sell costs about <b>{roundTrip.toFixed(1)}%</b>. A trade has to gain more than that just to break even, so lower costs mean Claude finds more trades worth taking.
      </p>
    </>
  );
}

function BotPanel({ pair, tf, state, notify, refresh, multi, onOpen, alerts = null }: { pair: PairInfo | null; tf: Timeframe; state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void; multi: boolean; onOpen: (chain: string, pool: string) => void; alerts?: "telegram" | "ntfy" | null }) {
  const running = state?.bot.running ?? false;
  const active = state?.bot.config;
  const [mode, setMode] = useState<"this" | "auto">("this");
  const [autoChain, setAutoChain] = useState<ScanChain>("all");
  const [waitForHold, setWaitForHold] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  // Changes in the popup are drafts: Confirm keeps them, Cancel / ✕ / Escape / clicking outside undoes them.
  const [snap, setSnap] = useState<{ cfg: typeof cfg; custom: boolean; waitForHold: boolean } | null>(null);
  const [feeDraft, setFeeDraft] = useState("");
  const [slipDraft, setSlipDraft] = useState("");
  const openRules = (asCustom = false) => {
    setSnap({ cfg, custom, waitForHold });
    setFeeDraft(String(state?.settings.feePct ?? 1));
    setSlipDraft(String(state?.settings.slippagePct ?? 0.5));
    if (asCustom) setCustom(true);
    setRulesOpen(true);
  };
  const cancelRules = () => {
    if (snap) {
      setCfg(snap.cfg);
      setCustom(snap.custom);
      setWaitForHold(snap.waitForHold);
    }
    setRulesOpen(false);
  };
  const confirmRules = async () => {
    const feePct = Number(feeDraft), slippagePct = Number(slipDraft);
    if (!(feePct >= 0 && feePct <= 10 && slippagePct >= 0 && slippagePct <= 10)) return notify("Trading costs must be between 0 and 10%", true);
    const costsChanged = feePct !== (state?.settings.feePct ?? 1) || slippagePct !== (state?.settings.slippagePct ?? 0.5);
    try {
      if (costsChanged) await api.settings({ feePct, slippagePct });
      setRulesOpen(false);
      refresh();
      notify(running ? (costsChanged ? "Trading costs saved." : "No changes: stop the bot to change its settings.") : "Settings confirmed. They'll be used when you start the bot.");
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  useEffect(() => {
    if (!rulesOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancelRules();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rulesOpen, snap]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownMode = running && active ? (active.pick ?? "this") : mode;
  const shownChain = running && active ? (active.autoChain ?? "all") : autoChain;
  const candidates = running ? (state?.bot.candidates ?? []) : [];
  const target = running ? state?.bot.target : null;
  const botPos = state?.positions.find((p) => p.source === "bot");
  const plan = running ? state?.lastSignal : null;
  const planOrders = plan?.consensus.orders ?? [];
  const startCash = state?.startCash ?? 10;
  const [cfg, setCfg] = useState<RiskKnobs & { goalUsd: number }>({ ...PRESETS.balanced, goalUsd: 15 });
  const set = (k: keyof typeof cfg) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setCustom(true);
    setCfg({ ...cfg, [k]: Number(e.target.value) });
  };
  // "Custom" shows the input boxes; picking a preset goes back to the summary view.
  const [custom, setCustom] = useState(false);
  const pick = (p: PresetKey) => {
    setCustom(false);
    setCfg({ ...cfg, ...Object.fromEntries(KNOBS.map((n) => [n, PRESETS[p][n]])) });
  };

  // While running, describe what the bot is actually using.
  const shown: RiskKnobs & { goalUsd: number } =
    running && active ? { positionPct: active.positionPct, minConfidence: active.minConfidence, analyzeMin: Math.round(active.analyzeEverySec / 60), maxDrawdownPct: active.maxDrawdownPct, breakEvenAtPct: active.breakEvenAtPct, trailPct: active.trailPct ?? 3, cooldownMin: active.cooldownMin ?? 30, dailyLossPct: active.dailyLossPct ?? 10, maxDrop1hPct: active.maxDrop1hPct ?? 10, riskPerTradePct: active.riskPerTradePct ?? 1.5, goalUsd: active.goalUsd } : cfg;
  const preset = matchPreset(shown);
  const isCustom = (custom && !running) || !preset;
  const cash = state?.cash ?? startCash;
  const perTrade = (cash * shown.positionPct) / 100;
  const floor = startCash * (1 - shown.maxDrawdownPct / 100);

  const start = async () => {
    if (mode === "this" && !pair) return;
    // In auto mode the chain/pool are placeholders; the bot chooses its own coins.
    const full: BotConfig = { chain: pair?.chain ?? "solana", pool: pair?.pool ?? "", symbol: mode === "auto" ? "AUTO" : (pair?.symbol ?? ""), tf: mode === "auto" ? "5m" : tf, positionPct: cfg.positionPct, minConfidence: cfg.minConfidence, analyzeEverySec: cfg.analyzeMin * 60, checkEverySec: 5, maxDrawdownPct: cfg.maxDrawdownPct, breakEvenAtPct: cfg.breakEvenAtPct, trailPct: cfg.trailPct, goalUsd: cfg.goalUsd, pick: mode, autoChain, autoCandidates: 3, waitForHold, cooldownMin: cfg.cooldownMin, dailyLossPct: cfg.dailyLossPct, maxDrop1hPct: cfg.maxDrop1hPct, riskPerTradePct: cfg.riskPerTradePct };
    try {
      await api.startBot(full);
      notify(mode === "auto" ? `Auto-pick bot started (${preset ? PRESETS[preset].label : "Custom"})` : `Bot started on ${pair?.symbol} (${preset ? PRESETS[preset].label : "Custom"})`);
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
        <div className="pulse-wrap">
          <span className={`pulse ${running ? "on" : ""}`}>{running ? (active?.pick === "auto" ? (target ? `AUTO-PICK → ${target.symbol}` : "AUTO-PICK · SCANNING") : `RUNNING · ${active?.symbol} ${active?.tf}`) : "IDLE"}</span>
          <BotTimer running={running} startedAt={state?.bot.startedAt ?? null} stoppedAt={state?.bot.stoppedAt ?? null} />
          {running && state?.bot.lastWatch && <LastCheck at={state.bot.lastWatch.at} by={state.bot.lastWatch.by} />}
        </div>
      </div>

      <div className="label-row">
        <div className="label-sm">What should it trade?</div>
        <button className="chip" onClick={() => openRules()} aria-haspopup="dialog">
          ⓘ How it trades
        </button>
      </div>
      <div className="presets two" role="radiogroup" aria-label="What to trade">
        <button role="radio" aria-checked={shownMode === "this"} className={`preset balanced ${shownMode === "this" ? "on" : ""}`} onClick={() => setMode("this")} disabled={running}>
          {running && shownMode === "this" ? active?.symbol : `This coin${pair ? ` (${pair.symbol})` : ""}`}
        </button>
        <button role="radio" aria-checked={shownMode === "auto"} className={`preset safe ${shownMode === "auto" ? "on" : ""}`} onClick={() => setMode("auto")} disabled={running}>
          Auto-pick best coin
        </button>
      </div>
      {shownMode === "auto" && (
        <>
          <div className="chain-tabs compact">
            {CHAIN_TABS.map((t) => (
              <button key={t.id} className={`chip ${shownChain === t.id ? "on" : ""}`} onClick={() => setAutoChain(t.id)} disabled={running}>{t.label}</button>
            ))}
          </div>
          <p className="preset-blurb small">Each round it scans trending coins, asks Claude about the top 3 in the buy zone (3 paid calls), and buys the one Claude is most sure about. Skips coins with under $50K liquidity.</p>
        </>
      )}

      {running && state?.bot.blocked && (
        <div className="blocked small">
          <b>Not trading right now:</b> {state.bot.blocked}.
        </div>
      )}
      {running && (
        <div className="bot-status small">
          {botPos ? (
            <div>
              Holding <b>{botPos.symbol}</b>: {fmtPct(((botPos.lastPrice - botPos.entryPrice) / botPos.entryPrice) * 100)} · exit below {botPos.stopLoss ? fmtPrice(botPos.stopLoss) : "–"} ·{" "}
              {botPos.trailing && botPos.peak
                ? `riding the trend: sells below ${fmtPrice(botPos.peak * (1 - (botPos.trailPct ?? 3) / 100))} (high ${fmtPrice(botPos.peak)})`
                : `from ${botPos.target ? fmtPrice(botPos.target) : "the target"} it rides the trend`}
              <button className="chip" onClick={() => onOpen(botPos.chain, botPos.pool)}>View</button>
            </div>
          ) : plan && planOrders.length > 0 && !planOrders.some((o) => o.winChancePct >= (active?.minConfidence ?? 0)) ? (
            <div className="muted">
              Claude's best order for <b>{plan.symbol}</b> has a {Math.max(...planOrders.map((o) => o.winChancePct))}% win chance, below your {active?.minConfidence}% minimum, so none will be used. Next plan by {fmtTime(Math.min(plan.consensus.expiresAt, (state?.bot.lastAnalysisAt ?? 0) + (active?.analyzeEverySec ?? 1800) * 1000))}, sooner if the market moves.
            </div>
          ) : plan && planOrders.length > 0 ? (
            <div>
              Waiting on <b>{plan.symbol}</b>:
              {planOrders.map((o, i) => (
                <div key={i} className="tiny">
                  {state?.bot.armedSince?.[i] ? <b className="up">Triggered, confirming… </b> : "· "}
                  {describeOrder(o, active?.waitForHold)} · {o.winChancePct}% win chance{o.winChancePct < (active?.minConfidence ?? 0) ? " (below your minimum)" : ""}
                </div>
              ))}
              <div className="muted tiny">Plan cancels at {fmtTime(plan.consensus.expiresAt)} or if the price leaves its range; then Claude makes a new one.</div>
              <button className="chip" onClick={() => onOpen(active?.pick === "auto" ? (target?.chain ?? "solana") : active!.chain, plan.pool)}>View</button>
            </div>
          ) : (
            <div className="muted">
              {state?.bot.lastAnalysisAt ? `Claude's last plan (${fmtTime(state.bot.lastAnalysisAt)}): no orders worth placing. It will be asked again by ${fmtTime(state.bot.lastAnalysisAt + (active?.analyzeEverySec ?? 1800) * 1000)}, sooner if the market moves.` : "Starting up: getting Claude's first plan."}
            </div>
          )}
          {candidates.length > 0 && !botPos && (
            <div className="cands">
              {candidates.map((c) => (
                <span key={c.pool} className={`tag ${c.action === "BUY" ? "buy" : c.action === "ERROR" ? "sell" : "hold"}`} title={c.note}>
                  {c.symbol} {c.action}{c.confidence ? ` ${c.confidence}%` : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="presets four" role="radiogroup" aria-label="Risk level">
        {(Object.keys(PRESETS) as PresetKey[]).map((p) => {
          const on = !isCustom && preset === p;
          return (
            <button key={p} role="radio" aria-checked={on} className={`preset ${p} ${on ? "on" : ""}`} onClick={() => pick(p)} disabled={running}>
              {PRESETS[p].label}
            </button>
          );
        })}
        <button role="radio" aria-checked={isCustom} className={`preset custom ${isCustom ? "on" : ""}`} onClick={() => openRules(true)} disabled={running}>
          Custom
        </button>
      </div>


      {rulesOpen && createPortal(
        <div className="modal-backdrop" onClick={cancelRules}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 id="rules-title">How the bot trades{isCustom ? " · Custom" : preset ? ` · ${PRESETS[preset].label}` : ""}</h2>
              <button className="chip" onClick={cancelRules} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="modal-body rules-body">
              <p className="preset-blurb small">{isCustom ? "Your own numbers. Type them below; each box explains what it does." : PRESETS[preset!].blurb}</p>

              <ul className="plan small">
                <li>Sizes each trade so that hitting Claude's exit loses about <b>{shown.riskPerTradePct}%</b> of the account (≈{fmtUsd(((state?.equityNow ?? cash) * shown.riskPerTradePct) / 100)}), never more than {fmtUsd(perTrade)} ({shown.positionPct}% of cash)</li>
                <li>Claude writes standing orders; the bot uses ones with a <b>{shown.minConfidence}%+</b> win chance that make money on average after fees, and buys the moment one triggers (checked every 5 seconds, free)</li>
                <li>Sells below Claude's exit price; once up <b>{shown.breakEvenAtPct}%</b> it can't turn into a loss</li>
                <li>At Claude's target it rides the trend, selling if it falls <b>{shown.trailPct}%</b> from its high</li>
                <li>Asks Claude again after each trade or when the plan expires (backup check every {shown.analyzeMin} min)</li>
                <li>No dip buys while a coin is falling (down more than <b>{shown.maxDrop1hPct}%</b> in an hour, or a 1-hour downtrend)</li>
                <li>After a losing trade, waits <b>{shown.cooldownMin} min</b> before re-buying that coin; skips it for the day after 2 losses in a row</li>
                <li>Stops opening trades for the day after losing <b>{shown.dailyLossPct}%</b> in a day</li>
                <li>Sells everything and stops if the account drops below <b>{fmtUsd(floor)}</b></li>
              </ul>
              <label className="check small">
                <input type="checkbox" checked={running ? Boolean(active?.waitForHold) : waitForHold} onChange={(e) => setWaitForHold(e.target.checked)} disabled={running} />
                <span>
                  Wait for the price to hold before buying
                  <span className="muted tiny"> · Off: buys the instant a trigger price is hit. On: waits the few seconds Claude suggests, so it doesn't buy into a spike or a crash that's still going. Sells are always instant.</span>
                </span>
              </label>

              <div className="settings-head">
                <span>Settings</span>
                <span className="muted tiny">{running ? "Stop the bot to change these." : "Change any number to switch to Custom."}</span>
              </div>
              <div className="grid2 knobs">
                <label>
                  Risk per trade (% of account)
                  <input type="number" step="0.5" value={shown.riskPerTradePct} onChange={set("riskPerTradePct")} disabled={running} />
                  <small>How much one losing trade should cost. The bot sizes each trade from Claude's exit price so that hitting it loses about this much (≈{fmtUsd(((state?.equityNow ?? cash) * shown.riskPerTradePct) / 100)} now). Smaller = survives losing streaks.</small>
                </label>
                <label>
                  Max money per trade (% of cash)
                  <input type="number" value={shown.positionPct} onChange={set("positionPct")} disabled={running} />
                  <small>Upper limit: never more than {shown.positionPct}% of {fmtUsd(cash)} = {fmtUsd(perTrade)} in one trade, even if the exit is very close.</small>
                </label>
                <label>
                  Minimum win chance (%)
                  <input type="number" value={shown.minConfidence} onChange={set("minConfidence")} disabled={running} />
                  <small>For each order, Claude estimates the chance it reaches its target before its exit price. Orders below this aren't used. Every order must also make money on average after fees. Higher = fewer, safer trades.</small>
                </label>
                <label>
                  Backup re-check (minutes)
                  <input type="number" value={shown.analyzeMin} onChange={set("analyzeMin")} disabled={running} />
                  <small>Claude is asked after every trade and whenever its plan expires or the price leaves its range. This is the longest it waits otherwise. Each ask costs a few cents.</small>
                </label>
                <label>
                  Emergency stop if I lose (%)
                  <input type="number" value={shown.maxDrawdownPct} onChange={set("maxDrawdownPct")} disabled={running} />
                  <small>If your {fmtUsd(startCash)} drops below {fmtUsd(floor)}, it sells everything and switches off.</small>
                </label>
                <label>
                  Protect a trade once it's up (%)
                  <input type="number" value={shown.breakEvenAtPct} onChange={set("breakEvenAtPct")} disabled={running} />
                  <small>Once a trade is up this much, the bot won't let it turn into a loss.</small>
                </label>
                <label>
                  Trailing stop (%)
                  <input type="number" value={shown.trailPct} onChange={set("trailPct")} disabled={running} />
                  <small>After Claude's target is reached, it keeps holding while the price climbs and sells if it falls this much from its highest point.</small>
                </label>
                <label>
                  Skip dips if it fell more than (% in 1 hour)
                  <input type="number" value={shown.maxDrop1hPct} onChange={set("maxDrop1hPct")} disabled={running} />
                  <small>A crash is not a dip. If the coin dropped more than this in the last hour (or its 1-hour trend is down), the bot won't buy dips. Breakout buys are still allowed.</small>
                </label>
                <label>
                  Cool-down after a loss (minutes)
                  <input type="number" value={shown.cooldownMin} onChange={set("cooldownMin")} disabled={running} />
                  <small>After a losing trade, the bot won't buy that coin again for this long. After 2 losses in a row it skips the coin for the rest of the day.</small>
                </label>
                <label>
                  Daily loss limit (%)
                  <input type="number" value={shown.dailyLossPct} onChange={set("dailyLossPct")} disabled={running} />
                  <small>If the account loses this much in one day, the bot stops opening new trades until midnight UTC ({new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} your time). Open trades still sell normally.</small>
                </label>
                <label>
                  My target ($)
                  <input type="number" value={shown.goalUsd} onChange={set("goalUsd")} disabled={running} />
                  <small>Just a milestone: the bot notes when you reach it and keeps going.</small>
                </label>
              </div>
              <TradingCosts fee={feeDraft} slip={slipDraft} setFee={setFeeDraft} setSlip={setSlipDraft} />
              <div className="settings-head">
                <span>Phone alerts</span>
                <span className="muted tiny">{alerts ? `On (${alerts === "telegram" ? "Telegram" : "ntfy"})` : "Off"}</span>
              </div>
              <p className="small">
                {alerts
                  ? "You'll get a message for every bot buy and sell, protected sells, the daily loss limit, the emergency stop, and a daily summary after midnight UTC."
                  : "Get a message on your phone for every trade, safety limit and a daily summary: add Telegram or ntfy settings in Vercel (see the README), then redeploy."}
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={cancelRules}>Cancel</button>
              <button className="btn buy" onClick={confirmRules}>Confirm</button>
            </div>
          </div>
        </div>,
        document.body, // render at page level: the panel's blur effect would otherwise trap the popup inside it
      )}
      {running ? (
        <button className="btn sell wide" onClick={stop}>STOP BOT</button>
      ) : (
        <button className="btn buy wide" onClick={start} disabled={mode === "this" && !pair}>{mode === "auto" ? "START AUTO-PICK BOT" : `START BOT ON ${pair?.symbol ?? "…"}`}</button>
      )}
      <p className="muted small">{multi ? "Each AI check calls Claude and ChatGPT (a few cents). The bot buys only when both agree and reward beats risk after fees." : "Claude is in charge. Each check is a paid Claude call (a few cents), and it only buys when reward beats risk after fees."}</p>
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

const CHAIN_TABS: { id: ScanChain; label: string }[] = [
  { id: "all", label: "All chains" },
  { id: "solana", label: "Solana" },
  { id: "base", label: "Base" },
  { id: "ethereum", label: "Ethereum" },
  { id: "bsc", label: "BSC" },
];

function Scanner({ onSelect, notify, tf }: { onSelect: (p: PairInfo) => void; notify: (m: string, bad?: boolean) => void; tf: Timeframe }) {
  const [chain, setChain] = useState<ScanChain>(() => (savedUi().scanChain as ScanChain) ?? "all");
  const [data, setData] = useState<ScanResult | null>(() => savedScan(savedUi().scanChain ?? "all") ?? null);
  const [err, setErr] = useState("");
  const [ai, setAi] = useState<Record<string, Analysis["consensus"] | "loading">>({});

  const load = (c = chain) => {
    saveUi({ scanChain: c });
    setData(savedScan(c) ?? null); // last list for this chain shows instantly, then refreshes
    setErr("");
    const got = (r: ScanResult) => {
      setData(r);
      saveScan(c, r);
    };
    api.scan(c).then(got).catch(() => setTimeout(() => api.scan(c).then(got).catch((e) => setErr(e.message)), 8000));
  };
  useEffect(() => load(chain), [chain]); // eslint-disable-line react-hooks/exhaustive-deps

  const askClaude = async (p: PairInfo) => {
    setAi((m) => ({ ...m, [p.pool]: "loading" }));
    try {
      const r = await api.analyze(p.chain, p.pool, tf);
      setAi((m) => ({ ...m, [p.pool]: r.consensus }));
    } catch (e: any) {
      setAi((m) => {
        const { [p.pool]: _, ...rest } = m;
        return rest;
      });
      notify(e.message, true);
    }
  };

  return (
    <div className="table-wrap">
      <div className="chain-tabs">
        {CHAIN_TABS.map((t) => (
          <button key={t.id} className={`chip ${chain === t.id ? "on" : ""}`} onClick={() => setChain(t.id)}>{t.label}</button>
        ))}
        <button className="chip" onClick={() => load()}>↻ Rescan</button>
      </div>
      <div className="scan-head muted small">
        {data?.source === "boosted" ? (
          <span className="warn">Trending data is busy, so this list shows tokens <b>promoted (paid) on DexScreener</b>. Be extra careful.</span>
        ) : (
          <span>Top trending coins with a quick plan from their live trading stats (free, no AI). Click <b>Ask Claude</b> for a proper plan before buying.</span>
        )}
      </div>
      {err && <p className="down small pad">{err}</p>}
      {!data && !err && <p className="muted small pad">Scanning trending coins…</p>}
      {data && !data.rows.length && <p className="muted small pad">No coins with enough liquidity right now. Try another chain.</p>}
      {data && data.rows.length > 0 && (
        <table className="scan">
          <thead>
            <tr>
              <th>Coin</th>
              <th>Price</th>
              <th className="hide-sm">1h</th>
              <th className="hide-sm">24h</th>
              <th>Signal</th>
              <th title="Buy only at or below this price">Buy below</th>
              <th title="Sell for profit at this price">Sell at</th>
              <th className="hide-sm" title="Get out if price falls below this">Exit if below</th>
              <th className="hide-sm" title="Buy before this time, sell by this time">When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map(({ pair, plan }) => {
              const a = ai[pair.pool];
              const go = plan?.verdict === "BUY ZONE";
              return (
                <tr key={pair.pool} onClick={() => onSelect(pair)}>
                  <td>
                    <b>{pair.symbol}</b>
                    <div className="muted tiny">{pair.chain} · liq {fmtBig(pair.liquidityUsd)}</div>
                  </td>
                  <td className="mono">{fmtPrice(pair.priceUsd)}</td>
                  <td className={`hide-sm ${pair.change.h1 >= 0 ? "up" : "down"}`}>{fmtPct(pair.change.h1)}</td>
                  <td className={`hide-sm ${pair.change.h24 >= 0 ? "up" : "down"}`}>{fmtPct(pair.change.h24)}</td>
                  <td title={plan?.why}>
                    {a && a !== "loading" ? (
                      <span className={`tag ${a.stance === "BUY_NOW" ? "buy" : a.stance === "AVOID" ? "sell" : "hold"}`}>Claude: {STANCE_LABEL[a.stance ?? "AVOID"]} {a.confidence}%</span>
                    ) : (
                      <span className={`tag ${go ? "buy" : plan?.verdict === "AVOID" ? "sell" : "hold"}`}>{plan?.verdict ?? "DATA BUSY"}</span>
                    )}
                    <div className="muted tiny why">{a && a !== "loading" ? a.note : plan?.why}</div>
                  </td>
                  {a && a !== "loading" && a.orders?.length > 0 ? (
                    <>
                      <td className="mono up">{a.orders[0].kind === "buy_breakout" ? "above " : ""}{fmtPrice(a.orders[0].triggerPrice)}</td>
                      <td className="mono up">{fmtPrice(a.orders[0].target)}<div className="muted tiny">then trails</div></td>
                      <td className="mono down hide-sm">{fmtPrice(a.orders[0].stopLoss)}</td>
                      <td className="hide-sm small">plan valid until {fmtTime(a.expiresAt)}{a.orders.length > 1 ? <><br />+1 more order</> : null}</td>
                    </>
                  ) : go && plan && !(a && a !== "loading") ? (
                    <>
                      <td className="mono">{fmtPrice(plan.buyBelow)}</td>
                      <td className="mono up">{fmtPrice(plan.sellAt)}<div className="muted tiny">+{plan.netGainPct.toFixed(1)}% after fees</div></td>
                      <td className="mono down hide-sm">{fmtPrice(plan.exitBelow)}</td>
                      <td className="hide-sm small">buy by {fmtTime(plan.buyBy)}<br />sell by {fmtTime(plan.sellBy)}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="muted small">{a && a !== "loading" ? "Claude: no orders worth placing now." : !plan ? "Chart data is busy. Rescan in a minute, or Ask Claude." : plan.verdict === "AVOID" ? "Don't buy." : "Wait for a clearer setup."}</td>
                  )}
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="chip" disabled={a === "loading"} onClick={() => askClaude(pair)}>{a === "loading" ? "Asking…" : "Ask Claude"}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted tiny pad">Quick plans are chart estimates, not predictions. Prices can move against any plan, especially on small coins.</p>
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
                <td>
                  {p.source === "manual" && <ProtectControl pos={p} notify={notify} refresh={refresh} compact />}
                  <button className="chip" onClick={async () => { try { await api.sell(p.chain, p.pool, p.id, 1); notify(`Closed ${p.symbol}`); refresh(); } catch (e: any) { notify(e.message, true); } }}>Close</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Claude's track record: predicted win chance vs how often bot trades actually reached the target.
function TrackRecord({ state }: { state: AppState | null }) {
  const sells = (state?.trades ?? []).filter((t) => t.source === "bot" && t.side === "SELL");
  if (!sells.length) return null;
  const scored = sells.filter((t) => typeof t.predictedWinPct === "number");
  const pnl = sells.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
  const avgPred = scored.length ? scored.reduce((a, t) => a + t.predictedWinPct!, 0) / scored.length : null;
  const hitRate = scored.length ? (scored.filter((t) => t.reachedTarget).length / scored.length) * 100 : null;
  const profitable = sells.filter((t) => (t.pnlUsd ?? 0) > 0).length;
  return (
    <div className="track">
      <div className="track-title">Claude's track record</div>
      <div className="track-grid">
        <div><small>Bot trades</small><b>{sells.length}</b></div>
        <div><small>Profitable</small><b>{profitable} of {sells.length}</b></div>
        <div><small>Bot P&amp;L</small><b className={pnl >= 0 ? "up" : "down"}>{pnl >= 0 ? "+" : ""}{fmtUsd(pnl)}</b></div>
        <div><small>Claude predicted</small><b>{avgPred === null ? "–" : `${avgPred.toFixed(0)}% win`}</b></div>
        <div><small>Actually reached target</small><b>{hitRate === null ? "–" : `${hitRate.toFixed(0)}%`}</b></div>
      </div>
      <p className="muted tiny">
        {scored.length < 20
          ? `Only ${scored.length} scored trade${scored.length === 1 ? "" : "s"} so far: too few to judge. After 20–30, compare "predicted" with "actually reached": if the real rate stays well below the prediction, Claude's odds are too optimistic for this market.`
          : avgPred !== null && hitRate !== null && hitRate < avgPred - 10
            ? "Claude's odds have been too optimistic: real results are clearly below its predictions. Raise the minimum win chance or trade less."
            : "Real results are close to Claude's predictions so far."}
      </p>
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
      <TrackRecord state={state} />
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
