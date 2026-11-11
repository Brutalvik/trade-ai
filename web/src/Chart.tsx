// Price chart (TradingView Lightweight Charts) with our own trading tools on top:
// indicators (EMA, SMA, Bollinger, VWAP, volume; RSI and MACD in their own panes), price or
// market-cap view, log / % / auto scale, range buttons, an OHLC legend on hover, a screenshot
// button, and drawing tools (trend line, horizontal / vertical line, rectangle, Fibonacci,
// ruler, text) saved per coin in this browser.
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, LineSeries, LineStyle, PriceScaleMode,
  type AutoscaleInfo, type CandlestickData, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi,
  type MouseEventParams, type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Candle, Trade } from "./api";

export type ChartLine = { price: number; color: string; title: string };

// ---------- data helpers ----------
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

type Pt = { time: UTCTimestamp; value: number };
const T = (t: number) => t as UTCTimestamp;
function ema(c: Candle[], period: number, pick: (x: Candle) => number = (x) => x.close): Pt[] {
  const k = 2 / (period + 1);
  let prev = c[0] ? pick(c[0]) : 0;
  return c.map((x, i) => ((prev = i === 0 ? pick(x) : pick(x) * k + prev * (1 - k)), { time: T(x.time), value: prev }));
}
function emaOf(v: number[], period: number) {
  const k = 2 / (period + 1);
  let prev = v[0] ?? 0;
  return v.map((x, i) => (prev = i === 0 ? x : x * k + prev * (1 - k)));
}
function sma(c: Candle[], period: number): Pt[] {
  const out: Pt[] = [];
  let sum = 0;
  c.forEach((x, i) => {
    sum += x.close;
    if (i >= period) sum -= c[i - period].close;
    if (i >= period - 1) out.push({ time: T(x.time), value: sum / period });
  });
  return out;
}
function bollinger(c: Candle[], period = 20, mult = 2) {
  const up: Pt[] = [], mid: Pt[] = [], lo: Pt[] = [];
  for (let i = period - 1; i < c.length; i++) {
    const w = c.slice(i - period + 1, i + 1).map((x) => x.close);
    const m = w.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / period);
    const t = T(c[i].time);
    mid.push({ time: t, value: m });
    up.push({ time: t, value: m + mult * sd });
    lo.push({ time: t, value: m - mult * sd });
  }
  return { up, mid, lo };
}
function vwap(c: Candle[]): Pt[] {
  let pv = 0, v = 0;
  return c.map((x) => {
    const tp = (x.high + x.low + x.close) / 3;
    pv += tp * (x.volume || 0);
    v += x.volume || 0;
    return { time: T(x.time), value: v > 0 ? pv / v : tp };
  });
}
function rsi(c: Candle[], period = 14): Pt[] {
  const out: Pt[] = [];
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i].close - c[i - 1].close;
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= period) {
      g += up / period;
      l += dn / period;
      if (i < period) continue;
    } else {
      g = (g * (period - 1) + up) / period;
      l = (l * (period - 1) + dn) / period;
    }
    out.push({ time: T(c[i].time), value: l === 0 ? 100 : 100 - 100 / (1 + g / l) });
  }
  return out;
}
function macd(c: Candle[]) {
  const closes = c.map((x) => x.close);
  const fast = emaOf(closes, 12), slow = emaOf(closes, 26);
  const line = closes.map((_, i) => fast[i] - slow[i]);
  const sig = emaOf(line, 9);
  const start = Math.min(26, c.length);
  return {
    line: c.slice(start).map((x, j) => ({ time: T(x.time), value: line[j + start] })),
    signal: c.slice(start).map((x, j) => ({ time: T(x.time), value: sig[j + start] })),
    hist: c.slice(start).map((x, j) => {
      const h = line[j + start] - sig[j + start];
      return { time: T(x.time), value: h, color: h >= 0 ? "rgba(0,245,160,0.55)" : "rgba(255,61,113,0.55)" };
    }),
  };
}

function precisionFor(p: number) {
  if (!p || p >= 1) return 4;
  return Math.min(12, -Math.floor(Math.log10(p)) + 3);
}
const compact = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(2);
};
const fmtVal = (v: number, mcap: boolean) => (mcap ? `$${compact(v)}` : v >= 1 ? v.toFixed(4) : v.toFixed(precisionFor(v)));

