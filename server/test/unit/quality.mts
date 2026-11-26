// The quality step's sums (src/quality.ts): what is known about what a coin costs to trade, when
// it should be measured again, and the verdict on each coin of the agents' list. Pure functions:
// no account, no network.
import { expect, finish } from "../check.mts";
const { knownPct, needsPricing, vet } = await import(new URL("../../src/quality.ts", import.meta.url).href);
const { costAt } = await import(new URL("../../src/costs.ts", import.meta.url).href);

const NOW = Date.UTC(2026, 10, 26, 6, 0, 0), MIN = 60_000, HOUR = 60 * MIN;
// A measured curve: `base`% + `perK`% for every $1,000 traded, measured `agoMin` minutes ago for trades up to `upTo`.
const curve = (base: number, perK: number, agoMin = 5, upTo: number | null = 1000) => ({ basePct: base, perUsdPct: perK / 1000, source: "jupiter", at: NOW - agoMin * MIN, ...(upTo ? { upTo } : {}) });
const depth = { basePct: 0.6, perUsdPct: 0.005, source: "depth", at: NOW };
const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
const cheap = curve(0.6, 0.2), dear = curve(0.8, 3.0);

// What a coin is known to cost.
expect("a measured coin: what a round trip of the agent's money costs there (the network fee included)", [r1(knownPct(cheap, 1000, 1.5, NOW, HOUR)), r1(knownPct(dear, 1000, 1.5, NOW, HOUR)), knownPct(cheap, 1000, 1.5, NOW, HOUR) === costAt(cheap, 1000)], [0.8, 3.8, true]);
expect("a smaller agent pays less on the same coin", [r1(knownPct(dear, 300, 1.5, NOW, HOUR)), r1(knownPct(dear, 100, 1.5, NOW, HOUR))], [1.7, 1.1]);
expect("nothing is known without a measurement: none at all, an estimate from the pool's depth, or one older than an hour", [knownPct(undefined, 1000, 1.5, NOW, HOUR), knownPct(null, 1000, 1.5, NOW, HOUR), knownPct(depth, 1000, 1.5, NOW, HOUR), knownPct(curve(0.6, 0.2, 61), 1000, 1.5, NOW, HOUR)], [null, null, null, null]);
expect("...and one of 59 minutes still counts", r1(knownPct(curve(0.6, 0.2, 59), 1000, 1.5, NOW, HOUR)), 0.8);
// Measured for a small trade, asked about a large one.
const small = curve(0.6, 2.0, 5, 250); // measured up to $250: there it costs 0.6 + 0.5 = 1.1% (+ network)
expect("a little more money than was measured is still covered (up to 1.5 times)", r1(knownPct(small, 370, 1.5, NOW, HOUR)), 1.4);
expect("much more money than was measured: the measurement only says 'at least this much', which does not settle it when that is under the line", knownPct(small, 1000, 1.5, NOW, HOUR), null);
expect("...and does settle it when even that is over the line", r1(knownPct(curve(2.0, 2.0, 5, 250), 1000, 1.5, NOW, HOUR)), 2.5);
expect("a curve kept from before sizes were recorded answers for any size", r1(knownPct(curve(0.6, 0.2, 5, null), 5000, 1.5, NOW, HOUR)), 1.6);

// When the step should measure a coin (again).
const FRESH = 45 * MIN;
expect("the step measures a coin that was never measured, or only estimated", [needsPricing(undefined, 1000, NOW, FRESH), needsPricing(depth, 1000, NOW, FRESH)], [true, true]);
expect("...one whose measurement has grown older than 45 minutes, not one that is newer", [needsPricing(curve(0.6, 0.2, 46), 1000, NOW, FRESH), needsPricing(curve(0.6, 0.2, 44), 1000, NOW, FRESH)], [true, false]);
expect("...and one that was measured for a much smaller trade than its agents make", [needsPricing(small, 1000, NOW, FRESH), needsPricing(small, 300, NOW, FRESH)], [true, false]);

// The verdict on each coin of the list.
const list = [{ mint: "A", symbol: "QDEAR" }, { mint: "B", symbol: "QOKAY" }, { mint: "C", symbol: "QNEW" }, { mint: "D", symbol: "QOLD" }, { mint: "E", symbol: "QLINE" }];
const known: Record<string, any> = { A: dear, B: cheap, D: curve(0.6, 0.2, 50), E: curve(1.0, 0.496) }; // E: exactly 1.5% for $1,000
const verdicts = vet(list, { funds: 1000, max: 1.5, now: NOW, keepMs: HOUR, freshMs: FRESH, curveOf: (m: string) => known[m] });
expect("each coin of the list gets a verdict, in the list's order: too expensive, ready, or not priced yet", verdicts.map((v: any) => `${v.symbol} ${v.state} ${r1(v.pct)}`), ["QDEAR dear 3.8", "QOKAY ready 0.8", "QNEW unpriced null", "QOLD ready 0.8", "QLINE ready 1.5"]);
expect("a coin at exactly the line is taken, not passed over", verdicts[4].state, "ready");
expect("the step's next coin to measure is the first that is unpriced or has grown old", [verdicts.map((v: any) => v.stale), verdicts.find((v: any) => v.stale)?.symbol], [[false, false, true, true, false], "QNEW"]);
expect("the same list for an agent with $300: the coin that was too expensive is within its reach", vet(list.slice(0, 2), { funds: 300, max: 1.5, now: NOW, keepMs: HOUR, freshMs: FRESH, curveOf: (m: string) => ({ A: curve(0.5, 3.0), B: cheap } as any)[m] }).map((v: any) => `${v.symbol} ${v.state} ${r1(v.pct)}`), ["QDEAR ready 1.4", "QOKAY ready 0.7"]);
expect("an empty list has no verdicts", vet([], { funds: 1000, max: 1.5, now: NOW, keepMs: HOUR, freshMs: FRESH, curveOf: () => undefined }), []);

finish();
