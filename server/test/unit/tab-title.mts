// The browser tab's text and icon (web/src/tabTitle.ts): "T//R" and the account's profit or loss
// in dollars; the icon is green in profit, red at a loss, and the usual one at zero.
import { check, expect, finish } from "../check.mts";
const { tabText, tabTone, tabIcon, showTab, boldDigits, pnlText } = await import(new URL("../../../web/src/tabTitle.ts", import.meta.url).href);
// The same figure under EQUITY in the header: always with its sign, and no sign at zero.
expect("under EQUITY: a profit has a plus, a loss a minus before the dollar sign, thousands are separated", [pnlText(64.41), pnlText(-11.22), pnlText(1234.567), pnlText(-9000)], ["+$64.41", "-$11.22", "+$1,234.57", "-$9,000.00"]);
expect("under EQUITY: zero, and anything under half a cent either way, reads $0.00 with no sign", [pnlText(0), pnlText(0.004), pnlText(-0.004)], ["$0.00", "$0.00", "$0.00"]);
// What the tab reads: "T//R", a wider gap, a green or red dot, then the amount with bold digits.
const B = boldDigits;
const up = (amount: string) => `T//R\u2003\u{1F7E2}\u00a0+$${B(amount)}`;
const down = (amount: string) => `T//R\u2003\u{1F534}\u00a0-$${B(amount)}`;
const zero = `T//R\u2003$${B("0.00")}`;
expect("the digits are Unicode's bold digits; signs and points are left as they are", [B("1,234.50"), [...B("0123456789")].length, B("+$-.,")], ["\u{1D7ED},\u{1D7EE}\u{1D7EF}\u{1D7F0}.\u{1D7F1}\u{1D7EC}", 10, "+$-.,"]);

expect("a profit: a green dot, a plus sign and the amount to the cent, with thousands separated", [tabText(52.1), tabText(1234.567)], [up("52.10"), up("1,234.57")]);
expect("a loss: a red dot, and a minus sign before the dollar sign", [tabText(-23.4), tabText(-9000)], [down("23.40"), down("9,000.00")]);
expect("zero, and anything under half a cent either way, reads $0.00 with no sign and no dot", [tabText(0), tabText(0.004), tabText(-0.004)], [zero, zero, zero]);
expect("the colour: green in profit, red at a loss, neither at zero", [tabTone(0.01), tabTone(-0.01), tabTone(0), tabTone(-0.004)], ["up", "down", "flat", "flat"]);
const upIcon = decodeURIComponent(tabIcon("up")), downIcon = decodeURIComponent(tabIcon("down"));
check("the icon is the logo in the app's green in profit and its red at a loss", upIcon.includes('stop-color="#00f5a0"') && !upIcon.includes("#ff3d71") && downIcon.includes('stop-color="#ff3d71"') && !downIcon.includes("#00f5a0") && tabIcon("up").startsWith("data:image/svg+xml,"), upIcon.slice(0, 80));
expect("...its two shapes, the same as the logo's", [upIcon.includes('d="M24 490 506 30V490Z"'), upIcon.includes('d="M530 30H1056L530 490Z"'), downIcon.includes('d="M24 490 506 30V490Z"')], [true, true, true]);
expect("at zero the usual icon is used", tabIcon("flat"), "/favicon.svg");

// In a page: the title and the icon follow the figure, and go back to the plain name.
{
  const head: any[] = [];
  const make = (href: string) => ({ rel: "icon", type: "", href, getAttribute(k: string) { return (this as any)[k]; }, remove() { head.splice(head.indexOf(this), 1); } });
  head.push(make("/favicon.svg"));
  (globalThis as any).document = {
    title: "TRADING//RUST",
    querySelector: () => head.find((l) => l.rel === "icon") ?? null,
    createElement: () => make(""),
    head: { appendChild: (l: any) => head.push(l) },
  };
  const doc = (globalThis as any).document;
  showTab(52.1);
  expect("in profit the tab reads T//R and the amount, with the green icon", [doc.title, head.length, decodeURIComponent(head[0].href).includes("#00f5a0")], [up("52.10"), 1, true]);
  const same = head[0];
  showTab(60);
  expect("a new amount of the same colour changes the text and leaves the icon alone", [doc.title, head[0] === same], [up("60.00"), true]);
  showTab(-5);
  expect("at a loss the icon turns red", [doc.title, head.length, decodeURIComponent(head[0].href).includes("#ff3d71")], [down("5.00"), 1, true]);
  showTab(null);
  expect("signed out (or in real mode) the tab shows the plain name and the usual icon", [doc.title, head.length, head[0].href], ["TRADING//RUST", 1, "/favicon.svg"]);
  showTab(Number.NaN);
  expect("a figure that is not a number is never shown", doc.title, "TRADING//RUST");
  delete (globalThis as any).document;
}
finish();
