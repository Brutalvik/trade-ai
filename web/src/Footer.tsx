import { useEffect, useState } from "react";

const LAST_UPDATED = "11 November 2026";
// Where people send privacy requests and complaints (PIPEDA: a named, reachable contact).
// Set this to the real mailbox before launch; until then the policy says it's being set up.
const PRIVACY_EMAIL = "testing@tradeairust.com";

// Footer: a short risk reminder on the left; version, User guide, Privacy Policy and Terms on the right.
// The Privacy Policy also opens at #privacy (shareable link).
// The Subscription Terms (paid plans and AI token packs), a document of their own: they open at
// #subscription-terms, from the footer or from the Plans window before paying.
export const SUBSCRIPTION_TERMS_VERSION = "2026-11-27"; // (the server's billing.ts TERMS_VERSION)
export const openSubscriptionTerms = () => {
  window.location.hash = "subscription-terms";
};
export function Footer() {
  const [subTerms, setSubTerms] = useState(() => window.location.hash === "#subscription-terms");
  const [open, setOpen] = useState(() => window.location.hash === "#terms");
  const [privacy, setPrivacy] = useState(() => window.location.hash === "#privacy");
  useEffect(() => {
    const on = () => {
      if (window.location.hash === "#privacy") setPrivacy(true);
      if (window.location.hash === "#terms") setOpen(true);
      if (window.location.hash === "#subscription-terms") setSubTerms(true);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const closePrivacy = () => {
    setPrivacy(false);
    if (window.location.hash === "#privacy") history.replaceState(null, "", window.location.pathname + window.location.search);
  };
  return (
    <>
      <footer className="footer">
        <span className="muted">Paper and real trading · Not financial advice</span>
        <span className="footer-right">
          <span className="mono muted" title={__APP_COMMIT__ ? `Build ${__APP_COMMIT__}` : undefined}>
            v{__APP_VERSION__}
            {__APP_COMMIT__ ? ` (${__APP_COMMIT__})` : ""}
          </span>
          <a className="link" href="#guide">User guide</a>
          <button className="link" onClick={() => setPrivacy(true)}>
            Privacy Policy
          </button>
          <button className="link" onClick={() => setOpen(true)}>
            Terms &amp; Conditions
          </button>
          <button className="link" onClick={() => setSubTerms(true)}>
            Subscription Terms
          </button>
        </span>
      </footer>
      {open && <TermsModal onClose={() => { setOpen(false); if (window.location.hash === "#terms") history.replaceState(null, "", window.location.pathname + window.location.search); }} onPrivacy={() => { setOpen(false); setPrivacy(true); }} />}
      {privacy && <PrivacyModal onClose={closePrivacy} />}
      {subTerms && <SubscriptionTermsModal onClose={() => { setSubTerms(false); if (window.location.hash === "#subscription-terms") history.replaceState(null, "", window.location.pathname + window.location.search); }} />}
    </>
  );
}

function TermsModal({ onClose, onPrivacy }: { onClose: () => void; onPrivacy: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="terms-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="terms-title">Terms &amp; Conditions</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="muted small">Last updated {LAST_UPDATED}</p>

          <h3>1. What this app is</h3>
          <p>TRADING//RUST is an experimental crypto trading app. It shows market data, asks an AI model for trading plans, runs bots that follow those plans on a practice ("paper") account, and lets you trade real crypto from your own Solana wallet. By creating an account or using the app you agree to these terms. You must be at least 18 and allowed to trade crypto where you live.</p>

          <h3>2. Your account</h3>
          <p>You sign in through MoonPay, with a code sent to your email, Google or Apple. One account per person. Your username can't be changed. Keep your sign-in secure: you are responsible for everything done from your account. Every account has its own paper account, bots, trades and history.</p>

          <h3>3. Paper trading</h3>
          <p>The paper account uses practice money. Nothing is bought or sold for real. Fees and slippage are simulated from the settings you choose, so real results would differ, often for the worse.</p>

          <h3>4. Real trading from your own wallet</h3>
          <ul>
            <li><b>Your wallet, your keys.</b> Your Solana wallet is made for you by MoonPay when you sign up and is secured by MoonPay with your sign-in. We never hold your keys or your funds, and we can't move them: every transaction from it is approved by you.</li>
            <li><b>You approve every real trade.</b> Each one is a swap routed by Jupiter that you review and sign yourself. Once signed and confirmed on the blockchain it can't be reversed.</li>
            <li><b>Prices move.</b> What you receive can differ from the quote within the slippage shown, and network fees apply. A swap can fail; failed swaps don't move your funds but may cost a network fee.</li>
            <li><b>Solana only.</b> Real trading supports Solana tokens. Coins on other chains are paper-only. Sending funds from another network to your wallet can lose them.</li>
            <li><b>Limits.</b> While real trading is new, each real trade is capped (currently $100). The bots trade real money only through the Real mode auto-pilot, after you allow it, within limits you set (per trade, per day, and a daily loss that pauses it); it can lose money.</li>
          </ul>

          <h3>5. AI plans and the bots</h3>
          <p>AI plans, win chances, targets, momentum labels (Hot / Mixed / Cold) and scores are automated estimates that are often wrong. The bots act automatically on your paper account according to your settings: they buy, sell and stop without asking you. Your plan sets how many bots can run at once. A coin you buy by hand can be handed to a bot, and selling a bot's coin yourself stops that bot. How everything works is in the User guide.</p>

          <h3>6. Your settings and recorded consent</h3>
          <p>Some choices remove protections: risky mode, lifting the daily loss limit, turning off a safety setting (such as the emergency stop, profit guard or cool-down) or the 1.5× reward rule. Each needs you to confirm "I understand". We record each confirmation as proof of your choice: the setting, the warning shown, which bot, the time, and your IP address and browser. You accept the results of the settings you choose.</p>

          <h3>7. Not financial advice</h3>
          <p>Nothing in this app is financial, investment, tax or legal advice. Make your own decisions, and talk to a licensed professional if you need advice.</p>

          <h3>8. Trading is entirely at your own risk</h3>
          <p><b>All trading in this app, paper or real, by you or by a bot you start, is at your own risk. You alone are responsible for your trading decisions and their results. We are not responsible for any losses, missed gains or other harm from trading,</b> including losses from AI plans or win chances, bot actions (buying, selling, holding past a stop-loss after an AI second look, or stopping), settings you choose or turn off, delayed or wrong prices, failed, delayed or reversed transactions, outages, or the behaviour of any coin or third-party service.</p>
          <p>Crypto, and small "memecoin" tokens above all, is extremely risky. Prices can fall to zero within minutes, tokens can be scams ("rug pulls"), and stop-losses can sell well below their price in fast markets. Past or simulated results don't predict future results. Never trade money you can't afford to lose.</p>

          <h3>9. Plans, AI tokens and fees</h3>
          <p>Plans (Free, Starter, AI Pro, AI Max) decide which features you can use, how many AI tokens you get each month and the platform fee on trades. Paying for a plan or an AI token pack is covered by our separate Subscription Terms. AI use is metered in app tokens; unused monthly tokens don't carry over, while top-up tokens don't expire. Prices, allowances, fees and features may change; we'll show changes in the app before they apply to you.</p>

          <h3>10. Your personal information</h3>
          <p>How we collect, use, share and protect your personal information, and your rights over it, is set out in our <button className="link" onClick={onPrivacy}>Privacy Policy</button>, which is part of these terms. We don't sell your data.</p>

          <h3>11. Third-party services</h3>
          <p>The app relies on other services, each with its own terms: MoonPay (sign-in, wallets and buying crypto), Jupiter (swaps), the Solana network and RPC providers such as Helius (balances and transactions), CoinGecko, DexScreener, GeckoTerminal and CoinMarketCap (prices and charts), Anthropic (AI), and Vercel and Supabase (hosting and storage). Their data can be delayed, incomplete or wrong, and they can be unavailable.</p>

          <h3>12. Fair use</h3>
          <p>Don't misuse the app: no attacks, scraping or automated abuse of our services, no use for anything illegal, and no use where crypto trading is prohibited or by sanctioned persons. We may suspend accounts that break these terms.</p>

          <h3>13. No warranty, limited liability</h3>
          <p>The app is provided "as is" and "as available", without warranties of any kind, express or implied, including fitness for a particular purpose or that it will be accurate, uninterrupted or error-free. To the fullest extent allowed by law, its operators, owners and suppliers are not liable for any direct, indirect, incidental or consequential losses or damages from using or being unable to use it, including trading losses, lost profits, bot actions, failed or delayed transactions, wrong data or AI errors, or decisions you make based on it. Where the law doesn't allow a liability to be excluded, it is limited to the amount you paid us in the 3 months before the claim. You agree to indemnify us against claims arising from your use of the app or your breach of these terms.</p>

          <h3>14. Changes</h3>
          <p>These terms change as the app changes. The date above shows the latest version, and continuing to use the app means you accept it.</p>

          <h3>15. Governing law</h3>
          <p>These terms are governed by the laws of Canada and of the province in which you live, without affecting any consumer protection rights you have under your provincial law.</p>
        </div>
      </div>
    </div>
  );
}

// Privacy Policy, written for Canadian privacy law: PIPEDA (federal), plus the provincial laws
// that apply in Quebec (Law 25), Alberta and British Columbia (PIPA).
function PrivacyModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const contact = PRIVACY_EMAIL ? <a className="link" href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a> : <b>our Privacy Officer (contact email being set up; it will be posted here)</b>;

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="privacy-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="privacy-title">Privacy Policy</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>
        <div className="modal-body">
          <p className="muted small">Last updated {LAST_UPDATED}</p>
          <p>This policy explains how TRADING//RUST ("we") collects, uses, shares and protects your personal information, following Canada's <i>Personal Information Protection and Electronic Documents Act</i> (PIPEDA) and, where they apply, Quebec's <i>Act respecting the protection of personal information in the private sector</i> (Law 25) and the Personal Information Protection Acts of Alberta and British Columbia.</p>

          <h3>1. Accountability</h3>
          <p>We are responsible for the personal information we control, including information handled for us by our service providers. Our Privacy Officer oversees this policy and answers questions, requests and complaints: {contact}.</p>

          <h3>2. What we collect</h3>
          <ul>
            <li><b>Account details</b>: first and last name, username, email address, and a securely hashed password (only for accounts made with one before sign-in moved to MoonPay). When you sign in, MoonPay confirms your email for us.</li>
            <li><b>Wallet information</b>: your Solana wallet's public address (made by MoonPay). We never receive or store your private keys.</li>
            <li><b>Trading and app activity</b>: your paper account, positions, trades, orders, bot settings and logs, AI analyses and token use, real-trade records (amounts, tokens and transaction signatures), and your plan.</li>
            <li><b>Activity and consent records</b>: sign-ins, setting changes, bot starts and stops, and each "I understand" you confirm, with the warning shown, the time, your IP address and your browser type.</li>
            <li><b>Stored on your device</b>: display preferences, chart drawings and cached chart data are kept in your browser's local storage, not on our servers. We don't use advertising or tracking cookies, and we don't use analytics trackers.</li>
          </ul>

          <h3>3. Why we use it</h3>
          <ul>
            <li>To create and secure your account and sign you in.</li>
            <li>To run the features you use: paper trading, bots, AI plans, real trades from your wallet, exports and history.</li>
            <li>To meter AI tokens and apply your plan's features and charges.</li>
            <li>To keep a record of your choices and consents and of what happened in your account, for your reference, support and resolving disputes.</li>
            <li>To protect the service against misuse, and to meet legal obligations.</li>
          </ul>
          <p>We use your information only for these purposes, or for new purposes you agree to. We don't sell it, rent it or use it for advertising.</p>

          <h3>4. Consent</h3>
          <p>By creating an account you consent to the collection and use described here. Some features ask for express consent first (for example switching to Real mode or turning off a safety setting). You can withdraw consent at any time, subject to legal or contractual limits, by closing your account or contacting us; some features may then stop working.</p>

          <h3>5. Who we share it with</h3>
          <p>We share personal information only with service providers that help run the app, and only what each needs:</p>
          <ul>
            <li><b>MoonPay</b>: sign-in, your wallet, and buying crypto. When you buy, MoonPay receives the amount, your wallet address and our reference for your account; it takes the payment and checks your identity under its own terms and privacy policy.</li>
            <li><b>Vercel</b> (hosting) and <b>Supabase</b> (database storage).</li>
            <li><b>Anthropic</b> (AI): coin market data and anonymous statistics about your bot's past trades are sent to create AI plans. Your name, email and username are not sent.</li>
            <li><b>Jupiter</b>, <b>Helius</b> and the <b>Solana network</b>: your wallet address and the trades you sign. Transactions on the blockchain are public and permanent by design.</li>
            <li><b>Operations alerts</b>: brief notices of bot trades may be sent to our team's alert channel (Telegram or ntfy) to monitor the service.</li>
          </ul>
          <p>Market data providers (CoinGecko, DexScreener, GeckoTerminal, CoinMarketCap) receive no personal information about you. We may also disclose information when required by law, or to protect the rights and safety of users or the service.</p>

          <h3>6. Storage outside Canada</h3>
          <p>Our service providers store and process information outside Canada, mainly in the United States. While there it is protected by our agreements with them, but it may be accessible to courts, law enforcement and national security authorities of those countries. For Quebec residents, we have assessed that these transfers give your information adequate protection.</p>

          <h3>7. How long we keep it</h3>
          <p>We keep your information while your account is open. If you ask us to close your account, we delete or anonymize your personal information within 90 days, except records we need to keep for legal, tax or dispute reasons (such as consent records and transaction history), which we keep for up to 7 years and then delete. Information already recorded on a public blockchain can't be deleted by anyone.</p>

          <h3>8. How we protect it</h3>
          <p>We use safeguards suited to its sensitivity: encrypted connections (HTTPS), hashed passwords, access limited to staff who need it, and providers with recognised security practices. Your wallet's keys are secured by MoonPay with your sign-in; we never hold them. No system is perfectly secure; if a breach creates a real risk of significant harm, we will notify you and the Privacy Commissioner of Canada (and Quebec's Commission d'accès à l'information where required) as the law requires, and keep a record of it.</p>

          <h3>9. Your rights</h3>
          <ul>
            <li><b>Access</b>: ask what personal information we hold about you and how it was used and shared. Much of it is already in your profile and activity history, and your trades can be downloaded as CSV.</li>
            <li><b>Correction</b>: ask us to correct inaccurate information. You can update your name and email in your profile.</li>
            <li><b>Withdrawal and deletion</b>: withdraw consent or ask us to close your account and delete your information (see section 7).</li>
            <li><b>Quebec residents</b> also have the right to data portability, to ask that information no longer be disseminated (de-indexing), and to be told about automated decisions about them. Note: the AI and bot decisions in this app concern trades you set up, not decisions about you.</li>
          </ul>
          <p>Send requests to {contact}. We answer within 30 days and may need to confirm your identity first. Requests are free.</p>

          <h3>10. Age</h3>
          <p>The app is for adults (18 or older). We don't knowingly collect information from minors; if we learn we have, we delete it.</p>

          <h3>11. Complaints</h3>
          <p>If you're not satisfied with how we handle your information, contact our Privacy Officer first. You can also complain to the <b>Office of the Privacy Commissioner of Canada</b> (priv.gc.ca), or, depending on where you live, Quebec's <b>Commission d'accès à l'information</b>, Alberta's <b>Information and Privacy Commissioner</b> or British Columbia's <b>Information and Privacy Commissioner</b>.</p>

          <h3>12. Changes</h3>
          <p>We'll update this policy as the app changes and show the new date above. For significant changes we'll tell you in the app before they apply.</p>
        </div>
      </div>
    </div>
  );
}

