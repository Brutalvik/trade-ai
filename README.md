# trade-ai — NEXUS//TRADE

An AI-assisted crypto trading dashboard. Claude analyzes a token's live candles and calls **BUY** only when the reward clearly beats the risk after fees. An auto-pilot bot can then trade the signal for you. ChatGPT can be switched on as a second opinion (`ENABLE_OPENAI=true`); then both models must agree before a BUY.

> **Paper mode only (for now).** Every trade is simulated with realistic fees and slippage. No real money moves. See [Going live](#going-live) below.

## Features

- **Live candlestick chart** (1-second to 1-day, with 1s and 5s charts updating every few seconds) with EMA 9/21, volume, AI entry/take-profit/stop lines, and markers for bot trades
- **AI signal**: Claude (optionally plus ChatGPT) gives entry, take-profit, stop, *buy-by* and *sell-by* times, confidence, and their reasoning
- **Manual trading**: buy and sell any token at the live price
- **Auto-pilot bot**: trades the coin on screen, or **auto-picks** the best coin each round (scans trending coins, asks Claude about the top 3, buys the one it's most sure about). Safe / Balanced / Aggressive presets or your own Custom numbers. It watches the price every second, plus
  - no chasing (it waits for the planned entry price)
  - a break-even stop once a trade is in profit, so a winner can't turn into a loss
  - a planned exit time
  - a drawdown kill-switch that sells everything and stops the bot
- **Opportunities**: trending coins on all chains (or Solana / Base / Ethereum / BSC), each with a quick plan: buy below, sell at, exit if below, and buy-by / sell-by times (free, from the chart). "Ask Claude" gives a proper plan for any coin
- **Growth ladder**: progress from $10 toward $15 / $20 / $100 / $1,000
- Responsive layout: desktop, tablet and phone

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
| POST | `/api/bot/heartbeat` | Sent by an open dashboard every ~20 s on Vercel: watches every second for ~18 s |
| GET | `/api/bot/tick` | For a scheduler (needs `Authorization: Bearer $CRON_SECRET`): watches every second for ~50 s |
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
- While the dashboard is open, it does this itself every 20 s, and the bot watches prices every second.
- To keep trading with the tab closed, use a free scheduler such as cron-job.org. Have it call `GET https://<your-site>/api/bot/tick` every minute with the header `Authorization: Bearer <your CRON_SECRET>`. Each call watches every second for about 50 s.

Storage use: while it's holding or about to buy a coin, the bot reads the saved state once a second (so a Stop from the dashboard always wins). That's about 3,600 Redis reads per hour of active watching. Check that against your Upstash plan's monthly allowance. When there's nothing to watch, it only does a quick check per wake-up.

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
