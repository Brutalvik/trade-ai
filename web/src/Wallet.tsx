// The wallet window, opened from the wallet button in the header. Real mode: the customer's
// MoonPay wallet, buying with MoonPay, and every real-money transaction (MoonPay.tsx). An account
// that had a wallet before MoonPay (made by Privy, no longer used) sees it under "Previous wallet",
// view only: nothing in the app can sign for it any more.
import { useEffect, useState } from "react";
import { api, fmtPct, fmtPrice, fmtUsd, type AppState, type WalletView } from "./api";
import { Modal, useAccess } from "./Account";
import { MoonPayPanel } from "./MoonPay";

const fmtAmount = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));

// Header button where the PAPER MODE chip used to be: wallet icon plus the current mode.
export function WalletButton({ notify, state }: { notify: (m: string, bad?: boolean) => void; state: AppState | null }) {
  const { me } = useAccess();
  const [open, setOpen] = useState(false);
  const real = me?.tradeMode === "real";
  return (
    <>
      <button className={real ? "sound-toggle" : "wallet-btn"} onClick={() => (me ? setOpen(true) : notify("Sign in to see your wallet", true))} title="Wallet" aria-label={real ? "Wallet" : "Wallet (Paper mode)"}>
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3m0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
          <path d="M21 12h-4a2 2 0 0 0 0 4h4z" />
        </svg>
        {!real && <span>PAPER</span>}
      </button>
      {open && <WalletModal notify={notify} state={state} onClose={() => setOpen(false)} />}
    </>
  );
}

// Paper mode shows the paper account only; Real mode shows the Solana wallet.
function WalletModal({ notify, state, onClose }: { notify: (m: string, bad?: boolean) => void; state: AppState | null; onClose: () => void }) {
  const { me } = useAccess();
  const real = me?.tradeMode === "real";
  return (
    <Modal title="Wallet" onClose={onClose} wide>
      {real ? <MoonPayPanel notify={notify} previous={me?.solanaAddress ? <SolanaWallet notify={notify} /> : null} /> : <PaperAccount state={state} />}
    </Modal>
  );
}

function PaperAccount({ state }: { state: AppState | null }) {
  if (!state || state.signedOut) return <p className="muted small">Sign in to see your paper account.</p>;
  const inPositions = state.positions.reduce((s, p) => s + p.qty * p.lastPrice, 0);
  const pnl = state.equityNow - state.startCash;
  const pnlPct = state.startCash > 0 ? (pnl / state.startCash) * 100 : 0;
  return (
    <div className="wallet-tab">
      <div className="wallet-head">
        <div>
          <div className="label-sm">Paper account · <b className="amber">practice money</b></div>
          <div className="wallet-total">{fmtUsd(state.equityNow)}</div>
          <div className={`small ${pnl >= 0 ? "up" : "down"}`}>{pnl >= 0 ? "+" : ""}{fmtUsd(pnl)} ({fmtPct(pnlPct)}) since you started with {fmtUsd(state.startCash)}</div>
        </div>
      </div>
      <div className="paper-stats">
        <div><small>Available cash</small><b>{fmtUsd(state.available ?? state.cash)}</b></div>
        <div><small>Locked for agents</small><b>{fmtUsd(state.locked ?? 0)}</b></div>
        <div><small>In open trades</small><b>{fmtUsd(inPositions)}</b></div>
        <div><small>Open trades</small><b>{state.positions.length}</b></div>
        <div><small>Waiting orders</small><b>{state.orders?.length ?? 0}</b></div>
      </div>
      {state.positions.length ? (
        <div className="table-wrap">
          <table className="scan wallet-table">
            <thead><tr><th>Token</th><th className="num col-price">Bought at</th><th className="num col-amount">Now</th><th className="num">Value</th><th className="num">P&L</th></tr></thead>
            <tbody>
              {state.positions.map((p) => {
                const value = p.qty * p.lastPrice;
                const pl = value - p.costUsd;
                return (
                  <tr key={p.id}>
                    <td><b>{p.symbol}</b><div className="muted tiny">{p.source === "bot" ? "🤖 bot" : "manual"}</div></td>
                    <td className="num col-price">{fmtPrice(p.entryPrice)}</td>
                    <td className="num col-amount">{fmtPrice(p.lastPrice)}</td>
                    <td className="num">{fmtUsd(value)}</td>
                    <td className={`num ${pl >= 0 ? "up" : "down"}`}>{pl >= 0 ? "+" : ""}{fmtUsd(pl)}<div className="tiny">{fmtPct(p.costUsd > 0 ? (pl / p.costUsd) * 100 : 0)}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small pad">No open trades right now.</p>
      )}
      <p className="muted tiny">Practice money only: nothing real is bought or sold.</p>
    </div>
  );
}

function SolanaWallet({ notify }: { notify: (m: string, bad?: boolean) => void }) {
  const { me } = useAccess();
  const [view, setView] = useState<WalletView | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const load = (fresh = false) => {
    setLoading(true);
    setErr("");
    api.wallet(fresh).then(setView).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => {
    if (me) load();
  }, [me?.username]); // eslint-disable-line react-hooks/exhaustive-deps

  const address = view?.address ?? me?.solanaAddress ?? null;
  return (
    <>
      {!address ? (
        <p className="muted small">This account has no wallet from before MoonPay.</p>
      ) : (
        <div className="wallet-tab">
          <div className="wallet-head">
            <div>
              <div className="label-sm">Previous wallet · Solana · view only</div>
              <div className="wallet-total">{view ? fmtUsd(view.totalUsd) : "…"}</div>
              <button className="link-btn mono small" onClick={() => void copy(address, notify)} title="Copy the full address">{address.slice(0, 6)}…{address.slice(-6)} ⧉</button>
            </div>
            <div className="wallet-actions">
              <button className="btn ghost" onClick={() => load(true)} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
            </div>
          </div>
          <p className="small down">
            Your wallet from before MoonPay (made by Privy, which this app no longer uses). The app can't
            send from it any more, so don't send money to it. Your wallet is in the first tab.
          </p>
          {err && <p className="down small">{err}</p>}
          {view && (
            <div className="table-wrap">
              <table className="scan wallet-table">
                <thead><tr><th>Token</th><th className="num col-amount">Amount</th><th className="num col-price">Price</th><th className="num">Value</th></tr></thead>
                <tbody>
                  {view.holdings.map((h) => (
                    <tr key={h.mint + h.symbol}>
                      <td>
                        <div className="token-cell">
                          {h.imageUrl ? <img src={h.imageUrl} alt="" /> : <span className="dot" />}
                          <span><b>{h.symbol}</b><div className="muted tiny">{h.name}</div><div className="muted tiny mono amount-under">{fmtAmount(h.amount)} {h.symbol}</div></span>
                        </div>
                      </td>
                      <td className="num col-amount">{fmtAmount(h.amount)}</td>
                      <td className="num col-price">{h.priceUsd === null ? "–" : fmtPrice(h.priceUsd)}</td>
                      <td className="num">{h.valueUsd === null ? "–" : fmtUsd(h.valueUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted tiny">Updated {new Date(view.updatedAt).toLocaleTimeString()}{view.rpc === "public" ? " · using the public Solana network connection (can be slow)" : ""}</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

async function copy(text: string, notify: (m: string, bad?: boolean) => void) {
  try {
    await navigator.clipboard.writeText(text);
    notify("Wallet address copied");
  } catch {
    notify(text);
  }
}
