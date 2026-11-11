// Real mode: buy and sell from your own Solana wallet through Jupiter.
// Flow: Review (server gets a price + unsigned swap) -> you check it -> Confirm (Privy signs in
// your browser) -> the server checks it's the same swap and sends it. Nothing moves until you sign.
import { useContext, useEffect, useState } from "react";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { api, fmtPrice, fmtUsd, type PairInfo, type RealQuote, type RealTrade, type WalletView } from "./api";
import { PrivyEnabled, useAccess } from "./Account";

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

export function RealTradePanel({ pair, notify }: { pair: PairInfo | null; notify: (m: string, bad?: boolean) => void }) {
  const privy = useContext(PrivyEnabled);
  if (!privy) return <RealShell><p className="muted small">Real trading needs Privy sign-in, which isn't set up on this server.</p></RealShell>;
  if (!pair) return <RealShell><p className="muted small">Pick a coin to trade.</p></RealShell>;
  if (pair.chain !== "solana") return <RealShell><p className="muted small">Real trading is Solana-only. Pick a Solana coin from the lists on the left.</p></RealShell>;
  return <RealTradeForm pair={pair} notify={notify} />;
}

function RealShell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="panel real-trade">
      <div className="panel-title"><span>TRADE</span>{right}</div>
      {children}
    </div>
  );
}

function RealTradeForm({ pair, notify }: { pair: PairInfo; notify: (m: string, bad?: boolean) => void }) {
  const { me } = useAccess();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [pay, setPay] = useState<"SOL" | "USDC">("SOL");
  const [usd, setUsd] = useState("10");
  const [pct, setPct] = useState(100);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [quote, setQuote] = useState<RealQuote | null>(null);
  const [busy, setBusy] = useState<"" | "quote" | "sign" | "send">("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState<RealTrade | null>(null);
  const [now, setNow] = useState(Date.now());
  const [maxUsd, setMaxUsd] = useState(100); // the server's per-trade cap (REAL_MAX_TRADE_USD)

  const loadWallet = (fresh = false) => api.wallet(fresh).then(setWallet).catch(() => {});
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
      const q = await api.realQuote(tab === "buy" ? { side: "BUY", pay, mint: pair.tokenAddress, symbol: pair.symbol, usd: Number(usd) } : { side: "SELL", pay, mint: pair.tokenAddress, symbol: pair.symbol, pct });
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
    const w = wallets.find((x) => x.address === me?.solanaAddress) ?? wallets[0];
    if (!w) return setErr("Your wallet isn't connected yet. Sign out and back in, then try again.");
    setErr("");
    setBusy("sign");
    try {
      const { signedTransaction } = await signTransaction({ transaction: b64ToBytes(quote.transaction), wallet: w, chain: "solana:mainnet" });
      setBusy("send");
      const t = await api.realExecute({ requestId: quote.requestId, signedTransaction: bytesToB64(signedTransaction) });
      setQuote(null);
      setDone(t);
      if (t.status === "Success") notify(`${t.side === "BUY" ? "Bought" : "Sold"} ${fmtAmt(t.side === "BUY" ? t.outAmount : t.inAmount)} ${t.symbol}`);
      else notify(`Trade failed: ${t.error ?? "unknown error"}`, true);
      setTimeout(() => void loadWallet(true), 2500);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setErr(/reject|cancel|denied|closed/i.test(msg) ? "You cancelled the signature. Nothing was traded." : msg);
      if (/expired|match/i.test(msg)) setQuote(null);
    } finally {
      setBusy("");
    }
  };

  return (
    <RealShell right={<button className="link-btn small" onClick={() => void loadWallet(true)} title="Refresh balances">{wallet ? `${fmtUsd(wallet.totalUsd)} in wallet` : "…"}</button>}>
      <div className="trade-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "buy"} className={`buy ${tab === "buy" ? "on" : ""}`} onClick={() => setTab("buy")}>Buy</button>
        <button role="tab" aria-selected={tab === "sell"} className={`sell ${tab === "sell" ? "on" : ""}`} onClick={() => setTab("sell")}>Sell</button>
      </div>

      {!quote ? (
        <>
          <div className="kind-toggle" role="radiogroup" aria-label={tab === "buy" ? "Pay with" : "Receive"}>
            {(["SOL", "USDC"] as const).map((p) => (
              <button key={p} role="radio" aria-checked={pay === p} className={pay === p ? "on" : ""} onClick={() => setPay(p)}>
                {tab === "buy" ? "Pay with" : "Get"} {p}
              </button>
            ))}
          </div>
          {tab === "buy" ? (
            <>
              <div className="amount">
                <span>$</span>
                <input type="number" min="1" step="1" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} aria-label="Amount in US dollars" />
              </div>
              <div className="real-quick">
                {[5, 10, 25, 50, 100].map((v) => <button key={v} className="chip" onClick={() => setUsd(String(v))}>${v}</button>)}
              </div>
              <p className="muted tiny">{pay} balance: {payBal ? `${fmtAmt(payBal.amount)} ${pay} (${fmtUsd(payBal.valueUsd ?? 0)})` : `0 ${pay}`}{pay === "SOL" ? " · 0.01 SOL is kept for network fees" : ""}</p>
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
          {err && <p className="down small" role="alert">{err}</p>}
          <button className={`btn ${tab === "buy" ? "buy" : "sell"} wide`} disabled={!!busy || (tab === "sell" && !tokenH)} onClick={() => void review()}>
            {busy === "quote" ? "Getting a price…" : `Review ${tab === "buy" ? "buy" : "sell"}`}
          </button>
          <p className="muted tiny">Real money from your own wallet. Max ${maxUsd} per trade while real trading is new.</p>
        </>
      ) : (
        <div className="real-review">
          <div className="real-line"><span className="muted">You pay</span><b>{fmtAmt(quote.inAmount)} {quote.inSymbol}</b></div>
          <div className="real-line"><span className="muted">You get about</span><b className="up">{fmtAmt(quote.outAmount)} {quote.outSymbol}</b></div>
          {quote.usd != null && <div className="real-line"><span className="muted">Worth about</span><span>{fmtUsd(quote.usd)}</span></div>}
          <div className="real-line"><span className="muted">Price impact</span><span className={Math.abs(quote.priceImpactPct) > 3 ? "down" : ""}>{Math.abs(quote.priceImpactPct).toFixed(2)}%</span></div>
          {quote.slippageBps != null && <div className="real-line"><span className="muted">Max slippage</span><span className={quote.slippageBps > 500 ? "amber" : ""} title="Jupiter sets this from how volatile the coin is">{(quote.slippageBps / 100).toFixed(1)}%</span></div>}
          <div className="real-line"><span className="muted">Fees</span><span>Swap {(quote.swapFeeBps / 100).toFixed(2)}% · {quote.platformFee.note} · network ~{quote.networkFeeSol.toFixed(6)} SOL</span></div>
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
