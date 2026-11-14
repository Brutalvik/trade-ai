// The moving-average crossover signal (20-candle average against 50-candle average) on each
// chart from 1 minute up, as the AI was given it: BUY when the fast average crosses above the
// slow one on a closed candle, SELL when it crosses below. Shown under the AI's plan and in the
// agent window. It is one of the signals the AI weighs; nothing is bought or sold on it alone.
import { fmtPrice, type MaView } from "./api";

export function MaCrossChips({ items, at }: { items?: MaView[]; at?: number }) {
  if (!items) return null; // a plan from before this signal existed
  const ago = (n: number) => (n === 0 ? "on the newest closed candle" : `${n} candle${n === 1 ? "" : "s"} ago`);
  return (
    <div className="pattern-box">
      <div className="label-sm">Moving-average crossover (20 / 50){at ? <span className="ma-at"> · as the AI read it at {new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}</div>
      {items.length ? (
        <div className="pattern-chips">
          {items.map((m) => {
            const fresh = m.signal !== "HOLD";
            const side = m.trend === "up" ? "above" : m.trend === "down" ? "below" : "level with";
            const tip = `${m.tf} chart: the 20-candle average (${fmtPrice(m.fast)}) is ${Math.abs(m.spreadPct).toFixed(2)}% ${side} the 50-candle average (${fmtPrice(m.slow)}).${m.last ? ` Last crossover: ${m.last.signal} ${ago(m.last.candlesAgo)} at ${fmtPrice(m.last.price)}.` : " No crossover in the candles it read."} BUY = the fast average crosses above the slow one on a closed candle; SELL = it crosses below. The AI weighs this with everything else; nothing is bought or sold on it alone.`;
            return (
              <span key={m.tf} className={`pattern-chip ${m.trend === "up" ? "up" : m.trend === "down" ? "down" : "neutral"} ${fresh ? "ma-fresh" : ""}`} data-tip={tip}>
                {m.trend === "up" ? "↑" : m.trend === "down" ? "↓" : "↔"} {m.tf} {fresh ? `${m.signal} signal` : `fast ${side} slow`}
                {!fresh && m.last ? <b>{m.last.signal} {m.last.candlesAgo} ago</b> : null}
              </span>
            );
          })}
        </div>
      ) : (
        <div className="muted tiny">Not enough history yet for the two averages.</div>
      )}
    </div>
  );
}
