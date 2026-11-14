// Paper-trading broker + automated bot.
// Every trade here is simulated with realistic fees and slippage so you can
// see how the strategy would perform before risking real money.
import { audit, ledger, type AuditType } from "./audit.js";
import { analyze, BOT_MODEL, CLAUDE_MODEL, combine, forecastPanel, orderKey, reviewAgentPick, reviewHold, reviewProfit, type AgentEval, type ProfitDecision, type CheckedOrder, type Consensus, type Frame, type ModelResult, type OrderPrediction, type PlanOrder } from "./ai.js";
import { countedWin, desk, expected, resolve, score, type ConePoint, type Desk, type FcStats, type Forecast, type ForecastRec, type Shape } from "./predict.js";
import { findPatterns, patternsText, patternTags, type FramePatterns } from "./patterns.js";
import { cachedJson, fromDexScreener, getCandles, getPair, getRecentTokenCandles, knownToken, type Candle, type PairInfo, type Timeframe } from "./data.js";
import { atr, snapshot } from "./indicators.js";
import { scanOpportunities } from "./scan.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { APP_TOKENS_PER_API_TOKEN, month, planOf, tokenLimit, type PlanId, type Role } from "./plans.js";
import { createStore } from "./store.js";
import { alertChannel, sendAlert } from "./alerts.js";
import { scanNewCoins } from "./newcoins.js";
import { AGENT_KEYS, AGENT_PASS, flowText, marketText, recentScan, scanAgents, scoreCoin, tokenInfo, type AgentCoin } from "./agents.js";
import { learn, type Learned, type Watch } from "./learn.js";

import { noteCommunityBuy } from "./lists.js";

export type Position = {
  id: string;
  adopted?: boolean; // bought by hand, then handed to a bot to sell
  imageUrl?: string; // the coin's picture (shown in Positions)
  botId?: string; // which bot manages it ("1" when missing)
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
  predictedWinPct?: number; // the win chance of the order that opened it (for an agent: the combined chance)
  prediction?: OrderPrediction; // Agents: the full prediction the buy was made on (shown in the agent window)
  // "Protect this trade" (manual positions): sell if the price falls protectPct% from its
  // highest point since protection was switched on. Checked every 5 s, bot running or not.
  protectPct?: number;
  protectSince?: number;
  strategy?: "newcoin" | "agents"; // opened by the New coins or Agents mode (their own rules)
  partialDone?: boolean; // new coins: half already sold at the first target
  extraSlipPct?: number; // extra slippage for thin liquidity, applied on the way out too
  realizedUsd?: number; // P&L already taken by partial sales (new coins: half at the first target)
  best?: number; // highest closing price since the buy (for the profit lock)
  locked?: boolean; // the stop is a profit lock (above break-even)
  patterns?: string[]; // chart patterns on screen when the bot bought
  tokenMint?: string; // Agents mode: the token's mint (to avoid buying it twice)
  secondLook?: boolean; // the AI already kept this trade open once at its stop-loss
  firstStop?: number; // the stop-loss before the AI's second look moved it
  underSince?: number; // Agents: when the price was first seen at or below the stop-loss (it sells if it is still there ~10 s later)
  extensions?: number; // times the AI extended the holding time
  ladderStep?: number; // (older trades) the highest whole % of profit after fees locked
  pm?: ProfitPlan; // Agents: how this trade's profit is being managed once the minimum is reached
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
  strategy?: "newcoin" | "agents";
  botId?: string; // bot trades: which bot ("1" when missing)
  patterns?: string[]; // bot buys: chart patterns on screen when it bought
};

export type BotConfig = {
  chain: string;
  pool: string;
  symbol: string;
  imageUrl?: string; // the coin's picture, for the agent's card (sent on start, or filled in once it is known)
  tf: Timeframe;
  positionPct: number; // % of cash per trade
  minConfidence: number;
  analyzeEverySec: number;
  checkEverySec: number;
  maxDrawdownPct: number; // bot stops itself if the account falls this % below its value when the bot started
  startEquity?: number; // account value when this bot was started (the emergency stop counts from here)
  breakEvenAtPct: number; // move stop to break-even once up this much
  lockPct?: number; // profit lock: once up breakEvenAtPct, never give back more than (100 - lockPct)% of the best gain (default 50; 0 = off)
  partialAtPct?: number; // sell half once the price is this % of the way to the target (default 75; 0 = off)
  goalUsd: number;
  // "this" = trade the coin above; "auto" = pick the best coin from Opportunities each round.
  pick?: "this" | "auto" | "newcoins" | "agents" | "agent";
  budgetUsd?: number; // Agent: the money it may invest (default $1,000)
  agentMaxPerDay?: number; // Agents mode: most buys per day (default 6)
  agentAiCheck?: boolean; // Agents mode: one AI check before each buy (default on)
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
  rewardRule?: boolean;
  takeProfitUsd?: number;
  strongMode?: boolean; // extra entry filters on top of everything else (default on)
  disabled?: string[]; // settings the user switched off (each with a recorded "I understand") // sell the whole position once it is up this many dollars after fees (0 / missing = off) // only buy when the gain after fees is >= 1.5x the loss (default on; off = the old rules)
  // Safety rules (defaults apply when missing, including bots started before they existed).
  cooldownMin?: number; // after a losing trade, don't re-buy that coin for this long (default 30)
  dailyLossPct?: number; // stop opening trades for the rest of the UTC day after losing this % (default 10)
  maxDrop1hPct?: number; // no dip buys if the coin fell more than this % in the last hour (default 10)
  // "I understand the risks": trade even when the coin is falling (dip buys allowed in a
  // downtrend) and skip the per-coin cool-down / 2-losses-a-day skip. The daily loss limit,
  // emergency stop, minimum win chance and fee check still apply.
  allowRisky?: boolean;
  riskReasons?: string[];
  riskyMinWin?: number; // minimum win chance in risky mode (default 30; normal mode uses minConfidence) // the warnings the user saw when accepting risky mode (kept in the audit log)
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

// Agents: a trade that reached its minimum profit. `floor` is the hard exit (starts at the locked
// minimum; the AI can only raise it). `trailPct` is how far behind the highest close the exit
// follows (the AI sets it each time it is asked; a fixed rule when it can't be asked).
export type ProfitPlan = { floor: number; trailPct: number; by: "ai" | "rule"; asks: number; fails: number; step: number; at?: number; nextAt?: number; target?: number; note?: string; confidence?: number; lastPrice?: number; lastAction?: string };

type State = {
  resetAt?: number; // when this account was last reset (older copies are never saved over it)
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
    bounceLow?: Record<string, number>; // Strong mode: lowest price since a dip order was touched (per plan + order)
    agentScan?: { at: number; scanned: number; top: AgentCoin[] }; // Agents mode: the latest scores (top 8)
    agentLog?: AgentDecision[]; // Agents mode: recent picks and skips
    learned?: Learned; // Agent: what it learned from its coin's history
    aiNotes?: { at: number; price: number; text: string }[]; // Agent: its AI's last decisions on this coin (given back to it next time)
    lastFiredAt?: number; // Agent: the candle its pattern last fired on (one try per signal)
    watch?: Watch | null; // Agent: the level it is watching (drawn on the chart)
    // Auto-pick: the coin the bot is currently waiting to buy, and what Claude said about each candidate.
    target: { chain: string; pool: string; symbol: string; chosenAt: number } | null;
    candidates: { symbol: string; chain: string; pool: string; action: string; confidence: number; note: string }[];
    log: { t: number; msg: string; level: "info" | "good" | "bad" }[];
  };
  lastSignal: { at: number; pool: string; symbol: string; tf: string; results: ModelResult[]; consensus: Consensus; trendDown?: boolean; atrPct?: number; patterns?: FramePatterns[]; priceAt?: number; desk?: DeskView } | null;
  // Extra bots (2 and 3). Bot 1 is `bot` / `lastSignal` above, so older saved states keep working.
  bots?: BotSlot[];
  // The forecast scoreboard (whole account): forecasts waiting for their outcome, every
  // forecaster's running record, and the last few that were scored.
  fc?: { pending: ForecastRec[]; stats: FcStats; last: Scored[] };
};
export type Scored = { at: number; symbol: string; kind: string; pWin: number; aiPct: number; passed: boolean; out: "win" | "stop" | "none" };
// The forecast desk as shown in the agent window: where the simulated paths put the price, and
// the chance of reaching the minimum profit first for a buy right now at three stop distances.
export type DeskView = {
  at: number; price: number; upPct: number; paths: number;
  cone: ConePoint[];
  rows: { stopPct: number; worlds: number | null; trend: number | null; flat: number | null; baseRate: number | null; lookalikes: number | null; lookN: string | null; numbers: number; needPct: number }[];
  next60: { mid: number; lo: number; hi: number } | null;
};
type BotState = State["bot"];
export type BotSlot = { id: string; bot: BotState; lastSignal: State["lastSignal"] };

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
  s.bots ??= [];
  for (const b of s.bots) b.bot = { ...fresh().bot, ...b.bot, coinStats: {}, day: null };
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
  busyIds?: Set<string>; // which agents' steps are running (each agent runs its own, side by side)
  steps?: Set<Promise<unknown>>; // rounds of agent steps still in flight
  reviews?: Set<Promise<unknown>>; // AI profit checks still in flight
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

// Several bots per account: each bot step runs inside one bot (botAls). `state.bot` and
// `state.lastSignal` then mean that bot's own state; bot 1 is the original `bot` field.
// Per-coin losing streaks and the daily loss limit stay shared by all bots of the account.
const botAls = new AsyncLocalStorage<string>();
export const currentBotId = () => botAls.getStore() ?? "1";
export const withBot = <T>(id: string, fn: () => T): T => botAls.run(id, fn);
const SHARED_BOT_KEYS = new Set(["coinStats", "day", "dailyOverride"]);
const botViews = new WeakMap<object, BotState>();
function slotOf(st: State, id: string): BotSlot | undefined {
  return id === "1" ? undefined : st.bots?.find((b) => b.id === id);
}
function botView(st: State, slot: BotSlot): BotState {
  let v = botViews.get(slot.bot);
  if (!v) {
    v = new Proxy(slot.bot, {
      get: (t, k) => (SHARED_BOT_KEYS.has(k as string) ? (st.bot as any)[k] : (t as any)[k]),
      set: (t, k, val) => {
        if (SHARED_BOT_KEYS.has(k as string)) (st.bot as any)[k] = val;
        else (t as any)[k] = val;
        return true;
      },
    });
    botViews.set(slot.bot, v);
  }
  return v;
}
const state = new Proxy({} as State, {
  get: (_t, k) => {
    const st = acct().state;
    if (k === "bot" || k === "lastSignal") {
      const slot = slotOf(st, currentBotId());
      if (slot) return k === "bot" ? botView(st, slot) : slot.lastSignal;
    }
    return (st as any)[k];
  },
  set: (_t, k, v) => {
    const st = acct().state;
    if (k === "bot" || k === "lastSignal") {
      const slot = slotOf(st, currentBotId());
      if (slot) {
        (slot as any)[k] = v;
        return true;
      }
    }
    (st as any)[k] = v;
    return true;
  },
  has: (_t, k) => k in acct().state,
  ownKeys: () => Reflect.ownKeys(acct().state),
  getOwnPropertyDescriptor: (_t, k) => Object.getOwnPropertyDescriptor(acct().state, k),
});

// Accounts that need watching even when nobody has the page open (bot on, protected trades,
// limit orders). The scheduler wakes each of them.
const ACTIVE_KEY = "active-accounts";
export const botIds = (st: State = acct().state) => ["1", ...(st.bots ?? []).map((b) => b.id)];
const runningIds = (st: State = acct().state) => botIds(st).filter((id) => (id === "1" ? st.bot : slotOf(st, id)!.bot).running);
const anyBotRunning = (st: State = acct().state) => runningIds(st).length > 0;

// ---------- Agents' locked budgets ----------
// A running agent's money is set aside for it: its budget plus what its trades have made or lost
// since it started, minus what is in its open trade right now. That cash can't be spent by you
// or by another agent. Equity is unchanged: locked cash is still your cash.
export type AgentLock = { id: string; symbol: string; usd: number };
export function agentLocks(st: State = acct().state): AgentLock[] {
  return botIds(st).flatMap((id) => {
    const bot = id === "1" ? st.bot : slotOf(st, id)!.bot;
    const cfg = bot.config;
    if (!bot.running || !cfg || cfg.pick !== "agent") return [];
    const since = bot.startedAt ?? 0;
    const pnl = st.trades.filter((t) => t.strategy === "agents" && (t.botId ?? "1") === id && t.time >= since && t.side === "SELL").reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
    const invested = st.positions.filter((p) => p.source === "bot" && (p.botId ?? "1") === id).reduce((s, p) => s + p.costUsd, 0);
    return [{ id, symbol: cfg.symbol, usd: Math.max(0, (cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT) + pnl - invested) }];
  });
}
// Cash that isn't locked for an agent (exceptId: leave that agent's own lock out).
export function availableCash(st: State = acct().state, exceptId?: string) {
  const locked = agentLocks(st).filter((l) => l.id !== exceptId).reduce((s, l) => s + l.usd, 0);
  return Math.max(0, st.cash - locked);
}
const isActive = (st: State) => anyBotRunning(st) || st.positions.some((p) => p.protectPct) || (st.orders?.length ?? 0) > 0;
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
// Community list: count this account's buy of a Solana coin (queued like the audit writes).
function noteCommunity(pair: PairInfo) {
  const a = acct();
  if (!a.key) return;
  const key = a.key;
  a.pending = a.pending.then(() => noteCommunityBuy(key, pair)).catch(() => {});
}
function recTrade(t: Trade) {
  const a = acct();
  if (!a.key) return;
  const key = a.key;
  a.pending = a.pending.then(() => ledger(key, t as unknown as Record<string, unknown>)).catch(() => {});
}

// ---------- Stops and resets that stick ----------
// Several server copies can hold the same account (the scheduler's, the dashboard's), and each
// saves the whole account. A copy that is mid-step (waiting on the AI) holds an older version;
// when it saved, it used to write a stopped agent back as running, or undo a reset.
// So every Stop and Reset is also written to a small control record, and every save checks it:
// an agent stopped after it last started stays stopped, and a copy from before a reset is not saved.
type Ctl = { resetAt?: number; stops?: Record<string, number> };
const ctlKey = (key: string) => `ctl:${key}`;
function applyStops(st: State, ctl: Ctl | null) {
  let changed = false;
  for (const [id, at] of Object.entries(ctl?.stops ?? {})) {
    const bot = id === "1" ? st.bot : st.bots?.find((b) => b.id === id)?.bot;
    if (bot && bot.running && at > (bot.startedAt ?? 0)) {
      bot.running = false;
      bot.stoppedAt = at;
      bot.target = null;
      changed = true;
    }
  }
  return changed;
}
const staleAfterReset = (st: State, ctl: Ctl | null) => (ctl?.resetAt ?? 0) > (st.resetAt ?? 0);
function queueCtl(change: (c: Ctl) => void) {
  const a = acct();
  if (!a.key) return;
  const key = a.key;
  a.pending = a.pending
    .then(async () => {
      const c = (await store.kvGet<Ctl>(ctlKey(key))) ?? {};
      change(c);
      await store.kvSet(ctlKey(key), c);
    })
    .catch((e) => console.error("[store] control record failed:", e));
}
// After a long wait (the AI): was this agent stopped, or the account reset, by another copy meanwhile?
async function stoppedElsewhere(): Promise<boolean> {
  const a = acct();
  if (!a.key) return !state.bot.running;
  const ctl = await store.kvGet<Ctl>(ctlKey(a.key)).catch(() => null);
  if (staleAfterReset(a.state, ctl)) return true;
  applyStops(a.state, ctl);
  return !state.bot.running;
}

function save() {
  const a = acct();
  a.dirty = false;
  if (!a.key) return; // signed-out visitors' views are never saved
  const key = a.key;
  const copy = structuredClone(a.state);
  a.pending = a.pending
    .then(async () => {
      const ctl = await store.kvGet<Ctl>(ctlKey(key)).catch(() => null);
      if (staleAfterReset(copy, ctl)) return; // the account was reset after this copy was loaded: never write it back
      applyStops(copy, ctl); // an agent stopped elsewhere stays stopped
      applyStops(a.state, ctl);
      await store.save(copy, key);
    })
    .then(() => markActive(a))
    .catch((e) => console.error("[store] save failed:", e));
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
  const st = acct().state;
  const available = availableCash(st);
  // available = cash you can spend yourself; locked = set aside for running agents (still part of equity).
  return {
    ...st, bots: st.bots ?? [], equityNow: equity(), roundTripCostPct: roundTripCostPct(), storage: store.kind, available, locked: Math.max(0, st.cash - available), locks: agentLocks(st),
    fc: st.fc ? { stats: st.fc.stats, last: st.fc.last, waiting: st.fc.pending.length } : null,
  };
}

