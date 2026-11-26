// The order of the agents' cards (web/src/cardOrder.ts): cards in a trade first, the highest
// profit at the top, by the figure at the card's top right; the rest after them, in the order
// they had. And the figure itself: closed trades since the agent started, plus the open trade now.
import { expect, finish } from "../check.mts";
const { agentMoney, cardOrder, heldOrder, HOLD_MS } = await import(new URL("../../../web/src/cardOrder.ts", import.meta.url).href);

const START = 1_000_000;
const slot = (id: string, startedAt = START) => ({ id, bot: { startedAt, running: true } });
// An open trade of $1,000 that is `pnl` dollars ahead (or behind) at the latest price.
const open = (botId: string | undefined, pnl: number) => ({ source: "bot", botId, qty: 1000, lastPrice: (1000 + pnl) / 1000, costUsd: 1000 });
const sold = (botId: string | undefined, pnlUsd: number, time = START + 60_000) => ({ source: "bot", botId, side: "SELL", time, pnlUsd });
const ids = (slots: { id: string }[], state: unknown) => cardOrder(slots, state).map((s: { id: string }) => s.id);
const four = [slot("1"), slot("2"), slot("3"), slot("4")];

// The user's own example: +68, then +42, then +3, then -24.
const positions = [open("1", -24), open("2", 3), open("3", 68), open("4", 42)];
expect("cards in a trade are listed by profit, the highest first: +68, +42, +3, -24", ids(four, { positions, trades: [] }), ["3", "4", "2", "1"]);
positions[0] = open("1", 55);
expect("when -24 turns into +55, that card moves up to second place", ids(four, { positions, trades: [] }), ["3", "1", "4", "2"]);
positions[2] = open("3", -5);
expect("and a card whose profit turns into a loss drops to the bottom of the cards in a trade", ids(four, { positions, trades: [] }), ["1", "4", "2", "3"]);

// Cards that are not in a trade.
expect(
  "cards not in a trade come after every card in a trade, in the order they had, whatever they have made so far",
  ids([slot("1"), slot("2"), slot("3"), slot("4"), slot("5")], { positions: [open("3", -10), open("5", 20)], trades: [sold("1", 500), sold("4", -80), sold("2", 30)] }),
  ["5", "3", "1", "2", "4"],
);
expect("with no card in a trade, the order is the one they had", ids(four, { positions: [], trades: [sold("3", 90), sold("1", -5)] }), ["1", "2", "3", "4"]);
expect("no account data yet: the order they had, and no error", [ids(four, null), ids([], null)], [["1", "2", "3", "4"], []]);

// The figure is the one at the card's top right: closed trades since the agent started, plus the open one.
const mixed = { positions: [open("1", -10), open("2", 42)], trades: [sold("1", 60), sold("1", 5, START - 1)] };
expect("the figure counts the agent's closed trades too, but not trades from before it was started", Math.round(agentMoney(slot("1"), mixed).pnl * 100) / 100, 50);
expect("so an agent that is +$60 from earlier trades and -$10 on its open one (+$50) is listed above a +$42", ids([slot("2"), slot("1")], mixed), ["1", "2"]);
expect("an agent in slot 1 owns the trades and positions that carry no agent number", ids([slot("1"), slot("2")], { positions: [open(undefined, 5), open("2", 9)], trades: [sold(undefined, 10)] }), ["1", "2"]);
expect("your own (manual) trades are never counted as an agent's", agentMoney(slot("1"), { positions: [{ ...open("1", 500), source: "manual" }], trades: [{ ...sold("1", 500), source: "manual" }] }).pnl, 0);

// Shown to the cent, compared to the cent.
expect("two cards showing the same amount keep the order they had (a difference under a cent moves nothing)", ids([slot("1"), slot("2"), slot("3")], { positions: [open("1", 3.001), open("2", 3.004), open("3", 3.0049)], trades: [] }), ["1", "2", "3"]);
expect("a difference of a cent is enough", ids([slot("1"), slot("2")], { positions: [open("1", 3.0), open("2", 3.01)], trades: [] }), ["2", "1"]);
const before = four.map((s) => s.id).join();
cardOrder(four, { positions, trades: [] });
expect("the list handed in is left as it was", four.map((s) => s.id).join(), before);

// While the pointer is on the cards they keep their places.
const want = [slot("3"), slot("1"), slot("4"), slot("2")];
const held = (shown: string[], wanted: { id: string }[]) => heldOrder(shown, wanted).map((s: { id: string }) => s.id);
expect("under the pointer the cards stay where they are shown, whatever the order by profit has become", held(["1", "2", "3", "4"], want), ["1", "2", "3", "4"]);
expect("a card whose agent has stopped drops out, the others keep their places", held(["1", "2", "3", "4"], [slot("3"), slot("4"), slot("2")]), ["2", "3", "4"]);
expect("an agent that has just started is added after the cards already shown", held(["1", "2"], want), ["1", "2", "3", "4"]);
expect("nothing shown yet: the order by profit", held([], want), ["3", "1", "4", "2"]);
expect("the cards it returns are the current ones, not stale copies", heldOrder(["1"], want)[0] === want[1], true);
expect("the cards are held for a moment after the pointer last moved (1.5 seconds)", HOLD_MS, 1500);

finish();
