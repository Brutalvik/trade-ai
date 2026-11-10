# trade-ai — NEXUS//TRADE

An AI-assisted crypto trading dashboard. Claude analyzes a token's live candles and calls **BUY** only when the reward clearly beats the risk after fees. An auto-pilot bot can then trade the signal for you. ChatGPT can be switched on as a second opinion (`ENABLE_OPENAI=true`); then both models must agree before a BUY.

> **Paper mode only (for now).** Every trade is simulated with realistic fees and slippage. No real money moves. See [Going live](#going-live) below.

## Features

- **Live candlestick chart** (1m–1d) with EMA 9/21, volume, AI entry/take-profit/stop lines, and markers for bot trades
- **AI signal**: Claude (optionally plus ChatGPT) gives entry, take-profit, stop, *buy-by* and *sell-by* times, confidence, and their reasoning
- **Manual trading**: buy and sell any token at the live price
- **Auto-pilot bot**: trades on the AI consensus, with
  - no chasing (it waits for the planned entry price)
  - a break-even stop once a trade is in profit, so a winner can't turn into a loss
  - a planned exit time
  - a drawdown kill-switch that sells everything and stops the bot
- **Opportunity scanner**: trending Solana pools ranked by a quick technical score (no AI cost)
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
| GET | `/api/scan` | Trending pools + technical score |
| POST | `/api/analyze` | `{chain, pool, tf}` → AI signal and final decision |
| GET | `/api/state` | Cash, positions, trades, equity, bot status and log |
| POST | `/api/trade` | `{side:"BUY", chain, pool, usd}` or `{side:"SELL", chain, pool, positionId, fraction}` |
| POST | `/api/bot/start` / `/api/bot/stop` | Control the auto-pilot |
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

**The bot on Vercel:** Vercel functions don't stay running, so the bot can't loop on a timer there. Something has to call `GET /api/bot/tick` (with `Authorization: Bearer $CRON_SECRET`) on a schedule. Also, paper-account state is saved to `/tmp`, which Vercel can wipe at any time. For a bot that runs reliably on Vercel, move the state to a database (Upstash Redis, Neon Postgres) and add a scheduler. To run the bot on a normal server, use `npm run dev` or `npm --prefix server start`; there it loops by itself.

## Data sources

FOMO (fomo.family) doesn't offer a public trading or data API. Its tokens are ordinary on-chain Solana tokens, though, so this app reads the same pools from public sources. Live prices and search come from DexScreener (free, no key).

Candles come from the first source that answers:

1. **GeckoTerminal**: free, exact pool, about 30 calls a minute. That limit is shared per IP address, which can bite on Vercel.
2. **CoinGecko on-chain API**: same pool data with your own quota. Only used if you set `COINGECKO_API_KEY`; a free demo key works. Set `COINGECKO_PLAN=pro` for a paid key.
3. **Coinbase, then OKX**: exchange candles for coins listed there (SOL, BONK, WIF…). Only used when the exchange price is within 3% of the pool's live price, so a copycat token can't borrow a real coin's chart.
4. **The last candles that loaded**, so the chart doesn't go blank.

After a rate-limit reply, the server skips that source for 30 seconds. The chart legend shows which source is in use, in amber when it's a backup.

## Important: realistic expectations

- **No system can guarantee "no loss".** Small-cap tokens can drop 50% in minutes or be rugged. The bot reduces risk with stops, a break-even lock and a kill-switch. It cannot remove the risk.
- **Fees matter a lot at $10.** With a 1% fee and 0.5% slippage on each side, a round trip costs about 3%, so the token has to rise more than 3% just to break even.
- **AI calls cost money too.** Each analysis is a paid Claude call, and on a $10 account that can be a real share of your profit. Keep the AI check interval long (15 min or more).
- Run it in paper mode for a while and look at the win rate in *Trade history* before you consider real funds.

## Going live

To trade real funds, you'd add a `LiveBroker` beside the paper `buy`/`sell` in `server/src/engine.ts`. On Solana that means swapping through Jupiter and signing with a wallet whose key stays on the server and never reaches the browser. Use a dedicated wallet holding only what you can afford to lose. FOMO has no trading API, so live trades would happen in a separate wallet, not inside the FOMO app.
