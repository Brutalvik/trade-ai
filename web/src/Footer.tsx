import { useEffect, useState } from "react";

const LAST_UPDATED = "11 November 2026";

// Footer: a short risk reminder on the left; version and Terms & Conditions on the right.
export function Footer() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <footer className="footer">
        <span className="muted">Paper and real trading · Not financial advice</span>
        <span className="footer-right">
          <span className="mono muted" title={__APP_COMMIT__ ? `Build ${__APP_COMMIT__}` : undefined}>
            v{__APP_VERSION__}
            {__APP_COMMIT__ ? ` (${__APP_COMMIT__})` : ""}
          </span>
          <a className="link" href="#rules">Trading rules</a>
          <button className="link" onClick={() => setOpen(true)}>
            Terms &amp; Conditions
          </button>
        </span>
      </footer>
      {open && <TermsModal onClose={() => setOpen(false)} />}
    </>
  );
}

function TermsModal({ onClose }: { onClose: () => void }) {
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
          <p>You sign in with an email code or Google (through Privy) or with a username and password. One account per person. Your username can't be changed. Keep your sign-in secure: you are responsible for everything done from your account. Every account has its own paper account, bots, trades and history.</p>

          <h3>3. Paper trading</h3>
          <p>The paper account uses practice money. Nothing is bought or sold for real. Fees and slippage are simulated from the settings you choose, so real results would differ, often for the worse.</p>

          <h3>4. Real trading from your own wallet</h3>
          <ul>
            <li><b>Your wallet, your keys.</b> Your Solana wallet is created and secured by Privy. We never hold your keys or your funds, and we can't move them. You can export your keys from Privy.</li>
            <li><b>You approve every real trade.</b> Each one is a swap routed by Jupiter that you review and sign yourself. Once signed and confirmed on the blockchain it can't be reversed.</li>
            <li><b>Prices move.</b> What you receive can differ from the quote within the slippage shown, and network fees apply. A swap can fail; failed swaps don't move your funds but may cost a network fee.</li>
            <li><b>Solana only.</b> Real trading supports Solana tokens. Coins on other chains are paper-only. Sending funds from another network to your wallet can lose them.</li>
            <li><b>Limits.</b> While real trading is new, each real trade is capped (currently $100). The bots don't trade real money yet.</li>
          </ul>

          <h3>5. AI plans and the bots</h3>
          <p>AI plans, win chances, targets, "Buy zone" labels and scores are automated estimates that are often wrong. The bots act automatically on your paper account according to your settings: they buy, sell and stop without asking you. Your plan sets how many bots can run at once. A coin you buy by hand can be handed to a bot, and selling a bot's coin yourself stops that bot. The full rules are on the Trading rules page.</p>

          <h3>6. Your settings and recorded consent</h3>
          <p>Some choices remove protections: risky mode, lifting the daily loss limit, turning off a safety setting (such as the emergency stop, profit guard or cool-down) or the 1.5× reward rule. Each needs you to confirm "I understand". We record each confirmation as proof of your choice: the setting, the warning shown, which bot, the time, and your IP address and browser. You accept the results of the settings you choose.</p>

          <h3>7. Not financial advice</h3>
          <p>Nothing in this app is financial, investment, tax or legal advice. Make your own decisions, and talk to a licensed professional if you need advice.</p>

          <h3>8. Risk</h3>
          <p>Crypto, and small "memecoin" tokens above all, is extremely risky. Prices can fall to zero within minutes, tokens can be scams ("rug pulls"), and stop-losses can sell well below their price in fast markets. Past or simulated results don't predict future results. Never trade money you can't afford to lose.</p>

          <h3>9. Plans, AI tokens and fees</h3>
          <p>Plans (Free, Member, AI Starter, AI Pro, AI Max) decide which features you can use, how many AI tokens you get each month and the platform fee on trades. AI use is metered in app tokens; unused monthly tokens don't carry over, while top-up tokens don't expire. Prices, allowances, fees and features may change; we'll show changes in the app before they apply to you.</p>

          <h3>10. Data we keep</h3>
          <p>We keep your account details (name, username, email), your wallet address, your trades, bot logs and activity history (sign-ins, bot starts and stops, setting changes and consents), and your IP address and browser for sign-ins and consents. This lets your account work across devices and serves as a record of what happened. It's stored with our hosting providers. Chart drawings and display preferences stay in your browser. We don't sell your data.</p>

          <h3>11. Third-party services</h3>
          <p>The app relies on other services, each with its own terms: Privy (sign-in and wallets), Jupiter (swaps), the Solana network and RPC providers such as Helius (balances and transactions), CoinGecko, DexScreener, GeckoTerminal and CoinMarketCap (prices and charts), Anthropic (AI), and Vercel and Upstash (hosting and storage). Their data can be delayed, incomplete or wrong, and they can be unavailable.</p>

          <h3>12. Fair use</h3>
          <p>Don't misuse the app: no attacks, scraping or automated abuse of our services, no use for anything illegal, and no use where crypto trading is prohibited or by sanctioned persons. We may suspend accounts that break these terms.</p>

          <h3>13. No warranty, limited liability</h3>
          <p>The app is provided "as is", without warranties of any kind. To the fullest extent allowed by law, its operators are not liable for any losses or damages from using it, including trading losses, bot actions, failed or delayed transactions, wrong data or AI errors, or decisions you make based on it.</p>

          <h3>14. Changes</h3>
          <p>These terms change as the app changes. The date above shows the latest version, and continuing to use the app means you accept it.</p>
        </div>
      </div>
    </div>
  );
}
