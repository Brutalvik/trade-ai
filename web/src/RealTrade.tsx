// Real mode: buy and sell from your own Solana wallet through Jupiter.
// Flow: Review (server gets a price + unsigned swap for the wallet you trade from) -> you check it ->
// Confirm (your MoonPay wallet signs in your browser) -> the server checks it's the same swap and
// sends it. Nothing moves until you sign.
import { useContext, useEffect, useState } from "react";
import { api, curSymbol, fmtPrice, fmtUsd, toUsd, type PairInfo, type RealQuote, type RealTrade, type WalletView } from "./api";
import { MoonPaySigner, useAccess, type TxSigner } from "./Account";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const fmtAmt = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));
const b64ToBytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const bytesToB64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;

// Slippage: how far the price may move against you before the trade is refused. "Auto" lets
// Jupiter set it from how volatile the coin is. Kept in this browser.
const SLIP_KEY = "real-slippage-bps";
const SLIPS = [50, 100, 300];
const readSlip = (): number | "auto" => {
  const v = Number(localStorage.getItem(SLIP_KEY));
  return v >= 1 && v <= 1000 ? v : "auto";
};

export function RealTradePanel({ pair, notify }: { pair: PairInfo | null; notify: (m: string, bad?: boolean) => void }) {
  const moonpay = useContext(MoonPaySigner);
  if (!moonpay) return <RealShell><p className="muted small">Real trading needs MoonPay sign-in, which isn't switched on yet.</p></RealShell>;
  if (!pair) return <RealShell><p className="muted small">Pick a coin to trade.</p></RealShell>;
  if (pair.chain !== "solana") return <RealShell><p className="muted small">Real trading is Solana-only. Pick a Solana coin from the lists on the left.</p></RealShell>;
  return <RealTradeForm pair={pair} notify={notify} signers={[moonpay]} />;
}

function RealShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="panel real-trade">
      {children}
    </div>
  );
}

