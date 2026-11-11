// Accounts: sign up with a unique username, first and last name, email and password;
// sign in with username or email. Passwords are hashed with scrypt (never stored).
// Sessions are signed cookies (HMAC-SHA256) that last 30 days; changing the password
// signs out every other session. The signing key is made once and kept in the store,
// so no extra setting is needed.
import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import { createStore } from "./store.js";
import { audit } from "./audit.js";
import { resolvePrivyLogin } from "./privy.js";
import { month, permissionsFor, PLANS, planOf, tokenLimit, type PlanId, type Role } from "./plans.js";

const store = createStore();
const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

type User = {
  username: string; // as typed at sign-up (unique, case-insensitive)
  firstName: string;
  lastName: string;
  email: string;
  salt: string; // hex
  hash: string; // hex scrypt(password, salt)
  passVer: number; // bumped on password change: old sessions stop working
  createdAt: number;
  avatarUrl?: string | null; // profile picture (coming later)
  plan?: PlanId; // what they pay for (default free)
  privyId?: string; // Privy user (DID) when they sign in with Privy
  solanaAddress?: string; // their Privy embedded Solana wallet
  role?: Role; // user | admin
};
export type PublicUser = { username: string; firstName: string; lastName: string; email: string; createdAt: number; avatarUrl: string | null; plan: PlanId; role: Role; solanaAddress: string | null; hasPassword: boolean };

const COOKIE = "nexus_session";
const SESSION_DAYS = 30;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const userKey = (u: string) => `user:${u.toLowerCase()}`;
const emailKey = (e: string) => `email:${e.toLowerCase()}`;
const pub = (u: User): PublicUser => ({ username: u.username, firstName: u.firstName, lastName: u.lastName, email: u.email, createdAt: u.createdAt, avatarUrl: u.avatarUrl ?? null, plan: planOf(u.plan).id, role: u.role ?? "user", solanaAddress: u.solanaAddress ?? null, hasPassword: !!u.hash });

let secret: Buffer | null = null;
async function key() {
  if (secret) return secret;
  await store.kvSet("auth:secret", crypto.randomBytes(32).toString("hex"), { nx: true }); // first run only
  secret = Buffer.from((await store.kvGet<string>("auth:secret"))!, "hex");
  return secret;
}

async function hashPassword(pw: string, salt: Buffer) {
  return (await scrypt(pw, salt, 64)).toString("hex");
}

function checkPassword(pw: unknown) {
  if (typeof pw !== "string" || pw.length < 8) throw new Error("Password must be at least 8 characters");
  if (pw.length > 200) throw new Error("Password is too long");
  return pw;
}

// The visitor's IP (first hop behind Vercel's proxy), kept with sign-ins in the audit log.
const clientIp = (req: Request) => String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim() || undefined;

// ---------- Session cookie ----------

const b64 = (s: string) => Buffer.from(s).toString("base64url");
async function sign(payload: string) {
  return crypto.createHmac("sha256", await key()).update(payload).digest("base64url");
}

async function setSession(res: Response, u: User) {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = b64(JSON.stringify({ u: u.username.toLowerCase(), v: u.passVer, exp }));
  const token = `${payload}.${await sign(payload)}`;
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${process.env.VERCEL ? "; Secure" : ""}`);
}

function clearSession(res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.VERCEL ? "; Secure" : ""}`);
}

function readCookie(req: Request) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return "";
}

