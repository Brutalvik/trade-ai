// Accounts: sign up with a unique username, first and last name, email and password;
// sign in with username or email. Passwords are hashed with scrypt (never stored).
// Sessions are signed cookies (HMAC-SHA256) that last 30 days; changing the password
// signs out every other session. The signing key is made once and kept in the store,
// so no extra setting is needed.
import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import { createStore } from "./store.js";

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
};
export type PublicUser = { username: string; firstName: string; lastName: string; email: string; createdAt: number; avatarUrl: string | null };

const COOKIE = "nexus_session";
const SESSION_DAYS = 30;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const userKey = (u: string) => `user:${u.toLowerCase()}`;
const emailKey = (e: string) => `email:${e.toLowerCase()}`;
const pub = (u: User): PublicUser => ({ username: u.username, firstName: u.firstName, lastName: u.lastName, email: u.email, createdAt: u.createdAt, avatarUrl: u.avatarUrl ?? null });

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

// True if this request comes from the signed-in owner of the paper account.
export async function isOwner(req: Request) {
  const u = await sessionUser(req);
  return !!u && (await ownerName(u)) === u.username.toLowerCase();
}

// ---------- Routes ----------

export async function me(req: Request) {
  const u = await sessionUser(req);
  const owner = u ? (await ownerName(u)) === u.username.toLowerCase() : false;
  return { user: u ? { ...pub(u), owner } : null };
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
  await setSession(res, user);
  return { user: { ...pub(user), owner: (await ownerName(user)) === user.username.toLowerCase() } };
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
  if (!user || !crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"))) {
    await store.kvSet(failKey, fails + 1, { ttlMs: 15 * 60_000 });
    throw new Error("Wrong username/email or password");
  }
  await store.kvDel(failKey);
  await setSession(res, user);
  return { user: { ...pub(user), owner: (await ownerName(user)) === user.username.toLowerCase() } };
}

export async function signOut(_req: Request, res: Response) {
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
  await store.kvSet(userKey(user.username), updated);
  await setSession(res, updated); // keep this browser signed in
  return { ok: true };
}
