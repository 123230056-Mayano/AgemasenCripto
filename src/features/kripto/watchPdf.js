"use strict";

/**
 * features/kripto/watchPdf.js
 * ------------------------------------------------------------------
 * PDF watchlist: semua koin dalam satu dokumen (A4, multi-halaman, header tabel diulang).
 * Dipakai !watchlist saat koin lebih banyak dari WATCH_PDF_MIN atau saat user minta "!watchlist pdf".
 * Pakai pdf-lib + Helvetica (sama dengan analisisPdf.js), jadi tanpa dependensi baru.
 * Helvetica cuma Latin (WinAnsi): nama koin dibersihkan dulu lewat clean().
 */

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { fmtUsd, fmtPct } = require("./market");

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const ROW_H = 15;
const HEAD_H = 18;

const C = {
  ink: rgb(0.1, 0.12, 0.16),
  muted: rgb(0.42, 0.45, 0.5),
  line: rgb(0.87, 0.88, 0.9),
  zebra: rgb(0.965, 0.972, 0.98),
  head: rgb(0.07, 0.11, 0.2),
  white: rgb(1, 1, 1),
  bullish: rgb(0.09, 0.55, 0.3),
  bearish: rgb(0.8, 0.18, 0.18),
  sideways: rgb(0.55, 0.45, 0.1),
  nodata: rgb(0.5, 0.5, 0.5),
};

const L = {
  id: {
    title: "Watchlist Kripto",
    sub: (n, tf, date) => `${n} koin | Tren ${tf} | ${date} WIB`,
    cols: ["No", "Koin", "Nama", "Harga (USD)", "24 jam", "Tren"],
    trend: { bullish: "Bullish", bearish: "Bearish", sideways: "Sideways", nodata: "Data kurang" },
    error: "Data gagal diambil",
    summary: (s) => `Bullish ${s.bullish} | Bearish ${s.bearish} | Sideways ${s.sideways} | Data kurang ${s.nodata}` + (s.error ? ` | Gagal ${s.error}` : ""),
    updown: (s) => `24 jam: ${s.up} naik | ${s.down} turun`,
    limited: "* Tren memakai EMA yang tersedia (candle kurang dari 200), bukan EMA 200 penuh.",
    foot: "Tren dari EMA 20/50/200 candle closed. Edukasi, bukan ajakan beli/jual.",
    page: (p, n) => `Hal. ${p}/${n}`,
  },
  en: {
    title: "Crypto Watchlist",
    sub: (n, tf, date) => `${n} coins | ${tf} trend | ${date} WIB`,
    cols: ["No", "Coin", "Name", "Price (USD)", "24h", "Trend"],
    trend: { bullish: "Bullish", bearish: "Bearish", sideways: "Sideways", nodata: "Not enough data" },
    error: "Failed to load",
    summary: (s) => `Bullish ${s.bullish} | Bearish ${s.bearish} | Sideways ${s.sideways} | No data ${s.nodata}` + (s.error ? ` | Failed ${s.error}` : ""),
    updown: (s) => `24h: ${s.up} up | ${s.down} down`,
    limited: "* Trend uses the EMAs available (under 200 candles), not the full EMA 200.",
    foot: "Trend from EMA 20/50/200 on closed candles. Educational, not buy/sell advice.",
    page: (p, n) => `Page ${p}/${n}`,
  },
};

function makeCleaner(font) {
  const ok = new Map();
  const canEncode = (ch) => {
    if (!ok.has(ch)) {
      let r = true;
      try {
        font.encodeText(ch);
      } catch {
        r = false;
      }
      ok.set(ch, r);
    }
    return ok.get(ch);
  };
  return (s) => {
    let out = "";
    for (const ch of String(s ?? "").replace(/\r?\n+/g, " ")) out += canEncode(ch) ? ch : /\s/.test(ch) ? " " : "";
    return out.replace(/ {2,}/g, " ").trim();
  };
}

/** Hitung ringkasan dari baris data (dipakai PDF dan teks ringkas). */
function summarize(rows) {
  const s = { bullish: 0, bearish: 0, sideways: 0, nodata: 0, error: 0, up: 0, down: 0 };
  for (const r of rows) {
    if (r.error) {
      s.error++;
      continue;
    }
    s[r.trend in s ? r.trend : "nodata"]++;
    if (typeof r.pct === "number" && isFinite(r.pct)) {
      if (r.pct > 0) s.up++;
      else if (r.pct < 0) s.down++;
    }
  }
  return s;
}

const wibStamp = () =>
  new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * @param {{rows: Array<{coin,name?,price?,pct?,trend?,limited?,error?}>, tf: string, lang?: string}} p
 * @returns {Promise<Buffer>}
 */
