"use strict";

/**
 * features/kripto/divPdf.js
 * ------------------------------------------------------------------
 * PDF divergence gabungan (item 05): dipakai alarm !alertdiv (semua sinyal satu penutupan candle,
 * beberapa TF yang closed bersamaan digabung) dan hasil !scandivergent.
 *
 * Susunan: judul + ringkasan, lalu satu bagian per TF (urut 1D > 4H > 1H > 15m, sesuai urutan `sections`),
 * tiap bagian berisi tabel Bullish dan tabel Bearish, masing-masing dipecah per jenis (Reguler = pembalikan,
 * Tersembunyi = lanjutan) dengan judul tegas: Koin | Indikator | Jenis. Baris konflik (bull + bear sekaligus) diberi tanda.
 * Gaya (font, warna, margin, footer) memakai ulang watchPdf.js, tanpa dependensi baru.
 *
 * @typedef {{coin:string, indicator:'rsi'|'macd', kind:'regular'|'hidden', conflict?:boolean}} DivRow
 * @typedef {{tf:string, bull:DivRow[], bear:DivRow[]}} DivSection  (tf = label tampil, mis. "1H", "15m")
 */

const { PDFDocument, StandardFonts } = require("pdf-lib");
const { makeCleaner, PDF_STYLE } = require("./watchPdf");

const { PAGE_W, PAGE_H, MARGIN, ROW_H, HEAD_H, C } = PDF_STYLE;

const L = {
  id: {
    title: { alert: "Alarm Divergence RSI/MACD", scan: "Scan Divergence RSI/MACD" },
    sub: { alert: (time) => `Candle closed ${time}`, scan: (time) => `Dipindai ${time}` },
    summary: (list) => `Sinyal per TF: ${list}`,
    tfHead: (tf, n) => `${tf}  |  ${n} sinyal`,
    group: {
      regular: { bull: "Bullish Reguler (pembalikan naik)", bear: "Bearish Reguler (pembalikan turun)" },
      hidden: { bull: "Bullish Tersembunyi (lanjutan naik)", bear: "Bearish Tersembunyi (lanjutan turun)" },
    },
    bullEmpty: "Bullish",
    bearEmpty: "Bearish",
    cols: ["No", "Koin", "Indikator", "Jenis"],
    kind: { regular: "Reguler (pembalikan)", hidden: "Tersembunyi (lanjutan)" },
    conflict: "KONFLIK",
    none: "Tidak ada",
    noneTf: "Tidak ada divergence baru di timeframe ini.",
    note: "Reguler = potensi pembalikan, Tersembunyi = potensi lanjutan tren. KONFLIK = koin punya sinyal bull dan bear sekaligus di TF itu. Dari candle closed.",
    foot: "Edukasi, bukan ajakan beli/jual.",
    page: (p, n) => `Hal. ${p}/${n}`,
  },
  en: {
    title: { alert: "RSI/MACD Divergence Alert", scan: "RSI/MACD Divergence Scan" },
    sub: { alert: (time) => `Candle closed ${time}`, scan: (time) => `Scanned ${time}` },
    summary: (list) => `Signals per TF: ${list}`,
    tfHead: (tf, n) => `${tf}  |  ${n} signals`,
    group: {
      regular: { bull: "Bullish Regular (reversal up)", bear: "Bearish Regular (reversal down)" },
      hidden: { bull: "Bullish Hidden (continuation up)", bear: "Bearish Hidden (continuation down)" },
    },
    bullEmpty: "Bullish",
    bearEmpty: "Bearish",
    cols: ["No", "Coin", "Indicator", "Type"],
    kind: { regular: "Regular (reversal)", hidden: "Hidden (continuation)" },
    conflict: "CONFLICT",
    none: "None",
    noneTf: "No new divergence on this timeframe.",
    note: "Regular = potential reversal, Hidden = potential trend continuation. CONFLICT = coin has both bull and bear signals on that TF. From closed candles.",
    foot: "Educational, not buy/sell advice.",
    page: (p, n) => `Page ${p}/${n}`,
  },
};

const GROUP_GAP = 8;
const TF_BAR_H = 20;

/**
 * @param {{sections: DivSection[], mode?: 'alert'|'scan', time: string, lang?: string}} p
 * @returns {Promise<Buffer>}
 */
