"use strict";

/**
 * features/kripto/allPdf.js
 * ------------------------------------------------------------------
 *   !snr all <koin>  -> 1 PDF: Support & Resistance semua timeframe (15m, 1H, 4H, 1D)
 *   !fib all <koin>  -> 1 PDF: Fibonacci semua timeframe
 *
 * Satu halaman A4 per timeframe: tabel 4 kolom + chart. Hasil dikirim sebagai dokumen
 * PDF saja (tanpa teks panjang di chat). Pakai pdf-lib + Helvetica, sama seperti
 * analisisPdf.js, jadi tidak butuh dependency baru.
 *
 * Kolom SNR : Level | Harga | Jarak | Kekuatan
 * Kolom FIB : Level (rasio) | Harga | Jarak | Keterangan
 */

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { t } = require("../../i18n");
const { renderChart } = require("../analisis/analisisChart");
const { TF_LABEL, fetchCandles, fetchTicker, fmtUsd, fmtLevel, fmtPct, pctFrom } = require("./market");
const { computeSnr, strengthLevel, strengthKey } = require("./snr");
const { computeFib, renderFibChart, retraceDepth } = require("./fib");

const ALL_TFS = ["15M", "1H", "4H", "1D"];
const PER_SIDE = 3;

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;

const C = {
  ink: rgb(0.1, 0.12, 0.16),
  muted: rgb(0.42, 0.45, 0.5),
  line: rgb(0.87, 0.88, 0.9),
  head: rgb(0.07, 0.11, 0.2),
  white: rgb(1, 1, 1),
  band: rgb(0.95, 0.96, 0.98),
  res: rgb(0.8, 0.18, 0.18),
  sup: rgb(0.09, 0.55, 0.3),
  now: rgb(0.1, 0.35, 0.8),
  gold: rgb(0.75, 0.55, 0.05),
  ext: rgb(0.5, 0.25, 0.75),
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
        try { font.encodeText(ch); out += ch; } catch { /* buang emoji dll */ }
      }
    }
    return out.replace(/ {2,}/g, " ").trim();
  };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Ambil candle semua timeframe paralel. TF yang gagal -> null (halamannya diberi catatan). */
async function loadAll(coin) {
  const [tick, ...res] = await Promise.all([
    fetchTicker(coin),
    ...ALL_TFS.map((tf) => fetchCandles(coin, tf).then((c) => ({ ok: true, c })).catch((e) => ({ ok: false, e }))),
  ]);
  const failed = res.filter((r) => !r.ok);
  if (failed.length === res.length) throw failed[0].e; // semua gagal -> biar handler umum yang membalas (mis. koin tidak didukung)
  return { tick, byTf: Object.fromEntries(ALL_TFS.map((tf, i) => [tf, res[i].ok ? res[i].c : null])) };
}

// ---------- kerangka PDF ----------
async function createDoc(title) {
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const clean = makeClean(reg);
  pdf.setTitle(title);
  pdf.setAuthor("AGEMASEN Crypto Analyst");
  pdf.setCreationDate(new Date());
  return { pdf, reg, bold, clean };
}

function pageHeader(ctx, page, { title, sub }) {
  const { reg, bold, clean } = ctx;
  page.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70, color: C.head });
  page.drawText(clean(title), { x: MARGIN, y: PAGE_H - 34, size: 17, font: bold, color: C.white });
  page.drawText(clean(sub), { x: MARGIN, y: PAGE_H - 54, size: 9, font: reg, color: rgb(0.75, 0.8, 0.9) });
}

/**
 * Gambar tabel 4 kolom. rows: [{cells:[a,b,c,d], color, bold, band, dots}]
 * dots (opsional) = angka 1-5; kolom ke-4 digambar sebagai bulatan + teks.
 * @returns {number} y baru (di bawah tabel)
 */
