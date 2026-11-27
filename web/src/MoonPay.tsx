// MoonPay in the wallet window (Real mode): the customer's MoonPay wallet, buying with a card or
// Apple Pay on the app's own screen, and every real-money transaction in a table.
// Everything shown comes from the server, which records only what MoonPay itself confirms: no
// price, fee or "paid" is ever made up here.
import { useContext, useEffect, useState } from "react";
import { MoonPaySigner } from "./Account";
import { WalletActionsContext, type CashOutChain } from "./walletActions";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { ChainLogo, type LogoId } from "./ChainLogo";
import { api, fmtUsd, MOONPAY_WALLET_EVENT, SIGNIN_EVENT, WALLET_KINDS, type BalanceRow, type ChainWallet, type MoonWalletView, type TxStatus, type WalletChain, type WalletTx, type WalletTxEvent } from "./api";

type Tab = "wallet" | "buy" | "history";
type Notify = (m: string, bad?: boolean) => void;

export function MoonPayPanel({ notify }: { notify: Notify }) {
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
  const tabs: [Tab, string][] = [["wallet", "Your wallets"], ["buy", "Buy"], ["history", "Transactions"]];
  return (
    <div className="mp">
      <div className="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {view?.buying.mode === "sandbox" && <p className="mp-sandbox small">Test mode: no real money moves, and bought coins arrive on test networks.</p>}
      {err && <p className="down small">{err}</p>}
      {tab === "wallet" && <WalletTab view={view} reload={load} notify={notify} toBuy={() => setTab("buy")} />}
      {tab === "buy" && <BuyTab view={view} toWallet={() => setTab("wallet")} toHistory={() => setTab("history")} />}
      {tab === "history" && <TxTable notify={notify} sandbox={view?.buying.mode !== "live"} />}
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
// The networks the Ethereum wallet's one address works on, with their marks.
const NET_LOGO: Record<string, LogoId> = { Ethereum: "eth", "BNB Chain": "bnb", Base: "base", Polygon: "pol", Arbitrum: "arb", Optimism: "op", Avalanche: "avax" };
const amountNum = (n: number) =>
  n === 0 ? "0.00" : n < 0.000001 ? n.toExponential(2) : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 4 });