async function buildWatchlistPdf({ rows, tf, lang = "id" }) {
  const tx = L[lang] || L.id;
  const pdf = await PDFDocument.create();
  pdf.setTitle(tx.title);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const clean = makeCleaner(font);

  // Kolom: x relatif ke MARGIN, lebar, rata.
  const cw = PAGE_W - MARGIN * 2;
  const cols = [
    { x: 0, w: 28, a: "l" },
    { x: 28, w: 62, a: "l" },
    { x: 90, w: 170, a: "l" },
    { x: 260, w: 95, a: "r" },
    { x: 355, w: 62, a: "r" },
    { x: 417, w: cw - 417, a: "l" },
  ];
  const put = (page, text, col, y, f, size, color) => {
    const pad = 4;
    let s = text;
    while (s.length > 1 && f.widthOfTextAtSize(s, size) > col.w - pad * 2) s = s.slice(0, -1);
    if (s !== text) s = s.slice(0, -1) + ".";
    const w = f.widthOfTextAtSize(s, size);
    const x = MARGIN + col.x + (col.a === "r" ? col.w - pad - w : pad + (col.a === "r" ? 0 : 0));
    page.drawText(s, { x, y, size, font: f, color });
  };

  const stats = summarize(rows);
  const anyLimited = rows.some((r) => !r.error && r.limited && r.trend !== "nodata");

  const pages = [];
  const newPage = () => {
    const p = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(p);
    return p;
  };
  const drawHead = (page, y) => {
    page.drawRectangle({ x: MARGIN, y: y - 5, width: cw, height: HEAD_H, color: C.head });
    tx.cols.forEach((name, i) => put(page, name, cols[i], y, bold, 9, C.white));
    return y - HEAD_H - 2;
  };

  let page = newPage();
  let y = PAGE_H - MARGIN;
  page.drawText(clean(tx.title), { x: MARGIN, y: y - 14, size: 18, font: bold, color: C.ink });
  y -= 34;
  page.drawText(clean(tx.sub(rows.length, tf, wibStamp())), { x: MARGIN, y, size: 9.5, font, color: C.muted });
  y -= 15;
  page.drawText(clean(tx.summary(stats)), { x: MARGIN, y, size: 9.5, font: bold, color: C.ink });
  y -= 13;
  page.drawText(clean(tx.updown(stats)), { x: MARGIN, y, size: 9.5, font, color: C.ink });
  y -= 22;
  y = drawHead(page, y);

  const bottom = MARGIN + 38; // ruang footer
  rows.forEach((r, i) => {
    if (y - ROW_H < bottom) {
      page = newPage();
      y = drawHead(page, PAGE_H - MARGIN - 6);
    }
    if (i % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - 4, width: cw, height: ROW_H, color: C.zebra });
    const ty = y;
    put(page, String(i + 1), cols[0], ty, font, 8.5, C.muted);
    put(page, clean(r.coin), cols[1], ty, bold, 8.5, C.ink);
    if (r.error) {
      put(page, tx.error, cols[2], ty, font, 8.5, C.nodata);
    } else {
      put(page, clean(r.name || ""), cols[2], ty, font, 8.5, C.ink);
      put(page, clean(fmtUsd(r.price)), cols[3], ty, font, 8.5, C.ink);
      const pctColor = r.pct > 0 ? C.bullish : r.pct < 0 ? C.bearish : C.muted;
      put(page, clean(fmtPct(r.pct)), cols[4], ty, font, 8.5, pctColor);
      const key = r.trend in tx.trend ? r.trend : "nodata";
      put(page, tx.trend[key] + (r.limited && key !== "nodata" ? "*" : ""), cols[5], ty, bold, 8.5, C[key]);
    }
    y -= ROW_H;
  });

  if (anyLimited && y - 14 > MARGIN + 22) page.drawText(clean(tx.limited), { x: MARGIN, y: y - 10, size: 8, font, color: C.muted });
  else if (anyLimited) {
    page = newPage();
    page.drawText(clean(tx.limited), { x: MARGIN, y: PAGE_H - MARGIN - 6, size: 8, font, color: C.muted });
  }

  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN + 18 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 18 }, thickness: 0.5, color: C.line });
    p.drawText(clean(tx.foot), { x: MARGIN, y: MARGIN + 6, size: 7.5, font, color: C.muted });
    const label = tx.page(i + 1, pages.length);
    p.drawText(label, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, 7.5), y: MARGIN + 6, size: 7.5, font, color: C.muted });
  });

  return Buffer.from(await pdf.save());
}

module.exports = { buildWatchlistPdf, summarize };