async function sessionUser(req: Request): Promise<User | null> {
  const token = readCookie(req);
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = Buffer.from(await sign(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const { u, v, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof exp !== "number" || exp < Date.now()) return null;
    const user = await store.kvGet<User>(userKey(String(u)));
    return user && user.passVer === v ? user : null;
  } catch {
    return null;
  }
}

// ---------- Paper account owner ----------
// The paper account and bot belong to one login. OWNER_USERNAME (Vercel setting) picks it;
// without it, the first account to sign in after this was added claims it, once.
async function ownerName(claimFor?: User | null) {
  const fromEnv = process.env.OWNER_USERNAME?.trim().toLowerCase();
  if (fromEnv) return fromEnv;
  if (claimFor) await store.kvSet("owner", claimFor.username.toLowerCase(), { nx: true });
  return (await store.kvGet<string>("owner")) ?? null;
}

// Everyone who has an account (for the admin page).
const USERS_INDEX = "users-index";
const indexed = new Set<string>();
async function addToIndex(name: string) {
  const k = name.toLowerCase();
  if (indexed.has(k)) return;
  const list = (await store.kvGet<string[]>(USERS_INDEX)) ?? [];
  if (!list.includes(k)) await store.kvSet(USERS_INDEX, [...list, k]);
  indexed.add(k);
}

// The owner of the platform's original account is its admin (on the top plan).
async function ensureOwnerRole(u: User): Promise<User> {
  const owner = await ownerName(u); // claims the old shared account once, if nobody has
  if (owner !== u.username.toLowerCase() || (u.role === "admin" && u.plan === "max")) return u;
  const updated: User = { ...u, role: "admin", plan: "max" };
  await store.kvSet(userKey(u.username), updated);
  return updated;
}

export type Auth = { key: string; plan: PlanId; role: Role; user: User };
// Who is making this request (null when signed out), with their plan and role.
export async function requestAuth(req: Request): Promise<Auth | null> {
  let u = await sessionUser(req);
  if (!u) return null;
  u = await ensureOwnerRole(u);
  await addToIndex(u.username);
  return { key: u.username.toLowerCase(), plan: planOf(u.plan).id, role: u.role ?? "user", user: u };
}
// The signed-in user's account key (lowercase username), or null when signed out.
export async function accountKey(req: Request): Promise<string | null> {
  return (await requestAuth(req))?.key ?? null;
}

// This month's AI token use for an account (app tokens).
const usageKey = (key: string, m = month()) => `usage:${key}:${m}`;
export async function tokenUsage(key: string, plan: PlanId, role: Role) {
  const used = (await store.kvGet<number>(usageKey(key))) ?? 0;
  const limit = tokenLimit(plan, role);
  const topup = (await store.kvGet<number>(`topup:${key}`)) ?? 0;
  return { month: month(), used, limit: Number.isFinite(limit) ? limit : -1, topup };
}

// Admin: list users and change a user's plan / role.
export async function listUsers() {
  const names = (await store.kvGet<string[]>(USERS_INDEX)) ?? [];
  const users = await Promise.all(names.map((n) => store.kvGet<User>(userKey(n))));
  return Promise.all(
    users.filter((u): u is User => !!u).map(async (u) => ({ ...pub(u), usage: await tokenUsage(u.username.toLowerCase(), planOf(u.plan).id, u.role ?? "user") })),
  );
}
// Admin: add top-up AI tokens to a user (they don't expire; used after the monthly allowance).
export async function addTopup(username: string, tokens: number, by?: string) {
  const k = String(username).toLowerCase();
  if (!(await store.kvGet<User>(userKey(k)))) throw new Error("User not found");
  if (!(tokens > 0) || tokens > 1_000_000_000) throw new Error("Enter a token amount");
  const tk = `topup:${k}`;
  const next = ((await store.kvGet<number>(tk)) ?? 0) + Math.round(tokens);
  await store.kvSet(tk, next);
  await audit(k, "admin.topup", `Admin added ${Math.round(tokens).toLocaleString()} AI tokens (balance ${next.toLocaleString()})`, { tokens: Math.round(tokens), balance: next }, by);
  return { username: k, topup: next };
}

export async function setUserAccess(username: string, plan?: string, role?: string, by?: string) {
  const u = await store.kvGet<User>(userKey(String(username)));
  if (!u) throw new Error("User not found");
  if (plan !== undefined && !(plan in PLANS)) throw new Error("Unknown plan");
  if (role !== undefined && role !== "user" && role !== "admin") throw new Error("Unknown role");
  const updated: User = { ...u, plan: (plan as PlanId) ?? u.plan, role: (role as Role) ?? u.role };
  await store.kvSet(userKey(u.username), updated);
  await audit(u.username, "admin.plan", `Admin changed plan ${planOf(u.plan).name} → ${planOf(updated.plan).name}, role ${u.role ?? "user"} → ${updated.role ?? "user"}`, { from: { plan: u.plan ?? "free", role: u.role ?? "user" }, to: { plan: updated.plan ?? "free", role: updated.role ?? "user" } }, by);
  return pub(updated);
}

// ---------- Routes ----------

export async function me(req: Request) {
  const a = await requestAuth(req);
  if (!a) return { user: null };
  return { user: { ...pub(a.user), owner: true, permissions: permissionsFor(a.plan, a.role), usage: await tokenUsage(a.key, a.plan, a.role) } };
}

export async function signUp(req: Request, res: Response) {
  const username = String(req.body?.username ?? "").trim();
  const firstName = String(req.body?.firstName ?? "").trim();
  const lastName = String(req.body?.lastName ?? "").trim();
  const email = String(req.body?.email ?? "").trim();
  if (!USERNAME_RE.test(username)) throw new Error("Username: 3-20 letters, numbers or _");
  if (!firstName || !lastName || firstName.length > 40 || lastName.length > 40) throw new Error("Enter your first and last name");
  if (!EMAIL_RE.test(email) || email.length > 120) throw new Error("Enter a valid email");
  const password = checkPassword(req.body?.password);
  const salt = crypto.randomBytes(16);
  const user: User = { username, firstName, lastName, email, salt: salt.toString("hex"), hash: await hashPassword(password, salt), passVer: 1, createdAt: Date.now(), avatarUrl: null };
  // Claim the username, then the email; undo the username if the email is taken.
  if (!(await store.kvSet(userKey(username), user, { nx: true }))) throw new Error("That username is taken");
  if (!(await store.kvSet(emailKey(email), username.toLowerCase(), { nx: true }))) {
    await store.kvDel(userKey(username));
    throw new Error("An account with that email already exists");
  }
  await addToIndex(username);
  await audit(username, "account.signup", "Account created", { email });
  await setSession(res, user);
  return { user: { ...pub(user), owner: true } };
}

export async function signIn(req: Request, res: Response) {
  const login = String(req.body?.login ?? "").trim();
  const password = String(req.body?.password ?? "");
  const failKey = `fail:${login.toLowerCase()}`;
  const fails = (await store.kvGet<number>(failKey)) ?? 0;
  if (fails >= 10) throw new Error("Too many tries. Wait 15 minutes and try again.");
  const name = login.includes("@") ? await store.kvGet<string>(emailKey(login)) : login;
  const user = name ? await store.kvGet<User>(userKey(name)) : null;
  // Hash even when the user doesn't exist, so timing doesn't reveal which usernames exist.
  const hash = await hashPassword(password, user ? Buffer.from(user.salt, "hex") : crypto.randomBytes(16));
  if (!user || !user.hash || !crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"))) {
    await store.kvSet(failKey, fails + 1, { ttlMs: 15 * 60_000 });
    throw new Error("Wrong username/email or password");
  }
  await store.kvDel(failKey);
  await setSession(res, user);
  await audit(user.username, "account.signin", "Signed in", { ip: clientIp(req) });
  await ownerName(user);
  return { user: { ...pub(user), owner: true } };
}

// ---------- Sign in with Privy (email code or Google); our copy of every user stays here ----------
const privyKey = (did: string) => `privy:${did}`;

// Step 1: verify the Privy login and sign in the matching user (by Privy ID, or by email for
// accounts made before Privy). A brand-new person gets { needsProfile } to pick a username.
export async function privyLogin(req: Request, res: Response) {
  const p = await resolvePrivyLogin(String(req.body?.accessToken ?? ""));
  let name = await store.kvGet<string>(privyKey(p.did));
  if (!name && p.email) {
    name = await store.kvGet<string>(emailKey(p.email)); // an existing account with this email: link it
    if (name) await store.kvSet(privyKey(p.did), name.toLowerCase());
  }
  const user = name ? await store.kvGet<User>(userKey(name)) : null;
  if (!user) {
    const [first, ...rest] = (p.name ?? "").trim().split(/\s+/);
    return { needsProfile: true, email: p.email ?? null, firstName: first || "", lastName: rest.join(" ") };
  }
  const updated: User = { ...user, privyId: p.did, solanaAddress: p.solanaAddress ?? user.solanaAddress };
  if (updated.privyId !== user.privyId || updated.solanaAddress !== user.solanaAddress) await store.kvSet(userKey(user.username), updated);
  await addToIndex(user.username);
  await setSession(res, updated);
  await audit(user.username, "account.signin", "Signed in with Privy", { ip: clientIp(req), method: p.method, wallet: updated.solanaAddress ?? null });
  return { user: { ...pub(updated), owner: true } };
}

// Step 2 (first time only): create our own user record for a new Privy login.
export async function privyCompleteProfile(req: Request, res: Response) {
  const p = await resolvePrivyLogin(String(req.body?.accessToken ?? ""));
  if (await store.kvGet<string>(privyKey(p.did))) return privyLogin(req, res); // already set up
  if (!p.email) throw new Error("Your Privy login has no email address; sign in with email or Google");
  const username = String(req.body?.username ?? "").trim();
  const firstName = String(req.body?.firstName ?? "").trim();
  const lastName = String(req.body?.lastName ?? "").trim();
  if (!USERNAME_RE.test(username)) throw new Error("Username: 3-20 letters, numbers or _");
  if (!firstName || !lastName || firstName.length > 40 || lastName.length > 40) throw new Error("Enter your first and last name");
  const user: User = {
    username, firstName, lastName, email: p.email, salt: "", hash: "", passVer: 1, createdAt: Date.now(), avatarUrl: null,
    privyId: p.did, solanaAddress: p.solanaAddress,
  };
  if (!(await store.kvSet(userKey(username), user, { nx: true }))) throw new Error("That username is taken");
  if (!(await store.kvSet(emailKey(p.email), username.toLowerCase(), { nx: true }))) {
    await store.kvDel(userKey(username));
    throw new Error("An account with that email already exists. Sign in again to link it.");
  }
  await store.kvSet(privyKey(p.did), username.toLowerCase());
  await addToIndex(username);
  await audit(username, "account.signup", "Account created (Privy)", { email: p.email, method: p.method, wallet: p.solanaAddress ?? null });
  await setSession(res, user);
  await audit(username, "account.signin", "Signed in with Privy", { ip: clientIp(req), method: p.method });
  return { user: { ...pub(user), owner: true } };
}

export async function signOut(req: Request, res: Response) {
  const u = await sessionUser(req);
  if (u) await audit(u.username, "account.signout", "Signed out");
  clearSession(res);
  return { ok: true };
}

// Reset password while signed in: needs the current one. Other sessions are signed out.
export async function changePassword(req: Request, res: Response) {
  const user = await sessionUser(req);
  if (!user) {
    res.status(401);
    throw new Error("Sign in first");
  }
  const current = String(req.body?.current ?? "");
  const hash = await hashPassword(current, Buffer.from(user.salt, "hex"));
  if (!crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"))) throw new Error("Current password is wrong");
  const next = checkPassword(req.body?.next);
  if (next === current) throw new Error("Choose a new password, different from the current one");
  const salt = crypto.randomBytes(16);
  const updated: User = { ...user, salt: salt.toString("hex"), hash: await hashPassword(next, salt), passVer: user.passVer + 1 };
  await audit(user.username, "account.password", "Password changed (other devices signed out)");
  await store.kvSet(userKey(user.username), updated);
  await setSession(res, updated); // keep this browser signed in
  return { ok: true };
}
