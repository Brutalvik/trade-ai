// Paper-trading broker + automated bot.
// Every trade here is simulated with realistic fees and slippage so you can
// see how the strategy would perform before risking real money.
import { analyze, type Consensus, type ModelResult } from "./ai.js";
import { getCandles, getPair, type PairInfo, type Timeframe } from "./data.js";
import { snapshot } from "./indicators.js";
import { scanOpportunities } from "./scan.js";
import { createStore } from "./store.js";

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
    // Auto-pick: the coin the bot is currently waiting to buy, and what Claude said about each candidate.
    target: { chain: string; pool: string; symbol: string; chosenAt: number } | null;
    candidates: { symbol: string; chain: string; pool: string; action: string; confidence: number; note: string }[];
    log: { t: number; msg: string; level: "info" | "good" | "bad" }[];
  };
  lastSignal: { at: number; pool: string; symbol: string; tf: string; results: ModelResult[]; consensus: Consensus } | null;
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
    bot: { running: false, config: null, lastAnalysisAt: 0, lastTickAt: 0, target: null, candidates: [], log: [] },
    lastSignal: null,
  };
}

// Fill in fields added in later versions so older saved states keep working.
function migrate(s: State): State {
  s.bot = { ...fresh().bot, ...s.bot };
  s.bot.candidates ??= [];
  s.bot.target ??= null;
  s.bot.lastTickAt ??= 0;
  return s;
}

let state: State = fresh();
let loaded = false;

// Load the latest saved state. With Redis this runs on every request, because
// on Vercel each request may land on a different short-lived server.
export async function sync() {
  if (loaded && store.kind !== "redis") return;
  const saved = await store.load<State>();
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

export async function runAnalysis(chain: string, pool: string, tf: Timeframe) {
  const pair = await getPair(chain, pool);
  const candles = await getCandles(chain, pool, tf, 300, pair);
  const snap = snapshot(candles);
  if (!snap) throw new Error("Not enough candle history for this token yet");
  const { results, consensus } = await analyze(pair, snap, candles, tf, roundTripCostPct());
  state.lastSignal = { at: Date.now(), pool, symbol: pair.symbol, tf, results, consensus };
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
  // Every second; tick(false) saves only when something happens (not 1 write per second).
  timer = setInterval(() => void tick(false), Math.max(1, cfg.checkEverySec) * 1000);
  void tick();
}

// Dashboard ping (every ~20 s while the page is open): watch for ~18 s.
export async function heartbeat() {
  return watch(18_000);
}

// Auto-pick: scan trending coins, ask Claude about the best few, choose the strongest BUY.
async function autoPick(cfg: BotConfig) {
  const scan = await scanOpportunities(cfg.autoChain ?? "all", roundTripCostPct(), cfg.autoMinLiquidityUsd ?? 50_000);
  const inZone = scan.rows.filter((r) => r.plan?.verdict === "BUY ZONE").slice(0, cfg.autoCandidates ?? 3);
  state.bot.target = null;
  state.bot.candidates = [];
  if (!inZone.length) {
    log(`Scanned ${scan.rows.length} trending coins: none in the buy zone right now. Will look again in ${Math.round(cfg.analyzeEverySec / 60)} min.`);
    return;
  }
  log(`Asking Claude about ${inZone.map((r) => r.pair.symbol).join(", ")}...`);
  let best: { pair: PairInfo; result: Awaited<ReturnType<typeof runAnalysis>> } | null = null;
  for (const row of inZone) {
    // One at a time, so CoinMarketCap's small allowance isn't used up in a burst.
    try {
      const r = await runAnalysis(row.pair.chain, row.pair.pool, cfg.tf);
      const c = r.consensus;
      state.bot.candidates.push({ symbol: row.pair.symbol, chain: row.pair.chain, pool: row.pair.pool, action: c.action, confidence: c.confidence, note: c.note });
      const good = c.action === "BUY" && c.confidence >= cfg.minConfidence;
      if (good && (!best || c.confidence > best.result.consensus.confidence)) best = { pair: row.pair, result: r };
    } catch (e: any) {
      state.bot.candidates.push({ symbol: row.pair.symbol, chain: row.pair.chain, pool: row.pair.pool, action: "ERROR", confidence: 0, note: String(e?.message ?? e) });
    }
  }
  const summary = state.bot.candidates.map((c) => `${c.symbol} ${c.action}${c.confidence ? ` ${c.confidence}%` : ""}`).join(", ");
  if (!best) {
    log(`Claude: ${summary}. No coin good enough to buy yet.`);
    state.lastSignal = null;
    return;
  }
  const { pair, result } = best;
  state.bot.target = { chain: pair.chain, pool: pair.pool, symbol: pair.symbol, chosenAt: Date.now() };
  state.lastSignal = { at: Date.now(), pool: pair.pool, symbol: pair.symbol, tf: cfg.tf, results: result.results, consensus: result.consensus };
  log(`Claude: ${summary}. Picked ${pair.symbol}; will buy at or below $${result.consensus.entryPrice.toPrecision(5)}.`, "good");
}

// persist=false skips the routine save at the end (buys/sells still save at once).
// The watch loop uses it so it doesn't write the whole state every second.
export async function tick(persist = true) {
  const cfg = state.bot.config;
  if (!state.bot.running || !cfg || busy) return;
  busy = true;
  state.bot.lastTickAt = Date.now();
  try {
    // 1. Manage an open bot position (every tick, no AI cost).
    const pos = state.positions.find((p) => p.source === "bot");
    if (pos) {
      const price = (await getPair(pos.chain, pos.pool)).priceUsd;
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
          log(`${pos.symbol} up ${gainPct.toFixed(1)}%: stop moved to break-even after fees ($${be.toPrecision(4)}).`, "good");
        }
      }
      let reason = "";
      if (pos.takeProfit && price >= pos.takeProfit) reason = "Take-profit hit";
      else if (pos.stopLoss && price <= pos.stopLoss) reason = gainPct > 0 ? "Break-even stop hit" : "Stop-loss hit";
      else if (pos.sellBy && Date.now() > pos.sellBy) reason = "Planned exit time reached";
      if (reason) {
        const t = sell(pos.id, price, 1, reason);
        log(`SELL ${pos.symbol} @ $${t.price.toPrecision(5)}: ${reason}. P&L ${t.pnlUsd! >= 0 ? "+" : ""}$${t.pnlUsd!.toFixed(2)}`, t.pnlUsd! >= 0 ? "good" : "bad");
        if (isAuto(cfg)) {
          // Look for the next coin straight away.
          state.bot.target = null;
          state.bot.lastAnalysisAt = 0;
        }
      }
      return;
    }

    recordEquity();
    if (checkDrawdown(cfg)) return;
    if (equity() >= cfg.goalUsd) log(`Goal of $${cfg.goalUsd} reached (equity $${equity().toFixed(2)}). Consider raising the goal.`, "good");

    // 2. No position: refresh the AI view on schedule (this is what costs money).
    const due = Date.now() - state.bot.lastAnalysisAt >= cfg.analyzeEverySec * 1000;
    if (due) {
      state.bot.lastAnalysisAt = Date.now();
      if (isAuto(cfg)) {
        await autoPick(cfg);
      } else {
        log(`Asking Claude about ${cfg.symbol}...`);
        const { consensus, results } = await runAnalysis(cfg.chain, cfg.pool, cfg.tf);
        for (const f of results) if (!f.ok) log(`${f.model} failed: ${f.error}`, "bad");
        log(`Signal: ${consensus.action} (${consensus.confidence}% sure). ${consensus.note}`);
      }
    }

    // 3. Buy the chosen coin once its price reaches the planned entry.
    const tgt = isAuto(cfg) ? state.bot.target : { chain: cfg.chain, pool: cfg.pool, symbol: cfg.symbol };
    const sig = state.lastSignal;
    if (!tgt || !sig || sig.pool !== tgt.pool) return;
    const c = sig.consensus;
    if (c.action !== "BUY" || c.confidence < cfg.minConfidence) return;
    if (Date.now() > c.buyBy) {
      if (isAuto(cfg)) {
        log(`${tgt.symbol} never reached the planned buy price in time. Looking for a new coin.`);
        state.bot.target = null;
        state.bot.lastAnalysisAt = 0;
      }
      return;
    }
    const pair = await getPair(tgt.chain, tgt.pool);
    const price = pair.priceUsd;
    if (price > c.entryPrice * 1.005) return; // don't chase: wait for the planned entry
    if (price <= c.stopLoss) return;

    const usd = Math.floor(state.cash * (cfg.positionPct / 100) * 100) / 100;
    if (usd < 1) return log("Not enough cash to open a position.", "bad");
    const t = buy(pair, usd, "bot", `Claude BUY ${c.confidence}%`, { takeProfit: c.takeProfit, stopLoss: c.stopLoss, sellBy: c.sellBy });
    log(`BUY ${pair.symbol} $${usd.toFixed(2)} @ $${t.price.toPrecision(5)}. Sell at $${c.takeProfit.toPrecision(5)}, exit below $${c.stopLoss.toPrecision(5)}.`, "good");
    state.lastSignal = { ...sig, consensus: { ...c, action: "HOLD", note: "Signal used for an entry." } };
  } catch (e: any) {
    log(`Tick error: ${e?.message ?? e}`, "bad");
  } finally {
    busy = false;
    if (persist || dirty) save();
  }
}

