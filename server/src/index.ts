import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { hasClaude, hasOpenAI } from "./ai.js";
import { getCandles, getPair, getTrending, searchPairs, type Timeframe } from "./data.js";
import * as engine from "./engine.js";
import { snapshot } from "./indicators.js";

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
app.get("/api/candles/:chain/:pool", wrap(async (req) => getCandles(String(req.params.chain), String(req.params.pool), (req.query.tf as Timeframe) ?? "5m")));

// Opportunity scanner: trending pools ranked by a quick technical score.
// This is a cheap pre-filter (no AI cost). Run the AI on the ones you like.
app.get(
  "/api/scan",
  wrap(async (req) => {
    const chain = String(req.query.chain ?? "solana");
    const trending = (await getTrending(chain)).filter((p) => p.liquidityUsd > 20_000).slice(0, 6);
    const rows = await Promise.all(
      trending.map(async (p) => {
        try {
          const snap = snapshot(await getCandles(chain, p.pool, "5m", 120));
          return { pair: p, snap };
        } catch {
          return { pair: p, snap: null };
        }
      }),
    );
    return rows.sort((a, b) => (b.snap?.techScore ?? -999) - (a.snap?.techScore ?? -999));
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
