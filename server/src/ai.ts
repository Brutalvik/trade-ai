import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { Candle, PairInfo } from "./data.js";
import type { Snapshot } from "./indicators.js";

export const SignalSchema = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  confidence: z.number().describe("0-100, how confident you are in this call"),
  entryPrice: z.number().describe("Suggested limit entry price in USD"),
  takeProfit: z.number().describe("Exit price for profit, USD"),
  stopLoss: z.number().describe("Exit price to cut the loss, USD"),
  holdMinutes: z.number().describe("Expected minutes until take-profit or exit"),
  buyWindowMinutes: z.number().describe("How many minutes from now the entry stays valid"),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "EXTREME"]),
  reasoning: z.string().describe("2-4 short sentences explaining the call"),
});
export type Signal = z.infer<typeof SignalSchema>;

export type ModelResult = { model: string; ok: true; signal: Signal; ms: number } | { model: string; ok: false; error: string; ms: number };

export type Consensus = {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  holdMinutes: number;
  buyBy: number; // unix ms
  sellBy: number; // unix ms
  netRewardPct: number; // after fees
  netRiskPct: number; // after fees
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

const SYSTEM = `You are a disciplined short-term crypto trading analyst for small-cap on-chain tokens (often Solana memecoins).
Your job is to protect capital first and only call BUY when the setup has a clear edge.
Rules:
- Round-trip trading costs (fees + slippage) are given. A BUY is only valid if (takeProfit - entry)/entry exceeds costs by a wide margin and reward:risk after costs is at least 2:1.
- Low liquidity, parabolic pumps, RSI > 80, or collapsing volume are reasons to HOLD.
- SELL means "exit / avoid, likely to fall". HOLD means "no trade".
- Never promise profit. Be honest about uncertainty in confidence.
- Prices are in USD and may be very small numbers; keep full precision.`;

function buildPrompt(pair: PairInfo, snap: Snapshot, candles: Candle[], tf: string, costPct: number) {
  const recent = candles.slice(-60).map((c) => [c.time, c.open, c.high, c.low, c.close, Math.round(c.volume)]);
  return `Token: ${pair.symbol} (${pair.name}) on ${pair.chain}, pool ${pair.pool}
Live price: $${pair.priceUsd}
Liquidity: $${Math.round(pair.liquidityUsd)} | 24h volume: $${Math.round(pair.volume24h)} | Market cap: $${Math.round(pair.marketCap)}
Change: 5m ${pair.change.m5}% | 1h ${pair.change.h1}% | 6h ${pair.change.h6}% | 24h ${pair.change.h24}%
Timeframe: ${tf}
Indicators: EMA9 ${snap.ema9} EMA21 ${snap.ema21} EMA50 ${snap.ema50} RSI14 ${snap.rsi14.toFixed(1)} ATR% ${snap.atrPct.toFixed(2)}
Volume ratio (last5 vs prior20): ${snap.volRatio.toFixed(2)} | 50-candle range: ${snap.low50} - ${snap.high50}
Round-trip cost (fees+slippage both sides): ${costPct.toFixed(2)}%
Current time (unix s): ${Math.floor(Date.now() / 1000)}
Last 60 candles [time, open, high, low, close, volume]:
${JSON.stringify(recent)}

Give your trade call for the next few hours.`;
}

async function askClaude(prompt: string): Promise<Signal> {
  anthropic ??= new Anthropic();
  const res = await anthropic.beta.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if a safety classifier declines, retry on a fallback model
    output_config: { effort: "medium", format: betaZodOutputFormat(SignalSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined this request");
  if (!res.parsed_output) throw new Error(`Claude returned no parseable signal (${res.stop_reason})`);
  return res.parsed_output;
}

async function askOpenAI(prompt: string): Promise<Signal> {
  openai ??= new OpenAI();
  const res = await openai.responses.parse({
    model: OPENAI_MODEL,
    instructions: SYSTEM,
    input: prompt,
    text: { format: zodTextFormat(SignalSchema, "trade_signal") },
  });
  if (!res.output_parsed) throw new Error("OpenAI returned no parseable signal");
  return res.output_parsed;
}

async function timed(model: string, fn: () => Promise<Signal>): Promise<ModelResult> {
  const t = Date.now();
  try {
    return { model, ok: true, signal: await fn(), ms: Date.now() - t };
  } catch (e: any) {
    return { model, ok: false, error: e?.message ?? String(e), ms: Date.now() - t };
  }
}

export async function analyze(pair: PairInfo, snap: Snapshot, candles: Candle[], tf: string, costPct: number) {
  const prompt = buildPrompt(pair, snap, candles, tf, costPct);
  const jobs: Promise<ModelResult>[] = [];
  if (hasClaude()) jobs.push(timed(`Claude (${CLAUDE_MODEL})`, () => askClaude(prompt)));
  if (hasOpenAI()) jobs.push(timed(`ChatGPT (${OPENAI_MODEL})`, () => askOpenAI(prompt)));
  if (!jobs.length) throw new Error("Claude is not configured. Add ANTHROPIC_API_KEY to server/.env (or your Vercel environment variables).");
  const results = await Promise.all(jobs);
  return { results, consensus: combine(results, costPct, pair.priceUsd) };
}

// Conservative combination: BUY only when every model that answered says BUY.
// With Claude alone, Claude's call is the decision (still checked against fees and risk below).
export function combine(results: ModelResult[], costPct: number, livePrice: number): Consensus {
  const sigs = results.filter((r): r is Extract<ModelResult, { ok: true }> => r.ok).map((r) => r.signal);
  const now = Date.now();
  const base = { entryPrice: livePrice, takeProfit: livePrice, stopLoss: livePrice, holdMinutes: 0, buyBy: now, sellBy: now, netRewardPct: 0, netRiskPct: 0 };
  if (!sigs.length) return { ...base, action: "HOLD", confidence: 0, agreement: false, note: "No model answered." };

  const avg = (f: (s: Signal) => number) => sigs.reduce((a, s) => a + f(s), 0) / sigs.length;
  const actions = new Set(sigs.map((s) => s.action));
  const agreement = actions.size === 1;
  const action = agreement ? sigs[0].action : "HOLD";
  const entryPrice = avg((s) => s.entryPrice);
  // For BUY use the more cautious target and the tighter stop.
  const takeProfit = action === "BUY" ? Math.min(...sigs.map((s) => s.takeProfit)) : avg((s) => s.takeProfit);
  const stopLoss = action === "BUY" ? Math.max(...sigs.map((s) => s.stopLoss)) : avg((s) => s.stopLoss);
  const holdMinutes = avg((s) => s.holdMinutes);
  const buyWindow = Math.min(...sigs.map((s) => s.buyWindowMinutes));
  const netRewardPct = ((takeProfit - entryPrice) / entryPrice) * 100 - costPct;
  const netRiskPct = ((entryPrice - stopLoss) / entryPrice) * 100 + costPct;
  let confidence = Math.round(avg((s) => s.confidence) * (agreement ? 1 : 0.5));
  let note = agreement ? `All ${sigs.length} model(s) agree.` : `Models disagree (${[...actions].join(" vs ")}), so standing aside.`;

  let finalAction = action;
  if (action === "BUY" && (netRewardPct <= 0 || netRewardPct < netRiskPct * 1.5)) {
    finalAction = "HOLD";
    note = `Models said BUY but after ${costPct.toFixed(1)}% costs the reward (${netRewardPct.toFixed(1)}%) doesn't justify the risk (${netRiskPct.toFixed(1)}%).`;
    confidence = Math.min(confidence, 40);
  }

  return {
    action: finalAction,
    confidence,
    entryPrice,
    takeProfit,
    stopLoss,
    holdMinutes,
    buyBy: now + buyWindow * 60_000,
    sellBy: now + (buyWindow + holdMinutes) * 60_000,
    netRewardPct,
    netRiskPct,
    agreement,
    note,
  };
}
