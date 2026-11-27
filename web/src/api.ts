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
export type CheckedOrder = PlanOrder & { netRewardPct: number; netRiskPct: number; evPct: number; warning?: string; prediction?: OrderPrediction }; // warning = fails the fee/risk (or, for agents, the prediction) check
// Agents: every forecaster's chance that the order reaches the minimum profit before its stop, and the combined chance it is judged on.
export type FcKey = "ai" | "panel" | "worlds" | "lookalikes" | "baseRate" | "combined";
export type OrderPrediction = {
  pWin: number; needPct: number; winNetPct: number; lossPct: number;
  parts: { key: FcKey; label: string; pct: number; adjPct: number; weight: number; note?: string }[];
  worlds?: { trend: number; flat: number; paths: number; from: string; minutesToWin: number | null; pStop: number; pNone: number; filledPct: number };
  panel?: { who: string; pct: number; reason: string }[];
  truncated?: boolean;
  assumed?: boolean;
};
// The forecast desk: what the numbers alone say about buying right now.
export type DeskView = {
  at: number; price: number; upPct: number; paths: number;
  cone: { min: number; lo: number; mid: number; hi: number }[];
  rows: { stopPct: number; worlds: number | null; trend: number | null; flat: number | null; baseRate: number | null; lookalikes: number | null; lookN: string | null; numbers: number; needPct: number }[];
  next60: { mid: number; lo: number; hi: number } | null;
};
// The scoreboard: every forecast checked against what really happened (whole account).
export type FcStat = { n: number; sumP: number; hits: number; brier: number };
export type Scoreboard = {
  stats: Partial<Record<FcKey, FcStat>> & { taken?: { n: number; hits: number }; refused?: { n: number; hits: number }; scored?: number; byQuality?: Record<string, { n: number; hits: number }> };
  last: { at: number; symbol: string; kind: string; pWin: number; aiPct: number; passed: boolean; out: "win" | "stop" | "none"; real?: boolean }[];
  waiting: number;
};
export type Signal = { stance: "BUY_NOW" | "WAIT_FOR_TRIGGER" | "AVOID"; confidence: number; riskLevel: string; reasoning: string; orders: PlanOrder[]; cancelBelow: number; cancelAbove: number; validMinutes: number };
export type ModelResult = { model: string; ok: true; signal: Signal; ms: number } | { model: string; ok: false; error: string; ms: number };
export type Consensus = { action: "BUY" | "SELL" | "HOLD"; stance: Signal["stance"]; orders: CheckedOrder[]; cancelBelow: number; cancelAbove: number; expiresAt: number; confidence: number; entryPrice: number; takeProfit: number; stopLoss: number; holdMinutes: number; buyBy: number; sellBy: number; netRewardPct: number; netRiskPct: number; agreement: boolean; note: string };
// Agents: how a trade's profit is managed once the minimum is reached (floor = locked exit; trailPct = how far behind the high the exit follows).
export type ProfitPlan = { floor: number; trailPct: number; by: "ai" | "rule"; asks: number; fails: number; at?: number; nextAt?: number; target?: number; note?: string; confidence?: number };
// costPct (agents' trades): what a round trip of this trade's size was estimated to cost in its pool when it was bought.
export type Position = { pm?: ProfitPlan; best?: number; prediction?: OrderPrediction; costPct?: number; id: string; botId?: string; imageUrl?: string; adopted?: boolean; chain: string; pool: string; symbol: string; qty: number; entryPrice: number; costUsd: number; openedAt: number; takeProfit?: number; stopLoss?: number; sellBy?: number; source: "manual" | "bot"; lastPrice: number; target?: number; trailPct?: number; peak?: number; trailing?: boolean; protectPct?: number; protectSince?: number };
export type Trade = { id: string; botId?: string; time: number; side: "BUY" | "SELL"; symbol: string; pool: string; price: number; qty: number; usd: number; feeUsd: number; pnlUsd?: number; reason: string; source: "manual" | "bot"; predictedWinPct?: number; reachedTarget?: boolean; auto?: boolean; strategy?: "newcoin"; platformFeeUsd?: number };
// What an agent's next buy would cost and how much it would invest: `usd` of its `funds` (less than all of it when that keeps
// the round trip at or under `capPct`), costing `pct`; `fullPct` is what investing all of its funds would cost.
// Why an agent stood aside without asking its AI: the scouts ruled the coin out, or the numbers left no order that could pass.
export type PlanGate = { kind: "scouts" | "numbers"; reasons: string[]; quality?: number; min?: number };
export type AgentCost = { pct: number; usd: number; funds: number; fullPct: number; capPct: number; source: "jupiter" | "depth" };
export type BotConfig = { autoPick?: boolean; autoStrict?: boolean; autoMaxCostPct?: number; mint?: string; maxCostPct?: number; chain: string; pool: string; symbol: string; imageUrl?: string; tf: Timeframe; positionPct: number; minConfidence: number; analyzeEverySec: number; checkEverySec: number; maxDrawdownPct: number; breakEvenAtPct: number; lockPct?: number; partialAtPct?: number; goalUsd: number; pick?: "this" | "auto" | "newcoins" | "agents" | "agent"; budgetUsd?: number; agentAiCheck?: boolean; autoChain?: ScanChain; newChain?: "solana" | "base"; newCoinPct?: number; newStopPct?: number; newTakePct?: number; newTrailPct?: number; newMaxMin?: number; newMaxPerDay?: number; autoCandidates?: number; autoMinLiquidityUsd?: number; trailPct?: number; waitForHold?: boolean; rewardRule?: boolean; strongMode?: boolean; takeProfitUsd?: number; startEquity?: number; disabled?: string[]; cooldownMin?: number; dailyLossPct?: number; maxDrop1hPct?: number; riskPerTradePct?: number; allowRisky?: boolean; riskReasons?: string[]; riskyMinWin?: number };
// Agents: the eight scouts' reading of a coin, and what an agent learned from its coin's history.
export type AgentCoin = { mint: string; symbol: string; name: string; icon?: string; priceUsd: number; mcap: number; liquidity: number; ageMin: number | null; change5m: number; change1h: number; agents: Record<string, { score: number; note: string }>; total: number; vetoes: string[]; structural?: string[]; timing?: string[]; quality?: number };
export type StratResult = { key: string; label: string; tf: string; trades: number; wins: number; avgNetPct: number; winChancePct: number; runMedPct?: number; ran10?: number };
export type Learned = { at: number; netTargetPct: number; table: StratResult[]; best: StratResult | null; summary: string };
// storageError: the database is set up but not answering (what it said); the bot is paused until it does.
export type Status = { claude: boolean; openai: boolean; mode: string; storage: "supabase" | "redis" | "file" | "temp"; storageError?: string; serverless: boolean; commit?: string; alerts?: "telegram" | "ntfy" | null };
export type AppState = {
  stepLog?: { t: number; msg: string; level: "info" | "good" | "bad"; d?: Decision }[]; // the quality step's newest lines
  mode: "paper";
  startCash: number;
  cash: number;
  peakEquity: number;
  equityNow: number;
  available?: number; // cash you can spend yourself (cash minus what is locked for agents)
  locked?: number; // cash set aside for running agents (still part of equity)
  locks?: { id: string; symbol: string; usd: number }[];
  fc?: Scoreboard | null;
  roundTripCostPct: number;
  positions: Position[];
  trades: Trade[];
  equity: { t: number; v: number }[];
  settings: { feePct: number; slippagePct: number; continuous?: boolean };
  bot: {
    learned?: Learned; // Agent: what it learned from its coin's history
    // Auto-pick agent: why it has no coin right now (note), and how many coins it has chosen since it started.
    auto?: { note: string; at: number; nextAt?: number; idleSince?: number; again?: boolean; picks?: number; pickedAt?: number };
    watch?: { key: string; label: string; tf: string; side: "above" | "below"; price: number; stop: number; target: number; live: boolean; at: number } | null; // Agent: the level it's watching
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
    log: { t: number; msg: string; level: "info" | "good" | "bad"; d?: Decision }[];
  };
  storage: Status["storage"];
  orders?: LimitOrder[]; // open limit buys / sells
  signedOut?: boolean; // true = not signed in as the account owner: an empty $0 view
  lastSignal: { at: number; pool: string; symbol: string; tf: string; results: ModelResult[]; consensus: Consensus; trendDown?: boolean; atrPct?: number; patterns?: FramePatterns[]; maCross?: MaView[]; desk?: DeskView; cost?: AgentCost; gate?: PlanGate } | null;
  bots?: BotSlot[]; // extra bots (2 and 3); bot 1 is bot / lastSignal
};
// One line of the agents' log: which agent wrote it (and on which coin), when, and how it should look.
// What a log line decided (server/src/botlog.ts): bought, sold, stayed out and why, chose a coin...
export type DecisionAct = "enter" | "exit" | "skip" | "filtered" | "order" | "pick" | "left" | "wait" | "lock" | "start" | "stop";
// by = for a coin ruled out or let go: which check did it.
export type Decision = { act: DecisionAct; coin?: string; why: string; by?: "scouts" | "numbers" | "cost"; usd?: number; of?: number; pnl?: number; pct?: number };
// Lines of the quality step (it works for all of the account's agents, so they are no one agent's)
// carry this in place of an agent's number.
export const STEP_BOT = "0";
export type LogLine = { t: number; bot: string; sym?: string; msg: string; level: "info" | "good" | "bad"; d?: Decision };
export type BotSlot = { id: string; bot: AppState["bot"]; lastSignal: AppState["lastSignal"] };
// Every bot of the account, bot 1 first.
export const allBots = (s: AppState | null): BotSlot[] => (s ? [{ id: "1", bot: s.bot, lastSignal: s.lastSignal }, ...(s.bots ?? [])] : []);
// The account state as one bot sees it (its own bot / plan; shared cash and positions).
export const stateForBot = (s: AppState | null, id: string): AppState | null => {
  if (!s || id === "1") return s;
  const b = s.bots?.find((x) => x.id === id);
  return { ...s, bot: b?.bot ?? { ...s.bot, running: false, config: null, log: [], target: null, candidates: [], blocked: null, startedAt: null, stoppedAt: null, lastWatch: null }, lastSignal: b?.lastSignal ?? null };
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
export type PlanInfo = { id: PlanId; name: string; priceUsd: number; blurb: string; aiTokens: number; feePct: number; freeTrades: number; bots?: number; permissions: Permission[] }; // freeTrades -1 = unlimited
export type User = { prefs?: { hide: string[] }; username: string; firstName: string; lastName: string; email: string; createdAt: number; avatarUrl: string | null; owner?: boolean; plan?: PlanId; role?: "user" | "admin"; permissions?: Permission[]; botLimit?: number; usage?: Usage; solanaAddress?: string | null; hasPassword?: boolean; tradeMode?: "paper" | "real" };
export type AdminUser = User & { usage: Usage };
export type RealQuote = { requestId: string; transaction: string; wallet: string; side: "BUY" | "SELL"; pay: "SOL" | "USDC"; symbol: string; mint: string; inAmount: number; outAmount: number; inSymbol: string; outSymbol: string; usd: number | null; priceImpactPct: number; slippageBps: number | null; router: string | null; swapFeeBps: number; platformFee: { bps: number; note: string }; networkFeeSol: number; gasless: boolean; expiresAt: number; maxTradeUsd: number };
export type RealTrade = { t: number; side: "BUY" | "SELL"; symbol: string; mint: string; pay: "SOL" | "USDC"; status: "Success" | "Failed"; signature: string | null; inAmount: number; outAmount: number; inSymbol: string; outSymbol: string; usd: number | null; feeBps: number; error?: string };
export type ListKind = "crypto" | "top" | "trending" | "held" | "graduated" | "bonding" | "community";
export type ListCoin = { mint: string; symbol: string; name: string; icon?: string; priceUsd: number; mcap: number; change24h: number; holders?: number; volume24h?: number; liquidity?: number; verified?: boolean; buys?: number; buyers?: number; pair?: PairInfo; score?: number | null; verdict?: "BUY ZONE" | "WAIT" | "AVOID"; why?: string; rank?: number; query?: string };
export type Holding = { mint: string; symbol: string; name: string; amount: number; priceUsd: number | null; valueUsd: number | null; imageUrl?: string; pool?: string };
export type WalletView = { address: string | null; holdings: Holding[]; totalUsd: number; updatedAt: number; rpc?: "custom" | "public" };
export type AuditEntry = { t: number; type: string; by?: string; summary: string; data?: Record<string, unknown> };
export type Page<T> = { total: number; items: T[] };
// Chart patterns the server found on each timeframe, with how each did earlier on the same chart.
export type FramePatterns = { tf: string; hits: { key: string; label: string; bias: "up" | "down" | "neutral"; level?: number; note: string; stat?: { seen: number; worked: number; avgPct: number } }[] };
// The moving-average crossover signal on one chart (20-candle average against 50-candle average,
// closed candles only): BUY / SELL on the newest closed candle, else HOLD with which side the
// fast average is on and when it last crossed.
export type MaView = { tf: string; signal: "BUY" | "SELL" | "HOLD"; trend: "up" | "down" | "flat"; spreadPct: number; fast: number; slow: number; last?: { signal: "BUY" | "SELL"; candlesAgo: number; price: number; time: number | null } };
export type Analysis = { pair: PairInfo; snapshot: Snapshot; results: ModelResult[]; consensus: Consensus; patterns?: FramePatterns[]; maCross?: MaView[] };

// Signed out and pressed something that needs an account (buy, start bot, analyze...):
// open the sign-in / register window instead of showing an error.
export const SIGNIN_EVENT = "nexus:signin-needed";
// The MoonPay wallet was just put on file (MoonPaySignIn.tsx): the wallet window loads it again.
export const MOONPAY_WALLET_EVENT = "moonpay-wallet-changed";
export class SignInNeeded extends Error {
  constructor() {
    super(""); // empty: no error toast, the sign-in window opens instead
    this.name = "SignInNeeded";
  }
}
async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && body !== undefined && !path.startsWith("/auth/")) {
    window.dispatchEvent(new Event(SIGNIN_EVENT));
    throw new SignInNeeded();
  }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

