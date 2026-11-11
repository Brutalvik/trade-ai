import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, LineSeries, LineStyle, type AutoscaleInfo, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle, Trade } from "./api";

export type ChartLine = { price: number; color: string; title: string };

// The chart library throws (and blanks the page) on out-of-order or repeated times,
// which can happen when candles from two sources or a cache get merged. Sort and keep
// the latest candle for each time. O(n) when already ordered, which is the usual case.
function orderedCandles(c: Candle[]): Candle[] {
  let ok = true;
  for (let i = 1; i < c.length && ok; i++) ok = c[i].time > c[i - 1].time;
  if (ok) return c;
  const byTime = new Map<number, Candle>();
  for (const x of c) byTime.set(x.time, x);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// Price range for the visible candles that ignores freak ticks: anything far outside the
// spread of closing prices (Tukey fences on log prices) doesn't stretch the scale. Real
// big moves still fit, because the closes move with them.
function robustRange(c: Candle[], from: number, to: number): { minValue: number; maxValue: number } | null {
  const v = c.slice(from, to + 1);
  if (v.length < 5) return null;
  const logs = v.map((x) => Math.log(x.close)).sort((a, b) => a - b);
  const q = (p: number) => logs[Math.min(logs.length - 1, Math.floor(p * (logs.length - 1)))];
  const iqr = Math.max(q(0.75) - q(0.25), 0.02);
  const hiFence = Math.exp(q(0.75) + 3 * iqr), loFence = Math.exp(q(0.25) - 3 * iqr);
  let lo = Infinity, hi = -Infinity;
  for (const x of v) {
    lo = Math.min(lo, Math.max(x.low, loFence));
    hi = Math.max(hi, Math.min(x.high, hiFence));
  }
  const last = v.at(-1)!.close;
  return { minValue: Math.min(lo, last), maxValue: Math.max(hi, last) };
}

function emaLine(c: Candle[], period: number) {
  const k = 2 / (period + 1);
  let prev = c[0]?.close ?? 0;
  return c.map((x, i) => {
    prev = i === 0 ? x.close : x.close * k + prev * (1 - k);
    return { time: x.time as UTCTimestamp, value: prev };
  });
}

function precisionFor(p: number) {
  if (!p || p >= 1) return 4;
  return Math.min(12, -Math.floor(Math.log10(p)) + 3);
}

export function Chart({ candles, trades, lines: levelLines, seconds = false, viewKey = "" }: { candles: Candle[]; trades: Trade[]; lines: ChartLine[]; seconds?: boolean; viewKey?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<{ candle: ISeriesApi<"Candlestick">; vol: ISeriesApi<"Histogram">; e9: ISeriesApi<"Line">; e21: ISeriesApi<"Line">; markers: ISeriesMarkersPluginApi<Time> } | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const fitted = useRef("");
  const data = useRef<Candle[]>([]); // the candles on screen, for the price-scale fit

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7d8db5", fontFamily: "JetBrains Mono, ui-monospace, monospace", attributionLogo: false },
      grid: { vertLines: { color: "rgba(80,120,255,0.06)" }, horzLines: { color: "rgba(80,120,255,0.06)" } },
      rightPriceScale: { borderColor: "rgba(80,120,255,0.15)" },
      timeScale: { borderColor: "rgba(80,120,255,0.15)", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "rgba(0,240,255,0.4)", labelBackgroundColor: "#0b3a4a" }, horzLine: { color: "rgba(0,240,255,0.4)", labelBackgroundColor: "#0b3a4a" } },
    });
    const candle = c.addSeries(CandlestickSeries, {
      upColor: "#00f5a0", downColor: "#ff3d71", borderVisible: false, wickUpColor: "#00f5a0", wickDownColor: "#ff3d71",
      // Fit the price scale to the real trading range, so one bad tick doesn't flatten everything.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const r = original();
        const range = c.timeScale().getVisibleLogicalRange();
        const fit = range ? robustRange(data.current, Math.max(0, Math.floor(range.from)), Math.ceil(range.to)) : null;
        return fit && r ? { ...r, priceRange: fit } : r;
      },
    });
    const vol = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const e9 = c.addSeries(LineSeries, { autoscaleInfoProvider: () => null, color: "#00e5ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const e21 = c.addSeries(LineSeries, { autoscaleInfoProvider: () => null, color: "#b45cff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    s.current = { candle, vol, e9, e21, markers: createSeriesMarkers(candle, []) };
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      s.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.applyOptions({ timeScale: { secondsVisible: seconds } });
  }, [seconds]);

  useEffect(() => {
    if (!s.current || !candles.length) return;
    candles = orderedCandles(candles);
    data.current = candles;
    const prec = precisionFor(candles.at(-1)!.close);
    const pf = { type: "price" as const, precision: prec, minMove: Math.pow(10, -prec) };
    s.current.candle.applyOptions({ priceFormat: pf });
    s.current.e9.applyOptions({ priceFormat: pf });
    s.current.e21.applyOptions({ priceFormat: pf });
    s.current.candle.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    s.current.vol.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? "rgba(0,245,160,0.35)" : "rgba(255,61,113,0.35)" })));
    s.current.e9.setData(emaLine(candles, 9));
    s.current.e21.setData(emaLine(candles, 21));
    // Zoom to fit only when the coin or timeframe changes, so live updates
    // don't keep resetting a view you have scrolled or zoomed.
    if (fitted.current !== viewKey) {
      chart.current?.timeScale().fitContent();
      fitted.current = viewKey;
    }
  }, [candles]);

  useEffect(() => {
    if (!s.current || !candles.length) return;
    const first = candles[0].time;
    const step = candles.length > 1 ? candles[1].time - candles[0].time : 60;
    const markers: SeriesMarker<Time>[] = trades
      .map((t) => Math.floor(t.time / 1000))
      .map((sec, i) => ({ sec, t: trades[i] }))
      .filter(({ sec }) => sec >= first)
      .map(({ sec, t }) => ({
        time: (Math.floor(sec / step) * step) as UTCTimestamp,
        position: t.side === "BUY" ? ("belowBar" as const) : ("aboveBar" as const),
        color: t.side === "BUY" ? "#00f5a0" : "#ff3d71",
        shape: t.side === "BUY" ? ("arrowUp" as const) : ("arrowDown" as const),
        text: `${t.side}${t.source === "bot" ? " 🤖" : ""}`,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    s.current.markers.setMarkers(markers);
  }, [trades, candles]);

  useEffect(() => {
    const cs = s.current?.candle;
    if (!cs) return;
    lines.current.forEach((l) => cs.removePriceLine(l));
    lines.current = [];
    for (const l of levelLines) {
      if (l.price > 0) lines.current.push(cs.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.title }));
    }
  }, [JSON.stringify(levelLines), candles.length > 0]);

  // The chart is absolutely positioned inside a wrapper, so its size can't
  // feed back into the layout (that loop made it grow forever).
  return (
    <div className="chart-wrap">
      <div ref={el} className="chart" />
    </div>
  );
}
