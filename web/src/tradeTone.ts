// The colour of an agent's card while it is in a trade: "gain" while the trade is ahead after
// fees, "loss" while it is behind, "" when it is level or there is no trade. It is judged on the
// figure as the card prints it (one decimal), so a card whose text reads "+0.0%" is not coloured
// either way, and the colour never disagrees with the number next to it.
export type TradeTone = "gain" | "loss" | "";

export function tradeTone(netPct: number | null | undefined): TradeTone {
  if (typeof netPct !== "number" || !Number.isFinite(netPct)) return "";
  const shown = Number(netPct.toFixed(1));
  return shown > 0 ? "gain" : shown < 0 ? "loss" : "";
}
