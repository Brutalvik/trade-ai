import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { hasClaude, hasOpenAI } from "./ai.js";
import { getCandlesWithSource, getPair, searchPairs, type Timeframe } from "./data.js";
import * as engine from "./engine.js";
import { scanOpportunities } from "./scan.js";
import { scanNewCoins, type NewCoinChain } from "./newcoins.js";
import { storageEnvNames } from "./store.js";
import { alertChannel } from "./alerts.js";
import { waitUntil } from "@vercel/functions";
import * as auth from "./auth.js";
import * as history from "./audit.js";
import * as privy from "./privy.js";
import { rpcHealth, walletView } from "./wallet.js";
import * as live from "./live.js";
import { coinList } from "./lists.js";
import { botLimit, can, planOf, publicPlans, TOKEN_PACKS, YEARLY_MONTHS_PAID, type Permission } from "./plans.js";

const app = express();
app.use(cors());
app.use(express.json());

// Every handler loads the saved state first and finishes saving before it replies
// (on Vercel, each request may run on a different short-lived server).
// Each request runs inside the signed-in user's own paper account (signed out: an empty one).
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  const a = await auth.requestAuth(req).catch(() => null);
  await engine.withAccount(a?.key ?? null, async () => {
    try {
      await engine.ensureMigrated();
      await engine.sync();
      const out = await fn(req, res);
      await engine.flush();
      res.json(out ?? { ok: true });
    } catch (e: any) {
      await engine.flush().catch(() => {});
      if (res.statusCode < 400) res.status(400);
      res.json({ error: e?.message ?? String(e) });
    }
  }, a ? { plan: a.plan, role: a.role } : undefined);
};

app.get(
  "/api/status",
  wrap(async (req) => ({
    claude: hasClaude(),
    openai: hasOpenAI(),
    mode: "paper",
    storage: engine.storeKind(), // "redis" | "file" | "temp" (temp = Vercel without Redis: the bot can't stay on)
    serverless: Boolean(process.env.VERCEL), // true = the dashboard must send heartbeats to keep the bot ticking
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7), // deployed build, so open pages can offer a refresh
    alerts: alertChannel(), // "telegram" | "ntfy" | null
    privyAppId: privy.privyAppId(), // public: the page uses it to load the wallet SDK
    activeAccounts: (await engine.activeAccounts().catch(() => [])).length, // bots / orders the scheduler keeps watching
    solanaRpc: await rpcHealth(req.query.rpc === "1"), // "custom" (e.g. Helius) or "public"; ?rpc=1 also pings it
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
    // One candle per time, oldest first (sources can overlap when merged from a cache).
    const byTime = new Map<number, (typeof r.candles)[number]>();
    for (const c of r.candles) byTime.set(c.time, c);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }),
);

// Opportunity scanner (logic in scan.ts, shared with the bot's auto-pick mode).
app.get("/api/scan", wrap(async (req) => scanOpportunities(String(req.query.chain ?? "all"), engine.roundTripCostPct())));

// New coins: young pools with a rug-risk score (Solana via RugCheck, Base via honeypot.is).
app.get("/api/newcoins", wrap(async (req) => scanNewCoins(String(req.query.chain ?? "solana") as NewCoinChain)));
// Left sidebar coin lists (Solana): crypto, trending, held, graduated, bonding, community.
app.get("/api/lists/:kind", wrap(async (req) => coinList(String(req.params.kind))));

// RBAC: a route needs a signed-in user, and optionally a permission from their plan / role.
const NEEDS: Record<Permission, string> = {
  "trade.manual": "trading",
  "trade.limit": "limit orders",
  "trade.protect": "Protect this trade",
  "ai.analyze": "AI plans",
  "bot.run": "the AI bot",
  "bot.autopick": "auto-pick",
  "bot.risky": "risky mode",
  "admin.users": "managing users",
};
const guard = (perm: Permission | null, fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  const a = await auth.requestAuth(req).catch(() => null);
  if (!a) return void res.status(401).json({ error: "Sign in to use your paper account." });
  if (perm && !can(a.plan, a.role, perm))
    return void res.status(403).json(
      perm === "admin.users" ? { error: "Only admins can do this." } : { error: `Your ${planOf(a.plan).name} plan doesn't include ${NEEDS[perm]}. See Plans to upgrade.`, upgrade: true },
    );
  return fn(req, res);
};
const signedIn = (fn: (req: Request, res: Response) => Promise<unknown>) => guard(null, fn);
const needs = (perm: Permission, fn: (req: Request, res: Response) => Promise<unknown>) => guard(perm, fn);

