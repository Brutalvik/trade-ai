// MoonPay in the wallet window (Real mode): the customer's MoonPay wallet, buying with a card or
// Apple Pay on the app's own screen, and every real-money transaction in a table.
// Everything shown comes from the server, which records only what MoonPay itself confirms: no
// price, fee or "paid" is ever made up here.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, MOONPAY_WALLET_EVENT, SIGNIN_EVENT, type MoonWalletView, type TxStatus, type WalletTx, type WalletTxEvent } from "./api";

type Tab = "wallet" | "buy" | "history" | "previous";
type Notify = (m: string, bad?: boolean) => void;

export function MoonPayPanel({ notify, previous }: { notify: Notify; previous: ReactNode }) {
  const [tab, setTab] = useState<Tab>("wallet");
  const [view, setView] = useState<MoonWalletView | null>(null);
  const [err, setErr] = useState("");
  const load = () => api.moonWallet().then((v) => { setView(v); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
    const again = () => void load();
    window.addEventListener(MOONPAY_WALLET_EVENT, again);
    return () => window.removeEventListener(MOONPAY_WALLET_EVENT, again);
  }, []);
  const tabs: [Tab, string][] = [["wallet", "Your wallet"], ["buy", "Buy"], ["history", "Transactions"], ["previous", "Previous wallet"]];
  return (
    <div className="mp">
      <div className="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {view?.buying.mode === "sandbox" && tab !== "previous" && <p className="mp-sandbox small">Test mode: no real money moves, and coins arrive on Solana's test network.</p>}
      {err && tab !== "previous" && <p className="down small">{err}</p>}
      {tab === "wallet" && <WalletTab view={view} reload={load} notify={notify} toBuy={() => setTab("buy")} />}
      {tab === "buy" && <BuyTab view={view} toWallet={() => setTab("wallet")} toHistory={() => setTab("history")} />}
      {tab === "history" && <TxTable notify={notify} sandbox={view?.buying.mode !== "live"} />}
      {tab === "previous" && previous}
    </div>
  );
}

// ---------- The wallet ----------
function WalletTab({ view, reload, notify, toBuy }: { view: MoonWalletView | null; reload: () => void; notify: Notify; toBuy: () => void }) {
  if (!view) return <p className="muted small pad">Loading your wallet…</p>;
  const w = view.wallet;
  if (!w)
    return (
      <div className="mp-card">
        <h3>Your wallet</h3>
        <p className="small">A wallet of your own, kept safe with your email sign-in. Crypto you buy here goes into it. This app can see it but can never move money out of it.</p>
        {view.wallets.on ? (
          <>
            <p className="muted small">Sign in with your account's email (a code is emailed to you), or with Google or Apple. Your wallet is made and connected in the same step.</p>
            <button className="btn buy" onClick={() => window.dispatchEvent(new Event(SIGNIN_EVENT))}>Connect wallet</button>
          </>
        ) : (
          <p className="muted small">Wallets are not switched on in this app yet.</p>
        )}
      </div>
    );
  return (
    <div className="wallet-tab">
      <div className="wallet-head">
        <div>
          <div className="label-sm">Your wallet · Solana</div>
          <div className="wallet-total">{view.balance?.sol === null || view.balance?.sol === undefined ? "…" : `${view.balance.sol.toFixed(4)} SOL`}</div>
          <button className="link-btn mono small" onClick={() => void copy(w.address, notify)} title="Copy the full address">{w.address.slice(0, 6)}…{w.address.slice(-6)} ⧉</button>
          {view.balance && <div className="muted tiny">{view.balance.network}</div>}
        </div>
        <div className="wallet-actions">
          <button className="btn buy" onClick={toBuy}>Buy</button>
          <button className="btn ghost" onClick={reload}>↻ Refresh</button>
        </div>
      </div>
      <p className="muted small">Your own wallet, kept safe with your email sign-in. This app can see it but can never move money out of it.</p>
    </div>
  );
}

