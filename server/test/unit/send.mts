// Sending crypto from a customer's own wallets (src/send.ts): Solana transfers built here exactly
// (checked against the real network once: the derived token-account address matched a real wallet's
// USDC account, and a SOL and a USDC transfer simulated cleanly on mainnet, 27 Nov 2026), sent only
// when the signed transaction is the one reviewed; Tron transfers built by TronGrid; transfers the
// browser sent recorded only when the network shows them coming from the customer's wallet.
// Every network here is faked.
import { check, expect, finish } from "../check.mts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "trading-rust-send-")));
for (const k of Object.keys(process.env)) if (/REST_API_|REDIS|SUPABASE|_UPSTASH|MOONPAY|MOONX|TRONGRID/.test(k)) delete process.env[k];
delete process.env.VERCEL;
process.env.SOLANA_RPC_URL = "https://rpc.fake.test";

const send = await import(new URL("../../src/send.ts", import.meta.url).href);
const mw = await import(new URL("../../src/moonwallet.ts", import.meta.url).href);
const { createStore } = await import(new URL("../../src/store.ts", import.meta.url).href);
const store = createStore();
const fail = (f: () => unknown) => Promise.resolve().then(f).then(() => "accepted", (e: Error) => e.message);
const pub = () => crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32);

// ---------- amounts, exactly ----------
expect("amounts become the coin's smallest units exactly (no rounding)", [send.toRaw("1.5", 9), send.toRaw("0.000001", 6), send.toRaw("123456789.123456", 6)].map(String), ["1500000000", "1", "123456789123456"]);
expect("...and anything else is refused plainly", [await fail(() => send.toRaw("1.1234567", 6)), await fail(() => send.toRaw("abc", 6)), await fail(() => send.toRaw("0", 6))], ["This coin has at most 6 decimals.", "Enter an amount, like 1.5.", "Enter an amount above zero."]);

// ---------- Solana addresses ----------
check("a wallet's public key is a point on the curve", send.onCurve(pub()));
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ata = send.ataOf(mw.base58("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"), mw.base58(USDC), mw.base58(send.TOKEN_PROGRAM));
expect("a wallet's token account is derived as Solana does (a real wallet's USDC account, checked on the network)", send.b58(ata), "FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq");
check("...and it is not on the curve (no one holds a key for it)", !send.onCurve(ata));
const payer = pub(), to = pub();
const msg = send.compile(payer, [{ program: mw.base58(send.SYSTEM_PROGRAM), keys: [{ key: payer, signer: true, writable: true }, { key: to, signer: false, writable: true }], data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }], crypto.randomBytes(32));
expect("a transfer's message: one signer (the sender), the receiver writable, the program read-only, in Solana's order", [[...msg.subarray(0, 4)], msg.subarray(4, 36).equals(payer), msg.subarray(36, 68).equals(to), send.b58(msg.subarray(68, 100))], [[1, 0, 1, 3], true, true, send.SYSTEM_PROGRAM]);

