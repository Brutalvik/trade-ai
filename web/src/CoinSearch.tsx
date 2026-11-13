// The coin search box (header, New Agent window): real coins first, like fomo.
// Crypto by market rank, then Solana tokens with verified ones on top; a pasted token or pool
// address lists its markets instead. Picking a result hands back that coin's chart (its market).
import { useEffect, useState } from "react";
import { api, fmtBig, fmtPrice, type ListCoin, type PairInfo } from "./api";
import { findCoinPair } from "./CoinList";

export function CoinSearch({ onSelect, notify, placeholder, autoFocus, className }: { onSelect: (p: PairInfo) => void; notify: (m: string, bad?: boolean) => void; placeholder?: string; autoFocus?: boolean; className?: string }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<PairInfo[]>([]); // an address: its markets
  const [coins, setCoins] = useState<{ crypto: ListCoin[]; tokens: ListCoin[] }>({ crypto: [], tokens: [] });
  const [searching, setSearching] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Like fomo: real coins first (Crypto by rank, then Solana tokens with verified ones on top);
  // a pasted token or pool address shows its markets instead.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes([]); setCoins({ crypto: [], tokens: [] }); return; }
    setSearching(true);
    const id = setTimeout(async () => {
      try {
        const r = await api.searchCoins(term);
        if (r.address) {
          setCoins({ crypto: [], tokens: [] });
          setRes(await api.search(term));
        } else {
          setRes([]);
          setCoins({ crypto: r.crypto, tokens: r.tokens });
        }
      } catch {
        setRes([]);
        setCoins({ crypto: [], tokens: [] });
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q]);
  const pick = async (c: ListCoin) => {
    setOpening(c.mint);
    try {
      const p = await findCoinPair(c);
      if (p) {
        onSelect(p);
        setQ("");
        setOpen(false);
      } else notify(`No chart found for ${c.symbol} yet`, true);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setOpening(null);
    }
  };
  const coinRow = (c: ListCoin) => (
    <button key={c.mint} className="sr-row" onMouseDown={(e) => e.preventDefault()} onClick={() => void pick(c)} disabled={opening === c.mint}>
      {c.icon ? <img src={c.icon} alt="" /> : <span className="sr-noicon">{c.symbol.slice(0, 1)}</span>}
      <span className="sr-name">
        <b>{c.symbol}{c.verified ? <span className="sr-verified" title="Verified by Jupiter">✓</span> : null}{c.rank ? <span className="sr-rank">#{c.rank}</span> : null}</b>
        <small>{c.name}{c.mint.startsWith("cg:") ? "" : ` · ${c.mint.slice(0, 4)}…${c.mint.slice(-4)}`}</small>
      </span>
      <span className="sr-cell"><small>MC</small>{fmtBig(c.mcap)}</span>
      <span className="sr-cell num">{fmtPrice(c.priceUsd)}</span>
      <span className={`sr-cell num ${c.change24h >= 0 ? "up" : "down"}`}>{c.change24h >= 0 ? "+" : ""}{c.change24h.toFixed(2)}%</span>
      <span className="sr-cell"><small>VOL</small>{fmtBig(c.volume24h ?? 0)}</span>
    </button>
  );
  const anyCoins = coins.crypto.length + coins.tokens.length > 0;
  return (
  <div className={`search ${className ?? ""}`}>
      <input placeholder={placeholder ?? "Search ticker, name or token address..."} autoFocus={autoFocus} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} />
      {open && q.trim().length >= 2 && (anyCoins || (searching && !res.length)) && (
        <div className="dropdown search-results">
          {searching && !anyCoins ? <div className="sr-empty muted small">Searching…</div> : null}
          {coins.crypto.length ? <div className="sr-group">Crypto</div> : null}
          {coins.crypto.map(coinRow)}
          {coins.tokens.length ? <div className="sr-group">Tokens</div> : null}
          {coins.tokens.map(coinRow)}
        </div>
      )}
      {open && q.trim().length >= 2 && !searching && !anyCoins && !res.length && (
        <div className="dropdown search-results"><div className="sr-empty muted small">No coins found for "{q.trim()}"</div></div>
      )}
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
  );
}
