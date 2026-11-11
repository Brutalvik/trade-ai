// Paper-trading broker + automated bot.
// Every trade here is simulated with realistic fees and slippage so you can
// see how the strategy would perform before risking real money.
import { audit, ledger, type AuditType } from "./audit.js";
import { analyze, BOT_MODEL, CLAUDE_MODEL, type CheckedOrder, type Consensus, type Frame, type ModelResult } from "./ai.js";
import { getCandles, getPair, getRecentTokenCandles, knownToken, type PairInfo, type Timeframe } from "./data.js";
import { snapshot } from "./indicators.js";
import { scanOpportunities } from "./scan.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { APP_TOKENS_PER_API_TOKEN, month, planOf, tokenLimit, type PlanId, type Role } from "./plans.js";
import { createStore } from "./store.js";
import { alertChannel, sendAlert } from "./alerts.js";
import { scanNewCoins } from "./newcoins.js";

export type Position = {
  id: string;
  chain: string;
  pool: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  costUsd: number;
  openedAt: number;
  takeProfit?: number;
  stopLoss?: number;
  sellBy?: number;
  source: "manual" | "bot";
  lastPrice: number;
  target?: number; // when reached, switch to a trailing stop
  trailPct?: number; // trailing stop distance from the highest price, %
  peak?: number; // highest price since the trailing stop started
  trailing?: boolean;
  predictedWinPct?: number; // Claude's win chance for the order that opened it
  // "Protect this trade" (manual positions): sell if the price falls protectPct% from its
  // highest point since protection was switched on. Checked every 5 s, bot running or not.
  protectPct?: number;
  protectSince?: number;
  strategy?: "newcoin"; // opened by the New coins mode (separate rules and scorecard)
  partialDone?: boolean; // new coins: half already sold at the first target
  extraSlipPct?: number; // extra slippage for thin liquidity, applied on the way out too
  realizedUsd?: number; // P&L already taken by partial sales (new coins: half at the first target)
  best?: number; // highest closing price since the buy (for the profit lock)
  locked?: boolean; // the stop is a profit lock (above break-even)
};

export type Trade = {
  platformFeeUsd?: number; // the platform's transaction charge on this trade (depends on the plan)
  id: string;
  time: number;
  side: "BUY" | "SELL";
  symbol: string;
  pool: string;
  price: number;
  qty: number;
  usd: number;
  feeUsd: number;
  pnlUsd?: number;
  reason: string;
  source: "manual" | "bot";
  // Bot trades: Claude's predicted win chance for the order, and (on the sell)
  // whether the price actually reached the target before the trade closed.
  predictedWinPct?: number;
  reachedTarget?: boolean;
  auto?: boolean; // sold automatically by "Protect this trade"
  strategy?: "newcoin";
};

export type BotConfig = {
  chain: string;
  pool: string;
  symbol: string;
  tf: Timeframe;
  positionPct: number; // % of cash per trade
  minConfidence: number;
  analyzeEverySec: number;
  checkEverySec: number;
  maxDrawdownPct: number; // bot stops itself below this
  breakEvenAtPct: number; // move stop to break-even once up this much
  lockPct?: number; // profit lock: once up breakEvenAtPct, never give back more than (100 - lockPct)% of the best gain (default 50; 0 = off)
  partialAtPct?: number; // sell half once the price is this % of the way to the target (default 75; 0 = off)
  goalUsd: number;
  // "this" = trade the coin above; "auto" = pick the best coin from Opportunities each round.
  pick?: "this" | "auto" | "newcoins";
  // New coins mode (fast, rule-based, no Claude): young coins that pass the rug-risk checks.
  newChain?: "solana" | "base";
  newCoinPct?: number; // % of the account per new coin (default 3)
  newStopPct?: number; // stop-loss below the buy price (default 15)
  newTakePct?: number; // sell half at this gain (default 30)
  newTrailPct?: number; // then trail the rest this far below its high (default 10)
  newMaxMin?: number; // sell after this many minutes (default 45)
  newMaxPerDay?: number; // at most this many new-coin buys per UTC day (default 5)
  autoChain?: string; // all | solana | base | ethereum | bsc
  autoCandidates?: number; // how many top coins Claude checks per round
  autoMinLiquidityUsd?: number; // skip thin coins in auto mode
  trailPct?: number; // after the target is hit, sell if price falls this % from its high (default 3)
  // false = wait for the price to hold past the trigger for the order's confirmSeconds.
  // Anything else (default) = buy the instant the trigger price is hit.
  waitForHold?: boolean;
  // Safety rules (defaults apply when missing, including bots started before they existed).
  cooldownMin?: number; // after a losing trade, don't re-buy that coin for this long (default 30)
  dailyLossPct?: number; // stop opening trades for the rest of the UTC day after losing this % (default 10)
  maxDrop1hPct?: number; // no dip buys if the coin fell more than this % in the last hour (default 10)
  // "I understand the risks": trade even when the coin is falling (dip buys allowed in a
  // downtrend) and skip the per-coin cool-down / 2-losses-a-day skip. The daily loss limit,
  // emergency stop, minimum win chance and fee check still apply.
  allowRisky?: boolean;
  riskReasons?: string[]; // the warnings the user saw when accepting risky mode (kept in the audit log)
  // Risk-based sizing: size each trade so hitting its exit loses about this % of the account
  // (default 1.5). positionPct is then only the maximum share of cash per trade.
  riskPerTradePct?: number;
};

// continuous: false (default) = the bot stops itself after one profitable trade;
// true = it keeps trading round after round until you stop it.
export type Settings = { feePct: number; slippagePct: number; continuous?: boolean };

// A limit order you set by hand: buy when the price falls to `price`, or sell (part of)
// a manual position when it rises to `price`. Checked every 5 seconds, even with the bot off.
export type LimitOrder = {
  id: string;
  side: "BUY" | "SELL";
  chain: string;
  pool: string;
  symbol: string;
  price: number;
  usd?: number; // BUY: how much to spend
  positionId?: string; // SELL: which position
  fraction?: number; // SELL: share of it to sell (0.25 / 0.5 / 1)
  createdAt: number;
};

type State = {
  mode: "paper";
  startCash: number;
  cash: number;
  peakEquity: number;
  positions: Position[];
  trades: Trade[];
  equity: { t: number; v: number }[];
  settings: Settings;
  orders: LimitOrder[];
  bot: {
    running: boolean;
    config: BotConfig | null;
    lastAnalysisAt: number;
    lastTickAt: number;
    // When each standing order's trigger was first met (for confirmSeconds); null = not met.
    armedSince: (number | null)[];
    // Set after a trade closes, so Claude is asked for a new plan right away.
    askNow: boolean;
    // Plans made before this time are not used: set when the bot starts and when a trade
    // closes, so every new trade starts from a fresh AI analysis.
    freshAfter?: number;
    // "Continue anyway": the user lifted today's daily loss limit (UTC date it applies to).
    dailyOverride?: string | null;
    // Orders whose trigger was reached but that were skipped (logged once per plan).
    skipNoted: boolean[];
    startedAt: number | null; // when the bot was last started (unix ms)
    stoppedAt: number | null; // when it was last stopped (null while running)
    // Per-coin losing streaks (for the cool-down) and today's starting equity (for the daily limit).
    coinStats: Record<string, { losses: number; lastLossAt: number; lossDay: string }>;
    day: { date: string; startEquity: number } | null;
    blocked: string | null; // why the bot isn't trading right now (shown in the panel)
    lastWatch: { at: number; by: "scheduler" | "dashboard" | "local" } | null; // last wake-up, to show the bot is alive
    noted: Record<string, number>; // one-time log messages already written
    // Auto-pick: the coin the bot is currently waiting to buy, and what Claude said about each candidate.
    target: { chain: string; pool: string; symbol: string; chosenAt: number } | null;
    candidates: { symbol: string; chain: string; pool: string; action: string; confidence: number; note: string }[];
    log: { t: number; msg: string; level: "info" | "good" | "bad" }[];
  };
  lastSignal: { at: number; pool: string; symbol: string; tf: string; results: ModelResult[]; consensus: Consensus; trendDown?: boolean } | null;
};

const store = createStore();
export const storeKind = () => store.kind;

function fresh(startCash = 10): State {
  return {
    mode: "paper",
    startCash,
    cash: startCash,
    peakEquity: startCash,
    positions: [],
    trades: [],
    equity: [{ t: Date.now(), v: startCash }],
    settings: { feePct: 1.0, slippagePct: 0.5 },
    orders: [],
    bot: { running: false, config: null, lastAnalysisAt: 0, lastTickAt: 0, armedSince: [], askNow: false, skipNoted: [], startedAt: null, stoppedAt: null, coinStats: {}, day: null, blocked: null, lastWatch: null, noted: {}, target: null, candidates: [], log: [] },
    lastSignal: null,
  };
}

// Fill in fields added in later versions so older saved states keep working.
function migrate(s: State): State {
  s.bot = { ...fresh().bot, ...s.bot };
  s.bot.candidates ??= [];
  s.bot.target ??= null;
  s.bot.lastTickAt ??= 0;
  s.bot.armedSince ??= [];
  s.bot.askNow ??= false;
  s.bot.skipNoted ??= [];
  s.orders ??= [];
  // Bots started before start/stop times were saved: recover them from the log.
  // (The defaults above already filled these with null, so check for null, not undefined.)
  s.bot.startedAt ??= s.bot.log.find((l) => l.msg.startsWith("Bot started"))?.t ?? null;
  if (s.bot.running) s.bot.stoppedAt = null;
  else s.bot.stoppedAt ??= s.bot.log.find((l) => l.msg.startsWith("Bot stopped"))?.t ?? null;
  s.bot.noted ??= {};
  s.bot.blocked ??= null;
  s.bot.lastWatch ??= null;
  if (!s.bot.coinStats || !Object.keys(s.bot.coinStats).length) {
    // Rebuild today's losing streaks from the bot's trade history.
    s.bot.coinStats = {};
    const today = utcDay();
    for (const tr of s.trades.slice().reverse()) {
      if (tr.source !== "bot" || tr.side !== "SELL" || utcDay(tr.time) !== today) continue;
      const cs = (s.bot.coinStats[tr.pool] ??= { losses: 0, lastLossAt: 0, lossDay: today });
      if ((tr.pnlUsd ?? 0) < 0) {
        cs.losses++;
        cs.lastLossAt = tr.time;
      } else cs.losses = 0;
    }
  }
  if (!s.bot.day) {
    const dayStart = Date.parse(utcDay() + "T00:00:00Z");
    s.bot.day = { date: utcDay(), startEquity: s.equity.find((e) => e.t >= dayStart)?.v ?? s.startCash };
  }
  // Plans saved before standing orders existed have no "orders": drop them so
  // the bot asks Claude for a new-style plan instead of erroring every second.
  if (s.lastSignal && !Array.isArray(s.lastSignal.consensus?.orders)) s.lastSignal = null;
  // Plans from before per-order win chances: drop them too, so Claude writes a new one.
  if (s.lastSignal && s.lastSignal.consensus.orders.some((o) => typeof o.winChancePct !== "number")) s.lastSignal = null;
  return s;
}

