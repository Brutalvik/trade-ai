// Saves (or extends) candle fixtures for back-tests from the app's own data sources.
//
//   npm run backtest:fetch -- <pool address> [<pool address> ...] [--hours 24] [--tf 5s,1m,5m,15m,1h]
//   npm run backtest:fetch -- --all [--hours 24] [--tf 5s]      extend every fixture already saved
//
// --hours is how far back to go for 5-second and 1-minute candles (the longer timeframes take up
// to 1,000 candles). Requests are spaced out by the data layer; a busy source is waited out.
// Read-only public market data.
import { getCandles, getOlderCandles, getPair, type Candle, type Timeframe } from "../data.js";
import { loadFixtures, saveFixture, TF_SEC, type Fixture } from "./fixtures.js";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const hours = Number(opt("hours", "24"));
const tfs = opt("tf", "5s,1m,5m,15m,1h").split(",").filter((t) => TF_SEC[t]) as Timeframe[];
const saved = loadFixtures();
const pools = args.includes("--all") ? saved.map((f) => f.pool) : args.filter((a) => !a.startsWith("--") && a.length >= 32);
if (!pools.length) {
  console.error("Give one or more Solana pool addresses, or --all to extend the saved fixtures.");
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const merge = (a: Candle[], b: Candle[]) => [...new Map([...a, ...b].map((c) => [c.time, c])).values()].sort((x, y) => x.time - y.time);

for (const pool of pools) {
  try {
    const pair = await getPair("solana", pool);
    const old = saved.find((f) => f.pool === pool);
    const fx: Fixture = old ?? { symbol: pair.symbol, pool, savedAt: "", liquidityUsd: 0, roundTripPct: {}, candles: {} };
    fx.savedAt = new Date().toISOString().slice(0, 10);
    fx.liquidityUsd = Math.round(pair.liquidityUsd);
    for (const tf of tfs) {
      const want = tf === "5s" || tf === "1m" ? Math.floor(Date.now() / 1000) - hours * 3600 : 0; // how far back to go (0 = two pages)
      let all = merge(fx.candles[tf] ?? [], await getCandles("solana", pool, tf, 300, pair).catch(() => []));
      let pages = 0, fails = 0;
      // Page back from the oldest candle we have until the wanted time is covered or the history ends.
      while (all.length && (want ? all[0].time > want : pages < 2) && pages < 80) {
        try {
          const page = await getOlderCandles("solana", pool, tf, all[0].time, "CoinMarketCap");
          const older = page.candles.filter((c) => c.time < all[0].time);
          if (!older.length) break;
          all = merge(older, all);
          pages++;
          fails = 0;
        } catch {
          if (++fails > 4) break; // the source keeps refusing: keep what we have
          await sleep(20_000);
        }
      }
      fx.candles[tf] = all;
      console.log(`${pair.symbol.padEnd(10)} ${tf.padEnd(3)} ${String(all.length).padStart(6)} candles${all.length ? `, ${((all[all.length - 1].time - all[0].time) / 3600).toFixed(1)} h` : ""}${pages ? ` (+${pages} pages)` : ""}`);
    }
    console.log(`saved ${saveFixture(fx)}`);
  } catch (e: any) {
    console.log(`${pool.slice(0, 8)}: ${String(e?.message ?? e).slice(0, 120)}`);
  }
}
process.exit(0);
