// New coins: young pools (minutes to 3 days old) with an automatic rug-risk score.
//  - Solana: RugCheck (free): mint/freeze authority, creator rug history, holder
//    concentration, LP lock, insider networks.
//  - Base: honeypot.is (free): can you sell? buy/sell tax, risk level.
// Every coin gets LOW / MEDIUM / HIGH / REJECTED with the reasons, plus a momentum read.
// Safety results are cached per token for 10 minutes; the list for 60 s.
import { cachedJson, getNewPools, type PairInfo } from "./data.js";

export type NewCoinChain = "solana" | "base";
export type Risk = "LOW" | "MEDIUM" | "HIGH" | "REJECTED";
export type NewCoin = {
  pair: PairInfo;
  ageMin: number;
  risk: Risk;
  reasons: string[]; // why it got that risk level
  safetyChecked: boolean; // false = the safety service had no data (treated as risky)
  buyShare: number | null; // share of last-hour trades that were buys
  momentum: "UP" | "FLAT" | "DOWN";
  tradeable: boolean; // passes the bot's new-coin entry rules right now
  why: string; // one-line summary
};

type Safety = { checked: boolean; rejected: string[]; high: string[]; medium: string[] };

const RANK: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, REJECTED: 3 };
const worst = (a: Risk, b: Risk) => (RANK[a] >= RANK[b] ? a : b);

// ---------- Safety checks ----------

async function solanaSafety(mint: string): Promise<Safety> {
  const s: Safety = { checked: false, rejected: [], high: [], medium: [] };
  try {
    const r = await cachedJson<any>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, 600_000, { retries: 0 });
    s.checked = true;
    for (const risk of r.risks ?? []) {
      const name = String(risk.name ?? "");
      const label = risk.value ? `${name} (${risk.value})` : name;
      // Deal-breakers: the creator can print or freeze tokens, has rugged before, or one wallet owns too much.
      if (/mint authority|freeze authority|history of rugg|rugged|copycat|honeypot/i.test(name)) s.rejected.push(label);
      else if (/single holder/i.test(name) && parseFloat(risk.value) >= 30) s.rejected.push(label);
      else if (risk.level === "danger") s.high.push(label);
      else if (risk.level === "warn") s.medium.push(label);
    }
    const locked = Number(r.lpLockedPct);
    if (Number.isFinite(locked) && locked < 50) s.high.push(`only ${locked.toFixed(0)}% of liquidity locked`);
  } catch (e: any) {
    s.high.push(`safety check unavailable (${String(e?.message ?? e).slice(0, 40)})`);
  }
  return s;
}

async function baseSafety(token: string): Promise<Safety> {
  const s: Safety = { checked: false, rejected: [], high: [], medium: [] };
  try {
    const r = await cachedJson<any>(`https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=8453`, 600_000, { retries: 0 });
    s.checked = true;
    if (r.honeypotResult?.isHoneypot) s.rejected.push("honeypot: you can't sell");
    const sellTax = Number(r.simulationResult?.sellTax ?? 0), buyTax = Number(r.simulationResult?.buyTax ?? 0);
    if (sellTax > 10) s.rejected.push(`sell tax ${sellTax.toFixed(0)}%`);
    else if (sellTax > 3 || buyTax > 3) s.high.push(`tax ${buyTax.toFixed(0)}% buy / ${sellTax.toFixed(0)}% sell`);
    const level = Number(r.summary?.riskLevel ?? 0);
    if (level >= 3) s.high.push(`honeypot.is risk: ${r.summary?.risk}`);
    else if (level === 2) s.medium.push(`honeypot.is risk: ${r.summary?.risk}`);
    for (const f of r.flags ?? r.summary?.flags ?? []) s.medium.push(String(f.description ?? f.flag ?? f).slice(0, 60));
  } catch (e: any) {
    // 404 = too new to be indexed: unverified, so it can't be called safe.
    s.high.push(/404/.test(String(e?.message)) ? "too new to verify (no sell simulation yet)" : "safety check unavailable");
  }
  return s;
}

