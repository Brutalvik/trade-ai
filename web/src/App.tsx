import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { type FramePatterns, aiText, allBots, api, SIGNIN_EVENT, fmtBig, fmtPct, fmtPrice, fmtTime, fmtUsd, type Analysis, type AppState, type RealTrade, type PlanInfo, type User, type Candle, type PairInfo, type CheckedOrder, type Position, type Status, type Timeframe } from "./api";
import { Chart, type ChartLine } from "./Chart";
import { Footer } from "./Footer";
import { GuidePage } from "./Guide";
import { CoinSearch } from "./CoinSearch";
import { AgentsPanel, type AgentRequest } from "./Agents";
import { WalletButton } from "./Wallet";
import { Chevrons, CoinList, LIST_MAX, LIST_MIN, ListResizer } from "./CoinList";
import { RealTradePanel, solscanTx } from "./RealTrade";
import { paperCsv, paperPdf, realCsv, realPdf } from "./exportTrades";
import { AccessCtx, AccountButton, SIGNIN_PENDING, AdminModal, LockChip, PlansModal, SettingsButton, useAccess, type Access } from "./Account";
import { BotTradeNotifications, UpdateBanner } from "./Notifications";
import { isMuted, playTradeSound, setMuted, unlockAudioOnFirstGesture } from "./sounds";
import { saveAnalysis, saveChart, saveState, saveUi, savedAnalysis, savedChart, savedState, savedUi, type SavedAnalysis } from "./persist";

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
  // The user guide lives at #guide (linked from the footer, shareable; old #rules links still open it).
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const closeRules = () => {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    setHash("");
  };
  const [adminOpen, setAdminOpen] = useState(false);
  // The chart's "Start agent on X" button asks the Agents panel to open its window.
  const [agentReq, setAgentReq] = useState<AgentRequest | null>(null);
  // Arrived from the landing page's "Start free" / "Sign in": open the sign-in window once.
  useEffect(() => {
    const u = new URL(window.location.href);
    if (u.searchParams.get("signin") !== "1") return;
    u.searchParams.delete("signin");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    sessionStorage.setItem(SIGNIN_PENDING, "1");
    window.dispatchEvent(new Event(SIGNIN_EVENT));
  }, []);
  const loadMe = useCallback(() => api.me().then((r) => setMe(r.user)).catch(() => setMe(null)), []);
  useEffect(() => {
    void loadMe();
    void api.plans().then(setPlans).catch(() => {});
    const id = setInterval(() => void loadMe(), 60_000); // keeps the token meter current
    return () => clearInterval(id);
  }, [loadMe]);
  const access = useMemo<Access & { plans: PlanInfo[] }>(
    () => ({ me, plans, can: (perm) => (me ? (me.permissions ?? []).includes(perm) : true), openPlans: () => setPlansOpen(true), openAdmin: () => setAdminOpen(true), reloadMe: () => void loadMe() }),
    [me, plans, loadMe],
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
  const [tab, setTab] = useState<"positions" | "trades" | "log">(() => { const t = savedUi().tab; return t === "trades" || t === "log" ? t : "positions"; });
  useEffect(() => saveUi({ pair: pair ?? undefined, tf, tab }), [pair, tf, tab]);
  useEffect(() => { if (state) saveState(state); }, [state]);
  // Chart maximize: fills the window; Esc (or the button) brings it back.
  const [chartMax, setChartMax] = useState(false);
  // Desktop: the three columns fill the window below the header and banners exactly.
  const layoutRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const set = () => {
      const el = layoutRef.current;
      if (el) document.documentElement.style.setProperty("--layout-top", `${Math.round(el.getBoundingClientRect().top + window.scrollY)}px`);
    };
    set();
    window.addEventListener("resize", set);
    return () => window.removeEventListener("resize", set);
  });
  // Growth ladder under Positions: shown on desktop, hidden on tablets / phones, until you choose.
  const [showLadder, setShowLadder] = useState(() => {
    const v = localStorage.getItem("nexus-ladder");
    return v ? v === "1" : window.innerWidth > 1180;
  });
  // Chart height: drag the handle between the chart and Positions (remembered).
  const [chartH, setChartH] = useState(() => Math.max(CHART_MIN, Math.min(CHART_MAX, Number(localStorage.getItem("nexus-chart-h")) || 420)));
  // Left coin-list panel: collapsible and resizable (both remembered).
  const [listCollapsed, setListCollapsed] = useState(() => localStorage.getItem("nexus-list-collapsed") === "1");
  const [listW, setListW] = useState(() => Math.max(LIST_MIN, Math.min(LIST_MAX, Number(localStorage.getItem("nexus-list-w")) || 300)));
  const collapseList = (v: boolean) => {
    setListCollapsed(v);
    localStorage.setItem("nexus-list-collapsed", v ? "1" : "0");
  };
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
    if (!msg) return; // e.g. "sign in needed": the sign-in window opens instead of a toast
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

  // Which coin / timeframe is on screen now, so a slow answer for a coin you've left is ignored.
  const showing = useRef("");
  showing.current = `${pair?.pool}:${tf}`;
  useInterval(() => {
    if (!pair) return;
    const want = `${pair.pool}:${tf}`;
    api
      .candles(pair.chain, pair.pool, tf)
      .then((r) => {
        if (showing.current !== want) return; // you've moved on: don't show this coin's candles
        setCandles(r.candles);
        setSource({ source: r.source, note: r.note });
        saveChart(pair.pool, tf, r.candles, r.source);
      })
      .catch((e) => setSource({ source: "unavailable", note: e.message }));
    api.pair(pair.chain, pair.pool).then((p) => setPair((cur) => (cur && cur.pool === p.pool ? { ...cur, ...p } : cur))).catch(() => {});
  }, tf === "1s" ? 3_000 : tf === "5s" ? 5_000 : 15_000, [pair?.pool, tf]);

  useInterval(() => {
    api.state().then(setState).catch(() => {});
  }, allBots(state).some((b) => b.bot.running) ? 2_000 : 5_000, [allBots(state).some((b) => b.bot.running)]); // faster while the bot trades, so buys/sells show up quickly

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
  const botHere = allBots(state).find((b) => b.bot.running && (b.bot.config?.pool === pair?.pool || b.bot.target?.pool === pair?.pool)) ?? allBots(state).find((b) => b.lastSignal?.pool === pair?.pool);
  const botSig = botHere && botHere.lastSignal?.pool === pair?.pool ? botHere.lastSignal : null;
  // A plan you saved before the latest trade on this coin is outdated: every new trade
  // starts from a fresh analysis.
  const lastTradeAt = useMemo(() => Math.max(0, ...(state?.trades ?? []).filter((t) => t.pool === pair?.pool).map((t) => t.time)), [state?.trades, pair?.pool]);
  const savedPlan = analysis && analysis.at >= lastTradeAt ? analysis : null;
  // Signed out: no real AI plans (only a demo in the AI panel), and no plan lines on the chart.
  const demo = !!state?.signedOut;
  // An agent running on this coin: only its own plan is shown (your earlier analysis of the coin
  // is not what it trades on, so its levels must not appear on the chart as if they were).
  const agentHere = !!botHere && botHere.bot.running && botHere.bot.config?.pool === pair?.pool;
  const shownPlan = demo ? null : agentHere ? botSig : savedPlan && (!botSig || savedPlan.at >= botSig.at) ? savedPlan : botSig;
  const sig = shownPlan?.consensus;
  const results = shownPlan?.results;
  const botOnThisCoin = allBots(state).some((b) => b.bot.running && b.bot.config?.pool === pair?.pool && (b.bot.config?.pick === "this" || b.bot.config?.pick === "agent"));
  // The bot is really fetching a plan for this coin: running here, not paused (skip / limits),
  // and not holding the coin (a holding bot manages its trade instead of planning).
  const botPausedHere = allBots(state).find((b) => b.bot.running && b.bot.config?.pool === pair?.pool && b.bot.blocked)?.bot.blocked ?? null;
  const botHolding = !!state?.positions.some((p) => p.source === "bot" && p.pool === pair?.pool);
  const botPlanning = botOnThisCoin && !botPausedHere && !botHolding;
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
        pos.pm ? { price: pos.stopLoss ?? pos.pm.floor, color: "#ffc857", title: "PROFIT EXIT" } : { price: pos.stopLoss ?? 0, color: "#ff3d71", title: "EXIT" },
        pos.trailing && pos.peak ? { price: pos.peak * (1 - trail / 100), color: "#ffc857", title: "TRAILING STOP" } : { price: pos.target ?? 0, color: "#00f5a0", title: "TARGET" },
      ];
    }
    if (!sig?.orders?.length) return [];
    // Only orders that passed their check are buy lines (with the first one's target and exit).
    // A level that failed is drawn grey and named as not used, so it never looks like a live order.
    const live = sig.orders.filter((o) => !o.warning);
    if (!live.length) return sig.orders.map((o) => ({ price: o.triggerPrice, color: "#7182a8", title: o.kind === "buy_breakout" ? "BREAKOUT (NOT USED)" : o.kind === "buy_dip" ? "DIP (NOT USED)" : "BUY NOW (NOT USED)" }));
    const out: ChartLine[] = live.map((o) => ({ price: o.triggerPrice, color: "#00e5ff", title: o.kind === "buy_breakout" ? "BUY ABOVE" : "BUY BELOW" }));
    out.push({ price: live[0].target, color: "#00f5a0", title: "TARGET" }, { price: live[0].stopLoss, color: "#ff3d71", title: "EXIT" });
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
      {status?.storage === "temp" && (
        <div className="banner">
          <b>The bot can't stay on yet.</b> This server has nowhere permanent to save the bot and your paper account, so they reset. Add the free Upstash Redis database in Vercel (Storage tab), then redeploy. Steps are in the README.
        </div>
      )}

      <main ref={layoutRef} className={`layout ${listCollapsed ? "list-collapsed" : ""}`} style={{ "--list-w": `${listW}px` } as CSSProperties}>
        {listCollapsed ? (
          <aside className="coin-side collapsed" aria-label="Coin lists (collapsed)">
            <button className="panel-toggle" onClick={() => collapseList(false)} data-tip="Expand panel" aria-label="Expand coin lists">
              <Chevrons dir="right" />
              <span className="panel-toggle-label">Coin lists</span>
            </button>
          </aside>
        ) : (
          <aside className="panel coin-side" aria-label="Coin lists">
            <CoinList onSelect={selectPair} selectedMint={pair?.tokenAddress} notify={notify} onCollapse={() => collapseList(true)} />
            <ListResizer width={listW} onChange={setListW} onDone={(w) => localStorage.setItem("nexus-list-w", String(w))} />
          </aside>
        )}

        <section className={`panel chart-panel ${chartMax ? "maximized" : ""}`} style={{ "--chart-h": `${chartH}px` } as CSSProperties}>
          {!chartMax && <RowResizer height={chartH} onChange={setChartH} onDone={(h) => localStorage.setItem("nexus-chart-h", String(h))} />}
          <PairHeader pair={pair} tf={tf} setTf={(t) => { if (t !== tf) { setTf(t); setCandles((pair && savedChart(pair.pool, t)?.candles) || []); } }} />
          {candles.length ? <Chart candles={candles} trades={pairTrades} lines={lines} seconds={isSeconds(tf)} viewKey={`${pair?.pool}:${tf}`} drawKey={pair?.pool ?? ""} symbol={pair?.symbol ?? "chart"} mcapFactor={pair && pair.priceUsd > 0 && pair.marketCap > 0 ? pair.marketCap / pair.priceUsd : 0} /> : <div className="chart empty">{pair ? <ChartLoading symbol={pair.symbol} icon={pair.imageUrl} /> : "Search a ticker to begin"}</div>}
          <div className="legend">
            {pair && me?.tradeMode !== "real" ? (() => {
              // Start an agent on the coin on screen (or open the one already working it).
              const here = allBots(state).find((b) => b.bot.running && (b.bot.config?.pool ?? b.bot.target?.pool) === pair.pool);
              return (
                <button className={`chart-size-btn agent-here ${here ? "on" : ""}`} title={here ? `Open the ${pair.symbol} agent` : `Give an agent a budget to trade ${pair.symbol}`}
                  onClick={() => {
                    if (!me) return void window.dispatchEvent(new Event(SIGNIN_EVENT));
                    if (chartMax) setChartMax(false);
                    setAgentReq(here ? { kind: "open", pool: pair.pool } : { kind: "start", pair });
                  }}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 8V4M8 4h8M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM9 13v2M15 13v2" /></svg>
                  <span>{here ? `Agent on ${pair.symbol}` : `Start agent on ${pair.symbol}`}</span>
                </button>
              );
            })() : null}
            <button className="chart-size-btn" onClick={() => setChartMax((v) => !v)} aria-pressed={chartMax} title={chartMax ? "Minimize (Esc)" : "Fill the window"} aria-label={chartMax ? "Minimize chart" : "Maximize chart"}>
              {chartMax ? (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
              )}
              {chartMax ? "Minimize" : "Maximize"}
            </button>
            {lines.filter((l, i) => l.price > 0 && lines.findIndex((x) => x.title === l.title) === i).map((l) => (
              <span key={l.title} title={LINE_HELP[l.title] ?? ""}>
                <i className="dash" style={{ borderColor: l.color }} />
                {LINE_NAME[l.title] ?? l.title} {fmtPrice(l.price)}
              </span>
            ))}
          </div>
        </section>

        <aside className="side right">
          {me?.tradeMode === "real" ? <RealTradePanel pair={pair} notify={notify} /> : <TradePanel pair={pair} state={state} notify={notify} refresh={() => api.state().then(setState)} />}
          {demo ? <DemoSignal pair={pair} price={candles.at(-1)?.close ?? pair?.priceUsd} /> : <SignalPanel pair={pair} tf={tf} sig={sig} results={results} cost={state?.roundTripCostPct ?? 3} onResult={gotAnalysis} price={candles.at(-1)?.close ?? pair?.priceUsd} botOnThisCoin={botOnThisCoin} botPlanning={botPlanning} botPaused={botPausedHere} analyzedAt={shownPlan?.at} patterns={shownPlan?.patterns} notify={notify} hasAI={!!(status?.claude || status?.openai)} multi={!!(status?.claude && status?.openai)} botMinWin={botHere?.bot.running && botHere.bot.config ? (botHere.bot.config.allowRisky ? Math.min(botHere.bot.config.minConfidence, botHere.bot.config.riskyMinWin ?? 30) : botHere.bot.config.minConfidence) : undefined} botWaitForHold={botHere?.bot.running ? botHere.bot.config?.waitForHold : undefined} />}
          {me?.tradeMode === "real" ? <RealModeNotice what="bot" botRunning={allBots(state).some((b) => b.bot.running)} /> : (
            <AgentsPanel state={state} limit={me?.botLimit ?? (access.can("bot.run") ? 1 : 0)} notify={notify} refresh={() => api.state().then(setState)} onOpen={openPool} defaults={AGENT_DEFAULTS} request={agentReq} onRequestDone={() => setAgentReq(null)} />
          )}
        </aside>

        <section className="panel bottom">
          <div className="tabs">
            {(["positions", "trades", "log"] as const).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t === "positions" ? `Positions (${state?.positions.length ?? 0})` : t === "trades" ? "Trade history" : "Agent log"}
              </button>
            ))}
            {tab === "positions" && (
              <label className="check small ladder-toggle" title="Show or hide the Growth ladder under your positions">
                <input type="checkbox" checked={showLadder} onChange={(e) => { setShowLadder(e.target.checked); localStorage.setItem("nexus-ladder", e.target.checked ? "1" : "0"); }} />
                <span>Growth ladder</span>
              </label>
            )}
          </div>
          {tab === "positions" && (
            <>
              <Positions state={state} notify={notify} refresh={() => api.state().then(setState)} onOpen={openPool} />
              {showLadder && <GoalLadder state={state} />}
            </>
          )}
          {tab === "trades" && (me?.tradeMode === "real" ? <RealTrades notify={notify} /> : <Trades state={state} notify={notify} />)}
          {tab === "log" && <BotLog state={state} />}
        </section>
      </main>

      <Footer />
      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`}>{toast.msg}</div>}
      {plansOpen && <PlansModal onClose={() => setPlansOpen(false)} />}
      {(hash === "#guide" || hash === "#rules") && <GuidePage plans={plans} onClose={closeRules} />}
      {adminOpen && <AdminModal onClose={() => { setAdminOpen(false); void loadMe(); }} notify={notify} />}
    </div>
    </AccessCtx.Provider>
  );
}

// Speaker button before the wallet button: mutes/unmutes the bot's trade sounds.
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

  const { me } = useAccess();
  const real = me?.tradeMode === "real";
  // Real mode: the header shows your own wallet's value instead of the paper equity.
  const [walletUsd, setWalletUsd] = useState<number | null>(null);
  useEffect(() => {
    if (!real) return setWalletUsd(null);
    const load = () => api.wallet().then((w) => setWalletUsd(w.totalUsd)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [real, me?.username]);
  const eq = state?.equityNow ?? 0;
  const pnl = state ? eq - state.startCash : 0;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">◢◤</span>
        <span>TRADING<b>//</b>RUST</span>
      </div>
      <CoinSearch onSelect={onSelect} notify={notify} />
      <div className="stats">
        {me && <SettingsButton alerts={status?.alerts ?? null} fee={state?.settings.feePct ?? 1} slip={state?.settings.slippagePct ?? 0.5} onSaved={refresh} notify={notify} />}
        <SoundToggle />
        {me && <WalletButton notify={notify} state={state} />}
        {me && <span className={`ai-dot ${status?.claude ? "on" : ""}`} title="AI key">AI</span>}
        {me && status?.openai && <span className="ai-dot on" title="OpenAI API key">GPT</span>}
        {!me ? null : real ? (
          <div className="equity">
            <small>WALLET</small>
            <b>{walletUsd === null ? "…" : fmtUsd(walletUsd)}</b>
          </div>
        ) : (
          <div className="equity">
            <small>EQUITY</small>
            <b>{fmtUsd(eq)}</b>
            <small className={pnl >= 0 ? "up" : "down"}>{fmtUsd(pnl)}</small>
          </div>
        )}
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
  // An agent's order: judged on the combined chance of reaching +5% after fees before the stop.
  if (o.prediction) {
    const what = o.kind === "buy_dip" ? `a dip to ${fmtPrice(o.triggerPrice)}` : o.kind === "buy_breakout" ? `a breakout above ${fmtPrice(o.triggerPrice)}` : `buying now, up to ${fmtPrice(o.triggerPrice)}`;
    return (
      <div className={`order ${o.warning ? "risky" : ""}`}>
        <b>{o.warning ? `Not an order: ${what}` : describeOrder(o, waitForHold)}</b>
        <span className="tiny">
          <b className={o.warning ? "down" : "up"}>{Math.round(o.prediction.pWin)}% chance of reaching +5% after fees</b> · needs {Math.ceil(o.prediction.needPct)}% to be worth buying
        </span>
        <span className="muted tiny">
          Exit below <span className="down">{fmtPrice(o.stopLoss)}</span> · reaching +5% is worth about +{o.prediction.winNetPct.toFixed(1)}%, missing costs about {o.prediction.lossPct.toFixed(1)}% · max {Math.round(o.maxHoldMinutes)} min
        </span>
        {o.warning && <span className="order-warning">The agent won't buy here: the odds aren't good enough. See its window for every forecaster's number.</span>}
      </div>
    );
  }
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
      {o.warning && <span className="order-warning">⚠ Risky: {o.warning.replace(/^Fails the fee\/risk check: /, "it ")}</span>}
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

function SignalPanel(props: { pair: PairInfo | null; tf: Timeframe; sig?: Analysis["consensus"]; results?: Analysis["results"]; cost: number; onResult: (a: Analysis) => void; price?: number; botOnThisCoin: boolean; botPlanning?: boolean; botPaused?: string | null; analyzedAt?: number; patterns?: FramePatterns[]; notify: (m: string, bad?: boolean) => void; hasAI: boolean; multi: boolean; botMinWin?: number; botWaitForHold?: boolean }) {
  const access = useAccess();
  const { pair, tf, sig, results, cost, onResult, price, botOnThisCoin, analyzedAt, notify, hasAI, multi, botMinWin, botWaitForHold } = props; // (fees are already applied in each order's numbers)
  // Small by default (the Agents panel sits below it); the arrow in the title shows the full plan.
  const [small, setSmall] = useState(() => localStorage.getItem("nexus-signal-small") !== "0");
  const [loading, setLoading] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [glow, setGlow] = useState(false);
  // While analyzing: a step that changes every ~1.5 s. After: the (i) flips once like a coin.
  const [step, setStep] = useState(0);
  const [flip, setFlip] = useState(false);
  const wasLoading = useRef(false);
  useEffect(() => {
    if (loading) {
      setStep(0);
      const id = setInterval(() => setStep((x) => x + 1), 1500);
      wasLoading.current = true;
      return () => clearInterval(id);
    }
    if (wasLoading.current) {
      wasLoading.current = false;
      setFlip(true);
      const t = setTimeout(() => setFlip(false), 700);
      return () => clearTimeout(t);
    }
  }, [loading]);

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
    <div className={`panel signal-panel ${small ? "small" : ""}`}>
      <div className="panel-title ai-title">
        <span className="ai-title-left">
          <span>AI SIGNAL</span>
          {(() => {
            const can = !!(sig && (explain.why || sig.note));
            return (
              <button className={`info-btn ${glow && can ? "glow" : ""} ${flip && can ? "coin-flip" : ""}`} onClick={can ? openInfo : undefined} disabled={!can} aria-label="Why the AI decided this" title={can ? "Why the AI decided this" : "Analyze a coin to see why the AI decided"}>
                i
              </button>
            );
          })()}
          <button className="info-btn size-btn" onClick={() => { const v = !small; setSmall(v); localStorage.setItem("nexus-signal-small", v ? "1" : "0"); }} aria-pressed={!small} aria-label={small ? "Show the full AI plan" : "Make the AI panel smaller"} title={small ? "Show the full plan" : "Make this smaller"}>{small ? "▾" : "▴"}</button>
        </span>
        {loading ? (
          // While the AI works, the rest of the header becomes an animated "analyzing" bar.
          <div className="ai-working" role="status" aria-live="polite">
            <span className="ai-candles" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
            <span className="ai-working-text" key={step % AI_STEPS.length}>{AI_STEPS[step % AI_STEPS.length]}</span>
            <span className="ai-sweep-line" aria-hidden="true" />
          </div>
        ) : (
          <span className="title-actions">
            {(!sig && props.botPlanning) || botOnThisCoin ? null : access.can("ai.analyze") ? (
              <button className="btn ghost" onClick={() => run()} disabled={!pair || !hasAI}>{sig ? "Analyze again" : "Analyze"}</button>
            ) : (
              <LockChip label="AI plans" />
            )}
          </span>
        )}
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
              {loading ? "The AI is making a new plan…" : botOnThisCoin ? `The agent's own plan, made ${fmtAgo(analyzedAt)}. It looks again by itself.` : `Analyzed ${fmtAgo(analyzedAt)} · kept until you press Analyze again${stale ? ` (re-checking: ${stale})` : ", or until it can no longer play out"}`}
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
                sig.orders.some((o) => o.prediction)
                  ? <div className="avoid-setup">No buy order right now. These are the AI's best levels, but the odds at them aren't good enough, so the agent won't buy there. It looks again on its own.</div>
                  : <div className="avoid-setup">⚠ Risky setup: the AI advises against trading now. These are its best levels if you trade anyway.</div>
              ) : (
                <div className="label-sm">{botOnThisCoin ? "The agent's orders: it buys on its own the moment one triggers" : "The AI's suggested orders (nothing is bought unless you buy, or start an agent)"}</div>
              )}
              {sig.orders.map((o, i) => (
                <OrderCard key={i} o={o} minWin={botMinWin} waitForHold={botWaitForHold} />
              ))}
              <PatternChips patterns={props.patterns} />
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
          {props.botPlanning ? (
            <BotPlanning symbol={pair?.symbol ?? ""} icon={pair?.imageUrl} />
          ) : props.botPaused ? (
            <p className="muted small">The bot on this coin isn't trading right now ({props.botPaused}), so it isn't asking the AI for a plan. Press Analyze to see the AI's view anyway.</p>
          ) : (
            <p className="muted small">Press Analyze to get the AI's plan: standing orders (buy now, buy the dip, or buy the breakout) with exit prices and targets. {multi ? "Both models must agree on the plan." : "Orders only count if the gain clearly beats the risk after fees."}</p>
          )}
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
  // Cash you can spend yourself: budgets locked for running agents are left out.
  const cash = state?.available ?? state?.cash ?? 0;
  const lockedForAgents = state?.locked ?? 0;
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
      <div className="order-row">
      <div className="kind-toggle" role="radiogroup" aria-label="Order type">
        <button role="radio" aria-checked={kind === "market"} className={kind === "market" ? "on" : ""} onClick={() => setKind("market")} title="Buy or sell now at the current price">Market</button>
        <button role="radio" aria-checked={kind === "limit"} className={kind === "limit" ? "on" : ""} onClick={() => (access.can("trade.limit") ? setKind("limit") : access.openPlans())} title={access.can("trade.limit") ? undefined : "Limit orders are included from the Member plan"}>
          {!access.can("trade.limit") && "🔒 "}Limit
        </button>
      </div>
      <span className="available" data-tip={tab === "buy" && lockedForAgents > 0.005 ? `${fmtUsd(lockedForAgents)} more is locked for your agents` : undefined}><span className="muted">Available</span> <b>{tab === "buy" ? fmtUsd(cash) : pos ? `${pos.qty.toPrecision(4)} ${pos.symbol}` : "0"}</b></span>
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

