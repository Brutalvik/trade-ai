// Your real Solana wallet (Privy embedded wallet), read-only for now:
// SOL and token balances with USD values, and a Deposit screen (address + QR code).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { api, fmtPrice, fmtUsd, type WalletView } from "./api";
import { useAccess } from "./Account";

const fmtAmount = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));

export function WalletTab({ notify }: { notify: (m: string, bad?: boolean) => void }) {
  const { me } = useAccess();
  const [view, setView] = useState<WalletView | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const load = (fresh = false) => {
    setLoading(true);
    setErr("");
    api.wallet(fresh).then(setView).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => {
    if (me) load();
  }, [me?.username]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) return <p className="muted small pad">Sign in to see your wallet.</p>;
  const address = view?.address ?? me.solanaAddress ?? null;
  if (!address) return <p className="muted small pad">Your Solana wallet is being created. Sign out and back in, or reopen this tab in a moment.</p>;
  return (
    <div className="wallet-tab">
      <div className="wallet-head">
        <div>
          <div className="label-sm">Real wallet · Solana</div>
          <div className="wallet-total">{view ? fmtUsd(view.totalUsd) : "…"}</div>
          <button className="link-btn mono small" onClick={() => void copy(address, notify)} title="Copy the full address">{address.slice(0, 6)}…{address.slice(-6)} ⧉</button>
        </div>
        <div className="wallet-actions">
          <button className="btn buy" onClick={() => setDepositOpen(true)}>Deposit</button>
          <button className="btn ghost" onClick={() => load(true)} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
        </div>
      </div>
      <p className="muted small">This is real money in your own wallet (you can export its keys from Privy). It's read-only here for now; trading with it comes with the Live mode switch. The app still trades your paper account.</p>
      {err && <p className="down small">{err}</p>}
      {view && (
        <div className="table-wrap">
          <table className="scan">
            <thead><tr><th>Token</th><th className="num">Amount</th><th className="num">Price</th><th className="num">Value</th></tr></thead>
            <tbody>
              {view.holdings.map((h) => (
                <tr key={h.mint + h.symbol}>
                  <td>
                    <div className="token-cell">
                      {h.imageUrl ? <img src={h.imageUrl} alt="" /> : <span className="dot" />}
                      <span><b>{h.symbol}</b><div className="muted tiny">{h.name}</div></span>
                    </div>
                  </td>
                  <td className="num">{fmtAmount(h.amount)}</td>
                  <td className="num">{h.priceUsd === null ? "–" : fmtPrice(h.priceUsd)}</td>
                  <td className="num">{h.valueUsd === null ? "–" : fmtUsd(h.valueUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.holdings.length === 1 && view.holdings[0].amount === 0 && <p className="muted small pad">Empty so far. Use Deposit to add SOL or USDC.</p>}
          <p className="muted tiny">Updated {new Date(view.updatedAt).toLocaleTimeString()}{view.rpc === "public" ? " · using the public Solana network connection (can be slow)" : ""}</p>
        </div>
      )}
      {depositOpen && <DepositModal address={address} onClose={() => setDepositOpen(false)} notify={notify} />}
    </div>
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

function DepositModal({ address, onClose, notify }: { address: string; onClose: () => void; notify: (m: string, bad?: boolean) => void }) {
  const [qr, setQr] = useState("");
  useEffect(() => {
    QRCode.toDataURL(`solana:${address}`, { margin: 1, width: 220, color: { dark: "#04101c", light: "#ffffff" } }).then(setQr).catch(() => setQr(""));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [address, onClose]);
  return createPortal(
    <div className="modal-backdrop">
      <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="deposit-title">
        <div className="modal-head">
          <h2 id="deposit-title">Deposit to your wallet</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>
        <div className="modal-body deposit-body">
          <p>Send <b>SOL</b> or <b>USDC</b> (or other Solana tokens) to this address, from an exchange or another wallet.</p>
          {qr && <img className="deposit-qr" src={qr} alt="QR code of your wallet address" />}
          <div className="deposit-address mono">{address}</div>
          <button className="btn buy wide" onClick={() => void copy(address, notify)}>Copy address</button>
          <ul className="small deposit-notes">
            <li><b>Solana network only.</b> Sending from another network (Ethereum, Base, BNB…) can lose the funds.</li>
            <li>Keep a little SOL (about 0.01–0.05) for network fees once live trading is on.</li>
            <li>Start small while live trading is new.</li>
          </ul>
        </div>
      </div>
    </div>,
    document.body,
  );
}