// ---------- Broker ----------

export function buy(pair: PairInfo, usd: number, source: "manual" | "bot", reason: string, plan?: Partial<Position>, extraSlipPct = 0) {
  if (!(usd > 0)) throw new Error("Amount must be positive");
  // Your own buys can't use cash locked for agents; an agent's buy uses its own locked budget.
  const spendable = source === "manual" ? availableCash() : state.cash;
  if (usd > spendable + 1e-9)
    throw new Error(state.cash - spendable > 0.005 ? `Not enough available cash: $${spendable.toFixed(2)} available, $${(state.cash - spendable).toFixed(2)} is locked for your agents` : `Not enough cash ($${state.cash.toFixed(2)} available)`);
  if (!(pair.priceUsd > 0)) throw new Error("No live price for this token");
  const { feePct, slippagePct } = state.settings;
  const feeUsd = usd * (feePct / 100);
  const platformFeeUsd = usd * (platformFeePct() / 100);
  const fillPrice = pair.priceUsd * (1 + (slippagePct + extraSlipPct) / 100);
  const qty = (usd - feeUsd - platformFeeUsd) / fillPrice;
  state.cash -= usd;
  const existing = state.positions.find((p) => p.pool === pair.pool && p.source === source && (source !== "bot" || (p.botId ?? "1") === (plan?.botId ?? "1")));
  if (existing) {
    const totalQty = existing.qty + qty;
    existing.entryPrice = (existing.entryPrice * existing.qty + fillPrice * qty) / totalQty;
    existing.qty = totalQty;
    existing.costUsd += usd;
    Object.assign(existing, plan);
  } else {
    state.positions.push({ id: uid(), chain: pair.chain, pool: pair.pool, symbol: pair.symbol, ...(pair.imageUrl ? { imageUrl: pair.imageUrl } : {}), qty, entryPrice: fillPrice, costUsd: usd, openedAt: Date.now(), source, lastPrice: pair.priceUsd, ...plan });
  }
  const t: Trade = { id: uid(), time: Date.now(), side: "BUY", symbol: pair.symbol, pool: pair.pool, price: fillPrice, qty, usd, feeUsd, platformFeeUsd, reason, source, ...(source === "bot" ? { botId: plan?.botId ?? "1" } : {}) };
  state.trades.unshift(t);
  recTrade(t);
  noteCommunity(pair);
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
  const t: Trade = { id: uid(), time: Date.now(), side: "SELL", symbol: p.symbol, pool: p.pool, price: fillPrice, qty, usd: net, feeUsd, pnlUsd: net - costPart, platformFeeUsd, reason, source: p.source, ...(p.source === "bot" ? { botId: p.botId ?? "1" } : {}) };
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
  const at = Date.now();
  const learnt = acct().state.fc; // the forecasters' record is knowledge, not money: it survives a reset
  acct().state = fresh(startCash);
  if (learnt) acct().state.fc = { pending: [], stats: learnt.stats, last: learnt.last };
  acct().state.resetAt = at;
  queueCtl((c) => { c.resetAt = at; c.stops = {}; }); // older copies of the account must not be saved over this
  rec("account.reset", `Paper account reset to $${startCash.toFixed(2)}`, { startCash });
  save();
}

// ---------- AI signal (shared by UI and bot) ----------

// What Claude sees for each plan: zoomed in for timing, zoomed out for the bigger picture.
const PLAN_FRAMES: { tf: Timeframe; label: string; show: number }[] = [
  { tf: "5s", label: "5-second candles (last ~5 minutes): precise timing", show: 60 },
  { tf: "1m", label: "1-minute candles (last ~90 minutes): the move happening now", show: 90 },
  { tf: "5m", label: "5-minute candles (last ~5 hours): today's swings, support and resistance", show: 60 },
  { tf: "1h", label: "1-hour candles (last ~2 days): the trend", show: 48 },
  { tf: "1d", label: "1-day candles (last ~month): the big picture", show: 30 },
];

async function loadFrames(chain: string, pool: string, pair: PairInfo, only?: Timeframe[]) {
  // One timeframe at a time (CoinMarketCap allows ~1 request/second); skip any that fail,
  // e.g. no daily candles yet for a brand-new coin.
  const wanted = PLAN_FRAMES.filter((x) => !only || only.includes(x.tf));
  const got = await Promise.all(
    wanted.map(async (f, i): Promise<Frame | null> => {
      await new Promise((r) => setTimeout(r, i * 250));
      // Try twice: a free data source can briefly refuse (rate limit); don't silently drop a timeframe.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const candles = await getCandles(chain, pool, f.tf, 300, pair);
          return candles.length ? { ...f, candles, snap: snapshot(candles) } : null;
        } catch {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
        }
      }
      return null;
    }),
  );
  return got.filter((f): f is Frame => f !== null);
}

// ---------- Prediction (agents) ----------
// An order as percentages from the entry, for the forecast: how far to the minimum-profit level,
// how far to the stop, how long it may wait to fill and how long it may be held.
function shapeOf(o: Pick<PlanOrder, "kind" | "triggerPrice" | "stopLoss" | "maxHoldMinutes">, priceNow: number, cost: number, validMinutes: number): Shape & { entry: number; immediate: boolean } {
  const t = o.triggerPrice;
  const immediate = o.kind === "buy_breakout" ? priceNow >= t : priceNow <= t; // already on the buying side of the trigger
  const entry = immediate ? priceNow : t;
  return {
    entry, immediate,
    offsetPct: immediate ? 0 : (t / priceNow - 1) * 100,
    upPct: cost + AGENT_NET_TARGET,
    downPct: Math.max(0.1, (1 - o.stopLoss / entry) * 100),
    holdMin: Math.min(1440, Math.max(5, o.maxHoldMinutes)),
    waitMin: immediate ? 0 : validMinutes,
  };
}
const pct0 = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${Math.round(v)}%`);
// The forecast desk: what the numbers say about buying right now, as text for the AI and as data for the agent window.
// The usual size of one candle on this coin (high to low, % of its price): the middle one of the last 120.
function usualSwing(c: Candle[]): number {
  const r = c.slice(-120).filter((x) => x.close > 0).map((x) => ((x.high - x.low) / x.close) * 100).sort((a, b) => a - b);
  return r.length >= 20 ? r[Math.floor(r.length / 2)] : 0;
}
function deskReport(D: Desk, cost: number, measuredWinPct: number | undefined, stats: FcStats | undefined, swing1m = 0, swing5m = 0): { text: string; view: DeskView } | null {
  if (!D.ready || !(D.price > 0)) return null;
  const up = cost + AGENT_NET_TARGET;
  const rows: DeskView["rows"] = [];
  const lines: string[] = [];
  let next60: DeskView["next60"] = null, paths = 0;
  for (const stopPct of [3, 5, 8]) {
    const f = D.forecast({ offsetPct: 0, upPct: up, downPct: stopPct, holdMin: 180, waitMin: 0 });
    if (!f) continue;
    const winNet = measuredWinPct ?? countedWin(f.winNetPct, AGENT_NET_TARGET);
    const need = expected(f.numbers, winNet, stopPct + cost, f).needPct;
    const w = f.worlds;
    paths = w?.paths ?? paths;
    next60 ??= f.lookalikes?.next60 ?? null;
    const r1 = (v: number | undefined | null) => (v === undefined || v === null ? null : Math.round(v * 10) / 10);
    rows.push({ stopPct, worlds: r1(w?.pWin), trend: r1(w?.trend.pWin), flat: r1(w?.flat.pWin), baseRate: r1(f.baseRate?.pWin), lookalikes: r1(f.lookalikes?.pWin), lookN: f.lookalikes ? `${f.lookalikes.wins} of ${f.lookalikes.n}` : null, numbers: r1(f.numbers) ?? 0, needPct: r1(need) ?? 0 });
    lines.push(`  stop ${stopPct}% below: simulated paths ${pct0(w?.pWin)}${w ? ` (trend continues ${pct0(w.trend.pWin)}, no trend ${pct0(w.flat.pWin)}; with no trend ${pct0(w.flat.pStop)} hit the stop first and ${pct0(w.flat.pNone)} ran out of time)` : ""} | this coin's last ${f.baseRate ? `${Math.round(f.baseRate.hours)}h: ${pct0(f.baseRate.pWin)}` : "day: n/a"} | look-alike moments: ${f.lookalikes ? `${f.lookalikes.wins} of ${f.lookalikes.n}` : "n/a"} | together ${pct0(f.numbers)}; an order like this needs about ${Math.ceil(need)}% to be worth buying.`);
  }
  if (!rows.length) return null;
  const cone = D.cone([15, 60, 180]);
  const money = (v: number) => `$${Number(v.toPrecision(4))}`;
  const ai = stats?.ai && stats.ai.n >= 8 ? stats.ai : null;
  const text = [
    `Forecast desk (worked out by code from this coin's own candles; there is no opinion in it):`,
    `- To be up +${AGENT_NET_TARGET}% after the ${cost.toFixed(1)}% costs, the price must rise ${up.toFixed(1)}% from the entry before the stop is hit.`,
    swing1m > 0 && swing5m > 0 ? `- This coin's usual swing: about ${swing1m.toFixed(1)}% inside one 1-minute candle and ${swing5m.toFixed(1)}% inside one 5-minute candle. A stop closer than about one 5-minute swing below the entry sits inside ordinary wiggle and is usually hit before anything else happens; if the chart gives no sound level that far out, there is no trade.` : "",
    `- A breakout order is bought only if the price is still above its level after holding there (your confirmSeconds, at least 15 s) and has not run more than 2% past it (or half the distance to your stop); otherwise you are asked again.`,
    `- Buying now, the chance that happens first within 3 hours, by how far below the stop sits:`,
    ...lines,
    cone.length ? `- Where the simulated paths put the price if there is no trend (the middle 80% of them): ${cone.map((c) => `in ${c.min >= 60 ? `${c.min / 60} h` : `${c.min} min`} ${money(c.lo)} to ${money(c.hi)} (middle ${money(c.mid)})`).join("; ")}.` : "",
    next60 ? `- After the past moments most like this one, the price an hour later was typically ${next60.mid >= 0 ? "+" : ""}${next60.mid.toFixed(1)}% (from ${next60.lo >= 0 ? "+" : ""}${next60.lo.toFixed(1)}% to ${next60.hi >= 0 ? "+" : ""}${next60.hi.toFixed(1)}%).` : "",
    `- How far to trust it: tested blind on real coins (about 2,000 past moments), these numbers were right when low (a chance under 10% almost never came through), about a third too high when above 30%, and no good at telling a better moment from a worse one on the same coin. Timing is your job.`,
    `- How to use it: these are base rates for this coin, not a forecast of this exact moment. Start your winChancePct from them and move only as far as specific evidence on the chart justifies. The bot combines your chance with these numbers, asks three more AI forecasters about any order that would pass, and buys only if the combined chance beats what the order needs. A closer stop needs a lower chance but is hit more often: put the stop where the chart says the idea is wrong.`,
    ai ? `- Your own record on this account: your last forecasts said ${Math.round((ai.sumP / ai.n) * 100)}% on average and ${Math.round((ai.hits / ai.n) * 100)}% of them reached the level. The bot corrects your chance by that gap.` : "",
  ].filter(Boolean).join("\n");
  const p6 = (v: number) => Number(v.toPrecision(6));
  return { text, view: { at: Date.now(), price: D.price, upPct: up, paths, cone: cone.map((c) => ({ min: c.min, lo: p6(c.lo), mid: p6(c.mid), hi: p6(c.hi) })), rows, next60: next60 ? { mid: Math.round(next60.mid * 10) / 10, lo: Math.round(next60.lo * 10) / 10, hi: Math.round(next60.hi * 10) / 10 } : null } };
}
// Scores the forecasts made on this coin against the candles since: reached the minimum-profit
// level first, hit the stop first, or ran out of time. Orders that never filled are not scored.
function settleForecasts(pool: string, c1: Candle[], c5: Candle[]) {
  const fc = state.fc;
  if (!fc?.pending.length) return;
  const now = Date.now();
  const keep: ForecastRec[] = [];
  for (const r of fc.pending) {
    if (r.pool !== pool) {
      if (now - r.at < 30 * 3_600_000) keep.push(r); // its coin isn't being looked at any more: dropped after a day
      continue;
    }
    // 1-minute candles while they still reach back to the forecast, then 5-minute ones.
    const out = c1.length && c1[0].time * 1000 <= r.at ? resolve(r, c1, 60) : c5.length && c5[0].time * 1000 <= r.at ? resolve(r, c5, 300) : now - r.at > 26 * 3_600_000 ? "unfilled" : null;
    if (out === null) { keep.push(r); continue; }
    if (out === "unfilled") continue;
    fc.stats = score(fc.stats, r, out);
    fc.last.unshift({ at: r.at, symbol: r.symbol, kind: r.kind, pWin: Math.round(r.p.combined ?? 0), aiPct: Math.round(r.p.ai ?? 0), passed: r.passed, out });
    if (fc.last.length > 12) fc.last.length = 12;
  }
  if (keep.length !== fc.pending.length) acct().dirty = true;
  fc.pending = keep;
}
// Remembers each predicted order so it can be scored later, whether or not it was bought (one
// per coin, kind and verdict every 45 minutes: looks a few minutes apart are the same evidence).
function recordForecasts(pair: PairInfo, consensus: Consensus, cost: number) {
  const now = Date.now();
  const validMin = Math.max(5, Math.round((consensus.expiresAt - now) / 60_000));
  const fc = (state.fc ??= { pending: [], stats: {}, last: [] });
  for (const o of consensus.orders) {
    const p = o.prediction;
    if (!p) continue;
    const passed = !o.warning;
    if (fc.pending.some((r) => r.pool === pair.pool && r.kind === o.kind && r.passed === passed && now - r.at < 45 * 60_000)) continue;
    const sh = shapeOf(o, pair.priceUsd, cost, validMin);
    const each: ForecastRec["p"] = { combined: p.pWin };
    for (const part of p.parts) each[part.key] = part.pct;
    fc.pending.push({ id: uid(), at: now, pool: pair.pool, symbol: pair.symbol, kind: sh.immediate ? "buy_now" : o.kind, entry: sh.entry, stop: o.stopLoss, level: sh.entry * (1 + (cost + AGENT_NET_TARGET) / 100), waitMin: sh.waitMin, holdMin: Math.min(sh.holdMin, 420), p: each, passed });
  }
  if (fc.pending.length > 60) fc.pending.splice(0, fc.pending.length - 60);
}

