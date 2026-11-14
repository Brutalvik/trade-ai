// The chart's data source must not hop: when CoinMarketCap is briefly busy, the server keeps
// answering with CoinMarketCap's last candles instead of another source's (different) prices.
let cmcOk = true;
const now = () => Math.floor(Date.now() / 1000);
const cmcRows = (base: number) => Array.from({ length: 300 }, (_, i) => [base, base * 1.01, base * 0.99, base, 10, (now() - (299 - i) * 60) * 1000, 3]);
const gtRows = (base: number) => Array.from({ length: 300 }, (_, i) => [now() - i * 60, base, base * 1.01, base * 0.99, base, 10]);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("dexscreener.com")) return json({ pairs: [{ chainId: "solana", dexId: "t", pairAddress: "PoolAAA", baseToken: { address: "MintAAA", symbol: "TST", name: "Test" }, priceUsd: "1.00", priceChange: {}, volume: {}, txns: {}, liquidity: { usd: 100000 }, marketCap: 1e6 }] });
  if (url.includes("coinmarketcap.com")) return cmcOk ? json({ data: cmcRows(1.0), status: { error_code: "0" } }) : json({ status: { error_message: "rate limited" } }, 429);
  if (url.includes("geckoterminal.com")) return json({ data: { attributes: { ohlcv_list: gtRows(1.04) } } }); // the same coin, priced 4% apart
  return json({}, 404);
}) as typeof fetch;
const { getCandlesWithSource, getOlderCandles } = await import(new URL("../../src/data.ts", import.meta.url).href);
let pass = 0, fail = 0;
const expect = (name: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`); };
const brief = (r: any) => ({ source: r.source, origin: r.origin, lastClose: r.candles.at(-1)?.close });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

expect("first load: CoinMarketCap", brief(await getCandlesWithSource("solana", "PoolAAA", "1m")), { source: "CoinMarketCap", origin: "CoinMarketCap", lastClose: 1 });
cmcOk = false;
await sleep(21_000); // let the 1-minute cache run out, so the next call really asks again
expect("CoinMarketCap busy a moment later: its own last candles, not another source's", brief(await getCandlesWithSource("solana", "PoolAAA", "1m")), { source: "cached", origin: "CoinMarketCap", lastClose: 1 });
// a coin/timeframe that has never loaded from CoinMarketCap has nothing to keep: the other source is used
expect("first load while CoinMarketCap is busy: the other source", brief(await getCandlesWithSource("solana", "PoolAAA", "5m")), { source: "GeckoTerminal", origin: "GeckoTerminal", lastClose: 1.04 });
// history is only taken from the source the chart is on
const older = await getOlderCandles("solana", "PoolAAA", "5m", now() - 3600, "GeckoTerminal");
expect("older candles for a GeckoTerminal chart come from GeckoTerminal", { source: older.source, n: older.candles.length > 0 }, { source: "GeckoTerminal", n: true });
let refused = "";
try { await getOlderCandles("solana", "PoolAAA", "1m", now() - 3600, "CoinMarketCap"); } catch (e: any) { refused = /No older candles right now/.test(e.message) ? "refused" : e.message; }
expect("older candles for a CoinMarketCap chart are not taken from another source while it is busy", refused, "refused");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
