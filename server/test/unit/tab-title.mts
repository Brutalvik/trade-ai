// The browser tab's text and icon (web/src/tabTitle.ts): "T//R" and the account's profit or loss
// in dollars; the icon is green in profit, red at a loss, and the usual one at zero.
import { check, expect, finish } from "../check.mts";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
const { tabText, tabTone, tabIcon, showTab, boldDigits, pnlText, ICON_SHAPES, ICON } = await import(new URL("../../../web/src/tabTitle.ts", import.meta.url).href);
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
const plain = readFileSync(new URL("../../../web/public/favicon.svg", import.meta.url), "utf8");
expect("...the same two shapes as the usual tab icon (public/favicon.svg)", [ICON_SHAPES.left, ICON_SHAPES.right].map((d) => [plain.includes(`d="${d}"`), upIcon.includes(`d="${d}"`), downIcon.includes(`d="${d}"`)]), [[true, true, true], [true, true, true]]);
expect("at zero the usual icon is used, at a new address so browsers fetch it again", [tabIcon("flat"), ICON], ["/favicon.svg?v=2", "/favicon.svg?v=2"]);

// The pages' own icons: the .svg at the same address, and the .ico named for 32 pixels only (named
// for 16, Chrome took the .ico over the .svg and showed the wide logo in it as a thin strip).
for (const page of ["index.html", "app/index.html"]) {
  const html = readFileSync(new URL(`../../../web/${page}`, import.meta.url), "utf8");
  const icons = [...html.matchAll(/<link rel="(?:[^"]*\s)?icon"[^>]*>/g)].map((m) => m[0]);
  expect(`${page}: the .svg and the .ico are named, the .ico for 32 pixels`, [icons.some((l) => l.includes(`href="${ICON}"`) && l.includes('type="image/svg+xml"')), icons.some((l) => l.includes('href="/favicon.ico?v=2"') && l.includes('sizes="32x32"')), icons.length], [true, true, 2]);
}
// favicon.ico holds the same icon as favicon.svg (web/scripts/favicon-ico.mjs draws it): in a
// 16 and a 32 pixel tab it is as wide as the tab and three quarters as tall (the svg's shapes are
// 100 wide and 76 tall), not the wide logo.
{
  const ico = readFileSync(new URL("../../../web/public/favicon.ico", import.meta.url));
  const frames = [...Array(ico.readUInt16LE(4)).keys()].map((i) => {
    const e = 6 + 16 * i, size = ico[e] || 256, png = ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8));
    const idat: Buffer[] = [];
    for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) if (png.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + png.readUInt32BE(at)));
    const raw = inflateSync(Buffer.concat(idat)), row = size * 4 + 1;
    const seen = (x: number, y: number) => raw[y * row + 1 + x * 4 + 3] > 20;
    const xs = [...Array(size).keys()].filter((x) => [...Array(size).keys()].some((y) => seen(x, y)));
    const ys = [...Array(size).keys()].filter((y) => [...Array(size).keys()].some((x) => seen(x, y)));
    return { size, png: png.subarray(1, 4).toString("ascii"), plain: [...Array(size).keys()].every((y) => raw[y * row] === 0), w: xs.at(-1)! - xs[0] + 1, h: ys.at(-1)! - ys[0] + 1 };
  });
  expect("favicon.ico: 16, 32, 48, 64, 128 and 256 pixel pictures, written by web/scripts/favicon-ico.mjs", frames.map((f) => [f.size, f.png, f.plain]), [16, 32, 48, 64, 128, 256].map((s) => [s, "PNG", true]));
  expect("...as wide as the tab and about three quarters as tall", frames.filter((f) => f.size <= 32).map((f) => [f.w, Math.abs(f.h - 0.76 * f.size) <= 2]), [[16, true], [32, true]]);
}

// In a page: the title and the icon follow the figure, and go back to the plain name.
{
  const head: any[] = [];
  const make = (href: string) => ({ rel: "icon", type: "", href, getAttribute(k: string) { return (this as any)[k]; }, remove() { head.splice(head.indexOf(this), 1); } });
  head.push(make("/favicon.ico?v=2"), make(ICON));
  (globalThis as any).document = {
    title: "TRADING//RUST",
    querySelectorAll: (sel: string) => (sel === 'link[rel~="icon"]' ? head.filter((l) => l.rel.split(/\s+/).includes("icon")) : []),
    createElement: () => make(""),
    head: { appendChild: (l: any) => head.push(l) },
  };
  const doc = (globalThis as any).document;
  showTab(52.1);
  expect("in profit the tab reads T//R and the amount, with the green icon in place of both of the page's own (the .ico too)", [doc.title, head.length, decodeURIComponent(head[0].href).includes("#00f5a0")], [up("52.10"), 1, true]);
  const same = head[0];
  showTab(60);
  expect("a new amount of the same colour changes the text and leaves the icon alone", [doc.title, head[0] === same], [up("60.00"), true]);
  showTab(-5);
  expect("at a loss the icon turns red", [doc.title, head.length, decodeURIComponent(head[0].href).includes("#ff3d71")], [down("5.00"), 1, true]);
  showTab(null);
  expect("signed out (or in real mode) the tab shows the plain name and the usual icon", [doc.title, head.length, head[0].href], ["TRADING//RUST", 1, ICON]);
  showTab(Number.NaN);
  expect("a figure that is not a number is never shown", doc.title, "TRADING//RUST");
  delete (globalThis as any).document;
}
finish();
