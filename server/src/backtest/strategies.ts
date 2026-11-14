// Where back-test entries come from. A back-test cannot ask the AI, so entries are rules:
//   every:<minutes>   a buy every N minutes whenever the agent is not in a trade. No skill at all,
//                     which makes it the fair way to compare exit designs and cost models.
//   pattern:<key>     one of the entry patterns the agents study on their own coin (learn.ts):
//                     breakout, pullback, squeeze, flag, rebound, macross.
// The exit designs the back-tester can run side by side are listed here too.
import { fires, series, stopPctFor, STRATS, type StratKey } from "../learn.js";
import { EXIT_V058, type ExitDesign } from "../rules.js";
import { measuredRoundTripPct, TF_SEC, type Fixture } from "./fixtures.js";
import type { CostModel, Entry } from "./sim.js";

export type Strategy = { name: string; entries: (fx: Fixture) => Entry[] };

export function strategy(spec: string, stopPct = 5, maxHoldMin = 240): Strategy {
  const [kind, arg, tfArg] = spec.split(":");
  if (kind === "every") {
    const mins = Math.max(1, Number(arg) || 15);
    return {
      name: `a buy every ${mins} min`,
      entries: (fx) => {
        const all = Object.values(fx.candles).filter((c) => c.length);
        if (!all.length) return [];
        const from = Math.min(...all.map((c) => c[0].time)), to = Math.max(...all.map((c) => c[c.length - 1].time));
        const out: Entry[] = [];
        for (let t = Math.ceil(from / (mins * 60)) * mins * 60; t < to; t += mins * 60) out.push({ time: t, stopPct, maxHoldMin, tag: "every" });
        return out;
      },
    };
  }
  if (kind === "pattern") {
    const key = arg as StratKey;
    const st = STRATS.find((s) => s.key === key);
    if (!st) throw new Error(`Unknown pattern "${arg}". Use one of: ${STRATS.map((s) => s.key).join(", ")}`);
    const tf = tfArg && TF_SEC[tfArg] ? tfArg : "5m";
    return {
      name: `${st.label} on ${tf}`,
      entries: (fx) => {
        const c = fx.candles[tf] ?? [];
        if (c.length < 80) return [];
        const s = series(c);
        const out: Entry[] = [];
        // The pattern is read on a closed candle; the buy is at the next price after it closes.
        for (let i = 30; i < c.length - 1; i++) if (fires(key, s, i)) out.push({ time: c[i].time + TF_SEC[tf], stopPct: stopPctFor(s, i), maxHoldMin: tf === "1h" ? 720 : maxHoldMin, tag: key });
        return out;
      },
    };
  }
  throw new Error(`Unknown entries "${spec}". Use every:<minutes> or pattern:<key>[:<timeframe>]`);
}

// ---------- Exit designs ----------
const ADAPTIVE: ExitDesign["trail"] = { kind: "atr", mult: 1.8, minPct: 2.5, maxPct: 12 };
export const DESIGNS: Record<string, ExitDesign> = {
  // What the bot runs: +5% after costs is locked the moment it is reached; the exit follows 2.5% behind the high;
  // a trade that neither stops out nor reaches +5% is held with no time limit.
  v058: EXIT_V058,
  // The same with the order's time limit working (the trade is sold when its holding time is up).
  timed: { ...EXIT_V058, name: "v0.58.0 + time limit", timeLimit: true },
  // The same lock, but the exit follows 1.8 x the coin's usual 5-minute swing behind (2.5% to 12%).
  adaptive: { ...EXIT_V058, name: "adaptive trail", trail: ADAPTIVE },
  "adaptive-timed": { ...EXIT_V058, name: "adaptive trail + time limit", trail: ADAPTIVE, timeLimit: true },
  // ...and once up 10%, at least half of the best gain is kept.
  ratchet: { ...EXIT_V058, name: "adaptive trail + keep half above 10%", trail: ADAPTIVE, ratchet: { fromNetPct: 10, keep: 0.5 } },
  // Break-even after costs is locked at +5%; the +5% floor only at +8%; then the adaptive trail.
  breakeven: { ...EXIT_V058, name: "break-even at +5%, floor at +8%", softLock: { atNetPct: 5, floorNetPct: 0 }, lockAtNetPct: 8, trail: ADAPTIVE },
  // The stop-loss stays until the trade is up +10%; then +5% is locked and the adaptive trail follows.
  late: { ...EXIT_V058, name: "floor locked at +10%", lockAtNetPct: 10, trail: ADAPTIVE },
  // The same late lock with today's fixed 2.5% trail (to see which of the two changes matters).
  "late-fixed": { ...EXIT_V058, name: "floor locked at +10%, 2.5% trail", lockAtNetPct: 10 },
};

// ---------- Cost models ----------
export const COSTS: Record<string, CostModel> = {
  // What the app assumes today: 1% fee + 0.5% slippage on each side, whatever the coin or the size.
  flat: { name: "flat", roundTripPct: () => 3 },
  // What a round trip of that size really cost on Jupiter when the candles were saved.
  measured: { name: "measured", roundTripPct: (fx, usd) => measuredRoundTripPct(fx, usd) },
};
