"use strict";

/**
 * features/kripto/divChart.js
 * ------------------------------------------------------------------
 * Gambar chart divergence per koin (PNG), dipakai !scandivergent <koin> [tf].
 *
 * Tiga panel (tema gelap): harga (candlestick), MACD (histogram + garis), RSI.
 * Tiap divergence hasil detectDivergence() digambar sebagai panah biru dari pivot 1 ke pivot 2:
 *   - di panel harga  : dari low/high pivot 1 ke pivot 2, label perubahan harga (%)
 *   - di panel RSI/MACD: dari nilai indikator pivot 1 ke pivot 2, label "a -> b (selisih)"
 * Indikator dihitung ulang dari deret closed yang sama dengan detektornya, jadi panah selalu jatuh
 * persis di titik yang dipakai deteksi. Panah RSI/MACD berpangkal di lembah/puncak indikator sendiri
 * (pivot.indIdx), bisa bergeser 1-3 candle dari pivot harga; angka label = nilai di titik itu.
 *
 * Fungsi murni (tanpa fetch / kirim pesan). Melempar error kalau candle kurang; pemanggil menanganinya.
 */

const { createCanvas } = require("@napi-rs/canvas");
const { rsi, macd } = require("./indicators");
const { INDICATOR_CONFIG } = require("../../config/indicatorConfig");
const { DIV } = require("./divergence");
const { C, fontFamily, fmtPrice, niceStep, tickLabel, arrow, dot, chip } = require("./chartKit");

const VISIBLE = 140; // jumlah candle yang digambar (diperlebar otomatis agar pivot 1 ikut masuk)
// Nilai indikator: 2 desimal, tapi tetap terbaca untuk koin berharga sangat kecil (MACD bisa ~0.00001).
const fmtInd = (v) => {
  if (typeof v !== "number" || !isFinite(v)) return "-";
  const a = Math.abs(v);
  if (a === 0) return "0.00";
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toPrecision(3);
};
const fmtSigned = (v) => (v > 0 ? "+" : v < 0 ? "-" : "") + fmtInd(Math.abs(v));

/**
 * @param {object} o
 * @param {Array<{t,o,h,l,c}>} o.candles  closed, lama -> baru (deret yang sama dengan yang dipakai detektor)
 * @param {string} o.coin
 * @param {string} o.tf        "15m" | "1H" | "4H" | "1D"
 * @param {Array} o.divs       hasil detectDivergence() yang sudah difilter
 * @param {{bull:string,bear:string,regular:string,hidden:string}} [o.labels]
 * @returns {Buffer} PNG
 */