export async function runAnalysis(chain: string, pool: string, tf: Timeframe, opts: { forBot?: boolean; agentBrief?: string } = {}) {
  const pair = await getPair(chain, pool);
  const frames = await loadFrames(chain, pool, pair);
  // Chart patterns found by code on each timeframe, with how each did earlier on the same chart.
  const patterns = frames.map((f) => findPatterns(f.tf, f.candles));
  const primary = frames.find((f) => f.tf === "5m" && f.snap) ?? frames.find((f) => f.snap);
  if (!primary?.snap) throw new Error("Not enough candle history for this token yet");
  const snap = primary.snap;
  // Downtrend on the 1-hour chart: fast average below slow average and price below the slow one.
  // Worked out BEFORE asking, so the AI knows which of its orders the bot is allowed to fill.
  const h1 = frames.find((f) => f.tf === "1h")?.snap;
  const trendDown = h1 ? h1.ema9 < h1.ema21 && h1.price < h1.ema21 : false;
  const cfg = state.bot.config;
  const maxDrop = cfg?.maxDrop1hPct ?? 10;
  const dipsBlocked = ((cfg && strongOn(cfg)) || (!cfg?.allowRisky && !isOff(cfg, "maxDrop1hPct"))) && (trendDown || pair.change.h1 <= -maxDrop);
  const recent = state.trades.filter((t) => t.pool === pool && t.source === "bot" && t.side === "SELL").slice(0, 5);
  // The AI's own track record (all coins): predicted win chance vs what really happened.
  const scored = state.trades.filter((t) => t.source === "bot" && t.side === "SELL" && typeof t.predictedWinPct === "number").slice(0, 30);
  const record = scored.length >= 3
    ? (() => {
        const avgPred = scored.reduce((a, t) => a + t.predictedWinPct!, 0) / scored.length;
        const hit = (scored.filter((t) => t.reachedTarget).length / scored.length) * 100;
        const wins = scored.filter((t) => (t.pnlUsd ?? 0) > 0).length;
        const pnl = scored.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
        if (opts.agentBrief) return `The last ${scored.length} trades the agents on this account took: the chance at entry averaged ${avgPred.toFixed(0)}%; the minimum-profit level (or, on older trades, the target) was actually reached ${hit.toFixed(0)}% of the time; ${wins} of ${scored.length} closed in profit; total P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}.`;
        return `Your track record on the last ${scored.length} bot trades: you predicted on average ${avgPred.toFixed(0)}% win chance; the target was actually reached ${hit.toFixed(0)}% of the time; ${wins} of ${scored.length} closed in profit; total P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}.${hit < avgPred - 10 ? " Your win chances have been too optimistic: lower them, or plan closer targets / better entries." : ""}`;
      })()
    : "Not enough bot trades yet to score your past predictions.";
  const ex = {
    be: cfg?.breakEvenAtPct ?? 8,
    lock: cfg?.lockPct ?? 50,
    half: cfg?.partialAtPct ?? 100,
    trail: cfg?.trailPct ?? 3,
    minWin: cfg ? minWin(cfg) : 45,
  };
  const journal = tradeJournal(state.trades, pool, pair.symbol);
  // Agents: the prediction engine. Past forecasts on this coin are scored first, then the
  // forecast desk is built from the same candles the AI is about to read.
  const cost = roundTripCostPct();
  const managed = opts.agentBrief ? state.trades.filter((t) => t.strategy === "agents" && t.side === "SELL" && t.reachedTarget && t.usd - (t.pnlUsd ?? 0) > 0) : [];
  const measuredWinPct = managed.length >= 5 ? managed.reduce((s, t) => s + ((t.pnlUsd ?? 0) / (t.usd - (t.pnlUsd ?? 0))) * 100, 0) / managed.length : undefined;
  let D: Desk | null = null, deskOut: ReturnType<typeof deskReport> = null;
  if (opts.agentBrief) {
    const c1 = frames.find((f) => f.tf === "1m")?.candles ?? [], c5 = frames.find((f) => f.tf === "5m")?.candles ?? [];
    try {
      settleForecasts(pool, c1, c5);
      D = desk(c1, c5, cost, PM_RULE_TRAIL);
      deskOut = deskReport(D, cost, measuredWinPct, state.fc?.stats, usualSwing(c1), usualSwing(c5));
    } catch (err: any) {
      console.error("[predict]", err?.message ?? err); // the plan goes ahead on the AI alone
      D = null;
    }
  }
  const context = [
    opts.agentBrief ?? "",
    deskOut?.text ?? "",
    patternsText(patterns),
    journal,
    cfg && strongOn(cfg)
      ? `Strong mode is ON: a dip order is only bought after the price bounces off its low (by about ${Math.max(0.6, (primary.snap?.atrPct ?? 1) * 0.5).toFixed(1)}%), never far above the dip price; breakouts must still be above the level when checked; your win chances are scaled by this account's real results${(() => { const f = oddsFactor(state.trades); return f < 1 ? ` (currently x${f.toFixed(2)}: be more conservative)` : ""; })()}.`
      : "",
    recent.length
      ? `Recent bot trades on this coin (newest first): ${recent.map((t) => `${new Date(t.time).toISOString().slice(11, 16)} UTC ${(t.pnlUsd ?? 0) >= 0 ? "+" : ""}$${(t.pnlUsd ?? 0).toFixed(2)} (${t.reason})`).join("; ")}.`
      : "No recent bot trades on this coin.",
    record,
    ...(opts.agentBrief ? [] : [
    dipsBlocked
      ? `IMPORTANT: right now the bot will NOT fill buy_dip or buy_now orders (${trendDown ? "the 1-hour trend is down" : `the coin fell ${Math.abs(pair.change.h1).toFixed(1)}% in the last hour`}). Only a buy_breakout can be used; otherwise choose AVOID.`
      : `Dip and buy-now orders are allowed right now (the bot pauses them if the 1-hour trend turns down or the coin falls more than ${maxDrop}% in an hour).`,
    `Exact exit rules: once up ${ex.be}%, the stop moves to break-even, then a profit lock keeps at least ${ex.lock}% of the best gain; it sells half at ${ex.half}% of the way from entry to your target; at the target it trails ${ex.trail}% below the highest price. Orders with a win chance below ${ex.minWin}% are not used. After a losing trade it waits before re-buying, and skips the coin for the day after 2 losses.`,
    ]),
  ].filter(Boolean).join("\n");
  if ((await tokensLeft()) <= 0) throw new Error("You've used this month's AI tokens for your plan. Upgrade your plan or wait for next month.");
  // Agents: an order is judged on the combined chance (its AI, the numbers, the forecaster panel),
  // and a win counts as what managed winners really made (measured once there are 5; simulated before).
  const seen = new Map<string, Forecast | null>();
  const judge: AgentEval | undefined = opts.agentBrief
    ? {
        minNetPct: AGENT_NET_TARGET,
        ...(measuredWinPct !== undefined ? { measuredWinPct } : {}),
        stats: state.fc?.stats,
        predict: (o, validMinutes) => {
          const k = orderKey(o);
          if (!seen.has(k)) seen.set(k, D?.ready ? D.forecast(shapeOf(o, pair.priceUsd, cost, validMinutes)) : null);
          return seen.get(k) ?? null;
        },
      }
    : undefined;
  const first = await analyze(pair, frames, cost, context, opts.forBot ? BOT_MODEL : undefined, judge);
  const results = first.results;
  let consensus = first.consensus;
  // The forecaster panel: asked only about orders that pass on the agent's AI and the numbers.
  const passing = consensus.orders.filter((o) => !o.warning && o.prediction);
  // (not when the agent was stopped while its AI was thinking: nothing will be bought)
  if (judge && passing.length && state.bot.running && !(await stoppedElsewhere()) && (await tokensLeft()) > 0) {
    try {
      const plan = results.find((r) => r.ok);
      const validMin = Math.max(5, Math.round((consensus.expiresAt - Date.now()) / 60_000));
      const money = (v: number) => `$${Number(v.toPrecision(6))}`;
      const t = chain === "solana" && pair.tokenAddress ? await tokenInfo(pair.tokenAddress) : null;
      const panel = await Promise.race([
        forecastPanel({
          pair, frames, costPct: cost, minNetPct: AGENT_NET_TARGET,
          orders: passing.map((o) => {
            const sh = shapeOf(o, pair.priceUsd, cost, validMin);
            const how = sh.immediate ? `buy now at about ${money(sh.entry)}` : o.kind === "buy_breakout" ? `buy if it breaks above ${money(sh.entry)} within ${validMin} min` : `buy if it falls to ${money(sh.entry)} within ${validMin} min`;
            return { text: `${how}: stop ${money(o.stopLoss)} (${sh.downPct.toFixed(1)}% below the entry), minimum-profit level ${money(sh.entry * (1 + sh.upPct / 100))} (${sh.upPct.toFixed(1)}% above), time limit ${Math.round(sh.holdMin)} min.` };
          }),
          numbers: passing.map((o, i) => `Order ${i + 1}: ${o.prediction!.parts.filter((p) => p.key !== "ai").map((p) => `${p.label.toLowerCase()} ${Math.round(p.pct)}%${p.note ? ` (${p.note})` : ""}`).join("; ") || "no history to work from"}.`).join("\n") + (deskOut ? `\n${deskOut.text.split("\n").filter((l) => /simulated paths put the price|most like this one/.test(l)).join("\n")}` : ""),
          traderCase: plan && plan.ok ? plan.signal.reasoning : "",
          flow: t ? flowText(t) : "",
          market: chain === "solana" ? await marketText(pair.tokenAddress).catch(() => "") : "",
          patterns: patternsText(patterns),
        }),
        new Promise<never>((_, no) => setTimeout(() => no(new Error("the forecaster panel took too long")), 20_000)),
      ]);
      results.push({ model: "Forecaster panel", ok: false, error: "", ms: 0, tokens: panel.tokens }); // counted in the token bill below
      judge.panel = new Map(passing.map((o, i) => [orderKey(o), { pct: panel.chances[i], votes: panel.votes.map((v) => ({ who: v.who, pct: Math.round(v.chances[i]), reason: v.reason })) }]));
      consensus = combine(results.filter((r) => r.model !== "Forecaster panel"), cost, pair.priceUsd, judge);
      for (const o of consensus.orders) {
        const v = judge.panel.get(orderKey(o));
        if (v && o.prediction) log(`Forecaster panel on the ${o.kind.replace("buy_", "").replace("now", "buy-now")} order: ${v.votes.map((x) => `${x.who.toLowerCase()} ${x.pct}%`).join(", ")}. Combined chance ${Math.round(o.prediction.pWin)}% (needs ${Math.ceil(o.prediction.needPct)}%): ${o.warning ? "not used" : "used"}.`, o.warning ? "info" : "good");
      }
    } catch (err: any) {
      log(`${err?.message ?? "The forecaster panel could not be asked"}: the order is judged on the agent's AI and the numbers.`);
    }
  }
  if (judge) recordForecasts(pair, consensus, cost);
  const appTokens = await chargeTokens(results);
  const model = opts.forBot ? BOT_MODEL : CLAUDE_MODEL;
  const apiTokens = results.reduce((s, r) => s + (r.tokens ?? 0), 0);
  rec("ai.analysis", `${opts.forBot ? "Bot re-plan" : "AI analysis"} on ${pair.symbol}: ${apiTokens.toLocaleString()} AI tokens (${appTokens.toLocaleString()} app tokens)`, { symbol: pair.symbol, pool, model, apiTokens, appTokens, forBot: !!opts.forBot, stance: consensus.stance });
  const shown = results.filter((r) => r.model !== "Forecaster panel");
  // Your own Analyze (from the dashboard) never replaces the plan of an agent that is running:
  // the agent's orders are judged differently (the prediction check) and must stay its own.
  // The analysis is still returned to you; it just isn't something the agent trades on.
  if (opts.forBot || !state.bot.running) {
    state.lastSignal = { at: Date.now(), pool, symbol: pair.symbol, tf, results: shown, consensus, trendDown, atrPct: primary.snap.atrPct, patterns, priceAt: pair.priceUsd, ...(deskOut ? { desk: deskOut.view } : {}) };
    state.bot.armedSince = []; // a new plan: its triggers start fresh
    state.bot.skipNoted = [];
  }
  save();
  return { pair, snapshot: snap, results: shown, consensus, patterns };
}

// ---------- Bot ----------
// Locally a timer calls tick() every checkEverySec. On Vercel there are no
// long-lived timers, so /api/bot/heartbeat (from an open dashboard) and
// /api/bot/tick (from a scheduler) call it instead.


const isAuto = (cfg: BotConfig) => cfg.pick === "auto";
// The minimum win chance in force: lower in risky mode (the user accepted the risk).
// A setting the user switched off (Settings → its checkbox → "I understand").
export const isOff = (cfg: Pick<BotConfig, "disabled"> | null | undefined, key: string) => !!cfg?.disabled?.includes(key);
const minWin = (cfg: BotConfig) => (isOff(cfg, "minConfidence") ? 0 : cfg.allowRisky ? Math.min(cfg.minConfidence, cfg.riskyMinWin ?? 30) : cfg.minConfidence);
const isNew = (cfg: BotConfig) => cfg.pick === "newcoins";
const isAgents = (cfg: BotConfig) => cfg.pick === "agents";
const isCoinAgent = (cfg: BotConfig) => cfg.pick === "agent";
// Extra slippage on thin liquidity: buying size S from a pool with liquidity L moves the
// price roughly 2*S/L (each side of the pool holds about half). Clamped to 0.2-10%.
const thinSlipPct = (usd: number, liquidityUsd: number) => Math.min(10, Math.max(0.2, (200 * usd) / Math.max(liquidityUsd, 1)));

