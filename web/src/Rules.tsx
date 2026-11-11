// "Trading rules": every rule and condition the bot and the app follow, in one page.
// Opened from the footer (and reachable at #rules). Numbers come from the presets and
// plans, so the page stays in step with the app.
import { useEffect } from "react";
import type { PlanInfo } from "./api";

type Preset = {
  label: string;
  positionPct: number;
  riskPerTradePct: number;
  minConfidence: number;
  analyzeMin: number;
  breakEvenAtPct: number;
  lockPct: number;
  partialAtPct: number;
  trailPct: number;
  cooldownMin: number;
  dailyLossPct: number;
  maxDrop1hPct: number;
  maxDrawdownPct: number;
  riskyMinWin: number;
};

const SECTIONS = [
  ["overview", "How a trade happens"],
  ["plan", "The AI's plan"],
  ["checks", "Checks on every order"],
  ["buy", "When the bot buys"],
  ["size", "How much it buys"],
  ["sell", "When the bot sells"],
  ["after", "After a trade"],
  ["safety", "Account safety limits"],
  ["risky", "Risky mode"],
  ["autopick", "Auto-pick"],
  ["manual", "Manual trading"],
  ["costs", "Costs and charges"],
  ["plans", "Plans and AI tokens"],
  ["presets", "Preset values"],
  ["data", "Prices, data and the scheduler"],
  ["history", "What's recorded"],
  ["risk", "Important"],
] as const;