// The safety limits every agent starts with (its entries and exits are its own rules).
const AGENT_DEFAULTS = { positionPct: 100, minConfidence: 45, analyzeEverySec: 1800, maxDrawdownPct: 25, breakEvenAtPct: 6, trailPct: 3, cooldownMin: 30, dailyLossPct: 10, maxDrop1hPct: 10, riskPerTradePct: 0, lockPct: 50 };

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
      {!state?.signedOut && <div className="row reset">
        <span className="muted small">Reset paper account to</span>
        <input type="number" value={cash} onChange={(e) => setCash(e.target.value)} />
        <button className="chip" onClick={() => confirm("Reset the paper account? Trade history will be cleared.") && api.reset(Number(cash))}>Reset</button>
      </div>}
    </div>
  );
}

const LINE_NAME: Record<string, string> = {
  BOUGHT: "Bought at",
  EXIT: "Stop-loss",
  "PROFIT EXIT": "Sells here (profit locked)",
  TARGET: "Take-profit",
  "TRAILING STOP": "Trailing stop",
  "PROTECT STOP": "Protection stop",
  "BUY BELOW": "Buy if it dips to",
  "BUY ABOVE": "Buy if it breaks above",
  "DIP (NOT USED)": "No order (odds too low): dip to",
  "BREAKOUT (NOT USED)": "No order (odds too low): breakout above",
  "BUY NOW (NOT USED)": "No order (odds too low): buying now up to",
  "LIMIT BUY": "Your limit buy",
  "LIMIT SELL": "Your limit sell",
};
const LINE_HELP: Record<string, string> = {
  BOUGHT: "The price the open position was bought at.",
  EXIT: "Sells automatically if the price falls to this line.",
  "PROFIT EXIT": "This trade is in profit. It sells if the price closes back at this line; the line follows the price up and never drops below the locked +5% minimum.",
  TARGET: "Profit target: at this price the bot starts trailing the high to lock in gains.",
  "TRAILING STOP": "Follows the price up; sells if it falls back to this line.",
  "PROTECT STOP": "Your manual trade sells if the price falls back to this line.",
  "BUY BELOW": "The AI's standing order: the bot buys if the price dips to this line.",
  "BUY ABOVE": "The AI's standing order: the agent buys if the price breaks above this line. If the order asks for extra trading volume (shown in the AI Signal card and the agent's window), the price alone is not enough.",
  "DIP (NOT USED)": "The AI's level for buying a dip. It did not pass the check on its odds, so nothing is bought at this line.",
  "BREAKOUT (NOT USED)": "The AI's level for buying a breakout. It did not pass the check on its odds, so nothing is bought at this line.",
  "BUY NOW (NOT USED)": "The AI's price for buying right away. It did not pass the check on its odds, so nothing is bought at this line.",
  "LIMIT BUY": "Your limit buy: fills automatically if the price falls to this line.",
  "LIMIT SELL": "Your limit sell: fills automatically if the price rises to this line.",
};

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

