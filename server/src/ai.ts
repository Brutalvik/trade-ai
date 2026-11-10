import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { Candle, PairInfo } from "./data.js";
import type { Snapshot } from "./indicators.js";

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
  stance: z.enum(["BUY_NOW", "WAIT_FOR_TRIGGER", "AVOID"]).describe("BUY_NOW: good entry right now. WAIT_FOR_TRIGGER: only buy if a trigger below is hit. AVOID: no orders, stay out."),
  confidence: z.number().describe("0-100, overall confidence in your read of this market (shown to the user; orders are judged by their own winChancePct)"),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "EXTREME"]),
  reasoning: z.string().describe("2-4 short sentences explaining the plan in plain words"),
  orders: z.array(OrderSchema).describe("0-2 standing buy orders. Empty for AVOID."),
  cancelBelow: z.number().describe("Cancel the whole plan if price falls below this USD price (0 = none)"),
  cancelAbove: z.number().describe("Cancel the whole plan if price rises above this USD price without any order filling (0 = none)"),
  validMinutes: z.number().describe("How long this plan stays valid (5-720)"),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanOrder = z.infer<typeof OrderSchema>;
// Kept as an alias: the UI and older code call a model's answer its "signal".
export type Signal = Plan;

export type ModelResult = { model: string; ok: true; signal: Plan; ms: number } | { model: string; ok: false; error: string; ms: number };

// An order the server checked against fees and risk, ready for the bot.
// evPct = expected profit per trade after fees, from Claude's win chance:
//   winChance x gain-after-fees  -  (1 - winChance) x loss-after-fees
export type CheckedOrder = PlanOrder & { netRewardPct: number; netRiskPct: number; evPct: number };

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

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
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
After buying it: sells at stopLoss if wrong; once up enough, moves the stop to break-even after fees;
when the price reaches target, it switches to a trailing stop (sells if the price falls a set % from its highest point), and sells after maxHoldMinutes.
You will be asked again after a trade closes, when your plan expires, or when the price leaves your cancel range.

Rules:
- Protect capital first. Round-trip costs (fees + slippage) are given. For every order, give winChancePct: if it fills, the chance it reaches target before stopLoss. Be calibrated and honest, not optimistic.
- The bot only uses an order if it is profitable on average after costs (winChance x gain - (1 - winChance) x loss > 0) and its gain after costs is at least as big as its loss after costs. Orders that fail this are discarded.
- Prefer patient entries: a buy_dip near support with confirmSeconds ~60, and/or a buy_breakout above resistance with a volume check. Use buy_now only when the entry is good right now.
- Use AVOID with no orders for rugs, parabolic pumps, collapsing volume, thin liquidity, or no edge.
- Set cancelBelow/cancelAbove so the plan is dropped when the market moves away from your thesis.
- Never promise profit. Be honest about uncertainty in confidence.
- Prices are in USD and may be tiny numbers; keep full precision.`;

// One timeframe of chart data for Claude.
export type Frame = { tf: string; label: string; candles: Candle[]; snap: Snapshot | null; show: number };

const sig6 = (n: number) => Number(n.toPrecision(6)); // keep prompts compact; tiny prices keep full detail

function buildPrompt(pair: PairInfo, frames: Frame[], costPct: number, context = "") {
  const sections = frames.map((f) => {
    const rows = f.candles.slice(-f.show).map((c) => [c.time, sig6(c.open), sig6(c.high), sig6(c.low), sig6(c.close), Math.round(c.volume)]);
    const ind = f.snap
      ? `Indicators: EMA9 ${sig6(f.snap.ema9)} EMA21 ${sig6(f.snap.ema21)} EMA50 ${sig6(f.snap.ema50)} RSI14 ${f.snap.rsi14.toFixed(1)} ATR% ${f.snap.atrPct.toFixed(2)} | volume ratio (last5 vs prior20) ${f.snap.volRatio.toFixed(2)} | 50-candle range ${sig6(f.snap.low50)} - ${sig6(f.snap.high50)}`
      : "Indicators: not enough history";
    return `## ${f.label}\n${ind}\nLast ${rows.length} candles [unix time, open, high, low, close, volume]:\n${JSON.stringify(rows)}`;
  });
  return `Token: ${pair.symbol} (${pair.name}) on ${pair.chain}, pool ${pair.pool}
Live price: $${pair.priceUsd}
Liquidity: $${Math.round(pair.liquidityUsd)} | 24h volume: $${Math.round(pair.volume24h)} | Market cap: $${Math.round(pair.marketCap)}
Change: 5m ${pair.change.m5}% | 1h ${pair.change.h1}% | 6h ${pair.change.h6}% | 24h ${pair.change.h24}%
Round-trip cost (fees+slippage both sides): ${costPct.toFixed(2)}%
Current time (unix s): ${Math.floor(Date.now() / 1000)}

Chart data on several timeframes (newest candle last). Use the longer timeframes for the trend and real support/resistance, and the 5-second candles for precise entry and exit levels. The bot checks prices every 5 seconds using 5-second candles.

${sections.join("\n\n")}
${context ? `\n${context}\n` : ""}
Write your trading plan (standing orders) for roughly the next few hours.`;
}

