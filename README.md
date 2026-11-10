# trade-ai — NEXUS//TRADE

An AI-assisted crypto trading dashboard. Claude and ChatGPT both analyze a token's live candles. A trade is called a **BUY** only when both models agree and the reward still beats the risk after fees. An auto-pilot bot can then trade the signal for you.

> **Paper mode only (for now).** Every trade is simulated with realistic fees and slippage. No real money moves. See [Going live](#going-live) below.

## Features

- **Live candlestick chart** (1m–1d) with EMA 9/21, volume, AI entry/take-profit/stop lines, and markers for bot trades
- **AI signal**: Claude + ChatGPT run in parallel and give entry, take-profit, stop, *buy-by* and *sell-by* times, confidence, and their reasoning
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
| POST | `/api/analyze` | `{chain, pool, tf}` → Claude + GPT signal and consensus |
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
- `OPENAI_API_KEY`: from platform.openai.com
- Optional: `CLAUDE_MODEL` (default `claude-opus-5-5`), `OPENAI_MODEL` (default `gpt-5`)

## Data sources

FOMO (fomo.family) doesn't offer a public trading or data API. Its tokens are ordinary on-chain Solana tokens, though, so this app reads the same pools from DexScreener and GeckoTerminal. Both are free and need no key. GeckoTerminal limits you to about 30 calls a minute, so the server throttles and caches its requests.

## Important: realistic expectations

- **No system can guarantee "no loss".** Small-cap tokens can drop 50% in minutes or be rugged. The bot reduces risk with stops, a break-even lock and a kill-switch. It cannot remove the risk.
- **Fees matter a lot at $10.** With a 1% fee and 0.5% slippage on each side, a round trip costs about 3%, so the token has to rise more than 3% just to break even.
- **AI calls cost money too.** Each analysis calls two models, and on a $10 account that can be a real share of your profit. Keep the AI check interval long (15 min or more).
- Run it in paper mode for a while and look at the win rate in *Trade history* before you consider real funds.

## Going live

To trade real funds, you'd add a `LiveBroker` beside the paper `buy`/`sell` in `server/src/engine.ts`. On Solana that means swapping through Jupiter and signing with a wallet whose key stays on the server and never reaches the browser. Use a dedicated wallet holding only what you can afford to lose. FOMO has no trading API, so live trades would happen in a separate wallet, not inside the FOMO app.