// ---------- Accounts ----------
// Every login has its own paper account (cash, positions, trades, bot, orders), saved under
// its own key. Each request / bot step runs inside one account (AsyncLocalStorage), and
// `state` below always means the current account's state, so the rest of the engine is unchanged.
type Account = {
  key: string | null; // username (lowercase); null = signed-out visitor (never saved)
  state: State;
  loaded: boolean;
  pending: Promise<void>; // queued writes and alerts
  dirty: boolean; // something worth saving happened (a trade, a log line, a moved stop)
  busy: boolean; // a bot step is running: don't swap the state under it
  guarding: boolean;
  active?: boolean; // last value written to the active-accounts list
  activeCheckedAt?: number; // when that list was last read (other servers may have changed it)
  plan?: PlanId; // the user's plan and role (refreshed from their user record about once a minute)
  role?: Role;
  planAt?: number;
};
const NEW_ACCOUNT_CASH = 1000;
const als = new AsyncLocalStorage<Account>();
const accounts = new Map<string, Account>();
const newAccount = (key: string | null): Account => ({ key, state: fresh(key ? NEW_ACCOUNT_CASH : 0), loaded: false, pending: Promise.resolve(), dirty: false, busy: false, guarding: false });
const acct = (): Account => als.getStore() ?? (fallback ??= newAccount(null));
let fallback: Account | null = null;

// Run fn inside a user's account (null = a signed-out visitor: an empty, unsaved $0 account).
export function withAccount<T>(key: string | null, fn: () => Promise<T>, access?: { plan: PlanId; role: Role }): Promise<T> {
  const k = key?.toLowerCase() ?? null;
  let a = k ? accounts.get(k) : undefined;
  if (!a) {
    a = newAccount(k);
    if (k) accounts.set(k, a);
  }
  // A request knows the user's current plan and role: use them right away (no stale cache).
  if (access) Object.assign(a, { plan: access.plan, role: access.role, planAt: Date.now() });
  return als.run(a, fn);
}
export const currentAccountKey = () => acct().key;

const state = new Proxy({} as State, {
  get: (_t, k) => (acct().state as any)[k],
  set: (_t, k, v) => {
    (acct().state as any)[k] = v;
    return true;
  },
  has: (_t, k) => k in acct().state,
  ownKeys: () => Reflect.ownKeys(acct().state),
  getOwnPropertyDescriptor: (_t, k) => Object.getOwnPropertyDescriptor(acct().state, k),
});

// Accounts that need watching even when nobody has the page open (bot on, protected trades,
// limit orders). The scheduler wakes each of them.
const ACTIVE_KEY = "active-accounts";
const isActive = (st: State) => st.bot.running || st.positions.some((p) => p.protectPct) || (st.orders?.length ?? 0) > 0;
async function markActive(a: Account) {
  if (!a.key) return;
  const now = isActive(a.state);
  // Another server copy may have changed the shared list since we last looked, so a cached
  // "already on the list" is only trusted for 30 s; otherwise read the list again.
  if (a.active === now && Date.now() - (a.activeCheckedAt ?? 0) < 30_000) return;
  const list = (await store.kvGet<string[]>(ACTIVE_KEY)) ?? [];
  a.activeCheckedAt = Date.now();
  const next = now ? [...new Set([...list, a.key])] : list.filter((k) => k !== a.key);
  if (next.length !== list.length || now !== list.includes(a.key)) await store.kvSet(ACTIVE_KEY, next);
  a.active = now;
}
export const activeAccounts = async () => (await store.kvGet<string[]>(ACTIVE_KEY)) ?? [];

// One-time move: the single shared account from before logins had their own goes to the
// owner's login (OWNER_USERNAME, or the account that claimed it). A backup copy is kept.
let migrated = false;
export async function ensureMigrated() {
  if (migrated) return;
  if (await store.kvGet<boolean>("migrated-to-accounts")) return void (migrated = true);
  const owner = process.env.OWNER_USERNAME?.trim().toLowerCase() || (await store.kvGet<string>("owner"));
  const legacy = await store.load<State>();
  if (!legacy) return void (await store.kvSet("migrated-to-accounts", true), (migrated = true));
  if (!owner) return; // nobody has claimed it yet: try again later
  if (!(await store.load<State>(owner))) await store.save(legacy, owner);
  await store.kvSet("legacy-state-backup", legacy);
  if (isActive(legacy)) {
    const list = (await store.kvGet<string[]>(ACTIVE_KEY)) ?? [];
    if (!list.includes(owner)) await store.kvSet(ACTIVE_KEY, [...list, owner]);
  }
  await store.kvSet("migrated-to-accounts", true);
  migrated = true;
  console.log(`[accounts] moved the shared paper account to ${owner}`);
}

// Load the latest saved state. With Redis this runs on every request, because
// on Vercel each request may land on a different short-lived server.
export async function sync() {
  const a = acct();
  if (!a.key) return; // signed-out visitor: nothing to load
  if (a.loaded && store.kind !== "redis") return;
  // Never swap the state out from under a running bot step. One server handles
  // several requests at once (e.g. dashboard refreshes while the bot waits for
  // Claude); replacing the object mid-step lost the step's updates, so the bot
  // forgot it had just asked Claude and asked again every 20 s.
  if (a.busy) return;
  const saved = await store.load<State>(a.key);
  if (a.busy) return; // a step started while we were loading: keep its state
  if (saved) a.state = migrate(saved);
  const first = !a.loaded;
  a.loaded = true;
  if (!saved && first) save(); // a brand-new account: keep its starting balance
  if (a.active === undefined) a.active = (await activeAccounts()).includes(a.key);
  if (!a.planAt || Date.now() - a.planAt > 60_000) {
    const u = await store.kvGet<{ plan?: PlanId; role?: Role }>(`user:${a.key}`);
    // The platform owner is its admin on the top plan, even before their record says so
    // (their bot keeps running on the scheduler without them signing in).
    const owner = process.env.OWNER_USERNAME?.trim().toLowerCase() || (await store.kvGet<string>("owner"));
    const isOwner = owner === a.key && !u?.role;
    a.plan = isOwner ? "max" : planOf(u?.plan).id;
    a.role = isOwner ? "admin" : (u?.role ?? "user");
    a.planAt = Date.now();
  }
}

// ---------- Plans: AI tokens and transaction charges ----------
const usageKey = (key: string) => `usage:${key}:${month()}`;
// AI tokens left this month (app tokens; Infinity for admins).
async function tokensLeft(): Promise<number> {
  const a = acct();
  if (!a.key) return Infinity; // scripts and tests without a login
  const limit = tokenLimit(a.plan, a.role);
  if (!Number.isFinite(limit)) return Infinity;
  if (limit <= 0) return 0; // no AI on this plan (top-ups don't add AI to a plan without it)
  const used = (await store.kvGet<number>(usageKey(a.key))) ?? 0;
  const topup = (await store.kvGet<number>(`topup:${a.key}`)) ?? 0;
  return Math.max(0, limit - used) + topup;
}
// Charge the AI tokens an analysis used: 10 app tokens per AI API token, for every model asked.
async function chargeTokens(results: ModelResult[]) {
  const a = acct();
  const apiTokens = results.reduce((s, r) => s + (r.tokens ?? 0), 0);
  if (!a.key || !apiTokens) return 0;
  const appTokens = apiTokens * APP_TOKENS_PER_API_TOKEN;
  const k = usageKey(a.key);
  const used = (await store.kvGet<number>(k)) ?? 0;
  const limit = tokenLimit(a.plan, a.role);
  // The monthly allowance is used first; anything beyond it comes out of top-up tokens.
  const fromMonthly = Number.isFinite(limit) ? Math.min(appTokens, Math.max(0, limit - used)) : appTokens;
  await store.kvSet(k, used + fromMonthly);
  const extra = appTokens - fromMonthly;
  if (extra > 0) {
    const tk = `topup:${a.key}`;
    await store.kvSet(tk, Math.max(0, ((await store.kvGet<number>(tk)) ?? 0) - extra));
  }
  return appTokens;
}
// The platform's transaction charge for the next trade: free for the first `freeTrades`
// trades this month on the user's plan, then the plan's rate.
function platformFeePct() {
  if (!acct().key) return 0; // scripts and tests without a login
  const p = planOf(acct().plan);
  if (p.feePct <= 0) return 0;
  const m = month();
  const tradesThisMonth = state.trades.filter((t) => month(t.time) === m).length;
  return tradesThisMonth < p.freeTrades ? 0 : p.feePct;
}

// Permanent history (audit log / full trade history), queued like saves so flush() waits for it.
function rec(type: AuditType, summary: string, data?: Record<string, unknown>) {
  const a = acct();
  if (!a.key) return;
  const key = a.key;
  a.pending = a.pending.then(() => audit(key, type, summary, data)).catch(() => {});
}
function recTrade(t: Trade) {
  const a = acct();
  if (!a.key) return;
  const key = a.key;
  a.pending = a.pending.then(() => ledger(key, t as unknown as Record<string, unknown>)).catch(() => {});
}

function save() {
  const a = acct();
  a.dirty = false;
  if (!a.key) return; // signed-out visitors' views are never saved
  const copy = structuredClone(a.state);
  a.pending = a.pending.then(() => store.save(copy, a.key!)).then(() => markActive(a)).catch((e) => console.error("[store] save failed:", e));
}
// Wait for writes to finish (must happen before a Vercel function returns).
export async function flush() {
  await acct().pending;
}

// Phone alert (Telegram / ntfy, if configured). Queued with saves so flush() waits for it.
function alert(text: string) {
  if (!alertChannel()) return;
  const a = acct();
  if (!a.key) return;
  a.pending = a.pending.then(() => sendAlert(text)).catch(() => {});
}

