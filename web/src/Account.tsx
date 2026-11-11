// Header controls: Settings (wrench) and the account (sign in / profile).
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, type User } from "./api";

// ---------- Shared modal ----------

function Modal({ title, onClose, children, foot, narrow }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; narrow?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${narrow ? "narrow" : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="chip" onClick={onClose} aria-label="Close">✕</button>
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

export function AccountButton({ notify, onChange }: { notify: (m: string, bad?: boolean) => void; onChange: () => void }) {
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
      {open === "auth" && <AuthModal onClose={() => setOpen(null)} onDone={(u) => { setUser(u); setOpen(null); onChange(); notify(u.owner ? `Welcome, ${u.firstName}! Your paper account is loaded.` : `Welcome, ${u.firstName}!`); }} />}
      {open === "profile" && user && (
        <ProfileModal
          user={user}
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

function ProfileModal({ user, onClose, onSignedOut, notify }: { user: User; onClose: () => void; onSignedOut: () => void; notify: (m: string, bad?: boolean) => void }) {
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
      <div className="profile-top">
        <Avatar user={user} size={76} />
        <div>
          <div className="profile-name">{user.firstName} {user.lastName}</div>
          <div className="muted small">@{user.username}</div>
        </div>
      </div>
      <dl className="profile-fields">
        <div><dt>Username</dt><dd>{user.username} <span className="lock" title="Can't be changed">🔒</span></dd></div>
        <div><dt>Name</dt><dd>{user.firstName} {user.lastName} <span className="lock" title="Can't be changed">🔒</span></dd></div>
        <div><dt>Email</dt><dd>{user.email}</dd></div>
        <div><dt>Member since</dt><dd>{new Date(user.createdAt).toLocaleDateString()}</dd></div>
        <div><dt>Paper account</dt><dd>{user.owner ? "Yours" : "Not linked to this login"}</dd></div>
      </dl>
      {!resetting ? (
        <button className="btn ghost" onClick={() => setResetting(true)}>Reset password</button>
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
