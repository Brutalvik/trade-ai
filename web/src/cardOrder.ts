// The order of the agents' cards, and the figure it goes by.
//
// Cards whose agent is in a trade come first, the highest profit at the top, by the figure at
// the card's top right: +$68, then +$42, then +$3, then -$24. When a figure changes the card
// moves by itself, so a -$24 that turns into +$55 goes up to second place. Cards whose agent is
// not in a trade follow, in the order they always had (by agent number).
// Figures are compared as they are shown, to the cent: two cards that show the same amount keep
// the order they had, so cards never swap places over a difference nobody can see.
import type { AppState, BotSlot } from "./api";

type Slot = Pick<BotSlot, "id" | "bot">;
type Money = Pick<AppState, "positions" | "trades"> | null;

// What an agent has made or lost since it started: its closed trades, plus its open trade at the
// latest price. This is the figure at the top right of its card (what selling the open trade will
// cost is not taken off until it is sold). The card's colour and its place in the list both go by it.
export function agentMoney(slot: Slot, state: Money) {
  const since = slot.bot.startedAt ?? 0;
  const pos = state?.positions.find((p) => p.source === "bot" && (p.botId ?? "1") === slot.id);
  const trades = (state?.trades ?? []).filter((t) => t.source === "bot" && (t.botId ?? "1") === slot.id && t.time >= since);
  const sells = trades.filter((t) => t.side === "SELL");
  const realized = sells.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const pnl = realized + (pos ? pos.qty * pos.lastPrice - pos.costUsd : 0);
  return { since, pos, trades, sells, realized, pnl };
}

export function cardOrder<S extends Slot>(slots: S[], state: Money): S[] {
  const cents = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) : 0);
  return slots
    .map((slot, was) => {
      const m = agentMoney(slot, state);
      return { slot, was, inTrade: !!m.pos, cents: cents(m.pnl) };
    })
    .sort((a, b) => Number(b.inTrade) - Number(a.inTrade) || (a.inTrade ? b.cents - a.cents : 0) || a.was - b.was)
    .map((r) => r.slot);
}
