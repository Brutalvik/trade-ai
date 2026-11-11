// Trade history export: CSV (all fields) and a designed PDF report (summary cards + table).
// The PDF is built in the browser with jsPDF, loaded only when someone exports.
import type { RealTrade, Trade } from "./api";

type Who = { username?: string; name?: string };

// ---------- shared helpers ----------
const save = (blob: Blob, filename: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
const stamp = () => new Date().toISOString().slice(0, 10);
const esc = (v: unknown) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(esc).join(",")).join("\n"); // BOM: Excel opens UTF-8 correctly

const usd = (v: number, d = 2) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const signed = (v: number) => `${v > 0 ? "+" : ""}${usd(v)}`;
const price = (p: number) => {
  if (!p) return "$0";
  if (p >= 1) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${p.toFixed(Math.min(12, Math.max(2, -Math.floor(Math.log10(p)) + 3)))}`;
};
const qty = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));
const when = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
// The PDF's built-in font covers Latin text only: swap common symbols, drop the rest.
const pdfText = (s: string) =>
  s.replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...").replace(/≈/g, "~").replace(/×/g, "x").replace(/[^\x20-\x7E\xA0-\xFF]/g, "").trim();

// ---------- CSV ----------
export function paperCsv(trades: Trade[]) {
  const head = ["time_utc", "side", "token", "pool", "price_usd", "qty", "usd", "dex_fee_usd", "platform_fee_usd", "pnl_usd", "by", "bot", "ai_predicted_win_pct", "reached_target", "reason"];
  const rows = trades.map((t) => [new Date(t.time).toISOString(), t.side, t.symbol, t.pool, t.price, t.qty, t.usd.toFixed(2), t.feeUsd.toFixed(4), (t.platformFeeUsd ?? 0).toFixed(4), t.pnlUsd?.toFixed(2) ?? "", t.source, t.source === "bot" ? (t.botId ?? "1") : "", t.predictedWinPct ?? "", t.reachedTarget === undefined ? "" : t.reachedTarget ? "yes" : "no", t.reason]);
  save(new Blob([csv([head, ...rows])], { type: "text/csv;charset=utf-8" }), `trading-rust-paper-trades-${stamp()}.csv`);
}
export function realCsv(trades: RealTrade[]) {
  const head = ["time_utc", "side", "token", "mint", "paid", "paid_token", "received", "received_token", "usd_estimate", "status", "platform_fee_bps", "signature", "solscan", "error"];
  const rows = trades.map((t) => [new Date(t.t).toISOString(), t.side, t.symbol, t.mint, t.inAmount, t.inSymbol, t.status === "Success" ? t.outAmount : "", t.outSymbol, t.usd?.toFixed(2) ?? "", t.status, t.feeBps, t.signature ?? "", t.signature ? `https://solscan.io/tx/${t.signature}` : "", t.error ?? ""]);
  save(new Blob([csv([head, ...rows])], { type: "text/csv;charset=utf-8" }), `trading-rust-real-trades-${stamp()}.csv`);
}

// ---------- PDF ----------
const C = {
  ink: [15, 23, 42] as const, // slate-900
  sub: [100, 116, 139] as const, // slate-500
  line: [226, 232, 240] as const,
  card: [246, 248, 252] as const,
  navy: [8, 13, 30] as const,
  navy2: [17, 26, 52] as const,
  cyan: [0, 200, 230] as const,
  green: [0, 168, 120] as const,
  red: [226, 54, 96] as const,
  amber: [214, 150, 20] as const,
  white: [255, 255, 255] as const,
};
type RGB = readonly [number, number, number];

async function newDoc() {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  return { doc, autoTable };
}

type Doc = Awaited<ReturnType<typeof newDoc>>["doc"];
const fill = (doc: Doc, c: RGB) => doc.setFillColor(c[0], c[1], c[2]);
const color = (doc: Doc, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

function brand(doc: Doc, x: number, y: number, size: number) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(size);
  color(doc, C.white);
  doc.text("TRADING", x, y);
  const w1 = doc.getTextWidth("TRADING");
  color(doc, C.cyan);
  doc.text("//", x + w1, y);
  const w2 = doc.getTextWidth("//");
  color(doc, C.white);
  doc.text("RUST", x + w1 + w2, y);
}

