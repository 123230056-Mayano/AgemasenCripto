"use strict";

/**
 * features/kripto/signalAllPdf.js
 * ------------------------------------------------------------------
 * PDF untuk !signal all: satu bagian per timeframe, berisi
 *   - 4 kotak ringkasan (VALID / TUNGGU / HINDARI / SIDEWAYS),
 *   - tabel VALID   : Koin | Arah | Entry | SL | TP1 | RR
 *   - tabel TUNGGU  : Koin | Arah | Entry | Alasan
 *   - tabel HINDARI : Koin | Arah | Entry | Alasan
 *   - daftar koin SIDEWAYS dan koin dengan data kurang (grid ticker, tidak punya entry).
 * Parameter `only` (mis. ["VALID"]) membatasi bagian yang dicetak; tanpa itu semua status dicetak.
 * Halaman terakhir: cara membaca. Pakai pdf-lib + Helvetica seperti allPdf.js (tanpa dependency baru).
 */

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { fmtLevel } = require("./market");
const { reasonText } = require("./suddenMoveText");

const TF_LABEL = { "15M": "15m", "1H": "1H", "4H": "4H", "1D": "1D" };
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;
const HEADER_H = 70;
const GRID_COLS = 8;

const C = {
  ink: rgb(0.1, 0.12, 0.16),
  muted: rgb(0.42, 0.45, 0.5),
  line: rgb(0.87, 0.88, 0.9),
  head: rgb(0.07, 0.11, 0.2),
  white: rgb(1, 1, 1),
  band: rgb(0.95, 0.96, 0.98),
  green: rgb(0.09, 0.55, 0.3),
  red: rgb(0.8, 0.18, 0.18),
  gold: rgb(0.75, 0.55, 0.05),
  grey: rgb(0.5, 0.53, 0.58),
};

const STATUS_COLOR = { VALID: C.green, TUNGGU: C.gold, HINDARI: C.red, SIDEWAYS: C.grey, NODATA: C.grey };

