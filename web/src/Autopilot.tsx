// Real mode's Auto-pilot card: the AI agent trading the customer's own Solana wallet with no click
// per trade, inside the limits they set (server/src/autopilot.ts). Self-contained: it loads its own
// status and asks MoonPay's kit (through AutopilotGrantContext) for the signing permission.
import { useContext, useEffect, useState } from "react";
import { api, fmtUsd, type AutopilotLimits, type AutopilotStatus } from "./api";
import { Modal, useAccess } from "./Account";
import { AutopilotGrantContext } from "./autopilotGrant";

type Notify = (m: string, bad?: boolean) => void;
const day = (ms: number) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${fmtUsd(Math.abs(n))}`;

export function AutopilotPanel({ notify, onPaper }: { notify: Notify; onPaper: () => void }) {
  const access = useAccess();
  const grant = useContext(AutopilotGrantContext);
  const [st, setSt] = useState<AutopilotStatus | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [consent, setConsent] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = () => api.autopilot().then((s) => { setSt(s); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, []);
  const run = async (what: string, fn: () => Promise<AutopilotStatus | void>, done?: string) => {
    setBusy(what);
    try {
      const s = await fn();
      if (s) setSt(s);
      if (done) notify(done);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  };
  const revoke = () => run("revoke", async () => {
    const r = await api.autopilotRevoke();
    if (r.apiPubHex && grant?.signedIn) await grant.revoke(r.apiPubHex).catch(() => notify("Withdrawn here. MoonPay could not be told just now: it ends on its own date.", true));
    return r;
  }, "Automatic trading is no longer allowed. What it held was sold.");

  const head = (
    <div className="real-notice-head">
      <h3>Auto-Pilot</h3>
      <span className="mode-pill">Real mode</span>
      {st?.on && <span className={`ap-chip ${st.paused ? "amber" : "up"}`}>{st.paused ? "Paused" : "On"}</span>}
    </div>
  );
  if (!st) return <section className="panel real-notice autopilot">{head}<p className="muted small">{err || "Loading…"}</p></section>;
  if (!st.available)
    return (
      <section className="panel real-notice autopilot">
        {head}
        <p>Automated wallet trading isn't switched on yet. It will trade your own wallet within limits you set.</p>
        {access.me?.role === "admin" && st.reason && <p className="muted small">{st.reason}</p>}
        <button className="btn ghost wide" onClick={onPaper}>Switch to Paper Mode</button>
      </section>
    );
  const L = st.limits;
  return (
    <section className="panel real-notice autopilot">
      {head}
      {!st.allowed ? (
        <>
          <p>The AI agent can trade your own Solana wallet for you, with no click per trade, inside your limits: {fmtUsd(L.perTradeUsd)} a trade, {fmtUsd(L.dailySpendUsd)} a day, and it pauses for the day after a {fmtUsd(L.dailyLossUsd)} loss.</p>
          {st.allowProblem && <p className="down small">{st.allowProblem}</p>}
          <button className="btn buy wide" onClick={() => setConsent(true)} disabled={!!busy}>Allow automatic trading</button>
        </>
      ) : (
        <>
          {st.on ? (
            <div className="ap-status">
              {st.paused ? <p className="amber small">Paused for today: {st.stopReason}. It starts again tomorrow (UTC).</p> : <p className="small">{st.agent.watching ? <>Watching <b>{st.agent.watching}</b></> : "Looking for a coin to trade"}</p>}
              {st.holding.map((h) => (
                <p key={h.symbol + h.at} className="small">
                  Holding <b>{h.symbol}</b> for {fmtUsd(h.costUsd)}{h.changePct !== null && <span className={h.changePct >= 0 ? "up" : "down"}> ({h.changePct >= 0 ? "+" : ""}{h.changePct.toFixed(1)}%)</span>}
                  {h.sellError && <span className="down"> · selling did not go through yet: {h.sellError}</span>}
                </p>
              ))}
            </div>
          ) : (
            <p className="small">{st.stopReason ? `Stopped: ${st.stopReason}.` : "Ready. Start it to let the agent trade your wallet."}</p>
          )}
          <dl className="ap-today">
            <div><dt>Spent today</dt><dd>{fmtUsd(st.today.spentUsd)} <em>of {fmtUsd(L.dailySpendUsd)}</em></dd></div>
            <div><dt>Result today</dt><dd className={st.today.pnlUsd > 0 ? "up" : st.today.pnlUsd < 0 ? "down" : ""}>{signed(st.today.pnlUsd)} <em>pauses at -{fmtUsd(L.dailyLossUsd)}</em></dd></div>
            <div><dt>Per trade</dt><dd>{fmtUsd(L.perTradeUsd)} <button className="link-btn tiny" onClick={() => setEditing(true)}>change</button></dd></div>
            <div><dt>Signatures</dt><dd>{st.today.signatures} <em>of {st.today.signatureLimit} today</em></dd></div>
          </dl>
          {st.on ? (
            <button className="btn sell wide" onClick={() => run("stop", api.autopilotStop, "Auto-pilot stopped. What it held was sold.")} disabled={!!busy}>{busy === "stop" ? "Stopping and selling…" : "Stop (sells what it holds)"}</button>
          ) : (
            <button className="btn buy wide" onClick={() => run("start", api.autopilotStart, "Auto-pilot started with real money")} disabled={!!busy}>{busy === "start" ? "Starting…" : "Start auto-pilot"}</button>
          )}
          {st.trades.length > 0 && (
            <ul className="ap-trades small">
              {st.trades.slice(0, 5).map((t, i) => (
                <li key={(t.signature ?? "") + i}>
                  <span className={t.status !== "Success" ? "down" : t.side === "BUY" ? "up" : "down"}>{t.status !== "Success" ? "Failed" : t.side === "BUY" ? "Bought" : "Sold"}</span> {t.symbol}
                  {t.usd !== null && <span className="muted"> · {fmtUsd(t.usd)}</span>}
                  <span className="muted"> · {new Date(t.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted tiny">Allowed for your wallet {st.allowed.address.slice(0, 4)}…{st.allowed.address.slice(-4)} until {day(st.allowed.expiresAt)} · <button className="link-btn tiny" onClick={() => void revoke()} disabled={!!busy}>Withdraw permission</button></p>
        </>
      )}
      {consent && <ConsentModal st={st} notify={notify} onClose={() => setConsent(false)} onDone={(s) => { setSt(s); setConsent(false); }} />}
      {editing && <LimitsModal limits={L} max={st.maxPerTradeUsd} onClose={() => setEditing(false)} onSaved={(s) => { setSt(s); setEditing(false); notify("Limits saved"); }} />}
    </section>
  );
}

function LimitsFields({ value, max, onChange }: { value: AutopilotLimits; max: number; onChange: (l: AutopilotLimits) => void }) {
  const f = (k: keyof AutopilotLimits, label: string, hint: string) => (
    <label>
      {label}
      <span className="ap-money">$<input inputMode="decimal" value={String(value[k])} onChange={(e) => onChange({ ...value, [k]: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })} /></span>
      <small>{hint}</small>
    </label>
  );
  return (
    <div className="ap-limits auth-form">
      {f("perTradeUsd", "Per trade", `$10 to $${max}`)}
      {f("dailySpendUsd", "Spent per day, at most", "No new buys once it is reached")}
      {f("dailyLossUsd", "Pause for the day after losing", "It stops buying until the next day (UTC)")}
    </div>
  );
}

function LimitsModal({ limits, max, onClose, onSaved }: { limits: AutopilotLimits; max: number; onClose: () => void; onSaved: (s: AutopilotStatus) => void }) {
  const [l, setL] = useState(limits);
  const [err, setErr] = useState("");
  const save = () => api.autopilotLimits(l).then(onSaved).catch((e) => setErr(e.message));
  return (
    <Modal title="Auto-pilot limits" onClose={onClose} narrow foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn buy" onClick={() => void save()}>Save</button></>}>
      <LimitsFields value={l} max={max} onChange={setL} />
      {err && <p className="down small" role="alert">{err}</p>}
    </Modal>
  );
}

// Allowing it: what it does and the risks, the limits, then MoonPay's own permission step.
function ConsentModal({ st, notify, onClose, onDone }: { st: AutopilotStatus; notify: Notify; onClose: () => void; onDone: (s: AutopilotStatus) => void }) {
  const grant = useContext(AutopilotGrantContext);
  const [l, setL] = useState(st.limits);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const allow = async () => {
    setErr("");
    if (!grant) return setErr("Wallets are not loaded in this browser. Reload the page and try again.");
    if (!grant.signedIn) {
      grant.signIn();
      return setErr("Sign in with MoonPay (your email) in the window that opened, then press Allow again.");
    }
    setBusy(true);
    try {
      await api.autopilotLimits(l);
      const g = await api.autopilotAllowStart();
      const t = await grant.grant(g.apiPubHex, g.address, g.expiresAt);
      onDone(await api.autopilotAllowFinish({ apiPubHex: g.apiPubHex, expiresAt: g.expiresAt, ...t }));
      notify("Automatic trading allowed. Start the auto-pilot when you're ready.");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Allow automatic trading?" onClose={onClose} narrow foot={<>
      <button className="btn ghost" onClick={onClose}>Not now</button>
      <button className="btn sell" disabled={!ok || busy} onClick={() => void allow()}>{busy ? "Allowing…" : "Allow"}</button>
    </>}>
      <p>The AI agent will buy and sell Solana coins with <b>real money from your own wallet</b>, with no click from you for each trade.</p>
      <ul className="small deposit-notes">
        <li>You can lose some or all of what it trades. Prices of small coins move fast.</li>
        <li>The AI's plans are estimates, not promises, and not financial advice. In our own tests most automated trades lost money after costs.</li>
        <li>Network fees and slippage apply to every trade; 0.01 SOL is always kept for fees.</li>
        <li>MoonPay lets this app sign for your Solana wallet only, for 30 days. You can stop it or withdraw the permission any time; stopping sells what it holds.</li>
      </ul>
      <LimitsFields value={l} max={st.maxPerTradeUsd} onChange={setL} />
      <label className="ap-ok small"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I understand the risks and allow automatic trading within these limits.</label>
      {err && <p className="down small" role="alert">{err}</p>}
    </Modal>
  );
}
