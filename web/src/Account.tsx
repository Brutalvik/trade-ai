// Header controls: Settings (wrench) and the account (sign in / profile).
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { createPortal } from "react-dom";
import { api, fmtPrice, fmtUsd, type AdminUser, type AppState, type AuditEntry, type Trade, type Permission, type PlanExtras, type PlanId, type PlanInfo, type User } from "./api";

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

export function SettingsButton({ alerts, continuous, onSaved, notify }: { alerts: "telegram" | "ntfy" | null; continuous: boolean; onSaved: () => void; notify: (m: string, bad?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(continuous);
  const [saving, setSaving] = useState(false);
  const openIt = () => {
    setDraft(continuous);
    setOpen(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      if (draft !== continuous) await api.settings({ continuous: draft });
      onSaved();
      setOpen(false);
      notify(draft === continuous ? "No changes." : draft ? "The bot will now trade continuously." : "The bot will now stop after each profitable trade.");
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
            <span>Bot trading</span>
            <span className="muted tiny">{continuous ? "Continuous" : "One trade at a time"}</span>
          </div>
          <div className="choice-list" role="radiogroup" aria-label="Bot trading">
            <label className={`choice ${!draft ? "on" : ""}`}>
              <input type="radio" name="runmode" checked={!draft} onChange={() => setDraft(false)} />
              <span>
                <b>One trade at a time</b>
                <small>The bot stops itself after a profitable trade, so you can check the result and start it again. After a losing trade it keeps going (with its safety rules).</small>
              </span>
            </label>
            <label className={`choice ${draft ? "on" : ""}`}>
              <input type="radio" name="runmode" checked={draft} onChange={() => setDraft(true)} />
              <span>
                <b>Trade continuously</b>
                <small>The bot keeps trading round after round until you stop it, or a safety limit (daily loss limit, emergency stop) stops it.</small>
              </span>
            </label>
          </div>

          <div className="settings-head">
            <span>Phone alerts</span>
            <span className={`tiny ${alerts ? "up" : "muted"}`}>{alerts ? `On (${alerts === "telegram" ? "Telegram" : "ntfy"})` : "Off"}</span>
          </div>
          <p className="small">
            {alerts
              ? "You'll get a message for every bot buy and sell, protected sells, the daily loss limit, the emergency stop, and a daily summary after midnight UTC."
              : "Get a message on your phone for every trade, safety limit and a daily summary: add Telegram or ntfy settings in Vercel (see the README), then redeploy."}
          </p>
        </Modal>
      )}
    </>
  );
}

// ---------- Account ----------

const initials = (u: User) => `${u.firstName[0] ?? ""}${u.lastName[0] ?? ""}`.toUpperCase();

function Avatar({ user, size }: { user: User; size: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initials(user)}
    </span>
  );
}

// True when the page runs inside Privy's provider (sign-in and wallets through Privy).
export const PrivyEnabled = createContext(false);

type Props = { notify: (m: string, bad?: boolean) => void; onChange: () => void; state: AppState | null };
export function AccountButton(props: Props) {
  return useContext(PrivyEnabled) ? <PrivyAccountButton {...props} /> : <PasswordAccountButton {...props} />;
}

