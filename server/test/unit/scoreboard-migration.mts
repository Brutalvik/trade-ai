// The scoreboard's "trades it made" must hold real results only: an account saved by the older
// version (where that line was scored from the chart) gets it rebuilt once from its real trades.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-"));
process.chdir(dir);
delete process.env.VERCEL;
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS/.test(k)) delete process.env[k];
const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
const { createStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const other = createStore();
let pass = 0, fail = 0;
const expect = (name: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`); };

await engine.withAccount("tmp", async () => { await engine.sync(); engine.reset(1500); await engine.flush(); });
const base: any = await other.load("tmp");
const T = 1794621517000; // v0.54.0's commit time (2026-11-14T01:58:37Z): predictions began
const min = 60_000;
const tr = (side: string, at: number, extra: any = {}) => ({ id: Math.random().toString(36).slice(2), time: at, side, symbol: "X", pool: "P1", price: 1, qty: 1, usd: 100, feeUsd: 1, reason: "t", source: "bot", strategy: "agents", botId: "1", ...extra });
const trades = [ // newest first, as the engine keeps them
  tr("SELL", T + 50 * min, { botId: "2", pool: "P2", reachedTarget: true, pnlUsd: 5 }),   // counted: a win
  tr("BUY", T + 40 * min, { botId: "2", pool: "P2" }),
  tr("SELL", T + 35 * min, { source: "manual", reachedTarget: true }),                   // closed by hand: not counted
  tr("SELL", T + 30 * min, { reachedTarget: false, pnlUsd: -9 }),                        // counted: a loss
  tr("BUY", T + 20 * min),
  tr("SELL", T + 12 * min, { strategy: undefined, reachedTarget: true }),                 // not an agent's trade
  tr("SELL", T + 10 * min, { reachedTarget: false, pnlUsd: -9 }),                        // bought before predictions began: not counted
  tr("BUY", T - 10 * min),
];
const old = { scored: 12, taken: { n: 6.9, hits: 4.9 }, refused: { n: 5, hits: 2 }, ai: { n: 12, sumP: 5, hits: 7, brier: 3 } };
await other.save({ ...structuredClone(base), trades, fc: { pending: [], stats: old, last: [] } }, "older");
await other.save({ ...structuredClone(base), trades, fc: { pending: [], stats: { ...old, taken: { n: 3, hits: 0 }, v: 2 }, last: [] } }, "newer");
await other.save({ ...structuredClone(base), trades }, "none");

expect("the cutoff is v0.54.0's go-live", Date.UTC(2026, 10, 14, 1, 58, 37), T);
await engine.withAccount("older", async () => {
  await engine.sync();
  const s: any = engine.getState().fc?.stats;
  expect("older account: 'trades it made' rebuilt from the real trades", s.taken, { n: 2, hits: 1 });
  expect("older account: marked as migrated", s.v, 2);
  expect("older account: the rest of the record is kept", { refused: s.refused, ai: s.ai, scored: s.scored }, { refused: old.refused, ai: old.ai, scored: old.scored });
});
await engine.withAccount("newer", async () => {
  await engine.sync();
  expect("already migrated: left alone", (engine.getState().fc?.stats as any).taken, { n: 3, hits: 0 });
});
await engine.withAccount("none", async () => {
  await engine.sync();
  expect("no scoreboard yet: nothing invented", engine.getState().fc, null);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