// Load a coin's chart into the browser cache ahead of a click (hovering a coin row).
const prefetched = new Map<string, number>();
export async function prefetchChart(chain: string, pool: string, tf: Timeframe) {
  const key = `${chain}:${pool}:${tf}`;
  if (Date.now() - (prefetched.get(key) ?? 0) < 20_000) return;
  prefetched.set(key, Date.now());
  try {
    const r = await api.candles(chain, pool, tf);
    const { saveChart } = await import("./persist");
    saveChart(pool, tf, r.candles, r.source);
  } catch {
    prefetched.delete(key);
  }
}

// ---------- MoonPay: the customer's wallet, buying, and every real-money transaction ----------
export type TxStatus = "started" | "pending" | "completed" | "failed" | "cancelled" | "refunded" | "expired";
export type WalletTx = {
  id: string; provider: string; providerId: string | null; kind: "buy" | "sell" | "swap" | "send" | "receive"; status: TxStatus; providerStatus: string | null; final: boolean;
  fiatCurrency: string | null; fiatAmount: number | null; feeAmount: number | null; networkFeeAmount: number | null; extraFeeAmount: number | null;
  cryptoCurrency: string | null; network: string | null; cryptoAmount: number | null; walletAddress: string | null; txHash: string | null;
  failureReason: string | null; flag: string | null; createdAt: number; updatedAt: number; providerUpdatedAt: number | null;
};
export type WalletTxEvent = { at: number; source: string; type: string | null; status: string | null; applied: boolean; note: string | null };
export type MoonPayStatus = { on: boolean; mode: "sandbox" | "live" | null; reason: string | null; webhooks: boolean; publishableKey: string | null; minBuy: number; maxBuy: number };
export type MoonWalletsStatus = { on: boolean; mode: "sandbox" | "live" | null; reason: string | null; publishableKey: string | null; appId: string | null };
export type MoonWallet = { address: string; chain: "solana"; via: string; moonxUserId: string | null; at: number };
// The four wallets MoonPay makes for a person (the Ethereum one also works on BNB Chain, Base, Polygon,
// Arbitrum, Optimism and Avalanche), and what is in them, network by network.
export const WALLET_KINDS = ["solana", "ethereum", "bitcoin", "tron"] as const;
export type WalletChain = (typeof WALLET_KINDS)[number];
export type ChainWallet = { address: string; chain: WalletChain; via: string; moonxUserId: string | null; at: number };
export type BalanceRow = { network: string; symbol: string; amount: number | null; usd?: number | null; test?: boolean };
export type BuyOptions = { coins: { id: string; label: string; wallet?: WalletChain }[]; fiats: { code: string; min: number; max: number }[] };
export type MoonWalletView = { wallet: MoonWallet | null; all?: ChainWallet[]; wallets: MoonWalletsStatus; buying: MoonPayStatus; options: BuyOptions | null; buyInto: { address: string; which: "moonpay" | "current-test" } | null; balance: { sol: number | null; network: string } | null };

