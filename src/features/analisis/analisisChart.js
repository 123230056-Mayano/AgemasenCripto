"use strict";

/**
 * features/analisis/analisisChart.js
 * ------------------------------------------------------------------
 * Gambar grafik candlestick (PNG) untuk disisipkan ke PDF !analisis.
 *
 * Isi grafik meniru grafik di web KriptoPredict (LiveChart.js):
 *   - candle naik/turun
 *   - EMA 20 (kuning), EMA 50 (biru), EMA 200 (ungu)
 *   - garis Resistance (R1..) dan Support (S1..) dari report.key_levels
 *   - label harga terakhir di sisi kanan
 *
 * Gaya (tema gelap, palet, font, panah biru + titik pivot, chip label) dipakai bersama dengan chart
 * !scandivergent lewat ../kripto/chartKit.js. Panah menunjukkan cara tiap elemen ditentukan:
 *   - R/S : dari candle swing high/low (pivot +-3 candle) ke candle terakhir, label jarak % dari harga
 *   - EMA : dari nilai EMA 20 candle lalu ke nilai terakhir, label perubahan %
 * Dipakai !chart dan !analisis (kedua command memanggil renderChart yang sama).
 *
 * Data candle diambil langsung dari Binance (endpoint & mapping simbol
 * sama dengan web), dan HANYA candle yang sudah tutup dipakai, sama
 * seperti yang dipakai AI untuk analisis. Kalau fetch/gambar gagal,
 * fungsi ini melempar error dan pemanggil (analisisPdf) tetap bikin PDF
 * tanpa grafik, jadi gak pernah bikin command gagal total.
 *
 * Env opsional: BINANCE_BASE (default https://data-api.binance.vision)
 */

const axios = require("axios");
const { createCanvas } = require("@napi-rs/canvas");

const BINANCE = (process.env.BINANCE_BASE || "https://data-api.binance.vision").replace(/\/+$/, "");
const INTERVAL = { "15M": "15m", "1H": "1h", "4H": "4h", "1D": "1d" };
const FETCH_LIMIT = 320; // cukup supaya EMA200 sudah terisi di seluruh candle yang digambar
const VISIBLE = 110; // jumlah candle yang digambar

// Ticker di daftar web -> simbol dasar Binance, bila beda (sama dengan lib/coins.js di web).
const BINANCE_BASE_OVERRIDE = { BABYDOGE: "1MBABYDOGE", PEPE: "PEPE", BONK: "BONK", FLOKI: "FLOKI", LUNC: "LUNC" };
const binanceSymbol = (ticker) => `${BINANCE_BASE_OVERRIDE[ticker] || ticker}USDT`;

