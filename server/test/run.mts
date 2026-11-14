// Runs the test scripts and fails (exit code 1) if any check in any of them fails.
//
//   npm test             the quick checks (about 2 minutes): order check, prediction, crossover,
//                        scoreboard migration, chart source
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
  { name: "order-check", file: "unit/order-check.mts", what: "an agent's order is used only if the combined chance beats what it needs" },
  { name: "prediction", file: "unit/prediction.mts", what: "the prediction engine on made-up candles with a known answer" },
  { name: "macross", file: "unit/macross.mts", what: "moving-average crossover: the averages, the rule, closed candles only" },
  { name: "macross-engine", file: "unit/macross-engine.mts", what: "the crossover reaches the AI, the plan, the coin study and the endpoint" },
  { name: "scoreboard-migration", file: "unit/scoreboard-migration.mts", what: "the scoreboard's real results are rebuilt from real trades" },
  { name: "chart-source", file: "unit/chart-source.mts", what: "a chart stays on one candle source" },
];
const ENGINE: Job[] = [
  { name: "profit-ride", file: "engine/profit.mts", env: { SC: "ride" }, what: "past +5% the AI holds, then sells near the top" },
  { name: "profit-trail", file: "engine/profit.mts", env: { SC: "trail" }, what: "past +5% the exit follows the high and sells on a pullback" },
  { name: "profit-noai", file: "engine/profit.mts", env: { SC: "noai" }, what: "the AI can't be reached: a fixed rule protects the profit" },
  { name: "profit-min", file: "engine/profit.mts", env: { SC: "min" }, what: "a fall straight back sells at the locked +5%" },
  { name: "agent-lose", file: "engine/agent.mts", env: { SC: "lose" }, what: "a stop-out, then the agent trades on (no daily limit, no cool-down)" },
  { name: "agent-wick", file: "engine/agent.mts", env: { SC: "wick" }, what: "the stop waits about 10 seconds: a wick doesn't sell, a real fall does" },
  { name: "agent-crash", file: "engine/agent.mts", env: { SC: "crash" }, what: "a crash through the stop sells at once" },
  { name: "agent-quiet", file: "engine/agent.mts", env: { SC: "quiet" }, what: "a coin that isn't moving: the prediction check refuses the buy" },
  { name: "agent-manual", file: "engine/agent.mts", env: { SC: "quiet", MANUAL: "1" }, what: "your own Analyze never replaces an agent's plan" },
  { name: "breakout-buy", file: "engine/breakout.mts", env: { SC: "buy" }, what: "a breakout is bought only once it has held" },
  { name: "breakout-spike", file: "engine/breakout.mts", env: { SC: "spike" }, what: "a spike that falls back is not bought" },
  { name: "breakout-chase", file: "engine/breakout.mts", env: { SC: "chase" }, what: "a breakout that ran away is not chased" },
  { name: "breakout-volume", file: "engine/breakout.mts", env: { SC: "buy", VOLREQ: "5" }, what: "a breakout without the volume the AI asked for is not bought" },
  { name: "relook-move", file: "engine/breakout.mts", env: { SC: "move" }, what: "a real price move makes the agent ask its AI again" },
  { name: "relook-touch", file: "engine/breakout.mts", env: { SC: "touch" }, what: "reaching a refused level makes the agent ask again" },
  { name: "ten-agents", file: "engine/ten-agents.mts", env: { SC: "win" }, what: "ten agents at once, an eleventh refused" },
  { name: "locked-budgets", file: "engine/locked-budgets.mts", env: { SC: "win" }, what: "an agent's budget can't be spent by you or another agent" },
  { name: "stop-sticks", file: "engine/stop-sticks.mts", env: { SC: "win" }, what: "a Stop wins over an AI answer that arrives after it" },
  { name: "stale-copy", file: "engine/stale-copy.mts", env: { SC: "win" }, what: "a stale server copy can't undo a Stop or a Reset" },
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
