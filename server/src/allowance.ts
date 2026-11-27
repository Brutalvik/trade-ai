// When an account's monthly AI token allowance starts again (the owner's rule, 2026-11-27): it starts
// again only for a plan that is being paid for.
//  - Paid monthly through Stripe: when the renewal is paid (the next billing period), not on the 1st.
//  - Paid yearly: every month of the paid year (counted from the day it was paid).
//  - Renewal cancelled, or a payment not gone through: it does not start again; the account uses
//    what is left (and its top-up tokens) until it pays again or the plan ends.
//  - A plan with no Stripe subscription (one an admin set by hand): on the 1st of each month (UTC), as
//    before.
// The account's use is kept per allowance period: usage:<user>:<period id>. A calendar month's id is
// "2026-11" (the earlier key, so nothing is lost); a paid period's is "p<start in seconds>-<month>".
import { createStore } from "./store.js";
import { month, nextMonthStart } from "./plans.js";

const store = () => createStore();
export type PaidPeriod = { start: number; end: number; interval: "month" | "year" };
// What billing.ts keeps that matters here (its record, billing:<user>).
export type AllowanceInfo = { subscriptionId?: string; status?: string; cancelAtPeriodEnd?: boolean; paid?: PaidPeriod };
export type Allowance = {
  id: string;
  resetsAt: number | null; // when it starts again (null: not until a payment goes through)
  why: "month" | "renewal" | "payment" | "ends"; // month = a new month; renewal = when the plan renews and is paid; payment = once a payment goes through; ends = the plan ends then (renewal cancelled)
};
export const billingKey = (user: string) => `billing:${user.toLowerCase()}`;

// Adds whole months to a moment, on the same day of the month (the last day when that month is shorter).
export function addMonths(ms: number, k: number) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d.getUTCDate(), last));
  return t.getTime();
}

export function allowanceCycle(info: AllowanceInfo | null, now = Date.now()): Allowance {
  if (!info?.subscriptionId || !info.paid) return { id: month(now), resetsAt: nextMonthStart(now), why: "month" };
  const { start, end, interval } = info.paid;
  const t = Math.min(now, end - 1); // never past what was paid for
  let k = 0;
  if (interval === "year") while (k < 12 && addMonths(start, k + 1) <= t) k++;
  const id = `p${Math.floor(start / 1000)}-${k}`;
  const next = interval === "year" ? Math.min(addMonths(start, k + 1), end) : end;
  if (next < end) return { id, resetsAt: next, why: "month" }; // a month of a paid year
  if (info.status !== "active") return { id, resetsAt: null, why: "payment" }; // the card was not charged
  if (info.cancelAtPeriodEnd) return { id, resetsAt: end, why: "ends" };
  return { id, resetsAt: end, why: "renewal" };
}

// The account's allowance period now (its billing record read at most every 30 seconds per server).
const cache = new Map<string, { at: number; info: AllowanceInfo | null }>();
export async function allowanceOf(user: string, now = Date.now()): Promise<Allowance> {
  const k = user.toLowerCase();
  let hit = cache.get(k);
  if (!hit || Date.now() - hit.at > 30_000) {
    hit = { at: Date.now(), info: await store().kvGet<AllowanceInfo>(billingKey(k)) };
    cache.set(k, hit);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return allowanceCycle(hit.info, now);
}
export const forgetAllowance = (user: string) => void cache.delete(user.toLowerCase());
export const usageKeyOf = async (user: string) => `usage:${user.toLowerCase()}:${(await allowanceOf(user)).id}`;
