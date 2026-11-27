// Sending crypto from a customer's own wallets to another address (theirs, an exchange, a friend).
// Nothing is sent without the customer: the transaction is built here (or by MoonPay's kit) and
// signed by them in the browser with their MoonPay wallet; this server only checks it is exactly
// the transfer they reviewed, broadcasts it (Solana) or confirms it on the chain (Ethereum, Tron),
// and records it in their transactions.
//  - Solana: SOL, or any token they hold (a token account for the receiver is opened when needed,
//    paid for by the sender). Built here, signed in the browser, sent and confirmed here.
//  - Ethereum & EVM: the network's own coin (ETH, BNB, POL, AVAX), sent by MoonPay's kit in the
//    browser; this server checks the transaction on the network and records it.
//  - Tron: TRX or USDT, built by TronGrid here, signed and sent by MoonPay's kit, checked here.
//  - Bitcoin: not yet (MoonPay's kit needs a PSBT built for it).
import crypto from "node:crypto";
import { createStore } from "./store.js";
import { audit } from "./audit.js";
import * as moonwallet from "./moonwallet.js";
import { rpc } from "./wallet.js";
import * as wallettx from "./wallettx.js";

const store = () => createStore();
const QUOTE_TTL_MS = 120_000;
const NEW_ACCOUNT_MIN = 890_880n; // lamports: the rent-exempt minimum of an empty Solana account
let get = async (url: string, init?: RequestInit): Promise<any> => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.Error ?? j?.error?.message ?? `HTTP ${r.status}`);
  return j;
};
export function __setFetchForTests(f: (url: string, init?: RequestInit) => Promise<any>) {
  get = f;
}

// ---------- amounts ----------
// A decimal amount as the coin's smallest units, exactly (no floating point).
export function toRaw(amount: unknown, decimals: number): bigint {
  const s = String(amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Enter an amount, like 1.5.");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`This coin has at most ${decimals} decimals.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (raw <= 0n) throw new Error("Enter an amount above zero.");
  return raw;
}
const fromRaw = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

// ---------- Solana: addresses ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58(b: Buffer): string {
  let n = BigInt("0x" + (b.toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = "1" + s; }
  return s;
}
const key32 = (a: string) => {
  const b = moonwallet.base58(a);
  if (b.length !== 32) throw new Error("That is not a Solana address.");
  return b;
};
// Is this 32-byte string a point on the ed25519 curve? (A program-derived address must not be.)
const P = 2n ** 255n - 19n;
const mod = (a: bigint) => ((a % P) + P) % P;
const pow = (b: bigint, e: bigint) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; } return r; };
const D = mod(-121665n * pow(121666n, P - 2n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);
export function onCurve(bytes: Buffer): boolean {
  const le = Buffer.from(bytes).reverse();
  le[0] &= 0x7f;
  const y = BigInt("0x" + le.toString("hex"));
  if (y >= P) return false;
  const u = mod(y * y - 1n), v = mod(D * y * y + 1n);
  const x2 = mod(u * pow(v, P - 2n));
  if (x2 === 0n) return true;
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
  return mod(x * x - x2) === 0n;
}
export function findPda(seeds: Buffer[], program: Buffer): Buffer {
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash("sha256").update(Buffer.concat([...seeds, Buffer.from([bump]), program, Buffer.from("ProgramDerivedAddress")])).digest();
    if (!onCurve(h)) return h;
  }
  throw new Error("No address could be derived.");
}
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const ataOf = (owner: Buffer, mint: Buffer, tokenProgram: Buffer) => findPda([owner, tokenProgram, mint], key32(ATA_PROGRAM));

