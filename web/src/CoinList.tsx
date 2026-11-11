// Left sidebar: Solana coin lists (Crypto, Trending, Most held, Graduated, Bonding, Community).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtBig, fmtPrice, type ListCoin, type ListKind, type PairInfo } from "./api";

const KINDS: { id: ListKind; label: string; hint: string }[] = [
  { id: "crypto", label: "Crypto", hint: "All coins ranked by market cap (charts come from each coin's busiest on-chain market)" },
  { id: "top", label: "Top", hint: "Trending Solana coins ranked by a quick score from their price, volume and buyers (not AI)" },
  { id: "trending", label: "Trending", hint: "Trending on Solana in the last hour" },
  { id: "held", label: "Most held", hint: "Coins with the most holders" },
  { id: "graduated", label: "Graduated", hint: "pump.fun coins that finished their bonding curve, busiest first" },
  { id: "bonding", label: "Bonding", hint: "pump.fun coins still on their bonding curve: very early and very risky" },
  { id: "community", label: "Community", hint: "What TRADING//RUST traders bought most this week" },
];
const LS = "nexus-list-kind";
// Price like fomo: tiny prices get a subscript zero count, e.g. $0.0₅1679 = $0.000001679.
function Price({ p }: { p: number }) {
  if (!(p > 0)) return <>$0</>;
  if (p >= 0.001) return <>{fmtPrice(p)}</>;
  const zeros = -Math.floor(Math.log10(p)) - 1; // zeros right after "0."
  const digits = Math.round(p * 10 ** (zeros + 4)).toString().slice(0, 4);
  return <>$0.0<sub className="price-zeros">{zeros}</sub>{digits}</>;
}
const fmtCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

