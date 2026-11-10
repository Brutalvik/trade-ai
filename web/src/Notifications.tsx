import { useEffect, useRef, useState } from "react";
import { fmtPrice, fmtUsd, type AppState, type Trade } from "./api";

type Note = { id: string; trade: Trade };
const SHOW_MS = 20_000;

// Cards at the top right (under the header) whenever the bot buys or sells.
// Trades that already existed when the page opened are not announced.
export function BotTradeNotifications({ state }: { state: AppState | null }) {
  const seen = useRef<Set<string> | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);

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
    for (const t of fresh) setTimeout(() => setNotes((n) => n.filter((x) => x.id !== t.id)), SHOW_MS);
  }, [state?.trades]);

  if (!notes.length) return null;
  return (
    <div className="bot-notes" aria-live="polite">
      {notes.map(({ id, trade: t }) => {
        const pnl = t.pnlUsd ?? 0;
        const tone = t.side === "BUY" ? "buy" : pnl >= 0 ? "win" : "loss";
        return (
          <div key={id} className={`bot-note ${tone}`} role="status">
            <div className="bot-note-head">
              <b>
                🤖 Bot {t.side === "BUY" ? "bought" : "sold"} {t.symbol}
              </b>
              <button className="chip" aria-label="Dismiss" onClick={() => setNotes((n) => n.filter((x) => x.id !== id))}>
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
