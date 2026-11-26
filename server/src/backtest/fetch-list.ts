// Saves two days of candles for the coins an auto-pick agent could take right now (the scouts'
// list, in the order the agents use it) as a set of back-test fixtures in a folder of its own,
// with a universe.json beside them holding each coin's place and score on that list.
//
//   npm run backtest:list -- <folder> <how many coins> [hours, default 48]
//   npm run backtest:pick -- --dir <folder>          then compare ways of choosing among them
//
// Read-only public market data. Takes a while: a busy source is waited out.
import fs from "node:fs";
import path from "node:path";
import { AGENT_PASS, qualityGate, scanAgents, scoreCoin, tokenInfo } from "../agents.js";
import { costAt, costCurve } from "../costs.js";
import { cachedJson, fromDexScreener, getCandles, getOlderCandles, getPair, type Candle, type Timeframe } from "../data.js";
import { saveFixture, type Fixture } from "./fixtures.js";

const [dir, countArg, hoursArg] = process.argv.slice(2);
if (!dir || !(Number(countArg) > 0)) { console.error("Usage: npm run backtest:list -- <folder> <how many coins> [hours]"); process.exit(1); }
const HOURS = Number(hoursArg) || 48;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const merge = (a: Candle[], b: Candle[]) => [...new Map([...a, ...b].map((c) => [c.time, c])).values()].sort((x, y) => x.time - y.time);

// The agents' own order (engine.ts, autoCandidates): the coins that pass every scout check first,
// then the next best by score that are fit to trade.
const scan = await scanAgents();
const fitOk = (c: (typeof scan.coins)[number]) => qualityGate(c).ok;
const passing = scan.coins.filter((c) => !c.vetoes.length && c.total >= AGENT_PASS && fitOk(c));
const list = [...passing, ...scan.coins.filter((c) => !passing.includes(c) && fitOk(c)).sort((a, b) => b.total - a.total)].slice(0, Number(countArg) || 0);
console.log(`scouts: ${scan.scanned} scanned, ${passing.length} pass every check; taking the first ${list.length} an agent could take: ${list.map((c) => c.symbol).join(", ")}`);
fs.mkdirSync(dir, { recursive: true });

const universe: any[] = [];
const started = Date.now();
for (const [rank, c] of list.entries()) {
  try {
    const pairs = await cachedJson<any[]>(`https://api.dexscreener.com/tokens/v1/solana/${c.mint}`, 60_000).catch(() => []);
    const best = (pairs ?? []).filter((p) => p?.baseToken?.address === c.mint).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best) { console.log(`${c.symbol}: no market found`); continue; }
    const pool = fromDexScreener(best).pool;
    const pair = await getPair("solana", pool);
    const fx: Fixture = { symbol: pair.symbol, pool, savedAt: new Date().toISOString().slice(0, 10), liquidityUsd: Math.round(pair.liquidityUsd), roundTripPct: {}, candles: {} };
    const curve = await costCurve(pair.tokenAddress, pair.liquidityUsd, 1000);
    if (curve.source === "jupiter") fx.roundTripPct = { "100": costAt(curve, 100), "1000": costAt(curve, 1000) };
    const token = pair.tokenAddress ? await tokenInfo(pair.tokenAddress) : null;
    if (token) {
      const g = qualityGate(scoreCoin(token, null));
      fx.scouts = { at: fx.savedAt, ok: g.ok, quality: g.quality, reasons: g.reasons };
    }
    for (const tf of ["5s", "1m", "5m"] as Timeframe[]) {
      const want = tf === "5m" ? 0 : Math.floor(Date.now() / 1000) - HOURS * 3600;
      let all: Candle[] = [];
      for (let attempt = 0; attempt < 3 && !all.length; attempt++) {
        if (attempt) await sleep(8_000); // an empty first answer is usually the source being busy
        all = await getCandles("solana", pool, tf, 300, pair).catch(() => [] as Candle[]);
      }
      let pages = 0, fails = 0;
      while (all.length && (want ? all[0].time > want : pages < 3) && pages < 120) {
        try {
          const page = await getOlderCandles("solana", pool, tf, all[0].time, "CoinMarketCap");
          const older = page.candles.filter((x) => x.time < all[0].time);
          if (!older.length) break;
          all = merge(older, all);
          pages++;
          fails = 0;
        } catch {
          if (++fails > 3) break;
          await sleep(15_000);
        }
      }
      fx.candles[tf] = all;
    }
    const c5 = fx.candles["5s"] ?? [];
    saveFixture(fx, dir);
    universe.push({ rank, symbol: pair.symbol, scoutSymbol: c.symbol, mint: c.mint, pool, total: c.total, passes: passing.includes(c), vetoes: c.vetoes, timing: c.timing, quality: fx.scouts?.quality ?? null });
    fs.writeFileSync(path.join(dir, "universe.json"), JSON.stringify({ at: new Date().toISOString(), scanned: scan.scanned, coins: universe }, null, 1));
    console.log(`${String(rank + 1).padStart(2)} ${pair.symbol.padEnd(10)} score ${String(c.total).padStart(3)} | 5s ${String(c5.length).padStart(6)} candles${c5.length ? `, ${((c5[c5.length - 1].time - c5[0].time) / 3600).toFixed(1)} h` : ""} | 1m ${fx.candles["1m"]?.length ?? 0} | 5m ${fx.candles["5m"]?.length ?? 0} | round trip $1,000 ${fx.roundTripPct["1000"] ?? "?"}% (${curve.source}) | ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (e: any) {
    console.log(`${c.symbol}: ${String(e?.message ?? e).slice(0, 140)}`);
  }
}
console.log("done");
process.exit(0);
