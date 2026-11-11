// Plans (what a user pays for) and roles (what a user is allowed to administer), RBAC style:
// every feature checks a permission, and a user's permissions come from their plan + role.
//
// Billing isn't connected yet: an admin sets each user's plan. Prices are the proposed ones.
//
// AI tokens: 10 app tokens = 1 token of an AI API. Each model asked counts separately, so
// asking two AI models costs the tokens of both (x10).

export type PlanId = "free" | "member" | "starter" | "pro" | "max";
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
  priceUsd: number; // per month (proposed)
  blurb: string;
  aiTokens: number; // app tokens per month (0 = no AI)
  feePct: number; // platform transaction charge per trade, % of the trade
  freeTrades: number; // trades per month with no platform charge (then feePct applies)
  permissions: Permission[];
};

const TRADING: Permission[] = ["trade.manual", "trade.limit", "trade.protect"];
const AI: Permission[] = ["ai.analyze", "bot.run"];

export const APP_TOKENS_PER_API_TOKEN = 10;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free", name: "Free", priceUsd: 0,
    blurb: "Charts, scanner and paper trading. A small charge on each trade.",
    aiTokens: 0, feePct: 0.5, freeTrades: 0, permissions: [...TRADING],
  },
  member: {
    id: "member", name: "Member", priceUsd: 9,
    blurb: "Everything in Free, with 100 trades a month free of charge, then a lower rate.",
    aiTokens: 0, feePct: 0.2, freeTrades: 100, permissions: [...TRADING],
  },
  starter: {
    id: "starter", name: "AI Starter", priceUsd: 19,
    blurb: "Member benefits plus AI plans and the AI bot on one coin.",
    aiTokens: 1_000_000, feePct: 0.1, freeTrades: 300, permissions: [...TRADING, ...AI],
  },
  pro: {
    id: "pro", name: "AI Pro", priceUsd: 49,
    blurb: "More AI, auto-pick and risky mode. No transaction charges.",
    aiTokens: 5_000_000, feePct: 0, freeTrades: Infinity, permissions: [...TRADING, ...AI, "bot.autopick", "bot.risky"],
  },
  max: {
    id: "max", name: "AI Max", priceUsd: 129,
    blurb: "The most AI for frequent analyses and longer bot runs. No transaction charges.",
    aiTokens: 15_000_000, feePct: 0, freeTrades: Infinity, permissions: [...TRADING, ...AI, "bot.autopick", "bot.risky"],
  },
};
export const PLAN_ORDER: PlanId[] = ["free", "member", "starter", "pro", "max"];

// Extra AI tokens for AI plans: used after the monthly allowance runs out, and they don't expire.
export const TOKEN_PACKS = [
  { id: "pack2m", tokens: 2_000_000, priceUsd: 6 },
  { id: "pack10m", tokens: 10_000_000, priceUsd: 25 },
];
// Yearly billing: pay for 10 months, get 12 (2 months free).
export const YEARLY_MONTHS_PAID = 10;

const ROLE_PERMISSIONS: Record<Role, Permission[]> = { user: [], admin: ["admin.users"] };

export const planOf = (id?: string | null): Plan => PLANS[(id as PlanId) in PLANS ? (id as PlanId) : "free"];
export const permissionsFor = (plan?: string | null, role?: string | null): Permission[] => [
  ...new Set([...planOf(plan).permissions, ...(ROLE_PERMISSIONS[(role as Role) ?? "user"] ?? [])]),
];
export const can = (plan: string | null | undefined, role: string | null | undefined, p: Permission) => permissionsFor(plan, role).includes(p);
// Admins aren't limited by AI tokens (they run the platform's own bot).
export const tokenLimit = (plan?: string | null, role?: string | null) => (role === "admin" ? Infinity : planOf(plan).aiTokens);
export const month = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 7); // "2026-11"

// For the plans page (JSON can't hold Infinity).
export const publicPlans = () =>
  PLAN_ORDER.map((id) => {
    const p = PLANS[id];
    return { ...p, freeTrades: Number.isFinite(p.freeTrades) ? p.freeTrades : -1 };
  });
