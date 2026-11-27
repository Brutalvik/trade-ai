// What the wallet window needs from MoonPay's wallet kit, which is loaded only when wallets are on
// (MoonPaySignIn.tsx provides it): sending on Ethereum & EVM and Tron (the customer signs each one in
// MoonPay's window), and cashing out to a bank through MoonPay's own flow.
import { createContext } from "react";

export type CashOutChain = "solana" | "ethereum" | "tron";
export type WalletActions = {
  signedIn: boolean; // signed in to MoonPay in this browser (needed to sign anything)
  signIn: () => void; // opens MoonPay's sign-in window
  cashOut: (chain: CashOutChain, address: string) => Promise<void>;
  // Sends the network's own coin from the Ethereum wallet `address`; returns the transaction hash.
  sendEvm: (address: string, tx: { to: string; valueWei: string; chainId: number; rpcUrl: string }) => Promise<string>;
  // Signs and sends a Tron transaction built by the server from the Tron wallet `address`; returns its id.
  sendTron: (address: string, transaction: unknown) => Promise<string>;
};
export const WalletActionsContext = createContext<WalletActions | null>(null);
