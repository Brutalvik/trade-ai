import { useEffect, useRef, useState } from "react";
import { fmtPrice, fmtUsd, type AppState, type Trade } from "./api";

type Note = { id: string; trade?: Trade; pick?: { symbol: string; chain: string; pool: string; detail: string } };
const SHOW_MS = 20_000;

// Cards at the top right (under the header) whenever the bot buys or sells.
// Trades that already existed when the page opened are not announced.
export function BotTradeNotifications({ state, onOpen }: { state: AppState | null; onOpen: (chain: string, pool: string) => void }) {
  const seen = useRef<Set<string> | null>(null);
  const lastPick = useRef<string | null | undefined>(undefined);
  const [notes, setNotes] = useState<Note[]>([]);
  const dismiss = (id: string) => setNotes((n) => n.filter((x) => x.id !== id));

  // Auto-pick: announce when the bot chooses a (new) coin.
  const tgt = state?.bot.running && state.bot.config?.pick === "auto" ? state.bot.target : null;
  useEffect(() => {
    if (!state) return;
    const key = tgt ? `${tgt.pool}:${tgt.chosenAt}` : null;
    if (lastPick.current === undefined) {
      lastPick.current = key; // first load: don't announce
      return;
    }
    if (!key || key === lastPick.current) {
      lastPick.current = key;
      return;
    }
    lastPick.current = key;
    const orders = state.lastSignal?.pool === tgt!.pool ? state.lastSignal.consensus.orders : [];
    const best = orders.slice().sort((a, b) => b.winChancePct - a.winChancePct)[0];
    const detail = best ? `Claude's best order: ${best.kind === "buy_dip" ? "buy the dip" : best.kind === "buy_breakout" ? "buy the breakout" : "buy now"} at ${fmtPrice(best.triggerPrice)} (${best.winChancePct}% win chance)` : "Waiting for Claude's plan";
    const id = `pick-${key}`;
    setNotes((n) => [{ id, pick: { symbol: tgt!.symbol, chain: tgt!.chain, pool: tgt!.pool, detail } }, ...n].slice(0, 4));
    setTimeout(() => dismiss(id), SHOW_MS);
  }, [Boolean(state), tgt?.pool, tgt?.chosenAt]); // Boolean(state): run once state first arrives, even with no pick yet

  useEffect(() => {
    if (!state) return;
    const botTrades = state.trades.filter((t) => t.source === "bot");
    if (!seen.current) {
      seen.current = new Set(botTrades.map((t) => t.id)); // first load: remember, don't announce
      return;
    }
    const fresh = botTrades.filter((t) => !seen.current!.has(t.id)).reverse(); // oldest first
    if (!fresh.length) return;
    for (const t of fresh) seen.current.add(t.id);
    setNotes((n) => [...fresh.map((t) => ({ id: t.id, trade: t })), ...n].slice(0, 4));
    for (const t of fresh) setTimeout(() => dismiss(t.id), SHOW_MS);
  }, [state?.trades]);

  if (!notes.length) return null;
  return (
    <div className="bot-notes" aria-live="polite">
      {notes.map(({ id, trade: t, pick }) => {
        if (pick) {
          return (
            <div key={id} className="bot-note pick" role="status">
              <div className="bot-note-head">
                <b>🎯 Auto-pick chose {pick.symbol}</b>
                <button className="chip" aria-label="Dismiss" onClick={() => dismiss(id)}>
                  ✕
                </button>
              </div>
              <div className="muted tiny">{pick.detail}</div>
              <button className="chip view" onClick={() => onOpen(pick.chain, pick.pool)}>
                View chart
              </button>
            </div>
          );
        }
        if (!t) return null;
        const pnl = t.pnlUsd ?? 0;
        const tone = t.side === "BUY" ? "buy" : pnl >= 0 ? "win" : "loss";
        return (
          <div key={id} className={`bot-note ${tone}`} role="status">
            <div className="bot-note-head">
              <b>
                🤖 Bot {t.side === "BUY" ? "bought" : "sold"} {t.symbol}
              </b>
              <button className="chip" aria-label="Dismiss" onClick={() => dismiss(id)}>
                ✕
              </button>
            </div>
            <div className="small">
              {fmtUsd(t.usd)} @ <span className="mono">{fmtPrice(t.price)}</span>
              {t.side === "SELL" && (
                <>
                  {" · "}
                  <b className={pnl >= 0 ? "up" : "down"}>
                    {pnl >= 0 ? "+" : ""}
                    {fmtUsd(pnl)}
                  </b>
                </>
              )}
            </div>
            <div className="muted tiny">{t.reason.replace(/^Claude plan: /, "Claude's order: ")} · {new Date(t.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
          </div>
        );
      })}
    </div>
  );
}

// "New version available" when the server is running a newer build than this page.
// Refreshing only reloads the page; the bot runs on the server and keeps trading.
export function UpdateBanner({ serverCommit }: { serverCommit?: string }) {
  if (!serverCommit || !__APP_COMMIT__ || serverCommit === __APP_COMMIT__) return null;
  return (
    <div className="update-banner" role="status">
      <span>
        A new version of the app is live. <span className="muted">Refreshing won't interrupt the bot; it keeps trading on the server.</span>
      </span>
      <button className="btn ghost" onClick={() => location.reload()}>
        Refresh
      </button>
    </div>
  );
}