// ---------- Solana: a transaction ----------
const cu16 = (n: number) => { const out: number[] = []; for (;;) { const b = n & 0x7f; n >>= 7; if (!n) { out.push(b); return Buffer.from(out); } out.push(b | 0x80); } };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
type Meta = { key: Buffer; signer: boolean; writable: boolean };
type Ix = { program: Buffer; keys: Meta[]; data: Buffer };
// A legacy message with one signer (the payer), compiled the way Solana orders its accounts.
export function compile(payer: Buffer, ixs: Ix[], blockhash: Buffer): Buffer {
  const metas = new Map<string, Meta>();
  const add = (m: Meta) => {
    const k = m.key.toString("hex"), had = metas.get(k);
    metas.set(k, had ? { key: m.key, signer: had.signer || m.signer, writable: had.writable || m.writable } : { ...m });
  };
  add({ key: payer, signer: true, writable: true });
  for (const ix of ixs) { ix.keys.forEach(add); add({ key: ix.program, signer: false, writable: false }); }
  const all = [...metas.values()];
  const group = (s: boolean, w: boolean) => all.filter((m) => m.signer === s && m.writable === w && !m.key.equals(payer));
  const ordered = [metas.get(payer.toString("hex"))!, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const at = (k: Buffer) => ordered.findIndex((m) => m.key.equals(k));
  const header = Buffer.from([ordered.filter((m) => m.signer).length, ordered.filter((m) => m.signer && !m.writable).length, ordered.filter((m) => !m.signer && !m.writable).length]);
  const ixBufs = ixs.map((ix) => Buffer.concat([Buffer.from([at(ix.program)]), cu16(ix.keys.length), Buffer.from(ix.keys.map((m) => at(m.key))), cu16(ix.data.length), ix.data]));
  return Buffer.concat([header, cu16(ordered.length), ...ordered.map((m) => m.key), blockhash, cu16(ixs.length), ...ixBufs]);
}
const unsigned = (message: Buffer) => Buffer.concat([cu16(1), Buffer.alloc(64), message]);
// The message of a serialized transaction (everything after its signatures).
function messageOf(tx: Buffer): Buffer {
  let n = 0, shift = 0, i = 0;
  for (;;) { const b = tx[i++]; if (b === undefined) throw new Error("Bad transaction"); n |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  return tx.subarray(i + 64 * n);
}

type Pending = { key: string; tx: string; to: string; asset: string; symbol: string; amount: number; at: number };
export async function solanaQuote(owner: string, body: any) {
  const w = await moonwallet.myWallet(owner);
  if (!w) throw new Error("Your Solana wallet isn't made yet.");
  const to = String(body?.to ?? "").trim();
  if (!moonwallet.ADDRESS.solana.test(to)) throw new Error("That is not a Solana address.");
  const toKey = key32(to), me = key32(w.address);
  if (toKey.equals(me)) throw new Error("That is this wallet's own address.");
  const asset = String(body?.mint ?? "SOL");
  const ixs: Ix[] = [];
  let symbol = "SOL", amount = 0, createsAccount = false;
  if (asset === "SOL") {
    const raw = toRaw(body?.amount, 9);
    const bal = BigInt((await rpc<{ value: number }>("getBalance", [w.address, { commitment: "confirmed" }])).value);
    if (raw + 5_000n > bal) throw new Error(`Not enough SOL: you have ${fromRaw(bal, 9)} SOL, and the network fee is 0.000005 SOL.`);
    // A Solana address that holds nothing yet only comes into being with at least its rent-exempt minimum.
    const theirs = BigInt((await rpc<{ value: number }>("getBalance", [to, { commitment: "confirmed" }])).value);
    if (theirs === 0n && raw < NEW_ACCOUNT_MIN) throw new Error(`That address holds nothing yet: Solana needs at least ${fromRaw(NEW_ACCOUNT_MIN, 9)} SOL sent to a new address.`);
    ixs.push({ program: key32(SYSTEM_PROGRAM), keys: [{ key: me, signer: true, writable: true }, { key: toKey, signer: false, writable: true }], data: Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(raw)]) });
    amount = fromRaw(raw, 9);
  } else {
    if (!moonwallet.ADDRESS.solana.test(asset)) throw new Error("Pick a coin to send.");
    const mint = key32(asset);
    const info = await rpc<{ value: { owner: string } | null }>("getAccountInfo", [asset, { encoding: "base64" }]);
    const program = info.value?.owner;
    if (program !== TOKEN_PROGRAM && program !== TOKEN_2022) throw new Error("That is not a Solana token.");
    const accounts = await rpc<{ value: any[] }>("getTokenAccountsByOwner", [w.address, { mint: asset }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const held = (accounts.value ?? []).map((a) => ({ pubkey: String(a.pubkey), amount: BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0"), decimals: Number(a.account?.data?.parsed?.info?.tokenAmount?.decimals), frozen: a.account?.data?.parsed?.info?.state === "frozen" }))
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    if (!held.length || held[0].amount === 0n) throw new Error("You don't hold this coin.");
    // A token account its issuer froze can't send: the largest one that isn't frozen is used.
    const mine = held.filter((a) => !a.frozen);
    if (!mine.length || mine[0].amount === 0n) throw new Error("This coin is frozen in your wallet by its issuer: it can't be sent.");
    const decimals = mine[0].decimals;
    const raw = toRaw(body?.amount, decimals);
    if (raw > mine[0].amount) throw new Error(`Not enough: you have ${fromRaw(mine[0].amount, decimals)}.`);
    const tp = key32(program), dest = ataOf(toKey, mint, tp);
    createsAccount = !(await rpc<{ value: unknown }>("getAccountInfo", [b58(dest), { encoding: "base64" }])).value;
    // Open the receiver's token account if it has none (idempotent), then transfer.
    ixs.push({ program: key32(ATA_PROGRAM), keys: [{ key: me, signer: true, writable: true }, { key: dest, signer: false, writable: true }, { key: toKey, signer: false, writable: false }, { key: mint, signer: false, writable: false }, { key: key32(SYSTEM_PROGRAM), signer: false, writable: false }, { key: tp, signer: false, writable: false }], data: Buffer.from([1]) });
    ixs.push({ program: tp, keys: [{ key: key32(mine[0].pubkey), signer: false, writable: true }, { key: mint, signer: false, writable: false }, { key: dest, signer: false, writable: true }, { key: me, signer: true, writable: false }], data: Buffer.concat([Buffer.from([12]), u64(raw), Buffer.from([decimals])]) });
    symbol = String(body?.symbol ?? "").slice(0, 16) || asset.slice(0, 4);
    amount = fromRaw(raw, decimals);
  }
  const bh = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = unsigned(compile(me, ixs, key32(bh.value.blockhash))).toString("base64");
  const requestId = crypto.randomBytes(12).toString("hex");
  await store().kvSet(`send-order:${requestId}`, { key: owner, tx, to, asset, symbol, amount, at: Date.now() } satisfies Pending, { ttlMs: QUOTE_TTL_MS });
  return { requestId, transaction: tx, wallet: w.address, to, symbol, amount, networkFeeSol: 0.000005 + (createsAccount ? 0.00203928 : 0), createsAccount, expiresAt: Date.now() + 90_000 };
}

export async function solanaExecute(owner: string, body: any) {
  const requestId = String(body?.requestId ?? ""), signed = String(body?.signedTransaction ?? "");
  const p = requestId ? await store().kvGet<Pending>(`send-order:${requestId}`) : null;
  if (!p || p.key !== owner) throw new Error("This transfer expired. Review it again.");
  await store().kvDel(`send-order:${requestId}`); // one try only, right or wrong
  let same = false;
  try { same = messageOf(Buffer.from(signed, "base64")).equals(messageOf(Buffer.from(p.tx, "base64"))); } catch { same = false; }
  if (!same) throw new Error("The signed transaction is not the transfer you reviewed. Nothing was sent.");
  const rec = await wallettx.startTx(owner, "solana", "send", { cryptoCurrency: p.symbol, network: "solana", cryptoAmount: p.amount, walletAddress: p.to }).catch(() => null);
  let signature: string | null = null, error: string | null = null, status: "completed" | "failed" | "pending" = "pending";
  try {
    signature = await rpc<string>("sendTransaction", [signed, { encoding: "base64", preflightCommitment: "confirmed" }]);
    for (let i = 0; i < 20; i++) {
      const s = await rpc<{ value: ({ confirmationStatus?: string; err?: unknown } | null)[] }>("getSignatureStatuses", [[signature]]);
      const st = s.value?.[0];
      if (st?.err) { status = "failed"; error = "The network refused the transfer."; break; }
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) { status = "completed"; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e: any) {
    status = "failed";
    error = String(e?.message ?? e).replace(/^Solana RPC: /, "").slice(0, 200);
  }
  if (rec) await wallettx.recordUpdate({ provider: "solana", id: rec.id, key: owner, status, source: "app", fields: { txHash: signature, ...(error ? { failureReason: error } : {}) } }).catch(() => null);
  await audit(owner, status === "failed" ? "wallet.send_failed" : "wallet.send", `${status === "failed" ? "Sending failed" : "Sent"}: ${p.amount} ${p.symbol} to ${p.to.slice(0, 4)}…${p.to.slice(-4)} (Solana)${error ? `: ${error}` : ""}`, { to: p.to, amount: p.amount, symbol: p.symbol, signature });
  return { status, signature, error, id: rec?.id ?? null };
}

// ---------- Tron: TRX and USDT, built by TronGrid ----------
const TRONGRID = () => (process.env.TRONGRID_URL?.trim() || "https://api.trongrid.io").replace(/\/+$/, "");
export const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
// A Tron address with its checksum checked; returns its 21 bytes (0x41 + 20).
export function tronBytes(a: string): Buffer {
  if (!moonwallet.ADDRESS.tron.test(a)) throw new Error("That is not a Tron address.");
  const b = moonwallet.base58(a);
  const body = b.subarray(0, 21), sum = b.subarray(21);
  const check = crypto.createHash("sha256").update(crypto.createHash("sha256").update(body).digest()).digest().subarray(0, 4);
  if (b.length !== 25 || body[0] !== 0x41 || !sum.equals(check)) throw new Error("That is not a valid Tron address (its check digits don't match).");
  return Buffer.from(body);
}
export async function tronBuild(owner: string, body: any) {
  const w = await store().kvGet<{ address: string }>(`moonpay-wallet-tron:${owner}`);
  if (!w) throw new Error("Your Tron wallet isn't made yet.");
  const to = String(body?.to ?? "").trim();
  const toBytes = tronBytes(to);
  if (to === w.address) throw new Error("That is this wallet's own address.");
  const asset = body?.asset === "USDT" ? "USDT" : "TRX";
  const raw = toRaw(body?.amount, 6);
  if (asset === "TRX") {
    const tx = await get(`${TRONGRID()}/wallet/createtransaction`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner_address: w.address, to_address: to, amount: Number(raw), visible: true }) });
    if (!tx?.txID) throw new Error(`Tron could not prepare it: ${tx?.Error ?? "no transaction"}`);
    return { transaction: tx, wallet: w.address, to, asset, amount: fromRaw(raw, 6) };
  }
  const parameter = toBytes.subarray(1).toString("hex").padStart(64, "0") + raw.toString(16).padStart(64, "0");
  const r = await get(`${TRONGRID()}/wallet/triggersmartcontract`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner_address: w.address, contract_address: TRON_USDT, function_selector: "transfer(address,uint256)", parameter, fee_limit: 30_000_000, call_value: 0, visible: true }) });
  if (!r?.result?.result || !r?.transaction?.txID) throw new Error(`Tron could not prepare it: ${r?.result?.message ? Buffer.from(r.result.message, "hex").toString() : "no transaction"}`);
  return { transaction: r.transaction, wallet: w.address, to, asset, amount: fromRaw(raw, 6) };
}

