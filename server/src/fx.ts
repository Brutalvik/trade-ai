// The currencies a customer can see the app's money in, and their rates against the US dollar.
// The app keeps every amount in US dollars; the chosen currency is for showing (and typing)
// amounts only. Which currencies: US dollar and Canadian dollar first, then every currency MoonPay
// supports for paying (its own list, when MoonPay is set up), as long as there is a rate for it.
// Rates: Coinbase's public exchange rates (one call for all), kept 10 minutes.
import { fiatCurrencies } from "./moonpay.js";

export type Currency = { code: string; name: string; rate: number }; // rate = units of it per US dollar
const FALLBACK: { code: string; name: string }[] = [
  { code: "USD", name: "US Dollar" }, { code: "CAD", name: "Canadian Dollar" }, { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" }, { code: "AUD", name: "Australian Dollar" },
];

let get = async (url: string): Promise<any> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
export function __setFetchForTests(f: (url: string) => Promise<any>) {
  get = f;
  cache = null;
}
let cache: { at: number; list: Currency[] } | null = null;
export async function currencies(): Promise<Currency[]> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.list;
  const rates: Record<string, string> = (await get("https://api.coinbase.com/v2/exchange-rates?currency=USD").catch(() => null))?.data?.rates ?? {};
  const fiats = await fiatCurrencies().catch(() => [] as { code: string; name: string }[]);
  const seen = new Set<string>(), list: Currency[] = [];
  for (const c of [...FALLBACK.slice(0, 2), ...fiats, ...FALLBACK.slice(2)]) {
    const code = c.code.toUpperCase();
    const rate = code === "USD" ? 1 : Number(rates[code]);
    if (seen.has(code) || !(rate > 0)) continue;
    seen.add(code);
    list.push({ code, name: c.name, rate });
  }
  const [usd, cad, ...rest] = list;
  const sorted = [usd, cad, ...rest.sort((a, b) => a.code.localeCompare(b.code))].filter(Boolean);
  if (sorted.length > 1) cache = { at: Date.now(), list: sorted };
  return sorted.length ? sorted : [{ code: "USD", name: "US Dollar", rate: 1 }];
}
// A currency a customer may choose: three capital letters, and on the list.
export async function checkCurrency(code: unknown): Promise<string> {
  const c = String(code ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(c) || !(await currencies()).some((x) => x.code === c)) throw new Error("Pick a currency from the list.");
  return c;
}