// Saved state stays small and constant-size: newest trades, log lines and equity points only.
const MAX_TRADES = 1000;
const uid = () => Math.random().toString(36).slice(2, 10);
export const roundTripCostPct = () => 2 * (state.settings.feePct + state.settings.slippagePct);

function log(msg: string, level: "info" | "good" | "bad" = "info") {
  acct().dirty = true;
  state.bot.log.unshift({ t: Date.now(), msg, level });
  state.bot.log = state.bot.log.slice(0, 200);
  console.log(`[bot] ${msg}`);
}

export function equity() {
  return state.cash + state.positions.reduce((s, p) => s + p.qty * p.lastPrice, 0);
}

function recordEquity() {
  const v = equity();
  state.peakEquity = Math.max(state.peakEquity, v);
  const last = state.equity.at(-1);
  if (!last || Date.now() - last.t > 30_000) state.equity.push({ t: Date.now(), v });
  state.equity = state.equity.slice(-2000);
}

// What a signed-out visitor (or another login) sees: an empty $0 paper account.
export function emptyView() {
  const f = fresh(0);
  return { ...f, settings: state.settings, equityNow: 0, roundTripCostPct: roundTripCostPct(), storage: store.kind, signedOut: true };
}

export function getState() {
  return { ...state, equityNow: equity(), roundTripCostPct: roundTripCostPct(), storage: store.kind };
}

// ---------- Broker ----------

export function buy(pair: PairInfo, usd: number, source: "manual" | "bot", reason: string, plan?: Partial<Position>, extraSlipPct = 0) {
  if (!(usd > 0)) throw new Error("Amount must be positive");
  if (usd > state.cash + 1e-9) throw new Error(`Not enough cash ($${state.cash.toFixed(2)} available)`);
  if (!(pair.priceUsd > 0)) throw new Error("No live price for this token");
  const { feePct, slippagePct } = state.settings;
  const feeUsd = usd * (feePct / 100);
  const platformFeeUsd = usd * (platformFeePct() / 100);
  const fillPrice = pair.priceUsd * (1 + (slippagePct + extraSlipPct) / 100);
  const qty = (usd - feeUsd - platformFeeUsd) / fillPrice;
  state.cash -= usd;
  const existing = state.positions.find((p) => p.pool === pair.pool && p.source === source);
  if (existing) {
    const totalQty = existing.qty + qty;
    existing.entryPrice = (existing.entryPrice * existing.qty + fillPrice * qty) / totalQty;
    existing.qty = totalQty;
    existing.costUsd += usd;
    Object.assign(existing, plan);
  } else {
    state.positions.push({ id: uid(), chain: pair.chain, pool: pair.pool, symbol: pair.symbol, qty, entryPrice: fillPrice, costUsd: usd, openedAt: Date.now(), source, lastPrice: pair.priceUsd, ...plan });
  }
  const t: Trade = { id: uid(), time: Date.now(), side: "BUY", symbol: pair.symbol, pool: pair.pool, price: fillPrice, qty, usd, feeUsd, platformFeeUsd, reason, source };
  state.trades.unshift(t);
  recTrade(t);
  if (state.trades.length > MAX_TRADES) state.trades.length = MAX_TRADES; // keep the newest only
  recordEquity();
  save();
  return t;
}

export function sell(positionId: string, price: number, fraction: number, reason: string) {
  const p = state.positions.find((x) => x.id === positionId);
  if (!p) throw new Error("Position not found");
  const f = Math.min(1, Math.max(0.01, fraction));
  const { feePct, slippagePct } = state.settings;
  const qty = p.qty * f;
  const fillPrice = price * (1 - (slippagePct + (p.extraSlipPct ?? 0)) / 100);
  const gross = qty * fillPrice;
  const feeUsd = gross * (feePct / 100);
  const platformFeeUsd = gross * (platformFeePct() / 100);
  const net = gross - feeUsd - platformFeeUsd;
  const costPart = p.costUsd * f;
  state.cash += net;
  p.qty -= qty;
  p.costUsd -= costPart;
  if (f >= 0.999 || p.qty * price < 0.01) {
    state.positions = state.positions.filter((x) => x.id !== p.id);
    state.orders = (state.orders ?? []).filter((o) => o.positionId !== p.id); // its limit sells go with it
  }
  else p.realizedUsd = (p.realizedUsd ?? 0) + (net - costPart);
  const t: Trade = { id: uid(), time: Date.now(), side: "SELL", symbol: p.symbol, pool: p.pool, price: fillPrice, qty, usd: net, feeUsd, pnlUsd: net - costPart, platformFeeUsd, reason, source: p.source };
  state.trades.unshift(t);
  recTrade(t);
  if (state.trades.length > MAX_TRADES) state.trades.length = MAX_TRADES;
  recordEquity();
  save();
  return t;
}

export function updateSettings(s: Partial<Settings>) {
  const next = { ...state.settings };
  if (s.feePct !== undefined) next.feePct = Number(s.feePct);
  if (s.slippagePct !== undefined) next.slippagePct = Number(s.slippagePct);
  if (s.continuous !== undefined) next.continuous = Boolean(s.continuous);
  if (!(next.feePct >= 0 && next.feePct <= 10 && next.slippagePct >= 0 && next.slippagePct <= 10)) throw new Error("Trading costs must be between 0 and 10%");
  state.settings = next;
  save();
}

export function reset(startCash: number) {
  acct().state = fresh(startCash);
  rec("account.reset", `Paper account reset to $${startCash.toFixed(2)}`, { startCash });
  save();
}

// ---------- AI signal (shared by UI and bot) ----------

// What Claude sees for each plan: zoomed in for timing, zoomed out for the bigger picture.
const PLAN_FRAMES: { tf: Timeframe; label: string; show: number }[] = [
  { tf: "5s", label: "5-second candles (last ~5 minutes): precise timing", show: 60 },
  { tf: "5m", label: "5-minute candles (last ~5 hours): today's swings, support and resistance", show: 60 },
  { tf: "1h", label: "1-hour candles (last ~2 days): the trend", show: 48 },
  { tf: "1d", label: "1-day candles (last ~month): the big picture", show: 30 },
];

