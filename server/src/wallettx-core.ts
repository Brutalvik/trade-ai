// Customers' real-money transactions: the types, and the rules that decide whether a message from
// the payment provider changes a transaction. Pure (no storage, no network), so the database's
// own copy of these rules (trade_wtx_update in supabase/schema.sql) and the local file store's
// copy (store.ts) can be tested against the same cases (test/unit/wallet-tx.mts).
//
// A transaction is one row per customer action with real money: buying crypto with a card or
// Apple Pay, selling it, swapping, sending, receiving. Its status only moves forward:
//   started (the customer began, nothing paid yet) -> pending (the provider is working on it)
//   -> one final status: completed, failed, cancelled, refunded, expired.
// Once final, only a newer final word changes it (e.g. completed, then refunded).

export const WALLET_TX_STATUSES = ["started", "pending", "completed", "failed", "cancelled", "refunded", "expired"] as const;
export type WalletTxStatus = (typeof WALLET_TX_STATUSES)[number];
export const WALLET_TX_KINDS = ["buy", "sell", "swap", "send", "receive"] as const;
export type WalletTxKind = (typeof WALLET_TX_KINDS)[number];
export const FINAL_STATUSES: readonly WalletTxStatus[] = ["completed", "failed", "cancelled", "refunded", "expired"];
export const isFinal = (s: WalletTxStatus) => FINAL_STATUSES.includes(s);
const rank = (s: WalletTxStatus) => (s === "started" ? 0 : s === "pending" ? 1 : 2);

// Amounts are kept as the provider gave them (a decimal number or its text); the database keeps them as exact decimals.
export type Amount = number | string | null | undefined;
export type WalletTxFields = {
  kind?: WalletTxKind;
  fiatCurrency?: string | null;
  fiatAmount?: Amount;
  feeAmount?: Amount;
  networkFeeAmount?: Amount;
  extraFeeAmount?: Amount;
  cryptoCurrency?: string | null;
  network?: string | null;
  cryptoAmount?: Amount;
  walletAddress?: string | null;
  txHash?: string | null;
  failureReason?: string | null;
  flag?: string | null; // something a person should look at
  detail?: unknown;
};

export type WalletTx = {
  id: string; // ours (MoonPay: externalTransactionId)
  key: string; // the customer
  provider: string;
  providerId: string | null;
  kind: WalletTxKind;
  status: WalletTxStatus;
  providerStatus: string | null;
  final: boolean;
  fiatCurrency: string | null;
  fiatAmount: number | null;
  feeAmount: number | null;
  networkFeeAmount: number | null;
  extraFeeAmount: number | null;
  cryptoCurrency: string | null;
  network: string | null;
  cryptoAmount: number | null;
  walletAddress: string | null;
  txHash: string | null;
  failureReason: string | null;
  flag: string | null;
  createdAt: number;
  updatedAt: number;
  providerUpdatedAt: number | null;
  detail: unknown;
};

// What the provider says about a transaction. source: webhook = its signed message; check = the
// server asked it; app = the app itself (only for "started").
export type WalletTxUpdate = {
  provider: string;
  id?: string | null;
  providerId?: string | null;
  key?: string | null;
  status: WalletTxStatus;
  providerStatus?: string | null;
  providerAt?: number | null;
  fields?: WalletTxFields;
  source: "webhook" | "check" | "app";
  eventId?: string | null;
  eventType?: string | null;
  payload?: unknown;
};
export type WalletTxResult = { applied: boolean; duplicate: boolean; note: string | null; tx: WalletTx | null };
export type WalletTxEvent = { at: number; source: string; type: string | null; status: string | null; applied: boolean; note: string | null };

// Does this message change the transaction? (The same rules as trade_wtx_update in schema.sql.)
// flag = something a person should look at; the change still applies.
export function decide(tx: WalletTx | null, u: WalletTxUpdate): { apply: boolean; note: string | null; flag: string | null } {
  if (!tx) return { apply: false, note: "no such transaction", flag: null };
  if (tx.provider !== u.provider) return { apply: false, note: "another provider's transaction", flag: null };
  if (u.id && tx.id !== u.id) return { apply: false, note: "our id and the provider's id name different transactions", flag: null };
  if (u.key && u.key !== tx.key) return { apply: false, note: "another customer's transaction", flag: null };
  if (u.providerId && tx.providerId && u.providerId !== tx.providerId) return { apply: false, note: "another provider id", flag: null };
  const was = rank(tx.status), now = rank(u.status);
  if (now < was) return { apply: false, note: `older news: it is ${tx.status} already`, flag: null };
  if (now === was && tx.providerUpdatedAt !== null && (u.providerAt === null || u.providerAt === undefined || u.providerAt <= tx.providerUpdatedAt))
    return { apply: false, note: "not newer than what is known", flag: null };
  const addr = u.fields?.walletAddress || null;
  if (tx.walletAddress && addr && addr !== tx.walletAddress) {
    const flag = `the provider names wallet ${addr}, not the one the app gave`;
    return { apply: true, note: flag, flag };
  }
  return { apply: true, note: null, flag: null };
}

