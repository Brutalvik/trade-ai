// Plans (what a user pays for) and roles (what a user is allowed to administer), RBAC style:
// every feature checks a permission, and a user's permissions come from their plan + role.
//
// The owner's plans (27 Nov 2026, from their mockup "Plans & AI Credits"): Free, Starter $19,
// AI Pro $59, AI Max $149 a month; yearly = 11 months paid (1 month free). Paid by card through
// Stripe (billing.ts); an admin can still set a plan by hand.
//
// AI tokens: 2 app tokens = 1 token of Claude (the owner's rate: a 50% margin on AI). Each model
// asked counts separately.

export type PlanId = "free" | "starter" | "pro" | "max";
export type Role = "user" | "admin";

export type Permission =
  | "trade.manual" // buy / sell now
  | "trade.limit" // limit buy / sell orders
  | "trade.protect" // "Protect this trade"
  | "ai.analyze" // ask the AI for a plan (Analyze, Ask AI)
  | "bot.run" // run the AI bot on a coin
  | "bot.autopick" // bot picks coins itself
  | "bot.risky" // trade risky setups ("I understand")
  | "admin.users"; // manage users' plans and roles

export type Plan = {
  id: PlanId;
  name: string;
  priceUsd: number; // per month
  blurb: string; // the line under the price
  aiTokens: number; // app tokens per month (0 = no AI)
  feePct: number; // platform transaction charge per trade, % of the trade
  freeTrades: number; // trades per month with no platform charge (then feePct applies)
  bots: number; // AI agents that can run at the same time, each on its own coin
  permissions: Permission[];
  features: string[]; // the Plans window's list ({analyses} = the estimate for the plan's tokens)
  popular?: boolean; // shown as "Most Popular"
};

const TRADING: Permission[] = ["trade.manual", "trade.limit", "trade.protect"];
const AI: Permission[] = ["ai.analyze", "bot.run"];

export const APP_TOKENS_PER_API_TOKEN = 2;
// What one AI analysis takes, roughly, in Claude tokens (the Plans window's "≈ N analyses").
// An estimate, not a measurement: the app's earlier figure, unchanged.
export const API_TOKENS_PER_ANALYSIS = 14_000;
export const analysesFor = (appTokens: number) => Math.round(appTokens / (API_TOKENS_PER_ANALYSIS * APP_TOKENS_PER_API_TOKEN));

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free", name: "Free", priceUsd: 0, blurb: "Explore charts & paper trading",
    aiTokens: 0, feePct: 0.5, freeTrades: 0, bots: 0, permissions: ["trade.manual"], // manual only: no limit orders or Protect
    features: ["Paper trading, charts & scanner", "Manual instant buy & sell", "0.5% fee per trade", "No AI agents or analyses"],
  },
  starter: {
    id: "starter", name: "Starter", priceUsd: 19, blurb: "Pro orders & your first AI agent",
    aiTokens: 1_500_000, feePct: 0.15, freeTrades: 200, bots: 1, permissions: [...TRADING, ...AI],
    features: ["200 free trades/mo, then 0.15%", "Limit orders & Protect guard", "1.5M AI tokens/mo ({analyses})", "1 AI agent on 1 coin"],
  },
  pro: {
    id: "pro", name: "AI Pro", priceUsd: 59, blurb: "Multi-agent AI trading & 0% fees", popular: true,
    aiTokens: 5_000_000, feePct: 0, freeTrades: Infinity, bots: 3, permissions: [...TRADING, ...AI, "bot.autopick", "bot.risky"],
    features: ["0% platform transaction fees", "5M AI tokens/mo ({analyses})", "3 simultaneous AI agents", "Auto-Pick (AI selects coins) & real-money Auto-Pilot", "Risky mode + Protect guard"],
  },
  max: {
    id: "max", name: "AI Max", priceUsd: 149, blurb: "Full autonomous AI trading desk",
    aiTokens: 13_000_000, feePct: 0, freeTrades: Infinity, bots: 10, permissions: [...TRADING, ...AI, "bot.autopick", "bot.risky"],
    features: ["0% platform transaction fees", "13M AI tokens/mo ({analyses})", "10 simultaneous AI agents", "Auto-Pick + Risky mode", "5-second price checks & execution"],
  },
};
export const PLAN_ORDER: PlanId[] = ["free", "starter", "pro", "max"];
// The first plan that includes a feature (the app's Plans window points at it).
export const firstPlanWith = (perm: Permission): PlanId => PLAN_ORDER.find((id) => PLANS[id].permissions.includes(perm)) ?? "max";
// A feature the account's plan does not include: the app opens its Plans window instead of an error.
export class UpgradeNeeded extends Error {
  readonly upgrade = true;
  constructor(message: string, readonly need: PlanId) {
    super(message);
  }
}
// The account's AI tokens are used up (this month's allowance and any top-up): answers carry
// `topup: true`, and the app opens its top-up window (the token packs only) instead of an error.
export class TokensNeeded extends Error {
  readonly topup = true;
  constructor(message = "You've used all your AI tokens for this month.") {
    super(message);
  }
}
// When a month's AI allowance starts again: the 1st of next month, 00:00 UTC.
export const nextMonthStart = (ms = Date.now()) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

// Pay-as-you-go AI tokens for AI plans: used after the monthly allowance runs out; they never expire.
export const TOKEN_PACKS: { id: string; tokens: number; priceUsd: number; note?: string }[] = [
  { id: "pack2m", tokens: 2_000_000, priceUsd: 20 },
  { id: "pack5m", tokens: 5_000_000, priceUsd: 50 },
  { id: "pack10m", tokens: 10_000_000, priceUsd: 100, note: "Best for heavy bots" },
];
// Yearly billing: pay for 11 months, get 12 (1 month free).
export const YEARLY_MONTHS_PAID = 11;

const ROLE_PERMISSIONS: Record<Role, Permission[]> = { user: [], admin: ["admin.users"] };

// (An account still marked with the old Member plan, which had no AI, counts as Starter.)
export const planOf = (id?: string | null): Plan => PLANS[id === "member" ? "starter" : (id as PlanId) in PLANS ? (id as PlanId) : "free"];
export const permissionsFor = (plan?: string | null, role?: string | null): Permission[] => [
  ...new Set([...planOf(plan).permissions, ...(ROLE_PERMISSIONS[(role as Role) ?? "user"] ?? [])]),
];
export const can = (plan: string | null | undefined, role: string | null | undefined, p: Permission) => permissionsFor(plan, role).includes(p);
// Admins aren't limited by AI tokens (they run the platform's own bot).
export const tokenLimit = (plan?: string | null, role?: string | null) => (role === "admin" ? Infinity : planOf(plan).aiTokens);
// How many agents can run at once (admins: the most any plan has).
export const MAX_AGENTS = 10;
export const botLimit = (plan?: string | null, role?: string | null) => (role === "admin" ? MAX_AGENTS : planOf(plan).bots);
export const month = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 7); // "2026-11"

// For the plans page (JSON can't hold Infinity).
export const publicPlans = () =>
  PLAN_ORDER.map((id) => {
    const p = PLANS[id];
    return { ...p, freeTrades: Number.isFinite(p.freeTrades) ? p.freeTrades : -1, features: p.features.map((f) => f.replace("{analyses}", `≈ ${analysesFor(p.aiTokens)} analyses`)) };
  });
