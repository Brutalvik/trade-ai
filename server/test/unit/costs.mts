// The cost of a round trip (src/costs.ts): measured with two-way Jupiter quotes at two sizes, a
// line through them for any size, the network fee on top, a fallback from the pool's depth when
// Jupiter can't be asked, and the size that keeps the cost under a cap. Jupiter is faked here: a
// plain pool with $200,000 on each side and a 0.3% fee per swap.
let quotes = 0, jupiterUp = true;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const R_USD = 200_000, R_COIN = 200_000_000, FEE = 0.003; // 1 coin = $0.001
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (!url.href.includes("/swap/v2/order")) return json({}, 404);
  quotes++;
  if (!jupiterUp) return json({ error: "busy" }, 503);
  const amount = Number(url.searchParams.get("amount"));
  const buying = url.searchParams.get("inputMint") === USDC;
  // constant-product pool, amounts in raw units (USDC 6 decimals, the coin 6 decimals)
  const inAmt = (amount / 1e6) * (1 - FEE);
  const out = buying ? (R_COIN * inAmt) / (R_USD + inAmt) : (R_USD * inAmt) / (R_COIN + inAmt);
  return json({ inAmount: String(amount), outAmount: String(Math.floor(out * 1e6)), priceImpactPct: "0" });
}) as typeof fetch;
const { costAt, costCurve, depthCurve, knownCurve, sizeUnderCap, NETWORK_FEE_USD, __resetCostsForTests } = await import(new URL("../../src/costs.ts", import.meta.url).href);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); };
const expect = (name: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); check(name, ok, ok ? (got as any) : `${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`); };
const r2 = (x: number) => Math.round(x * 100) / 100;

// What the fake pool really costs: fee twice, plus the price moved both ways.
const truth = (usd: number) => { const a = usd * (1 - FEE); const coins = (R_COIN * a) / (R_USD + a); const b = coins * (1 - FEE); return (1 - (R_USD * b) / (R_COIN + b) / usd) * 100; };

const c = await costCurve("CoinMint1111", 400_000, 1000);
expect("measured on Jupiter with two sizes (four quotes: there and back, twice)", [c.source, quotes], ["jupiter", 4]);
check("the pool's fees show up as the base cost (about 0.6% for 0.3% a side)", c.basePct > 0.55 && c.basePct < 0.75, r2(c.basePct));
for (const usd of [100, 500, 1000]) check(`$${usd}: within 0.1 of the pool's true cost`, Math.abs(costAt(c, usd) - (truth(usd) + ((2 * NETWORK_FEE_USD) / usd) * 100)) < 0.1, `${costAt(c, usd)}% vs ${r2(truth(usd))}% + network`);
check("a bigger trade costs more", costAt(c, 1000) > costAt(c, 100) + 0.5, [costAt(c, 100), costAt(c, 1000)]);
check("the network fee matters on a small trade (about 0.4% of $10) and not on a large one", costAt(c, 10) - (c.basePct + c.perUsdPct * 10) > 0.35 && costAt(c, 1000) - (c.basePct + c.perUsdPct * 1000) < 0.02, [costAt(c, 10), costAt(c, 1000)]);
await costCurve("CoinMint1111", 400_000, 1000);
expect("the measurement is remembered: asking again costs no quotes", quotes, 4);
expect("...and can be read without waiting", knownCurve("CoinMint1111", 400_000).source, "jupiter");

// The size cap.
expect("under the cap: the whole amount", sizeUnderCap(c, 1000, 5), 1000);
const capped = sizeUnderCap(c, 1000, 1.2);
check("over the cap: the largest amount that fits (about $585 here)", capped > 540 && capped < 630 && costAt(c, capped) <= 1.2 && costAt(c, capped + 15) > 1.2, { size: capped, cost: costAt(c, capped) });
expect("no size fits (fees alone are above the cap): the smallest position, a tenth of the funds", sizeUnderCap(c, 1000, 0.3), 100);
expect("...never under $10", sizeUnderCap(c, 60, 0.3), 10);
expect("no cap: the whole amount", sizeUnderCap(c, 1000, 0), 1000);

// Jupiter can't be asked.
jupiterUp = false;
const d = await costCurve("OtherMint2222", 100_000, 1000);
expect("Jupiter busy, nothing measured yet: the pool's depth is used", [d.source, r2(costAt(d, 1000)), r2(costAt(d, 100))], ["depth", r2(0.6 + 4 + 0.004), r2(0.6 + 0.4 + 0.04)]);
expect("the depth estimate: 0.6% fees + 2 x size / liquidity each way", [depthCurve(400_000).basePct, r2(depthCurve(400_000).perUsdPct * 1000)], [0.6, 1]);
expect("a coin measured earlier keeps its measurement while Jupiter is busy", (await costCurve("CoinMint1111", 400_000, 1000)).source, "jupiter");
expect("no token address (not a Solana coin): the depth estimate", (await costCurve(undefined, 400_000, 1000)).source, "depth");
__resetCostsForTests();
expect("an unknown coin read without waiting: the depth estimate", knownCurve("CoinMint1111", 400_000).source, "depth");
// A new server copy starts with an empty memory: the curve kept with the agent is used, with no quotes.
const before = quotes;
const kept = await costCurve("CoinMint1111", 400_000, 1000, c);
expect("a curve saved with the agent is used by a fresh server copy without measuring again", [kept.source, kept.at === c.at, quotes - before], ["jupiter", true, 0]);
__resetCostsForTests();
expect("...and can be read at buy time too", knownCurve("CoinMint1111", 400_000, c).at === c.at, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
