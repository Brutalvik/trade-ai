import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { isSecondsTf, type Candle, type PairInfo, type Timeframe } from "./data.js";
import { keyLevels, type Snapshot } from "./indicators.js";
import { maCrossover, TF_SECONDS, type MaCross } from "./macross.js";
import { combineChance, countedWin, expected, type FcKey, type FcStats, type Forecast } from "./predict.js";

// What Claude returns: a PLAN of standing orders the bot carries out on its own,
// checking prices every 5 seconds, without asking Claude again until something changes.
const OrderSchema = z.object({
  kind: z
    .enum(["buy_now", "buy_dip", "buy_breakout"])
    .describe("buy_now: buy right away at or below triggerPrice. buy_dip: buy when price falls to triggerPrice or lower. buy_breakout: buy when price rises to triggerPrice or higher."),
  triggerPrice: z.number().describe("USD price that triggers the buy (see kind)"),
  confirmSeconds: z.number().describe("How many seconds the price must stay past the trigger before buying (0-300). Use ~60 for dips so the bot doesn't catch a falling knife, ~30 for breakouts, 0 for buy_now."),
  minVolumeRatio: z.number().describe("buy_breakout only: required ratio of last-5-minute volume to the hourly average (e.g. 1.5). 0 = no volume check."),
  stopLoss: z.number().describe("USD price to sell at a loss if the trade goes wrong; must be below triggerPrice"),
  target: z.number().describe("USD profit target; must be above triggerPrice. When reached, the bot switches to a trailing stop to ride further gains."),
  maxHoldMinutes: z.number().describe("Sell after this many minutes in the trade no matter what"),
  winChancePct: z
    .number()
    .describe("If this order fills, your honest estimate (0-100) of the chance the price reaches target BEFORE stopLoss. This decides whether the bot uses the order."),
});

export const PlanSchema = z.object({
  stance: z.enum(["BUY_NOW", "WAIT_FOR_TRIGGER", "AVOID"]).describe("BUY_NOW: good entry right now. WAIT_FOR_TRIGGER: only buy if a trigger below is hit. AVOID: you advise staying out (still give your best risky setup in orders)."),
  confidence: z.number().describe("0-100, overall confidence in your read of this market (shown to the user; orders are judged by their own winChancePct)"),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "EXTREME"]),
  reasoning: z.string().describe("2-4 short sentences explaining the plan in plain words"),
  orders: z.array(OrderSchema).describe("1-2 standing buy orders: your best setups. ALWAYS give at least one, even with AVOID (the user may choose to trade risky setups); leave empty only for a confirmed rug or honeypot."),
  cancelBelow: z.number().describe("Cancel the whole plan if price falls below this USD price (0 = none)"),
  cancelAbove: z.number().describe("Cancel the whole plan if price rises above this USD price without any order filling (0 = none)"),
  validMinutes: z.number().describe("How long this plan stays valid (5-720)"),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanOrder = z.infer<typeof OrderSchema>;
// Kept as an alias: the UI and older code call a model's answer its "signal".
export type Signal = Plan;

// tokens = AI API tokens this call used (input + output, including cache), for metering.
export type ModelResult = { model: string; ok: true; signal: Plan; ms: number; tokens?: number } | { model: string; ok: false; error: string; ms: number; tokens?: number };

// An order the server checked against fees and risk, ready for the bot.
// evPct = expected profit per trade after fees, from Claude's win chance:
//   winChance x gain-after-fees  -  (1 - winChance) x loss-after-fees
// warning = the order failed the fee/risk check (shown in red; the bot uses it only in risky mode).
// prediction = agents only: every forecaster's chance for this order and the combined chance it was judged on.
export type CheckedOrder = PlanOrder & { netRewardPct: number; netRiskPct: number; evPct: number; warning?: string; prediction?: OrderPrediction };
// An agent's order as predicted: pWin = the combined chance (0-100) of reaching the minimum-profit
// level before the stop; needPct = the chance it takes to be worth buying after costs.
export type OrderPrediction = {
  pWin: number;
  needPct: number;
  winNetPct: number; // what reaching the level is worth on average (the bot's exit rule, after costs)
  lossPct: number; // what failing costs on average
  parts: { key: FcKey; label: string; pct: number; adjPct: number; weight: number; note?: string }[];
  worlds?: { trend: number; flat: number; paths: number; from: string; minutesToWin: number | null; pStop: number; pNone: number; filledPct: number };
  panel?: { who: string; pct: number; reason: string }[];
  truncated?: boolean;
  assumed?: boolean; // judged as a buy at the order's level (the coin has hardly ever reached it lately)
};

export type Consensus = {
  action: "BUY" | "SELL" | "HOLD"; // BUY = buy now, HOLD = waiting for a trigger (or nothing), SELL = avoid
  stance: Plan["stance"];
  confidence: number;
  orders: CheckedOrder[];
  cancelBelow: number;
  cancelAbove: number;
  expiresAt: number; // unix ms
  // Summary of the first order, for simple displays.
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  holdMinutes: number;
  buyBy: number;
  sellBy: number;
  netRewardPct: number;
  netRiskPct: number;
  agreement: boolean;
  note: string;
};

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// The bot's routine re-plans (after each trade, when a plan expires) use a cheaper model:
// Claude Sonnet 5.5 costs half as much per token. Your own Analyze / Ask AI stay on Opus.
export const BOT_MODEL = process.env.BOT_MODEL || "claude-sonnet-5-5";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";

let anthropic: Anthropic | null = null;
let openai: OpenAI | null = null;
export const hasClaude = () => Boolean(process.env.ANTHROPIC_API_KEY);
// ChatGPT is off by default: Claude alone makes the trading calls.
// Set ENABLE_OPENAI=true (plus OPENAI_API_KEY) to add it back as a second opinion.
export const hasOpenAI = () => process.env.ENABLE_OPENAI === "true" && Boolean(process.env.OPENAI_API_KEY);

