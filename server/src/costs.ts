// What a round trip (a buy and the sale that follows) of a given size costs in a coin's pool:
// the pool's trading fee and the price the trade itself moves, both ways, plus the network fee.
//
// Measured with read-only Jupiter quotes (no wallet, nothing is traded): quote USDC -> coin for the
// amount, then quote the coins received back to USDC. What is missing at the end is the cost.
// Two sizes are measured; cost grows with size, and the line through the two gives any size in
// between. When Jupiter cannot be asked, the cost is estimated from the pool's depth instead.
//
// Measured on 14 coins (14 Nov 2026): $100 cost 0.3% to 2.7% (median 0.9%); $1,000 cost 0.3% to
// 7.4% (median 3.2%). The flat 3% the app assumed before was too high for deep pools and too low
// for a large trade in a thin one.
import { cachedJson } from "./data.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP = () => (process.env.JUPITER_API_URL?.trim() || "https://api.jup.ag/swap/v2").replace(/\/$/, "");
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY?.trim() ? { "x-api-key": process.env.JUPITER_API_KEY.trim() } : {});

export const NETWORK_FEE_USD = 0.02; // roughly what one swap costs in network and priority fees
export const DEPTH_FEE_PCT = 0.6; // pool fees for a round trip when they cannot be measured (about 0.3% a side)
const CURVE_TTL_MS = 10 * 60_000; // a pool's cost changes slowly: measure at most this often
const KEEP_MS = 60 * 60_000; // a measured curve stands in for this long when Jupiter cannot be asked
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : hi));

// cost of a round trip of `usd`, in % = basePct + perUsdPct x usd, plus the network fee (a fixed amount)
export type CostCurve = { basePct: number; perUsdPct: number; source: "jupiter" | "depth"; at: number };
export type Cost = { pct: number; usd: number; source: CostCurve["source"] };

// From the pool's depth: each side of the pool holds about half its liquidity, so a trade of S
// moves the price about 2 x S / liquidity, on the way in and again on the way out.
export function depthCurve(liquidityUsd: number, at = Date.now()): CostCurve {
  return { basePct: DEPTH_FEE_PCT, perUsdPct: liquidityUsd > 0 ? 400 / liquidityUsd : 0.03, source: "depth", at };
}
export function costAt(c: CostCurve, usd: number): number {
  const network = usd > 0 ? ((2 * NETWORK_FEE_USD) / usd) * 100 : 0;
  return Math.round(clamp(c.basePct + c.perUsdPct * usd + network, 0.1, 30) * 100) / 100;
}
// The largest amount, at most `funds`, whose round trip costs no more than `capPct`. If no size
// does (the pool's fees alone are above the cap), the smallest position an agent takes: a tenth of
// its funds, at least $10. The cap only ever makes a position smaller; whether the trade is worth
// taking at that cost is still the prediction check's call.
export function sizeUnderCap(c: CostCurve, funds: number, capPct: number): number {
  const floor = Math.min(funds, Math.max(10, funds * 0.1));
  if (!(capPct > 0) || costAt(c, funds) <= capPct) return funds;
  if (costAt(c, floor) > capPct) return Math.floor(floor * 100) / 100;
  let lo = floor, hi = funds;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (costAt(c, mid) <= capPct) lo = mid; else hi = mid;
  }
  return Math.floor(lo * 100) / 100;
}

// One measurement: the % lost by swapping `usd` of USDC into the coin and straight back.
async function measure(mint: string, usd: number): Promise<number> {
  const ask = async (inputMint: string, outputMint: string, amount: string) => {
    const url = `${JUP()}/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`;
    const j = await Promise.race([
      cachedJson<any>(url, 60_000, { headers: jupHeaders(), retries: 0, allowStale: false }),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("Jupiter took too long")), 9_000)),
    ]);
    const out = BigInt(String(j?.outAmount ?? "0"));
    if (out <= 0n) throw new Error(j?.errorMessage || j?.error || "no route");
    return out;
  };
  const inRaw = BigInt(Math.round(usd * 1e6));
  const coins = await ask(USDC, mint, inRaw.toString());
  const back = await ask(mint, USDC, coins.toString());
  return (1 - Number(back) / Number(inRaw)) * 100;
}

const curves = new Map<string, CostCurve>();
const pending = new Map<string, Promise<CostCurve>>();
// The cost curve for a coin: measured on Jupiter (two sizes), remembered for ten minutes.
// `funds` = the largest amount that may be traded; `liquidityUsd` is used when Jupiter can't be asked;
// `saved` = a curve measured earlier and kept with the agent (another server copy may have measured it).
export async function costCurve(mint: string | undefined, liquidityUsd: number, funds: number, saved?: CostCurve | null): Promise<CostCurve> {
  if (!mint) return depthCurve(liquidityUsd);
  if (saved?.source === "jupiter" && saved.at > (curves.get(mint)?.at ?? 0)) curves.set(mint, saved);
  const hit = curves.get(mint);
  if (hit && Date.now() - hit.at < CURVE_TTL_MS) return hit;
  if (!pending.has(mint)) {
    pending.set(
      mint,
      (async () => {
        try {
          const big = Math.max(40, Math.round(funds));
          const small = Math.max(20, Math.round(Math.min(100, big / 4)));
          const pSmall = await measure(mint, small);
          const pBig = await measure(mint, big);
          const perUsdPct = Math.max(0, (pBig - pSmall) / (big - small));
          const c: CostCurve = { basePct: clamp(pSmall - perUsdPct * small, 0.05, 25), perUsdPct, source: "jupiter", at: Date.now() };
          curves.set(mint, c);
          if (curves.size > 300) for (const k of [...curves.keys()].slice(0, 100)) curves.delete(k);
          return c;
        } catch {
          // Jupiter can't be asked right now: the last measurement if it is recent, else the pool's depth.
          return hit && Date.now() - hit.at < KEEP_MS ? hit : depthCurve(liquidityUsd);
        } finally {
          pending.delete(mint);
        }
      })(),
    );
  }
  return pending.get(mint)!;
}
// The last curve measured for a coin, without asking anything (for decisions that cannot wait).
export const knownCurve = (mint: string | undefined, liquidityUsd: number, saved?: CostCurve | null): CostCurve => {
  if (mint && saved?.source === "jupiter" && saved.at > (curves.get(mint)?.at ?? 0)) curves.set(mint, saved);
  const hit = mint ? curves.get(mint) : undefined;
  return hit && Date.now() - hit.at < KEEP_MS ? hit : depthCurve(liquidityUsd);
};
export const __resetCostsForTests = () => { curves.clear(); pending.clear(); };
