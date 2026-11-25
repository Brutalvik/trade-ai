// The browser tab: "T//R" and the account's profit or loss in dollars (the figure under EQUITY in
// the header), so it can be read with the app in the background. A page cannot set the colour or
// the weight of the text of its own tab (the browser draws it), so:
//  - the colour is carried by the tab's icon (the bolt turns green in profit, red at a loss, and
//    is its usual purple at exactly zero, signed out, or in real mode) and by a green or red dot
//    right before the amount;
//  - the digits are Unicode's bold digits, which browsers show in bold; the sign, the dollar sign
//    and the decimal point have no bold form and stay as they are;
//  - the gap after "T//R" is an em space, which browsers do not collapse.
const NAME = "TRADING//RUST";
const ICON = "/favicon.svg";
const UP = "#00f5a0", DOWN = "#ff3d71"; // the app's own green and red (--up, --down)
// The bolt's outline, from public/favicon.svg.
const BOLT = "M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z";

export type TabTone = "up" | "down" | "flat";
// Under half a cent either way reads $0.00, so it is neither a profit nor a loss.
export const tabTone = (pnl: number): TabTone => (pnl >= 0.005 ? "up" : pnl <= -0.005 ? "down" : "flat");
// 0-9 as bold digits (the sans-serif bold ones, which sit best beside a tab's own lettering).
export const boldDigits = (text: string) => text.replace(/[0-9]/g, (d) => String.fromCodePoint(0x1d7ec + Number(d)));
const GAP = "\u2003"; // an em space
const DOT = { up: "\u{1F7E2}", down: "\u{1F534}" }; // a green circle, a red circle
// "T//R  (green dot) +$1,234.56", "T//R  (red dot) -$23.40", "T//R  $0.00", the digits in bold
export function tabText(pnl: number): string {
  const tone = tabTone(pnl);
  const amount = boldDigits(tone === "flat" ? "0.00" : Math.abs(pnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return tone === "flat" ? `T//R${GAP}$${amount}` : `T//R${GAP}${DOT[tone]}\u00a0${tone === "up" ? "+" : "-"}$${amount}`;
}
export const tabIcon = (tone: TabTone): string =>
  tone === "flat" ? ICON : `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 46"><path fill="${tone === "up" ? UP : DOWN}" d="${BOLT}"/></svg>`)}`;

// pnl = the account's profit or loss in dollars; null = show the plain name and the usual icon.
export function showTab(pnl: number | null) {
  if (typeof document === "undefined") return;
  const title = pnl === null || !Number.isFinite(pnl) ? NAME : tabText(pnl);
  if (document.title !== title) document.title = title;
  const href = tabIcon(pnl === null || !Number.isFinite(pnl) ? "flat" : tabTone(pnl));
  const old = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (old?.getAttribute("href") === href) return;
  // A new element, not a changed address: some browsers only redraw the tab's icon for a new one.
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = href;
  old?.remove();
  document.head.appendChild(link);
}