// ---------- Ethereum & EVM, and Tron: record a transfer MoonPay's kit sent ----------
export const EVM_SEND: Record<string, { name: string; symbol: string; rpc: string; explorer: string; test?: boolean }> = {
  "1": { name: "Ethereum", symbol: "ETH", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io/tx/" },
  "56": { name: "BNB Chain", symbol: "BNB", rpc: "https://bsc-rpc.publicnode.com", explorer: "https://bscscan.com/tx/" },
  "8453": { name: "Base", symbol: "ETH", rpc: "https://base-rpc.publicnode.com", explorer: "https://basescan.org/tx/" },
  "137": { name: "Polygon", symbol: "POL", rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygonscan.com/tx/" },
  "42161": { name: "Arbitrum", symbol: "ETH", rpc: "https://arbitrum-one-rpc.publicnode.com", explorer: "https://arbiscan.io/tx/" },
  "10": { name: "Optimism", symbol: "ETH", rpc: "https://optimism-rpc.publicnode.com", explorer: "https://optimistic.etherscan.io/tx/" },
  "43114": { name: "Avalanche", symbol: "AVAX", rpc: "https://avalanche-c-chain-rpc.publicnode.com", explorer: "https://snowtrace.io/tx/" },
  "11155111": { name: "Sepolia (test)", symbol: "ETH", rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io/tx/", test: true },
};
// The browser reports a transfer it sent with the customer's wallet; it is recorded only when the
// network itself shows it came from that wallet (to the address and amount reported).
export async function recordSent(owner: string, body: any) {
  const chain = String(body?.chain ?? "");
  const hash = String(body?.hash ?? "");
  let from: string | null = null, to: string | null = null, amount = 0, symbol = "", network = "", mined = false;
  if (chain === "ethereum") {
    const net = EVM_SEND[String(body?.chainId ?? "")];
    if (!net || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Unknown transfer.");
    const w = await store().kvGet<{ address: string }>(`moonpay-wallet-ethereum:${owner}`);
    const j = await get(net.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }) });
    const t = j?.result;
    if (!t || !w || String(t.from).toLowerCase() !== w.address.toLowerCase()) throw new Error("That transfer is not from your wallet.");
    from = w.address; to = String(t.to); amount = Number(BigInt(t.value)) / 1e18; symbol = net.symbol; network = net.name; mined = !!t.blockNumber;
  } else if (chain === "tron") {
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Unknown transfer.");
    const w = await store().kvGet<{ address: string }>(`moonpay-wallet-tron:${owner}`);
    const t = await get(`${TRONGRID()}/wallet/gettransactionbyid`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: hash, visible: true }) });
    const c = t?.raw_data?.contract?.[0]?.parameter?.value;
    if (!c || !w || c.owner_address !== w.address) throw new Error("That transfer is not from your wallet.");
    from = w.address; to = String(body?.to ?? c.to_address ?? ""); amount = Number(body?.amount) || Number(c.amount ?? 0) / 1e6; symbol = body?.asset === "USDT" ? "USDT" : "TRX"; network = "tron"; mined = t?.ret?.[0]?.contractRet === "SUCCESS";
  } else throw new Error("Unknown network.");
  const rec = await wallettx.startTx(owner, chain, "send", { cryptoCurrency: symbol, network, cryptoAmount: amount, walletAddress: to, txHash: hash }).catch(() => null);
  if (rec) await wallettx.recordUpdate({ provider: chain, id: rec.id, key: owner, status: mined ? "completed" : "pending", source: "app", fields: { txHash: hash } }).catch(() => null);
  await audit(owner, "wallet.send", `Sent: ${amount} ${symbol} to ${String(to).slice(0, 6)}… (${network})`, { from, to, amount, symbol, hash });
  return { recorded: !!rec, id: rec?.id ?? null };
}