function drawTable(ctx, page, y, headers, rows) {
  const { reg, bold, clean } = ctx;
  const cols = [0.2, 0.28, 0.2, 0.32].map((f) => f * CONTENT_W);
  const xs = cols.map((_, i) => MARGIN + cols.slice(0, i).reduce((s, v) => s + v, 0));
  const RH = 20;

  page.drawRectangle({ x: MARGIN, y: y - RH, width: CONTENT_W, height: RH, color: C.head });
  headers.forEach((h, i) => page.drawText(clean(h), { x: xs[i] + 8, y: y - 14, size: 9.5, font: bold, color: C.white }));
  y -= RH;

  for (const r of rows) {
    if (r.band) page.drawRectangle({ x: MARGIN, y: y - RH, width: CONTENT_W, height: RH, color: r.band });
    page.drawLine({ start: { x: MARGIN, y: y - RH }, end: { x: MARGIN + CONTENT_W, y: y - RH }, thickness: 0.4, color: C.line });
    const font = r.bold ? bold : reg;
    r.cells.forEach((cell, i) => {
      let x = xs[i] + 8;
      if (i === 3 && r.dots) {
        for (let d = 0; d < 5; d++) {
          const cx = x + 4 + d * 11;
          const cy = y - 10.5;
          if (d < r.dots) page.drawCircle({ x: cx, y: cy, size: 3.6, color: r.color });
          else page.drawCircle({ x: cx, y: cy, size: 3.6, borderColor: C.muted, borderWidth: 0.7 });
        }
        x += 60;
      }
      page.drawText(clean(cell), { x, y: y - 14, size: i === 3 && r.dots ? 8.5 : 10, font, color: i === 0 || i === 3 ? r.color : C.ink });
    });
    y -= RH;
  }
  return y;
}

function drawChart(ctx, page, y, img, caption) {
  const { reg, clean } = ctx;
  const maxH = y - MARGIN - 34;
  let w = CONTENT_W;
  let h = (img.height / img.width) * w;
  if (h > maxH) { h = maxH; w = (img.width / img.height) * h; }
  page.drawImage(img, { x: MARGIN + (CONTENT_W - w) / 2, y: y - h, width: w, height: h });
  y -= h + 12;
  if (caption) page.drawText(clean(caption), { x: MARGIN, y, size: 7.5, font: reg, color: C.muted });
  return y;
}

function drawFooters(ctx) {
  const { pdf, reg, clean } = ctx;
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN - 4 }, end: { x: PAGE_W - MARGIN, y: MARGIN - 4 }, thickness: 0.4, color: C.line });
    p.drawText(clean("Edukasi, bukan saran finansial."), { x: MARGIN, y: MARGIN - 16, size: 7.5, font: reg, color: C.muted });
    const label = `Halaman ${i + 1}/${pages.length}`;
    p.drawText(label, { x: PAGE_W - MARGIN - reg.widthOfTextAtSize(label, 7.5), y: MARGIN - 16, size: 7.5, font: reg, color: C.muted });
  });
}

function note(ctx, page, y, text, color = C.muted) {
  page.drawText(ctx.clean(text), { x: MARGIN, y, size: 9.5, font: ctx.reg, color });
  return y - 16;
}

function priceLine(ctx, page, y, coin, tf, tick) {
  const txt = `${coin}/USDT ${TF_LABEL[tf]}   |   Harga ${fmtUsd(tick.price)} (${fmtPct(tick.changePct)} 24j)`;
  page.drawText(ctx.clean(txt), { x: MARGIN, y, size: 12, font: ctx.bold, color: C.ink });
  return y - 22;
}

const fmtNow = () =>
  new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " WIB";

