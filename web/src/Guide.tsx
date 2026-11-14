// "User guide": how to use the app, written for the reader's own plan. Sections a plan doesn't
// include are left out entirely (a Free user sees no AI or bot instructions), with one short line
// pointing to Plans. Opened from the footer, at #guide (#rules still works for old links).
import { useEffect, type ReactNode } from "react";
import { useAccess } from "./Account";
import type { PlanInfo } from "./api";

type Section = { id: string; title: string; show: boolean; body: ReactNode };

const fmtM = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`);

export function GuidePage({ plans, onClose }: { plans: PlanInfo[]; onClose: () => void }) {
  const { me, openPlans } = useAccess();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // What this reader's plan includes (signed out = Free).
  const perms = me?.permissions ?? [];
  const has = (p: string) => !!me && perms.includes(p as never);
  const limit = has("trade.limit");
  const ai = has("ai.analyze");
  const bot = has("bot.run");
  const bots = me?.botLimit ?? (bot ? 1 : 0);
  const plan = plans.find((p) => p.id === (me?.plan ?? "free")) ?? plans.find((p) => p.id === "free");
  const planName = plan?.name ?? "Free";
  const isTop = me?.plan === "max" || me?.role === "admin";

  const go = (id: string) => document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const sections: Section[] = [
    {
      id: "start", title: "Getting started", show: true,
      body: (
        <>
          <ol>
            <li><b>Sign in</b> (top right) with an email code, Google, or a username and password. Signed out you can browse coins and charts, but trading needs an account.</li>
            <li><b>You start in Paper mode</b>: a practice account with practice money. Nothing real is bought or sold. The <b>PAPER</b> label in the header and your practice balance show you're in Paper mode.</li>
            <li><b>Pick a coin</b> from the list on the left, or search by name, ticker or address at the top.</li>
            <li><b>Read the chart</b>, then <b>buy</b> from the trade panel on the right. Your coins appear under <b>Positions</b> below the chart.</li>
          </ol>
          <p>The screen has four parts: the <b>coin list</b> (left), the <b>chart</b> (middle), the <b>trade panel{ai ? ", AI Signal" : ""}{bot ? " and Agents" : ""}</b> (right) and <b>Positions, Trade history{bot ? " and the agents' log" : ""}</b> (bottom).</p>
        </>
      ),
    },
    {
      id: "coins", title: "Finding coins", show: true,
      body: (
        <ul>
          <li><b>Tabs</b> at the top of the list: <b>Crypto</b> (major coins by market rank), <b>Top</b> (trending Solana coins ranked by momentum), <b>Trending</b>, <b>Most held</b>, <b>Graduated</b> (coins that left their launch curve), <b>Bonding</b> (coins still on their launch curve) and <b>Community</b> (coins most traded by users of this app). Use ‹ › to scroll the tabs.</li>
          <li><b>Momentum labels</b> in the Top list: <b>Hot</b>, <b>Mixed</b> and <b>Cold</b>, with a score. They come from the coin's price change, volume and buyers only. They are not advice{ai ? " and not the AI's plan" : ""}.</li>
          <li><b>Search</b> by name, ticker or token address.</li>
          <li><b>The list panel</b> can be collapsed («) and resized by dragging its right edge. Hovering a coin preloads its chart so it opens faster.</li>
        </ul>
      ),
    },
    {
      id: "chart", title: "The chart", show: true,
      body: (
        <ul>
          <li><b>Timeframes</b> (top right): 1s, 5s, 1m, 5m, 15m, 1h, 4h, 1d. <b>Ranges</b> (bottom left): 1H to All.</li>
          <li><b>Indicators</b>: volume, EMA 9 and 21, SMA 50 and 200, Bollinger Bands and VWAP on the price; RSI and MACD in their own panes below it.</li>
          <li><b>Drawing tools</b> (left toolbar): trend lines, horizontal and vertical lines, rectangles, Fibonacci retracement, measure (% change and time) and text notes. The eraser removes one drawing; the trash icon lets you pick one, several or all drawings on the coin. Drawings stay in your browser.</li>
          <li><b>Price / MCap</b> switches the scale between price and market cap. <b>%</b>, <b>log</b> and <b>auto</b> (bottom right) change the scale mode.</li>
          <li><b>Lines on the chart</b>: your buy price (BOUGHT), exit (EXIT) and target (TARGET){ai ? ", plus the AI's buy levels (BUY BELOW / BUY ABOVE)" : ""}{limit ? " and your limit orders" : ""}. The legend under the chart names them.</li>
          <li><b>Maximize</b> fills the window (Esc to leave). <b>Drag the handle</b> under the chart to make it taller or shorter. The camera icon saves a screenshot.</li>
        </ul>
      ),
    },
    {
      id: "trade", title: "Buying and selling", show: true,
      body: (
        <>
          <ul>
            <li><b>Market</b>: type an amount in dollars (or tap 25%, 50%, 100% of your available cash) and press <b>Buy</b>. It fills at the live price plus simulated slippage and fees. <b>Sell</b> works the same way on a coin you hold.</li>
            <li><b>Close</b> on a row in Positions sells that whole position. Clicking anywhere else on the row opens its chart.</li>
            {limit ? (
              <>
                <li><b>Limit buy</b> (Limit tab): spends an amount when the price falls to your price. Fills at your price or lower, after slippage.</li>
                <li><b>Limit sell</b>: sells 25%, 50% or all of a position when the price rises to your price. Fills at your price or higher.</li>
                <li>Limit orders are checked every 5 seconds, even with the page closed; up to 10 open orders. A position's limit sells go away when it closes. If cash runs short when a limit buy triggers, it uses what's left (cancelled under $1).</li>
                <li><b>Protect this trade</b>: a trailing stop on a position you bought yourself. Pick 3%, 5% or 10%: it sells if the price falls that much from its highest close since you switched it on. Also works with the page closed.</li>
              </>
            ) : null}
          </ul>
          <p className="muted small">Every trade costs fees and slippage on the way in and out (see Costs). A coin has to rise more than those costs before a trade makes money.</p>
        </>
      ),
    },
    {
      id: "ai", title: "The AI Signal", show: ai,
      body: (
        <>
          <p>Press <b>Analyze</b> in the AI Signal panel to get the AI's plan for the coin on screen. The AI reads four timeframes (5-second, 5-minute, 1-hour and 1-day candles), indicators, liquidity, buyers vs sellers, the pool's age, your trading costs, chart patterns found by the app, and your own trade results.</p>
          <ul>
            <li><b>Stance</b>: <b>Buy now</b>, <b>Waiting</b> (only buy if a trigger is reached) or <b>Avoid</b> (the AI advises staying out; it still shows its best levels as a risky setup).</li>
            <li><b>Orders</b> (1–2): <b>buy now</b>, <b>buy the dip</b> (when the price falls to a level) or <b>buy the breakout</b> (when it rises above a level, optionally with extra volume). Each has an exit price, a target, a maximum holding time and a <b>win chance</b>: the AI's estimate that the target is reached before the exit.</li>
            <li><b>Fee check</b>: an order is used only if it makes money on average after costs. One that fails is shown in red as a risky setup.</li>
            <li><b>Chart patterns the AI saw</b>: chips under the plan (for example a breakout from a range, a bull flag, a double bottom or a stretched price). Hover one to see how often it worked earlier on the same chart.</li>
            <li><b>ⓘ</b> next to the title explains why the AI decided what it did.</li>
            <li>A plan is kept until you press <b>Analyze again</b>, or until it can no longer play out (its time ran out or the price left its range); then a new one is made.</li>
          </ul>
          <p className="muted small">The AI's plans and win chances are estimates and are often wrong. Each analysis uses AI tokens from your plan.</p>
        </>
      ),
    },
    {
      id: "agents", title: "Agents", show: bot,
      body: (
        <>
          <p>An agent trades <b>one coin</b> with the money you give it, and its <b>AI decides</b>. Press <b>+ New Agent</b>, pick a coin from the <b>top 10 opportunities</b> or the search box, set a budget (default $1,000) and start it. Or open a coin and press <b>Start agent on …</b> at the bottom right of its chart: it only asks for the budget.{bots > 1 ? ` Your plan runs up to ${bots} agents at once, each on its own coin.` : ""}</p>
          <ul>
            <li><b>It decides straight away.</b> On start the AI answers: <b>buy now</b>, buy at a level (a dip or a breakout), or stay out. It is asked again at least every 10 minutes, whenever the price makes a real move (4%, or more on a very jumpy coin), when its plan runs out, and right after every trade. Its orders count even if it labels the coin risky.</li>
            <li><b>What the AI is given each time</b>: five charts (5-second, 1-minute, 5-minute, 1-hour and 1-day candles) with indicators and the key levels on each; the chart patterns on screen and how each did before on this coin; real buyers vs sellers for the last 5 minutes, hour and 6 hours; holders, the top wallets' share and the dev's share; what SOL is doing; a study of how simple entries have done on this coin; its own earlier decisions on the coin and what the price did after; and your past trades.</li>
            <li><b>Prediction, three ways.</b> Before each decision the app works out, from the coin's own candles, the chance that a buy reaches +5% after fees before its stop. <b>Simulated paths</b>: thousands of possible next hours rebuilt from stretches of the coin's own recent moves, each one traded with the agent's real exit rules. <b>This coin lately</b>: how often the same order worked from every starting point in the last day. <b>Look-alike moments</b>: the past moments most like now, and what followed. The AI is given these numbers, and where the paths put the price, before it decides.</li>
            <li><b>How an order is judged</b>: the AI gives its own chance of reaching +5% after fees before the stop. That is combined with the numbers, half the weight each. If the order would pass, <b>three more AI forecasters</b> (a momentum trader, a skeptic and a statistician) judge it separately and join the average. The order is used only if the combined chance is enough to make money on average: reaching +5% is worth a little over 5% (winners are then held for more; once you have 5 managed winners, what they really made), and a miss costs the stop distance plus fees, or less if it only runs out of time.</li>
            <li><b>The scoreboard.</b> Every forecast is checked later against what really happened, whether or not the agent bought. Each forecaster, the AI included, is corrected for its own record (one that says 60% when 35% happens is marked down) and weighted by how accurate it has been. The agent's window shows the scoreboard, including how the orders it refused would have done.</li>
            <li><b>What prediction can and can't do.</b> It is good at saying when the odds are poor: a coin that isn't moving enough to clear the fees, or a stop that is too close. It keeps the AI honest. It does not know the future: tested on real coins, the numbers were reliable when low, about a third too high when above 30%, and could not pick the better moment to enter. Expect fewer trades, not more.</li>
            <li><b>Every trade aims for at least +5% after all fees.</b> The AI sets the exit and the target; an order aiming for less isn't used, and neither is one whose combined chance says it loses money on average.</li>
            <li><b>Each buy invests the agent's whole budget</b> (its budget plus what its own trades have made or lost).</li>
            <li><b>The budget is locked.</b> Starting an agent sets its budget aside: it leaves your <b>Available</b> cash, so neither you nor another agent can spend it, while your <b>Equity</b> stays the same. Stopping the agent unlocks whatever isn't in an open trade.</li>
            <li><b>No other limits.</b> There is no daily loss limit, cool-down, losing-streak pause or emergency stop on agents. <b>The budget is the only limit</b>: the agent stops when its budget is used up. Give it only what you're ready to lose.</li>
            <li><b>Profit, managed by the AI</b>: once a trade is up <b>+5% after fees</b>, that minimum is locked as the exit. From then on the AI is asked again and again (on every new percent, on a pullback, and at least every few minutes): <b>hold for more, or sell now?</b> When it holds, it sets the exit and how closely the exit follows the price, so a normal dip doesn't end a trade that is still going. When it thinks the move is over, it sells. The exit never drops below the +5% lock; in a fast drop the sale can fill a little below it.</li>
            <li><b>If the AI can't answer</b> (slow, unreachable, out of AI tokens), the exit follows the price 2.5% behind its high, never below the lock.</li>
            <li><b>Before +5%</b>: the AI's stop-loss applies (the AI is asked once at the stop whether to hold, with a capped last exit), and a time limit closes a trade that goes nowhere.</li>
            <li><b>On the chart</b>: the AI's levels for the agent (BUY BELOW / BUY ABOVE, EXIT, TARGET); after it buys you see BOUGHT, EXIT and TARGET, and its buys and sells are marked on the candles. The AI Signal card shows the same plan.</li>
            <li><b>Click an agent's card</b> to open its window: a running bar (AI deciding → Waiting for its price → In a trade), the AI's decision and reasons, the prediction (every forecaster's chance, the combined chance and what the order needs), the scoreboard, budget and results, activity log and trades.</li>
            <li><b>Top 10 opportunities</b> are scored by eight rule-based scouts: trend, volume, real traders, holders, dev wallet, liquidity, momentum and age. A coin with a deal-breaker is marked vetoed with the reason. Scores are not advice.</li>
            <li><b>Cost</b>: each AI decision uses AI tokens from your plan (about one decision per plan, not per price check).</li>
            <li><b>Stop</b> on an agent's card or in its window switches it off; an open trade stays in Positions for you to close.</li>
          </ul>
        </>
      ),
    },
    {
      id: "positions", title: "Positions, history and exports", show: true,
      body: (
        <ul>
          <li><b>Positions</b>: each coin you hold, {bot ? "who bought it (you or an agent), " : ""}the amount invested, entry and current price, profit or loss, exit and target, and when it sells by.</li>
          <li><b>Trade history</b>: every buy and sell. Download it as <b>CSV</b> (for spreadsheets) or a formatted <b>PDF</b>.</li>
          <li><b>Growth ladder</b> (checkbox): your progress toward account goals, shown under Positions.</li>
          <li><b>Profile → Activity &amp; history</b>: sign-ins, setting changes, {bot ? "agent starts and stops, " : ""}{ai ? "AI analyses, " : ""}and every "I understand" you confirmed. Entries are never edited or deleted.</li>
        </ul>
      ),
    },
    {
      id: "real", title: "Real trading (your own wallet)", show: true,
      body: (
        <>
          <p>In <b>Profile</b>, switch from <b>Paper</b> to <b>Real</b> (you confirm a warning first). In Real mode:</p>
          <ul>
            <li><b>Your wallet</b>: a Solana wallet created and secured by Privy. Open it from the wallet icon in the header to see your balance and address and to add funds. Send only Solana-network funds to it.</li>
            <li><b>You approve every trade</b>: each buy or sell is a Jupiter swap you review and sign. Once confirmed on the blockchain it can't be undone.</li>
            <li><b>Solana coins only</b>; each real trade is capped at $100 for now. {bot ? "Agents don't trade real money yet." : ""}</li>
            <li>Switch back to <b>Paper</b> any time; your practice account is untouched.</li>
          </ul>
        </>
      ),
    },
    {
      id: "costs", title: "Costs and your plan", show: true,
      body: (
        <>
          <ul>
            <li><b>Trading costs</b> (paper, simulated): a DEX fee and slippage on each side, about 3% for a buy and a sell together. Change them in Settings (the wrench in the header). Real trades pay the real swap and network fees shown before you sign.</li>
            {plan ? (
              <li><b>Platform charge on your plan ({planName})</b>: {plan.feePct === 0 ? "none" : plan.freeTrades > 0 ? `${plan.freeTrades} trades a month free, then ${plan.feePct}% of each trade` : `${plan.feePct}% of each trade`}.</li>
            ) : null}
            {ai && plan ? (
              <li><b>AI tokens</b>: {fmtM(plan.aiTokens)} app tokens a month on {planName} (10 app tokens = 1 AI token; a typical analysis uses about 140K). The allowance resets on the 1st (UTC); top-up packs don't expire. Your use is shown in your profile.</li>
            ) : null}
          </ul>
          {!isTop ? (
            <p className="guide-more">
              Higher plans add more features and their own guide sections.{" "}
              <button className="link" onClick={openPlans}>See plans</button>
            </p>
          ) : null}
        </>
      ),
    },
    {
      id: "account", title: "Your account and data", show: true,
      body: (
        <ul>
          <li><b>Profile</b> (your avatar, top right): name, email, password, plan, Paper / Real mode, and your activity history.</li>
          <li>Your username can't be changed. Each account has its own paper balance{bot ? ", agents" : ""}, trades and history.</li>
          <li>How we handle your personal information is in the <b>Privacy Policy</b>; the rules of using the app are in the <b>Terms &amp; Conditions</b> (both linked at the bottom of the page).</li>
        </ul>
      ),
    },
    {
      id: "risk", title: "Important", show: true,
      body: (
        <p>Trading is at your own risk. Crypto, and small new coins above all, can lose most of their value in minutes. {ai ? "The AI's plans and win chances are estimates and are often wrong. " : ""}Paper results don't predict real results. Nothing in this app is financial advice, and we are not responsible for your trading decisions or losses.</p>
      ),
    },
  ];
  const shown = sections.filter((s) => s.show);

  return (
    <div className="rules-page" role="dialog" aria-modal="true" aria-labelledby="guide-h1">
      <header className="rules-top">
        <button className="btn ghost" onClick={onClose}>← Back to trading</button>
        <h1 id="guide-h1">User guide</h1>
        <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
      </header>
      <div className="rules-body">
        <nav className="rules-toc" aria-label="Contents">
          <div className="label-sm">Contents</div>
          {shown.map((s, i) => (
            <button key={s.id} onClick={() => go(s.id)}>{i + 1}. {s.title}</button>
          ))}
        </nav>
        <article className="rules-content">
          <p className="rules-lead">
            How to use TRADING//RUST{me ? <> on your <b>{planName}</b> plan</> : <>. You're signed out, so this shows the <b>Free</b> plan; sign in to see the guide for your plan</>}.
          </p>
          {shown.map((s, i) => (
            <section key={s.id} id={`guide-${s.id}`}>
              <h2>{i + 1}. {s.title}</h2>
              {s.body}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}
