# trade-ai — NEXUS//TRADE

An AI-assisted crypto trading dashboard. Claude analyzes a token's live candles and calls **BUY** only when the reward clearly beats the risk after fees. An auto-pilot bot can then trade the signal for you. ChatGPT can be switched on as a second opinion (`ENABLE_OPENAI=true`); then both models must agree before a BUY.

> **Paper mode only (for now).** Every trade is simulated with realistic fees and slippage. No real money moves. See [Going live](#going-live) below.

## Features

- **Live candlestick chart** (1-second to 1-day, with 1s and 5s charts updating every few seconds) with EMA 9/21, volume, AI entry/take-profit/stop lines, and markers for bot trades
- **AI signal**: Claude (optionally plus ChatGPT) gives entry, take-profit, stop, *buy-by* and *sell-by* times, confidence, and their reasoning
- **Manual trading**: buy and sell any token at the live price
- **Auto-pilot bot**: trades the coin on screen, or **auto-picks** the best coin each round. Safe / Balanced / Aggressive presets or your own Custom numbers. How it works:
  - **Claude sees several timeframes** for every plan: 5-second candles (last ~5 minutes, for precise timing), 5-minute (~5 hours, support and resistance), 1-hour (~2 days, the trend) and 1-day (~a month, the big picture), each with indicators.
  - **Claude writes a plan of standing orders** rather than one-off calls: *buy now*, *buy the dip* (e.g. "if it dips to $0.96 and holds 60 s"), or *buy the breakout* (e.g. "if it breaks above $1.07 with 1.5× normal volume"). Each order has an exit price, a target, a time limit and Claude's **win chance** (the odds it reaches the target before the exit price); the plan has cancel levels and an expiry. Orders are only used if they make money on average after fees (win chance × gain − loss chance × loss > 0), their gain is at least their loss, and their win chance meets your minimum. When a trigger is reached but an order is skipped, the log says why.
  - **The bot carries the plan out on its own**, checking prices every 5 seconds (free) using 5-second candles, so even a brief dip or spike between checks counts. A dip order fills at its trigger price like a limit order; stops sell at the stop price, or lower if the price fell straight through. Optionally ("Wait for the price to hold before buying") it waits the few seconds Claude suggests first. Sells are always instant.
  - **Exits:** sells at Claude's exit price; once up enough, the stop moves to break-even after fees; at Claude's target it **rides the trend with a trailing stop** (sells if the price falls a set % from its high); it sells after the time limit.
  - **Claude is asked when something happens**: after each trade, when the plan expires, or when the price leaves the plan's range, plus a slow backup timer. Never more than once every 2 minutes.
  - **Safety rules:** no dip buys while a coin is falling (down more than ~10% in an hour, or a 1-hour downtrend: a crash is not a dip); a cool-down after a losing trade before re-buying that coin, and the coin is skipped for the day after 2 losses in a row; a daily loss limit that stops new trades until midnight UTC. Claude is told about recent losses on the coin.
  - **Claude's track record** (Trade history tab): its average predicted win chance vs how often trades really reached the target.
  - **Sounds:** soft chimes for a bot buy, a profitable sell, and a losing sell; mute with the speaker button by PAPER MODE.
  - **Emergency stop:** sells everything and switches off if the account falls past your limit.
- **Opportunities**: trending coins on all chains (or Solana / Base / Ethereum / BSC), each with a quick plan: buy below, sell at, exit if below, and buy-by / sell-by times (free, from the chart). "Ask Claude" gives a proper plan for any coin
- **Growth ladder**: progress from $10 toward $15 / $20 / $100 / $1,000
- Responsive layout: desktop, tablet and phone

## Settings and accounts

- **Settings** (wrench, top right): choose whether the bot stops by itself after one profitable trade (the default) or trades continuously, and see whether phone alerts are on.
- **Accounts:** sign up with a unique username, first and last name, email and password; sign in with username or email. Passwords are hashed with scrypt; sessions are signed, HTTP-only cookies that last 30 days. The profile (click your initials) shows your details and lets you reset your password, which signs out your other devices. Accounts are stored in the same Upstash Redis database, so no extra setup is needed. The paper account and bot are still shared by everyone using the site.

## New coins

The 🚀 New coins tab lists pools from minutes to 3 days old, each with a rug-risk level (LOW / MEDIUM / HIGH / REJECTED) and the reasons. Solana uses RugCheck (mint/freeze authority, creator rug history, holder concentration, locked liquidity); Base uses honeypot.is (can you sell, buy/sell tax). Open a coin to see its chart, get the AI's plan and trade it like any other coin; skip Rejected and High-risk ones.

## Limit orders

The Manual trade panel has Buy and Sell tabs, each with Now or At a price (limit). A limit buy spends a set amount when the price falls to your price; a limit sell sells 25/50/100% of your position when the price rises to yours. Orders are checked every 5 seconds even with the bot off (the scheduler keeps watching), fill like real limit orders, and send an in-app notification (and a phone alert if set up). Open orders show on the chart, in the panel and in the Positions tab, where you can cancel them.

## Taking profits

- **Profit lock:** once a trade is up the break-even amount, the stop follows the best (closing) price so the trade keeps at least 50% of its best gain.
- **Take half early:** the bot sells half once the price is 75% of the way to the AI's target (runs often stall just under resistance), then the rest rides with the profit lock and, past the target, a trailing stop.
- **Reachable targets:** the AI is told to set targets just below resistance.
- All adjustable in the bot panel's Settings (0 turns a rule off).

## Architecture

```
web/     React + Vite + TypeScript (UI only, talks to /api)
server/  Express + TypeScript (market data, AI, broker, bot)
```

All logic lives in the Express API, so a future **React Native** app can use the same endpoints.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/status` | Which AI keys are configured |
| GET | `/api/search?q=` | Find tokens/pools (DexScreener) |
| GET | `/api/pair/:chain/:pool` | Live price & stats |
| GET | `/api/candles/:chain/:pool?tf=5m` | OHLCV candles (GeckoTerminal) |
| GET | `/api/scan?chain=all` | Trending coins (`all`, `solana`, `base`, `ethereum`, `bsc`) with a quick buy/sell plan |
| POST | `/api/analyze` | `{chain, pool, tf}` → AI signal and final decision |
| GET | `/api/state` | Cash, positions, trades, equity, bot status and log |
| POST | `/api/trade` | `{side:"BUY", chain, pool, usd}` or `{side:"SELL", chain, pool, positionId, fraction}` |
| POST | `/api/bot/start` / `/api/bot/stop` | Control the auto-pilot (`pick: "this"` or `"auto"`, `autoChain`) |
| POST | `/api/bot/heartbeat` | Sent by an open dashboard every ~20 s on Vercel: watches every 5 s for ~18 s |
| GET | `/api/bot/tick` | For a scheduler (needs `Authorization: Bearer $CRON_SECRET`): watches every 5 s for ~50 s |
| POST | `/api/settings` | `{feePct, slippagePct}` |
| POST | `/api/reset` | `{startCash}` resets the paper account |

## Run it

```bash
npm install && npm run setup
cp server/.env.example server/.env   # then add your keys
npm run dev
```

Open http://localhost:5173. The API runs on http://localhost:8787.

Keys go in `server/.env` (git ignores this file):

- `ANTHROPIC_API_KEY`: from console.anthropic.com
- Optional: `CLAUDE_MODEL` (default `claude-opus-5-5`)
- Optional, off by default: `ENABLE_OPENAI=true` with `OPENAI_API_KEY` (from platform.openai.com) adds ChatGPT as a second opinion; `OPENAI_MODEL` defaults to `gpt-5`

## Deploy to Vercel

`vercel.json` deploys this repo as one Vercel project with two services:

- `web` (Vite) is public at `/`
- `server` (Express) is public at `/api/*` and receives the full `/api/...` path

The browser calls `/api` on the same domain, so the services don't call each other directly and need no bindings. Add `ANTHROPIC_API_KEY` and `CRON_SECRET` in the Vercel project's environment variables. Run `vercel dev` to test both services together.

### Keeping the bot on, on Vercel

Vercel runs the API as short-lived copies that don't share memory or disk, so two things are needed:

**1. Permanent storage (required).** Without it the bot and paper account reset, and the app shows a yellow warning.
1. In your Vercel project, open **Storage → Create Database → Upstash (Redis)**, pick the free plan, and connect it to this project.
2. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the project. (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` also work.)
3. Redeploy.

**2. Something to wake the bot.**
- While the dashboard is open, it does this itself every 20 s, and the bot checks prices every 5 seconds.
- To keep trading with the tab closed, use a free scheduler such as cron-job.org. Have it call `GET https://<your-site>/api/bot/tick` every minute with the header `Authorization: Bearer <your CRON_SECRET>`. Each call watches every 5 s for about 50 s.

Storage use: while it's holding or about to buy a coin, the bot reads the saved state every 5 seconds (so a Stop from the dashboard always wins). That's about 720 Redis reads per hour of active watching. Check that against your Upstash plan's monthly allowance. When there's nothing to watch, it only does a quick check per wake-up.

### Phone alerts (optional)

Get a message for every bot buy and sell, protected sells, the daily loss limit, the emergency stop, and a daily summary after midnight UTC. Pick one, add its settings in Vercel (Settings → Environment Variables), then redeploy:

- **ntfy** (easiest, no account): install the ntfy app, subscribe to a long random topic name (e.g. `nexus-7f3k2m9q`), and set `NTFY_TOPIC` to that name. Anyone who knows the topic can read it, so make it hard to guess.
- **Telegram** (private): create a bot with @BotFather to get `TELEGRAM_BOT_TOKEN`, send your bot any message, then get your chat id from `https://api.telegram.org/bot<token>/getUpdates` and set `TELEGRAM_CHAT_ID`.

The Settings popup (wrench, top right) shows whether alerts are on.

## Data sources

FOMO (fomo.family) doesn't offer a public trading or data API. Its tokens are ordinary on-chain Solana tokens, though, so this app reads the same pools from public sources. Live prices and search come from DexScreener (free, no key).

Candles come from the first source that answers:

1. **CoinMarketCap** (primary): candles by token address, free with no key, including 1-second and 5-second candles. Its free access allows roughly one request per second, so the server spaces its calls 1.1 s apart and shares fresh results between viewers.
2. **GeckoTerminal**: candles for the exact pool, 1 minute and up, free, about 30 calls a minute (shared per IP address).
3. **Coinbase, then OKX**: exchange candles for listed coins (SOL, BONK, WIF…).
4. **The last candles that loaded**, so the chart doesn't go blank.

Token-level sources (CoinMarketCap, the exchanges) are only used when their latest price matches the pool's live price and the data is current, so a copycat token can't borrow a real coin's chart. After a rate-limit reply, the server skips that source for a short while. The scanner never uses CoinMarketCap, so its burst of requests can't eat the allowance the live chart needs. The chart legend shows which source is in use, in amber when it's a backup.

Small coins only get a 1-second candle in seconds when someone trades, so their 1s chart has gaps. That's real, not missing data.

## Important: realistic expectations

- **No system can guarantee "no loss".** Small-cap tokens can drop 50% in minutes or be rugged. The bot reduces risk with stops, a break-even lock and a kill-switch. It cannot remove the risk.
- **Fees matter a lot at $10.** With a 1% fee and 0.5% slippage on each side, a round trip costs about 3%, so the token has to rise more than 3% just to break even.
- **AI calls cost money too.** Each analysis is a paid Claude call, and on a $10 account that can be a real share of your profit. Keep the AI check interval long (15 min or more).
- Run it in paper mode for a while and look at the win rate in *Trade history* before you consider real funds.

## Going live

To trade real funds, you'd add a `LiveBroker` beside the paper `buy`/`sell` in `server/src/engine.ts`. On Solana that means swapping through Jupiter and signing with a wallet whose key stays on the server and never reaches the browser. Use a dedicated wallet holding only what you can afford to lose. FOMO has no trading API, so live trades would happen in a separate wallet, not inside the FOMO app.
