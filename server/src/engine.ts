// Paper-trading broker + automated bot.
// Every trade here is simulated with realistic fees and slippage so you can
// see how the strategy would perform before risking real money.
import { analyze, type CheckedOrder, type Consensus, type Frame, type ModelResult } from "./ai.js";
import { getCandles, getPair, getRecentTokenCandles, knownToken, type PairInfo, type Timeframe } from "./data.js";
import { snapshot } from "./indicators.js";
import { scanOpportunities } from "./scan.js";
import { createStore } from "./store.js";
import { alertChannel, sendAlert } from "./alerts.js";

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
};

export type Trade = {
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
  goalUsd: number;
  // "this" = trade the coin above; "auto" = pick the best coin from Opportunities each round.
  pick?: "this" | "auto";
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
  // Risk-based sizing: size each trade so hitting its exit loses about this % of the account
  // (default 1.5). positionPct is then only the maximum share of cash per trade.
  riskPerTradePct?: number;
};

export type Settings = { feePct: number; slippagePct: number };

type State = {
  mode: "paper";
  startCash: number;
  cash: number;
  peakEquity: number;
  positions: Position[];
  trades: Trade[];
  equity: { t: number; v: number }[];
  settings: Settings;
  bot: {
    running: boolean;
    config: BotConfig | null;
    lastAnalysisAt: number;
    lastTickAt: number;
    // When each standing order's trigger was first met (for confirmSeconds); null = not met.
    armedSince: (number | null)[];
    // Set after a trade closes, so Claude is asked for a new plan right away.
    askNow: boolean;
    // Orders whose trigger was reached but that were skipped (logged once per plan).
    skipNoted: boolean[];
    startedAt: number | null; // when the bot was last started (unix ms)
    stoppedAt: number | null; // when it was last stopped (null while running)
    // Per-coin losing streaks (for the cool-down) and today's starting equity (for the daily limit).
    coinStats: Record<string, { losses: number; lastLossAt: number; lossDay: string }>;
    day: { date: string; startEquity: number } | null;
    blocked: string | null; // why the bot isn't trading right now (shown in the panel)
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
    bot: { running: false, config: null, lastAnalysisAt: 0, lastTickAt: 0, armedSince: [], askNow: false, skipNoted: [], startedAt: null, stoppedAt: null, coinStats: {}, day: null, blocked: null, noted: {}, target: null, candidates: [], log: [] },
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
  // Bots started before start/stop times were saved: recover them from the log.
  // (The defaults above already filled these with null, so check for null, not undefined.)
  s.bot.startedAt ??= s.bot.log.find((l) => l.msg.startsWith("Bot started"))?.t ?? null;
  if (s.bot.running) s.bot.stoppedAt = null;
  else s.bot.stoppedAt ??= s.bot.log.find((l) => l.msg.startsWith("Bot stopped"))?.t ?? null;
  s.bot.noted ??= {};
  s.bot.blocked ??= null;
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

let state: State = fresh();
let loaded = false;

// Load the latest saved state. With Redis this runs on every request, because
// on Vercel each request may land on a different short-lived server.
export async function sync() {
  if (loaded && store.kind !== "redis") return;
  // Never swap the state out from under a running bot step. One server handles
  // several requests at once (e.g. dashboard refreshes while the bot waits for
  // Claude); replacing the object mid-step lost the step's updates, so the bot
  // forgot it had just asked Claude and asked again every 20 s.
  if (busy) return;
  const saved = await store.load<State>();
  if (busy) return; // a step started while we were loading: keep its state
  if (saved) state = migrate(saved);
  loaded = true;
}

let pending: Promise<void> = Promise.resolve();
let dirty = false; // something worth saving happened (a trade, a log line, a moved stop)
function save() {
  dirty = false;
  const copy = structuredClone(state);
  pending = pending.then(() => store.save(copy)).catch((e) => console.error("[store] save failed:", e));
}
// Wait for writes to finish (must happen before a Vercel function returns).
export async function flush() {
  await pending;
}

// Phone alert (Telegram / ntfy, if configured). Queued with saves so flush() waits for it.
function alert(text: string) {
  if (!alertChannel()) return;
  pending = pending.then(() => sendAlert(text)).catch(() => {});
}

// Saved state stays small and constant-size: newest trades, log lines and equity points only.
const MAX_TRADES = 1000;
const uid = () => Math.random().toString(36).slice(2, 10);
export const roundTripCostPct = () => 2 * (state.settings.feePct + state.settings.slippagePct);

function log(msg: string, level: "info" | "good" | "bad" = "info") {
  dirty = true;
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

export function getState() {
  return { ...state, equityNow: equity(), roundTripCostPct: roundTripCostPct(), storage: store.kind };
}

// ---------- Broker ----------

export function buy(pair: PairInfo, usd: number, source: "manual" | "bot", reason: string, plan?: Partial<Position>) {
  if (!(usd > 0)) throw new Error("Amount must be positive");
  if (usd > state.cash + 1e-9) throw new Error(`Not enough cash ($${state.cash.toFixed(2)} available)`);
  if (!(pair.priceUsd > 0)) throw new Error("No live price for this token");
  const { feePct, slippagePct } = state.settings;
  const feeUsd = usd * (feePct / 100);
  const fillPrice = pair.priceUsd * (1 + slippagePct / 100);
  const qty = (usd - feeUsd) / fillPrice;
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
  const t: Trade = { id: uid(), time: Date.now(), side: "BUY", symbol: pair.symbol, pool: pair.pool, price: fillPrice, qty, usd, feeUsd, reason, source };
  state.trades.unshift(t);
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
  const fillPrice = price * (1 - slippagePct / 100);
  const gross = qty * fillPrice;
  const feeUsd = gross * (feePct / 100);
  const net = gross - feeUsd;
  const costPart = p.costUsd * f;
  state.cash += net;
  p.qty -= qty;
  p.costUsd -= costPart;
  if (f >= 0.999 || p.qty * price < 0.01) state.positions = state.positions.filter((x) => x.id !== p.id);
  const t: Trade = { id: uid(), time: Date.now(), side: "SELL", symbol: p.symbol, pool: p.pool, price: fillPrice, qty, usd: net, feeUsd, pnlUsd: net - costPart, reason, source: p.source };
  state.trades.unshift(t);
  if (state.trades.length > MAX_TRADES) state.trades.length = MAX_TRADES;
  recordEquity();
  save();
  return t;
}

export function updateSettings(s: Partial<Settings>) {
  state.settings = { ...state.settings, ...s };
  save();
}

export function reset(startCash: number) {
  state = fresh(startCash);
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

export async function runAnalysis(chain: string, pool: string, tf: Timeframe) {
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
  const recent = state.trades.filter((t) => t.pool === pool && t.source === "bot" && t.side === "SELL").slice(0, 5);
  const context = [
    recent.length
      ? `Recent bot trades on this coin (newest first): ${recent.map((t) => `${new Date(t.time).toISOString().slice(11, 16)} UTC ${(t.pnlUsd ?? 0) >= 0 ? "+" : ""}$${(t.pnlUsd ?? 0).toFixed(2)} (${t.reason})`).join("; ")}.`
      : "No recent bot trades on this coin.",
    "Bot rules: it will NOT fill dip or buy-now orders while the 1-hour trend is down or the coin fell more than ~10% in the last hour (a crash is not a dip); breakout orders are still allowed. After a losing trade it waits before re-buying the coin, and skips the coin for the day after 2 losses in a row.",
  ].join("\n");
  const { results, consensus } = await analyze(pair, frames, roundTripCostPct(), context);
  // Downtrend on the 1-hour chart: fast average below slow average and price below the slow one.
  const h1 = frames.find((f) => f.tf === "1h")?.snap;
  const trendDown = h1 ? h1.ema9 < h1.ema21 && h1.price < h1.ema21 : false;
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

let timer: NodeJS.Timeout | null = null;
let busy = false;

const isAuto = (cfg: BotConfig) => cfg.pick === "auto";

export function startBot(cfg: BotConfig) {
  if (isAuto(cfg)) {
    cfg.autoChain ??= "all";
    cfg.autoCandidates = Math.min(5, Math.max(1, cfg.autoCandidates ?? 3));
    cfg.autoMinLiquidityUsd ??= 50_000;
  }
  state.bot.config = cfg;
  state.bot.running = true;
  state.bot.lastAnalysisAt = 0;
  state.bot.lastTickAt = 0;
  state.bot.target = null;
  state.bot.candidates = [];
  state.bot.armedSince = [];
  state.bot.askNow = false;
  state.bot.startedAt = Date.now();
  state.bot.stoppedAt = null;
  cfg.trailPct = clampNum(cfg.trailPct ?? 3, 0.5, 30);
  log(
    isAuto(cfg)
      ? `Bot started in AUTO-PICK mode (${cfg.autoChain === "all" ? "all chains" : cfg.autoChain}). Each round Claude checks the top ${cfg.autoCandidates} coins. Cash $${state.cash.toFixed(2)}.`
      : `Bot started on ${cfg.symbol} (${cfg.tf}). Paper mode. Cash $${state.cash.toFixed(2)}.`,
    "good",
  );
  save();
  schedule();
}

export function stopBot(reason = "Stopped by user") {
  state.bot.running = false;
  state.bot.stoppedAt = Date.now();
  state.bot.target = null;
  log(`Bot stopped: ${reason}`, "bad");
  if (timer) clearInterval(timer);
  timer = null;
  save();
}

function schedule() {
  if (timer) clearInterval(timer);
  const cfg = state.bot.config;
  if (!state.bot.running || !cfg) return;
  if (process.env.VERCEL) return; // driven by heartbeat / tick requests instead
  // Every 5 s; tick(false) saves only when something happens (not on every check).
  timer = setInterval(() => void tick(false), CHECK_MS);
  void tick();
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
  if (state.bot.blocked !== reason) dirty = true;
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
  const lostPct = ((state.bot.day.startEquity - equity()) / state.bot.day.startEquity) * 100;
  return lostPct >= limit ? `daily loss limit reached (down ${lostPct.toFixed(1)}% today, limit ${limit}%); resumes at 00:00 UTC` : null;
}

// Cool-down: after a loss, wait before re-buying the coin; after 2 losses in a row, skip it for the day.
function coinBlock(cfg: BotConfig, pool: string, symbol: string): string | null {
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
  log(`Asking Claude for plans on ${inZone.map((r) => r.pair.symbol).join(", ")}...`);
  let best: { pair: PairInfo; result: Awaited<ReturnType<typeof runAnalysis>> } | null = null;
  const usableOrders = (c: Consensus) => c.orders.filter((o) => o.winChancePct >= cfg.minConfidence);
  const rank = (c: Consensus) => (c.stance === "BUY_NOW" ? 1000 : 0) + Math.max(...usableOrders(c).map((o) => o.evPct));
  for (const row of inZone) {
    // One at a time, so CoinMarketCap's small allowance isn't used up in a burst.
    try {
      const r = await runAnalysis(row.pair.chain, row.pair.pool, cfg.tf);
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
    log(`Claude: ${summary}. No usable plan yet.`);
    return;
  }
  const { pair, result } = best;
  state.bot.target = { chain: pair.chain, pool: pair.pool, symbol: pair.symbol, chosenAt: Date.now() };
  state.lastSignal = { at: Date.now(), pool: pair.pool, symbol: pair.symbol, tf: cfg.tf, results: result.results, consensus: result.consensus };
  log(`Auto-pick chose ${pair.symbol}. Claude: ${summary}. ${result.consensus.note}`, "good");
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
type Quote = { pair: PairInfo; price: number; low: number; high: number; source: string };

async function quote(chain: string, pool: string, sinceMs: number): Promise<Quote> {
  // Fetch the live price and the 5-second candles at the same time (token is known
  // after the first lookup), so a check takes one network round-trip, not two.
  const token = knownToken(pool);
  const candlesP = token ? getRecentTokenCandles(chain, token).catch(() => null) : null;
  const pair = await getPair(chain, pool);
  let price = pair.priceUsd, low = price, high = price, source = "DexScreener";
  try {
    if (pair.tokenAddress) {
      const candles = (candlesP && pair.tokenAddress === token ? await candlesP : null) ?? (await getRecentTokenCandles(chain, pair.tokenAddress));
      const last = candles.at(-1);
      const nowS = Date.now() / 1000;
      // Use CoinMarketCap only if it's current and agrees with this pool's price.
      if (last && nowS - last.time < 30 && price > 0 && Math.abs(last.close - price) / price < 0.1) {
        const recent = candles.filter((c) => c.time + 5 > sinceMs / 1000); // candles overlapping the window
        price = last.close;
        low = Math.min(price, ...recent.map((c) => c.low));
        high = Math.max(price, ...recent.map((c) => c.high));
        source = "CoinMarketCap 5s candles";
      }
    }
  } catch {
    // fall back to the DexScreener snapshot
  }
  return { pair: { ...pair, priceUsd: price }, price, low, high, source };
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

export async function tick(persist = true) {
  const cfg = state.bot.config;
  if (!state.bot.running || !cfg || busy) return;
  busy = true;
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
      // Lock in a no-loss exit once the trade is far enough in profit.
      if (gainPct >= Math.max(cfg.breakEvenAtPct, cost * 1.5)) {
        const be = pos.entryPrice * (1 + cost / 100);
        if (!pos.stopLoss || pos.stopLoss < be) {
          pos.stopLoss = be;
          log(`${pos.symbol} up ${gainPct.toFixed(1)}%: stop moved to break-even after fees (${fmt(be)}).`, "good");
        }
      }
      // At the target, don't sell yet: ride it with a trailing stop.
      const trail = pos.trailPct ?? cfg.trailPct ?? 3;
      let newHighThisCheck = false;
      if (!pos.trailing && pos.target && q.high >= pos.target) {
        pos.trailing = true;
        pos.peak = q.high;
        newHighThisCheck = true;
        log(`${pos.symbol} hit its target ${fmt(pos.target)}: now riding it, selling if it falls ${trail}% from its high.`, "good");
      }
      if (pos.trailing && q.high > (pos.peak ?? 0)) {
        pos.peak = q.high;
        newHighThisCheck = true;
        dirty = true; // the high matters for the trailing stop; keep it saved
      }
      const trailStop = pos.trailing && pos.peak ? pos.peak * (1 - trail / 100) : 0;
      // Stops sell like real stop orders: at the stop price if the price touched it,
      // or at the current price if it has already fallen further.
      let reason = "";
      let sellAt = price;
      // If the high was set in this same check we can't tell whether the low came
      // before or after it, so judge the trailing stop on the latest price instead.
      const trailLow = newHighThisCheck ? price : q.low;
      if (pos.trailing && trailLow <= trailStop) {
        reason = `Trailing stop: fell ${trail}% from its high of ${fmt(pos.peak!)}`;
        sellAt = Math.min(trailStop, price);
      } else if (pos.stopLoss && q.low <= pos.stopLoss) {
        reason = pos.stopLoss >= pos.entryPrice ? "Break-even stop hit" : "Stop-loss hit";
        sellAt = Math.min(pos.stopLoss, price);
      } else if (pos.sellBy && Date.now() > pos.sellBy) reason = "Maximum holding time reached";
      else if (!pos.target && pos.takeProfit && q.high >= pos.takeProfit) {
        reason = "Take-profit hit"; // positions from before trailing stops
        sellAt = Math.max(pos.takeProfit, price);
      }
      if (reason) {
        const t = sell(pos.id, sellAt, 1, reason);
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
        // Ask Claude for a fresh plan right away.
        state.lastSignal = null;
        state.bot.armedSince = [];
        state.bot.askNow = true;
        if (isAuto(cfg)) state.bot.target = null;
      }
      return;
    }

    recordEquity();
    if (checkDrawdown(cfg)) return;
    if (equity() >= cfg.goalUsd) noteOnce(`goal:${utcDay()}`, `Goal of $${cfg.goalUsd} reached (equity $${equity().toFixed(2)}). Consider raising the goal.`, "good");

    // 2. Safety rules: daily loss limit for the whole account, cool-down per coin.
    const daily = dailyBlock(cfg);
    if (daily) return setBlocked(daily, `daily:${utcDay()}`);
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

    // 3. Ask Claude only when something calls for it (never more than once per 2 min).
    const why = claudeDue(cfg, q?.price ?? null);
    if (why && Date.now() - state.bot.lastAnalysisAt >= MIN_CLAUDE_GAP_MS) {
      // Save "asked Claude at ..." BEFORE the slow, paid call, so no other
      // request or server decides a check is due and asks again meanwhile.
      state.bot.lastAnalysisAt = Date.now();
      state.bot.askNow = false;
      state.bot.armedSince = [];
      state.bot.skipNoted = [];
      log(`Asking Claude for a new plan (${why})...`);
      save();
      await flush();
      if (isAuto(cfg)) {
        await autoPick(cfg);
      } else {
        const { consensus, results } = await runAnalysis(cfg.chain, cfg.pool, cfg.tf);
        for (const f of results) if (!f.ok) log(`Claude failed: ${f.error}`, "bad");
        log(`Plan: ${consensus.stance.replace(/_/g, " ")} (${consensus.confidence}% sure). ${consensus.note}`);
      }
      const t2 = isAuto(cfg) ? state.bot.target : tgt;
      q = t2 ? await quote(t2.chain, t2.pool, planSince()) : null;
    }

    // 4. Carry out the plan's standing orders, checked every 5 seconds.
    const sig = state.lastSignal;
    const t3 = isAuto(cfg) ? state.bot.target : tgt;
    if (!q || !t3 || !sig || sig.pool !== t3.pool) return;
    const pair = q.pair;
    const c = sig.consensus;
    if (!c.orders.length || Date.now() > c.expiresAt) return;
    for (let i = 0; i < c.orders.length; i++) {
      const o = c.orders[i];
      const label = o.kind === "buy_dip" ? `dip to ${fmt(o.triggerPrice)}` : o.kind === "buy_breakout" ? `breakout above ${fmt(o.triggerPrice)}` : `buy-now order (up to ${fmt(o.triggerPrice)})`;
      // Orders below the user's minimum win chance are never used, but say so when their trigger is hit.
      // Trend filter: a crash is not a dip.
      if (o.kind !== "buy_breakout") {
        const drop = pair.change.h1;
        const maxDrop = cfg.maxDrop1hPct ?? 10;
        if (sig.trendDown || drop <= -maxDrop) {
          if (triggerMet(o, q))
            noteOnce(`trend:${sig.at}:${i}`, `${t3.symbol} reached the ${label}, but it's falling (${sig.trendDown ? "1-hour trend is down" : `${drop.toFixed(1)}% in the last hour`}), so dip orders are paused. A crash is not a dip.`);
          continue;
        }
      }
      if (o.winChancePct < cfg.minConfidence) {
        if (triggerMet(o, q) && !state.bot.skipNoted[i]) {
          state.bot.skipNoted[i] = true;
          log(`${t3.symbol} reached the ${label} (touched ${fmt(o.kind === "buy_breakout" ? q.high : q.low)}), but Claude gives it only a ${o.winChancePct}% win chance, below your ${cfg.minConfidence}% minimum. Not buying.`);
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

      // Risk-based size: if the trade hits its exit, lose about riskPerTradePct of the account
      // (exit distance plus round-trip costs), capped at positionPct of cash.
      const riskPct = cfg.riskPerTradePct ?? 1.5;
      const exitLossPct = ((o.triggerPrice - o.stopLoss) / o.triggerPrice) * 100 + roundTripCostPct();
      const bySize = (equity() * riskPct) / 100 / (exitLossPct / 100);
      const cap = state.cash * (cfg.positionPct / 100);
      const usd = Math.floor(Math.min(cap, bySize) * 100) / 100;
      if (usd < 1) return log("Not enough cash to open a position.", "bad");
      const riskUsd = usd * (exitLossPct / 100);
      // Fill like a real order at the trigger price (or better/worse, see buyFillPrice).
      const t = buy({ ...pair, priceUsd: buyFillPrice(o, q) }, usd, "bot", `Claude plan: ${label}`, {
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
    busy = false;
    if (persist || dirty) save();
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
export async function watch(maxMs: number) {
  const botOn = () => state.bot.running && !!state.bot.config;
  if (!botOn() && !hasProtected()) return { ticks: 0, reason: "bot is off" };
  if (!(await store.lock("watch", maxMs + 10_000))) return { ticks: 0, reason: "another window is already watching" };
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
    await store.unlock("watch");
  }
}

// ---------- "Protect this trade" (manual positions) ----------
const hasProtected = () => state.positions.some((p) => p.protectPct);
let guarding = false;

export async function protectPosition(positionId: string, pct: number) {
  const p = state.positions.find((x) => x.id === positionId);
  if (!p) throw new Error("Position not found");
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
  if (guarding || !hasProtected()) return;
  guarding = true;
  let changed = false;
  try {
    for (const p of state.positions.filter((x) => x.protectPct)) {
      const q = await quote(p.chain, p.pool, Math.max(Date.now() - 60_000, p.protectSince ?? 0));
      p.lastPrice = q.price;
      if (q.high > (p.peak ?? 0)) {
        p.peak = q.high;
        changed = true;
      }
      const stop = p.peak! * (1 - p.protectPct! / 100);
      if (q.low <= stop) {
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
    guarding = false;
    if (changed) save();
  }
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

// Local: load the saved state and resume a running bot after a restart.
void sync().then(() => {
  if (state.bot.running) schedule();
});

// Locally (not on Vercel) a timer guards protected manual positions every 5 s.
if (!process.env.VERCEL) setInterval(() => void guardProtected(), CHECK_MS);