export async function runAnalysis(chain: string, pool: string, tf: Timeframe, opts: { forBot?: boolean } = {}) {
  const pair = await getPair(chain, pool);
  // One timeframe at a time (CoinMarketCap allows ~1 request/second); skip any that fail,
  // e.g. no daily candles yet for a brand-new coin.
  const frames: Frame[] = [];
  for (const f of PLAN_FRAMES) {
    // Try twice: a free data source can briefly refuse (rate limit); don't silently drop a timeframe.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const candles = await getCandles(chain, pool, f.tf, 300, pair);
        if (candles.length) frames.push({ ...f, candles, snap: snapshot(candles) });
        break;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  const primary = frames.find((f) => f.tf === "5m" && f.snap) ?? frames.find((f) => f.snap);
  if (!primary?.snap) throw new Error("Not enough candle history for this token yet");
  const snap = primary.snap;
  // Downtrend on the 1-hour chart: fast average below slow average and price below the slow one.
  // Worked out BEFORE asking, so the AI knows which of its orders the bot is allowed to fill.
  const h1 = frames.find((f) => f.tf === "1h")?.snap;
  const trendDown = h1 ? h1.ema9 < h1.ema21 && h1.price < h1.ema21 : false;
  const cfg = state.bot.config;
  const maxDrop = cfg?.maxDrop1hPct ?? 10;
  const dipsBlocked = !cfg?.allowRisky && (trendDown || pair.change.h1 <= -maxDrop);
  const recent = state.trades.filter((t) => t.pool === pool && t.source === "bot" && t.side === "SELL").slice(0, 5);
  // The AI's own track record (all coins): predicted win chance vs what really happened.
  const scored = state.trades.filter((t) => t.source === "bot" && t.side === "SELL" && typeof t.predictedWinPct === "number").slice(0, 30);
  const record = scored.length >= 3
    ? (() => {
        const avgPred = scored.reduce((a, t) => a + t.predictedWinPct!, 0) / scored.length;
        const hit = (scored.filter((t) => t.reachedTarget).length / scored.length) * 100;
        const wins = scored.filter((t) => (t.pnlUsd ?? 0) > 0).length;
        const pnl = scored.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
        return `Your track record on the last ${scored.length} bot trades: you predicted on average ${avgPred.toFixed(0)}% win chance; the target was actually reached ${hit.toFixed(0)}% of the time; ${wins} of ${scored.length} closed in profit; total P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}.${hit < avgPred - 10 ? " Your win chances have been too optimistic: lower them, or plan closer targets / better entries." : ""}`;
      })()
    : "Not enough bot trades yet to score your past predictions.";
  const ex = {
    be: cfg?.breakEvenAtPct ?? 8,
    lock: cfg?.lockPct ?? 50,
    half: cfg?.partialAtPct ?? 75,
    trail: cfg?.trailPct ?? 3,
    minWin: cfg?.minConfidence ?? 45,
  };
  const context = [
    recent.length
      ? `Recent bot trades on this coin (newest first): ${recent.map((t) => `${new Date(t.time).toISOString().slice(11, 16)} UTC ${(t.pnlUsd ?? 0) >= 0 ? "+" : ""}$${(t.pnlUsd ?? 0).toFixed(2)} (${t.reason})`).join("; ")}.`
      : "No recent bot trades on this coin.",
    record,
    dipsBlocked
      ? `IMPORTANT: right now the bot will NOT fill buy_dip or buy_now orders (${trendDown ? "the 1-hour trend is down" : `the coin fell ${Math.abs(pair.change.h1).toFixed(1)}% in the last hour`}). Only a buy_breakout can be used; otherwise choose AVOID.`
      : `Dip and buy-now orders are allowed right now (the bot pauses them if the 1-hour trend turns down or the coin falls more than ${maxDrop}% in an hour).`,
    `Exact exit rules: once up ${ex.be}%, the stop moves to break-even, then a profit lock keeps at least ${ex.lock}% of the best gain; it sells half at ${ex.half}% of the way from entry to your target; at the target it trails ${ex.trail}% below the highest price. Orders with a win chance below ${ex.minWin}% are not used. After a losing trade it waits before re-buying, and skips the coin for the day after 2 losses.`,
  ].join("\n");
  if ((await tokensLeft()) <= 0) throw new Error("You've used this month's AI tokens for your plan. Upgrade your plan or wait for next month.");
  const { results, consensus } = await analyze(pair, frames, roundTripCostPct(), context, opts.forBot ? BOT_MODEL : undefined);
  const appTokens = await chargeTokens(results);
  const model = opts.forBot ? BOT_MODEL : CLAUDE_MODEL;
  const apiTokens = results.reduce((s, r) => s + (r.tokens ?? 0), 0);
  rec("ai.analysis", `${opts.forBot ? "Bot re-plan" : "AI analysis"} on ${pair.symbol}: ${apiTokens.toLocaleString()} AI tokens (${appTokens.toLocaleString()} app tokens)`, { symbol: pair.symbol, pool, model, apiTokens, appTokens, forBot: !!opts.forBot, stance: consensus.stance });
  state.lastSignal = { at: Date.now(), pool, symbol: pair.symbol, tf, results, consensus, trendDown };
  state.bot.armedSince = []; // a new plan: its triggers start fresh
  state.bot.skipNoted = [];
  save();
  return { pair, snapshot: snap, results, consensus };
}

// ---------- Bot ----------
// Locally a timer calls tick() every checkEverySec. On Vercel there are no
// long-lived timers, so /api/bot/heartbeat (from an open dashboard) and
// /api/bot/tick (from a scheduler) call it instead.


const isAuto = (cfg: BotConfig) => cfg.pick === "auto";
const isNew = (cfg: BotConfig) => cfg.pick === "newcoins";
// Extra slippage on thin liquidity: buying size S from a pool with liquidity L moves the
// price roughly 2*S/L (each side of the pool holds about half). Clamped to 0.2-10%.
const thinSlipPct = (usd: number, liquidityUsd: number) => Math.min(10, Math.max(0.2, (200 * usd) / Math.max(liquidityUsd, 1)));

export function startBot(cfg: BotConfig) {
  if (isAuto(cfg)) {
    cfg.autoChain ??= "all";
    cfg.autoCandidates = Math.min(5, Math.max(1, cfg.autoCandidates ?? 3));
    cfg.autoMinLiquidityUsd ??= 50_000;
  }
  rec("bot.start", `Bot started on ${cfg.symbol} (${cfg.pick === "auto" ? "auto-pick" : "this coin"})${cfg.allowRisky ? " in risky mode" : ""}`, {
    symbol: cfg.symbol, pool: cfg.pool, pick: cfg.pick ?? "this", positionPct: cfg.positionPct, riskPerTradePct: cfg.riskPerTradePct, minConfidence: cfg.minConfidence,
    dailyLossPct: cfg.dailyLossPct, maxDrawdownPct: cfg.maxDrawdownPct, allowRisky: !!cfg.allowRisky,
  });
  if (cfg.allowRisky)
    rec("consent.risky_mode", `Accepted "I understand, trade anyway" for ${cfg.symbol}`, {
      symbol: cfg.symbol,
      warningsShown: cfg.riskReasons ?? [],
      note: "In risky mode the bot buys even while the coin is falling and doesn't pause after losing trades on it. Exits, minimum win chance, the daily loss limit and the emergency stop still apply.",
    });
  state.bot.config = cfg;
  state.bot.running = true;
  state.bot.lastAnalysisAt = 0;
  state.bot.lastTickAt = 0;
  state.bot.target = null;
  state.bot.candidates = [];
  state.bot.armedSince = [];
  state.bot.askNow = false;
  state.bot.freshAfter = Date.now(); // never reuse a plan from before this start
  state.bot.startedAt = Date.now();
  state.bot.stoppedAt = null;
  cfg.trailPct = clampNum(cfg.trailPct ?? 3, 0.5, 30);
  log(
    isNew(cfg)
      ? `Bot started in NEW COINS mode (${cfg.newChain ?? "solana"}): ${cfg.newCoinPct ?? 3}% per coin, stop -${cfg.newStopPct ?? 15}%, half at +${cfg.newTakePct ?? 30}%, max ${cfg.newMaxPerDay ?? 5} buys a day. Cash $${state.cash.toFixed(2)}.`
      : isAuto(cfg)
      ? `Bot started in AUTO-PICK mode (${cfg.autoChain === "all" ? "all chains" : cfg.autoChain}). Each round the AI checks the top ${cfg.autoCandidates} coins. Cash $${state.cash.toFixed(2)}.`
      : `Bot started on ${cfg.symbol} (${cfg.tf}). Paper mode. Cash $${state.cash.toFixed(2)}.${cfg.allowRisky ? " RISKY MODE: it will also buy while the coin is falling and skip the cool-downs (you accepted the risk)." : ""}`,
    "good",
  );
  save();
  schedule();
}

export function stopBot(reason = "Stopped by user") {
  if (state.bot.running) rec("bot.stop", `Bot stopped: ${reason}`, { reason });
  state.bot.running = false;
  state.bot.stoppedAt = Date.now();
  state.bot.target = null;
  log(`Bot stopped: ${reason}`, "bad");
  save();
}

function schedule() {
  // Locally a single loop (bottom of this file) runs every active account every 5 s; on
  // Vercel, heartbeat / tick requests do. Run the first step right away.
  if (!process.env.VERCEL && state.bot.running && state.bot.config) void tick();
}

// Dashboard ping (every ~20 s while the page is open): watch for ~18 s.
export async function heartbeat() {
  return watch(18_000);
}

// Auto-pick: scan trending coins, ask Claude about the best few, choose the strongest BUY.
// ---------- Safety rules ----------
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";

// Write a log line only once per key (keys include a day / plan / loss time so they reset naturally).
function noteOnce(key: string, msg: string, level: "info" | "good" | "bad" = "info"): boolean {
  if (state.bot.noted[key]) return false;
  state.bot.noted[key] = Date.now();
  for (const [k, at] of Object.entries(state.bot.noted)) if (Date.now() - at > 2 * 86_400_000) delete state.bot.noted[k];
  log(msg, level);
  return true;
}

function setBlocked(reason: string | null, key?: string) {
  if (state.bot.blocked !== reason) acct().dirty = true;
  state.bot.blocked = reason;
  if (reason && key && noteOnce(key, `Not trading: ${reason}.`, "bad") && key.startsWith("daily:")) alert(`⛔ Daily loss limit: ${reason}.`);
}

// Daily loss limit: no new trades for the rest of the UTC day after losing this much since midnight.
function dailyBlock(cfg: BotConfig): string | null {
  const today = utcDay();
  if (!state.bot.day || state.bot.day.date !== today) {
    const prev = state.bot.day;
    if (prev) {
      // Daily summary for the day that just ended.
      const sells = state.trades.filter((t) => t.side === "SELL" && utcDay(t.time) === prev.date);
      const pnl = sells.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
      const change = ((equity() - prev.startEquity) / prev.startEquity) * 100;
      alert(`📊 Daily summary ${prev.date}: ${sells.length} closed trade${sells.length === 1 ? "" : "s"} (${sells.filter((t) => (t.pnlUsd ?? 0) > 0).length} profitable), P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}. Account $${equity().toFixed(2)} (${change >= 0 ? "+" : ""}${change.toFixed(1)}% on the day).`);
    }
    state.bot.day = { date: today, startEquity: equity() };
  }
  const limit = cfg.dailyLossPct ?? 10;
  if (state.bot.dailyOverride === today) return null; // the user chose to keep trading today
  const lostPct = ((state.bot.day.startEquity - equity()) / state.bot.day.startEquity) * 100;
  return lostPct >= limit ? `daily loss limit reached (down ${lostPct.toFixed(1)}% today, limit ${limit}%); resumes at 00:00 UTC` : null;
}

// Cool-down: after a loss, wait before re-buying the coin; after 2 losses in a row, skip it for the day.
function coinBlock(cfg: BotConfig, pool: string, symbol: string): string | null {
  if (cfg.allowRisky) return null; // the user chose to trade anyway
  const cs = state.bot.coinStats[pool];
  if (!cs || !cs.losses) return null;
  if (cs.losses >= 2 && cs.lossDay === utcDay()) return `${symbol} lost ${cs.losses} trades in a row today, so it's skipped until 00:00 UTC`;
  const until = cs.lastLossAt + (cfg.cooldownMin ?? 30) * 60_000;
  return Date.now() < until ? `cooling down on ${symbol} after a losing trade, until ${clock(until)}` : null;
}

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const MIN_CLAUDE_GAP_MS = 2 * 60_000; // never ask Claude more often than this, whatever happens
const fmt = (n: number) => `$${n.toPrecision(4)}`;

// Auto-pick: scan trending coins, ask Claude for a plan on the best few, keep the best plan.
async function autoPick(cfg: BotConfig) {
  const scan = await scanOpportunities(cfg.autoChain ?? "all", roundTripCostPct(), cfg.autoMinLiquidityUsd ?? 50_000);
  const inZone = scan.rows.filter((r) => r.plan?.verdict === "BUY ZONE" && !coinBlock(cfg, r.pair.pool, r.pair.symbol)).slice(0, cfg.autoCandidates ?? 3);
  state.bot.target = null;
  state.bot.candidates = [];
  state.lastSignal = null;
  if (!inZone.length) {
    log(`Scanned ${scan.rows.length} trending coins: none in the buy zone right now.`);
    return;
  }
  log(`Asking the AI for plans on ${inZone.map((r) => r.pair.symbol).join(", ")}...`);
  let best: { pair: PairInfo; result: Awaited<ReturnType<typeof runAnalysis>> } | null = null;
  const usableOrders = (c: Consensus) => c.orders.filter((o) => o.winChancePct >= cfg.minConfidence);
  const rank = (c: Consensus) => (c.stance === "BUY_NOW" ? 1000 : 0) + Math.max(...usableOrders(c).map((o) => o.evPct));
  for (const row of inZone) {
    // One at a time, so CoinMarketCap's small allowance isn't used up in a burst.
    try {
      const r = await runAnalysis(row.pair.chain, row.pair.pool, cfg.tf, { forBot: true });
      const c = r.consensus;
      state.bot.candidates.push({ symbol: row.pair.symbol, chain: row.pair.chain, pool: row.pair.pool, action: c.stance === "WAIT_FOR_TRIGGER" ? "WAIT" : c.action, confidence: c.confidence, note: c.note });
      const usable = usableOrders(c).length > 0;
      if (usable && (!best || rank(c) > rank(best.result.consensus))) best = { pair: row.pair, result: r };
    } catch (e: any) {
      state.bot.candidates.push({ symbol: row.pair.symbol, chain: row.pair.chain, pool: row.pair.pool, action: "ERROR", confidence: 0, note: String(e?.message ?? e) });
    }
  }
  const summary = state.bot.candidates.map((c) => `${c.symbol} ${c.action}${c.confidence ? ` ${c.confidence}%` : ""}`).join(", ");
  state.lastSignal = null;
  if (!best) {
    log(`AI: ${summary}. No usable plan yet.`);
    return;
  }
  const { pair, result } = best;
  state.bot.target = { chain: pair.chain, pool: pair.pool, symbol: pair.symbol, chosenAt: Date.now() };
  state.lastSignal = { at: Date.now(), pool: pair.pool, symbol: pair.symbol, tf: cfg.tf, results: result.results, consensus: result.consensus };
  log(`Auto-pick chose ${pair.symbol}. AI: ${summary}. ${result.consensus.note}`, "good");
}

// Why Claude should be asked now (or null). Event-driven, plus a slow backup timer.
function claudeDue(cfg: BotConfig, price: number | null): string | null {
  const sig = state.lastSignal;
  const tgtPool = isAuto(cfg) ? state.bot.target?.pool : cfg.pool;
  if (state.bot.askNow) return "the last trade closed";
  if (!sig || !tgtPool || sig.pool !== tgtPool) return state.bot.lastAnalysisAt ? "no plan to follow" : "starting up";
  const c = sig.consensus;
  if (Date.now() > c.expiresAt) return "the plan expired";
  if (price !== null && c.cancelBelow > 0 && price < c.cancelBelow) return `the price fell below the plan's cancel level (${fmt(c.cancelBelow)})`;
  if (price !== null && c.cancelAbove > 0 && price > c.cancelAbove) return `the price rose above the plan's range (${fmt(c.cancelAbove)})`;
  if (Date.now() - state.bot.lastAnalysisAt >= cfg.analyzeEverySec * 1000) return "backup re-check";
  return null;
}

// ---------- Price checks (every 5 seconds) ----------
// Each check looks at the 5-second candles since the last check, so a brief dip
// or spike between checks still counts, the way a real limit/stop order would fill.
export const CHECK_MS = 5_000;
// low/high: the range touched since the last check (for dip/breakout triggers, targets, stops).
// peakHigh: the highest *closing* price in that window, used to move trailing stops up.
// A single bad tick can print a wick far from the real price (SEPPUKU once showed a
// $0.039 "high" while it traded at $0.012), so wicks are capped near the live price and
// trailing stops follow closes, never a lone wick.
type Quote = { pair: PairInfo; price: number; low: number; high: number; peakHigh: number; closeLow: number; source: string };
const MAX_WICK = 0.15; // ignore any high/low more than 15% beyond both live prices

async function quote(chain: string, pool: string, sinceMs: number): Promise<Quote> {
  // Fetch the live price and the 5-second candles at the same time (token is known
  // after the first lookup), so a check takes one network round-trip, not two.
  const token = knownToken(pool);
  const candlesP = token ? getRecentTokenCandles(chain, token).catch(() => null) : null;
  const pair = await getPair(chain, pool);
  let price = pair.priceUsd, low = price, high = price, peakHigh = price, closeLow = price, source = "DexScreener";
  try {
    if (pair.tokenAddress) {
      const candles = (candlesP && pair.tokenAddress === token ? await candlesP : null) ?? (await getRecentTokenCandles(chain, pair.tokenAddress));
      const last = candles.at(-1);
      const nowS = Date.now() / 1000;
      // Use CoinMarketCap only if it's current and agrees with this pool's price.
      if (last && nowS - last.time < 30 && price > 0 && Math.abs(last.close - price) / price < 0.1) {
        const recent = candles.filter((c) => c.time + 5 > sinceMs / 1000); // candles overlapping the window
        const dex = price;
        price = last.close;
        const refHi = Math.max(price, dex), refLo = Math.min(price, dex);
        low = Math.max(Math.min(price, ...recent.map((c) => c.low)), refLo * (1 - MAX_WICK));
        high = Math.min(Math.max(price, ...recent.map((c) => c.high)), refHi * (1 + MAX_WICK));
        peakHigh = Math.min(Math.max(price, ...recent.map((c) => c.close)), high);
        closeLow = Math.max(Math.min(price, ...recent.map((c) => c.close)), low);
        source = "CoinMarketCap 5s candles";
      }
    }
  } catch {
    // fall back to the DexScreener snapshot
  }
  return { pair: { ...pair, priceUsd: price }, price, low, high, peakHigh, closeLow, source };
}

// Was this standing order's trigger touched since the last check?
function triggerMet(o: CheckedOrder, q: Quote) {
  if (o.kind === "buy_dip" || o.kind === "buy_now") return q.low <= o.triggerPrice;
  // breakout: price went above the trigger, and (if asked) recent volume above normal
  if (q.high < o.triggerPrice) return false;
  if (!o.minVolumeRatio) return true;
  const hourlyAvg5m = (q.pair.volume1h ?? 0) / 12;
  return hourlyAvg5m > 0 && (q.pair.volume5m ?? 0) / hourlyAvg5m >= o.minVolumeRatio;
}

// Fill price like a real order: a dip (limit) order fills at its price or better;
// a breakout (stop-buy) fills at its price or worse.
function buyFillPrice(o: CheckedOrder, q: Quote) {
  return o.kind === "buy_breakout" ? Math.max(o.triggerPrice, q.price) : Math.min(o.triggerPrice, q.price);
}

// New coins mode: one fast, rule-based step (no AI). Picks the best young coin that
// passes the rug-risk checks and entry rules, buys a small amount at the live price.
const unpriceable = new Map<string, number>(); // pool -> skip until (no live price available yet)

async function newCoinsStep(cfg: BotConfig) {
  const today = utcDay();
  const boughtToday = state.trades.filter((t) => t.strategy === "newcoin" && t.side === "BUY" && utcDay(t.time) === today).length;
  const maxPerDay = cfg.newMaxPerDay ?? 5;
  if (boughtToday >= maxPerDay) return setBlocked(`new-coin limit reached (${boughtToday} buys today, max ${maxPerDay}); resumes at 00:00 UTC`, `newcap:${today}`);
  setBlocked(null);
  const list = await scanNewCoins(cfg.newChain ?? "solana"); // cached 60 s
  for (const [pool, until] of unpriceable) if (until < Date.now()) unpriceable.delete(pool);
  // One shot per coin per day: never re-buy a new coin the bot already traded today
  // (after a win that would be chasing the pump; after a loss, repeating the mistake).
  const tradedToday = new Set(state.trades.filter((t) => t.strategy === "newcoin" && utcDay(t.time) === today).map((t) => t.pool));
  const pick = list.find((c) => c.tradeable && !tradedToday.has(c.pair.pool) && !unpriceable.has(c.pair.pool) && !coinBlock(cfg, c.pair.pool, c.pair.symbol) && !state.positions.some((p) => p.pool === c.pair.pool));
  if (!pick) {
    state.bot.target = null;
    return;
  }
  state.bot.target = { chain: pick.pair.chain, pool: pick.pair.pool, symbol: pick.pair.symbol, chosenAt: Date.now() };
  let q: Quote;
  try {
    q = await quote(pick.pair.chain, pick.pair.pool, Date.now() - 10_000);
    if (!(q.price > 0)) throw new Error("no price");
  } catch {
    unpriceable.set(pick.pair.pool, Date.now() + 30 * 60_000); // not listed for live prices yet: skip it for a while
    return;
  }
  const usd = Math.floor(Math.min((equity() * (cfg.newCoinPct ?? 3)) / 100, state.cash) * 100) / 100;
  if (usd < 1) {
    noteOnce(`newcash:${today}`, "New coins: not enough cash for another position.", "bad");
    return;
  }
  const slip = thinSlipPct(usd, pick.pair.liquidityUsd);
  const stopPct = cfg.newStopPct ?? 15, takePct = cfg.newTakePct ?? 30;
  const t = buy({ ...q.pair, priceUsd: q.price }, usd, "bot", `New coin (${pick.risk} risk, ${pick.ageMin} min old)`, {
    stopLoss: q.price * (1 - stopPct / 100),
    target: q.price * (1 + takePct / 100),
    takeProfit: q.price * (1 + takePct / 100),
    trailPct: cfg.newTrailPct ?? 10,
    sellBy: Date.now() + (cfg.newMaxMin ?? 45) * 60_000,
    strategy: "newcoin",
    extraSlipPct: slip,
  }, slip);
  t.strategy = "newcoin";
  const msg = `NEW COIN BUY ${pick.pair.symbol} $${usd.toFixed(2)} @ ${fmt(t.price)} (${pick.risk} risk, ${pick.ageMin} min old, liquidity $${Math.round(pick.pair.liquidityUsd / 1000)}K, +${slip.toFixed(1)}% thin-liquidity slippage). Stop -${stopPct}%, half at +${takePct}%, sells within ${cfg.newMaxMin ?? 45} min.`;
  log(msg, "good");
  alert(`🚀 ${msg}`);
}

const lockNoted = new Map<string, number>();
function noteKey(pos: Position, gainPct: number) {
  const step = Math.floor(gainPct / 5);
  if ((lockNoted.get(pos.id) ?? -1) >= step) return false;
  lockNoted.set(pos.id, step);
  return true;
}

export async function tick(persist = true) {
  const cfg = state.bot.config;
  if (!state.bot.running || !cfg || acct().busy) return;
  acct().busy = true;
  // Look at candles since the previous check (at most the last minute).
  const windowStart = Math.max(Date.now() - 60_000, (state.bot.lastTickAt || Date.now()) - CHECK_MS);
  state.bot.lastTickAt = Date.now();
  try {
    // 1. Manage an open bot position (every check, no AI cost).
    const pos = state.positions.find((p) => p.source === "bot");
    if (pos) {
      const q = await quote(pos.chain, pos.pool, Math.max(pos.openedAt, windowStart));
      const price = q.price;
      pos.lastPrice = price;
      recordEquity();
      if (checkDrawdown(cfg)) return;
      const gainPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      const cost = roundTripCostPct();
      // Lock in a no-loss exit once the trade is far enough in profit
      // (new coins swing too hard for this: only after their half-profit sale).
      if (gainPct >= Math.max(cfg.breakEvenAtPct, cost * 1.5) && (pos.strategy !== "newcoin" || pos.partialDone)) {
        const be = pos.entryPrice * (1 + cost / 100);
        if (!pos.stopLoss || pos.stopLoss < be) {
          pos.stopLoss = be;
          log(`${pos.symbol} up ${gainPct.toFixed(1)}%: stop moved to break-even after fees (${fmt(be)}).`, "good");
        }
      }
      // Profit lock: once the best gain reaches the break-even level, the stop follows it up
      // so the trade keeps at least lockPct% of its best gain (judged on closing prices).
      const lockPct = cfg.lockPct ?? 50;
      let newBestThisCheck = false;
      if (q.peakHigh > (pos.best ?? pos.entryPrice)) {
        pos.best = q.peakHigh;
        newBestThisCheck = true;
      }
      const best = pos.best ?? pos.entryPrice;
      const bestGainPct = ((best - pos.entryPrice) / pos.entryPrice) * 100;
      if (lockPct > 0 && bestGainPct >= Math.max(cfg.breakEvenAtPct, cost * 1.5) && (pos.strategy !== "newcoin" || pos.partialDone)) {
        const be = pos.entryPrice * (1 + cost / 100);
        const lock = Math.max(be, pos.entryPrice + (best - pos.entryPrice) * (lockPct / 100));
        if (!pos.stopLoss || lock > pos.stopLoss * 1.001) {
          pos.stopLoss = lock;
          pos.locked = lock > be;
          acct().dirty = true;
          if (pos.locked && noteKey(pos, bestGainPct)) // first lock, then every +5% of best gain
            log(`${pos.symbol} best gain +${bestGainPct.toFixed(1)}%: profit lock raised to ${fmt(lock)} (keeps at least ${lockPct}% of the gain).`, "good");
        }
      }
      // Take half before the target: targets often sit at resistance, where a run can stall.
      const partialAt = cfg.partialAtPct ?? 75;
      if (pos.strategy !== "newcoin" && partialAt > 0 && !pos.partialDone && pos.target && pos.target > pos.entryPrice) {
        const level = pos.entryPrice + (pos.target - pos.entryPrice) * (partialAt / 100);
        const be = pos.entryPrice * (1 + cost / 100);
        if (level > be && q.high >= level) {
          const t = sell(pos.id, Math.max(level, price), 0.5, `Took half ${partialAt}% of the way to the target`);
          pos.partialDone = true;
          if (!pos.stopLoss || pos.stopLoss < be) pos.stopLoss = be; // the rest can't turn into a loss
          log(`${pos.symbol}: sold half @ ${fmt(t.price)} (P&L +$${t.pnlUsd!.toFixed(2)}), ${partialAt}% of the way to the ${fmt(pos.target)} target. The rest rides with the profit lock.`, "good");
          alert(`💰 ${pos.symbol}: sold half @ ${fmt(t.price)}, +$${t.pnlUsd!.toFixed(2)}. Riding the rest.`);
          return;
        }
      }
      // New coins: at the first target sell half (like a limit order), then trail the rest.
      if (pos.strategy === "newcoin" && !pos.partialDone && pos.target && q.high >= pos.target) {
        const t = sell(pos.id, Math.max(pos.target, price), 0.5, `New coin: half sold at +${cfg.newTakePct ?? 30}%`);
        t.strategy = "newcoin";
        pos.partialDone = true;
        pos.trailing = true;
        pos.peak = q.peakHigh;
        log(`${pos.symbol}: sold half @ ${fmt(t.price)} (P&L +$${t.pnlUsd!.toFixed(2)}); trailing the rest ${pos.trailPct}% below its high.`, "good");
        alert(`🚀 ${pos.symbol}: sold half @ ${fmt(t.price)}, +$${t.pnlUsd!.toFixed(2)}. Riding the rest.`);
        return;
      }
      // At the target, don't sell yet: ride it with a trailing stop.
      const trail = pos.trailPct ?? cfg.trailPct ?? 3;
      let newHighThisCheck = false;
      if (!pos.trailing && pos.target && q.high >= pos.target) {
        pos.trailing = true;
        pos.peak = Math.max(pos.target, q.peakHigh);
        newHighThisCheck = true;
        log(`${pos.symbol} hit its target ${fmt(pos.target)}: now riding it, selling if it falls ${trail}% from its high.`, "good");
      }
      if (pos.trailing && q.peakHigh > (pos.peak ?? 0)) {
        pos.peak = q.peakHigh;
        newHighThisCheck = true;
        acct().dirty = true; // the high matters for the trailing stop; keep it saved
      }
      const trailStop = pos.trailing && pos.peak ? pos.peak * (1 - trail / 100) : 0;
      // Stops sell like real stop orders: at the stop price if the price touched it,
      // or at the current price if it has already fallen further.
      let reason = "";
      let sellAt = price;
      // If the high was set in this same check we can't tell whether the low came
      // before or after it, so judge the trailing stop on the latest price instead.
      // Trailing stops (like their highs) go by closing prices, so one bad tick can't end a trade.
      const trailLow = newHighThisCheck ? price : q.closeLow;
      if (pos.trailing && trailLow <= trailStop) {
        reason = `Trailing stop: fell ${trail}% from its high of ${fmt(pos.peak!)}`;
        sellAt = Math.min(trailStop, price);
      } else if (pos.stopLoss && (pos.stopLoss >= pos.entryPrice ? (newBestThisCheck ? price : q.closeLow) : q.low) <= pos.stopLoss) {
        reason = pos.locked ? `Profit lock: kept part of the best gain (+${bestGainPct.toFixed(1)}%)` : pos.stopLoss >= pos.entryPrice ? "Break-even stop hit" : "Stop-loss hit";
        sellAt = Math.min(pos.stopLoss, price);
      } else if (pos.sellBy && Date.now() > pos.sellBy) reason = "Maximum holding time reached";
      else if (!pos.target && pos.takeProfit && q.high >= pos.takeProfit) {
        reason = "Take-profit hit"; // positions from before trailing stops
        sellAt = Math.max(pos.takeProfit, price);
      }
      if (reason) {
        const t = sell(pos.id, sellAt, 1, reason);
        if (pos.strategy) t.strategy = pos.strategy;
        t.predictedWinPct = pos.predictedWinPct;
        t.reachedTarget = Boolean(pos.trailing); // trailing only starts once the target was reached
        const cs = (state.bot.coinStats[pos.pool] ??= { losses: 0, lastLossAt: 0, lossDay: utcDay() });
        if (t.pnlUsd! < 0) {
          cs.losses = cs.lossDay === utcDay() ? cs.losses + 1 : 1;
          cs.lastLossAt = Date.now();
          cs.lossDay = utcDay();
        } else cs.losses = 0;
        log(`SELL ${pos.symbol} @ ${fmt(t.price)}: ${reason}. P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}`, t.pnlUsd! >= 0 ? "good" : "bad");
        alert(`${t.pnlUsd! >= 0 ? "✅" : "🔻"} Sold ${pos.symbol} @ ${fmt(t.price)}: ${reason}. P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}. Account $${equity().toFixed(2)}.`);
        // Ask for a fresh plan right away; no new trade until it arrives.
        state.lastSignal = null;
        state.bot.freshAfter = Date.now();
        state.bot.armedSince = [];
        state.bot.askNow = true;
        if (isAuto(cfg)) state.bot.target = null;
        // One trade at a time (the default): stop after a profitable round trip.
        const total = t.pnlUsd! + (pos.realizedUsd ?? 0);
        if (total > 0 && !state.settings.continuous) {
          stopBot(`Done: one profitable trade (+$${total.toFixed(2)}). Start it again for another, or turn on "Trade continuously" in Settings.`);
          alert(`⏹ Bot stopped after a profitable trade (+$${total.toFixed(2)}). Account $${equity().toFixed(2)}.`);
        }
      }
      return;
    }

    recordEquity();
    if (checkDrawdown(cfg)) return;
    if (equity() >= cfg.goalUsd) noteOnce(`goal:${utcDay()}`, `Goal of $${cfg.goalUsd} reached (equity $${equity().toFixed(2)}). Consider raising the goal.`, "good");

    // 2. Safety rules: daily loss limit for the whole account, cool-down per coin.
    const daily = dailyBlock(cfg);
    if (daily) {
      const k = `auditpause:${utcDay()}`;
      if (!state.bot.noted[k]) {
        state.bot.noted[k] = Date.now();
        rec("bot.pause", `Bot paused: ${daily}`, { rule: "daily_loss_limit" });
      }
      return setBlocked(daily, `daily:${utcDay()}`);
    }
    if (isNew(cfg)) return await newCoinsStep(cfg);
    if (isAuto(cfg) && state.bot.target && coinBlock(cfg, state.bot.target.pool, state.bot.target.symbol)) {
      state.bot.target = null; // pick another coin
      state.lastSignal = null;
    }
    const tgt = isAuto(cfg) ? state.bot.target : { chain: cfg.chain, pool: cfg.pool, symbol: cfg.symbol };
    const coin = tgt ? coinBlock(cfg, tgt.pool, tgt.symbol) : null;
    if (coin) return setBlocked(coin, `coin:${tgt!.pool}:${state.bot.coinStats[tgt!.pool]?.lastLossAt}`);
    setBlocked(null);
    // Only count price moves after the current plan was made.
    const planSince = () => Math.max(windowStart, state.lastSignal?.at ?? 0);
    let q = tgt ? await quote(tgt.chain, tgt.pool, planSince()) : null;

    // 3. Ask AI only when something calls for it (never more than once per 2 min).
    const why = claudeDue(cfg, q?.price ?? null);
    let askedAt = 0;
    if (why && (await tokensLeft()) <= 0) {
      noteOnce(`tokens:${month()}`, "Out of AI tokens for this month on your plan: the bot can't make new plans. Open positions are still managed. Upgrade your plan to keep the bot trading.", "bad");
      return;
    }
    if (why && Date.now() - state.bot.lastAnalysisAt >= MIN_CLAUDE_GAP_MS) {
      // Save "asked Claude at ..." BEFORE the slow, paid call, so no other
      // request or server decides a check is due and asks again meanwhile.
      state.bot.lastAnalysisAt = Date.now();
      askedAt = state.bot.lastAnalysisAt;
      state.bot.askNow = false;
      state.bot.armedSince = [];
      state.bot.skipNoted = [];
      log(`Asking the AI for a new plan (${why})...`);
      save();
      await flush();
      if (isAuto(cfg)) {
        await autoPick(cfg);
      } else {
        const { consensus, results } = await runAnalysis(cfg.chain, cfg.pool, cfg.tf, { forBot: true });
        for (const f of results) if (!f.ok) log(`The AI failed: ${f.error}`, "bad");
        log(`Plan: ${consensus.stance.replace(/_/g, " ")} (${consensus.confidence}% sure). ${consensus.note}`);
      }
      const t2 = isAuto(cfg) ? state.bot.target : tgt;
      q = t2 ? await quote(t2.chain, t2.pool, planSince()) : null;
    } else if (why) {
      // A new plan is due but the AI was asked less than 2 minutes ago: wait for it
      // rather than trade on the old plan.
      const waitS = Math.ceil((state.bot.lastAnalysisAt + MIN_CLAUDE_GAP_MS - Date.now()) / 1000);
      noteOnce(`wait:${state.bot.lastAnalysisAt}`, `Waiting for a fresh AI plan before the next trade (${why}); asking in about ${waitS}s.`);
      return;
    }

    // 4. Carry out the plan's standing orders, checked every 5 seconds.
    const sig = state.lastSignal;
    const t3 = isAuto(cfg) ? state.bot.target : tgt;
    if (!q || !t3 || !sig || sig.pool !== t3.pool) return;
    // Only trade on a plan made after the bot started / the last trade closed / this ask.
    if (sig.at < Math.max(state.bot.freshAfter ?? 0, askedAt)) return;
    const pair = q.pair;
    const c = sig.consensus;
    if (!c.orders.length || Date.now() > c.expiresAt) return;
    // The AI advised staying out: its risky setup is only traded if the user accepted the risk.
    if (c.stance === "AVOID" && !cfg.allowRisky)
      return noteOnce(`avoid:${sig.at}`, `The AI advises staying out of ${t3.symbol}, so its risky setup isn't traded. Start the bot and choose "I understand, trade anyway" to trade it.`), undefined;
    for (let i = 0; i < c.orders.length; i++) {
      const o = c.orders[i];
      // Setups that fail the fee/risk check are shown as warnings; traded only in risky mode.
      if (o.warning && !cfg.allowRisky) continue;
      const label = o.kind === "buy_dip" ? `dip to ${fmt(o.triggerPrice)}` : o.kind === "buy_breakout" ? `breakout above ${fmt(o.triggerPrice)}` : `buy-now order (up to ${fmt(o.triggerPrice)})`;
      // Orders below the user's minimum win chance are never used, but say so when their trigger is hit.
      // Trend filter: a crash is not a dip.
      if (o.kind !== "buy_breakout") {
        const drop = pair.change.h1;
        const maxDrop = cfg.maxDrop1hPct ?? 10;
        if (!cfg.allowRisky && (sig.trendDown || drop <= -maxDrop)) {
          if (triggerMet(o, q))
            noteOnce(`trend:${sig.at}:${i}`, `${t3.symbol} reached the ${label}, but it's falling (${sig.trendDown ? "1-hour trend is down" : `${drop.toFixed(1)}% in the last hour`}), so dip orders are paused. A crash is not a dip.`);
          continue;
        }
      }
      if (o.winChancePct < cfg.minConfidence) {
        if (triggerMet(o, q) && !state.bot.skipNoted[i]) {
          state.bot.skipNoted[i] = true;
          log(`${t3.symbol} reached the ${label} (touched ${fmt(o.kind === "buy_breakout" ? q.high : q.low)}), but the AI gives it only a ${o.winChancePct}% win chance, below your ${cfg.minConfidence}% minimum. Not buying.`);
        }
        continue;
      }
      if (!triggerMet(o, q)) {
        if (state.bot.armedSince[i]) log(`${t3.symbol} ${label} didn't hold (now ${fmt(pair.priceUsd)}); still waiting.`);
        state.bot.armedSince[i] = null;
        continue;
      }
      // By default buy the instant the trigger is hit; optionally wait for it to hold.
      const holdSec = cfg.waitForHold ? o.confirmSeconds : 0;
      if (!state.bot.armedSince[i]) {
        state.bot.armedSince[i] = Date.now();
        if (holdSec > 0) {
          log(`${t3.symbol} reached the ${label} at ${fmt(pair.priceUsd)}; buying if it holds for ${holdSec}s.`);
          continue;
        }
      }
      if (Date.now() - state.bot.armedSince[i]! < holdSec * 1000) continue;

      // Size: positionPct of the account (never more than the cash on hand). With a risk per
      // trade set, it may be smaller: hitting the exit then loses about riskPerTradePct of the
      // account (exit distance plus round-trip costs). Risk 0 = always use positionPct.
      const riskPct = cfg.riskPerTradePct ?? 1.5;
      const exitLossPct = ((o.triggerPrice - o.stopLoss) / o.triggerPrice) * 100 + roundTripCostPct();
      const bySize = riskPct > 0 ? (equity() * riskPct) / 100 / (exitLossPct / 100) : Infinity;
      const cap = Math.min(state.cash, equity() * (cfg.positionPct / 100));
      const usd = Math.floor(Math.min(cap, bySize) * 100) / 100;
      if (usd < 1) return log("Not enough cash to open a position.", "bad");
      const riskUsd = usd * (exitLossPct / 100);
      // Fill like a real order at the trigger price (or better/worse, see buyFillPrice).
      const t = buy({ ...pair, priceUsd: buyFillPrice(o, q) }, usd, "bot", `AI plan: ${label}`, {
        stopLoss: o.stopLoss,
        target: o.target,
        takeProfit: o.target,
        trailPct: cfg.trailPct ?? 3,
        sellBy: Date.now() + o.maxHoldMinutes * 60_000,
        predictedWinPct: o.winChancePct,
      });
      log(`BUY ${pair.symbol} $${usd.toFixed(2)} @ ${fmt(t.price)} (${label}). Exit below ${fmt(o.stopLoss)} (risking about $${riskUsd.toFixed(2)}, ${((riskUsd / equity()) * 100).toFixed(1)}% of the account); at ${fmt(o.target)} it starts trailing.`, "good");
      alert(`🤖 Bought ${pair.symbol}: $${usd.toFixed(2)} @ ${fmt(t.price)} (${label}). Exit below ${fmt(o.stopLoss)}, target ${fmt(o.target)}. Risking ~$${riskUsd.toFixed(2)}.`);
      // The plan is used up; Claude plans again after this trade closes.
      state.lastSignal = { ...sig, consensus: { ...c, orders: [], note: "Plan used for an entry." } };
      state.bot.armedSince = [];
      return;
    }
  } catch (e: any) {
    log(`Tick error: ${e?.message ?? e}`, "bad");
  } finally {
    acct().busy = false;
    if (persist || acct().dirty) save();
  }
}

// True while there's something to watch closely: an open bot position, a plan
// to fetch, or standing orders waiting to fill.
function watching() {
  if (hasProtected()) return true;
  const cfg = state.bot.config;
  if (!state.bot.running || !cfg) return false;
  if (state.positions.some((p) => p.source === "bot")) return true;
  if (state.bot.askNow) return true;
  const sig = state.lastSignal;
  const tgtPool = isAuto(cfg) ? state.bot.target?.pool : cfg.pool;
  // Only orders with at least the user's minimum win chance count.
  return Boolean(tgtPool && sig && sig.pool === tgtPool && sig.consensus.orders.some((o) => o.winChancePct >= cfg.minConfidence) && Date.now() < sig.consensus.expiresAt);
}

// Serverless: run bot steps every 5 seconds for up to maxMs (one scheduler call or
// dashboard ping keeps watch for a while). A lock stops two windows overlapping.
// Stops early when there's nothing to watch.
export async function watch(maxMs: number, by: "scheduler" | "dashboard" = "dashboard") {
  const botOn = () => state.bot.running && !!state.bot.config;
  if (!botOn() && !hasProtected()) return { ticks: 0, reason: "bot is off" };
  const lockName = `watch:${acct().key ?? "-"}`;
  if (!(await store.lock(lockName, maxMs + 10_000))) return { ticks: 0, reason: "another window is already watching" };
  // Record the wake-up (one small write per window) so the dashboard can show the bot is alive.
  state.bot.lastWatch = { at: Date.now(), by };
  save(); // also makes sure this account is on the scheduler's list
  let ticks = 0;
  try {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      // Reload first, so a Stop or manual trade from the dashboard is never overwritten.
      await sync();
      if (!botOn() && !hasProtected()) break;
      if (botOn()) await tick(false); // saves only if something happened
      await guardProtected();
      ticks++;
      await flush();
      if (!watching()) break; // nothing to watch closely; the next scheduled check will come
      await new Promise((r) => setTimeout(r, CHECK_MS));
    }
    return { ticks, reason: botOn() || hasProtected() ? (watching() ? "window ended" : "nothing to watch") : "bot stopped" };
  } finally {
    await flush();
    await store.unlock(lockName);
  }
}