const SYSTEM = `You are a disciplined short-term crypto trading planner for small-cap on-chain tokens (often memecoins).
You don't place one-off calls: you write a PLAN of standing orders that a bot carries out on its own.
The bot checks prices every 5 seconds, including the low and high of each 5-second candle, and buys the moment an order's trigger is touched (a dip order fills at its trigger price like a limit order).
After buying it: sells at stopLoss if wrong; once up enough, a profit lock keeps at least half of the best gain;
it sells half the position once the price is most of the way to target; when the price reaches target, it switches to
a trailing stop (sells if the price falls a set % from its highest point), and sells after maxHoldMinutes.
You will be asked again after a trade closes, when your plan expires, or when the price leaves your cancel range.

Rules:
- Protect capital first. Round-trip costs (fees + slippage) are given. For every order, give winChancePct: if it fills, the chance it reaches target before stopLoss. Be calibrated and honest, not optimistic.
- The bot only uses an order if it is profitable on average after costs (winChance x gain - (1 - winChance) x loss > 0) and its gain after costs is at least as big as its loss after costs. Orders that fail this are discarded.
- Prefer patient entries: a buy_dip near real support (where the price bounced before), and/or a buy_breakout above resistance with a volume check. Use buy_now only when the entry is good right now.
- Place stopLoss just below the support that invalidates the idea AND outside normal noise: at least about 1.5x the 5-minute ATR below the entry. A stop inside the normal wiggle gets hit by noise even when the idea is right.
- Respect the bot's current limits given below: if dip orders are blocked, use a breakout order or AVOID.
- Use your track record (given below when available) to calibrate winChancePct: if your past predictions were too optimistic, lower them.
- Read buy/sell pressure (share of buys in the last hour), liquidity and the pool's age: thin, brand-new or sell-heavy pools deserve lower win chances.
- Use AVOID as your advice for rugs, parabolic pumps, collapsing volume, thin liquidity, or no edge, but STILL give your best 1-2 orders (buy level, stop, target) with an honest, usually low, winChancePct. The user decides whether to trade a risky setup; the bot only trades AVOID plans if they accept the risk. Always give at least one order; leave orders empty only for a confirmed rug or honeypot.
- Put target slightly BELOW the nearest resistance (where recent rallies stalled or sellers stepped in), not at or above it.
  Runs often stall just under resistance; a target that actually gets reached lets the bot ride the trend from there.
  Base winChancePct on that reachable target.
- Set cancelBelow/cancelAbove so the plan is dropped when the market moves away from your thesis.
- Never promise profit. Be honest about uncertainty in confidence.
- Chart patterns found by code are listed below with how each did earlier on this same chart. Use them: a breakout from a range with volume or a bull flag supports a buy_breakout just above the level; a double top, breakdown or stretched price argues for patience. Weigh each pattern by its track record on this chart, not by its name.
- A moving-average crossover signal is given on every chart from 1 minute up (20-candle average against 50-candle average, closed candles only): BUY = the fast average has just crossed above the slow one, SELL = it has just crossed below; otherwise the line says which side the fast average is on and when it last crossed. Use it as one more input next to everything else. It is a late signal (it confirms a turn after it has happened), so weigh it by its track record on this chart, listed with the chart patterns, and never buy or sell on it alone.
- Your trade journal (below) shows which setups have really worked for this account; lean toward those.
- Prices are in USD and may be tiny numbers; keep full precision.`;

// Agents get their own instructions: a trader working one coin with a budget, expected to act.
const AGENT_SYSTEM = `You are an active short-term crypto trader working ONE token with a fixed budget, through a bot that carries out your orders.
Your job is to make that budget grow. That means taking calculated risks when the odds are on your side, not waiting for a perfect setup: a trader who never enters makes nothing.
The bot checks prices every 5 seconds and fills an order the moment its trigger is touched. You are asked again every 5 minutes, at once when the price reaches a level you named, whenever the price makes a real move (about 4%), and right after each trade, so plan for the next 10-30 minutes, not for hours.

How to decide:
- Read all timeframes, the volume, buyers vs sellers, the chart patterns, the history study and the forecast desk you are given, and form a view: where is this going next, and with what odds?
- A moving-average crossover signal is given on every chart from 1 minute up (20-candle average against 50-candle average, closed candles only): BUY = the fast average has just crossed above the slow one, SELL = it has just crossed below; otherwise the line says which side the fast average is on and when it last crossed. Use it as one more input. It is a late signal (it confirms a turn after it has happened), so weigh it by its record: how it did earlier on this chart (listed with the chart patterns) and in the history study, where the same crossover is replayed with your own stop and minimum profit. Never buy on it alone.
- If the entry is good right now (trend up with buyers behind it, a breakout holding, a dip that has bounced), say BUY_NOW with a buy_now order. Momentum is a reason to trade, not a reason to stay out: a coin that is running can be bought with a stop under the last higher low.
- Otherwise say WAIT_FOR_TRIGGER and give the exact price at which you WILL buy: a breakout above a level (with a volume check) and/or a pullback to support. Put those levels close enough to be reached in the next 10-30 minutes.
- ALWAYS give 1-2 orders you would genuinely take. Use AVOID only when the token looks like a rug or honeypot, liquidity is being pulled, or it is in free fall with no buyers; even then give the level where you would step back in.
- For every order give winChancePct: your honest, calibrated chance that the price reaches the MINIMUM-PROFIT level (given below) before stopLoss. Start from the forecast desk's base rates and move only as far as the evidence in front of you justifies; do not shade it down out of caution or up out of eagerness. The bot combines your chance with those numbers and with three more AI forecasters, and uses an order only if the combined chance makes money on average after costs.
- target is where you realistically expect the move to reach if it works; it must be at least the minimum-profit level you are told. Pick trades where such a move is realistic: strong trends, breakouts with volume, sharp reversals. Once that minimum profit is reached it is locked, and you are asked again and again to manage the trade (hold for more, or sell), so the win you are estimating is "reaches the minimum profit before the stop". Put the stop where your idea is proved wrong, outside normal noise.
- Set cancelBelow / cancelAbove just outside your thesis and validMinutes between 10 and 30.
- reasoning: 2-3 short plain sentences on what you expect and why. Prices are USD and may be tiny; keep full precision.`;

// One timeframe of chart data for Claude.
export type Frame = { tf: string; label: string; candles: Candle[]; snap: Snapshot | null; show: number };

const sig6 = (n: number) => Number(n.toPrecision(6)); // keep prompts compact; tiny prices keep full detail

