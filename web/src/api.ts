export type Timeframe = "1s" | "5s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
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
export type PlanOrder = { kind: "buy_now" | "buy_dip" | "buy_breakout"; triggerPrice: number; confirmSeconds: number; minVolumeRatio: number; stopLoss: number; target: number; maxHoldMinutes: number; winChancePct: number };
export type CheckedOrder = PlanOrder & { netRewardPct: number; netRiskPct: number; evPct: number; warning?: string }; // warning = fails the fee/risk check (risky)
export type Signal = { stance: "BUY_NOW" | "WAIT_FOR_TRIGGER" | "AVOID"; confidence: number; riskLevel: string; reasoning: string; orders: PlanOrder[]; cancelBelow: number; cancelAbove: number; validMinutes: number };
export type ModelResult = { model: string; ok: true; signal: Signal; ms: number } | { model: string; ok: false; error: string; ms: number };
export type Consensus = { action: "BUY" | "SELL" | "HOLD"; stance: Signal["stance"]; orders: CheckedOrder[]; cancelBelow: number; cancelAbove: number; expiresAt: number; confidence: number; entryPrice: number; takeProfit: number; stopLoss: number; holdMinutes: number; buyBy: number; sellBy: number; netRewardPct: number; netRiskPct: number; agreement: boolean; note: string };
export type Position = { id: string; chain: string; pool: string; symbol: string; qty: number; entryPrice: number; costUsd: number; openedAt: number; takeProfit?: number; stopLoss?: number; sellBy?: number; source: "manual" | "bot"; lastPrice: number; target?: number; trailPct?: number; peak?: number; trailing?: boolean; protectPct?: number; protectSince?: number };
export type Trade = { id: string; time: number; side: "BUY" | "SELL"; symbol: string; pool: string; price: number; qty: number; usd: number; feeUsd: number; pnlUsd?: number; reason: string; source: "manual" | "bot"; predictedWinPct?: number; reachedTarget?: boolean; auto?: boolean; strategy?: "newcoin"; platformFeeUsd?: number };
export type BotConfig = { chain: string; pool: string; symbol: string; tf: Timeframe; positionPct: number; minConfidence: number; analyzeEverySec: number; checkEverySec: number; maxDrawdownPct: number; breakEvenAtPct: number; lockPct?: number; partialAtPct?: number; goalUsd: number; pick?: "this" | "auto" | "newcoins"; autoChain?: ScanChain; newChain?: "solana" | "base"; newCoinPct?: number; newStopPct?: number; newTakePct?: number; newTrailPct?: number; newMaxMin?: number; newMaxPerDay?: number; autoCandidates?: number; autoMinLiquidityUsd?: number; trailPct?: number; waitForHold?: boolean; cooldownMin?: number; dailyLossPct?: number; maxDrop1hPct?: number; riskPerTradePct?: number; allowRisky?: boolean; riskReasons?: string[] };
export type Status = { claude: boolean; openai: boolean; mode: string; storage: "redis" | "file" | "temp"; serverless: boolean; commit?: string; alerts?: "telegram" | "ntfy" | null };
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
  settings: { feePct: number; slippagePct: number; continuous?: boolean };
  bot: {
    running: boolean;
    config: BotConfig | null;
    lastAnalysisAt: number;
    lastTickAt: number;
    armedSince: (number | null)[];
    askNow: boolean;
    skipNoted: boolean[];
    startedAt: number | null;
    stoppedAt: number | null;
    coinStats: Record<string, { losses: number; lastLossAt: number; lossDay: string }>;
    day: { date: string; startEquity: number } | null;
    blocked: string | null;
    lastWatch: { at: number; by: "scheduler" | "dashboard" | "local" } | null;
    target: { chain: string; pool: string; symbol: string; chosenAt: number } | null;
    candidates: { symbol: string; chain: string; pool: string; action: string; confidence: number; note: string }[];
    log: { t: number; msg: string; level: "info" | "good" | "bad" }[];
  };
  storage: Status["storage"];
  orders?: LimitOrder[]; // open limit buys / sells
  signedOut?: boolean; // true = not signed in as the account owner: an empty $0 view
  lastSignal: { at: number; pool: string; symbol: string; tf: string; results: ModelResult[]; consensus: Consensus; trendDown?: boolean } | null;
};
export type Plan = { verdict: "BUY ZONE" | "WAIT" | "AVOID"; buyBelow: number; sellAt: number; exitBelow: number; buyBy: number; sellBy: number; netGainPct: number; why: string };
export type ScanChain = "all" | "solana" | "base" | "ethereum" | "bsc";
export type NewCoinRisk = "LOW" | "MEDIUM" | "HIGH" | "REJECTED";
export type NewCoin = { pair: PairInfo; ageMin: number; risk: NewCoinRisk; reasons: string[]; safetyChecked: boolean; buyShare: number | null; momentum: "UP" | "FLAT" | "DOWN"; tradeable: boolean; why: string };
export type ScanResult = { source: "trending" | "boosted"; chain: ScanChain; rows: { pair: PairInfo; snap: Snapshot | null; plan: Plan | null }[] };
// Older saved logs, trades and plans may still name the model; show "AI" instead.
export const aiText = (s: string) => s.replace(/\bClaude plan: /g, "AI plan: ").replace(/\bClaude \([^)]*\)/g, "AI").replace(/\bClaude's\b/g, "the AI's").replace(/\bClaude\b/g, "AI");
export type LimitOrder = { id: string; side: "BUY" | "SELL"; chain: string; pool: string; symbol: string; price: number; usd?: number; positionId?: string; fraction?: number; createdAt: number };
export type PlanId = "free" | "member" | "starter" | "pro" | "max";
export type Permission = "trade.manual" | "trade.limit" | "trade.protect" | "ai.analyze" | "bot.run" | "bot.autopick" | "bot.risky" | "admin.users";
export type Usage = { month: string; used: number; limit: number; topup?: number }; // limit -1 = unlimited; topup = extra tokens that don't expire
export type PlanExtras = { tokenPacks: { id: string; tokens: number; priceUsd: number }[]; yearlyMonthsPaid: number };
export type PlanInfo = { id: PlanId; name: string; priceUsd: number; blurb: string; aiTokens: number; feePct: number; freeTrades: number; permissions: Permission[] }; // freeTrades -1 = unlimited
export type User = { username: string; firstName: string; lastName: string; email: string; createdAt: number; avatarUrl: string | null; owner?: boolean; plan?: PlanId; role?: "user" | "admin"; permissions?: Permission[]; usage?: Usage };
export type AdminUser = User & { usage: Usage };
export type AuditEntry = { t: number; type: string; by?: string; summary: string; data?: Record<string, unknown> };
export type Page<T> = { total: number; items: T[] };
export type Analysis = { pair: PairInfo; snapshot: Snapshot; results: ModelResult[]; consensus: Consensus };

async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  status: () => req<Status>("/status"),
  search: (q: string) => req<PairInfo[]>(`/search?q=${encodeURIComponent(q)}`),
  pair: (chain: string, pool: string) => req<PairInfo>(`/pair/${chain}/${pool}`),
  candles: async (chain: string, pool: string, tf: Timeframe) => {
    const res = await fetch(`/api/candles/${chain}/${pool}?tf=${tf}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return { candles: data as Candle[], source: res.headers.get("X-Candle-Source") ?? "unknown", note: res.headers.get("X-Candle-Note") ?? "" };
  },
  scan: (chain: ScanChain) => req<ScanResult>(`/scan?chain=${chain}`),
  newcoins: (chain: "solana" | "base") => req<NewCoin[]>(`/newcoins?chain=${chain}`),
  analyze: (chain: string, pool: string, tf: Timeframe) => req<Analysis>("/analyze", { chain, pool, tf }),
  state: () => req<AppState>("/state"),
  buy: (chain: string, pool: string, usd: number) => req("/trade", { side: "BUY", chain, pool, usd }),
  sell: (chain: string, pool: string, positionId: string, fraction: number) => req("/trade", { side: "SELL", chain, pool, positionId, fraction }),
  settings: (s: { feePct?: number; slippagePct?: number; continuous?: boolean }) => req("/settings", s),
  me: () => req<{ user: User | null }>("/auth/me"),
  placeOrder: (b: { side: "BUY" | "SELL"; chain?: string; pool?: string; symbol?: string; price: number; usd?: number; positionId?: string; fraction?: number }) => req<LimitOrder>("/orders", b),
  cancelOrder: (id: string) => req("/orders/cancel", { id }),
  overrideDailyLimit: () => req("/bot/override-daily", {}),
  signIn: (b: { login: string; password: string }) => req<{ user: User }>("/auth/signin", b),
  signUp: (b: { username: string; firstName: string; lastName: string; email: string; password: string }) => req<{ user: User }>("/auth/signup", b),
  signOut: () => req("/auth/signout", {}),
  changePassword: (b: { current: string; next: string }) => req("/auth/password", b),
  plans: () => req<PlanInfo[]>("/plans"),
  activity: (before = 0) => req<Page<AuditEntry>>(`/activity?before=${before}&limit=50`),
  tradeHistory: (before = 0, limit = 200) => req<Page<Trade>>(`/trades/history?before=${before}&limit=${limit}`),
  adminActivity: (username: string, before = 0) => req<Page<AuditEntry>>(`/admin/activity?username=${encodeURIComponent(username)}&before=${before}&limit=50`),
  planExtras: () => req<PlanExtras>("/plans/extras"),
  adminTopup: (b: { username: string; tokens: number }) => req<{ username: string; topup: number }>("/admin/topup", b),
  adminUsers: () => req<AdminUser[]>("/admin/users"),
  setUserAccess: (b: { username: string; plan?: PlanId; role?: "user" | "admin" }) => req<User>("/admin/users", b),
  reset: (startCash: number) => req("/reset", { startCash }),
  startBot: (cfg: BotConfig) => req("/bot/start", cfg),
  stopBot: () => req("/bot/stop", {}),
  heartbeat: () => req<{ ticked: boolean; running: boolean }>("/bot/heartbeat", {}),
  protect: (positionId: string, pct: number) => req("/protect", { positionId, pct }),
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