async function askClaude(prompt: string): Promise<Plan> {
  anthropic ??= new Anthropic();
  const res = await anthropic.beta.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if a safety classifier declines, retry on a fallback model
    output_config: { effort: "medium", format: betaZodOutputFormat(PlanSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined this request");
  if (!res.parsed_output) throw new Error(`Claude returned no parseable signal (${res.stop_reason})`);
  return res.parsed_output;
}

async function askOpenAI(prompt: string): Promise<Plan> {
  openai ??= new OpenAI();
  const res = await openai.responses.parse({
    model: OPENAI_MODEL,
    instructions: SYSTEM,
    input: prompt,
    text: { format: zodTextFormat(PlanSchema, "trading_plan") },
  });
  if (!res.output_parsed) throw new Error("OpenAI returned no parseable signal");
  return res.output_parsed;
}

async function timed(model: string, fn: () => Promise<Plan>): Promise<ModelResult> {
  const t = Date.now();
  try {
    return { model, ok: true, signal: await fn(), ms: Date.now() - t };
  } catch (e: any) {
    return { model, ok: false, error: e?.message ?? String(e), ms: Date.now() - t };
  }
}

export async function analyze(pair: PairInfo, frames: Frame[], costPct: number, context = "") {
  const prompt = buildPrompt(pair, frames, costPct, context);
  const jobs: Promise<ModelResult>[] = [];
  if (hasClaude()) jobs.push(timed(`Claude (${CLAUDE_MODEL})`, () => askClaude(prompt)));
  if (hasOpenAI()) jobs.push(timed(`ChatGPT (${OPENAI_MODEL})`, () => askOpenAI(prompt)));
  if (!jobs.length) throw new Error("Claude is not configured. Add ANTHROPIC_API_KEY to server/.env (or your Vercel environment variables).");
  const results = await Promise.all(jobs);
  return { results, consensus: combine(results, costPct, pair.priceUsd) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

// Checks each order for sanity and against fees/risk; drops the ones that fail.
// An order is kept only if, using Claude's own win chance, it makes money on
// average after fees (positive expected value) and its gain >= its loss.
export function checkOrders(orders: PlanOrder[], costPct: number): { kept: CheckedOrder[]; dropped: string[] } {
  const kept: CheckedOrder[] = [];
  const dropped: string[] = [];
  for (const o of orders.slice(0, 2)) {
    const t = o.triggerPrice;
    if (!(t > 0 && o.stopLoss > 0 && o.stopLoss < t && o.target > t)) {
      dropped.push(`${o.kind}: prices don't make sense (stop < trigger < target)`);
      continue;
    }
    const netRewardPct = ((o.target - t) / t) * 100 - costPct;
    const netRiskPct = ((t - o.stopLoss) / t) * 100 + costPct;
    const win = clamp(o.winChancePct, 0, 100) / 100;
    const evPct = win * netRewardPct - (1 - win) * netRiskPct;
    if (netRewardPct <= 0 || netRewardPct < netRiskPct) {
      dropped.push(`${o.kind}: after ${costPct.toFixed(1)}% costs the gain (${netRewardPct.toFixed(1)}%) is smaller than the risk (${netRiskPct.toFixed(1)}%)`);
      continue;
    }
    if (evPct <= 0) {
      dropped.push(`${o.kind}: with a ${Math.round(win * 100)}% win chance it loses money on average after costs`);
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
    });
  }
  return { kept, dropped };
}

// Conservative combination: orders only when every model that answered has the same stance
// (with Claude alone, Claude's plan is used), and every order must pass the fee/risk check.
export function combine(results: ModelResult[], costPct: number, livePrice: number): Consensus {
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
  const { kept, dropped } = plan.stance === "AVOID" ? { kept: [], dropped: [] } : checkOrders(plan.orders, costPct);
  const validMs = clamp(plan.validMinutes, 5, 720) * 60_000;
  // Default cancel range: below the lowest stop, above the highest target.
  const cancelBelow = plan.cancelBelow > 0 ? plan.cancelBelow : kept.length ? Math.min(...kept.map((o) => o.stopLoss)) : 0;
  const cancelAbove = plan.cancelAbove > 0 ? plan.cancelAbove : kept.length ? Math.max(...kept.map((o) => o.target)) : 0;
  const first = kept[0];
  const stance = plan.stance !== "AVOID" && !kept.length ? "AVOID" : plan.stance;
  const action = stance === "BUY_NOW" ? "BUY" : stance === "AVOID" ? "SELL" : "HOLD";
  const describe = (o: CheckedOrder) =>
    (o.kind === "buy_dip" ? `buy if it dips to $${o.triggerPrice.toPrecision(4)}` : o.kind === "buy_breakout" ? `buy if it breaks above $${o.triggerPrice.toPrecision(4)}` : `buy now up to $${o.triggerPrice.toPrecision(4)}`) +
    ` (${o.winChancePct}% win chance)`;
  let note =
    stance === "AVOID"
      ? plan.stance === "AVOID"
        ? "Claude says stay out for now."
        : `No order passed the fee/risk check (${dropped.join("; ")}).`
      : `Standing orders: ${kept.map(describe).join(" or ")}.`;
  if (kept.length && dropped.length) note += ` Dropped: ${dropped.join("; ")}.`;
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