// Start agent `botId` ("1" to "10"). Slots after the first are created on first start.
// maxBots comes from the plan; two bots never trade the same coin.
// A coin picture must be a plain web address (it is shown as an image on the agent's card).
const okImage = (u: unknown): u is string => typeof u === "string" && u.length <= 400 && /^https:\/\/[^\s"'<>]+$/.test(u);

export function startBot(cfg: BotConfig, botId = "1", maxBots = 10) {
  if (!/^(?:[1-9]|10)$/.test(botId)) throw new Error("No free agent slot. Stop an agent first.");
  const id = botId;
  const st = acct().state;
  const others = runningIds(st).filter((x) => x !== id);
  if (others.length + 1 > maxBots) throw new Error(maxBots <= 1 ? "Your plan includes 1 agent. Stop it first, or see Plans for more." : `Your plan includes ${maxBots} agents and they're all running. Stop one first, or see Plans for more.`);
  if (!okImage(cfg.imageUrl)) delete cfg.imageUrl;
  if (cfg.pick === "agent") {
    const budget = Number(cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT);
    if (!(budget >= 10)) throw new Error("An agent's budget must be at least $10.");
    const free = availableCash(st, id);
    if (budget > free + 0.005) throw new Error(`Only $${free.toFixed(2)} is available${st.cash - free > 0.005 ? ` ($${(st.cash - free).toFixed(2)} is locked for your other agents)` : ""}. Lower the budget or free some cash.`);
    cfg.budgetUsd = Math.floor(budget * 100) / 100;
  }
  if (cfg.pick !== "auto" && cfg.pool)
    for (const o of others) {
      const ob = o === "1" ? st.bot : slotOf(st, o)!.bot;
      const busy = ob.config?.pool === cfg.pool || st.positions.some((p) => p.source === "bot" && (p.botId ?? "1") === o && p.pool === cfg.pool);
      if (busy) throw new Error(`Bot ${o} is already trading ${cfg.symbol}. Pick another coin for this bot.`);
    }
  if (id !== "1" && !slotOf(st, id)) {
    st.bots = [...(st.bots ?? []), { id, bot: { ...fresh().bot, coinStats: {}, day: null }, lastSignal: null }].sort((a, b) => a.id.localeCompare(b.id));
  }
  return withBot(id, () => {
    startBotHere(cfg);
    if (cfg.pick !== "auto" && cfg.pool) adoptManualPosition(cfg);
  });
}

// "Buy by hand, let the bot sell": starting a bot on a coin you hold hands that position to the
// bot. It keeps any exit you set; otherwise the exit is 8% below the current price and the target
// 16% up (gain twice the risk). Then break-even, profit lock, take-half and trailing apply.
const ADOPT_RISK = 0.08;
function adoptManualPosition(cfg: BotConfig) {
  const id = currentBotId();
  if (state.positions.some((p) => p.source === "bot" && p.pool === cfg.pool)) return;
  const p = state.positions.find((x) => x.source === "manual" && x.pool === cfg.pool);
  if (!p) return;
  const now = p.lastPrice || p.entryPrice;
  p.source = "bot";
  p.botId = id;
  p.adopted = true;
  if (!(p.stopLoss && p.stopLoss < now)) p.stopLoss = now * (1 - ADOPT_RISK);
  if (!(p.target && p.target > now)) p.target = Math.max(p.entryPrice, now) * (1 + 2 * ADOPT_RISK);
  p.takeProfit = p.target;
  p.trailPct = trailFor(cfg, state.lastSignal?.atrPct);
  delete p.protectPct; // the bot's exits replace "Protect this trade"
  delete p.protectSince;
  rec("bot.setting", `Bot ${id} took over your ${p.symbol} position to sell it automatically`, { positionId: p.id, symbol: p.symbol, stopLoss: p.stopLoss, target: p.target });
  log(`Took over your ${p.symbol} position (${fmt(p.entryPrice)} entry). It sells below ${fmt(p.stopLoss)}; at ${fmt(p.target)} it starts trailing ${p.trailPct}% below the high.`, "good");
  save();
}

// A sell you make yourself. Selling a coin a bot bought stops that bot, so it doesn't buy it back.
export function sellByUser(positionId: string, price: number, fraction: number) {
  const p = state.positions.find((x) => x.id === positionId);
  const t = sell(positionId, price, fraction, "Manual sell");
  if (p && p.source === "bot") {
    const id = p.botId ?? "1";
    withBot(id, () => {
      if (state.bot.running) stopBot(`You sold ${p.symbol} yourself, so bot ${id} stopped. Start it again to keep trading.`);
    });
  }
  return t;
}

function startBotHere(cfg: BotConfig) {
  if (isAuto(cfg)) {
    cfg.autoChain ??= "all";
    cfg.autoCandidates = Math.min(5, Math.max(1, cfg.autoCandidates ?? 3));
    cfg.autoMinLiquidityUsd ??= 50_000;
  }
  rec("bot.start", `Bot started on ${cfg.symbol} (${cfg.pick === "auto" ? "auto-pick" : cfg.pick === "agents" ? "agents" : cfg.pick === "agent" ? `agent, $${cfg.budgetUsd ?? 1000} budget` : "this coin"})${cfg.allowRisky ? " in risky mode" : ""}`, {
    symbol: cfg.symbol, pool: cfg.pool, pick: cfg.pick ?? "this", positionPct: cfg.positionPct, riskPerTradePct: cfg.riskPerTradePct, minConfidence: cfg.minConfidence,
    dailyLossPct: cfg.dailyLossPct, maxDrawdownPct: cfg.maxDrawdownPct, allowRisky: !!cfg.allowRisky, settingsOff: cfg.disabled ?? [], rewardRule: cfg.rewardRule !== false, strongMode: cfg.strongMode !== false,
  });
  if (cfg.allowRisky)
    rec("consent.risky_mode", `Accepted "I understand, trade anyway" for ${cfg.symbol}`, {
      symbol: cfg.symbol,
      warningsShown: cfg.riskReasons ?? [],
      note: "In risky mode the bot buys even while the coin is falling and doesn't pause after losing trades on it. Exits, minimum win chance, the daily loss limit and the emergency stop still apply.",
    });
  cfg.startEquity = equity(); // the emergency stop counts from today's account value, not the original deposit
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
  state.bot.learned = undefined; // an agent learns its (possibly new) coin afresh
  state.bot.aiNotes = [];
  state.bot.lastFiredAt = undefined;
  state.bot.watch = null;
  state.bot.stoppedAt = null;
  cfg.trailPct = clampNum(cfg.trailPct ?? 3, 0.5, 30);
  log(
    isNew(cfg)
      ? `Bot started in NEW COINS mode (${cfg.newChain ?? "solana"}): ${cfg.newCoinPct ?? 3}% per coin, stop -${cfg.newStopPct ?? 15}%, half at +${cfg.newTakePct ?? 30}%, max ${cfg.newMaxPerDay ?? 5} buys a day. Cash $${state.cash.toFixed(2)}.`
      : isAuto(cfg)
      ? `Bot started in AUTO-PICK mode (${cfg.autoChain === "all" ? "all chains" : cfg.autoChain}). Each round the AI checks the top ${cfg.autoCandidates} coins. Cash $${state.cash.toFixed(2)}.`
      : isCoinAgent(cfg)
        ? `Agent started on ${cfg.symbol} with a $${cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT} budget. Its AI is reading the charts and deciding now.`
      : `Bot started on ${cfg.symbol} (${cfg.tf}). Paper mode. Cash $${state.cash.toFixed(2)}.${cfg.allowRisky ? " RISKY MODE: it will also buy while the coin is falling (you accepted the risk). Trades are capped at 25% of the account, with a 5-minute cool-down after a loss." : ""}`,
    "good",
  );
  save();
  schedule();
}

export function stopBot(reason = "Stopped by user", botId?: string): void {
  if (botId && botId !== currentBotId()) return withBot(botId, () => stopBot(reason));
  if (state.bot.running) rec("bot.stop", `Bot stopped: ${reason}`, { reason });
  const at = Date.now();
  const id = currentBotId();
  state.bot.running = false;
  state.bot.stoppedAt = at;
  state.bot.target = null;
  queueCtl((c) => { c.stops = { ...(c.stops ?? {}), [id]: at }; }); // so no other copy can save it back as running
  log(`${isCoinAgent(state.bot.config ?? ({} as BotConfig)) ? "Agent" : "Bot"} stopped: ${reason}`, "bad");
  save();
}

// Remove a stopped extra bot (bots 2 and 3). Its trade history stays.
export function removeBot(botId: string) {
  const st = acct().state;
  const slot = slotOf(st, botId);
  if (!slot) throw new Error("That bot doesn't exist");
  if (slot.bot.running) throw new Error(`Stop bot ${botId} first`);
  if (st.positions.some((p) => p.source === "bot" && p.botId === botId)) throw new Error(`Bot ${botId} still holds a position: let it close or sell it first`);
  st.bots = (st.bots ?? []).filter((b) => b.id !== botId);
  save();
  return { ok: true };
}

function schedule() {
  // Locally a single loop (bottom of this file) runs every active account every 5 s; on
  // Vercel, heartbeat / tick requests do. Run the first step right away.
  if (!process.env.VERCEL && anyBotRunning()) void tick();
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
  if (isOff(cfg, "dailyLossPct")) return null; // switched off by the user
  if (state.bot.dailyOverride === today) return null; // the user chose to keep trading today
  const lostPct = ((state.bot.day.startEquity - equity()) / state.bot.day.startEquity) * 100;
  return lostPct >= limit ? `daily loss limit reached (down ${lostPct.toFixed(1)}% today, limit ${limit}%); resumes at 00:00 UTC` : null;
}

// Cool-down: after a loss, wait before re-buying the coin; after 2 losses in a row, skip it for the day.
// Risky mode keeps both, with a short cool-down (it used to skip them and re-bought a minute
// after each stop-loss).
export const RISKY_COOLDOWN_MIN = 5;
function coinBlock(cfg: BotConfig, pool: string, symbol: string): string | null {
  if (isOff(cfg, "cooldownMin")) return null; // switched off by the user
  const cs = state.bot.coinStats[pool];
  if (!cs || !cs.losses) return null;
  if (cs.losses >= 2 && cs.lossDay === utcDay()) return `${symbol} lost ${cs.losses} trades in a row today, so it's skipped until 00:00 UTC`;
  const until = cs.lastLossAt + (cfg.allowRisky ? RISKY_COOLDOWN_MIN : (cfg.cooldownMin ?? 30)) * 60_000;
  return Date.now() < until ? `cooling down on ${symbol} after a losing trade, until ${clock(until)}` : null;
}

// Profit guard: protection starts at the "protect" setting, but never later than fees + 1.5%,
// and then locks at least fees + 0.5% (a small profit after costs).
export const GUARD_EXTRA_PCT = 1.5;
export const GUARD_PROFIT_PCT = 0.5;
export const protectAt = (cfg: Pick<BotConfig, "breakEvenAtPct">, cost: number) => Math.max(cost + 1, Math.min(cfg.breakEvenAtPct, cost + GUARD_EXTRA_PCT));
// ---------- Strong mode ----------
// Extra filters on entries (never on exits): honest odds from your own results, no dip buys in a
// down-trend, wait for a bounce off the low, breakouts must hold, a pause after a losing streak,
// and AVOID / fee-failing setups are skipped even in risky mode. On unless the user turns it off.
export const strongOn = (cfg: BotConfig) => cfg.strongMode !== false && !isOff(cfg, "strongMode");
export const STREAK_LOSSES = 3;
export const STREAK_PAUSE_MIN = 60;
// How much to trust the AI's win chances: your bots' real win rate vs what the AI predicted
// (last 30 scored trades; needs 8+). Never above 1, never below 0.5.
export function oddsFactor(trades: Trade[]) {
  const scored = trades.filter((t) => t.source === "bot" && t.side === "SELL" && typeof t.predictedWinPct === "number").slice(0, 30);
  if (scored.length < 8) return 1;
  const pred = scored.reduce((s, t) => s + (t.predictedWinPct ?? 0), 0) / scored.length;
  const won = (scored.filter((t) => (t.pnlUsd ?? 0) > 0).length / scored.length) * 100;
  if (!(pred > 0)) return 1;
  return Math.max(0.5, Math.min(1, won / pred));
}
// Losing streak across all the account's bots: the last N bot sells were all losses.
export function streakPauseUntil(trades: Trade[]): number | null {
  const sells = trades.filter((t) => t.source === "bot" && t.side === "SELL").slice(0, STREAK_LOSSES);
  if (sells.length < STREAK_LOSSES || sells.some((t) => (t.pnlUsd ?? 0) >= 0)) return null;
  const until = sells[0].time + STREAK_PAUSE_MIN * 60_000;
  return Date.now() < until ? until : null;
}
// ---------- Trade journal for the AI ----------
// What the account's bot trades taught us, summarised for the AI so it plans with real results:
// how each kind of setup has done, how fast losing trades get stopped out, and this coin's day.
type Trip = { pool: string; symbol: string; setup: "dip" | "breakout" | "now"; openedAt: number; closedAt: number; pnl: number; pnlPct: number; stopped: boolean; cost: number; patterns: string[] };
export function botTrips(trades: Trade[]): Trip[] {
  const out: Trip[] = [];
  const open = new Map<string, Trip>();
  for (const t of [...trades].reverse()) { // oldest first
    if (t.source !== "bot") continue;
    const k = `${t.pool}:${t.botId ?? "1"}`;
    if (t.side === "BUY") {
      const setup = /breakout/.test(t.reason) ? "breakout" : /dip/.test(t.reason) ? "dip" : "now";
      open.set(k, { pool: t.pool, symbol: t.symbol, setup, openedAt: t.time, closedAt: 0, pnl: 0, pnlPct: 0, stopped: false, cost: t.usd, patterns: t.patterns ?? [] });
    } else {
      const tr = open.get(k);
      if (!tr) continue;
      tr.pnl += t.pnlUsd ?? 0;
      if (/Took half/.test(t.reason)) continue; // the rest is still open
      tr.closedAt = t.time;
      tr.stopped = /Stop-loss|Emergency/.test(t.reason);
      tr.pnlPct = tr.cost > 0 ? (tr.pnl / tr.cost) * 100 : 0;
      out.push(tr);
      open.delete(k);
    }
  }
  return out.reverse(); // newest first
}
export function tradeJournal(trades: Trade[], pool: string, symbol: string): string {
  const trips = botTrips(trades).slice(0, 40);
  if (trips.length < 3) return "Trade journal: fewer than 3 finished bot trades so far, so no pattern yet.";
  const lines: string[] = [];
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const won = trips.filter((t) => t.pnl > 0);
  lines.push(`Trade journal (this account's last ${trips.length} finished bot trades): ${won.length} profitable (${pct(won.length, trips.length)}%), average result ${(trips.reduce((s, t) => s + t.pnlPct, 0) / trips.length).toFixed(1)}% per trade after fees.`);
  for (const k of ["dip", "breakout", "now"] as const) {
    const xs = trips.filter((t) => t.setup === k);
    if (!xs.length) continue;
    lines.push(`- ${k === "dip" ? "Dip buys" : k === "breakout" ? "Breakout buys" : "Buy-now orders"}: ${xs.length} trades, ${xs.filter((t) => t.pnl > 0).length} profitable, average ${(xs.reduce((s, t) => s + t.pnlPct, 0) / xs.length).toFixed(1)}%.`);
  }
  // How trades did by the chart pattern on screen when the bot bought (2+ trades each).
  const byPat = new Map<string, Trip[]>();
  for (const t of trips) for (const p of t.patterns) byPat.set(p, [...(byPat.get(p) ?? []), t]);
  const patLines = [...byPat].filter(([, xs]) => xs.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 6)
    .map(([p, xs]) => `${p}: ${xs.length} trades, ${xs.filter((t) => t.pnl > 0).length} profitable, average ${(xs.reduce((s, t) => s + t.pnlPct, 0) / xs.length).toFixed(1)}%`);
  if (patLines.length) lines.push(`- By chart pattern at the buy: ${patLines.join("; ")}.`);
  const stops = trips.filter((t) => t.stopped);
  if (stops.length) {
    const mins = stops.map((t) => (t.closedAt - t.openedAt) / 60_000).sort((a, b) => a - b);
    const fast = mins.filter((m) => m <= 15).length;
    lines.push(`- ${stops.length} trades hit the exit; median time from buy to exit ${Math.round(mins[Math.floor(mins.length / 2)])} min${fast ? ` (${fast} within 15 min: entries were early, or exits sat inside normal noise; place exits beyond recent swing lows and prefer confirmed entries)` : ""}.`);
  }
  const winsHeld = won.map((t) => (t.closedAt - t.openedAt) / 60_000);
  if (winsHeld.length) lines.push(`- Winning trades were held about ${Math.round(winsHeld.reduce((a, b) => a + b, 0) / winsHeld.length)} min on average.`);
  const coin = trips.filter((t) => t.pool === pool);
  if (coin.length) lines.push(`- On ${symbol}: ${coin.length} finished trades, ${coin.filter((t) => t.pnl > 0).length} profitable, last ${coin.slice(0, 3).map((t) => `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}% (${t.setup})`).join(", ")}.`);
  const last5 = trips.slice(0, 5);
  if (last5.length === 5 && last5.every((t) => t.pnl <= 0)) lines.push("- The last 5 trades all lost: the market may have turned against these setups. Prefer AVOID unless the setup is clearly better than recent ones.");
  return lines.join("\n");
}

export const MIN_REWARD_RISK = 1.5; // gain after fees must be at least this many times the loss
export const RISKY_MAX_POSITION_PCT = 25; // risky mode: at most this % of the account per trade
// Trailing stop sized to how much the coin normally swings: 3x its average 5-minute range,
// never tighter than the setting, never wider than 12%.
// The AI's second look at a trade that hit its stop-loss or its time limit. Hard limits:
// - at the stop: once per trade; the new exit is never lower than entry - 1.5x the original risk
// - at the time limit: the exit can only stay or rise; at most 3 extensions of 10-120 min
// - the AI must give a win chance at or above your minimum, a target that is a profit after
//   costs, and holding must make money on average from here; otherwise (or on any error) it sells.
export const SECOND_LOOK_MAX_RISK = 1.5;
async function secondLook(cfg: BotConfig, pos: Position, price: number, why: "stop" | "time"): Promise<boolean> {
  const firstStop = pos.firstStop ?? pos.stopLoss ?? 0;
  const risk = pos.entryPrice - firstStop;
  const hardFloor = why === "stop" ? pos.entryPrice - SECOND_LOOK_MAX_RISK * risk : (pos.stopLoss ?? 0);
  if (why === "stop" && (!(risk > 0) || price <= hardFloor)) return false;
  try {
    const pair = await getPair(pos.chain, pos.pool);
    const frames = await loadFrames(pos.chain, pos.pool, pair, ["5s", "1m", "5m", "1h"]);
    const pats = frames.map((f) => findPatterns(f.tf, f.candles));
    const cost = roundTripCostPct();
    const d = await Promise.race([
      reviewHold({ pair, frames, costPct: cost, why, entry: pos.entryPrice, price, stop: pos.stopLoss ?? 0, hardFloor, heldMin: (Date.now() - pos.openedAt) / 60_000, target: pos.target, patterns: patternsText(pats) }),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("took too long")), 45_000)),
    ]);
    await chargeTokens([{ model: BOT_MODEL, ok: false, error: "", ms: 0, tokens: d.tokens }]);
    // The price may have moved while the AI was thinking.
    const now = (await quote(pos.chain, pos.pool, Date.now() - 15_000)).price || price;
    const exit = why === "stop" ? Math.max(hardFloor, d.lastExit) : Math.max(pos.stopLoss ?? 0, d.lastExit);
    const p = Math.max(0, Math.min(100, d.winChancePct)) / 100;
    const ev = p * ((d.target - now) / now) - (1 - p) * ((now - exit) / now);
    const profitTarget = d.target >= pos.entryPrice * (1 + cost / 100);
    const ok = d.hold && d.winChancePct >= minWin(cfg) && profitTarget && ev > 0 && exit > 0 && exit < now * 0.998 && now > hardFloor;
    const tag = why === "stop" ? "at the stop-loss" : "at the time limit";
    if (!ok) {
      log(`AI second look ${tag} on ${pos.symbol}: sell. ${d.hold ? `It wanted to hold, but the bot's limits said no (${d.winChancePct}% win chance${profitTarget ? "" : ", target not a profit after fees"}${ev > 0 ? "" : ", loses on average from here"}).` : d.reason}`);
      return false;
    }
    const mins = Math.round(Math.max(10, Math.min(120, d.extraMinutes || 30)));
    if (why === "stop") {
      pos.firstStop = firstStop;
      pos.secondLook = true;
    } else pos.extensions = (pos.extensions ?? 0) + 1;
    pos.stopLoss = exit;
    delete pos.underSince; // the new exit starts its own count
    pos.locked = false;
    pos.sellBy = Date.now() + mins * 60_000;
    if (!pos.trailing) {
      pos.target = d.target;
      pos.takeProfit = d.target;
    }
    acct().dirty = true;
    log(`AI second look ${tag} on ${pos.symbol}: holding (${d.winChancePct}% win chance to reach ${fmt(d.target)}). New last exit ${fmt(exit)}, for up to ${mins} more min. ${d.reason}`, "good");
    alert(`🧠 ${pos.symbol}: AI kept the trade open ${tag}. Last exit ${fmt(exit)}, target ${fmt(d.target)}. ${d.reason}`);
    rec("ai.analysis", `AI second look on ${pos.symbol}: held ${tag}`, { symbol: pos.symbol, pool: pos.pool, model: BOT_MODEL, apiTokens: d.tokens, why, exit, target: d.target, winChancePct: d.winChancePct });
    return true;
  } catch (e: any) {
    log(`AI second look on ${pos.symbol} failed (${e?.message ?? e}): selling as planned.`, "bad");
    return false;
  }
}

