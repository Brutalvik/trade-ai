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

function redisFromEnv(): Redis | null {
  // Vercel's Upstash integration sets KV_REST_API_*; Upstash's own docs use UPSTASH_REDIS_REST_*.
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
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
