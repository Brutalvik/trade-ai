// "User guide": how to use the app, written for the reader's own plan. Sections a plan doesn't
// include are left out entirely (a Free user sees no AI or bot instructions), with one short line
// pointing to Plans. Opened from the footer, at #guide (#rules still works for old links).
import { useEffect, type ReactNode } from "react";
import { useAccess } from "./Account";
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

type Section = { id: string; title: string; show: boolean; body: ReactNode };

const fmtM = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`);

export function GuidePage({ presets, plans, onClose }: { presets: Record<string, Preset>; plans: PlanInfo[]; onClose: () => void }) {
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
  const pro = has("bot.autopick");
  const bots = me?.botLimit ?? (bot ? 1 : 0);
  const plan = plans.find((p) => p.id === (me?.plan ?? "free")) ?? plans.find((p) => p.id === "free");
  const planName = plan?.name ?? "Free";
  const isTop = me?.plan === "max" || me?.role === "admin";

  const P = Object.values(presets);
  const row = (label: string, f: (p: Preset) => string) => (
    <tr>
      <td>{label}</td>
      {P.map((p) => <td key={p.label} className="num">{f(p)}</td>)}
    </tr>
  );
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
          <p>The screen has four parts: the <b>coin list</b> (left), the <b>chart</b> (middle), the <b>trade panel{ai ? ", AI Signal" : ""}{bot ? " and Auto-pilot" : ""}</b> (right) and <b>Positions, Trade history{bot ? " and Bot log" : ""}</b> (bottom).</p>
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
          <p>An agent trades <b>one coin</b> with the money you give it. Press <b>+ New Agent</b> in the Agents panel, pick a coin from the <b>top 10 opportunities</b> or the search box, set a budget (default $1,000) and start it.{bots > 1 ? ` Your plan runs up to ${bots} agents at once, each on its own coin.` : ""}</p>
          <ul>
            <li><b>It learns first.</b> The agent replays five entry patterns over the coin's own history (breakout with volume, pullback to the trend line, tight-range breakout, bull flag, RSI rebound) with the exact rules it trades by, and keeps the one that really made money there. It relearns every hour. "What it learned" on its card shows every pattern's record.</li>
            <li><b>It only trades with proof.</b> If no pattern has at least 3 past trades that made money on average, the agent waits. Waiting is the agent working, not a fault.</li>
            <li><b>Every trade aims for +10% after all fees.</b> The exit sits 4–7% below the buy price. From +8% the exit moves above the buy price; at the target it sells half and trails the rest.</li>
            <li><b>One AI check before each buy</b> (optional): a small AI call per trade, not per scan.</li>
            <li><b>Its budget is its limit.</b> It invests only its budget plus what its own trades have made. If it loses half its budget, it stops itself.</li>
            <li><b>Top 10 opportunities</b> are scored by eight rule-based scouts: trend, volume, real traders, holders, dev wallet, liquidity, momentum and age. A coin with a deal-breaker (for example the dev holds too much, or liquidity is being pulled) is marked vetoed with the reason. Scores are not advice.</li>
            <li><b>Stop</b> on an agent's card switches it off; an open trade stays in Positions for you to close. The older bot card is under <b>Classic bot view</b>.</li>
          </ul>
        </>
      ),
    },
    {
      id: "bot", title: "Auto-pilot: the AI bot", show: bot,
      body: (
        <>
          <ol>
            <li>Open a coin, choose a preset (<b>Safe</b>, <b>Balanced</b>, <b>Aggressive</b>) or <b>Custom</b>, and press <b>Start bot</b>.</li>
            <li><b>The AI writes a plan</b>; the app checks every order against fees, risk and your minimum win chance.</li>
            <li><b>The bot watches the price every 5 seconds</b> (with the page closed too) and buys the moment an order's trigger is reached, if the safety rules allow it.</li>
            <li><b>It manages the trade</b> until it sells (see "How the bot sells"), then asks the AI for a fresh plan before buying again. While it does, the AI panel shows the planning animation.</li>
          </ol>
          <ul>
            <li><b>One trade or continuously</b> (wrench ⚙ in the header): by default the bot stops after a profitable trade; <b>Trade continuously</b> keeps it going.</li>
            <li><b>Buy by hand, let the bot sell</b>: start a bot on a coin you already hold and it takes over that position. <b>Closing a bot's coin yourself</b> stops that bot.</li>
            <li><b>Settings</b> (in the bot card) can't be changed while the bot runs: stop it first.</li>
            <li><b>Bot log</b> (bottom) shows every decision; trades the bot makes also pop up at the top right.</li>
            {bots > 1 ? <li><b>{bots} bots at once</b>: the Bot 1–{bots} tabs each run their own coin, settings, plan and log, from the same cash. Two bots never trade the same coin. Clicking a bot tab opens its coin; the daily loss limit and emergency stop cover the whole account.</li> : null}
          </ul>
        </>
      ),
    },
    {
      id: "switches", title: "Bot switches", show: bot,
      body: (
        <ul>
          <li><b>Strong mode</b> (on by default): extra checks on every buy. Win chances are scaled by your bots' real results; no dip buys while a coin is falling; dip orders wait for a bounce off the low; breakouts must hold above the level; after 3 losing trades in a row, no new buys for 60 minutes; Avoid plans are never traded.</li>
          <li><b>AI second look at the stop</b> (on by default): when a trade touches its stop-loss, the AI checks the chart again and may keep it open <b>once</b>, with a new last exit never more than 1.5× the original risk below your buy price. At the time limit it can extend the hold (10–120 min, up to 3 times). It must clear your minimum win chance, aim for a profit after fees and make money on average from there; otherwise, or if the AI is slow or unavailable, the bot sells. This can turn a small loss into a bigger one.</li>
          <li><b>Gain must be 1.5× the risk</b> (on by default): only buys when the possible gain after fees is at least 1.5× the possible loss.</li>
          <li><b>Turning a protection off</b> (any setting's On/Off pill, Strong mode, or the 1.5× rule) asks you to confirm "I understand", and your choice is recorded in your activity history.</li>
        </ul>
      ),
    },
    {
      id: "buy", title: "When the bot buys", show: bot,
      body: (
        <ul>
          <li><b>Fills like real orders</b>: a dip order at its trigger price or better; a breakout at its trigger or worse; buy now at the live price.</li>
          <li><b>Wait for the price to hold</b> (optional): the bot waits a few seconds past the trigger so it doesn't buy a spike or a crash that's still going.</li>
          <li><b>Fresh plan only</b>: never a plan made before the bot started or before its last trade closed.</li>
          <li><b>Falling coins</b>: dip and buy-now orders pause while the 1-hour trend is down or the coin fell more than your limit in the last hour.</li>
          <li><b>Size</b>: <i>money per trade</i> is the most one trade can use (% of the account). With <i>risk per trade</i> set, the trade is sized so hitting the exit loses about that % of the account: amount ≈ account × risk % ÷ (distance to the exit + costs).</li>
          <li><b>AI tokens</b>: when they run out, the bot makes no new plans (it still manages an open trade).</li>
        </ul>
      ),
    },
    {
      id: "sell", title: "How the bot sells", show: bot,
      body: (
        <>
          <p>The AI sets each trade's starting exit (stop-loss). After that the bot only raises it, except for the AI second look above.</p>
          <ul>
            <li><b>Stop-loss</b>: sells if the price falls to the exit, at that price or lower if it gapped.</li>
            <li><b>Profit guard</b>: once the trade is up enough, the exit jumps to a small profit after fees, so a winner can't turn into a loss.</li>
            <li><b>Profit lock</b>: the exit then follows the best price so the trade keeps at least a share of its best gain (default 50%).</li>
            <li><b>Take half</b>: sells half at the target (or earlier, if you set it), and the rest rides on.</li>
            <li><b>Trailing stop</b> past the target: sells if the price falls a set % from its highest close (sized to how much the coin normally moves, at most 12%).</li>
            <li><b>Sell everything once up $X</b> (optional): takes the whole profit when the trade is up that many dollars after fees.</li>
            <li><b>Time limit</b>: sells after the order's maximum holding time.</li>
            <li>Bad ticks (prices more than 15% away from the live price) are ignored.</li>
          </ul>
        </>
      ),
    },
    {
      id: "safety", title: "Safety limits", show: bot,
      body: (
        <ul>
          <li><b>Cool-down after a loss</b>: no re-buy of that coin for a while. <b>Two losses in a row</b> on a coin in a day: skipped until 00:00 UTC.</li>
          <li><b>Daily loss limit</b>: if the account falls this % in a UTC day, no new trades until midnight UTC. <b>Continue anyway</b> (after "I understand") lifts it for the rest of the day.</li>
          <li><b>Emergency stop</b>: if the account falls more than this % below its value when the bot started, the bot sells its positions and switches off. It always applies.</li>
        </ul>
      ),
    },
    {
      id: "risky", title: "Risky mode and auto-pick", show: pro,
      body: (
        <>
          <p><b>Risky mode</b>: starting a bot on a coin the AI rates risky, advises avoiding, that is falling, or with thin liquidity shows the reasons. <b>"I understand, trade anyway"</b> lets the bot use Avoid plans and red risky setups and lower its minimum win chance (default 30%). Still applies: each trade capped at 25% of the account, a 5-minute cool-down after a loss, a coin skipped for the day after two losses in a row, the 1.5× rule (if on), the daily loss limit and the emergency stop. With Strong mode on, Avoid plans are still skipped.</p>
          <p><b>Auto-pick</b>: instead of one coin, the bot scans trending coins on the chosen chain, skips thin ones (under $50K liquidity), asks the AI about the best few and trades the strongest plan, then picks again after each trade.</p>
        </>
      ),
    },
    {
      id: "presets", title: "Preset values", show: bot,
      body: (
        <div className="table-wrap">
          <table className="scan rules-table">
            <thead><tr><th>Setting</th>{P.map((p) => <th key={p.label} className="num">{p.label}</th>)}</tr></thead>
            <tbody>
              {row("Money per trade (% of account)", (p) => `${p.positionPct}%`)}
              {row("Risk per trade (% of account)", (p) => (p.riskPerTradePct > 0 ? `${p.riskPerTradePct}%` : "off (full amount)"))}
              {row("Minimum win chance", (p) => `${p.minConfidence}%`)}
              {pro ? row("Minimum win chance in risky mode", (p) => `${p.riskyMinWin}%`) : null}
              {row("Backup AI re-check", (p) => `every ${p.analyzeMin} min`)}
              {row("Profit guard once up", (p) => `${p.breakEvenAtPct}%`)}
              {row("Profit lock (best gain kept)", (p) => `${p.lockPct}%`)}
              {row("Take half at (of the way to target)", (p) => `${p.partialAtPct}%`)}
              {row("Trailing stop past the target", (p) => `${p.trailPct}%`)}
              {row("Cool-down after a loss", (p) => `${p.cooldownMin} min`)}
              {row("Skip dips if it fell more than (1 hour)", (p) => `${p.maxDrop1hPct}%`)}
              {row("Daily loss limit", (p) => `${p.dailyLossPct}%`)}
              {row("Emergency stop", (p) => `${p.maxDrawdownPct}%`)}
            </tbody>
          </table>
        </div>
      ),
    },
    {
      id: "positions", title: "Positions, history and exports", show: true,
      body: (
        <ul>
          <li><b>Positions</b>: each coin you hold, {bot ? "who bought it (you or a bot), " : ""}the amount invested, entry and current price, profit or loss, exit and target, and when it sells by.</li>
          <li><b>Trade history</b>: every buy and sell. Download it as <b>CSV</b> (for spreadsheets) or a formatted <b>PDF</b>.</li>
          <li><b>Growth ladder</b> (checkbox): your progress toward account goals, shown under Positions.</li>
          <li><b>Profile → Activity &amp; history</b>: sign-ins, setting changes, {bot ? "bot starts and stops, " : ""}{ai ? "AI analyses, " : ""}and every "I understand" you confirmed. Entries are never edited or deleted.</li>
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
            <li><b>Solana coins only</b>; each real trade is capped at $100 for now. {bot ? "The bots don't trade real money yet." : ""}</li>
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
            <li><b>Trading costs</b> (paper, simulated): a DEX fee and slippage on each side, about 3% for a buy and a sell together. Change them in the wrench ⚙ settings. Real trades pay the real swap and network fees shown before you sign.</li>
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
          <li>Your username can't be changed. Each account has its own paper balance{bot ? ", bots" : ""}, trades and history.</li>
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