// The scheduler's wake-up: watch every account that has a bot running, protected trades or
// limit orders, side by side.
export async function watchAll(maxMs: number, by: "scheduler" | "dashboard" = "scheduler") {
  await ensureMigrated();
  const keys = await activeAccounts();
  const results = await Promise.all(
    keys.map((k) =>
      withAccount(k, async () => {
        await sync();
        const r = await watch(maxMs, by);
        await flush();
        return { key: k, ...r };
      }).catch((e) => ({ key: k, ticks: 0, reason: `error: ${e?.message ?? e}` })),
    ),
  );
  return { accounts: keys.length, results };
}

// ---------- "Protect this trade" (manual positions) ----------
// Anything to watch with the bot off: protected manual trades or open limit orders.
const hasProtected = () => state.positions.some((p) => p.protectPct) || (state.orders?.length ?? 0) > 0;

export async function protectPosition(positionId: string, pct: number) {
  const p = state.positions.find((x) => x.id === positionId);
  if (!p) throw new Error("Position not found");
  rec("trade.protect", pct ? `Protect this trade on ${p.symbol}: sell if it falls ${pct}% from its high` : `Removed protection on ${p.symbol}`, { positionId, pct });
  if (p.source !== "manual") throw new Error("The bot already manages its own trades");
  if (!pct) {
    delete p.protectPct;
    delete p.protectSince;
    delete p.peak;
    log(`Protection removed from ${p.symbol}.`);
    save();
    return p;
  }
  if (!(pct >= 0.5 && pct <= 50)) throw new Error("Use a trailing % between 0.5 and 50");
  p.lastPrice = (await getPair(p.chain, p.pool)).priceUsd;
  p.protectPct = pct;
  p.protectSince = Date.now();
  p.peak = Math.max(p.lastPrice, p.peak ?? 0);
  log(`Protecting ${p.symbol}: sells if it falls ${pct}% from its high (now ${fmt(p.lastPrice)}, sells below ${fmt(p.peak * (1 - pct / 100))}).`, "good");
  save();
  return p;
}

