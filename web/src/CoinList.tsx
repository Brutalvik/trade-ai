// Left sidebar: Solana coin lists (Crypto, Trending, Most held, Graduated, Bonding, Community).
import { useCallback, useEffect, useState } from "react";
import { api, fmtBig, fmtPrice, type ListCoin, type ListKind, type PairInfo } from "./api";

const KINDS: { id: ListKind; label: string; hint: string }[] = [
  { id: "crypto", label: "Crypto", hint: "Biggest Solana coins by market cap" },
  { id: "trending", label: "Trending", hint: "Trending on Solana in the last hour" },
  { id: "held", label: "Most held", hint: "Coins with the most holders" },
  { id: "graduated", label: "Graduated", hint: "pump.fun coins that finished their bonding curve, busiest first" },
  { id: "bonding", label: "Bonding", hint: "pump.fun coins still on their bonding curve: very early and very risky" },
  { id: "community", label: "Community", hint: "What TRADING//RUST traders bought most this week" },
];
const LS = "nexus-list-kind";
const fmtCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

export function CoinList({ onSelect, selectedMint, notify }: { onSelect: (p: PairInfo) => void; selectedMint?: string; notify: (m: string, bad?: boolean) => void }) {
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
      const found = (await api.search(c.mint)).filter((p) => p.chain === "solana" && p.tokenAddress === c.mint).sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
      if (found) onSelect({ ...found, imageUrl: found.imageUrl ?? c.icon });
      else notify(`No chart found for ${c.symbol} yet`, true);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setOpening(null);
    }
  };

  const coins = lists[kind];
  const meta = KINDS.find((k) => k.id === kind)!;
  return (
    <div className="coin-side-inner">
      <div className="coin-chips" role="tablist" aria-label="Coin lists">
        {KINDS.map((k) => (
          <button key={k.id} role="tab" aria-selected={kind === k.id} className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)} title={k.hint}>{k.label}</button>
        ))}
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
              <span className="muted">{kind === "crypto" ? `#${i + 1} · ` : ""}{fmtPrice(c.priceUsd)}</span>
            </span>
            <span className="coin-nums">
              <b>{fmtBig(c.mcap)} <small className="muted">MC</small></b>
              {kind === "held" && c.holders ? (
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
