import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtBig, fmtPct, fmtPrice, fmtTime, fmtUsd, type Analysis, type AppState, type BotConfig, type Candle, type PairInfo, type ScanChain, type ScanResult, type Timeframe } from "./api";
import { Chart } from "./Chart";

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
  }, tf === "1s" ? 3_000 : tf === "5s" ? 5_000 : 15_000, [pair?.pool, tf]);

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
          <PairHeader pair={pair} tf={tf} setTf={(t) => { if (t !== tf) { setTf(t); setCandles([]); } }} />
          {candles.length ? <Chart candles={candles} trades={pairTrades} levels={levels} seconds={isSeconds(tf)} viewKey={`${pair?.pool}:${tf}`} /> : <div className="chart empty">{pair ? "Loading candles..." : "Search a ticker to begin"}</div>}
          <div className="legend">
            <span><i style={{ background: "#00e5ff" }} />EMA 9</span>
            <span><i style={{ background: "#b45cff" }} />EMA 21</span>
            {sig?.action === "BUY" && <span className="muted">Dashed lines: AI entry / take-profit / stop</span>}
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
          {tab === "scanner" && <Scanner onSelect={selectPair} notify={notify} tf={tf} />}
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

type RiskKnobs = { positionPct: number; minConfidence: number; analyzeMin: number; maxDrawdownPct: number; breakEvenAtPct: number };
const PRESETS: Record<"safe" | "balanced" | "aggressive", RiskKnobs & { label: string; blurb: string }> = {
  safe: { label: "Safe", blurb: "Small trades, only very confident calls, tight emergency brake.", positionPct: 50, minConfidence: 80, analyzeMin: 30, maxDrawdownPct: 15, breakEvenAtPct: 4 },
  balanced: { label: "Balanced", blurb: "Most of your cash per trade, solid confidence required.", positionPct: 90, minConfidence: 70, analyzeMin: 15, maxDrawdownPct: 25, breakEvenAtPct: 6 },
  aggressive: { label: "Aggressive", blurb: "All-in trades, accepts weaker signals, wider brake. Bigger swings both ways.", positionPct: 100, minConfidence: 60, analyzeMin: 10, maxDrawdownPct: 40, breakEvenAtPct: 8 },
};
type PresetKey = keyof typeof PRESETS;
const KNOBS: (keyof RiskKnobs)[] = ["positionPct", "minConfidence", "analyzeMin", "maxDrawdownPct", "breakEvenAtPct"];
const matchPreset = (k: RiskKnobs): PresetKey | null => (Object.keys(PRESETS) as PresetKey[]).find((p) => KNOBS.every((n) => PRESETS[p][n] === k[n])) ?? null;