// Subscription Terms: what a customer agrees to when they pay for a plan or a token pack.
function SubscriptionTermsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop on-top">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="subterms-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="subterms-title">Subscription Terms</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>
        <div className="modal-body">
          <p className="muted small">Version {SUBSCRIPTION_TERMS_VERSION}. These terms cover paid plans and AI token packs. They are separate from, and in addition to, our Terms &amp; Conditions, which still apply to everything else.</p>
          <h3>1. Plans and prices</h3>
          <p>Starter is $19 a month or $209 a year, AI Pro $59 a month or $649 a year, AI Max $149 a month or $1,639 a year (a year costs 11 months). AI token packs cost $20 (2 million tokens), $50 (5 million) and $100 (10 million). Prices are in US dollars. Where the law requires it, sales tax is added at checkout.</p>
          <h3>2. Paying</h3>
          <p>Payments are processed by Stripe on its own secure page. We never see or store your full card number. By subscribing you authorize us, through Stripe, to charge your payment method for each renewal until you cancel.</p>
          <h3>3. Automatic renewal</h3>
          <p>A subscription renews automatically at the end of each month or year, at the price shown, until you cancel. If a price changes, we will tell you before it applies to your next renewal.</p>
          <h3>4. Cancelling</h3>
          <p>You can cancel at any time in the Plans window or under Manage billing. Your plan stays until the end of the period you have paid for, then your account returns to the Free plan. Nothing more is charged after you cancel.</p>
          <h3>5. Changing plan</h3>
          <p>An upgrade starts at once, and your card is charged the difference for the rest of the current period. A downgrade starts at your next renewal; until then you keep the plan you paid for. If your plan includes fewer AI agents than you are running, the extra agents are stopped.</p>
          <h3>6. Failed payments</h3>
          <p>If a renewal payment fails, Stripe tries your card again over the following days and your plan continues meanwhile. If the payment still cannot be collected, the subscription ends and your account returns to the Free plan.</p>
          <h3>7. Refunds</h3>
          <p>Payments are not refundable, except where the law requires a refund or where we choose to give one. AI tokens from a pack cannot be refunded once used. For billing questions, contact us at the address in our Privacy Policy.</p>
          <h3>8. AI tokens</h3>
          <p>AI tokens are this app's unit of AI use. A paid plan's monthly allowance starts again only while the plan is being paid for: for a monthly plan, when its renewal is paid; for a yearly plan, each month of the year paid for. If you cancel the renewal, or a payment does not go through, the allowance does not start again, and you can use what is left until the plan ends. Unused allowance does not carry over. Tokens from a pack are used after the monthly allowance runs out, and they never expire. How many tokens an AI analysis uses depends on the request.</p>
          <h3>9. What you pay for</h3>
          <p>A plan pays for features of the software. It does not buy any trading result. Trading carries risk, and the AI's plans are estimates, not financial advice; see our Terms &amp; Conditions.</p>
          <h3>10. Changes to these terms</h3>
          <p>We may update these terms. If a change affects your subscription, we will tell you before it applies, and you can cancel before then.</p>
        </div>
      </div>
    </div>
  );
}
