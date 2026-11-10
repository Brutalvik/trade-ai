export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type PairInfo = {
  chain: string;
  pool: string;
  symbol: string;
  name: string;
  tokenAddress: string;
  priceUsd: number;
  change: { m5: number; h1: number; h6: number; h24: number };
  volume24h: number;
  liquidityUsd: number;
  marketCap: number;
  imageUrl?: string;
  dex?: string;
};
export type Snapshot = { price: number; ema9: number; ema21: number; ema50: number; rsi14: number; atrPct: number; volRatio: number; change1: number; change12: number; high50: number; low50: number; techScore: number };
export type Signal = { action: "BUY" | "SELL" | "HOLD"; confidence: number; entryPrice: number; takeProfit: number; stopLoss: number; holdMinutes: number; buyWindowMinutes: number; riskLevel: string; reasoning: string };
export type ModelResult = { model: string; ok: true; signal: Signal; ms: number } | { model: string; ok: false; error: string; ms: number };
export type Consensus = { action: "BUY" | "SELL" | "HOLD"; confidence: number; entryPrice: number; takeProfit: number; stopLoss: number; holdMinutes: number; buyBy: number; sellBy: number; netRewardPct: number; netRiskPct: number; agreement: boolean; note: string };
export type Position = { id: string; chain: string; pool: string; symbol: string; qty: number; entryPrice: number; costUsd: number; openedAt: number; takeProfit?: number; stopLoss?: number; sellBy?: number; source: "manual" | "bot"; lastPrice: number };
export type Trade = { id: string; time: number; side: "BUY" | "SELL"; symbol: string; pool: string; price: number; qty: number; usd: number; feeUsd: number; pnlUsd?: number; reason: string; source: "manual" | "bot" };
export type BotConfig = { chain: string; pool: string; symbol: string; tf: Timeframe; positionPct: number; minConfidence: number; analyzeEverySec: number; checkEverySec: number; maxDrawdownPct: number; breakEvenAtPct: number; goalUsd: number };
export type AppState = {
  mode: "paper";
  startCash: number;
  cash: number;
  peakEquity: number;
  equityNow: number;
  roundTripCostPct: number;
  positions: Position[];
  trades: Trade[];
  equity: { t: number; v: number }[];
  settings: { feePct: number; slippagePct: number };
  bot: { running: boolean; config: BotConfig | null; lastAnalysisAt: number; log: { t: number; msg: string; level: "info" | "good" | "bad" }[] };
  lastSignal: { at: number; pool: string; symbol: string; tf: string; results: ModelResult[]; consensus: Consensus } | null;
};
export type Analysis = { pair: PairInfo; snapshot: Snapshot; results: ModelResult[]; consensus: Consensus };

async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  status: () => req<{ claude: boolean; openai: boolean; mode: string }>("/status"),
  search: (q: string) => req<PairInfo[]>(`/search?q=${encodeURIComponent(q)}`),
  pair: (chain: string, pool: string) => req<PairInfo>(`/pair/${chain}/${pool}`),
  candles: async (chain: string, pool: string, tf: Timeframe) => {
    const res = await fetch(`/api/candles/${chain}/${pool}?tf=${tf}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return { candles: data as Candle[], source: res.headers.get("X-Candle-Source") ?? "unknown", note: res.headers.get("X-Candle-Note") ?? "" };
  },
  scan: () => req<{ pair: PairInfo; snap: Snapshot | null }[]>("/scan"),
  analyze: (chain: string, pool: string, tf: Timeframe) => req<Analysis>("/analyze", { chain, pool, tf }),
  state: () => req<AppState>("/state"),
  buy: (chain: string, pool: string, usd: number) => req("/trade", { side: "BUY", chain, pool, usd }),
  sell: (chain: string, pool: string, positionId: string, fraction: number) => req("/trade", { side: "SELL", chain, pool, positionId, fraction }),
  settings: (s: { feePct?: number; slippagePct?: number }) => req("/settings", s),
  reset: (startCash: number) => req("/reset", { startCash }),
  startBot: (cfg: BotConfig) => req("/bot/start", cfg),
  stopBot: () => req("/bot/stop", {}),
};

export const fmtPrice = (p: number) => {
  if (!p) return "$0";
  if (p >= 1) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  const digits = Math.max(2, -Math.floor(Math.log10(p)) + 3);
  return `$${p.toFixed(Math.min(digits, 12))}`;
};
export const fmtUsd = (v: number, d = 2) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const fmtBig = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);
export const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