// True while there's something to watch closely: an open bot position, or a
// coin the bot is waiting to buy at its planned price.
function watching() {
  const cfg = state.bot.config;
  if (!state.bot.running || !cfg) return false;
  if (state.positions.some((p) => p.source === "bot")) return true;
  const sig = state.lastSignal;
  const tgtPool = isAuto(cfg) ? state.bot.target?.pool : cfg.pool;
  return Boolean(tgtPool && sig && sig.pool === tgtPool && sig.consensus.action === "BUY" && Date.now() < sig.consensus.buyBy);
}

// Serverless: run bot steps every second for up to maxMs (one scheduler call or
// dashboard ping keeps watch for a while). A lock stops two windows overlapping.
// Stops early when there's nothing to watch.
export async function watch(maxMs: number) {
  if (!state.bot.running || !state.bot.config) return { ticks: 0, reason: "bot is off" };
  if (!(await store.lock("watch", maxMs + 10_000))) return { ticks: 0, reason: "another window is already watching" };
  let ticks = 0;
  try {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      // Reload first, so a Stop or manual trade from the dashboard is never overwritten.
      await sync();
      if (!state.bot.running) break;
      await tick(false); // saves only if something happened
      ticks++;
      await flush();
      if (!watching()) break; // nothing to watch closely; the next scheduled check will come
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ticks, reason: state.bot.running ? (watching() ? "window ended" : "nothing to watch") : "bot stopped" };
  } finally {
    await flush();
    await store.unlock("watch");
  }
}

// Emergency stop: sell everything and switch off if equity falls below the limit.
function checkDrawdown(cfg: BotConfig) {
  const eq = equity();
  if (eq >= state.startCash * (1 - cfg.maxDrawdownPct / 100)) return false;
  for (const p of state.positions.filter((x) => x.source === "bot")) sell(p.id, p.lastPrice, 1, "Emergency stop");
  stopBot(`Equity $${eq.toFixed(2)} fell below the ${cfg.maxDrawdownPct}% limit`);
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