const num = (v: Amount): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? null : String(v));

// The transaction after an update that applies (the same as the database's update).
export function applied(tx: WalletTx, u: WalletTxUpdate, flag: string | null, now = Date.now()): WalletTx {
  const f = u.fields ?? {};
  return {
    ...tx,
    status: u.status,
    providerStatus: u.providerStatus ?? tx.providerStatus,
    final: isFinal(u.status),
    providerId: tx.providerId ?? u.providerId ?? null,
    fiatCurrency: text(f.fiatCurrency) ?? tx.fiatCurrency,
    fiatAmount: num(f.fiatAmount) ?? tx.fiatAmount,
    feeAmount: num(f.feeAmount) ?? tx.feeAmount,
    networkFeeAmount: num(f.networkFeeAmount) ?? tx.networkFeeAmount,
    extraFeeAmount: num(f.extraFeeAmount) ?? tx.extraFeeAmount,
    cryptoCurrency: text(f.cryptoCurrency) ?? tx.cryptoCurrency,
    network: text(f.network) ?? tx.network,
    cryptoAmount: num(f.cryptoAmount) ?? tx.cryptoAmount,
    walletAddress: tx.walletAddress ?? text(f.walletAddress),
    txHash: text(f.txHash) ?? tx.txHash,
    failureReason: text(f.failureReason) ?? tx.failureReason,
    flag: flag ?? text(f.flag) ?? tx.flag,
    providerUpdatedAt: tx.providerUpdatedAt === null ? (u.providerAt ?? null) : u.providerAt === null || u.providerAt === undefined ? tx.providerUpdatedAt : Math.max(tx.providerUpdatedAt, u.providerAt),
    updatedAt: now,
    detail: f.detail !== undefined ? f.detail : tx.detail,
  };
}

// A new transaction, as trade_wtx_start makes it.
export function started(id: string, key: string, provider: string, kind: WalletTxKind, f: WalletTxFields = {}, now = Date.now(), providerId: string | null = null): WalletTx {
  return {
    id, key, provider, providerId, kind, status: "started", providerStatus: null, final: false,
    fiatCurrency: text(f.fiatCurrency), fiatAmount: num(f.fiatAmount), feeAmount: null, networkFeeAmount: null, extraFeeAmount: null,
    cryptoCurrency: text(f.cryptoCurrency), network: text(f.network), cryptoAmount: num(f.cryptoAmount), walletAddress: text(f.walletAddress),
    txHash: null, failureReason: null, flag: null, createdAt: now, updatedAt: now, providerUpdatedAt: null, detail: f.detail ?? {},
  };
}

// The fields as the database functions take them (snake_case; amounts as text, so no decimal is rounded on the way).
export function fieldsForDb(f: WalletTxFields = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== "") out[k] = v; };
  const amt = (v: Amount) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : String(v));
  put("kind", f.kind);
  put("fiat_currency", f.fiatCurrency);
  put("fiat_amount", amt(f.fiatAmount));
  put("fee_amount", amt(f.feeAmount));
  put("network_fee_amount", amt(f.networkFeeAmount));
  put("extra_fee_amount", amt(f.extraFeeAmount));
  put("crypto_currency", f.cryptoCurrency);
  put("network", f.network);
  put("crypto_amount", amt(f.cryptoAmount));
  put("wallet_address", f.walletAddress);
  put("tx_hash", f.txHash);
  put("failure_reason", f.failureReason);
  put("flag", f.flag);
  if (f.detail !== undefined) out.detail = f.detail;
  return out;
}

// A row as the database gives it (to_jsonb: snake_case, times as text) -> WalletTx.
const ms = (v: unknown) => (v === null || v === undefined ? null : typeof v === "number" ? v : Date.parse(String(v)));
export function fromDb(r: any): WalletTx {
  return {
    id: r.id, key: r.key, provider: r.provider, providerId: r.provider_id ?? null, kind: r.kind, status: r.status,
    providerStatus: r.provider_status ?? null, final: !!r.final,
    fiatCurrency: r.fiat_currency ?? null, fiatAmount: num(r.fiat_amount), feeAmount: num(r.fee_amount), networkFeeAmount: num(r.network_fee_amount),
    extraFeeAmount: num(r.extra_fee_amount), cryptoCurrency: r.crypto_currency ?? null, network: r.network ?? null, cryptoAmount: num(r.crypto_amount),
    walletAddress: r.wallet_address ?? null, txHash: r.tx_hash ?? null, failureReason: r.failure_reason ?? null, flag: r.flag ?? null,
    createdAt: ms(r.created_at) ?? 0, updatedAt: ms(r.updated_at) ?? 0, providerUpdatedAt: ms(r.provider_updated_at), detail: r.detail ?? {},
  };
}
export const eventFromDb = (e: any): WalletTxEvent => ({ at: ms(e.at) ?? 0, source: e.source, type: e.type ?? null, status: e.status ?? null, applied: !!e.applied, note: e.note ?? null });
