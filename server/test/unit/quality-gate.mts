// The coin quality gate (src/agents.ts): before an agent's AI is asked, the scouts say whether
// the coin is fit to trade at all. It refuses on what the coin IS (who holds it, who can mint or
// freeze it, how deep and how real its market is) and on a low quality score, never on what the
// price is doing this minute.
import { QUALITY_MIN, qualityGate, scoreCoin } from "../../src/agents.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); };
const expect = (name: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); check(name, ok, ok ? (got as any) : `${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`); };

// A healthy coin: real traders, thousands of holders, a small dev share, a deep pool, a day old.
const coin = (over: Record<string, any> = {}) => {
  const base: any = {
    id: "Mint1111", symbol: "TST", name: "Test", usdPrice: 1, mcap: 5e6, liquidity: 400_000, holderCount: 4200, organicScore: 72,
    graduatedAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18, devBalancePercentage: 0.5, devMints: 1 },
    stats5m: { priceChange: 1.2, holderChange: 0.6, liquidityChange: 0.4, buyVolume: 60_000, sellVolume: 35_000, numOrganicBuyers: 30, numTraders: 400 },
    stats1h: { priceChange: 14, holderChange: 3, buyVolume: 300_000, sellVolume: 220_000, buyOrganicVolume: 40_000, sellOrganicVolume: 30_000, numOrganicBuyers: 80, numTraders: 1500 },
  };
  for (const [k, v] of Object.entries(over)) base[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...base[k], ...v } : v;
  return base;
};
const gate = (over: Record<string, any> = {}, min?: number) => qualityGate(scoreCoin(coin(over), null), min);

expect("the default minimum quality", QUALITY_MIN, 45);
const good = scoreCoin(coin(), null);
check("a healthy coin: no deal-breakers, a high quality score", good.structural.length === 0 && good.quality >= 70, { quality: good.quality, structural: good.structural });
expect("...so the gate lets the AI be asked", gate().ok, true);

// What the price is doing right now is not the gate's business.
const flat = scoreCoin(coin({ stats1h: { priceChange: -0.2 }, stats5m: { priceChange: -0.1 } }), null);
check("a coin that is flat this hour trips the scouts' own timing veto", flat.timing.some((v) => v.includes("no upward move")) && flat.vetoes.length > 0, flat.timing);
expect("...but an agent's gate does not refuse it (its AI may buy a dip)", [flat.structural, qualityGate(flat).ok], [[], true]);
const dumping = scoreCoin(coin({ stats5m: { priceChange: -9 }, stats1h: { priceChange: -20 } }), null);
expect("the same for a coin that is falling right now", [dumping.timing.length >= 2, qualityGate(dumping).ok], [true, true]);
const spiking = scoreCoin(coin({ stats5m: { priceChange: 22 } }), null);
expect("and for one that is spiking", [spiking.timing.some((v) => v.includes("spiking")), qualityGate(spiking).ok], [true, true]);
const quietHour = scoreCoin(coin({ stats5m: { priceChange: -3, buyVolume: 8_000, sellVolume: 14_000 }, stats1h: { priceChange: -6, buyVolume: 200_000, sellVolume: 260_000 } }), null);
check("the scouts' own total is not used either: a sound coin in a slow, falling hour scores under their 65 pass mark and still passes the gate", quietHour.total < 65 && quietHour.quality >= 70 && qualityGate(quietHour).ok, { total: quietHour.total, quality: quietHour.quality });

// What the coin is.
const refused = (name: string, over: Record<string, any>, word: string) => {
  const g = gate(over);
  check(name, !g.ok && g.reasons.some((r) => r.includes(word)), g.reasons);
};
refused("the creator can still mint new tokens: refused", { audit: { mintAuthorityDisabled: false } }, "mint new tokens");
refused("the creator can freeze wallets: refused", { audit: { freezeAuthorityDisabled: false } }, "freeze wallets");
refused("the dev holds 14%: refused", { audit: { devBalancePercentage: 14 } }, "the dev holds 14%");
refused("the top 10 wallets own 66%: refused", { audit: { topHoldersPercentage: 66 } }, "top 10 wallets own 66%");
refused("a $34K pool: refused", { liquidity: 34_000 }, "thin liquidity ($34K)");
refused("liquidity fell 22% in 5 minutes: refused", { stats5m: { liquidityChange: -22 } }, "possible rug");
refused("mostly bot volume: refused", { organicScore: 12 }, "mostly bot volume");
refused("launched 8 minutes ago: refused", { graduatedAt: new Date(Date.now() - 8 * 60_000).toISOString() }, "launched minutes ago");

// The quality score: a coin with no deal-breaker can still be too poor.
const weak = scoreCoin(coin({ organicScore: 30, holderCount: 300, liquidity: 60_000, audit: { devMints: 40 }, stats1h: { numOrganicBuyers: 2, holderChange: 0 } }), null);
check("few holders, little real trading, a serial launcher, a shallow pool: no single deal-breaker, but a low score", weak.structural.length === 0 && weak.quality < 45, { quality: weak.quality, parts: Object.fromEntries(["organic", "holders", "dev", "liquidity"].map((k) => [k, Math.round((weak.agents as any)[k].score)])) });
const g = qualityGate(weak);
check("...refused, and the reason gives the score and its parts", !g.ok && g.reasons.length === 1 && g.reasons[0].includes(`quality score is ${weak.quality}, under the 45`) && g.reasons[0].includes("liquidity"), g.reasons);
expect("the minimum is the agent's to set: at 20 the same coin passes, at 90 a healthy one fails", [qualityGate(weak, 20).ok, qualityGate(good, 90).ok], [true, false]);
expect("the gate reports the score and the minimum it was held to", [gate().quality === good.quality, gate({}, 60).min], [true, 60]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
