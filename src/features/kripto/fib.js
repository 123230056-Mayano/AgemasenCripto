"use strict";

/**
 * features/kripto/fib.js
 * ------------------------------------------------------------------
 * !fib <koin> [tf]  -> Fibonacci retracement + extension otomatis:
 *   - swing diambil dari high tertinggi & low terendah dalam LOOKBACK candle terakhir
 *   - arah tarikan mengikuti TREN (ditentukan urutan waktunya):
 *       swing low lebih dulu, swing high belakangan  -> tren naik  -> ditarik LOW -> HIGH
 *       swing high lebih dulu, swing low belakangan  -> tren turun -> ditarik HIGH -> LOW
 *   - retracement: 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1  (area koreksi / pullback)
 *   - extension  : 1.272, 1.618, 2.0, 2.618               (target kalau tren lanjut)
 *   - gambar chart (candle + garis level + panah swing) sekalian
 *
 * Beda dengan !snr: S/R dihitung dari seberapa sering harga memantul di satu zona,
 * sedangkan fib dihitung dari rasio SATU ayunan harga (swing).
 * Data langsung dari Binance (market.js), tidak butuh ANALYST_URL.
 */

const { createCanvas } = require("@napi-rs/canvas");
const { t } = require("../../i18n");
const { C, fontFamily, fmtPrice, niceStep, tickLabel, arrow, dot, chip } = require("./chartKit");
const { TF_LABEL, fetchCandles, fetchTicker, fmtUsd, fmtLevel, fmtPct, pctFrom } = require("./market");

const LOOKBACK = 120; // jumlah candle terakhir yang dicari swing high/low-nya
const MIN_SWING_PCT = 0.01; // swing lebih kecil dari 1% dianggap belum ada swing yang jelas
const MIN_VISIBLE = 60; // minimal candle yang digambar
const MAX_VISIBLE = 200; // maksimal candle yang digambar
const CAPTION_MAX = 1000; // batas aman caption gambar WhatsApp (1024)

const RETR = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const EXT = [1.272, 1.618, 2, 2.618];
const CHART_EXT_MAX = 1.618; // extension di atas ini cuma tampil di teks (kalau digambar, candle jadi gepeng)

const ratioLabel = (r) => (Number.isInteger(r) && r > 1 ? r.toFixed(1) : String(r));
const isGolden = (r) => r === 0.5 || r === 0.618;

/**
 * Cari swing utama lalu hitung semua level fib.
 *
 * @param {Array<{t,o,h,l,c}>} candles  candle closed, urut lama -> baru
 * @returns {null | {
 *   trend: "up"|"down", startIdx:number, endIdx:number, start:number, end:number, range:number,
 *   retracement: {ratio:number, price:number}[], extension: {ratio:number, price:number}[]
 * }} null kalau belum ada swing yang jelas
 */
function computeFib(candles, { lookback = LOOKBACK } = {}) {
  if (!candles || candles.length < 10) return null;
  const offset = Math.max(0, candles.length - lookback);
  const slice = candles.slice(offset);

  let hiI = 0;
  let loI = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].h >= slice[hiI].h) hiI = i; // seri -> ambil yang paling baru
    if (slice[i].l <= slice[loI].l) loI = i;
  }
  const hi = slice[hiI].h;
  const lo = slice[loI].l;
  if (!(hi > lo) || (hi - lo) / lo < MIN_SWING_PCT) return null;

  // Tren = urutan waktu kedua ekstrem. Kalau jatuh di candle yang sama (candle raksasa), ikut warna candle.
  let up;
  if (loI !== hiI) up = loI < hiI;
  else up = slice[hiI].c >= slice[hiI].o;

  const startIdx = offset + (up ? loI : hiI);
  const endIdx = offset + (up ? hiI : loI);
  const start = up ? lo : hi;
  const end = up ? hi : lo;
  const range = hi - lo;

  // up  : retracement turun dari swing high; extension diproyeksikan ke atas swing high
  // down: retracement naik dari swing low;   extension diproyeksikan ke bawah swing low
  const retracement = RETR.map((ratio) => ({ ratio, price: up ? end - ratio * range : end + ratio * range }));
  const extension = EXT.map((ratio) => ({ ratio, price: up ? start + ratio * range : start - ratio * range }));

  return { trend: up ? "up" : "down", startIdx, endIdx, start, end, range, retracement, extension };
}

/** Seberapa dalam harga sudah retrace dari ujung swing (0 = di ujung, 1 = balik ke awal swing). */
function retraceDepth(fib, price) {
  return fib.trend === "up" ? (fib.end - price) / fib.range : (price - fib.end) / fib.range;
}

