// Landing page at "/": live markets, a try-the-AI demo on real candles, a playable bot replay,
// features and interactive pricing. The trading app itself lives at /app.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, fmtBig, fmtPrice, type Candle, type ListCoin, type PlanInfo } from "./api";
import "./landing.css";

const APP = "/app";
const START = "/app?signin=1";

export default function Landing() {
  // Signed in already: straight to the app.
  useEffect(() => {
    api.me().then((r) => { if (r.user) window.location.replace(APP); }).catch(() => {});
  }, []);
  const [crypto, setCrypto] = useState<ListCoin[]>([]);
  const [top, setTop] = useState<ListCoin[]>([]);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  useEffect(() => {
    const load = () => {
      api.list("crypto").then((r) => setCrypto(r.coins)).catch(() => {});
      api.list("top").then((r) => setTop(r.coins.filter((c) => c.pair))).catch(() => {});
    };
    load();
    api.plans().then(setPlans).catch(() => {});
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Sections fade up as they scroll into view.
  useEffect(() => {
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.12 });
    document.querySelectorAll(".lp-reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  });

  return (
    <div className="lp">
      <div className="lp-bg" aria-hidden="true" />
      <Nav />
      <Hero coins={top} />
      <Ticker coins={crypto} />
      <LiveMarkets crypto={crypto} top={top} />
      <AIDemo coins={top} />
      <BotSim />
      <Features />
      <Pricing plans={plans} />
      <Faq />
      <section className="lp-cta lp-reveal">
        <h2>Practice with the AI today. <span className="lp-grad">Free.</span></h2>
        <p>Start with a paper account: real prices, practice money, no card.</p>
        <a className="lp-btn primary big" href={START}>Start free</a>
      </section>
      <footer className="lp-foot">
        <span className="lp-brand small"><span className="lp-logo">◢◤</span>TRADING<b>//</b>RUST</span>
        <nav>
          <a href={`${APP}#guide`}>User guide</a>
          <a href={`${APP}#privacy`}>Privacy Policy</a>
          <a href={`${APP}#terms`}>Terms &amp; Conditions</a>
        </nav>
        <p>Trading is at your own risk. Crypto, and small coins above all, can lose most of their value in minutes. AI plans are estimates and are often wrong. Nothing here is financial advice.</p>
      </footer>
    </div>
  );
}

function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const links = [["#markets", "Markets"], ["#demo", "Try the AI"], ["#bot", "Bot replay"], ["#features", "Features"], ["#pricing", "Pricing"]];
  return (
    <header className={`lp-nav ${scrolled ? "solid" : ""}`}>
      <a className="lp-brand" href="/"><span className="lp-logo">◢◤</span>TRADING<b>//</b>RUST</a>
      <nav className={menu ? "open" : ""}>
        {links.map(([h, t]) => <a key={h} href={h} onClick={() => setMenu(false)}>{t}</a>)}
      </nav>
      <div className="lp-nav-cta">
        <a className="lp-btn ghost" href={START}>Sign in</a>
        <a className="lp-btn primary" href={APP}>Launch app</a>
        <button className="lp-burger" onClick={() => setMenu((v) => !v)} aria-label="Menu" aria-expanded={menu}><span /><span /><span /></button>
      </div>
    </header>
  );
}

// ---------- Hero: headline + an orbiting AI core with live coins around it ----------
function Hero({ coins }: { coins: ListCoin[] }) {
  const stage = useRef<HTMLDivElement>(null);
  // The orbit tilts toward the pointer.
  const onMove = (e: React.PointerEvent) => {
    const r = stage.current?.getBoundingClientRect();
    if (!r) return;
    stage.current!.style.setProperty("--rx", `${((e.clientY - r.top) / r.height - 0.5) * -14}deg`);
    stage.current!.style.setProperty("--ry", `${((e.clientX - r.left) / r.width - 0.5) * 18}deg`);
  };
  const shown = coins.filter((c) => c.icon).slice(0, 6);
  return (
    <section className="lp-hero">
      <div className="lp-hero-text">
        <span className="lp-pill"><i className="lp-live" /> Live on Solana · paper &amp; real trading</span>
        <h1>Your AI co-pilot for <span className="lp-grad">memecoin trading</span></h1>
        <p>It reads every timeframe, spots chart patterns, learns from your own results and writes a plan: where to buy, where to get out, where to take profit. Then a bot carries it out every 5 seconds, even with the page closed.</p>
        <div className="lp-hero-cta">
          <a className="lp-btn primary big" href={START}>Start free</a>
          <a className="lp-btn ghost big" href="#demo">Try the AI demo ↓</a>
        </div>
        <div className="lp-hero-stats">
          <Stat value="5s" label="price checks" />
          <Stat value="4" label="timeframes read" />
          <Stat value="9" label="chart patterns" />
          <Stat value="3" label="agents at once" />
        </div>
      </div>
      <div className="lp-hero-art" ref={stage} onPointerMove={onMove} onPointerLeave={() => { stage.current?.style.setProperty("--rx", "0deg"); stage.current?.style.setProperty("--ry", "0deg"); }}>
        <div className="lp-orb">
          <span className="lp-ring r1"><i /></span>
          <span className="lp-ring r2"><i /></span>
          <span className="lp-ring r3"><i /></span>
          <span className="lp-core">AI</span>
          {shown.map((c, i) => (
            <a key={c.mint} className="lp-float" href={APP} style={{ "--i": i, "--n": shown.length } as CSSProperties} title={`Open ${c.symbol} in the app`}>
              <img src={c.icon} alt="" />
              <span><b>{c.symbol}</b><small className={c.change24h >= 0 ? "up" : "down"}>{c.change24h >= 0 ? "+" : ""}{c.change24h.toFixed(1)}%</small></span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return <div className="lp-stat"><b>{value}</b><span>{label}</span></div>;
}

// ---------- Live ticker ----------
function Ticker({ coins }: { coins: ListCoin[] }) {
  const row = coins.slice(0, 24);
  if (!row.length) return <div className="lp-ticker empty" />;
  const items = [...row, ...row];
  return (
    <div className="lp-ticker" aria-label="Live prices">
      <div className="lp-ticker-track">
        {items.map((c, i) => (
          <span key={`${c.mint}${i}`} className="lp-tick">
            {c.icon ? <img src={c.icon} alt="" /> : null}
            <b>{c.symbol}</b> {fmtPrice(c.priceUsd)}
            <em className={c.change24h >= 0 ? "up" : "down"}>{c.change24h >= 0 ? "▲" : "▼"} {Math.abs(c.change24h).toFixed(2)}%</em>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- Live markets ----------
function LiveMarkets({ crypto, top }: { crypto: ListCoin[]; top: ListCoin[] }) {
  const [tab, setTab] = useState<"top" | "crypto">("top");
  const list = (tab === "top" ? top : crypto).slice(0, 8);
  return (
    <section id="markets" className="lp-section lp-reveal">
      <div className="lp-head">
        <span className="lp-kicker">Live markets</span>
        <h2>Real prices, refreshed as you watch</h2>
        <p>The same data the app trades on. Trending Solana coins are ranked by momentum; major coins by market rank.</p>
      </div>
      <div className="lp-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "top"} className={tab === "top" ? "on" : ""} onClick={() => setTab("top")}>Trending on Solana</button>
        <button role="tab" aria-selected={tab === "crypto"} className={tab === "crypto" ? "on" : ""} onClick={() => setTab("crypto")}>Major coins</button>
      </div>
      <div className="lp-market-grid">
        {list.length ? list.map((c) => <MarketCard key={c.mint} c={c} />) : Array.from({ length: 8 }, (_, i) => <div key={i} className="lp-mcard skeleton" />)}
      </div>
    </section>
  );
}

function MarketCard({ c }: { c: ListCoin }) {
  // Flash green/red when the price changes on a refresh.
  const prev = useRef(c.priceUsd);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (prev.current !== c.priceUsd) {
      setFlash(c.priceUsd > prev.current ? "flash-up" : "flash-down");
      prev.current = c.priceUsd;
      const id = window.setTimeout(() => setFlash(""), 900);
      return () => window.clearTimeout(id);
    }
  }, [c.priceUsd]);
  const ch = Math.max(-100, Math.min(100, c.change24h));
  return (
    <a className={`lp-mcard ${flash}`} href={APP} onPointerMove={glow}>
      <div className="lp-mcard-top">
        {c.icon ? <img src={c.icon} alt="" /> : <span className="lp-noicon">{c.symbol.slice(0, 1)}</span>}
        <span><b>{c.symbol}</b><small>{c.rank ? `#${c.rank} · ` : ""}{c.name}</small></span>
      </div>
      <div className="lp-mcard-price">{fmtPrice(c.priceUsd)}</div>
      <div className="lp-mcard-row">
        <span className={c.change24h >= 0 ? "up" : "down"}>{c.change24h >= 0 ? "+" : ""}{c.change24h.toFixed(2)}%</span>
        <span className="muted">MC {fmtBig(c.mcap)}</span>
      </div>
      <div className="lp-bar"><i className={ch >= 0 ? "up" : "down"} style={{ width: `${Math.min(100, Math.abs(ch))}%` }} /></div>
      {c.verdict ? <span className={`lp-tag ${c.verdict === "BUY ZONE" ? "up" : c.verdict === "AVOID" ? "down" : "amber"}`}>{c.verdict === "BUY ZONE" ? "Hot" : c.verdict === "AVOID" ? "Cold" : "Mixed"}</span> : null}
    </a>
  );
}

// Cards light up where the pointer is.
function glow(e: React.PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
}

// ---------- Try-the-AI demo: real candles, a sample plan drawn by simple rules ----------
type DemoPlan = { stance: "WAIT FOR DIP" | "BUY BREAKOUT" | "AVOID"; buy: number; stop: number; target: number; win: number; patterns: { label: string; bias: "up" | "down" | "neutral" }[]; why: string };

function demoPlan(c: Candle[]): DemoPlan {
  const last = c.slice(-60);
  const closes = last.map((x) => x.close);
  const price = closes.at(-1)!;
  const lo = Math.min(...last.map((x) => x.low)), hi = Math.max(...last.map((x) => x.high));
  const range = hi - lo || price * 0.05;
  const atr = last.slice(-14).reduce((s, x) => s + (x.high - x.low), 0) / 14 || price * 0.01;
  const ema = (n: number) => closes.reduce((e, v, i) => (i ? v * (2 / (n + 1)) + e * (1 - 2 / (n + 1)) : v), closes[0]);
  const up = ema(9) > ema(21);
  const prevHigh = Math.max(...last.slice(-21, -1).map((x) => x.high));
  const breakout = price > prevHigh;
  const recentRange = Math.max(...last.slice(-20).map((x) => x.high)) - Math.min(...last.slice(-20).map((x) => x.low));
  const patterns: DemoPlan["patterns"] = [];
  if (breakout) patterns.push({ label: "Breakout above the recent high", bias: "up" });
  if (recentRange < range * 0.35) patterns.push({ label: "Tight range (coiling)", bias: "neutral" });
  patterns.push(up ? { label: "Fast average above slow", bias: "up" } : { label: "Fast average below slow", bias: "down" });
  if ((price - lo) / range > 0.9 && !breakout) patterns.push({ label: "Near the top of its range", bias: "down" });
  if (breakout && up) {
    const buy = prevHigh * 1.002;
    return { stance: "BUY BREAKOUT", buy, stop: buy - 2 * atr, target: buy + 3.5 * atr, win: 48, patterns, why: "Price is pushing through its recent high with the trend up: buy only if it holds above the level." };
  }
  if (!up && (price - lo) / range < 0.2) {
    return { stance: "AVOID", buy: lo + range * 0.05, stop: lo - 1.5 * atr, target: lo + range * 0.45, win: 31, patterns, why: "Falling and near its low: a crash is not a dip. Best to wait for it to stop falling." };
  }
  const buy = lo + range * 0.3;
  return { stance: "WAIT FOR DIP", buy, stop: buy - 1.8 * atr, target: lo + range * 0.88, win: up ? 52 : 41, patterns, why: "Wait for a pullback to support where it bounced before; exit below that support, take profit just under resistance." };
}

function AIDemo({ coins }: { coins: ListCoin[] }) {
  const choices = coins.filter((c) => c.pair && c.icon).slice(0, 5);
  const [pick, setPick] = useState<ListCoin | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [phase, setPhase] = useState<"idle" | "loading" | "thinking" | "done" | "error">("idle");
  const [step, setStep] = useState(0);
  const steps = ["Reading 5-minute candles", "Finding support and resistance", "Spotting chart patterns", "Weighing risk vs reward", "Writing the plan"];
  const run = async (c: ListCoin) => {
    setPick(c);
    setPhase("loading");
    setStep(0);
    try {
      const r = await api.candles(c.pair!.chain, c.pair!.pool, "5m");
      if (r.candles.length < 30) throw new Error("short");
      setCandles(r.candles.slice(-90));
      setPhase("thinking");
    } catch {
      setPhase("error");
    }
  };
  useEffect(() => {
    if (phase !== "thinking") return;
    if (step >= steps.length) return setPhase("done");
    const id = window.setTimeout(() => setStep((s) => s + 1), 520);
    return () => window.clearTimeout(id);
  }, [phase, step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pick && choices[0]) void run(choices[0]);
  }, [choices.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = useMemo(() => (candles.length >= 30 ? demoPlan(candles) : null), [candles]);

  return (
    <section id="demo" className="lp-section lp-reveal">
      <div className="lp-head">
        <span className="lp-kicker">Try the AI</span>
        <h2>Pick a coin. Watch a plan appear.</h2>
        <p>Real 5-minute candles, with a sample plan drawn by simple rules so you can see what an AI plan looks like. Sign in for the real AI.</p>
      </div>
      <div className="lp-demo">
        <div className="lp-demo-coins">
          {choices.length ? choices.map((c) => (
            <button key={c.mint} className={pick?.mint === c.mint ? "on" : ""} onClick={() => void run(c)}>
              <img src={c.icon} alt="" />
              <span><b>{c.symbol}</b><small>{fmtPrice(c.priceUsd)}</small></span>
            </button>
          )) : <div className="muted small">Loading trending coins…</div>}
        </div>
        <div className="lp-demo-main">
          <div className="lp-chart-card">
            {phase === "error" ? <div className="lp-chart-msg">This coin's chart isn't available right now. Pick another.</div>
              : candles.length ? <CandleChart candles={candles} plan={phase === "done" ? plan : null} />
              : <div className="lp-chart-msg">Loading the chart…</div>}
            {(phase === "thinking" || phase === "loading") && (
              <div className="lp-scan" aria-live="polite">
                <span className="lp-scan-line" />
                <span className="lp-scan-text">{phase === "loading" ? "Loading candles…" : `${steps[Math.min(step, steps.length - 1)]}…`}</span>
              </div>
            )}
          </div>
          <div className={`lp-plan ${phase === "done" && plan ? "show" : ""}`}>
            {plan && pick ? (
              <>
                <div className="lp-plan-top">
                  <span className={`lp-stance ${plan.stance === "AVOID" ? "down" : "up"}`}>{plan.stance}</span>
                  <span className="lp-demo-badge">DEMO</span>
                </div>
                <div className="lp-meter"><i style={{ width: `${plan.win}%` }} /><span>{plan.win}% sample win chance</span></div>
                <ul className="lp-levels">
                  <li><span>{plan.stance === "BUY BREAKOUT" ? "Buy above" : "Buy at"}</span><b className="cy">{fmtPrice(plan.buy)}</b></li>
                  <li><span>Exit if wrong</span><b className="down">{fmtPrice(plan.stop)}</b></li>
                  <li><span>Take profit from</span><b className="up">{fmtPrice(plan.target)}</b></li>
                </ul>
                <div className="lp-chips">{plan.patterns.map((p) => <span key={p.label} className={`lp-chip ${p.bias}`}>{p.bias === "up" ? "↑" : p.bias === "down" ? "↓" : "↔"} {p.label}</span>)}</div>
                <p className="lp-why">{plan.why}</p>
                <a className="lp-btn primary" href={START}>Get the real AI plan for {pick.symbol}</a>
              </>
            ) : <div className="lp-plan-wait">The plan appears here.</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function CandleChart({ candles, plan }: { candles: Candle[]; plan: DemoPlan | null }) {
  const W = 760, H = 300, P = 8;
  const lo0 = Math.min(...candles.map((c) => c.low)), hi0 = Math.max(...candles.map((c) => c.high));
  const lo = plan ? Math.min(lo0, plan.stop) : lo0, hi = plan ? Math.max(hi0, plan.target) : hi0;
  const pad = (hi - lo) * 0.06;
  const y = (v: number) => P + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 2 * P);
  const step = (W - 70) / candles.length;
  const lines = plan ? [
    { v: plan.target, c: "var(--up)", t: "TARGET" },
    { v: plan.buy, c: "var(--cyan)", t: plan.stance === "BUY BREAKOUT" ? "BUY ABOVE" : "BUY" },
    { v: plan.stop, c: "var(--down)", t: "EXIT" },
  ] : [];
  return (
    <svg className="lp-candles" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Price chart">
      {[0.2, 0.4, 0.6, 0.8].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="lp-grid" />)}
      {candles.map((c, i) => {
        const x = i * step + step / 2, up = c.close >= c.open;
        return (
          <g key={c.time} className={up ? "cu" : "cd"} style={{ animationDelay: `${i * 6}ms` }}>
            <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} />
            <rect x={x - step * 0.32} width={step * 0.64} y={Math.min(y(c.open), y(c.close))} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} />
          </g>
        );
      })}
      {lines.map((l, i) => (
        <g key={l.t} className="lp-pline" style={{ animationDelay: `${i * 220}ms` }}>
          <line x1="0" x2={W - 70} y1={y(l.v)} y2={y(l.v)} stroke={l.c} strokeDasharray="5 5" pathLength={1} />
          <rect x={W - 68} y={y(l.v) - 9} width="66" height="18" rx="4" fill={l.c} />
          <text x={W - 35} y={y(l.v) + 4} textAnchor="middle">{l.t}</text>
        </g>
      ))}
    </svg>
  );
}

// ---------- Bot replay: a scripted trade, step by step ----------
type Scenario = "win" | "loss" | "second";
const SCEN: Record<Scenario, { label: string; keys: [number, number][] }> = {
  win: { label: "A winning trade", keys: [[0, 1.0], [14, 0.985], [24, 0.957], [30, 0.968], [44, 1.02], [58, 1.07], [70, 1.115], [80, 1.16], [92, 1.13], [104, 1.11]] },
  loss: { label: "A losing trade", keys: [[0, 1.0], [14, 0.98], [24, 0.957], [32, 0.975], [44, 0.945], [56, 0.915], [70, 0.9], [104, 0.89]] },
  second: { label: "AI second look", keys: [[0, 1.0], [14, 0.98], [24, 0.957], [34, 0.94], [44, 0.917], [52, 0.925], [64, 0.99], [76, 1.06], [86, 1.12], [96, 1.15], [104, 1.1]] },
};
const BUY = 0.96, STOP = 0.92, TARGET = 1.1;

function path(s: Scenario) {
  const k = SCEN[s].keys;
  let seed = s.length * 97;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280 - 0.5);
  const out: number[] = [];
  for (let i = 0; i <= 104; i++) {
    const j = k.findIndex(([t]) => t >= i);
    const [t1, v1] = k[Math.max(0, j)];
    const [t0, v0] = k[Math.max(0, j - 1)];
    const f = t1 === t0 ? 1 : (i - t0) / (t1 - t0);
    out.push(v0 + (v1 - v0) * (0.5 - Math.cos(f * Math.PI) / 2) + rnd() * 0.006);
  }
  return out;
}

type SimEvent = { i: number; text: string; tone: "info" | "good" | "bad" | "ai" };
function simulate(s: Scenario) {
  const p = path(s);
  const ev: SimEvent[] = [{ i: 0, text: "AI plan: buy the dip at 0.960, exit 0.920, target 1.100.", tone: "ai" }];
  const stops: (number | null)[] = [];
  let held = false, done = false, entry = 0, stop = STOP, best = 0, half = false, trail = false, peak = 0, looked = false, lockStep = 0;
  const marks: { i: number; kind: "buy" | "half" | "sell"; v: number }[] = [];
  p.forEach((v, i) => {
    if (done) return stops.push(null);
    if (!held) {
      if (v <= BUY) { held = true; entry = BUY; best = v; marks.push({ i, kind: "buy", v: BUY }); ev.push({ i, text: "Price touched 0.960: the bot buys.", tone: "good" }); }
      return stops.push(null);
    }
    best = Math.max(best, v);
    const gain = (best - entry) / entry;
    if (gain >= 0.045 && stop < entry * 1.035) { stop = entry * 1.035; ev.push({ i, text: "Up 4.5%: profit guard moves the exit above the buy price.", tone: "good" }); }
    if (gain >= 0.045) {
      const lock = entry + (best - entry) * 0.5;
      if (lock > stop) { stop = lock; const st = Math.floor(gain * 25); if (st > lockStep) { lockStep = st; ev.push({ i, text: `Profit lock raised to ${lock.toFixed(3)}: keeps half the best gain.`, tone: "info" }); } }
    }
    if (!half && v >= TARGET) { half = true; trail = true; peak = v; marks.push({ i, kind: "half", v }); ev.push({ i, text: "Target reached: sells half, the rest rides with a 3% trailing stop.", tone: "good" }); }
    if (trail) { peak = Math.max(peak, v); stop = Math.max(stop, peak * 0.97); }
    if (v <= stop) {
      if (s === "second" && !looked && stop < entry) {
        looked = true; stop = entry - 1.5 * (entry - STOP);
        ev.push({ i, text: `Stop touched. AI second look: support is holding, buyers are back, so it holds once with a last exit at ${stop.toFixed(3)}.`, tone: "ai" });
      } else {
        const pnl = ((v - entry) / entry) * 100;
        marks.push({ i, kind: "sell", v });
        ev.push({ i, text: `${trail ? "Trailing stop" : stop >= entry ? "Profit guard" : "Stop-loss"}: sells at ${v.toFixed(3)} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%${half ? " on the rest" : ""}).`, tone: pnl >= 0 ? "good" : "bad" });
        done = true;
      }
    }
    stops.push(stop);
  });
  return { p, ev, stops, marks };
}

function BotSim() {
  const [scen, setScen] = useState<Scenario>("win");
  const sim = useMemo(() => simulate(scen), [scen]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  // Starts playing the first time it scrolls into view.
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setPlaying(true); io.disconnect(); } }, { threshold: 0.4 });
    if (box.current) io.observe(box.current);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!playing) return;
    if (t >= sim.p.length - 1) { setPlaying(false); return; }
    const id = window.setTimeout(() => setT((x) => x + 1), 110 / speed);
    return () => window.clearTimeout(id);
  }, [playing, t, speed, sim.p.length]);
  const choose = (s: Scenario) => { setScen(s); setT(0); setPlaying(true); };
  const W = 760, H = 280, lo = 0.86, hi = 1.2;
  const x = (i: number) => (i / (sim.p.length - 1)) * (W - 70);
  const y = (v: number) => 10 + (1 - (v - lo) / (hi - lo)) * (H - 20);
  const upto = sim.p.slice(0, t + 1);
  const d = upto.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const stopPts = sim.stops.slice(0, t + 1).map((s, i) => (s == null ? null : [x(i), y(s)] as const)).filter(Boolean) as (readonly [number, number])[];
  const stopD = stopPts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
  const shownEv = sim.ev.filter((e) => e.i <= t);
  // Keep the newest event in view.
  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }, [shownEv.length]);
  return (
    <section id="bot" className="lp-section lp-reveal">
      <div className="lp-head">
        <span className="lp-kicker">Bot replay</span>
        <h2>See exactly how the bot trades</h2>
        <p>Play a trade from plan to sale. Watch the exit (red) only ever move up as the trade goes your way: profit guard, profit lock, take half, trailing stop.</p>
      </div>
      <div className="lp-sim" ref={box}>
        <div className="lp-sim-bar">
          <div className="lp-seg">
            {(Object.keys(SCEN) as Scenario[]).map((s) => <button key={s} className={scen === s ? "on" : ""} onClick={() => choose(s)}>{SCEN[s].label}</button>)}
          </div>
          <div className="lp-seg">
            <button onClick={() => (t >= sim.p.length - 1 ? choose(scen) : setPlaying((v) => !v))} aria-label={playing ? "Pause" : "Play"}>{playing ? "❚❚ Pause" : t >= sim.p.length - 1 ? "↻ Replay" : "▶ Play"}</button>
            {[1, 2, 4].map((s) => <button key={s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>{s}×</button>)}
          </div>
        </div>
        <div className="lp-sim-body">
          <svg className="lp-sim-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Bot replay chart">
            {[BUY, STOP, TARGET].map((v, i) => (
              <g key={v}>
                <line x1="0" x2={W - 70} y1={y(v)} y2={y(v)} className={`lp-sim-level l${i}`} />
                <text x={W - 4} y={y(v) + 4} textAnchor="end" className={`lp-sim-lbl l${i}`}>{["BUY 0.960", "EXIT 0.920", "TARGET 1.100"][i]}</text>
              </g>
            ))}
            <path d={stopD} className="lp-sim-stop" />
            <path d={d} className="lp-sim-price" />
            {upto.length ? <circle cx={x(t)} cy={y(upto[t])} r="5" className="lp-sim-dot" /> : null}
            {sim.marks.filter((m) => m.i <= t).map((m) => (
              <g key={`${m.kind}${m.i}`} className={`lp-mark ${m.kind}`}>
                <circle cx={x(m.i)} cy={y(m.v)} r="7" />
                <text x={x(m.i)} y={y(m.v) - 12} textAnchor="middle">{m.kind === "buy" ? "BUY" : m.kind === "half" ? "½ SOLD" : "SOLD"}</text>
              </g>
            ))}
          </svg>
          <ol className="lp-sim-log" ref={logRef}>
            {shownEv.map((e, k) => <li key={k} className={`${e.tone} ${k === shownEv.length - 1 ? "now" : ""}`}>{e.text}</li>)}
          </ol>
        </div>
        <input className="lp-scrub" type="range" min={0} max={sim.p.length - 1} value={t} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Scrub through the trade" />
        <p className="lp-note">A scripted example to show the rules, not a real trade or a promise of results.</p>
      </div>
    </section>
  );
}

// ---------- Features ----------
const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: "◎", title: "AI plans on four timeframes", text: "5-second to daily candles, volume, liquidity and buyers vs sellers, turned into standing orders with an exit, a target and an honest win chance." },
  { icon: "⌁", title: "Chart patterns, back-tested", text: "Breakouts, flags, double bottoms, tight ranges and more, each checked against how it played out earlier on the same chart." },
  { icon: "▤", title: "Learns from your trades", text: "A trade journal of your bots' real results goes into every plan, so the AI leans toward what actually works for you." },
  { icon: "⛨", title: "Eight scouts", text: "Trend, volume, real traders, holders, dev wallet, liquidity, momentum and age: every busy coin scored, deal-breakers flagged." },
  { icon: "↺", title: "AI second look", text: "When a trade touches its stop, the AI checks once more and holds only with a strict, capped last exit." },
  { icon: "⚡", title: "Up to 3 agents", text: "Each trades one coin with its own budget; its AI decides, and prices are checked every 5 seconds, even with the page closed." },
  { icon: "◈", title: "Your own Solana wallet", text: "Switch to Real mode and trade from a wallet only you control. You approve every swap." },
  { icon: "✎", title: "Pro chart tools", text: "Indicators, drawing tools, Fibonacci, measure, price or market-cap scale and screenshots." },
];
function Features() {
  return (
    <section id="features" className="lp-section lp-reveal">
      <div className="lp-head">
        <span className="lp-kicker">Features</span>
        <h2>Built to protect you first</h2>
        <p>Every rule is written down in the user guide, and every risky choice asks you first.</p>
      </div>
      <div className="lp-feat-grid">
        {FEATURES.map((f) => (
          <div key={f.title} className="lp-feat" onPointerMove={glow}>
            <span className="lp-feat-icon">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- Pricing ----------
function perks(p: PlanInfo): string[] {
  const out: string[] = [];
  const has = (x: string) => p.permissions.includes(x as never);
  out.push("Live charts and coin lists", "Paper trading with real prices");
  if (has("trade.limit")) out.push("Limit orders and Protect this trade");
  if (has("ai.analyze")) out.push(`AI plans · ${p.aiTokens >= 1e6 ? `${p.aiTokens / 1e6}M` : p.aiTokens} AI tokens a month`);
  if (has("bot.run")) out.push(`${p.bots ?? 1} AI bot${(p.bots ?? 1) > 1 ? "s" : ""} at once`);
  if (has("bot.autopick")) out.push("Auto-pick and risky mode");
  out.push(p.feePct === 0 ? "No transaction charges" : p.freeTrades > 0 ? `${p.freeTrades} trades a month free, then ${p.feePct}%` : `${p.feePct}% per trade`);
  return out;
}
function Pricing({ plans }: { plans: PlanInfo[] }) {
  const [yearly, setYearly] = useState(false);
  return (
    <section id="pricing" className="lp-section lp-reveal">
      <div className="lp-head">
        <span className="lp-kicker">Pricing</span>
        <h2>Start free. Add AI when you're ready.</h2>
        <div className="lp-toggle" role="radiogroup" aria-label="Billing">
          <button role="radio" aria-checked={!yearly} className={!yearly ? "on" : ""} onClick={() => setYearly(false)}>Monthly</button>
          <button role="radio" aria-checked={yearly} className={yearly ? "on" : ""} onClick={() => setYearly(true)}>Yearly <em>2 months free</em></button>
        </div>
      </div>
      <div className="lp-price-grid">
        {(plans.length ? plans : []).map((p) => {
          const month = yearly ? (p.priceUsd * 10) / 12 : p.priceUsd;
          const best = p.id === "pro";
          return (
            <div key={p.id} className={`lp-price ${best ? "best" : ""}`} onPointerMove={glow}>
              {best ? <span className="lp-best">Most popular</span> : null}
              <h3>{p.name}</h3>
              <div className="lp-amount">{p.priceUsd ? <><b>${month % 1 ? month.toFixed(2) : month}</b><span>/mo</span></> : <b>Free</b>}</div>
              <small className="muted">{p.priceUsd ? (yearly ? `$${p.priceUsd * 10} billed yearly` : "billed monthly") : "forever"}</small>
              <ul>{perks(p).map((x) => <li key={x}>{x}</li>)}</ul>
              <a className={`lp-btn ${best ? "primary" : "ghost"}`} href={START}>{p.priceUsd ? `Choose ${p.name}` : "Start free"}</a>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------- FAQ ----------
const FAQ: [string, ReactNode][] = [
  ["Is it real money?", "You start in Paper mode with practice money and real prices. Switch to Real mode in your profile to trade from your own Solana wallet; you approve every swap."],
  ["Does the AI guarantee profit?", "No. Its plans and win chances are estimates and are often wrong, and small coins can fall fast. The bot's rules limit losses, but trading is at your own risk."],
  ["Do I need to keep the page open?", "No. A scheduler wakes your bots about every minute and they check prices every 5 seconds."],
  ["Who holds my funds?", "You do. Your wallet is created and secured by Privy; we never hold your keys or your funds."],
  ["What limits an agent?", "Its budget. You choose how much each agent may invest; its AI decides when to buy and sell, and the agent stops when the budget is used up."],
];
function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="lp-section lp-reveal">
      <div className="lp-head"><span className="lp-kicker">FAQ</span><h2>Questions</h2></div>
      <div className="lp-faq">
        {FAQ.map(([q, a], i) => (
          <div key={q} className={`lp-q ${open === i ? "open" : ""}`}>
            <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>{q}<span>+</span></button>
            <div className="lp-a"><p>{a}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}
