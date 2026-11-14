// The moving-average crossover module: the averages, the crossover rule exactly as specified,
// closed candles only, and the payload it hands to the decision model.
let cmcCalls = 0, lastLimit = "";
const nowS = () => Math.floor(Date.now() / 1000);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
// A market whose 5-minute closes fall for 90 candles and then climb: the fast average crosses up near the end.
const path = (i: number) => (i < 90 ? 2 - i * 0.01 : 1.1 + (i - 90) * 0.03);
globalThis.fetch = (async (input: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("dexscreener.com")) return json({ pairs: [{ chainId: "solana", dexId: "t", pairAddress: "PoolMA", baseToken: { address: "MintMA", symbol: "MAT", name: "Ma Test" }, priceUsd: String(path(119)), priceChange: {}, volume: {}, txns: {}, liquidity: { usd: 100000 }, marketCap: 1e6 }] });
  if (url.includes("coinmarketcap.com")) {
    cmcCalls++;
    lastLimit = new URL(url).searchParams.get("limit") ?? "";
    const n = 120;
    // rows: [open, high, low, close, volume, time ms, ...]; the newest candle started 100 s ago (still forming on a 5-minute chart)
    const rows = Array.from({ length: n }, (_, i) => { const p = path(i); return [p, p * 1.001, p * 0.999, p, 10, (nowS() - 100 - (n - 1 - i) * 300) * 1000, 3]; });
    return json({ data: rows, status: { error_code: "0" } });
  }
  return json({}, 404);
}) as typeof fetch;
const { movingAverage, crossOf, maCrossover, fetchMaCrossover, MA_FAST, MA_SLOW } = await import(new URL("../../src/macross.ts", import.meta.url).href);

