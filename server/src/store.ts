// Where the paper account and bot state live.
//  - Upstash Redis when its env vars are set (needed on Vercel: functions are
//    short-lived copies that don't share memory or disk).
//  - A local JSON file otherwise (fine for `npm run dev` on one machine).
import { Redis } from "@upstash/redis";
import fs from "node:fs";
import path from "node:path";

export type StoreKind = "redis" | "file" | "temp";

export interface Store {
  kind: StoreKind;
  load<T>(): Promise<T | null>;
  save<T>(value: T): Promise<void>;
  // Returns true if we got the lock (it expires by itself after ttlMs).
  lock(name: string, ttlMs: number): Promise<boolean>;
  unlock(name: string): Promise<void>;
  // Small key-value records (user accounts). kvSet with nx only writes if the key is new
  // and returns whether it wrote; ttlMs makes the record expire by itself.
  kvGet<T>(key: string): Promise<T | null>;
  kvSet<T>(key: string, value: T, opts?: { nx?: boolean; ttlMs?: number }): Promise<boolean>;
  kvDel(key: string): Promise<void>;
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
    .filter((n) => /REDIS|^KV_|_KV_|UPSTASH|_REST_API_/i.test(n))
    .sort();
}

function fileStore(): Store {
  // On Vercel only /tmp is writable, and it is wiped between instances ("temp").
  const dir = process.env.VERCEL ? "/tmp/trade-ai" : path.resolve("data");
  const file = path.join(dir, "state.json");
  const kvFile = path.join(dir, "kv.json");
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
    async load<T>() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as T;
      } catch {
        return null;
      }
    },
    async save<T>(value: T) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value, null, 2));
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
    ...localLock,
  };
}

export function createStore(): Store {
  const redis = redisFromEnv();
  if (!redis) return fileStore();
  return {
    kind: "redis",
    load: <T>() => redis.get<T>(KEY),
    async save<T>(value: T) {
      await redis.set(KEY, value);
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
  };
}
