// Header controls: Settings (wrench) and the account (sign in / profile).
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, fmtPrice, fmtUsd, SIGNIN_EVENT, type AdminUser, type AppState, type AuditEntry, type BillingStatus, type Trade, type RealTrade, type Permission, type PlanExtras, type PlanId, type PlanInfo, type User } from "./api";
import { openSubscriptionTerms } from "./Footer";

// ---------- Shared modal ----------

export function Modal({ title, onClose, children, foot, narrow, wide }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; narrow?: boolean; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop">
      <div className={`modal ${narrow ? "narrow" : ""} ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Settings ----------

export function SettingsButton({ alerts, fee, slip, onSaved, notify }: { alerts: "telegram" | "ntfy" | null; fee: number; slip: number; onSaved: () => void; notify: (m: string, bad?: boolean) => void }) {
  const access = useAccess();
  const [open, setOpen] = useState(false);
  const [feeS, setFeeS] = useState(String(fee));
  const [slipS, setSlipS] = useState(String(slip));
  const [saving, setSaving] = useState(false);
  // What the app shows: parts you can hide. Kept on your account, so it follows you to every sign-in.
  const hidden = access.me?.prefs?.hide ?? [];
  const [showSignal, setShowSignal] = useState(true);
  const openIt = () => {
    setFeeS(String(fee));
    setSlipS(String(slip));
    setShowSignal(!hidden.includes("aiSignal"));
    setOpen(true);
  };
  const hideNext = showSignal ? hidden.filter((x) => x !== "aiSignal") : [...new Set([...hidden, "aiSignal"])];
  const prefsChanged = [...hideNext].sort().join() !== [...hidden].sort().join();
  const f = Number(feeS), sl = Number(slipS);
  const valid = f >= 0 && f <= 10 && sl >= 0 && sl <= 10;
  const changed = f !== fee || sl !== slip;
  const save = async () => {
    if (!valid) return notify("Fees and slippage must be between 0 and 10%.", true);
    setSaving(true);
    try {
      if (changed) await api.settings({ feePct: f, slippagePct: sl });
      if (prefsChanged) {
        await api.setPrefs(hideNext);
        access.reloadMe?.();
      }
      onSaved();
      setOpen(false);
      notify(changed && prefsChanged ? "Settings saved." : changed ? "Trading costs saved." : prefsChanged ? (showSignal ? "The AI Signal card is shown again." : "The AI Signal card is hidden. Switch it back on here in Settings.") : "No changes.");
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <button className="icon-btn" onClick={openIt} data-tip="Settings" aria-label="Settings">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      </button>
      {open && (
        <Modal
          title="Settings"
          onClose={() => setOpen(false)}
          foot={
            <>
              <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn buy" onClick={save} disabled={saving}>{saving ? "Saving…" : "Confirm"}</button>
            </>
          }
        >
          <div className="settings-head">
            <span>Trading costs (paper)</span>
            <span className="muted tiny">Used for every simulated trade</span>
          </div>
          <div className="grid2 knobs">
            <label>
              Fee per buy or sell (%)
              <input type="number" step="0.1" min="0" max="10" value={feeS} onChange={(e) => setFeeS(e.target.value)} />
              <small>What your exchange charges on each side of a trade.</small>
            </label>
            <label>
              Slippage per buy or sell (%)
              <input type="number" step="0.1" min="0" max="10" value={slipS} onChange={(e) => setSlipS(e.target.value)} />
              <small>How much worse the fill usually is than the quoted price. Thin coins slip more.</small>
            </label>
          </div>
          <p className="small">
            A buy plus a sell costs about <b>{(2 * ((f || 0) + (sl || 0))).toFixed(1)}%</b>. Agents aim for at least +5% after these costs, so their first target sits that much higher on the price.
          </p>

          <div className="settings-head">
            <span>What the app shows</span>
            <span className="muted tiny">Saved to your account</span>
          </div>
          <label className="check small settings-show">
            <input type="checkbox" checked={showSignal} onChange={(e) => setShowSignal(e.target.checked)} />
            <span><b>AI Signal card</b>: the AI's plan for the coin on the chart, with the Analyze button. Untick it to hide the card; it then stays hidden every time you sign in, on any device, until you tick it again here. Your agents are not affected.</span>
          </label>

          <div className="settings-head">
            <span>Phone alerts</span>
            <span className={`tiny ${alerts ? "up" : "muted"}`}>{alerts ? `On (${alerts === "telegram" ? "Telegram" : "ntfy"})` : "Off"}</span>
          </div>
          <p className="small">
            {alerts
              ? "You'll get a message for every agent buy and sell, protected sells, the daily loss limit, the emergency stop, and a daily summary after midnight UTC."
              : "Get a message on your phone for every trade, safety limit and a daily summary: add Telegram or ntfy settings in Vercel (see the README), then redeploy."}
          </p>
        </Modal>
      )}
    </>
  );
}

// ---------- Account ----------

const initials = (u: User) => `${u.firstName[0] ?? ""}${u.lastName[0] ?? ""}`.toUpperCase();

export function Avatar({ user, size }: { user: User; size: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initials(user)}
    </span>
  );
}

// Set when the page was opened to sign in (the landing page's buttons): the sign-in window opens
// as soon as sign-in is ready, then the flag is cleared.
export const SIGNIN_PENDING = "nexus-signin-pending";

// When MoonPay's wallets are switched on (keys set on the server), sign-in runs on MoonPay: its
// account button is given here (MoonPaySignIn.tsx, loaded only then: MoonPay's kit is large).
export const MoonPayUI = createContext<null | { AccountButton: (p: AccountButtonProps) => ReactNode }>(null);
// The MoonPay wallet this browser can sign real trades with (MoonPaySignIn.tsx). The server names the
// wallet each trade must be signed by; only that one is used.
export type TxSigner = { via: "moonpay"; addresses: string[]; sign: (address: string, tx: Uint8Array) => Promise<Uint8Array> };
export const MoonPaySigner = createContext<TxSigner | null>(null);

type Props = { notify: (m: string, bad?: boolean) => void; onChange: () => void; state: AppState | null };
export type AccountButtonProps = Props;
export function AccountButton(props: Props) {
  const moonpay = useContext(MoonPayUI);
  if (moonpay) return <>{moonpay.AccountButton(props)}</>;
  return <PasswordAccountButton {...props} />;
}

// First MoonPay sign-in: pick a username (and confirm the name) for the app's own account.
export type ProfileFields = { username: string; firstName: string; lastName: string };
export function SetupProfileModal({ initial, onClose, onDone, complete, walletNote = "Your Solana wallet is created automatically." }: { initial: { email: string | null; firstName: string; lastName: string }; onClose: () => void; onDone: (u: User) => void; complete: (f: ProfileFields) => Promise<{ user: User }>; walletNote?: string }) {
  const [f, setF] = useState({ username: "", firstName: initial.firstName, lastName: initial.lastName });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await complete(f);
      onDone(r.user);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }) });
  return (
    <Modal title="Set up your account" onClose={onClose} narrow>
      <form className="auth-form" onSubmit={submit}>
        <p className="muted small">Welcome! {initial.email ? <>Signed in as <b>{initial.email}</b>. </> : ""}Pick a username for your account. {walletNote}</p>
        <div className="grid2">
          <label>First name<input autoComplete="given-name" required maxLength={40} {...field("firstName")} /></label>
          <label>Last name<input autoComplete="family-name" required maxLength={40} {...field("lastName")} /></label>
        </div>
        <label>Username<input autoFocus autoComplete="username" required pattern="[A-Za-z0-9_]{3,20}" title="3-20 letters, numbers or _" {...field("username")} /><small>3-20 letters, numbers or _. It can't be changed later.</small></label>
        {err && <p className="down small" role="alert">{err}</p>}
        <button className="btn buy wide" disabled={busy}>{busy ? "Please wait…" : "Create my account"}</button>
      </form>
    </Modal>
  );
}

function PasswordAccountButton({ notify, onChange, state }: Props) {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = still checking
  const [open, setOpen] = useState<"auth" | "profile" | null>(null);
  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);
  useEffect(() => {
    const open = () => setOpen("auth");
    if (sessionStorage.getItem(SIGNIN_PENDING)) {
      sessionStorage.removeItem(SIGNIN_PENDING);
      open();
    }
    window.addEventListener(SIGNIN_EVENT, open);
    return () => window.removeEventListener(SIGNIN_EVENT, open);
  }, []);
  if (user === undefined) return <span className="avatar-slot" />;
  return (
    <>
      {user ? (
        <button className="avatar-btn" onClick={() => setOpen("profile")} data-tip="Profile" aria-label={`Profile: ${user.firstName} ${user.lastName}`}>
          <Avatar user={user} size={34} />
        </button>
      ) : (
        <button className="btn ghost signin-btn" onClick={() => setOpen("auth")}>Sign in</button>
      )}
      {open === "auth" && <AuthModal onClose={() => setOpen(null)} onDone={(u) => { setUser(u); setOpen(null); onChange(); notify(`Welcome, ${u.firstName}! Your own paper account is loaded.`); }} />}
      {open === "profile" && user && (
        <ProfileModal
          user={user}
          state={state}
          notify={notify}
          onClose={() => setOpen(null)}
          onSignedOut={() => { setUser(null); setOpen(null); onChange(); notify("Signed out. Your paper account is hidden until you sign in again."); }}
        />
      )}
    </>
  );
}

function AuthModal({ onClose, onDone }: { onClose: () => void; onDone: (u: User) => void }) {
  const [tab, setTab] = useState<"in" | "up">("in");
  const [f, setF] = useState({ login: "", username: "", firstName: "", lastName: "", email: "", password: "", confirm: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const field = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    if (tab === "up" && f.password !== f.confirm) return setErr("The two passwords don't match");
    setBusy(true);
    try {
      const r = tab === "in"
        ? await api.signIn({ login: f.login, password: f.password })
        : await api.signUp({ username: f.username, firstName: f.firstName, lastName: f.lastName, email: f.email, password: f.password });
      onDone(r.user);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={tab === "in" ? "Sign in" : "Create account"} onClose={onClose} narrow>
      <div className="auth-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "in"} className={tab === "in" ? "on" : ""} onClick={() => { setTab("in"); setErr(""); }}>Sign in</button>
        <button role="tab" aria-selected={tab === "up"} className={tab === "up" ? "on" : ""} onClick={() => { setTab("up"); setErr(""); }}>Create account</button>
      </div>
      <form className="auth-form" onSubmit={submit}>
        {tab === "in" ? (
          <label>Username or email<input autoFocus autoComplete="username" required {...field("login")} /></label>
        ) : (
          <>
            <div className="grid2">
              <label>First name<input autoFocus autoComplete="given-name" required maxLength={40} {...field("firstName")} /></label>
              <label>Last name<input autoComplete="family-name" required maxLength={40} {...field("lastName")} /></label>
            </div>
            <label>Username<input autoComplete="username" required pattern="[A-Za-z0-9_]{3,20}" title="3-20 letters, numbers or _" {...field("username")} /><small>3-20 letters, numbers or _. It can't be changed later.</small></label>
            <label>Email<input type="email" autoComplete="email" required {...field("email")} /></label>
          </>
        )}
        <label>Password<input type="password" autoComplete={tab === "in" ? "current-password" : "new-password"} required minLength={tab === "up" ? 8 : undefined} {...field("password")} />{tab === "up" && <small>At least 8 characters.</small>}</label>
        {tab === "up" && <label>Confirm password<input type="password" autoComplete="new-password" required {...field("confirm")} /></label>}
        {err && <p className="down small" role="alert">{err}</p>}
        <button className="btn buy wide" disabled={busy}>{busy ? "Please wait…" : tab === "in" ? "Sign in" : "Create account"}</button>
      </form>
    </Modal>
  );
}

export function ProfileModal({ user, state, onClose, onSignedOut, notify, signOutOverride }: { user: User; state: AppState | null; onClose: () => void; onSignedOut: () => void; notify: (m: string, bad?: boolean) => void; signOutOverride?: () => Promise<void> }) {
  const access = useAccess();
  const [activityOpen, setActivityOpen] = useState(false);
  // Paper and Real are kept apart: Paper shows the paper account, Real shows the customer's own
  // wallets and their real trades only (never paper figures).
  const real = (access.me?.tradeMode ?? user.tradeMode) === "real";
  const [realView, setRealView] = useState<{ totalUsd: number | null; complete: boolean; trades: RealTrade[] | null; autopilot: { on: boolean; paused: boolean } | null } | null>(null);
  useEffect(() => {
    if (!real) return setRealView(null);
    let live = true;
    Promise.all([
      api.moonBalances().then((r) => ({ totalUsd: r.totalUsd ?? null, complete: r.complete !== false })).catch(() => ({ totalUsd: null, complete: false })),
      api.realTrades(200).catch(() => null),
      api.autopilot().then((a) => ({ on: a.on, paused: a.paused })).catch(() => null),
    ]).then(([b, trades, autopilot]) => live && setRealView({ ...b, trades, autopilot }));
    return () => void (live = false);
  }, [real]);
  // This login's own paper account at a glance.
  const acc = state && !state.signedOut ? state : null;
  const eq = acc?.equityNow ?? 0;
  const pnl = acc ? eq - acc.startCash : 0;
  const pnlPct = acc && acc.startCash > 0 ? (pnl / acc.startCash) * 100 : 0;
  const sells = acc?.trades.filter((t) => t.side === "SELL") ?? [];
  const wins = sells.filter((t) => (t.pnlUsd ?? 0) > 0).length;
  const [resetting, setResetting] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    if (pw.next !== pw.confirm) return setErr("The two new passwords don't match");
    setBusy(true);
    try {
      await api.changePassword({ current: pw.current, next: pw.next });
      setResetting(false);
      setPw({ current: "", next: "", confirm: "" });
      notify("Password changed. Other devices were signed out.");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    if (signOutOverride) return void (await signOutOverride());
    await api.signOut().catch(() => {});
    onSignedOut();
  };
  return (
    <Modal title="Profile" onClose={onClose} narrow foot={<button className="btn ghost" onClick={signOut}>Sign out</button>}>
      <div className="profile-hero">
        <Avatar user={user} size={72} />
        <div className="profile-id">
          <div className="profile-name">{user.firstName} {user.lastName}</div>
          <div className="muted small">@{user.username}</div>
          <span className="profile-chip">{access.me?.role === "admin" ? "Admin · " : ""}{planName(access.me?.plan)} plan · member since {new Date(user.createdAt).toLocaleDateString([], { month: "short", year: "numeric" })}</span>
        </div>
      </div>

      {real ? (
        <RealStats view={realView} />
      ) : acc && (
        <div className="profile-stats">
          <div><small>Equity</small><b>{fmtUsd(eq)}</b></div>
          <div><small>Since start</small><b className={pnl >= 0 ? "up" : "down"}>{pnl >= 0 ? "+" : ""}{fmtUsd(pnl)}<em>{pnl >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</em></b></div>
          <div><small>Closed trades</small><b>{sells.length}<em>{sells.length ? `${Math.round((wins / sells.length) * 100)}% won` : "none yet"}</em></b></div>
          <div><small>Bot</small><b className={acc.bot.running ? "up" : ""}>{acc.bot.running ? "Running" : "Off"}<em>{acc.positions.length} open · {acc.orders?.length ?? 0} orders</em></b></div>
        </div>
      )}

      <TradeModeSwitch user={user} notify={notify} />
      <TokenMeter usage={access.me?.usage} />
      <div className="profile-actions">
        <button className="btn ghost" onClick={access.openPlans}>See plans</button>
        <BillingButton />
        <button className="btn ghost" onClick={() => setActivityOpen(true)}>Activity & history</button>
        {access.can("admin.users") && <button className="btn ghost" onClick={access.openAdmin}>Manage users</button>}
      </div>

      <div className="profile-section-title">Account details</div>
      <dl className="profile-fields">
        <div><dt>Username</dt><dd>@{user.username} <span className="lock" title="Can't be changed">🔒</span></dd></div>
        <div><dt>Name</dt><dd>{user.firstName} {user.lastName} <span className="lock" title="Can't be changed">🔒</span></dd></div>
        <div><dt>Email</dt><dd>{user.email}</dd></div>
        <div><dt>Currency</dt><dd><CurrencyPicker notify={notify} /></dd></div>
        {!real && <div><dt>Started with</dt><dd>{acc ? fmtUsd(acc.startCash) : "–"}</dd></div>}
      </dl>
      <p className="muted tiny">{real
        ? "Real mode shows your own wallets and your real trades only. Your paper account is kept apart and does not change."
        : "Your paper account is yours alone: other logins have their own balance, trades and bot."}</p>
      {user.hasPassword === false ? null : !resetting ? (
        <button className="btn ghost" onClick={() => setResetting(true)}>🔑 Reset password</button>
      ) : (
        <form className="auth-form" onSubmit={changePw}>
          <label>Current password<input type="password" autoComplete="current-password" required autoFocus value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
          <label>New password<input type="password" autoComplete="new-password" required minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /><small>At least 8 characters.</small></label>
          <label>Confirm new password<input type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></label>
          {err && <p className="down small" role="alert">{err}</p>}
          <div className="row-btns">
            <button type="button" className="btn ghost" onClick={() => { setResetting(false); setErr(""); }}>Cancel</button>
            <button className="btn buy" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
          </div>
        </form>
      )}
      {activityOpen && <ActivityModal onClose={() => setActivityOpen(false)} notify={notify} />}
    </Modal>
  );
}


// Real mode in the profile: the dollar value of the customer's own wallets and their real trades.
function RealStats({ view }: { view: { totalUsd: number | null; complete: boolean; trades: RealTrade[] | null; autopilot: { on: boolean; paused: boolean } | null } | null }) {
  const done = view?.trades?.filter((t) => t.status === "Success") ?? [];
  const buys = done.filter((t) => t.side === "BUY").length, sells = done.length - buys;
  const volume = done.reduce((sum, t) => sum + (t.usd ?? 0), 0);
  return (
    <div className="profile-stats">
      <div><small>Wallet balance</small><b>{view === null ? "…" : view.totalUsd === null ? "—" : fmtUsd(view.totalUsd)}<em>{view && !view.complete ? "some figures missing" : "all your wallets"}</em></b></div>
      <div><small>Real trades</small><b>{view?.trades ? done.length : "…"}<em>{done.length ? `${buys} bought · ${sells} sold` : "none yet"}</em></b></div>
      <div><small>Traded</small><b>{view?.trades ? fmtUsd(volume) : "…"}<em>in real trades</em></b></div>
      <div><small>Auto-pilot</small><b className={view?.autopilot?.on ? (view.autopilot.paused ? "amber" : "up") : ""}>{view === null ? "…" : view.autopilot?.on ? (view.autopilot.paused ? "Paused" : "On") : "Off"}<em>{view?.autopilot?.on ? (view.autopilot.paused ? "for today: loss limit" : "trading your wallet") : "for real money"}</em></b></div>
    </div>
  );
}

// The currency every amount in the app is shown in (and typed in). The app keeps dollars; this is
// how they are shown, at Coinbase's rate (server/src/fx.ts). Kept with the account.
function CurrencyPicker({ notify }: { notify: (m: string, bad?: boolean) => void }) {
  const access = useAccess();
  const list = access.currencies ?? [];
  const now = access.me?.prefs?.currency ?? "USD";
  const [busy, setBusy] = useState(false);
  const pick = async (code: string) => {
    setBusy(true);
    try {
      await api.setCurrency(code);
      access.reloadMe?.();
      notify(`Amounts are now shown in ${code}`);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  if (!list.length) return <span>{now}</span>;
  return (
    <select className="currency-pick" value={now} disabled={busy} onChange={(e) => void pick(e.target.value)} aria-label="Currency to show amounts in">
      {list.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
    </select>
  );
}

// Profile: Stripe's billing page (card, invoices, cancel), once the account has paid through it.
function BillingButton() {
  const [b, setB] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.billing().then(setB).catch(() => {});
  }, []);
  if (!b?.on || !b.canManage) return null;
  const open = async () => {
    setBusy(true);
    try {
      window.location.href = (await api.billingPortal()).url;
    } catch {
      setBusy(false);
    }
  };
  return <button className="btn ghost" onClick={() => void open()} disabled={busy} title={b.subscription?.periodEnd ? `${b.subscription.cancelAtPeriodEnd ? "Ends" : "Renews"} ${new Date(b.subscription.periodEnd).toLocaleDateString()}` : undefined}>{busy ? "Opening…" : "Manage billing"}</button>;
}

// Paper or Real: which money the app shows and trades. Going Real asks for a clear "I understand".
function TradeModeSwitch({ user, notify }: { user: User; notify: (m: string, bad?: boolean) => void }) {
  const access = useAccess();
  const [mode, setMode] = useState<"paper" | "real">((access.me?.tradeMode ?? user.tradeMode) === "real" ? "real" : "paper");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (next: "paper" | "real") => {
    setBusy(true);
    try {
      await api.setTradeMode(next);
      setMode(next);
      setConfirming(false);
      access.reloadMe?.();
      notify(next === "real" ? "Real mode on: the app now shows your own wallet" : "Paper mode on: trades use your paper account");
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  const real = mode === "real";
  return (
    <div className="mode-switch-row">
      <div>
        <div className="mode-switch-title">Trading mode: {real ? <b className="up">Real</b> : <b className="amber">Paper</b>}</div>
        <div className="muted tiny">{real ? "Uses the money in your own wallet." : "Practice money only. Nothing real is bought or sold."}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={real}
        aria-label="Real transactions"
        className={`mode-switch ${real ? "on" : ""}`}
        disabled={busy}
        onClick={() => (real ? void save("paper") : setConfirming(true))}
      >
        <span className="mode-switch-label">Paper</span>
        <span className="mode-switch-label">Real</span>
        <span className="mode-switch-knob" />
      </button>
      {confirming && (
        <Modal title="Switch to Real?" onClose={() => setConfirming(false)} narrow foot={<>
          <button className="btn ghost" onClick={() => setConfirming(false)}>Stay on Paper</button>
          <button className="btn sell" disabled={busy} onClick={() => void save("real")}>{busy ? "Switching…" : "I understand"}</button>
        </>}>
          <p>Real mode uses the money in <b>your own wallets</b>, not practice money.</p>
          <ul className="small deposit-notes">
            <li>Crypto prices move fast. You can lose some or all of what you trade.</li>
            <li>The AI's plans are estimates, not promises, and not financial advice.</li>
            <li>Network fees and slippage apply to every real trade.</li>
            <li>Your paper account and its bot stay as they are; switch back any time.</li>
          </ul>
        </Modal>
      )}
    </div>
  );
}

// ---------- Plans & access (RBAC) ----------
const PLAN_NAMES: Record<string, string> = { free: "Free", member: "Starter", starter: "Starter", pro: "AI Pro", max: "AI Max" };
const planName = (id?: string) => PLAN_NAMES[id ?? "free"] ?? "Free";
// The signed-in user's plan, role and permissions, shared across the page.
export type Access = { me: User | null; can: (p: Permission) => boolean; openPlans: () => void; openAdmin: () => void; reloadMe?: () => void; currencies?: { code: string; name: string; rate: number }[] };
export const AccessCtx = createContext<Access>({ me: null, can: () => true, openPlans: () => {}, openAdmin: () => {} });
export const useAccess = () => useContext(AccessCtx);

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

// A small lock shown in place of a feature the plan doesn't include.
export function LockChip({ label, plan = "Starter" }: { label: string; plan?: string }) {
  const { openPlans } = useAccess();
  return (
    <button className="lock-chip" onClick={openPlans} title={`${label} is included from ${plan}. See plans.`}>
      🔒 {label} · <span>{plan}+</span>
    </button>
  );
}

// AI token usage bar (profile): just the share of this month's tokens used.
// Unlimited accounts (admins) are measured against the top plan's allowance.
const MAX_PLAN_TOKENS = 13_000_000;
export function TokenMeter({ usage }: { usage?: User["usage"] }) {
  const { openPlans } = useAccess();
  if (!usage) return null;
  const noAi = usage.limit === 0;
  const ref = usage.limit < 0 ? MAX_PLAN_TOKENS : usage.limit;
  const pct = noAi ? 0 : Math.min(100, (usage.used / ref) * 100);
  return (
    <div className="token-meter">
      <div className="tm-head">
        <span>AI token usage</span>
        <b>{noAi ? <button className="link-btn" onClick={openPlans}>Not in your plan</button> : `${pct.toFixed(0)}%`}</b>
      </div>
      <div className="tm-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="AI tokens used this month">
        <div className={pct > 90 ? "hot" : pct > 70 ? "warm" : ""} style={{ width: `${Math.max(pct, usage.used > 0 ? 1 : 0)}%` }} />
      </div>
    </div>
  );
}


// The Plans window (the owner's "Plans & AI Credits" mockup): four plans, monthly or yearly, and
// pay-as-you-go AI token packs, paid by card on Stripe's own page (billing.ts). ask = it opened
// because something needs a higher plan: that is said at the top and the plan that unlocks it is lit.
export function PlansModal({ onClose, ask }: { onClose: () => void; ask?: { reason: string; need?: PlanId } | null }) {
  const { me, reloadMe } = useAccess();
  const [plans, setPlans] = useState<PlanInfo[] | null>(null);
  const [extras, setExtras] = useState<PlanExtras | null>(null);
  const [bill, setBill] = useState<BillingStatus | null>(null);
  const [yearly, setYearly] = useState(false);
  const [pick, setPick] = useState<{ kind: "plan"; plan: PlanInfo } | { kind: "pack"; pack: PlanExtras["tokenPacks"][number] } | { kind: "cancel" } | null>(null);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    void api.plans().then(setPlans).catch(() => setPlans([]));
    void api.planExtras().then(setExtras).catch(() => {});
    if (me) void api.billing().then(setBill).catch(() => {});
  }, [me?.username]); // eslint-disable-line react-hooks/exhaustive-deps
  const paid = extras?.yearlyMonthsPaid ?? 11;
  const free = 12 - paid;
  const current = (me?.plan ?? "free") as PlanId;
  const order = (plans ?? []).map((p) => p.id);
  const rankOf = (id: PlanId) => order.indexOf(id);
  const sub = bill?.subscription ?? null;
  const on = !!bill?.on;
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setErr("");
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  };
  const go = (url: string) => { window.location.href = url; };
  const confirmPlan = (p: PlanInfo) => run("plan", async () => {
    const r = await api.billingCheckout({ plan: p.id, interval: yearly ? "year" : "month", terms: bill!.termsVersion });
    if ("url" in r) return go(r.url);
    setBill(r.status);
    setPick(null);
    reloadMe?.();
  });
  const confirmPack = (id: string) => run("pack", async () => go((await api.billingPack({ pack: id, terms: bill!.termsVersion })).url));
  const cancel = () => run("cancel", async () => { setBill(await api.billingCancel()); setPick(null); });
  const resume = () => run("resume", async () => { setBill(await api.billingResume()); });
  const manage = () => run("manage", async () => go((await api.billingPortal()).url));
  const until = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "");
  const buttonFor = (p: PlanInfo) => {
    if (p.id === current) {
      if (sub?.cancelAtPeriodEnd) return <button className="btn ghost wide" onClick={() => void resume()} disabled={!!busy || !on}>Ends {until(sub.periodEnd)} · Keep it</button>;
      return <button className="btn ghost wide" disabled>Current Plan</button>;
    }
    if (!me) return <button className="btn buy wide" onClick={() => window.dispatchEvent(new Event(SIGNIN_EVENT))}>Sign in to upgrade</button>;
    if (p.id === "free") return sub && !sub.cancelAtPeriodEnd ? <button className="btn ghost wide" onClick={() => { setTerms(false); setPick({ kind: "cancel" }); }} disabled={!on}>Cancel subscription</button> : <button className="btn ghost wide" disabled>Free</button>;
    const down = rankOf(p.id) < rankOf(current);
    return (
      <button className={`btn ${p.popular ? "buy" : "plan-btn"} wide`} disabled={!on || !!busy} onClick={() => { setTerms(false); setErr(""); setPick({ kind: "plan", plan: p }); }} title={on ? undefined : "Online payment is being set up"}>
        {down ? `Switch to ${p.name}` : `Upgrade to ${p.name}`}
      </button>
    );
  };
  return (
    <Modal title="Plans & AI Credits" onClose={onClose} wide>
      {ask && (
        <div className="plans-ask" role="status">
          <b>Upgrade needed.</b> {ask.reason}{ask.need && plans ? ` Included from ${plans.find((p) => p.id === ask.need)?.name ?? "a higher plan"}.` : ""} Choose a plan below.
        </div>
      )}
      <div className="plans-top">
        <p className="plans-lead">Paper trading is free. Upgrade for zero trade fees, Auto-Pilot AI agents, and monthly AI token allowances.</p>
        <div className="billing-toggle" role="radiogroup" aria-label="Billing period">
          <button role="radio" aria-checked={!yearly} className={!yearly ? "on" : ""} onClick={() => setYearly(false)}>Monthly</button>
          <button role="radio" aria-checked={yearly} className={yearly ? "on" : ""} onClick={() => setYearly(true)}>Yearly <span className="save">{free === 1 ? "1 month free" : `${free} months free`}</span></button>
        </div>
      </div>
      {sub && (
        <p className="plans-sub small">
          {sub.cancelAtPeriodEnd ? `Your subscription ends on ${until(sub.periodEnd)}, then Free.` : sub.keep ? `${planName(sub.keep.plan)} stays until ${until(sub.keep.until)}, then ${planName(sub.plan ?? undefined)}.` : `Renews on ${until(sub.periodEnd)} (${sub.interval === "year" ? "yearly" : "monthly"}).`}
          {sub.status === "past_due" && <span className="down"> A payment did not go through: update your card under Manage billing.</span>}
        </p>
      )}
      <div className="plan-grid">
        {(plans ?? []).map((p) => {
          const isCurrent = current === p.id;
          return (
            <div key={p.id} className={`plan-card ${p.id}${isCurrent ? " current" : ""}${p.popular ? " popular" : ""}${ask?.need === p.id ? " suggested" : ""}`}>
              <div className="plan-name">
                {p.name}
                {isCurrent ? <span className="plan-current">Current plan</span> : p.popular ? <span className="plan-popular">Most Popular</span> : null}
              </div>
              <div className="plan-price">
                {yearly && p.priceUsd > 0 ? <>${(p.priceUsd * paid).toLocaleString()}<small> / year</small></> : <>${p.priceUsd}<small> / month</small></>}
              </div>
              <div className="plan-yearly">
                {p.priceUsd > 0 ? (yearly ? `≈ $${(p.priceUsd * paid / 12).toFixed(2)}/mo (${free === 1 ? "1 mo" : `${free} mo`} free)` : `or $${(p.priceUsd * paid).toLocaleString()}/yr (${free === 1 ? "1 mo" : `${free} mo`} free)`) : " "}
              </div>
              <p className="plan-blurb">{p.blurb}</p>
              <ul className="plan-features">{(p.features ?? []).map((f) => <li key={f}>{f}</li>)}</ul>
              {buttonFor(p)}
            </div>
          );
        })}
      </div>
      {extras && (
        <div className="packs">
          <div className="packs-title">Need More AI? Pay-As-You-Go Token Packs</div>
          <p className="muted small">Used after your monthly allowance runs out · Tokens never expire · Available on all AI plans.</p>
          <div className="pack-row">
            {extras.tokenPacks.map((k) => (
              <div key={k.id} className={`pack-card${k.note ? " best" : ""}`}>
                <div>
                  <b>{fmtTokens(k.tokens)} AI Tokens</b>
                  <span className="muted small">≈ {k.analyses} analyses{k.note ? ` · ${k.note}` : ""}</span>
                </div>
                <span className="pack-price">${k.priceUsd}</span>
                <button className="btn plan-btn" disabled={!on || !me || !!busy || !(me && (me.permissions ?? []).includes("ai.analyze"))} title={!(me && (me.permissions ?? []).includes("ai.analyze")) ? "Token packs are for AI plans" : undefined} onClick={() => { setTerms(false); setErr(""); setPick({ kind: "pack", pack: k }); }}>Buy Pack</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="muted tiny plans-foot">
        {on ? <>Payments by Stripe{bill?.mode === "test" ? " (test mode: no real charge)" : ""}. Prices in USD. </> : <>Online payment is being set up. {me?.role === "admin" && bill?.reason ? bill.reason : ""} </>}
        {bill?.canManage && <button className="link-btn tiny" onClick={() => void manage()} disabled={!!busy}>Manage billing</button>}
      </p>
      {err && !pick && <p className="down small">{err}</p>}
      {pick && bill && (
        <Modal title={pick.kind === "cancel" ? "Cancel your subscription?" : pick.kind === "plan" ? (rankOf(pick.plan.id) < rankOf(current) ? `Switch to ${pick.plan.name}` : `Upgrade to ${pick.plan.name}`) : `Buy ${fmtTokens(pick.pack.tokens)} AI tokens`} onClose={() => setPick(null)} narrow foot={<>
          <button className="btn ghost" onClick={() => setPick(null)}>Back</button>
          {pick.kind === "cancel"
            ? <button className="btn sell" onClick={() => void cancel()} disabled={!!busy}>{busy ? "Cancelling…" : "Cancel subscription"}</button>
            : <button className="btn buy" disabled={!terms || !!busy} onClick={() => void (pick.kind === "plan" ? confirmPlan(pick.plan) : confirmPack(pick.pack.id))}>{busy ? "Opening…" : sub && pick.kind === "plan" ? "Confirm change" : "Continue to payment"}</button>}
        </>}>
          {pick.kind === "cancel" ? (
            <p className="small">Your plan stays until {until(sub?.periodEnd)}, then your account returns to Free. Nothing more is charged. You can keep the plan instead any time before then.</p>
          ) : pick.kind === "plan" ? (
            <>
              <p><b>{pick.plan.name}</b>: {yearly ? `$${(pick.plan.priceUsd * paid).toLocaleString()} a year` : `$${pick.plan.priceUsd} a month`}.</p>
              <ul className="small deposit-notes">
                {sub ? (rankOf(pick.plan.id) < rankOf(current)
                  ? <li>{planName(current)} stays until {until(sub.periodEnd)}; then {pick.plan.name} starts at the new price.</li>
                  : <li>It starts now. Your card is charged the difference for the rest of this period.</li>)
                  : <li>You pay on Stripe's secure page. This app never sees your card.</li>}
                <li>It renews automatically every {yearly ? "year" : "month"} until you cancel. Cancel any time: the plan stays until the end of the period paid.</li>
              </ul>
            </>
          ) : (
            <ul className="small deposit-notes">
              <li>${pick.pack.priceUsd}, paid once on Stripe's secure page. The tokens are added as soon as Stripe confirms the payment.</li>
              <li>They are used after your monthly allowance runs out, and never expire.</li>
            </ul>
          )}
          {pick.kind !== "cancel" && <label className="terms-ok small"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /> <span>I agree to the <button className="link-btn" onClick={(e) => { e.preventDefault(); openSubscriptionTerms(); }}>Subscription Terms</button>.</span></label>}
          {err && <p className="down small" role="alert">{err}</p>}
        </Modal>
      )}
    </Modal>
  );
}

export function AdminModal({ onClose, notify }: { onClose: () => void; notify: (m: string, bad?: boolean) => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const load = () => api.adminUsers().then(setUsers).catch((e) => notify(e.message, true));
  useEffect(() => {
    void load();
    void api.plans().then(setPlans).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const change = async (username: string, b: { plan?: PlanId; role?: "user" | "admin" }) => {
    try {
      await api.setUserAccess({ username, ...b });
      notify(`Updated ${username}`);
      void load();
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  const addTokens = async (username: string, tokens: number) => {
    try {
      await api.adminTopup({ username, tokens });
      notify(`Added ${fmtTokens(tokens)} tokens to ${username}`);
      void load();
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  return (
    <Modal title="Manage users" onClose={onClose} wide>
      {!users ? <p className="muted small">Loading…</p> : (
        <div className="table-wrap">
          <table className="scan">
            <thead><tr><th>User</th><th>Email</th><th>Plan</th><th>Role</th><th className="num">AI tokens this month</th><th>Top-up</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username}>
                  <td><b>{u.firstName} {u.lastName}</b><div className="muted tiny">@{u.username}</div></td>
                  <td className="small">{u.email}</td>
                  <td>
                    <select value={u.plan} onChange={(e) => void change(u.username, { plan: e.target.value as PlanId })}>
                      {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={u.role} onChange={(e) => void change(u.username, { role: e.target.value as "user" | "admin" })}>
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="num">{u.usage.limit < 0 ? `${fmtTokens(u.usage.used)} / unlimited` : `${fmtTokens(u.usage.used)} / ${fmtTokens(u.usage.limit)}`}</td>
                  <td>
                    <div className="topup-cell">
                      <span className="mono small">{fmtTokens(u.usage.topup ?? 0)}</span>
                      {[2_000_000, 10_000_000].map((n) => (
                        <button key={n} className="chip" onClick={() => void addTokens(u.username, n)}>+{fmtTokens(n)}</button>
                      ))}
                    </div>
                  </td>
                  <td><button className="chip" onClick={() => setViewing(u.username)}>Activity</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && <ActivityModal username={viewing} onClose={() => setViewing(null)} notify={notify} />}
    </Modal>
  );
}


// ---------- Activity: permanent history ----------
const KIND: Record<string, { label: string; tone: string }> = {
  consent: { label: "Consent", tone: "sell" },
  bot: { label: "Bot", tone: "hold" },
  ai: { label: "AI", tone: "buy" },
  order: { label: "Order", tone: "hold" },
  trade: { label: "Trade", tone: "hold" },
  account: { label: "Account", tone: "" },
  admin: { label: "Admin", tone: "sell" },
};
const FILTERS = ["all", "consent", "bot", "ai", "order", "account", "admin"] as const;

function toCsv(trades: Trade[]) {
  const head = ["time_utc", "side", "token", "pool", "price_usd", "qty", "usd", "dex_fee_usd", "platform_fee_usd", "pnl_usd", "source", "reason"];
  const esc = (v: unknown) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = trades.map((t) => [new Date(t.time).toISOString(), t.side, t.symbol, t.pool, t.price, t.qty, t.usd.toFixed(2), t.feeUsd.toFixed(4), (t.platformFeeUsd ?? 0).toFixed(4), t.pnlUsd?.toFixed(2) ?? "", t.source, t.reason]);
  return [head, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

export function ActivityModal({ onClose, username, notify }: { onClose: () => void; username?: string; notify: (m: string, bad?: boolean) => void }) {
  // username = an admin looking at someone else's activity; otherwise your own (with trades).
  const [tab, setTab] = useState<"activity" | "trades">("activity");
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradeTotal, setTradeTotal] = useState(0);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [open, setOpen] = useState<number | null>(null);
  const loadActivity = (before = 0) =>
    (username ? api.adminActivity(username, before) : api.activity(before))
      .then((r) => { setTotal(r.total); setItems((cur) => (before ? [...cur, ...r.items] : r.items)); })
      .catch((e) => notify(e.message, true));
  const loadTrades = (before = 0) =>
    api.tradeHistory(before, 200)
      .then((r) => { setTradeTotal(r.total); setTrades((cur) => (before ? [...cur, ...r.items] : r.items)); })
      .catch((e) => notify(e.message, true));
  useEffect(() => {
    void loadActivity();
    if (!username) void loadTrades();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const download = async () => {
    try {
      const all = await api.tradeHistory(0, 5000);
      const blob = new Blob([toCsv(all.items)], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      notify(e.message, true);
    }
  };
  const shown = items.filter((e) => filter === "all" || e.type.startsWith(filter + "."));
  return (
    <Modal title={username ? `Activity · @${username}` : "Your activity"} onClose={onClose} wide>
      {!username && (
        <div className="auth-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "activity"} className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>Activity ({total})</button>
          <button role="tab" aria-selected={tab === "trades"} className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")}>All trades ({tradeTotal})</button>
        </div>
      )}
      {tab === "activity" ? (
        <>
          <p className="muted small">A permanent record: consents ("I understand"), bot starts, stops and pauses, AI analyses with tokens used, orders, sign-ins and admin changes. Entries are never edited or deleted.</p>
          <div className="chain-tabs">
            {FILTERS.map((f) => (
              <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{f === "all" ? "All" : KIND[f].label}</button>
            ))}
          </div>
          <div className="activity-list">
            {shown.map((e, i) => {
              const k = KIND[e.type.split(".")[0]] ?? { label: e.type, tone: "" };
              return (
                <div key={`${e.t}-${i}`} className="activity-row">
                  <span className="muted mono tiny">{new Date(e.t).toLocaleString()}</span>
                  <span className={`tag ${k.tone}`}>{k.label}</span>
                  <span className="activity-summary">
                    {e.summary}
                    {e.by && <span className="muted tiny"> · by @{e.by}</span>}
                    {e.data && <button className="link-btn tiny" onClick={() => setOpen(open === i ? null : i)}>{open === i ? "hide details" : "details"}</button>}
                    {open === i && e.data && <pre className="activity-data">{JSON.stringify(e.data, null, 2)}</pre>}
                  </span>
                </div>
              );
            })}
            {!shown.length && <p className="muted small">Nothing here yet.</p>}
          </div>
          {items.length < total && <button className="btn ghost" onClick={() => void loadActivity(items.length)}>Load older</button>}
        </>
      ) : (
        <>
          <div className="row-btns" style={{ justifyContent: "space-between", alignItems: "center", margin: "6px 0 10px" }}>
            <span className="muted small">Every trade, kept permanently (the trade history tab shows the newest 1,000).</span>
            <button className="btn ghost" onClick={() => void download()}>⬇ Download CSV</button>
          </div>
          <div className="table-wrap">
            <table className="scan">
              <thead><tr><th>Time</th><th>Side</th><th>Token</th><th className="num">Price</th><th className="num">USD</th><th className="num">P&amp;L</th><th>Reason</th></tr></thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td className="muted small">{new Date(t.time).toLocaleString()}</td>
                    <td className={t.side === "BUY" ? "up" : "down"}>{t.side}{t.source === "bot" ? " 🤖" : ""}</td>
                    <td><b>{t.symbol}</b></td>
                    <td className="num">{fmtPrice(t.price)}</td>
                    <td className="num">{fmtUsd(t.usd)}</td>
                    <td className={`num ${(t.pnlUsd ?? 0) >= 0 ? "up" : "down"}`}>{t.pnlUsd === undefined ? "–" : fmtUsd(t.pnlUsd)}</td>
                    <td className="muted small">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {trades.length < tradeTotal && <button className="btn ghost" onClick={() => void loadTrades(trades.length)}>Load older</button>}
          {!trades.length && <p className="muted small">No trades recorded yet. Trades are kept from now on.</p>}
        </>
      )}
    </Modal>
  );
}
