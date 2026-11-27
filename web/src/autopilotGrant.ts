// What the auto-pilot card needs from MoonPay's wallet kit, which is loaded only when wallets are on
// (MoonPaySignIn.tsx provides it): granting MoonPay's signer to the server's key, and revoking it.
import { createContext } from "react";

export type AutopilotGrant = {
  signedIn: boolean; // signed in to MoonPay in this browser (needed to grant or revoke)
  signIn: () => void; // opens MoonPay's sign-in window
  // Grants MoonPay's signer for the Solana wallet `address` to the server's key, until expiresAt.
  // Returns MoonPay's id of that wallet and the sign-in tokens the server checks it with.
  grant: (apiPubHex: string, address: string, expiresAt: number) => Promise<{ walletId: string; accessToken: string; identityToken: string }>;
  revoke: (apiPubHex: string) => Promise<void>;
};
export const AutopilotGrantContext = createContext<AutopilotGrant | null>(null);