async function buildDivergencePdf({ sections, mode = "alert", time, lang = "id" }) {
  const tx = L[lang] || L.id;
  const pdf = await PDFDocument.create();
  pdf.setTitle(tx.title[mode] || tx.title.alert);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const clean = makeCleaner(font);

  const cw = PAGE_W - MARGIN * 2;
  const cols = [
    { x: 0, w: 34, a: "l" },
    { x: 34, w: 170, a: "l" },
    { x: 204, w: 110, a: "l" },
    { x: 314, w: cw - 314, a: "l" },
  ];
  const put = (page, text, col, y, f, size, color) => {
    const pad = 4;
    let s = String(text);
    while (s.length > 1 && f.widthOfTextAtSize(s, size) > col.w - pad * 2) s = s.slice(0, -1);
    page.drawText(s, { x: MARGIN + col.x + pad, y, size, font: f, color });
  };

  const bottom = MARGIN + 44; // ruang footer (2 baris)
  const pages = [];
  const newPage = () => {
    const p = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(p);
    return p;
  };
  let page = newPage();
  let y = PAGE_H - MARGIN;

  // Pindah halaman bila sisa ruang kurang dari h.
  const ensure = (h) => {
    if (y - h < bottom) {
      page = newPage();
      y = PAGE_H - MARGIN - 6;
    }
  };

  const total = sections.reduce((n, s) => n + s.bull.length + s.bear.length, 0);
  page.drawText(clean(tx.title[mode] || tx.title.alert), { x: MARGIN, y: y - 14, size: 18, font: bold, color: C.ink });
  y -= 34;
  page.drawText(clean((tx.sub[mode] || tx.sub.alert)(time)), { x: MARGIN, y, size: 9.5, font, color: C.muted });
  y -= 15;
  const list = sections.map((s) => `${s.tf} ${s.bull.length + s.bear.length}`).join(" | ");
  page.drawText(clean(tx.summary(list || "-")), { x: MARGIN, y, size: 9.5, font: bold, color: C.ink });
  y -= 13;
  page.drawText(clean(`${total} ${lang === "en" ? "signals" : "sinyal"}`), { x: MARGIN, y, size: 9.5, font, color: C.ink });
  y -= 22;

  const drawGroup = (rows, label, color) => {
    ensure(HEAD_H + ROW_H * 2 + 14); // label + header + minimal satu baris
    page.drawText(clean(label), { x: MARGIN, y, size: 10, font: bold, color });
    y -= 14;
    page.drawRectangle({ x: MARGIN, y: y - 5, width: cw, height: HEAD_H, color: C.head });
    tx.cols.forEach((name, i) => put(page, name, cols[i], y, bold, 9, C.white));
    y -= HEAD_H + 2;
    if (!rows.length) {
      put(page, tx.none, cols[1], y, font, 8.5, C.muted);
      y -= ROW_H;
      return;
    }
    rows.forEach((r, i) => {
      if (y - ROW_H < bottom) {
        page = newPage();
        y = PAGE_H - MARGIN - 6;
        page.drawRectangle({ x: MARGIN, y: y - 5, width: cw, height: HEAD_H, color: C.head });
        tx.cols.forEach((name, k) => put(page, name, cols[k], y, bold, 9, C.white));
        y -= HEAD_H + 2;
      }
      if (i % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - 4, width: cw, height: ROW_H, color: C.zebra });
      put(page, String(i + 1), cols[0], y, font, 8.5, C.muted);
      put(page, clean(r.coin), cols[1], y, bold, 8.5, C.ink);
      put(page, String(r.indicator).toUpperCase(), cols[2], y, font, 8.5, C.ink);
      put(page, (tx.kind[r.kind] || r.kind) + (r.conflict ? `  [${tx.conflict}]` : ""), cols[3], y, r.conflict ? bold : font, 8.5, r.conflict ? C.bearish : C.ink);
      y -= ROW_H;
    });
  };

  for (const s of sections) {
    const n = s.bull.length + s.bear.length;
    // TF kosong hanya butuh batang judul + satu baris; TF berisi butuh judul + label + header tabel + satu baris.
    ensure(n ? TF_BAR_H + 14 + HEAD_H + ROW_H * 2 + 14 : TF_BAR_H + ROW_H + GROUP_GAP + 8);
    page.drawRectangle({ x: MARGIN, y: y - 6, width: cw, height: TF_BAR_H, color: C.head });
    page.drawText(clean(tx.tfHead(s.tf, n)), { x: MARGIN + 8, y: y - 0.5, size: 11, font: bold, color: C.white });
    y -= TF_BAR_H + 8;
    if (!n) {
      page.drawText(clean(tx.noneTf), { x: MARGIN + 4, y, size: 9, font, color: C.muted });
      y -= ROW_H + GROUP_GAP;
      continue;
    }
    // Tiap arah dipecah per jenis: reguler (pembalikan) lalu tersembunyi (lanjutan), masing-masing tabel sendiri.
    for (const [dir, rows, color, emptyLabel] of [
      ["bull", s.bull, C.bullish, tx.bullEmpty],
      ["bear", s.bear, C.bearish, tx.bearEmpty],
    ]) {
      if (!rows.length) {
        drawGroup(rows, `${emptyLabel} (0)`, color);
        y -= GROUP_GAP;
        continue;
      }
      for (const kind of ["regular", "hidden"]) {
        const part = rows.filter((r) => r.kind === kind);
        if (!part.length) continue;
        drawGroup(part, `${tx.group[kind][dir]} (${part.length})`, color);
        y -= GROUP_GAP;
      }
    }
    y -= 6;
  }

  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN + 30 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 30 }, thickness: 0.5, color: C.line });
    p.drawText(clean(tx.note), { x: MARGIN, y: MARGIN + 18, size: 7, font, color: C.muted });
    p.drawText(clean(tx.foot), { x: MARGIN, y: MARGIN + 6, size: 7.5, font, color: C.muted });
    const label = tx.page(i + 1, pages.length);
    p.drawText(label, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, 7.5), y: MARGIN + 6, size: 7.5, font, color: C.muted });
  });

  return Buffer.from(await pdf.save());
}

module.exports = { buildDivergencePdf };
