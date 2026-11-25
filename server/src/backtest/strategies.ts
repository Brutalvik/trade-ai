// Where back-test entries come from. A back-test cannot ask the AI, so entries are rules:
//   every:<minutes>   a buy every N minutes whenever the agent is not in a trade. No skill at all,
//                     which makes it the fair way to compare exit designs and cost models.
//   pattern:<key>     one of the entry patterns the agents study on their own coin (learn.ts):
//                     breakout, pullback, squeeze, flag, rebound, macross.
// The exit designs the back-tester can run side by side are listed here too.
import { fires, series, stopPctFor, STRATS, type StratKey } from "../learn.js";
import { EXIT_LIVE, EXIT_V058, type ExitDesign } from "../rules.js";
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
  // What the bot ran up to v0.61.0: +5% after costs is locked the moment it is reached; the exit follows 2.5%
  // behind the high; a trade that neither stops out nor reaches +5% is held with no time limit.
  v058: EXIT_V058,
  // The same with the order's time limit working (the trade is sold when its holding time is up).
  timed: { ...EXIT_V058, name: "v0.58.0 + time limit", timeLimit: true },
  // The same lock, but the exit follows 1.8 x the coin's usual 5-minute swing behind (2.5% to 12%).
  // This is what the bot runs now ("live" is the engine's own copy of it).
  adaptive: { ...EXIT_V058, name: "adaptive trail", trail: ADAPTIVE },
  live: { ...EXIT_LIVE, name: "the bot now (lock at +5%)" },
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

// A design by its key. "lock<N>" is the bot's design with the +5% floor locked only once the trade
// is up N% after costs (lock8, lock12 ...), for any N from the minimum profit up.
export function design(key: string): ExitDesign | undefined {
  const m = /^lock(\d+(?:\.\d+)?)$/.exec(key);
  if (m) return Number(m[1]) >= EXIT_LIVE.minNetPct ? { ...EXIT_LIVE, name: `floor locked at +${m[1]}%`, lockAtNetPct: Number(m[1]) } : undefined;
  // "quick<N>" is the bot's design with a smaller minimum profit: +N% after costs is locked the
  // moment the trade gets there (quick1, quick2.5 ...), for any N from 0.5 up to the live minimum.
  // The question it answers: do quicker, smaller wins add up to more than the +5% lock does?
  // "keep<P>" is the bot's design that, once the +5% minimum is locked, also never gives back more
  // than (100 - P)% of the best gain so far (keep60, keep75 ...). "tight<N>" is the bot's design
  // with the exit a fixed N% behind the highest close (tight1.5, tight2 ...). The question both
  // answer: does selling closer to the best price add up to more than the exit the bot uses?
  // "touch" = the bot's design with a profit exit taken on the first touch of the exit line
  // (sim.ts, TestDesign); "touch-keep<P>" = the same together with keep<P>.
  if (key === "touch") return { ...EXIT_LIVE, name: "sell on the first touch of the line", touch: true } as ExitDesign;
  const tk = /^touch-keep(\d+)$/.exec(key);
  if (tk) return Number(tk[1]) >= 10 && Number(tk[1]) <= 95 ? ({ ...EXIT_LIVE, name: `first touch + keep ${tk[1]}%`, touch: true, ratchet: { fromNetPct: EXIT_LIVE.lockAtNetPct, keep: Number(tk[1]) / 100 } } as ExitDesign) : undefined;
  // "confirm<S>" = the bot's design, but a profit exit waits: the price must still be under the exit
  // line S seconds after it was first seen there (confirm10, confirm15 ...). "confirm<S>-crash<P>"
  // also sells at once when the price is P% under the line. "confirm<S>-keep<P>" adds keep<P>.
  const cf = /^confirm(\d+)(?:-crash(\d+(?:\.\d+)?))?(?:-keep(\d+))?$/.exec(key);
  if (cf) return ({ ...EXIT_LIVE, name: `profit exit waits ${cf[1]} s${cf[2] ? `, at once if ${cf[2]}% under` : ""}${cf[3] ? ` + keep ${cf[3]}%` : ""}`, profitConfirmMs: Math.max(1, Number(cf[1]) - 2) * 1000, ...(cf[2] ? { profitCrashPct: Number(cf[2]) } : {}), ...(cf[3] ? { ratchet: { fromNetPct: EXIT_LIVE.lockAtNetPct, keep: Number(cf[3]) / 100 } } : {}) } as ExitDesign);
  const k = /^keep(\d+)$/.exec(key);
  if (k) return Number(k[1]) >= 10 && Number(k[1]) <= 95 ? { ...EXIT_LIVE, name: `keep ${k[1]}% of the best gain`, ratchet: { fromNetPct: EXIT_LIVE.lockAtNetPct, keep: Number(k[1]) / 100 } } : undefined;
  const t = /^tight(\d+(?:\.\d+)?)$/.exec(key);
  if (t) return Number(t[1]) >= 0.5 && Number(t[1]) <= 12 ? { ...EXIT_LIVE, name: `exit ${t[1]}% behind the high`, trail: { kind: "fixed", pct: Number(t[1]) } } : undefined;
  const q = /^quick(\d+(?:\.\d+)?)$/.exec(key);
  if (q) return Number(q[1]) >= 0.5 && Number(q[1]) <= EXIT_LIVE.minNetPct ? { ...EXIT_LIVE, name: `quick: +${q[1]}% locked at once`, minNetPct: Number(q[1]), lockAtNetPct: Number(q[1]) } : undefined;
  return DESIGNS[key];
}

// ---------- Cost models ----------
export const COSTS: Record<string, CostModel> = {
  // What the app assumes today: 1% fee + 0.5% slippage on each side, whatever the coin or the size.
  flat: { name: "flat", roundTripPct: () => 3 },
  // What a round trip of that size really cost on Jupiter when the candles were saved.
  measured: { name: "measured", roundTripPct: (fx, usd) => measuredRoundTripPct(fx, usd) },
};