// The moving-average crossover on one chart (macross.ts), from closed candles only. Not worked
// out on the 1- and 5-second charts (there it is noise) or when there is too little history.
export function frameCross(f: Pick<Frame, "tf" | "candles">): MaCross | null {
  const step = TF_SECONDS[f.tf as Timeframe];
  if (!step || isSecondsTf(f.tf as Timeframe)) return null;
  const m = maCrossover(f.candles, { stepSec: step });
  return m.ready ? m : null;
}
// The same as one line of text for the AI: the signal, both averages and the last crossover.
export function crossText(f: Pick<Frame, "tf" | "candles">): string {
  const m = frameCross(f);
  if (!m) return "";
  const lc = m.lastCross;
  return `Moving-average crossover (${m.fastPeriod}- and ${m.slowPeriod}-candle averages of the closes, closed candles only): ${m.signal === "HOLD" ? "no crossover on the newest closed candle" : `${m.signal} signal on the newest closed candle`} | MA${m.fastPeriod} ${sig6(m.fast!)} MA${m.slowPeriod} ${sig6(m.slow!)}: fast is ${Math.abs(m.spreadPct!).toFixed(2)}% ${m.fast! >= m.slow! ? "above" : "below"} slow${lc && lc.candlesAgo > 0 ? ` | last crossover: ${lc.signal} ${lc.candlesAgo} candle${lc.candlesAgo === 1 ? "" : "s"} ago at ${sig6(lc.price)}` : lc ? "" : " | no crossover in this window"}`;
}

// One timeframe as text: indicators, key levels found by code (swing highs/lows, VWAP, where the
// price sits in the range) and the candles themselves.
function frameText(f: Frame, max = f.show) {
  const shown = f.candles.slice(-Math.min(f.show, max));
  const rows = shown.map((c) => [c.time, sig6(c.open), sig6(c.high), sig6(c.low), sig6(c.close), Math.round(c.volume)]);
  const ind = f.snap
    ? `Indicators: EMA9 ${sig6(f.snap.ema9)} EMA21 ${sig6(f.snap.ema21)} EMA50 ${sig6(f.snap.ema50)} RSI14 ${f.snap.rsi14.toFixed(1)} ATR% ${f.snap.atrPct.toFixed(2)} | volume ratio (last5 vs prior20) ${f.snap.volRatio.toFixed(2)} | 50-candle range ${sig6(f.snap.low50)} - ${sig6(f.snap.high50)}`
    : "Indicators: not enough history";
  const lv = keyLevels(shown);
  const levels = lv
    ? `\nKey levels (found by code): swing highs, newest first ${lv.swingHighs.map(sig6).join(", ") || "none"} | swing lows, newest first ${lv.swingLows.map(sig6).join(", ") || "none"} | VWAP ${sig6(lv.vwap)} | price is ${lv.fromHighPct.toFixed(1)}% from this window's high ${sig6(lv.high)} and +${lv.fromLowPct.toFixed(1)}% from its low ${sig6(lv.low)}`
    : "";
  const cross = crossText(f);
  return `## ${f.label}\n${ind}${cross ? `\n${cross}` : ""}${levels}\nLast ${rows.length} candles [unix time, open, high, low, close, volume]:\n${JSON.stringify(rows)}`;
}

function buildPrompt(pair: PairInfo, frames: Frame[], costPct: number, context = "", agent = false) {
  const sections = frames.map((f) => frameText(f));
  return `Token: ${pair.symbol} (${pair.name}) on ${pair.chain}, pool ${pair.pool}
Live price: $${pair.priceUsd}
Liquidity: $${Math.round(pair.liquidityUsd)} | 24h volume: $${Math.round(pair.volume24h)} | Market cap: $${Math.round(pair.marketCap)}
Change: 5m ${pair.change.m5}% | 1h ${pair.change.h1}% | 6h ${pair.change.h6}% | 24h ${pair.change.h24}%
Last hour trades: ${pair.buys1h ?? "?"} buys / ${pair.sells1h ?? "?"} sells${pair.buys1h && pair.sells1h ? ` (${Math.round((pair.buys1h / (pair.buys1h + pair.sells1h)) * 100)}% buys)` : ""} | Pool age: ${pair.createdAt ? `${Math.max(0, Math.round((Date.now() - pair.createdAt) / 3_600_000))} hours` : "unknown"}
Round-trip cost (fees+slippage both sides): ${costPct.toFixed(2)}%
Current time (unix s): ${Math.floor(Date.now() / 1000)}

Chart data on several timeframes (newest candle last). Use the longer timeframes for the trend and real support/resistance, the 1-minute candles for the move that is happening now, and the 5-second candles for precise entry and exit levels. The bot checks prices every 5 seconds using 5-second candles.

${sections.join("\n\n")}
${context ? `\n${context}\n` : ""}
${agent ? "Decide now: your orders for the next 10-30 minutes." : "Write your trading plan (standing orders) for roughly the next few hours."}`;
}