export function trailFor(cfg: Pick<BotConfig, "trailPct">, atrPct?: number) {
  const base = cfg.trailPct ?? 3;
  const swing = atrPct && Number.isFinite(atrPct) ? atrPct * 3 : 0;
  return Math.round(clampNum(Math.max(base, swing), 0.5, Math.max(base, 12)) * 10) / 10;
}
const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const MIN_CLAUDE_GAP_MS = 2 * 60_000; // never ask Claude more often than this, whatever happens
const fmt = (n: number) => `$${n.toPrecision(4)}`;

// Coins the account's other bots are trading or holding (so two bots never trade one coin).
function otherBotPools() {
  const st = acct().state;
  const me = currentBotId();
  const out = new Set<string>();
  for (const id of botIds(st)) {
    if (id === me) continue;
    const b = id === "1" ? st.bot : slotOf(st, id)!.bot;
    if (b.running) {
      if (b.config?.pick !== "auto" && b.config?.pool) out.add(b.config.pool);
      if (b.target?.pool) out.add(b.target.pool);
    }
  }
  for (const p of st.positions) if (p.source === "bot" && (p.botId ?? "1") !== me) out.add(p.pool);
  return out;
}

// Auto-pick: scan trending coins, ask Claude for a plan on the best few, keep the best plan.
async function autoPick(cfg: BotConfig) {
  const scan = await scanOpportunities(cfg.autoChain ?? "all", roundTripCostPct(), cfg.autoMinLiquidityUsd ?? 50_000);
  const taken = otherBotPools();
  const inZone = scan.rows.filter((r) => r.plan?.verdict === "BUY ZONE" && !taken.has(r.pair.pool) && !coinBlock(cfg, r.pair.pool, r.pair.symbol)).slice(0, cfg.autoCandidates ?? 3);
  state.bot.target = null;
  state.bot.candidates = [];
  state.lastSignal = null;
  if (!inZone.length) {
    log(`Scanned ${scan.rows.length} trending coins: none in the buy zone right now.`);
    return;
  }
  log(`Asking the AI for plans on ${inZone.map((r) => r.pair.symbol).join(", ")}...`);
  let best: { pair: PairInfo; result: Awaited<ReturnType<typeof runAnalysis>> } | null = null;
  const usableOrders = (c: Consensus) => c.orders.filter((o) => o.winChancePct >= minWin(cfg));
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
  state.lastSignal = { at: Date.now(), pool: pair.pool, symbol: pair.symbol, tf: cfg.tf, results: result.results, consensus: result.consensus, atrPct: result.snapshot?.atrPct, patterns: result.patterns };
  log(`Auto-pick chose ${pair.symbol}. AI: ${summary}. ${result.consensus.note}`, "good");
}