// Big header on page 1; slim header on the following pages.
function header(doc: Doc, title: string, badge: string, who: Who, first: boolean) {
  const W = doc.internal.pageSize.getWidth();
  if (first) {
    fill(doc, C.navy);
    doc.rect(0, 0, W, 92, "F");
    fill(doc, C.cyan);
    doc.rect(0, 92, W, 2.5, "F");
    // logo mark
    fill(doc, C.cyan);
    doc.triangle(40, 54, 52, 34, 64, 54, "F");
    fill(doc, C.navy2);
    doc.triangle(50, 54, 58, 41, 66, 54, "F");
    brand(doc, 74, 52, 20);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    color(doc, [170, 186, 214]);
    doc.text("AI crypto trading", 74, 66);
    // title block (right)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    color(doc, C.white);
    doc.text(title, W - 40, 46, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    color(doc, [170, 186, 214]);
    const sub = [who.name ? pdfText(who.name) : "", who.username ? `@${who.username}` : "", `Generated ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`].filter(Boolean).join("  ·  ");
    doc.text(sub, W - 40, 64, { align: "right" });
    // badge
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    const bw = doc.getTextWidth(badge) + 16;
    const paper = badge.startsWith("PAPER");
    { const c = paper ? C.amber : C.green; doc.setDrawColor(c[0], c[1], c[2]); }
    doc.setLineWidth(0.8);
    doc.roundedRect(W - 40 - bw, 72, bw, 14, 7, 7, "S");
    color(doc, paper ? C.amber : C.green);
    doc.text(badge, W - 40 - bw / 2, 81.5, { align: "center" });
  } else {
    fill(doc, C.navy);
    doc.rect(0, 0, W, 34, "F");
    brand(doc, 40, 22, 11);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    color(doc, [170, 186, 214]);
    doc.text(`${title}  ·  ${badge}`, W - 40, 22, { align: "right" });
  }
}

function footers(doc: Doc, note: string) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(C.line[0], C.line[1], C.line[2]);
    doc.setLineWidth(0.6);
    doc.line(40, H - 30, W - 40, H - 30);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    color(doc, C.sub);
    doc.text(`TRADING//RUST  ·  ${note}`, 40, H - 17);
    doc.text(`Page ${i} of ${n}`, W - 40, H - 17, { align: "right" });
  }
}

type Card = { label: string; value: string; sub?: string; tone?: "up" | "down" | "plain" };
function cards(doc: Doc, y: number, items: Card[]) {
  const W = doc.internal.pageSize.getWidth();
  const gap = 10;
  const w = (W - 80 - gap * (items.length - 1)) / items.length;
  items.forEach((c, i) => {
    const x = 40 + i * (w + gap);
    fill(doc, C.card);
    doc.setDrawColor(C.line[0], C.line[1], C.line[2]);
    doc.setLineWidth(0.6);
    doc.roundedRect(x, y, w, 58, 8, 8, "FD");
    // accent bar
    fill(doc, c.tone === "up" ? C.green : c.tone === "down" ? C.red : C.cyan);
    doc.roundedRect(x, y, 3, 58, 1.5, 1.5, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    color(doc, C.sub);
    doc.text(c.label.toUpperCase(), x + 14, y + 17);
    doc.setFontSize(15);
    color(doc, c.tone === "up" ? C.green : c.tone === "down" ? C.red : C.ink);
    doc.text(c.value, x + 14, y + 37);
    if (c.sub) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      color(doc, C.sub);
      doc.text(c.sub, x + 14, y + 50);
    }
  });
  return y + 58;
}

function sectionTitle(doc: Doc, y: number, text: string, right?: string) {
  const W = doc.internal.pageSize.getWidth();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  color(doc, C.ink);
  doc.text(text, 40, y);
  if (right) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    color(doc, C.sub);
    doc.text(right, W - 40, y, { align: "right" });
  }
}

const tableStyle = {
  theme: "plain" as const,
  margin: { left: 40, right: 40, top: 50, bottom: 44 },
  styles: { font: "helvetica", fontSize: 8, cellPadding: { top: 6, bottom: 6, left: 6, right: 6 }, textColor: [30, 41, 59] as [number, number, number], lineColor: [226, 232, 240] as [number, number, number], lineWidth: { bottom: 0.5 } },
  headStyles: { fillColor: [17, 26, 52] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontStyle: "bold" as const, fontSize: 7.5, cellPadding: { top: 7, bottom: 7, left: 6, right: 6 } },
  alternateRowStyles: { fillColor: [248, 250, 253] as [number, number, number] },
};

