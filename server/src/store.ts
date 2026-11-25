// Where the paper account and bot state live.
//  - Supabase (Postgres) when its settings are present. Needed on Vercel: functions are
//    short-lived copies that don't share memory or disk.
//  - Upstash Redis when only its settings are present (the store used until November 2026; with
//    Supabase set up it is only the place the data is copied from once, see copyFromUpstash).
//  - A local JSON file otherwise (fine for `npm run dev` on one machine).
import { Redis } from "@upstash/redis";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export type StoreKind = "supabase" | "redis" | "file" | "temp";
// Calls and bytes since this server copy started (to see what the storage traffic really is).
// auth: which kind of key the database accepted and how it was sent (never the key itself).
export type StoreStats = { since: number; calls: Record<string, number>; sentBytes: number; receivedBytes: number; auth?: { key: "secret" | "service_role"; header: "apikey" | "apikey+bearer" } };

export interface Store {
  kind: StoreKind;
  // key = account (username); none = the old single shared account.
  load<T>(key?: string): Promise<T | null>;
  // Returns the account's new version number when the store keeps one (see rev below).
  save<T>(value: T, key?: string): Promise<number | void>;
  // Returns true if we got the lock (it expires by itself after ttlMs).
  lock(name: string, ttlMs: number): Promise<boolean>;
  unlock(name: string): Promise<void>;
  // Small key-value records (user accounts). kvSet with nx only writes if the key is new
  // and returns whether it wrote; ttlMs makes the record expire by itself.
  kvGet<T>(key: string): Promise<T | null>;
  kvSet<T>(key: string, value: T, opts?: { nx?: boolean; ttlMs?: number }): Promise<boolean>;
  kvDel(key: string): Promise<void>;
  // Append-only lists (audit log, full trade history): entries are added, never edited.
  listPush<T>(key: string, value: T): Promise<void>;
  listLen(key: string): Promise<number>;
  listRange<T>(key: string, start: number, stop: number): Promise<T[]>; // inclusive, oldest = 0

  // Only a store that keeps a version number per account (Supabase). The number goes up with
  // every save, so a server copy can ask for it (a few bytes) and load the account itself only
  // when another copy has saved it. loadRev = the account together with its number.
  rev?(key: string): Promise<number | null>;
  loadRev?<T>(key?: string): Promise<{ value: T | null; rev: number | null }>;
  // A batch of entries put at the end of a list in one call (reset = empty the list first).
  listReplace?<T>(key: string, items: T[], reset: boolean): Promise<void>;
  // Is the store set up, and closed to the public? Throws a message a person can act on if not.
  check?(): Promise<{ accounts: number }>;
  // Saves a small account and a list entry and reads them back from the database itself (not
  // from what this copy remembers). Throws if what comes back is not what went in.
  selfTest?(): Promise<void>;
  stats?(): StoreStats;
}

const localLocks = new Map<string, number>();
const localLock = {
  async lock(name: string, ttlMs: number) {
    if ((localLocks.get(name) ?? 0) > Date.now()) return false;
    localLocks.set(name, Date.now() + ttlMs);
    return true;
  },
  async unlock(name: string) {
    localLocks.delete(name);
  },
};

const KEY = "trade-ai:state";

// Finds Upstash's REST settings under any prefix: Vercel's integration lets you
// pick one (KV_REST_API_URL, STORAGE_KV_REST_API_URL, ...); Upstash's own docs
// use UPSTASH_REDIS_REST_URL. The token must share the URL's prefix.
function redisFromEnv(): Redis | null {
  const env = process.env;
  const pairs: [string, string][] = [["KV_REST_API_URL", "KV_REST_API_TOKEN"], ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]];
  for (const name of Object.keys(env)) {
    if (name.endsWith("_REST_API_URL")) pairs.push([name, name.replace(/_URL$/, "_TOKEN")]);
    if (name.endsWith("_REDIS_REST_URL")) pairs.push([name, name.replace(/_URL$/, "_TOKEN")]);
  }
  for (const [u, t] of pairs) {
    const url = env[u], token = env[t];
    if (url && /^https?:\/\//.test(url) && token) return new Redis({ url, token });
  }
  return null;
}

// Names (never values) of database-looking settings, to diagnose a missing connection.
export function storageEnvNames() {
  return Object.keys(process.env)
    .filter((n) => /REDIS|^KV_|_KV_|UPSTASH|_REST_API_|SUPABASE|^POSTGRES_/i.test(n))
    .sort();
}

