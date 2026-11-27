// Sign up and sign in with MoonPay: MoonPay's own sign-in window (an emailed code, Google or Apple)
// makes the person's Solana wallet at sign-up, so every account has a MoonPay wallet from the start.
// The server checks MoonPay's tokens itself and asks MoonPay which wallet is theirs (auth.ts,
// moonwallet.ts): nothing about who someone is, or which wallet is theirs, is taken from here.
// Loaded only when the server has MoonPay's wallet keys (appMain.tsx): MoonPay's kit is large.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MoonXProvider, useMoonX } from "@moon-x/react-sdk";
import { useSignTransaction, useWallets } from "@moon-x/react-sdk/solana";
import "@moon-x/react-sdk/style.css";
import { api, MOONPAY_WALLET_EVENT, SIGNIN_EVENT, type User } from "./api";
import { Avatar, MoonPaySigner, MoonPayUI, ProfileModal, SetupProfileModal, SIGNIN_PENDING, type AccountButtonProps, type TxSigner } from "./Account";

const METHODS: ("email" | "google" | "apple")[] = ["email", "google", "apple"];
const UI = { AccountButton: (p: AccountButtonProps) => <MoonPayAccountButton {...p} /> };
// How MoonPay's sign-in window looks (MoonPay takes this from the code, not its dashboard): the
// owner's settings, with the accent in the logo's middle blue (the app's button colour, #00AEF0).
const APPEARANCE = {
  displayMode: "dark" as const,
  accentColor: "#00AEF0",
  borderRadius: "lg" as const,
  logo: "https://trade-ai-rust.vercel.app/logo.svg",
  loginHeaderTitle: "Sign up with Trading//Rust",
};

export function MoonPayRoot({ publishableKey, children }: { publishableKey: string; children: ReactNode }) {
  return (
    <MoonXProvider
      publishableKey={publishableKey}
      config={{
        loginMethods: METHODS,
        walletChainType: "solana", // the wallet made at sign-up
        // Real trades run on Solana's main network (MoonPay's sandbox pays test coins on devnet).
        chains: [{ id: "solana:mainnet", rpcUrl: "https://api.mainnet-beta.solana.com" }, { id: "solana:devnet", rpcUrl: "https://api.devnet.solana.com" }],
        defaultChain: "solana:mainnet",
        isDark: true,
        showSessionErrorAlert: false, // the Sign in button says what is wrong instead
        appearance: APPEARANCE,
      }}
    >
      <SignerBridge>
        <MoonPayUI.Provider value={UI}>{children}</MoonPayUI.Provider>
      </SignerBridge>
    </MoonXProvider>
  );
}

// Lets the trade screen sign with the MoonPay wallet (only the one the server names for a trade).
function SignerBridge({ children }: { children: ReactNode }) {
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const value = useMemo<TxSigner>(() => {
    const sol = wallets.filter((w) => w.wallet_type === "solana");
    return {
      via: "moonpay",
      addresses: sol.map((w) => w.public_address),
      sign: async (address, tx) => {
        const w = sol.find((x) => x.public_address === address);
        if (!w) throw new Error("Sign in with MoonPay to sign with your MoonPay wallet.");
        const r = await signTransaction({ transaction: tx, wallet: w, options: { uiOptions: { title: "Confirm your trade", description: "Signs the trade you just reviewed in TRADING//RUST." } } });
        return r.signedTransaction;
      },
    };
  }, [wallets, signTransaction]);
  return <MoonPaySigner.Provider value={value}>{children}</MoonPaySigner.Provider>;
}

const cancelled = (e: any) => /user_cancelled|cancel|closed/i.test(`${e?.code ?? ""} ${e?.message ?? e}`);

