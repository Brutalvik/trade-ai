// The browser tab's text and icon (web/src/tabTitle.ts): "T//R" and the account's profit or loss
// in dollars; the icon is green in profit, red at a loss, and the usual one at zero.
import { check, expect, finish } from "../check.mts";
const { tabText, tabTone, tabIcon, showTab } = await import(new URL("../../../web/src/tabTitle.ts", import.meta.url).href);

expect("a profit: a plus sign and the amount to the cent, with thousands separated", [tabText(52.1), tabText(1234.567)], ["T//R +$52.10", "T//R +$1,234.57"]);
expect("a loss: a minus sign before the dollar sign", [tabText(-23.4), tabText(-9000)], ["T//R -$23.40", "T//R -$9,000.00"]);
expect("zero, and anything under half a cent either way, reads $0.00 with no sign", [tabText(0), tabText(0.004), tabText(-0.004)], ["T//R $0.00", "T//R $0.00", "T//R $0.00"]);
expect("the colour: green in profit, red at a loss, neither at zero", [tabTone(0.01), tabTone(-0.01), tabTone(0), tabTone(-0.004)], ["up", "down", "flat", "flat"]);
check("the icon is the app's green in profit and its red at a loss", decodeURIComponent(tabIcon("up")).includes('fill="#00f5a0"') && decodeURIComponent(tabIcon("down")).includes('fill="#ff3d71"') && tabIcon("up").startsWith("data:image/svg+xml,"), tabIcon("up").slice(0, 60));
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
  expect("in profit the tab reads T//R and the amount, with the green icon", [doc.title, head.length, decodeURIComponent(head[0].href).includes("#00f5a0")], ["T//R +$52.10", 1, true]);
  const same = head[0];
  showTab(60);
  expect("a new amount of the same colour changes the text and leaves the icon alone", [doc.title, head[0] === same], ["T//R +$60.00", true]);
  showTab(-5);
  expect("at a loss the icon turns red", [doc.title, head.length, decodeURIComponent(head[0].href).includes("#ff3d71")], ["T//R -$5.00", 1, true]);
  showTab(null);
  expect("signed out (or in real mode) the tab shows the plain name and the usual icon", [doc.title, head.length, head[0].href], ["TRADING//RUST", 1, "/favicon.svg"]);
  showTab(Number.NaN);
  expect("a figure that is not a number is never shown", doc.title, "TRADING//RUST");
  delete (globalThis as any).document;
}
finish();
