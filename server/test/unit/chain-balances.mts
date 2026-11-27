// What is in a customer's four wallets (src/chainbal.ts), network by network, read from public
// blockchain nodes (faked here): the Ethereum wallet's one address on all the EVM networks (BNB Chain
// included), Bitcoin, Tron (TRX and USDT), Solana. A network that does not answer shows no figure,
// never a made-up zero.
import { expect, finish } from "../check.mts";
const cb = await import(new URL("../../src/chainbal.ts", import.meta.url).href);

const EVM = "0x52908400098527886E0F7030069857D2E4169EE7", BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", TRX = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", SOL = "So1aNaWa11etxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const wei = (eth: number) => "0x" + (BigInt(Math.round(eth * 1e6)) * 10n ** 12n).toString(16);
const asked: string[] = [];
let tronUnused = false;
cb.__setFetchForTests(async (url: string, init?: RequestInit) => {
  asked.push(url);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (url.startsWith("https://api.coinbase.com/v2/exchange-rates")) return { data: { rates: { SOL: "0.01", ETH: "0.0005", BNB: "0.002", BTC: "0.00002", USDT: "1", AVAX: "0.1", POL: "10" } } };
  if (url.startsWith("https://www.okx.com/api/v5/market/ticker?instId=TRX-USDT")) return { data: [{ last: "0.25" }] };
  if (url.includes("polygon")) throw new Error("timeout"); // a network that does not answer
  if (body?.method === "eth_getBalance") {
    if (body.params[0] !== EVM) throw new Error("wrong address asked");
    return { result: url.includes("bsc") ? wei(0.25) : url.includes("sepolia") ? wei(0.5) : url.includes("ethereum-rpc") ? wei(1.5) : "0x0" };
  }
  if (body?.method === "getBalance") return { result: { value: 2.5e9 } };
  if (url.startsWith("https://mempool.space/api/address/")) return { chain_stats: { funded_txo_sum: 150_000_000, spent_txo_sum: 50_000_000 }, mempool_stats: { funded_txo_sum: 10_000_000, spent_txo_sum: 0 } };
  if (url.startsWith("https://api.trongrid.io/v1/accounts/")) return tronUnused ? { data: [] } : { data: [{ balance: 12_500_000, trc20: [{ TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj: "1" }, { TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: "42000000" }] }] };
  throw new Error(`not faked: ${url}`);
});
const w = (chain: string, address: string) => ({ chain, address, via: "proven", moonxUserId: "mx", at: 0 });
const all = [w("solana", SOL), w("ethereum", EVM), w("bitcoin", BTC), w("tron", TRX)];

const live = await cb.balances(all, false);
expect("the Ethereum wallet: one address, read on every EVM network, BNB Chain included", live.ethereum.map((r: any) => [r.network, r.symbol, r.amount]), [
  ["Ethereum", "ETH", 1.5], ["BNB Chain", "BNB", 0.25], ["Base", "ETH", 0], ["Polygon", "POL", null], ["Arbitrum", "ETH", 0], ["Optimism", "ETH", 0], ["Avalanche", "AVAX", 0],
]);
expect("...a network that does not answer shows no figure (Polygon here), never a made-up zero", live.ethereum[3].amount, null);
expect("Bitcoin: what came in less what went out, unconfirmed included", live.bitcoin[0].amount, 1.1);
expect("Tron: TRX and USDT (other Tron tokens are not counted as USDT)", live.tron.map((r: any) => [r.symbol, r.amount]), [["TRX", 12.5], ["USDT", 42]]);
expect("Solana: SOL on Solana's main network", live.solana, [{ network: "Solana", symbol: "SOL", amount: 2.5, usd: 250 }]);
expect("dollar values: each coin at its price (Coinbase's rates, TRX from OKX)", [live.ethereum[0].usd, live.ethereum[1].usd, live.bitcoin[0].usd, live.tron.map((r: any) => r.usd)], [3000, 125, 55000, [3.13, 42]]);
expect("the total in dollars, and it says when a figure is missing (Polygon did not answer)", cb.totalUsd(live), { totalUsd: 58420.13, complete: false });
expect("only the wallet's own public address is sent to the networks", asked.every((u) => !/user|email|key=/i.test(u)), true);

const test = await cb.balances(all, true);
expect("in test mode: Solana's test network, and Sepolia's test ETH beside the real networks", [test.solana[0].network, test.solana[0].test, test.ethereum.at(-1)], ["Solana test network (devnet)", true, { network: "Ethereum test network (Sepolia)", symbol: "ETH", amount: 0.5, test: true, usd: null }]);
expect("...test coins are worth nothing: no dollar value, and left out of the total", [test.solana[0].usd, cb.totalUsd({ solana: test.solana }).totalUsd], [null, 0]);

tronUnused = true;
expect("a Tron address never used yet holds 0 TRX and 0 USDT (its record does not exist yet)", (await cb.balances([w("tron", TRX)], false, true)).tron.map((r: any) => r.amount), [0, 0]);
const n = asked.length;
await cb.balances([w("bitcoin", BTC)], false);
expect("balances are kept 30 seconds: reopening the window does not ask the networks again", asked.length, n);
await cb.balances([w("bitcoin", BTC)], false, true);
expect("...unless Refresh asks for fresh ones", asked.length, n + 1);
finish();
