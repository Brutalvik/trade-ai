import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { hasClaude, hasOpenAI } from "./ai.js";
import { getCandlesWithSource, getOlderCandles, getPair, searchPairs, type Timeframe } from "./data.js";
import { fetchMaCrossover, MA_FAST, MA_SLOW } from "./macross.js";
import * as engine from "./engine.js";
import { scanOpportunities } from "./scan.js";
import { scanNewCoins, type NewCoinChain } from "./newcoins.js";
import { storageEnvNames } from "./store.js";
import { alertChannel } from "./alerts.js";
import { waitUntil } from "@vercel/functions";
import * as auth from "./auth.js";
import * as history from "./audit.js";
import { logHistory } from "./botlog.js";
import { rpcHealth, walletView } from "./wallet.js";
import * as live from "./live.js";
import * as send from "./send.js";
import * as autopilot from "./autopilot.js";
import * as moonpay from "./moonpay.js";
import * as fx from "./fx.js";
import * as moonwallet from "./moonwallet.js";
import { balances as chainBalances, totalUsd as chainTotal } from "./chainbal.js";
import * as wallettx from "./wallettx.js";
import { searchCoins, coinList } from "./lists.js";
import { AGENT_PASS, scanAgents } from "./agents.js";
import { botLimit, can, planOf, publicPlans, TOKEN_PACKS, YEARLY_MONTHS_PAID, type Permission } from "./plans.js";

const app = express();
app.use(cors());

// MoonPay's messages about purchases (webhooks). Registered before the JSON reader: the signature
// is checked on the exact bytes MoonPay sent. A message is saved before it is acknowledged; one
// that could not be saved gets an error, so MoonPay sends it again (moonpay.ts).
app.post("/api/moonpay/webhook", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
  try {
    await engine.ensureStore();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const r = await moonpay.webhook(raw, req.headers);
    if (r.after) waitUntil(r.after());
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error("[moonpay] webhook not saved:", engine.shortError(e));
    res.status(503).json({ error: "Not saved; send it again." });
  }
});

app.use(express.json());

// Nothing that reads accounts or logins runs before the storage is ready: set up, and holding what
// was moved from the old database. A login looked up in a still-empty database would look like a
// stranger's, and a sign-up there would be overwritten by the move. Market data, the plans and the
// status page do not need the storage; the scheduler's call answers for itself.
const NO_STORE = /^\/api\/(status$|bot\/tick$|pair\/|candles\/|signal\/|agents$|search-coins$|lists\/|plans)/;
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/") || NO_STORE.test(req.path)) return next();
  try {
    await engine.ensureStore();
  } catch (e) {
    res.status(503).json({ error: engine.shortError(e) });
    return;
  }
  next();
});

