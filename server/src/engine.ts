// Paper-trading broker + automated bot.
// Every trade here is simulated with realistic fees and slippage so you can
// see how the strategy would perform before risking real money.
import { audit, ledger, type AuditType } from "./audit.js";
import { analyze, BOT_MODEL, checkOrders, CLAUDE_MODEL, combine, forecastPanel, frameCross, numbersOf, orderKey, reviewAgentPick, reviewHold, reviewProfit, type AgentEval, type ProfitDecision, type CheckedOrder, type Consensus, type Frame, type ModelResult, type OrderPrediction, type PlanOrder } from "./ai.js";
import { countedWin, desk, expected, resolve, score, type ConePoint, type Desk, type FcStats, type Forecast, type ForecastRec, type Shape } from "./predict.js";
import { findPatterns, patternsText, patternTags, type FramePatterns } from "./patterns.js";
import { cachedJson, fromDexScreener, getCandles, getPair, getRecentTokenCandles, knownToken, type Candle, type PairInfo, type Timeframe } from "./data.js";
import { atr, snapshot } from "./indicators.js";
import { scanOpportunities } from "./scan.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { APP_TOKENS_PER_API_TOKEN, month, planOf, tokenLimit, type PlanId, type Role } from "./plans.js";
import { copyFromUpstash, createStore, oldStoreFromEnv, type HourRow } from "./store.js";
import { keepLogLines, shortWhy, type Decision, type LogLine } from "./botlog.js";
import { alertChannel, sendAlert } from "./alerts.js";
import { scanNewCoins } from "./newcoins.js";
import { AGENT_KEYS, AGENT_PASS, flowText, marketText, QUALITY_MIN, qualityGate, recentScan, scanAgents, scoreCoin, tokenInfo, type AgentCoin, type AgentScan, type CoinGate } from "./agents.js";
import { learn, type Learned, type Watch } from "./learn.js";
import { maView, type MaView } from "./macross.js";
import { breakoutHoldSec, chaseLimitPct, EXIT_LIVE, exitCheck, exitHit, exitInForce, fillBuy, fillSell, lockDue, lockedFloor, ruleTrailPct, stopCheck, type SideCost, type StopAction } from "./rules.js";
import { costAt, costCurve, knownCurve, measuring, sizeUnderCap, type CostCurve } from "./costs.js";
import { knownPct, needsPricing, vet } from "./quality.js";

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
  // Agents: what a round trip of this trade's size was estimated to cost in its pool when it was
  // bought (costs.ts). Every "after costs" figure of the trade uses it, and half of it is charged
  // on each side of the trade in place of the account's fee and slippage settings.
  costPct?: number;
  quality?: number; // Agents: the scouts' quality score of the coin when it was bought
  atrPct?: number; // Agents: the coin's usual 5-minute swing (ATR%) when it was bought
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
  exitSince?: number; // Agents: when the price was first seen at or under the profit exit of a locked trade (it sells if it is still there ~10 s later)
  feedRatio?: number; // Agents: the 5-second feed's price divided by the pool snapshot's, when both were last seen (see sameFeed)
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
  hr?: 1; // an agent's sale that has been counted into the agents' hours (keepHours)
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
  maxCostPct?: number; // Agent: invest only as much as keeps the round-trip cost at or under this % (default 2.5; 0 = always all of its funds)
  minQuality?: number; // Agent: the scouts' quality score (0-100) its coin needs before the AI is asked (default 45). "qualityGate" in `disabled` switches the gate off.
  minNumbersPct?: number; // Agent: the least chance the numbers alone must give an order (default 10; 0 = no floor). Under it an order is refused, and if no plain order reaches it the AI is not asked.
  // Auto-pick agent: it chooses its own coin from the top of the scouts' list, and chooses again
  // after every trade (see "Auto-pick agents" below). pool and symbol are empty while it has none.
  autoPick?: boolean;
  autoStrict?: boolean; // Auto-pick: only coins that pass every scout check (default: those first, then the next best that are fit to trade)
  autoMaxCostPct?: number; // Auto-pick: pass over a coin where buying and selling all the agent's money would cost more than this % (default 1.5; 0 = take any coin)
  mint?: string; // Auto-pick: the token it is on now (the scouts list coins by token)
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
// atrPct: the coin's usual 5-minute swing (ATR%), which sizes the exit's distance while no AI answer is in force.
export type ProfitPlan = { atrPct?: number; floor: number; trailPct: number; by: "ai" | "rule"; asks: number; fails: number; step: number; at?: number; nextAt?: number; target?: number; note?: string; confidence?: number; lastPrice?: number; lastAction?: string };

type State = {
  resetAt?: number; // when this account was last reset (older copies are never saved over it)
  // Lines written by the quality step, which works for all of the account's agents and so has no
  // agent's log to write in: the newest 50 (they are also in the week's log, as agent "0").
  stepLog?: { t: number; msg: string; level: "info" | "good" | "bad"; d?: Decision }[];
  raised10k?: boolean; // the one-time raise of an account opened with the earlier $1,000 has been looked at
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
    costCurve?: CostCurve; // Agent: the last cost measured for its coin (kept here so another server copy needn't measure again)
    quality?: number; // Agent: the scouts' quality score of its coin at the last look (remembered with each forecast)
    aiNotes?: { at: number; price: number; text: string }[]; // Agent: its AI's last decisions on this coin (given back to it next time)
    lastFiredAt?: number; // Agent: the candle its pattern last fired on (one try per signal)
    watch?: Watch | null; // Agent: the level it is watching (drawn on the chart)
    // Auto-pick agent: what its coin choice is doing. note = why it has no coin (shown on its card);
    // nextAt = when it looks at the list again; idleSince = since when it has had no live order on
    // its coin; again = its trade closed, so it chooses again; picks = coins chosen since it started.
    // key = the kind of reason the note gives (its log is written again only when that changes,
    // not when a count in the text moves).
    auto?: { note: string; at: number; key?: string; nextAt?: number; idleSince?: number; again?: boolean; picks?: number; pickedAt?: number };
    // Auto-pick (shared by the account's agents): token -> not to be picked again before this time.
    autoSkip?: Record<string, number>;
    // Auto-pick (shared by the account's agents): token -> what a round trip was last measured to
    // cost there, kept for an hour. What one agent measured, no other agent (on any server copy) measures again.
    autoCost?: Record<string, CostCurve>;
    // Auto-pick (shared by the account's agents): "token|money" -> when the quality step last wrote
    // that this coin is too expensive for that much money (it writes it once an hour, not per agent).
    autoSaid?: Record<string, number>;
    // Auto-pick: the coin the bot is currently waiting to buy, and what Claude said about each candidate.
    target: { chain: string; pool: string; symbol: string; chosenAt: number } | null;
    candidates: { symbol: string; chain: string; pool: string; action: string; confidence: number; note: string }[];
    log: { t: number; msg: string; level: "info" | "good" | "bad"; d?: Decision }[]; // d = what the line decided, if anything (botlog.ts)
  };
  // maCross: the moving-average crossover signal on each chart from 1 minute up, as the AI was given it.
  lastSignal: { at: number; pool: string; symbol: string; tf: string; results: ModelResult[]; consensus: Consensus; trendDown?: boolean; atrPct?: number; patterns?: FramePatterns[]; maCross?: MaView[]; priceAt?: number; desk?: DeskView; cost?: AgentCost; gate?: PlanGate } | null;
  // Extra bots (2 and 3). Bot 1 is `bot` / `lastSignal` above, so older saved states keep working.
  bots?: BotSlot[];
  // The forecast scoreboard (whole account): forecasts waiting for their outcome, every
  // forecaster's running record, and the last few that were scored.
  fc?: { pending: ForecastRec[]; stats: FcStats; last: Scored[] };
};
// What an agent's next buy would cost and how much it would invest: `usd` of its `funds` (less
// than all of it when that keeps the round trip at or under `capPct`), costing `pct`; `fullPct`
// is what investing all of its funds would cost.
export type AgentCost = { pct: number; usd: number; funds: number; fullPct: number; capPct: number; source: CostCurve["source"] };
// Why an agent stood aside without asking its AI (no AI tokens spent): the scouts ruled the coin
// out, or the prediction engine's numbers left no order that could pass.
export type PlanGate = { kind: "scouts" | "numbers"; reasons: string[]; quality?: number; min?: number };
export type Scored = { at: number; symbol: string; kind: string; pWin: number; aiPct: number; passed: boolean; out: "win" | "stop" | "none"; real?: boolean };
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
// Calls and bytes to the storage since this server copy started (null for a store that does not count).
export const storageStats = () => store.stats?.() ?? null;
// An error from the storage in one short line a person can read (Upstash appends the whole command).
export const shortError = (e: unknown) => String((e as Error)?.message ?? e).replace(/,?\s*command was:[\s\S]*$/, "").slice(0, 600);

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

// When agents' orders began to be judged by the prediction engine (v0.54.0 went live).
const PREDICTIONS_SINCE = Date.UTC(2026, 10, 14, 1, 58, 37);
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
  // Paper accounts start with $10,000 since v0.64.0. An account that was opened with the earlier
  // $1,000 and never reset is raised by the difference, once. Everything measured against the
  // start moves with it (the starting balance, the high, the equity curve, the day's baseline),
  // so its profit and loss, its open trades and its agents' budgets stay exactly what they were.
  if (!s.raised10k) {
    if (s.startCash === EARLIER_ACCOUNT_CASH && !s.resetAt) {
      const add = NEW_ACCOUNT_CASH - EARLIER_ACCOUNT_CASH;
      s.startCash += add;
      s.cash += add;
      s.peakEquity += add;
      for (const e of s.equity ?? []) e.v += add;
      for (const b of [s.bot, ...s.bots.map((x) => x.bot)]) if (b.day) b.day.startEquity += add;
    }
    s.raised10k = true;
  }
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
  // The scoreboard's "trades it made" used to be scored from the chart, which is kinder than a
  // real fill (it said 5 of 7 reached +5% when 1 of 5 real trades had). It now holds real results
  // only: rebuilt once from the agents' own closed trades bought since predictions began.
  if (s.fc && s.fc.stats.v !== 2) {
    const boughtAt = new Map<string, number>();
    let n = 0, hits = 0;
    for (const tr of s.trades.slice().reverse()) {
      if (tr.strategy !== "agents" || tr.source !== "bot") continue;
      const k = `${tr.botId ?? "1"}:${tr.pool}`;
      if (tr.side === "BUY") boughtAt.set(k, tr.time);
      else if ((boughtAt.get(k) ?? 0) >= PREDICTIONS_SINCE) {
        n++;
        if (tr.reachedTarget) hits++;
      }
    }
    s.fc.stats = { ...s.fc.stats, taken: { n, hits }, v: 2 };
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
  rev?: number | null; // the saved account's version number this copy holds (stores that keep one)
  saving?: number; // saves of this copy still on their way
  logQueue?: LogLine[]; // log lines written since the last save, on their way to the week's log (botlog.ts)
  hoursRetryAt?: number; // the hours table did not answer: not asked again before this time
  autoBusy?: Set<string>; // tokens an auto-pick agent is taking right now (so two never take the same one in one round)
  ahead?: Promise<unknown> | null; // the quality step's work in flight for this account (it prices one coin at a time)
  aheadPauseUntil?: number; // Jupiter did not answer it: it leaves the queue alone until then
  aheadScanAt?: number; // when it last read the scouts' list itself
  aheadSkip?: Map<string, number>; // coins it could not price -> not tried again before this time (so the others get their turn)
  closing?: number; // above 0: a watch of this account is over and only finishing what is in flight: open trades are checked, nothing new is started (see watch())
  backupSince?: Map<string, number>; // open trade -> since when only the backup price source has answered for it (see sameFeed)
};
const NEW_ACCOUNT_CASH = 10_000; // what a new paper account starts with ($1,000 until v0.63)
const EARLIER_ACCOUNT_CASH = 1000;
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

// ---------- The real-money auto-pilot's own account ----------
// A customer's real auto-pilot decides in an account of its own, "<username>~real", never in their
// paper account (Paper and Real are kept apart). It runs on the customer's own plan and AI tokens,
// and every trade its agent makes is handed to the real executor (autopilot.ts), which copies it
// with real money within the customer's limits, or skips it.
export const REAL_SUFFIX = "~real";
export const isRealKey = (key: string | null | undefined): key is string => !!key && key.endsWith(REAL_SUFFIX);
export const ownerOf = (key: string) => (isRealKey(key) ? key.slice(0, -REAL_SUFFIX.length) : key);
export type MirrorEvent = { side: "BUY" | "SELL"; positionId: string; mint?: string; symbol: string; chain: string; usd: number; price: number; fraction?: number; closed?: boolean };
let mirrorHook: ((key: string, ev: MirrorEvent) => Promise<unknown>) | null = null;
export function onRealTrade(fn: ((key: string, ev: MirrorEvent) => Promise<unknown>) | null) {
  mirrorHook = fn;
}
// Queued like the agents' steps, so a watch window waits for the real trade before it ends.
function mirror(ev: MirrorEvent) {
  const a = acct();
  if (!isRealKey(a.key) || !mirrorHook) return;
  const job = mirrorHook(a.key, ev).catch((e) => console.error("[autopilot] copying a trade failed:", e?.message ?? e));
  const steps = (a.steps ??= new Set());
  steps.add(job);
  void job.finally(() => steps.delete(job));
}

// Several bots per account: each bot step runs inside one bot (botAls). `state.bot` and
// `state.lastSignal` then mean that bot's own state; bot 1 is the original `bot` field.
// Per-coin losing streaks and the daily loss limit stay shared by all bots of the account.
const botAls = new AsyncLocalStorage<string>();
export const currentBotId = () => botAls.getStore() ?? "1";
export const withBot = <T>(id: string, fn: () => T): T => botAls.run(id, fn);
const SHARED_BOT_KEYS = new Set(["coinStats", "day", "dailyOverride", "autoSkip", "autoCost", "autoSaid"]);
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
    const budget = cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT;
    // An auto-pick agent's money is never more than its budget: what it has made beyond that is yours at once.
    return [{ id, symbol: cfg.symbol || "Auto-pick", usd: Math.max(0, (cfg.autoPick ? Math.min(budget, budget + pnl) : budget + pnl) - invested) }];
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

