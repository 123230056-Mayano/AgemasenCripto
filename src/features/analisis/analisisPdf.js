"use strict";

/**
 * features/analisis/analisisPdf.js
 * ------------------------------------------------------------------
 * Bikin PDF (A4, bisa multi-halaman) dari hasil /api/analyze milik web
 * KriptoPredict. Pakai pdf-lib (pure JS, tanpa browser/binary tambahan)
 * dan font bawaan Helvetica, jadi aman di Railway/nixpacks.
 *
 * Helvetica cuma bisa Latin (WinAnsi). Teks dari AI/berita dibersihin
 * dulu lewat clean() supaya karakter aneh (emoji, panah, dst) gak bikin
 * pdf-lib error.
 */

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { buildChartPng } = require("./analisisChart");
const { getDominance } = require("../kripto/dominance");

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
  bullish: rgb(0.09, 0.55, 0.3),
  bearish: rgb(0.8, 0.18, 0.18),
  sideways: rgb(0.55, 0.45, 0.1),
  warn: rgb(0.7, 0.4, 0.02),
};

// ---------- format angka ----------
const fmtNum = (v) => {
  if (typeof v !== "number" || !isFinite(v)) return v == null ? "-" : String(v);
  const abs = Math.abs(v);
  const o = abs >= 1 ? { maximumFractionDigits: abs >= 1000 ? 2 : 4 } : { maximumSignificantDigits: 6 };
  return v.toLocaleString("en-US", o);
};
const fmtUsd = (v) => (typeof v === "number" && isFinite(v) ? "$" + fmtNum(v) : "-");
const fmtIdr = (v) => {
  if (typeof v !== "number" || !isFinite(v)) return "-";
  const o = v >= 100 ? { maximumFractionDigits: 0 } : v >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 };
  return "Rp" + v.toLocaleString("id-ID", o);
};
const fmtDate = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "-";
  return (
    d.toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " WIB"
  );
};

// ---------- pembersih teks (WinAnsi only) ----------
const REPLACE = {
  "\u2192": "->", "\u2190": "<-", "\u2191": "naik", "\u2193": "turun",
  "\u2212": "-", "\u2248": "~", "\u2264": "<=", "\u2265": ">=",
  "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"',
  "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00A0": " ",
};

function makeCleaner(font) {
  const ok = new Map();
  const canEncode = (ch) => {
    if (ok.has(ch)) return ok.get(ch);
    let r = true;
    try { font.encodeText(ch); } catch { r = false; }
    ok.set(ch, r);
    return r;
  };
  return (s) => {
    let out = "";
    for (const ch of String(s ?? "").replace(/\r?\n+/g, " ")) {
      if (REPLACE[ch] !== undefined) out += REPLACE[ch];
      else if (canEncode(ch)) out += ch;
      else if (/\s/.test(ch)) out += " ";
      // karakter lain (emoji, CJK, dst) dibuang
    }
    return out.replace(/ {2,}/g, " ").trim();
  };
}

/**
 * @param {object} data  hasil /api/analyze
 * @param {object} [fx]  kurs USD->IDR
 * @param {object} [opts]
 * @param {Array}  [opts.candles]  candle siap pakai (opsional; default diambil dari Binance)
 */
