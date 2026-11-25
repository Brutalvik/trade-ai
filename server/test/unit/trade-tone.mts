// The colour of an agent's card while it is in a trade (web/src/tradeTone.ts): green while the
// trade is ahead after fees, red while it is behind, neither when it is level or there is no trade.
import { expect, finish } from "../check.mts";
const { tradeTone } = await import(new URL("../../../web/src/tradeTone.ts", import.meta.url).href);

expect("ahead after fees: green", [tradeTone(1), tradeTone(0.1), tradeTone(37.26)], ["gain", "gain", "gain"]);
expect("behind after fees: red (a trade just bought is behind by its costs)", [tradeTone(-1.2), tradeTone(-0.1), tradeTone(-99.98)], ["loss", "loss", "loss"]);
// The card prints the figure with one decimal, and the colour goes by what is printed.
expect("a figure the card prints as 0.0% has no colour, whichever side of zero it is on", [tradeTone(0), tradeTone(0.04), tradeTone(-0.04)], ["", "", ""]);
expect("...and the first figure that prints as 0.1% has one", [tradeTone(0.06), tradeTone(-0.06)], ["gain", "loss"]);
expect("no trade, or no usable figure: no colour", [tradeTone(null), tradeTone(undefined), tradeTone(NaN), tradeTone(Infinity)], ["", "", "", ""]);

finish();
