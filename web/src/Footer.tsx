import { useEffect, useState } from "react";

const LAST_UPDATED = "10 November 2026";

// Footer: a short risk reminder on the left; version and Terms & Conditions on the right.
export function Footer() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <footer className="footer">
        <span className="muted">Paper trading only · Not financial advice</span>
        <span className="footer-right">
          <span className="mono muted" title={__APP_COMMIT__ ? `Build ${__APP_COMMIT__}` : undefined}>
            v{__APP_VERSION__}
            {__APP_COMMIT__ ? ` (${__APP_COMMIT__})` : ""}
          </span>
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="terms-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="terms-title">Terms &amp; Conditions</h2>
          <button className="chip" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="muted small">Last updated {LAST_UPDATED}</p>

          <h3>1. What this app is</h3>
          <p>NEXUS//TRADE is an experimental tool that shows crypto market data, asks an AI model for trading plans, and runs a bot that follows those plans. By using it you agree to these terms.</p>

          <h3>2. Paper trading only</h3>
          <p>All trades in this app are simulated ("paper trading"). No real money or crypto is bought, sold or held. Simulated fees and slippage are estimates; real results would differ.</p>

          <h3>3. Not financial advice</h3>
          <p>Nothing in this app is financial, investment, tax or legal advice. AI plans, signals, "buy zone" labels and targets are automated estimates that can be wrong. Make your own decisions, and talk to a licensed professional if you need advice.</p>

          <h3>4. Risk</h3>
          <p>Crypto, especially small "memecoin" tokens, is extremely risky. Prices can drop to zero within minutes, tokens can be scams ("rug pulls"), and stop-losses may sell well below their set price in fast markets. Past or simulated performance does not predict future results. Never trade money you can't afford to lose.</p>

          <h3>5. Data and AI</h3>
          <p>Prices and charts come from third-party sources (such as CoinMarketCap, GeckoTerminal, DexScreener, Coinbase and OKX) and may be delayed, incomplete or wrong. AI responses come from a third-party AI model and may contain errors. The app may be unavailable or behave unexpectedly.</p>

          <h3>6. Costs</h3>
          <p>Using the AI features calls paid APIs on the account whose keys are configured. You are responsible for those costs and for any limits you set with the providers.</p>

          <h3>7. No warranty, limited liability</h3>
          <p>The app is provided "as is", without warranties of any kind. To the fullest extent allowed by law, its authors are not liable for any losses or damages arising from its use, including any decision you make based on it.</p>

          <h3>8. Changes</h3>
          <p>These terms may change as the app changes. The date above shows the latest version.</p>
        </div>
      </div>
    </div>
  );
}