async function askClaude(prompt: string, model = CLAUDE_MODEL, effort: "low" | "medium" | "high" = "high", system = SYSTEM): Promise<{ plan: Plan; tokens: number }> {
  anthropic ??= new Anthropic();
  const res = await anthropic.beta.messages.parse({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if a safety classifier declines, retry on a fallback model
    output_config: { effort, format: betaZodOutputFormat(PlanSchema) },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("The AI declined this request");
  if (!res.parsed_output) throw new Error(`The AI returned no parseable signal (${res.stop_reason})`);
  const u: any = res.usage ?? {};
  const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return { plan: res.parsed_output, tokens };
}

async function askOpenAI(prompt: string): Promise<{ plan: Plan; tokens: number }> {
  openai ??= new OpenAI();
  const res = await openai.responses.parse({
    model: OPENAI_MODEL,
    instructions: SYSTEM,
    input: prompt,
    text: { format: zodTextFormat(PlanSchema, "trading_plan") },
  });
  if (!res.output_parsed) throw new Error("OpenAI returned no parseable signal");
  const u: any = res.usage ?? {};
  return { plan: res.output_parsed, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
}

async function timed(model: string, fn: () => Promise<{ plan: Plan; tokens: number }>): Promise<ModelResult> {
  const t = Date.now();
  try {
    const r = await fn();
    return { model, ok: true, signal: r.plan, ms: Date.now() - t, tokens: r.tokens };
  } catch (e: any) {
    return { model, ok: false, error: e?.message ?? String(e), ms: Date.now() - t };
  }
}

// How an agent's orders are judged. A win is reaching the minimum profit before the stop; from
// there the trade is managed (held for more, or sold), so a win counts as the minimum plus 30%
// of the extra distance to the AI's target (target counted up to +20%), or, once this account
// has enough managed winners, what they really made on average.
// predict = the numbers' forecast for an order (simulated paths, look-alikes, this coin lately);
// panel = the AI forecaster panel's answers, keyed by orderKey; stats = every forecaster's record.
export type AgentEval = {
  minNetPct: number;
  measuredWinPct?: number;
  predict?: (o: PlanOrder, validMinutes: number) => Forecast | null;
  panel?: Map<string, { pct: number; votes: { who: string; pct: number; reason: string }[] }>;
  stats?: FcStats;
  // A floor on the numbers: an order whose chance from the coin's own candles alone is under this is
  // refused whatever the AI's chance (0 / missing = no floor). Blind tests on real coins found that
  // when the numbers say under 10% it almost never happens, while the AI's own chance is half of
  // the combined one: once trading costs are low, an AI at 60% can carry such an order through.
  minNumbersPct?: number;
};
// The chance by the numbers alone (the simulated paths, this coin lately, the look-alike moments, by their weights).
export function numbersOf(parts: { key: string; pct: number; weight: number }[]): number | null {
  const nums = parts.filter((p) => p.key !== "ai" && p.key !== "panel");
  const w = nums.reduce((s, p) => s + p.weight, 0);
  return w > 0 ? nums.reduce((s, p) => s + p.pct * p.weight, 0) / w : null;
}
export const orderKey = (o: Pick<PlanOrder, "kind" | "triggerPrice">) => `${o.kind}:${o.triggerPrice}`;

export async function analyze(pair: PairInfo, frames: Frame[], costPct: number, context = "", model?: string, agent?: AgentEval) {
  const aiInCharge = !!agent;
  const prompt = buildPrompt(pair, frames, costPct, context, aiInCharge);
  const jobs: Promise<ModelResult>[] = [];
  // The bot's own re-plans (model given) use medium effort so a new plan arrives quickly.
  if (hasClaude()) jobs.push(timed("AI", () => askClaude(prompt, model, model ? "medium" : "high", aiInCharge ? AGENT_SYSTEM : SYSTEM)));
  if (hasOpenAI()) jobs.push(timed(`ChatGPT (${OPENAI_MODEL})`, () => askOpenAI(prompt)));
  if (!jobs.length) throw new Error("AI is not configured. Add ANTHROPIC_API_KEY to server/.env (or your Vercel environment variables).");
  const results = await Promise.all(jobs);
  return { results, consensus: combine(results, costPct, pair.priceUsd, agent) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

// Checks each order for sanity and against fees/risk; drops the ones that fail.
// An order is kept only if, using Claude's own win chance, it makes money on
// average after fees (positive expected value) and its gain >= its loss.
export function checkOrders(orders: PlanOrder[], costPct: number, agent?: AgentEval, validMinutes = 30): { kept: CheckedOrder[]; dropped: string[]; warned: CheckedOrder[] } {
  const kept: CheckedOrder[] = [];
  const dropped: string[] = [];
  const warned: CheckedOrder[] = []; // sensible prices, but they fail the fee/risk check
  const clean = (o: PlanOrder) => ({
    winChancePct: Math.round(clamp(o.winChancePct, 0, 100)),
    confirmSeconds: clamp(o.confirmSeconds, 0, 600),
    minVolumeRatio: o.kind === "buy_breakout" ? clamp(o.minVolumeRatio, 0, 10) : 0,
    maxHoldMinutes: clamp(o.maxHoldMinutes, 5, 1440),
  });
  for (const o of orders.slice(0, 2)) {
    const t = o.triggerPrice;
    if (!(t > 0 && o.stopLoss > 0 && o.stopLoss < t && o.target > t)) {
      dropped.push(`${o.kind}: prices don't make sense (stop < trigger < target)`);
      continue;
    }
    const netRewardPct = ((o.target - t) / t) * 100 - costPct;
    const netRiskPct = ((t - o.stopLoss) / t) * 100 + costPct;
    let win = clamp(o.winChancePct, 0, 100) / 100;
    // What a win is worth: the target (classic), or for an agent what its managed trades end with.
    let winPct = !agent
      ? netRewardPct
      : agent.measuredWinPct !== undefined
        ? clamp(agent.measuredWinPct, agent.minNetPct, Math.max(agent.minNetPct, netRewardPct))
        : Math.max(0, agent.minNetPct + 0.3 * (Math.min(netRewardPct, 20) - agent.minNetPct));
    let evPct = win * winPct - (1 - win) * netRiskPct;
    // Agents: the AI's chance is combined with the numbers (and the forecaster panel when it was
    // asked), each corrected for its own record, and the order is judged on the combined chance.
    let prediction: OrderPrediction | undefined;
    let numbersPct: number | null = null;
    if (agent?.predict) {
      let f: Forecast | null = null;
      try {
        f = agent.predict(o, validMinutes);
      } catch { /* no forecast: the AI side alone */ }
      const pv = agent.panel?.get(orderKey(o)) ?? null;
      const c = combineChance(clamp(o.winChancePct, 0, 100), pv ? pv.pct : null, f, agent.stats);
      if (f && agent.measuredWinPct === undefined) winPct = countedWin(f.winNetPct, agent.minNetPct);
      const ex = expected(c.pWin, winPct, netRiskPct, f);
      numbersPct = f ? numbersOf(c.parts) : null;
      win = c.pWin / 100;
      evPct = ex.evPct;
      const w = f?.worlds;
      prediction = {
        pWin: Math.round(c.pWin * 10) / 10, needPct: Math.round(ex.needPct * 10) / 10, winNetPct: Math.round(winPct * 10) / 10, lossPct: Math.round(ex.lossPct * 10) / 10,
        parts: c.parts.map((p) => ({ ...p, pct: Math.round(p.pct * 10) / 10, adjPct: Math.round(p.adjPct * 10) / 10, weight: Math.round(p.weight * 1000) / 1000 })),
        ...(w ? { worlds: { trend: Math.round(w.trend.pWin), flat: Math.round(w.flat.pWin), paths: w.paths, from: w.from, minutesToWin: w.flat.minutesToWin === null ? null : Math.round(w.flat.minutesToWin), pStop: Math.round(w.flat.pStop), pNone: Math.round(w.flat.pNone), filledPct: Math.round(w.flat.filledPct) } } : {}),
        ...(pv ? { panel: pv.votes } : {}),
        ...(f?.truncated ? { truncated: true } : {}),
        ...(f?.assumed ? { assumed: true } : {}),
      };
    }
    if (netRewardPct <= 0 || (!agent && netRewardPct < netRiskPct)) {
      const why = `after ${costPct.toFixed(1)}% costs the gain (${netRewardPct.toFixed(1)}%) is smaller than the risk (${netRiskPct.toFixed(1)}%)`;
      dropped.push(`${o.kind}: ${why}`);
      warned.push({ ...o, ...clean(o), netRewardPct, netRiskPct, evPct, warning: `Fails the fee/risk check: ${why}.`, ...(prediction ? { prediction } : {}) });
      continue;
    }
    if (agent?.minNumbersPct && numbersPct !== null && numbersPct < agent.minNumbersPct) {
      const why = `this coin's own candles give it ${numbersPct < 1 ? "under 1" : `about ${Math.round(numbersPct)}`}% chance of reaching the minimum profit before the stop, under the ${agent.minNumbersPct}% floor (when the numbers are that low it almost never happens, whatever the AI's own estimate)`;
      dropped.push(`${o.kind}: ${why}`);
      warned.push({ ...o, ...clean(o), winChancePct: Math.round(win * 100), netRewardPct, netRiskPct, evPct, warning: `Fails the prediction check: ${why}.`, ...(prediction ? { prediction } : {}) });
      continue;
    }
    if (evPct <= 0) {
      const why = prediction
        ? `the combined chance of reaching the minimum profit before the stop is ${Math.round(prediction.pWin)}% (${prediction.parts.map((p) => `${p.label.toLowerCase()} ${Math.round(p.pct)}%`).join(", ")}); it needs about ${Math.ceil(prediction.needPct)}% to be worth buying after costs`
        : `with a ${Math.round(win * 100)}% win chance it loses money on average after costs (${evPct.toFixed(1)}% per trade)`;
      dropped.push(`${o.kind}: ${why}`);
      warned.push({ ...o, ...clean(o), ...(prediction ? { winChancePct: Math.round(win * 100) } : {}), netRewardPct, netRiskPct, evPct, warning: `Fails the ${prediction ? "prediction" : "fee/risk"} check: ${why}.`, ...(prediction ? { prediction } : {}) });
      continue;
    }
    kept.push({
      ...o,
      winChancePct: Math.round(win * 100),
      confirmSeconds: clamp(o.confirmSeconds, 0, 600),
      minVolumeRatio: o.kind === "buy_breakout" ? clamp(o.minVolumeRatio, 0, 10) : 0,
      maxHoldMinutes: clamp(o.maxHoldMinutes, 5, 1440),
      netRewardPct,
      netRiskPct,
      evPct,
      ...(prediction ? { prediction } : {}),
    });
  }
  return { kept, dropped, warned };
}

// Conservative combination: orders only when every model that answered has the same stance
// (with Claude alone, Claude's plan is used), and every order must pass the fee/risk check.
export function combine(results: ModelResult[], costPct: number, livePrice: number, agent?: AgentEval): Consensus {
  const aiInCharge = !!agent;
  const plans = results.filter((r): r is Extract<ModelResult, { ok: true }> => r.ok).map((r) => r.signal);
  const now = Date.now();
  const empty = {
    orders: [] as CheckedOrder[], cancelBelow: 0, cancelAbove: 0, expiresAt: now + 30 * 60_000,
    entryPrice: livePrice, takeProfit: livePrice, stopLoss: livePrice, holdMinutes: 0, buyBy: now, sellBy: now, netRewardPct: 0, netRiskPct: 0,
  };
  if (!plans.length) return { ...empty, action: "HOLD", stance: "AVOID", confidence: 0, agreement: false, note: "No model answered." };

  const stances = new Set(plans.map((p) => p.stance));
  const agreement = stances.size === 1;
  const confidence = Math.round(plans.reduce((a, p) => a + p.confidence, 0) / plans.length);
  if (!agreement) return { ...empty, action: "HOLD", stance: "AVOID", confidence: Math.round(confidence / 2), agreement, note: `Models disagree (${[...stances].join(" vs ")}), so standing aside.` };

  const plan = plans[0];
  const checked = checkOrders(plan.orders, costPct, agent, clamp(plan.validMinutes, 5, 720));
  const { dropped } = checked;
  // Orders that pass come first; ones that fail the check stay as warned, risky setups.
  const kept = [...checked.kept, ...checked.warned];
  const passing = checked.kept;
  const validMs = clamp(plan.validMinutes, 5, 720) * 60_000;
  // Default cancel range: below the lowest stop, above the highest target.
  const cancelBelow = plan.cancelBelow > 0 ? plan.cancelBelow : kept.length ? Math.min(...kept.map((o) => o.stopLoss)) : 0;
  const cancelAbove = plan.cancelAbove > 0 ? plan.cancelAbove : kept.length ? Math.max(...kept.map((o) => o.target)) : 0;
  const first = kept[0];
  const stance = !passing.length
    ? "AVOID"
    : aiInCharge && plan.stance === "AVOID"
      ? (passing.some((o) => o.kind === "buy_now") ? "BUY_NOW" : "WAIT_FOR_TRIGGER") // an agent's orders count, whatever the label
      : plan.stance;
  const action = stance === "BUY_NOW" ? "BUY" : stance === "AVOID" ? "SELL" : "HOLD";
  const describe = (o: CheckedOrder) =>
    (o.kind === "buy_dip" ? `buy if it dips to $${o.triggerPrice.toPrecision(4)}` : o.kind === "buy_breakout" ? `buy if it breaks above $${o.triggerPrice.toPrecision(4)}` : `buy now up to $${o.triggerPrice.toPrecision(4)}`) +
    (o.prediction ? ` (${Math.round(o.prediction.pWin)}% combined chance, needs ${Math.ceil(o.prediction.needPct)}%)` : ` (${o.winChancePct}% win chance)`);
  let note =
    stance === "AVOID"
      ? plan.stance === "AVOID"
        ? kept.length
          ? `The AI advises staying out (risky). Its best setup if you trade anyway: ${kept.map(describe).join(" or ")}.`
          : "The AI says stay out for now (no sensible setup)."
        : kept.some((o) => o.prediction)
          ? `No order passed the prediction check; closest: ${kept.map(describe).join(" or ")}.`
          : `No order passed the fee/risk check; risky setup shown: ${kept.map(describe).join(" or ")}.`
      : `Standing orders: ${kept.map(describe).join(" or ")}.`;
  if (passing.length && dropped.length) note += ` Risky, not used unless you accept the risk: ${dropped.join("; ")}.`;
  if (plans.length > 1) note += ` All ${plans.length} models agree.`;

  return {
    action,
    stance,
    confidence,
    orders: kept,
    cancelBelow,
    cancelAbove,
    expiresAt: now + validMs,
    entryPrice: first?.triggerPrice ?? livePrice,
    takeProfit: first?.target ?? livePrice,
    stopLoss: first?.stopLoss ?? livePrice,
    holdMinutes: first?.maxHoldMinutes ?? 0,
    buyBy: now + validMs,
    sellBy: now + validMs + (first?.maxHoldMinutes ?? 0) * 60_000,
    netRewardPct: first?.netRewardPct ?? 0,
    netRiskPct: first?.netRiskPct ?? 0,
    agreement,
    note,
  };
}

// ---------- Second look: the bot asks before a stop-loss or time-limit sale ----------
// The price touched the stop (or the time limit ran out). Claude looks at the chart again and
// decides: sell now, or hold with a new last-resort exit. The bot enforces hard limits on top.
const HoldSchema = z.object({
  hold: z.boolean().describe("true = keep the trade open; false = sell now"),
  winChancePct: z.number().describe("If held, honest chance (0-100) the price reaches `target` before `lastExit`"),
  target: z.number().describe("USD price you expect it can reach if held (above the current price)"),
  lastExit: z.number().describe("USD last-resort exit if held: sell if the price falls to this. Below the current price, at or above the hard floor given."),
  extraMinutes: z.number().describe("How many more minutes to hold (10-120)"),
  reason: z.string().describe("1-2 short sentences in plain words"),
});
export type HoldDecision = z.infer<typeof HoldSchema> & { tokens: number };

export async function reviewHold(input: {
  pair: PairInfo; frames: Frame[]; costPct: number; why: "stop" | "time";
  entry: number; price: number; stop: number; hardFloor: number; heldMin: number; target?: number; patterns: string;
}): Promise<HoldDecision> {
  const { pair, frames, why, entry, price, stop, hardFloor } = input;
  const sections = frames.map((f) => {
    const rows = f.candles.slice(-Math.min(f.show, 48)).map((c) => [c.time, sig6(c.open), sig6(c.high), sig6(c.low), sig6(c.close), Math.round(c.volume)]);
    const ind = f.snap ? `EMA9 ${sig6(f.snap.ema9)} EMA21 ${sig6(f.snap.ema21)} RSI14 ${f.snap.rsi14.toFixed(1)} ATR% ${f.snap.atrPct.toFixed(2)} volume ratio ${f.snap.volRatio.toFixed(2)}` : "";
    const cross = crossText(f);
    return `## ${f.label}\n${ind}${cross ? `\n${cross}` : ""}\n${JSON.stringify(rows)}`;
  });
  const prompt = `The bot holds ${pair.symbol} (${pair.chain}). Bought at $${entry}, now $${price} (${(((price - entry) / entry) * 100).toFixed(2)}%), held ${Math.round(input.heldMin)} min.
${why === "stop" ? `The price just touched the stop-loss at $${stop}. Normally the bot sells now.` : `The maximum holding time just ran out. Normally the bot sells now. Current exit: $${stop}.`}
${input.target ? `Original target: $${input.target}.` : ""}
Round-trip costs: ${input.costPct.toFixed(2)}%. Liquidity $${Math.round(pair.liquidityUsd)}. Change 5m ${pair.change.m5}% 1h ${pair.change.h1}%. Last hour ${pair.buys1h ?? "?"} buys / ${pair.sells1h ?? "?"} sells.
${why === "stop" ? `Hard floor for a new exit: $${hardFloor} (the bot will never accept a lower one).` : `A new exit can only be at or above the current exit $${stop}.`}

${input.patterns}

${sections.join("\n\n")}

Decide: sell now, or hold. Hold ONLY if the chart gives a concrete reason the drop is noise or a retest that is holding (support, a pattern still valid, buyers stepping in), and the trade can realistically end in profit after costs. Most touched stops should be sold: a falling coin usually keeps falling. Be honest and calibrated.`;
  anthropic ??= new Anthropic();
  const res = await anthropic.beta.messages.parse({
    model: BOT_MODEL,
    max_tokens: 3000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(HoldSchema) },
    system: "You manage the exit of an open short-term crypto trade. Capital protection comes first; only hold when there is a clear, concrete reason. Prices are USD, keep full precision.",
    messages: [{ role: "user", content: prompt }],
  });
  if (!res.parsed_output) throw new Error(`no decision (${res.stop_reason})`);
  const u: any = res.usage ?? {};
  return { ...res.parsed_output, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
}

// ---------- Agents mode: the AI's one check before a buy ----------
const AgentCheckSchema = z.object({
  approve: z.boolean().describe("true = buy now with the given exit and target; false = skip this coin"),
  winChancePct: z.number().describe("Honest chance (0-100) the price reaches the target before the exit"),
  reason: z.string().describe("1-2 short sentences in plain words"),
});
export type AgentCheck = z.infer<typeof AgentCheckSchema> & { tokens: number };

export async function reviewAgentPick(input: { pair: PairInfo; frames: Frame[]; agentReport: string; patterns: string; entry: number; stop: number; target: number; costPct: number }): Promise<AgentCheck> {
  const { pair, frames, entry, stop, target } = input;
  const sections = frames.map((f) => {
    const rows = f.candles.slice(-Math.min(f.show, 48)).map((c) => [c.time, sig6(c.open), sig6(c.high), sig6(c.low), sig6(c.close), Math.round(c.volume)]);
    const ind = f.snap ? `EMA9 ${sig6(f.snap.ema9)} EMA21 ${sig6(f.snap.ema21)} RSI14 ${f.snap.rsi14.toFixed(1)} ATR% ${f.snap.atrPct.toFixed(2)} volume ratio ${f.snap.volRatio.toFixed(2)}` : "";
    const cross = crossText(f);
    return `## ${f.label}\n${ind}${cross ? `\n${cross}` : ""}\n${JSON.stringify(rows)}`;
  });
  const prompt = `Scouting agents picked ${pair.symbol} (${pair.chain}) to buy now at about $${entry}.
Proposed exit (stop-loss) $${stop} (${(((stop - entry) / entry) * 100).toFixed(1)}%), target $${target} (+${(((target - entry) / entry) * 100).toFixed(1)}%, which is the minimum profit after the ${input.costPct.toFixed(1)}% round-trip costs). At the target the bot sells half and trails the rest.
Liquidity $${Math.round(pair.liquidityUsd)}, change 5m ${pair.change.m5}% 1h ${pair.change.h1}% 24h ${pair.change.h24}%, last hour ${pair.buys1h ?? "?"} buys / ${pair.sells1h ?? "?"} sells.

What the agents saw:
${input.agentReport}

${input.patterns}

${sections.join("\n\n")}

Approve only if reaching the target before the exit is realistic in the next few hours: room below resistance, momentum with real buyers, not a pump that is already fading. Most picks should be rejected unless the setup is clearly good. Be calibrated.`;
  anthropic ??= new Anthropic();
  const res = await anthropic.beta.messages.parse({
    model: BOT_MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(AgentCheckSchema) },
    system: "You approve or reject a short-term crypto entry chosen by rule-based scouts. Protect capital first; reject anything unclear. Prices are USD, keep full precision.",
    messages: [{ role: "user", content: prompt }],
  });
  if (!res.parsed_output) throw new Error(`no decision (${res.stop_reason})`);
  const u: any = res.usage ?? {};
  return { ...res.parsed_output, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
}

// ---------- Agents: managing a trade that is in profit ----------
// Once a trade has reached its minimum profit (locked as the exit), the AI is asked again and
// again: hold for more, or sell now? When it holds it says where the hard exit sits and how
// closely to follow the price. The bot enforces the locked minimum whatever the answer.
const ProfitSchema = z.object({
  action: z.enum(["HOLD", "SELL_NOW"]).describe("HOLD: keep the trade open for more. SELL_NOW: take the profit now."),
  exitPrice: z.number().describe("If holding: USD hard exit. The bot sells if the price closes at or below it. At least the locked exit you are given, below the current price. It can only be moved up later, never down."),
  trailPct: z.number().describe("If holding: sell if the price falls this many % from its highest close (0.5-20). Wide enough for this coin's normal wiggle, tight enough to keep most of the gain. You may change it each time you are asked."),
  targetPrice: z.number().describe("USD price you expect it can reach if held (0 when selling now)"),
  recheckSeconds: z.number().describe("Ask me again after this many seconds (20-300). Sooner when it is moving fast."),
  confidence: z.number().describe("0-100: how likely the price goes meaningfully higher before reaching your exit"),
  reason: z.string().describe("1-2 short sentences in plain words"),
});
export type ProfitDecision = z.infer<typeof ProfitSchema> & { tokens: number };

const PROFIT_SYSTEM = `You are managing an open trade that is in profit, for a short-term crypto trading bot. The minimum profit is already locked: the bot will not sell below the locked exit.
Your job is to get the most out of this move: keep holding while it is still going, and sell when it is ending. Selling too early gives away profit; holding into a reversal gives it back.

How to decide:
- The big winners are the trades that are left alone. A trend that lasts hours or days is full of pullbacks of several percent; selling into each one turns a large win into a string of small ones. Your default is HOLD.
- HOLD while the trend is intact: the price is above its 21-candle average on the 15-minute and 1-hour charts, the fast average is above the slow one there, and buyers are out-trading sellers by volume (the "Trend check" below gives all of these, worked out by code). A pause, a red candle, or a pullback that stays above those averages is normal inside a trend: it is not a reason to sell.
- SELL_NOW only when the trend itself breaks or the move exhausts: a 15-minute close back under its 21-candle average with the 1-hour trend turning (fast average under slow, or price under the 1-hour average); a blow-off, where the biggest volume of the move comes with a long rejection wick and no follow-through; sellers clearly taking over by volume for more than a few minutes while price makes lower highs; or liquidity being pulled. One sign alone on the 5-second or 1-minute chart is noise.
- You do not need to sell to protect the profit: the locked exit and the trailing exit do that on their own, every 5 seconds. Selling is for when the reason to be in the trade is gone.
- Each chart from 1 minute up carries a moving-average crossover line (20-candle average against 50-candle average, closed candles only). A fresh SELL signal on the 1-minute chart is one sign the push is tiring, on the 5-minute chart a stronger one; it is late and can be wrong in a healthy pause, so weigh it with the rest and with its record on this chart (listed with the chart patterns).
- When holding, set exitPrice under the level that must hold for the move to stay alive (the last higher low / reclaimed level), never below the locked exit. It only ever moves up, so raise it only to where you are happy to be sold.
- Set trailPct from how much this coin really swings: about 1.5 to 2 times its 5-minute ATR% (given in the Trend check), never tighter than its ordinary 5-minute swing, and wider (up to about 12%) while the 15-minute and 1-hour trends are intact. Too tight and ordinary noise sells you out of a move that goes on without you. Tighten it only when the trend is breaking down or the move looks exhausted.
- Be honest in confidence. Do not hold out of hope and do not sell out of fear: read the tape.
- Prices are USD and may be tiny; keep full precision.`;

export async function reviewProfit(input: {
  pair: PairInfo; frames: Frame[]; costPct: number; entry: number; price: number; best: number; lockedExit: number; minNetPct: number;
  trailPct: number; heldMin: number; flow: string; market: string; patterns: string; history: string; outlook?: string; trend?: string; last?: { secondsAgo: number; price: number; action: string; reason: string } | null;
}): Promise<ProfitDecision> {
  const { pair, entry, price, best, lockedExit, costPct } = input;
  const net = (p: number) => ((p - entry) / entry) * 100 - costPct;
  const prompt = `Open trade on ${pair.symbol} (${pair.chain}). Bought at $${entry}, ${Math.round(input.heldMin)} min ago.
Price now $${price}: +${net(price).toFixed(2)}% after the ${costPct.toFixed(1)}% round-trip costs. Best so far $${best} (+${net(best).toFixed(2)}% after costs).
Locked exit: $${lockedExit} (+${net(lockedExit).toFixed(2)}% after costs; the minimum is +${input.minNetPct}%). The bot sells if the price closes at or below it.
Trailing exit in force now: ${input.trailPct}% below the highest close.
${input.last ? `Your last decision (${Math.round(input.last.secondsAgo)} s ago, price was $${input.last.price}): ${input.last.action}. ${input.last.reason}` : "This is your first look since the minimum profit was reached."}
Liquidity $${Math.round(pair.liquidityUsd)}; change 5m ${pair.change.m5}%, 1h ${pair.change.h1}%; last hour ${pair.buys1h ?? "?"} buys / ${pair.sells1h ?? "?"} sells.
${input.market}
${input.flow}
${input.history}
${input.outlook ?? ""}
${input.trend ?? ""}
${input.patterns}

${input.frames.map((f) => frameText(f, f.tf === "1h" ? 24 : f.tf === "15m" ? 32 : 60)).join("\n\n")}

Decide now: HOLD (with exitPrice, trailPct, targetPrice, recheckSeconds) or SELL_NOW.`;
  anthropic ??= new Anthropic();
  const res = await anthropic.beta.messages.parse({
    model: BOT_MODEL,
    max_tokens: 1500,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(ProfitSchema) },
    system: PROFIT_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  if (!res.parsed_output) throw new Error(`no decision (${res.stop_reason})`);
  const u: any = res.usage ?? {};
  return { ...res.parsed_output, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
}

// ---------- A panel of AI forecasters (agents) ----------
// Before an agent's order is used, three forecasters with different jobs judge it on their own,
// asked side by side. Their average joins the agent's own estimate and the numbers. It is only
// asked for orders that already pass on the agent's estimate and the numbers.
const PanelSchema = z.object({
  chances: z.array(z.number()).describe("One number per order, in the order they are listed: the chance (0-100) that, once the order is filled, the price reaches the minimum-profit level before the stop, inside the time limit"),
  reason: z.string().describe("1-2 short sentences in plain words: the main thing behind your numbers"),
});
const PANEL_RULES = `You are one of three independent forecasters judging a short-term crypto trade for a trading bot. You do not decide the trade; you give a probability.
For each order listed, estimate the chance (0-100) that, once it is filled, the price reaches the MINIMUM-PROFIT LEVEL before it reaches the STOP, inside the time limit. Running out of time counts as not reaching it.
Be calibrated: of all the orders you rate 60%, about 60 in 100 should really get there. On a coin with no direction, an order that needs a rise of U% before a fall of D% gets there about D / (U + D) of the time, and less with a short time limit; move away from the numbers you are given only as far as the evidence in front of you justifies.
Prices are USD and may be tiny; keep full precision.`;
const PANEL: { who: string; job: string }[] = [
  { who: "Momentum trader", job: "Your job: judge the move itself. Are buyers in control right now (higher lows, buys out-trading sells, volume behind the push), and is there room to the level before resistance or exhaustion? Give credit to a move that is really alive, none to one that already happened." },
  { who: "Skeptic", job: "Your job: find how this trade fails. Look for exhaustion after a run, resistance between the entry and the level, sellers taking over, volume fading, a thin pool, a few wallets holding most of the supply, a weak market backdrop. Say how likely the stop is hit first." },
  { who: "Statistician", job: "Your job: think in base rates. Start from the numbers given (simulated paths, this coin lately, look-alike moments) and adjust only for specific, strong evidence that this moment differs from the typical one. Distrust stories." },
];
export type PanelResult = { votes: { who: string; chances: number[]; reason: string }[]; chances: number[]; tokens: number };

export async function forecastPanel(input: {
  pair: PairInfo; frames: Frame[]; costPct: number; minNetPct: number; orders: { text: string }[]; numbers: string; traderCase: string; flow: string; market: string; patterns: string;
}): Promise<PanelResult> {
  const { pair } = input;
  const show: Record<string, number> = { "1m": 45, "5m": 36, "1h": 24 };
  const prompt = `Token: ${pair.symbol} (${pair.name}) on ${pair.chain}. Live price: $${pair.priceUsd}
Liquidity $${Math.round(pair.liquidityUsd)} | market cap $${Math.round(pair.marketCap)} | change 5m ${pair.change.m5}%, 1h ${pair.change.h1}%, 6h ${pair.change.h6}%, 24h ${pair.change.h24}% | last hour ${pair.buys1h ?? "?"} buys / ${pair.sells1h ?? "?"} sells
Round-trip cost ${input.costPct.toFixed(2)}%. The minimum-profit level is the price at which the trade is up ${input.minNetPct}% after that cost.

Orders to judge:
${input.orders.map((o, i) => `${i + 1}. ${o.text}`).join("\n")}

The trader's case for them: ${input.traderCase || "(none given)"}

What the numbers say (from this coin's own candles, no opinion in them):
${input.numbers}
${input.market}
${input.flow}
${input.patterns}

${input.frames.filter((f) => show[f.tf]).map((f) => frameText(f, show[f.tf])).join("\n\n")}

Give one chance per order (${input.orders.length} number${input.orders.length === 1 ? "" : "s"}), and your reason.`;
  anthropic ??= new Anthropic();
  const ask = async (p: (typeof PANEL)[number]) => {
    const res = await anthropic!.beta.messages.parse({
      model: BOT_MODEL,
      max_tokens: 1200,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(PanelSchema) },
      system: `${PANEL_RULES}\n${p.job}`,
      messages: [{ role: "user", content: prompt }],
    });
    if (!res.parsed_output) throw new Error(`no answer (${res.stop_reason})`);
    const u: any = res.usage ?? {};
    const chances = input.orders.map((_, i) => clamp(res.parsed_output!.chances[i] ?? NaN, 0, 100));
    if (res.parsed_output.chances.length < input.orders.length) throw new Error("too few answers");
    return { who: p.who, chances, reason: res.parsed_output.reason.slice(0, 240), tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
  };
  const got = await Promise.allSettled(PANEL.map(ask));
  const votes = got.filter((g): g is PromiseFulfilledResult<Awaited<ReturnType<typeof ask>>> => g.status === "fulfilled").map((g) => g.value);
  if (votes.length < 2) throw new Error(`the forecaster panel could not be asked (${got.find((g) => g.status === "rejected") ? String((got.find((g) => g.status === "rejected") as PromiseRejectedResult).reason?.message ?? "no answer") : "no answer"})`);
  return {
    votes: votes.map(({ who, chances, reason }) => ({ who, chances, reason })),
    chances: input.orders.map((_, i) => votes.reduce((a, v) => a + v.chances[i], 0) / votes.length),
    tokens: votes.reduce((a, v) => a + v.tokens, 0),
  };
}