export async function paperPdf(trades: Trade[], who: Who) {
  const { doc, autoTable } = await newDoc();
  const rows = [...trades].sort((a, b) => b.time - a.time);
  const closed = rows.filter((t) => t.pnlUsd != null);
  const wins = closed.filter((t) => (t.pnlUsd ?? 0) > 0);
  const pnl = closed.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const fees = rows.reduce((s, t) => s + t.feeUsd + (t.platformFeeUsd ?? 0), 0);
  const volume = rows.reduce((s, t) => s + t.usd, 0);
  const bot = closed.filter((t) => t.source === "bot").reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const manual = pnl - bot;
  const best = closed.reduce<Trade | null>((b, t) => (!b || (t.pnlUsd ?? 0) > (b.pnlUsd ?? 0) ? t : b), null);
  const worst = closed.reduce<Trade | null>((b, t) => (!b || (t.pnlUsd ?? 0) < (b.pnlUsd ?? 0) ? t : b), null);
  const avgWin = wins.length ? wins.reduce((s, t) => s + (t.pnlUsd ?? 0), 0) / wins.length : 0;
  const losses = closed.filter((t) => (t.pnlUsd ?? 0) < 0);
  const avgLoss = losses.length ? losses.reduce((s, t) => s + (t.pnlUsd ?? 0), 0) / losses.length : 0;

  header(doc, "Trade history", "PAPER ACCOUNT", who, true);
  const period = rows.length ? `${day(rows[rows.length - 1].time)} - ${day(rows[0].time)}` : "No trades";
  sectionTitle(doc, 122, "Summary", `${period}  ·  ${rows.length} trades`);
  let y = cards(doc, 132, [
    { label: "Net P&L", value: signed(pnl), sub: `bot ${signed(bot)}  ·  manual ${signed(manual)}`, tone: pnl >= 0 ? "up" : "down" },
    { label: "Win rate", value: closed.length ? `${Math.round((wins.length / closed.length) * 100)}%` : "-", sub: `${wins.length} of ${closed.length} closed trades` },
    { label: "Avg win / loss", value: `${usd(avgWin, 0)} / ${usd(Math.abs(avgLoss), 0)}`, sub: avgLoss ? `ratio ${(avgWin / Math.abs(avgLoss)).toFixed(2)}x` : undefined },
    { label: "Volume traded", value: usd(volume, 0), sub: `${rows.filter((t) => t.side === "BUY").length} buys  ·  ${rows.filter((t) => t.side === "SELL").length} sells` },
    { label: "Fees paid", value: usd(fees), sub: volume ? `${((fees / volume) * 100).toFixed(2)}% of volume` : undefined },
  ]);
  if (best && worst) {
    y = cards(doc, y + 10, [
      { label: "Best trade", value: signed(best.pnlUsd ?? 0), sub: `${pdfText(best.symbol)}  ·  ${when(best.time)}`, tone: "up" },
      { label: "Worst trade", value: signed(worst.pnlUsd ?? 0), sub: `${pdfText(worst.symbol)}  ·  ${when(worst.time)}`, tone: "down" },
    ]);
  }
  sectionTitle(doc, y + 26, "All trades", "Newest first");

  autoTable(doc, {
    ...tableStyle,
    startY: y + 34,
    head: [["Date", "Side", "Token", "Price", "Amount", "Value", "Fees", "P&L", "By", "Reason"]],
    body: rows.map((t) => [when(t.time), t.side, pdfText(t.symbol) || "?", price(t.price), qty(t.qty), usd(t.usd), usd(t.feeUsd + (t.platformFeeUsd ?? 0)), t.pnlUsd == null ? "-" : signed(t.pnlUsd), t.source === "bot" ? "Bot" : "Manual", pdfText(t.reason).replace(/^AI plan: /, "Plan: ")]),
    columnStyles: {
      0: { cellWidth: 90 }, 1: { cellWidth: 36, fontStyle: "bold" }, 2: { cellWidth: 62, fontStyle: "bold" },
      3: { halign: "right", cellWidth: 66 }, 4: { halign: "right", cellWidth: 66 }, 5: { halign: "right", cellWidth: 62 },
      6: { halign: "right", cellWidth: 48 }, 7: { halign: "right", cellWidth: 62, fontStyle: "bold" }, 8: { cellWidth: 42 }, 9: { textColor: [100, 116, 139] },
    },
    didParseCell: (d) => {
      if (d.section !== "body") return;
      const t = rows[d.row.index];
      if (d.column.index === 1) d.cell.styles.textColor = t.side === "BUY" ? [0, 168, 120] : [226, 54, 96];
      if (d.column.index === 7 && t.pnlUsd != null) d.cell.styles.textColor = t.pnlUsd >= 0 ? [0, 168, 120] : [226, 54, 96];
    },
    didDrawPage: (d) => { if (d.pageNumber > 1) header(doc, "Trade history", "PAPER ACCOUNT", who, false); },
  });
  footers(doc, "Paper trading: practice money, not real trades  ·  Not financial advice");
  doc.save(`trading-rust-paper-trades-${stamp()}.pdf`);
}

