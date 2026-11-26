// Runs the test scripts and fails (exit code 1) if any check in any of them fails.
//
//   npm test             the quick checks (about 2 minutes): order check, prediction, crossover,
//                        scoreboard migration, chart source, and the storage (the Supabase store on
//                        a real Postgres engine in memory, the move from Upstash, the server's routes)
//   npm run test:engine  the engine scenarios (about 8 minutes, three at a time): the real engine
//                        against a fake market and a scripted AI, in real 5-second steps
//   npm run test:all     both
//
// A scenario's full output is kept in a log file; on failure its last lines are printed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Job = { name: string; file: string; env?: Record<string, string>; what: string };
const here = path.dirname(new URL(import.meta.url).pathname);

const UNIT: Job[] = [
  { name: "rules", file: "unit/rules.mts", what: "fills, the stop that waits, the profit lock, breakouts, and the back-tester's replay of them" },
  { name: "costs", file: "unit/costs.mts", what: "what a round trip really costs: Jupiter quotes, the pool-depth fallback, the size cap" },
  { name: "quality-gate", file: "unit/quality-gate.mts", what: "the scouts refuse a coin for what it is, never for what its price is doing this minute" },
  { name: "order-check", file: "unit/order-check.mts", what: "an agent's order is used only if the combined chance beats what it needs" },
  { name: "prediction", file: "unit/prediction.mts", what: "the prediction engine on made-up candles with a known answer" },
  { name: "macross", file: "unit/macross.mts", what: "moving-average crossover: the averages, the rule, closed candles only" },
  { name: "macross-engine", file: "unit/macross-engine.mts", what: "the crossover reaches the AI, the plan, the coin study and the endpoint" },
  { name: "scoreboard-migration", file: "unit/scoreboard-migration.mts", what: "the scoreboard's real results are rebuilt from real trades" },
  { name: "chart-source", file: "unit/chart-source.mts", what: "a chart stays on one candle source" },
  { name: "voice", file: "unit/voice.mts", what: "which of a device's voices says the trade words: an English female one when the device has one" },
  { name: "agent-hours", file: "unit/agent-hours.mts", what: "what an account's agents made together, hour by hour, in a table linked to the account: each sale counted once, nothing lost before the table exists" },
  { name: "indicators", file: "unit/indicators.mts", what: "MACD and Bollinger Bands as the AI is given them, and the strategy playbook the planners are sent" },
  { name: "agent-log", file: "unit/agent-log.mts", what: "the agents' log is kept for a week: written with each save, read in pages (today, the last 7 days), older lines cleared by the archive function; what a line decided is kept with it" },
  { name: "decisions", file: "unit/decisions.mts", what: "the one-line view of the log: one row per decision, repeats folded, the size or the result at the right, the sum above" },
  { name: "moonwallet", file: "unit/moonwallet.mts", what: "customers' MoonPay wallets: on file only when MoonPay's sign-in tokens check out (its key, this app, not expired, same person, same email) and the wallet signs the server's one-time message; never replaced" },
  { name: "moonpay", file: "unit/moonpay.mts", what: "buying with MoonPay: the server starts a purchase into the customer's own wallet, believes MoonPay asked directly (never the browser), takes only signed messages, and finds purchases the browser never reported" },
  { name: "wallet-tx", file: "unit/wallet-tx.mts", what: "customers' real-money transactions: one row each, kept the same way in the database and the local file; the same message twice counts once, older news never overwrites newer, never across customers" },
  { name: "quality", file: "unit/quality.mts", what: "the quality step's sums: what a coin is known to cost for an agent's money, when it is measured again, the verdict on each coin of the list" },
  { name: "pipeline", file: "unit/pipeline.mts", what: "the Pipeline tab: six steps (scan, check, AI, size, execute, log), each with what it did, worked out from the decisions kept with the log" },
  { name: "user-prefs", file: "unit/user-prefs.mts", what: "a part of the app a user hides in Settings stays hidden on every sign-in: the choice is saved on the account" },
  { name: "tab-title", file: "unit/tab-title.mts", what: "the browser tab: T//R and the account's profit or loss, green or red icon" },
  { name: "trade-tone", file: "unit/trade-tone.mts", what: "an agent's card in a trade takes the colour of the profit or loss at its top right" },
  { name: "card-order", file: "unit/card-order.mts", what: "the agents' cards: those in a trade first, the highest profit at the top, moving as the figures change" },
  { name: "supabase-store", file: "unit/supabase-store.mts", what: "the Supabase store on a real Postgres engine: records, locks, lists, accounts in compressed parts" },
  { name: "sync-versions", file: "unit/sync-versions.mts", what: "a check asks the database for a version number; the account is loaded only when it changed" },
  { name: "store-move", file: "unit/store-move.mts", what: "the one-time copy from Upstash: interrupted and finished, and the server waits for it" },
  { name: "store-move-skip", file: "unit/store-move.mts", env: { MODE: "skip" }, what: "told to start empty, the server does not wait for the old database" },
  { name: "server-storage", file: "unit/server-storage.mts", what: "the server's routes with the database missing, blocked, then working: status explains, sign-in waits, the scheduler's call never looks failed" },
];
const ENGINE: Job[] = [
  { name: "profit-ride", file: "engine/profit.mts", env: { SC: "ride" }, what: "past +5% the AI holds, then sells near the top" },
  { name: "profit-trail", file: "engine/profit.mts", env: { SC: "trail" }, what: "past +5% the exit follows the high and sells on a pullback" },
  { name: "profit-noai", file: "engine/profit.mts", env: { SC: "noai" }, what: "the AI can't be reached: a fixed rule protects the profit" },
  { name: "profit-min", file: "engine/profit.mts", env: { SC: "min" }, what: "a fall straight back that stays there sells at the locked +5%, about 10 seconds later" },
  { name: "profit-dip", file: "engine/profit.mts", env: { SC: "dip" }, what: "a winning trade's exit waits about 10 seconds: a dip that bounces straight back does not sell it, staying under does" },
  { name: "profit-back", file: "engine/profit.mts", env: { SC: "back" }, what: "a winning trade that falls all the way back to the buy price is sold at once, without the wait" },
  { name: "profit-feeds", file: "engine/profit.mts", env: { SC: "feeds" }, what: "two price sources: a winning trade is not sold on the backup source alone, unless it has been the only one for half a minute" },
  { name: "agent-lose", file: "engine/agent.mts", env: { SC: "lose" }, what: "a stop-out, then the agent trades on (no daily limit, no cool-down)" },
  { name: "agent-wick", file: "engine/agent.mts", env: { SC: "wick" }, what: "the stop waits about 10 seconds: a wick doesn't sell, a real fall does" },
  { name: "agent-crash", file: "engine/agent.mts", env: { SC: "crash" }, what: "a crash through the stop sells at once" },
  { name: "agent-thin-pool", file: "engine/agent.mts", env: { SC: "thin" }, what: "a thin pool: the agent buys less, so the cost stays under its cap" },
  { name: "agent-quiet", file: "engine/agent.mts", env: { SC: "quiet" }, what: "a coin that isn't moving: the numbers rule a buy out and the AI is not asked" },
  // AIWIN 45: the forecast's random sample changes with the minute on the clock, and with the
  // scripted AI at its usual 62% this order sat on the pass line in about 1 minute of 30 (31% chance
  // against a need of 31 to 35%), where the panel then tipped it into a buy. At 45% it is refused in every minute.
  { name: "agent-no-floor", file: "engine/agent.mts", env: { SC: "quiet", MINNUM: "0", AIWIN: "45" }, what: "with the floor on the numbers off, the AI is asked and the order check refuses the buy" },
  { name: "agent-scouts", file: "engine/agent.mts", env: { SC: "scouts" }, what: "the scouts refuse a coin before the AI is asked; you can trade it anyway" },
  { name: "agent-manual", file: "engine/agent.mts", env: { SC: "quiet", MANUAL: "1" }, what: "your own Analyze never replaces an agent's plan" },
  { name: "breakout-buy", file: "engine/breakout.mts", env: { SC: "buy" }, what: "a breakout is bought only once it has held" },
  { name: "breakout-spike", file: "engine/breakout.mts", env: { SC: "spike" }, what: "a spike that falls back is not bought" },
  { name: "breakout-chase", file: "engine/breakout.mts", env: { SC: "chase" }, what: "a breakout that ran away is not chased" },
  { name: "breakout-volume", file: "engine/breakout.mts", env: { SC: "buy", VOLREQ: "5" }, what: "a breakout without the volume the AI asked for is not bought" },
  { name: "relook-move", file: "engine/breakout.mts", env: { SC: "move" }, what: "a real price move makes the agent ask its AI again" },
  { name: "relook-touch", file: "engine/breakout.mts", env: { SC: "touch", MINNUM: "0", PANEL: "20" }, what: "reaching a refused level makes the agent ask again" }, // (PANEL 20: with the forecasters at 70% the order passed its check in some minutes, by the forecast's clock-seeded sample: 32% against the 29% needed at 12:19 on 26 Nov, on the old code too)
  { name: "ten-agents", file: "engine/ten-agents.mts", env: { SC: "win" }, what: "ten agents at once, an eleventh refused" },
  { name: "auto-pick-rotate", file: "engine/auto-pick.mts", env: { SC: "rotate" }, what: "auto-pick agents take different coins from the scouts' list; after a win an agent chooses again and starts with its budget, never more; after a loss it leaves that coin and trades on with what is left" },
  { name: "auto-pick-wait", file: "engine/auto-pick.mts", env: { SC: "wait" }, what: "auto-pick, only coins that pass every scout check: with too few, agents wait at no AI cost and take the next one that passes" },
  { name: "auto-pick-nolist", file: "engine/auto-pick.mts", env: { SC: "nolist" }, what: "the scouts' list stops answering: an auto-pick agent whose trade just closed carries on with its coin, and one with no coin waits" },
  { name: "auto-pick-cost", file: "engine/auto-pick.mts", env: { SC: "cost" }, what: "an auto-pick agent passes over a coin that is too expensive for its money, waits when it can afford none, and leaves a coin that is clearly too expensive without asking its AI" },
  { name: "auto-pick-ahead", file: "engine/auto-pick.mts", env: { SC: "ahead" }, what: "the quality step prices the first coins of the agents' list ahead of them: the next agent takes its coin at once; what is ruled out is written once for the account; it stands back when Jupiter does not answer" },
  { name: "auto-pick-fresh", file: "engine/auto-pick.mts", env: { SC: "fresh" }, what: "the quality step measures a coin again after three quarters of an hour; when Jupiter does not answer then, it asks once and stands back" },
  { name: "auto-pick-window", file: "engine/auto-pick.mts", env: { SC: "window" }, what: "as deployed, run by the scheduler's calls: the quality step starts no measurement that could outlast the watch that runs it, so a watch never runs long because of it" },
  { name: "auto-pick-idle", file: "engine/auto-pick.mts", env: { SC: "idle" }, what: "an auto-pick agent whose coin gives it no order for ten minutes moves to a free coin, and stays if there is none" },
  { name: "locked-budgets", file: "engine/locked-budgets.mts", env: { SC: "win" }, what: "an agent's budget can't be spent by you or another agent" },
  { name: "stop-sticks", file: "engine/stop-sticks.mts", env: { SC: "win" }, what: "a Stop wins over an AI answer that arrives after it" },
  { name: "stale-copy", file: "engine/stale-copy.mts", env: { SC: "win" }, what: "a stale server copy can't undo a Stop or a Reset" },
  { name: "watch-loop@supabase", file: "engine/watch-loop.mts", what: "as deployed, on Supabase: the scheduler's call buys, watches, sells at the stop; a Stop from the dashboard's server copy ends the watch" },
  { name: "watch-gap-calm", file: "engine/watch-gap.mts", env: { SC: "calm", MINUTES: "2" }, what: "as deployed, across the minute: an open trade is checked every 5 seconds, also where one watch ends and the scheduler's next call begins" },
  { name: "watch-gap-thinking", file: "engine/watch-gap.mts", env: { SC: "thinking", AI_MS: "20000" }, what: "...an AI answer still on its way as a watch ends: the open trade stays checked, and the scheduler's next call waits for its turn instead of giving up" },
  { name: "watch-gap-crowd", file: "engine/watch-gap.mts", env: { SC: "crowd", AGENTS: "5" }, what: "...five agents, so every round of checks is slow: no call of the scheduler goes unwatched (every second one did)" },
  // The same scenarios with the account kept in Supabase (a real Postgres engine in memory).
  { name: "stale-copy@supabase", file: "engine/stale-copy.mts", env: { SC: "win", STORE: "supabase" }, what: "...on Supabase: a stale server copy can't undo a Stop or a Reset" },
  { name: "stop-sticks@supabase", file: "engine/stop-sticks.mts", env: { SC: "win", STORE: "supabase" }, what: "...on Supabase: a Stop wins over an AI answer that arrives after it" },
  { name: "agent-lose@supabase", file: "engine/agent.mts", env: { SC: "lose", STORE: "supabase" }, what: "...on Supabase: a stop-out, then the agent trades on" },
  { name: "profit-ride@supabase", file: "engine/profit.mts", env: { SC: "ride", STORE: "supabase" }, what: "...on Supabase: past +5% the AI holds, then sells near the top" },
  { name: "ten-agents@supabase", file: "engine/ten-agents.mts", env: { SC: "win", STORE: "supabase" }, what: "...on Supabase: ten agents at once" },
  { name: "auto-pick-rotate@supabase", file: "engine/auto-pick.mts", env: { SC: "rotate", STORE: "supabase" }, what: "...on Supabase: auto-pick agents choose, trade and choose again" },
  { name: "locked-budgets@supabase", file: "engine/locked-budgets.mts", env: { SC: "win", STORE: "supabase" }, what: "...on Supabase: an agent's budget can't be spent by you or another agent" },
];

