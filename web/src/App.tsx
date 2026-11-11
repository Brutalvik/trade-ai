import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { aiText, api, fmtBig, fmtPct, fmtPrice, fmtTime, fmtUsd, type Analysis, type AppState, type PlanInfo, type User, type BotConfig, type Candle, type PairInfo, type ScanChain, type CheckedOrder, type NewCoin, type Position, type ScanResult, type Status, type Timeframe } from "./api";
import { Chart, type ChartLine } from "./Chart";
import { Footer } from "./Footer";
import { AccessCtx, AccountButton, AdminModal, LockChip, PlansModal, SettingsButton, useAccess, type Access } from "./Account";
import { BotTradeNotifications, UpdateBanner } from "./Notifications";
import { isMuted, playTradeSound, setMuted, unlockAudioOnFirstGesture } from "./sounds";
import { saveAnalysis, saveChart, saveScan, saveState, saveUi, savedAnalysis, savedChart, savedScan, savedState, savedUi, type SavedAnalysis } from "./persist";

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
  // Who's signed in, with their plan, role, permissions and AI token use (RBAC).
  const [me, setMe] = useState<User | null>(null);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [plansOpen, setPlansOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const loadMe = useCallback(() => api.me().then((r) => setMe(r.user)).catch(() => setMe(null)), []);
  useEffect(() => {
    void loadMe();
    void api.plans().then(setPlans).catch(() => {});
    const id = setInterval(() => void loadMe(), 60_000); // keeps the token meter current
    return () => clearInterval(id);
  }, [loadMe]);
  const access = useMemo<Access & { plans: PlanInfo[] }>(
    () => ({ me, plans, can: (perm) => (me ? (me.permissions ?? []).includes(perm) : true), openPlans: () => setPlansOpen(true), openAdmin: () => setAdminOpen(true) }),
    [me, plans],
  );
  // Restore the last session instantly (coin, timeframe, tab, last-seen data); live data replaces it moments later.
  const [pair, setPair] = useState<PairInfo | null>(() => savedUi().pair ?? null);
  const [tf, setTf] = useState<Timeframe>(() => savedUi().tf ?? "5m");
  const [candles, setCandles] = useState<Candle[]>(() => {
    const ui = savedUi();
    return ui.pair ? (savedChart(ui.pair.pool, ui.tf ?? "5m")?.candles ?? []) : [];
  });
  const [, setSource] = useState<{ source: string; note: string } | null>(() => {
    const ui = savedUi();
    const c = ui.pair ? savedChart(ui.pair.pool, ui.tf ?? "5m") : undefined;
    return c ? { source: c.source, note: "" } : null;
  });
  const [state, setState] = useState<AppState | null>(() => savedState() ?? null);
  // Claude's last plan for the coin on screen: kept per coin, so coming back to a coin shows it
  // again without paying for a new analysis.
  const [analysis, setAnalysis] = useState<SavedAnalysis | null>(() => { const p = savedUi().pair; return (p && savedAnalysis(p.pool)) || null; });
  const gotAnalysis = useCallback((a: Analysis) => setAnalysis(saveAnalysis(a.pair.pool, a)), []);
  const [toast, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);
  const [tab, setTab] = useState<"scanner" | "newcoins" | "positions" | "trades" | "log">(() => (savedUi().tab as "scanner" | "newcoins" | "positions" | "trades" | "log") ?? "scanner");
  useEffect(() => saveUi({ pair: pair ?? undefined, tf, tab }), [pair, tf, tab]);
  useEffect(() => { if (state) saveState(state); }, [state]);
  // Chart maximize: fills the window; Esc (or the button) brings it back.
  const [chartMax, setChartMax] = useState(false);
  useEffect(() => {
    if (!chartMax) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setChartMax(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [chartMax]);

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
  const anyProtected = (state?.positions.some((p) => p.protectPct) || (state?.orders?.length ?? 0) > 0) ?? false; // protected trades or limit orders to watch
  useInterval(() => {
    if (status?.serverless && (botRunning || anyProtected)) api.heartbeat().catch(() => {});
  }, 20_000, [status?.serverless, botRunning, anyProtected]);

  const openPool = (chain: string, pool: string) => api.pair(chain, pool).then(selectPair).catch((e) => notify(e.message, true));

  const selectPair = (p: PairInfo) => {
    setPair(p);
    const c = savedChart(p.pool, tf); // show a recently seen chart instantly if we have it
    setCandles(c?.candles ?? []);
    setSource(c ? { source: c.source, note: "" } : null);
    setAnalysis(savedAnalysis(p.pool) ?? null);
  };

  // Show the bot's last signal on the chart if it is for this pool.
  // Whichever is newer: your saved analysis of this coin, or the bot's latest plan for it.
  const botSig = state?.lastSignal?.pool === pair?.pool ? state?.lastSignal : null;
  // A plan you saved before the latest trade on this coin is outdated: every new trade
  // starts from a fresh analysis.
  const lastTradeAt = useMemo(() => Math.max(0, ...(state?.trades ?? []).filter((t) => t.pool === pair?.pool).map((t) => t.time)), [state?.trades, pair?.pool]);
  const savedPlan = analysis && analysis.at >= lastTradeAt ? analysis : null;
  const shownPlan = savedPlan && (!botSig || savedPlan.at >= botSig.at) ? savedPlan : botSig;
  const sig = shownPlan?.consensus;
  const results = shownPlan?.results;
  const planRisk = useMemo(() => {
    const ok = results?.find((r) => r.ok);
    const level = ok && ok.ok ? ok.signal.riskLevel : undefined;
    const reasons: string[] = [];
    if (level === "HIGH" || level === "EXTREME") reasons.push(`The AI rates this coin ${level} risk.`);
    if (sig?.stance === "AVOID") reasons.push("The AI's current advice is to stay out.");
    if ((botSig?.trendDown ?? false) || (pair?.change.h1 ?? 0) <= -10) reasons.push(`It's falling (1-hour change ${fmtPct(pair?.change.h1 ?? 0)}${botSig?.trendDown ? ", 1-hour trend down" : ""}).`);
    if ((pair?.liquidityUsd ?? Infinity) < 50_000) reasons.push(`Liquidity is thin (${fmtBig(pair?.liquidityUsd ?? 0)}): prices can jump and fills slip.`);
    return reasons;
  }, [results, sig?.stance, botSig?.trendDown, pair?.change.h1, pair?.liquidityUsd]);
  const botOnThisCoin = !!(state?.bot.running && state.bot.config?.pool === pair?.pool && state.bot.config?.pick === "this");
  // Chart lines: the bot's open trade on this coin, otherwise Claude's standing orders.
  const orderLines = useMemo<ChartLine[]>(
    () => (state?.orders ?? []).filter((x) => x.pool === pair?.pool).map((x) => ({ price: x.price, color: x.side === "BUY" ? "#7cf7ff" : "#ffb86b", title: x.side === "BUY" ? "LIMIT BUY" : "LIMIT SELL" })),
    [state?.orders, pair?.pool],
  );
  const planLines = useMemo<ChartLine[]>(() => {
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
  const lines = useMemo(() => [...planLines, ...orderLines], [planLines, orderLines]);
  const pairTrades = useMemo(() => (state?.trades ?? []).filter((t) => t.pool === pair?.pool), [state?.trades, pair?.pool]);

  return (
    <AccessCtx.Provider value={access}>
    <div className="app">
      <div className="bg-grid" />
      <TopBar status={status} state={state} onSelect={selectPair} notify={notify} refresh={() => { void api.state().then(setState); void loadMe(); }} />
      <BotTradeNotifications state={state} onOpen={openPool} />
      <UpdateBanner serverCommit={status?.commit} />
      {state?.signedOut && (
        <div className="banner signed-out">
          <b>You're signed out.</b> Your paper account, trades and bot are hidden. Sign in (top right) to see them and trade.
        </div>
      )}
      {status?.storage === "temp" && (
        <div className="banner">
          <b>The bot can't stay on yet.</b> This server has nowhere permanent to save the bot and your paper account, so they reset. Add the free Upstash Redis database in Vercel (Storage tab), then redeploy. Steps are in the README.
        </div>
      )}

      <main className="layout">
        <section className={`panel chart-panel ${chartMax ? "maximized" : ""}`}>
          <PairHeader pair={pair} tf={tf} setTf={(t) => { if (t !== tf) { setTf(t); setCandles((pair && savedChart(pair.pool, t)?.candles) || []); } }} />
          {candles.length ? <Chart candles={candles} trades={pairTrades} lines={lines} seconds={isSeconds(tf)} viewKey={`${pair?.pool}:${tf}`} /> : <div className="chart empty">{pair ? "Loading candles..." : "Search a ticker to begin"}</div>}
          <div className="legend">
            <button className="chart-size-btn" onClick={() => setChartMax((v) => !v)} aria-pressed={chartMax} title={chartMax ? "Minimize (Esc)" : "Fill the window"} aria-label={chartMax ? "Minimize chart" : "Maximize chart"}>
              {chartMax ? (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
              )}
              {chartMax ? "Minimize" : "Maximize"}
            </button>
            <span><i style={{ background: "#00e5ff" }} />EMA 9</span>
            <span><i style={{ background: "#b45cff" }} />EMA 21</span>
            {lines.filter((l, i) => l.price > 0 && lines.findIndex((x) => x.title === l.title) === i).map((l) => (
              <span key={l.title} title={LINE_HELP[l.title] ?? ""}>
                <i className="dash" style={{ borderColor: l.color }} />
                {LINE_NAME[l.title] ?? l.title} {fmtPrice(l.price)}
              </span>
            ))}
          </div>
        </section>

        <aside className="side">
          <SignalPanel pair={pair} tf={tf} sig={sig} results={results} cost={state?.roundTripCostPct ?? 3} onResult={gotAnalysis} price={candles.at(-1)?.close ?? pair?.priceUsd} botOnThisCoin={botOnThisCoin} analyzedAt={shownPlan?.at} notify={notify} hasAI={!!(status?.claude || status?.openai)} multi={!!(status?.claude && status?.openai)} botMinWin={state?.bot.running ? state.bot.config?.minConfidence : undefined} botWaitForHold={state?.bot.running ? state?.bot.config?.waitForHold : undefined} />
          <TradePanel pair={pair} state={state} notify={notify} refresh={() => api.state().then(setState)} />
        </aside>

        <aside className="side">
          <BotPanel pair={pair} tf={tf} state={state} notify={notify} refresh={() => api.state().then(setState)} multi={!!(status?.claude && status?.openai)} onOpen={openPool} alerts={status?.alerts ?? null} riskReasons={planRisk} />
          <GoalLadder state={state} />
        </aside>

        <section className="panel bottom">
          <div className="tabs">
            {(["scanner", "newcoins", "positions", "trades", "log"] as const).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t === "scanner" ? "⚡ Opportunities" : t === "newcoins" ? "🚀 New coins" : t === "positions" ? `Positions (${state?.positions.length ?? 0})` : t === "trades" ? "Trade history" : "Bot log"}
              </button>
            ))}
          </div>
          {tab === "scanner" && <Scanner onSelect={selectPair} notify={notify} tf={tf} />}
          {tab === "newcoins" && <NewCoins onSelect={selectPair} />}
          {tab === "positions" && <Positions state={state} notify={notify} refresh={() => api.state().then(setState)} />}
          {tab === "trades" && <Trades state={state} />}
          {tab === "log" && <BotLog state={state} />}
        </section>
      </main>

      <Footer />
      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`}>{toast.msg}</div>}
      {plansOpen && <PlansModal onClose={() => setPlansOpen(false)} />}
      {adminOpen && <AdminModal onClose={() => { setAdminOpen(false); void loadMe(); }} notify={notify} />}
    </div>
    </AccessCtx.Provider>
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

function TopBar({ status, state, onSelect, notify, refresh }: { status: Status | null; state: AppState | null; onSelect: (p: PairInfo) => void; notify: (m: string, bad?: boolean) => void; refresh: () => void }) {
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
        <SettingsButton alerts={status?.alerts ?? null} continuous={!!state?.settings.continuous} onSaved={refresh} notify={notify} />
        <SoundToggle />
        <span className="badge paper">PAPER MODE</span>
        <span className={`ai-dot ${status?.claude ? "on" : ""}`} title="AI key">AI</span>
        {status?.openai && <span className="ai-dot on" title="OpenAI API key">GPT</span>}
        <div className="equity">
          <small>EQUITY</small>
          <b>{fmtUsd(eq)}</b>
          <small className={pnl >= 0 ? "up" : "down"}>{fmtUsd(pnl)}</small>
        </div>
        <AccountButton notify={notify} onChange={refresh} state={state} />
      </div>
    </header>
  );
}

// Copies the full contract (token) address; shows a check mark for a moment.
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older browsers / no permission: fall back to a hidden text box.
      const t = document.createElement("textarea");
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button className={`copy-btn ${done ? "done" : ""}`} onClick={copy} data-tip={done ? "Copied" : "Copy"} aria-label={done ? "Copied" : "Copy contract address"}>
      {done ? (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </button>
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
          <div className="muted small mono addr-line">
            {pair.chain} · {pair.dex} · <span title={pair.tokenAddress || pair.pool}>{(pair.tokenAddress || pair.pool).slice(0, 6)}…{(pair.tokenAddress || pair.pool).slice(-4)}</span>
            <CopyButton text={pair.tokenAddress || pair.pool} />
          </div>
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
    <div className={`order ${below ? "dim" : ""} ${o.warning ? "risky" : ""}`}>
      <b>{describeOrder(o, waitForHold)}</b>
      <span className="tiny">
        <b className={below ? "down" : "up"}>{o.winChancePct}% win chance</b> <PredictionInfo pct={o.winChancePct} /> · expected {o.evPct >= 0 ? "+" : ""}
        {o.evPct.toFixed(1)}% per trade after fees{below ? ` · below your ${minWin}% minimum, won't be used` : ""}
      </span>
      <span className="muted tiny">
        Exit below <span className="down">{fmtPrice(o.stopLoss)}</span> · from <span className="up">{fmtPrice(o.target)}</span> it rides the trend · +{o.netRewardPct.toFixed(1)}% after fees vs {o.netRiskPct.toFixed(1)}% risk · max {Math.round(o.maxHoldMinutes)} min
      </span>
      {o.warning && <span className="order-warning">⚠ Risky: {o.warning.replace(/^Fails the fee\/risk check: /, "it ")} The bot uses it only if you start it and choose "I understand, trade anyway".</span>}
    </div>
  );
}

const fmtAgo = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

// Warning icon next to Claude's percentages: they are predictions, not promises.
function PredictionInfo({ pct }: { pct: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const wins = Math.round(pct / 10);
  return (
    <>
      <button className="warn-btn" onClick={(e) => { e.stopPropagation(); setOpen(true); }} aria-label="What this percentage means" data-tip="It's a prediction">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" fill="currentColor" fillOpacity="0.15" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </button>
      {open && createPortal(
        <div className="modal-backdrop">
          <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="pred-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 id="pred-title">⚠ It's a prediction</h2>
              <button className="modal-close" onClick={() => setOpen(false)} aria-label="Close" title="Close">✕</button>
            </div>
            <div className="modal-body">
              <p className="pred-big"><b>{pct}%</b> means the AI expects this to work about <b>{wins} times out of 10</b>, and not about {10 - wins} times out of 10.</p>
              <h3>A prediction, not a promise</h3>
              <p>The AI reads the charts (5-second, 5-minute, hourly and daily candles) and estimates the chance the price reaches the target before it hits the exit. Any single trade either wins or loses: the percentage only shows up over many trades. Memecoins move fast, and the AI can be wrong.</p>
              <h3>Why trade below 50%?</h3>
              <p>Because a win is bigger than a loss. For example, at 45% with +12% on a win and −7.4% on a loss, the average is about +1.3% per trade after fees. The bot skips any order whose average comes out negative, and any order below your minimum win chance (Safe 55%, Balanced 45%, Aggressive 40%).</p>
              <h3>Expect losing streaks</h3>
              <p>At around 40%, three losses in a row happen about 1 time in 5. Keep the risk per trade at a level you're comfortable losing several times.</p>
              <h3>Check if the predictions hold up</h3>
              <p>After 20–30 bot trades, open <b>Trade history → Track record</b>: it compares the AI's predicted win chance with how often trades really won. If real results are clearly lower, raise the minimum win chance.</p>
            </div>
            <div className="modal-foot">
              <button className="btn buy" onClick={() => setOpen(false)}>Got it</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function SignalPanel(props: { pair: PairInfo | null; tf: Timeframe; sig?: Analysis["consensus"]; results?: Analysis["results"]; cost: number; onResult: (a: Analysis) => void; price?: number; botOnThisCoin: boolean; analyzedAt?: number; notify: (m: string, bad?: boolean) => void; hasAI: boolean; multi: boolean; botMinWin?: number; botWaitForHold?: boolean }) {
  const access = useAccess();
  const { pair, tf, sig, results, cost, onResult, price, botOnThisCoin, analyzedAt, notify, hasAI, multi, botMinWin, botWaitForHold } = props; // (fees are already applied in each order's numbers)
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
        ? { label: "No profit after fees", tone: "hold", text: `The AI found trades, but none make money after the ~${cost.toFixed(1)}% fees and slippage per trade.` }
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

  const run = async (auto = false) => {
    if (!pair) return;
    setLoading(true);
    try {
      onResult(await api.analyze(pair.chain, pair.pool, tf));
      if (auto) notify(`${pair.symbol}: the old plan ran out, so the AI made a new one`);
    } catch (e: any) {
      if (!auto) notify(e.message, true);
    } finally {
      setLoading(false);
    }
  };

  // The saved plan stays until you press Analyze, unless it can no longer play out:
  // its time ran out, or the price left the range where its orders make sense.
  // Then Claude is asked again automatically (only for the coin on screen, at most every
  // 3 minutes per coin; the bot re-plans its own coin, so that one is left to the bot).
  const stale = (() => {
    if (!sig || !price) return "";
    if (Date.now() > sig.expiresAt) return "the plan's time ran out";
    if (sig.cancelBelow > 0 && price < sig.cancelBelow) return "the price fell below the plan's range";
    if (sig.cancelAbove > 0 && price > sig.cancelAbove) return "the price rose above the plan's range";
    return "";
  })();
  const lastAuto = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!stale || !pair || !hasAI || loading || botOnThisCoin) return;
    if (Date.now() - (lastAuto.current[pair.pool] ?? 0) < 180_000) return;
    lastAuto.current[pair.pool] = Date.now();
    run(true);
  }, [stale, pair?.pool, hasAI, botOnThisCoin]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="panel">
      <div className="panel-title">
        <span>AI SIGNAL</span>
        <span className="title-actions">
          {sig && (explain.why || sig.note) && (
            <button className={`info-btn ${glow ? "glow" : ""}`} onClick={openInfo} aria-label="Why the AI decided this" title="Why the AI decided this">
              i
            </button>
          )}
          {access.can("ai.analyze") ? (
            <button className="btn ghost" onClick={() => run()} disabled={!pair || loading || !hasAI}>{loading ? "Analyzing…" : sig ? "Analyze again" : "Analyze"}</button>
          ) : (
            <LockChip label="AI plans" />
          )}
        </span>
      </div>
      {infoOpen && sig && createPortal(
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="why-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 id="why-title">Why the AI says {STANCE_LABEL[sig.stance ?? "AVOID"]}</h2>
              <button className="modal-close" onClick={() => setInfoOpen(false)} aria-label="Close" title="Close">✕</button>
            </div>
            <div className="modal-body why-body">
              <div className="why-kind">
                <span className={`tag ${sig.stance === "BUY_NOW" ? "buy" : sig.stance === "AVOID" ? "sell" : "hold"}`}>{STANCE_LABEL[sig.stance ?? "AVOID"]} · {sig.confidence}%</span>
                {explain.kind && <span className={`tag ${explain.kind.tone}`}>{explain.kind.label}</span>}
                {explain.risk && <span className={`risk-tag ${String(explain.risk).toLowerCase()}`}>Risk: {explain.risk}</span>}
              </div>
              {explain.kind?.text && <p>{explain.kind.text}</p>}
              {explain.why && <p>{aiText(explain.why)}</p>}
              {sig.note && <p className="muted">{aiText(sig.note)}</p>}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {!hasAI && <p className="muted small">Add <code>ANTHROPIC_API_KEY</code> to <code>server/.env</code> to enable AI analysis.</p>}
      {sig ? (
        <>
          {analyzedAt && (
            <p className="muted tiny">
              {loading ? "The AI is making a new plan…" : `Analyzed ${fmtAgo(analyzedAt)} · kept until you press Analyze again${stale ? ` (re-checking: ${stale})` : ", or until it can no longer play out"}`}
            </p>
          )}
          <div className={`verdict ${sig.stance === "BUY_NOW" ? "buy" : sig.stance === "AVOID" ? "sell" : "hold"}`}>
            <span>{STANCE_LABEL[sig.stance ?? "AVOID"]}</span>
            <div className="conf"><div style={{ width: `${sig.confidence}%` }} /></div>
            <small className="conf-line">{sig.confidence}% confidence <PredictionInfo pct={sig.confidence} /></small>
          </div>
          {sig.orders?.length > 0 && (
            <div className="orders">
              {sig.stance === "AVOID" ? (
                <div className="avoid-setup">⚠ Risky setup: the AI advises against trading now. These are its best levels if you trade anyway; the bot uses them only if you start it and choose "I understand, trade anyway".</div>
              ) : (
                <div className="label-sm">Standing orders: the bot buys on its own the moment one triggers</div>
              )}
              {sig.orders.map((o, i) => (
                <OrderCard key={i} o={o} minWin={botMinWin} waitForHold={botWaitForHold} />
              ))}
              <div className="muted tiny">
                Plan cancels{sig.cancelBelow > 0 ? ` below ${fmtPrice(sig.cancelBelow)}` : ""}{sig.cancelAbove > 0 ? `${sig.cancelBelow > 0 ? "," : ""} above ${fmtPrice(sig.cancelAbove)}` : ""}{sig.cancelBelow > 0 || sig.cancelAbove > 0 ? " or" : ""} at {fmtTime(sig.expiresAt)}; then the AI makes a new one.
              </div>
            </div>
          )}
          {explain.kind && (
            <div className="why-kind">
              <span className={`tag ${explain.kind.tone}`}>{explain.kind.label}</span>
              {explain.risk && <span className={`risk-tag ${String(explain.risk).toLowerCase()}`}>Risk: {explain.risk}</span>}
            </div>
          )}
          <div className="models">
            {results?.map((r) => (
              <details key={r.model} className="model">
                <summary>
                  <span className="info-chip">ⓘ Info</span>
                  {r.ok ? <span className={`tag ${r.signal.stance === "BUY_NOW" ? "buy" : r.signal.stance === "AVOID" ? "sell" : "hold"}`}>{STANCE_LABEL[r.signal.stance]} {r.signal.confidence}%</span> : <span className="tag sell">ERROR</span>}
                </summary>
                {r.ok ? <p className="small">{aiText(r.signal.reasoning)} <span className="muted">Risk: {r.signal.riskLevel}. {(r.ms / 1000).toFixed(1)}s</span></p> : <p className="small down">{r.error}</p>}
              </details>
            ))}
          </div>
        </>
      ) : (
        <>
          {botOnThisCoin && <p className="small fresh-wait">The bot is getting a fresh AI plan for its next trade…</p>}
          <p className="muted small">Press Analyze to get the AI's plan: standing orders (buy now, buy the dip, or buy the breakout) with exit prices and targets. {multi ? "Both models must agree on the plan." : "Orders only count if the gain clearly beats the risk after fees."}</p>
        </>
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

// The platform's transaction charge on the user's plan (free trades left this month, then the rate).
function FeeLine({ state }: { state: AppState | null }) {
  const { me, plans, openPlans } = useAccess() as ReturnType<typeof useAccess> & { plans?: PlanInfo[] };
  if (!me || !state || state.signedOut) return null;
  const plan = plans?.find((p) => p.id === (me.plan ?? "free"));
  if (!plan) return null;
  if (plan.feePct === 0 || plan.freeTrades < 0) return <p className="fee-line">No transaction charges on your {plan.name} plan.</p>;
  const m = new Date().toISOString().slice(0, 7);
  const used = state.trades.filter((t) => new Date(t.time).toISOString().slice(0, 7) === m).length;
  const left = Math.max(0, plan.freeTrades - used);
  return (
    <p className="fee-line">
      {left > 0 ? `${left} of ${plan.freeTrades} free trades left this month, then ` : ""}{plan.feePct}% transaction charge per trade ({plan.name} plan).{" "}
      {plan.id !== "max" && <button className="link-btn" onClick={openPlans}>See plans</button>}
    </p>
  );
}

function TradePanel({ pair, state, notify, refresh }: { pair: PairInfo | null; state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void }) {
  const access = useAccess();
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<"market" | "limit">("market");
  useEffect(() => { if (kind === "limit" && !access.can("trade.limit")) setKind("market"); }, [kind, access]);
  const [usd, setUsd] = useState("5");
  const [limitPrice, setLimitPrice] = useState("");
  const [sellShare, setSellShare] = useState(1);
  const pos = state?.positions.find((p) => p.pool === pair?.pool && p.source === "manual");
  const cash = state?.cash ?? 0;
  const live = pair?.priceUsd ?? 0;
  const orders = (state?.orders ?? []).filter((o) => o.pool === pair?.pool);
  const otherOrders = (state?.orders?.length ?? 0) - orders.length;
  // While a limit order is open on this coin, its tab shows that order (locked) with a Cancel button.
  const pendingBuy = orders.find((o) => o.side === "BUY");
  const pendingSell = orders.find((o) => o.side === "SELL" && o.positionId === pos?.id);
  const pending = tab === "buy" ? pendingBuy : pendingSell;
  // Suggest a limit price whenever the coin or tab changes: buys 3% below the live price,
  // sells 5% above it (you can type any price).
  useEffect(() => setLimitPrice(live ? String(Number((live * (tab === "buy" ? 0.97 : 1.05)).toPrecision(4))) : ""), [pair?.pool, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notify(ok);
      refresh();
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  const lp = Number(limitPrice);
  const diffPct = live && lp ? ((lp - live) / live) * 100 : 0;
  const buyNow = () => pair && run(() => api.buy(pair.chain, pair.pool, Number(usd)), `Bought ${fmtUsd(Number(usd))} of ${pair.symbol} (paper)`);
  const sellNow = (f: number) => pair && pos && run(() => api.sell(pair.chain, pair.pool, pos.id, f), `Sold ${f * 100}% of ${pair.symbol} (paper)`);
  const limitBuy = () => pair && run(() => api.placeOrder({ side: "BUY", chain: pair.chain, pool: pair.pool, symbol: pair.symbol, price: lp, usd: Number(usd) }), `Limit buy set: ${fmtUsd(Number(usd))} of ${pair.symbol} at ${fmtPrice(lp)}`);
  const limitSell = () => pos && run(() => api.placeOrder({ side: "SELL", positionId: pos.id, price: lp, fraction: sellShare }), `Limit sell set: ${sellShare * 100}% of ${pos.symbol} at ${fmtPrice(lp)}`);
  const cancel = (id: string) => run(() => api.cancelOrder(id), "Order cancelled");

  const priceBox = (
    <div className="limit-row">
      <label className="limit-price">
        <span>{tab === "buy" ? "Buy when price falls to" : "Sell when price rises to"}</span>
        <div className="amount">
          <span>$</span>
          <input type="number" min="0" step="any" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} aria-label="Limit price" />
        </div>
      </label>
      {live > 0 && lp > 0 && (
        <small className={`limit-hint ${(tab === "buy" ? diffPct >= 0 : diffPct <= 0) ? "warn" : "muted"}`}>
          {tab === "buy"
            ? diffPct >= 0 ? "At or above the live price: it will buy right away." : `${Math.abs(diffPct).toFixed(1)}% below the live price (${fmtPrice(live)}).`
            : diffPct <= 0 ? "At or below the live price: it will sell right away." : `${diffPct.toFixed(1)}% above the live price (${fmtPrice(live)}).`}
        </small>
      )}
    </div>
  );

  return (
    <div className="panel">
      <div className="panel-title"><span>MANUAL TRADE</span><span className="muted small">cash {fmtUsd(cash)}</span></div>
      <div className="trade-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "buy"} className={`buy ${tab === "buy" ? "on" : ""}`} onClick={() => setTab("buy")}>Buy</button>
        <button role="tab" aria-selected={tab === "sell"} className={`sell ${tab === "sell" ? "on" : ""}`} onClick={() => setTab("sell")}>Sell{pos ? "" : ""}</button>
      </div>
      {pending ? (
        // A limit order is open on this coin: show just that order (the form comes back when it's cancelled or filled).
        <>
          {tab === "sell" && pos && (
            <div className="pos-mini">
              <span>Holding {pos.qty.toPrecision(4)} {pos.symbol}</span>
              <span className={pos.lastPrice >= pos.entryPrice ? "up" : "down"}>{fmtPct(((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100)}</span>
              <span className="muted small">bought {fmtPrice(pos.entryPrice)}</span>
            </div>
          )}
          <div className="open-order pending-order">
            <span className={`tag ${pending.side === "BUY" ? "buy" : "sell"}`}>LIMIT {pending.side}</span>
            <span className="small">{pending.side === "BUY" ? `${fmtUsd(pending.usd ?? 0)} at ${fmtPrice(pending.price)}` : `${Math.round((pending.fraction ?? 1) * 100)}% at ${fmtPrice(pending.price)}`}</span>
            <button className="chip" onClick={() => cancel(pending.id)}>Cancel</button>
          </div>
          <p className="muted tiny">Waiting: {pending.side === "BUY" ? "buys" : "sells"} automatically when the price {pending.side === "BUY" ? "falls" : "rises"} to {fmtPrice(pending.price)} (live {fmtPrice(live)}).</p>
          {tab === "sell" && pos && (access.can("trade.protect") ? <ProtectControl pos={pos} notify={notify} refresh={refresh} /> : <LockChip label="Protect this trade" plan="Member" />)}
        </>
      ) : (
        <>
      <div className="kind-toggle" role="radiogroup" aria-label="Order type">
        <button role="radio" aria-checked={kind === "market"} className={kind === "market" ? "on" : ""} onClick={() => setKind("market")}>Now</button>
        <button role="radio" aria-checked={kind === "limit"} className={kind === "limit" ? "on" : ""} onClick={() => (access.can("trade.limit") ? setKind("limit") : access.openPlans())} title={access.can("trade.limit") ? undefined : "Limit orders are included from the Member plan"}>
          {!access.can("trade.limit") && "🔒 "}At a price (limit)
        </button>
      </div>

      {tab === "buy" ? (
        <>
          <div className="amount">
            <span>$</span>
            <input type="number" min="1" step="1" value={usd} onChange={(e) => setUsd(e.target.value)} aria-label="Amount in dollars" />
            {[25, 50, 100].map((p) => (
              <button key={p} className="chip" onClick={() => setUsd(((cash * p) / 100).toFixed(2))}>{p}%</button>
            ))}
          </div>
          {kind === "limit" && priceBox}
          {kind === "market" ? (
            <button className="btn buy wide" onClick={buyNow} disabled={!pair}>BUY {pair?.symbol}</button>
          ) : (
            <button className="btn buy wide" onClick={limitBuy} disabled={!pair || !(lp > 0)}>SET LIMIT BUY</button>
          )}
        </>
      ) : !pos ? (
        <p className="muted small">You don't hold {pair?.symbol ?? "this coin"}. Buy it first, then you can sell it now or set a limit sell.</p>
      ) : (
        <>
          <div className="pos-mini">
            <span>Holding {pos.qty.toPrecision(4)} {pos.symbol}</span>
            <span className={pos.lastPrice >= pos.entryPrice ? "up" : "down"}>{fmtPct(((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100)}</span>
            <span className="muted small">bought {fmtPrice(pos.entryPrice)}</span>
          </div>
          <div className="share-chips" role="radiogroup" aria-label="How much to sell">
            {[0.25, 0.5, 1].map((f) => (
              <button key={f} role="radio" aria-checked={sellShare === f} className={`chip ${sellShare === f ? "on" : ""}`} onClick={() => setSellShare(f)}>{f === 1 ? "All" : `${f * 100}%`}</button>
            ))}
          </div>
          {kind === "limit" && priceBox}
          {kind === "market" ? (
            <button className="btn sell wide" onClick={() => sellNow(sellShare)}>SELL {sellShare === 1 ? "ALL" : `${sellShare * 100}%`}</button>
          ) : (
            <button className="btn sell wide" onClick={limitSell} disabled={!(lp > 0)}>SET LIMIT SELL</button>
          )}
          {access.can("trade.protect") ? <ProtectControl pos={pos} notify={notify} refresh={refresh} /> : <LockChip label="Protect this trade" plan="Member" />}
        </>
      )}
        </>
      )}

      {orders.some((o) => o.id !== pending?.id) && (
        <div className="open-orders">
          <div className="label-sm">Open orders on {pair?.symbol}</div>
          {orders.filter((o) => o.id !== pending?.id).map((o) => (
            <div key={o.id} className="open-order">
              <span className={`tag ${o.side === "BUY" ? "buy" : "sell"}`}>LIMIT {o.side}</span>
              <span className="small">{o.side === "BUY" ? `${fmtUsd(o.usd ?? 0)} at ${fmtPrice(o.price)}` : `${Math.round((o.fraction ?? 1) * 100)}% at ${fmtPrice(o.price)}`}</span>
              <button className="chip" onClick={() => cancel(o.id)}>Cancel</button>
            </div>
          ))}
        </div>
      )}
      {otherOrders > 0 && <p className="muted tiny">{otherOrders} open order{otherOrders === 1 ? "" : "s"} on other coins (see Positions).</p>}
      <FeeLine state={state} />
      {!pending && <p className="muted tiny">{kind === "limit" ? "Limit orders are checked every 5 seconds, even with the bot off, and you get a notification when one fills." : `Fees ${state?.settings.feePct}% + slippage ${state?.settings.slippagePct}% per side are simulated.`}</p>}
    </div>
  );
}

type RiskKnobs = { positionPct: number; minConfidence: number; analyzeMin: number; maxDrawdownPct: number; breakEvenAtPct: number; trailPct: number; cooldownMin: number; dailyLossPct: number; maxDrop1hPct: number; riskPerTradePct: number; newCoinPct: number; newStopPct: number; newTakePct: number; newTrailPct: number; newMaxMin: number; newMaxPerDay: number; lockPct: number; partialAtPct: number };
// Profit protection, the same for every preset: keep at least half of the best gain once
// up the break-even amount, and take half 75% of the way to the target.
const PROFIT_DEFAULTS = { lockPct: 50, partialAtPct: 75 };
const NEW_COIN_DEFAULTS = { newCoinPct: 3, newStopPct: 15, newTakePct: 30, newTrailPct: 10, newMaxMin: 45, newMaxPerDay: 5 };
const PRESETS: Record<"safe" | "balanced" | "aggressive", RiskKnobs & { label: string; blurb: string }> = {
  safe: { label: "Safe", blurb: "Risks 1% of the account per trade, only orders with good odds, tight emergency brake.", positionPct: 50, minConfidence: 55, analyzeMin: 60, maxDrawdownPct: 15, breakEvenAtPct: 4, trailPct: 2, cooldownMin: 60, dailyLossPct: 5, maxDrop1hPct: 7, riskPerTradePct: 1, ...NEW_COIN_DEFAULTS, ...PROFIT_DEFAULTS },
  balanced: { label: "Balanced", blurb: "Risks 1.5% of the account per trade, decent odds required.", positionPct: 90, minConfidence: 45, analyzeMin: 30, maxDrawdownPct: 25, breakEvenAtPct: 6, trailPct: 3, cooldownMin: 30, dailyLossPct: 10, maxDrop1hPct: 10, riskPerTradePct: 1.5, ...NEW_COIN_DEFAULTS, ...PROFIT_DEFAULTS },
  aggressive: { label: "Aggressive", blurb: "Puts 50% of the account into every trade, accepts lower odds, wider brake. Bigger swings both ways.", positionPct: 50, minConfidence: 40, analyzeMin: 20, maxDrawdownPct: 40, breakEvenAtPct: 8, trailPct: 5, cooldownMin: 15, dailyLossPct: 15, maxDrop1hPct: 15, riskPerTradePct: 0, ...NEW_COIN_DEFAULTS, ...PROFIT_DEFAULTS },
};
type PresetKey = keyof typeof PRESETS;
const KNOBS: (keyof RiskKnobs)[] = ["positionPct", "minConfidence", "analyzeMin", "maxDrawdownPct", "breakEvenAtPct", "trailPct", "cooldownMin", "dailyLossPct", "maxDrop1hPct", "riskPerTradePct", "newCoinPct", "newStopPct", "newTakePct", "newTrailPct", "newMaxMin", "newMaxPerDay", "lockPct", "partialAtPct"];
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
        A buy plus a sell costs about <b>{roundTrip.toFixed(1)}%</b>. A trade has to gain more than that just to break even, so lower costs mean the AI finds more trades worth taking.
      </p>
    </>
  );
}

function BotPanel({ pair, tf, state, notify, refresh, multi, onOpen, riskReasons = [] }: { pair: PairInfo | null; tf: Timeframe; state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void; multi: boolean; onOpen: (chain: string, pool: string) => void; riskReasons?: string[]; alerts?: "telegram" | "ntfy" | null }) {
  const access = useAccess();
  const running = state?.bot.running ?? false;
  const active = state?.bot.config;
  // Your choices are saved in this browser, so a refresh or coin change keeps them.
  const savedBot = savedUi().bot ?? {};
  // New coins are traded like any other coin now (open one from the New coins tab).
  const [mode, setMode] = useState<"this" | "auto" | "newcoins">(savedBot.mode === "auto" ? "auto" : "this");
  const [newChain, setNewChain] = useState<"solana" | "base">(savedBot.newChain ?? "solana");
  const [autoChain, setAutoChain] = useState<ScanChain>((savedBot.autoChain as ScanChain) ?? "all");
  const [waitForHold, setWaitForHold] = useState(savedBot.waitForHold ?? false);
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
  const [cfg, setCfg] = useState<RiskKnobs & { goalUsd: number }>(() => ({ ...PRESETS.balanced, goalUsd: 15, ...(savedBot.cfg as Partial<RiskKnobs & { goalUsd: number }>) }));
  const set = (k: keyof typeof cfg) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setCustom(true);
    setCfg({ ...cfg, [k]: Number(e.target.value) });
  };
  // "Custom" shows the input boxes; picking a preset goes back to the summary view.
  const [custom, setCustom] = useState(savedBot.custom ?? false);
  useEffect(() => saveUi({ bot: { cfg, custom, mode, newChain, autoChain, waitForHold } }), [cfg, custom, mode, newChain, autoChain, waitForHold]);
  const pick = (p: PresetKey) => {
    setCustom(false);
    setCfg({ ...cfg, ...Object.fromEntries(KNOBS.map((n) => [n, PRESETS[p][n]])) });
  };

  // While running, describe what the bot is actually using.
  const shown: RiskKnobs & { goalUsd: number } =
    running && active ? { positionPct: active.positionPct, minConfidence: active.minConfidence, analyzeMin: Math.round(active.analyzeEverySec / 60), maxDrawdownPct: active.maxDrawdownPct, breakEvenAtPct: active.breakEvenAtPct, trailPct: active.trailPct ?? 3, lockPct: active.lockPct ?? 50, partialAtPct: active.partialAtPct ?? 75, cooldownMin: active.cooldownMin ?? 30, dailyLossPct: active.dailyLossPct ?? 10, maxDrop1hPct: active.maxDrop1hPct ?? 10, riskPerTradePct: active.riskPerTradePct ?? 1.5, newCoinPct: active.newCoinPct ?? 3, newStopPct: active.newStopPct ?? 15, newTakePct: active.newTakePct ?? 30, newTrailPct: active.newTrailPct ?? 10, newMaxMin: active.newMaxMin ?? 45, newMaxPerDay: active.newMaxPerDay ?? 5, goalUsd: active.goalUsd } : cfg;
  // When the bot stops, keep the settings it was running with (even if this page was
  // refreshed or the bot was started elsewhere), ready for the next start.
  const lastRun = useRef<{ shown: typeof shown; active: BotConfig } | null>(null);
  useEffect(() => {
    if (running && active) lastRun.current = { shown, active };
    else if (!running && lastRun.current) {
      const { shown: used, active: a } = lastRun.current;
      lastRun.current = null;
      setCfg(used);
      setCustom(!matchPreset(used));
      setMode(a.pick ?? "this");
      if (a.newChain) setNewChain(a.newChain);
      if (a.autoChain) setAutoChain(a.autoChain);
      setWaitForHold(!!a.waitForHold);
    }
  }, [running, active]); // eslint-disable-line react-hooks/exhaustive-deps
  const preset = matchPreset(shown);
  const isCustom = (custom && !running) || !preset;
  const cash = state?.cash ?? startCash;
  const perTrade = Math.min(cash, ((state?.equityNow ?? cash) * shown.positionPct) / 100);
  const floor = startCash * (1 - shown.maxDrawdownPct / 100);

  // Risky coin: ask first ("I understand"), then start with the safety pauses relaxed.
  const [riskOpen, setRiskOpen] = useState(false);
  // Daily loss limit: "Continue anyway" after an "I understand" popup.
  const [dailyOpen, setDailyOpen] = useState(false);
  const continueToday = async () => {
    setDailyOpen(false);
    try {
      await api.overrideDailyLimit();
      notify("Daily loss limit lifted until 00:00 UTC. The bot keeps trading.");
      refresh();
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  const start = () => {
    if (mode === "this" && !pair) return;
    if (mode === "this" && riskReasons.length) return setRiskOpen(true);
    void startBot(false);
  };
  const startBot = async (allowRisky: boolean) => {
    setRiskOpen(false);
    if (mode === "this" && !pair) return;
    // In auto mode the chain/pool are placeholders; the bot chooses its own coins.
    const full: BotConfig = { chain: pair?.chain ?? "solana", pool: pair?.pool ?? "", symbol: mode === "auto" ? "AUTO" : mode === "newcoins" ? "NEW COINS" : (pair?.symbol ?? ""), tf: mode === "this" ? tf : "5m", positionPct: cfg.positionPct, minConfidence: cfg.minConfidence, analyzeEverySec: cfg.analyzeMin * 60, checkEverySec: 5, maxDrawdownPct: cfg.maxDrawdownPct, breakEvenAtPct: cfg.breakEvenAtPct, trailPct: cfg.trailPct, lockPct: cfg.lockPct, partialAtPct: cfg.partialAtPct, goalUsd: cfg.goalUsd, pick: mode, autoChain, autoCandidates: 3, newChain, newCoinPct: cfg.newCoinPct, newStopPct: cfg.newStopPct, newTakePct: cfg.newTakePct, newTrailPct: cfg.newTrailPct, newMaxMin: cfg.newMaxMin, newMaxPerDay: cfg.newMaxPerDay, waitForHold, cooldownMin: cfg.cooldownMin, dailyLossPct: cfg.dailyLossPct, maxDrop1hPct: cfg.maxDrop1hPct, riskPerTradePct: cfg.riskPerTradePct, allowRisky, riskReasons: allowRisky ? riskReasons : undefined };
    try {
      await api.startBot(full);
      notify(mode === "newcoins" ? `New coins bot started on ${newChain}` : mode === "auto" ? `Auto-pick bot started (${preset ? PRESETS[preset].label : "Custom"})` : `Bot started on ${pair?.symbol} (${preset ? PRESETS[preset].label : "Custom"})${allowRisky ? " · risky mode" : ""}`);
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
          <span className={`pulse ${running ? "on" : ""}`}>{running ? (active?.pick === "newcoins" ? (target ? `NEW COINS → ${target.symbol}` : `NEW COINS · ${(active.newChain ?? "solana").toUpperCase()}`) : active?.pick === "auto" ? (target ? `AUTO-PICK → ${target.symbol}` : "AUTO-PICK · SCANNING") : `RUNNING · ${active?.symbol} ${active?.tf}`) : "IDLE"}</span>
          <BotTimer running={running} startedAt={state?.bot.startedAt ?? null} stoppedAt={state?.bot.stoppedAt ?? null} />
          {running && state?.bot.lastWatch && <LastCheck at={state.bot.lastWatch.at} by={state.bot.lastWatch.by} />}
        </div>
      </div>

      <div className="label-row">
        <div className="label-sm">What should it trade?</div>
        <button className="chip" onClick={() => openRules()} aria-haspopup="dialog">
          ⚙ Settings
        </button>
      </div>
      <div className="presets two" role="radiogroup" aria-label="What to trade">
        <button role="radio" aria-checked={shownMode === "this"} className={`preset balanced ${shownMode === "this" ? "on" : ""}`} onClick={() => setMode("this")} disabled={running}>
          {running && shownMode === "this" ? active?.symbol : `This coin${pair ? ` (${pair.symbol})` : ""}`}
        </button>
        <button role="radio" aria-checked={shownMode === "auto"} className={`preset safe ${shownMode === "auto" ? "on" : ""}`} onClick={() => (access.can("bot.autopick") ? setMode("auto") : access.openPlans())} disabled={running} title={access.can("bot.autopick") ? undefined : "Auto-pick is included from AI Pro"}>
          {!access.can("bot.autopick") && "🔒 "}
          Auto-pick
        </button>
      </div>
      {shownMode === "auto" && (
        <>
          <div className="chain-tabs compact">
            {CHAIN_TABS.map((t) => (
              <button key={t.id} className={`chip ${shownChain === t.id ? "on" : ""}`} onClick={() => setAutoChain(t.id)} disabled={running}>{t.label}</button>
            ))}
          </div>
          <p className="preset-blurb small">Each round it scans trending coins, asks the AI about the top 3 in the buy zone (3 paid calls), and buys the one the AI is most sure about. Skips coins with under $50K liquidity.</p>
        </>
      )}

      {running && state?.bot.blocked && (
        <div className="blocked small">
          <b>Not trading right now:</b> {state.bot.blocked}.
          {state.bot.blocked.startsWith("daily loss limit") && (
            <button className="btn ghost continue-btn" onClick={() => setDailyOpen(true)}>Continue anyway…</button>
          )}
        </div>
      )}
      {dailyOpen && createPortal(
        <div className="modal-backdrop">
          <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="daily-title">
            <div className="modal-head">
              <h2 id="daily-title">⚠ Keep trading after today's losses?</h2>
              <button className="modal-close" onClick={() => setDailyOpen(false)} aria-label="Close" title="Close">✕</button>
            </div>
            <div className="modal-body">
              <p className="risk-lead">{state?.bot.blocked}.</p>
              <p>The daily loss limit stops new trades after a bad day, so a losing streak can't keep growing. Continuing lifts it <b>until 00:00 UTC</b>; it turns back on automatically tomorrow.</p>
              <p>The bot keeps using its exits, your minimum win chance and the <b>emergency stop</b>, which sells everything and switches the bot off if the account falls below your limit.</p>
              <p className="muted small">Losing days often get worse when trading continues. This is paper trading, but treat it as practice for real money.</p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setDailyOpen(false)}>Keep the pause</button>
              <button className="btn sell" onClick={() => void continueToday()}>I understand, continue today</button>
            </div>
          </div>
        </div>,
        document.body,
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
              The AI's best order for <b>{plan.symbol}</b> has a {Math.max(...planOrders.map((o) => o.winChancePct))}% win chance, below your {active?.minConfidence}% minimum, so none will be used. Next plan by {fmtTime(Math.min(plan.consensus.expiresAt, (state?.bot.lastAnalysisAt ?? 0) + (active?.analyzeEverySec ?? 1800) * 1000))}, sooner if the market moves.
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
              <div className="muted tiny">Plan cancels at {fmtTime(plan.consensus.expiresAt)} or if the price leaves its range; then the AI makes a new one.</div>
              <button className="chip" onClick={() => onOpen(active?.pick === "auto" ? (target?.chain ?? "solana") : active!.chain, plan.pool)}>View</button>
            </div>
          ) : (
            <div className="muted">
              {state?.bot.lastAnalysisAt ? `The AI's last plan (${fmtTime(state.bot.lastAnalysisAt)}): no orders worth placing. It will be asked again by ${fmtTime(state.bot.lastAnalysisAt + (active?.analyzeEverySec ?? 1800) * 1000)}, sooner if the market moves.` : "Starting up: getting the AI's first plan."}
            </div>
          )}
          {candidates.length > 0 && !botPos && (
            <div className="cands">
              {candidates.map((c) => (
                <span key={c.pool} className={`tag ${c.action === "BUY" ? "buy" : c.action === "ERROR" ? "sell" : "hold"}`} title={aiText(c.note ?? "")}>
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
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 id="rules-title">Settings{isCustom ? " · Custom" : preset ? ` · ${PRESETS[preset].label}` : ""}</h2>
              <button className="modal-close" onClick={cancelRules} aria-label="Close" title="Close">
                ✕
              </button>
            </div>
            <div className="modal-body rules-body">
              <p className="preset-blurb small">{isCustom ? "Your own numbers. Type them below; each box explains what it does." : PRESETS[preset!].blurb}</p>

              <ul className="plan small">
                {shown.riskPerTradePct > 0 ? (
                  <li>Sizes each trade so that hitting the AI's exit loses about <b>{shown.riskPerTradePct}%</b> of the account (≈{fmtUsd(((state?.equityNow ?? cash) * shown.riskPerTradePct) / 100)}), never more than {fmtUsd(perTrade)} ({shown.positionPct}% of the account)</li>
                ) : (
                  <li>Puts <b>{shown.positionPct}%</b> of the account into every trade (≈{fmtUsd(perTrade)} now); a trade that hits its exit loses part of that, usually 5–10%</li>
                )}
                <li>The AI writes standing orders; the bot uses ones with a <b>{shown.minConfidence}%+</b> win chance that make money on average after fees, and buys the moment one triggers (checked every 5 seconds, free)</li>
                <li>Sells below the AI's exit price; once up <b>{shown.breakEvenAtPct}%</b> it can't turn into a loss</li>
                <li>Profit lock: from then on it keeps at least <b>{shown.lockPct}%</b> of the best gain, so a run that fades still ends in profit</li>
                <li>Takes half the profit <b>{shown.partialAtPct}%</b> of the way to the target, then lets the rest ride</li>
                <li>At the AI's target it rides the trend, selling if it falls <b>{shown.trailPct}%</b> from its high</li>
                <li>Asks the AI again after each trade or when the plan expires (backup check every {shown.analyzeMin} min)</li>
                <li>No dip buys while a coin is falling (down more than <b>{shown.maxDrop1hPct}%</b> in an hour, or a 1-hour downtrend)</li>
                <li>After a losing trade, waits <b>{shown.cooldownMin} min</b> before re-buying that coin; skips it for the day after 2 losses in a row</li>
                <li>Stops opening trades for the day after losing <b>{shown.dailyLossPct}%</b> in a day</li>
                <li>Sells everything and stops if the account drops below <b>{fmtUsd(floor)}</b></li>
              </ul>
              <label className="check small">
                <input type="checkbox" checked={running ? Boolean(active?.waitForHold) : waitForHold} onChange={(e) => setWaitForHold(e.target.checked)} disabled={running} />
                <span>
                  Wait for the price to hold before buying
                  <span className="muted tiny"> · Off: buys the instant a trigger price is hit. On: waits the few seconds the AI suggests, so it doesn't buy into a spike or a crash that's still going. Sells are always instant.</span>
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
                  <small>How much one losing trade should cost. The bot sizes each trade from the AI's exit price so that hitting it loses about this much (≈{fmtUsd(((state?.equityNow ?? cash) * shown.riskPerTradePct) / 100)} now). Smaller = survives losing streaks. 0 = off: always use the full "Money per trade" amount.</small>
                </label>
                <label>
                  Money per trade (% of account)
                  <input type="number" value={shown.positionPct} onChange={set("positionPct")} disabled={running} />
                  <small>{shown.riskPerTradePct > 0 ? `Upper limit: never more than ${shown.positionPct}% of the account (${fmtUsd(perTrade)}) in one trade, even if the exit is very close.` : `Every trade uses ${shown.positionPct}% of the account (${fmtUsd(perTrade)} now), never more than your cash.`}</small>
                </label>
                <label>
                  Minimum win chance (%)
                  <input type="number" value={shown.minConfidence} onChange={set("minConfidence")} disabled={running} />
                  <small>For each order, the AI estimates the chance it reaches its target before its exit price. Orders below this aren't used. Every order must also make money on average after fees. Higher = fewer, safer trades.</small>
                </label>
                <label>
                  Backup re-check (minutes)
                  <input type="number" value={shown.analyzeMin} onChange={set("analyzeMin")} disabled={running} />
                  <small>The AI is asked after every trade and whenever its plan expires or the price leaves its range. This is the longest it waits otherwise. Each ask costs a few cents.</small>
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
                  <small>After the AI's target is reached, it keeps holding while the price climbs and sells if it falls this much from its highest point.</small>
                </label>
                <label>
                  Profit lock (% of best gain kept)
                  <input type="number" min={0} max={90} value={shown.lockPct} onChange={set("lockPct")} disabled={running} />
                  <small>Once the trade is up the break-even amount, the stop follows the best price so it keeps at least this share of the gain. 0 = off.</small>
                </label>
                <label>
                  Take half at (% of the way to target)
                  <input type="number" min={0} max={100} value={shown.partialAtPct} onChange={set("partialAtPct")} disabled={running} />
                  <small>Sells half when the price gets this far toward the target, since runs often stall just short of it. 0 = off.</small>
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
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={cancelRules}>Cancel</button>
              <button className="btn buy" onClick={confirmRules}>Confirm</button>
            </div>
          </div>
        </div>,
        document.body, // render at page level: the panel's blur effect would otherwise trap the popup inside it
      )}
      {riskOpen && createPortal(
        <div className="modal-backdrop">
          <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="risk-title">
            <div className="modal-head">
              <h2 id="risk-title">⚠ High-risk trade</h2>
              <button className="modal-close" onClick={() => setRiskOpen(false)} aria-label="Close" title="Close">✕</button>
            </div>
            <div className="modal-body">
              <p className="risk-lead">Trading <b>{pair?.symbol}</b> with the bot right now is risky:</p>
              <ul className="risk-list">{riskReasons.map((r) => <li key={r}>{r}</li>)}</ul>
              <p>If you continue, the bot <b>will</b> buy even while the coin is falling, and won't pause after losing trades on it. It still uses the AI's exit, your minimum win chance and fee check, the daily loss limit and the emergency stop.</p>
              <p className="muted small">You could lose a large part of the money in each trade. This is paper trading, but treat it as practice for real money.</p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => void startBot(false)}>Start with safety on</button>
              {access.can("bot.risky") ? (
                <button className="btn sell" onClick={() => void startBot(true)}>I understand, trade anyway</button>
              ) : (
                <LockChip label="Risky mode" plan="AI Pro" />
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {running && active?.allowRisky && <div className="risky-pill">⚠ Risky mode: buys while falling, no cool-downs</div>}
      {running ? (
        <button className="btn sell wide" onClick={stop}>STOP BOT</button>
      ) : (
        !access.can("bot.run") ? (
          <div className="lock-card">
            <b>The AI bot trades for you around the clock.</b>
            <span className="muted small">It's included from the AI Starter plan, with a monthly AI token allowance.</span>
            <LockChip label="AI bot" />
          </div>
        ) : (mode === "auto" && !access.can("bot.autopick")) ? (
          <LockChip label="Auto-pick" plan="AI Pro" />
        ) :
        <button className="btn buy wide" onClick={start} disabled={mode === "this" && !pair}>{mode === "newcoins" ? `START NEW COINS BOT (${newChain === "solana" ? "Solana" : "Base"})` : mode === "auto" ? "START AUTO-PICK BOT" : `START BOT ON ${pair?.symbol ?? "…"}`}</button>
      )}
      <p className="muted small run-mode-hint">{state?.settings.continuous ? "Trades continuously until you stop it." : "Stops by itself after one profitable trade."} Change this in Settings (wrench, top right).</p>
      <p className="muted small">{mode === "newcoins" ? "New coins mode does not call the AI: it follows fixed safety and exit rules, so it is free to run." : multi ? "Each AI check calls two AI models (a few cents). The bot buys only when both agree and reward beats risk after fees." : "The AI is in charge. Each check is a paid AI call (a few cents), and it only buys when reward beats risk after fees."}</p>
    </div>
  );
}

function GoalLadder({ state }: { state: AppState | null }) {
  const eq = state?.equityNow ?? 0;
  const start = state?.startCash || 10; // signed out: the $0 view still shows the usual ladder
  const steps = [start, start * 1.5, start * 2, start * 10, start * 100];
  const [cash, setCash] = useState("10");
  return (
    <div className="panel">
      <div className="panel-title"><span>GROWTH LADDER</span><span className="muted small">peak {fmtUsd(state?.peakEquity ?? 0)}</span></div>
      <div className="ladder">
        {steps.map((s, i) => {
          const pct = s > 0 ? Math.max(0, Math.min(100, (eq / s) * 100)) : 0;
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
  const access = useAccess();
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
      saveAnalysis(p.pool, r); // opening this coin later shows the same plan, no new call
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
          <span>Top trending coins with a quick plan from their live trading stats (free, no AI). Click <b>Ask AI</b> for a proper plan before buying.</span>
        )}
      </div>
      {err && <p className="down small pad">{err}</p>}
      {!data && !err && <p className="muted small pad">Scanning trending coins…</p>}
      {data && !data.rows.length && <p className="muted small pad">No coins with enough liquidity right now. Try another chain.</p>}
      {data && data.rows.length > 0 && (
        <table className="scan">
          <thead>
            <tr>
              <th className="col-coin">Coin</th>
              <th className="num">Price</th>
              <th className="num hide-sm">1h</th>
              <th className="num hide-sm">24h</th>
              <th className="col-signal">Signal</th>
              <th className="num" title="Buy only at or below this price">Buy below</th>
              <th className="num" title="Sell for profit at this price">Sell at</th>
              <th className="num hide-sm" title="Get out if price falls below this">Exit if below</th>
              <th className="hide-sm" title="Buy before this time, sell by this time">When</th>
              <th className="col-action" />
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
                  <td className="mono num">{fmtPrice(pair.priceUsd)}</td>
                  <td className={`num hide-sm ${pair.change.h1 >= 0 ? "up" : "down"}`}>{fmtPct(pair.change.h1)}</td>
                  <td className={`num hide-sm ${pair.change.h24 >= 0 ? "up" : "down"}`}>{fmtPct(pair.change.h24)}</td>
                  <td className="col-signal" title={plan?.why}>
                    {a && a !== "loading" ? (
                      <span className={`tag ${a.stance === "BUY_NOW" ? "buy" : a.stance === "AVOID" ? "sell" : "hold"}`}>AI: {STANCE_LABEL[a.stance ?? "AVOID"]} {a.confidence}%</span>
                    ) : (
                      <span className={`tag ${go ? "buy" : plan?.verdict === "AVOID" ? "sell" : "hold"}`}>{plan?.verdict ?? "DATA BUSY"}</span>
                    )}
                    <div className="muted tiny why">{a && a !== "loading" ? a.note : plan?.why}</div>
                  </td>
                  {a && a !== "loading" && a.orders?.length > 0 ? (
                    <>
                      <td className="mono num up">{a.orders[0].kind === "buy_breakout" ? "above " : ""}{fmtPrice(a.orders[0].triggerPrice)}</td>
                      <td className="mono num up">{fmtPrice(a.orders[0].target)}<div className="muted tiny">then trails</div></td>
                      <td className="mono num down hide-sm">{fmtPrice(a.orders[0].stopLoss)}</td>
                      <td className="hide-sm small">plan valid until {fmtTime(a.expiresAt)}{a.orders.length > 1 ? <><br />+1 more order</> : null}</td>
                    </>
                  ) : go && plan && !(a && a !== "loading") ? (
                    <>
                      <td className="mono num">{fmtPrice(plan.buyBelow)}</td>
                      <td className="mono num up">{fmtPrice(plan.sellAt)}<div className="muted tiny">+{plan.netGainPct.toFixed(1)}% after fees</div></td>
                      <td className="mono num down hide-sm">{fmtPrice(plan.exitBelow)}</td>
                      <td className="hide-sm small">buy by {fmtTime(plan.buyBy)}<br />sell by {fmtTime(plan.sellBy)}</td>
                    </>
                  ) : (
                    <>
                      <td className="num empty-cell" title={a && a !== "loading" ? "AI: no orders worth placing now." : !plan ? "Chart data is busy. Rescan in a minute, or Ask AI." : plan.verdict === "AVOID" ? "Don't buy." : "Wait for a clearer setup."}>–</td>
                      <td className="num empty-cell">–</td>
                      <td className="num empty-cell hide-sm">–</td>
                      <td className="empty-cell hide-sm">{a && a !== "loading" ? "No orders now" : !plan ? "Data busy" : plan.verdict === "AVOID" ? "Don't buy" : "Wait"}</td>
                    </>
                  )}
                  <td className="col-action" onClick={(e) => e.stopPropagation()}>
                    {access.can("ai.analyze") ? (
                      <button className="chip" disabled={a === "loading"} onClick={() => askClaude(pair)}>{a === "loading" ? "Asking…" : "Ask AI"}</button>
                    ) : (
                      <LockChip label="Ask AI" />
                    )}
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

// Plain names for the dashed price lines on the chart (shown in the legend under it).
const LINE_NAME: Record<string, string> = {
  BOUGHT: "Bought at",
  EXIT: "Stop-loss",
  TARGET: "Take-profit",
  "TRAILING STOP": "Trailing stop",
  "PROTECT STOP": "Protection stop",
  "BUY BELOW": "Buy if it dips to",
  "BUY ABOVE": "Buy if it breaks above",
  "LIMIT BUY": "Your limit buy",
  "LIMIT SELL": "Your limit sell",
};
const LINE_HELP: Record<string, string> = {
  BOUGHT: "The price the open position was bought at.",
  EXIT: "Sells automatically if the price falls to this line.",
  TARGET: "Profit target: at this price the bot starts trailing the high to lock in gains.",
  "TRAILING STOP": "Follows the price up; sells if it falls back to this line.",
  "PROTECT STOP": "Your manual trade sells if the price falls back to this line.",
  "BUY BELOW": "The AI's standing order: the bot buys if the price dips to this line.",
  "BUY ABOVE": "The AI's standing order: the bot buys if the price breaks above this line.",
  "LIMIT BUY": "Your limit buy: fills automatically if the price falls to this line.",
  "LIMIT SELL": "Your limit sell: fills automatically if the price rises to this line.",
};

const RISK_TONE: Record<string, string> = { LOW: "buy", MEDIUM: "hold", HIGH: "sell", REJECTED: "sell" };

function NewCoins({ onSelect }: { onSelect: (p: PairInfo) => void }) {
  const [chain, setChain] = useState<"solana" | "base">(() => (savedUi().newChain as "solana" | "base") ?? "solana");
  const [list, setList] = useState<NewCoin[] | null>(null);
  const [err, setErr] = useState("");
  const [showRejected, setShowRejected] = useState(false);
  const load = (c = chain) => {
    saveUi({ newChain: c });
    setList(null);
    setErr("");
    api.newcoins(c).then(setList).catch((e) => setErr(e.message));
  };
  useEffect(() => load(chain), [chain]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (list ?? []).filter((c) => showRejected || c.risk !== "REJECTED");
  const rejected = (list ?? []).filter((c) => c.risk === "REJECTED").length;
  return (
    <div className="table-wrap">
      <div className="chain-tabs">
        {(["solana", "base"] as const).map((c) => (
          <button key={c} className={`chip ${chain === c ? "on" : ""}`} onClick={() => setChain(c)}>{c === "solana" ? "Solana" : "Base"}</button>
        ))}
        <button className="chip" onClick={() => load()}>↻ Rescan</button>
        {rejected > 0 && <button className="chip" onClick={() => setShowRejected((v) => !v)}>{showRejected ? "Hide" : "Show"} {rejected} rejected</button>}
      </div>
      <div className="scan-head muted small">
        Coins from minutes to 3 days old, checked for rug-pull signs ({chain === "solana" ? "RugCheck" : "honeypot.is"}). Open a coin to see its chart, get the AI's plan and trade it like any other coin; avoid Rejected and High-risk ones. Very high risk: most new coins fail.
      </div>
      {err && <p className="down small pad">{err}</p>}
      {!list && !err && <p className="muted small pad">Scanning new coins and running safety checks…</p>}
      {list && !shown.length && <p className="muted small pad">No new coins worth showing right now.</p>}
      {shown.length > 0 && (
        <table className="scan">
          <thead>
            <tr><th>Coin</th><th>Age</th><th>Liquidity</th><th className="hide-sm">Price</th><th>1h</th><th className="hide-sm">Buys</th><th>Risk</th><th>Why</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.pair.pool} onClick={() => onSelect(c.pair)} className={c.tradeable ? "tradeable" : ""}>
                <td><b>{c.pair.symbol}</b><div className="muted tiny">{c.pair.dex}</div></td>
                <td>{c.ageMin < 60 ? `${c.ageMin}m` : c.ageMin < 1440 ? `${Math.round(c.ageMin / 60)}h` : `${Math.round(c.ageMin / 1440)}d`}</td>
                <td>{fmtBig(c.pair.liquidityUsd)}</td>
                <td className="mono hide-sm">{fmtPrice(c.pair.priceUsd)}</td>
                <td className={c.pair.change.h1 >= 0 ? "up" : "down"}>{fmtPct(c.pair.change.h1)}</td>
                <td className="hide-sm">{c.buyShare === null ? "–" : `${Math.round(c.buyShare * 100)}%`}</td>
                <td>
                  <span className={`tag ${RISK_TONE[c.risk]}`}>{c.risk}</span>
                  {c.tradeable && <div className="tiny up">fits entry rules</div>}
                </td>
                <td className="why small">{c.reasons.length ? c.reasons.slice(0, 3).join(" · ") : "No red flags found"}</td>
                <td><button className="chip">Open →</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OpenOrders({ state, notify, refresh }: { state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void }) {
  const orders = state?.orders ?? [];
  if (!orders.length) return null;
  const cancel = async (id: string) => {
    try {
      await api.cancelOrder(id);
      notify("Order cancelled");
      refresh();
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  return (
    <div className="table-wrap">
      <div className="label-sm pad">Open limit orders</div>
      <table className="scan">
        <thead><tr><th>Token</th><th>Order</th><th className="num">Price</th><th className="num">Amount</th><th className="hide-sm">Placed</th><th className="col-action" /></tr></thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td><b>{o.symbol}</b></td>
              <td><span className={`tag ${o.side === "BUY" ? "buy" : "sell"}`}>LIMIT {o.side}</span></td>
              <td className="num mono">{fmtPrice(o.price)}</td>
              <td className="num">{o.side === "BUY" ? fmtUsd(o.usd ?? 0) : `${Math.round((o.fraction ?? 1) * 100)}%`}</td>
              <td className="hide-sm muted">{new Date(o.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
              <td className="col-action"><button className="chip" onClick={() => cancel(o.id)}>Cancel</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Positions({ state, notify, refresh }: { state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void }) {
  if (!state?.positions.length) return <><p className="muted small pad">No open positions.</p><OpenOrders state={state} notify={notify} refresh={refresh} /></>;
  return (
    <>
    <OpenOrders state={state} notify={notify} refresh={refresh} />
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
    </>
  );
}

// Claude's track record: predicted win chance vs how often bot trades actually reached the target.
function TrackRecord({ state }: { state: AppState | null }) {
  const allSells = (state?.trades ?? []).filter((t) => t.source === "bot" && t.side === "SELL");
  if (!allSells.length) return null;
  const sells = allSells.filter((t) => t.strategy !== "newcoin");
  const newSells = allSells.filter((t) => t.strategy === "newcoin");
  const newPnl = newSells.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
  const newCoinsBlock = newSells.length > 0 && (
    <>
      <div className="track-title" style={{ marginTop: 12 }}>🚀 New coins scorecard</div>
      <div className="track-grid">
        <div><small>Sells</small><b>{newSells.length}</b></div>
        <div><small>Profitable</small><b>{newSells.filter((t) => (t.pnlUsd ?? 0) > 0).length} of {newSells.length}</b></div>
        <div><small>New-coin P&amp;L</small><b className={newPnl >= 0 ? "up" : "down"}>{newPnl >= 0 ? "+" : ""}{fmtUsd(newPnl)}</b></div>
        <div><small>Coins traded</small><b>{new Set(newSells.map((t) => t.pool)).size}</b></div>
      </div>
      <p className="muted tiny">Judge new-coin trading on 100+ trades: a few lucky wins mean little when many new coins go to zero.</p>
    </>
  );
  if (!sells.length) return <div className="track">{newCoinsBlock}</div>;
  const scored = sells.filter((t) => typeof t.predictedWinPct === "number");
  const pnl = sells.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
  const avgPred = scored.length ? scored.reduce((a, t) => a + t.predictedWinPct!, 0) / scored.length : null;
  const hitRate = scored.length ? (scored.filter((t) => t.reachedTarget).length / scored.length) * 100 : null;
  const profitable = sells.filter((t) => (t.pnlUsd ?? 0) > 0).length;
  return (
    <div className="track">
      <div className="track-title">AI track record</div>
      <div className="track-grid">
        <div><small>Bot trades</small><b>{sells.length}</b></div>
        <div><small>Profitable</small><b>{profitable} of {sells.length}</b></div>
        <div><small>Bot P&amp;L</small><b className={pnl >= 0 ? "up" : "down"}>{pnl >= 0 ? "+" : ""}{fmtUsd(pnl)}</b></div>
        <div><small>AI predicted</small><b>{avgPred === null ? "–" : `${avgPred.toFixed(0)}% win`}</b></div>
        <div><small>Actually reached target</small><b>{hitRate === null ? "–" : `${hitRate.toFixed(0)}%`}</b></div>
      </div>
      <p className="muted tiny">
        {scored.length < 20
          ? `Only ${scored.length} scored trade${scored.length === 1 ? "" : "s"} so far: too few to judge. After 20–30, compare "predicted" with "actually reached": if the real rate stays well below the prediction, the AI's odds are too optimistic for this market.`
          : avgPred !== null && hitRate !== null && hitRate < avgPred - 10
            ? "The AI's odds have been too optimistic: real results are clearly below its predictions. Raise the minimum win chance or trade less."
            : "Real results are close to the AI's predictions so far."}
      </p>
      {newCoinsBlock}
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
              <td className="hide-sm muted">{aiText(t.reason)}</td>
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
        <div key={i} className={l.level}><span className="muted mono">{new Date(l.t).toLocaleTimeString()}</span> {aiText(l.msg)}</div>
      ))}
    </div>
  );
}