// ---------- Buying ----------
// The app's own form; the payment itself in MoonPay's window, built and signed by the server (so
// nothing in it can be changed here), shown in a modal. Card payments run in the modal; Apple Pay
// and Google Pay cannot run inside an embedded window, so they open MoonPay's own tab.
type PayWith = "card" | "apple_pay" | "google_pay";
const PAY_WITH: { id: PayWith; label: string }[] = [{ id: "card", label: "Debit or credit card" }, { id: "apple_pay", label: "Apple Pay" }, { id: "google_pay", label: "Google Pay" }];
type Pending = { id: string; url: string; fiatAmount: number; fiatCurrency: string; asset: string };
function BuyTab({ view, toWallet, toHistory }: { view: MoonWalletView | null; toWallet: () => void; toHistory: () => void }) {
  const fiats = view?.options?.fiats ?? [], coins = view?.options?.coins ?? [];
  const [currency, setCurrency] = useState("usd");
  const [coin, setCoin] = useState("");
  const [payWith, setPayWith] = useState<PayWith>("card");
  const [amount, setAmount] = useState("100");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const fiat = fiats.find((f) => f.code === currency) ?? fiats[0];
  const asset = coins.some((c) => c.id === coin) ? coin : coins[0]?.id ?? "";
  const n = Number(amount);
  const amountProblem = !amount || !fiat ? "" : n < fiat.min ? `The smallest purchase is ${money(fiat.min, fiat.code, 0)}.` : n > fiat.max ? `The largest purchase is ${money(fiat.max, fiat.code, 0)} at a time.` : "";
  const into = view?.buyInto ?? null;
  const go = async () => {
    setMsg(null);
    if (!view?.buying.on) return setMsg({ text: "Buying is not switched on in this app yet.", bad: true });
    if (!into) return setMsg({ text: "Connect your wallet first: your crypto goes into it.", bad: true });
    // Apple Pay and Google Pay: MoonPay's own tab, opened now (in the click) so the browser allows it.
    const tab = payWith === "card" ? null : window.open("about:blank", "_blank");
    setBusy(true);
    try {
      const r = await api.buyWidget({ fiatCurrency: fiat!.code, asset, fiatAmount: n, payWith });
      if (tab) {
        tab.opener = null;
        tab.location.href = r.url;
      }
      setPending({ id: r.id, url: r.url, fiatAmount: r.fiatAmount, fiatCurrency: r.fiatCurrency, asset: r.asset });
    } catch (e: any) {
      tab?.close();
      setMsg({ text: e.message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  const clear = () => setMsg(null);
  if (view && !view.options) return <div className="mp-card"><h3>Buy crypto</h3><p className="small down">MoonPay's list of coins could not be read just now. Try again in a moment.</p></div>;
  return (
    <div className="mp-card">
      <h3>Buy crypto</h3>
      <p className="small">
        Pay with a card, Apple Pay or Google Pay. The crypto goes straight into{" "}
        {into ? (into.which === "moonpay" ? <>your wallet (<span className="mono">{short(into.address)}</span>)</> : <>your current wallet (<span className="mono">{short(into.address)}</span>), as test coins</>) : "your wallet"}.
      </p>
      {!into && view && <p className="small"><button className="link-btn" onClick={toWallet}>Connect your wallet</button> first.</p>}
      <div className="mp-form">
        <label>
          <span className="label-sm">You pay</span>
          <span className="mp-amount">
            <input inputMode="numeric" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^0-9]/g, "").slice(0, 6)); clear(); }} aria-label="Amount to pay (whole number)" />
            <select value={fiat?.code ?? ""} onChange={(e) => { setCurrency(e.target.value); clear(); }} aria-label="Currency">{fiats.map((f) => <option key={f.code} value={f.code}>{f.code.toUpperCase()}</option>)}</select>
          </span>
        </label>
        <div className="mp-quick">{[50, 100, 250].map((v) => <button key={v} className="btn ghost small" onClick={() => { setAmount(String(v)); clear(); }}>{fiat ? money(v, fiat.code, 0) : v}</button>)}</div>
        <label>
          <span className="label-sm">You get</span>
          <select value={asset} onChange={(e) => { setCoin(e.target.value); clear(); }} aria-label="Coin to buy">{coins.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        </label>
        <label>
          <span className="label-sm">Pay with</span>
          <select value={payWith} onChange={(e) => { setPayWith(e.target.value as PayWith); clear(); }} aria-label="Pay with">{PAY_WITH.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </label>
        {payWith !== "card" && <p className="muted tiny">{payWith === "apple_pay" ? "Apple Pay works in Safari on iPhone and Mac. " : ""}It opens in MoonPay's own tab; this window shows how it is going.</p>}
        {amountProblem && <p className="down small">{amountProblem}</p>}
        <p className="muted tiny">MoonPay shows the exact amount you get, its fee and the network fee before you pay. Nothing is charged until you confirm there.</p>
        <button className="btn buy wide" disabled={busy || !!amountProblem || !amount || !fiat || !asset} onClick={() => void go()}>{busy ? "Preparing…" : "Continue to MoonPay"}</button>
        {msg && <p className={`small ${msg.bad ? "down" : "up"}`}>{msg.text}</p>}
      </div>
      <p className="muted tiny">Payments by MoonPay. Every purchase is recorded under <button className="link-btn" onClick={toHistory}>Transactions</button>.</p>
      {pending && <PayModal p={pending} inModal={payWith === "card"} sandbox={view?.buying.mode !== "live"} onClose={() => setPending(null)} toHistory={() => { setPending(null); toHistory(); }} />}
    </div>
  );
}

// MoonPay's window in the app's modal, with how the purchase is going underneath (asked of the
// server every 5 seconds; the server asks MoonPay).
const STEP: Partial<Record<TxStatus, string>> = { started: "Waiting for you to pay at MoonPay…", pending: "MoonPay is processing the payment…", completed: "Done: the crypto is on its way to your wallet.", failed: "The payment did not go through.", cancelled: "The payment was cancelled.", expired: "The payment was not completed." };
function PayModal({ p, inModal, sandbox, onClose, toHistory }: { p: Pending; inModal: boolean; sandbox: boolean; onClose: () => void; toHistory: () => void }) {
  const [st, setSt] = useState<{ status: TxStatus; failureReason: string | null } | null>(null);
  useEffect(() => {
    let off = false;
    const ask = () => api.buyCheck(p.id).then((r) => !off && setSt(r)).catch(() => {});
    void ask();
    const id = window.setInterval(() => void ask(), 5_000);
    return () => { off = true; window.clearInterval(id); void api.buyCheck(p.id).catch(() => {}); };
  }, [p.id]);
  const done = st && ["completed", "failed", "cancelled", "refunded", "expired"].includes(st.status);
  return createPortal(
    <div className="modal-backdrop on-top">
      <div className="modal mp-pay" role="dialog" aria-modal="true" aria-labelledby="mp-pay-title">
        <div className="modal-head">
          <h2 id="mp-pay-title">Pay {money(p.fiatAmount, p.fiatCurrency, 0)} with MoonPay{sandbox ? " · test mode" : ""}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>
        <div className="modal-body">
          {inModal && !done && (
            <iframe className="mp-frame" src={p.url} title="MoonPay" allow="accelerometer; autoplay; camera; gyroscope; payment; clipboard-write" referrerPolicy="strict-origin-when-cross-origin" />
          )}
          {!inModal && !done && <p className="small">MoonPay opened in a new tab. Finish the payment there; this window follows along.</p>}
          <p className={`small mp-step ${st?.status === "completed" ? "up" : st && ["failed", "cancelled", "expired"].includes(st.status) ? "down" : ""}`}>
            {st ? STEP[st.status] ?? st.status : "Connecting to MoonPay…"}{st?.failureReason ? ` ${st.failureReason}` : ""}
          </p>
          <div className="mp-pay-actions">
            {!done && <a className="link-btn small" href={p.url} target="_blank" rel="noopener noreferrer">Open in MoonPay's own tab instead ↗</a>}
            <button className="btn ghost small" onClick={toHistory}>See it in Transactions</button>
          </div>
          {sandbox && !done && <p className="muted tiny">Test mode: use MoonPay's test card (see MoonPay's sandbox guide). No real money moves.</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Every transaction ----------
const STATUS: Record<TxStatus, string> = { started: "Started", pending: "In progress", completed: "Completed", failed: "Failed", cancelled: "Cancelled", refunded: "Refunded", expired: "Not completed" };
const KIND: Record<WalletTx["kind"], string> = { buy: "Buy", sell: "Sell", swap: "Swap", send: "Send", receive: "Receive" };
function TxTable({ notify, sandbox }: { notify: Notify; sandbox: boolean }) {
  const [rows, setRows] = useState<WalletTx[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const load = (before?: number) =>
    api.walletTxs(before).then((r) => {
      setRows((old) => (before && old ? [...old, ...r.transactions] : r.transactions));
      setMore(r.transactions.length === 50);
      setErr("");
    }).catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 15_000); // a purchase in progress updates by itself
    return () => window.clearInterval(id);
  }, []);
  if (err) return <p className="down small">{err}</p>;
  if (!rows) return <p className="muted small pad">Loading…</p>;
  if (!rows.length) return <p className="muted small pad">No transactions yet. Everything you buy, sell, send or receive with real money will be listed here.</p>;
  return (
    <div className="table-wrap">
      <table className="scan wallet-table mp-tx">
        <thead><tr><th>Date</th><th>Type</th><th className="num">Paid</th><th className="num">Received</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <TxRow key={t.id} t={t} open={open === t.id} toggle={() => setOpen(open === t.id ? null : t.id)} notify={notify} sandbox={sandbox} />
          ))}
        </tbody>
      </table>
      {more && <button className="btn ghost small" onClick={() => void load(rows[rows.length - 1].createdAt)}>Load older</button>}
    </div>
  );
}
function TxRow({ t, open, toggle, notify, sandbox }: { t: WalletTx; open: boolean; toggle: () => void; notify: Notify; sandbox: boolean }) {
  return (
    <>
      <tr className="mp-row" onClick={toggle} title="Show details">
        <td>{new Date(t.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        <td>{KIND[t.kind]}{t.flag && <span className="mp-flag" title={t.flag}> ⚠</span>}</td>
        <td className="num">{t.fiatAmount === null ? "–" : money(t.fiatAmount, t.fiatCurrency ?? "usd")}</td>
        <td className="num">{t.cryptoAmount === null ? "–" : `${fmtCoin(t.cryptoAmount)} ${coinName(t.cryptoCurrency)}`}</td>
        <td><span className={`mp-status s-${t.status}`}>{STATUS[t.status]}</span></td>
      </tr>
      {open && <tr className="mp-detail-row"><td colSpan={5}><TxDetail id={t.id} notify={notify} sandbox={sandbox} /></td></tr>}
    </>
  );
}
function TxDetail({ id, notify, sandbox }: { id: string; notify: Notify; sandbox: boolean }) {
  const [d, setD] = useState<{ tx: WalletTx; events: WalletTxEvent[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.walletTx(id).then(setD).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p className="down small">{err}</p>;
  if (!d) return <p className="muted small">Loading…</p>;
  const t = d.tx, cur = t.fiatCurrency ?? "usd";
  const fees: [string, number | null][] = [["MoonPay Fee", t.feeAmount], ["Network Fee", t.networkFeeAmount], ["Ecosystem Fee", t.extraFeeAmount]];
  const explorer = t.txHash && t.network === "solana" ? `https://solscan.io/tx/${encodeURIComponent(t.txHash)}${sandbox ? "?cluster=devnet" : ""}` : null;
  return (
    <div className="mp-detail small">
      {t.flag && <p className="warn">⚠ {t.flag}. Contact support before relying on this transaction.</p>}
      {t.failureReason && <p className="down">{t.failureReason}</p>}
      <dl>
        {fees.filter(([, v]) => v !== null).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{money(v!, cur)}</dd></div>)}
        {t.walletAddress && <div><dt>Into wallet</dt><dd className="mono">{t.walletAddress.slice(0, 6)}…{t.walletAddress.slice(-6)}</dd></div>}
        {t.providerId && <div><dt>MoonPay reference</dt><dd><button className="link-btn mono" onClick={() => void copy(t.providerId!, notify, "MoonPay reference copied")}>{t.providerId.slice(0, 12)}… ⧉</button></dd></div>}
        {explorer && <div><dt>On the blockchain</dt><dd><a href={explorer} target="_blank" rel="noopener noreferrer">View ↗</a></dd></div>}
        <div><dt>Our reference</dt><dd className="mono">{t.id}</dd></div>
      </dl>
      <div className="label-sm">History</div>
      <ul className="mp-events">
        {d.events.map((e, i) => (
          <li key={i} className={e.applied ? "" : "muted"}>
            <span className="mono">{new Date(e.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>{" "}
            {e.source === "app" ? "Started in the app" : e.source === "webhook" ? "MoonPay reported" : "Checked with MoonPay"}
            {e.status ? `: ${e.status}` : ""}{e.applied ? "" : e.note ? ` (no change: ${e.note})` : " (no change)"}
            {e.applied && e.note ? ` (${e.note})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Small helpers ----------
function money(v: number, currency: string, digits = 2) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  } catch {
    return `${v.toFixed(digits)} ${currency.toUpperCase()}`;
  }
}
const fmtCoin = (v: number) => (v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const coinName = (c: string | null) => (c ?? "").replace(/_sol$|_base$|_eth$/i, "").toUpperCase();
async function copy(text: string, notify: Notify, done = "Wallet address copied") {
  try {
    await navigator.clipboard.writeText(text);
    notify(done);
  } catch {
    notify(text);
  }
}