function BotPanel({ pair, tf, state, notify, refresh, multi }: { pair: PairInfo | null; tf: Timeframe; state: AppState | null; notify: (m: string, bad?: boolean) => void; refresh: () => void; multi: boolean }) {
  const running = state?.bot.running ?? false;
  const active = state?.bot.config;
  const startCash = state?.startCash ?? 10;
  const [cfg, setCfg] = useState<RiskKnobs & { goalUsd: number }>({ ...PRESETS.balanced, goalUsd: 15 });
  const set = (k: keyof typeof cfg) => (e: React.ChangeEvent<HTMLInputElement>) => setCfg({ ...cfg, [k]: Number(e.target.value) });
  const pick = (p: PresetKey) => setCfg({ ...cfg, ...Object.fromEntries(KNOBS.map((n) => [n, PRESETS[p][n]])) });

  // While running, describe what the bot is actually using.
  const shown: RiskKnobs & { goalUsd: number } =
    running && active ? { positionPct: active.positionPct, minConfidence: active.minConfidence, analyzeMin: Math.round(active.analyzeEverySec / 60), maxDrawdownPct: active.maxDrawdownPct, breakEvenAtPct: active.breakEvenAtPct, goalUsd: active.goalUsd } : cfg;
  const preset = matchPreset(shown);
  const cash = state?.cash ?? startCash;
  const perTrade = (cash * shown.positionPct) / 100;
  const floor = startCash * (1 - shown.maxDrawdownPct / 100);

  const start = async () => {
    if (!pair) return;
    const full: BotConfig = { chain: pair.chain, pool: pair.pool, symbol: pair.symbol, tf, positionPct: cfg.positionPct, minConfidence: cfg.minConfidence, analyzeEverySec: cfg.analyzeMin * 60, checkEverySec: 20, maxDrawdownPct: cfg.maxDrawdownPct, breakEvenAtPct: cfg.breakEvenAtPct, goalUsd: cfg.goalUsd };
    try {
      await api.startBot(full);
      notify(`Bot started on ${pair.symbol} (${preset ? PRESETS[preset].label : "Custom"})`);
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

      <div className="presets" role="radiogroup" aria-label="Risk level">
        {(Object.keys(PRESETS) as PresetKey[]).map((p) => (
          <button key={p} role="radio" aria-checked={preset === p} className={`preset ${p} ${preset === p ? "on" : ""}`} onClick={() => pick(p)} disabled={running}>
            {PRESETS[p].label}
          </button>
        ))}
      </div>
      <p className="preset-blurb small">{preset ? PRESETS[preset].blurb : "Custom settings."}</p>

      <ul className="plan small">
        <li>Puts <b>{fmtUsd(perTrade)}</b> into each trade ({shown.positionPct}% of cash)</li>
        <li>Buys only when Claude is <b>{shown.minConfidence}%+</b> sure, checking every {shown.analyzeMin} min</li>
        <li>Locks in no-loss once a trade is up <b>{shown.breakEvenAtPct}%</b></li>
        <li>Sells everything and stops if the account drops below <b>{fmtUsd(floor)}</b></li>
      </ul>

      <details className="advanced" open={!running && !preset ? true : undefined}>
        <summary className="small">Customize (what each setting means)</summary>
        <div className="grid2 knobs">
          <label>
            Money per trade (% of cash)
            <input type="number" value={shown.positionPct} onChange={set("positionPct")} disabled={running} />
            <small>{shown.positionPct}% of {fmtUsd(cash)} = {fmtUsd(perTrade)} per trade. The rest stays safe as cash.</small>
          </label>
          <label>
            How sure Claude must be (%)
            <input type="number" value={shown.minConfidence} onChange={set("minConfidence")} disabled={running} />
            <small>If Claude is less sure than this, the bot doesn't buy. Higher = fewer but safer trades.</small>
          </label>
          <label>
            Ask Claude every (minutes)
            <input type="number" value={shown.analyzeMin} onChange={set("analyzeMin")} disabled={running} />
            <small>How often it looks for a new trade. Each check costs a few cents, so smaller = more cost.</small>
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
            My target ($)
            <input type="number" value={shown.goalUsd} onChange={set("goalUsd")} disabled={running} />
            <small>Just a milestone: the bot notes when you reach it and keeps going.</small>
          </label>
        </div>
      </details>

      {running ? (
        <button className="btn sell wide" onClick={stop}>STOP BOT</button>
      ) : (
        <button className="btn buy wide" onClick={start} disabled={!pair}>START BOT ON {pair?.symbol ?? "…"}</button>
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
  const [chain, setChain] = useState<ScanChain>("all");
  const [data, setData] = useState<ScanResult | null>(null);
  const [err, setErr] = useState("");
  const [ai, setAi] = useState<Record<string, Analysis["consensus"] | "loading">>({});

  const load = (c = chain) => {
    setData(null);
    setErr("");
    api.scan(c).then(setData).catch(() => setTimeout(() => api.scan(c).then(setData).catch((e) => setErr(e.message)), 8000));
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
          <span>Top trending coins with a quick plan from the chart (free, no AI). Click <b>Ask Claude</b> for a proper plan before buying.</span>
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
                      <span className={`tag ${a.action.toLowerCase()}`}>Claude: {a.action} {a.confidence}%</span>
                    ) : (
                      <span className={`tag ${go ? "buy" : plan?.verdict === "AVOID" ? "sell" : "hold"}`}>{plan?.verdict ?? "DATA BUSY"}</span>
                    )}
                    <div className="muted tiny why">{a && a !== "loading" ? a.note : plan?.why}</div>
                  </td>
                  {a && a !== "loading" && a.action === "BUY" ? (
                    <>
                      <td className="mono up">{fmtPrice(a.entryPrice)}</td>
                      <td className="mono up">{fmtPrice(a.takeProfit)}</td>
                      <td className="mono down hide-sm">{fmtPrice(a.stopLoss)}</td>
                      <td className="hide-sm small">buy by {fmtTime(a.buyBy)}<br />sell by {fmtTime(a.sellBy)}</td>
                    </>
                  ) : go && plan && !(a && a !== "loading") ? (
                    <>
                      <td className="mono">{fmtPrice(plan.buyBelow)}</td>
                      <td className="mono up">{fmtPrice(plan.sellAt)}<div className="muted tiny">+{plan.netGainPct.toFixed(1)}% after fees</div></td>
                      <td className="mono down hide-sm">{fmtPrice(plan.exitBelow)}</td>
                      <td className="hide-sm small">buy by {fmtTime(plan.buyBy)}<br />sell by {fmtTime(plan.sellBy)}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="muted small">{a && a !== "loading" ? "Claude says don't buy now." : !plan ? "Chart data is busy. Rescan in a minute, or Ask Claude." : plan.verdict === "AVOID" ? "Don't buy." : "Wait for a clearer setup."}</td>
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
