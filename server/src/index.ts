import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { hasClaude, hasOpenAI } from "./ai.js";
import { getCandlesWithSource, getPair, searchPairs, type Timeframe } from "./data.js";
import * as engine from "./engine.js";
import { scanOpportunities } from "./scan.js";
import { storageEnvNames } from "./store.js";

const app = express();
app.use(cors());
app.use(express.json());

// Every handler loads the saved state first and finishes saving before it replies
// (on Vercel, each request may run on a different short-lived server).
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    await engine.sync();
    const out = await fn(req, res);
    await engine.flush();
    res.json(out ?? { ok: true });
  } catch (e: any) {
    await engine.flush().catch(() => {});
    if (res.statusCode < 400) res.status(400);
    res.json({ error: e?.message ?? String(e) });
  }
};

app.get(
  "/api/status",
  wrap(async () => ({
    claude: hasClaude(),
    openai: hasOpenAI(),
    mode: "paper",
    storage: engine.storeKind(), // "redis" | "file" | "temp" (temp = Vercel without Redis: the bot can't stay on)
    serverless: Boolean(process.env.VERCEL), // true = the dashboard must send heartbeats to keep the bot ticking
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7), // deployed build, so open pages can offer a refresh
    // Only when storage isn't working: names (not values) of database settings the server can see.
    ...(engine.storeKind() === "temp" ? { storageEnvNames: storageEnvNames() } : {}),
  })),
);
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

// Opportunity scanner (logic in scan.ts, shared with the bot's auto-pick mode).
app.get("/api/scan", wrap(async (req) => scanOpportunities(String(req.query.chain ?? "all"), engine.roundTripCostPct())));

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

// While the dashboard is open it pings this every ~20 s. It only runs a bot step
// if one is due, and Claude is only asked on the bot's own schedule, so extra
// pings cost nothing.
app.post("/api/bot/heartbeat", wrap(async () => ({ ...(await engine.heartbeat()), running: engine.getState().bot.running })));

// One bot step. Locally a timer calls this; on Vercel (no long-lived process)
// a scheduler must hit it. Protected by CRON_SECRET when that is set.
app.get(
  "/api/bot/tick",
  wrap(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      res.status(401);
      throw new Error("Unauthorized");
    }
    // A scheduler calls this about once a minute; watch every 5 s for ~50 s.
    const r = await engine.watch(50_000);
    return { ok: true, ...r, running: engine.getState().bot.running };
  }),
);

// Vercel runs the exported app as a function; locally we listen on a port.
if (!process.env.VERCEL || process.env.FORCE_LISTEN) {
  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => {
    console.log(`API on http://localhost:${port}  | Claude: ${hasClaude() ? "on" : "off"}  ChatGPT: ${hasOpenAI() ? "on" : "off"}  | PAPER mode`);
  });
}

export default app;