export function CoinList({ onSelect, selectedMint, notify, onCollapse }: { onSelect: (p: PairInfo) => void; selectedMint?: string; notify: (m: string, bad?: boolean) => void; onCollapse: () => void }) {
  const [kind, setKind] = useState<ListKind>(() => (KINDS.some((k) => k.id === localStorage.getItem(LS)) ? (localStorage.getItem(LS) as ListKind) : "crypto"));
  const [lists, setLists] = useState<Partial<Record<ListKind, ListCoin[]>>>({});
  const [err, setErr] = useState("");
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback((k: ListKind) => {
    setErr("");
    api.list(k).then((r) => setLists((l) => ({ ...l, [k]: r.coins }))).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    localStorage.setItem(LS, kind);
    load(kind);
    const id = setInterval(() => load(kind), 60_000);
    return () => clearInterval(id);
  }, [kind, load]);

  const open = async (c: ListCoin) => {
    if (c.pair) return onSelect(c.pair);
    setOpening(c.mint);
    try {
      let found: PairInfo | undefined;
      if (c.query) {
        // A ranked coin (any chain): its busiest market, or a wrapped version (BTC -> WBTC / cbBTC).
        const sym = c.query.toUpperCase();
        const names = [sym, `W${sym}`, `CB${sym}`, `${sym}.E`, `B${sym}`];
        // Copycat tokens reuse big names, so the market's price must also match the real coin's (±2%).
        const near = (p: PairInfo) => c.priceUsd > 0 && Math.abs(p.priceUsd - c.priceUsd) / c.priceUsd < 0.02;
        const res = [...(await api.search(sym)), ...(sym.length <= 5 ? await api.search(`W${sym}`).catch(() => []) : [])]
          .filter((p) => names.includes(p.symbol.toUpperCase()) && near(p))
          .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
        found = res[0];
      } else {
        found = (await api.search(c.mint)).filter((p) => p.chain === "solana" && p.tokenAddress === c.mint).sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
      }
      if (found) onSelect({ ...found, imageUrl: found.imageUrl ?? c.icon });
      else notify(`No chart found for ${c.symbol} yet`, true);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setOpening(null);
    }
  };

  // Tabs sit in one scrolling line; the arrows move to the previous / next list.
  const strip = useRef<HTMLDivElement>(null);
  const idx = KINDS.findIndex((k) => k.id === kind);
  const step = (d: number) => {
    const next = KINDS[Math.max(0, Math.min(KINDS.length - 1, idx + d))];
    if (next) setKind(next.id);
  };
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-kind="${kind}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [kind]);

  const coins = lists[kind];
  const meta = KINDS.find((k) => k.id === kind)!;
  return (
    <div className="coin-side-inner">
      <div className="coin-top">
        <button className="coin-arrow" onClick={() => step(-1)} disabled={idx === 0} aria-label="Previous list" title="Previous list">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <div className="coin-tabs" role="tablist" aria-label="Coin lists" ref={strip}>
          {KINDS.map((k) => (
            <button key={k.id} role="tab" aria-selected={kind === k.id} className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)} title={k.hint} data-kind={k.id}>
              {kind === k.id && <span className="coin-tab-dot" />}
              {k.label}
            </button>
          ))}
        </div>
        <button className="coin-arrow" onClick={() => step(1)} disabled={idx === KINDS.length - 1} aria-label="Next list" title="Next list">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
        <button className="panel-toggle" onClick={onCollapse} data-tip="Collapse panel" aria-label="Collapse coin lists"><Chevrons dir="left" /></button>
      </div>
      <p className="muted tiny coin-hint">{meta.hint}</p>
      <div className="coin-rows">
        {err && !coins && <p className="down small pad">{err}</p>}
        {!coins && !err && <p className="muted small pad">Loading…</p>}
        {coins && !coins.length && <p className="muted small pad">{kind === "community" ? "No buys from TRADING//RUST traders yet this week." : "Nothing here right now."}</p>}
        {coins?.map((c, i) => (
          <button key={c.mint} className={`coin-row ${selectedMint === c.mint ? "on" : ""}`} onClick={() => void open(c)} disabled={opening === c.mint}>
            {c.icon ? <img src={c.icon} alt="" loading="lazy" /> : <span className="coin-dot">{c.symbol.slice(0, 1)}</span>}
            <span className="coin-id">
              <b>{c.symbol}</b>
              <span className="muted">{kind === "crypto" ? `#${c.rank ?? i + 1} · ` : ""}{fmtBig(c.mcap)} MC</span>
            </span>
            <span className="coin-nums">
              <b><Price p={c.priceUsd} /></b>
              {kind === "top" && c.verdict ? (
                <span className={`verdict ${c.verdict === "BUY ZONE" ? "up" : c.verdict === "AVOID" ? "down" : "amber"}`} title={c.why}>{c.verdict === "BUY ZONE" ? "Buy zone" : c.verdict === "AVOID" ? "Avoid" : "Wait"}{c.score != null ? ` · ${c.score}` : ""}</span>
              ) : kind === "held" && c.holders ? (
                <span className="muted">{fmtCount(c.holders)} holders</span>
              ) : kind === "community" && c.buyers ? (
                <span className="muted">{c.buyers} trader{c.buyers === 1 ? "" : "s"}</span>
              ) : (
                <span className={c.change24h >= 0 ? "up" : "down"}>{c.change24h >= 0 ? "▲" : "▼"} {Math.abs(c.change24h).toFixed(2)}%</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Chevrons({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === "left" ? <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" /> : <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />}
    </svg>
  );
}

// Drag handle on the list's right edge: drag to resize the list (the middle column takes the rest).
export const LIST_MIN = 240;
export const LIST_MAX = 520;
export function ListResizer({ width, onChange, onDone }: { width: number; onChange: (w: number) => void; onDone: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number; last: number } | null>(null);
  const clamp = (w: number) => Math.max(LIST_MIN, Math.min(LIST_MAX, Math.round(w)));
  return (
    <div
      className="list-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize coin lists"
      aria-valuemin={LIST_MIN}
      aria-valuemax={LIST_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize"
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, w: width, last: width };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const w = clamp(drag.current.w + e.clientX - drag.current.x);
        drag.current.last = w;
        onChange(w);
      }}
      onPointerUp={() => {
        if (drag.current) onDone(drag.current.last);
        drag.current = null;
        document.body.classList.remove("resizing");
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const w = clamp(width + (e.key === "ArrowRight" ? 20 : -20));
        onChange(w);
        onDone(w);
      }}
    >
      <span />
    </div>
  );
}