// ---------- Score ----------

export const NEW_COIN_RULES = { minAgeMin: 20, minLiquidityUsd: 25_000, minBuyShare: 0.55 };

function assess(p: PairInfo, safety: Safety): NewCoin {
  const ageMin = Math.max(0, Math.round((Date.now() - (p.createdAt ?? Date.now())) / 60_000));
  const reasons: string[] = [];
  let risk = "LOW" as Risk; // widened: it is updated inside bump()
  const bump = (r: Risk, why: string) => {
    risk = worst(risk, r);
    reasons.push(why);
  };
  for (const r of safety.rejected) bump("REJECTED", r);
  if (p.liquidityUsd < 5_000) bump("REJECTED", `liquidity only $${Math.round(p.liquidityUsd).toLocaleString()}`);
  for (const r of safety.high) bump("HIGH", r);
  if (ageMin < 15) bump("HIGH", `only ${ageMin} min old`);
  else if (ageMin < 120) bump("MEDIUM", `${ageMin} min old`);
  if (p.liquidityUsd < 15_000) bump("HIGH", `thin liquidity ($${Math.round(p.liquidityUsd / 1000)}K)`);
  else if (p.liquidityUsd < 50_000) bump("MEDIUM", `liquidity $${Math.round(p.liquidityUsd / 1000)}K`);
  for (const r of safety.medium) bump("MEDIUM", r);
  if (p.change.h1 <= -30) bump("HIGH", `down ${Math.abs(p.change.h1).toFixed(0)}% in 1h (dumping)`);

  const buys = p.buys1h ?? 0, sells = p.sells1h ?? 0;
  const buyShare = buys + sells >= 10 ? buys / (buys + sells) : null;
  const momentum = p.change.h1 > 5 && p.change.m5 >= 0 ? "UP" : p.change.h1 < -5 || p.change.m5 < -3 ? "DOWN" : "FLAT";
  const tradeable =
    (risk === "LOW" || risk === "MEDIUM") &&
    ageMin >= NEW_COIN_RULES.minAgeMin &&
    p.liquidityUsd >= NEW_COIN_RULES.minLiquidityUsd &&
    buyShare !== null &&
    buyShare >= NEW_COIN_RULES.minBuyShare &&
    momentum === "UP";
  const why =
    risk === "REJECTED"
      ? `Rejected: ${reasons.filter((r) => safety.rejected.includes(r) || r.startsWith("liquidity only"))[0] ?? reasons[0]}.`
      : `${momentum === "UP" ? "Rising" : momentum === "DOWN" ? "Falling" : "Flat"} (1h ${p.change.h1 >= 0 ? "+" : ""}${p.change.h1.toFixed(0)}%)${buyShare !== null ? `, ${Math.round(buyShare * 100)}% buys` : ""}${tradeable ? ": fits the new-coin entry rules." : "."}`;
  return { pair: p, ageMin, risk, reasons, safetyChecked: safety.checked, buyShare, momentum, tradeable, why };
}

// ---------- Scan ----------

const cache = new Map<string, { at: number; list: NewCoin[] }>();

export async function scanNewCoins(chain: NewCoinChain): Promise<NewCoin[]> {
  if (chain !== "solana" && chain !== "base") throw new Error("New coins: choose solana or base");
  const hit = cache.get(chain);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const pools = (await getNewPools(chain))
    .filter((p) => p.liquidityUsd >= 2_000)
    .sort((a, b) => (b.volume1h ?? 0) - (a.volume1h ?? 0))
    .slice(0, 15);
  // Safety checks in parallel (each cached 10 min per token).
  const list = await Promise.all(pools.map(async (p) => assess(p, chain === "solana" ? await solanaSafety(p.tokenAddress) : await baseSafety(p.tokenAddress))));
  list.sort((a, b) => Number(b.tradeable) - Number(a.tradeable) || RANK[a.risk] - RANK[b.risk] || (b.pair.volume1h ?? 0) - (a.pair.volume1h ?? 0));
  cache.set(chain, { at: Date.now(), list });
  return list;
}
