// MoonPay in the wallet window (Real mode): the customer's MoonPay wallet, buying with a card or
// Apple Pay on the app's own screen, and every real-money transaction in a table.
// Everything shown comes from the server, which records only what MoonPay itself confirms: no
// price, fee or "paid" is ever made up here.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { api, MOONPAY_WALLET_EVENT, SIGNIN_EVENT, WALLET_KINDS, type BalanceRow, type ChainWallet, type MoonWalletView, type TxStatus, type WalletChain, type WalletTx, type WalletTxEvent } from "./api";

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
  const tabs: [Tab, string][] = [["wallet", "Your wallets"], ["buy", "Buy"], ["history", "Transactions"], ...(previous ? ([["previous", "Previous wallet"]] as [Tab, string][]) : [])];
  return (
    <div className="mp">
      <div className="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {view?.buying.mode === "sandbox" && tab !== "previous" && <p className="mp-sandbox small">Test mode: no real money moves, and bought coins arrive on test networks.</p>}
      {err && tab !== "previous" && <p className="down small">{err}</p>}
      {tab === "wallet" && <WalletTab view={view} reload={load} notify={notify} toBuy={() => setTab("buy")} />}
      {tab === "buy" && <BuyTab view={view} toWallet={() => setTab("wallet")} toHistory={() => setTab("history")} />}
      {tab === "history" && <TxTable notify={notify} sandbox={view?.buying.mode !== "live"} />}
      {tab === "previous" && previous}
    </div>
  );
}