function RealTradeForm({ pair, notify, signers }: { pair: PairInfo; notify: (m: string, bad?: boolean) => void; signers: TxSigner[] }) {
  const { me } = useAccess();
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [pay, setPay] = useState<"SOL" | "USDC">("SOL");
  const [usd, setUsd] = useState("10");
  const [pct, setPct] = useState(100);
  const [wallet, setWallet] = useState<(WalletView & { via?: "moonpay" | null }) | null>(null);
  const [quote, setQuote] = useState<RealQuote | null>(null);
  const [busy, setBusy] = useState<"" | "quote" | "sign" | "send">("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState<RealTrade | null>(null);
  const [now, setNow] = useState(Date.now());
  const [maxUsd, setMaxUsd] = useState(100); // the server's per-trade cap (REAL_MAX_TRADE_USD)
  const [slip, setSlipState] = useState<number | "auto">(readSlip);
  const [custom, setCustom] = useState(() => (typeof readSlip() === "number" && !SLIPS.includes(readSlip() as number) ? String((readSlip() as number) / 100) : ""));
  const [fee, setFee] = useState<{ bps: number; note: string } | null>(null);
  const setSlip = (v: number | "auto") => {
    setSlipState(v);
    if (v === "auto") localStorage.removeItem(SLIP_KEY);
    else localStorage.setItem(SLIP_KEY, String(v));
  };
  const loadFee = () => api.realFees().then(setFee).catch(() => setFee(null));
  useEffect(() => { void loadFee(); }, [me?.username]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadWallet = (fresh = false) => api.realWallet(fresh).then(setWallet).catch(() => {});
  useEffect(() => { void loadWallet(); }, [me?.username]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setQuote(null); setErr(""); setDone(null); }, [pair.tokenAddress, tab]);
  useEffect(() => {
    if (!quote) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [quote]);

  const solH = wallet?.holdings.find((h) => h.mint === SOL_MINT && h.symbol === "SOL");
  const usdcH = wallet?.holdings.find((h) => h.mint === USDC_MINT);
  const tokenH = wallet?.holdings.find((h) => h.mint === pair.tokenAddress);
  const payBal = pay === "SOL" ? solH : usdcH;
  const secondsLeft = quote ? Math.max(0, Math.round((quote.expiresAt - now) / 1000)) : 0;

  const review = async () => {
    setErr("");
    setDone(null);
    setBusy("quote");
    try {
      const slippage = slip === "auto" ? {} : { slippageBps: slip };
      const q = await api.realQuote(tab === "buy" ? { side: "BUY", pay, mint: pair.tokenAddress, symbol: pair.symbol, usd: toUsd(Number(usd)), ...slippage } : { side: "SELL", pay, mint: pair.tokenAddress, symbol: pair.symbol, pct, ...slippage });
      setQuote(q);
      setMaxUsd(q.maxTradeUsd);
      setNow(Date.now());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  };

  const confirm = async () => {
    if (!quote) return;
    // Only the wallet the server quoted for may sign it.
    const s = signers.find((x) => x.addresses.includes(quote.wallet));
    if (!s) return setErr("Sign in with MoonPay again to sign with your MoonPay wallet.");
    setErr("");
    setBusy("sign");
    try {
      const signedTransaction = await s.sign(quote.wallet, b64ToBytes(quote.transaction));
      setBusy("send");
      const t = await api.realExecute({ requestId: quote.requestId, signedTransaction: bytesToB64(signedTransaction) });
      setQuote(null);
      setDone(t);
      if (t.status === "Success") notify(`${t.side === "BUY" ? "Bought" : "Sold"} ${fmtAmt(t.side === "BUY" ? t.outAmount : t.inAmount)} ${t.symbol}`);
      else notify(`Trade failed: ${t.error ?? "unknown error"}`, true);
      setTimeout(() => void loadWallet(true), 2500);
      void loadFee(); // (a free trade of the month may have been used)
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setErr(/reject|cancel|denied|closed/i.test(msg) ? "You cancelled the signature. Nothing was traded." : msg);
      if (/expired|match/i.test(msg)) setQuote(null);
    } finally {
      setBusy("");
    }
  };

  return (
    <RealShell>
      <div className="trade-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "buy"} className={`buy ${tab === "buy" ? "on" : ""}`} onClick={() => setTab("buy")}>Buy</button>
        <button role="tab" aria-selected={tab === "sell"} className={`sell ${tab === "sell" ? "on" : ""}`} onClick={() => setTab("sell")}>Sell</button>
      </div>

      {!quote ? (
        <>
          <div className="order-row">
            <div className="kind-toggle" role="radiogroup" aria-label={tab === "buy" ? "Pay with" : "Receive"}>
              {(["SOL", "USDC"] as const).map((p) => (
                <button key={p} role="radio" aria-checked={pay === p} className={pay === p ? "on" : ""} onClick={() => setPay(p)} title={tab === "buy" ? `Pay with ${p}` : `Get ${p} back`}>
                  {p}
                </button>
              ))}
            </div>
            <button className="available link-btn" onClick={() => void loadWallet(true)} title="Refresh balances">
              <span className="muted">Available</span>{" "}
              <b>{tab === "buy" ? (payBal ? `${fmtAmt(payBal.amount)} ${pay}` : `0 ${pay}`) : tokenH ? `${fmtAmt(tokenH.amount)} ${pair.symbol}` : `0 ${pair.symbol}`}</b>
            </button>
          </div>
          {tab === "buy" ? (
            <>
              <div className="amount">
                <span>{curSymbol()}</span>
                <input type="number" min="1" step="1" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} aria-label="Amount to buy" />
              </div>
              <div className="real-quick">
                {[5, 10, 25, 50, 100].map((v) => <button key={v} className="chip" onClick={() => setUsd(String(v))}>{curSymbol()}{v}</button>)}
              </div>
              {pay === "SOL" && <p className="muted tiny">0.01 SOL is kept for network fees.</p>}
            </>
          ) : (
            <>
              <div className="pos-mini">
                <span>{tokenH ? `You hold ${fmtAmt(tokenH.amount)} ${pair.symbol}` : `You don't hold ${pair.symbol}`}</span>
                {tokenH?.valueUsd != null && <span className="muted small">{fmtUsd(tokenH.valueUsd)}</span>}
              </div>
              <div className="real-quick">
                {[25, 50, 100].map((v) => <button key={v} className={`chip ${pct === v ? "on" : ""}`} onClick={() => setPct(v)}>{v}%</button>)}
              </div>
            </>
          )}
          <div className="slip-row" role="radiogroup" aria-label="Max slippage">
            <span className="muted tiny">Slippage</span>
            <button role="radio" aria-checked={slip === "auto"} className={`chip ${slip === "auto" ? "on" : ""}`} onClick={() => { setSlip("auto"); setCustom(""); }} title="Jupiter sets it from how volatile the coin is">Auto</button>
            {SLIPS.map((b) => <button key={b} role="radio" aria-checked={slip === b} className={`chip ${slip === b ? "on" : ""}`} onClick={() => { setSlip(b); setCustom(""); }}>{b / 100}%</button>)}
            <span className={`slip-custom ${custom ? "on" : ""}`}>
              <input inputMode="decimal" placeholder="Custom" value={custom} aria-label="Custom slippage in percent" onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, "").slice(0, 4);
                setCustom(v);
                const bps = Math.round(Number(v) * 100);
                if (bps >= 1 && bps <= 1000) setSlip(bps);
                else if (!v) setSlip("auto");
              }} />%
            </span>
          </div>
          {Number(custom) > 10 && <p className="down tiny">Slippage can be at most 10%.</p>}
          <p className="muted tiny fee-line">Fee: {fee ? fee.note : "…"} · plus the Solana network fee.</p>
          {err && <p className="down small" role="alert">{err}</p>}
          <button className={`btn ${tab === "buy" ? "buy" : "sell"} wide`} disabled={!!busy || (tab === "sell" && !tokenH)} onClick={() => void review()}>
            {busy === "quote" ? "Getting a price…" : `Review ${tab === "buy" ? "buy" : "sell"}`}
          </button>
          <p className="muted tiny">Real money from your own wallet. Max {fmtUsd(maxUsd, 0)} per trade while real trading is new.</p>
        </>
      ) : (
        <div className="real-review">
          <div className="real-line"><span className="muted">You pay</span><b>{fmtAmt(quote.inAmount)} {quote.inSymbol}</b></div>
          <div className="real-line"><span className="muted">You get about</span><b className="up">{fmtAmt(quote.outAmount)} {quote.outSymbol}</b></div>
          {quote.usd != null && <div className="real-line"><span className="muted">Worth about</span><span>{fmtUsd(quote.usd)}</span></div>}
          <div className="real-line"><span className="muted">Price impact</span><span className={Math.abs(quote.priceImpactPct) > 3 ? "down" : ""}>{Math.abs(quote.priceImpactPct).toFixed(2)}%</span></div>
          {quote.slippageBps != null && <div className="real-line"><span className="muted">Max slippage</span><span className={quote.slippageBps > 500 ? "amber" : ""} title={slip === "auto" ? "Jupiter set this from how volatile the coin is" : "Your slippage setting"}>{(quote.slippageBps / 100).toFixed(1)}%{slip === "auto" ? " (auto)" : ""}</span></div>}
          <div className="real-line"><span className="muted">Fees</span><span title={`Route ${(quote.swapFeeBps / 100).toFixed(2)}% · ${quote.platformFee.note} · network ~${quote.networkFeeSol.toFixed(6)} SOL`}>{((quote.swapFeeBps + quote.platformFee.bps) / 100).toFixed(2)}% + network ~{quote.networkFeeSol.toFixed(6)} SOL</span></div>
          <p className="muted tiny">{quote.platformFee.note}. Fees are included in what you get.</p>
          {Math.abs(quote.priceImpactPct) > 3 && <p className="down small">High price impact: this coin has little liquidity, so you get noticeably less than the chart price.</p>}
          {err && <p className="down small" role="alert">{err}</p>}
          {secondsLeft === 0 ? (
            <button className="btn ghost wide" onClick={() => void review()} disabled={!!busy}>Price expired · get a new one</button>
          ) : (
            <div className="row-btns">
              <button className="btn ghost" onClick={() => { setQuote(null); setErr(""); }} disabled={!!busy}>Cancel</button>
              <button className={`btn ${quote.side === "BUY" ? "buy" : "sell"}`} onClick={() => void confirm()} disabled={!!busy}>
                {busy === "sign" ? "Approve in the popup…" : busy === "send" ? "Sending…" : `Confirm ${quote.side === "BUY" ? "buy" : "sell"} (${secondsLeft}s)`}
              </button>
            </div>
          )}
          <p className="muted tiny">Price {fmtPrice(pair.priceUsd)} on the chart. The final amount can differ slightly, within the max slippage.</p>
        </div>
      )}

      {done && (
        <div className={`real-done ${done.status === "Success" ? "ok" : "bad"}`}>
          <b>{done.status === "Success" ? "Done" : "Failed"}</b>{" "}
          {done.status === "Success"
            ? `${done.side === "BUY" ? "Bought" : "Sold"} ${fmtAmt(done.side === "BUY" ? done.outAmount : done.inAmount)} ${done.symbol} for ${fmtAmt(done.side === "BUY" ? done.inAmount : done.outAmount)} ${done.pay}.`
            : done.error}
          {done.signature && <> <a href={solscanTx(done.signature)} target="_blank" rel="noreferrer">View on Solscan ↗</a></>}
        </div>
      )}
    </RealShell>
  );
}
