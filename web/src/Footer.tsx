import { useEffect, useState } from "react";

const LAST_UPDATED = "11 November 2026";
// Where people send privacy requests and complaints (PIPEDA: a named, reachable contact).
// Set this to the real mailbox before launch; until then the policy says it's being set up.
const PRIVACY_EMAIL = "testing@tradeairust.com";

// Footer: a short risk reminder on the left; version, User guide, Privacy Policy and Terms on the right.
// The Privacy Policy also opens at #privacy (shareable link).
// The Payment Terms (paid plans and AI token packs), a document of their own: they open at
// #payment-terms (also the older #subscription-terms), from the footer, the Plans window and the
// checkout form (in a new tab).
export const SUBSCRIPTION_TERMS_VERSION = "2026-11-27.2"; // (the server's billing.ts TERMS_VERSION)
export const openSubscriptionTerms = () => {
  window.location.hash = "payment-terms";
};
const isPaymentTerms = () => window.location.hash === "#payment-terms" || window.location.hash === "#subscription-terms";
// Who runs the app (the owner, 2026-11-27).
const OPERATOR = "2607521 Alberta Inc.";
export function Footer() {
  const [subTerms, setSubTerms] = useState(isPaymentTerms);
  const [open, setOpen] = useState(() => window.location.hash === "#terms");
  const [privacy, setPrivacy] = useState(() => window.location.hash === "#privacy");
  useEffect(() => {
    const on = () => {
      if (window.location.hash === "#privacy") setPrivacy(true);
      if (window.location.hash === "#terms") setOpen(true);
      if (isPaymentTerms()) setSubTerms(true);
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
            Payment Terms
          </button>
        </span>
      </footer>
      {open && <TermsModal onClose={() => { setOpen(false); if (window.location.hash === "#terms") history.replaceState(null, "", window.location.pathname + window.location.search); }} onPrivacy={() => { setOpen(false); setPrivacy(true); }} />}
      {privacy && <PrivacyModal onClose={closePrivacy} />}
      {subTerms && <SubscriptionTermsModal onClose={() => { setSubTerms(false); if (isPaymentTerms()) history.replaceState(null, "", window.location.pathname + window.location.search); }} />}
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
          <p>TRADING//RUST is operated by {OPERATOR}, a corporation in Alberta, Canada ("we", "us", "our"). It is an experimental crypto trading app. It shows market data, asks an AI model for trading plans, runs bots that follow those plans on a practice ("paper") account, and lets you trade real crypto from your own Solana wallet. By creating an account or using the app you agree to these terms. You must be at least 18 and allowed to trade crypto where you live.</p>

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
          <p>Plans (Free, Starter, AI Pro, AI Max) decide which features you can use, how many AI tokens you get each month and the platform fee on trades. Paying for a plan or an AI token pack is covered by our separate Payment Terms. AI use is metered in app tokens; unused monthly tokens don't carry over, while top-up tokens don't expire. Prices, allowances, fees and features may change; we'll show changes in the app before they apply to you.</p>

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

// Payment Terms: what a customer agrees to when they pay for a plan or a token pack. Written to be
// plain and complete; have them reviewed by a lawyer before taking real payments.
function SubscriptionTermsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const contact = PRIVACY_EMAIL ? <a className="link" href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a> : <b>the contact address in our Privacy Policy</b>;
  return (
    <div className="modal-backdrop on-top">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="subterms-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="subterms-title">Payment Terms</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>
        <div className="modal-body">
          <p className="muted small">Version {SUBSCRIPTION_TERMS_VERSION}</p>
          <p>These Payment Terms apply whenever you buy a paid plan or an AI token pack on Trading//Rust. Trading//Rust is operated by <b>{OPERATOR}</b>, a corporation in Alberta, Canada ("we", "us", "our"). These terms form part of, and add to, our Terms &amp; Conditions and our Privacy Policy. By ticking "I agree" or by paying, you accept them. If you don't agree, please don't buy.</p>

          <h3>1. Who you are paying</h3>
          <p>You buy from {OPERATOR}, the operator of Trading//Rust. Payments are processed for us by Stripe, our payment processor, under <a className="link" href="https://stripe.com/legal/consumer" target="_blank" rel="noopener noreferrer">Stripe's own terms</a>. Card details are entered into Stripe's secure fields and are never stored by us. Your card statement may show our company name or "Trading//Rust".</p>

          <h3>2. What you are buying</h3>
          <p>A plan or a token pack buys access to features of our software, and AI tokens to use them, for as long as described here. It is not an investment, it does not buy, hold or move any crypto or money for you, and it never guarantees any trading result. The AI's plans, win chances and the bots' actions are estimates and automation, not financial, investment, legal or tax advice. Trading crypto can lose all of the money you trade; see our Terms &amp; Conditions.</p>

          <h3>3. Prices, currency and taxes</h3>
          <p>Prices are shown in US dollars before tax: Starter $19 a month or $209 a year, AI Pro $59 a month or $649 a year, AI Max $149 a month or $1,639 a year (a year costs 11 months), and AI token packs of $20 (2 million tokens), $50 (5 million) and $100 (10 million). Your card issuer may convert the charge into your currency and add its own fees; those are between you and your issuer.</p>
          <p>Sales taxes are added on top of the price where we are required to collect them, based on the billing address you give at checkout (in Canada, for example, GST, HST, PST or QST depending on your province). The checkout shows each tax and the total before you pay. You must give an accurate billing address; you are responsible for any tax that is due because an address you gave was wrong.</p>

          <h3>4. Your authorization to charge</h3>
          <p>When you subscribe, you authorize {OPERATOR}, through Stripe, to charge the payment method you give (a) the plan's price and any tax shown, at once, and (b) the same amounts at the start of each new billing period, monthly or yearly as you chose, until you cancel. For a token pack you authorize one charge. You confirm that you are allowed to use the payment method, and you agree to keep its details current (you can update them under Manage billing).</p>

          <h3>5. Billing periods and automatic renewal</h3>
          <p>A subscription starts when your first payment goes through and renews automatically at the end of each month or year until you cancel. We will tell you before any change of price applies to your next renewal, so you can cancel first.</p>

          <h3>6. Changing plan</h3>
          <p>An upgrade starts at once; your payment method is charged the difference for the rest of the current billing period. A downgrade starts at your next renewal; until then you keep the plan you paid for. If the new plan includes fewer AI agents than you are running, the extra agents are stopped, and features the new plan does not include stop working.</p>

          <h3>7. Cancelling</h3>
          <p>You can cancel at any time in the Plans window or under Manage billing. Your plan stays until the end of the period you have already paid for, and then your account returns to the Free plan. Nothing more is charged after you cancel. Cancelling does not refund the current period (see section 10).</p>

          <h3>8. Failed or late payments</h3>
          <p>If a renewal payment does not go through, Stripe may try your payment method again over the following days, and we may remind you. Meanwhile your plan continues, but its monthly AI allowance does not start again until the payment goes through. If the payment still cannot be collected, the subscription ends and your account returns to the Free plan. Amounts that were due remain due.</p>

          <h3>9. AI tokens</h3>
          <p>AI tokens are Trading//Rust's unit of AI use. A paid plan's monthly allowance starts again only while the plan is being paid for: for a monthly plan, when its renewal is paid; for a yearly plan, each month of the year paid for. If you cancel the renewal, or a payment does not go through, the allowance does not start again, and you can use what is left until the plan ends. Unused allowance does not carry over. Tokens from a pack are used after the monthly allowance runs out and do not expire while your account is open. Tokens have no cash value, cannot be transferred, sold or exchanged, and can only be used in Trading//Rust. How many tokens a request uses depends on the request and the AI model, and may change.</p>

          <h3>10. Refunds</h3>
          <p>Because plans and tokens are digital services you can use right away, payments are final and are not refunded, including for unused time or tokens, except where the law requires a refund, or where we choose to give one (for example, if you were charged twice by mistake). Tokens from a pack cannot be refunded once used. If you believe a charge is wrong, contact us within 60 days of it at {contact}, and we will look into it promptly.</p>

          <h3>11. Disputes and chargebacks</h3>
          <p>Please contact us before disputing a charge with your bank; most problems can be fixed quickly. If a charge is disputed, we may pause paid features on your account until the dispute is resolved. If a dispute is decided in your favour, the plan or tokens paid for by that charge end. Filing a dispute for a charge you authorized is a breach of these terms.</p>

          <h3>12. Promotions</h3>
          <p>From time to time we may offer promotion codes or discounts. Each offer's conditions are shown with it; an offer cannot be combined with another unless it says so, has no cash value, and may end at any time.</p>

          <h3>13. Changes to plans and prices</h3>
          <p>We may change prices, plans, AI allowances and features. A price change for a subscription applies from your next renewal after we tell you about it; if you don't agree, cancel before then.</p>

          <h3>14. Suspension and closing accounts</h3>
          <p>We may suspend or close an account that breaks these terms or our Terms &amp; Conditions, is used for fraud or unlawful activity, or whose payments are reversed. If we close your account for such a reason, unused periods and tokens are not refunded, except where the law requires it. If we stop offering Trading//Rust altogether, we will refund the unused part of any period you paid for in advance.</p>

          <h3>15. Our liability</h3>
          <p>To the fullest extent the law allows, our total liability to you for anything related to your payments and plans is limited to the amount you paid us in the 12 months before the claim, and we are not liable for indirect or consequential losses, including any trading losses or missed gains. Nothing in these terms limits rights you have under consumer protection laws that cannot be limited or waived.</p>

          <h3>16. Governing law</h3>
          <p>These terms are governed by the laws of the Province of Alberta and the federal laws of Canada that apply there, and the courts of Alberta have jurisdiction, except where the consumer protection laws of the place you live give you the right to other laws or courts.</p>

          <h3>17. Changes to these terms</h3>
          <p>We may update these terms. The version number above changes when we do, and you will be asked to accept the new version before your next purchase. A change that affects an existing subscription applies from your next renewal after we tell you, and you can cancel before then.</p>

          <h3>18. Contact</h3>
          <p>For questions about billing or these terms, contact {OPERATOR}, operator of Trading//Rust, at {contact}.</p>
        </div>
      </div>
    </div>
  );
}
