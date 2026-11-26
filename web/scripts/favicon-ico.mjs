// Writes web/public/favicon.ico from the tab's version of the logo, web/public/favicon.svg: the
// same shapes and gradients, drawn at 16, 32, 48, 64, 128 and 256 pixels. Browsers that pick the
// .ico over the .svg (Chrome did, with the full wide logo in it: a thin strip in the tab) then show
// the same icon. Run it after changing favicon.svg:  node web/scripts/favicon-ico.mjs
// It reads only what favicon.svg uses: a viewBox, paths made of M, L, H, V and Z with absolute
// numbers, and linear gradients over each shape's own box (the SVG default).
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const svgFile = new URL("../public/favicon.svg", import.meta.url);
const icoFile = new URL("../public/favicon.ico", import.meta.url);
const SIZES = [16, 32, 48, 64, 128, 256];

const svg = readFileSync(svgFile, "utf8");
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const [vx, vy, vw, vh] = attr(svg.match(/<svg[^>]*>/)[0], "viewBox").split(/[\s,]+/).map(Number);

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const gradients = {};
for (const m of svg.matchAll(/<linearGradient([^>]*)>([\s\S]*?)<\/linearGradient>/g)) {
  const n = (k, d) => Number(attr(m[1], k) ?? d);
  gradients[attr(m[1], "id")] = {
    from: [n("x1", 0), n("y1", 0)],
    to: [n("x2", 1), n("y2", 0)],
    stops: [...m[2].matchAll(/<stop[^>]*>/g)].map((s) => [Number(attr(s[0], "offset")), hex(attr(s[0], "stop-color"))]),
  };
}

const polygon = (d) => {
  const pts = [];
  let x = 0, y = 0, cmd = "";
  const t = d.match(/[MLHVZ]|-?[\d.]+/gi);
  for (let i = 0; i < t.length; ) {
    if (/[A-Z]/i.test(t[i])) cmd = t[i++].toUpperCase();
    if (cmd === "Z") continue;
    if (cmd === "H") x = Number(t[i++]);
    else if (cmd === "V") y = Number(t[i++]);
    else if (cmd === "M" || cmd === "L") { x = Number(t[i++]); y = Number(t[i++]); if (cmd === "M") cmd = "L"; }
    else throw new Error(`favicon.svg: path command ${cmd} is not handled here`);
    pts.push([x, y]);
  }
  return pts;
};
const shapes = [...svg.matchAll(/<path[^>]*>/g)].map((p) => {
  const pts = polygon(attr(p[0], "d"));
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  return { pts, box, gradient: gradients[attr(p[0], "fill").match(/#([^)]+)/)[1]] };
});

const inside = (pts, x, y) => {
  let ins = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
};
const colour = ({ box: [bx, by, bw, bh], gradient: { from, to, stops } }, x, y) => {
  const u = (x - bx) / bw, v = (y - by) / bh, dx = to[0] - from[0], dy = to[1] - from[1];
  const t = Math.min(1, Math.max(0, ((u - from[0]) * dx + (v - from[1]) * dy) / (dx * dx + dy * dy)));
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < t) i++;
  const [o0, c0] = stops[i - 1], [o1, c1] = stops[i];
  const f = o1 > o0 ? Math.min(1, Math.max(0, (t - o0) / (o1 - o0))) : 1;
  return c0.map((c, k) => c + (c1[k] - c) * f);
};

// Each pixel is the average of k x k points inside it: the share that falls on a shape is its
// opacity, and their average colour is its colour.
const draw = (size) => {
  const k = size <= 64 ? 16 : 4;
  const px = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let hits = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          const x = vx + ((pxl + (j + 0.5) / k) / size) * vw, y = vy + ((py + (i + 0.5) / k) / size) * vh;
          const s = shapes.find((sh) => inside(sh.pts, x, y));
          if (!s) continue;
          const c = colour(s, x, y);
          hits++; r += c[0]; g += c[1]; b += c[2];
        }
      }
      const at = py * (size * 4 + 1) + 1 + pxl * 4;
      if (hits) px.set([Math.round(r / hits), Math.round(g / hits), Math.round(b / hits), Math.round((255 * hits) / (k * k))], at);
    }
  }
  return px; // rows, each after a 0 (no filter)
};

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
};
const png = (size) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(draw(size), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
};

const images = SIZES.map(png);
const head = Buffer.alloc(6 + 16 * images.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(images.length, 4);
let offset = head.length;
images.forEach((img, i) => {
  const e = 6 + 16 * i, s = SIZES[i] === 256 ? 0 : SIZES[i];
  head.set([s, s, 0, 0], e);
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(img.length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += img.length;
});
writeFileSync(icoFile, Buffer.concat([head, ...images]));
console.log(`favicon.ico: ${SIZES.join(", ")} px, ${offset} bytes, from favicon.svg (${shapes.length} shapes)`);