// ---------- chart ----------
const RETR_COLOR = { 0: "#8b93a1", 0.236: "#60a5fa", 0.382: "#4ade80", 0.5: "#facc15", 0.618: "#fb923c", 0.786: "#f472b6", 1: "#8b93a1" };
const EXT_COLOR = { 1.272: "#a78bfa", 1.618: "#c084fc", 2: "#e879f9", 2.618: "#f0abfc" };

/**
 * @returns {Buffer} PNG
 */
function renderFibChart({ candles, coin, tf, fib }) {
  if (!candles || candles.length < 10) throw new Error("CANDLES_TOO_FEW");
  const family = fontFamily();
  const n = candles.length;
  const last = candles[n - 1];
  const up = fib.trend === "up";

  // ----- jendela candle: mulai sedikit sebelum awal swing, minimal MIN_VISIBLE, maksimal MAX_VISIBLE -----
  let from = Math.min(Math.max(0, fib.startIdx - 6), Math.max(0, n - MIN_VISIBLE));
  from = Math.max(from, n - MAX_VISIBLE, 0);
  const bars = candles.slice(from);
  const nb = bars.length;

  // ----- level yang digambar -----
  const drawn = [
    ...fib.retracement.map((l) => ({ ...l, label: ratioLabel(l.ratio), color: RETR_COLOR[l.ratio], ext: false })),
    ...fib.extension.filter((l) => l.ratio <= CHART_EXT_MAX).map((l) => ({ ...l, label: ratioLabel(l.ratio), color: EXT_COLOR[l.ratio], ext: true })),
  ];

  // ----- rentang harga (Y) -----
  let lo = Math.min(...bars.map((b) => b.l), last.c);
  let hi = Math.max(...bars.map((b) => b.h), last.c);
  for (const l of drawn) {
    lo = Math.min(lo, l.price);
    hi = Math.max(hi, l.price);
  }
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad;
  hi += pad;

  // ----- kanvas & panel -----
  const W = 1600;
  const Lm = 20;
  const Rm = 190;
  const T = 74;
  const hP = 760;
  const B = 52;
  const H = T + hP + B;
  const cw = W - Lm - Rm;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const pPrice = { x: Lm, y: T, w: cw, h: hP };
  g.fillStyle = C.panel;
  g.fillRect(pPrice.x, pPrice.y, pPrice.w, pPrice.h);

  const Yp = (p) => pPrice.y + ((hi - p) / (hi - lo)) * pPrice.h;
  const slot = cw / nb;
  const X = (i) => Lm + slot * (i - from) + slot / 2;
  const bodyW = Math.max(2, slot * 0.62);

  // ----- grid + label harga -----
  g.font = `19px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineWidth = 1;
  const step = niceStep(hi - lo, 8);
  const tagYs = [...drawn.map((l) => Yp(l.price)), Yp(last.c)]; // posisi tag level, label grid yang bertabrakan disembunyikan
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(Yp(p)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(pPrice.x, yy);
    g.lineTo(pPrice.x + pPrice.w, yy);
    g.stroke();
    if (tagYs.some((ty) => Math.abs(ty - yy) < 18)) continue;
    g.fillStyle = C.axis;
    g.fillText(fmtPrice(p), pPrice.x + pPrice.w + 10, yy);
  }

  // ----- grid vertikal + label waktu -----
  g.textAlign = "center";
  g.textBaseline = "top";
  const every = Math.max(1, Math.round(nb / 7));
  for (let i = Math.min(every, 3); i < nb - 2; i += every) {
    const xx = Math.round(X(from + i)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(xx, pPrice.y);
    g.lineTo(xx, pPrice.y + pPrice.h);
    g.stroke();
    g.fillStyle = C.axis;
    g.fillText(tickLabel(bars[i].t, tf), xx, pPrice.y + pPrice.h + 14);
  }

  // ----- golden zone 0.5 - 0.618 (di bawah garis & candle) -----
  {
    const a = fib.retracement.find((l) => l.ratio === 0.5).price;
    const b = fib.retracement.find((l) => l.ratio === 0.618).price;
    const y1 = Yp(Math.max(a, b));
    const y2 = Yp(Math.min(a, b));
    g.save();
    g.globalAlpha = 0.1;
    g.fillStyle = RETR_COLOR[0.618];
    g.fillRect(pPrice.x, y1, pPrice.w, y2 - y1);
    g.restore();
  }

  // ----- garis level (dari awal swing sampai tepi kanan) -----
  const x0 = Math.max(pPrice.x, X(Math.max(fib.startIdx, from)));
  for (const l of drawn) {
    const yy = Math.round(Yp(l.price)) + 0.5;
    const edge = l.ratio === 0 || l.ratio === 1;
    g.save();
    g.strokeStyle = l.color;
    g.lineWidth = edge ? 2 : isGolden(l.ratio) ? 2.2 : 1.6;
    if (!edge) g.setLineDash([10, 7]);
    g.globalAlpha = 0.9;
    g.beginPath();
    g.moveTo(x0, yy);
    g.lineTo(pPrice.x + pPrice.w, yy);
    g.stroke();
    g.restore();
  }

  // ----- candle -----
  g.lineWidth = 1.4;
  bars.forEach((b, k) => {
    const i = from + k;
    const color = b.c >= b.o ? C.up : C.down;
    const xx = Math.round(X(i)) + 0.5;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(xx, Yp(b.h));
    g.lineTo(xx, Yp(b.l));
    g.stroke();
    g.fillRect(xx - bodyW / 2, Yp(Math.max(b.o, b.c)), bodyW, Math.max(1.5, Math.abs(Yp(b.o) - Yp(b.c))));
  });

  // ----- harga terakhir (garis putus) -----
  {
    const yy = Yp(last.c);
    g.save();
    g.strokeStyle = last.c >= last.o ? C.up : C.down;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(pPrice.x, Math.round(yy) + 0.5);
    g.lineTo(pPrice.x + pPrice.w, Math.round(yy) + 0.5);
    g.stroke();
    g.restore();
  }

  // ----- frame -----
  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.strokeRect(pPrice.x + 0.5, pPrice.y + 0.5, pPrice.w, pPrice.h);

  // ----- tag sumbu kanan: tiap level fib + harga terakhir (yang berdekatan digeser supaya terbaca) -----
  const tag = (txt, yy, color) => {
    g.save();
    g.font = `bold 19px ${family}`;
    g.fillStyle = color;
    g.fillRect(pPrice.x + pPrice.w + 4, yy - 13, Rm - 8, 26);
    g.fillStyle = "#0b0e14";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(txt, pPrice.x + pPrice.w + 10, yy + 1);
    g.restore();
  };
  {
    const lastColor = last.c >= last.o ? C.up : C.down;
    const tags = [
      ...drawn.map((l) => ({ txt: `${l.label} ${fmtPrice(l.price)}`, y: Yp(l.price), color: l.color })),
      { txt: fmtPrice(last.c), y: Yp(last.c), color: lastColor },
    ].sort((a, b) => a.y - b.y);
    const gapY = 28;
    for (let i = 1; i < tags.length; i++) tags[i].ty = Math.max(tags[i].y, (tags[i - 1].ty ?? tags[i - 1].y) + gapY);
    if (tags.length) tags[0].ty = tags[0].y;
    for (const tg of tags) tag(tg.txt, Math.min(tg.ty ?? tg.y, pPrice.y + pPrice.h - 14), tg.color);
  }

  // ----- panah swing (dari awal ke ujung swing) + chip label -----
  const ax = X(Math.max(fib.startIdx, from));
  const ay = Yp(fib.start);
  const bx = X(fib.endIdx);
  const by = Yp(fib.end);
  arrow(g, ax, ay, bx, by);
  dot(g, ax, ay);
  const placed = [];
  const swingTxt = (isHigh, price) => `swing ${isHigh ? "high" : "low"} ${fmtPrice(price)}`;
  chip(g, family, swingTxt(!up, fib.start), ax + 70, ay + (up ? 30 : -30), pPrice, C.arrow, placed);
  chip(g, family, swingTxt(up, fib.end), bx - 40, by + (up ? -30 : 30), pPrice, C.arrow, placed);

  // ----- judul + legenda -----
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.font = `bold 28px ${family}`;
  g.fillStyle = C.title;
  const title = `${coin}/USDT  ${tf}  Fibonacci`;
  g.fillText(title, Lm, 26);
  const titleW = g.measureText(title).width;
  const prev = candles[Math.max(0, n - 2)];
  const chgLast = ((last.c - prev.c) / prev.c) * 100;
  g.font = `22px ${family}`;
  g.fillStyle = last.c >= prev.c ? C.up : C.down;
  g.fillText(`${fmtPrice(last.c)}  (${chgLast >= 0 ? "+" : ""}${chgLast.toFixed(2)}%)`, Lm + titleW + 20, 27);
  g.font = `19px ${family}`;
  g.fillStyle = C.axis;
  g.fillText(`Close candle only · swing = highest high / lowest low of last ${LOOKBACK} candles · ${up ? "Uptrend (low → high)" : "Downtrend (high → low)"}`, Lm, 56);

  return canvas.toBuffer("image/png");
}

// ---------- teks ----------
function rowIcon(item) {
  if (item.ext) return "🎯";
  if (isGolden(item.ratio)) return "⭐";
  if (item.ratio === 0 || item.ratio === 1) return "📍";
  return "▫️";
}

function buildRows(lang, fib, price) {
  const up = fib.trend === "up";
  const items = [
    ...fib.retracement.map((l) => ({ ...l, ext: false })),
    ...fib.extension.map((l) => ({ ...l, ext: true })),
  ].sort((a, b) => b.price - a.price); // harga tinggi -> rendah, sama dengan posisi di chart

  const lines = items.map((it) => {
    let suffix = "";
    if (!it.ext && it.ratio === 0) suffix = ` · ${t(lang, up ? "kripto.fib.swingHigh" : "kripto.fib.swingLow")}`;
    if (!it.ext && it.ratio === 1) suffix = ` · ${t(lang, up ? "kripto.fib.swingLow" : "kripto.fib.swingHigh")}`;
    return { price: it.price, text: `${rowIcon(it)} ${ratioLabel(it.ratio)}  ${fmtLevel(it.price)} (${fmtPct(pctFrom(price, it.price))})${suffix}` };
  });

  // sisipkan baris "harga sekarang" di posisi yang pas
  const nowRow = `▶️ ${t(lang, "kripto.fib.now")} ${fmtLevel(price)}`;
  let at = lines.findIndex((l) => l.price < price);
  if (at === -1) at = lines.length;
  const out = lines.map((l) => l.text);
  out.splice(at, 0, nowRow);
  return out.join("\n");
}

function buildNote(lang, fib, price) {
  const depth = retraceDepth(fib, price);
  if (depth < 0) return t(lang, "kripto.fib.beyond");
  if (depth > 1) return t(lang, "kripto.fib.broken");
  // cari dua level retracement yang mengapit harga
  const r = fib.retracement;
  let k = 0;
  for (let i = 0; i < r.length - 1; i++) if (depth >= r[i].ratio) k = i;
  const a = r[k];
  const b = r[Math.min(k + 1, r.length - 1)];
  return t(lang, "kripto.fib.depth", {
    pct: (depth * 100).toFixed(1),
    a: `${ratioLabel(a.ratio)} (${fmtLevel(a.price)})`,
    b: `${ratioLabel(b.ratio)} (${fmtLevel(b.price)})`,
  });
}

async function runFib(sock, msg, { jid, lang }, { coin, tf }) {
  const [candles, tick] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin)]);
  const fib = computeFib(candles);
  if (!fib) {
    await sock.sendMessage(jid, { text: t(lang, "kripto.fib.none", { coin, tf: TF_LABEL[tf] }) }, { quoted: msg });
    return;
  }

  const up = fib.trend === "up";
  const swingPct = (Math.abs(fib.end - fib.start) / fib.start) * 100; // besar swing dihitung dari titik awal swing
  const trend = t(lang, up ? "kripto.fib.trendUp" : "kripto.fib.trendDown", {
    from: fmtLevel(fib.start),
    to: fmtLevel(fib.end),
    pct: swingPct.toFixed(1),
  });

  const caption = t(lang, "kripto.fib.body", {
    coin,
    tf: TF_LABEL[tf],
    price: fmtUsd(tick.price),
    change: fmtPct(tick.changePct),
    trend,
    rows: buildRows(lang, fib, tick.price),
    note: buildNote(lang, fib, tick.price),
  });

  // Kalau render gagal (mis. font/canvas bermasalah) tetap kirim versi teks supaya fitur tidak mati total.
  let png = null;
  try {
    png = renderFibChart({ candles, coin, tf: TF_LABEL[tf], fib });
  } catch (err) {
    console.log("[kripto] !fib chart gagal, kirim teks saja:", err.message);
  }

  if (!png) {
    await sock.sendMessage(jid, { text: caption }, { quoted: msg });
  } else if (caption.length <= CAPTION_MAX) {
    await sock.sendMessage(jid, { image: png, caption }, { quoted: msg });
  } else {
    // Batas caption WhatsApp 1024 karakter -> kalau lebih, gambar dan teks dikirim terpisah.
    await sock.sendMessage(jid, { image: png }, { quoted: msg });
    await sock.sendMessage(jid, { text: caption });
  }
}

module.exports = { runFib, computeFib, retraceDepth, renderFibChart, LOOKBACK };
