// Limit orders you set by hand (src/engine.ts placeOrder / checkLimitOrders), against a fake market:
// a limit buy fills once the price is at or BELOW its limit (a lower price is better), a limit sell
// once the price is at or ABOVE its limit (a higher price is better), also when the price jumps
// past the limit between two checks, and at the better market price, never worse than the limit.
import { check, expect, finish } from "../check.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-limits-")));
delete process.env.VERCEL;
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|ANTHROPIC|OPENAI|CMC/.test(k)) delete process.env[k];

const POOL = "LimitPool1111";
let price = 0.16;
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const pair = () => ({ chainId: "solana", dexId: "test", pairAddress: POOL, baseToken: { address: "LimitMint1111", symbol: "LIM", name: "Limit Test" }, priceUsd: String(price), priceChange: { m5: 0, h1: 0, h24: 0 }, volume: { m5: 50_000, h1: 400_000, h24: 2e6 }, txns: { h1: { buys: 500, sells: 500 } }, liquidity: { usd: 500_000 }, marketCap: 5e6 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("api.dexscreener.com/latest/dex/pairs")) return json({ pairs: [pair()] });
  if (url.includes("api.dexscreener.com/tokens/v1/solana/")) return json([pair()]);
  if (url.includes("coinmarketcap.com")) {
    // Flat 5-second candles at the current price (the fake market moves all at once).
    const step = 5_000, last = Math.floor(Date.now() / step) * step;
    return json({ data: Array.from({ length: 60 }, (_, i) => [price, price, price, price, 500, last - (59 - i) * step, 5]), status: { error_code: "0" } });
  }
  if (/jup\.ag|geckoterminal|birdeye/.test(url)) return new Response("{}", { status: 503 });
  return realFetch(input, init);
}) as typeof fetch;

const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
const coin = { chain: "solana", pool: POOL, symbol: "LIM" };
await engine.withAccount("limits", async () => {
  await engine.sync();
  engine.reset(10_000);
  // What the 5-second loop runs, 5 seconds on (the price and the 5-second candles are cached for
  // 0.9 and 4.5 seconds, so each check sees the new price, as the real loop does).
  const check5s = async () => { await new Promise((r) => setTimeout(r, 5_000)); await engine.guardProtected(); };
  const lastTrade = () => engine.getState().trades[0];
  const held = () => engine.getState().positions.find((p: any) => p.pool === POOL);

  // ---------- a limit buy at 0.1575 ----------
  engine.placeOrder({ side: "BUY", ...coin, price: 0.1575, usd: 100 });
  price = 0.16;
  await check5s();
  expect("limit buy at 0.1575, the price at 0.1600 (above it): not bought yet", [engine.getState().orders.length, held()], [1, undefined]);
  price = 0.15;
  await check5s();
  const b = lastTrade();
  expect("the price falls to 0.1500, below the limit: bought (a lower price is better than the limit)", [engine.getState().orders.length, b?.side, !!held()], [0, "BUY", true]);
  check("...at the lower market price (0.1500 plus slippage), never more than the 0.1575 limit", b.price <= 0.1575 && b.price < 0.152, b.price);

  // ---------- a limit sell at 0.1700 ----------
  engine.placeOrder({ side: "SELL", positionId: held().id, price: 0.17, fraction: 1 });
  price = 0.165;
  await check5s();
  expect("limit sell at 0.1700, the price at 0.1650 (below it): not sold yet", [engine.getState().orders.length, !!held()], [1, true]);
  price = 0.18;
  await check5s();
  const s = lastTrade();
  expect("the price rises to 0.1800, above the limit: sold (a higher price is better than the limit)", [engine.getState().orders.length, s?.side, held()], [0, "SELL", undefined]);
  check("...at the higher market price (0.1800 less slippage), never less than the 0.1700 limit", s.price >= 0.17 && s.price > 0.178, s.price);

  // ---------- a jump past the limit between two checks ----------
  price = 0.16;
  engine.placeOrder({ side: "BUY", ...coin, price: 0.1575, usd: 50 });
  price = 0.1; // far below the limit, with no price in between
  await check5s();
  const g = lastTrade();
  expect("the price jumps from 0.1600 straight to 0.1000: still bought, at about 0.10", [g.side, g.price < 0.102], ["BUY", true]);
  engine.placeOrder({ side: "SELL", positionId: held().id, price: 0.12, fraction: 1 });
  price = 0.2; // far above the limit
  await check5s();
  const j = lastTrade();
  expect("...and a sell at 0.12 when it jumps to 0.20: sold, at about 0.20", [j.side, j.price > 0.198], ["SELL", true]);

  // ---------- a limit already beaten when it is set ----------
  price = 0.15;
  engine.placeOrder({ side: "BUY", ...coin, price: 0.1575, usd: 50 });
  await check5s();
  expect("a limit buy at 0.1575 set while the price is already 0.1500: bought at the next check", [lastTrade().side, engine.getState().orders.length], ["BUY", 0]);
});
finish();