// Sign in with Privy (email code or Google). The server verifies it and keeps its own copy of
// the user (linked by email for existing accounts); new people pick a username once.
function PrivyAccountButton({ notify, onChange, state }: Props) {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<{ email: string | null; firstName: string; lastName: string } | null>(null);
  const linking = useRef(false);
  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);
  const link = async () => {
    if (linking.current) return;
    linking.current = true;
    try {
      const token = await getAccessToken();
      if (!token) return;
      const r = await api.privyLogin(token);
      if (r.needsProfile) setSetup({ email: r.email ?? null, firstName: r.firstName ?? "", lastName: r.lastName ?? "" });
      else if (r.user) {
        setUser(r.user);
        onChange();
        notify(`Welcome, ${r.user.firstName}! Your paper account and wallet are ready.`);
      }
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      linking.current = false;
    }
  };
  // Signed in to Privy but not to the app yet: link the two.
  useEffect(() => {
    if (ready && authenticated && user === null && !setup) void link();
  }, [ready, authenticated, user, setup]); // eslint-disable-line react-hooks/exhaustive-deps
  // The wallet is created just after the first sign-in: tell the server its address once it exists.
  const wallet = wallets[0]?.address;
  useEffect(() => {
    if (user && wallet && !user.solanaAddress && authenticated) void link();
  }, [user?.username, wallet, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps
  const signOut = async () => {
    await api.signOut().catch(() => {});
    await logout().catch(() => {});
    setUser(null);
    setOpen(false);
    onChange();
    notify("Signed out. Your paper account is hidden until you sign in again.");
  };
  if (user === undefined) return <span className="avatar-slot" />;
  return (
    <>
      {user ? (
        <button className="avatar-btn" onClick={() => setOpen(true)} data-tip="Profile" aria-label={`Profile: ${user.firstName} ${user.lastName}`}>
          <Avatar user={user} size={34} />
        </button>
      ) : (
        <button className="btn ghost signin-btn" onClick={() => (authenticated ? void link() : login())} disabled={!ready}>Sign in</button>
      )}
      {setup && (
        <SetupProfileModal
          initial={setup}
          onClose={() => { setSetup(null); void logout(); }}
          onDone={(u) => { setSetup(null); setUser(u); onChange(); notify(`Welcome, ${u.firstName}! Your paper account and wallet are ready.`); }}
          getToken={getAccessToken}
        />
      )}
      {open && user && (
        <ProfileModal
          user={{ ...user, solanaAddress: user.solanaAddress ?? wallet ?? null }}
          state={state}
          notify={notify}
          onClose={() => setOpen(false)}
          onSignedOut={() => void signOut()}
          signOutOverride={signOut}
        />
      )}
    </>
  );
}

// First Privy sign-in: pick a username (and confirm the name) for the app's own account.
function SetupProfileModal({ initial, onClose, onDone, getToken }: { initial: { email: string | null; firstName: string; lastName: string }; onClose: () => void; onDone: (u: User) => void; getToken: () => Promise<string | null> }) {
  const [f, setF] = useState({ username: "", firstName: initial.firstName, lastName: initial.lastName });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your sign-in expired. Please sign in again.");
      const r = await api.privyComplete({ accessToken: token, ...f });
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
        <p className="muted small">Welcome! {initial.email ? <>Signed in as <b>{initial.email}</b>. </> : ""}Pick a username for your account. Your Solana wallet is created automatically.</p>
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

function ProfileModal({ user, state, onClose, onSignedOut, notify, signOutOverride }: { user: User; state: AppState | null; onClose: () => void; onSignedOut: () => void; notify: (m: string, bad?: boolean) => void; signOutOverride?: () => Promise<void> }) {
  const access = useAccess();
  const [activityOpen, setActivityOpen] = useState(false);
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
  const copyWallet = async () => {
    if (!user.solanaAddress) return;
    try {
      await navigator.clipboard.writeText(user.solanaAddress);
      notify("Wallet address copied");
    } catch {
      notify(user.solanaAddress);
    }
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

      {acc && (
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
        <button className="btn ghost" onClick={() => setActivityOpen(true)}>Activity & history</button>
        {access.can("admin.users") && <button className="btn ghost" onClick={access.openAdmin}>Manage users</button>}
      </div>

      <div className="profile-section-title">Account details</div>
      <dl className="profile-fields">
        <div><dt>Username</dt><dd>@{user.username} <span className="lock" title="Can't be changed">🔒</span></dd></div>
        <div><dt>Name</dt><dd>{user.firstName} {user.lastName} <span className="lock" title="Can't be changed">🔒</span></dd></div>
        <div><dt>Email</dt><dd>{user.email}</dd></div>
        <div><dt>Wallet (Solana)</dt><dd>{user.solanaAddress ? <button className="link-btn mono" onClick={() => void copyWallet()} title="Copy the full address">{user.solanaAddress.slice(0, 6)}…{user.solanaAddress.slice(-4)} ⧉</button> : "Not created yet"}</dd></div>
        <div><dt>Started with</dt><dd>{acc ? fmtUsd(acc.startCash) : "–"}</dd></div>
      </dl>
      <p className="muted tiny">Your paper account is yours alone: other logins have their own balance, trades and bot.</p>
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
          <p>Real mode uses the money in <b>your own wallet</b>{user.solanaAddress ? <> (<span className="mono">{user.solanaAddress.slice(0, 4)}…{user.solanaAddress.slice(-4)}</span>)</> : null}, not practice money.</p>
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
const PLAN_NAMES: Record<string, string> = { free: "Free", member: "Member", starter: "AI Starter", pro: "AI Pro", max: "AI Max" };
const planName = (id?: string) => PLAN_NAMES[id ?? "free"] ?? "Free";
// The signed-in user's plan, role and permissions, shared across the page.
export type Access = { me: User | null; can: (p: Permission) => boolean; openPlans: () => void; openAdmin: () => void; reloadMe?: () => void };
export const AccessCtx = createContext<Access>({ me: null, can: () => true, openPlans: () => {}, openAdmin: () => {} });
export const useAccess = () => useContext(AccessCtx);

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
// About how many AI analyses a token allowance covers (~14K API tokens = ~140K app tokens each).
const analysesFor = (tokens: number) => Math.round(tokens / 140_000);

// A small lock shown in place of a feature the plan doesn't include.
export function LockChip({ label, plan = "AI Starter" }: { label: string; plan?: string }) {
  const { openPlans } = useAccess();
  return (
    <button className="lock-chip" onClick={openPlans} title={`${label} is included from ${plan}. See plans.`}>
      🔒 {label} · <span>{plan}+</span>
    </button>
  );
}

// AI token usage bar (profile): just the share of this month's tokens used.
// Unlimited accounts (admins) are measured against the top plan's allowance.
const MAX_PLAN_TOKENS = 15_000_000;
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

const FEATURES: { perm: Permission; label: string }[] = [
  { perm: "trade.manual", label: "Paper trading, charts, scanner" },
  { perm: "trade.limit", label: "Limit orders and Protect this trade" },
  { perm: "ai.analyze", label: "AI plans (Analyze, Ask AI)" },
  { perm: "bot.run", label: "AI bot on a coin" },
  { perm: "bot.autopick", label: "Auto-pick (bot chooses coins)" },
  { perm: "bot.risky", label: "Risky mode" },
];

export function PlansModal({ onClose }: { onClose: () => void }) {
  const { me } = useAccess();
  const [plans, setPlans] = useState<PlanInfo[] | null>(null);
  const [extras, setExtras] = useState<PlanExtras | null>(null);
  const [yearly, setYearly] = useState(false);
  useEffect(() => {
    void api.plans().then(setPlans).catch(() => setPlans([]));
    void api.planExtras().then(setExtras).catch(() => {});
  }, []);
  const paid = extras?.yearlyMonthsPaid ?? 10;
  return (
    <Modal title="Plans" onClose={onClose} wide>
      <div className="plans-top">
        <p className="muted small plans-lead">Paper trading is free. Membership removes transaction charges on most trades; AI plans add AI analyses and the AI bot, with a monthly AI token allowance.</p>
        <div className="billing-toggle" role="radiogroup" aria-label="Billing period">
          <button role="radio" aria-checked={!yearly} className={!yearly ? "on" : ""} onClick={() => setYearly(false)}>Monthly</button>
          <button role="radio" aria-checked={yearly} className={yearly ? "on" : ""} onClick={() => setYearly(true)}>Yearly <span className="save">2 months free</span></button>
        </div>
      </div>
      <div className="plan-grid">
        {(plans ?? []).map((p) => {
          const current = (me?.plan ?? "free") === p.id;
          return (
            <div key={p.id} className={`plan-card ${current ? "current" : ""} ${p.id}`}>
              <div className="plan-name">{p.name}{current && <span className="plan-current">Your plan</span>}</div>
              <div className="plan-price">
                {!p.priceUsd ? "Free" : yearly ? <>${p.priceUsd * paid}<small>/year</small></> : <>${p.priceUsd}<small>/month</small></>}
              </div>
              {yearly && p.priceUsd > 0 && <div className="plan-yearly">≈ ${(p.priceUsd * paid / 12).toFixed(2)}/month · save ${p.priceUsd * (12 - paid)}</div>}
              <p className="small">{p.blurb}</p>
              <ul className="plan-features">
                <li>{p.feePct === 0 ? "No transaction charges" : p.freeTrades > 0 ? `${p.freeTrades} trades/month free, then ${p.feePct}%` : `${p.feePct}% charge per trade`}</li>
                <li>{p.aiTokens ? `${fmtTokens(p.aiTokens)} AI tokens/month (≈ ${analysesFor(p.aiTokens)} analyses)` : "No AI"}</li>
                {FEATURES.map((f) => (
                  <li key={f.perm} className={p.permissions.includes(f.perm) ? "yes" : "no"}>{p.permissions.includes(f.perm) ? "✓" : "–"} {f.label}</li>
                ))}
              </ul>
              <button className={`btn ${current ? "ghost" : "buy"} wide`} disabled>{current ? "Current plan" : "Upgrade (billing coming soon)"}</button>
            </div>
          );
        })}
      </div>
      {extras && (
        <div className="packs">
          <div className="profile-section-title">Need more AI? Token packs</div>
          <p className="muted small">For AI plans: used after your monthly allowance runs out, and they never expire.</p>
          <div className="pack-row">
            {extras.tokenPacks.map((k) => (
              <div key={k.id} className="pack-card">
                <b>{fmtTokens(k.tokens)} tokens</b>
                <span className="muted small">≈ {analysesFor(k.tokens)} analyses</span>
                <span className="pack-price">${k.priceUsd}</span>
                <button className="btn ghost" disabled>Buy (billing coming soon)</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="muted tiny">Online billing isn't connected yet: an admin can change your plan or add tokens meanwhile. Prices are in USD.</p>
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
