// Candle fixtures for back-tests: one gzipped JSON file per coin in server/backtest/fixtures/,
// holding its candles on several timeframes (rows of [time, open, high, low, close, volume]),
// the pool's liquidity and what a round trip really cost on Jupiter when the candles were saved.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Candle } from "../data.js";

export type Fixture = {
  symbol: string;
  pool: string;
  savedAt: string;
  liquidityUsd: number;
  roundTripPct: Record<string, number>; // measured round-trip cost in %, by trade size in USD ("100", "1000")
  // What the scouts' quality gate said about the coin when the fixture was saved (they have no history to replay).
  scouts?: { at: string; ok: boolean; quality: number; reasons: string[] };
  candles: Record<string, Candle[]>; // "5s", "1m", "5m", "15m", "1h"
};
type Row = [number, number, number, number, number, number];
type Stored = Omit<Fixture, "candles"> & { candles: Record<string, Row[]> };

export const FIXTURE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../backtest/fixtures");
export const TF_SEC: Record<string, number> = { "5s": 5, "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };

export function loadFixtures(only?: string[], dir = FIXTURE_DIR): Fixture[] {
  if (!fs.existsSync(dir)) return [];
  const want = only?.map((s) => s.toLowerCase());
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json.gz"))
    .sort()
    .map((f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString("utf8")) as Stored)
    .filter((s) => !want || want.some((w) => s.symbol.toLowerCase().includes(w)))
    .map((s) => ({
      ...s,
      candles: Object.fromEntries(Object.entries(s.candles).map(([tf, rows]) => [tf, rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))])),
    }));
}

export function saveFixture(fx: Fixture, dir = FIXTURE_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const sig = (x: number) => Number(x.toPrecision(7));
  const stored: Stored = {
    ...fx,
    candles: Object.fromEntries(Object.entries(fx.candles).map(([tf, cs]) => [tf, cs.map((c): Row => [c.time, sig(c.open), sig(c.high), sig(c.low), sig(c.close), Math.round(c.volume * 100) / 100])])),
  };
  const file = path.join(dir, `${fx.symbol.replace(/[^a-zA-Z0-9]/g, "_")}_${fx.pool.slice(0, 6)}.json.gz`);
  // Written beside the file and moved into place, so a reader never sees half a file.
  fs.writeFileSync(`${file}.tmp`, zlib.gzipSync(Buffer.from(JSON.stringify(stored)), { level: 9 }));
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

// The round-trip cost in % for a trade of `usd` in this coin, from the measurements saved with it:
// a straight line through the measured sizes (cost grows with size), never below the smallest one.
// Without measurements: the pool-depth estimate (see costs in the engine), or 3% when even the
// liquidity is unknown.
export function measuredRoundTripPct(fx: Fixture, usd: number): number {
  const pts = Object.entries(fx.roundTripPct ?? {}).map(([s, p]) => [Number(s), p] as const).filter(([s, p]) => s > 0 && p >= 0).sort((a, b) => a[0] - b[0]);
  if (pts.length >= 2) {
    const [[s0, p0], [s1, p1]] = [pts[0], pts[pts.length - 1]];
    const slope = Math.max(0, (p1 - p0) / (s1 - s0));
    return Math.max(Math.min(p0, p1), p0 + slope * (usd - s0));
  }
  if (pts.length === 1) return pts[0][1];
  return fx.liquidityUsd > 0 ? 0.6 + 2 * ((200 * usd) / fx.liquidityUsd) : 3;
}