// ---------- !snr all ----------
async function buildSnrAllPdf(coin, lang = "id") {
  const { tick, byTf } = await loadAll(coin);
  const ctx = await createDoc(`Support & Resistance ${coin} semua timeframe`);
  const { pdf } = ctx;

  for (const tf of ALL_TFS) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    pageHeader(ctx, page, { title: "AGEMASEN Support & Resistance", sub: `${coin}/USDT  |  Semua timeframe  |  dibuat ${fmtNow()}` });
    let y = PAGE_H - 70 - 28;
    y = priceLine(ctx, page, y, coin, tf, tick);

    const candles = byTf[tf];
    if (!candles) {
      note(ctx, page, y, "Data timeframe ini tidak bisa diambil saat ini.");
      continue;
    }

    const { resistance, support } = computeSnr(candles, tick.price);
    const row = (label, zone, color) => {
      if (!zone) return { cells: [label, "-", "-", "-"], color: C.muted };
      const lv = strengthLevel(zone.touches);
      return {
        cells: [label, fmtLevel(zone.price), fmtPct(pctFrom(tick.price, zone.price)), `${t(lang, `kripto.snr.str.${strengthKey(zone.touches)}`)} (${zone.touches}x)`],
        color,
        dots: lv,
        bold: true,
      };
    };
    const rows = [
      ...[...Array(PER_SIDE).keys()].reverse().map((i) => row(`R${i + 1}`, resistance[i], C.res)),
      { cells: ["Sekarang", fmtLevel(tick.price), "", ""], color: C.now, bold: true, band: C.band },
      ...[...Array(PER_SIDE).keys()].map((i) => row(`S${i + 1}`, support[i], C.sup)),
    ];
    y = drawTable(ctx, page, y, ["Level", "Harga", "Jarak", "Kekuatan"], rows) - 14;

    const r1 = resistance[0];
    const s1 = support[0];
    if (r1 && s1) y = note(ctx, page, y, `Harga ada di antara support ${fmtLevel(s1.price)} dan resistance ${fmtLevel(r1.price)}.`, C.ink);
    else if (!r1 && s1) y = note(ctx, page, y, "Tidak ada resistance di atas harga; perhatikan support di bawah.", C.ink);
    else if (r1 && !s1) y = note(ctx, page, y, "Tidak ada support di bawah harga; perhatikan resistance di atas.", C.ink);
    else y = note(ctx, page, y, "Belum ada level jelas di timeframe ini.", C.ink);

    page.drawText(ctx.clean("R = resistance (atap) | S = support (lantai) | Jarak = dari harga sekarang | (Nx) = berapa kali harga berbalik di zona itu"), {
      x: MARGIN, y, size: 7.5, font: ctx.reg, color: C.muted,
    });
    y -= 16;

    try {
      const png = renderChart({
        candles,
        coin,
        tf: TF_LABEL[tf],
        resistance: resistance.map((z) => z.price),
        support: support.map((z) => z.price),
        dominance: null,
      });
      const img = await pdf.embedPng(png);
      drawChart(ctx, page, y, img, "Candle yang sudah tutup + EMA + garis S/R. Level kuat bukan jaminan harga berbalik.");
    } catch (err) {
      console.log("[kripto] !snr all chart gagal:", tf, err.message);
    }
  }

  drawFooters(ctx);
  return Buffer.from(await pdf.save());
}