// Teks PDF (Helvetica tidak punya emoji, jadi tanpa ikon).
const TXT = {
  id: {
    title: (tf) => `Signal Semua Koin - ${tf}`,
    sub: (total, now) => `${total} koin dipindai  |  harga live Binance (USDT)  |  dibuat ${now}`,
    VALID: "VALID",
    TUNGGU: "TUNGGU",
    HINDARI: "HINDARI",
    SIDEWAYS: "SIDEWAYS",
    NODATA: "DATA KURANG",
    descVALID: "Skenario boleh dipertimbangkan sekarang. Diurutkan dari keyakinan bias tertinggi.",
    descTUNGGU: "Arah sudah ada, tetapi belum waktunya masuk. Alasan di kolom kanan.",
    descHINDARI: "Kondisi terlalu berisiko. Alasan di kolom kanan.",
    descSIDEWAYS: "Bias netral, tidak ada entry. Tunggu close keluar range.",
    descNODATA: "Data kurang atau gagal diambil.",
    none: "Belum ada skenario valid di timeframe ini.",
    noneTUNGGU: "Tidak ada koin berstatus tunggu di timeframe ini.",
    noneHINDARI: "Tidak ada koin berstatus hindari di timeframe ini.",
    noneSIDEWAYS: "Tidak ada koin sideways di timeframe ini.",
    filterNote: (f) => `Filter: ${f}`,
    cols: { coin: "Koin", dir: "Arah", entry: "Entry", sl: "SL", tp1: "TP1", rr: "RR", why: "Alasan" },
    cont: "(lanjutan)",
    page: (i, n) => `Halaman ${i}/${n}`,
    foot: "Edukasi, bukan saran finansial.",
    howTitle: "Cara membaca",
    howSub: "Penjelasan singkat supaya tabel tidak salah dibaca",
    how: [
      ["Arah", "LONG = skenario beli, SHORT = skenario jual. Tanda * berarti valid bersyarat: SL sudah dilebarkan oleh Sudden Move Guard, kecilkan ukuran posisi agar risiko uang tetap sama."],
      ["Status", "VALID / TUNGGU / HINDARI dinilai Sudden Move Guard (volatilitas, sweep, wick reject, RR setelah SL disesuaikan), sama persis dengan !signal <koin>. Arah mengikuti !bias di tiap timeframe."],
      ["SIDEWAYS", "Bias netral, jadi tidak ada entry. Detail batas range dan syarat keluar: !signal <koin> <tf>."],
      ["Entry / SL / TP1 / RR", "Dihitung dari candle closed, ATR 14, dan level swing S/R. RR dihitung dari angka entry, SL, dan TP1. Bukan prediksi."],
      ["Catatan", "Skenario edukasi dari indikator teknikal, bukan ajakan beli/jual dan bukan jaminan hasil. Tentukan sendiri risikomu."],
    ],
    long: "LONG",
    short: "SHORT",
  },
  en: {
    title: (tf) => `Signal All Coins - ${tf}`,
    sub: (total, now) => `${total} coins scanned  |  live Binance price (USDT)  |  generated ${now}`,
    VALID: "VALID",
    TUNGGU: "WAIT",
    HINDARI: "AVOID",
    SIDEWAYS: "SIDEWAYS",
    NODATA: "INSUFFICIENT DATA",
    descVALID: "Scenarios worth considering now. Sorted by highest bias confidence.",
    descTUNGGU: "A direction exists but it is not time to enter yet. Reason in the right column.",
    descHINDARI: "Conditions too risky. Reason in the right column.",
    descSIDEWAYS: "Neutral bias, no entry. Wait for a close outside the range.",
    descNODATA: "Insufficient data or failed to load.",
    none: "No valid scenario on this timeframe yet.",
    noneTUNGGU: "No coin with a wait status on this timeframe.",
    noneHINDARI: "No coin with an avoid status on this timeframe.",
    noneSIDEWAYS: "No sideways coin on this timeframe.",
    filterNote: (f) => `Filter: ${f}`,
    cols: { coin: "Coin", dir: "Dir", entry: "Entry", sl: "SL", tp1: "TP1", rr: "RR", why: "Reason" },
    cont: "(continued)",
    page: (i, n) => `Page ${i}/${n}`,
    foot: "Educational, not financial advice.",
    howTitle: "How to read",
    howSub: "A short guide so the tables are not misread",
    how: [
      ["Dir", "LONG = buy scenario, SHORT = sell scenario. A * means conditionally valid: the Sudden Move Guard widened the SL, so reduce position size to keep the money risk the same."],
      ["Status", "VALID / WAIT / AVOID is judged by the Sudden Move Guard (volatility, sweep, wick reject, RR after SL adjustment), exactly like !signal <coin>. Direction follows !bias on each timeframe."],
      ["SIDEWAYS", "Neutral bias, so there is no entry. Range bounds and exit conditions: !signal <coin> <tf>."],
      ["Entry / SL / TP1 / RR", "Calculated from closed candles, ATR 14 and swing S/R levels. RR is calculated from the entry, SL and TP1 numbers. Not a prediction."],
      ["Note", "Educational scenarios from technical indicators, not a call to buy/sell and not a guarantee. Decide your own risk."],
    ],
    long: "LONG",
    short: "SHORT",
  },
};

// ---------- util ----------
// Helvetica hanya WinAnsi: buang karakter di luar itu supaya pdf-lib tidak error.
function makeClean(font) {
  return (s) => {
    let out = "";
    for (const ch of String(s ?? "").replace(/\r?\n+/g, " ")) {
      if (ch === "\u2212" || ch === "\u2013" || ch === "\u2014") out += "-";
      else if (ch === "\u00B7") out += "|";
      else {
        try {
          font.encodeText(ch);
          out += ch;
        } catch {
          /* buang emoji dll */
        }
      }
    }
    return out.replace(/ {2,}/g, " ").trim();
  };
}

