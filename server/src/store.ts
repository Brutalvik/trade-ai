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
    if (url?.startsWith("https://") && token) return new Redis({ url, token });
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
  };
}