// Supabase must be set up: its tables there, and closed to the public keys. The app then starts on
// it with empty accounts (the owner's choice on 25 Nov 2026: start from scratch).
// What the app kept in Upstash can still be brought over instead: with COPY_FROM_UPSTASH=1 set
// before the first start, everything is copied once and nothing is served until that is done
// (otherwise people would sign in to empty accounts, and the copy could no longer be made
// without overwriting what they did since).
// While it is not ready, the reason is remembered for a short while and given again without
// asking either database: the app can sit in this state for days (waiting for the old database to
// be unblocked) with a dashboard open, and every refresh would otherwise ask both. Requests that
// arrive together share one attempt.
let storeReady = false;
let storeProblem: unknown = null, storeFailedAt = 0, storeAttempt: Promise<void> | null = null;
const storeRetryMs = () => Number(process.env.STORE_RETRY_MS ?? 20_000);
export async function ensureStore() {
  if (storeReady) return;
  if (store.kind !== "supabase") return void (storeReady = true);
  if (storeProblem && Date.now() < storeFailedAt + storeRetryMs()) throw storeProblem;
  storeAttempt ??= setUpStore()
    .then(
      () => {
        storeReady = true;
        storeProblem = null;
      },
      (e) => {
        storeProblem = e;
        storeFailedAt = Date.now();
        throw e;
      },
    )
    .finally(() => {
      storeAttempt = null;
    });
  return storeAttempt;
}
async function setUpStore() {
  await store.check!();
  // Once per database: an account and a list entry are saved and read back, so a problem with
  // saving shows on the status page before anybody's account depends on it.
  if (!(await store.kvGet<unknown>("selftest"))) {
    await store.selfTest!();
    await store.kvSet("selftest", { at: Date.now() });
  }
  if (!(await store.kvGet<unknown>("copied-from-upstash"))) {
    const old = oldStoreFromEnv();
    if (!old || !process.env.COPY_FROM_UPSTASH) {
      const why = old ? "COPY_FROM_UPSTASH is not set" : "no Upstash settings";
      await store.kvSet("copied-from-upstash", { skipped: true, at: Date.now(), why });
      console.log(`[store] starting on Supabase with empty accounts, without a copy from Upstash (${why})`);
    } else {
      if (!(await store.lock("copy-from-upstash", 10 * 60_000))) throw new Error("Your data is being moved to the new database right now. Try again in a minute.");
      try {
        const r = await copyFromUpstash(store, old);
        await store.kvSet("copied-from-upstash", { at: Date.now(), ...r });
        console.log(`[store] copied from Upstash: ${r.accounts} accounts, ${r.records} records, ${r.lists} lists (${r.items} entries)`);
      } catch (e) {
        throw new Error(`Moving to the new database: your accounts and history could not be copied from the old one yet (${shortError(e).slice(0, 160)}). Unblock it in the Upstash console, or remove COPY_FROM_UPSTASH in Vercel to start with empty accounts.`);
      } finally {
        await store.unlock("copy-from-upstash").catch(() => {});
      }
    }
  }
}

