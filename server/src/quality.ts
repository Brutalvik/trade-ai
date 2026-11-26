// The quality step's sums: is a coin one an auto-pick agent can take, as far as what it costs to
// trade goes? Pure functions (no account, no network), so the engine's choice of a coin, the step
// that prices coins ahead of the agents, and the tests all read the same answer.
//
// The other two checks an agent's coin goes through are where they always were: the scouts' gate
// (agents.ts, qualityGate: who holds the coin, who can mint or freeze it, how deep its market is)
// and the numbers' pre-check (engine.ts, runAnalysis: does it move enough to clear its costs),
// which needs the coin's candles and so runs with each look of an agent's AI, not here.
import type { AgentCoin } from "./agents.js";
import { costAt, curveCovers, type CostCurve } from "./costs.js";

// What a round trip of `funds` costs by a measured curve that is no older than `keepMs`; null =
// not known. A measurement taken for a much smaller trade only says "at least this much" about a
// larger one, which settles the matter when even that is over the line `max`.
export function knownPct(curve: CostCurve | null | undefined, funds: number, max: number, now: number, keepMs: number): number | null {
  if (!curve || curve.source !== "jupiter" || now - curve.at > keepMs) return null;
  if (curveCovers(curve, funds)) return costAt(curve, funds);
  const atLeast = costAt(curve, curve.upTo ?? funds);
  return atLeast > max ? atLeast : null;
}

// Should the coin be measured (again) for agents that trade with `funds`? Yes when it never was,
// when the measurement is older than `freshMs`, or when it was taken for a much smaller trade.
export function needsPricing(curve: CostCurve | null | undefined, funds: number, now: number, freshMs: number): boolean {
  return !curve || curve.source !== "jupiter" || now - curve.at > freshMs || !curveCovers(curve, funds);
}

// The verdict on each candidate, in the order given (the scouts' order), for an agent that trades
// with `funds` and passes over a coin costing more than `max` %:
//   ready     it costs `pct`, at or under the line
//   dear      it costs `pct`, over the line: passed over
//   unpriced  nothing is known yet (the agent that gets to it measures it, or the step does first)
// stale = the step should measure it (again) when its turn comes.
export type Verdict = { mint: string; symbol: string; state: "ready" | "dear" | "unpriced"; pct: number | null; stale: boolean };
export function vet(
  list: Pick<AgentCoin, "mint" | "symbol">[],
  o: { funds: number; max: number; now: number; keepMs: number; freshMs: number; curveOf: (mint: string) => CostCurve | null | undefined },
): Verdict[] {
  return list.map((c) => {
    const curve = o.curveOf(c.mint);
    const pct = knownPct(curve, o.funds, o.max, o.now, o.keepMs);
    return { mint: c.mint, symbol: c.symbol, state: pct === null ? "unpriced" : pct > o.max ? "dear" : "ready", pct, stale: needsPricing(curve, o.funds, o.now, o.freshMs) };
  });
}