const which = process.argv[2] ?? "unit";
const only = process.argv[3]; // optional: run just the jobs whose name contains this
const jobs = (which === "all" ? [...UNIT, ...ENGINE] : which === "engine" ? ENGINE : UNIT).filter((j) => !only || j.name.includes(only));
const lanes = which === "unit" ? 2 : 3; // scenarios run in real time and are light on the processor
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-test-logs-"));

function run(job: Job): Promise<{ job: Job; ok: boolean; secs: number; summary: string; log: string }> {
  const log = path.join(logDir, `${job.name}.log`);
  const out = fs.createWriteStream(log);
  const t0 = Date.now();
  return new Promise((done) => {
    const child = spawn("npx", ["tsx", path.join(here, job.file)], { cwd: path.join(here, ".."), env: { ...process.env, ...job.env } });
    const kill = setTimeout(() => child.kill("SIGKILL"), 400_000);
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on("close", (code) => {
      clearTimeout(kill);
      const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      const fails = text.split("\n").filter((l) => l.startsWith("FAIL"));
      const tally = text.match(/(\d+) passed, (\d+) failed/g)?.at(-1) ?? "no result line";
      done({ job, ok: code === 0 && !fails.length && /\d+ passed, 0 failed/.test(tally), secs: Math.round((Date.now() - t0) / 1000), summary: tally, log });
    });
  });
}

const queue = [...jobs];
const results: Awaited<ReturnType<typeof run>>[] = [];
await Promise.all(
  Array.from({ length: Math.min(lanes, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const r = await run(job);
      results.push(r);
      console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.job.name.padEnd(22)} ${String(r.secs).padStart(4)} s  ${r.summary.padEnd(22)} ${r.job.what}`);
      if (!r.ok) {
        const lines = fs.readFileSync(r.log, "utf8").split("\n").filter((l) => !l.startsWith("[bot]"));
        console.log(lines.filter((l) => l.startsWith("FAIL")).concat(["   ... last lines:"], lines.slice(-12)).map((l) => `      ${l.slice(0, 300)}`).join("\n"));
      }
    }
  }),
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed${failed.length ? `; FAILED: ${failed.map((r) => r.job.name).join(", ")}` : ""}. Logs: ${logDir}`);
process.exit(failed.length ? 1 : 0);