// Supabase's settings under any prefix Vercel's integration was given (SUPABASE_URL,
// STORAGE_SUPABASE_URL, ...). The key must be a SECRET one: the publishable / anon key cannot
// reach the tables, by design (see supabase/schema.sql). There are two kinds and a project can
// have both: the new SUPABASE_SECRET_KEY (sb_secret_...) and the older SUPABASE_SERVICE_ROLE_KEY
// (a JWT), which Supabase is retiring. The new one is used first; the other is kept as a fallback.
function supabaseFromEnv(): { url: string; keys: string[] } | null {
  const env = process.env;
  const names = Object.keys(env)
    .filter((n) => /(^|_)SUPABASE_URL$/.test(n))
    .sort((a, b) => Number(a.startsWith("NEXT_PUBLIC_")) - Number(b.startsWith("NEXT_PUBLIC_")) || a.length - b.length);
  for (const n of names) {
    const url = env[n]?.trim().replace(/\/+$/, "");
    if (!url || !/^https?:\/\//.test(url)) continue;
    const prefix = n.replace(/^NEXT_PUBLIC_/, "").replace(/SUPABASE_URL$/, "");
    const keys = [`${prefix}SUPABASE_SECRET_KEY`, `${prefix}SUPABASE_SERVICE_ROLE_KEY`, "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"].map((k) => env[k]?.trim() ?? "").filter(Boolean);
    if (keys.length) return { url, keys: [...new Set(keys)] };
  }
  return null;
}

function fileStore(): Store {
  // On Vercel only /tmp is writable, and it is wiped between instances ("temp").
  const dir = process.env.VERCEL ? "/tmp/trade-ai" : path.resolve("data");
  const file = path.join(dir, "state.json");
  const fileFor = (key?: string) => (key ? path.join(dir, `state-${key.replace(/[^a-z0-9_]/gi, "_")}.json`) : file);
  const kvFile = path.join(dir, "kv.json");
  const listFile = (key: string) => path.join(dir, `list-${key.replace(/[^a-z0-9_:-]/gi, "_").replace(/:/g, "__")}.jsonl`);
  const readList = (key: string): unknown[] => {
    try {
      return fs.readFileSync(listFile(key), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  type Rec = { v: unknown; exp?: number };
  const readKv = (): Record<string, Rec> => {
    try {
      return JSON.parse(fs.readFileSync(kvFile, "utf8"));
    } catch {
      return {};
    }
  };
  const writeKv = (m: Record<string, Rec>) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(kvFile, JSON.stringify(m, null, 2));
  };
  return {
    kind: process.env.VERCEL ? "temp" : "file",
    async load<T>(key?: string) {
      try {
        return JSON.parse(fs.readFileSync(fileFor(key), "utf8")) as T;
      } catch {
        return null;
      }
    },
    async save<T>(value: T, key?: string) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fileFor(key), JSON.stringify(value, null, 2));
    },
    async kvGet<T>(key: string) {
      const r = readKv()[key];
      return r && (!r.exp || r.exp > Date.now()) ? (r.v as T) : null;
    },
    async kvSet<T>(key: string, value: T, opts: { nx?: boolean; ttlMs?: number } = {}) {
      const m = readKv();
      const cur = m[key];
      if (opts.nx && cur && (!cur.exp || cur.exp > Date.now())) return false;
      m[key] = { v: value, exp: opts.ttlMs ? Date.now() + opts.ttlMs : undefined };
      writeKv(m);
      return true;
    },
    async kvDel(key: string) {
      const m = readKv();
      delete m[key];
      writeKv(m);
    },
    async listPush<T>(key: string, value: T) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(listFile(key), JSON.stringify(value) + "\n");
    },
    async listLen(key: string) {
      return readList(key).length;
    },
    async listRange<T>(key: string, start: number, stop: number) {
      return readList(key).slice(start, stop + 1) as T[];
    },
    ...localLock,
  };
}