function Positions({ state, notify, refresh, onOpen }: { state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void; onOpen: (chain: string, pool: string) => void }) {
  if (!state?.positions.length) return <><p className="muted small pad">No open positions.</p><OpenOrders state={state} notify={notify} refresh={refresh} /></>;
  return (
    <>
    <OpenOrders state={state} notify={notify} refresh={refresh} />
    <div className="table-wrap">
      <table>
        <thead><tr><th>Token</th><th>By</th><th title="How much money went into this trade (including fees)">Invested</th><th>Entry</th><th>Now</th><th>P&L</th><th className="hide-sm">TP / SL</th><th className="hide-sm">Sell by</th><th /></tr></thead>
        <tbody>
          {state.positions.map((p) => {
            const value = p.qty * p.lastPrice;
            const pnl = value - p.costUsd;
            return (
              <tr
                key={p.id}
                className="pos-row"
                tabIndex={0}
                title={`Open the ${p.symbol} chart`}
                onClick={() => onOpen(p.chain, p.pool)}
                onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(p.chain, p.pool); }}
              >
                <td>
                  <span className="pos-token">
                    {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : <span className="pos-token-dot">{p.symbol.slice(0, 1)}</span>}
                    <b>{p.symbol}</b>
                  </span>
                </td>
                <td title={p.adopted ? "You bought it; the bot sells it" : undefined}>{p.source === "bot" ? `🤖 bot${state.bots?.length ? ` ${p.botId ?? 1}` : ""}${p.adopted ? " · yours" : ""}` : "manual"}</td>
                <td className="mono">{fmtUsd(p.costUsd)}</td>
                <td className="mono">{fmtPrice(p.entryPrice)}</td>
                <td className="mono">{fmtPrice(p.lastPrice)}</td>
                <td className={pnl >= 0 ? "up" : "down"}>{fmtUsd(pnl)} ({fmtPct((pnl / p.costUsd) * 100)})</td>
                <td className="hide-sm mono">{p.takeProfit ? fmtPrice(p.takeProfit) : "–"} / {p.stopLoss ? fmtPrice(p.stopLoss) : "–"}</td>
                <td className="hide-sm">{p.sellBy ? fmtTime(p.sellBy) : "–"}</td>
                <td className="pos-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
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

// What turning each safety setting off means (shown in the "I understand" popup and saved with it).
// Chart patterns found by code, shown under the AI's plan (the AI reads the same list).
function PatternChips({ patterns }: { patterns?: FramePatterns[] }) {
  const hits = (patterns ?? []).flatMap((f) => f.hits.map((h) => ({ ...h, tf: f.tf })));
  if (!patterns) return null;
  return (
    <div className="pattern-box">
      <div className="label-sm">Chart patterns the AI saw</div>
      {hits.length ? (
        <div className="pattern-chips">
          {hits.map((h) => (
            <span key={`${h.tf}:${h.key}`} className={`pattern-chip ${h.bias}`}
              data-tip={`${h.note}.${h.stat && h.stat.seen >= 2 ? ` Earlier on this chart: ${h.stat.worked} of ${h.stat.seen} times it followed through.` : " No earlier track record on this chart."}`}>
              {h.bias === "up" ? "↑" : h.bias === "down" ? "↓" : "↔"} {h.tf} {h.label.split(" (")[0].split(",")[0]}
              {h.stat && h.stat.seen >= 2 ? <b>{Math.round((h.stat.worked / h.stat.seen) * 100)}%</b> : null}
            </span>
          ))}
        </div>
      ) : (
        <div className="muted tiny">None clear right now.</div>
      )}
    </div>
  );
}

// Drag handle under the chart: drag up/down to make the chart shorter/taller (Positions moves with it).
const CHART_MIN = 260;
const CHART_MAX = 900;
function RowResizer({ height, onChange, onDone }: { height: number; onChange: (h: number) => void; onDone: (h: number) => void }) {
  const drag = useRef<{ y: number; h: number; last: number } | null>(null);
  // Never taller than the window allows: leave room for the header, the chart toolbars and some of Positions.
  const clamp = (h: number) => Math.max(CHART_MIN, Math.min(CHART_MAX, window.innerHeight - 330, Math.round(h)));
  return (
    <div
      className="row-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the chart"
      aria-valuemin={CHART_MIN}
      aria-valuemax={CHART_MAX}
      aria-valuenow={height}
      tabIndex={0}
      title="Drag to resize the chart"
      onPointerDown={(e) => {
        drag.current = { y: e.clientY, h: height, last: height };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing-row");
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const h = clamp(drag.current.h + e.clientY - drag.current.y);
        drag.current.last = h;
        onChange(h);
      }}
      onPointerUp={() => {
        if (drag.current) onDone(drag.current.last);
        drag.current = null;
        document.body.classList.remove("resizing-row");
      }}
      onDoubleClick={() => { onChange(420); onDone(420); }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const h = clamp(height + (e.key === "ArrowDown" ? 30 : -30));
        onChange(h);
        onDone(h);
      }}
    >
      <span />
    </div>
  );
}

// Placeholder while a coin's candles load: a glowing price line draws itself across a faint
// grid, a pulsing dot rides its tip, and the coin's icon and name sit above it.
const LOAD_PATH = "M0,167 C40,154 60,184 95,146 S150,96 185,121 S240,175 280,129 S340,58 380,83 S440,142 480,104 S540,54 600,66";
function ChartLoading({ symbol }: { symbol: string; icon?: string }) {
  return (
    <div className="chart-loading2" role="status" aria-label={`Loading the ${symbol} chart`}>
      <div className="cl-head">
        <span className="cl-status">Loading chart</span>
      </div>
      <svg className="cl-svg" viewBox="0 0 600 240" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <linearGradient id="clStroke" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#00e5ff" stopOpacity="0.15" />
            <stop offset="60%" stopColor="#00e5ff" />
            <stop offset="100%" stopColor="#b45cff" />
          </linearGradient>
          <linearGradient id="clFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#00e5ff" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#00e5ff" stopOpacity="0" />
          </linearGradient>
          <filter id="clGlow" x="-10%" y="-50%" width="120%" height="200%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {[48, 96, 144, 192].map((y) => <line key={y} x1="0" x2="600" y1={y} y2={y} className="cl-grid" />)}
        {[100, 200, 300, 400, 500].map((x) => <line key={x} x1={x} x2={x} y1="0" y2="240" className="cl-grid" />)}
        <path d={`${LOAD_PATH} L600,240 L0,240 Z`} fill="url(#clFill)" className="cl-area" />
        <path d={LOAD_PATH} pathLength={1} fill="none" stroke="url(#clStroke)" strokeWidth="3" strokeLinecap="round" filter="url(#clGlow)" className="cl-line" />
        <circle r="5" className="cl-tip">
          <animateMotion dur="2.4s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.75;1" calcMode="linear" path={LOAD_PATH} />
        </circle>
      </svg>
    </div>
  );
}

// What the AI is doing, shown in turn while it analyzes.
// While the bot fetches its next AI plan: the coin sits in a glowing core, three tilted orbits
// spin around it, sparks of chart data stream inward, and a pulse ripples out when a step finishes.
const PLAN_STEPS = ["Reading every timeframe", "Spotting chart patterns", "Checking the trade journal", "Weighing risk against reward", "Placing the orders"];
function BotPlanning({ symbol, icon }: { symbol: string; icon?: string }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setT(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  const step = Math.min(PLAN_STEPS.length - 1, Math.floor(t / 3));
  return (
    <div className="bot-planning" role="status" aria-live="polite" aria-label={`The bot is getting a fresh AI plan for ${symbol}`}>
      <div className="bp-stage" aria-hidden="true">
        <span className="bp-ripple" key={step} />
        <span className="bp-orbit o1"><i /></span>
        <span className="bp-orbit o2"><i /></span>
        <span className="bp-orbit o3"><i /></span>
        {Array.from({ length: 8 }, (_, i) => <span key={i} className="bp-spark" style={{ "--a": `${i * 45}deg`, "--d": `${(i % 4) * 0.35}s` } as CSSProperties} />)}
        <span className="bp-core">{icon ? <img src={icon} alt="" /> : <b>{symbol.slice(0, 1)}</b>}</span>
      </div>
      <div className="bp-text">
        <span className="bp-title">Planning the next trade</span>
        <span className="bp-step" key={t > 45 ? "slow" : step}>{t > 45 ? "Taking longer than usual: waiting for the AI…" : `${PLAN_STEPS[step]}…`}</span>
        <span className="bp-dots">
          {PLAN_STEPS.map((s, i) => <i key={s} className={i < step ? "done" : i === step ? "now" : ""} />)}
          <em>{t}s</em>
        </span>
      </div>
    </div>
  );
}

const AI_STEPS = ["Reading candles…", "Checking volume…", "Spotting the trend…", "Weighing risk…", "Writing the plan…"];

// Signed out: a clearly labelled example of what the AI panel shows, with a sign-in button.
function DemoSignal({ pair, price }: { pair: PairInfo | null; price?: number }) {
  const p = price ?? pair?.priceUsd ?? 0;
  return (
    <div className="panel demo-signal">
      <div className="panel-title"><span>AI SIGNAL</span><span className="demo-badge">DEMO</span></div>
      <p className="muted small">This is an example of the plan the AI writes for a coin. Sign in to get real plans{pair ? ` for ${pair.symbol}` : ""}.</p>
      <div className="demo-card">
        <div className="demo-stance"><b className="up">WAIT FOR DIP</b><span className="muted small">example · 58% confidence</span></div>
        <div className="demo-order">
          <b>Buy instantly if it dips to {p ? fmtPrice(p * 0.97) : "3% below now"}</b>
          <span className="small"><span className="up">52% win chance</span> · expected +2.1% per trade after fees</span>
          <span className="muted tiny">Exit below {p ? fmtPrice(p * 0.93) : "-7%"} · target {p ? fmtPrice(p * 1.09) : "+9%"}, then it rides the trend · max 120 min</span>
        </div>
        <p className="muted tiny">Example numbers only, not a prediction for this coin.</p>
      </div>
      <button className="btn buy wide" onClick={() => window.dispatchEvent(new Event(SIGNIN_EVENT))}>Sign in for the AI's real plan</button>
    </div>
  );
}

// CSV / PDF export of the full trade history (paper: every trade ever; real: your swaps).
function ExportButtons({ kind, notify }: { kind: "paper" | "real"; notify: (m: string, bad?: boolean) => void }) {
  const { me } = useAccess();
  const [busy, setBusy] = useState<"" | "csv" | "pdf">("");
  const run = async (fmt: "csv" | "pdf") => {
    setBusy(fmt);
    try {
      const who = { username: me?.username, name: me ? `${me.firstName} ${me.lastName}` : undefined };
      if (kind === "paper") {
        const items = (await api.tradeHistory(0, 5000)).items;
        if (!items.length) return notify("No trades to export yet", true);
        if (fmt === "csv") paperCsv(items);
        else await paperPdf(items, who);
      } else {
        const items = await api.realTrades(1000);
        if (!items.length) return notify("No real trades to export yet", true);
        if (fmt === "csv") realCsv(items);
        else await realPdf(items, who);
      }
      notify(`Trade history ${fmt.toUpperCase()} downloaded`);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  };
  return (
    <span className="export-btns">
      <button className="chip" onClick={() => void run("csv")} disabled={!!busy} title="Download every trade as a spreadsheet (CSV)">{busy === "csv" ? "…" : "⬇ CSV"}</button>
      <button className="chip" onClick={() => void run("pdf")} disabled={!!busy} title="Download a PDF report with a summary and every trade">{busy === "pdf" ? "Making PDF…" : "⬇ PDF"}</button>
    </span>
  );
}

function Trades({ state, notify }: { state: AppState | null; notify: (m: string, bad?: boolean) => void }) {
  if (!state?.trades.length) return <p className="muted small pad">No trades yet.</p>;
  const closed = state.trades.filter((t) => t.pnlUsd != null);
  const wins = closed.filter((t) => t.pnlUsd! > 0).length;
  const fees = state.trades.reduce((s, t) => s + t.feeUsd, 0);
  return (
    <div className="table-wrap">
      <TrackRecord state={state} />
      <div className="scan-head muted small history-head"><span>Win rate {closed.length ? ((wins / closed.length) * 100).toFixed(0) : 0}% over {closed.length} closed trades · fees paid {fmtUsd(fees)}</span><ExportButtons kind="paper" notify={notify} /></div>
      <table>
        <thead><tr><th>Time</th><th>Side</th><th>Token</th><th>Price</th><th>USD</th><th>P&L</th><th className="hide-sm">Reason</th></tr></thead>
        <tbody>
          {state.trades.slice(0, 100).map((t) => (
            <tr key={t.id}>
              <td>{fmtTime(t.time)}</td>
              <td className={t.side === "BUY" ? "up" : "down"}>{t.side}{t.source === "bot" ? ` 🤖${t.botId && t.botId !== "1" ? t.botId : ""}` : ""}</td>
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
  const bots = allBots(state);
  const many = bots.length > 1;
  const lines = bots.flatMap((b) => b.bot.log.map((l) => ({ ...l, bot: b.id }))).sort((a, b) => b.t - a.t).slice(0, 300);
  if (!lines.length) return <p className="muted small pad">Bot hasn't run yet.</p>;
  return (
    <div className="log">
      {lines.map((l, i) => (
        <div key={i} className={l.level}><span className="muted mono">{new Date(l.t).toLocaleTimeString()}</span> {many && <span className="bot-tag">Bot {l.bot}</span>} {aiText(l.msg)}</div>
      ))}
    </div>
  );
}

// Real mode: trading and the bot with your own wallet aren't switched on yet, so nothing
// pretends to trade real money. The paper bot (if on) keeps running in the background.
// Real mode's Trade history: swaps from your own wallet, each with its Solscan link.
function RealTrades({ notify }: { notify: (m: string, bad?: boolean) => void }) {
  const [rows, setRows] = useState<RealTrade[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const load = () => api.realTrades().then(setRows).catch((e) => setErr(e.message));
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);
  if (err) return <p className="down small pad">{err}</p>;
  if (!rows) return <p className="muted small pad">Loading…</p>;
  if (!rows.length) return <p className="muted small pad">No real trades yet.</p>;
  const amt = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));
  return (
    <div className="table-wrap">
      <div className="scan-head muted small history-head"><span>{rows.length} real swap{rows.length === 1 ? "" : "s"} from your wallet</span><ExportButtons kind="real" notify={notify} /></div>
      <table>
        <thead><tr><th>Time</th><th>Side</th><th>Token</th><th>Paid</th><th>Got</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={(t.signature ?? "") + i}>
              <td>{fmtTime(t.t)}</td>
              <td className={t.side === "BUY" ? "up" : "down"}>{t.side}</td>
              <td>{t.symbol}</td>
              <td className="mono">{amt(t.inAmount)} {t.inSymbol}</td>
              <td className="mono">{t.status === "Success" ? `${amt(t.outAmount)} ${t.outSymbol}` : "–"}</td>
              <td className={t.status === "Success" ? "up" : "down"} title={t.error}>{t.status === "Success" ? "Done" : "Failed"}</td>
              <td>{t.signature && <a href={solscanTx(t.signature)} target="_blank" rel="noreferrer">Solscan ↗</a>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RealModeNotice({ what, botRunning }: { what: "trade" | "bot"; botRunning?: boolean }) {
  return (
    <section className="panel real-notice">
      <h3>{what === "trade" ? "Trade · Real mode" : "Auto-pilot · Real mode"}</h3>
      <p>{what === "trade" ? "Buying and selling with your own wallet is switched on in the next update." : "The bot trading your own wallet is switched on in a later update, with limits you set."}</p>
      {what === "bot" && botRunning && <p className="muted small">Your paper bot is still running on the paper account.</p>}
      <p className="muted small">To trade now, switch back to <b>Paper</b> in your profile (top right).</p>
    </section>
  );
}
