// Remembers the page between refreshes (on this device only, in localStorage):
//  - UI choices: the coin you were viewing, timeframe, open tab, scanner chain
//  - the last data seen (account state, the chart's candles, the scanner list), so a
//    refresh shows everything instantly and then quietly updates from the server.
// Sizes are bounded: one account state, up to 3 recent charts, one list per chain.
import type { Analysis, AppState, Candle, PairInfo, ScanResult, Timeframe } from "./api";

// One saved Claude analysis per coin (only what the page shows, not the raw data sent).
export type SavedAnalysis = { at: number; results: Analysis["results"]; consensus: Analysis["consensus"] };

const KEY = "nexus-v1";
type Saved = {
  ui: { pair?: PairInfo; tf?: Timeframe; tab?: string; scanChain?: string; newChain?: string };
  state?: AppState;
  charts: { key: string; candles: Candle[]; source: string }[]; // most recent first, max 3
  scans: Record<string, ScanResult>;
  analyses: Record<string, SavedAnalysis>; // by pool, the 20 most recent
};

let mem: Saved = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s && typeof s === "object") return { ui: s.ui ?? {}, state: s.state, charts: s.charts ?? [], scans: s.scans ?? {}, analyses: s.analyses ?? {} };
  } catch {
    // corrupted or unavailable storage: start fresh
  }
  return { ui: {}, charts: [], scans: {}, analyses: {} };
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
      mem = { ui: mem.ui, charts: [], scans: {}, analyses: mem.analyses };
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

// Claude's plan per coin, so switching coins (or refreshing) doesn't need a new, paid analysis.
export const savedAnalysis = (pool: string): SavedAnalysis | undefined => mem.analyses[pool];
export function saveAnalysis(pool: string, a: Analysis | SavedAnalysis, at = Date.now()): SavedAnalysis {
  const entry: SavedAnalysis = { at: "at" in a ? a.at : at, results: a.results, consensus: a.consensus };
  const keep = Object.entries({ ...mem.analyses, [pool]: entry }).sort((x, y) => y[1].at - x[1].at).slice(0, 20);
  mem.analyses = Object.fromEntries(keep);
  write();
  return entry;
}