// ---------- indicators ----------
type IndKey = "vol" | "ema9" | "ema21" | "sma50" | "sma200" | "bb" | "vwap" | "rsi" | "macd";
const INDICATORS: { key: IndKey; label: string; hint: string; color: string }[] = [
  { key: "vol", label: "Volume", hint: "Traded volume per candle", color: "#5b6684" },
  { key: "ema9", label: "EMA 9", hint: "Fast exponential moving average", color: "#00e5ff" },
  { key: "ema21", label: "EMA 21", hint: "Slower exponential moving average", color: "#b45cff" },
  { key: "sma50", label: "SMA 50", hint: "50-candle simple moving average", color: "#ffc857" },
  { key: "sma200", label: "SMA 200", hint: "200-candle simple moving average (needs 200 candles)", color: "#ff8fab" },
  { key: "bb", label: "Bollinger Bands", hint: "20-candle average ± 2 standard deviations", color: "#7c9cff" },
  { key: "vwap", label: "VWAP", hint: "Volume-weighted average price over the loaded candles", color: "#ffa94d" },
  { key: "rsi", label: "RSI 14", hint: "Momentum 0-100 in its own pane: above 70 overbought, below 30 oversold", color: "#c084fc" },
  { key: "macd", label: "MACD 12/26/9", hint: "Trend momentum in its own pane", color: "#00e5ff" },
];
const IND_LS = "nexus-indicators";
const loadInd = (): Record<IndKey, boolean> => {
  const base = { vol: true, ema9: true, ema21: true, sma50: false, sma200: false, bb: false, vwap: false, rsi: false, macd: false };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(IND_LS) || "{}") };
  } catch {
    return base;
  }
};

// ---------- drawings ----------
type Tool = "cursor" | "trend" | "hline" | "vline" | "rect" | "fib" | "ruler" | "text" | "eraser";
type Anchor = { t: number; p: number }; // time (unix s, may be past the last candle) and price (in USD)
type Drawing = { id: string; kind: Exclude<Tool, "cursor" | "eraser">; a: Anchor; b?: Anchor; text?: string };
const TWO_CLICK: Tool[] = ["trend", "rect", "fib", "ruler"];
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ["#8a96b4", "#ff3d71", "#ffa94d", "#ffc857", "#00f5a0", "#00e5ff", "#8a96b4"];
const drawKeyLs = (k: string) => `nexus-draw:${k}`;
const loadDrawings = (k: string): Drawing[] => {
  try {
    return k ? JSON.parse(localStorage.getItem(drawKeyLs(k)) || "[]") : [];
  } catch {
    return [];
  }
};

// The drawings layer: a series primitive that paints every drawing (and the one being drawn).
class DrawLayer {
  drawings: Drawing[] = [];
  preview: Drawing | null = null;
  hidden = false;
  toXY: (a: Anchor) => { x: number; y: number } | null = () => null;
  private req: (() => void) | null = null;
  attached(p: { requestUpdate: () => void }) {
    this.req = p.requestUpdate;
  }
  detached() {
    this.req = null;
  }
  update() {
    this.req?.();
  }
  paneViews() {
    return [{ zOrder: () => "top" as const, renderer: () => ({ draw: (target: any) => target.useMediaCoordinateSpace((s: any) => this.paint(s.context as CanvasRenderingContext2D, s.mediaSize.width, s.mediaSize.height)) }) }];
  }
  private paint(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (this.hidden) return;
    for (const d of [...this.drawings, ...(this.preview ? [this.preview] : [])]) paintDrawing(ctx, d, this.toXY, W, H);
  }
}

function paintDrawing(ctx: CanvasRenderingContext2D, d: Drawing, toXY: (a: Anchor) => { x: number; y: number } | null, W: number, H: number) {
  const A = toXY(d.a);
  const B = d.b ? toXY(d.b) : null;
  if (!A) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.font = "11px JetBrains Mono, ui-monospace, monospace";
  const label = (txt: string, x: number, y: number, color: string, align: CanvasTextAlign = "left") => {
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  };
  const dot = (x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  };
  if (d.kind === "hline") {
    ctx.strokeStyle = "#ffc857";
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, A.y);
    ctx.lineTo(W, A.y);
    ctx.stroke();
    label(fmtPrice(d.a.p), W - 6, A.y - 4, "#ffc857", "right");
  } else if (d.kind === "vline") {
    ctx.strokeStyle = "#8a96b4";
    ctx.beginPath();
    ctx.moveTo(A.x, 0);
    ctx.lineTo(A.x, H);
    ctx.stroke();
  } else if (d.kind === "text") {
    ctx.font = "600 12px Inter, system-ui, sans-serif";
    label(d.text ?? "", A.x + 4, A.y + 4, "#e6f0ff");
    dot(A.x, A.y, "#e6f0ff");
  } else if (B) {
    if (d.kind === "trend") {
      ctx.strokeStyle = "#00e5ff";
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
      dot(A.x, A.y, "#00e5ff");
      dot(B.x, B.y, "#00e5ff");
    } else if (d.kind === "rect") {
      ctx.fillStyle = "rgba(0,229,255,0.08)";
      ctx.strokeStyle = "rgba(0,229,255,0.7)";
      ctx.fillRect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
      ctx.strokeRect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
    } else if (d.kind === "fib") {
      const x0 = Math.min(A.x, B.x), x1 = Math.max(W, Math.max(A.x, B.x));
      FIB.forEach((lv, i) => {
        const p = d.b!.p + (d.a.p - d.b!.p) * lv;
        const y = B.y + (A.y - B.y) * lv;
        ctx.strokeStyle = FIB_COLORS[i];
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        label(`${lv} (${fmtPrice(p)})`, x0 + 4, y - 3, FIB_COLORS[i]);
      });
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
    } else if (d.kind === "ruler") {
      const up = d.b!.p >= d.a.p;
      const col = up ? "0,245,160" : "255,61,113";
      ctx.fillStyle = `rgba(${col},0.12)`;
      ctx.strokeStyle = `rgba(${col},0.8)`;
      const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y), w = Math.abs(B.x - A.x), h = Math.abs(B.y - A.y);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      const pct = ((d.b!.p - d.a.p) / d.a.p) * 100;
      const mins = Math.round(Math.abs(d.b!.t - d.a.t) / 60);
      const txt = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%  ·  ${mins >= 1440 ? `${(mins / 1440).toFixed(1)}d` : mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`}`;
      const tw = ctx.measureText(txt).width + 12;
      const ly = up ? y - 22 : y + h + 4;
      ctx.fillStyle = `rgba(${col},0.9)`;
      ctx.fillRect(x + w / 2 - tw / 2, ly, tw, 18);
      label(txt, x + w / 2, ly + 13, "#04101c", "center");
    }
  }
  ctx.restore();
}
const fmtPrice = (p: number) => (p >= 1 ? p.toFixed(4) : p.toFixed(precisionFor(p)));

