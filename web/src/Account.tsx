// Header controls: Settings (wrench) and the account (sign in / profile).
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, fmtUsd, type AdminUser, type AppState, type Permission, type PlanExtras, type PlanId, type PlanInfo, type User } from "./api";

// ---------- Shared modal ----------

function Modal({ title, onClose, children, foot, narrow, wide }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; narrow?: boolean; wide?: boolean }) {
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

export function AccountButton({ notify, onChange, state }: { notify: (m: string, bad?: boolean) => void; onChange: () => void; state: AppState | null }) {
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

function ProfileModal({ user, state, onClose, onSignedOut, notify }: { user: User; state: AppState | null; onClose: () => void; onSignedOut: () => void; notify: (m: string, bad?: boolean) => void }) {
  const access = useAccess();
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

      {acc && (
        <div className="profile-stats">
          <div><small>Equity</small><b>{fmtUsd(eq)}</b></div>
          <div><small>Since start</small><b className={pnl >= 0 ? "up" : "down"}>{pnl >= 0 ? "+" : ""}{fmtUsd(pnl)}<em>{pnl >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</em></b></div>
          <div><small>Closed trades</small><b>{sells.length}<em>{sells.length ? `${Math.round((wins / sells.length) * 100)}% won` : "none yet"}</em></b></div>
          <div><small>Bot</small><b className={acc.bot.running ? "up" : ""}>{acc.bot.running ? "Running" : "Off"}<em>{acc.positions.length} open · {acc.orders?.length ?? 0} orders</em></b></div>
        </div>
      )}

      <TokenMeter usage={access.me?.usage} />
      <div className="profile-actions">
        <button className="btn ghost" onClick={access.openPlans}>See plans</button>
        {access.can("admin.users") && <button className="btn ghost" onClick={access.openAdmin}>Manage users</button>}
      </div>

      <div className="profile-section-title">Account details</div>
      <dl className="profile-fields">
        <div><dt>Username</dt><dd>@{user.username} <span className="lock" title="Can't be changed">🔒</span></dd></div>
        <div><dt>Name</dt><dd>{user.firstName} {user.lastName} <span className="lock" title="Can't be changed">🔒</span></dd></div>
        <div><dt>Email</dt><dd>{user.email}</dd></div>
        <div><dt>Started with</dt><dd>{acc ? fmtUsd(acc.startCash) : "–"}</dd></div>
      </dl>
      <p className="muted tiny">Your paper account is yours alone: other logins have their own balance, trades and bot.</p>
      {!resetting ? (
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
    </Modal>
  );
}


// ---------- Plans & access (RBAC) ----------
const PLAN_NAMES: Record<string, string> = { free: "Free", member: "Member", starter: "AI Starter", pro: "AI Pro", max: "AI Max" };
const planName = (id?: string) => PLAN_NAMES[id ?? "free"] ?? "Free";
// The signed-in user's plan, role and permissions, shared across the page.
export type Access = { me: User | null; can: (p: Permission) => boolean; openPlans: () => void; openAdmin: () => void };
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

export function TokenMeter({ usage }: { usage?: User["usage"] }) {
  if (!usage) return null;
  if (usage.limit < 0) return <div className="token-meter"><div className="tm-head"><span>AI tokens this month</span><b>Unlimited</b></div></div>;
  if (usage.limit === 0) return <div className="token-meter"><div className="tm-head"><span>AI tokens</span><b>Not in your plan</b></div></div>;
  const pct = Math.min(100, (usage.used / usage.limit) * 100);
  const topup = usage.topup ?? 0;
  return (
    <div className="token-meter">
      <div className="tm-head"><span>AI tokens this month</span><b>{fmtTokens(usage.used)} / {fmtTokens(usage.limit)}</b></div>
      <div className="tm-bar"><div className={pct > 90 ? "hot" : ""} style={{ width: `${pct}%` }} /></div>
      {topup > 0 && <div className="tm-head"><span>+ Top-up tokens (don't expire)</span><b>{fmtTokens(topup)}</b></div>}
      <small className="muted">≈ {analysesFor(Math.max(0, usage.limit - usage.used) + topup)} AI analyses left · 10 tokens per AI token used</small>
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
            <thead><tr><th>User</th><th>Email</th><th>Plan</th><th>Role</th><th className="num">AI tokens this month</th><th>Top-up</th></tr></thead>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