const fmtM = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`);

export function RulesPage({ presets, plans, onClose }: { presets: Record<string, Preset>; plans: PlanInfo[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  const P = Object.values(presets);
  const row = (label: string, f: (p: Preset) => string) => (
    <tr>
      <td>{label}</td>
      {P.map((p) => <td key={p.label} className="num">{f(p)}</td>)}
    </tr>
  );
  const go = (id: string) => document.getElementById(`rules-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="rules-page" role="dialog" aria-modal="true" aria-labelledby="rules-h1">
      <header className="rules-top">
        <button className="btn ghost" onClick={onClose}>← Back to trading</button>
        <h1 id="rules-h1">Trading rules</h1>
        <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
      </header>
      <div className="rules-body">
        <nav className="rules-toc" aria-label="Contents">
          <div className="label-sm">Contents</div>
          {SECTIONS.map(([id, title], i) => (
            <button key={id} onClick={() => go(id)}>{i + 1}. {title}</button>
          ))}
        </nav>

        <article className="rules-content">
          <p className="rules-lead">
            Everything the AI, the bot and the app do when you trade, in plain words. Numbers marked <i>(your setting)</i> can be changed in the
            bot panel's <b>⚙ Settings</b>; the values of each preset are in <a onClick={() => go("presets")}>Preset values</a>. This is paper
            trading: no real money moves.
          </p>

          <section id="rules-overview">
            <h2>1. How a trade happens</h2>
            <ol>
              <li><b>The AI writes a plan</b> for the coin: whether to buy, at what price, where to exit if wrong, and where to take profit.</li>
              <li><b>The app checks every order</b> in the plan against fees and risk, and against your minimum win chance. The bot only buys when the possible gain after fees is at least <b>1.5x</b> the possible loss. You can switch this rule off in Auto-pilot (<i>Gain must be 1.5× the risk</i>) to go back to the old rules, even while the bot runs.</li>
              <li><b>The bot watches the price every 5 seconds</b> and buys the moment an order's trigger is reached, if the safety rules allow it.</li>
              <li><b>It manages the trade</b> until it sells: stop-loss, break-even, profit lock, taking half early, a trailing stop past the target, and a time limit.</li>
              <li><b>Buy by hand, let the bot sell</b>: start a bot on a coin you hold and it takes over that position (exit 8% below the price unless you set one, target +16%, then its profit lock and trailing stop). <b>Selling a bot's coin yourself</b> (Close) stops that bot, so it doesn't buy it straight back.</li>
              <li><b>Several bots</b> <i>(AI Pro: 2, AI Max: 3)</i>: each bot trades its own coin from the same account cash, with its own settings, plan and log. Two bots never trade the same coin, and the daily loss limit and emergency stop cover the whole account (the emergency stop sells every bot position and stops all bots).</li>
              <li><b>After the trade</b> it waits for a fresh AI plan before buying again, and applies the cool-down and daily limits.</li>
            </ol>
          </section>

          <section id="rules-plan">
            <h2>2. The AI's plan</h2>
            <p>The AI reads the coin's charts on four timeframes (5-second candles for the last few minutes, 5-minute for the day, 1-hour for the trend, 1-day for the big picture), with indicators (moving averages, RSI, volatility, volume), plus liquidity, buyers vs sellers in the last hour, the pool's age, your trading costs, its own track record and the bot's exact rules.</p>
            <ul>
              <li><b>Stance:</b> <b>Buy now</b> (a good entry right now), <b>Waiting</b> (only buy if a trigger is reached) or <b>Avoid</b> (the AI advises staying out). With Avoid it still gives its best levels, shown as a risky setup.</li>
              <li><b>Orders (1–2):</b>
                <ul>
                  <li><b>Buy now</b>: buy at once, up to the order's price.</li>
                  <li><b>Buy the dip</b>: buy when the price falls to the trigger or lower.</li>
                  <li><b>Buy the breakout</b>: buy when the price rises to the trigger or higher, optionally only with above-normal volume (e.g. 1.5× the hourly average).</li>
                </ul>
                Each order has an <b>exit price</b> (stop-loss), a <b>target</b>, a <b>maximum holding time</b> and a <b>win chance</b>.
              </li>
              <li><b>Win chance:</b> the AI's estimate that, once bought, the price reaches the target before the exit. It's a prediction, not a promise.</li>
              <li><b>Confidence and risk level:</b> how sure the AI is about its overall read, and how risky the coin is (Low, Medium, High, Extreme). Shown as information.</li>
              <li><b>Cancel range and validity:</b> the plan is dropped if the price leaves its range (below / above set prices) or its time runs out; then a new plan is made.</li>
              <li><b>Targets:</b> the AI is told to put targets just below resistance (where rallies have stalled), so they actually get reached.</li>
              <li><b>Models:</b> your own <b>Analyze</b> and <b>Ask AI</b> use Claude Opus 5.5; the bot's routine re-plans use Claude Sonnet 5.5.</li>
              <li><b>Saved plans:</b> a coin's plan is kept until you press Analyze again, or until it can no longer play out (time ran out or the price left its range). Plans made before the latest trade on that coin are hidden.</li>
            </ul>
          </section>

          <section id="rules-checks">
            <h2>3. Checks on every order</h2>
            <ul>
              <li><b>Sensible prices:</b> exit below the buy price, target above it. Otherwise the order is dropped.</li>
              <li><b>Fee and risk check:</b> with the round-trip cost (fees + slippage, both sides) added, the gain to the target must be at least as big as the loss to the exit, and the order must make money on average:
                <div className="rules-formula">win chance × gain after costs − (1 − win chance) × loss after costs &gt; 0</div>
                An order that fails is kept as a <b className="down">risky setup</b> (red warning). The bot uses it only in risky mode.</li>
              <li><b>Minimum win chance</b> <i>(your setting)</i>: orders below it aren't used. The card says "below your minimum, won't be used". In risky mode a separate, lower <b>risky-mode minimum</b> <i>(your setting, default 30%)</i> applies instead.</li>
            </ul>
          </section>

          <section id="rules-buy">
            <h2>4. When the bot buys</h2>
            <ul>
              <li><b>Price checks every 5 seconds</b>, including the low and high of each 5-second candle, so a brief dip or spike between checks still counts.</li>
              <li><b>Fills like real orders:</b> a dip order at its trigger price or better; a breakout at its trigger or worse; buy now at the live price (up to the order's price).</li>
              <li><b>Wait for the price to hold</b> <i>(optional setting)</i>: if on, the bot waits the few seconds the AI suggests past the trigger, so it doesn't buy into a spike or a crash that's still going.</li>
              <li><b>Fresh plan only:</b> it never trades on a plan made before the bot started or before the last trade closed. If a new plan is needed but the AI was asked under 2 minutes ago, it waits.</li>
              <li><b>Falling coins:</b> dip and buy-now orders are paused while the 1-hour trend is down or the coin fell more than the limit in the last hour <i>(your setting)</i>. A crash is not a dip. Breakout orders are still allowed. Risky mode lifts this.</li>
              <li><b>Avoid plans and risky setups:</b> traded only in risky mode.</li>
              <li><b>One bot position at a time</b> per account.</li>
              <li><b>AI tokens:</b> if your plan's AI tokens are used up, the bot can't make new plans (it still manages an open position).</li>
            </ul>
          </section>

          <section id="rules-size">
            <h2>5. How much it buys</h2>
            <ul>
              <li><b>Money per trade</b> <i>(your setting)</i>: the most one trade can use, as a % of the account, never more than your cash.</li>
              <li><b>Risk per trade</b> <i>(your setting)</i>: sizes the trade so that hitting the exit loses about this % of the account:
                <div className="rules-formula">amount ≈ account × risk % ÷ (distance to the exit + round-trip costs)</div>
                e.g. a $10,000 account, 1.5% risk and an exit 5% below plus 3% costs: about $1,875.</li>
              <li><b>Risk per trade 0</b> (Aggressive): always use the full "money per trade", e.g. 50% of the account.</li>
            </ul>
          </section>

          <section id="rules-sell">
            <h2>6. When the bot sells</h2>
            <ul>
              <li><b>Stop-loss:</b> sells if the price falls to the exit price, at that price, or at the live price if it gapped lower.</li>
              <li><b>Break-even:</b> once the trade is up the break-even amount <i>(your setting)</i>, the stop moves to the buy price plus costs, so it can't turn into a loss.</li>
              <li><b>Profit lock</b> <i>(your setting, default 50%)</i>: from then on the stop follows the best price so the trade keeps at least that share of its best gain.</li>
              <li><b>Take half</b> <i>(your setting, default 100% = at the target)</i>: sells half once the price is that far from the buy price to the target. The rest rides on. (A lower setting takes profit earlier but cuts winners short.)</li>
              <li><b>At the target:</b> it doesn't sell; it switches to a <b>trailing stop</b> that sells if the price falls that % from its highest point. The % is sized to how much the coin normally moves (3x its average 5-minute range), never tighter than <i>your setting</i> and at most 12%.</li>
              <li><b>Time limit:</b> sells after the order's maximum holding time.</li>
              <li><b>Bad-tick protection:</b> highs and lows more than 15% beyond the live price are ignored, and trailing stops and the profit lock follow closing prices, so one bad tick can't end a trade.</li>
              <li><b>Emergency stop:</b> see account safety limits.</li>
            </ul>
          </section>

          <section id="rules-after">
            <h2>7. After a trade</h2>
            <ul>
              <li><b>Fresh plan:</b> the old plan is dropped and the AI is asked again before the next buy.</li>
              <li><b>One trade at a time or continuously</b> (wrench ⚙ Settings): by default the bot stops itself after a profitable trade; "Trade continuously" keeps it going.</li>
              <li><b>Cool-down after a loss</b> <i>(your setting)</i>: it won't re-buy that coin for this many minutes.</li>
              <li><b>Two losses in a row on a coin</b> in a day: that coin is skipped until 00:00 UTC.</li>
              <li>Risky mode lifts the cool-down and the two-loss skip.</li>
            </ul>
          </section>

          <section id="rules-safety">
            <h2>8. Account safety limits</h2>
            <ul>
              <li><b>Daily loss limit</b> <i>(your setting)</i>: if the account falls this % in one UTC day, the bot stops opening new trades until 00:00 UTC. Open trades still sell normally. <b>Continue anyway</b> (after an "I understand" popup) lifts it until midnight UTC; it turns back on the next day.</li>
              <li><b>Emergency stop</b> <i>(your setting)</i>: if the account falls more than this % below its starting balance, the bot sells its positions and switches off. It always applies, even in risky mode or after "Continue anyway".</li>
            </ul>
          </section>

          <section id="rules-risky">
            <h2>9. Risky mode</h2>
            <p>When you start the bot on a coin the AI rates High/Extreme risk, advises avoiding, that is falling, or with thin liquidity (under $50K), a popup lists the reasons. <b>"I understand, trade anyway"</b> starts risky mode (AI Pro and up):</p>
            <ul>
              <li><b>Changes:</b> buys dips even while the coin is falling; uses Avoid plans and setups that fail the fee/risk check; uses orders down to your <b>risky-mode minimum win chance</b> (default 30%) instead of the normal minimum.</li>
              <li><b>Still applies:</b> a <b>5-minute cool-down</b> on the coin after a losing trade, and the coin is skipped for the rest of the day after <b>two losses in a row</b>. Each trade is capped at <b>25% of the account</b>, and a trade must be able to gain at least <b>1.5x</b> what it risks after fees.</li>
              <li><b>Also still applies:</b> the AI's exit, profit lock, take-half, trailing stop, the risky-mode minimum, the daily loss limit and the emergency stop.</li>
              <li>Your acceptance, with the warnings shown, is kept in your activity history.</li>
            </ul>
          </section>

          <section id="rules-autopick">
            <h2>10. Auto-pick</h2>
            <p>Instead of one coin, the bot scans trending coins on the chosen chain (all chains by default), skips coins with under $50K liquidity, asks the AI about the best 3 in the buy zone and trades the one with the strongest plan. It still holds one position at a time and picks again after each trade. Available on AI Pro and up.</p>
          </section>

          <section id="rules-manual">
            <h2>11. Manual trading</h2>
            <ul>
              <li><b>Buy / sell now</b>: at the live price plus simulated slippage and fees (all plans).</li>
              <li><b>Limit buy</b>: spends an amount when the price falls to your price. Fills at your price or lower, after slippage (Member and up).</li>
              <li><b>Limit sell</b>: sells 25%, 50% or all of a position when the price rises to your price. Fills at your price or higher, after slippage (Member and up).</li>
              <li>Limit orders are checked every 5 seconds, even with the bot off and the page closed; up to 10 open orders; a position's limit sells go away when it closes; if there isn't enough cash when a limit buy triggers, it uses the cash that's left (and is cancelled if that's under $1).</li>
              <li><b>Protect this trade</b>: a trailing stop on a manual position (3/5/10% from its high, by closing prices), also checked with the bot off (Member and up).</li>
            </ul>
          </section>

          <section id="rules-costs">
            <h2>12. Costs and charges</h2>
            <ul>
              <li><b>Trading costs</b> <i>(your setting)</i>: a DEX fee and slippage on each side, e.g. 1% + 0.5% = about 3% for a buy and sell. Every trade has to gain more than this to make money.</li>
              <li><b>Platform transaction charge</b> by plan, after the plan's free trades for the month:
                <ul>
                  {plans.map((p) => (
                    <li key={p.id}>{p.name}: {p.feePct === 0 ? "none" : p.freeTrades > 0 ? `${p.freeTrades} trades a month free, then ${p.feePct}%` : `${p.feePct}% per trade`}</li>
                  ))}
                </ul>
              </li>
            </ul>
          </section>

          <section id="rules-plans">
            <h2>13. Plans and AI tokens</h2>
            <div className="table-wrap">
              <table className="scan rules-table">
                <thead><tr><th>Plan</th><th className="num">Price</th><th className="num">AI tokens / month</th><th>Includes</th></tr></thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id}>
                      <td><b>{p.name}</b></td>
                      <td className="num">{p.priceUsd ? `$${p.priceUsd}/mo` : "Free"}</td>
                      <td className="num">{p.aiTokens ? fmtM(p.aiTokens) : "–"}</td>
                      <td className="small">{p.permissions.includes("bot.autopick") ? `Everything: AI plans, ${p.bots ?? 1} AI bots at once (each on its own coin), auto-pick, risky mode, limit orders, Protect` : p.permissions.includes("bot.run") ? `AI plans, ${p.bots ?? 1} AI bot on a coin, limit orders, Protect` : p.permissions.includes("trade.limit") ? "Manual trading, limit orders, Protect" : "Manual buy and sell only"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul>
              <li><b>10 app tokens = 1 token of the AI</b>, for every AI model asked. A typical analysis uses about 14,000 AI tokens (about 140,000 app tokens).</li>
              <li>The allowance resets on the 1st of each month (UTC). Token packs add tokens that don't expire, used after the monthly allowance.</li>
              <li>When tokens run out, AI requests are refused and the bot makes no new plans; open positions are still managed.</li>
              <li>Yearly billing: pay for 10 months, get 12.</li>
            </ul>
          </section>

          <section id="rules-presets">
            <h2>14. Preset values</h2>
            <p>Pick a preset in the bot panel, or change any number to make your own (Custom).</p>
            <div className="table-wrap">
              <table className="scan rules-table">
                <thead><tr><th>Setting</th>{P.map((p) => <th key={p.label} className="num">{p.label}</th>)}</tr></thead>
                <tbody>
                  {row("Money per trade (% of account)", (p) => `${p.positionPct}%`)}
                  {row("Risk per trade (% of account)", (p) => (p.riskPerTradePct > 0 ? `${p.riskPerTradePct}%` : "off (full amount)"))}
                  {row("Minimum win chance", (p) => `${p.minConfidence}%`)}
                  {row("Minimum win chance in risky mode", (p) => `${p.riskyMinWin}%`)}
                  {row("Backup AI re-check", (p) => `every ${p.analyzeMin} min`)}
                  {row("Break-even once up", (p) => `${p.breakEvenAtPct}%`)}
                  {row("Profit lock (best gain kept)", (p) => `${p.lockPct}%`)}
                  {row("Take half at (of the way to target)", (p) => `${p.partialAtPct}%`)}
                  {row("Trailing stop past the target", (p) => `${p.trailPct}%`)}
                  {row("Cool-down after a loss", (p) => `${p.cooldownMin} min`)}
                  {row("Skip dips if it fell more than (1 hour)", (p) => `${p.maxDrop1hPct}%`)}
                  {row("Daily loss limit", (p) => `${p.dailyLossPct}%`)}
                  {row("Emergency stop (account drawdown)", (p) => `${p.maxDrawdownPct}%`)}
                </tbody>
              </table>
            </div>
          </section>

          <section id="rules-data">
            <h2>15. Prices, data and the scheduler</h2>
            <ul>
              <li>Prices come from DexScreener and CoinMarketCap (5-second candles), with GeckoTerminal, Coinbase and OKX as backups. Data from free sources can be delayed or briefly unavailable.</li>
              <li>A scheduler wakes your bot, protected trades and limit orders about every minute, and they're checked every 5 seconds while awake, so they work with the page closed. The bot panel shows when it was last woken.</li>
              <li>Each login has its own paper account, bot, settings and orders. Signed out, you see an empty $0 account.</li>
            </ul>
          </section>

          <section id="rules-history">
            <h2>16. What's recorded</h2>
            <p>Your activity history (Profile → Activity & history) permanently keeps: consents ("I understand", with the warnings shown), bot starts, stops and pauses, AI analyses with tokens used, orders, Protect, sign-ins and account changes, and changes made by admins. Every trade is kept and can be downloaded as CSV. Entries are never edited or deleted.</p>
          </section>

          <section id="rules-risk">
            <h2>17. Important</h2>
            <p>This is a paper-trading simulator for learning and testing. The AI's plans and win chances are estimates and can be wrong; small and new coins can lose most of their value quickly, and past results don't predict future ones. Nothing here is financial advice.</p>
          </section>
        </article>
      </div>
    </div>
  );
}