const amountText = (n: number | null, symbol: string) => (n === null ? "—" : `${amountNum(n)} ${symbol}`);
const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const CopyIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
);
const QrIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></svg>
);
const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.6 3.4 8.3 8 9 4.6-.7 8-4.4 8-9V6Z" /><path d="m9 12 2 2 4-4" /></svg>
);
function WalletTab({ view, reload, notify, toBuy }: { view: MoonWalletView | null; reload: () => void; notify: Notify; toBuy: () => void }) {
  const [bal, setBal] = useState<{ balances: Partial<Record<WalletChain, BalanceRow[]>>; totalUsd: number | null; complete: boolean } | null>(null);
  const [deposit, setDeposit] = useState<ChainWallet | null>(null);
  const all = view?.all ?? (view?.wallet ? [view.wallet as ChainWallet] : []);
  const loadBal = (fresh = false) =>
    api.moonBalances(fresh).then((r) => setBal({ balances: r.balances, totalUsd: r.totalUsd ?? null, complete: r.complete !== false })).catch(() => setBal({ balances: {}, totalUsd: null, complete: false }));
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
  const sandbox = view.buying.mode === "sandbox";
  const of = (k: WalletChain) => all.find((w) => w.chain === k);
  const left = of("ethereum");
  const right = (["solana", "bitcoin", "tron"] as WalletChain[]).map(of).filter((w): w is ChainWallet => !!w);
  const missing = WALLET_KINDS.filter((k) => !of(k));
  const card = (w: ChainWallet) => <WalletCard key={w.chain} w={w} rows={bal?.balances[w.chain]} sandbox={sandbox} notify={notify} onDeposit={() => setDeposit(w)} onSent={() => setTimeout(() => void loadBal(true), 3000)} />;
  const empty = bal !== null && bal.totalUsd === 0 && bal.complete;
  return (
    <div className="wallet-tab">
      <div className="wl-summary">
        <div className="wl-total">
          <small>Total Balance</small>
          <b>{bal === null ? "…" : bal.totalUsd === null ? "—" : fmtUsd(bal.totalUsd)}</b>
          {bal !== null && !bal.complete && <span className="muted tiny" title="A network did not answer, or a coin has no price just now. Refresh to try again.">some figures missing</span>}
        </div>
        <div className="wl-protect">
          <ShieldIcon />
          <div>Protected by your email sign-in.<br />Only you can move your funds: you sign every transfer.</div>
        </div>
        <div className="wallet-actions">
          <button className="btn buy" onClick={toBuy}>Buy</button>
          <button className="btn ghost" onClick={() => { reload(); setBal(null); void loadBal(true); }}>↻ Refresh</button>
        </div>
      </div>
      <div className={`wl-grid${left && right.length ? "" : " one"}`}>
        {left && <div className="wl-col">{card(left)}</div>}
        {right.length > 0 && <div className="wl-col">{right.map(card)}</div>}
      </div>
      {empty && <p className="wl-hint small">Your wallets are empty. <button className="link-btn" onClick={toBuy}>Buy crypto</button>, or press Deposit to send some from an exchange or another wallet.</p>}
      {missing.length > 0 && <p className="muted tiny">Your {missing.map((k) => CHAIN_INFO[k].name).join(" and ")} {missing.length > 1 ? "wallets are" : "wallet is"} made the next time you sign in.</p>}
      {deposit && <DepositModal wallet={deposit} sandbox={sandbox} onClose={() => setDeposit(null)} notify={notify} />}
    </div>
  );
}
// One wallet: its mark, name, short address (copy; QR opens Deposit), Deposit, and what it holds on
// each network it works on.
function WalletCard({ w, rows, sandbox, notify, onDeposit, onSent }: { w: ChainWallet; rows: BalanceRow[] | undefined; sandbox: boolean; notify: Notify; onDeposit: () => void; onSent: () => void }) {
  const actions = useContext(WalletActionsContext);
  const [sending, setSending] = useState(false);
  // (Bitcoin: MoonPay's kit can't send or cash out from here yet.)
  const canMove = w.chain !== "bitcoin";
  const withdraw = async () => {
    if (!actions) return notify("Wallets are not loaded in this browser. Reload the page.", true);
    if (!actions.signedIn) { actions.signIn(); return notify("Sign in with your email in the window that opened, then press Withdraw again.", true); }
    try {
      await actions.cashOut(w.chain as CashOutChain, w.address);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      notify(/not (enabled|configured|available)|offramp|off-ramp|cash.?out/i.test(msg) ? "Withdrawing to a bank isn't switched on for this app yet." : msg, true);
    }
  };
  const info = CHAIN_INFO[w.chain];
  const label = (r: BalanceRow) =>
    w.chain === "solana" ? (r.test || sandbox ? "Solana Devnet · Testnet" : "Solana Mainnet")
      : w.chain === "bitcoin" ? "Bitcoin Mainnet"
      : w.chain === "tron" ? (r.symbol === "USDT" ? "USDT (TRC-20)" : "TRX (Tron)")
      : r.test ? "Sepolia · Testnet" : r.network;
  const logo = (r: BalanceRow): LogoId | null => (w.chain === "ethereum" ? (r.test ? "test" : NET_LOGO[r.network] ?? null) : w.chain === "tron" && r.symbol === "USDT" ? "usdt" : null);
  const real = (rows ?? []).filter((r) => !r.test), test = (rows ?? []).filter((r) => r.test);
  const line = (r: BalanceRow) => {
    const mark = logo(r);
    return (
      <div key={`${r.network}-${r.symbol}`} className="wc-row" title={typeof r.usd === "number" && r.amount ? fmtUsd(r.usd) : r.amount === null ? "The network did not answer just now. Try Refresh." : undefined}>
        <span className="wc-net">{mark && <ChainLogo id={mark} size={20} />}{label(r)}</span>
        <span className="wc-amt">{amountText(r.amount, r.symbol)}</span>
      </div>
    );
  };
  return (
    <div className={`wc ${w.chain}`}>
      <div className="wc-head">
        <ChainLogo id={w.chain} size={40} />
        <div className="wc-id">
          <div className="wc-name">{info.name}</div>
          <span className="wc-addr">
            <button className="mono" onClick={() => void copy(w.address, notify)} title={`Copy the full address: ${w.address}`}>{shortAddress(w.address)}</button>
            <button onClick={() => void copy(w.address, notify)} title="Copy address" aria-label="Copy address"><CopyIcon /></button>
            <button onClick={onDeposit} title="Show the QR code" aria-label="Show the QR code"><QrIcon /></button>
          </span>
        </div>
        <div className="wc-buttons">
          <button className="btn ghost small wc-deposit" onClick={onDeposit}>Deposit</button>
          {canMove && <button className="btn ghost small wc-deposit" onClick={() => setSending(true)}>Send</button>}
          {canMove && <button className="btn ghost small wc-deposit" onClick={() => void withdraw()} title="Sell to your bank account or card">Withdraw</button>}
        </div>
      </div>
      <div className="wc-rows">
        {rows === undefined ? <span className="muted tiny">Reading balances…</span> : <>
          {real.map(line)}
          {test.length > 0 && real.length > 0 && <div className="wc-sep" />}
          {test.map(line)}
        </>}
      </div>
      {sending && <SendModal w={w} rows={rows} sandbox={sandbox} onClose={() => setSending(false)} onSent={onSent} />}
    </div>
  );
}
// ---------- Sending to another wallet, and withdrawing ----------
// The networks the Ethereum wallet can send its own coin on (the same as server/src/send.ts).
const EVM_NETS = [
  { chainId: 1, name: "Ethereum", symbol: "ETH", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io/tx/" },
  { chainId: 56, name: "BNB Chain", symbol: "BNB", rpc: "https://bsc-rpc.publicnode.com", explorer: "https://bscscan.com/tx/" },
  { chainId: 8453, name: "Base", symbol: "ETH", rpc: "https://base-rpc.publicnode.com", explorer: "https://basescan.org/tx/" },
  { chainId: 137, name: "Polygon", symbol: "POL", rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygonscan.com/tx/" },
  { chainId: 42161, name: "Arbitrum", symbol: "ETH", rpc: "https://arbitrum-one-rpc.publicnode.com", explorer: "https://arbiscan.io/tx/" },
  { chainId: 10, name: "Optimism", symbol: "ETH", rpc: "https://optimism-rpc.publicnode.com", explorer: "https://optimistic.etherscan.io/tx/" },
  { chainId: 43114, name: "Avalanche", symbol: "AVAX", rpc: "https://avalanche-c-chain-rpc.publicnode.com", explorer: "https://snowtrace.io/tx/" },
];
const SEPOLIA = { chainId: 11155111, name: "Sepolia (test)", symbol: "ETH", rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io/tx/" };
const isAddress: Record<WalletChain, RegExp> = { solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, ethereum: /^0x[0-9a-fA-F]{40}$/, bitcoin: /^(bc1|tb1|[13mn2])/, tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ };
// A decimal amount in a coin's smallest units, exactly (as the server reads it).
function weiOf(amount: string, decimals: number): bigint {
  const [w, f = ""] = amount.trim().split(".");
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
const b64ToBytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const bytesToB64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

type Asset = { id: string; symbol: string; balance: number | null; decimals: number; chainId?: number };
function SendModal({ w, rows, sandbox, onClose, onSent }: { w: ChainWallet; rows: BalanceRow[] | undefined; sandbox: boolean; onClose: () => void; onSent: () => void }) {
  const actions = useContext(WalletActionsContext);
  const solSigner = useContext(MoonPaySigner);
  const info = CHAIN_INFO[w.chain];
  const [assets, setAssets] = useState<Asset[]>([]);
  const [asset, setAsset] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<"form" | "review" | "sending" | "done">("form");
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const [solQuote, setSolQuote] = useState<Awaited<ReturnType<typeof api.sendSolanaQuote>> | null>(null);
  useEffect(() => {
    const bal = (net: string, sym: string) => rows?.find((r) => r.network === net && r.symbol === sym)?.amount ?? null;
    if (w.chain === "solana") {
      api.realWallet().then((v) => {
        const list: Asset[] = v.holdings.filter((h) => h.amount > 0).map((h) => ({ id: h.symbol === "SOL" && h.mint.startsWith("So1111") ? "SOL" : h.mint, symbol: h.symbol, balance: h.amount, decimals: h.symbol === "SOL" ? 9 : 6 }));
        if (!list.some((a) => a.id === "SOL")) list.unshift({ id: "SOL", symbol: "SOL", balance: 0, decimals: 9 });
        setAssets(list);
        setAsset("SOL");
      }).catch(() => { setAssets([{ id: "SOL", symbol: "SOL", balance: null, decimals: 9 }]); setAsset("SOL"); });
    } else if (w.chain === "ethereum") {
      const nets = sandbox ? [...EVM_NETS, SEPOLIA] : EVM_NETS;
      setAssets(nets.map((n) => ({ id: String(n.chainId), symbol: n.symbol, balance: bal(n.chainId === SEPOLIA.chainId ? "Ethereum test network (Sepolia)" : n.name, n.symbol), decimals: 18, chainId: n.chainId })));
      setAsset("1");
    } else if (w.chain === "tron") {
      setAssets([{ id: "TRX", symbol: "TRX", balance: bal("Tron", "TRX"), decimals: 6 }, { id: "USDT", symbol: "USDT", balance: bal("Tron", "USDT"), decimals: 6 }]);
      setAsset("TRX");
    }
  }, [w.chain]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = assets.find((x) => x.id === asset);
  const net = w.chain === "ethereum" ? [...EVM_NETS, SEPOLIA].find((n) => String(n.chainId) === asset) : null;
  const where = net ? net.name : info.networks;
  const amountOk = /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount) > 0;
  const tooMuch = a?.balance != null && amountOk && Number(amount) > a.balance;
  const toOk = isAddress[w.chain].test(to.trim()) && to.trim() !== w.address;
  const problem = !to ? "Enter the address to send to" : !toOk ? (to.trim() === w.address ? "That is this wallet's own address" : `That is not ${/^[AEIOU]/.test(where) ? "an" : "a"} ${where} address`) : !amountOk ? "Enter an amount" : tooMuch ? `You have ${a!.balance} ${a!.symbol}` : "";
  const maxOf = () => {
    if (a?.balance == null) return;
    const keep = a.id === "SOL" ? 0.00001 : a.id === "TRX" ? 1.1 : w.chain === "ethereum" ? -1 : 0; // network fees
    if (keep < 0) return;
    setAmount(String(Math.max(0, Math.floor((a.balance - keep) * 10 ** Math.min(a.decimals, 9)) / 10 ** Math.min(a.decimals, 9))));
  };

  const review = async () => {
    setErr("");
    if (problem) return setErr(problem);
    if (w.chain === "solana") {
      try {
        setSolQuote(await api.sendSolanaQuote({ mint: asset, symbol: a?.symbol, to: to.trim(), amount: amount.trim() }));
      } catch (e: any) {
        return setErr(e.message);
      }
    }
    setStep("review");
  };
  const sendNow = async () => {
    setErr("");
    setStep("sending");
    try {
      if (w.chain === "solana") {
        if (!solQuote) throw new Error("Review it again.");
        if (!solSigner || !solSigner.addresses.includes(solQuote.wallet)) throw new Error("Sign in again (your email) to sign with your Solana wallet.");
        const signed = await solSigner.sign(solQuote.wallet, b64ToBytes(solQuote.transaction));
        const r = await api.sendSolanaExecute({ requestId: solQuote.requestId, signedTransaction: bytesToB64(signed) });
        setResult({ ok: r.status !== "failed", text: r.status === "failed" ? `Not sent: ${r.error}` : r.status === "pending" ? "Sent. The network is still confirming it." : `Sent ${solQuote.amount} ${solQuote.symbol}.`, link: r.signature ? `https://solscan.io/tx/${r.signature}` : undefined });
      } else if (w.chain === "ethereum") {
        if (!actions) throw new Error("Wallets are not loaded in this browser. Reload the page.");
        if (!actions.signedIn) { actions.signIn(); throw new Error("Sign in with your email in the window that opened, then send again."); }
        const hash = await actions.sendEvm(w.address, { to: to.trim(), valueWei: weiOf(amount, 18).toString(), chainId: net!.chainId, rpcUrl: net!.rpc });
        await api.sendRecord({ chain: "ethereum", chainId: net!.chainId, hash }).catch(() => null);
        setResult({ ok: true, text: `Sent ${amount} ${net!.symbol} on ${net!.name}.`, link: net!.explorer + hash });
      } else if (w.chain === "tron") {
        if (!actions) throw new Error("Wallets are not loaded in this browser. Reload the page.");
        if (!actions.signedIn) { actions.signIn(); throw new Error("Sign in with your email in the window that opened, then send again."); }
        const b = await api.sendTronBuild({ asset: asset as "TRX" | "USDT", to: to.trim(), amount: amount.trim() });
        const txid = await actions.sendTron(w.address, b.transaction);
        await api.sendRecord({ chain: "tron", hash: txid, to: b.to, amount: b.amount, asset: b.asset }).catch(() => null);
        setResult({ ok: true, text: `Sent ${b.amount} ${b.asset} on Tron.`, link: `https://tronscan.org/#/transaction/${txid}` });
      }
      setStep("done");
      onSent();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setErr(/reject|cancel|denied|closed/i.test(msg) ? "You cancelled the signature. Nothing was sent." : msg);
      setStep("review");
    }
  };

  return createPortal(
    <div className="modal-backdrop on-top">
      <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="send-title">
        <div className="modal-head">
          <h2 id="send-title">Send from your {info.name} wallet</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>
        <div className="modal-body send-body">
          {step === "form" && (
            <>
              <label className="send-field">{w.chain === "ethereum" ? "Network" : "Coin"}
                <select value={asset} onChange={(e) => { setAsset(e.target.value); setErr(""); }}>
                  {assets.map((x) => <option key={x.id} value={x.id}>{w.chain === "ethereum" ? `${EVM_NETS.concat(SEPOLIA).find((n) => String(n.chainId) === x.id)?.name} · ${x.symbol}` : x.symbol}{x.balance != null ? ` (${x.balance} available)` : ""}</option>)}
                </select>
              </label>
              <label className="send-field">To address
                <input value={to} onChange={(e) => { setTo(e.target.value); setErr(""); }} placeholder={w.chain === "ethereum" ? "0x…" : w.chain === "tron" ? "T…" : "Solana address"} spellCheck={false} autoComplete="off" />
              </label>
              <label className="send-field">Amount
                <span className="send-amount">
                  <input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setErr(""); }} placeholder="0.00" />
                  <b>{a?.symbol}</b>
                  {w.chain !== "ethereum" && a?.balance != null && <button className="link-btn tiny" onClick={maxOf}>Max</button>}
                </span>
              </label>
              <ul className="small deposit-notes">
                <li><b>Only to {/^[AEIOU]/.test(where) ? "an" : "a"} {where} address.</b> Sending to an address on another network can lose the money, and a transfer can't be undone.</li>
                <li>A network fee is paid from this wallet{w.chain === "ethereum" ? ` in ${net?.symbol ?? "ETH"}` : w.chain === "tron" ? " in TRX" : " in SOL"}.</li>
              </ul>
              {err && <p className="down small" role="alert">{err}</p>}
              <button className="btn buy wide" onClick={() => void review()} disabled={!!problem}>{problem || "Review"}</button>
            </>
          )}
          {(step === "review" || step === "sending") && (
            <>
              <div className="real-review">
                <div className="real-line"><span className="muted">Send</span><b>{w.chain === "solana" && solQuote ? `${solQuote.amount} ${solQuote.symbol}` : `${amount} ${a?.symbol}`}</b></div>
                <div className="real-line"><span className="muted">On</span><span>{where}</span></div>
                <div className="real-line"><span className="muted">To</span><span className="mono send-to">{to.trim()}</span></div>
                {w.chain === "solana" && solQuote && <div className="real-line"><span className="muted">Network fee</span><span>~{solQuote.networkFeeSol.toFixed(6)} SOL{solQuote.createsAccount ? " (opens the receiver's account for this coin)" : ""}</span></div>}
              </div>
              <p className="muted tiny">Check the address: a transfer can't be undone. You sign it in the signing window.</p>
              {err && <p className="down small" role="alert">{err}</p>}
              <div className="row-btns">
                <button className="btn ghost" onClick={() => { setStep("form"); setErr(""); }} disabled={step === "sending"}>Back</button>
                <button className="btn sell" onClick={() => void sendNow()} disabled={step === "sending"}>{step === "sending" ? "Approve in the popup…" : "Send"}</button>
              </div>
            </>
          )}
          {step === "done" && result && (
            <>
              <p className={result.ok ? "up" : "down"}>{result.text}</p>
              {result.link && <a href={result.link} target="_blank" rel="noopener noreferrer">View on the network ↗</a>}
              <button className="btn ghost wide" onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
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
// The address MoonPay sees from this browser: its payment window accepts the link only from that
// address. The app's own server can see another one (the app is reached over IPv4, MoonPay over
// IPv6 when the connection has it), so the page asks MoonPay and the server signs that address.
async function moonpaySeenIp(publishableKey: string | null | undefined): Promise<string | null> {
  if (!publishableKey) return null;
  try {
    const r = await fetch(`https://api.moonpay.com/v4/ip_address?apiKey=${encodeURIComponent(publishableKey)}`, { signal: AbortSignal.timeout(5_000) });
    const j = await r.json();
    return typeof j?.ipAddress === "string" ? j.ipAddress : null;
  } catch {
    return null; // (the server then signs the address it sees)
  }
}
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
      const seenIp = await moonpaySeenIp(view?.buying.publishableKey);
      const r = await api.buyWidget({ fiatCurrency: fiat!.code, asset, fiatAmount: n, payWith, ...(seenIp ? { seenIp } : {}) });
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
        <p className="muted tiny">You see the exact amount you get before you pay, fees included. Nothing is charged until you confirm.</p>
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
  // One figure for all the fees of a purchase (they are already taken from what was received).
  const parts = [t.feeAmount, t.networkFeeAmount, t.extraFeeAmount].filter((v): v is number => typeof v === "number");
  const fees: [string, number | null][] = [["Fees", parts.length ? parts.reduce((a, b) => a + b, 0) : null]];
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