// Every handler loads the saved state first and finishes saving before it replies
// (on Vercel, each request may run on a different short-lived server).
// Each request runs inside the signed-in user's own paper account (signed out: an empty one).
// Public market data (charts, coin info, coin lists): the same for everyone, so no account is
// loaded, and Vercel's edge caches it for a few seconds (then serves it stale while refreshing).
const publicData = (seconds: (req: Request) => number, fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    const s = seconds(req);
    res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${s}, stale-while-revalidate=${Math.max(60, s * 12)}`);
    res.json(out);
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? String(e) });
  }
};

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  // The storage first: who is signed in is read from it.
  try {
    await engine.ensureStore();
  } catch (e) {
    res.status(503).json({ error: engine.shortError(e) });
    return;
  }
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
      res.json({ error: engine.shortError(e) });
    }
  }, a ? { plan: a.plan, role: a.role } : undefined);
};

// Always answers, also when the storage does not: then it says what is wrong (storageError), so
// a dead database shows up here and in the app instead of as a bot that silently stopped.
app.get("/api/status", async (req, res) => {
  try {
    let storageError: string | undefined;
    const active = await engine
      .ensureMigrated()
      .then(() => engine.activeAccounts())
      .then((list) => list.length)
      .catch((e) => {
        storageError = engine.shortError(e);
        return null;
      });
    res.json({
      claude: hasClaude(),
      openai: hasOpenAI(),
      mode: "paper",
      storage: engine.storeKind(), // "supabase" | "redis" | "file" | "temp" (temp = Vercel without a database: the bot can't stay on)
      ...(storageError ? { storageError } : {}),
      serverless: Boolean(process.env.VERCEL), // true = the dashboard must send heartbeats to keep the bot ticking
      commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7), // deployed build, so open pages can offer a refresh
      alerts: alertChannel(), // "telegram" | "ntfy" | null
      activeAccounts: active, // bots / orders the scheduler keeps watching (null = the storage did not answer)
      solanaRpc: await rpcHealth(req.query.rpc === "1"), // "custom" (e.g. Helius) or "public"; ?rpc=1 also pings it
      storageStats: engine.storageStats(), // calls and bytes to the storage since this server copy started
      moonpay: moonpay.publicStatus(), // on or off and why (never a key; the publishable key is public by design)
      moonpayWallets: moonwallet.moonxStatus(), // the same for MoonPay's wallets
      autopilot: autopilot.autopilotConfig(), // the real-money auto-pilot: on, or why not
      node: process.versions.node, // MoonPay's wallet pre-generation needs Node 22 or later
      // Only when storage isn't working: names (not values) of database settings the server can see.
      ...(engine.storeKind() === "temp" || storageError ? { storageEnvNames: storageEnvNames() } : {}),
    });
  } catch (e) {
    res.status(500).json({ error: engine.shortError(e) });
  }
});
app.get("/api/search", wrap(async (req) => searchPairs(String(req.query.q ?? ""))));
// The agents' live scores for the busiest Solana coins (market data only, same for everyone).
app.get("/api/agents", publicData(() => 30, async () => {
  const s = await scanAgents();
  return { at: s.at, scanned: s.scanned, pass: AGENT_PASS, coins: s.coins.slice(0, 12) };
}));
app.get("/api/search-coins", publicData(() => 30, async (req) => searchCoins(String(req.query.q ?? ""))));
app.get("/api/pair/:chain/:pool", publicData(() => 5, async (req) => getPair(String(req.params.chain), String(req.params.pool))));
// Returns the candle array; the X-Candle-Source header says where it came from.
app.get(
  "/api/candles/:chain/:pool",
  publicData((req) => (Number(req.query.before) > 0 ? 300 : ["1s", "5s"].includes(String(req.query.tf)) ? 2 : String(req.query.tf) === "1m" ? 5 : 10), async (req, res) => {
    // ?before=<unix seconds>: the page of candles just older than that (the chart scrolling back).
    const before = Math.floor(Number(req.query.before));
    if (before > 0) {
      const from = typeof req.query.from === "string" && /^[A-Za-z]{3,20}$/.test(req.query.from) ? req.query.from : undefined;
      const page = await getOlderCandles(String(req.params.chain), String(req.params.pool), (req.query.tf as Timeframe) ?? "5m", before, from);
      const older = page.candles;
      res.setHeader("X-Candle-Source", "history");
      res.setHeader("X-Candle-Origin", page.source);
      const seen = new Map<number, (typeof older)[number]>();
      for (const c of older) seen.set(c.time, c);
      return [...seen.values()].sort((a, b) => a.time - b.time);
    }
    const r = await getCandlesWithSource(String(req.params.chain), String(req.params.pool), (req.query.tf as Timeframe) ?? "5m");
    res.setHeader("X-Candle-Source", r.source);
    res.setHeader("X-Candle-Origin", r.origin);
    if (r.note) res.setHeader("X-Candle-Note", r.note);
    // One candle per time, oldest first (sources can overlap when merged from a cache).
    const byTime = new Map<number, (typeof r.candles)[number]>();
    for (const c of r.candles) byTime.set(c.time, c);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }),
);

// The moving-average crossover signal for a coin's market (macross.ts): BUY, SELL or HOLD with
// both averages, from its newest closed candles. Optional: ?tf=1m|5m|15m|1h|4h|1d (default 5m),
// fast=20, slow=50, kind=sma|ema, candles=100.
app.get(
  "/api/signal/ma-crossover/:chain/:pool",
  publicData((req) => (String(req.query.tf) === "1m" ? 5 : 10), async (req) => {
    const tf = (["1m", "5m", "15m", "1h", "4h", "1d"].includes(String(req.query.tf)) ? String(req.query.tf) : "5m") as Timeframe;
    const whole = (v: unknown, fallback: number, lo: number, hi: number) => {
      const n = Math.floor(Number(v));
      return v !== undefined && Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
    };
    const fast = whole(req.query.fast, MA_FAST, 2, 200), slow = whole(req.query.slow, MA_SLOW, 3, 400);
    if (slow <= fast) throw new Error("slow must be larger than fast");
    return fetchMaCrossover(String(req.params.chain), String(req.params.pool), tf, { fast, slow, kind: req.query.kind === "ema" ? "ema" : "sma", candles: whole(req.query.candles, 100, slow + 2, 1000) });
  }),
);

// Opportunity scanner (logic in scan.ts, shared with the bot's auto-pick mode).
app.get("/api/scan", wrap(async (req) => scanOpportunities(String(req.query.chain ?? "all"), engine.roundTripCostPct())));

// New coins: young pools with a rug-risk score (Solana via RugCheck, Base via honeypot.is).
app.get("/api/newcoins", wrap(async (req) => scanNewCoins(String(req.query.chain ?? "solana") as NewCoinChain)));
// Left sidebar coin lists (Solana): crypto, trending, held, graduated, bonding, community.
app.get("/api/lists/:kind", publicData(() => 30, async (req) => coinList(String(req.params.kind))));

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
// ---------- The real-money auto-pilot (autopilot.ts) ----------
// Its agent's trades are copied with real money, within the customer's limits.
engine.onRealTrade(autopilot.onAgentTrade);
const ap = (fn: (a: Signed, req: Request) => Promise<unknown>) => signedIn(async (req, res) => {
  try {
    await engine.ensureStore();
    const a = (await auth.requestAuth(req))!;
    res.setHeader("Cache-Control", "no-store");
    res.json(await fn(a, req));
  } catch (e: any) {
    if (res.statusCode < 400) res.status(400);
    res.json({ error: e?.message ?? String(e) });
  }
});
app.get("/api/autopilot", ap((a) => autopilot.status(a.key)));
app.post("/api/autopilot/allow/start", ap((a) => autopilot.grantStart(a.key)));
app.post("/api/autopilot/allow/finish", ap((a, req) => autopilot.grantFinish(a.key, { email: a.user.email, moonxId: a.user.moonxId }, req.body ?? {})));
app.post("/api/autopilot/revoke", ap((a) => autopilot.revoke(a.key, { plan: a.plan, role: a.role })));
app.post("/api/autopilot/limits", ap((a, req) => autopilot.setLimits(a.key, req.body ?? {})));
app.post("/api/autopilot/start", ap((a) => autopilot.start(a.key, { plan: a.plan, role: a.role }, a.user)));
app.post("/api/autopilot/stop", ap((a) => autopilot.stop(a.key, "Stopped by you", { plan: a.plan, role: a.role })));

// Real trades from the user's own wallet (Jupiter): quote -> user signs in the browser -> execute.
// The wallet they trade from: their MoonPay wallet on file (MoonPay wallets on). The server decides;
// the quote names it, and the browser signs with that wallet only. A wallet from before MoonPay
// (Privy's) is never traded from: nothing in the app can sign for it any more.
type Signed = NonNullable<Awaited<ReturnType<typeof auth.requestAuth>>>;
async function tradingWallet(a: Signed): Promise<{ address: string; via: "moonpay" } | null> {
  if (!moonwallet.moonxStatus().on) return null;
  const w = await moonwallet.myWallet(a.key);
  return w ? { address: w.address, via: "moonpay" } : null;
}
const realUser = async (a: Signed) => ({ key: a.key, plan: a.plan, solanaAddress: (await tradingWallet(a))?.address ?? null, tradeMode: a.user.tradeMode });
// The balances of the wallet they trade from (the trade form shows them).
app.get("/api/real/wallet", signedIn(async (req, res) => {
  const w = await tradingWallet((await auth.requestAuth(req))!);
  if (!w) return void res.json({ address: null, via: null, holdings: [], totalUsd: 0, updatedAt: Date.now() });
  try {
    res.json({ ...(await walletView(w.address, req.query.fresh === "1")), via: w.via });
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? String(e), address: w.address, via: w.via });
  }
}));
// Sending crypto from the customer's own wallets (send.ts): built here, signed by them in the browser.
const walletRoute = (fn: (a: Signed, req: Request) => Promise<unknown>) => signedIn(async (req, res) => {
  try {
    if (!moonwallet.moonxStatus().on) throw new Error("Wallets are not switched on.");
    res.setHeader("Cache-Control", "no-store");
    res.json(await fn((await auth.requestAuth(req))!, req));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});
app.post("/api/wallet/send/solana/quote", walletRoute((a, req) => send.solanaQuote(a.key, req.body)));
app.post("/api/wallet/send/solana/execute", walletRoute((a, req) => send.solanaExecute(a.key, req.body)));
app.post("/api/wallet/send/tron/build", walletRoute((a, req) => send.tronBuild(a.key, req.body)));
app.post("/api/wallet/send/record", walletRoute((a, req) => send.recordSent(a.key, req.body)));
// The platform fee the next real trade pays, from the customer's plan (shown before they review it).
app.get("/api/real/fees", signedIn(async (req, res) => {
  const a = (await auth.requestAuth(req))!;
  res.setHeader("Cache-Control", "no-store");
  res.json(await live.platformFee(a.key, a.plan));
}));
app.post("/api/real/quote", needs("trade.manual", async (req, res) => {
  try {
    res.json(await live.realQuote(await realUser((await auth.requestAuth(req))!), req.body));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
}));
app.post("/api/real/execute", needs("trade.manual", async (req, res) => {
  try {
    res.json(await live.realExecute(await realUser((await auth.requestAuth(req))!), req.body));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
}));
app.get("/api/real/trades", signedIn(async (req, res) => {
  res.json(await live.realTrades((await auth.requestAuth(req))!.key, num(req.query.limit, 50)));
}));
// The customer's real-money transactions (buys, and later sells, swaps, sends, receives), newest
// first: only their own, and never the provider's raw record (wallettx.ts).
const txError = (res: Response, e: unknown) => void res.status(/not in the database yet/.test(String((e as Error)?.message)) ? 503 : 400).json({ error: (e as Error)?.message ?? String(e) });
app.get("/api/wallet/transactions", signedIn(async (req, res) => {
  try {
    const a = (await auth.requestAuth(req))!;
    const before = req.query.before ? num(req.query.before, 0) || null : null;
    res.setHeader("Cache-Control", "no-store");
    res.json({ transactions: await wallettx.myTransactions(a.key, before, num(req.query.limit, 50)), moonpay: moonpay.publicStatus() });
  } catch (e) {
    txError(res, e);
  }
}));
app.get("/api/wallet/transactions/:id", signedIn(async (req, res) => {
  try {
    const r = await wallettx.myTransaction((await auth.requestAuth(req))!.key, String(req.params.id));
    if (!r) return void res.status(404).json({ error: "No such transaction." });
    res.setHeader("Cache-Control", "no-store");
    res.json(r);
  } catch (e) {
    txError(res, e);
  }
}));
// Buying with a card or Apple Pay (MoonPay): the server starts the purchase with the customer's
// own wallet from its records, and links what MoonPay's frame reports only after asking MoonPay.
app.post("/api/moonpay/buy/start", signedIn(async (req, res) => {
  try {
    res.json(await moonpay.startBuy((await auth.requestAuth(req))!.key, req.body));
  } catch (e) {
    txError(res, e);
  }
}));
// The customer's MoonPay wallet: on file only after MoonPay's sign-in and the wallet's own
// signature are checked (moonwallet.ts). The balance is read from the blockchain.
// The customer's public address (MoonPay ties its links to it). Vercel sets x-real-ip itself (a
// visitor cannot set it), so it comes first; a header a visitor could send comes last.
const deviceIp = (req: Request) => String(req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim().replace(/^::ffff:/, "");
app.get("/api/moonpay/wallet", signedIn(async (req, res) => {
  try {
    const a = (await auth.requestAuth(req))!;
    const [wallet, all] = await Promise.all([moonwallet.myWallet(a.key), moonwallet.myWallets(a.key)]);
    const sandbox = moonpay.config().mode !== "live";
    res.setHeader("Cache-Control", "no-store");
    const [options, buyInto] = await Promise.all([moonpay.buyOptions().catch(() => null), moonpay.buyDestination(a.key, { solanaAddress: a.user.solanaAddress })]);
    res.json({ wallet, all, wallets: moonwallet.moonxStatus(), buying: moonpay.publicStatus(), options, buyInto, balance: wallet ? { sol: await moonwallet.solBalance(wallet.address, sandbox), network: sandbox ? "Solana test network (devnet)" : "Solana" } : null });
  } catch (e) {
    txError(res, e);
  }
}));
// What is in each of the account's wallets, network by network (chainbal.ts).
app.get("/api/moonpay/balances", signedIn(async (req, res) => {
  try {
    const a = (await auth.requestAuth(req))!;
    res.setHeader("Cache-Control", "no-store");
    const balances = await chainBalances(await moonwallet.myWallets(a.key), moonpay.config().mode !== "live", req.query.fresh === "1");
    res.json({ balances, ...chainTotal(balances) });
  } catch (e) {
    txError(res, e);
  }
}));
app.post("/api/moonpay/wallet/challenge", signedIn(async (req, res) => {
  try {
    res.json(await moonwallet.walletChallenge((await auth.requestAuth(req))!.key));
  } catch (e) {
    txError(res, e);
  }
}));
app.post("/api/moonpay/wallet/prove", signedIn(async (req, res) => {
  try {
    const a = (await auth.requestAuth(req))!;
    res.json({ wallet: await moonwallet.proveWallet(a.key, { email: a.user.email }, req.body ?? {}) });
  } catch (e) {
    txError(res, e);
  }
}));
app.post("/api/moonpay/session", signedIn(async (req, res) => {
  try {
    const a = (await auth.requestAuth(req))!;
    res.setHeader("Cache-Control", "no-store");
    res.json(await moonpay.createSession(a.key, a.user.email, deviceIp(req)));
  } catch (e) {
    txError(res, e);
  }
}));
// MoonPay's own payment window, shown in the app's modal: the server builds and signs the whole
// link; the modal then asks how the purchase is going (the server asks MoonPay).
app.post("/api/moonpay/buy/widget", signedIn(async (req, res) => {
  try {
    const a = (await auth.requestAuth(req))!;
    res.setHeader("Cache-Control", "no-store");
    res.json(await moonpay.widgetBuy(a.key, { solanaAddress: a.user.solanaAddress }, req.body ?? {}, deviceIp(req)));
  } catch (e) {
    txError(res, e);
  }
}));
app.post("/api/moonpay/buy/check", signedIn(async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await moonpay.checkBuy((await auth.requestAuth(req))!.key, String(req.body?.id ?? "")));
  } catch (e) {
    txError(res, e);
  }
}));
app.post("/api/moonpay/buy/link", signedIn(async (req, res) => {
  try {
    const r = await moonpay.linkBuy((await auth.requestAuth(req))!.key, String(req.body?.id ?? ""), String(req.body?.transactionId ?? ""));
    res.json({ ok: true, status: r.tx?.status ?? null });
  } catch (e) {
    txError(res, e);
  }
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
// What the account's agents made together, hour by hour (the last 31 days unless asked otherwise).
app.get("/api/bot/hours", signedIn(wrap(async (req) => {
  const now = Date.now();
  return engine.agentHours(num(req.query.from, now - 31 * 86_400_000), num(req.query.to, now));
})));
// The agents' log for a stretch of time, newest first, in pages (the last week is kept: botlog.ts).
// only=decisions: just the lines that decided something (bought, sold, stayed out and why...).
app.get("/api/bot/log", signedIn(async (req, res) => {
  const a = (await auth.requestAuth(req))!;
  try {
    const now = Date.now();
    res.setHeader("Cache-Control", "no-store");
    res.json(await logHistory(a.key, num(req.query.from, now - 86_400_000), num(req.query.to, now), num(req.query.limit, 500), now, req.query.only === "decisions"));
  } catch (e) {
    res.status(502).json({ error: engine.shortError(e) });
  }
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
    return engine.sellByUser(positionId, pair.priceUsd, Number(fraction ?? 1));
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
app.post("/api/auth/signup", authRoute(auth.signUp));
app.post("/api/auth/signin", authRoute(auth.signIn));
app.post("/api/auth/signout", authRoute(auth.signOut));
// Sign up and sign in with MoonPay (its wallet sign-in). Off until MoonPay's wallet keys are set.
app.post("/api/auth/moonpay-login", authRoute(auth.moonpayLogin));
app.post("/api/auth/moonpay-complete", authRoute(auth.moonpayCompleteProfile));
app.post("/api/moonpay/wallet/sync", authRoute(auth.moonpayWalletSync));
app.post("/api/auth/password", authRoute(auth.changePassword));
// Switching to Paper also stops the real auto-pilot (it sells what it holds first).
app.post("/api/auth/trade-mode", async (req, res) => {
  if (req.body?.mode === "paper") {
    const a = await auth.requestAuth(req).catch(() => null);
    if (a && (await autopilot.status(a.key).catch(() => null))?.on) await autopilot.stop(a.key, "Switched to Paper", { plan: a.plan, role: a.role }).catch((e) => console.error("[autopilot] stop on Paper:", e));
  }
  return authRoute(auth.setTradeMode)(req, res);
});
app.post("/api/auth/prefs", authRoute(auth.setPrefs));
// The currencies the app can show money in, with their rates against the US dollar (fx.ts).
app.get("/api/currencies", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ currencies: await fx.currencies() });
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? String(e) });
  }
});
app.post("/api/reset", signedIn(wrap(async (req) => engine.reset(Number(req.body.startCash ?? 10)))));
app.post(
  "/api/bot/start",
  needs("bot.run", async (req, res) => {
    // Auto-pick and risky mode need their own permissions.
    const a = (await auth.requestAuth(req))!;
    if ((req.body?.pick === "auto" || req.body?.pick === "agents") && !can(a.plan, a.role, "bot.autopick"))
      return void res.status(403).json({ error: `Your ${planOf(a.plan).name} plan doesn't include auto-pick. See Plans to upgrade.`, upgrade: true });
    if (req.body?.allowRisky && !can(a.plan, a.role, "bot.risky"))
      return void res.status(403).json({ error: `Your ${planOf(a.plan).name} plan doesn't include risky mode. See Plans to upgrade.`, upgrade: true });
    const { botId, ...cfg } = req.body ?? {};
    const max = botLimit(a.plan, a.role);
    return wrap(async () => engine.startBot(cfg, String(botId ?? "1"), max))(req, res);
  }),
);
// Several auto-pick agents at once: each takes the best coin on the scouts' list that is free,
// and chooses again after every trade. budgets = one budget per agent to start.
app.post(
  "/api/bot/start-auto",
  needs("bot.run", async (req, res) => {
    const a = (await auth.requestAuth(req))!;
    if (!can(a.plan, a.role, "bot.autopick")) return void res.status(403).json({ error: `Your ${planOf(a.plan).name} plan doesn't include auto-pick. See Plans to upgrade.`, upgrade: true });
    const { budgets, strict, botId: _none, ...cfg } = req.body ?? {};
    const max = botLimit(a.plan, a.role);
    return wrap(async () => engine.startAutoAgents(cfg, budgets, !!strict, max))(req, res);
  }),
);
app.post("/api/bot/stop", signedIn(wrap(async (req) => engine.stopBot("Stopped by user", String(req.body?.botId ?? "1")))));
app.post("/api/bot/remove", signedIn(wrap(async (req) => engine.removeBot(String(req.body?.botId ?? "")))));
// "Continue anyway" past today's daily loss limit (the user confirmed the risk).
// "I understand": the user switched a safety setting off. Kept in the activity log as proof.
app.post("/api/consent/setting-off", signedIn(async (req, res) => {
  const a = (await auth.requestAuth(req))!;
  const b = req.body ?? {};
  const setting = String(b.setting ?? "").slice(0, 40);
  const label = String(b.label ?? setting).slice(0, 80);
  if (!setting) return void res.status(400).json({ error: "Which setting?" });
  await history.audit(a.key, "consent.setting_off", `Accepted "I understand" and turned off: ${label}${b.botId ? ` (bot ${String(b.botId).slice(0, 2)})` : ""}`, {
    setting, label, botId: b.botId ? String(b.botId).slice(0, 2) : null,
    warningShown: String(b.warning ?? "").slice(0, 600),
    ip: String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || null,
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200),
    at: new Date().toISOString(),
  });
  res.json({ ok: true });
}));
app.post("/api/bot/override-daily", needs("bot.run", wrap(async () => engine.overrideDailyLimit())));
app.post("/api/bot/strong-mode", needs("bot.run", wrap(async (req) => engine.setStrongMode(req.body?.on !== false, String(req.body?.botId ?? "1")))));
app.post("/api/bot/reward-rule", needs("bot.run", wrap(async (req) => engine.setRewardRule(req.body?.on !== false, String(req.body?.botId ?? "1")))));
// An agent's coin quality gate: off = "trade this coin anyway" (the page records the consent first).
app.post("/api/bot/quality-gate", needs("bot.run", wrap(async (req) => engine.setQualityGate(req.body?.on !== false, String(req.body?.botId ?? "1")))));
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
app.get("/api/bot/tick", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    await engine.ensureMigrated();
    // A scheduler calls this about once a minute. Reply immediately (cron-job.org's free plan
    // waits at most 30 s) and keep watching every 5 s for the rest of the minute in the
    // background (engine.WATCH_MS; if the watch before it is still finishing, it waits for it);
    // Vercel's waitUntil keeps the function alive until that finishes.
    const work = engine.watchAll(engine.WATCH_MS, "scheduler").catch((e) => console.error("[tick] watch failed:", e));
    waitUntil(work);
    // Customers' MoonPay purchases that are not finished: asked about again (does nothing while MoonPay is not set up).
    waitUntil(moonpay.reconcile(15_000).catch((e) => console.error("[moonpay] check failed:", e?.message ?? e)));
    // The real auto-pilot: sales that did not go through are tried again; a pause for the day ends.
    waitUntil(autopilot.everyMinute().catch((e) => console.error("[autopilot] every minute:", e?.message ?? e)));
    res.json({ ok: true, started: true, accounts: (await engine.activeAccounts()).length });
  } catch (e) {
    // The storage is not answering. Said in a normal reply, not as a failed call: a scheduler
    // that sees failures for long enough switches the job off (cron-job.org after 25), and the
    // bot would then stay off after the storage is back. /api/status and the app show the problem.
    console.error("[tick] storage:", e);
    res.json({ ok: false, error: engine.shortError(e) });
  }
});

// Vercel runs the exported app as a function; locally we listen on a port.
if (!process.env.VERCEL || process.env.FORCE_LISTEN) {
  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => {
    console.log(`API on http://localhost:${port}  | Claude: ${hasClaude() ? "on" : "off"}  ChatGPT: ${hasOpenAI() ? "on" : "off"}  | PAPER mode`);
  });
}

export default app;