// Distance from point (x, y) to a drawing, for the eraser (px).
function hitDistance(d: Drawing, x: number, y: number, toXY: (a: Anchor) => { x: number; y: number } | null) {
  const A = toXY(d.a), B = d.b ? toXY(d.b) : null;
  if (!A) return Infinity;
  if (d.kind === "hline") return Math.abs(y - A.y);
  if (d.kind === "vline") return Math.abs(x - A.x);
  if (d.kind === "text") return Math.hypot(x - A.x, y - A.y) - 10;
  if (!B) return Infinity;
  if (d.kind === "trend") {
    const dx = B.x - A.x, dy = B.y - A.y;
    const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - (A.x + t * dx), y - (A.y + t * dy));
  }
  const inside = x >= Math.min(A.x, B.x) - 4 && x <= Math.max(A.x, B.x, d.kind === "fib" ? 1e9 : 0) + 4 && y >= Math.min(A.y, B.y) - 4 && y <= Math.max(A.y, B.y) + 4;
  return inside ? 0 : Infinity;
}

const TOOLS: { id: Tool; label: string; icon: ReactNode }[] = [
  { id: "cursor", label: "Crosshair (no drawing)", icon: <path d="M12 3v18M3 12h18" /> },
  { id: "trend", label: "Trend line: click the start, then the end", icon: <><path d="M5 19L19 5" /><circle cx="5" cy="19" r="1.6" /><circle cx="19" cy="5" r="1.6" /></> },
  { id: "hline", label: "Horizontal line: click a price", icon: <><path d="M3 12h18" /><circle cx="12" cy="12" r="1.6" /></> },
  { id: "vline", label: "Vertical line: click a time", icon: <><path d="M12 3v18" /><circle cx="12" cy="12" r="1.6" /></> },
  { id: "rect", label: "Rectangle: click two corners", icon: <rect x="5" y="7" width="14" height="10" rx="1" /> },
  { id: "fib", label: "Fibonacci retracement: click the high/low, then the other end", icon: <path d="M4 5h16M4 9.5h16M4 13h16M4 16.5h16M4 20h16" /> },
  { id: "ruler", label: "Measure: click two points to see % change and time", icon: <path d="M4 17L17 4l3 3L7 20zM8 13l2 2M11 10l2 2M14 7l2 2" /> },
  { id: "text", label: "Text note: click where it goes", icon: <path d="M5 6h14M12 6v13" /> },
  { id: "eraser", label: "Eraser: click a drawing to delete it", icon: <path d="M15 4l5 5-9 9H6l-2-2zM9 20h11" /> },
];

const RANGES: { label: string; secs: number }[] = [
  { label: "1H", secs: 3600 },
  { label: "4H", secs: 4 * 3600 },
  { label: "1D", secs: 86400 },
  { label: "1W", secs: 7 * 86400 },
  { label: "1M", secs: 30 * 86400 },
];

