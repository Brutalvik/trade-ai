// Permanent, append-only history per user:
//  - audit:<user>   what happened and who did it: consents ("I understand"), bot starts / stops /
//                   pauses, AI analyses (model, tokens), limit orders, sign-ins, admin changes.
//  - ledger:<user>  every trade, kept forever (the page shows only the newest 1,000).
// Entries are only ever added, never edited or deleted.
import { createStore } from "./store.js";

const store = createStore();

export type AuditType =
  | "consent.risky_mode" // accepted "I understand, trade anyway"
  | "consent.daily_limit" // lifted today's daily loss limit
  | "bot.start"
  | "bot.stop"
  | "bot.pause" // a safety rule paused the bot (daily loss limit, ...)
  | "ai.analysis" // an AI analysis: model, tokens
  | "order.place"
  | "order.cancel"
  | "trade.protect"
  | "trade.real" // a real swap from the user's own wallet (signature on-chain)
  | "trade.real_failed"
  | "account.signup"
  | "account.signin"
  | "account.signout"
  | "account.password"
  | "account.mode"
  | "account.reset" // paper account reset
  | "admin.plan" // an admin changed plan / role
  | "admin.topup"; // an admin added AI tokens

export type AuditEntry = { t: number; type: AuditType; by?: string; summary: string; data?: Record<string, unknown> };

export async function audit(user: string | null | undefined, type: AuditType, summary: string, data?: Record<string, unknown>, by?: string) {
  if (!user) return;
  const e: AuditEntry = { t: Date.now(), type, summary, ...(data ? { data } : {}), ...(by ? { by } : {}) };
  try {
    await store.listPush(`audit:${user.toLowerCase()}`, e);
  } catch (err) {
    console.error("[audit] write failed:", err);
  }
}

export async function ledger(user: string | null | undefined, trade: Record<string, unknown>) {
  if (!user) return;
  try {
    await store.listPush(`ledger:${user.toLowerCase()}`, trade);
  } catch (err) {
    console.error("[ledger] write failed:", err);
  }
}

// Newest first, in pages: `before` = how many of the newest entries to skip.
async function page<T>(key: string, before: number, limit: number) {
  const total = await store.listLen(key);
  const stop = total - 1 - before;
  if (stop < 0) return { total, items: [] as T[] };
  const start = Math.max(0, stop - limit + 1);
  const items = (await store.listRange<T>(key, start, stop)).reverse();
  return { total, items };
}
export const activity = (user: string, before = 0, limit = 50) => page<AuditEntry>(`audit:${user.toLowerCase()}`, before, Math.min(200, limit));
export const tradeHistory = (user: string, before = 0, limit = 200) => page<Record<string, unknown>>(`ledger:${user.toLowerCase()}`, before, Math.min(5000, limit));