function wrapText(font, clean, text, size, width, maxLines = Infinity) {
  const words = clean(text).split(" ").filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) <= width) cur = test;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && font.widthOfTextAtSize(`${last}...`, size) > width) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}...`;
    return kept;
  }
  return lines;
}

const fmtRR = (v) => (v == null ? "-" : v.toFixed(2).replace(/\.?0+$/, ""));
const fmtNow = () =>
  new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " WIB";

// ---------- kerangka ----------
async function createDoc(title) {
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(title);
  pdf.setAuthor("AGEMASEN Crypto Analyst");
  pdf.setCreationDate(new Date());
  return { pdf, reg, bold, clean: makeClean(reg) };
}

/** Halaman baru dengan header; mengembalikan state kursor { page, y }. */
function newPage(ctx, { title, sub }) {
  const { pdf, reg, bold, clean } = ctx;
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: C.head });
  page.drawText(clean(title), { x: MARGIN, y: PAGE_H - 34, size: 17, font: bold, color: C.white });
  page.drawText(clean(sub), { x: MARGIN, y: PAGE_H - 54, size: 8.5, font: reg, color: rgb(0.75, 0.8, 0.9) });
  return { page, y: PAGE_H - HEADER_H - 26 };
}

/** Pastikan ada ruang `h`; kalau tidak, halaman lanjutan baru. */
function ensure(ctx, st, h, head) {
  if (st.y - h >= MARGIN + 8) return st;
  return newPage(ctx, { title: `${head.title} ${head.cont}`, sub: head.sub });
}

function drawFooters(ctx, tx) {
  const { pdf, reg, clean } = ctx;
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN - 4 }, end: { x: PAGE_W - MARGIN, y: MARGIN - 4 }, thickness: 0.4, color: C.line });
    p.drawText(clean(tx.foot), { x: MARGIN, y: MARGIN - 16, size: 7.5, font: reg, color: C.muted });
    const label = tx.page(i + 1, pages.length);
    p.drawText(label, { x: PAGE_W - MARGIN - reg.widthOfTextAtSize(label, 7.5), y: MARGIN - 16, size: 7.5, font: reg, color: C.muted });
  });
}

function drawSummary(ctx, st, tx, groups) {
  const { reg, bold, clean } = ctx;
  const gap = 8;
  const w = (CONTENT_W - gap * 3) / 4;
  const h = 46;
  ["VALID", "TUNGGU", "HINDARI", "SIDEWAYS"].forEach((k, i) => {
    const x = MARGIN + i * (w + gap);
    st.page.drawRectangle({ x, y: st.y - h, width: w, height: h, color: C.band });
    st.page.drawRectangle({ x, y: st.y - h, width: 3.5, height: h, color: STATUS_COLOR[k] });
    st.page.drawText(String(groups[k].length), { x: x + 14, y: st.y - 28, size: 20, font: bold, color: STATUS_COLOR[k] });
    st.page.drawText(clean(tx[k]), { x: x + 14, y: st.y - 40, size: 8, font: reg, color: C.muted });
  });
  st.y -= h + 36;
}

function drawSectionTitle(ctx, st, tx, key, count) {
  const { reg, bold, clean } = ctx;
  st.page.drawRectangle({ x: MARGIN, y: st.y - 4, width: 4, height: 24, color: STATUS_COLOR[key] });
  st.page.drawText(clean(`${tx[key]} (${count})`), { x: MARGIN + 12, y: st.y + 10, size: 12, font: bold, color: STATUS_COLOR[key] });
  st.page.drawText(clean(tx[`desc${key}`]), { x: MARGIN + 12, y: st.y - 2, size: 8, font: reg, color: C.muted });
  st.y -= 20;
}

/**
 * Tabel generik. cols: [{ key, label, w (pecahan), wrap? }]. rows: [{ cells:{key: text|{t,color,bold}} , band }].
 * Kolom `wrap` boleh 2 baris. Header diulang di halaman lanjutan.
 */
function drawTable(ctx, st, head, cols, rows) {
  const { reg, bold, clean } = ctx;
  const widths = cols.map((c) => c.w * CONTENT_W);
  const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((s, v) => s + v, 0));
  const HR = 18;
  const SIZE = 9;
  const LH = 11;

  const drawHeader = () => {
    st.page.drawRectangle({ x: MARGIN, y: st.y - HR, width: CONTENT_W, height: HR, color: C.head });
    cols.forEach((c, i) => st.page.drawText(clean(c.label), { x: xs[i] + 6, y: st.y - 12.5, size: 8.5, font: bold, color: C.white }));
    st.y -= HR;
  };

  st = ensure(ctx, st, HR + 22, head);
  drawHeader();

  rows.forEach((r, ri) => {
    const cellLines = cols.map((c, i) => {
      const cell = r.cells[c.key];
      const text = typeof cell === "object" && cell ? cell.t : cell;
      return c.wrap ? wrapText(reg, clean, text ?? "", 8, widths[i] - 12, 2) : [clean(text ?? "")];
    });
    const rh = Math.max(...cellLines.map((l) => l.length)) * LH + 8;

    if (st.y - rh < MARGIN + 8) {
      st = newPage(ctx, { title: `${head.title} ${head.cont}`, sub: head.sub });
      drawHeader();
    }
    if (ri % 2 === 1) st.page.drawRectangle({ x: MARGIN, y: st.y - rh, width: CONTENT_W, height: rh, color: C.band });
    st.page.drawLine({ start: { x: MARGIN, y: st.y - rh }, end: { x: MARGIN + CONTENT_W, y: st.y - rh }, thickness: 0.3, color: C.line });
    cols.forEach((c, i) => {
      const cell = r.cells[c.key];
      const style = typeof cell === "object" && cell ? cell : {};
      cellLines[i].forEach((ln, li) => {
        st.page.drawText(ln, {
          x: xs[i] + 6,
          y: st.y - 12 - li * LH,
          size: c.wrap ? 8 : SIZE,
          font: style.bold ? bold : reg,
          color: style.color || C.ink,
        });
      });
    });
    st.y -= rh;
  });
  st.y -= 32;
  return st;
}

/** Grid ticker (koin tanpa entry): GRID_COLS kolom. */
function drawGrid(ctx, st, head, tickers) {
  const { reg } = ctx;
  const cw = CONTENT_W / GRID_COLS;
  const RH = 15;
  for (let i = 0; i < tickers.length; i += GRID_COLS) {
    st = ensure(ctx, st, RH + 4, head);
    tickers.slice(i, i + GRID_COLS).forEach((tk, j) => st.page.drawText(ctx.clean(tk), { x: MARGIN + j * cw + 6, y: st.y - 11, size: 9, font: reg, color: C.ink }));
    st.y -= RH;
  }
  st.y -= 24;
  return st;
}

// ---------- isi ----------
const dirCell = (tx, g) => ({ t: `${g.dir === "long" ? tx.long : tx.short}${g.conditional ? "*" : ""}`, color: g.dir === "long" ? C.green : C.red, bold: true });

function reasonOf(lang, g) {
  const rs = g.sc?.guard?.reasons || [];
  if (!rs.length) return "-";
  return rs.slice(0, 2).map((r) => reasonText(lang, r)).join("; ");
}

function addTfSection(ctx, lang, tx, tf, groups, total, now, only) {
  const show = (k) => only.includes(k);
  const filtered = only.length < 4;
  const sub = filtered ? `${tx.sub(total, now)}  |  ${tx.filterNote(only.map((k) => tx[k]).join(", "))}` : tx.sub(total, now);
  const head = { title: tx.title(TF_LABEL[tf]), sub, cont: tx.cont };
  let st = newPage(ctx, { title: head.title, sub: head.sub });
  drawSummary(ctx, st, tx, groups);

  // VALID
  if (show("VALID")) {
  st = ensure(ctx, st, 80, head);
  drawSectionTitle(ctx, st, tx, "VALID", groups.VALID.length);
  if (groups.VALID.length) {
    const cols = [
      { key: "coin", label: tx.cols.coin, w: 0.13 },
      { key: "dir", label: tx.cols.dir, w: 0.13 },
      { key: "entry", label: tx.cols.entry, w: 0.21 },
      { key: "sl", label: tx.cols.sl, w: 0.21 },
      { key: "tp1", label: tx.cols.tp1, w: 0.21 },
      { key: "rr", label: tx.cols.rr, w: 0.11 },
    ];
    const rows = groups.VALID.map((g) => ({
      cells: {
        coin: { t: g.ticker, bold: true },
        dir: dirCell(tx, g),
        entry: fmtLevel(g.sc.entry.price),
        sl: fmtLevel(g.sc.sl.price),
        tp1: fmtLevel(g.sc.tps[0].price),
        rr: fmtRR(g.sc.tps[0].rr),
      },
    }));
    st = drawTable(ctx, st, head, cols, rows);
  } else {
    st.page.drawText(ctx.clean(tx.none), { x: MARGIN + 12, y: st.y - 8, size: 9.5, font: ctx.reg, color: C.muted });
    st.y -= 44;
  }
  }

  // TUNGGU & HINDARI: ada arah + entry, plus alasan
  for (const key of ["TUNGGU", "HINDARI"]) {
    if (!show(key)) continue;
    if (!groups[key].length && !filtered) continue; // tanpa filter, bagian kosong dilewati
    st = ensure(ctx, st, 80, head);
    drawSectionTitle(ctx, st, tx, key, groups[key].length);
    if (!groups[key].length) {
      st.page.drawText(ctx.clean(tx[`none${key}`]), { x: MARGIN + 12, y: st.y - 8, size: 9.5, font: ctx.reg, color: C.muted });
      st.y -= 44;
      continue;
    }
    const cols = [
      { key: "coin", label: tx.cols.coin, w: 0.12 },
      { key: "dir", label: tx.cols.dir, w: 0.12 },
      { key: "entry", label: tx.cols.entry, w: 0.18 },
      { key: "why", label: tx.cols.why, w: 0.58, wrap: true },
    ];
    const rows = groups[key].map((g) => ({
      cells: { coin: { t: g.ticker, bold: true }, dir: dirCell(tx, g), entry: fmtLevel(g.sc.entry.price), why: reasonOf(lang, g) },
    }));
    st = drawTable(ctx, st, head, cols, rows);
  }

  // SIDEWAYS & DATA KURANG: hanya daftar koin
  for (const key of ["SIDEWAYS", "NODATA"]) {
    if (key === "NODATA" ? filtered : !show(key)) continue; // data kurang hanya tampil tanpa filter
    if (!groups[key].length && !filtered) continue;
    st = ensure(ctx, st, 60, head);
    drawSectionTitle(ctx, st, tx, key, groups[key].length);
    if (!groups[key].length) {
      st.page.drawText(ctx.clean(tx[`none${key}`]), { x: MARGIN + 12, y: st.y - 8, size: 9.5, font: ctx.reg, color: C.muted });
      st.y -= 44;
      continue;
    }
    st.y -= 6;
    st = drawGrid(ctx, st, head, groups[key].map((g) => g.ticker));
  }
}

function addHowPage(ctx, tx) {
  const { reg, bold, clean } = ctx;
  const st = newPage(ctx, { title: tx.howTitle, sub: tx.howSub });
  for (const [h, p] of tx.how) {
    const lines = wrapText(reg, clean, p, 10, CONTENT_W);
    st.page.drawText(clean(h), { x: MARGIN, y: st.y, size: 11, font: bold, color: C.head });
    st.y -= 16;
    for (const ln of lines) {
      st.page.drawText(ln, { x: MARGIN, y: st.y, size: 10, font: reg, color: C.ink });
      st.y -= 14;
    }
    st.y -= 12;
  }
}

/**
 * @param {string} lang
 * @param {{ tfs: string[], total: number, groupsByTf: Record<string, object>, only?: string[] }} data
 * @returns {Promise<Buffer>}
 */
async function buildSignalAllPdf(lang, { tfs, total, groupsByTf, only }) {
  const sel = ["VALID", "TUNGGU", "HINDARI", "SIDEWAYS"].filter((k) => !only || !only.length || only.includes(k));
  const tx = TXT[lang] || TXT.id;
  const ctx = await createDoc(tx.title(tfs.map((x) => TF_LABEL[x]).join(", ")));
  const now = fmtNow();
  for (const tf of tfs) addTfSection(ctx, lang, tx, tf, groupsByTf[tf], total, now, sel);
  addHowPage(ctx, tx);
  drawFooters(ctx, tx);
  return Buffer.from(await ctx.pdf.save());
}

module.exports = { buildSignalAllPdf };
