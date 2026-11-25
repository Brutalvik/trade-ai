// The colour of an agent's card while it is in a trade (web/src/tradeTone.ts): the colour of the
// profit or loss at the card's top right. Green at zero or more, red under zero, none out of a trade.
import { expect, finish } from "../check.mts";
const { tradeTone } = await import(new URL("../../../web/src/tradeTone.ts", import.meta.url).href);

expect("in a trade and in profit: green", [tradeTone(true, 2.26), tradeTone(true, 16.79), tradeTone(true, 0.01)], ["gain", "gain", "gain"]);
expect("in a trade and at a loss: red", [tradeTone(true, -0.87), tradeTone(true, -250), tradeTone(true, -0.01)], ["loss", "loss", "loss"]);
// The figure is drawn green from zero up ("+$0.00") and red under it, and the card goes with it.
expect("at zero the card is green, as its figure is; a hair under zero it is red, as its figure is", [tradeTone(true, 0), tradeTone(true, 0.004), tradeTone(true, -0.004)], ["gain", "gain", "loss"]);
expect("not in a trade: no colour, whatever the agent has made so far", [tradeTone(false, 26.04), tradeTone(false, -3), tradeTone(false, 0)], ["", "", ""]);
expect("no usable figure: no colour", [tradeTone(true, null), tradeTone(true, undefined), tradeTone(true, NaN)], ["", "", ""]);

finish();
