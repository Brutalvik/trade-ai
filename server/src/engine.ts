// Paper-trading broker + automated bot.
// Every trade here is simulated with realistic fees and slippage so you can
// see how the strategy would perform before risking real money.
import fs from "node:fs";
import path from "node:path";
import { analyze, type Consensus, type ModelResult } from "./ai.js";
import { getCandles, getPair, type PairInfo, type Timeframe } from "./data.js";
import { snapshot } from "./indicators.js";

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
  bot: { running: boolean; config: BotConfig | null; lastAnalysisAt: number; log: { t: number; msg: string; level: "info" | "good" | "bad" }[] };
  lastSignal: { at: number; pool: string; symbol: string; tf: string; results: ModelResult[]; consensus: Consensus } | null;
};

// Vercel functions can only write to /tmp, and it is wiped between instances.
// For real persistence on Vercel, swap this for a database (see README).
const DATA_DIR = process.env.VERCEL ? "/tmp/trade-ai" : path.resolve("data");
const FILE = path.join(DATA_DIR, "state.json");

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
    bot: { running: false, config: null, lastAnalysisAt: 0, log: [] },
    lastSignal: null,
  };
}

let state: State = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as State;
  } catch {
    return fresh();
  }
})();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

const uid = () => Math.random().toString(36).slice(2, 10);
export const roundTripCostPct = () => 2 * (state.settings.feePct + state.settings.slippagePct);

function log(msg: string, level: "info" | "good" | "bad" = "info") {
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
  return { ...state, equityNow: equity(), roundTripCostPct: roundTripCostPct() };
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

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function startBot(cfg: BotConfig) {
  state.bot.config = cfg;
  state.bot.running = true;
  state.bot.lastAnalysisAt = 0;
  log(`Bot started on ${cfg.symbol} (${cfg.tf}). Paper mode. Cash $${state.cash.toFixed(2)}.`, "good");
  save();
  schedule();
}

export function stopBot(reason = "Stopped by user") {
  state.bot.running = false;
  log(`Bot stopped: ${reason}`, "bad");
  if (timer) clearInterval(timer);
  timer = null;
  save();
}

function schedule() {
  if (timer) clearInterval(timer);
  const cfg = state.bot.config;
  if (!state.bot.running || !cfg) return;
  if (process.env.VERCEL) return void tick(); // no long-lived timers on Vercel; /api/bot/tick drives it
  timer = setInterval(() => void tick(), Math.max(10, cfg.checkEverySec) * 1000);
  void tick();
}

export async function tick() {
  const cfg = state.bot.config;
  if (!state.bot.running || !cfg || busy) return;
  busy = true;
  try {
    const pair = await getPair(cfg.chain, cfg.pool);
    const price = pair.priceUsd;
    for (const p of state.positions) if (p.pool === pair.pool) p.lastPrice = price;
    recordEquity();

    // Safety: hard drawdown stop.
    const eq = equity();
    if (eq < state.startCash * (1 - cfg.maxDrawdownPct / 100)) {
      for (const p of state.positions.filter((x) => x.source === "bot")) sell(p.id, p.lastPrice, 1, "Drawdown kill-switch");
      stopBot(`Equity $${eq.toFixed(2)} fell below the ${cfg.maxDrawdownPct}% drawdown limit`);
      return;
    }
    if (eq >= cfg.goalUsd) log(`Goal of $${cfg.goalUsd} reached (equity $${eq.toFixed(2)}). Consider raising the goal.`, "good");

    const pos = state.positions.find((p) => p.source === "bot" && p.pool === cfg.pool);
    if (pos) {
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
      }
      save();
      return;
    }

    // No position: refresh the AI view on schedule.
    if (Date.now() - state.bot.lastAnalysisAt >= cfg.analyzeEverySec * 1000) {
      state.bot.lastAnalysisAt = Date.now();
      log(`Asking the AI models about ${cfg.symbol}...`);
      const { consensus, results } = await runAnalysis(cfg.chain, cfg.pool, cfg.tf);
      const failed = results.filter((r) => !r.ok);
      for (const f of failed) if (!f.ok) log(`${f.model} failed: ${f.error}`, "bad");
      log(`Signal: ${consensus.action} (${consensus.confidence}% conf). ${consensus.note}`);
    }

    const sig = state.lastSignal;
    if (!sig || sig.pool !== cfg.pool) return;
    const c = sig.consensus;
    if (c.action !== "BUY" || c.confidence < cfg.minConfidence) return;
    if (Date.now() > c.buyBy) return;
    if (price > c.entryPrice * 1.005) return; // don't chase: wait for the planned entry
    if (price <= c.stopLoss) return;

    const usd = Math.floor(state.cash * (cfg.positionPct / 100) * 100) / 100;
    if (usd < 1) return log("Not enough cash to open a position.", "bad");
    const t = buy(pair, usd, "bot", `AI consensus BUY ${c.confidence}%`, { takeProfit: c.takeProfit, stopLoss: c.stopLoss, sellBy: c.sellBy });
    log(`BUY ${pair.symbol} $${usd.toFixed(2)} @ $${t.price.toPrecision(5)}. TP $${c.takeProfit.toPrecision(5)} / SL $${c.stopLoss.toPrecision(5)}`, "good");
    state.lastSignal = { ...sig, consensus: { ...c, action: "HOLD", note: "Signal used for an entry." } };
    save();
  } catch (e: any) {
    log(`Tick error: ${e?.message ?? e}`, "bad");
  } finally {
    busy = false;
  }
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

// Resume after restart.
if (state.bot.running) schedule();