// Checks every protected manual position: raises its high, sells on a pullback.
export async function guardProtected() {
  if (acct().guarding || !hasProtected()) return;
  await checkLimitOrders();
  if (!state.positions.some((p) => p.protectPct)) return;
  acct().guarding = true;
  let changed = false;
  try {
    for (const p of state.positions.filter((x) => x.protectPct)) {
      const q = await quote(p.chain, p.pool, Math.max(Date.now() - 60_000, p.protectSince ?? 0));
      p.lastPrice = q.price;
      if (q.peakHigh > (p.peak ?? 0)) {
        p.peak = q.peakHigh;
        changed = true;
      }
      const stop = p.peak! * (1 - p.protectPct! / 100);
      if (q.closeLow <= stop) { // by closing prices: one bad tick can't trigger it
        const gain = ((Math.min(stop, q.price) - p.entryPrice) / p.entryPrice) * 100;
        const t = sell(p.id, Math.min(stop, q.price), 1, `Protection: fell ${p.protectPct}% from its high of ${fmt(p.peak!)}`);
        t.auto = true;
        log(`PROTECTED SELL ${p.symbol} @ ${fmt(t.price)}: fell ${p.protectPct}% from its high of ${fmt(p.peak!)} (${gain >= 0 ? "+" : ""}${gain.toFixed(1)}% from your buy). P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}`, t.pnlUsd! >= 0 ? "good" : "bad");
        alert(`🛡 Protection sold ${p.symbol} @ ${fmt(t.price)} (fell ${p.protectPct}% from its high). P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}.`);
        changed = true;
      }
    }
  } catch (e: any) {
    log(`Protection check error: ${e?.message ?? e}`, "bad");
  } finally {
    acct().guarding = false;
    if (changed) save();
  }
}

