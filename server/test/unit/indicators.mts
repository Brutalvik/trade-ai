// MACD and Bollinger Bands (src/indicators.ts), worked out by code so the AI reads real numbers
// and not its own arithmetic, and the strategy playbook every planner is given (src/ai.ts).
import { check, expect, finish } from "../check.mts";
const { macd, bollinger, snapshot, ema } = await import(new URL("../../src/indicators.ts", import.meta.url).href);
const { PLAYBOOK } = await import(new URL("../../src/ai.ts", import.meta.url).href);

const r = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const candles = (closes: number[]) => closes.map((c, i) => ({ time: 1_700_000_000 + i * 300, open: closes[i - 1] ?? c, high: Math.max(c, closes[i - 1] ?? c) * 1.001, low: Math.min(c, closes[i - 1] ?? c) * 0.999, close: c, volume: 1000 }));

// ---------- Bollinger Bands ----------
{
  const b = bollinger(Array.from({ length: 20 }, (_, i) => i + 1))!; // 1 to 20: average 10.5, standard deviation 5.766
  expect("the bands sit two standard deviations either side of the 20-close average", [r(b.mid), r(b.upper), r(b.lower)], [10.5, 22.033, -1.033]);
  expect("where the price sits between them (0 = lower band, 1 = upper), and how wide they are", [r(b.pctB), r(b.widthPct, 1)], [0.912, 219.7]);
  const flat = bollinger(Array(30).fill(5))!;
  expect("a price that has not moved: bands of no width, the price in the middle", [flat.widthPct, flat.pctB], [0, 0.5]);
  expect("a close above the upper band reads over 1", bollinger([...Array(19).fill(10), 11])!.pctB > 1, true);
  expect("fewer than 20 closes: no bands", bollinger([1, 2, 3]), null);
  expect("only the last 20 closes count", r(bollinger([999, 999, ...Array.from({ length: 20 }, (_, i) => i + 1)])!.mid), 10.5);
}

// ---------- MACD ----------
{
  expect("fewer than 35 closes: no MACD", macd(Array(34).fill(1)), null);
  const flat = macd(Array(60).fill(7))!;
  expect("a price that has not moved: everything at zero", [flat.macd, flat.signal, flat.hist], [0, 0, 0]);
  // Flat, then a steady rise, then a steady fall.
  const closes = [...Array(60).fill(100), ...Array.from({ length: 20 }, (_, i) => 101 + i), ...Array.from({ length: 25 }, (_, i) => 119 - 2 * i)];
  const at = (n: number) => macd(closes.slice(0, n))!;
  const up = at(70);
  check("ten candles into a rise: the MACD line is above its signal line and the gap is growing", up.macd > 0 && up.hist > 0 && up.hist > up.prevHist, up);
  expect("the MACD line is the 12-candle average minus the 26-candle one", r(up.macd, 6), r(ema(closes.slice(0, 70), 12).at(-1) - ema(closes.slice(0, 70), 26).at(-1), 6));
  const flip = Array.from({ length: closes.length - 81 }, (_, i) => 81 + i).find((n) => at(n).hist < 0 && at(n).prevHist >= 0)!;
  check("after the turn the histogram changes sign once: the line has crossed under its signal", flip > 81 && flip < 95 && at(flip + 3).hist < 0, { candle: flip });
  const s = snapshot(candles(closes.slice(0, flip)))!;
  expect("the snapshot the AI is given says so on that candle, and gives the histogram as a share of the price", [s.macdCross, s.macdRising, s.macdHistPct < 0, r(s.macdHistPct, 6) === r((at(flip).hist / closes[flip - 1]) * 100, 6)], ["down", false, true, true]);
  const s2 = snapshot(candles(closes.slice(0, 70)))!;
  expect("in the rise: above the signal line, growing, no cross on this candle; the price near the upper band", [s2.macdHistPct > 0, s2.macdRising, s2.macdCross, s2.bbPctB > 0.8, s2.bbWidthPct > 0], [true, true, undefined, true, true]);
  const short = snapshot(candles(Array.from({ length: 32 }, (_, i) => 100 + i)))!;
  expect("with 30 to 34 candles there are bands but no MACD yet", [short.macdHistPct, short.bbPctB !== undefined], [undefined, true]);
}

// ---------- The playbook ----------
{
  const names = ["Trend following", "Pullback in a trend", "Breakout", "Range trading", "Momentum", "Reversal", "scalping", "arbitrage", "RSI", "MACD", "Bollinger"];
  expect("the playbook names every strategy the planners are to know, and the three indicators", names.filter((n) => !PLAYBOOK.includes(n)), []);
  check("it says what does not fit this bot, and never promises a result", /never plan for less than the minimum profit/.test(PLAYBOOK) && /No strategy wins every time/.test(PLAYBOOK) && !/guarantee/i.test(PLAYBOOK), "");
  check("it stays short enough to be sent with every plan (under 600 words)", PLAYBOOK.split(/\s+/).length < 600, PLAYBOOK.split(/\s+/).length);
}
finish();