let pass = 0, fail = 0;
const expect = (name: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`); };
const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

// An independent, slow way to work out the same things (by slicing), to check against.
const slowSma = (v: number[], n: number, i: number) => (i >= n - 1 ? v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n : null);
const slowEma = (v: number[], n: number, i: number) => { if (i < n - 1) return null; let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; for (let j = n; j <= i; j++) e = v[j] * (2 / (n + 1)) + e * (1 - 2 / (n + 1)); return e; };
const rule = (pf: number, ps: number, f: number, s: number) => (pf <= ps && f > s ? "BUY" : pf >= ps && f < s ? "SELL" : "HOLD");

expect("defaults are 20 and 50", [MA_FAST, MA_SLOW], [20, 50]);
const ramp = Array.from({ length: 60 }, (_, i) => i + 1);
expect("simple average of 1..60: last 20 and last 50", [movingAverage(ramp, 20).at(-1), movingAverage(ramp, 50).at(-1)], [50.5, 35.5]);
expect("no average until there are enough values", [movingAverage(ramp, 20)[18], movingAverage(ramp, 20)[19]], [null, 10.5]);

// The rule, including the edges: touching counts as "not above yet" before, and as no cross now.
expect("was below, now above -> BUY", crossOf(9, 10, 11, 10), "BUY");
expect("was equal, now above -> BUY", crossOf(10, 10, 10.1, 10), "BUY");
expect("was above, now below -> SELL", crossOf(11, 10, 9, 10), "SELL");
expect("was equal, now below -> SELL", crossOf(10, 10, 9.9, 10), "SELL");
expect("was below, now equal -> HOLD", crossOf(9, 10, 10, 10), "HOLD");
expect("above and still above -> HOLD", crossOf(11, 10, 12, 10), "HOLD");
expect("below and still below -> HOLD", crossOf(9, 10, 8, 10), "HOLD");

// Random price paths: at every candle the module must agree with the slow, independent version.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (const kind of ["sma", "ema"] as const) {
  let checked = 0, wrong = 0, buys = 0, sells = 0, lastWrong = 0;
  for (let trial = 0; trial < 40; trial++) {
    const v: number[] = [1];
    for (let i = 1; i < 260; i++) v.push(v[i - 1] * (1 + (rnd() - 0.5) * 0.06));
    let last: { signal: string; at: number } | null = null;
    for (let t = 0; t < v.length; t++) {
      const got = maCrossover(v.slice(0, t + 1), { kind });
      const avg = kind === "sma" ? slowSma : slowEma;
      const f = avg(v, 20, t), s = avg(v, 50, t), pf = t ? avg(v, 20, t - 1) : null, ps = t ? avg(v, 50, t - 1) : null;
      const ready = f !== null && s !== null && pf !== null && ps !== null;
      const want = ready ? rule(pf!, ps!, f!, s!) : "HOLD";
      if (ready && want !== "HOLD") last = { signal: want, at: t };
      checked++;
      if (got.signal !== want || got.ready !== ready || (ready && !(near(got.fast, f) && near(got.slow, s) && near(got.prevFast, pf) && near(got.prevSlow, ps)))) wrong++;
      if (ready && JSON.stringify(got.lastCross ? { signal: got.lastCross.signal, at: t - got.lastCross.candlesAgo } : null) !== JSON.stringify(last)) lastWrong++;
      if (want === "BUY") buys++;
      if (want === "SELL") sells++;
    }
  }
  expect(`${kind}: 40 random paths, every candle agrees with the independent check`, { checked, wrong, lastCrossWrong: lastWrong, sawBothSignals: buys > 20 && sells > 20 }, { checked: 10400, wrong: 0, lastCrossWrong: 0, sawBothSignals: true });
}

// Not enough history: 50 closes cannot give the slow average on two candles in a row.
expect("50 closes: not ready, HOLD", (({ signal, ready }) => ({ signal, ready }))(maCrossover(ramp.slice(0, 50))), { signal: "HOLD", ready: false });
expect("51 closes: ready", maCrossover(ramp.slice(0, 51)).ready, true);
let threw = "";
try { maCrossover(ramp, { fast: 50, slow: 20 }); } catch (e: any) { threw = e.message; }
expect("a fast average longer than the slow one is refused", threw, "The fast average must be shorter than the slow one");

// Closed candles only: a candle that is still forming is left out, so the signal cannot flicker.
const mk = (closes: number[], step: number, lastStart: number) => closes.map((c, i) => ({ time: lastStart - (closes.length - 1 - i) * step, open: c, high: c, low: c, close: c, volume: 1 }));
const flatThenUp = [...Array.from({ length: 70 }, () => 1), 1.5]; // the last close jumps: on it the fast average crosses above the slow one
const T = 1_800_000_000;
const forming = maCrossover(mk(flatThenUp, 300, T - 100), { stepSec: 300, nowSec: T }); // started 100 s ago: not closed
const closed = maCrossover(mk(flatThenUp, 300, T - 300), { stepSec: 300, nowSec: T }); // closed exactly now
expect("a forming candle is ignored", { signal: forming.signal, used: forming.used, price: forming.price }, { signal: "HOLD", used: 70, price: 1 });
expect("the same candle once closed gives the signal", { signal: closed.signal, used: closed.used, price: closed.price, last: closed.lastCross?.candlesAgo, trend: closed.trend }, { signal: "BUY", used: 71, price: 1.5, last: 0, trend: "up" });
expect("the payload names the averages", [closed.fastPeriod, closed.slowPeriod, closed.kind, Number(closed.fast!.toFixed(4)), Number(closed.slow!.toFixed(4)), Number(closed.spreadPct!.toFixed(2))], [20, 50, "sma", 1.025, 1.01, 1.49]);
console.log("     note:", closed.note);
console.log("     note:", maCrossover(mk([...flatThenUp, 1.5, 1.5, 1.5], 300, T - 300), { stepSec: 300, nowSec: T }).note);

// Fetching for a market: the last 100 candles, the forming one left out, and where they came from.
const r = await fetchMaCrossover("solana", "PoolMA", "5m");
expect("fetch: asks the way the chart does (300 candles, one shared request) and uses the newest 100 closed ones", { asked: lastLimit, used: r.used, source: r.source, tf: r.tf, ready: r.ready }, { asked: "300", used: 100, source: "CoinMarketCap", tf: "5m", ready: true });
expect("fetch: the falling-then-rising market reads as an up-cross behind us", { signal: r.signal, trend: r.trend, last: r.lastCross?.signal }, { signal: "HOLD", trend: "up", last: "BUY" });
console.log("     note:", r.note);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