// ---------- Limit orders (manual) ----------

const MAX_ORDERS = 10;

export function placeOrder(body: { side?: string; chain?: string; pool?: string; symbol?: string; price?: number; usd?: number; positionId?: string; fraction?: number }) {
  const side = body.side === "SELL" ? "SELL" : body.side === "BUY" ? "BUY" : null;
  const price = Number(body.price);
  if (!side) throw new Error("Choose buy or sell");
  if (!(price > 0)) throw new Error("Enter a price above 0");
  if (state.orders.length >= MAX_ORDERS) throw new Error(`You can have up to ${MAX_ORDERS} open orders. Cancel one first.`);
  let o: LimitOrder;
  if (side === "BUY") {
    const usd = Math.floor(Number(body.usd) * 100) / 100;
    if (!(usd >= 1)) throw new Error("Enter at least $1 to buy");
    if (usd > state.cash + 0.005) throw new Error(`Not enough cash (you have $${state.cash.toFixed(2)})`);
    if (!body.chain || !body.pool) throw new Error("Pick a coin first");
    o = { id: uid(), side, chain: body.chain, pool: body.pool, symbol: String(body.symbol ?? "?"), price, usd, createdAt: Date.now() };
  } else {
    const p = state.positions.find((x) => x.id === body.positionId);
    if (!p) throw new Error("You don't hold this coin");
    if (p.source !== "manual") throw new Error("The bot manages its own trades");
    const fraction = Math.min(1, Math.max(0.01, Number(body.fraction ?? 1)));
    o = { id: uid(), side, chain: p.chain, pool: p.pool, symbol: p.symbol, price, positionId: p.id, fraction, createdAt: Date.now() };
  }
  state.orders.push(o);
  rec("order.place", `Limit ${side === "BUY" ? `buy $${o.usd!.toFixed(2)}` : `sell ${Math.round(o.fraction! * 100)}%`} of ${o.symbol} at ${fmt(price)}`, { ...o });
  log(`Limit ${side === "BUY" ? `buy: $${o.usd!.toFixed(2)} of ${o.symbol} if it falls to ${fmt(price)}` : `sell: ${Math.round(o.fraction! * 100)}% of ${o.symbol} if it rises to ${fmt(price)}`}.`);
  save();
  return o;
}

