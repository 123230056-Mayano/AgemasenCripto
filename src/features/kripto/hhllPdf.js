"use strict";

/**
 * features/kripto/hhllPdf.js
 * ------------------------------------------------------------------
 * PDF alarm Higher High / Lower Low: semua kejadian satu penerima dalam satu dokumen, dikelompokkan per
 * timeframe (1D > 4H > 1H > 15m). A4, multi-halaman, header tabel diulang. Pakai pdf-lib + Helvetica
 * (sama dengan watchPdf.js), jadi tanpa dependensi baru. Helvetica cuma Latin: teks dibersihkan lewat clean().
 */

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { fmtUsd, fmtLevel } = require("./market");
const { makeCleaner, PDF_STYLE } = require("./watchPdf");
const { fmtCandleTime, TF_LABEL } = require("./divAlertCore");
const { TF_ORDER, sortEvents } = require("./hhllAlertCore");

const { PAGE_W, PAGE_H, MARGIN, ROW_H, HEAD_H, C: BASE } = PDF_STYLE;
const C = { ...BASE, up: rgb(0.09, 0.55, 0.3), down: rgb(0.8, 0.18, 0.18), flip: rgb(0.1, 0.35, 0.8) };

const L = {
  id: {
    title: "Alarm Higher High / Lower Low",
    sub: (time, n) => `${time} | ${n} kejadian`,
    sec: (tf, n) => `Timeframe ${tf} (${n})`,
    cols: ["No", "Koin", "Kejadian", "Arah", "Grade", "Level", "Close"],
    grade: { strong: "Kuat", medium: "Sedang", weak: "Lemah" },
    what: {
      "early.up": "HL baru (dini)",
      "early.down": "LH baru (dini)",
      "confirm.up.flip": "Tembus swing high, balik naik",
      "confirm.up.cont": "Tembus swing high, lanjut naik",
      "confirm.down.flip": "Tembus swing low, balik turun",
      "confirm.down.cont": "Tembus swing low, lanjut turun",
      "failed.up": "Tembusan naik gagal",
      "failed.down": "Tembusan turun gagal",
    },
    dir: { up: "Naik", down: "Turun" },
    foot: "Dini = swing baru terkonfirmasi (belum tembus). Konfirmasi = close tembus swing, dari candle closed. Edukasi, bukan ajakan beli/jual.",
    page: (p, n) => `Hal. ${p}/${n}`,
  },
  en: {
    title: "Higher High / Lower Low Alert",
    sub: (time, n) => `${time} | ${n} events`,
    sec: (tf, n) => `Timeframe ${tf} (${n})`,
    cols: ["No", "Coin", "Event", "Dir", "Grade", "Level", "Close"],
    grade: { strong: "Strong", medium: "Medium", weak: "Weak" },
    what: {
      "early.up": "New HL (early)",
      "early.down": "New LH (early)",
      "confirm.up.flip": "Broke swing high, turns up",
      "confirm.up.cont": "Broke swing high, uptrend continues",
      "confirm.down.flip": "Broke swing low, turns down",
      "confirm.down.cont": "Broke swing low, downtrend continues",
      "failed.up": "Upside break failed",
      "failed.down": "Downside break failed",
    },
    dir: { up: "Up", down: "Down" },
    foot: "Early = new swing confirmed (not broken yet). Confirmed = close broke the swing, from closed candles. Educational, not buy/sell advice.",
    page: (p, n) => `Page ${p}/${n}`,
  },
};

const whatKey = (ev) => (ev.stage === "early" ? `early.${ev.dir}` : ev.stage === "failed" ? `failed.${ev.dir}` : `confirm.${ev.dir}.${ev.flip ? "flip" : "cont"}`);

/**
 * @param {{events: object[], lang?: string, ms: number}} p events = hasil engine (coin, tf, stage, dir, flip, level, now)
 * @returns {Promise<Buffer>}
 */
async function buildHhllPdf({ events, lang = "id", ms }) {
  const tx = L[lang] || L.id;
  const pdf = await PDFDocument.create();
  pdf.setTitle(tx.title);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const clean = makeCleaner(font);

  const cw = PAGE_W - MARGIN * 2;
  const cols = [
    { x: 0, w: 28, a: "l" },
    { x: 28, w: 62, a: "l" },
    { x: 90, w: 160, a: "l" },
    { x: 250, w: 45, a: "l" },
    { x: 295, w: 50, a: "l" },
    { x: 345, w: 90, a: "r" },
    { x: 435, w: cw - 435, a: "r" },
  ];
  const put = (page, text, col, y, f, size, color) => {
    const pad = 4;
    let s = text;
    while (s.length > 1 && f.widthOfTextAtSize(s, size) > col.w - pad * 2) s = s.slice(0, -1);
    if (s !== text) s = s.slice(0, -1) + ".";
    const w = f.widthOfTextAtSize(s, size);
    const x = MARGIN + col.x + (col.a === "r" ? col.w - pad - w : pad);
    page.drawText(s, { x, y, size, font: f, color });
  };

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
  page.drawText(clean(tx.sub(fmtCandleTime(lang, ms), events.length)), { x: MARGIN, y, size: 9.5, font, color: C.muted });
  y -= 24;

  const bottom = MARGIN + 38; // ruang footer
  const sorted = sortEvents(events);
  for (const tf of TF_ORDER) {
    const rows = sorted.filter((e) => e.tf === tf);
    if (!rows.length) continue;
    if (y - HEAD_H * 2 - ROW_H * 2 < bottom) {
      page = newPage();
      y = PAGE_H - MARGIN - 6;
    }
    page.drawText(clean(tx.sec(TF_LABEL[tf], rows.length)), { x: MARGIN, y, size: 11.5, font: bold, color: C.ink });
    y -= 16;
    y = drawHead(page, y);
    rows.forEach((r, i) => {
      if (y - ROW_H < bottom) {
        page = newPage();
        y = drawHead(page, PAGE_H - MARGIN - 6);
      }
      if (i % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - 4, width: cw, height: ROW_H, color: C.zebra });
      const dirColor = r.dir === "up" ? C.up : C.down;
      put(page, String(i + 1), cols[0], y, font, 8.5, C.muted);
      put(page, clean(r.coin), cols[1], y, bold, 8.5, C.ink);
      put(page, clean(tx.what[whatKey(r)]), cols[2], y, r.flip ? bold : font, 8.5, r.flip && r.stage === "confirm" ? C.flip : C.ink);
      put(page, tx.dir[r.dir], cols[3], y, bold, 8.5, dirColor);
      const gr = r.ctx?.grade;
      put(page, gr ? clean(tx.grade[gr]) : "-", cols[4], y, gr === "strong" ? bold : font, 8.5, gr === "strong" ? C.up : gr === "weak" ? C.down : C.ink);
      put(page, clean(fmtLevel(r.level)), cols[5], y, font, 8.5, C.ink);
      put(page, clean(fmtUsd(r.now)), cols[6], y, font, 8.5, C.ink);
      y -= ROW_H;
    });
    y -= 14;
  }

  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN + 18 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 18 }, thickness: 0.5, color: C.line });
    p.drawText(clean(tx.foot), { x: MARGIN, y: MARGIN + 6, size: 6.5, font, color: C.muted });
    const label = tx.page(i + 1, pages.length);
    p.drawText(label, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, 7.5), y: MARGIN + 18 + 4, size: 7.5, font, color: C.muted });
  });

  return Buffer.from(await pdf.save());
}

module.exports = { buildHhllPdf };