export async function realPdf(trades: RealTrade[], who: Who) {
  const { doc, autoTable } = await newDoc();
  const rows = [...trades].sort((a, b) => b.t - a.t);
  const ok = rows.filter((t) => t.status === "Success");
  const volume = ok.reduce((s, t) => s + (t.usd ?? 0), 0);
  header(doc, "Trade history", "REAL WALLET", who, true);
  const period = rows.length ? `${day(rows[rows.length - 1].t)} - ${day(rows[0].t)}` : "No trades";
  sectionTitle(doc, 122, "Summary", `${period}  ·  ${rows.length} trades`);
  const y = cards(doc, 132, [
    { label: "Trades", value: String(rows.length), sub: `${ok.filter((t) => t.side === "BUY").length} buys  ·  ${ok.filter((t) => t.side === "SELL").length} sells` },
    { label: "Completed", value: String(ok.length), sub: rows.length ? `${Math.round((ok.length / rows.length) * 100)}% of attempts` : undefined, tone: "up" },
    { label: "Failed", value: String(rows.length - ok.length), sub: "nothing moved on failed swaps", tone: rows.length - ok.length ? "down" : "plain" },
    { label: "Volume (approx.)", value: usd(volume, 0), sub: "USD value at quote time" },
  ]);
  sectionTitle(doc, y + 26, "All swaps", "Each completed swap can be checked on solscan.io");
  autoTable(doc, {
    ...tableStyle,
    startY: y + 34,
    head: [["Date", "Side", "Token", "Paid", "Received", "Value", "Status", "Transaction"]],
    body: rows.map((t) => [when(t.t), t.side, pdfText(t.symbol) || "?", `${qty(t.inAmount)} ${pdfText(t.inSymbol)}`, t.status === "Success" ? `${qty(t.outAmount)} ${pdfText(t.outSymbol)}` : "-", t.usd == null ? "-" : usd(t.usd), t.status === "Success" ? "Done" : `Failed${t.error ? `: ${pdfText(t.error).slice(0, 40)}` : ""}`, t.signature ? `${t.signature.slice(0, 10)}...${t.signature.slice(-6)}` : "-"]),
    columnStyles: { 0: { cellWidth: 90 }, 1: { cellWidth: 38, fontStyle: "bold" }, 2: { cellWidth: 70, fontStyle: "bold" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right", cellWidth: 64 }, 6: { cellWidth: 110 }, 7: { cellWidth: 120, textColor: [0, 140, 190] } },
    didParseCell: (d) => {
      if (d.section !== "body") return;
      const t = rows[d.row.index];
      if (d.column.index === 1) d.cell.styles.textColor = t.side === "BUY" ? [0, 168, 120] : [226, 54, 96];
      if (d.column.index === 6) d.cell.styles.textColor = t.status === "Success" ? [0, 168, 120] : [226, 54, 96];
    },
    didDrawCell: (d) => {
      // Make the transaction column a clickable Solscan link.
      const t = rows[d.row.index];
      if (d.section === "body" && d.column.index === 7 && t?.signature) doc.link(d.cell.x, d.cell.y, d.cell.width, d.cell.height, { url: `https://solscan.io/tx/${t.signature}` });
    },
    didDrawPage: (d) => { if (d.pageNumber > 1) header(doc, "Trade history", "REAL WALLET", who, false); },
  });
  footers(doc, "Real swaps from your own Solana wallet  ·  Not financial advice");
  doc.save(`trading-rust-real-trades-${stamp()}.pdf`);
}