export function Chart({ candles, trades, lines: levelLines, seconds = false, viewKey = "", drawKey = "", symbol = "chart", mcapFactor = 0 }: {
  candles: Candle[]; trades: Trade[]; lines: ChartLine[]; seconds?: boolean; viewKey?: string;
  drawKey?: string; symbol?: string; mcapFactor?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<{ candle: ISeriesApi<"Candlestick">; vol: ISeriesApi<"Histogram">; markers: ISeriesMarkersPluginApi<Time> } | null>(null);
  const extra = useRef<Partial<Record<string, ISeriesApi<SeriesType>>>>({});
  const priceLines = useRef<IPriceLine[]>([]);
  const fitted = useRef("");
  const data = useRef<Candle[]>([]); // the candles on screen (after the price / market-cap switch)
  const levels = useRef<number[]>([]);
  const layer = useRef(new DrawLayer());
  const kRef = useRef(1);

  const [ind, setInd] = useState(loadInd);
  const [indOpen, setIndOpen] = useState(false);
  const [view, setView] = useState<"price" | "mcap">(() => (localStorage.getItem("nexus-chart-view") === "mcap" ? "mcap" : "price"));
  const [scaleMode, setScaleMode] = useState<0 | 1 | 2>(() => (Number(localStorage.getItem("nexus-chart-scale")) as 0 | 1 | 2) || 0);
  const [autoScale, setAutoScale] = useState(true);
  const [tool, setTool] = useState<Tool>("cursor");
  const [magnet, setMagnet] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [drawings, setDrawings] = useState<Drawing[]>(() => loadDrawings(drawKey));
  const [hover, setHover] = useState<{ o: number; h: number; l: number; c: number; v: number; t: number } | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const toolRef = useRef(tool);
  const magnetRef = useRef(magnet);
  const pending = useRef<Anchor | null>(null);
  const clickAt = useRef<((x: number, y: number) => void) | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  toolRef.current = tool;
  magnetRef.current = magnet;

  const k = view === "mcap" && mcapFactor > 0 ? mcapFactor : 1;
  kRef.current = k;
  const shown = useMemo(() => {
    const c = orderedCandles(candles);
    return k === 1 ? c : c.map((x) => ({ ...x, open: x.open * k, high: x.high * k, low: x.low * k, close: x.close * k }));
  }, [candles, k]);

  // ---- time <-> position (drawings stay put as new candles arrive) ----
  const timeToLogical = (t: number) => {
    const d = data.current;
    const n = d.length;
    if (!n) return null;
    const step = n > 1 ? d[n - 1].time - d[n - 2].time : 60;
    if (t >= d[n - 1].time) return n - 1 + (t - d[n - 1].time) / step;
    if (t <= d[0].time) return (t - d[0].time) / step;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid].time <= t) lo = mid;
      else hi = mid;
    }
    return lo + (t - d[lo].time) / (d[hi].time - d[lo].time);
  };
  const logicalToTime = (l: number) => {
    const d = data.current;
    const n = d.length;
    if (!n) return 0;
    const step = n > 1 ? d[n - 1].time - d[n - 2].time : 60;
    if (l >= n - 1) return d[n - 1].time + (l - (n - 1)) * step;
    if (l <= 0) return d[0].time + l * step;
    const i = Math.floor(l);
    return d[i].time + (l - i) * (d[i + 1].time - d[i].time);
  };
  layer.current.toXY = (a: Anchor) => {
    const c = chart.current, cs = s.current?.candle;
    if (!c || !cs) return null;
    const l = timeToLogical(a.t);
    if (l === null) return null;
    const x = c.timeScale().logicalToCoordinate(l as any);
    const y = cs.priceToCoordinate(a.p * kRef.current);
    return x === null || y === null ? null : { x, y };
  };
  const anchorAt = (x: number, y: number): Anchor | null => {
    const c = chart.current, cs = s.current?.candle;
    if (!c || !cs) return null;
    const l = c.timeScale().coordinateToLogical(x);
    let p: number | null = cs.coordinateToPrice(y);
    if (l === null || p === null) return null;
    if (magnetRef.current) {
      // Snap to the nearest open / high / low / close of that candle, if it's close on screen.
      const bar = data.current[Math.round(l)];
      if (bar) {
        let best: number = p, bestPx = 14;
        for (const v of [bar.open, bar.high, bar.low, bar.close]) {
          const py = cs.priceToCoordinate(v);
          if (py !== null && Math.abs(py - y) < bestPx) {
            bestPx = Math.abs(py - y);
            best = v;
          }
        }
        p = best;
      }
    }
    return { t: Math.round(logicalToTime(l)), p: p / kRef.current };
  };

  // ---- create the chart once ----
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7d8db5", fontFamily: "JetBrains Mono, ui-monospace, monospace", attributionLogo: false, panes: { separatorColor: "rgba(80,120,255,0.18)", separatorHoverColor: "rgba(0,229,255,0.3)" } },
      grid: { vertLines: { color: "rgba(80,120,255,0.06)" }, horzLines: { color: "rgba(80,120,255,0.06)" } },
      rightPriceScale: { borderColor: "rgba(80,120,255,0.15)" },
      timeScale: { borderColor: "rgba(80,120,255,0.15)", timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { vertLine: { color: "rgba(0,240,255,0.4)", labelBackgroundColor: "#0b3a4a" }, horzLine: { color: "rgba(0,240,255,0.4)", labelBackgroundColor: "#0b3a4a" } },
    });
    const candle = c.addSeries(CandlestickSeries, {
      upColor: "#00f5a0", downColor: "#ff3d71", borderVisible: false, wickUpColor: "#00f5a0", wickDownColor: "#ff3d71",
      // Fit the price scale to the real trading range, so one bad tick doesn't flatten everything.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const r = original();
        const range = c.timeScale().getVisibleLogicalRange();
        const fit = range ? robustRange(data.current, Math.max(0, Math.floor(range.from)), Math.ceil(range.to)) : null;
        const base = fit ?? r?.priceRange ?? null;
        if (!base) return r;
        // Keep the buy / target / exit / order lines on screen, as long as they're within
        // a sensible distance of the price (a line 10x away would flatten the candles).
        const last = data.current.at(-1)?.close ?? 0;
        let { minValue, maxValue } = base;
        for (const p of levels.current) {
          if (!(p > 0) || !last || p < last / 3 || p > last * 3) continue;
          minValue = Math.min(minValue, p);
          maxValue = Math.max(maxValue, p);
        }
        return r ? { ...r, priceRange: { minValue, maxValue } } : { priceRange: { minValue, maxValue } };
      },
    });
    const vol = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    candle.attachPrimitive(layer.current as any);
    s.current = { candle, vol, markers: createSeriesMarkers(candle, []) };
    chart.current = c;

    const onMove = (p: MouseEventParams) => {
      const bar = p.seriesData.get(candle) as CandlestickData | undefined;
      const v = p.seriesData.get(vol) as { value?: number } | undefined;
      setHover(bar && p.time !== undefined ? { o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: v?.value ?? 0, t: p.time as number } : null);
      // Live preview of a two-click drawing.
      if (pending.current && p.point && TWO_CLICK.includes(toolRef.current)) {
        const b = anchorAt(p.point.x, p.point.y);
        if (b) {
          layer.current.preview = { id: "preview", kind: toolRef.current as Drawing["kind"], a: pending.current, b };
          layer.current.update();
        }
      }
    };
    // Clicks come from the chart area's own pointer events (the chart's click event can drop
    // quick successive clicks). x / y are relative to the chart; only the price pane counts.
    const onClick = (x: number, y: number) => {
      const t = toolRef.current;
      if (t === "cursor" || x > c.timeScale().width() || y > (c.panes()[0]?.getHeight() ?? Infinity)) return;
      if (t === "eraser") {
        let best: Drawing | null = null, bestD = 8;
        for (const d of layer.current.drawings) {
          const dist = hitDistance(d, x, y, layer.current.toXY);
          if (dist < bestD) {
            bestD = dist;
            best = d;
          }
        }
        if (best) setDrawings((ds) => ds.filter((d) => d.id !== best!.id));
        return;
      }
      const a = anchorAt(x, y);
      if (!a) return;
      const id = Math.random().toString(36).slice(2, 9);
      if (t === "hline" || t === "vline") return setDrawings((ds) => [...ds, { id, kind: t, a }]);
      if (t === "text") {
        const text = window.prompt("Note text")?.trim();
        if (text) setDrawings((ds) => [...ds, { id, kind: "text", a, text: text.slice(0, 80) }]);
        return;
      }
      if (!pending.current) {
        pending.current = a;
        return;
      }
      const from = pending.current;
      pending.current = null;
      layer.current.preview = null;
      setDrawings((ds) => [...ds, { id, kind: t as Drawing["kind"], a: from, b: a }]);
    };
    clickAt.current = onClick;
    c.subscribeCrosshairMove(onMove);
    return () => {
      c.unsubscribeCrosshairMove(onMove);
      clickAt.current = null;
      c.remove();
      chart.current = null;
      s.current = null;
      extra.current = {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    chart.current?.applyOptions({ timeScale: { secondsVisible: seconds } });
  }, [seconds]);

  // ---- candles, volume, value format ----
  useEffect(() => {
    if (!s.current || !shown.length) return;
    data.current = shown;
    const mcap = k !== 1;
    const prec = precisionFor(shown.at(-1)!.close);
    s.current.candle.applyOptions({ priceFormat: mcap ? { type: "custom", minMove: 1, formatter: (v: number) => `$${compact(v)}` } : { type: "price", precision: prec, minMove: Math.pow(10, -prec) } });
    s.current.candle.setData(shown.map((c) => ({ ...c, time: T(c.time) })));
    s.current.vol.setData(shown.map((c) => ({ time: T(c.time), value: c.volume, color: c.close >= c.open ? "rgba(0,245,160,0.35)" : "rgba(255,61,113,0.35)" })));
    // Zoom to fit only when the coin or timeframe changes, so live updates
    // don't keep resetting a view you have scrolled or zoomed.
    if (fitted.current !== viewKey) {
      chart.current?.timeScale().fitContent();
      fitted.current = viewKey;
    }
    layer.current.update();
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- indicators ----
  useEffect(() => {
    localStorage.setItem(IND_LS, JSON.stringify(ind));
    const c = chart.current, base = s.current;
    if (!c || !base) return;
    base.vol.applyOptions({ visible: ind.vol });
    const prec = shown.length ? precisionFor(shown.at(-1)!.close) : 4;
    const pf = k !== 1 ? { type: "custom" as const, minMove: 1, formatter: (v: number) => `$${compact(v)}` } : { type: "price" as const, precision: prec, minMove: Math.pow(10, -prec) };
    const lineOpts = (color: string, extraOpts: object = {}) => ({ color, lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null, priceFormat: pf, ...extraOpts });
    const ensure = (key: string, on: boolean, make: () => ISeriesApi<SeriesType>) => {
      const cur = extra.current[key];
      if (on && !cur) extra.current[key] = make();
      if (!on && cur) {
        c.removeSeries(cur);
        delete extra.current[key];
      }
      return extra.current[key];
    };
    // overlays on the price pane
    const overlay = (key: IndKey | string, on: boolean, color: string, pts: () => Pt[], dashed = false) => {
      const ser = ensure(key, on, () => c.addSeries(LineSeries, lineOpts(color, dashed ? { lineStyle: LineStyle.Dashed } : {})));
      if (ser) {
        ser.applyOptions({ priceFormat: pf });
        ser.setData(pts() as any);
      }
    };
    overlay("ema9", ind.ema9, "#00e5ff", () => ema(shown, 9));
    overlay("ema21", ind.ema21, "#b45cff", () => ema(shown, 21));
    overlay("sma50", ind.sma50, "#ffc857", () => sma(shown, 50));
    overlay("sma200", ind.sma200, "#ff8fab", () => sma(shown, 200));
    const bb = ind.bb ? bollinger(shown) : null;
    overlay("bbU", ind.bb, "#7c9cff", () => bb!.up);
    overlay("bbM", ind.bb, "rgba(124,156,255,0.6)", () => bb!.mid, true);
    overlay("bbL", ind.bb, "#7c9cff", () => bb!.lo);
    overlay("vwap", ind.vwap, "#ffa94d", () => vwap(shown));

    // oscillators, each in its own pane below the price (RSI first, then MACD)
    const wantPanes = (ind.rsi ? 1 : 0) + (ind.macd ? 1 : 0);
    const rsiPane = 1, macdPane = ind.rsi ? 2 : 1;
    const paneOf = (key: string) => (extra.current[key] as any)?.getPane?.().paneIndex?.();
    // Rebuild oscillator series if their pane positions changed.
    for (const key of ["rsi", "macdL", "macdS", "macdH"]) {
      const want = key === "rsi" ? (ind.rsi ? rsiPane : -1) : ind.macd ? macdPane : -1;
      if (extra.current[key] && paneOf(key) !== want) {
        c.removeSeries(extra.current[key]!);
        delete extra.current[key];
      }
    }
    const osc = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false };
    const r = ensure("rsi", ind.rsi, () => {
      const ser = c.addSeries(LineSeries, { ...osc, color: "#c084fc", priceFormat: { type: "price", precision: 1, minMove: 0.1 } }, rsiPane);
      ser.createPriceLine({ price: 70, color: "rgba(255,61,113,0.5)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
      ser.createPriceLine({ price: 30, color: "rgba(0,245,160,0.5)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
      return ser;
    });
    if (r) r.setData(rsi(shown) as any);
    const m = ind.macd ? macd(shown) : null;
    const mh = ensure("macdH", ind.macd, () => c.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision: 8, minMove: 1e-8 } }, macdPane));
    const ml = ensure("macdL", ind.macd, () => c.addSeries(LineSeries, { ...osc, color: "#00e5ff", priceFormat: { type: "price", precision: 8, minMove: 1e-8 } }, macdPane));
    const ms = ensure("macdS", ind.macd, () => c.addSeries(LineSeries, { ...osc, color: "#ffa94d", lastValueVisible: false, priceFormat: { type: "price", precision: 8, minMove: 1e-8 } }, macdPane));
    if (m && mh && ml && ms) {
      mh.setData(m.hist as any);
      ml.setData(m.line as any);
      ms.setData(m.signal as any);
    }
    // Drop panes nothing uses any more; keep the oscillator panes compact.
    const panes = c.panes();
    for (let i = panes.length - 1; i > wantPanes; i--) if (!panes[i].getSeries().length) c.removePane(i);
    c.panes().forEach((p, i) => i > 0 && p.setHeight(90));
  }, [ind, shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- trade markers ----
  useEffect(() => {
    if (!s.current || !shown.length) return;
    const first = shown[0].time;
    const step = shown.length > 1 ? shown[1].time - shown[0].time : 60;
    const markers: SeriesMarker<Time>[] = trades
      .map((t) => ({ sec: Math.floor(t.time / 1000), t }))
      .filter(({ sec }) => sec >= first)
      .map(({ sec, t }) => ({
        time: T(Math.floor(sec / step) * step),
        position: t.side === "BUY" ? ("belowBar" as const) : ("aboveBar" as const),
        color: t.side === "BUY" ? "#00f5a0" : "#ff3d71",
        shape: t.side === "BUY" ? ("arrowUp" as const) : ("arrowDown" as const),
        text: `${t.side}${t.source === "bot" ? " 🤖" : ""}`,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    s.current.markers.setMarkers(markers);
  }, [trades, shown]);

  // ---- plan / order lines ----
  useEffect(() => {
    const cs = s.current?.candle;
    if (!cs) return;
    priceLines.current.forEach((l) => cs.removePriceLine(l));
    priceLines.current = [];
    levels.current = levelLines.map((l) => l.price * k);
    for (const l of levelLines) {
      if (l.price > 0) priceLines.current.push(cs.createPriceLine({ price: l.price * k, color: l.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.title }));
    }
    if (autoScale) chart.current?.priceScale("right").applyOptions({ autoScale: true }); // refit to include the new lines
  }, [JSON.stringify(levelLines), shown.length > 0, k]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- scale: normal / log / %, auto on or off ----
  useEffect(() => {
    localStorage.setItem("nexus-chart-scale", String(scaleMode));
    chart.current?.priceScale("right").applyOptions({ mode: scaleMode === 1 ? PriceScaleMode.Logarithmic : scaleMode === 2 ? PriceScaleMode.Percentage : PriceScaleMode.Normal, autoScale });
  }, [scaleMode, autoScale]);
  useEffect(() => localStorage.setItem("nexus-chart-view", view), [view]);

  // ---- drawings: per coin, saved in this browser ----
  useEffect(() => {
    setDrawings(loadDrawings(drawKey));
    pending.current = null;
    layer.current.preview = null;
  }, [drawKey]);
  useEffect(() => {
    if (drawKey) localStorage.setItem(drawKeyLs(drawKey), JSON.stringify(drawings.slice(-100)));
    layer.current.drawings = drawings;
    layer.current.update();
  }, [drawings]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    layer.current.hidden = hidden;
    layer.current.update();
  }, [hidden]);
  // Picking a tool drops any half-finished drawing right away (not in an effect, which could
  // run after the next chart click and swallow it).
  const pickTool = (t: Tool) => {
    pending.current = null;
    layer.current.preview = null;
    layer.current.update();
    setTool(t);
  };
  useEffect(() => {
    // While drawing, a click shouldn't also drag the chart.
    chart.current?.applyOptions({ handleScroll: tool === "cursor" || tool === "eraser", handleScale: true });
  }, [tool]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && toolRef.current !== "cursor") {
        pending.current = null;
        layer.current.preview = null;
        layer.current.update();
        setTool("cursor");
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const setRange = (secs: number) => {
    const d = data.current;
    const c = chart.current;
    if (!c || !d.length) return;
    const last = d[d.length - 1].time;
    if (d[0].time > last - secs) return c.timeScale().fitContent();
    c.timeScale().setVisibleRange({ from: T(last - secs), to: T(last) });
  };
  const screenshot = () => {
    const c = chart.current;
    if (!c) return;
    c.takeScreenshot(true).toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `${symbol}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/png");
  };

  const last = shown.at(-1);
  const prev = shown.at(-2);
  const leg = hover ?? (last ? { o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume, t: last.time } : null);
  const legPrev = hover ? shown.find((_, i) => shown[i + 1]?.time === hover.t) : prev;
  const chg = leg && legPrev ? leg.c - legPrev.close : 0;
  const chgPct = leg && legPrev && legPrev.close ? (chg / legPrev.close) * 100 : 0;
  const mcap = k !== 1;
  const activeInd = INDICATORS.filter((x) => x.key !== "vol" && ind[x.key]);

  // The chart is absolutely positioned inside .tv-area, so its size can't feed back into
  // the layout (that loop made it grow forever).
  return (
    <div className="chart-wrap tv">
      <div className="tv-top">
        <div className="tv-menu">
          <button className={`tv-btn ${indOpen ? "on" : ""}`} onClick={() => setIndOpen((v) => !v)} aria-expanded={indOpen} title="Indicators">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 17l5-6 4 4 4-7 5 5" /></svg>
            Indicators{activeInd.length ? <span className="tv-count">{activeInd.length}</span> : null}
          </button>
          {indOpen && (
            <>
              <div className="tv-menu-backdrop" onClick={() => setIndOpen(false)} />
              <div className="tv-menu-list" role="menu">
                {INDICATORS.map((x) => (
                  <label key={x.key} className="tv-menu-item" title={x.hint}>
                    <input type="checkbox" checked={ind[x.key]} onChange={(e) => setInd((v) => ({ ...v, [x.key]: e.target.checked }))} />
                    <i style={{ background: x.color }} />
                    <span>{x.label}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <span className="tv-sep" />
        <div className="tv-seg" role="radiogroup" aria-label="Show price or market cap">
          <button role="radio" aria-checked={!mcap} className={!mcap ? "on" : ""} onClick={() => setView("price")}>Price</button>
          <button role="radio" aria-checked={mcap} className={mcap ? "on" : ""} onClick={() => mcapFactor > 0 && setView("mcap")} disabled={!(mcapFactor > 0)} title={mcapFactor > 0 ? "Show market cap instead of price" : "No market cap for this coin"}>MCap</button>
        </div>
        <span className="tv-spacer" />
        <button className="tv-icon" onClick={screenshot} title="Download a picture of the chart" aria-label="Screenshot">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
        </button>
      </div>

      <div className="tv-body">
        <div className="tv-tools" role="toolbar" aria-label="Drawing tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={`tv-tool ${tool === t.id ? "on" : ""}`} onClick={() => pickTool(t.id)} title={t.label} aria-label={t.label} aria-pressed={tool === t.id}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{t.icon}</svg>
            </button>
          ))}
          <span className="tv-tools-sep" />
          <button className={`tv-tool ${magnet ? "on" : ""}`} onClick={() => setMagnet((v) => !v)} title={magnet ? "Magnet on: points snap to candle open/high/low/close" : "Magnet off"} aria-pressed={magnet} aria-label="Magnet">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M6 4v8a6 6 0 0 0 12 0V4M6 8h4M14 8h4" /></svg>
          </button>
          <button className={`tv-tool ${hidden ? "on" : ""}`} onClick={() => setHidden((v) => !v)} title={hidden ? "Show drawings" : "Hide drawings"} aria-pressed={hidden} aria-label="Hide drawings">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">{hidden ? <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 5 9 7a11 11 0 0 1-2.4 3.2M6.1 6.1C4 7.6 3 10.6 3 12c0 2 4 7 9 7 1.6 0 3-.4 4.3-1" /> : <><path d="M3 12c0-2 4-7 9-7s9 5 9 7-4 7-9 7-9-5-9-7z" /><circle cx="12" cy="12" r="2.5" /></>}</svg>
          </button>
          <button className="tv-tool" onClick={() => setDrawings((d) => d.slice(0, -1))} disabled={!drawings.length} title="Undo the last drawing" aria-label="Undo last drawing">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2" /></svg>
          </button>
          <button className="tv-tool" onClick={() => drawings.length && window.confirm(`Delete all ${drawings.length} drawing${drawings.length === 1 ? "" : "s"} on this coin?`) && setDrawings([])} disabled={!drawings.length} title="Delete all drawings on this coin" aria-label="Delete all drawings">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
          </button>
        </div>

        <div
          className={`tv-area ${tool !== "cursor" ? "drawing" : ""}`}
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            downAt.current = { x: e.clientX - r.left, y: e.clientY - r.top };
          }}
          onPointerUp={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            const d = downAt.current;
            downAt.current = null;
            if (d && Math.hypot(x - d.x, y - d.y) < 6 && e.button === 0) clickAt.current?.(x, y);
          }}
        >
          <div ref={el} className="chart" />
          {leg && (
            <div className="tv-legend">
              <div>
                <span className="muted">{symbol}{mcap ? " · MCap" : ""}</span>{" "}
                <span className="muted">O</span><b className={chg >= 0 ? "up" : "down"}>{fmtVal(leg.o, mcap)}</b>{" "}
                <span className="muted">H</span><b className={chg >= 0 ? "up" : "down"}>{fmtVal(leg.h, mcap)}</b>{" "}
                <span className="muted">L</span><b className={chg >= 0 ? "up" : "down"}>{fmtVal(leg.l, mcap)}</b>{" "}
                <span className="muted">C</span><b className={chg >= 0 ? "up" : "down"}>{fmtVal(leg.c, mcap)}</b>{" "}
                <b className={chg >= 0 ? "up" : "down"}>{chg >= 0 ? "+" : ""}{chgPct.toFixed(2)}%</b>
              </div>
              {ind.vol && <div><span className="muted">Volume</span> <b className="up">{compact(leg.v)}</b></div>}
              {activeInd.length > 0 && (
                <div className="tv-legend-inds">
                  {activeInd.map((x) => <span key={x.key}><i style={{ background: x.color }} />{x.label}</span>)}
                </div>
              )}
            </div>
          )}
          {tool !== "cursor" && <div className="tv-hint">{TOOLS.find((t) => t.id === tool)?.label}{pending.current ? " · now click the second point" : ""} · Esc to stop</div>}
        </div>
      </div>

      <div className="tv-bottom">
        <div className="tv-ranges">
          {RANGES.map((r) => <button key={r.label} onClick={() => setRange(r.secs)} title={`Show the last ${r.label}`}>{r.label}</button>)}
          <button onClick={() => chart.current?.timeScale().fitContent()} title="Show everything loaded">All</button>
        </div>
        <span className="tv-spacer" />
        <span className="muted mono tv-clock">{clock.toISOString().slice(11, 19)} UTC</span>
        <span className="tv-sep" />
        <button className={`tv-mini ${scaleMode === 2 ? "on" : ""}`} onClick={() => setScaleMode((m) => (m === 2 ? 0 : 2))} title="Percent scale: % change from the first visible candle">%</button>
        <button className={`tv-mini ${scaleMode === 1 ? "on" : ""}`} onClick={() => setScaleMode((m) => (m === 1 ? 0 : 1))} title="Logarithmic scale: equal % moves look equal">log</button>
        <button className={`tv-mini ${autoScale ? "on" : ""}`} onClick={() => setAutoScale((v) => !v)} title="Auto-fit the price scale to the visible candles">auto</button>
      </div>
    </div>
  );
}
