// Remembers the page between refreshes (on this device only, in localStorage):
//  - UI choices: the coin you were viewing, timeframe, open tab, scanner chain
//  - the last data seen (account state, the chart's candles, the scanner list), so a
//    refresh shows everything instantly and then quietly updates from the server.
// Sizes are bounded: one account state, up to 3 recent charts, one list per chain.
import type { AppState, Candle, PairInfo, ScanResult, Timeframe } from "./api";

const KEY = "nexus-v1";
type Saved = {
  ui: { pair?: PairInfo; tf?: Timeframe; tab?: string; scanChain?: string };
  state?: AppState;
  charts: { key: string; candles: Candle[]; source: string }[]; // most recent first, max 3
  scans: Record<string, ScanResult>;
};

let mem: Saved = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s && typeof s === "object") return { ui: s.ui ?? {}, state: s.state, charts: s.charts ?? [], scans: s.scans ?? {} };
  } catch {
    // corrupted or unavailable storage: start fresh
  }
  return { ui: {}, charts: [], scans: {} };
})();

let pending: ReturnType<typeof setTimeout> | null = null;
function write() {
  // Batch writes (several changes per refresh cycle become one localStorage write).
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(mem));
    } catch {
      // storage full: drop the bulky caches and keep the UI choices
      mem = { ui: mem.ui, charts: [], scans: {} };
      try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* give up quietly */ }
    }
  }, 300);
}

export const savedUi = () => mem.ui;
export function saveUi(patch: Saved["ui"]) {
  mem.ui = { ...mem.ui, ...patch };
  write();
}

export const savedState = () => mem.state;
export function saveState(s: AppState) {
  mem.state = s;
  write();
}

const chartKey = (pool: string, tf: Timeframe) => `${pool}:${tf}`;
export const savedChart = (pool: string, tf: Timeframe) => mem.charts.find((c) => c.key === chartKey(pool, tf));
export function saveChart(pool: string, tf: Timeframe, candles: Candle[], source: string) {
  const key = chartKey(pool, tf);
  mem.charts = [{ key, candles, source }, ...mem.charts.filter((c) => c.key !== key)].slice(0, 3);
  write();
}

export const savedScan = (chain: string) => mem.scans[chain];
export function saveScan(chain: string, r: ScanResult) {
  mem.scans = { ...mem.scans, [chain]: r };
  write();
}