export function cancelOrder(id: string) {
  const o = state.orders.find((x) => x.id === id);
  if (!o) throw new Error("Order not found (it may have just filled)");
  state.orders = state.orders.filter((x) => x.id !== id);
  rec("order.cancel", `Cancelled limit ${o.side === "BUY" ? "buy" : "sell"} on ${o.symbol} at ${fmt(o.price)}`, { id: o.id });
  log(`Cancelled limit ${o.side === "BUY" ? "buy" : "sell"} on ${o.symbol} at ${fmt(o.price)}.`);
  save();
  return { ok: true };
}

// Fill any limit order whose price was touched since it was placed (or since the last check).
// Buys fill at the limit or lower, sells at the limit or higher, like real limit orders.
async function checkLimitOrders() {
  if (!state.orders.length) return;
  const byPool = new Map<string, LimitOrder[]>();
  for (const o of state.orders) byPool.set(`${o.chain}:${o.pool}`, [...(byPool.get(`${o.chain}:${o.pool}`) ?? []), o]);
  for (const list of byPool.values()) {
    const since = Math.max(Date.now() - 60_000, Math.min(...list.map((o) => o.createdAt)));
    let q: Quote;
    try {
      q = await quote(list[0].chain, list[0].pool, since);
    } catch {
      continue; // price unavailable right now: try again next check
    }
    for (const o of list) {
      if (!state.orders.some((x) => x.id === o.id)) continue;
      if (o.side === "BUY" && q.low <= o.price) {
        const usd = Math.floor(Math.min(o.usd ?? 0, state.cash) * 100) / 100;
        state.orders = state.orders.filter((x) => x.id !== o.id);
        if (usd < 1) {
          log(`Limit buy on ${o.symbol} at ${fmt(o.price)} cancelled: not enough cash.`, "bad");
          alert(`⚠️ Limit buy on ${o.symbol} cancelled: not enough cash.`);
          continue;
        }
        // A limit buy never pays more than the limit: slippage only applies while the price
        // (plus slippage) is still under it. Fill = min(limit, live price + slippage).
        const slip = state.settings.slippagePct / 100;
        const t = buy({ ...q.pair, priceUsd: Math.min(o.price / (1 + slip), q.price) }, usd, "manual", `Limit buy at ${fmt(o.price)}`);
        t.auto = true;
        log(`LIMIT BUY ${o.symbol} $${usd.toFixed(2)} @ ${fmt(t.price)} (your limit ${fmt(o.price)}).`, "good");
        alert(`🟢 Limit buy filled: ${o.symbol} $${usd.toFixed(2)} @ ${fmt(t.price)}. Account $${equity().toFixed(2)}.`);
      } else if (o.side === "SELL") {
        const p = state.positions.find((x) => x.id === o.positionId);
        if (!p) {
          state.orders = state.orders.filter((x) => x.id !== o.id);
          log(`Limit sell on ${o.symbol} removed: the position is already closed.`);
          continue;
        }
        if (q.high >= o.price) {
          state.orders = state.orders.filter((x) => x.id !== o.id);
          // A limit sell never gets less than the limit: fill = max(limit, live price - slippage).
          const slip = (state.settings.slippagePct + (p.extraSlipPct ?? 0)) / 100;
          const t = sell(p.id, Math.max(o.price / (1 - slip), q.price), o.fraction ?? 1, `Limit sell at ${fmt(o.price)}`);
          t.auto = true;
          log(`LIMIT SELL ${o.symbol} ${Math.round((o.fraction ?? 1) * 100)}% @ ${fmt(t.price)} (your limit ${fmt(o.price)}). P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}`, t.pnlUsd! >= 0 ? "good" : "bad");
          alert(`${t.pnlUsd! >= 0 ? "✅" : "🔻"} Limit sell filled: ${o.symbol} @ ${fmt(t.price)}. P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}. Account $${equity().toFixed(2)}.`);
          // Other sell orders on the same position may no longer fit what's left: they stay, and
          // sell their share of whatever remains.
        }
      }
    }
  }
  save();
}

// "Continue anyway": lift today's daily loss limit (until 00:00 UTC). The emergency stop
// (account drawdown limit) still applies.
export function overrideDailyLimit() {
  const today = utcDay();
  rec("consent.daily_limit", `Accepted "I understand, continue today": lifted the daily loss limit until 00:00 UTC`, {
    date: today,
    warningShown: state.bot.blocked,
    note: "The daily loss limit stops new trades after a bad day. Continuing lifts it until 00:00 UTC; the emergency stop still applies.",
  });
  state.bot.dailyOverride = today;
  state.bot.blocked = null;
  log(`You lifted today's daily loss limit: the bot keeps trading until 00:00 UTC. The emergency stop still applies.`, "bad");
  save();
  return { ok: true, until: `${today}T24:00:00Z` };
}

// Emergency stop: sell everything and switch off if equity falls below the limit.
function checkDrawdown(cfg: BotConfig) {
  const eq = equity();
  if (eq >= state.startCash * (1 - cfg.maxDrawdownPct / 100)) return false;
  for (const p of state.positions.filter((x) => x.source === "bot")) sell(p.id, p.lastPrice, 1, "Emergency stop");
  stopBot(`Equity $${eq.toFixed(2)} fell below the ${cfg.maxDrawdownPct}% limit`);
  alert(`🚨 Emergency stop: account $${eq.toFixed(2)} fell below your ${cfg.maxDrawdownPct}% limit. Bot positions sold and the bot is OFF.`);
  return true;
}

export async function refreshPositionPrices() {
  await Promise.all(
    state.positions.map(async (p) => {
      try {
        p.lastPrice = (await getPair(p.chain, p.pool)).priceUsd;
      } catch {}
    }),
  );
  recordEquity();
}

// Locally (not on Vercel): every 5 s, run each active account's bot step, protected trades
// and limit orders (resumes running bots after a restart).
if (!process.env.VERCEL) {
  let localBusy = false;
  setInterval(async () => {
    if (localBusy) return;
    localBusy = true;
    try {
      await ensureMigrated();
      const step = async () => {
        await sync();
        if (state.bot.running && state.bot.config) await tick(false);
        await guardProtected();
        await flush();
      };
      for (const k of await activeAccounts()) await withAccount(k, step);
      // Scripts and tests that drive the engine without a login use the unnamed account.
      if (fallback && isActive(fallback.state)) await als.run(fallback, step);
    } catch (e) {
      console.error("[local loop]", e);
    } finally {
      localBusy = false;
    }
  }, CHECK_MS);
}