function MoonPayAccountButton({ notify, onChange, state }: AccountButtonProps) {
  const mx = useMoonX();
  const { ready, isAuthenticated, sessionError } = mx;
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = still checking
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<{ email: string | null; firstName: string; lastName: string } | null>(null);
  const linking = useRef(false);
  const synced = useRef("");
  const asked = useRef(false); // they pressed Sign in / Connect: say what went wrong
  const mounted = useRef(Date.now());
  const declined = useRef(false); // they closed the account setup: don't link again until MoonPay has signed them out
  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  // MoonPay's two tokens for the server, once the person's Solana wallet exists (MoonPay makes it at
  // sign-up; this only makes sure, for someone whose sign-up was cut short).
  const tokens = async () => {
    await mx.findOrCreateWallet("solana").catch(() => null);
    const t = await mx.getSessionTokens();
    if (!t) throw new Error("Your sign-in expired. Please sign in again.");
    return { accessToken: t.accessToken, identityToken: t.identityToken };
  };
  const link = async () => {
    if (linking.current) return;
    linking.current = true;
    try {
      const r = await api.moonpayLogin(await tokens());
      if (r.needsProfile) setSetup({ email: r.email ?? null, firstName: r.firstName ?? "", lastName: r.lastName ?? "" });
      else if (r.user) {
        synced.current = r.user.username; // signing in puts the wallet on file already
        setUser(r.user);
        onChange();
        window.dispatchEvent(new Event(MOONPAY_WALLET_EVENT));
        notify(`Welcome, ${r.user.firstName}! Your account and wallet are ready.`);
      }
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      linking.current = false;
    }
  };
  // Signed in to the app (from before) and to MoonPay, but no MoonPay wallet on file yet: put it on file.
  const sync = async (loud: boolean) => {
    try {
      const v = await api.moonWallet();
      if (v.wallet || !v.wallets.on) return;
      await api.moonpayWalletSync(await tokens());
      window.dispatchEvent(new Event(MOONPAY_WALLET_EVENT));
      notify("Your wallet is connected.");
    } catch (e: any) {
      if (loud) notify(e.message, true);
    }
  };
  const start = async () => {
    if (!ready) {
      // MoonPay's kit starts in a secure frame of MoonPay's. If it can't (MoonPay down, or this
      // website not on the app's allowed list in MoonPay's dashboard), it waits: say so.
      if (sessionError) {
        notify(`MoonPay's sign-in is not available right now (${sessionError.message}). Trying again…`, true);
        mx.retrySession();
      } else notify(Date.now() - mounted.current > 15_000 ? "MoonPay's sign-in did not start. Reload the page; if it keeps happening, MoonPay may be down." : "MoonPay's sign-in is still starting. Try again in a moment.", true);
      return;
    }
    if (isAuthenticated) return void (user ? sync(true) : link());
    asked.current = true;
    declined.current = false;
    try {
      // No walletChainType here: in start() MoonPay's kit reads it as "sign in with an outside
      // wallet" and hides its email / Google / Apple window (nothing showed at all). The Solana
      // wallet is still MoonPay's own, made at sign-up (the provider's walletChainType above).
      await mx.start({ loginMethods: METHODS });
    } catch (e: any) {
      if (!cancelled(e)) notify(`MoonPay sign-in failed: ${e?.message ?? e}`, true);
    }
    // Once MoonPay has signed them in, the effects below link the account (or connect the wallet).
  };

  useEffect(() => {
    const onAsk = () => void start();
    window.addEventListener(SIGNIN_EVENT, onAsk);
    return () => window.removeEventListener(SIGNIN_EVENT, onAsk);
  }); // re-subscribes each render so it uses the latest state
  useEffect(() => {
    if (!ready || !sessionStorage.getItem(SIGNIN_PENDING)) return;
    sessionStorage.removeItem(SIGNIN_PENDING);
    if (!isAuthenticated) void start();
  }, [ready, isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps
  // Signed in to MoonPay but not to the app yet: link the two.
  useEffect(() => {
    if (!isAuthenticated) declined.current = false;
    if (ready && isAuthenticated && user === null && !setup && !declined.current) void link();
  }, [ready, isAuthenticated, user, setup]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ready || !isAuthenticated || !user || synced.current === user.username) return;
    synced.current = user.username;
    void sync(asked.current);
    asked.current = false;
  }, [ready, isAuthenticated, user?.username]); // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = async () => {
    await api.signOut().catch(() => {});
    await mx.logout().catch(() => {});
    synced.current = "";
    setUser(null);
    setOpen(false);
    onChange();
    notify("Signed out. Your paper account is hidden until you sign in again.");
  };
  if (user === undefined) return <span className="avatar-slot" />;
  return (
    <>
      {user ? (
        <button className="avatar-btn" onClick={() => setOpen(true)} data-tip="Profile" aria-label={`Profile: ${user.firstName} ${user.lastName}`}>
          <Avatar user={user} size={34} />
        </button>
      ) : (
        <button className="btn ghost signin-btn" onClick={() => void start()}>Sign in</button>
      )}
      {setup && (
        <SetupProfileModal
          initial={setup}
          walletNote="Your wallet is already made: it is yours, kept safe with this sign-in."
          onClose={() => { declined.current = true; setSetup(null); void mx.logout().catch(() => {}); }}
          onDone={(u) => {
            setSetup(null);
            synced.current = u.username;
            setUser(u);
            onChange();
            window.dispatchEvent(new Event(MOONPAY_WALLET_EVENT));
            notify(`Welcome, ${u.firstName}! Your account and wallet are ready.`);
          }}
          complete={async (f) => api.moonpayComplete({ ...(await tokens()), ...f })}
        />
      )}
      {open && user && <ProfileModal user={user} state={state} notify={notify} onClose={() => setOpen(false)} onSignedOut={() => void signOut()} signOutOverride={signOut} />}
    </>
  );
}