// ---------- Supabase ----------
// The server talks to Supabase over its REST API, and only through the functions in
// supabase/schema.sql (POST /rest/v1/rpc/<function>): a plain HTTPS call, so nothing has to stay
// connected between a serverless function's runs.
//
// An account is kept in parts: "trades" and "equity" (large, and changed rarely or a little at a
// time) each on their own, everything else in "main". Each part is its JSON, gzipped. A part is
// identified by the hash of its JSON, so a part this server copy already holds is neither sent
// nor fetched again. Together with the version number (rev) this is what keeps the traffic
// small: before, the whole account was read on every 5-second check.
const ACCOUNT_PARTS = ["trades", "equity"];
const SCHEMA_VERSION = 1;
const READS = new Set(["trade_account_rev", "trade_account_load", "trade_kv_get", "trade_list_len", "trade_list_range", "trade_selfcheck"]);
const SHARED = "__shared__"; // the single account from before logins had their own
const pack = (json: string) => zlib.gzipSync(Buffer.from(json, "utf8"), { level: 6 }).toString("base64");
const unpack = (b64: string) => zlib.gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
const hashOf = (json: string) => crypto.createHash("sha1").update(json).digest("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One value as its parts (each one a JSON text), and back.
function splitParts(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { main: JSON.stringify(value ?? null) };
  const main: Record<string, unknown> = {}, out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (ACCOUNT_PARTS.includes(k) && v !== undefined) out[k] = JSON.stringify(v);
    else main[k] = v;
  }
  out.main = JSON.stringify(main);
  return out;
}
function joinParts(parts: Record<string, { json: string }>): unknown {
  const main = JSON.parse(parts.main.json);
  if (!main || typeof main !== "object" || Array.isArray(main)) return main;
  for (const [name, p] of Object.entries(parts)) if (name !== "main") main[name] = JSON.parse(p.json);
  return main;
}
// A list entry is stored as it is when it is a plain object (so it can be read with SQL);
// anything else is wrapped.
const wrapItem = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) && !("$v" in v) ? v : { $v: v ?? null });
const unwrapItem = (v: unknown) => (v && typeof v === "object" && "$v" in v && Object.keys(v).length === 1 ? (v as { $v: unknown }).$v : v);

// Postgres cannot keep two things JavaScript text may hold: a NUL character, and half of a
// two-part character (an emoji cut in two when a message was shortened). Both are cleaned on the
// way in, so one odd log line can never make a write fail.
type Text = string & { isWellFormed?: () => boolean; toWellFormed?: () => string };
const jsonSafe = (_k: string, v: unknown) => {
  if (typeof v !== "string") return v;
  const t = v as Text;
  const ok = t.isWellFormed ? t.isWellFormed() : true;
  return ok && !v.includes("\u0000") ? v : (t.toWellFormed ? t.toWellFormed() : v).replaceAll("\u0000", "");
};

const NOT_SET_UP = "The Supabase database is not set up yet: run server/supabase/schema.sql once in the Supabase SQL editor. (Already done? Then check that the Data API is switched on in the Supabase dashboard, under Integrations > Data API.)";
const BAD_KEY = "Supabase refused the server's key: the SUPABASE_SECRET_KEY setting (SUPABASE_SERVICE_ROLE_KEY on older projects) must be the project's secret key, and server/supabase/schema.sql must have been run.";
function explain(status: number, text: string, fn: string) {
  let j: { code?: string; message?: string } | null = null;
  try {
    j = JSON.parse(text);
  } catch {
    // not JSON: use the text itself
  }
  const msg = String(j?.message ?? text ?? "").slice(0, 240);
  if (status === 404 || j?.code === "PGRST202" || /could not find the function/i.test(msg)) return NOT_SET_UP;
  if (status === 401 || status === 403 || /permission denied/i.test(msg)) return BAD_KEY;
  return `Supabase (${fn}): ${msg || `HTTP ${status}`}`;
}

