import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { hasClaude, hasOpenAI } from "./ai.js";
import { getCandles, getCandlesWithSource, getPair, getTrending, SCAN_CHAINS, searchPairs, type Timeframe } from "./data.js";
import * as engine from "./engine.js";
import { snapshot, type Snapshot } from "./indicators.js";

const app = express();
app.use(cors());
app.use(express.json());

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req, res));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
};

app.get("/api/status", wrap(async () => ({ claude: hasClaude(), openai: hasOpenAI(), mode: "paper" })));
app.get("/api/search", wrap(async (req) => searchPairs(String(req.query.q ?? ""))));
app.get("/api/pair/:chain/:pool", wrap(async (req) => getPair(String(req.params.chain), String(req.params.pool))));
// Returns the candle array; the X-Candle-Source header says where it came from.
app.get(
  "/api/candles/:chain/:pool",
  wrap(async (req, res) => {
    const r = await getCandlesWithSource(String(req.params.chain), String(req.params.pool), (req.query.tf as Timeframe) ?? "5m");
    res.setHeader("X-Candle-Source", r.source);
    if (r.note) res.setHeader("X-Candle-Note", r.note);
    return r.candles;
  }),
);

// Opportunity scanner: trending pools ranked by a quick chart score, each with
// a rule-based buy/sell plan. No AI cost; "Ask Claude" in the UI gives a real plan.
type Plan = { verdict: "BUY ZONE" | "WAIT" | "AVOID"; buyBelow: number; sellAt: number; exitBelow: number; buyBy: number; sellBy: number; netGainPct: number; why: string };

function quickPlan(snap: Snapshot, costPct: number, livePrice: number): Plan {
  // Use the live price (candles can lag), so "buy below" is never above what the coin costs now.
  const price = livePrice > 0 ? livePrice : snap.price;
  // Buy on a small pullback toward the fast average, never above the current price.
  const buyBelow = Math.min(price, snap.ema9 < price ? Math.max(snap.ema9, price * 0.985) : price);
  const riskPct = Math.max(1.5 * snap.atrPct, 2); // room for normal wiggles
  const rewardPct = 2 * riskPct + costPct; // aim for 2x the risk, after fees
  const exitBelow = buyBelow * (1 - riskPct / 100);
  const sellAt = buyBelow * (1 + rewardPct / 100);
  // Rough time to reach the target on 5-minute candles, 30 min to 6 h.
  const holdMin = Math.min(360, Math.max(30, (rewardPct / Math.max(snap.atrPct / 3, 0.05)) * 5));
  const now = Date.now();
  const verdict = snap.techScore >= 50 ? "BUY ZONE" : snap.techScore <= -30 ? "AVOID" : "WAIT";
  const why =
    verdict === "BUY ZONE"
      ? `Uptrend with ${snap.volRatio > 1.5 ? "rising volume" : "steady volume"}, RSI ${snap.rsi14.toFixed(0)}.`
      : verdict === "AVOID"
        ? `Downtrend${snap.rsi14 > 75 ? ", overheated" : ""}. Stay away for now.`
        : `No clear direction yet (RSI ${snap.rsi14.toFixed(0)}).`;
  return { verdict, buyBelow, sellAt, exitBelow, buyBy: now + 15 * 60_000, sellBy: now + (15 + holdMin) * 60_000, netGainPct: rewardPct - costPct, why };
}

app.get(
  "/api/scan",
  wrap(async (req) => {
    const chain = String(req.query.chain ?? "all");
    if (!(SCAN_CHAINS as readonly string[]).includes(chain)) throw new Error(`Unknown chain "${chain}"`);
    const { pairs, source } = await getTrending(chain);
    const picks = pairs.filter((p) => p.liquidityUsd > 20_000).slice(0, 8);
    const cost = engine.roundTripCostPct();
    const rows = await Promise.all(
      picks.map(async (p) => {
        try {
          const snap = snapshot(await getCandles(p.chain, p.pool, "5m", 120, p, "no-cmc"));
          return { pair: p, snap, plan: snap ? quickPlan(snap, cost, p.priceUsd) : null };
        } catch {
          return { pair: p, snap: null, plan: null };
        }
      }),
    );
    rows.sort((a, b) => (b.snap?.techScore ?? -999) - (a.snap?.techScore ?? -999));
    return { source, chain, rows };
  }),
);

app.post("/api/analyze", wrap(async (req) => engine.runAnalysis(req.body.chain, req.body.pool, req.body.tf ?? "5m")));

app.get(
  "/api/state",
  wrap(async () => {
    await engine.refreshPositionPrices();
    return engine.getState();
  }),
);

app.post(
  "/api/trade",
  wrap(async (req) => {
    const { side, chain, pool, usd, positionId, fraction } = req.body;
    const pair = await getPair(chain, pool);
    if (side === "BUY") return engine.buy(pair, Number(usd), "manual", "Manual buy");
    return engine.sell(positionId, pair.priceUsd, Number(fraction ?? 1), "Manual sell");
  }),
);

app.post("/api/settings", wrap(async (req) => engine.updateSettings(req.body)));
app.post("/api/reset", wrap(async (req) => engine.reset(Number(req.body.startCash ?? 10))));
app.post("/api/bot/start", wrap(async (req) => engine.startBot(req.body)));
app.post("/api/bot/stop", wrap(async () => engine.stopBot()));

// One bot step. Locally a timer calls this; on Vercel (no long-lived process)
// a scheduler must hit it. Protected by CRON_SECRET when that is set.
app.get(
  "/api/bot/tick",
  wrap(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      res.status(401);
      return { error: "Unauthorized" };
    }
    await engine.tick();
    return { ok: true, running: engine.getState().bot.running };
  }),
);

// Vercel runs the exported app as a function; locally we listen on a port.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => {
    console.log(`API on http://localhost:${port}  | Claude: ${hasClaude() ? "on" : "off"}  ChatGPT: ${hasOpenAI() ? "on" : "off"}  | PAPER mode`);
  });
}

export default app;
