// Customers' real-money transactions: the server's side of the table (supabase/schema.sql,
// trade_wallet_tx). The rules for what a message may change are in wallettx-core.ts (and, the same,
// in the database). This module gives each transaction its id, starts it, records what the
// provider says, and reads a customer's own transactions back for the app.
//
// What is never done here: taking a status, an amount or a wallet address from the browser. A
// transaction is started by the server (with values it checked) and changed only by what the
// provider confirms: its signed messages, and the server's own questions to it.
import crypto from "node:crypto";
import { createStore } from "./store.js";
import { WALLET_TX_KINDS, type WalletTx, type WalletTxEvent, type WalletTxFields, type WalletTxKind, type WalletTxResult, type WalletTxUpdate } from "./wallettx-core.js";

const store = () => createStore();
// Ours, given to the provider as its reference (MoonPay: externalTransactionId): 96 random bits.
export const newTxId = () => `wtx_${crypto.randomBytes(12).toString("hex")}`;
export const TX_ID_RE = /^wtx_[0-9a-f]{24}$/;

function need<K extends "wtxStart" | "wtxUpdate" | "wtxList" | "wtxGet" | "wtxOpen">(fn: K) {
  const s = store();
  const f = s[fn];
  if (!f) throw new Error("This storage cannot keep real-money transactions.");
  return f.bind(s) as NonNullable<(typeof s)[K]>;
}

export async function startTx(key: string, provider: string, kind: WalletTxKind, fields: WalletTxFields, id = newTxId()): Promise<WalletTx> {
  if (!key) throw new Error("Sign in first.");
  if (!(WALLET_TX_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown kind of transaction: ${kind}`);
  return need("wtxStart")(id, key, provider, kind, fields);
}
export async function recordUpdate(u: WalletTxUpdate): Promise<WalletTxResult> {
  return need("wtxUpdate")(u);
}
export async function openTransactions(provider: string, unchangedForMs: number, limit = 20): Promise<WalletTx[]> {
  return need("wtxOpen")(provider, Date.now() - unchangedForMs, limit);
}

// What a customer sees of a transaction: everything about it except the provider's raw record
// (kept for support, in the database) and the customer key (it is their own).
export type PublicTx = Omit<WalletTx, "detail" | "key">;
const publicTx = ({ detail: _d, key: _k, ...t }: WalletTx): PublicTx => t;

export async function myTransactions(key: string, beforeMs: number | null, limit = 50): Promise<PublicTx[]> {
  const n = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
  return (await need("wtxList")(key, beforeMs, n)).map(publicTx);
}
export async function myTransaction(key: string, id: string): Promise<{ tx: PublicTx; events: WalletTxEvent[] } | null> {
  if (!TX_ID_RE.test(id)) return null;
  const r = await need("wtxGet")(key, id);
  return r ? { tx: publicTx(r.tx), events: r.events } : null;
}
