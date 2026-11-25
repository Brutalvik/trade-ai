// The colour of an agent's card while it is in a trade. It is the colour of the figure at the
// card's top right, the agent's profit or loss so far (its closed trades plus the open one at
// the current price): green when that figure is zero or more, red when it is under zero. The two
// are judged the same way, so the card never disagrees with its own number. A card whose agent is
// not in a trade has no colour.
// (v0.67.1 judged the open trade's result after the cost of selling it; a trade a little over
// its buy price then showed a green "+$2.26" on a red card, which read as a mistake.)
export type TradeTone = "gain" | "loss" | "";

export function tradeTone(inTrade: boolean, pnlUsd: number | null | undefined): TradeTone {
  if (!inTrade || typeof pnlUsd !== "number" || !Number.isFinite(pnlUsd)) return "";
  return pnlUsd >= 0 ? "gain" : "loss";
}