// ---------- a pretend Solana node ----------
const me = pub(), ME = send.b58(me), MINT = send.b58(pub()), FROZEN = send.b58(pub());
const balances: Record<string, number> = { [ME]: 2_000_000_000 };
let sent: string[] = [];
let sigStatus: any = { confirmationStatus: "confirmed", err: null };
let tronCalls: any[] = [];
let TRON_ME = "";
const evmTx: Record<string, any> = {};
globalThis.fetch = (async (input: any, init?: any) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  const b = init?.body ? JSON.parse(String(init.body)) : {};
  if (u.host === "rpc.fake.test") {
    const r = (result: unknown) => Response.json({ jsonrpc: "2.0", id: b.id, result });
    if (b.method === "getBalance") return r({ value: balances[b.params[0]] ?? 0 });
    if (b.method === "getAccountInfo") return r({ value: b.params[0] === MINT || b.params[0] === FROZEN ? { owner: send.TOKEN_PROGRAM } : null });
    if (b.method === "getTokenAccountsByOwner") {
      const mint = b.params[1].mint;
      const acc = (amount: string, state = "initialized") => ({ pubkey: send.b58(pub()), account: { data: { parsed: { info: { tokenAmount: { amount, decimals: 6 }, state } } } } });
      return r({ value: mint === MINT ? [acc("5000000"), acc("0")] : mint === FROZEN ? [acc("9000000", "frozen")] : [] });
    }
    if (b.method === "getLatestBlockhash") return r({ value: { blockhash: send.b58(crypto.randomBytes(32)) } });
    if (b.method === "sendTransaction") { sent.push(b.params[0]); return r("SiGnAtUrE111"); }
    if (b.method === "getSignatureStatuses") return r({ value: [sigStatus] });
    return r(null);
  }
  if (u.host === "api.trongrid.io") {
    tronCalls.push({ path: u.pathname, body: b });
    if (u.pathname === "/wallet/createtransaction") return Response.json({ txID: "aa".repeat(32), raw_data: { contract: [] }, raw_data_hex: "00", visible: true });
    if (u.pathname === "/wallet/triggersmartcontract") return Response.json({ result: { result: true }, transaction: { txID: "bb".repeat(32), raw_data: {}, raw_data_hex: "00" } });
    if (u.pathname === "/wallet/gettransactionbyid") return Response.json({ raw_data: { contract: [{ parameter: { value: { owner_address: b.value === "cc".repeat(32) ? TRON_ME : "TSomeoneElse", to_address: "TReceiver", amount: 1_000_000 } } }] }, ret: [{ contractRet: "SUCCESS" }] });
  }
  if (u.host.endsWith("publicnode.com")) return Response.json({ jsonrpc: "2.0", id: 1, result: evmTx[b.params?.[0]] ?? null });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// ---------- Solana: building a transfer ----------
expect("no Solana wallet on file: nothing is built", await fail(() => send.solanaQuote("ada", { to: send.b58(pub()), amount: "1" })), "Your Solana wallet isn't made yet.");
await store.kvSet("moonpay-wallet:ada", { address: ME, chain: "solana", via: "proven", moonxUserId: "mx", at: Date.now() });
const other = send.b58(pub());
balances[other] = 5;
expect("refused before anything is signed: a bad address, its own address, more SOL than it holds (with the fee), and less than a new address needs", [
  await fail(() => send.solanaQuote("ada", { to: "not-an-address", amount: "1" })),
  await fail(() => send.solanaQuote("ada", { to: ME, amount: "1" })),
  await fail(() => send.solanaQuote("ada", { to: other, amount: "2" })),
  await fail(() => send.solanaQuote("ada", { to: send.b58(pub()), amount: "0.0001" })),
], ["That is not a Solana address.", "That is this wallet's own address.", "Not enough SOL: you have 2 SOL, and the network fee is 0.000005 SOL.", "That address holds nothing yet: Solana needs at least 0.00089088 SOL sent to a new address."]);
const q = await send.solanaQuote("ada", { to: other, amount: "0.5" });
check("SOL to an address that exists: built, unsigned, for the reviewed amount", q.amount === 0.5 && q.symbol === "SOL" && q.wallet === ME && Buffer.from(q.transaction, "base64").subarray(1, 65).equals(Buffer.alloc(64)), q);
expect("tokens: not held, frozen by their issuer, or more than held, are refused", [
  await fail(() => send.solanaQuote("ada", { mint: send.b58(pub()), to: other, amount: "1" })),
  await fail(() => send.solanaQuote("ada", { mint: FROZEN, to: other, amount: "1" })),
  await fail(() => send.solanaQuote("ada", { mint: MINT, to: other, amount: "6" })),
], ["That is not a Solana token.", "This coin is frozen in your wallet by its issuer: it can't be sent.", "Not enough: you have 5."]);
const tq = await send.solanaQuote("ada", { mint: MINT, symbol: "COIN", to: other, amount: "2.5" });
const tmsg = Buffer.from(tq.transaction, "base64").subarray(65);
check("a token transfer opens the receiver's token account if needed (its fee shown) and sends exactly 2.5", tq.createsAccount && tq.networkFeeSol > 0.002 && tmsg.includes(send.ataOf(mw.base58(other), mw.base58(MINT), mw.base58(send.TOKEN_PROGRAM))) && tmsg.includes(Buffer.from([12, 0xa0, 0x25, 0x26, 0, 0, 0, 0, 0, 6])), tq);

// ---------- Solana: sending it ----------
const signedLike = (txB64: string, change = false) => { const b = Buffer.from(txB64, "base64"); crypto.randomBytes(64).copy(b, 1); if (change) b[b.length - 1] ^= 1; return b.toString("base64"); };
expect("a transaction that is not the one reviewed is refused: nothing sent", [await fail(() => send.solanaExecute("ada", { requestId: q.requestId, signedTransaction: signedLike(q.transaction, true) })), sent.length], ["The signed transaction is not the transfer you reviewed. Nothing was sent.", 0]);
expect("...and that review is used up (a fresh one is needed)", await fail(() => send.solanaExecute("ada", { requestId: q.requestId, signedTransaction: signedLike(q.transaction) })), "This transfer expired. Review it again.");
expect("someone else cannot send another account's reviewed transfer", await fail(() => send.solanaExecute("eve", { requestId: tq.requestId, signedTransaction: signedLike(tq.transaction) })), "This transfer expired. Review it again.");
const q2 = await send.solanaQuote("ada", { to: other, amount: "0.25" });
const done = await send.solanaExecute("ada", { requestId: q2.requestId, signedTransaction: signedLike(q2.transaction) });
expect("the reviewed transaction, signed, is sent and confirmed", [done.status, done.signature, sent.length], ["completed", "SiGnAtUrE111", 1]);
sigStatus = { err: { InstructionError: [0, "x"] } };
const q3 = await send.solanaQuote("ada", { to: other, amount: "0.1" });
expect("one the network refuses is reported as not sent", (await send.solanaExecute("ada", { requestId: q3.requestId, signedTransaction: signedLike(q3.transaction) })).status, "failed");

// ---------- Tron ----------
// A real-format Tron address (0x41 + 20 bytes, with its check digits).
const tronAddr = () => { const body = Buffer.concat([Buffer.from([0x41]), crypto.randomBytes(20)]); const sum = crypto.createHash("sha256").update(crypto.createHash("sha256").update(body).digest()).digest().subarray(0, 4); return send.b58(Buffer.concat([body, sum])); };
TRON_ME = tronAddr();
expect("a Tron address's check digits are checked", [send.tronBytes(send.TRON_USDT).length, await fail(() => send.tronBytes("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"))], [21, "That is not a valid Tron address (its check digits don't match)."]);
await store.kvSet("moonpay-wallet-tron:ada", { address: TRON_ME, chain: "tron", via: "proven", moonxUserId: "mx", at: Date.now() });
const trx = await send.tronBuild("ada", { asset: "TRX", to: send.TRON_USDT, amount: "1.5" });
expect("TRX: TronGrid builds it, for the exact amount in sun", [trx.asset, tronCalls[0].body.amount, tronCalls[0].body.owner_address], ["TRX", 1_500_000, TRON_ME]);
await send.tronBuild("ada", { asset: "USDT", to: send.TRON_USDT, amount: "2" });
const usdtParam = tronCalls[1].body.parameter;
expect("USDT on Tron: transfer(address,uint256) with the receiver and the amount encoded as the contract reads them", [tronCalls[1].body.contract_address, usdtParam.length, usdtParam.slice(0, 24), usdtParam.slice(24, 64), BigInt("0x" + usdtParam.slice(64)).toString()], [send.TRON_USDT, 128, "0".repeat(24), send.tronBytes(send.TRON_USDT).subarray(1).toString("hex"), "2000000"]);
expect("its own address is refused", await fail(() => send.tronBuild("ada", { asset: "TRX", to: TRON_ME, amount: "1" })), "That is this wallet's own address.");

// ---------- recording what the browser sent ----------
await store.kvSet("moonpay-wallet-ethereum:ada", { address: "0x52908400098527886E0F7030069857D2E4169EE7", chain: "ethereum", via: "proven", moonxUserId: "mx", at: Date.now() });
const H1 = "0x" + "11".repeat(32), H2 = "0x" + "22".repeat(32);
evmTx[H1] = { from: "0x52908400098527886e0f7030069857d2e4169ee7", to: "0x000000000000000000000000000000000000dEaD", value: "0xde0b6b3a7640000", blockNumber: "0x1" };
evmTx[H2] = { from: "0x1111111111111111111111111111111111111111", to: "0x2", value: "0x1", blockNumber: "0x1" };
expect("a transfer the network shows from another wallet is never recorded as the customer's", await fail(() => send.recordSent("ada", { chain: "ethereum", chainId: 56, hash: H2 })), "That transfer is not from your wallet.");
check("one from their own wallet is accepted (BNB Chain)", (await fail(() => send.recordSent("ada", { chain: "ethereum", chainId: 56, hash: H1 }))) === "accepted");
expect("an unknown network is refused", await fail(() => send.recordSent("ada", { chain: "ethereum", chainId: 999, hash: H1 })), "Unknown transfer.");
expect("Tron: only a transfer from their own Tron wallet", [await fail(() => send.recordSent("ada", { chain: "tron", hash: "dd".repeat(32) })), await fail(() => send.recordSent("ada", { chain: "tron", hash: "cc".repeat(32), asset: "TRX" }))], ["That transfer is not from your wallet.", "accepted"]);
finish();