async function buildAnalysisPdf(data, fx, opts = {}) {
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const clean = makeCleaner(reg);

  const report = data.report || {};
  const main = data.backend?.main || {};
  const ctx = data.backend?.context || {};
  const ind = main.indicators || {};
  const trendColor = C[report.trend] || C.muted;

  // Grafik candlestick. Kalau gagal (Binance down, dst) PDF tetap jadi, hanya tanpa grafik.
  let chartImg = null;
  try {
    const png = await buildChartPng(data, { candles: opts.candles });
    chartImg = await pdf.embedPng(png);
  } catch (err) {
    console.log("[analisis] grafik dilewati:", err.response?.status || err.message);
  }

  // Dominance: pakai angka dari web analyst bila ada, kalau tidak ambil langsung (CoinGecko). Gagal -> "-".
  const domNow = ctx.btc_dominance?.btc_dominance_pct != null
    ? { btc: Number(ctx.btc_dominance.btc_dominance_pct), eth: null, usdt: null }
    : null;
  let dom = null;
  try {
    dom = await getDominance(data.backend?.timeframe || report.timeframe, Date.now() - 30 * 86_400_000);
  } catch { /* abaikan */ }
  const domBtc = domNow?.btc ?? dom?.now?.btc ?? null;
  const pctOrDash = (v) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(2)}%` : "-");

  pdf.setTitle(`Analisis ${main.coin || ""} ${data.backend?.timeframe || ""}`.trim());
  pdf.setAuthor("AGEMASEN Crypto Analyst");
  pdf.setCreationDate(new Date());

  let page, y;

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const need = (h) => { if (y - h < MARGIN + 18) newPage(); };

  const wrap = (text, font, size, width) => {
    const words = clean(text).split(" ").filter(Boolean);
    const lines = [];
    let cur = "";
    for (let w of words) {
      // kata kepanjangan (URL dll) dipotong paksa
      while (font.widthOfTextAtSize(w, size) > width) {
        let cut = w.length;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        if (cur) { lines.push(cur); cur = ""; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const test = cur ? cur + " " + w : w;
      if (font.widthOfTextAtSize(test, size) <= width) cur = test;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  };

  const text = (str, o = {}) => {
    const { size = 10, font = reg, color = C.ink, indent = 0, gap = 3, lead = 1.38 } = o;
    const lines = wrap(str, font, size, CONTENT_W - indent);
    for (const ln of lines) {
      need(size * lead);
      y -= size * lead;
      page.drawText(ln, { x: MARGIN + indent, y: y + size * 0.28, size, font, color });
    }
    y -= gap;
  };

  const bullet = (str, o = {}) => {
    const size = o.size || 10;
    const lines = wrap(str, reg, size, CONTENT_W - 14);
    lines.forEach((ln, i) => {
      need(size * 1.38);
      y -= size * 1.38;
      if (i === 0) page.drawCircle({ x: MARGIN + 4, y: y + size * 0.62, size: 1.5, color: o.color || C.muted });
      page.drawText(ln, { x: MARGIN + 14, y: y + size * 0.28, size, font: reg, color: o.color || C.ink });
    });
    y -= 2.5;
  };

  const heading = (str, color = C.head) => {
    need(34);
    y -= 12;
    page.drawText(clean(str).toUpperCase(), { x: MARGIN, y: y - 4, size: 10.5, font: bold, color });
    y -= 9;
    page.drawLine({ start: { x: MARGIN, y: y - 3 }, end: { x: PAGE_W - MARGIN, y: y - 3 }, thickness: 0.8, color: C.line });
    y -= 9;
  };

  const kv = (rows) => {
    for (const [k, v] of rows) {
      const lines = wrap(v, bold, 9.5, CONTENT_W - 150);
      const h = Math.max(1, lines.length) * 13 + 3;
      need(h);
      page.drawText(clean(k), { x: MARGIN, y: y - 11, size: 9.5, font: reg, color: C.muted });
      lines.forEach((ln, i) =>
        page.drawText(ln, { x: MARGIN + 150, y: y - 11 - i * 13, size: 9.5, font: bold, color: C.ink }),
      );
      y -= h;
      page.drawLine({ start: { x: MARGIN, y: y + 0.5 }, end: { x: PAGE_W - MARGIN, y: y + 0.5 }, thickness: 0.4, color: C.line });
    }
    y -= 4;
  };

  // ================= HEADER =================
  newPage();
  page.drawRectangle({ x: 0, y: PAGE_H - 78, width: PAGE_W, height: 78, color: C.head });
  page.drawText("AGEMASEN Crypto Analyst", { x: MARGIN, y: PAGE_H - 38, size: 18, font: bold, color: C.white });
  page.drawText(
    clean(`Laporan analisis teknikal  |  dibuat ${fmtDate(data.backend?.generated_at || report.generated_at || Date.now())}`),
    { x: MARGIN, y: PAGE_H - 58, size: 9, font: reg, color: rgb(0.75, 0.8, 0.9) },
  );
  y = PAGE_H - 78 - 10;

  // Ringkasan: koin + harga + tren
  const title = `${main.coin || report.asset || "?"}  ${data.backend?.timeframe || report.timeframe || ""}`;
  y -= 24;
  page.drawText(clean(title), { x: MARGIN, y, size: 22, font: bold, color: C.ink });
  const badge = clean(String(report.trend || "-")).toUpperCase();
  const bw = bold.widthOfTextAtSize(badge, 11) + 22;
  page.drawRectangle({ x: PAGE_W - MARGIN - bw, y: y - 5, width: bw, height: 24, color: trendColor });
  page.drawText(badge, { x: PAGE_W - MARGIN - bw + 11, y: y + 2, size: 11, font: bold, color: C.white });
  y -= 10;

  kv([
    ["Harga (USD)", fmtUsd(main.price)],
    ["Harga (Rupiah)", fx?.rate ? fmtIdr(main.price * fx.rate) : "kurs belum tersedia"],
    ["Candle terakhir (mulai)", fmtDate(main.last_close_time)],
    ["Perubahan 30 candle", typeof main.change_30_candles_pct === "number" ? `${main.change_30_candles_pct}%` : "-"],
    ["Confidence AI", typeof report.confidence === "number" ? `${Math.round(report.confidence * 100)}%` : "-"],
    ["Data memadai", report.data_sufficient === false ? "Tidak" : "Ya"],
  ]);
  if (fx?.rate) {
    text(`Kurs 1 USD = ${fmtIdr(fx.rate)} (${fx.source || "-"}). Harga dari pasangan USDT di Binance, dianggap setara USD.`, { size: 8, color: C.muted });
  }

  // ================= GRAFIK =================
  if (chartImg) {
    heading("Grafik");
    const w = CONTENT_W;
    const h = (chartImg.height / chartImg.width) * w;
    need(h + 22);
    page.drawImage(chartImg, { x: MARGIN, y: y - h, width: w, height: h });
    y -= h + 4;
    text(
      "Candle yang sudah tutup, zona waktu WIB. Garis R/S adalah level kunci dari analisis; EMA dihitung dari data yang sama dengan indikator di bawah. Panel bawah: MACD (12,26,9), RSI 14, dan dominance (BTC.D / ETH.D) dari CoinMarketCap + CoinGecko.",
      { size: 8, color: C.muted },
    );
  }

  if (data.warnings?.length) {
    heading("Peringatan validasi", C.warn);
    data.warnings.forEach((w) => bullet(w, { size: 9, color: C.warn }));
  }

  // ================= INDIKATOR =================
  heading("Indikator (dihitung backend)");
  kv([
    ["RSI 14", fmtNum(ind.rsi14)],
    ["EMA 20 / 50 / 200", `${fmtNum(ind.ema20)} / ${fmtNum(ind.ema50)} / ${fmtNum(ind.ema200)}`],
    ["MACD / Signal / Histogram", ind.macd ? `${fmtNum(ind.macd.macd)} / ${fmtNum(ind.macd.signal)} / ${fmtNum(ind.macd.histogram)}` : "-"],
    ["ATR 14", fmtNum(ind.atr14)],
    ["Fear & Greed", ctx.fear_greed ? `${ctx.fear_greed.value} (${ctx.fear_greed.label})` : "-"],
    ["Dominasi BTC (BTC.D)", `${pctOrDash(domBtc)}  (sumber: ${domNow ? "web analyst" : "CoinGecko"})`],
    ["Dominasi ETH / USDT", `${pctOrDash(dom?.now?.eth)} / ${pctOrDash(dom?.now?.usdt)}`],
  ]);

  // ================= LEVEL KUNCI =================
  heading("Level kunci");
  kv([
    ["Resistance", (report.key_levels?.resistance || []).map(fmtNum).join(", ") || "-"],
    ["Support", (report.key_levels?.support || []).map(fmtNum).join(", ") || "-"],
  ]);
  if (report.no_trade_note) text(`No trade: ${report.no_trade_note}`, { size: 9.5 });

  // ================= FAKTA & INTERPRETASI =================
  if (report.facts?.length) {
    heading("Fakta");
    report.facts.forEach((f) => bullet(`${f.text}${f.source ? ` (${f.source})` : ""}`, { size: 9.5 }));
  }
  if (report.interpretation?.length) {
    heading("Interpretasi");
    report.interpretation.forEach((t) => bullet(t, { size: 9.5 }));
  }

  // ================= SKENARIO =================
  for (const k of ["bullish", "bearish"]) {
    const s = report.scenarios?.[k];
    if (!s) continue;
    heading(`Skenario ${k}`, C[k]);
    text(`Trigger: ${s.trigger || "-"}`, { size: 9.5 });
    text(`Target: ${s.target || "-"}`, { size: 9.5 });
    text(`Invalidasi: ${s.invalidation || "-"}`, { size: 9.5 });
    const c = s.calc;
    if (c) {
      text(`Risk/Reward 1 : ${c.rr}   |   Potensi +${c.reward_pct}% ke ${fmtNum(c.target)}   |   Risiko -${c.risk_pct}% ke ${fmtNum(c.stop)}`, { size: 9.5, font: bold, color: C[k] });
      text(
        `Trigger ${fmtNum(c.entry)} (${c.entry_dist_pct > 0 ? "+" : ""}${c.entry_dist_pct}% dari harga sekarang). Dihitung jika masuk di harga trigger, belum termasuk biaya dan slippage.${c.rr < 1 ? " Potensi lebih kecil daripada risikonya." : ""}`,
        { size: 8, color: C.muted },
      );
    } else {
      text("Rasio risk/reward tidak tersedia untuk skenario ini.", { size: 8.5, color: C.muted });
    }
  }

  // ================= BERITA =================
  const news = ctx.news;
  heading("Berita 24 jam terakhir");
  if (!news || news.status === "unavailable") {
    text("Berita tidak dapat dimuat saat ini, jadi analisis hanya memakai data harga dan indikator.", { size: 9.5, color: C.muted });
  } else {
    const impacts = new Map((report.news_impact || []).map((i) => [i.ref, i]));
    const list = (items) =>
      items.forEach((n) => {
        bullet(n.title, { size: 9.5 });
        text(`${n.source || ""}${n.published ? " | " + fmtDate(n.published) : ""}`, { size: 8, color: C.muted, indent: 14, gap: 1 });
        const imp = impacts.get(n.ref);
        if (imp) text(`Dampak ${imp.impact}: ${imp.reason}`, { size: 8.5, indent: 14, gap: 4 });
      });
    if (news.coin?.length) { text(`Menyebut ${main.coin}`, { size: 9.5, font: bold }); list(news.coin); }
    else text(`Tidak ada headline yang menyebut ${main.coin} dalam 24 jam terakhir.`, { size: 9.5, color: C.muted });
    if (news.market?.length) { text("Berita pasar umum", { size: 9.5, font: bold }); list(news.market); }
    text("Penilaian dampak adalah tafsiran AI dari judul saja, bukan fakta, dan berita sering terlambat dibanding pergerakan harga.", { size: 8, color: C.muted });
  }

  // ================= RISIKO =================
  if (report.risks?.length) {
    heading("Risiko");
    report.risks.forEach((t) => bullet(t, { size: 9.5 }));
  }
  if (report.disclaimer) {
    y -= 6;
    text(report.disclaimer, { size: 8, color: C.muted });
  }

  // ================= FOOTER semua halaman =================
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN - 4 }, end: { x: PAGE_W - MARGIN, y: MARGIN - 4 }, thickness: 0.4, color: C.line });
    p.drawText("Analisis edukatif, bukan sinyal trading.", { x: MARGIN, y: MARGIN - 16, size: 7.5, font: reg, color: C.muted });
    const label = `Halaman ${i + 1}/${pages.length}`;
    p.drawText(label, { x: PAGE_W - MARGIN - reg.widthOfTextAtSize(label, 7.5), y: MARGIN - 16, size: 7.5, font: reg, color: C.muted });
  });

  return Buffer.from(await pdf.save());
}

module.exports = { buildAnalysisPdf, fmtUsd, fmtIdr };