// Plans (public) and admin: users' plans and roles.
app.get("/api/plans", (_req, res) => void res.json(publicPlans()));

// Permanent history: your activity (consents, bot, AI use, account) and every trade.
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
// Your real Solana wallet (read-only): SOL and token balances with USD values.
// Real trades from the user's own wallet (Jupiter): quote -> user signs in the browser -> execute.
const realUser = (a: NonNullable<Awaited<ReturnType<typeof auth.requestAuth>>>) => ({ key: a.key, plan: a.plan, solanaAddress: a.user.solanaAddress, tradeMode: a.user.tradeMode });
app.post("/api/real/quote", needs("trade.manual", async (req, res) => {
  try {
    res.json(await live.realQuote(realUser((await auth.requestAuth(req))!), req.body));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
}));
app.post("/api/real/execute", needs("trade.manual", async (req, res) => {
  try {
    res.json(await live.realExecute(realUser((await auth.requestAuth(req))!), req.body));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
}));
app.get("/api/real/trades", signedIn(async (req, res) => {
  res.json(await live.realTrades((await auth.requestAuth(req))!.key, num(req.query.limit, 50)));
}));
app.get("/api/wallet", signedIn(async (req, res) => {
  const a = (await auth.requestAuth(req))!;
  const address = a.user.solanaAddress;
  if (!address) return void res.json({ address: null, holdings: [], totalUsd: 0, updatedAt: Date.now() });
  try {
    res.json(await walletView(address, req.query.fresh === "1"));
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? String(e), address });
  }
}));

