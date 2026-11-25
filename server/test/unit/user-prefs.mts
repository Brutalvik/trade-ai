// What a user chooses to see is saved on their account (auth.setPrefs, POST /api/auth/prefs):
// a part of the app they hide in Settings stays hidden on every sign-in, on any device, until they
// show it again. Driven through the server's own routes, with real sign-ups and sessions.
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|_UPSTASH|CRON_SECRET|ANTHROPIC|OPENAI|PRIVY/.test(k)) delete process.env[k];
process.env.VERCEL = "1"; // as deployed: no local timer, and the app does not open its own port
const { fakeSupabase } = await import(new URL("../pg-fake.mts", import.meta.url).href);
await fakeSupabase();

const app = (await import(new URL("../../src/index.ts", import.meta.url).href)).default;
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
// A browser: it keeps the session cookie the server gives it.
const browser = () => {
  let cookie = "";
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).filter((c) => !/=$/.test(c)).join("; ");
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
};
const person = (username: string) => ({ username, email: `${username}@example.test`, password: "correct horse battery", firstName: "Pat", lastName: "Test" });

const laptop = browser();
expect("a new account is made", (await laptop("POST", "/api/auth/signup", person("pat"))).status, 200);
expect("a new account sees everything: nothing is hidden", (await laptop("GET", "/api/auth/me")).body.user.prefs, { hide: [] });

const hid = await laptop("POST", "/api/auth/prefs", { hide: ["aiSignal"] });
expect("hiding the AI Signal card is saved, and the answer says so", [hid.status, hid.body.user.prefs], [200, { hide: ["aiSignal"] }]);
expect("the account now says the card is hidden", (await laptop("GET", "/api/auth/me")).body.user.prefs, { hide: ["aiSignal"] });

// Signed out and in again, and on another device: still hidden.
await laptop("POST", "/api/auth/signout", {});
expect("signed out, nothing is known about the choice", (await laptop("GET", "/api/auth/me")).body.user, null);
expect("signing in again", (await laptop("POST", "/api/auth/signin", { login: "pat", password: "correct horse battery" })).status, 200);
expect("after signing in again the card is still hidden", (await laptop("GET", "/api/auth/me")).body.user.prefs, { hide: ["aiSignal"] });
const phone = browser();
await phone("POST", "/api/auth/signin", { login: "pat@example.test", password: "correct horse battery" });
expect("and on another device too", (await phone("GET", "/api/auth/me")).body.user.prefs, { hide: ["aiSignal"] });

// Another person has their own choice.
const other = browser();
await other("POST", "/api/auth/signup", person("sam"));
expect("someone else's account is not touched", (await other("GET", "/api/auth/me")).body.user.prefs, { hide: [] });

// Only parts the app knows can be hidden; anything else is ignored.
const odd = await phone("POST", "/api/auth/prefs", { hide: ["aiSignal", "aiSignal", "everything", 7, "<script>"] });
expect("names the app does not know are ignored, and a name sent twice counts once", [odd.status, odd.body.user.prefs], [200, { hide: ["aiSignal"] }]);
expect("a request that is not a list is refused", [(await phone("POST", "/api/auth/prefs", { hide: "aiSignal" })).status, (await phone("POST", "/api/auth/prefs", {})).status], [400, 400]);
expect("nobody signed in: refused", (await browser()("POST", "/api/auth/prefs", { hide: ["aiSignal"] })).status, 401);

// Shown again.
const shown = await phone("POST", "/api/auth/prefs", { hide: [] });
expect("showing the card again is saved the same way", [shown.body.user.prefs, (await laptop("GET", "/api/auth/me")).body.user.prefs], [{ hide: [] }, { hide: [] }]);

// The rest of the account is untouched by it.
const me = (await laptop("GET", "/api/auth/me")).body.user;
check("the choice changes nothing else on the account", me.username === "pat" && me.email === "pat@example.test" && me.tradeMode === "paper" && Array.isArray(me.permissions), { username: me.username, tradeMode: me.tradeMode });
server.close();
finish();