// ---------- !fib all ----------
async function buildFibAllPdf(coin, lang = "id") {
  const { tick, byTf } = await loadAll(coin);
  const ctx = await createDoc(`Fibonacci ${coin} semua timeframe`);
  const { pdf } = ctx;

  for (const tf of ALL_TFS) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    pageHeader(ctx, page, { title: "AGEMASEN Fibonacci", sub: `${coin}/USDT  |  Semua timeframe  |  dibuat ${fmtNow()}` });
    let y = PAGE_H - 70 - 28;
    y = priceLine(ctx, page, y, coin, tf, tick);

    const candles = byTf[tf];
    if (!candles) {
      note(ctx, page, y, "Data timeframe ini tidak bisa diambil saat ini.");
      continue;
    }
    const fib = computeFib(candles);
    if (!fib) {
      note(ctx, page, y, "Belum ada swing yang jelas di timeframe ini (pergerakan harga masih terlalu kecil).", C.ink);
      continue;
    }

    const up = fib.trend === "up";
    const swingPct = (Math.abs(fib.end - fib.start) / fib.start) * 100;
    y = note(
      ctx, page, y,
      `${up ? "Tren NAIK" : "Tren TURUN"}: ditarik dari swing ${up ? "low" : "high"} ${fmtLevel(fib.start)} ke swing ${up ? "high" : "low"} ${fmtLevel(fib.end)} (${up ? "+" : "-"}${swingPct.toFixed(1)}%)`,
      up ? C.sup : C.res,
    );
    y -= 4;

    const ratioLabel = (r) => (Number.isInteger(r) && r > 1 ? r.toFixed(1) : String(r));
    const items = [
      ...fib.retracement.map((l) => ({ ...l, ext: false })),
      ...fib.extension.map((l) => ({ ...l, ext: true })),
    ].sort((a, b) => b.price - a.price);

    const rows = items.map((it) => {
      let desc = it.ext ? "Target (extension)" : "Retracement";
      if (!it.ext && (it.ratio === 0.5 || it.ratio === 0.618)) desc = "Golden zone";
      if (!it.ext && it.ratio === 0) desc = up ? "Swing high" : "Swing low";
      if (!it.ext && it.ratio === 1) desc = up ? "Swing low" : "Swing high";
      const golden = !it.ext && (it.ratio === 0.5 || it.ratio === 0.618);
      return {
        cells: [ratioLabel(it.ratio), fmtLevel(it.price), fmtPct(pctFrom(tick.price, it.price)), desc],
        color: it.ext ? C.ext : golden ? C.gold : C.ink,
        bold: golden || it.ratio === 0 || it.ratio === 1,
        price: it.price,
      };
    });
    // sisipkan baris harga sekarang di posisi yang pas (tinggi -> rendah)
    let at = rows.findIndex((r) => r.price < tick.price);
    if (at === -1) at = rows.length;
    rows.splice(at, 0, { cells: ["Sekarang", fmtLevel(tick.price), "", ""], color: C.now, bold: true, band: C.band });

    y = drawTable(ctx, page, y, ["Level", "Harga", "Jarak", "Keterangan"], rows) - 14;

    const depth = retraceDepth(fib, tick.price);
    if (depth < 0) y = note(ctx, page, y, "Harga sudah melewati ujung swing; perhatikan level extension sebagai target berikutnya.", C.ink);
    else if (depth > 1) y = note(ctx, page, y, "Harga sudah menembus awal swing, jadi swing ini mungkin tidak berlaku lagi.", C.ink);
    else y = note(ctx, page, y, `Harga sudah retrace ${(depth * 100).toFixed(1)}% dari swing.`, C.ink);
    y -= 2;

    try {
      const png = renderFibChart({ candles, coin, tf: TF_LABEL[tf], fib });
      const img = await pdf.embedPng(png);
      drawChart(ctx, page, y, img, "Retracement: area harga bisa tertahan saat koreksi. Extension: target kalau tren lanjut.");
    } catch (err) {
      console.log("[kripto] !fib all chart gagal:", tf, err.message);
    }
  }

  drawFooters(ctx);
  return Buffer.from(await pdf.save());
}

// ---------- runner (dipanggil dari kriptoCommand) ----------
async function sendPdf(sock, msg, jid, buf, fileName, caption) {
  await sock.sendMessage(jid, { document: buf, mimetype: "application/pdf", fileName, caption }, { quoted: msg });
}

async function runSnrAll(sock, msg, { jid, lang }, { coin }) {
  const buf = await buildSnrAllPdf(coin, lang);
  await sendPdf(sock, msg, jid, buf, `SNR-${coin}-semua-TF-${stamp()}.pdf`, t(lang, "kripto.all.snr.caption", { coin }));
}

async function runFibAll(sock, msg, { jid, lang }, { coin }) {
  const buf = await buildFibAllPdf(coin, lang);
  await sendPdf(sock, msg, jid, buf, `FIB-${coin}-semua-TF-${stamp()}.pdf`, t(lang, "kripto.all.fib.caption", { coin }));
}

const ALL_RUNNERS = { snr: runSnrAll, fib: runFibAll };

module.exports = { ALL_RUNNERS, buildSnrAllPdf, buildFibAllPdf, ALL_TFS };