function renderDivChart({ candles, coin, tf, divs = [], labels = {} }) {
  if (!candles || candles.length < 40) throw new Error("CANDLES_TOO_FEW");
  const family = fontFamily();
  const L = {
    bull: labels.bull || "Bullish",
    bear: labels.bear || "Bearish",
    regular: labels.regular || "Regular",
    hidden: labels.hidden || "Hidden",
  };

  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const rsiS = rsi(closes, INDICATOR_CONFIG.RSI_PERIOD);
  const m = macd(closes);

  // jendela tampil: minimal VISIBLE candle, melebar sampai pivot 1 tertua masuk
  let from = Math.max(0, n - VISIBLE);
  if (divs.length) from = Math.max(0, Math.min(from, Math.min(...divs.map((d) => d.pivot1.idx)) - 8));
  const bars = candles.slice(from);
  const nb = bars.length;

  // ----- kanvas & panel -----
  const W = 1600;
  const Lm = 20;
  const Rm = 130;
  const T = 74;
  const gap = 16;
  const hP = 640;
  const hM = 260;
  const hR = 260;
  const B = 52;
  const H = T + hP + gap + hM + gap + hR + B;
  const cw = W - Lm - Rm;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);

  const pPrice = { x: Lm, y: T, w: cw, h: hP };
  const pMacd = { x: Lm, y: T + hP + gap, w: cw, h: hM };
  const pRsi = { x: Lm, y: T + hP + gap + hM + gap, w: cw, h: hR };
  for (const p of [pPrice, pMacd, pRsi]) {
    g.fillStyle = C.panel;
    g.fillRect(p.x, p.y, p.w, p.h);
  }

  const slot = cw / nb;
  const X = (i) => Lm + slot * (i - from) + slot / 2;
  const bodyW = Math.max(2, slot * 0.62);

  // ----- skala harga -----
  let lo = Math.min(...bars.map((b) => b.l));
  let hi = Math.max(...bars.map((b) => b.h));
  const pad = (hi - lo) * 0.09 || hi * 0.01;
  lo -= pad;
  hi += pad;
  const Yp = (v) => pPrice.y + ((hi - v) / (hi - lo)) * pPrice.h;

  // ----- skala MACD -----
  let mLo = Infinity;
  let mHi = -Infinity;
  for (let i = from; i < n; i++) {
    for (const v of [m.hist[i], m.macd[i], m.signal[i]]) {
      if (v == null) continue;
      if (v < mLo) mLo = v;
      if (v > mHi) mHi = v;
    }
  }
  if (!isFinite(mLo) || mHi === mLo) {
    mLo = -1;
    mHi = 1;
  }
  mLo = Math.min(mLo, 0);
  mHi = Math.max(mHi, 0);
  const mPad = (mHi - mLo) * 0.12;
  mLo -= mPad;
  mHi += mPad;
  const Ym = (v) => pMacd.y + ((mHi - v) / (mHi - mLo)) * pMacd.h;

  // ----- skala RSI (tetap 0..100, sedikit ruang) -----
  const Yr = (v) => pRsi.y + ((104 - v) / 108) * pRsi.h;

  // ----- grid + label sumbu -----
  g.font = `19px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineWidth = 1;
  const hline = (yy, label, color = C.grid, dashed = false, p) => {
    const y = Math.round(yy) + 0.5;
    g.save();
    g.strokeStyle = color;
    if (dashed) g.setLineDash([6, 6]);
    g.beginPath();
    g.moveTo(p.x, y);
    g.lineTo(p.x + p.w, y);
    g.stroke();
    g.restore();
    if (label != null) {
      g.fillStyle = C.axis;
      g.fillText(label, p.x + p.w + 10, y);
    }
  };
  const stepP = niceStep(hi - lo, 8);
  for (let v = Math.ceil(lo / stepP) * stepP; v <= hi; v += stepP) hline(Yp(v), fmtPrice(v), C.grid, false, pPrice);
  const stepM = niceStep(mHi - mLo, 4);
  for (let v = Math.ceil(mLo / stepM) * stepM; v <= mHi; v += stepM) {
    if (Math.abs(v) < stepM / 1000) continue;
    hline(Ym(v), fmtInd(v), C.grid, false, pMacd);
  }
  hline(Ym(0), "0", C.axis, true, pMacd);
  for (const v of [30, 70]) hline(Yr(v), String(v), C.axis, true, pRsi);
  hline(Yr(50), "50", C.grid, true, pRsi);
  g.fillStyle = "rgba(124,92,255,0.07)";
  g.fillRect(pRsi.x, Yr(70), pRsi.w, Yr(30) - Yr(70));

  // grid vertikal + label waktu
  g.textAlign = "center";
  g.textBaseline = "top";
  const every = Math.max(1, Math.round(nb / 7));
  for (let i = Math.min(every, 3); i < nb - 2; i += every) {
    const xx = Math.round(X(from + i)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(xx, T);
    g.lineTo(xx, pRsi.y + pRsi.h);
    g.stroke();
    g.fillStyle = C.axis;
    g.fillText(tickLabel(bars[i].t, tf), xx, pRsi.y + pRsi.h + 14);
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

  // ----- MACD: histogram + garis -----
  const y0 = Ym(0);
  for (let i = from; i < n; i++) {
    const v = m.hist[i];
    if (v == null) continue;
    const prev = i > 0 ? m.hist[i - 1] : null;
    const rising = prev == null || v >= prev;
    g.fillStyle = v >= 0 ? (rising ? "rgba(38,166,154,0.95)" : "rgba(38,166,154,0.45)") : rising ? "rgba(239,83,80,0.45)" : "rgba(239,83,80,0.95)";
    const xx = X(i);
    g.fillRect(xx - bodyW / 2, Math.min(y0, Ym(v)), bodyW, Math.max(1, Math.abs(Ym(v) - y0)));
  }
  const line = (series, Y, color, w = 2.2) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.lineJoin = "round";
    g.beginPath();
    let started = false;
    for (let i = from; i < n; i++) {
      if (series[i] == null) continue;
      if (!started) {
        g.moveTo(X(i), Y(series[i]));
        started = true;
      } else g.lineTo(X(i), Y(series[i]));
    }
    g.stroke();
  };
  line(m.macd, Ym, C.macdLine);
  line(m.signal, Ym, C.macdSig);
  line(rsiS, Yr, C.rsiLine, 2.4);

  // ----- panel frame -----
  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  for (const p of [pPrice, pMacd, pRsi]) g.strokeRect(p.x + 0.5, p.y + 0.5, p.w, p.h);

  // ----- panah divergence -----
  const drawn = new Set(); // panah harga cukup sekali per pasangan pivot
  const used = new Map(); // jumlah label per panel
  for (const d of divs) {
    const bull = d.dir === "bull";
    const col = bull ? C.bull : C.bear;
    const p1 = d.pivot1;
    const p2 = d.pivot2;
    const key = bull ? "l" : "h";
    const off = bull ? 14 : -14; // titik panah sedikit di luar wick

    // harga
    const pk = `${d.dir}:${p1.idx}:${p2.idx}`;
    if (!drawn.has(pk)) {
      drawn.add(pk);
      const ax = X(p1.idx);
      const ay = Yp(candles[p1.idx][key]) + off;
      const bx = X(p2.idx);
      const by = Yp(candles[p2.idx][key]) + off;
      arrow(g, ax, ay, bx, by);
      dot(g, ax, ay);
      const chg = ((p2.price - p1.price) / p1.price) * 100;
      chip(g, family, `${fmtPrice(p1.price)} → ${fmtPrice(p2.price)} (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)`, (ax + bx) / 2, Math.max(ay, by) + (bull ? 34 : -34), pPrice, col);
    }

    // indikator
    const isRsi = d.indicator === "rsi";
    const Yi = isRsi ? Yr : Ym;
    const box = isRsi ? pRsi : pMacd;
    // titik di lembah/puncak indikator sendiri (indIdx), bukan di candle pivot harga; fallback idx untuk hasil lama
    const ax = X(p1.indIdx ?? p1.idx);
    const ay = Yi(p1.ind);
    const bx = X(p2.indIdx ?? p2.idx);
    const by = Yi(p2.ind);
    arrow(g, ax, ay, bx, by);
    dot(g, ax, ay);
    const diff = p2.ind - p1.ind;
    const lbl = `${L[d.dir]} ${L[d.kind]} · ${isRsi ? "RSI" : "MACD"} ${fmtInd(p1.ind)} → ${fmtInd(p2.ind)} (${fmtSigned(diff)})`;
    const slotN = used.get(box) || 0; // label bertumpuk? geser ke bawah/atas per divergence
    used.set(box, slotN + 1);
    const cy = bull ? Math.max(ay, by) + 30 + slotN * 30 : Math.min(ay, by) - 26 - slotN * 30;
    chip(g, family, lbl, (ax + bx) / 2, cy, box, col);
  }

  // ----- judul + legenda -----
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.font = `bold 28px ${family}`;
  g.fillStyle = C.title;
  const title = `${coin}/USDT  ${tf}`;
  g.fillText(title, Lm, 26);
  const titleW = g.measureText(title).width; // ukur sebelum font diganti
  const last = candles[n - 1];
  const first = candles[Math.max(0, n - 2)];
  const chgLast = ((last.c - first.c) / first.c) * 100;
  g.font = `22px ${family}`;
  g.fillStyle = last.c >= first.c ? C.up : C.down;
  g.fillText(`${fmtPrice(last.c)}  (${chgLast >= 0 ? "+" : ""}${chgLast.toFixed(2)}%)`, Lm + titleW + 20, 27);
  g.font = `19px ${family}`;
  g.fillStyle = C.axis;
  g.fillText(`Close candle only · pivot ${DIV.PIVOT_LEFT} left / ${DIV.PIVOT_RIGHT} right`, Lm, 56);

  const ml = (txt, x, y, color) => {
    g.font = `20px ${family}`;
    g.fillStyle = color;
    g.fillText(txt, x, y);
  };
  const mLast = m.hist[n - 1];
  ml(`MACD ${INDICATOR_CONFIG.MACD_FAST} ${INDICATOR_CONFIG.MACD_SLOW} ${INDICATOR_CONFIG.MACD_SIGNAL}`, Lm + 10, pMacd.y + 18, C.text);
  ml(`hist ${fmtInd(mLast)}`, Lm + 170, pMacd.y + 18, mLast >= 0 ? C.up : C.down);
  ml(`macd ${fmtInd(m.macd[n - 1])}`, Lm + 300, pMacd.y + 18, C.macdLine);
  ml(`signal ${fmtInd(m.signal[n - 1])}`, Lm + 440, pMacd.y + 18, C.macdSig);
  ml(`RSI ${INDICATOR_CONFIG.RSI_PERIOD}`, Lm + 10, pRsi.y + 18, C.text);
  ml(fmtInd(rsiS[n - 1]), Lm + 80, pRsi.y + 18, C.rsiLine);

  return canvas.toBuffer("image/png");
}

module.exports = { renderDivChart };