// ---------- The wallets ----------
// Four wallets, made for the person by MoonPay (with no click: at sign-up, or the first time the app
// and MoonPay know it is them). The Ethereum one is a single address on all the EVM networks.
export const CHAIN_INFO: Record<WalletChain, { name: string; networks: string; holds: string; coin: string; glyph: string; qr: (a: string) => string }> = {
  solana: { name: "Solana", networks: "Solana", holds: "SOL and Solana tokens, such as USDC and the coins this app trades.", coin: "SOL", glyph: "◎", qr: (a) => `solana:${a}` },
  ethereum: { name: "Ethereum & EVM", networks: "Ethereum · BNB Chain · Base · Polygon · Arbitrum · Optimism · Avalanche", holds: "One address on all these networks: ETH, BNB, POL, AVAX and their tokens (USDT, USDC…).", coin: "ETH", glyph: "Ξ", qr: (a) => `ethereum:${a}` },
  bitcoin: { name: "Bitcoin", networks: "Bitcoin", holds: "BTC.", coin: "BTC", glyph: "₿", qr: (a) => `bitcoin:${a}` },
  tron: { name: "Tron", networks: "Tron", holds: "TRX and USDT on Tron (TRC-20).", coin: "TRX", glyph: "T", qr: (a) => a },
};
// The networks the Ethereum wallet's one address works on, each with its own colour dot.
const EVM_CHIPS: [string, string][] = [["Ethereum", "eth"], ["BNB Chain", "bnb"], ["Base", "base"], ["Polygon", "pol"], ["Arbitrum", "arb"], ["Optimism", "op"], ["Avalanche", "avax"]];
const amountNum = (n: number) => (n === 0 ? "0" : n < 0.0001 ? n.toExponential(2) : n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 }));
const amountText = (n: number | null, symbol: string) => (n === null ? "—" : `${amountNum(n)} ${symbol}`);
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`;
function WalletTab({ view, reload, notify, toBuy }: { view: MoonWalletView | null; reload: () => void; notify: Notify; toBuy: () => void }) {
  const [bal, setBal] = useState<Partial<Record<WalletChain, BalanceRow[]>> | null>(null);
  const [deposit, setDeposit] = useState<ChainWallet | null>(null);
  const all = view?.all ?? (view?.wallet ? [view.wallet as ChainWallet] : []);
  const loadBal = (fresh = false) => api.moonBalances(fresh).then((r) => setBal(r.balances)).catch(() => setBal({}));
  useEffect(() => {
    if (all.length) void loadBal();
  }, [all.map((w) => w.address).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!view) return <p className="muted small pad">Loading your wallets…</p>;
  if (!all.length)
    return (
      <div className="mp-card">
        <h3>Your wallets</h3>
        <p className="small">Wallets of your own on Solana, Ethereum (with BNB Chain, Base, Polygon, Arbitrum, Optimism and Avalanche), Bitcoin and Tron, kept safe with your email sign-in. This app can see them but can never move money out of them.</p>
        {view.wallets.on ? (
          <>
            <p className="muted small">They are made the moment you sign in with your account's email. Sign in once to finish making them.</p>
            <button className="btn buy" onClick={() => window.dispatchEvent(new Event(SIGNIN_EVENT))}>Sign in to finish</button>
          </>
        ) : (
          <p className="muted small">Wallets are not switched on in this app yet.</p>
        )}
      </div>
    );
  const mine = WALLET_KINDS.map((k) => all.find((w) => w.chain === k)).filter((w): w is ChainWallet => !!w);
  const missing = WALLET_KINDS.filter((k) => !all.some((w) => w.chain === k));
  const read = bal !== null && mine.every((w) => bal[w.chain] !== undefined);
  const empty = read && mine.every((w) => (bal![w.chain] ?? []).every((r) => !r.amount));
  return (
    <div className="wallet-tab">
      <div className="wallets-top">
        <p className="muted small">Your own wallets, kept safe with your email sign-in. This app can see them but can never move money out of them.</p>
        <div className="wallet-actions">
          <button className="btn buy" onClick={toBuy}>Buy</button>
          <button className="btn ghost" onClick={() => { reload(); setBal(null); void loadBal(true); }}>↻ Refresh</button>
        </div>
      </div>
      <div className="wl-list">
        {mine.map((w) => <WalletRow key={w.chain} w={w} rows={bal === null ? undefined : bal[w.chain]} notify={notify} onDeposit={() => setDeposit(w)} />)}
      </div>
      {empty && <p className="wl-hint small">Your wallets are empty. <button className="link-btn" onClick={toBuy}>Buy crypto</button>, or press Deposit to send some from an exchange or another wallet.</p>}
      {missing.length > 0 && <p className="muted tiny">Your {missing.map((k) => CHAIN_INFO[k].name).join(" and ")} {missing.length > 1 ? "wallets are" : "wallet is"} made the next time you sign in.</p>}
      {deposit && <DepositModal wallet={deposit} sandbox={view.buying.mode === "sandbox"} onClose={() => setDeposit(null)} notify={notify} />}
    </div>
  );
}
// One wallet: its coin's mark, name, short address (click to copy), what it holds (only what is not
// zero; the Ethereum one can list every network), and Deposit.
function WalletRow({ w, rows, notify, onDeposit }: { w: ChainWallet; rows: BalanceRow[] | undefined; notify: Notify; onDeposit: () => void }) {
  const info = CHAIN_INFO[w.chain];
  const [open, setOpen] = useState(false);
  const held = (rows ?? []).filter((r) => (r.amount ?? 0) > 0);
  const unread = rows !== undefined && rows.length > 0 && rows.every((r) => r.amount === null);
  const onTest = rows !== undefined && rows.length === 1 && rows[0].test;
  return (
    <div className="wl-row">
      <div className={`wl-icon ${w.chain}`} aria-hidden="true">{info.glyph}</div>
      <div className="wl-main">
        <div className="wl-name">{info.name}</div>
        <button className="wl-addr mono" onClick={() => void copy(w.address, notify)} title={`Copy the full address: ${w.address}`}>{shortAddress(w.address)} <span aria-hidden="true">⧉</span></button>
        {w.chain === "ethereum" && <div className="wl-chips">{EVM_CHIPS.map(([n, c]) => <span key={n} className={`wl-chip ${c}`}>{n}</span>)}</div>}
      </div>
      <div className="wl-bal">
        {rows === undefined ? (
          <span className="muted tiny">Reading…</span>
        ) : held.length ? (
          held.map((r) => (
            <div key={`${r.network}-${r.symbol}`}>
              <b className="mono">{amountNum(r.amount!)}</b> {r.symbol}
              {w.chain === "ethereum" && <span className="muted tiny"> on {r.test ? "Sepolia" : r.network}</span>}
              {r.test && <span className="wl-test">test</span>}
            </div>
          ))
        ) : (
          <div title={unread ? "The network did not answer just now. Try Refresh." : undefined}>
            <b className="mono">{unread ? "—" : "0"}</b> {info.coin}
            {onTest && <span className="wl-test">test network</span>}
          </div>
        )}
        {w.chain === "ethereum" && rows !== undefined && <button className="link-btn tiny" onClick={() => setOpen(!open)}>{open ? "Hide networks" : `All ${rows.length} networks`}</button>}
      </div>
      <div className="wl-actions">
        <button className="btn ghost small" onClick={onDeposit}>Deposit</button>
      </div>
      {open && rows && (
        <div className="wl-nets">
          {rows.map((r) => (
            <div key={`${r.network}-${r.symbol}`} className="chain-row">
              <span className="muted">{r.network}{r.test && <span className="wl-test">test</span>}</span>
              <span className="mono">{amountText(r.amount, r.symbol)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
// Receiving crypto from an exchange or another wallet: the wallet's address, with a QR code, and the
// networks it works on (sending on another network can lose the money).
function DepositModal({ wallet, sandbox, onClose, notify }: { wallet: ChainWallet; sandbox: boolean; onClose: () => void; notify: Notify }) {
  const info = CHAIN_INFO[wallet.chain];
  const [qr, setQr] = useState("");
  useEffect(() => {
    QRCode.toDataURL(info.qr(wallet.address), { margin: 1, width: 220, color: { dark: "#04101c", light: "#ffffff" } }).then(setQr).catch(() => setQr(""));
  }, [wallet.address]); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div className="modal-backdrop on-top">
      <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="deposit-title">
        <div className="modal-head">
          <h2 id="deposit-title">Deposit to your {info.name} wallet</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>
        <div className="modal-body deposit-body">
          <p>{info.holds}</p>
          {qr && <img className="deposit-qr" src={qr} alt={`QR code of your ${info.name} wallet address`} />}
          <div className="deposit-address mono">{wallet.address}</div>
          <button className="btn buy wide" onClick={() => void copy(wallet.address, notify)}>Copy address</button>
          <ul className="small deposit-notes">
            <li><b>Only on: {info.networks}.</b> Sending on any other network can lose the money.</li>
            {wallet.chain === "ethereum" && <li>Choose the same network when you send as the coin you send (BNB on BNB Chain, POL on Polygon…).</li>}
            {sandbox && <li>This app is in test mode, but this address is a real one: anything sent here is real.</li>}
          </ul>
        </div>
      </div>
    </div>,
    document.body,
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
  // The coin goes into the customer's wallet of its kind (BNB, POL, AVAX… into the Ethereum & EVM
  // one). The server decides again when the purchase starts; this only says where.
  const kind: WalletChain = coins.find((c) => c.id === asset)?.wallet ?? "solana";
  const mine = (view?.all ?? []).find((w) => w.chain === kind);
  const into = mine ? { address: mine.address, which: "moonpay" as const } : kind === "solana" ? view?.buyInto ?? null : null;
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
        {into ? (into.which === "moonpay" ? <>your {CHAIN_INFO[kind].name} wallet (<span className="mono">{short(into.address)}</span>)</> : <>your current wallet (<span className="mono">{short(into.address)}</span>), as test coins</>) : `your ${CHAIN_INFO[kind].name} wallet`}.
      </p>
      {!into && view && <p className="small">Your {CHAIN_INFO[kind].name} wallet is not made yet: <button className="link-btn" onClick={toWallet}>see your wallets</button>.</p>}
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
  const explorer = t.txHash ? explorerTx(t.network, t.txHash, sandbox) : null;
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

// Where a delivered purchase can be looked up, on its own network's explorer (test networks in test mode).
const EXPLORER: Record<string, (h: string, test: boolean) => string> = {
  solana: (h, t) => `https://solscan.io/tx/${h}${t ? "?cluster=devnet" : ""}`,
  ethereum: (h, t) => `https://${t ? "sepolia." : ""}etherscan.io/tx/${h}`,
  binance_smart_chain: (h) => `https://bscscan.com/tx/${h}`,
  base: (h) => `https://basescan.org/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
  optimism: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  avalanche_c_chain: (h) => `https://snowtrace.io/tx/${h}`,
  bitcoin: (h, t) => `https://mempool.space/${t ? "testnet/" : ""}tx/${h}`,
  tron: (h) => `https://tronscan.org/#/transaction/${h}`,
};
function explorerTx(network: string | null | undefined, hash: string, sandbox: boolean): string | null {
  const f = network ? EXPLORER[network] : undefined;
  return f ? f(encodeURIComponent(hash), sandbox) : null;
}