app.get("/api/activity", signedIn(async (req, res) => {
  const a = (await auth.requestAuth(req))!;
  res.json(await history.activity(a.key, num(req.query.before, 0), num(req.query.limit, 50)));
}));
app.get("/api/trades/history", signedIn(async (req, res) => {
  const a = (await auth.requestAuth(req))!;
  res.json(await history.tradeHistory(a.key, num(req.query.before, 0), num(req.query.limit, 200)));
}));
app.get("/api/admin/activity", needs("admin.users", async (req, res) => {
  res.json(await history.activity(String(req.query.username ?? ""), num(req.query.before, 0), num(req.query.limit, 50)));
}));
app.get("/api/plans/extras", (_req, res) => void res.json({ tokenPacks: TOKEN_PACKS, yearlyMonthsPaid: YEARLY_MONTHS_PAID }));
app.post("/api/admin/topup", needs("admin.users", async (req, res) => {
  try {
    const a = await auth.requestAuth(req);
    res.json(await auth.addTopup(String(req.body?.username ?? ""), Number(req.body?.tokens), a?.key));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
}));
app.get("/api/admin/users", needs("admin.users", async (_req, res) => void res.json(await auth.listUsers())));
app.post("/api/admin/users", needs("admin.users", async (req, res) => {
  try {
    const a = await auth.requestAuth(req);
    res.json(await auth.setUserAccess(String(req.body?.username ?? ""), req.body?.plan, req.body?.role, a?.key));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
}));

app.post("/api/analyze", needs("ai.analyze", wrap(async (req) => engine.runAnalysis(req.body.chain, req.body.pool, req.body.tf ?? "5m"))));

app.get(
  "/api/state",
  wrap(async (req) => {
    if (!engine.currentAccountKey()) return engine.emptyView();
    await engine.refreshPositionPrices();
    return engine.getState();
  }),
);

app.post(
  "/api/trade",
  needs("trade.manual", wrap(async (req) => {
    const { side, chain, pool, usd, positionId, fraction } = req.body;
    const pair = await getPair(chain, pool);
    if (side === "BUY") return engine.buy(pair, Number(usd), "manual", "Manual buy");
    return engine.sell(positionId, pair.priceUsd, Number(fraction ?? 1), "Manual sell");
  })),
);

app.post("/api/settings", signedIn(wrap(async (req) => engine.updateSettings(req.body))));

// Accounts (don't touch the trading state, so no sync/flush needed).
const authRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await fn(req, res));
  } catch (e: any) {
    if (res.statusCode < 400) res.status(400);
    res.json({ error: e?.message ?? String(e) });
  }
};
app.get("/api/auth/me", authRoute(auth.me));
// Privy custom auth: the public key set, and a short-lived token for the signed-in user.
app.get("/api/auth/jwks.json", async (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(await privy.jwks());
});
app.get("/api/auth/privy-token", authRoute(async (req, res) => {
  const a = await auth.requestAuth(req);
  if (!a) {
    res.status(401);
    throw new Error("Sign in first");
  }
  return privy.tokenFor(a.key);
}));
app.post("/api/auth/signup", authRoute(auth.signUp));
app.post("/api/auth/signin", authRoute(auth.signIn));
app.post("/api/auth/signout", authRoute(auth.signOut));
// Sign in with Privy (email code or Google): verify, then link or create our own user record.
app.post("/api/auth/privy-login", authRoute(auth.privyLogin));
app.post("/api/auth/privy-complete", authRoute(auth.privyCompleteProfile));
app.post("/api/auth/password", authRoute(auth.changePassword));
app.post("/api/auth/trade-mode", authRoute(auth.setTradeMode));
app.post("/api/reset", signedIn(wrap(async (req) => engine.reset(Number(req.body.startCash ?? 10)))));
app.post(
  "/api/bot/start",
  needs("bot.run", async (req, res) => {
    // Auto-pick and risky mode need their own permissions.
    const a = (await auth.requestAuth(req))!;
    if (req.body?.pick === "auto" && !can(a.plan, a.role, "bot.autopick"))
      return void res.status(403).json({ error: `Your ${planOf(a.plan).name} plan doesn't include auto-pick. See Plans to upgrade.`, upgrade: true });
    if (req.body?.allowRisky && !can(a.plan, a.role, "bot.risky"))
      return void res.status(403).json({ error: `Your ${planOf(a.plan).name} plan doesn't include risky mode. See Plans to upgrade.`, upgrade: true });
    const { botId, ...cfg } = req.body ?? {};
    const max = botLimit(a.plan, a.role);
    return wrap(async () => engine.startBot(cfg, String(botId ?? "1"), max))(req, res);
  }),
);
app.post("/api/bot/stop", signedIn(wrap(async (req) => engine.stopBot("Stopped by user", String(req.body?.botId ?? "1")))));
app.post("/api/bot/remove", signedIn(wrap(async (req) => engine.removeBot(String(req.body?.botId ?? "")))));
// "Continue anyway" past today's daily loss limit (the user confirmed the risk).
app.post("/api/bot/override-daily", needs("bot.run", wrap(async () => engine.overrideDailyLimit())));
app.post("/api/bot/reward-rule", needs("bot.run", wrap(async (req) => engine.setRewardRule(req.body?.on !== false, String(req.body?.botId ?? "1")))));
// "Protect this trade": trailing stop on a manual position ({ positionId, pct }; pct 0 removes it).
// Limit orders: { side: "BUY", chain, pool, symbol, price, usd } or { side: "SELL", positionId, price, fraction }.
app.post("/api/orders", needs("trade.limit", wrap(async (req) => engine.placeOrder(req.body ?? {}))));
app.post("/api/orders/cancel", signedIn(wrap(async (req) => engine.cancelOrder(String(req.body?.id ?? "")))));
app.post("/api/protect", needs("trade.protect", wrap(async (req) => engine.protectPosition(String(req.body.positionId), Number(req.body.pct ?? 0)))));

// While the dashboard is open it pings this every ~20 s. It only runs a bot step
// if one is due, and Claude is only asked on the bot's own schedule, so extra
// pings cost nothing.
app.post("/api/bot/heartbeat", wrap(async () => (engine.currentAccountKey() ? { ...(await engine.heartbeat()), running: engine.getState().bot.running } : { ticks: 0, reason: "signed out", running: false })));

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
    // A scheduler calls this about once a minute. Reply immediately (cron-job.org's free plan
    // waits at most 30 s) and keep watching every 5 s for ~55 s in the background; Vercel's
    // waitUntil keeps the function alive until that finishes.
    const work = engine.watchAll(55_000, "scheduler").catch((e) => console.error("[tick] watch failed:", e));
    waitUntil(work);
    return { ok: true, started: true, accounts: (await engine.activeAccounts()).length };
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
