// The browser tab: "T//R" and the account's profit or loss in dollars (the figure under EQUITY in
// the header), so it can be read with the app in the background. A page cannot set the colour or
// the weight of the text of its own tab (the browser draws it), so:
//  - the colour is carried by the tab's icon (the logo turns green in profit, red at a loss, and
//    is its usual cyan and blue at exactly zero, signed out, or in real mode) and by a green or red
//    dot right before the amount;
//  - the digits are Unicode's bold digits, which browsers show in bold; the sign, the dollar sign
//    and the decimal point have no bold form and stay as they are;
//  - the gap after "T//R" is an em space, which browsers do not collapse.
const NAME = "TRADING//RUST";
// "?v=2": a new address, so browsers fetch the icon again instead of showing the one they stored
// (the pages' heads, index.html and app/index.html, use the same). public/favicon.ico is drawn
// from favicon.svg by web/scripts/favicon-ico.mjs.
export const ICON = "/favicon.svg?v=2";
const UP = "#00f5a0", DOWN = "#ff3d71"; // the app's own green and red (--up, --down)
// The tab's version of the logo (public/favicon.svg): the same two shapes with the same gap, drawn
// steeper so they fill a square tab (the full logo, public/logo.svg, is twice as wide as it is tall
// and would be a thin strip there). Each in a light-to-deep gradient of one colour, as the logo is
// in cyan and blue: [light, middle, deep] for each of its two shapes.
export const ICON_SHAPES = { left: "M0 76 47 0V76Z", right: "M53 0H100L53 76Z" };
const SHADES = {
  up: { left: ["#8dffd6", UP, "#00a866"], right: ["#3dfcc0", "#00dc92", "#00995f"] },
  down: { left: ["#ffa3b9", DOWN, "#c20f3d"], right: ["#ff7a9b", "#f5285f", "#b30c39"] },
};
const logoIcon = (tone: "up" | "down") => {
  const g = (id: string, x2: string, [a, b, c]: string[]) => `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".48" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`;
  const s = SHADES[tone];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -12 100 100"><defs>${g("l", "1", s.left)}${g("r", ".7", s.right)}</defs><path d="${ICON_SHAPES.left}" fill="url(#l)"/><path d="${ICON_SHAPES.right}" fill="url(#r)"/></svg>`;
};

export type TabTone = "up" | "down" | "flat";
// Under half a cent either way reads $0.00, so it is neither a profit nor a loss.
export const tabTone = (pnl: number): TabTone => (pnl >= 0.005 ? "up" : pnl <= -0.005 ? "down" : "flat");
// 0-9 as bold digits (the sans-serif bold ones, which sit best beside a tab's own lettering).
export const boldDigits = (text: string) => text.replace(/[0-9]/g, (d) => String.fromCodePoint(0x1d7ec + Number(d)));
const GAP = "\u2003"; // an em space
const DOT = { up: "\u{1F7E2}", down: "\u{1F534}" }; // a green circle, a red circle
// "T//R  (green dot) +$1,234.56", "T//R  (red dot) -$23.40", "T//R  $0.00", the digits in bold
// sym = the shown currency's symbol (the amount is already in that currency: api.ts fromUsd).
export function tabText(pnl: number, sym = "$"): string {
  const tone = tabTone(pnl);
  const amount = boldDigits(tone === "flat" ? "0.00" : Math.abs(pnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return tone === "flat" ? `T//R${GAP}${sym}${amount}` : `T//R${GAP}${DOT[tone]}\u00a0${tone === "up" ? "+" : "-"}${sym}${amount}`;
}
// The same figure as the header prints it under EQUITY: always with its sign ("+$1,234.56",
// "-$23.40"), and "$0.00" with none when it is under half a cent either way.
export function pnlText(pnl: number, sym = "$"): string {
  const tone = tabTone(pnl);
  const amount = (tone === "flat" ? 0 : Math.abs(pnl)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${tone === "up" ? "+" : tone === "down" ? "-" : ""}${sym}${amount}`;
}
export const tabIcon = (tone: TabTone): string =>
  tone === "flat" ? ICON : `data:image/svg+xml,${encodeURIComponent(logoIcon(tone))}`;

// pnl = the account's profit or loss in dollars; null = show the plain name and the usual icon.
export function showTab(pnl: number | null, sym = "$") {
  if (typeof document === "undefined") return;
  const title = pnl === null || !Number.isFinite(pnl) ? NAME : tabText(pnl, sym);
  if (document.title !== title) document.title = title;
  const href = tabIcon(pnl === null || !Number.isFinite(pnl) ? "flat" : tabTone(pnl));
  // Every icon the page names (the .svg and the .ico; not the apple-touch-icon): with the .ico still
  // there, a browser may keep showing it instead of the green or red one.
  const icons = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
  if (icons.length === 1 && icons[0].getAttribute("href") === href) return;
  // A new element, not a changed address: some browsers only redraw the tab's icon for a new one.
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = href;
  for (const old of icons) old.remove();
  document.head.appendChild(link);
}