type Cached = { rev: number; parts: Record<string, { h: string; json: string }> };
export function supabaseStore(url: string, key: string | string[]): Store {
  const stats: StoreStats = { since: Date.now(), calls: {}, sentBytes: 0, receivedBytes: 0 };
  // How the key is sent. A new-style key (sb_secret_...) goes in the "apikey" header alone, as
  // Supabase's page on API keys says; an older JWT key (service_role) is also sent as a bearer
  // token. If the database refuses the first way with "401", the other way is tried once, and
  // then the other key if there is one; what worked is kept (Supabase's own examples show both
  // ways, and it is retiring the older keys), so a difference there cannot keep the bot down.
  const keys = (Array.isArray(key) ? key : [key]).filter(Boolean);
  const bearerFirst = (k: string) => !k.startsWith("sb_");
  let keyAt = 0;
  let bearer = bearerFirst(keys[0] ?? "");
  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(args, jsonSafe);
    stats.calls[fn] = (stats.calls[fn] ?? 0) + 1;
    let again = false, otherWay = false, otherKeys = keys.length - 1;
    // The key and the way this call uses (calls running side by side each decide for themselves).
    let at = keyAt, asBearer = bearer;
    for (;;) {
      let res: Response, text: string;
      try {
        stats.sentBytes += Buffer.byteLength(body);
        res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
          method: "POST",
          headers: { apikey: keys[at], ...(asBearer ? { Authorization: `Bearer ${keys[at]}` } : {}), "Content-Type": "application/json", "User-Agent": "trade-server (node)" },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        text = await res.text();
        stats.receivedBytes += Buffer.byteLength(text);
      } catch (e) {
        // No answer. A read is asked once more, and so is a whole-account save (saving the same
        // thing twice changes nothing); other writes are not repeated blindly.
        if (!again && (READS.has(fn) || fn === "trade_account_save")) {
          again = true;
          await sleep(250);
          continue;
        }
        throw new Error(`The database (Supabase) did not answer: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
      if (res.ok) {
        // What worked is what is used from now on.
        keyAt = at;
        bearer = asBearer;
        stats.auth = { key: keys[at].startsWith("sb_") ? "secret" : "service_role", header: asBearer ? "apikey+bearer" : "apikey" };
        return (text ? JSON.parse(text) : null) as T;
      }
      if (res.status === 401) {
        // Refused before anything ran: safe to send once more, the other way, then with the other key.
        if (!otherWay) {
          otherWay = true;
          asBearer = !asBearer;
          continue;
        }
        if (otherKeys > 0) {
          otherKeys--;
          at = (at + 1) % keys.length;
          asBearer = bearerFirst(keys[at]);
          otherWay = false;
          continue;
        }
      }
      if (res.status >= 500 && !again && READS.has(fn)) {
        again = true;
        await sleep(250);
        continue;
      }
      throw new Error(explain(res.status, text, fn));
    }
  }

  // What this server copy last loaded or saved of each account, so unchanged parts stay here.
  const cache = new Map<string, Cached>();
  const remember = (k: string, c: Cached) => {
    cache.delete(k);
    cache.set(k, c);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  };
  async function loadRev<T>(key?: string, fresh = false): Promise<{ value: T | null; rev: number | null }> {
    const k = key ?? SHARED;
    const have = fresh ? undefined : cache.get(k);
    const r = await rpc<{ rev: number; parts: Record<string, { h: string; b: string | null }> } | null>("trade_account_load", {
      p_key: k,
      p_have: Object.fromEntries(Object.entries(have?.parts ?? {}).map(([n, p]) => [n, p.h])),
    });
    if (!r) {
      cache.delete(k);
      return { value: null, rev: null };
    }
    const parts: Cached["parts"] = {};
    for (const [name, p] of Object.entries(r.parts ?? {})) {
      if (p.b !== null) parts[name] = { h: p.h, json: unpack(p.b) };
      else if (have?.parts[name]?.h === p.h) parts[name] = have.parts[name];
      else if (!fresh) return loadRev<T>(key, true); // should not happen: ask for everything
    }
    if (!parts.main) throw new Error(`Supabase: the saved account "${k}" is incomplete`);
    const rev = Number(r.rev);
    remember(k, { rev, parts });
    return { value: joinParts(parts) as T, rev };
  }
  const revFlights = new Map<string, Promise<number | null>>();

  return {
    kind: "supabase",
    load: async <T>(key?: string) => (await loadRev<T>(key)).value,
    loadRev,
    async save<T>(value: T, key?: string) {
      const k = key ?? SHARED;
      const have = cache.get(k);
      const parts: Cached["parts"] = {};
      for (const [name, json] of Object.entries(splitParts(value))) parts[name] = { h: hashOf(json), json };
      // A part the database already has (as far as this copy knows) goes without its body; if
      // another copy changed it meanwhile, the database says so and everything is sent.
      const send = (all: boolean) => Object.fromEntries(Object.entries(parts).map(([n, p]) => [n, { h: p.h, b: !all && have?.parts[n]?.h === p.h ? null : pack(p.json) }]));
      let rev: number;
      try {
        rev = Number(await rpc<number>("trade_account_save", { p_key: k, p_parts: send(false) }));
      } catch (e) {
        if (!/part body missing/.test(String((e as Error)?.message))) throw e;
        rev = Number(await rpc<number>("trade_account_save", { p_key: k, p_parts: send(true) }));
      }
      remember(k, { rev, parts });
      return rev;
    },
    rev(key: string) {
      // Several requests asking at the same moment share one call.
      let p = revFlights.get(key);
      if (!p) {
        p = rpc<number | null>("trade_account_rev", { p_key: key })
          .then((r) => (r === null || r === undefined ? null : Number(r)))
          .finally(() => revFlights.delete(key));
        revFlights.set(key, p);
      }
      return p;
    },
    async lock(name: string, ttlMs: number) {
      return Boolean(await rpc<boolean>("trade_kv_set", { p_key: `~lock:${name}`, p_value: { v: Date.now() }, p_nx: true, p_ttl_ms: Math.max(1, Math.round(ttlMs)) }));
    },
    async unlock(name: string) {
      await rpc("trade_kv_del", { p_key: `~lock:${name}` });
    },
    async kvGet<T>(key: string) {
      const r = await rpc<{ v?: T } | null>("trade_kv_get", { p_key: key });
      return r && typeof r === "object" && "v" in r ? (r.v as T) : null;
    },
    async kvSet<T>(key: string, value: T, opts: { nx?: boolean; ttlMs?: number } = {}) {
      return Boolean(await rpc<boolean>("trade_kv_set", { p_key: key, p_value: { v: value ?? null }, p_nx: Boolean(opts.nx), p_ttl_ms: opts.ttlMs ? Math.max(1, Math.round(opts.ttlMs)) : null }));
    },
    async kvDel(key: string) {
      await rpc("trade_kv_del", { p_key: key });
    },
    async listPush<T>(key: string, value: T) {
      await rpc("trade_list_push", { p_key: key, p_value: wrapItem(value) });
    },
    listLen: async (key: string) => Number(await rpc<number>("trade_list_len", { p_key: key })),
    async listRange<T>(key: string, start: number, stop: number) {
      return ((await rpc<unknown[]>("trade_list_range", { p_key: key, p_start: Math.max(0, start), p_stop: stop })) ?? []).map(unwrapItem) as T[];
    },
    async listReplace<T>(key: string, items: T[], reset: boolean) {
      await rpc("trade_list_replace", { p_key: key, p_items: items.map(wrapItem), p_reset: reset });
    },
    async check() {
      const c = await rpc<{ version: number; tables: number; rls: boolean; open: boolean; accounts: number } | null>("trade_selfcheck", {});
      if (!c || Number(c.tables) < 4 || Number(c.version) < SCHEMA_VERSION) throw new Error("The Supabase database is not fully set up: run the latest server/supabase/schema.sql in the Supabase SQL editor.");
      if (!c.rls || c.open) throw new Error("The Supabase tables are open to the public keys: run server/supabase/schema.sql again in the Supabase SQL editor (it closes them).");
      return { accounts: Number(c.accounts) };
    },
    async selfTest() {
      const key = "~selftest", nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const doc = { note: "written by the server to prove that saving and loading work", nonce, trades: [{ n: 1, text: "caf\u00e9 \u{1F680}" }], equity: [{ t: 1, v: 1.5 }] };
      const rev = await this.save(doc, key);
      const back = await loadRev<typeof doc>(key, true); // everything from the database, nothing from memory
      const list = `${key}:list`;
      await this.listPush(list, { nonce });
      const n = await this.listLen(list);
      const last = (await this.listRange<{ nonce?: string }>(list, n - 1, n - 1))[0];
      const same = back.rev === rev && back.value?.nonce === nonce && JSON.stringify(back.value.trades) === JSON.stringify(doc.trades) && JSON.stringify(back.value.equity) === JSON.stringify(doc.equity) && (await this.rev!(key)) === rev && last?.nonce === nonce;
      if (!same) throw new Error("Supabase self-test failed: what was saved did not come back the same. Nothing was served from it.");
    },
    stats: () => ({ ...stats, calls: { ...stats.calls }, ...(stats.auth ? { auth: { ...stats.auth } } : {}) }),
  };
}

// One store per server copy: every module shares it (and, with Supabase, what it remembers).
let made: Store | null = null;
export function createStore(): Store {
  return (made ??= newStore());
}
// A separate store on the same storage, with nothing remembered: "another server copy" in tests.
export function newStore(): Store {
  const supa = supabaseFromEnv();
  if (supa) return supabaseStore(supa.url, supa.keys);
  const redis = redisFromEnv();
  if (!redis) return fileStore();
  return {
    kind: "redis",
    load: <T>(key?: string) => redis.get<T>(key ? `${KEY}:u:${key}` : KEY),
    async save<T>(value: T, key?: string) {
      await redis.set(key ? `${KEY}:u:${key}` : KEY, value);
    },
    async lock(name: string, ttlMs: number) {
      return (await redis.set(`${KEY}:lock:${name}`, Date.now(), { nx: true, px: ttlMs })) === "OK";
    },
    async unlock(name: string) {
      await redis.del(`${KEY}:lock:${name}`);
    },
    kvGet: <T>(key: string) => redis.get<T>(`${KEY}:kv:${key}`),
    async kvSet<T>(key: string, value: T, opts: { nx?: boolean; ttlMs?: number } = {}) {
      const k = `${KEY}:kv:${key}`;
      const r = opts.nx
        ? opts.ttlMs ? await redis.set(k, value, { nx: true, px: opts.ttlMs }) : await redis.set(k, value, { nx: true })
        : opts.ttlMs ? await redis.set(k, value, { px: opts.ttlMs }) : await redis.set(k, value);
      return r === "OK";
    },
    async kvDel(key: string) {
      await redis.del(`${KEY}:kv:${key}`);
    },
    async listPush<T>(key: string, value: T) {
      await redis.rpush(`${KEY}:list:${key}`, value);
    },
    listLen: (key: string) => redis.llen(`${KEY}:list:${key}`),
    listRange: <T>(key: string, start: number, stop: number) => redis.lrange<T>(`${KEY}:list:${key}`, start, stop),
  };
}

// ---------- The one-time move from Upstash to Supabase ----------
// Everything the app kept in Upstash, read the way the app read it and written through the new
// store: accounts, small records (with the time they still have to live), and the append-only
// lists in their order. Locks are left behind. Safe to run again: accounts and records are
// simply written again, and a list that was finished in an earlier, interrupted run is skipped.
export type OldStore = {
  scan(cursor: string | number, opts: { match: string; count: number }): Promise<[string | number, string[]]>;
  get(key: string): Promise<unknown>;
  pttl(key: string): Promise<number>;
  llen(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
};
export const oldStoreFromEnv = (): OldStore | null => redisFromEnv() as unknown as OldStore | null;
export type CopyResult = { accounts: number; records: number; lists: number; items: number };
export async function copyFromUpstash(to: Store, from: OldStore): Promise<CopyResult> {
  if (!to.listReplace) throw new Error("This store cannot take a copy");
  const out: CopyResult = { accounts: 0, records: 0, lists: 0, items: 0 };
  const found: string[] = [];
  let cursor: string | number = "0";
  do {
    const [next, page]: [string | number, string[]] = await from.scan(cursor, { match: `${KEY}*`, count: 500 });
    found.push(...page);
    cursor = next;
  } while (String(cursor) !== "0");
  const keys = [...new Set(found)].sort();
  const lists = keys.filter((k) => k.startsWith(`${KEY}:list:`));
  const singles = keys.filter((k) => k === KEY || k.startsWith(`${KEY}:u:`) || k.startsWith(`${KEY}:kv:`));
  const one = async (k: string) => {
    const v = await from.get(k);
    if (v === null || v === undefined) return; // it expired meanwhile
    if (k === KEY) {
      await to.save(v);
      out.accounts++;
    } else if (k.startsWith(`${KEY}:u:`)) {
      await to.save(v, k.slice(`${KEY}:u:`.length));
      out.accounts++;
    } else {
      const ttl = await from.pttl(k);
      if (ttl === -2) return;
      await to.kvSet(k.slice(`${KEY}:kv:`.length), v, ttl > 0 ? { ttlMs: ttl } : {});
      out.records++;
    }
  };
  for (let i = 0; i < singles.length; i += 6) await Promise.all(singles.slice(i, i + 6).map(one));
  for (const k of lists) {
    const name = k.slice(`${KEY}:list:`.length);
    const mark = `copied-list:${name}`;
    const done = await to.kvGet<{ items: number }>(mark);
    if (done) {
      out.lists++;
      out.items += done.items;
      continue;
    }
    const n = await from.llen(k);
    if (n === 0) await to.listReplace(name, [], true);
    for (let i = 0; i < n; i += 500) await to.listReplace(name, await from.lrange(k, i, Math.min(n, i + 500) - 1), i === 0);
    await to.kvSet(mark, { at: Date.now(), items: n });
    out.lists++;
    out.items += n;
  }
  return out;
}
