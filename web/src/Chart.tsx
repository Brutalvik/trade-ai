import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, LineSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
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
    const candle = c.addSeries(CandlestickSeries, { upColor: "#00f5a0", downColor: "#ff3d71", borderVisible: false, wickUpColor: "#00f5a0", wickDownColor: "#ff3d71" });
    const vol = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const e9 = c.addSeries(LineSeries, { color: "#00e5ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const e21 = c.addSeries(LineSeries, { color: "#b45cff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
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
