// Two server copies of one account: a stale copy must not undo a Stop or a Reset made by the other.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-"));
process.chdir(dir);
delete process.env.VERCEL;
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS/.test(k)) delete process.env[k];

const { expect, finish } = await import(new URL("../check.mts", import.meta.url).href);
const engine = await import(new URL("../../src/engine.ts", import.meta.url).href);
const { createStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const other = createStore(); // "the other server copy": reads and writes the same storage directly
const KEY = "tester";
const cfg = { chain: "solana", pool: "Pool01", symbol: "A01", tf: "5m", positionPct: 100, minConfidence: 0, analyzeEverySec: 600, checkEverySec: 5, maxDrawdownPct: 25, goalUsd: 1e9, pick: "agent", budgetUsd: 1000, trailPct: 3, riskPerTradePct: 0, dailyLossPct: 10, cooldownMin: 30, breakEvenAtPct: 6, lockPct: 50, disabled: [] };

await engine.withAccount(KEY, async () => {
  await engine.sync();
  engine.reset(1500);
  await engine.flush();
  engine.startBot(cfg as any, "1", 10);
  await engine.flush();
  let g: any = engine.getState();
  console.log(`this copy: agent running ${g.bot.running}, available $${g.available}, locked $${g.locked}`);

  // The other copy stops the agent (as the Stop button does): saves its version + the control record.
  const theirs: any = await other.load(KEY);
  const at = Date.now() + 5;
  theirs.bot.running = false; theirs.bot.stoppedAt = at;
  await other.save(theirs, KEY);
  await other.kvSet(`ctl:${KEY}`, { resetAt: theirs.resetAt, stops: { "1": at } });
  console.log("other copy pressed Stop. Stored: running", (await other.load(KEY) as any).bot.running);

  // This copy still believes the agent runs, and saves (as it does when its AI step finishes).
  engine.updateSettings({});
  await engine.flush();
  const stored: any = await other.load(KEY);
  g = engine.getState();
  console.log(`after the stale copy saved -> stored: running ${stored.bot.running} | this copy now: running ${g.bot.running}, available $${g.available}, locked $${g.locked}`);
  expect("a Stop made by another server copy survives a save from a stale copy", [stored.bot.running, g.bot.running, g.available, g.locked], [false, false, 1500, 0]);

  // The other copy resets the account to $1,000.
  const rAt = Date.now() + 10;
  const fresh: any = structuredClone(stored);
  fresh.cash = 1000; fresh.startCash = 1000; fresh.trades = []; fresh.positions = []; fresh.resetAt = rAt;
  await other.save(fresh, KEY);
  await other.kvSet(`ctl:${KEY}`, { resetAt: rAt, stops: {} });
  engine.updateSettings({}); // the stale copy (cash $1,500) saves again
  await engine.flush();
  console.log("after a Reset elsewhere and a stale save -> stored cash $" + (await other.load(KEY) as any).cash);
  expect("a Reset made elsewhere is not undone by a stale copy", (await other.load(KEY) as any).cash, 1000);
});
finish();