// One-time move: the single shared account from before logins had their own goes to the
// owner's login (OWNER_USERNAME, or the account that claimed it). A backup copy is kept.
let migrated = false;
export async function ensureMigrated() {
  await ensureStore();
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

// Bring this copy's account up to date with what is saved. With shared storage (Supabase,
// Redis) this runs on every request and on every 5-second check, because on Vercel each one may
// land on a different short-lived server.
// A store that keeps a version number per account is asked for that number first (a few bytes):
// the account itself is loaded only when another server copy has saved it since. Before, the
// whole account was read every time, which is what used up the old database's allowance.
export async function sync() {
  const a = acct();
  if (!a.key) return; // signed-out visitor: nothing to load
  const shared = store.kind === "supabase" || store.kind === "redis";
  if (a.loaded && !shared) return;
  // Never swap the state out from under a running bot step. One server handles
  // several requests at once (e.g. dashboard refreshes while the bot waits for
  // Claude); replacing the object mid-step lost the step's updates, so the bot
  // forgot it had just asked Claude and asked again every 20 s.
  if (a.busy) return;
  let reload = true;
  if (a.loaded && store.rev) {
    // This copy's own save is still on its way: what it holds is the newest there is.
    if (a.saving) reload = false;
    else {
      const rev = await store.rev(a.key).catch(() => undefined); // no answer: load the account itself
      if (a.busy) return;
      if (rev !== undefined && rev === (a.rev ?? null)) reload = false;
    }
  }
  let saved: State | null = null;
  if (reload) {
    const got = store.loadRev ? await store.loadRev<State>(a.key) : { value: await store.load<State>(a.key), rev: null };
    if (a.busy) return; // a step started while we were loading: keep its state
    // A save queued on this copy while the answer was on its way wins over what was loaded (it
    // is about to be written anyway).
    if (!(a.loaded && a.saving)) {
      saved = got.value;
      if (saved) a.state = migrate(saved);
      a.rev = got.rev;
    }
  }
  const first = !a.loaded;
  a.loaded = true;
  if (!saved && first) save(); // a brand-new account: keep its starting balance
  if (a.active === undefined) a.active = (await activeAccounts()).includes(a.key);
  if (!a.planAt || Date.now() - a.planAt > 60_000) {
    const u = await store.kvGet<{ plan?: PlanId; role?: Role }>(`user:${ownerOf(a.key)}`); // (the real auto-pilot's account: its customer's)
    // The platform owner is its admin on the top plan, even before their record says so
    // (their bot keeps running on the scheduler without them signing in).
    const owner = process.env.OWNER_USERNAME?.trim().toLowerCase() || (await store.kvGet<string>("owner"));
    const isOwner = owner === ownerOf(a.key) && !u?.role;
    a.plan = isOwner ? "max" : planOf(u?.plan).id;
    a.role = isOwner ? "admin" : (u?.role ?? "user");
    a.planAt = Date.now();
  }
}

// ---------- Plans: AI tokens and transaction charges ----------
const usageKey = (key: string) => `usage:${ownerOf(key)}:${month()}`; // (the real auto-pilot uses its customer's tokens)
// AI tokens left this month (app tokens; Infinity for admins).
async function tokensLeft(): Promise<number> {
  const a = acct();
  if (!a.key) return Infinity; // scripts and tests without a login
  const limit = tokenLimit(a.plan, a.role);
  if (!Number.isFinite(limit)) return Infinity;
  if (limit <= 0) return 0; // no AI on this plan (top-ups don't add AI to a plan without it)
  const used = (await store.kvGet<number>(usageKey(a.key))) ?? 0;
  const topup = (await store.kvGet<number>(`topup:${ownerOf(a.key)}`)) ?? 0;
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
    const tk = `topup:${ownerOf(a.key)}`;
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
  a.saving = (a.saving ?? 0) + 1;
  a.pending = a.pending
    .then(async () => {
      const ctl = await store.kvGet<Ctl>(ctlKey(key)).catch(() => null);
      if (staleAfterReset(copy, ctl)) return; // the account was reset after this copy was loaded: never write it back
      applyStops(copy, ctl); // an agent stopped elsewhere stays stopped
      applyStops(a.state, ctl);
      const rev = await store.save(copy, key);
      if (typeof rev === "number") a.rev = rev; // what this copy holds is now that version
    })
    .then(() => markActive(a))
    .catch((e) => console.error("[store] save failed:", e))
    .then(() => keepLog(a))
    .then(() => keepHours(a))
    .finally(() => {
      a.saving = Math.max(0, (a.saving ?? 1) - 1);
    });
}
// The agents' hours: what all of an account's agents made together, hour by hour, in a table of
// its own (store.hoursAdd). Every sale an agent makes is counted into its hour once: it is marked
// on the trade when the table has taken it, so a sale that could not be written (the table not
// made yet, the database down) stays unmarked and is written later, oldest first. At most 25 a
// save, so catching up never holds a request for long.
const HOURS_RETRY_MS = 10 * 60_000;
async function keepHours(a: Account) {
  if (!a.key || !store.hoursAdd || Date.now() < (a.hoursRetryAt ?? 0)) return;
  const todo = a.state.trades.filter((t) => t.side === "SELL" && t.source === "bot" && !t.hr && typeof t.pnlUsd === "number").sort((x, y) => x.time - y.time).slice(0, 25);
  for (const t of todo) {
    try {
      await store.hoursAdd(a.key, { tradeId: t.id, time: t.time, pnlUsd: t.pnlUsd!, bot: t.botId ?? "1", symbol: t.symbol });
    } catch (e) {
      a.hoursRetryAt = Date.now() + HOURS_RETRY_MS;
      console.error("[hours] not written yet:", shortError(e));
      return;
    }
    t.hr = 1;
    // The mark is also put on the same trade in the account as it is now (it may have been loaded again meanwhile).
    const live = a.state.trades.find((x) => x.id === t.id);
    if (live) live.hr = 1;
    a.dirty = true;
  }
}
// The agents' hours between two times, for the signed-in account (oldest first).
// ready: false = this store has no hours table (yet).
export async function agentHours(fromMs: number, toMs: number): Promise<{ ready: boolean; rows: HourRow[]; error?: string }> {
  const a = acct();
  if (!a.key || !store.hoursGet) return { ready: false, rows: [] };
  try {
    return { ready: true, rows: await store.hoursGet(a.key, fromMs, toMs) };
  } catch (e) {
    return { ready: false, rows: [], error: shortError(e) };
  }
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

// d = what this line decided (bought, sold, stayed out and why...): the app's one-line view of
// the log shows only such lines, from this record, never by reading the sentence (botlog.ts).
function log(msg: string, level: "info" | "good" | "bad" = "info", d?: Decision) {
  const a = acct();
  a.dirty = true;
  const t = Date.now();
  state.bot.log.unshift({ t, msg, level, ...(d ? { d } : {}) });
  state.bot.log = state.bot.log.slice(0, 200);
  // The account keeps each agent's newest 200 lines; the week's log keeps them all (botlog.ts).
  if (a.key) {
    const sym = state.bot.config?.symbol;
    (a.logQueue ??= []).push({ t, bot: currentBotId(), ...(sym ? { sym } : {}), msg, level, ...(d ? { d } : {}) });
  }
  console.log(`[bot] ${msg}`);
}
// A line written by the quality step. It works for all of the account's agents, so its lines are
// not any one agent's: they are kept with the account (state.stepLog) and go to the week's log
// under the agent number STEP_BOT, which the app shows as "quality check".
export const STEP_BOT = "0";
function stepLog(msg: string, level: "info" | "good" | "bad" = "info", d?: Decision) {
  const a = acct();
  a.dirty = true;
  const t = Date.now();
  a.state.stepLog = [{ t, msg, level, ...(d ? { d } : {}) }, ...(a.state.stepLog ?? [])].slice(0, 50);
  if (a.key) (a.logQueue ??= []).push({ t, bot: STEP_BOT, msg, level, ...(d ? { d } : {}) });
  console.log(`[quality] ${msg}`);
}
// The log lines written since the last save go to the week's log in one write. A write that
// fails is tried again with the next save (the newest 500 lines are held for it).
async function keepLog(a: Account) {
  const lines = a.logQueue;
  if (!a.key || !lines?.length) return;
  a.logQueue = [];
  try {
    await keepLogLines(a.key, lines);
  } catch (e) {
    a.logQueue = [...lines, ...(a.logQueue ?? [])].slice(-500);
    console.error("[botlog] write failed:", e);
  }
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

// `side`: this trade's own cost per side (an agent's trade), in place of the account's fee and slippage settings.
export function buy(pair: PairInfo, usd: number, source: "manual" | "bot", reason: string, plan?: Partial<Position>, extraSlipPct = 0, side?: SideCost) {
  if (!(usd > 0)) throw new Error("Amount must be positive");
  // Your own buys can't use cash locked for agents; an agent's buy uses its own locked budget.
  const spendable = source === "manual" ? availableCash() : state.cash;
  if (usd > spendable + 1e-9)
    throw new Error(state.cash - spendable > 0.005 ? `Not enough available cash: $${spendable.toFixed(2)} available, $${(state.cash - spendable).toFixed(2)} is locked for your agents` : `Not enough cash ($${state.cash.toFixed(2)} available)`);
  if (!(pair.priceUsd > 0)) throw new Error("No live price for this token");
  const { feePct, slippagePct } = state.settings;
  const { fillPrice, qty, feeUsd, platformFeeUsd } = fillBuy(usd, pair.priceUsd, { ...(side ?? { feePct, slipPct: slippagePct + extraSlipPct }), platformPct: platformFeePct() });
  state.cash -= usd;
  const existing = state.positions.find((p) => p.pool === pair.pool && p.source === source && (source !== "bot" || (p.botId ?? "1") === (plan?.botId ?? "1")));
  const positionId = existing?.id ?? uid();
  if (existing) {
    const totalQty = existing.qty + qty;
    existing.entryPrice = (existing.entryPrice * existing.qty + fillPrice * qty) / totalQty;
    existing.qty = totalQty;
    existing.costUsd += usd;
    Object.assign(existing, plan);
  } else {
    state.positions.push({ id: positionId, chain: pair.chain, pool: pair.pool, symbol: pair.symbol, ...(pair.imageUrl ? { imageUrl: pair.imageUrl } : {}), qty, entryPrice: fillPrice, costUsd: usd, openedAt: Date.now(), source, lastPrice: pair.priceUsd, ...plan });
  }
  const t: Trade = { id: uid(), time: Date.now(), side: "BUY", symbol: pair.symbol, pool: pair.pool, price: fillPrice, qty, usd, feeUsd, platformFeeUsd, reason, source, ...(source === "bot" ? { botId: plan?.botId ?? "1" } : {}) };
  state.trades.unshift(t);
  recTrade(t);
  if (source === "bot") mirror({ side: "BUY", positionId, mint: plan?.tokenMint ?? existing?.tokenMint ?? state.bot.config?.mint, symbol: pair.symbol, chain: pair.chain, usd, price: pair.priceUsd });
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
  // An agent's trade pays the other half of the round-trip cost estimated when it was bought.
  const { fillPrice, net, feeUsd, platformFeeUsd } = fillSell(qty, price, { ...(p.costPct !== undefined ? { feePct: p.costPct / 2, slipPct: 0 } : { feePct, slipPct: slippagePct + (p.extraSlipPct ?? 0) }), platformPct: platformFeePct() });
  const costPart = p.costUsd * f;
  state.cash += net;
  p.qty -= qty;
  p.costUsd -= costPart;
  const closed = f >= 0.999 || p.qty * price < 0.01;
  if (closed) {
    state.positions = state.positions.filter((x) => x.id !== p.id);
    acct().backupSince?.delete(p.id);
    state.orders = (state.orders ?? []).filter((o) => o.positionId !== p.id); // its limit sells go with it
  }
  else p.realizedUsd = (p.realizedUsd ?? 0) + (net - costPart);
  const t: Trade = { id: uid(), time: Date.now(), side: "SELL", symbol: p.symbol, pool: p.pool, price: fillPrice, qty, usd: net, feeUsd, pnlUsd: net - costPart, platformFeeUsd, reason, source: p.source, ...(p.source === "bot" ? { botId: p.botId ?? "1" } : {}) };
  state.trades.unshift(t);
  recTrade(t);
  if (p.source === "bot") mirror({ side: "SELL", positionId: p.id, mint: p.tokenMint, symbol: p.symbol, chain: p.chain, usd: net, price, fraction: f, closed });
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

// Asked for by name only (profit management reads the 15-minute chart; plans do not).
const EXTRA_FRAMES: typeof PLAN_FRAMES = [{ tf: "15m", label: "15-minute candles (last ~8 hours): the swing the trade is riding", show: 32 }];
const FRAME_ORDER: Timeframe[] = ["1s", "5s", "1m", "5m", "15m", "1h", "4h", "1d"];
async function loadFrames(chain: string, pool: string, pair: PairInfo, only?: Timeframe[]) {
  // One timeframe at a time (CoinMarketCap allows ~1 request/second); skip any that fail,
  // e.g. no daily candles yet for a brand-new coin.
  const wanted = (only ? [...PLAN_FRAMES, ...EXTRA_FRAMES].filter((x) => only.includes(x.tf)) : PLAN_FRAMES).sort((a, b) => FRAME_ORDER.indexOf(a.tf) - FRAME_ORDER.indexOf(b.tf));
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
// A trade the agent made has closed: the prediction it was bought on is scored with what really
// happened to the trade (it reached the minimum profit, or it did not), which is what the money
// depends on. The chart is not asked: a real order can fill worse than the chart shows.
function scoreTrade(pos: Position, reached: boolean) {
  const p = pos.prediction;
  if (!p) return; // bought without a prediction (too little history for the desk): nothing to score
  const fc = (state.fc ??= { pending: [], stats: { v: 2 }, last: [] });
  const each: ForecastRec["p"] = { combined: p.pWin };
  for (const part of p.parts) each[part.key] = part.pct;
  const out = reached ? "win" : "stop";
  const made: ForecastRec = { id: uid(), at: pos.openedAt, pool: pos.pool, symbol: pos.symbol, kind: "buy_now", entry: pos.entryPrice, stop: pos.stopLoss ?? 0, level: pos.entryPrice, waitMin: 0, holdMin: 0, p: each, passed: true, ...(typeof pos.quality === "number" ? { q: pos.quality } : {}) };
  fc.stats = score(fc.stats, made, out, true);
  fc.last.unshift({ at: made.at, symbol: made.symbol, kind: "trade", pWin: Math.round(p.pWin), aiPct: Math.round(each.ai ?? 0), passed: true, out, real: true });
  if (fc.last.length > 12) fc.last.length = 12;
  acct().dirty = true;
}
// Remembers each predicted order so it can be scored later, whether or not it was bought (one
// per coin, kind and verdict per holding window: looks a few minutes apart are the same evidence).
function recordForecasts(pair: PairInfo, consensus: Consensus, cost: number) {
  const now = Date.now();
  const validMin = Math.max(5, Math.round((consensus.expiresAt - now) / 60_000));
  const fc = (state.fc ??= { pending: [], stats: { v: 2 }, last: [] });
  for (const o of consensus.orders) {
    const p = o.prediction;
    if (!p) continue;
    const passed = !o.warning;
    const sh = shapeOf(o, pair.priceUsd, cost, validMin);
    const every = Math.min(180, Math.max(45, sh.holdMin)) * 60_000;
    if (fc.pending.some((r) => r.pool === pair.pool && r.kind === (sh.immediate ? "buy_now" : o.kind) && r.passed === passed && now - r.at < every)) continue;
    const each: ForecastRec["p"] = { combined: p.pWin };
    for (const part of p.parts) each[part.key] = part.pct;
    fc.pending.push({ id: uid(), at: now, pool: pair.pool, symbol: pair.symbol, kind: sh.immediate ? "buy_now" : o.kind, entry: sh.entry, stop: o.stopLoss, level: sh.entry * (1 + (cost + AGENT_NET_TARGET) / 100), waitMin: sh.waitMin, holdMin: Math.min(sh.holdMin, 420), p: each, passed, ...(typeof state.bot.quality === "number" ? { q: state.bot.quality } : {}) });
  }
  if (fc.pending.length > 60) fc.pending.splice(0, fc.pending.length - 60);
}

// The best any buy could do right now: a set of plain orders (buy now, a dip, a breakout; tight
// to wide stops; a short and a longer hold) is put through the same check as the AI's own orders
// (checkOrders), each with the AI's chance set to the ceiling. If none passes, none the AI could
// give would, so the AI is not asked. `numbers` = the highest chance the numbers alone give any of them.
//
// The floor on the numbers (AgentEval.minNumbersPct) is what makes this bite. Measured on 140
// looks at 14 real coins: without a floor it never fired (the AI is half of the combined chance,
// so an AI at 95% passes an order the numbers put at 0%), and with real costs on a deep pool a
// stand-in AI at 62% carried an order the numbers put at 9%. Blind tests found that when the
// numbers say under 10% it almost never happens; they were under 10% for every plain order in
// 18% of those looks.
const AI_CEILING_PCT = 95;
export const AGENT_MIN_NUMBERS_PCT = 10;
function bestCase(D: Desk, price: number, cost: number, judge: AgentEval): { passes: boolean; pWin: number; needPct: number; numbers: number } | null {
  let best: { passes: boolean; pWin: number; needPct: number; gap: number } | null = null;
  let numbers = 0, any = false;
  for (const [kind, offset] of [["buy_now", 0], ["buy_dip", -2], ["buy_dip", -4], ["buy_breakout", 2], ["buy_breakout", 4]] as const)
    for (const stopPct of [3, 5, 8, 12])
      for (const hold of [60, 180]) {
        const trigger = price * (1 + offset / 100);
        const order: PlanOrder = { kind, triggerPrice: trigger, confirmSeconds: 0, minVolumeRatio: 0, stopLoss: trigger * (1 - stopPct / 100), target: trigger * (1 + (cost + AGENT_NET_TARGET + 10) / 100), maxHoldMinutes: hold, winChancePct: AI_CEILING_PCT };
        const r = checkOrders([order], cost, { ...judge, panel: undefined, predict: (x, validMinutes) => D.forecast(shapeOf(x, price, cost, validMinutes)) }, 30);
        const o = r.kept[0] ?? r.warned[0];
        const p = o?.prediction;
        if (!p) continue;
        numbers = Math.max(numbers, numbersOf(p.parts) ?? 0);
        if (r.kept.length) any = true;
        const gap = p.pWin - p.needPct;
        if (!best || gap > best.gap) best = { passes: r.kept.length > 0, pWin: p.pWin, needPct: p.needPct, gap };
      }
  return best ? { ...best, passes: any, numbers } : null;
}

export async function runAnalysis(chain: string, pool: string, tf: Timeframe, opts: { forBot?: boolean; agentBrief?: string; cost?: AgentCost } = {}) {
  const pair = await getPair(chain, pool);
  const frames = await loadFrames(chain, pool, pair);
  // Chart patterns found by code on each timeframe, with how each did earlier on the same chart.
  const patterns = frames.map((f) => findPatterns(f.tf, f.candles));
  // The moving-average crossover on each chart from 1 minute up (the AI reads it in the chart data).
  const maCross = frames.map((f) => maView(f.tf, frameCross(f))).filter((m): m is MaView => m !== null);
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
  // An agent's plan is judged with what its own trade would cost in this pool; your own Analyze with your settings.
  const cost = opts.cost?.pct ?? roundTripCostPct();
  const managed = opts.agentBrief ? state.trades.filter((t) => t.strategy === "agents" && t.side === "SELL" && t.reachedTarget && t.usd - (t.pnlUsd ?? 0) > 0) : [];
  const measuredWinPct = managed.length >= 5 ? managed.reduce((s, t) => s + ((t.pnlUsd ?? 0) / (t.usd - (t.pnlUsd ?? 0))) * 100, 0) / managed.length : undefined;
  let D: Desk | null = null, deskOut: ReturnType<typeof deskReport> = null;
  if (opts.agentBrief) {
    const c1 = frames.find((f) => f.tf === "1m")?.candles ?? [], c5 = frames.find((f) => f.tf === "5m")?.candles ?? [];
    try {
      settleForecasts(pool, c1, c5);
      D = desk(c1, c5, cost, ruleTrailPct(EXIT_LIVE, primary.snap.atrPct)); // simulated winners are followed the way the bot would follow them
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
        minNumbersPct: state.bot.config?.minNumbersPct ?? AGENT_MIN_NUMBERS_PCT,
        predict: (o, validMinutes) => {
          const k = orderKey(o);
          if (!seen.has(k)) seen.set(k, D?.ready ? D.forecast(shapeOf(o, pair.priceUsd, cost, validMinutes)) : null);
          return seen.get(k) ?? null;
        },
      }
    : undefined;
  // Agents: a free check before the paid one. If no buy could pass the prediction check even with
  // an AI that is 95% sure (the numbers are that low: a coin that is not moving enough to clear
  // its costs), the AI is not asked.
  if (judge && D?.ready) {
    const best = bestCase(D, pair.priceUsd, cost, judge);
    const floor = judge.minNumbersPct ?? 0;
    if (best && !best.passes) {
      const low = best.numbers < floor;
      const why = low
        ? `from this coin's own candles, no plain order has even a ${floor}% chance of reaching +${AGENT_NET_TARGET}% after costs before its stop (the best is ${best.numbers < 1 ? "under 1" : Math.round(best.numbers)}%)`
        : `even if it were ${AI_CEILING_PCT}% sure, the best order would have a ${Math.round(best.pWin)}% combined chance of reaching +${AGENT_NET_TARGET}% after costs and needs ${Math.ceil(best.needPct)}%`;
      const note = `The numbers rule out a buy right now, so the AI was not asked (no AI tokens spent): ${why}.`;
      standAside(state.bot.config!, { kind: "numbers", reasons: [low ? `the numbers give at most ${Math.round(best.numbers)}%, under the ${floor}% floor` : `best case ${Math.round(best.pWin)}% chance, needs ${Math.ceil(best.needPct)}%`] }, note, { trendDown, atrPct: primary.snap.atrPct, patterns, maCross, priceAt: pair.priceUsd, ...(deskOut ? { desk: deskOut.view } : {}), ...(opts.cost ? { cost: opts.cost } : {}) });
      save();
      return { pair, snapshot: snap, results: [] as ModelResult[], consensus: state.lastSignal!.consensus, patterns, maCross };
    }
  }
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
    state.lastSignal = { at: Date.now(), pool, symbol: pair.symbol, tf, results: shown, consensus, trendDown, atrPct: primary.snap.atrPct, patterns, maCross, priceAt: pair.priceUsd, ...(deskOut ? { desk: deskOut.view } : {}), ...(opts.cost ? { cost: opts.cost } : {}) };
    state.bot.armedSince = []; // a new plan: its triggers start fresh
    state.bot.skipNoted = [];
  }
  save();
  return { pair, snapshot: snap, results: shown, consensus, patterns, maCross };
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
  if (cfg.pick === "agent" && cfg.autoPick) {
    // An auto-pick agent starts without a coin: it chooses one itself on its first check.
    Object.assign(cfg, { chain: "solana", pool: "", symbol: "" });
    delete cfg.mint;
    delete cfg.imageUrl;
  } else {
    delete cfg.autoPick;
    delete cfg.autoStrict;
    delete cfg.mint;
  }
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
  rec("bot.start", isAutoAgent(cfg) ? `Auto-pick agent started ($${cfg.budgetUsd ?? 1000} budget${cfg.autoStrict ? ", only coins that pass every scout check" : ""})` : `Bot started on ${cfg.symbol} (${cfg.pick === "auto" ? "auto-pick" : cfg.pick === "agents" ? "agents" : cfg.pick === "agent" ? `agent, $${cfg.budgetUsd ?? 1000} budget` : "this coin"})${cfg.allowRisky ? " in risky mode" : ""}`, {
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
  state.bot.costCurve = undefined; // ...and measures what trading it costs
  state.bot.quality = undefined;
  state.bot.aiNotes = [];
  state.bot.lastFiredAt = undefined;
  state.bot.watch = null;
  state.bot.stoppedAt = null;
  state.bot.auto = isAutoAgent(cfg) ? { note: "", at: Date.now() } : undefined;
  if (isAutoAgent(cfg)) state.lastSignal = null;
  cfg.trailPct = clampNum(cfg.trailPct ?? 3, 0.5, 30);
  log(
    isNew(cfg)
      ? `Bot started in NEW COINS mode (${cfg.newChain ?? "solana"}): ${cfg.newCoinPct ?? 3}% per coin, stop -${cfg.newStopPct ?? 15}%, half at +${cfg.newTakePct ?? 30}%, max ${cfg.newMaxPerDay ?? 5} buys a day. Cash $${state.cash.toFixed(2)}.`
      : isAuto(cfg)
      ? `Bot started in AUTO-PICK mode (${cfg.autoChain === "all" ? "all chains" : cfg.autoChain}). Each round the AI checks the top ${cfg.autoCandidates} coins. Cash $${state.cash.toFixed(2)}.`
      : isAutoAgent(cfg)
        ? `Auto-pick agent started with a $${cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT} budget. It takes the best coin on the scouts' list that no other agent of yours is on${cfg.autoStrict ? " (only coins that pass every scout check)" : ""}${autoCostMax(cfg) > 0 ? `, passing over a coin where buying and selling its money would cost more than ${autoCostMax(cfg)}%` : ""}, and chooses again after every trade.`
      : isCoinAgent(cfg)
        ? `Agent started on ${cfg.symbol} with a $${cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT} budget. Its AI is reading the charts and deciding now.`
      : `Bot started on ${cfg.symbol} (${cfg.tf}). Paper mode. Cash $${state.cash.toFixed(2)}.${cfg.allowRisky ? " RISKY MODE: it will also buy while the coin is falling (you accepted the risk). Trades are capped at 25% of the account, with a 5-minute cool-down after a loss." : ""}`,
    "good",
    { act: "start", ...(cfg.symbol ? { coin: cfg.symbol } : {}), why: isCoinAgent(cfg) ? `${isAutoAgent(cfg) ? "auto-pick agent" : "agent"} with a ${usd0(cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT)} budget` : "bot started" },
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
  log(`${isCoinAgent(state.bot.config ?? ({} as BotConfig)) ? "Agent" : "Bot"} stopped: ${reason}`, "bad", { act: "stop", ...(state.bot.config?.symbol ? { coin: state.bot.config.symbol } : {}), why: shortWhy(reason) });
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
function noteOnce(key: string, msg: string, level: "info" | "good" | "bad" = "info", d?: Decision): boolean {
  if (state.bot.noted[key]) return false;
  state.bot.noted[key] = Date.now();
  for (const [k, at] of Object.entries(state.bot.noted)) if (Date.now() - at > 2 * 86_400_000) delete state.bot.noted[k];
  log(msg, level, d);
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
    const cost = pos.costPct ?? roundTripCostPct();
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
  state.lastSignal = { at: Date.now(), pool: pair.pool, symbol: pair.symbol, tf: cfg.tf, results: result.results, consensus: result.consensus, atrPct: result.snapshot?.atrPct, patterns: result.patterns, maCross: result.maCross };
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

// ---------- One price series for an open trade ----------
// A trade is followed on the 5-second feed (CoinMarketCap). When that feed gives no current
// answer for a check, quote() falls back to the pool's own snapshot (DexScreener). The two do not
// agree: on eight coins on 25 Nov 2026 the feed read from 0.6% under to 0.5% over the snapshot on
// average, single readings from 1.0% under to 1.0% over, and the snapshot lags a fast move. To an
// open trade a change of source therefore looked like a sudden move of that size, and a profit
// locked on one source could be sold on the other (a live mihao sale that day was priced 1.5%
// under the lowest 5-second price of its minute).
// So for an agent's trade: the difference between the two is remembered whenever both are seen
// (pos.feedRatio), and a reading from the backup is brought to the feed's level with it. And a
// profit exit is not taken on backup readings until the backup has been the only source for
// BACKUP_EXIT_MS (see the profit exit in tickBot); a fall back to the buy price still sells at once.
const MAIN_FEED = "CoinMarketCap 5s candles";
export const BACKUP_EXIT_MS = 30_000;
function sameFeed(pos: Position, q: Quote): { q: Quote; backupFor: number | null } {
  const a = acct();
  const since = (a.backupSince ??= new Map<string, number>());
  if (q.source === MAIN_FEED) {
    since.delete(pos.id);
    const r = q.dex > 0 ? q.price / q.dex : 1;
    // Kept on the trade (and so saved) only when it has moved by a third of a percent: it is
    // read at every check, and a trade must not be saved every 5 seconds for it.
    if (r > 0.9 && r < 1.1 && Math.abs(r - (pos.feedRatio ?? 1)) >= 0.003) {
      pos.feedRatio = Math.round(r * 1e4) / 1e4;
      a.dirty = true;
    }
    return { q, backupFor: null };
  }
  const now = Date.now();
  if (!since.has(pos.id)) since.set(pos.id, now);
  const k = pos.feedRatio ?? 1;
  const adj = k === 1 ? q : { ...q, price: q.price * k, low: q.low * k, high: q.high * k, peakHigh: q.peakHigh * k, closeLow: q.closeLow * k, pair: { ...q.pair, priceUsd: q.price * k } };
  return { q: adj, backupFor: now - since.get(pos.id)! };
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
export const AGENT_NET_TARGET = EXIT_LIVE.minNetPct; // minimum % profit after all fees an agent's trade aims for (rules.ts)
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
// The numbers and the rule itself are in rules.ts (stopCheck, EXIT_LIVE), shared with the back-tester;
// so are the breakout entry rules (breakoutHoldSec, chaseLimitPct).
const RELEARN_MS = 60 * 60_000;

// The agent's money: its budget plus everything its trades have made or lost since it started.
function agentFunds(cfg: BotConfig) {
  const since = state.bot.startedAt ?? 0;
  const pnl = state.trades.filter((t) => t.strategy === "agents" && (t.botId ?? "1") === currentBotId() && t.time >= since && t.side === "SELL").reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const budget = cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT;
  // An auto-pick agent starts every trade with its budget, never more: profit beyond the budget
  // goes back to the account's available cash, and a loss comes out of the budget until its
  // later trades have made it back. So the budget is still the most the agent can lose.
  return cfg.autoPick ? Math.min(budget, budget + pnl) : budget + pnl;
}

// What this agent's next buy would cost, and how much of its funds it would invest: all of it,
// or less when that keeps the round-trip cost under the agent's cap (a large buy in a thin pool
// moves the price against itself, on the way in and again on the way out).
export const AGENT_COST_CAP_PCT = 2.5;
const costCap = (cfg: BotConfig) => (isOff(cfg, "maxCostPct") ? 0 : (cfg.maxCostPct ?? AGENT_COST_CAP_PCT));
const agentSpendable = (cfg: BotConfig) => Math.max(0, Math.floor(Math.min(state.cash, availableCash(acct().state, currentBotId()), agentFunds(cfg)) * 100) / 100);
function costFor(curve: CostCurve, cfg: BotConfig): AgentCost {
  const funds = agentSpendable(cfg), capPct = costCap(cfg);
  const usd = sizeUnderCap(curve, funds, capPct);
  return { pct: costAt(curve, usd), usd, funds, fullPct: costAt(curve, funds), capPct, source: curve.source };
}
const curveMint = (cfg: BotConfig, pair: PairInfo) => (cfg.chain === "solana" ? pair.tokenAddress : undefined); // Jupiter only quotes Solana coins
async function agentCost(cfg: BotConfig, pair: PairInfo): Promise<AgentCost> {
  const curve = await costCurve(curveMint(cfg, pair), pair.liquidityUsd, agentSpendable(cfg), state.bot.costCurve);
  if (curve.source === "jupiter" && curve.at !== state.bot.costCurve?.at) {
    state.bot.costCurve = curve;
    acct().dirty = true;
  }
  return costFor(curve, cfg);
}

// Is this agent's coin fit to trade at all? Asked of the scouts before the AI (see qualityGate).
// null = the gate is off, or nothing is known about the coin (then it is not refused).
async function coinGate(cfg: BotConfig): Promise<CoinGate | null> {
  if (isOff(cfg, "qualityGate") || cfg.chain !== "solana") return null;
  const pair = await getPair(cfg.chain, cfg.pool);
  const t = pair.tokenAddress ? await tokenInfo(pair.tokenAddress) : null;
  return t ? qualityGate(scoreCoin(t, null), cfg.minQuality ?? QUALITY_MIN) : null;
}
// The agent stands aside without asking its AI: an empty AVOID plan that says why, good for 5 minutes.
function standAside(cfg: BotConfig, gate: PlanGate, note: string, extra: Partial<NonNullable<State["lastSignal"]>> = {}) {
  const now = Date.now();
  state.lastSignal = {
    at: now, pool: cfg.pool, symbol: cfg.symbol, tf: cfg.tf, results: [],
    consensus: { ...combine([], roundTripCostPct(), extra.priceAt ?? 0), stance: "AVOID", action: "SELL", note, expiresAt: now + AGENT_RECHECK_SEC * 1000 },
    gate, ...extra,
  };
  state.bot.armedSince = [];
  state.bot.skipNoted = [];
  if (gate.kind === "scouts") noteOnce(`gate:scouts:${Math.floor(now / 3_600_000)}:${gate.reasons.join("|").slice(0, 160)}`, `${note} It looks again every 5 minutes.`, "bad", { act: "filtered", coin: cfg.symbol, by: "scouts", why: shortWhy(`the scouts: ${gate.reasons.join("; ")}`) });
  acct().dirty = true;
}
// Turn an agent's quality gate off ("trade it anyway", recorded) or back on.
export function setQualityGate(on: boolean, botId?: string): { ok: boolean; qualityGate: boolean } {
  if (botId && botId !== currentBotId()) return withBot(botId, () => setQualityGate(on));
  const cfg = state.bot.config;
  if (cfg) cfg.disabled = on ? (cfg.disabled ?? []).filter((k) => k !== "qualityGate") : [...new Set([...(cfg.disabled ?? []), "qualityGate"])];
  rec("bot.setting", on ? "Turned the coin quality gate on" : "Turned the coin quality gate off (trade this coin anyway)", { qualityGate: on, running: state.bot.running });
  if (state.bot.running) {
    log(on ? "Quality gate on: the scouts check this coin before the AI is asked." : "Quality gate off: the AI is asked about this coin whatever the scouts say.", on ? "good" : "bad");
    state.lastSignal = null; // decide again now, with the new setting
    state.bot.lastAnalysisAt = 0;
  }
  save();
  return { ok: true, qualityGate: on };
}

// true = the agent stopped because its budget is used up (under a tenth of it, or under $10, is left)
function agentSpent(cfg: BotConfig): boolean {
  const budget = cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT;
  if (agentFunds(cfg) >= Math.max(10, budget * 0.1)) return false;
  stopBot(`Agent stopped: its $${budget} budget is used up. Its trades are in your history.`);
  alert(`⏹ Agent${cfg.symbol ? ` on ${cfg.symbol}` : ""} stopped: its $${budget} budget is used up.`);
  return true;
}

// ---------- Auto-pick agents ----------
// An agent that chooses its own coin. It takes the best coin on the scouts' list (agents.ts) that
// none of the account's other agents is on: the coins that pass every scout check first, then
// (unless it was started "strict") the next best by score that are fit to trade, which is the test
// every agent applies to its coin before it asks its AI (no structural deal-breaker, quality at
// or over its minimum). From there it is an ordinary agent on that coin: its AI plans, the order
// check judges, the same exits apply. It chooses again
//  - after every trade (a coin it lost on is left alone for half an hour),
//  - when the scouts rule its coin out,
//  - when its coin is too expensive for its money (see AUTO_MAX_COST_PCT), and
//  - when its coin has given it no live order for AUTO_IDLE_MS, if another coin is free
//    (the coin it leaves is not tried again for half an hour, so agents do not swap coins in circles).
// With no coin to take it waits, at no AI cost, and looks at the list again every half minute.
// Choosing a coin costs nothing; the AI is asked only once the agent is on a coin, as always.
export const AUTO_IDLE_MS = 10 * 60_000;
// A coin is too expensive for an auto-pick agent when buying and then selling everything the agent
// trades with would cost more than this % (the pool's fees, and the price the trade itself moves,
// both ways: costs.ts). The agent passes such a coin over and takes the best one it can afford;
// with none, it waits. The size cap (AGENT_COST_CAP_PCT) does not do this job: it makes the trade
// smaller, the cost stays near the cap, and an order then has to be right well over half the time.
// Measured on 3,819 buys with no skill over three sets of real prices (npm run backtest:pick):
// the scouts' order among coins costing at most 1.5% did better per buy than the scouts' order
// alone on all three (-1.17 / +2.76 / +0.09% against -2.49 / +0.53 / -0.76%).
// It is not a profit rule: each trade starts less far behind, nothing more.
// The cost is for the agent's own money, so a small agent can take coins a large one cannot.
// Only a measured cost counts (two-way Jupiter quotes). When Jupiter cannot be asked no coin is
// passed over: the estimate from a pool's depth reads far too high for a coin that trades in
// several pools, and an agent never refuses or leaves a coin on a guess.
export const AUTO_MAX_COST_PCT = 1.5;
// The line is for choosing a coin. An agent leaves the coin it is on for its cost only when that
// is clearly over the line (by this many points): a coin priced right at the line must not send
// its agent away and back again (every arrival asks the AI for a new plan), and an agent that
// was on a coin just over the line when this rule arrived is not pulled off it.
export const AUTO_COST_SLACK_PCT = 0.5;
const AUTO_COST_KEEP_MS = 60 * 60_000; // how long a measurement counts when a coin is chosen
// Jupiter answers one request every two seconds for everything the app asks of it (data.ts), and
// measuring a coin is four requests. So a look at the list measures a few coins at most and goes
// on from there half a minute later: pricing coins must not hold up the agents' own looks.
const AUTO_PRICE_PER_LOOK = 2;
const AUTO_PRICE_LOOK_MS = 20_000; // no new measurement once a look has taken this long
const AUTO_PRICE_WAIT_MS = 20_000; // the longest one measurement is waited for (it takes about 8 seconds when nothing else is asking)
// ...and only one coin is being measured for choosing at any moment, for all agents of all
// accounts on this server copy: an agent that finds another measurement under way goes on at its
// next look. So pricing takes at most every other turn in Jupiter's queue, however many agents wait.
// That next look comes soon (AUTO_PRICE_RETRY_MS, not the usual half minute), so that agents
// started together price the list one coin after another without idle gaps: ten agents settle in
// about two minutes instead of five.
let pricingNow = 0;
const AUTO_PRICE_RETRY_MS = 10_000;
// The quality step's own measurement in flight (it prices coins ahead of the agents, see
// aheadStep): one at a time for all accounts on this server copy, and started only while no
// agent's look is measuring. Agents' looks do not wait for it: the step gives way to them, never
// the other way round. So an agent's look is exactly as quick as before the step existed, or
// quicker, and at most two coins are ever being measured at once.
let aheadNow = 0;
const autoCostMax = (cfg: BotConfig) => (isOff(cfg, "autoMaxCostPct") ? 0 : Math.max(0, cfg.autoMaxCostPct ?? AUTO_MAX_COST_PCT));
// The most the coin an agent is on may cost: the line plus the slack. 0 = the rule is off.
const costLimit = (cfg: BotConfig) => { const max = autoCostMax(cfg); return max > 0 ? max + AUTO_COST_SLACK_PCT : 0; };
const usd0 = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pct1 = (v: number) => `${v.toFixed(1)}%`;
const nameList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "");
type Dear = { symbol: string; pct: number };
// pct: what a round trip of `funds` costs there; null = it could not be measured.
type CoinCost = { pct: number | null; funds: number; max: number };
const hasLiveOrder = (cfg: BotConfig, now = Date.now()) => {
  const sig = state.lastSignal;
  return !!sig && sig.pool === cfg.pool && now < sig.consensus.expiresAt && sig.consensus.stance !== "AVOID" && sig.consensus.orders.some((o) => !o.warning);
};
const AUTO_RESCAN_MS = 30_000;
const AUTO_SKIP_LOSS_MS = 30 * 60_000; // after a losing trade on it
const AUTO_SKIP_IDLE_MS = 30 * 60_000; // after leaving it without a trade
const AUTO_SKIP_UNFIT_MS = 60 * 60_000; // after the scouts ruled it out
const AUTO_SKIP_NOPOOL_MS = 10 * 60_000; // no market found for it
const isAutoAgent = (cfg: BotConfig) => cfg.pick === "agent" && !!cfg.autoPick;

// The coins an auto-pick agent may take, best first.
export function autoCandidates(scan: AgentScan, cfg: Pick<BotConfig, "autoStrict" | "minQuality">): AgentCoin[] {
  const fit = (c: AgentCoin) => qualityGate(c, cfg.minQuality ?? QUALITY_MIN).ok;
  const passing = scan.coins.filter((c) => !c.vetoes.length && c.total >= AGENT_PASS && fit(c));
  if (cfg.autoStrict) return passing;
  return [...passing, ...scan.coins.filter((c) => !passing.includes(c) && fit(c)).sort((a, b) => b.total - a.total)];
}
// Tokens the account's other agents are on or hold.
function otherAgentMints() {
  const st = acct().state;
  const me = currentBotId();
  const out = new Set<string>();
  for (const id of botIds(st)) {
    if (id === me) continue;
    const b = id === "1" ? st.bot : slotOf(st, id)!.bot;
    if (b.running && b.config?.mint) out.add(b.config.mint);
  }
  for (const p of st.positions) if (p.tokenMint && !(p.source === "bot" && (p.botId ?? "1") === me)) out.add(p.tokenMint);
  return out;
}
// Keeps a measured cost with the account, for all of its auto-pick agents on every server copy.
function rememberCost(mint: string | undefined, curve: CostCurve | null | undefined) {
  if (!mint || curve?.source !== "jupiter") return;
  const known = (state.bot.autoCost ??= {});
  if (known[mint]?.at === curve.at) return;
  known[mint] = curve;
  const mints = Object.keys(known);
  if (mints.length > 80) for (const m of mints.sort((a, b) => known[a].at - known[b].at).slice(0, mints.length - 80)) delete known[m];
  acct().dirty = true;
}
// What a round trip of `funds` is known to cost in a coin: from a measurement of the last hour, by
// this server copy or by any of the account's agents. null = not known. A measurement taken for
// a much smaller trade only says "at least this much" about a larger one, which settles it when
// even that is over the line.
function knownCost(mint: string, funds: number, max: number): number | null {
  const curve = knownCurve(mint, 0, state.bot.autoCost?.[mint]);
  const pct = knownPct(curve, funds, max, Date.now(), AUTO_COST_KEEP_MS); // (the sums: quality.ts)
  if (curve.source === "jupiter" && Date.now() - curve.at <= AUTO_COST_KEEP_MS) rememberCost(mint, curve);
  return pct;
}
// A coin found too expensive for an agent with this much money is the quality step's finding,
// whichever agent's look (or the step's own work ahead) came across it: written once an hour for
// the whole account, in the step's own lines. So the record of what was ruled out is complete,
// and ten agents passing the same coin over do not write it ten times.
// (It is called from inside an agent's look: writing the record must never stop the look.)
function ruledOutForCost(symbol: string, mint: string, pct: number, funds: number, max: number) {
  try {
    const said = (state.bot.autoSaid ??= {});
    const now = Date.now(), k = `${mint}|${Number(funds.toPrecision(2))}`; // (to two figures: $997 and $1,000 are the same money here)
    for (const [key, at] of Object.entries(said)) if (now - at > 2 * 3_600_000) delete said[key];
    if (now - (said[k] ?? 0) < 3_600_000) return;
    said[k] = now;
    stepLog(`Quality check: ${symbol} is passed over for an agent with ${usd0(funds)}: buying and selling there costs about ${pct1(pct)}, more than the ${max}% it accepts.`, "info",
      { act: "filtered", coin: symbol, by: "cost", why: `the cost: trading ${usd0(funds)} there costs ${pct1(pct)}, the line is ${max}%` });
  } catch (e) {
    console.error("[quality] record:", e);
  }
}
// Measures it. "no" = Jupiter could not be asked (the coin is then not refused, as before this
// rule). "late" = no answer in time (the look stops there and goes on next time).
// step = the quality step is asking, not an agent's look (it is counted apart, see aheadNow).
async function priceCoin(mint: string, liquidityUsd: number, funds: number, waitMs = AUTO_PRICE_WAIT_MS, step = false): Promise<number | "no" | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = costCurve(mint, liquidityUsd, funds, state.bot.autoCost?.[mint]);
  // (counted until the measurement itself is over, also when the asker stops waiting for it)
  if (step) aheadNow++; else pricingNow++;
  const over = () => { if (step) aheadNow--; else pricingNow--; };
  void work.then(over, over);
  const curve = await Promise.race([
    work,
    new Promise<null>((ok) => { timer = setTimeout(() => ok(null), Math.max(0, waitMs)); }),
  ]).finally(() => clearTimeout(timer));
  if (!curve) return "late";
  if (curve.source !== "jupiter") return "no";
  rememberCost(mint, curve);
  return costAt(curve, funds);
}
// The same for the coin the agent is on, from the measurement kept with it (every look of its AI
// measures it). null = the rule is off for it, or nothing was measured within the hour.
function ownCost(cfg: BotConfig): { pct: number; funds: number; max: number } | null {
  const max = autoCostMax(cfg), funds = agentSpendable(cfg), curve = state.bot.costCurve;
  if (!(max > 0) || !(funds > 0) || curve?.source !== "jupiter" || Date.now() - curve.at > AUTO_COST_KEEP_MS) return null;
  return { pct: costAt(curve, funds), funds, max };
}
// What the card shows while the agent has no coin. Its log is written when the kind of reason
// changes (`key`), not each time a count in the text moves.
function autoNote(text: string, key = text, why = "") {
  const au = (state.bot.auto ??= { note: "", at: Date.now() });
  au.nextAt = Date.now() + AUTO_RESCAN_MS;
  if (au.note === text) return;
  const sameKind = au.note !== "" && (au.key ?? au.note) === key;
  au.note = text;
  au.key = key;
  acct().dirty = true;
  if (sameKind) return;
  au.at = Date.now();
  log(`Auto-pick: ${text}`, "info", { act: "wait", why: shortWhy(why || text) });
}
// The agent lets its coin go and waits for one it can take (it holds no trade).
function autoRelease(cfg: BotConfig) {
  Object.assign(cfg, { pool: "", symbol: "" });
  delete cfg.mint;
  delete cfg.imageUrl;
  state.lastSignal = null;
  state.bot.askNow = false;
  const au = (state.bot.auto ??= { note: "", at: Date.now() });
  delete au.again;
  delete au.idleSince;
  acct().dirty = true;
}
// Puts the agent on a coin: from here it is an ordinary agent on it, starting from a fresh AI plan.
// moved = the same reason in a few words, for the one-line log.
function autoAssign(cfg: BotConfig, found: { coin: AgentCoin; pair: PairInfo; cost?: CoinCost; dear: Dear[] }, why: string, moved = "") {
  const { coin: c, pair, cost, dear } = found;
  const same = cfg.pool === pair.pool;
  Object.assign(cfg, { chain: pair.chain, pool: pair.pool, symbol: pair.symbol, mint: c.mint });
  const img = c.icon ?? pair.imageUrl;
  if (okImage(img)) cfg.imageUrl = img;
  else delete cfg.imageUrl;
  state.lastSignal = null;
  state.bot.lastAnalysisAt = 0;
  state.bot.armedSince = [];
  state.bot.skipNoted = [];
  state.bot.askNow = false;
  state.bot.freshAfter = Date.now();
  if (!same) {
    state.bot.learned = undefined;
    state.bot.costCurve = state.bot.autoCost?.[c.mint]; // what was measured for this coin, if anything
    state.bot.quality = undefined;
    state.bot.aiNotes = [];
    state.bot.lastFiredAt = undefined;
    state.bot.watch = null;
  }
  const au = state.bot.auto ?? { note: "", at: Date.now() };
  state.bot.auto = { note: "", at: Date.now(), pickedAt: Date.now(), picks: (au.picks ?? 0) + 1 };
  const passes = !c.vetoes.length && c.total >= AGENT_PASS;
  const costNote = `${cost && cost.pct !== null ? ` Buying and selling its ${usd0(cost.funds)} there costs about ${pct1(cost.pct)}.` : ""}${cost && dear.length ? ` It passed over ${nameList(dear.slice(0, 4).map((d) => `${d.symbol} (${pct1(d.pct)})`))}${dear.length > 4 ? ` and ${dear.length - 4} more` : ""}, higher on the list: more than the ${cost.max}% it accepts.` : ""}`;
  log(`Auto-pick: ${why}${same ? `${pair.symbol} is still the best coin that is free, so it stays on it` : `chose ${pair.symbol}`} (the scouts' score ${c.total} of 100${passes ? ", passes every scout check" : c.timing.length ? `; the scouts' timing check says "${c.timing[0]}", so its AI decides when to buy` : `, under the ${AGENT_PASS} that passes; fit to trade`}).${costNote} Its AI reads the charts now.`, "good", {
    act: "pick", coin: pair.symbol, score: c.total, ...(cost && cost.pct !== null ? { costPct: Math.round(cost.pct * 100) / 100 } : {}),
    why: shortWhy(`${moved ? `${moved}; ` : ""}${same ? "still the best coin that is free; " : ""}the scouts' score ${c.total} of 100${cost && cost.pct !== null ? `, costs ${pct1(cost.pct)} to trade with its ${usd0(cost.funds)}` : ""}${cost && dear.length ? `; passed over ${nameList(dear.slice(0, 4).map((d) => `${d.symbol} (${pct1(d.pct)})`))}` : ""}`, 220),
  });
  acct().dirty = true;
}
// The best coin this agent could take right now (not `except`), or null with the reason.
// failed = the list itself could not be read (as opposed to: read, and nothing on it is free).
// more = the look stopped while coins were still to be priced: it goes on from there next time.
// A coin that is returned stays claimed for this agent (autoBusy) until the caller has taken it
// or let it be: the caller must pass the result to autoUnclaim(). A coin is claimed before
// anything is awaited about it, so two agents looking at the same moment never get the same coin,
// and never measure the same coin twice.
// soon = it stopped only because another agent's measurement was under way: it looks again in a few seconds.
// why = the reason it has no coin, in a few words (for the one-line log).
type AutoFound = { coin: AgentCoin; pair: PairInfo; cost?: CoinCost; dear: Dear[] } | { none: string; key?: string; why?: string; failed?: boolean; more?: boolean; soon?: boolean };
const autoUnclaim = (found: AutoFound) => { if ("coin" in found) acct().autoBusy?.delete(found.coin.mint); };
async function autoFind(except?: string): Promise<AutoFound> {
  const now = Date.now();
  const scan = await scanAgents().catch(() => null);
  const cfg = state.bot.config;
  if (!cfg || !state.bot.running || !isAutoAgent(cfg)) return { none: "" };
  if (!scan?.coins.length) return { none: "the scouts' list could not be loaded just now. It tries again in half a minute", failed: true };
  const skip = (state.bot.autoSkip ??= {});
  for (const [m, until] of Object.entries(skip)) if (until < now) delete skip[m];
  const known = state.bot.autoCost;
  if (known) for (const [m, c] of Object.entries(known)) if (now - c.at > AUTO_COST_KEEP_MS) { delete known[m]; acct().dirty = true; }
  const list = autoCandidates(scan, cfg);
  const busy = (acct().autoBusy ??= new Set<string>());
  const max = autoCostMax(cfg), funds = agentSpendable(cfg);
  const rule = max > 0 && funds > 0;
  const lookFrom = Date.now(); // (the list is read by now: the time a look may spend measuring counts from here)
  const dear: Dear[] = [];
  let taken = 0, rested = 0, measured = 0, more = false, soon = false;
  for (const c of list) {
    if (c.mint === except) continue;
    if (skip[c.mint]) { rested++; continue; }
    if (otherAgentMints().has(c.mint) || busy.has(c.mint)) { taken++; continue; }
    busy.add(c.mint);
    let mine = false;
    try {
      // Too expensive for this agent's money? Then its trade would start too far behind (AUTO_MAX_COST_PCT).
      let pct: number | null = rule ? knownCost(c.mint, funds, max) : null;
      if (rule && pct === null) {
        // This very coin is being measured right now (by the quality step, working ahead): the
        // look waits for that answer, which starts nothing new.
        const joins = measuring(c.mint);
        if (!joins) {
          if (measured >= AUTO_PRICE_PER_LOOK || Date.now() - lookFrom > AUTO_PRICE_LOOK_MS) { more = true; break; }
          if (pricingNow > 0) { more = true; soon = !measured; break; }
          measured++;
        }
        const got = await priceCoin(c.mint, c.liquidity, funds);
        if (!state.bot.running) return { none: "" };
        if (got === "late") { more = true; break; }
        pct = got === "no" ? null : got;
      }
      if (pct !== null && pct > max) { dear.push({ symbol: c.symbol, pct }); ruledOutForCost(c.symbol, c.mint, pct, funds, max); continue; }
      const pair = await bestPool(c.mint).catch(() => null);
      if (!state.bot.running) return { none: "" };
      if (!pair?.pool) { skip[c.mint] = now + AUTO_SKIP_NOPOOL_MS; rested++; continue; }
      if (otherBotPools().has(pair.pool) || acct().state.positions.some((p) => p.pool === pair.pool && !(p.source === "bot" && (p.botId ?? "1") === currentBotId()))) { taken++; continue; }
      mine = true;
      return { coin: c, pair, cost: rule ? { pct, funds, max } : undefined, dear };
    } finally {
      if (!mine) busy.delete(c.mint);
    }
  }
  const tooDear = dear.length ? ` Too expensive means that buying and selling there would cost more than ${max}% of the trade (${dear.slice(0, 4).map((d) => d.symbol).join(", ")}${dear.length > 4 ? ` and ${dear.length - 4} more` : ""}).` : "";
  if (more) return { none: `it is finding out what the free coins on the list cost to trade with its ${usd0(funds)}${dear.length ? `: ${dear.length} so far ${dear.length === 1 ? "is" : "are"} too expensive.${tooDear}` : "."} It goes on ${soon ? "in a few seconds" : "in half a minute"}, at no AI cost`, key: "pricing", why: `finding out what the free coins cost to trade with its ${usd0(funds)}${dear.length ? ` (${dear.length} too expensive so far)` : ""}`, more: true, soon };
  const n = list.filter((c) => c.mint !== except).length;
  const wait = "It waits, at no AI cost, and looks again every half minute";
  if (!n) return { none: `no coin ${cfg.autoStrict ? "passes every scout check" : "is fit to trade"} right now (${scan.scanned} scanned). ${wait}`, key: "none", why: `no coin ${cfg.autoStrict ? "passes every scout check" : "is fit to trade"} right now (${scan.scanned} scanned)` };
  const kind = cfg.autoStrict ? (n === 1 ? "passes every scout check" : "pass every scout check") : n === 1 ? "is fit to trade" : "are fit to trade";
  const several = [taken, rested, dear.length].filter((k) => k > 0).length > 1;
  const count = (k: number) => (several ? ` (${k})` : "");
  const parts = [taken ? `with your other agents${count(taken)}` : "", rested ? `resting after a recent try${count(rested)}` : "", dear.length ? `too expensive for its ${usd0(funds)}${count(dear.length)}` : ""].filter(Boolean);
  const where = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}` : parts[0] ?? "not free";
  return {
    none: `the ${n === 1 ? "one coin" : `${n} coins`} that ${kind} right now ${n === 1 ? "is" : "are"} ${where}.${tooDear} ${wait}`,
    key: `some|${taken ? "t" : ""}${rested ? "r" : ""}|${dear.map((d) => d.symbol).sort().join(",")}`,
    why: `no coin free: ${[taken ? `${taken} with your other agents` : "", rested ? `${rested} resting after a recent try` : "", dear.length ? `${dear.length} too expensive for its ${usd0(funds)} (${dear.slice(0, 4).map((d) => d.symbol).join(", ")}${dear.length > 4 ? ", ..." : ""})` : ""].filter(Boolean).join(", ")}`,
  };
}
// ---------- The quality step works ahead ----------
// While an account has auto-pick agents running, the step keeps the first AUTO_AHEAD coins of
// their list priced, for the most money any of them trades with, one coin at a time. An agent
// that needs a coin then finds the answer waiting instead of measuring during its own look. A
// measurement is taken again once it is AUTO_AHEAD_FRESH_MS old. Coins that an agent is on, or
// that are resting, are left for later: nobody could take them now.
// Nothing depends on it: where the step has not got to a coin yet, the agent's own look measures
// it as before (or joins the step's measurement of that coin, if one is under way), and never
// waits for the step. The step asks Jupiter for one coin at a time and starts only while no
// agent's look is measuring. When a try brings no fresh measurement (Jupiter does not answer, is
// too busy to answer in time, or has no price for that coin) it stands back for five minutes, and
// leaves that coin alone for a quarter of an hour, so that one coin which cannot be priced does
// not keep the others waiting. AUTO_AHEAD=0 switches it off.
// by = when the watch that runs this check ends (as deployed, a watch lasts under a minute and
// the scheduler's next call must find it over). The step starts a measurement only when the whole
// wait for one still fits in the watch, so it never makes a watch run long. Not given = no end
// (the local 5-second loop).
const aheadEnv = (process.env.AUTO_AHEAD ?? "").trim();
export const AUTO_AHEAD = aheadEnv !== "" && Number.isFinite(Number(aheadEnv)) ? Math.max(0, Math.floor(Number(aheadEnv))) : 20; // (anything that is not a number keeps the 20)
const AUTO_AHEAD_FRESH_MS = 45 * 60_000;
const AUTO_AHEAD_PAUSE_MS = 5 * 60_000;
const AUTO_AHEAD_COIN_MS = 15 * 60_000;
const AUTO_AHEAD_SCAN_MS = 5 * 60_000; // it reads the scouts' list itself at most this often (an agent that looks reads it anyway)
const AUTO_AHEAD_NEED_MS = AUTO_PRICE_WAIT_MS + 1_000; // it starts a measurement only when this much of the watch is left: the longest it waits for one, and a little
// The promise's answer, or null when it has not come within `ms`.
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  if (!Number.isFinite(ms)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<null>((ok) => { timer = setTimeout(() => ok(null), Math.max(0, ms)); })]).finally(() => clearTimeout(timer));
}
function aheadStep(by?: number) {
  const a = acct();
  const left = () => (by === undefined ? Infinity : by - Date.now());
  if (!AUTO_AHEAD || a.ahead || pricingNow > 0 || aheadNow > 0 || Date.now() < (a.aheadPauseUntil ?? 0) || left() < AUTO_AHEAD_NEED_MS) return;
  // Whom it works for: the running auto-pick agents that keep to a cost line. It prices for the
  // one with the most money (a measurement for a large trade also answers for a smaller one).
  let funds = 0, max = 0, strict = true, minQuality = 100;
  const held = new Set<string>();
  for (const id of runningIds()) withBot(id, () => {
    const cfg = state.bot.config;
    if (cfg?.mint) held.add(cfg.mint);
    if (!cfg || !isAutoAgent(cfg) || !(autoCostMax(cfg) > 0)) return;
    const f = Math.floor(agentFunds(cfg) * 100) / 100;
    if (f > funds) { funds = f; max = autoCostMax(cfg); }
    strict &&= !!cfg.autoStrict;
    minQuality = Math.min(minQuality, cfg.minQuality ?? QUALITY_MIN);
  });
  if (!(funds >= 10)) return;
  for (const p of a.state.positions) if (p.tokenMint) held.add(p.tokenMint);
  const work = (async () => {
    try {
      let scan = recentScan(AUTO_AHEAD_SCAN_MS);
      if (!scan) {
        if (Date.now() - (a.aheadScanAt ?? 0) < AUTO_AHEAD_SCAN_MS) return;
        a.aheadScanAt = Date.now();
        scan = await within(scanAgents().catch(() => null), left() - AUTO_AHEAD_NEED_MS);
      }
      if (!scan?.coins.length || left() < AUTO_AHEAD_NEED_MS) return;
      const now = Date.now(), resting = state.bot.autoSkip ?? {};
      const failed = (a.aheadSkip ??= new Map<string, number>());
      for (const [m, until] of failed) if (until <= now) failed.delete(m);
      const free = autoCandidates(scan, { autoStrict: strict, minQuality }).slice(0, AUTO_AHEAD).filter((c) => !held.has(c.mint) && !((resting[c.mint] ?? 0) > now));
      const verdicts = vet(free, { funds, max, now, keepMs: AUTO_COST_KEEP_MS, freshMs: AUTO_AHEAD_FRESH_MS, curveOf: (m) => knownCurve(m, 0, state.bot.autoCost?.[m]) });
      // What is known to be too expensive is on the step's record, whoever measured it.
      for (const v of verdicts) if (v.state === "dear" && v.pct !== null) ruledOutForCost(v.symbol, v.mint, v.pct, funds, max);
      // Its next coin: first one that nobody has priced (an agent may need it next), then one whose
      // measurement has grown old.
      const due = verdicts.filter((v) => v.stale && !failed.has(v.mint));
      const next = due.find((v) => v.state === "unpriced") ?? due[0];
      if (!next || pricingNow > 0 || aheadNow > 0) return;
      const got = await priceCoin(next.mint, free.find((c) => c.mint === next.mint)?.liquidity ?? 0, funds, Math.min(AUTO_PRICE_WAIT_MS, left()), true);
      // Did a fresh measurement come of it? (When Jupiter does not answer, an older measurement of
      // the coin may be handed back in its place: that is not one.)
      const fresh = typeof got === "number" && !needsPricing(knownCurve(next.mint, 0, state.bot.autoCost?.[next.mint]), funds, Date.now(), AUTO_AHEAD_FRESH_MS);
      if (typeof got !== "number" || !fresh) {
        a.aheadPauseUntil = Date.now() + AUTO_AHEAD_PAUSE_MS;
        failed.set(next.mint, Date.now() + AUTO_AHEAD_COIN_MS);
      } else if (got > max) ruledOutForCost(next.symbol, next.mint, got, funds, max);
    } catch (e) {
      console.error("[quality] working ahead:", e);
    }
  })();
  // (Cleared only once the round is over AND after it is noted here: a round with nothing to do
  // is over before this line is reached, and must not leave the note standing.)
  a.ahead = work;
  const steps = (a.steps ??= new Set());
  steps.add(work);
  void work.finally(() => {
    steps.delete(work);
    if (a.ahead === work) a.ahead = null;
  });
}

// One check of an auto-pick agent that holds no trade. true = it has no coin (nothing more to do now).
async function autoStep(cfg: BotConfig): Promise<boolean> {
  const now = Date.now();
  const au = (state.bot.auto ??= { note: "", at: now });
  if (cfg.pool && !au.again) {
    // Is its coin still worth staying on?
    const sig = state.lastSignal;
    rememberCost(cfg.mint, state.bot.costCurve); // what its own looks measure, the account's other agents can read
    const liveOrder = hasLiveOrder(cfg, now);
    if (liveOrder) {
      if (au.idleSince) { delete au.idleSince; acct().dirty = true; }
      return false;
    }
    if (!au.idleSince) { au.idleSince = now; acct().dirty = true; }
    const unfit = sig?.pool === cfg.pool && sig.gate?.kind === "scouts";
    // Its coin is too expensive for its money (as last measured for it).
    const own = ownCost(cfg), limit = costLimit(cfg);
    const dear = !!own && limit > 0 && own.pct > limit;
    if (!unfit && !dear && now - au.idleSince < AUTO_IDLE_MS) return false;
    if (now < (au.nextAt ?? 0)) return false;
    const found = await autoFind(cfg.mint);
    try {
      const cur = state.bot.config;
      if (!cur || cur !== cfg || !state.bot.running) return false;
      const tooDear = dear && own ? `buying and selling its ${usd0(own.funds)} on ${cfg.symbol} costs about ${pct1(own.pct)}, more than the ${own.max}% it accepts` : "";
      if ("none" in found) {
        if (tooDear && found.none && !found.failed && !found.more) {
          // Too expensive, and no coin it can take instead: it lets the coin go and waits, at no AI
          // cost, rather than keep asking its AI about a coin whose trades start too far behind.
          log(`Auto-pick: left ${cfg.symbol}: ${tooDear}. No other coin is free for it right now.`, "info", { act: "left", coin: cfg.symbol, by: "cost", why: `the cost: trading its ${usd0(own!.funds)} there costs ${pct1(own!.pct)}, it accepts ${own!.max}%; no other coin is free` });
          autoRelease(cfg);
          autoNote(found.none, found.key, found.why);
          return true;
        }
        // Otherwise only if another coin is free: it stays where it is and keeps looking.
        (state.bot.auto ??= au).nextAt = Date.now() + (found.soon ? AUTO_PRICE_RETRY_MS : (found.more ? 1 : 2) * AUTO_RESCAN_MS);
        return false;
      }
      // (A coin left for its cost is not rested for the account's other agents: one with less money may well afford it.)
      if (cfg.mint && !tooDear) (state.bot.autoSkip ??= {})[cfg.mint] = now + (unfit ? AUTO_SKIP_UNFIT_MS : AUTO_SKIP_IDLE_MS);
      autoAssign(cfg, found, tooDear ? `${tooDear}, so it moved on and ` : unfit ? `the scouts ruled ${cfg.symbol} out, so it moved on and ` : `${cfg.symbol} gave it no order to place for ${Math.round((now - au.idleSince) / 60_000)} minutes, so it moved on and `,
        tooDear ? `left ${cfg.symbol}: it costs ${pct1(own!.pct)} to trade` : unfit ? `left ${cfg.symbol}: the scouts ruled it out` : `left ${cfg.symbol}: no order to place for ${Math.round((now - au.idleSince) / 60_000)} minutes`);
      return false;
    } finally {
      autoUnclaim(found);
    }
  }
  if (!au.again && now < (au.nextAt ?? 0)) return true; // no coin, and it looked a moment ago
  // No coin yet, or its trade has closed: take the best coin that is free.
  const after = au.again ? "after its trade, " : "";
  const found = await autoFind();
  try {
    const cur = state.bot.config;
    if (!cur || cur !== cfg || !state.bot.running) return true;
    if ("none" in found) {
      if (cfg.pool && found.failed && !(cfg.mint && ((state.bot.autoSkip ?? {})[cfg.mint] ?? 0) > Date.now())) {
        // Its trade closed but the list cannot be read: it carries on with the coin it has.
        delete (state.bot.auto ??= au).again;
        acct().dirty = true;
        log(`Auto-pick: the scouts' list could not be loaded after its trade, so it stays on ${cfg.symbol} for now.`);
        return false;
      }
      // Its trade closed and nothing is free (its own coin is resting after a loss, no longer
      // qualifies, or is too expensive for what is left of its money): it lets the coin go and waits.
      if (cfg.pool) autoRelease(cfg);
      if (found.none) autoNote(found.none, found.key, found.why);
      if (found.soon) (state.bot.auto ??= au).nextAt = Date.now() + AUTO_PRICE_RETRY_MS;
      return true;
    }
    autoAssign(cfg, found, after, au.again ? "after its trade" : "");
    return false;
  } finally {
    autoUnclaim(found);
  }
}
// Start several auto-pick agents at once, one per free agent slot, each with its own budget.
// base = the settings every agent starts with (as the app sends for one agent).
export function startAutoAgents(base: BotConfig, budgets: number[], strict: boolean, maxBots = 10): { started: string[] } {
  const st = acct().state;
  const list = (Array.isArray(budgets) ? budgets : []).map((b) => Math.floor(Number(b) * 100) / 100);
  if (!list.length) throw new Error("Choose at least one agent.");
  if (list.some((b) => !(b >= 10))) throw new Error("Each agent's budget must be at least $10.");
  const running = runningIds(st);
  const free = Array.from({ length: 10 }, (_, i) => String(i + 1)).filter((id) => !running.includes(id) && !st.positions.some((p) => p.source === "bot" && (p.botId ?? "1") === id));
  const room = Math.max(0, Math.min(free.length, maxBots - running.length));
  if (list.length > room) throw new Error(room ? `Only ${room} agent${room === 1 ? " is" : "s are"} free right now (your plan includes ${maxBots}, ${running.length} ${running.length === 1 ? "is" : "are"} running).` : `All ${maxBots} of your agents are running. Stop one first.`);
  const total = list.reduce((s, b) => s + b, 0), cash = availableCash(st);
  if (total > cash + 0.005) throw new Error(`These budgets add up to $${total.toFixed(2)}, but only $${cash.toFixed(2)} is available${st.cash - cash > 0.005 ? ` ($${(st.cash - cash).toFixed(2)} is locked for your other agents)` : ""}.`);
  const started: string[] = [];
  list.forEach((budgetUsd, i) => {
    startBot({ ...base, chain: "solana", pool: "", symbol: "", tf: "5m", pick: "agent", autoPick: true, ...(strict ? { autoStrict: true } : { autoStrict: undefined }), budgetUsd }, free[i], maxBots);
    started.push(free[i]);
  });
  return { started };
}

// What an agent's plan decided, for the one-line log. A plan with a buy-now order decides nothing
// yet: the buy that follows is the decision. Otherwise it has an order waiting at a price, or it
// stays out (its AI's choice, or its orders did not have the odds).
function planDecision(cfg: BotConfig, c: Consensus, results: ModelResult[]): Decision | undefined {
  if (!isCoinAgent(cfg)) return undefined;
  const ok = results.find((x) => x.ok);
  if (!ok) return { act: "skip", coin: cfg.symbol, why: "its AI could not be asked for a plan" };
  const said = ok.ok ? ok.signal.reasoning : "";
  const odds = (o: CheckedOrder) => (o.prediction ? `${Math.round(o.prediction.pWin)}% chance, needs ${Math.ceil(o.prediction.needPct)}%` : `${o.winChancePct}% chance`);
  const at = (o: CheckedOrder) => (o.kind === "buy_now" ? "buying now" : `${o.kind === "buy_breakout" ? "a breakout above" : "a dip to"} ${fmt(o.triggerPrice)}`);
  const used = c.orders.filter((o) => !o.warning);
  if (c.stance !== "AVOID" && used.length) {
    if (used.some((o) => o.kind === "buy_now")) return undefined;
    const first = used[0];
    return { act: "order", coin: cfg.symbol, ...(first.prediction ? { winPct: Math.round(first.prediction.pWin), needPct: Math.ceil(first.prediction.needPct) } : {}), ...(first.triggerPrice ? { price: first.triggerPrice } : {}), why: shortWhy(`waits for ${used.map((o) => `${at(o)} (${odds(o)})`).join(" or ")}${said ? ` \u00b7 ${said}` : ""}`, 220) };
  }
  const gap = (o: CheckedOrder) => (o.prediction ? o.prediction.needPct - o.prediction.pWin : 0);
  const best = [...c.orders].sort((x, y) => gap(x) - gap(y))[0];
  return { act: "skip", coin: cfg.symbol, ...(best?.prediction ? { winPct: Math.round(best.prediction.pWin), needPct: Math.ceil(best.prediction.needPct) } : {}), why: shortWhy(`${said || "its AI sees no bet worth taking"}${best ? ` \u00b7 closest: ${at(best)}, ${odds(best)}` : ""}`, 220) };
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
  if (agentSpent(cfg)) return true;
  const L = state.bot.learned;
  if (!L || Date.now() - L.at > RELEARN_MS) {
    try {
      const pair = await getPair(cfg.chain, cfg.pool);
      const [c5, c1] = await Promise.all([
        getCandles(cfg.chain, cfg.pool, "5m", 300, pair).catch(() => []),
        getCandles(cfg.chain, cfg.pool, "1h", 300, pair).catch(() => []),
      ]);
      state.bot.learned = learn([{ tf: "5m", candles: c5 }, { tf: "1h", candles: c1 }], (await agentCost(cfg, pair)).pct, AGENT_NET_TARGET);
      if (!L) log(`${cfg.symbol} agent: studied the coin's history for the AI. ${state.bot.learned.summary}`);
      acct().dirty = true;
    } catch { /* the AI still gets the charts */ }
  }
  return false;
}

// What the AI is told when it plans for an agent.
async function agentBrief(cfg: BotConfig, why = "", ac?: AgentCost): Promise<string> {
  const cost = ac?.pct ?? roundTripCostPct();
  const invests = !ac
    ? "each buy invests all of it"
    : ac.usd < ac.funds - 0.5
      ? `each buy invests $${ac.usd.toFixed(0)} of it, not all: in this pool a round trip of $${ac.usd.toFixed(0)} costs about ${ac.pct.toFixed(1)}%, and all $${ac.funds.toFixed(0)} would cost ${ac.fullPct.toFixed(1)}%, more than the ${ac.capPct}% this agent allows`
      : `each buy invests all of it; in this pool a round trip of that size costs about ${ac.pct.toFixed(1)}%`;
  const costNote = ac ? ` Costs are not a flat rate: they were ${ac.source === "jupiter" ? "measured for this pool and this size with two-way Jupiter quotes" : "estimated for this size from the pool's depth"} (pool fees plus the price the trade itself moves, both ways).` : "";
  const L = state.bot.learned;
  const managed = state.trades.filter((t) => t.strategy === "agents" && t.side === "SELL" && t.reachedTarget && t.usd - (t.pnlUsd ?? 0) > 0);
  const managedNote = managed.length >= 5
    ? `+${(managed.reduce((s, t) => s + ((t.pnlUsd ?? 0) / (t.usd - (t.pnlUsd ?? 0))) * 100, 0) / managed.length).toFixed(1)}% (what this account's ${managed.length} managed winners really made on average after costs)`
    : `+${AGENT_NET_TARGET}% plus 30% of the extra distance from there to your target, with the target counted up to +20% (winners are held for more, but not all of the extra is captured)`;
  const lines = [
    ...(why ? [`Why you are being asked right now: ${why}.${/level .* it was watching/.test(why) ? " That level came from your last answer; decide with what the chart shows now whether to buy here, and say BUY_NOW if so." : ""}`] : []),
    `You are this coin's dedicated trading agent. Budget $${cfg.budgetUsd ?? AGENT_BUDGET_DEFAULT} (funds now $${agentFunds(cfg).toFixed(2)}); ${invests}.${costNote}`,
    `YOU decide, now. If this is a good entry right now, answer BUY_NOW with a buy_now order and the bot buys at once. Otherwise give the exact level you WILL buy at (buy_dip and/or buy_breakout), close enough to be reached in the next 10-30 minutes. Do not wait for a perfect textbook setup: judge the odds from everything below and act on them. You will be asked again within 10 minutes, or sooner if the price moves ${AGENT_MOVE_PCT}%.`,
    `Every order's target must be at least ${(AGENT_NET_TARGET + cost).toFixed(1)}% above its trigger price (that is +${AGENT_NET_TARGET}% after the ${cost.toFixed(1)}% round-trip costs); orders with a smaller target are not used. That level is the MINIMUM-PROFIT level: winChancePct is your chance of reaching it before the stop. target is where you realistically expect the move to go (at or above that level). Put the stop where the idea is proved wrong.`,
    `The bot adds no other limits: no daily loss limit, no cool-down, no minimum win chance, and dips may be bought in a falling market if you judge it right. How an order is judged: a win (reaching the minimum-profit level) counts as ${managedNote}; a loss counts as the distance to your stop plus costs. The order is used only if chance x win - (1 - chance) x loss is above zero, where the chance is the COMBINED one: your winChancePct, the forecast desk's numbers below, and three more AI forecasters who are asked about any order that would pass. Every forecast is scored against what really happened and each forecaster, you included, is corrected for its record, so an inflated chance only gets you discounted.`,
    `After buying: the stop is yours until the trade is up +${AGENT_NET_TARGET}% after costs. At that point the minimum profit is locked as the exit and you are asked again and again to manage the trade: hold for more (you set the exit and how closely it follows the price) or sell now. So the entry only has to get to +${AGENT_NET_TARGET}%; how far it runs after that is handled then. The stop is judged on where the price settles, not on one wick: the bot sells if the price is still at or below your stop about 10 seconds after it got there, or at once if it falls to 1.5 times your planned loss. At the stop you are asked once whether to hold.`,
  ];
  if (L) {
    lines.push(`A study of this coin's own history (simple entry patterns replayed with the same stop and minimum profit): ${L.summary}`);
    const rows = [...L.table.slice(0, 6), ...L.table.slice(6).filter((t) => t.key === "macross")]; // the crossover's rows are always shown
    if (rows.length) lines.push(...rows.map((t) => `- ${t.label} on ${t.tf}: ${t.trades} past trades, ${t.wins} reached +${AGENT_NET_TARGET}% before the stop${t.wins && t.runMedPct !== undefined ? ` (in the ${t.tf === "5m" ? "hour" : "3 hours"} after, their typical best was +${t.runMedPct.toFixed(1)}%, and ${t.ran10 ?? 0} of ${t.wins} got to +10%)` : ""}; average ${t.avgNetPct >= 0 ? "+" : ""}${t.avgNetPct.toFixed(1)}% if every winner were sold at exactly +${AGENT_NET_TARGET}%`));
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
export const PM_RULE_TRAIL = ruleTrailPct(EXIT_LIVE); // % behind the highest close the exit follows when the AI hasn't said otherwise (rules.ts)
const PM_MIN_GAP_MS = 30_000; // never ask the AI about one trade more often than this
const profitInbox = new Map<string, { at: number; d?: ProfitDecision; error?: string; atrPct?: number }>(); // position id -> the AI's answer, waiting to be applied
const profitAsking = new Set<string>();

// What the trend is doing, worked out by code for the AI that manages a winning trade: where the
// price is against its 21-candle average and whether the fast average is above the slow one on the
// 5-minute, 15-minute and 1-hour charts, the coin's usual swing (ATR%), and buyers against sellers
// by volume over the last 5 minutes and the last hour.
export function trendCheck(frames: Frame[], token: any, price: number): string {
  const lines: string[] = [];
  for (const [tf, name] of [["5m", "5-minute"], ["15m", "15-minute"], ["1h", "1-hour"]] as const) {
    const s = frames.find((f) => f.tf === tf)?.snap;
    if (!s) continue;
    const off = ((price - s.ema21) / s.ema21) * 100;
    lines.push(`- ${name} chart: price is ${Math.abs(off).toFixed(1)}% ${off >= 0 ? "above" : "BELOW"} its 21-candle average; fast average ${s.ema9 >= s.ema21 ? "above" : "BELOW"} slow (EMA 9 vs EMA 21); usual swing (ATR) ${s.atrPct.toFixed(1)}% a candle`);
  }
  const ratio = (st: any) => {
    const b = Number(st?.buyVolume) || 0, sl = Number(st?.sellVolume) || 0;
    return b + sl > 0 ? `${sl > 0 ? (b / sl).toFixed(2) : "all buys"}${sl > 0 ? "x" : ""} ($${Math.round(b / 1000)}K bought, $${Math.round(sl / 1000)}K sold)` : null;
  };
  const f5 = ratio(token?.stats5m), f1 = ratio(token?.stats1h);
  if (f5 || f1) lines.push(`- Buyers against sellers by volume (above 1 = more bought than sold): ${[f5 ? `last 5 minutes ${f5}` : "", f1 ? `last hour ${f1}` : ""].filter(Boolean).join("; ")}`);
  const a5 = frames.find((f) => f.tf === "5m")?.snap?.atrPct;
  if (a5) lines.push(`- If you cannot be asked, the bot's own exit follows ${ruleTrailPct(EXIT_LIVE, a5)}% behind the highest close (1.8 x the 5-minute swing, never under 2.5% or over 12%).`);
  return lines.length ? `Trend check (worked out by code):\n${lines.join("\n")}` : "";
}

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
  let atr5m: number | undefined; // read from the charts this check loads; applied even if the AI cannot be asked
  const work = (async () => {
    try {
      const pair = await getPair(chain, pool);
      const frames = await loadFrames(chain, pool, pair, ["5s", "1m", "5m", "15m", "1h"]);
      const pats = frames.filter((f) => f.tf !== "5s").map((f) => findPatterns(f.tf, f.candles));
      atr5m = frames.find((f) => f.tf === "5m")?.snap?.atrPct;
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
      const trend = trendCheck(frames, t, now);
      const d = await Promise.race([
        reviewProfit({ pair, frames, costPct: cost, entry, price: now, best: Math.max(best, now), lockedExit, minNetPct: AGENT_NET_TARGET, trailPct, heldMin: (Date.now() - openedAt) / 60_000, outlook, trend, flow: t ? flowText(t) : "", market, patterns: patternsText(pats), history, last }),
        new Promise<never>((_, no) => setTimeout(() => no(new Error("took too long")), 30_000)),
      ]);
      await chargeTokens([{ model: BOT_MODEL, ok: false, error: "", ms: 0, tokens: d.tokens }]);
      profitInbox.set(id, { at: Date.now(), d, ...(atr5m ? { atrPct: atr5m } : {}) });
    } catch (err: any) {
      profitInbox.set(id, { at: Date.now(), error: err?.message ?? String(err), ...(atr5m ? { atrPct: atr5m } : {}) });
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

// A sale, for the one-line log: the result in dollars and in % of the money that was put in (after costs).
function soldDecision(t: Trade, why: string): Decision {
  const pnl = Math.round((t.pnlUsd ?? 0) * 100) / 100, put = t.usd - (t.pnlUsd ?? 0);
  return { act: "exit", coin: t.symbol, pnl, price: t.price, ...(put > 0 ? { pct: Math.round(((t.pnlUsd ?? 0) / put) * 1000) / 10 } : {}), why: shortWhy(why, 220) };
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
// aheadBy = when the watch that runs this check ends, for the quality step (see aheadStep).
export async function tick(persist = true, aheadBy?: number) {
  const a = acct();
  const all = Promise.allSettled(runningIds().map((id) => withBot(id, () => tickBot(persist))));
  const steps = (a.steps ??= new Set());
  steps.add(all);
  void all.finally(() => steps.delete(all));
  // The quality step prices the next coin of the agents' list, if there is one to price. It is
  // never waited for here, and nothing that goes wrong in it may disturb the agents' checks.
  try { aheadStep(aheadBy); } catch (e) { console.error("[quality] working ahead:", e); }
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
      const raw = await quote(pos.chain, pos.pool, Math.max(pos.openedAt, windowStart));
      // An agent's trade is followed on one price series (sameFeed). backupFor = how long only the backup source has answered (null = the main feed answered).
      const feed = pos.strategy === "agents" ? sameFeed(pos, raw) : { q: raw, backupFor: null };
      const q = feed.q;
      const price = q.price;
      pos.lastPrice = price;
      recordEquity();
      if (checkDrawdown(cfg)) return;
      const gainPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      const cost = pos.costPct ?? roundTripCostPct(); // an agent's trade carries the cost estimated for it when it was bought
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
      if (ladder && (pos.pm || lockDue(bestGainPct - cost, EXIT_LIVE))) {
        const now = Date.now();
        const bestNet = bestGainPct - cost;
        const nowNet = gainPct - cost;
        if (!pos.pm) {
          // A trade whose exit was already raised above the minimum (by the earlier 1% profit steps) keeps it: an exit is never lowered.
          const atr = pos.atrPct ?? state.lastSignal?.atrPct;
          pos.pm = { floor: lockedFloor(pos.entryPrice, cost, pos.stopLoss, EXIT_LIVE), trailPct: ruleTrailPct(EXIT_LIVE, atr), by: "rule", asks: 0, fails: 0, step: 0, ...(atr ? { atrPct: atr } : {}) };
          pos.locked = true;
          acct().dirty = true;
          log(`${pos.symbol} is up +${bestNet.toFixed(1)}% after fees: the +${AGENT_NET_TARGET}% minimum is locked (exit ${fmt(pos.pm.floor)}). The AI now decides how long to hold.`, "good", { act: "lock", coin: pos.symbol, why: `up +${bestNet.toFixed(1)}% after fees: the +${AGENT_NET_TARGET}% minimum is locked, its AI manages the exit from here` });
        }
        const pm = pos.pm;
        // An answer from the AI that arrived since the last check.
        const got = profitInbox.get(pos.id);
        if (got) profitInbox.delete(pos.id);
        if (got?.atrPct) pm.atrPct = got.atrPct;
        // While no AI answer is in force, the exit's distance follows the coin's own swings.
        if (pm.by === "rule") {
          const t = ruleTrailPct(EXIT_LIVE, pm.atrPct);
          if (t !== pm.trailPct) { pm.trailPct = t; acct().dirty = true; }
        }
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
        const exit = exitInForce(pm.floor, best, pm.trailPct);
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
          if (due && !acct().closing && (await tokensLeft()) > 0) askProfit(pos, price, best, cost); // (not while its watch is closing: the exit in force stays in force until the next one)
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
        // An agent's stop-loss (rules.ts, stopCheck): judged on where the price is now, sold at that price.
        const c = stopCheck({ entry: pos.entryPrice, stop: pos.stopLoss, price, underSince: pos.underSince, now: Date.now() }, EXIT_LIVE);
        if (c.action === "sell") reason = "Stop-loss hit";
        else if (c.action === "arm") {
          pos.underSince = Date.now();
          acct().dirty = true;
          log(`${pos.symbol} is at its stop-loss ${fmt(pos.stopLoss)} (now ${fmt(price)}). It sells if the price is still there in about 10 seconds; one dip that bounces straight back doesn't end the trade.`);
        } else if (c.action === "clear") {
          delete pos.underSince;
          acct().dirty = true;
          log(`${pos.symbol} bounced back above its stop-loss (now ${fmt(price)}): the trade stays open.`, "good");
        }
        if (reason) sellAt = price;
        // The order's time limit: only if the exit design has it on (see EXIT_LIVE.timeLimit in rules.ts).
        else if (EXIT_LIVE.timeLimit && pos.sellBy && Date.now() > pos.sellBy) reason = "Maximum holding time reached";
      } else if (ladder && pos.pm && pos.stopLoss) {
        // An agent's profit exit (rules.ts, exitCheck): like its stop-loss, judged on where the
        // price settles. First seen at or under the exit it is noted; it sells if the price is
        // still there about 10 seconds later, and at once if the price is back at the buy price.
        // On readings from the backup price source it waits for the main feed, unless the backup
        // has been the only source for half a minute (sameFeed).
        const now = Date.now();
        const under = exitHit({ entry: pos.entryPrice, stop: pos.stopLoss, price, low: q.low, closeLow: q.closeLow, newBest: newBestThisCheck });
        const trusted = feed.backupFor === null || feed.backupFor >= BACKUP_EXIT_MS;
        const c: StopAction = trusted ? exitCheck({ entry: pos.entryPrice, exit: pos.stopLoss, price, under, since: pos.exitSince, now }, EXIT_LIVE) : price <= pos.entryPrice ? "sell" : "none";
        if (c === "sell") {
          const at = Math.min(pos.stopLoss, price);
          reason = at <= pos.entryPrice
            ? `Exit: the price fell all the way back to the buy price (best was +${(bestGainPct - cost).toFixed(1)}% after fees)`
            : `Profit exit: sold at about +${(((at - pos.entryPrice) / pos.entryPrice) * 100 - cost).toFixed(1)}% after fees (best was +${(bestGainPct - cost).toFixed(1)}%)${pos.pm.by === "ai" ? ", at the exit the AI set" : ""}`;
          sellAt = at;
        } else if (c === "arm") {
          pos.exitSince = now;
          acct().dirty = true;
          log(`${pos.symbol} is at its exit ${fmt(pos.stopLoss)} (now ${fmt(price)}). It sells if the price is still there in about 10 seconds; a dip that bounces straight back doesn't end the trade.`);
        } else if (c === "clear") {
          delete pos.exitSince;
          acct().dirty = true;
          log(`${pos.symbol} bounced back above its exit (now ${fmt(price)}): the trade stays open.`, "good");
        } else if (!trusted && under) {
          noteOnce(`backup:${pos.id}:${Math.floor(now / 120_000)}`, `${pos.symbol}: the 5-second price feed gave no answer for this check, and the backup price reads under the exit ${fmt(pos.stopLoss)}. A winning trade is not sold on the backup price alone: the bot waits for the main feed, for half a minute at most.`);
        }
      } else if (pos.stopLoss && exitHit({ entry: pos.entryPrice, stop: pos.stopLoss, price, low: q.low, closeLow: q.closeLow, newBest: newBestThisCheck })) {
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
        if (pos.strategy === "agents") scoreTrade(pos, t.reachedTarget);
        const cs = (state.bot.coinStats[pos.pool] ??= { losses: 0, lastLossAt: 0, lossDay: utcDay() });
        if (t.pnlUsd! < 0) {
          cs.losses = cs.lossDay === utcDay() ? cs.losses + 1 : 1;
          cs.lastLossAt = Date.now();
          cs.lossDay = utcDay();
        } else cs.losses = 0;
        log(`SELL ${pos.symbol} @ ${fmt(t.price)}: ${reason}. P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}`, t.pnlUsd! >= 0 ? "good" : "bad", soldDecision(t, reason));
        alert(`${t.pnlUsd! >= 0 ? "✅" : "🔻"} Sold ${pos.symbol} @ ${fmt(t.price)}: ${reason}. P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}. Account $${equity().toFixed(2)}.`);
        // Ask for a fresh plan right away; no new trade until it arrives.
        state.lastSignal = null;
        state.bot.freshAfter = Date.now();
        state.bot.armedSince = [];
        state.bot.askNow = true;
        if (isAuto(cfg)) state.bot.target = null;
        // An auto-pick agent chooses its coin again after every trade. A coin it just lost on is
        // left alone for half an hour (by all of the account's auto-pick agents).
        if (isAutoAgent(cfg)) {
          const au = (state.bot.auto ??= { note: "", at: Date.now() });
          au.again = true;
          delete au.idleSince;
          if (t.pnlUsd! < 0 && cfg.mint) (state.bot.autoSkip ??= {})[cfg.mint] = Date.now() + AUTO_SKIP_LOSS_MS;
        }
        // One trade at a time (the default): stop after a profitable round trip.
        const total = t.pnlUsd! + (pos.realizedUsd ?? 0);
        if (total > 0 && !state.settings.continuous && !isCoinAgent(cfg) && !isAgents(cfg)) {
          stopBot(`Done: one profitable trade (+$${total.toFixed(2)}). Start it again for another, or turn on "Trade continuously" in Settings.`);
          alert(`⏹ Bot stopped after a profitable trade (+$${total.toFixed(2)}). Account $${equity().toFixed(2)}.`);
        }
      }
      return;
    }

    // The watch that runs this check is over and only waiting for something still on its way
    // (see watch()). Open trades were seen to above; an agent without one starts nothing now (no
    // coin search, no AI look): the next watch does, a few seconds from now.
    if (acct().closing) return;

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
    // An auto-pick agent first sees to its coin: it takes one if it has none, and moves on after
    // a trade or when its coin has given it nothing to do for a while.
    if (isAutoAgent(cfg)) {
      if (agentSpent(cfg)) return;
      if (await autoStep(cfg)) return;
      if (!cfg.pool) return; // (the account was loaded again while it was choosing: next check)
    }
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
      // Agents: a free check before the paid one. If the scouts rule the coin out, the AI is not
      // asked (no AI tokens spent) and the agent looks again in 5 minutes.
      if (isCoinAgent(cfg)) {
        const gate = await coinGate(cfg).catch(() => null);
        if (gate && gate.quality !== state.bot.quality) {
          state.bot.quality = gate.quality;
          acct().dirty = true;
        }
        if (gate && !gate.ok) {
          standAside(cfg, { kind: "scouts", reasons: gate.reasons, quality: gate.quality, min: gate.min }, `The scouts ruled ${cfg.symbol} out, so the AI was not asked (no AI tokens spent): ${gate.reasons.join("; ")}.`);
          return;
        }
      }
      // An auto-pick agent does not ask its AI about a coin that is too expensive for its money (as
      // last measured for it): its next check moves it on, or lets the coin go (autoStep).
      if (isAutoAgent(cfg)) {
        const own = ownCost(cfg), limit = costLimit(cfg);
        if (own && limit > 0 && own.pct > limit) {
          if (hasLiveOrder(cfg)) log(`Its order on ${cfg.symbol} is dropped: buying and selling its ${usd0(own.funds)} there costs about ${pct1(own.pct)}, more than the ${own.max}% it accepts. It looks for another coin.`, "info", { act: "filtered", coin: cfg.symbol, by: "cost", why: `its order is dropped: trading its ${usd0(own.funds)} there costs ${pct1(own.pct)}, it accepts ${own.max}%` });
          if (state.lastSignal) { state.lastSignal = null; acct().dirty = true; }
          return;
        }
      }
      log(`Asking the AI for a new plan (${why})...`);
      save();
      await flush();
      if (isAuto(cfg)) {
        await autoPick(cfg);
      } else {
        // An agent's plan is judged with what its own trade would really cost in this pool (costs.ts).
        const ac = isCoinAgent(cfg) ? await getPair(cfg.chain, cfg.pool).then((p) => agentCost(cfg, p)).catch(() => undefined) : undefined;
        // The same with the cost measured just now: this is where a coin it took while Jupiter
        // could not be asked is priced, and where a coin whose cost has since risen is caught. Its
        // plan, if it had one, is dropped; the checks that follow return above, without a word.
        if (ac && isAutoAgent(cfg) && ac.source === "jupiter") {
          rememberCost(cfg.mint, state.bot.costCurve);
          const limit = costLimit(cfg);
          if (limit > 0 && ac.fullPct > limit) {
            log(`The AI was not asked after all (no AI tokens spent): buying and selling its ${usd0(ac.funds)} on ${cfg.symbol} costs about ${pct1(ac.fullPct)} now, more than the ${autoCostMax(cfg)}% it accepts. It looks for another coin.`, "info", { act: "filtered", coin: cfg.symbol, by: "cost", why: `the cost: trading its ${usd0(ac.funds)} there costs ${pct1(ac.fullPct)} now, it accepts ${autoCostMax(cfg)}%` });
            state.lastSignal = null;
            acct().dirty = true;
            return;
          }
        }
        const { consensus, results } = await runAnalysis(cfg.chain, cfg.pool, cfg.tf, { forBot: true, ...(isCoinAgent(cfg) ? { agentBrief: await agentBrief(cfg, why, ac), ...(ac ? { cost: ac } : {}) } : {}) });
        for (const f of results) if (!f.ok) log(`The AI failed: ${f.error}`, "bad");
        // (once an hour for each coin: an auto-pick agent may be on several quiet coins in an hour)
        if (state.lastSignal?.gate) noteOnce(`gate:numbers:${cfg.pool}:${Math.floor(Date.now() / 3_600_000)}`, `${cfg.symbol}: ${consensus.note} It looks again every 5 minutes, or at once on a real move.`, "bad", { act: "filtered", coin: cfg.symbol, by: "numbers", why: shortWhy(`the numbers: ${state.lastSignal.gate.reasons.join("; ").replace(/^the numbers give /, "")}`) });
        else log(`Plan: ${consensus.stance.replace(/_/g, " ")} (${consensus.confidence}% sure). ${consensus.note}`, "info", planDecision(cfg, consensus, results));
        if (isCoinAgent(cfg) && !state.lastSignal?.gate) {
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
      const chasePct = agentBreakout ? chaseLimitPct(o.triggerPrice, o.stopLoss) : Infinity;
      if (agentBreakout && (q.price / o.triggerPrice - 1) * 100 > chasePct) {
        noteOnce(`chase:${sig.at}:${i}`, `${t3.symbol} ran ${((q.price / o.triggerPrice - 1) * 100).toFixed(1)}% past the breakout level ${fmt(o.triggerPrice)} before it could be bought. Buying up there would put the stop too far away, so the agent doesn't chase it: its AI looks again now.`);
        state.bot.armedSince[i] = null;
        state.bot.askNow = true;
        acct().dirty = true;
        continue;
      }
      // Otherwise: buy the instant the trigger is hit (optionally waiting for it to hold).
      const holdSec = agentBreakout ? breakoutHoldSec(o.confirmSeconds) : cfg.waitForHold ? o.confirmSeconds : 0;
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
      // An agent invests its funds, or less when that keeps the round trip under its cost cap (see agentCost).
      // Read from the last measurement without asking again: a buy must not wait on a quote.
      const ac = isCoinAgent(cfg) ? costFor(knownCurve(curveMint(cfg, pair), pair.liquidityUsd, state.bot.costCurve), cfg) : null;
      const riskPct = isOff(cfg, "riskPerTradePct") ? 0 : (cfg.riskPerTradePct ?? 1.5);
      const exitLossPct = ((o.triggerPrice - o.stopLoss) / o.triggerPrice) * 100 + (ac?.pct ?? roundTripCostPct());
      const bySize = riskPct > 0 ? (equity() * riskPct) / 100 / (exitLossPct / 100) : Infinity;
      const sizePct = cfg.allowRisky ? Math.min(cfg.positionPct, RISKY_MAX_POSITION_PCT) : cfg.positionPct; // risky trades stay small
      const cap = Math.min(state.cash, equity() * (sizePct / 100));
      const usd = ac ? ac.usd : Math.floor(Math.min(cap, bySize) * 100) / 100;
      if (usd < 1) return log("Not enough cash to open a position.", "bad");
      const riskUsd = usd * (exitLossPct / 100);
      // The forecast that becomes this trade is no longer an order the agent "did not buy": it leaves
      // the waiting list here, and the trade's real result is scored when it closes (scoreTrade).
      if (isCoinAgent(cfg) && o.prediction && state.fc) {
        const mine = state.fc.pending.filter((r) => r.pool === pair.pool && r.passed).sort((a, b) => b.at - a.at)[0];
        if (mine) state.fc.pending = state.fc.pending.filter((r) => r !== mine);
      }
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
        ...(ac ? { costPct: ac.pct } : {}),
        ...(isCoinAgent(cfg) && typeof state.bot.quality === "number" ? { quality: state.bot.quality } : {}),
        ...(isCoinAgent(cfg) && sig.atrPct ? { atrPct: sig.atrPct } : {}),
      }, 0, ac ? { feePct: ac.pct / 2, slipPct: 0 } : undefined);
      if (sig.patterns) t.patterns = patternTags(sig.patterns);
      if (isCoinAgent(cfg)) t.strategy = "agents";
      log(`BUY ${pair.symbol} $${usd.toFixed(2)} @ ${fmt(t.price)} (${label}). Exit below ${fmt(o.stopLoss)} (risking about $${riskUsd.toFixed(2)}, ${((riskUsd / equity()) * 100).toFixed(1)}% of the account); at ${fmt(o.target)} it starts trailing.${ac ? ` A round trip of this size in this pool costs about ${ac.pct.toFixed(1)}%${ac.usd < ac.funds - 0.5 ? `: it invests $${ac.usd.toFixed(0)} of its $${ac.funds.toFixed(0)}, because all of it would cost ${ac.fullPct.toFixed(1)}%` : ""}.` : ""}`, "good", {
        act: "enter", coin: pair.symbol, usd, ...(ac ? { of: ac.funds, costPct: Math.round(ac.pct * 100) / 100 } : {}), price: t.price,
        ...(o.prediction ? { winPct: Math.round(o.prediction.pWin), needPct: Math.ceil(o.prediction.needPct) } : { winPct: o.winChancePct }),
        why: shortWhy(`${(() => { const r = sig.results.find((x) => x.ok); return r && r.ok && r.signal.reasoning ? `${shortWhy(r.signal.reasoning, 130)} \u00b7 ` : ""; })()}${label}${o.prediction ? ` \u00b7 ${Math.round(o.prediction.pWin)}% chance, needs ${Math.ceil(o.prediction.needPct)}%` : ""}${ac ? ` \u00b7 costs ${ac.pct.toFixed(1)}% to trade` : ""}`, 260),
      });
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
  if (state.bot.askNow || state.bot.auto?.again) return true;
  const sig = state.lastSignal;
  const tgtPool = isAuto(cfg) ? state.bot.target?.pool : cfg.pool;
  // Only orders with at least the user's minimum win chance count.
  return Boolean(tgtPool && sig && sig.pool === tgtPool && sig.consensus.orders.some((o) => o.winChancePct >= minWin(cfg)) && Date.now() < sig.consensus.expiresAt);
}

// Serverless: run bot steps every 5 seconds for up to maxMs (one scheduler call or
// dashboard ping keeps watch for a while). A lock stops two windows overlapping.
// Stops early when there's nothing to watch.
//
// One watch hands over to the next (v0.72.0). The scheduler calls once a minute, and a watch must
// finish what is in flight before it lets go of the lock (another server copy may run the next
// one, and two copies saving the same account would overwrite each other). It used to work like
// this: the watch slept 5 s after its last round before it noticed its time was up, then stood
// still until an AI answer or a slow price check had landed; the next call, finding the lock
// held, gave up at once, and that whole minute went unwatched. With four agents or more a round
// of price checks takes long enough for that to happen every second minute
// (test/engine/watch-gap.mts measures it). Now:
//  - the scheduler's call waits for the watch before it instead of giving up (WATCH_LOCK_WAIT_MS),
//    and its own watch still ends maxMs after the call arrived, so nothing drifts;
//  - a watch stops when there is no time left for another round (no sleep past its end);
//  - a watch whose time is up while something is still on its way keeps checking the open
//    trades every 5 seconds until that has landed (at most until shortly before its lock runs
//    out), and starts nothing new meanwhile (acct().closing: no AI look, no coin search, no new
//    profit question; see tickBot).
// The app's own nudges (by = "dashboard") do not wait and do not go on past their end.
export const WATCH_MS = 58_000; // how long the scheduler's call watches (it comes every 60 s)
const WATCH_LOCK_WAIT_MS = 32_000; // the scheduler's call waits this long for the watch before it (longer than that one's lock can last past the minute)
const WATCH_LOCK_POLL_MS = 1_000;
const WATCH_OVER_MS = 30_000; // the lock outlasts the watch's end by this much: time for what is in flight to land
const WATCH_LOCK_MARGIN_MS = 4_000; // it starts no round this close to the end of its lock
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
export async function watch(maxMs: number, by: "scheduler" | "dashboard" = "dashboard") {
  const botOn = () => anyBotRunning();
  if (!botOn() && !hasProtected()) return { ticks: 0, reason: "bot is off" };
  const a = acct();
  const lockName = `watch:${a.key ?? "-"}`;
  const arrived = Date.now();
  const end = arrived + maxMs; // (counted from the call's arrival, however long it waits for the lock)
  const patient = by === "scheduler";
  let lockedUntil = 0;
  const lock = async () => {
    const at = Date.now(), ttl = Math.max(1_000, end - at) + (patient ? WATCH_OVER_MS : 10_000);
    if (!(await store.lock(lockName, ttl))) return false;
    lockedUntil = at + ttl;
    return true;
  };
  let got = await lock();
  if (!got && patient) {
    // The watch before this one is still finishing. It will let go within seconds: wait for it.
    const giveUp = Math.min(arrived + WATCH_LOCK_WAIT_MS, end - 10_000); // (never wait the whole watch away)
    while (!got && Date.now() < giveUp) {
      await nap(WATCH_LOCK_POLL_MS);
      got = await lock();
    }
  }
  if (!got) return { ticks: 0, reason: "another window is already watching" };
  const waitedMs = Date.now() - arrived;
  // Record the wake-up (one small write per window) so the dashboard can show the bot is alive.
  state.bot.lastWatch = { at: Date.now(), by };
  save(); // also makes sure this account is on the scheduler's list
  let ticks = 0, closing = false;
  // One round: every agent's check, protected trades and limit orders, and the save. false = nothing is running any more.
  const round = async (aheadBy: number) => {
    // Reload first, so a Stop or manual trade from the dashboard is never overwritten.
    await sync();
    if (!botOn() && !hasProtected()) return false;
    if (botOn()) await tick(false, aheadBy); // saves only if something happened
    await guardProtected();
    ticks++;
    await flush();
    return true;
  };
  try {
    for (;;) {
      if (!(await round(end))) break;
      if (!watching()) break; // nothing to watch closely; the next scheduled check will come
      if (end - Date.now() < CHECK_MS) break; // no time for another round
      await nap(CHECK_MS);
    }
    // Its time is up. What is still on its way now (an AI answer, a slow price check) has to
    // land before the lock is let go; until it has, the open trades are still checked.
    const waiting = patient && watching() ? [...(a.steps ?? []), ...(a.reviews ?? [])] : [];
    if (waiting.length) {
      closing = true;
      a.closing = (a.closing ?? 0) + 1;
      let landed = false;
      const all = Promise.allSettled(waiting).then(() => { landed = true; });
      const stopBy = lockedUntil - WATCH_LOCK_MARGIN_MS;
      while (!landed && Date.now() + CHECK_MS < stopBy) {
        await Promise.race([all, nap(CHECK_MS)]);
        if (landed || !(await round(0))) break;
      }
    }
    return { ticks, reason: botOn() || hasProtected() ? (watching() ? "window ended" : "nothing to watch") : "bot stopped", ...(waitedMs >= WATCH_LOCK_POLL_MS ? { waitedMs } : {}) };
  } finally {
    // Finish what is in flight, and apply an AI profit answer that arrived as the window closed.
    // (From here on nothing new is started: the next watch does that.)
    if (!closing) a.closing = (a.closing ?? 0) + 1;
    try {
      for (let i = 0; i < 2; i++) {
        await settleSteps();
        await settleReviews();
        if (!state.positions.some((p) => profitInbox.has(p.id))) break;
        await tick(false, 0); // (the window is over: the quality step starts nothing now)
      }
      await settleSteps();
      await flush();
    } finally {
      a.closing = Math.max(0, (a.closing ?? 1) - 1);
      // (A lock that has run out may be another watch's by now: that one is not ours to let go.)
      if (Date.now() < lockedUntil - 500) await store.unlock(lockName);
    }
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
        log(`PROTECTED SELL ${p.symbol} @ ${fmt(t.price)}: fell ${p.protectPct}% from its high of ${fmt(p.peak!)} (${gain >= 0 ? "+" : ""}${gain.toFixed(1)}% from your buy). P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}`, t.pnlUsd! >= 0 ? "good" : "bad", soldDecision(t, `your protection: fell ${p.protectPct}% from its high`));
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
        log(`LIMIT BUY ${o.symbol} $${usd.toFixed(2)} @ ${fmt(t.price)} (your limit ${fmt(o.price)}).`, "good", { act: "enter", coin: o.symbol, usd, why: `your limit order at ${fmt(o.price)}` });
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
          log(`LIMIT SELL ${o.symbol} ${Math.round((o.fraction ?? 1) * 100)}% @ ${fmt(t.price)} (your limit ${fmt(o.price)}). P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}`, t.pnlUsd! >= 0 ? "good" : "bad", soldDecision(t, `your limit order at ${fmt(o.price)}${(o.fraction ?? 1) < 0.999 ? ` (${Math.round((o.fraction ?? 1) * 100)}% of the position)` : ""}`));
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