export const api = {
  walletTxs: (before?: number) => req<{ transactions: WalletTx[]; moonpay: MoonPayStatus }>(`/wallet/transactions?limit=50${before ? `&before=${before}` : ""}`),
  walletTx: (id: string) => req<{ tx: WalletTx; events: WalletTxEvent[] }>(`/wallet/transactions/${encodeURIComponent(id)}`),
  moonWallet: () => req<MoonWalletView>("/moonpay/wallet"),
  moonBalances: (fresh = false) => req<{ balances: Partial<Record<WalletChain, BalanceRow[]>>; totalUsd?: number; complete?: boolean }>(`/moonpay/balances${fresh ? "?fresh=1" : ""}`),
  moonSession: () => req<{ sessionToken: string }>("/moonpay/session", {}),
  moonChallenge: () => req<{ message: string; expiresAt: number }>("/moonpay/wallet/challenge", {}),
  moonProve: (body: { address: string; signature: string; accessToken: string; identityToken: string }) => req<{ wallet: MoonWallet }>("/moonpay/wallet/prove", body),
  buyStart: (body: { fiatCurrency: string; asset: string; fiatAmount: number }) => req<{ id: string; walletAddress: string; asset: string; fiatCurrency: string; fiatAmount: number; customerRef: string }>("/moonpay/buy/start", body),
  buyWidget: (body: { fiatCurrency: string; asset: string; fiatAmount: number; payWith: "card" | "apple_pay" | "google_pay" }) => req<{ id: string; url: string; walletAddress: string; which: string; fiatCurrency: string; fiatAmount: number; asset: string }>("/moonpay/buy/widget", body),
  buyCheck: (id: string) => req<{ status: TxStatus; failureReason: string | null; providerId: string | null }>("/moonpay/buy/check", { id }),
  buyLink: (id: string, transactionId: string) => req<{ ok: boolean; status: TxStatus | null }>("/moonpay/buy/link", { id, transactionId }),
  status: () => req<Status>("/status"),
  search: (q: string) => req<PairInfo[]>(`/search?q=${encodeURIComponent(q)}`),
  realQuote: (b: { side: "BUY" | "SELL"; pay: "SOL" | "USDC"; mint: string; symbol: string; usd?: number; pct?: number; slippageBps?: number }) => req<RealQuote>("/real/quote", b),
  realFees: () => req<{ bps: number; note: string }>("/real/fees"),
  sendSolanaQuote: (b: { mint: string; symbol?: string; to: string; amount: string }) => req<{ requestId: string; transaction: string; wallet: string; to: string; symbol: string; amount: number; networkFeeSol: number; createsAccount: boolean; expiresAt: number }>("/wallet/send/solana/quote", b),
  sendSolanaExecute: (b: { requestId: string; signedTransaction: string }) => req<{ status: "completed" | "failed" | "pending"; signature: string | null; error: string | null }>("/wallet/send/solana/execute", b),
  sendTronBuild: (b: { asset: "TRX" | "USDT"; to: string; amount: string }) => req<{ transaction: unknown; wallet: string; to: string; asset: string; amount: number }>("/wallet/send/tron/build", b),
  sendRecord: (b: { chain: "ethereum" | "tron"; hash: string; chainId?: number; to?: string; amount?: number; asset?: string }) => req<{ recorded: boolean }>("/wallet/send/record", b),
  realExecute: (b: { requestId: string; signedTransaction: string }) => req<RealTrade>("/real/execute", b),
  // The wallet real trades come from (the MoonPay wallet on file) and its balances.
  realWallet: (fresh = false) => req<WalletView & { via: "moonpay" | null }>(`/real/wallet${fresh ? "?fresh=1" : ""}`),
  realTrades: (limit = 50) => req<RealTrade[]>(`/real/trades?limit=${limit}`),
  list: (kind: ListKind) => req<{ kind: ListKind; coins: ListCoin[] }>(`/lists/${kind}`),
  pair: (chain: string, pool: string) => req<PairInfo>(`/pair/${chain}/${pool}`),
  // before = unix seconds: the page of candles just older than that (for scrolling back in time).
  // from = the source the chart's candles came from, so older pages come from the same one.
  // origin (in the answer) = where the candles were really read from, even when served from a cache.
  candles: async (chain: string, pool: string, tf: Timeframe, before?: number, from?: string) => {
    const res = await fetch(`/api/candles/${chain}/${pool}?tf=${tf}${before ? `&before=${Math.floor(before)}` : ""}${before && from ? `&from=${encodeURIComponent(from)}` : ""}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    const source = res.headers.get("X-Candle-Source") ?? "unknown";
    return { candles: data as Candle[], source, origin: res.headers.get("X-Candle-Origin") ?? source, note: res.headers.get("X-Candle-Note") ?? "" };
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
  consentOff: (b: { setting: string; label: string; warning: string; botId?: string }) => req<{ ok: boolean }>("/consent/setting-off", b),
  botStrongMode: (on: boolean, botId = "1") => req<{ ok: boolean; strongMode: boolean }>("/bot/strong-mode", { on, botId }),
  botRewardRule: (on: boolean, botId = "1") => req<{ ok: boolean; rewardRule: boolean }>("/bot/reward-rule", { on, botId }),
  botQualityGate: (on: boolean, botId = "1") => req<{ ok: boolean; qualityGate: boolean }>("/bot/quality-gate", { on, botId }),
  signIn: (b: { login: string; password: string }) => req<{ user: User }>("/auth/signin", b),
  signUp: (b: { username: string; firstName: string; lastName: string; email: string; password: string }) => req<{ user: User }>("/auth/signup", b),
  signOut: () => req("/auth/signout", {}),
  // Sign up and sign in with MoonPay (its wallet sign-in): MoonPay's two tokens; the server checks them itself.
  moonpayLogin: (t: { accessToken: string; identityToken: string }) => req<{ user?: User; needsProfile?: boolean; email?: string | null; firstName?: string; lastName?: string }>("/auth/moonpay-login", t),
  moonpayComplete: (b: { accessToken: string; identityToken: string; username: string; firstName: string; lastName: string }) => req<{ user: User }>("/auth/moonpay-complete", b),
  moonpayWalletSync: (t: { accessToken: string; identityToken: string }) => req<{ wallet: MoonWallet | null; all: ChainWallet[] }>("/moonpay/wallet/sync", t),
  changePassword: (b: { current: string; next: string }) => req("/auth/password", b),
  setTradeMode: (mode: "paper" | "real") => req<{ user: User }>("/auth/trade-mode", { mode }),
  // The parts of the app this user has hidden (saved on their account).
  setPrefs: (hide: string[]) => req<{ user: User }>("/auth/prefs", { hide }),
  plans: () => req<PlanInfo[]>("/plans"),
  agents: () => req<{ at: number; scanned: number; pass: number; coins: AgentCoin[] }>("/agents"),
  searchCoins: (q: string) => req<{ crypto: ListCoin[]; tokens: (ListCoin & { organic?: number })[]; address: boolean }>(`/search-coins?q=${encodeURIComponent(q)}`),
  wallet: (fresh = false) => req<WalletView>(`/wallet${fresh ? "?fresh=1" : ""}`),
  activity: (before = 0) => req<Page<AuditEntry>>(`/activity?before=${before}&limit=50`),
  tradeHistory: (before = 0, limit = 200) => req<Page<Trade>>(`/trades/history?before=${before}&limit=${limit}`),
  adminActivity: (username: string, before = 0) => req<Page<AuditEntry>>(`/admin/activity?username=${encodeURIComponent(username)}&before=${before}&limit=50`),
  planExtras: () => req<PlanExtras>("/plans/extras"),
  adminTopup: (b: { username: string; tokens: number }) => req<{ username: string; topup: number }>("/admin/topup", b),
  adminUsers: () => req<AdminUser[]>("/admin/users"),
  setUserAccess: (b: { username: string; plan?: PlanId; role?: "user" | "admin" }) => req<User>("/admin/users", b),
  reset: (startCash: number) => req("/reset", { startCash }),
  startBot: (cfg: BotConfig, botId = "1") => req("/bot/start", { ...cfg, botId }),
  // Several auto-pick agents at once (one budget each); strict = only coins that pass every scout check.
  startAuto: (cfg: Omit<BotConfig, "chain" | "pool" | "symbol">, budgets: number[], strict: boolean) => req<{ started: string[] }>("/bot/start-auto", { ...cfg, budgets, strict }),
  // The agents' log between two times (newest first, in pages; the last week is kept).
  botLog: (from: number, to: number, limit = 500, decisions = false) => req<{ lines: LogLine[]; more: boolean }>(`/bot/log?from=${Math.floor(from)}&to=${Math.floor(to)}&limit=${limit}${decisions ? "&only=decisions" : ""}`),
  stopBot: (botId = "1") => req("/bot/stop", { botId }),
  removeBot: (botId: string) => req("/bot/remove", { botId }),
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