// ---------- data ----------
async function fetchCandles(coin, tf) {
  const interval = INTERVAL[tf];
  if (!interval) throw new Error("TF_UNSUPPORTED");
  const res = await axios.get(`${BINANCE}/api/v3/klines`, {
    params: { symbol: binanceSymbol(coin), interval, limit: FETCH_LIMIT },
    timeout: 10_000,
  });
  const now = Date.now();
  return res.data
    .filter((k) => k[6] < now) // buang candle yang masih berjalan
    .map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

// EMA persis seperti lib/indicators.js di web (seed = SMA periode pertama).
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// ---------- gaya & helper bersama (sama dengan chart !scandivergent) ----------
const { C, fontFamily, fmtPrice, niceStep, tickLabel, arrow, dot, chip } = require("../kripto/chartKit");

const { macd: calcMacd, rsi: calcRsi } = require("../kripto/indicators");
const { alignToCandles, getDominance } = require("../kripto/dominance");

const SWING_WIN = 3; // sama dengan computeLevels() di kripto/market.js (swing high/low +-3 candle)
const SWING_LOOKBACK = 150; // sama dengan computeLevels()
const EMA_SLOPE_BARS = 20; // panah EMA: dari nilai EMA 20 candle lalu ke nilai terakhir

const pctTxt = (from, to) => {
  const v = ((to - from) / from) * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
};

/**
 * Cari candle swing yang menghasilkan sebuah level (cara yang sama dengan computeLevels:
 * high/low yang tertinggi/terendah di antara +-SWING_WIN candle, dalam SWING_LOOKBACK candle terakhir).
 * Level dari web/AI bisa sedikit berbeda dari harga candle, jadi toleransi 0.1% bila tidak persis sama.
 * @returns {number} index candle, atau -1 bila tidak ada swing yang cocok
 */
function findSwingIdx(candles, level, isHigh) {
  const n = candles.length;
  const base = Math.max(0, n - SWING_LOOKBACK);
  const key = isHigh ? "h" : "l";
  let best = -1;
  let bestDiff = Infinity;
  for (let i = n - 1 - SWING_WIN; i >= base + SWING_WIN; i--) {
    const v = candles[i][key];
    let isSwing = true;
    for (let j = i - SWING_WIN; j <= i + SWING_WIN; j++) {
      if (isHigh ? candles[j][key] > v : candles[j][key] < v) {
        isSwing = false;
        break;
      }
    }
    if (!isSwing) continue;
    const diff = Math.abs(v - level) / level;
    if (diff < bestDiff - 1e-12) {
      best = i;
      bestDiff = diff;
      if (diff < 1e-9) break; // persis sama dan paling baru
    }
  }
  return bestDiff <= 0.001 ? best : -1;
}

/**
 * @param {object} o
 * @param {Array<{t,o,h,l,c}>} o.candles   candle closed, urut lama -> baru
 * @param {string} o.coin
 * @param {string} o.tf                    "15M" | "1H" | "4H" | "1D"
 * @param {number[]} [o.resistance]
 * @param {number[]} [o.support]
 * @param {{now:object|null, series:Array|null}|null} [o.dominance]  hasil getDominance(); null = panel dominance dilewati
 * @returns {Buffer} PNG
 */
function renderChart({ candles, coin, tf, resistance = [], support = [], dominance = null }) {
  if (!candles || candles.length < 10) throw new Error("CANDLES_TOO_FEW");
  const family = fontFamily();

  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const emas = [20, 50, 200].map((p) => ({ p, v: ema(closes, p) }));
  const from = Math.max(0, n - VISIBLE);
  const bars = candles.slice(from);
  const nb = bars.length;
  const last = candles[n - 1];

  // ----- rentang harga (Y) -----
  let lo = Math.min(...bars.map((b) => b.l));
  let hi = Math.max(...bars.map((b) => b.h));
  for (const { v } of emas) {
    for (let i = from; i < n; i++) {
      if (v[i] != null) {
        lo = Math.min(lo, v[i]);
        hi = Math.max(hi, v[i]);
      }
    }
  }
  // Level yang terlalu jauh (> 12% di luar rentang) tidak digambar supaya candle tidak gepeng.
  const span0 = hi - lo || hi * 0.01;
  const near = (lv) => typeof lv === "number" && isFinite(lv) && lv > lo - span0 * 0.5 && lv < hi + span0 * 0.5;
  const rs = resistance.filter(near);
  const ss = support.filter(near);
  for (const lv of [...rs, ...ss]) {
    lo = Math.min(lo, lv);
    hi = Math.max(hi, lv);
  }
  const pad = (hi - lo) * 0.09 || hi * 0.01;
  lo -= pad;
  hi += pad;

  // ----- kanvas & panel (ukuran dan margin sama dengan panel harga divChart) -----
  const W = 1600;
  const Lm = 20;
  const Rm = 130;
  const T = 74;
  const hP = 700;
  const B = 52;
  const gap = 16;
  const hSub = 200; // tinggi tiap panel bawah (MACD, RSI, Dominance)
  const withDom = !!(dominance && (dominance.series || dominance.now));
  const nSub = withDom ? 3 : 2;
  const H = T + hP + nSub * (gap + hSub) + B;
  const cw = W - Lm - Rm;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const pPrice = { x: Lm, y: T, w: cw, h: hP };
  const pMacd = { x: Lm, y: T + hP + gap, w: cw, h: hSub };
  const pRsi = { x: Lm, y: pMacd.y + hSub + gap, w: cw, h: hSub };
  const pDom = withDom ? { x: Lm, y: pRsi.y + hSub + gap, w: cw, h: hSub } : null;
  const lastPanel = pDom || pRsi;
  const panelsBottom = lastPanel.y + lastPanel.h;
  for (const p of [pPrice, pMacd, pRsi, ...(pDom ? [pDom] : [])]) {
    g.fillStyle = C.panel;
    g.fillRect(p.x, p.y, p.w, p.h);
  }

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
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(Yp(p)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(pPrice.x, yy);
    g.lineTo(pPrice.x + pPrice.w, yy);
    g.stroke();
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
    for (const p of [pPrice, pMacd, pRsi, ...(pDom ? [pDom] : [])]) {
      g.beginPath();
      g.moveTo(xx, p.y);
      g.lineTo(xx, p.y + p.h);
      g.stroke();
    }
    g.fillStyle = C.axis;
    g.fillText(tickLabel(bars[i].t, tf), xx, panelsBottom + 14);
  }

  // ----- garis support / resistance (di bawah candle) -----
  const levels = [
    ...rs.map((price, i) => ({ price, label: `R${i + 1}`, color: C.res, high: true })),
    ...ss.map((price, i) => ({ price, label: `S${i + 1}`, color: C.sup, high: false })),
  ];
  for (const lv of levels) {
    const yy = Math.round(Yp(lv.price)) + 0.5;
    g.save();
    g.strokeStyle = lv.color;
    g.lineWidth = 1.6;
    g.setLineDash([10, 7]);
    g.globalAlpha = 0.8;
    g.beginPath();
    g.moveTo(pPrice.x, yy);
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

  // ----- EMA -----
  g.lineJoin = "round";
  for (const { p, v } of emas) {
    g.strokeStyle = C.ema[p];
    g.lineWidth = 2.4;
    g.beginPath();
    let started = false;
    for (let i = from; i < n; i++) {
      if (v[i] == null) continue;
      if (!started) {
        g.moveTo(X(i), Yp(v[i]));
        started = true;
      } else g.lineTo(X(i), Yp(v[i]));
    }
    g.stroke();
  }

  // ----- harga terakhir (garis putus + tag di sumbu kanan) -----
  {
    const yy = Yp(last.c);
    const color = last.c >= last.o ? C.up : C.down;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(pPrice.x, Math.round(yy) + 0.5);
    g.lineTo(pPrice.x + pPrice.w, Math.round(yy) + 0.5);
    g.stroke();
    g.restore();
  }

  // ----- panel frame -----
  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.strokeRect(pPrice.x + 0.5, pPrice.y + 0.5, pPrice.w, pPrice.h);

  // ----- tag di sumbu kanan: level S/R dan harga terakhir -----
  const tag = (txt, yy, color) => {
    g.save();
    g.font = `bold 19px ${family}`;
    g.fillStyle = color;
    g.fillRect(pPrice.x + pPrice.w + 4, yy - 13, Rm - 8, 26);
    g.fillStyle = "#fff";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(txt, pPrice.x + pPrice.w + 10, yy + 1);
    g.restore();
  };
  {
    const tags = [
      ...levels.map((lv) => ({ txt: `${lv.label} ${fmtPrice(lv.price)}`, y: Yp(lv.price), color: lv.color })),
      { txt: fmtPrice(last.c), y: Yp(last.c), color: last.c >= last.o ? C.up : C.down },
    ].sort((a, b) => a.y - b.y);
    const gapY = 28; // tag yang berdekatan digeser supaya angkanya tetap terbaca
    for (let i = 1; i < tags.length; i++) tags[i].ty = Math.max(tags[i].y, (tags[i - 1].ty ?? tags[i - 1].y) + gapY);
    if (tags.length) tags[0].ty = tags[0].y;
    for (const tg of tags) tag(tg.txt, Math.min(tg.ty ?? tg.y, pPrice.y + pPrice.h - 14), tg.color);
  }

  // ----- panah (cara menentukan tiap elemen, sama dengan gaya !scandivergent) -----
  const placed = []; // kotak chip yang sudah digambar, supaya label tidak saling menimpa
  const chips = []; // chip digambar SETELAH semua panah supaya teks tidak tertimpa garis panah

  // S/R: dari candle swing high/low (pivot +-SWING_WIN candle) ke candle terakhir, sepanjang garis level.
  for (const lv of levels) {
    const pivotIdx = findSwingIdx(candles, lv.price, lv.high);
    const ay0 = Yp(lv.price);
    const bx = X(n - 1);
    let ax;
    let ay = ay0;
    let by = ay0;
    let kind = lv.high ? "swing high" : "swing low";
    if (pivotIdx >= from) {
      ax = X(pivotIdx);
      dot(g, ax, ay);
    } else if (pivotIdx >= 0) {
      ax = pPrice.x + 12; // swing-nya di luar jendela tampil: panah mulai dari tepi kiri
      kind += " (kiri)";
    } else {
      // level tidak berasal dari swing candle (mis. disesuaikan AI): panah dari harga terakhir ke level
      ax = bx;
      ay = Yp(last.c);
      kind = "dari harga";
      dot(g, ax, ay);
    }
    arrow(g, ax, ay, bx, by);
    const txt = `${lv.label} ${kind} ${fmtPrice(lv.price)} (${pctTxt(last.c, lv.price)})`;
    chips.push([txt, (ax + bx) / 2, ay0 + (lv.high ? -26 : 26), lv.color]);
  }

  // EMA: dari nilai EMA EMA_SLOPE_BARS candle lalu ke nilai terakhir (arah kemiringan).
  for (const { p, v } of emas) {
    const i1 = n - 1 - EMA_SLOPE_BARS;
    if (i1 < 0 || v[i1] == null || v[n - 1] == null) continue;
    const ax = X(Math.max(i1, from));
    const ay = Yp(v[i1]);
    const bx = X(n - 1);
    const by = Yp(v[n - 1]);
    arrow(g, ax, ay, bx, by);
    dot(g, ax, ay);
    const txt = `EMA ${p} ${fmtPrice(v[i1])} → ${fmtPrice(v[n - 1])} (${pctTxt(v[i1], v[n - 1])})`;
    chips.push([txt, (ax + bx) / 2, by + (v[n - 1] >= v[i1] ? 34 : -34), C.ema[p]]);
  }
  for (const [txt, cx, cy, color] of chips) chip(g, family, txt, cx, cy, pPrice, color, placed);

  // ----- panel MACD / RSI / Dominance (susunan sama dengan screenshot referensi klien) -----
  const frame = (p) => {
    g.strokeStyle = "#2a303c";
    g.lineWidth = 1;
    g.strokeRect(p.x + 0.5, p.y + 0.5, p.w, p.h);
  };
  const axisTag = (txt, yy, color) => {
    g.save();
    g.font = `bold 18px ${family}`;
    g.fillStyle = color;
    g.fillRect(Lm + cw + 4, yy - 12, Rm - 8, 24);
    g.fillStyle = "#fff";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(txt, Lm + cw + 10, yy + 1);
    g.restore();
  };
  const line = (arr, Y, color, width = 2) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    let on = false;
    for (let i = from; i < n; i++) {
      if (arr[i] == null) continue;
      if (!on) {
        g.moveTo(X(i), Y(arr[i]));
        on = true;
      } else g.lineTo(X(i), Y(arr[i]));
    }
    g.stroke();
  };
  const panelLabel = (p, parts) => {
    g.font = `20px ${family}`;
    g.textAlign = "left";
    g.textBaseline = "middle";
    let x = p.x + 10;
    for (const [txt, color] of parts) {
      g.fillStyle = color;
      g.fillText(txt, x, p.y + 18);
      x += g.measureText(txt).width + 22;
    }
  };
  const f2 = (v) => (v == null ? "-" : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));

  // MACD (12, 26, 9)
  {
    const m = calcMacd(closes);
    let mLo = 0;
    let mHi = 0;
    for (let i = from; i < n; i++) for (const v of [m.hist[i], m.macd[i], m.signal[i]]) if (v != null) { mLo = Math.min(mLo, v); mHi = Math.max(mHi, v); }
    if (mHi === mLo) { mLo = -1; mHi = 1; }
    const mp = (mHi - mLo) * 0.12;
    mLo -= mp;
    mHi += mp;
    const Ym = (v) => pMacd.y + ((mHi - v) / (mHi - mLo)) * pMacd.h;
    g.strokeStyle = "#2a303c";
    g.beginPath();
    g.moveTo(pMacd.x, Math.round(Ym(0)) + 0.5);
    g.lineTo(pMacd.x + pMacd.w, Math.round(Ym(0)) + 0.5);
    g.stroke();
    for (let i = from; i < n; i++) {
      const h = m.hist[i];
      if (h == null) continue;
      g.fillStyle = h >= 0 ? C.up : C.down;
      g.globalAlpha = 0.75;
      g.fillRect(X(i) - bodyW / 2, Math.min(Ym(0), Ym(h)), bodyW, Math.max(1, Math.abs(Ym(h) - Ym(0))));
    }
    g.globalAlpha = 1;
    line(m.macd, Ym, C.macdLine);
    line(m.signal, Ym, C.macdSig);
    panelLabel(pMacd, [
      ["MACD close 12 26 9", C.axis],
      [f2(m.macd[n - 1]), C.macdLine],
      [f2(m.signal[n - 1]), C.macdSig],
      [f2(m.hist[n - 1]), (m.hist[n - 1] ?? 0) >= 0 ? C.up : C.down],
    ]);
    frame(pMacd);
  }

  // RSI 14 (skala tetap 0..100, garis 70 / 30)
  {
    const r = calcRsi(closes);
    const Yr = (v) => pRsi.y + ((104 - v) / 108) * pRsi.h;
    g.save();
    g.fillStyle = "rgba(167,139,250,0.07)";
    g.fillRect(pRsi.x, Yr(70), pRsi.w, Yr(30) - Yr(70));
    g.setLineDash([6, 6]);
    g.strokeStyle = "#3a4152";
    for (const lv of [70, 50, 30]) {
      g.beginPath();
      g.moveTo(pRsi.x, Math.round(Yr(lv)) + 0.5);
      g.lineTo(pRsi.x + pRsi.w, Math.round(Yr(lv)) + 0.5);
      g.stroke();
    }
    g.restore();
    line(r, Yr, C.rsiLine);
    g.fillStyle = C.axis;
    g.font = `18px ${family}`;
    g.textAlign = "left";
    g.textBaseline = "middle";
    for (const lv of [70, 50, 30]) g.fillText(String(lv), pRsi.x + pRsi.w + 10, Yr(lv));
    panelLabel(pRsi, [["RSI 14 close", C.axis], [f2(r[n - 1]), C.rsiLine]]);
    frame(pRsi);
  }

  // Dominance: BTC.D (utama) + ETH.D bila ada deretnya. Deret waktu dari CoinMarketCap; kalau hanya angka terkini yang
  // tersedia, panel tetap tampil dengan nilai terkini saja (tanpa garis).
  if (pDom) {
    const al = alignToCandles(dominance.series, candles);
    const btcS = al.map((q) => (q ? q.btc : null));
    const ethS = al.map((q) => (q && q.eth != null ? q.eth : null));
    const hasLine = btcS.slice(from).some((v) => v != null);
    const now = dominance.now;
    if (hasLine) {
      // BTC.D di sumbu kiri-kanan panel sendiri; ETH.D digambar di skala yang sama bila rentangnya ikut masuk
      const vals = [...btcS.slice(from), ...ethS.slice(from)].filter((v) => v != null);
      let dLo = Math.min(...btcS.slice(from).filter((v) => v != null));
      let dHi = Math.max(...btcS.slice(from).filter((v) => v != null));
      const ethVals = ethS.slice(from).filter((v) => v != null);
      const showEth = ethVals.length > 1 && Math.max(...vals) - Math.min(...vals) < 45;
      if (showEth) { dLo = Math.min(dLo, ...ethVals); dHi = Math.max(dHi, ...ethVals); }
      if (dHi === dLo) { dLo -= 0.5; dHi += 0.5; }
      const dp = (dHi - dLo) * 0.15;
      dLo -= dp;
      dHi += dp;
      const Yd = (v) => pDom.y + ((dHi - v) / (dHi - dLo)) * pDom.h;
      const stepD = niceStep(dHi - dLo, 4);
      g.font = `18px ${family}`;
      g.textAlign = "left";
      g.textBaseline = "middle";
      for (let v = Math.ceil(dLo / stepD) * stepD; v <= dHi; v += stepD) {
        const yy = Math.round(Yd(v)) + 0.5;
        g.strokeStyle = C.grid;
        g.beginPath();
        g.moveTo(pDom.x, yy);
        g.lineTo(pDom.x + pDom.w, yy);
        g.stroke();
        g.fillStyle = C.axis;
        g.fillText(`${v.toFixed(stepD < 1 ? 1 : 0)}%`, pDom.x + pDom.w + 10, yy);
      }
      line(btcS, Yd, "#f59e0b", 2.4);
      if (showEth) line(ethS, Yd, "#60a5fa", 1.8);
      const lastBtc = [...btcS].reverse().find((v) => v != null);
      axisTag(`${lastBtc.toFixed(2)}%`, Yd(lastBtc), "#f59e0b");
    }
    const parts = [[hasLine ? "Dominance (CoinMarketCap)" : "Dominance (CoinGecko)", C.axis]];
    parts.push([`BTC.D ${now?.btc != null ? now.btc.toFixed(2) + "%" : "-"}`, "#f59e0b"]);
    if (now?.eth != null) parts.push([`ETH.D ${now.eth.toFixed(2)}%`, "#60a5fa"]);
    if (now?.usdt != null) parts.push([`USDT.D ${now.usdt.toFixed(2)}%`, "#9ca3af"]);
    if (!hasLine) parts.push(["(histori tidak tersedia, hanya nilai terkini)", C.axis]);
    panelLabel(pDom, parts);
    frame(pDom);
  }

  // ----- judul + legenda (sama dengan chart divergence) -----
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.font = `bold 28px ${family}`;
  g.fillStyle = C.title;
  const title = `${coin}/USDT  ${tf}`;
  g.fillText(title, Lm, 26);
  const titleW = g.measureText(title).width; // ukur sebelum font diganti
  const prev = candles[Math.max(0, n - 2)];
  const chgLast = ((last.c - prev.c) / prev.c) * 100;
  g.font = `22px ${family}`;
  g.fillStyle = last.c >= prev.c ? C.up : C.down;
  g.fillText(`${fmtPrice(last.c)}  (${chgLast >= 0 ? "+" : ""}${chgLast.toFixed(2)}%)`, Lm + titleW + 20, 27);
  g.font = `19px ${family}`;
  g.fillStyle = C.axis;
  g.fillText(`Close candle only · S/R swing ${SWING_WIN} candle · EMA slope ${EMA_SLOPE_BARS} candle`, Lm, 56);

  // nilai EMA terakhir di pojok kiri atas panel (seperti label MACD/RSI di chart divergence)
  let lx = Lm + 10;
  g.font = `20px ${family}`;
  for (const { p, v } of emas) {
    const txt = `EMA ${p} ${v[n - 1] == null ? "-" : fmtPrice(v[n - 1])}`;
    g.fillStyle = C.ema[p];
    g.fillText(txt, lx, pPrice.y + 18);
    lx += g.measureText(txt).width + 28;
  }

  return canvas.toBuffer("image/png");
}

/**
 * Ambil candle + gambar grafik dari hasil /api/analyze.
 * @returns {Promise<Buffer>} PNG
 */
async function buildChartPng(data, { candles } = {}) {
  const main = data.backend?.main || {};
  const report = data.report || {};
  const coin = main.coin || report.asset;
  const tf = data.backend?.timeframe || report.timeframe;
  const cs = candles || (await fetchCandles(coin, tf));
  const dominance = await getDominance(tf, cs[Math.max(0, cs.length - VISIBLE)].t).catch(() => null);
  return renderChart({
    candles: cs,
    coin,
    tf,
    dominance,
    resistance: (report.key_levels?.resistance || []).filter((v) => typeof v === "number"),
    support: (report.key_levels?.support || []).filter((v) => typeof v === "number"),
  });
}

module.exports = { buildChartPng, renderChart, fetchCandles, binanceSymbol };