// Why Claude should be asked now (or null). Event-driven, plus a slow backup timer.
// `dex` = this pool's own price (what the plan's price was taken from).
function claudeDue(cfg: BotConfig, price: number | null, dex: number | null = price): string | null {
  const sig = state.lastSignal;
  const tgtPool = isAuto(cfg) ? state.bot.target?.pool : cfg.pool;
  if (state.bot.askNow) return "the last trade closed";
  if (!sig || !tgtPool || sig.pool !== tgtPool) return state.bot.lastAnalysisAt ? "no plan to follow" : "starting up";
  const c = sig.consensus;
  if (Date.now() > c.expiresAt) return "the plan expired";
  if (price !== null && c.cancelBelow > 0 && price < c.cancelBelow) return `the price fell below the plan's cancel level (${fmt(c.cancelBelow)})`;
  if (price !== null && c.cancelAbove > 0 && price > c.cancelAbove) return `the price rose above the plan's range (${fmt(c.cancelAbove)})`;
  // The price has come to a level the AI named when the odds weren't good enough for an order:
  // that is the moment to look again, with what the chart shows now. Only for a plan with no
  // live order, only for a level that was still away from the price when the plan was made, and
  // judged on the pool's own price (the plan's price), so two data sources can't fake a touch.
  if (isCoinAgent(cfg) && dex !== null && sig.priceAt && Date.now() - sig.at >= AGENT_TOUCH_GAP_MS && !c.orders.some((o) => !o.warning)) {
    const hit = c.orders.find((o) =>
      o.kind === "buy_dip" ? sig.priceAt! > o.triggerPrice * 1.003 && dex <= o.triggerPrice
        : o.kind === "buy_breakout" ? sig.priceAt! < o.triggerPrice * 0.997 && dex >= o.triggerPrice
          : false);
    if (hit) return `the price reached the ${hit.kind === "buy_dip" ? "dip" : "breakout"} level ${fmt(hit.triggerPrice)} it was watching`;
  }
  // A real move since the plan: 4%, or one of the coin's usual 5-minute swings if that is bigger
  // (a very jumpy coin wiggles 4% all the time), measured on the same pool price the plan was
  // made at, and not within 90 s of that plan, so the AI is never asked every half minute.
  const moveAt = Math.max(AGENT_MOVE_PCT, sig.atrPct ?? 0);
  if (isCoinAgent(cfg) && dex !== null && sig.priceAt && Date.now() - sig.at >= 90_000 && (Math.abs(dex - sig.priceAt) / sig.priceAt) * 100 >= moveAt)
    return `the price moved ${(((dex - sig.priceAt) / sig.priceAt) * 100).toFixed(1)}% since the AI's plan`;
  if (Date.now() - state.bot.lastAnalysisAt >= cfg.analyzeEverySec * 1000) return isCoinAgent(cfg) ? "time for a fresh look" : "backup re-check";
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
type Quote = { pair: PairInfo; price: number; dex: number; low: number; high: number; peakHigh: number; closeLow: number; source: string };
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
  return { pair: { ...pair, priceUsd: price }, price, dex: pair.priceUsd, low, high, peakHigh, closeLow, source };
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

// ---------- Agents mode ----------
// Eight rule-based agents score every busy Solana coin (no AI cost); the best coin that passes
// every veto and the chart check gets one AI check, then a market buy aiming for +10% after fees.
export const AGENT_NET_TARGET = 5; // minimum % profit after all fees an agent's trade aims for; the profit ladder starts here
const AGENT_STOP_MIN = 4, AGENT_STOP_MAX = 7; // exit distance, % below the buy price
export type AgentDecision = { at: number; symbol: string; mint: string; total: number; ok: boolean; why: string };
const agentNotes = new Map<string, number>(); // mint -> skip until (failed chart / AI check)

async function bestPool(mint: string): Promise<PairInfo | null> {
  const pairs = await cachedJson<any[]>(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, 60_000).catch(() => []);
  const best = (pairs ?? []).filter((p) => p?.baseToken?.address === mint).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  return best ? fromDexScreener(best) : null;
}

function agentReport(c: AgentCoin) {
  return [`Total score ${c.total}/100.`, ...AGENT_KEYS.map((k) => `- ${k.toUpperCase()} ${Math.round(c.agents[k].score)}: ${c.agents[k].note}`)].join("\n");
}

function noteDecision(d: AgentDecision) {
  const list = (state.bot.agentLog ??= []);
  list.unshift(d);
  if (list.length > 20) list.length = 20;
}

async function agentsStep(cfg: BotConfig) {
  const today = utcDay();
  const mine = state.trades.filter((t) => t.strategy === "agents" && (t.botId ?? "1") === currentBotId());
  const buysToday = mine.filter((t) => t.side === "BUY" && utcDay(t.time) === today).length;
  const maxPerDay = cfg.agentMaxPerDay ?? 6;
  if (buysToday >= maxPerDay) return setBlocked(`agents' limit reached (${buysToday} buys today, max ${maxPerDay}); resumes at 00:00 UTC`, `agentcap:${today}`);
  if (strongOn(cfg)) {
    const pausedTill = streakPauseUntil(state.trades);
    if (pausedTill) return setBlocked(`${STREAK_LOSSES} losing trades in a row: no new buys until ${clock(pausedTill)}`, `astreak:${pausedTill}`);
  }
  setBlocked(null);
  for (const [m, until] of agentNotes) if (until < Date.now()) agentNotes.delete(m);
  const scan = await scanAgents(); // cached ~45 s
  state.bot.agentScan = { at: scan.at, scanned: scan.scanned, top: scan.coins.slice(0, 8) };
  // One trade per coin per day (no churning the same coin), nothing already held.
  const tradedToday = new Set(state.trades.filter((t) => t.strategy === "agents" && utcDay(t.time) === today).map((t) => t.pool));
  const held = new Set(state.positions.map((p) => p.tokenMint ?? p.pool));
  const picks = scan.coins.filter((c) => !c.vetoes.length && c.total >= AGENT_PASS && !agentNotes.has(c.mint) && !held.has(c.mint)).slice(0, 3);
  if (!picks.length) {
    state.bot.target = null;
    return noteOnce(`agentsidle:${Math.floor(Date.now() / 600_000)}`, `Agents: scanned ${scan.scanned} coins, none passed every check right now. Waiting.`);
  }
  for (const c of picks) {
    const pair = await bestPool(c.mint).catch(() => null);
    if (!pair || tradedToday.has(pair.pool) || coinBlock(cfg, pair.pool, pair.symbol) || state.positions.some((p) => p.pool === pair.pool)) { agentNotes.set(c.mint, Date.now() + 30 * 60_000); continue; }
    state.bot.target = { chain: pair.chain, pool: pair.pool, symbol: pair.symbol, chosenAt: Date.now() };
    // Chart check on 5-minute candles: enough movement to reach the target, no bearish pattern.
    let candles: Candle[] = [];
    try { candles = await getCandles(pair.chain, pair.pool, "5m", 300, pair); } catch { /* no chart */ }
    const skip = (why: string, mins = 30) => {
      agentNotes.set(c.mint, Date.now() + mins * 60_000);
      noteDecision({ at: Date.now(), symbol: pair.symbol, mint: c.mint, total: c.total, ok: false, why });
      log(`Agents: ${pair.symbol} (score ${c.total}) skipped: ${why}.`);
    };
    if (candles.length < 60) { skip("not enough chart history"); continue; }
    const price = candles.at(-1)!.close;
    const atrPct = (atr(candles) / price) * 100;
    const pats = findPatterns("5m", candles);
    const bad = pats.hits.find((h) => h.bias === "down");
    if (bad) { skip(`5-min chart shows ${bad.label.toLowerCase()}`); continue; }
    if (atrPct < 0.8) { skip(`moves too little (${atrPct.toFixed(2)}% per 5 min) to reach +${AGENT_NET_TARGET}% after fees`); continue; }
    const cost = roundTripCostPct();
    const swingLow = Math.min(...candles.slice(-12).map((x) => x.low));
    const stopPct = Math.min(AGENT_STOP_MAX, Math.max(AGENT_STOP_MIN, ((price - (swingLow - atr(candles) * 0.5)) / price) * 100));
    const stop = price * (1 - stopPct / 100);
    const target = price * (1 + (AGENT_NET_TARGET + cost) / 100);
    const high50 = Math.max(...candles.slice(-50).map((x) => x.high));
    if (high50 > price * 1.02 && high50 < target * 0.97 && !pats.hits.some((h) => h.key === "range_breakout" || h.key === "bull_flag")) {
      skip(`a recent high at ${fmt(high50)} sits below the +${AGENT_NET_TARGET}% target`, 20);
      continue;
    }
    // One AI check (cheap model, quick): approve or skip.
    let ai = "";
    if (cfg.agentAiCheck !== false && (await tokensLeft()) > 0) {
      try {
        const frames = await loadFrames(pair.chain, pair.pool, pair, ["5s", "5m", "1h"]);
        const d = await Promise.race([
          reviewAgentPick({ pair, frames, agentReport: agentReport(c), patterns: patternsText([pats]), entry: price, stop, target, costPct: cost }),
          new Promise<never>((_, no) => setTimeout(() => no(new Error("took too long")), 40_000)),
        ]);
        await chargeTokens([{ model: BOT_MODEL, ok: false, error: "", ms: 0, tokens: d.tokens }]);
        const p = Math.max(0, Math.min(100, d.winChancePct)) / 100;
        const ev = p * AGENT_NET_TARGET - (1 - p) * (stopPct + cost);
        if (!d.approve || ev <= 0) { skip(`AI check: ${d.approve ? `${d.winChancePct}% win chance doesn't pay after fees` : d.reason}`, 45); continue; }
        ai = ` AI: ${d.winChancePct}% win chance. ${d.reason}`;
      } catch (e: any) {
        skip(`AI check unavailable (${e?.message ?? e})`, 10);
        continue;
      }
    }
    // Buy at the live price, sized so hitting the exit loses about your risk per trade.
    let q: Quote;
    try { q = await quote(pair.chain, pair.pool, Date.now() - 10_000); } catch { skip("no live price"); continue; }
    if (!(q.price > 0)) { skip("no live price"); continue; }
    const riskPct = isOff(cfg, "riskPerTradePct") ? 0 : (cfg.riskPerTradePct ?? 1.5);
    const exitLossPct = stopPct + cost;
    const bySize = riskPct > 0 ? (equity() * riskPct) / 100 / (exitLossPct / 100) : Infinity;
    const usd = Math.floor(Math.min(state.cash, equity() * (Math.min(cfg.positionPct, cfg.allowRisky ? RISKY_MAX_POSITION_PCT : 100) / 100), bySize) * 100) / 100;
    if (usd < 1) return log("Agents: not enough cash to open a position.", "bad");
    const slip = thinSlipPct(usd, pair.liquidityUsd);
    const t = buy({ ...q.pair, priceUsd: q.price }, usd, "bot", `Agents: score ${c.total}/100`, {
      stopLoss: q.price * (1 - stopPct / 100),
      target: q.price * (1 + (AGENT_NET_TARGET + cost) / 100),
      takeProfit: q.price * (1 + (AGENT_NET_TARGET + cost) / 100),
      trailPct: trailFor(cfg, atrPct),
      botId: currentBotId(),
      sellBy: Date.now() + 240 * 60_000,
      strategy: "agents",
      tokenMint: c.mint,
      extraSlipPct: slip,
    }, slip);
    t.strategy = "agents";
    noteDecision({ at: Date.now(), symbol: pair.symbol, mint: c.mint, total: c.total, ok: true, why: `bought: score ${c.total}.${ai}` });
    const msg = `AGENTS BUY ${pair.symbol} $${usd.toFixed(2)} @ ${fmt(t.price)} (score ${c.total}/100). Exit ${fmt(q.price * (1 - stopPct / 100))} (-${stopPct.toFixed(1)}%), target ${fmt(q.price * (1 + (AGENT_NET_TARGET + cost) / 100))} (+${AGENT_NET_TARGET}% after fees).${ai}`;
    log(msg, "good");
    alert(`🛰 ${msg}`);
    return;
  }
}

// ---------- Agent: one coin, its own budget, the AI decides ----------
// On start (and whenever its plan runs out or a trade closes) the agent asks the AI, which gets
// every timeframe, the chart patterns, a study of the coin's own history, the scouts' reading and
// the trade journal, and answers: buy now, buy at a level, or stay out, with exit and target.
// The bot carries that out with the agent's budget. No other limits apply.
export const AGENT_BUDGET_DEFAULT = 1000;
export const AGENT_RECHECK_SEC = 300; // an agent asks its AI again at least this often
const AGENT_TOUCH_GAP_MS = 45_000; // ...and at once when the price reaches a level it named, but not within this long of the plan
export const AGENT_MOVE_PCT = 4; // ...and whenever the price has moved this much since its plan
// An agent's stop-loss sells when the price has settled at or below it, not on one wick: it must
// still be there this long after it was first seen there. A fall to CRASH times the planned loss
// sells at once. Replayed on 4,500 real entries at the bot's 5-second pace, this reached the
// minimum profit a few points more often than selling on the first touch and did slightly better on average.
const AGENT_STOP_CONFIRM_MS = 8_000;
const AGENT_STOP_CRASH = 1.5;
const AGENT_HOLD_SEC = 15; // an agent's breakout must stay above its level at least this long before it is bought
const AGENT_CHASE_PCT = 2; // ...and is not bought more than this far above the level (or half the stop distance, if that is less)
const RELEARN_MS = 60 * 60_000;

// The agent's money: its budget plus everything its trades have made or lost since it started.
function agentFunds(cfg: BotConfig) {
  const since = state.bot.startedAt ?? 0;
  const pnl = state.trades.filter((t) => t.strategy === "agents" && (t.botId ?? "1") === currentBotId() && t.time >= since && t.side === "SELL").reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  return (cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT) + pnl;
}

// true = the agent stopped (its budget is gone)
async function agentPrep(cfg: BotConfig): Promise<boolean> {
  // The coin's picture for the agent's card: kept the first time the pool's details include one
  // (agents started before pictures were kept get theirs here).
  if (!cfg.imageUrl) {
    const img = (await getPair(cfg.chain, cfg.pool).catch(() => null))?.imageUrl;
    if (okImage(img)) {
      cfg.imageUrl = img;
      acct().dirty = true;
    }
  }
  const budget = cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT;
  if (agentFunds(cfg) < Math.max(10, budget * 0.1)) {
    stopBot(`Agent stopped: its $${budget} budget is used up. Its trades are in your history.`);
    alert(`⏹ Agent on ${cfg.symbol} stopped: its $${budget} budget is used up.`);
    return true;
  }
  const L = state.bot.learned;
  if (!L || Date.now() - L.at > RELEARN_MS) {
    try {
      const pair = await getPair(cfg.chain, cfg.pool);
      const [c5, c1] = await Promise.all([
        getCandles(cfg.chain, cfg.pool, "5m", 300, pair).catch(() => []),
        getCandles(cfg.chain, cfg.pool, "1h", 300, pair).catch(() => []),
      ]);
      state.bot.learned = learn([{ tf: "5m", candles: c5 }, { tf: "1h", candles: c1 }], roundTripCostPct(), AGENT_NET_TARGET);
      if (!L) log(`${cfg.symbol} agent: studied the coin's history for the AI. ${state.bot.learned.summary}`);
      acct().dirty = true;
    } catch { /* the AI still gets the charts */ }
  }
  return false;
}

// What the AI is told when it plans for an agent.
async function agentBrief(cfg: BotConfig, why = ""): Promise<string> {
  const cost = roundTripCostPct();
  const L = state.bot.learned;
  const managed = state.trades.filter((t) => t.strategy === "agents" && t.side === "SELL" && t.reachedTarget && t.usd - (t.pnlUsd ?? 0) > 0);
  const managedNote = managed.length >= 5
    ? `+${(managed.reduce((s, t) => s + ((t.pnlUsd ?? 0) / (t.usd - (t.pnlUsd ?? 0))) * 100, 0) / managed.length).toFixed(1)}% (what this account's ${managed.length} managed winners really made on average after costs)`
    : `+${AGENT_NET_TARGET}% plus 30% of the extra distance from there to your target, with the target counted up to +20% (winners are held for more, but not all of the extra is captured)`;
  const lines = [
    ...(why ? [`Why you are being asked right now: ${why}.${/level .* it was watching/.test(why) ? " That level came from your last answer; decide with what the chart shows now whether to buy here, and say BUY_NOW if so." : ""}`] : []),
    `You are this coin's dedicated trading agent. Budget $${cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT} (funds now $${agentFunds(cfg).toFixed(2)}); each buy invests all of it.`,
    `YOU decide, now. If this is a good entry right now, answer BUY_NOW with a buy_now order and the bot buys at once. Otherwise give the exact level you WILL buy at (buy_dip and/or buy_breakout), close enough to be reached in the next 10-30 minutes. Do not wait for a perfect textbook setup: judge the odds from everything below and act on them. You will be asked again within 10 minutes, or sooner if the price moves ${AGENT_MOVE_PCT}%.`,
    `Every order's target must be at least ${(AGENT_NET_TARGET + cost).toFixed(1)}% above its trigger price (that is +${AGENT_NET_TARGET}% after the ${cost.toFixed(1)}% round-trip costs); orders with a smaller target are not used. That level is the MINIMUM-PROFIT level: winChancePct is your chance of reaching it before the stop. target is where you realistically expect the move to go (at or above that level). Put the stop where the idea is proved wrong.`,
    `The bot adds no other limits: no daily loss limit, no cool-down, no minimum win chance, and dips may be bought in a falling market if you judge it right. How an order is judged: a win (reaching the minimum-profit level) counts as ${managedNote}; a loss counts as the distance to your stop plus costs. The order is used only if chance x win - (1 - chance) x loss is above zero, where the chance is the COMBINED one: your winChancePct, the forecast desk's numbers below, and three more AI forecasters who are asked about any order that would pass. Every forecast is scored against what really happened and each forecaster, you included, is corrected for its record, so an inflated chance only gets you discounted.`,
    `After buying: the stop is yours until the trade is up +${AGENT_NET_TARGET}% after costs. At that point the minimum profit is locked as the exit and you are asked again and again to manage the trade: hold for more (you set the exit and how closely it follows the price) or sell now. So the entry only has to get to +${AGENT_NET_TARGET}%; how far it runs after that is handled then. The stop is judged on where the price settles, not on one wick: the bot sells if the price is still at or below your stop about 10 seconds after it got there, or at once if it falls to 1.5 times your planned loss. At the stop you are asked once whether to hold.`,
  ];
  if (L) {
    lines.push(`A study of this coin's own history (simple entry patterns replayed with the same stop and minimum profit): ${L.summary}`);
    if (L.table.length) lines.push(...L.table.slice(0, 6).map((t) => `- ${t.label} on ${t.tf}: ${t.trades} past trades, ${t.wins} reached +${AGENT_NET_TARGET}% before the stop${t.wins && t.runMedPct !== undefined ? ` (in the ${t.tf === "5m" ? "hour" : "3 hours"} after, their typical best was +${t.runMedPct.toFixed(1)}%, and ${t.ran10 ?? 0} of ${t.wins} got to +10%)` : ""}; average ${t.avgNetPct >= 0 ? "+" : ""}${t.avgNetPct.toFixed(1)}% if every winner were sold at exactly +${AGENT_NET_TARGET}%`));
  }
  try {
    const pair = await getPair(cfg.chain, cfg.pool);
    // What the agent's AI said before on this coin, and what the price has done since.
    const notes = state.bot.aiNotes ?? [];
    if (notes.length)
      lines.push(`Your earlier decisions on this coin (oldest first). The price now is $${pair.priceUsd}; judge them against what happened:\n${notes.map((x) => `- ${Math.max(1, Math.round((Date.now() - x.at) / 60_000))} min ago at $${x.price}${x.price > 0 ? ` (price is ${(((pair.priceUsd - x.price) / x.price) * 100).toFixed(1)}% from there now)` : ""}: ${x.text}`).join("\n")}`);
    if (cfg.chain === "solana" && pair.tokenAddress) {
      // One lookup for the coin and the market together; the scouts' list is used only if it is already in memory.
      const [t, market] = await Promise.all([tokenInfo(pair.tokenAddress), marketText(pair.tokenAddress).catch(() => "")]);
      const scan = recentScan();
      if (market) lines.push(market);
      if (t) {
        if (!cfg.imageUrl && okImage(t.icon)) { cfg.imageUrl = t.icon; acct().dirty = true; } // the picture, if the pool's details had none
        lines.push(flowText(t));
        const c = scan?.coins.find((x) => x.mint === pair.tokenAddress) ?? scoreCoin(t, null);
        lines.push(`Scouts' reading of this coin (rule-based, 0-100 each): ${AGENT_KEYS.map((k) => `${k} ${Math.round(c.agents[k].score)} (${c.agents[k].note})`).join("; ")}.${c.vetoes.length ? ` Warnings: ${c.vetoes.join("; ")}.` : ""}`);
      }
    }
  } catch { /* optional */ }
  return lines.join("\n");
}

// ---------- Agents: the AI's profit management ----------
// Once a trade has reached its minimum profit, the AI is asked (in the background, so the
// 5-second price checks keep running) whether to hold for more or sell. Its answer is applied at
// that agent's next check. If it can't be asked, the exit follows the price by a fixed rule.
export const PM_RULE_TRAIL = 2.5; // % behind the highest close the exit follows when the AI hasn't said otherwise
const PM_MIN_GAP_MS = 30_000; // never ask the AI about one trade more often than this
const profitInbox = new Map<string, { at: number; d?: ProfitDecision; error?: string }>(); // position id -> the AI's answer, waiting to be applied
const profitAsking = new Set<string>();

function askProfit(pos: Position, price: number, best: number, cost: number) {
  const a = acct();
  const pm = pos.pm!;
  const { id, chain, pool, entryPrice: entry, openedAt } = pos;
  const lockedExit = pm.floor, trailPct = pm.trailPct;
  const last = pm.at ? { secondsAgo: (Date.now() - pm.at) / 1000, price: pm.lastPrice ?? price, action: pm.lastAction ?? "HOLD", reason: pm.note ?? "" } : null;
  const L = state.bot.learned;
  const R = L?.runs;
  const history = R
    ? `On this coin's recent ${R.tf} chart, ${R.moves} separate moves reached +${AGENT_NET_TARGET}% after costs; in the ${R.tf === "5m" ? "hour" : "3 hours"} after, ${R.ran10} of them went on to +10% or more and ${R.ran20} to +20% or more (typical best +${R.medianBestPct.toFixed(0)}%). That is how it has traded lately, not a forecast for this move.`
    : "";
  profitAsking.add(id);
  const work = (async () => {
    try {
      const pair = await getPair(chain, pool);
      const frames = await loadFrames(chain, pool, pair, ["5s", "1m", "5m"]);
      const pats = frames.filter((f) => f.tf !== "5s").map((f) => findPatterns(f.tf, f.candles));
      const [t, market] = chain === "solana" && pair.tokenAddress ? await Promise.all([tokenInfo(pair.tokenAddress), marketText(pair.tokenAddress).catch(() => "")]) : [null, ""];
      const now = pair.priceUsd > 0 ? pair.priceUsd : price;
      // What the simulated paths say about holding on from here: the chance of climbing further
      // before falling back to the exit, and where the price is likely to be.
      let outlook = "";
      try {
        const exitNow = Math.max(lockedExit, Math.max(best, now) * (1 - trailPct / 100));
        const down = (1 - exitNow / now) * 100;
        const Dk = desk(frames.find((f) => f.tf === "1m")?.candles ?? [], frames.find((f) => f.tf === "5m")?.candles ?? [], cost, trailPct);
        if (Dk.ready && down >= 0.2) {
          const money = (v: number) => `$${Number(v.toPrecision(4))}`;
          const more = [3, 6].map((upPct) => ({ upPct, w: Dk.forecast({ offsetPct: 0, upPct, downPct: down, holdMin: 60, waitMin: 0 })?.worlds })).filter((x) => x.w);
          const cone = Dk.cone([15, 60]);
          if (more.length)
            outlook = `Simulated outlook from here (worked out by code from this coin's own recent candles; no opinion in it): the chance the price climbs ${more.map((x) => `another ${x.upPct}% before falling to the exit in force (${money(exitNow)}, ${down.toFixed(1)}% below) within the hour is ${Math.round(x.w!.pWin)}% (${Math.round(x.w!.trend.pWin)}% if the trend continues, ${Math.round(x.w!.flat.pWin)}% with no trend)`).join("; ")}.${cone.length ? ` Where the paths put the price (middle 80%): ${cone.map((c) => `in ${c.min} min ${money(c.lo)} to ${money(c.hi)}`).join("; ")}.` : ""} Weigh this against what the tape shows right now.`;
        }
      } catch { /* optional */ }
      const d = await Promise.race([
        reviewProfit({ pair, frames, costPct: cost, entry, price: now, best: Math.max(best, now), lockedExit, minNetPct: AGENT_NET_TARGET, trailPct, heldMin: (Date.now() - openedAt) / 60_000, outlook, flow: t ? flowText(t) : "", market, patterns: patternsText(pats), history, last }),
        new Promise<never>((_, no) => setTimeout(() => no(new Error("took too long")), 30_000)),
      ]);
      await chargeTokens([{ model: BOT_MODEL, ok: false, error: "", ms: 0, tokens: d.tokens }]);
      profitInbox.set(id, { at: Date.now(), d });
    } catch (err: any) {
      profitInbox.set(id, { at: Date.now(), error: err?.message ?? String(err) });
    } finally {
      profitAsking.delete(id);
    }
  })();
  const set = (a.reviews ??= new Set());
  set.add(work);
  void work.finally(() => set.delete(work));
}
// Wait for AI profit checks still in flight (before a watch window ends).
export async function settleReviews() {
  await Promise.allSettled([...(acct().reviews ?? [])]);
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

// Every running agent is checked at the same time, so one agent waiting for its AI (10-30 s)
// never delays the price checks, stops and exits of the others.
export async function tick(persist = true) {
  const a = acct();
  const all = Promise.allSettled(runningIds().map((id) => withBot(id, () => tickBot(persist))));
  const steps = (a.steps ??= new Set());
  steps.add(all);
  void all.finally(() => steps.delete(all));
  // The 5-second loop doesn't wait for an agent that is waiting on its AI: that step finishes on
  // its own (it can't start twice), and the next round checks everyone else on time.
  await Promise.race([all, new Promise((r) => setTimeout(r, 4_000))]);
}
// Wait for steps still in flight (before a watch window ends, so nothing is cut off mid-trade).
export async function settleSteps() {
  await Promise.allSettled([...(acct().steps ?? [])]);
}

async function tickBot(persist: boolean) {
  const cfg = state.bot.config;
  const me = currentBotId();
  const busyIds = (acct().busyIds ??= new Set<string>());
  if (!state.bot.running || !cfg || busyIds.has(me)) return; // this agent's previous step is still running
  if (isCoinAgent(cfg)) {
    // An agent's AI is in charge: no daily loss limit, cool-down, losing-streak pause, emergency
    // stop, minimum win chance or falling-coin filter. Its budget is its only limit.
    cfg.strongMode = false;
    cfg.rewardRule = false;
    cfg.allowRisky = false;
    cfg.analyzeEverySec = Math.min(cfg.analyzeEverySec || AGENT_RECHECK_SEC, AGENT_RECHECK_SEC); // look again at least every 5 minutes
    cfg.disabled = [...new Set([...(cfg.disabled ?? []), "dailyLossPct", "cooldownMin", "maxDrawdownPct", "minConfidence", "maxDrop1hPct", "riskPerTradePct"])];
    if (state.bot.blocked) setBlocked(null);
  }
  busyIds.add(me);
  acct().busy = true;
  // Look at candles since the previous check (at most the last minute).
  const windowStart = Math.max(Date.now() - 60_000, (state.bot.lastTickAt || Date.now()) - CHECK_MS);
  state.bot.lastTickAt = Date.now();
  try {
    // 1. Manage an open bot position (every check, no AI cost).
    const pos = state.positions.find((p) => p.source === "bot" && (p.botId ?? "1") === currentBotId());
    if (pos) {
      const q = await quote(pos.chain, pos.pool, Math.max(pos.openedAt, windowStart));
      const price = q.price;
      pos.lastPrice = price;
      recordEquity();
      if (checkDrawdown(cfg)) return;
      const gainPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      const cost = roundTripCostPct();
      // Profit guard: once the trade is far enough up, the stop jumps to a small locked-in profit
      // after fees, so a winner can't turn into a loss. It starts at your "protect" setting, but at
      // the latest once up fees + 1.5% (new coins: only after their half-profit sale).
      // Agents' trades use the profit ladder below instead of the guard, lock, half-sale and trailing stop.
      const ladder = pos.strategy === "agents";
      const guardAt = protectAt(cfg, cost);
      const floor = pos.entryPrice * (1 + (cost + GUARD_PROFIT_PCT) / 100);
      const guardOn = !ladder && !isOff(cfg, "breakEvenAtPct");
      if (guardOn && gainPct >= guardAt && (pos.strategy !== "newcoin" || pos.partialDone)) {
        if (!pos.stopLoss || pos.stopLoss < floor) {
          pos.stopLoss = floor;
          log(`${pos.symbol} up ${gainPct.toFixed(1)}%: profit guard on. It now sells no lower than ${fmt(floor)}, a small profit after fees.`, "good");
        }
      }
      // Sell everything once the trade is up the dollar amount you set (after fees).
      const tpUsd = cfg.takeProfitUsd ?? 0;
      if (tpUsd > 0 && pos.strategy !== "newcoin") {
        const upUsd = pos.qty * price * (1 - cost / 200) - pos.costUsd + (pos.realizedUsd ?? 0);
        if (upUsd >= tpUsd) {
          const t = sell(pos.id, price, 1, `Took profit: up $${upUsd.toFixed(2)} (your $${tpUsd} goal)`);
          log(`${pos.symbol}: up $${upUsd.toFixed(2)} after fees, your $${tpUsd} take-profit. Sold everything @ ${fmt(t.price)}.`, "good");
          alert(`💰 ${pos.symbol}: took profit, up $${upUsd.toFixed(2)}. Sold @ ${fmt(t.price)}.`);
          return;
        }
      }
      // Profit lock: once the best gain reaches the break-even level, the stop follows it up
      // so the trade keeps at least lockPct% of its best gain (judged on closing prices).
      const lockPct = ladder || isOff(cfg, "lockPct") ? 0 : (cfg.lockPct ?? 50);
      let newBestThisCheck = false;
      if (q.peakHigh > (pos.best ?? pos.entryPrice)) {
        pos.best = q.peakHigh;
        newBestThisCheck = true;
      }
      const best = pos.best ?? pos.entryPrice;
      const bestGainPct = ((best - pos.entryPrice) / pos.entryPrice) * 100;
      if (lockPct > 0 && bestGainPct >= guardAt && (pos.strategy !== "newcoin" || pos.partialDone)) {
        const lock = Math.max(guardOn ? floor : pos.entryPrice * (1 + cost / 100), pos.entryPrice + (best - pos.entryPrice) * (lockPct / 100));
        if (!pos.stopLoss || lock > pos.stopLoss * 1.001) {
          pos.stopLoss = lock;
          pos.locked = lock > floor;
          acct().dirty = true;
          if (pos.locked && noteKey(pos, bestGainPct)) // first lock, then every +5% of best gain
            log(`${pos.symbol} best gain +${bestGainPct.toFixed(1)}%: profit lock raised to ${fmt(lock)} (keeps at least ${lockPct}% of the gain).`, "good");
        }
      }
      // Agents: once the best gain reaches the minimum profit after fees, that minimum is locked as
      // the exit and the AI manages the rest: it is asked again and again whether to hold for more
      // or sell now, and sets the exit and how closely it follows the price. The exit never goes
      // below the locked minimum. If the AI can't be asked, the exit follows by a fixed rule.
      let aiSell = "";
      if (ladder && (pos.pm || bestGainPct - cost >= AGENT_NET_TARGET)) {
        const now = Date.now();
        const bestNet = bestGainPct - cost;
        const nowNet = gainPct - cost;
        if (!pos.pm) {
          // A trade whose exit was already raised above the minimum (by the earlier 1% profit steps) keeps it: an exit is never lowered.
          const minExit = pos.entryPrice * (1 + (cost + AGENT_NET_TARGET) / 100);
          pos.pm = { floor: Math.max(minExit, pos.stopLoss ?? 0), trailPct: PM_RULE_TRAIL, by: "rule", asks: 0, fails: 0, step: 0 };
          pos.locked = true;
          acct().dirty = true;
          log(`${pos.symbol} is up +${bestNet.toFixed(1)}% after fees: the +${AGENT_NET_TARGET}% minimum is locked (exit ${fmt(pos.pm.floor)}). The AI now decides how long to hold.`, "good");
        }
        const pm = pos.pm;
        // An answer from the AI that arrived since the last check.
        const got = profitInbox.get(pos.id);
        if (got) profitInbox.delete(pos.id);
        if (got && now - got.at > 60_000) pm.nextAt = now; // too old to act on (the price has moved on): ask again
        else if (got) {
          acct().dirty = true;
          if (!got.d) {
            pm.fails++;
            pm.nextAt = now + (pm.fails >= 3 ? 120_000 : 20_000);
            noteOnce(`pmfail:${pos.id}:${pm.fails}`, `${pos.symbol}: the AI couldn't be asked about the profit (${got.error}). The exit keeps following the price ${pm.trailPct}% behind its high, never below ${fmt(pm.floor)}.`, "bad");
          } else {
            const d = got.d;
            pm.fails = 0;
            pm.asks++;
            pm.at = now;
            pm.by = "ai";
            pm.step = Math.floor(bestNet);
            pm.note = d.reason;
            pm.confidence = clampNum(d.confidence, 0, 100);
            pm.lastPrice = price;
            pm.lastAction = d.action;
            if (d.action === "SELL_NOW") aiSell = `AI took profit at +${nowNet.toFixed(1)}% after fees: ${d.reason.replace(/[.\s]+$/, "")}`;
            else {
              pm.trailPct = clampNum(d.trailPct, 0.5, 20);
              if (d.exitPrice > pm.floor && d.exitPrice < price * 0.999) pm.floor = d.exitPrice; // only ever up, and below the price
              pm.target = d.targetPrice > price ? d.targetPrice : undefined;
              pm.nextAt = now + clampNum(d.recheckSeconds, 20, 300) * 1000;
              log(`${pos.symbol} +${nowNet.toFixed(1)}% after fees: the AI holds for more (${Math.round(pm.confidence)}% sure). Exit ${fmt(Math.max(pm.floor, best * (1 - pm.trailPct / 100)))}, following ${pm.trailPct}% behind the high${pm.target ? `, expecting ${fmt(pm.target)}` : ""}. ${d.reason}`, "good");
            }
          }
        }
        // The exit in force: the locked floor, or the trailing exit when that is higher.
        const exit = Math.max(pm.floor, best * (1 - pm.trailPct / 100));
        if (!pos.stopLoss || Math.abs(exit - pos.stopLoss) / exit > 1e-6) {
          pos.stopLoss = exit;
          acct().dirty = true;
        }
        if (pm.target) {
          pos.target = pm.target;
          pos.takeProfit = pm.target;
        }
        // Time to ask the AI again? First time at once; then when it asked to be, when a new
        // whole percent is reached, or when the price has fallen most of the way to the exit.
        if (!aiSell && !profitAsking.has(pos.id)) {
          const pulledBack = best > 0 && ((best - price) / best) * 100 >= pm.trailPct * 0.6;
          const due = now >= (pm.nextAt ?? 0) || (!!pm.at && (Math.floor(bestNet) > pm.step || pulledBack) && now - pm.at >= PM_MIN_GAP_MS);
          if (due && (await tokensLeft()) > 0) askProfit(pos, price, best, cost);
        }
      }
      // Take half before the target: targets often sit at resistance, where a run can stall.
      const partialAt = ladder || isOff(cfg, "partialAtPct") ? 0 : (cfg.partialAtPct ?? 100);
      if (pos.strategy !== "newcoin" && partialAt > 0 && !pos.partialDone && pos.target && pos.target > pos.entryPrice) {
        const level = pos.entryPrice + (pos.target - pos.entryPrice) * (partialAt / 100);
        const be = pos.entryPrice * (1 + cost / 100);
        if (level > be && q.high >= level) {
          const t = sell(pos.id, Math.max(level, price), 0.5, partialAt >= 100 ? "Took half at the target" : `Took half ${partialAt}% of the way to the target`);
          pos.partialDone = true;
          if (!pos.stopLoss || pos.stopLoss < be) pos.stopLoss = be; // the rest can't turn into a loss
          log(`${pos.symbol}: sold half @ ${fmt(t.price)} (P&L +$${t.pnlUsd!.toFixed(2)}), ${partialAt >= 100 ? "at" : `${partialAt}% of the way to`} the ${fmt(pos.target)} target. The rest rides with the profit lock.`, "good");
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
      if (!ladder && isOff(cfg, "trailPct") && pos.strategy !== "newcoin" && pos.target && q.high >= pos.target) {
        const t = sell(pos.id, Math.max(pos.target, price), 1, "Reached the target (trailing stop off)");
        log(`${pos.symbol} reached its target ${fmt(pos.target)}: sold everything @ ${fmt(t.price)} (trailing stop is off).`, "good");
        return;
      }
      if (!ladder && !pos.trailing && pos.target && q.high >= pos.target) {
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
      if (aiSell) reason = aiSell;
      else if (pos.trailing && trailLow <= trailStop) {
        reason = `Trailing stop: fell ${trail}% from its high of ${fmt(pos.peak!)}`;
        sellAt = Math.min(trailStop, price);
      } else if (ladder && pos.stopLoss && pos.stopLoss < pos.entryPrice && !pos.pm) {
        // An agent's stop-loss (see AGENT_STOP_CONFIRM_MS): judged on where the price is now, sold at that price.
        const crash = pos.entryPrice - AGENT_STOP_CRASH * (pos.entryPrice - pos.stopLoss);
        if (price <= crash) reason = "Stop-loss hit";
        else if (price <= pos.stopLoss) {
          if (!pos.underSince) {
            pos.underSince = Date.now();
            acct().dirty = true;
            log(`${pos.symbol} is at its stop-loss ${fmt(pos.stopLoss)} (now ${fmt(price)}). It sells if the price is still there in about 10 seconds; one dip that bounces straight back doesn't end the trade.`);
          } else if (Date.now() - pos.underSince >= AGENT_STOP_CONFIRM_MS) reason = "Stop-loss hit";
        } else if (pos.underSince) {
          delete pos.underSince;
          acct().dirty = true;
          log(`${pos.symbol} bounced back above its stop-loss (now ${fmt(price)}): the trade stays open.`, "good");
        }
        if (reason) sellAt = price;
      } else if (pos.stopLoss && (pos.stopLoss >= pos.entryPrice ? (newBestThisCheck ? price : q.closeLow) : q.low) <= pos.stopLoss) {
        reason = pos.pm ? `Profit exit: sold at about +${(((Math.min(pos.stopLoss, price) - pos.entryPrice) / pos.entryPrice) * 100 - cost).toFixed(1)}% after fees (best was +${(bestGainPct - cost).toFixed(1)}%)${pos.pm.by === "ai" ? ", at the exit the AI set" : ""}` : pos.locked ? `Profit lock: kept part of the best gain (+${bestGainPct.toFixed(1)}%)` : pos.stopLoss >= pos.entryPrice * (1 + roundTripCostPct() / 100) ? "Profit guard: kept a small profit after fees" : pos.stopLoss >= pos.entryPrice ? "Break-even stop hit" : "Stop-loss hit";
        sellAt = Math.min(pos.stopLoss, price);
      } else if (!pos.pm && pos.sellBy && Date.now() > pos.sellBy) reason = "Maximum holding time reached"; // a trade in profit is the AI's to manage, not the clock's
      else if (!pos.target && pos.takeProfit && q.high >= pos.takeProfit) {
        reason = "Take-profit hit"; // positions from before trailing stops
        sellAt = Math.max(pos.takeProfit, price);
      }
      // Second look: before a stop-loss or time-limit sale, the AI checks whether holding can
      // still end in profit. Once per trade at the stop; up to 3 time extensions; sells on any doubt.
      if (reason && pos.source === "bot" && (!pos.strategy || (pos.strategy === "agents" && isCoinAgent(cfg))) && !isOff(cfg, "aiSecondLook")) {
        const atStop = reason === "Stop-loss hit" && !pos.secondLook;
        const atTime = reason === "Maximum holding time reached" && (pos.extensions ?? 0) < 3;
        if ((atStop || atTime) && (await tokensLeft()) > 0) {
          const kept = await secondLook(cfg, pos, price, atStop ? "stop" : "time");
          if (kept) return;
          reason += " (AI second look: sell)";
        }
      }
      if (reason) {
        const t = sell(pos.id, sellAt, 1, reason);
        if (pos.strategy) t.strategy = pos.strategy;
        t.predictedWinPct = pos.predictedWinPct;
        t.reachedTarget = Boolean(pos.trailing || pos.pm); // the target (or an agent's minimum profit) was reached before it closed
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
        if (total > 0 && !state.settings.continuous && !isCoinAgent(cfg) && !isAgents(cfg)) {
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
    if (isAgents(cfg)) return await agentsStep(cfg);
    if (isCoinAgent(cfg) && (await agentPrep(cfg))) return;
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
    const why = claudeDue(cfg, q?.price ?? null, q?.dex ?? null);
    let askedAt = 0;
    const askGap = isCoinAgent(cfg) ? 30_000 : MIN_CLAUDE_GAP_MS; // agents decide again quickly after a trade or a broken plan
    if (why && (await tokensLeft()) <= 0) {
      noteOnce(`tokens:${month()}`, "Out of AI tokens for this month on your plan: the bot can't make new plans. Open positions are still managed. Upgrade your plan to keep the bot trading.", "bad");
      return;
    }
    if (why && Date.now() - state.bot.lastAnalysisAt >= askGap) {
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
        const { consensus, results } = await runAnalysis(cfg.chain, cfg.pool, cfg.tf, { forBot: true, ...(isCoinAgent(cfg) ? { agentBrief: await agentBrief(cfg, why) } : {}) });
        for (const f of results) if (!f.ok) log(`The AI failed: ${f.error}`, "bad");
        log(`Plan: ${consensus.stance.replace(/_/g, " ")} (${consensus.confidence}% sure). ${consensus.note}`);
        if (isCoinAgent(cfg)) {
          const ok = results.find((x) => x.ok);
          const used = consensus.orders.filter((o) => !o.warning);
          const said = (o: CheckedOrder) => Math.round(o.prediction?.parts.find((p) => p.key === "ai")?.pct ?? o.winChancePct);
          const orders = (used.length ? used : consensus.orders).map((o) => `${o.kind.replace("buy_", "")} at $${o.triggerPrice} (stop $${o.stopLoss}, target $${o.target}, you said ${said(o)}%${o.prediction ? `, combined with the numbers ${Math.round(o.prediction.pWin)}%, it needed ${Math.ceil(o.prediction.needPct)}%` : ""}${o.warning ? ": not used" : ""})`).join("; ");
          const notes = (state.bot.aiNotes ??= []);
          notes.push({ at: Date.now(), price: state.lastSignal?.priceAt ?? 0, text: `${consensus.stance.replace(/_/g, " ")}${orders ? `: ${orders}` : ""}. ${ok && ok.ok ? ok.signal.reasoning : ""}`.slice(0, 520) });
          if (notes.length > 5) notes.splice(0, notes.length - 5);
        }
      }
      const t2 = isAuto(cfg) ? state.bot.target : tgt;
      q = t2 ? await quote(t2.chain, t2.pool, planSince()) : null;
    } else if (why) {
      // A new plan is due but the AI was asked less than 2 minutes ago: wait for it
      // rather than trade on the old plan.
      const waitS = Math.ceil((state.bot.lastAnalysisAt + askGap - Date.now()) / 1000);
      noteOnce(`wait:${state.bot.lastAnalysisAt}`, `Waiting for a fresh AI plan before the next trade (${why}); asking in about ${waitS}s.`);
      return;
    }

    if (askedAt && (await stoppedElsewhere())) return; // stopped or reset while the AI was thinking: do nothing
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
      return noteOnce(`avoid:${sig.at}`, isCoinAgent(cfg)
        ? `${t3.symbol} agent: ${c.orders.some((o) => o.prediction && o.warning) && sig.results.some((x) => x.ok && x.signal.stance !== "AVOID") ? "the AI wanted to buy, but the combined chance wasn't enough, so it stays out for now" : "the AI decided to stay out for now"}. ${(() => { const r = sig.results.find((x) => x.ok); return r && r.ok ? r.signal.reasoning : ""; })()} It looks again by ${clock(Math.min(c.expiresAt, state.bot.lastAnalysisAt + cfg.analyzeEverySec * 1000))}, sooner if the price moves.`
        : `The AI advises staying out of ${t3.symbol}, so its risky setup isn't traded. Start the bot and choose "I understand, trade anyway" to trade it.`), undefined;
    const strong = strongOn(cfg);
    if (strong) {
      const pausedTill = streakPauseUntil(state.trades);
      if (pausedTill) return noteOnce(`streak:${pausedTill}`, `Strong mode: ${STREAK_LOSSES} losing trades in a row, so no new buys until ${clock(pausedTill)}. Open trades are still managed.`, "bad"), undefined;
      if (c.stance === "AVOID")
        return noteOnce(`savoid:${sig.at}`, `Strong mode: the AI advises staying out of ${t3.symbol}, so its setups aren't traded (even in risky mode).`), undefined;
    }
    const factor = strong ? oddsFactor(state.trades) : 1;
    for (let i = 0; i < c.orders.length; i++) {
      const o = c.orders[i];
      // Setups that fail the fee/risk check are shown as warnings; traded only in risky mode (never in Strong mode).
      if (o.warning && (!cfg.allowRisky || strong)) continue;
      if (isCoinAgent(cfg) && o.netRewardPct < AGENT_NET_TARGET) {
        if (triggerMet(o, q)) noteOnce(`anet:${sig.at}:${i}`, `${t3.symbol}: the AI's order aims for only +${o.netRewardPct.toFixed(1)}% after fees; the agent needs +${AGENT_NET_TARGET}%. Not buying.`);
        continue;
      }
      const label = o.kind === "buy_dip" ? `dip to ${fmt(o.triggerPrice)}` : o.kind === "buy_breakout" ? `breakout above ${fmt(o.triggerPrice)}` : `buy-now order (up to ${fmt(o.triggerPrice)})`;
      // Orders below the user's minimum win chance are never used, but say so when their trigger is hit.
      // Trend filter: a crash is not a dip.
      if (o.kind !== "buy_breakout") {
        const drop = pair.change.h1;
        const maxDrop = cfg.maxDrop1hPct ?? 10;
        if ((strong || (!cfg.allowRisky && !isOff(cfg, "maxDrop1hPct"))) && (sig.trendDown || drop <= -maxDrop)) {
          if (triggerMet(o, q))
            noteOnce(`trend:${sig.at}:${i}`, `${t3.symbol} reached the ${label}, but it's falling (${sig.trendDown ? "1-hour trend is down" : `${drop.toFixed(1)}% in the last hour`}), so dip orders are paused. A crash is not a dip.`);
          continue;
        }
      }
      // Reward must clearly beat risk after fees (1.5x), in every mode: a coin-flip with
      // equal-sized wins and losses loses money once fees are paid.
      if (cfg.rewardRule !== false && o.netRiskPct > 0 && o.netRewardPct < MIN_REWARD_RISK * o.netRiskPct) {
        if (triggerMet(o, q))
          noteOnce(`rr:${sig.at}:${i}`, `${t3.symbol} reached the ${label}, but after fees it could gain ${o.netRewardPct.toFixed(1)}% vs lose ${o.netRiskPct.toFixed(1)}%: less than ${MIN_REWARD_RISK}x the risk. Not buying.`);
        continue;
      }
      // Strong mode: scale the AI's win chance by your real results; the trade must still pay on average.
      if (strong && factor < 1) {
        const p = (o.winChancePct * factor) / 100;
        const ev = p * o.netRewardPct - (1 - p) * o.netRiskPct;
        if (o.winChancePct * factor < minWin(cfg) || ev <= 0) {
          if (triggerMet(o, q))
            noteOnce(`odds:${sig.at}:${i}`, `${t3.symbol} reached the ${label}. The AI says ${o.winChancePct}% win chance, but your bots have won about ${Math.round(factor * 100)}% as often as the AI predicts, so it's really about ${Math.round(o.winChancePct * factor)}%${ev <= 0 ? ", which loses money on average" : `, below your ${minWin(cfg)}% minimum`}. Not buying.`);
          continue;
        }
      }
      if (o.winChancePct < minWin(cfg)) {
        if (triggerMet(o, q) && !state.bot.skipNoted[i]) {
          state.bot.skipNoted[i] = true;
          log(`${t3.symbol} reached the ${label} (touched ${fmt(o.kind === "buy_breakout" ? q.high : q.low)}), but the AI gives it only a ${o.winChancePct}% win chance, below your ${minWin(cfg)}% minimum${cfg.allowRisky ? " for risky mode" : ""}. Not buying.`);
        }
        continue;
      }
      if (!triggerMet(o, q)) {
        // Past the breakout level but without the volume the AI asked for: say so (once per plan),
        // so a price above the line never looks like a buy that was missed.
        if (o.kind === "buy_breakout" && o.minVolumeRatio > 0 && q.high >= o.triggerPrice) {
          const usual = (q.pair.volume1h ?? 0) / 12;
          noteOnce(`vol:${sig.at}:${i}`, `${t3.symbol} is above the breakout level ${fmt(o.triggerPrice)}, but this order also needs the last 5 minutes' trading volume to be at least ${o.minVolumeRatio}x the usual (the AI's own condition, so it doesn't buy a breakout nobody is backing). It is ${usual > 0 ? ((q.pair.volume5m ?? 0) / usual).toFixed(1) : "0.0"}x now. Not buying unless volume picks up.`);
        }
        if (state.bot.armedSince[i]) log(`${t3.symbol} ${label} didn't hold (now ${fmt(pair.priceUsd)}); still waiting.`);
        state.bot.armedSince[i] = null;
        continue;
      }
      // Strong mode entries: a dip must bounce off its low first; a breakout must still be above
      // its level now (not just a wick). Buys at the live price, never far above the trigger.
      let entryPrice: number | null = null;
      if (strong) {
        if (o.kind === "buy_breakout") {
          if (q.price < o.triggerPrice) {
            noteOnce(`hold:${sig.at}:${i}`, `${t3.symbol} spiked above ${fmt(o.triggerPrice)} but fell back below it. Strong mode waits for the breakout to hold.`);
            continue;
          }
        } else {
          const key = `${sig.at}:${i}`;
          const lows = (state.bot.bounceLow ??= {});
          lows[key] = Math.min(lows[key] ?? Infinity, q.low, q.price);
          const bounce = Math.max(0.6, (sig.atrPct ?? 1) * 0.5) / 100;
          const need = lows[key] * (1 + bounce);
          if (q.price < need) {
            noteOnce(`bounce:${sig.at}:${i}`, `${t3.symbol} reached the ${label}. Strong mode waits for it to bounce to ${fmt(need)} before buying (not catching a falling knife).`);
            acct().dirty = true;
            continue;
          }
          if (q.price > o.triggerPrice * (1 + bounce + 0.01)) {
            noteOnce(`chase:${sig.at}:${i}`, `${t3.symbol} bounced too far above the ${label} (now ${fmt(q.price)}). Strong mode doesn't chase; waiting for a new plan.`);
            continue;
          }
          if (q.price <= o.stopLoss * 1.01) continue; // too close to the exit to be worth it
          entryPrice = q.price;
        }
      }
      // An agent's breakout is bought only if it is real: the price must still be above the level
      // (a spike that already fell back is not a breakout), must stay there for the AI's own
      // hold time (at least 15 s), and must not have run so far past the level that the planned
      // stop no longer fits. Tested on real coins: buying where a spike ran to was the worst entry.
      const agentBreakout = isCoinAgent(cfg) && o.kind === "buy_breakout";
      if (agentBreakout && q.price < o.triggerPrice) {
        if (state.bot.armedSince[i]) log(`${t3.symbol} went above ${fmt(o.triggerPrice)} but fell straight back (now ${fmt(q.price)}): not a breakout yet, still waiting.`);
        state.bot.armedSince[i] = null;
        continue;
      }
      const chasePct = agentBreakout ? Math.max(0.5, Math.min(AGENT_CHASE_PCT, (((o.triggerPrice - o.stopLoss) / o.triggerPrice) * 100) / 2)) : Infinity;
      if (agentBreakout && (q.price / o.triggerPrice - 1) * 100 > chasePct) {
        noteOnce(`chase:${sig.at}:${i}`, `${t3.symbol} ran ${((q.price / o.triggerPrice - 1) * 100).toFixed(1)}% past the breakout level ${fmt(o.triggerPrice)} before it could be bought. Buying up there would put the stop too far away, so the agent doesn't chase it: its AI looks again now.`);
        state.bot.armedSince[i] = null;
        state.bot.askNow = true;
        acct().dirty = true;
        continue;
      }
      // Otherwise: buy the instant the trigger is hit (optionally waiting for it to hold).
      const holdSec = agentBreakout ? Math.min(90, Math.max(AGENT_HOLD_SEC, o.confirmSeconds || 0)) : cfg.waitForHold ? o.confirmSeconds : 0;
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
      const riskPct = isOff(cfg, "riskPerTradePct") ? 0 : (cfg.riskPerTradePct ?? 1.5);
      const exitLossPct = ((o.triggerPrice - o.stopLoss) / o.triggerPrice) * 100 + roundTripCostPct();
      const bySize = riskPct > 0 ? (equity() * riskPct) / 100 / (exitLossPct / 100) : Infinity;
      const sizePct = cfg.allowRisky ? Math.min(cfg.positionPct, RISKY_MAX_POSITION_PCT) : cfg.positionPct; // risky trades stay small
      const cap = Math.min(state.cash, equity() * (sizePct / 100));
      const usd = isCoinAgent(cfg) ? Math.floor(Math.min(state.cash, availableCash(acct().state, currentBotId()), agentFunds(cfg)) * 100) / 100 : Math.floor(Math.min(cap, bySize) * 100) / 100;
      if (usd < 1) return log("Not enough cash to open a position.", "bad");
      const riskUsd = usd * (exitLossPct / 100);
      // Fill like a real order at the trigger price (or better/worse, see buyFillPrice).
      const t = buy({ ...pair, priceUsd: entryPrice ?? buyFillPrice(o, q) }, usd, "bot", `AI plan: ${label}${entryPrice ? " (after a bounce)" : ""}`, {
        stopLoss: o.stopLoss,
        target: o.target,
        takeProfit: o.target,
        trailPct: trailFor(cfg, sig.atrPct),
        botId: currentBotId(),
        sellBy: Date.now() + o.maxHoldMinutes * 60_000,
        predictedWinPct: o.winChancePct,
        ...(o.prediction ? { prediction: o.prediction } : {}),
        ...(isCoinAgent(cfg) ? { strategy: "agents" as const } : {}),
        ...(sig.patterns ? { patterns: patternTags(sig.patterns) } : {}),
      });
      if (sig.patterns) t.patterns = patternTags(sig.patterns);
      if (isCoinAgent(cfg)) t.strategy = "agents";
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
    busyIds.delete(me);
    acct().busy = busyIds.size > 0;
    if (persist || acct().dirty) save();
  }
}

// True while there's something to watch closely: an open bot position, a plan
// to fetch, or standing orders waiting to fill.
function watching(): boolean {
  if (hasProtected()) return true;
  return runningIds().some((id) => withBot(id, watchingBot));
}
function watchingBot() {
  const cfg = state.bot.config;
  if (!state.bot.running || !cfg) return false;
  if (state.positions.some((p) => p.source === "bot" && (p.botId ?? "1") === currentBotId())) return true;
  if (state.bot.askNow) return true;
  const sig = state.lastSignal;
  const tgtPool = isAuto(cfg) ? state.bot.target?.pool : cfg.pool;
  // Only orders with at least the user's minimum win chance count.
  return Boolean(tgtPool && sig && sig.pool === tgtPool && sig.consensus.orders.some((o) => o.winChancePct >= minWin(cfg)) && Date.now() < sig.consensus.expiresAt);
}

// Serverless: run bot steps every 5 seconds for up to maxMs (one scheduler call or
// dashboard ping keeps watch for a while). A lock stops two windows overlapping.
// Stops early when there's nothing to watch.
export async function watch(maxMs: number, by: "scheduler" | "dashboard" = "dashboard") {
  const botOn = () => anyBotRunning();
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
    // Finish what is in flight, and apply an AI profit answer that arrived as the window closed.
    for (let i = 0; i < 2; i++) {
      await settleSteps();
      await settleReviews();
      if (!state.positions.some((p) => profitInbox.has(p.id))) break;
      await tick(false);
    }
    await settleSteps();
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
    if (usd > availableCash() + 0.005) throw new Error(`Not enough available cash (you have $${availableCash().toFixed(2)} that isn't locked for agents)`);
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
        const usd = Math.floor(Math.min(o.usd ?? 0, availableCash()) * 100) / 100;
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
// Turn the 1.5x reward rule on or off for the running bot (and remember it for the next start).
export function setRewardRule(on: boolean, botId?: string): { ok: boolean; rewardRule: boolean } {
  if (botId && botId !== currentBotId()) return withBot(botId, () => setRewardRule(on));
  const cfg = state.bot.config;
  if (cfg) cfg.rewardRule = on;
  rec("bot.setting", on ? "Turned the 1.5x reward rule on" : "Turned the 1.5x reward rule off (old rules: setups whose gain is smaller than the risk can be bought)", { rewardRule: on, running: state.bot.running });
  if (state.bot.running)
    log(on ? "Reward rule on: the bot only buys when the gain after fees is at least 1.5x the possible loss." : "Reward rule off: back to the old rules. Setups whose gain is smaller than the risk can be bought (in risky mode, even ones that fail the fee check).", on ? "good" : "bad");
  save();
  return { ok: true, rewardRule: on };
}

// Turn Strong mode on or off for the running bot (and remember it for the next start).
export function setStrongMode(on: boolean, botId?: string): { ok: boolean; strongMode: boolean } {
  if (botId && botId !== currentBotId()) return withBot(botId, () => setStrongMode(on));
  const cfg = state.bot.config;
  if (cfg) cfg.strongMode = on;
  rec("bot.setting", on ? "Turned Strong mode on" : "Turned Strong mode off", { strongMode: on, running: state.bot.running });
  if (state.bot.running) log(on ? "Strong mode on: stricter entries (honest odds, trend check, bounce, losing-streak pause)." : "Strong mode off: entries follow your other settings only.", on ? "good" : "bad");
  save();
  return { ok: true, strongMode: on };
}

export function overrideDailyLimit() {
  const today = utcDay();
  rec("consent.daily_limit", `Accepted "I understand, continue today": lifted the daily loss limit until 00:00 UTC`, {
    date: today,
    warningShown: state.bot.blocked,
    note: "The daily loss limit stops new trades after a bad day. Continuing lifts it until 00:00 UTC; the emergency stop still applies.",
  });
  state.bot.dailyOverride = today;
  for (const id of botIds()) withBot(id, () => { state.bot.blocked = null; });
  log(`You lifted today's daily loss limit: the bot keeps trading until 00:00 UTC. The emergency stop still applies.`, "bad");
  save();
  return { ok: true, until: `${today}T24:00:00Z` };
}

// Emergency stop: sell everything and switch off if equity falls below the limit.
function checkDrawdown(cfg: BotConfig) {
  if (isOff(cfg, "maxDrawdownPct")) return false; // switched off by the user
  const eq = equity();
  const base = (cfg.startEquity ??= eq); // bots started before this rule: count from today
  if (eq >= base * (1 - cfg.maxDrawdownPct / 100)) return false;
  for (const p of state.positions.filter((x) => x.source === "bot")) sell(p.id, p.lastPrice, 1, "Emergency stop");
  for (const id of runningIds()) withBot(id, () => stopBot(`Emergency stop: the account ($${eq.toFixed(2)}) fell more than ${cfg.maxDrawdownPct}% below $${base.toFixed(2)}, its value when this bot started`));
  alert(`🚨 Emergency stop: account $${eq.toFixed(2)} fell more than ${cfg.maxDrawdownPct}% since the bot started ($${base.toFixed(2)}). Bot positions sold and the bots are OFF.`);
  return true;
}

export async function refreshPositionPrices() {
  await Promise.all(
    state.positions.map(async (p) => {
      try {
        const pr = await getPair(p.chain, p.pool);
        p.lastPrice = pr.priceUsd;
        if (!p.imageUrl && pr.imageUrl) p.imageUrl = pr.imageUrl; // positions opened before pictures were kept
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
        if (anyBotRunning()) await tick(false);
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
