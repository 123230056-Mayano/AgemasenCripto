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
 * Data candle diambil langsung dari Binance (endpoint & mapping simbol
 * sama dengan web), dan HANYA candle yang sudah tutup dipakai, sama
 * seperti yang dipakai AI untuk analisis. Kalau fetch/gambar gagal,
 * fungsi ini melempar error dan pemanggil (analisisPdf) tetap bikin PDF
 * tanpa grafik, jadi gak pernah bikin command gagal total.
 *
 * Env opsional: BINANCE_BASE (default https://data-api.binance.vision)
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

const BINANCE = (process.env.BINANCE_BASE || "https://data-api.binance.vision").replace(/\/+$/, "");
const INTERVAL = { "1H": "1h", "4H": "4h", "1D": "1d" };
const FETCH_LIMIT = 320; // cukup supaya EMA200 sudah terisi di seluruh candle yang digambar
const VISIBLE = 110; // jumlah candle yang digambar

// Ticker di daftar web -> simbol dasar Binance, bila beda (sama dengan lib/coins.js di web).
const BINANCE_BASE_OVERRIDE = { BABYDOGE: "1MBABYDOGE", PEPE: "PEPE", BONK: "BONK", FLOKI: "FLOKI", LUNC: "LUNC" };
const binanceSymbol = (ticker) => `${BINANCE_BASE_OVERRIDE[ticker] || ticker}USDT`;

// ---------- font ----------
const FONT_FILE = path.join(__dirname, "../../../assets/fonts/ArchivoNarrow-Variable.ttf");
let fontReady = false;
function fontFamily() {
  if (!fontReady) {
    fontReady = true;
    try {
      if (fs.existsSync(FONT_FILE)) GlobalFonts.registerFromPath(FONT_FILE, "ChartFont");
    } catch {
      /* pakai font bawaan */
    }
  }
  return 'ChartFont, "DejaVu Sans", Arial, sans-serif';
}

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

// ---------- format ----------
const fmtPrice = (p) => {
  if (typeof p !== "number" || !isFinite(p)) return "-";
  const d = p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 8;
  return p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};

function niceStep(range, target) {
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
}

const WIB = { timeZone: "Asia/Jakarta" };
const tickLabel = (t, tf) => {
  const d = new Date(t);
  const day = d.toLocaleString("en-GB", { ...WIB, day: "numeric", month: "short" });
  if (tf === "1D") return day;
  const hh = d.toLocaleString("en-GB", { ...WIB, hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${hh}`;
};

const COLORS = {
  bg: "#ffffff",
  grid: "#e9ebef",
  axis: "#8a8f99",
  text: "#4a4f58",
  up: "#0f8a5f",
  down: "#c8382e",
  r: "#c8382e",
  s: "#0f8a5f",
  ema: { 20: "#e0a100", 50: "#2f8fe0", 200: "#8b5cf6" },
};

/**
 * @param {object} o
 * @param {Array<{t,o,h,l,c}>} o.candles   candle closed, urut lama -> baru
 * @param {string} o.coin
 * @param {string} o.tf                    "1H" | "4H" | "1D"
 * @param {number[]} [o.resistance]
 * @param {number[]} [o.support]
 * @returns {Buffer} PNG
 */
function renderChart({ candles, coin, tf, resistance = [], support = [] }) {
  if (!candles || candles.length < 10) throw new Error("CANDLES_TOO_FEW");
  const family = fontFamily();

  const closes = candles.map((c) => c.c);
  const emas = [20, 50, 200].map((p) => ({ p, v: ema(closes, p) }));
  const from = Math.max(0, candles.length - VISIBLE);
  const bars = candles.slice(from);
  const last = bars[bars.length - 1];

  // ----- rentang harga (Y) -----
  let lo = Math.min(...bars.map((b) => b.l));
  let hi = Math.max(...bars.map((b) => b.h));
  for (const { v } of emas) {
    for (let i = from; i < candles.length; i++) {
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
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;

  // ----- kanvas -----
  const W = 1600;
  const H = 840;
  const L = 24;
  const R = 130; // ruang label harga di kanan
  const T = 64; // ruang legenda
  const B = 50; // ruang label waktu
  const cw = W - L - R;
  const ch = H - T - B;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");

  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, W, H);

  const y = (p) => T + ((hi - p) / (hi - lo)) * ch;
  const slot = cw / bars.length;
  const x = (i) => L + slot * i + slot / 2;
  const bodyW = Math.max(2, slot * 0.64);

  // ----- grid + label harga -----
  g.font = `20px ${family}`;
  g.textBaseline = "middle";
  const step = niceStep(hi - lo, 7);
  g.lineWidth = 1;
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(y(p)) + 0.5;
    g.strokeStyle = COLORS.grid;
    g.beginPath();
    g.moveTo(L, yy);
    g.lineTo(L + cw, yy);
    g.stroke();
    g.fillStyle = COLORS.axis;
    g.textAlign = "left";
    g.fillText(fmtPrice(p), L + cw + 10, yy);
  }

  // ----- label waktu -----
  g.textAlign = "center";
  g.textBaseline = "top";
  g.fillStyle = COLORS.axis;
  const every = Math.max(1, Math.round(bars.length / 7));
  for (let i = 0; i < bars.length; i += every) {
    const xx = Math.round(x(i)) + 0.5;
    g.strokeStyle = COLORS.grid;
    g.beginPath();
    g.moveTo(xx, T);
    g.lineTo(xx, T + ch);
    g.stroke();
    g.fillText(tickLabel(bars[i].t, tf), xx, T + ch + 12);
  }

  // ----- garis support / resistance (di bawah candle) -----
  const drawLevel = (price, label, color) => {
    const yy = Math.round(y(price)) + 0.5;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.setLineDash([10, 7]);
    g.globalAlpha = 0.85;
    g.beginPath();
    g.moveTo(L, yy);
    g.lineTo(L + cw, yy);
    g.stroke();
    g.restore();
    // label kecil di kanan (di dalam area chart)
    g.font = `bold 19px ${family}`;
    const txt = `${label} ${fmtPrice(price)}`;
    const tw = g.measureText(txt).width + 14;
    g.fillStyle = color;
    g.fillRect(L + cw - tw - 6, yy - 12, tw, 24);
    g.fillStyle = "#fff";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(txt, L + cw - tw + 1, yy + 1);
  };
  rs.forEach((p, i) => drawLevel(p, `R${i + 1}`, COLORS.r));
  ss.forEach((p, i) => drawLevel(p, `S${i + 1}`, COLORS.s));

  // ----- candle -----
  g.lineWidth = 1.4;
  bars.forEach((b, i) => {
    const color = b.c >= b.o ? COLORS.up : COLORS.down;
    const xx = Math.round(x(i)) + 0.5;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(xx, y(b.h));
    g.lineTo(xx, y(b.l));
    g.stroke();
    const top = y(Math.max(b.o, b.c));
    const hgt = Math.max(1.5, Math.abs(y(b.o) - y(b.c)));
    g.fillRect(xx - bodyW / 2, top, bodyW, hgt);
  });

  // ----- EMA -----
  g.lineJoin = "round";
  for (const { p, v } of emas) {
    g.strokeStyle = COLORS.ema[p];
    g.lineWidth = 2.4;
    g.beginPath();
    let started = false;
    for (let i = from; i < candles.length; i++) {
      if (v[i] == null) continue;
      const xx = x(i - from);
      const yy = y(v[i]);
      if (!started) {
        g.moveTo(xx, yy);
        started = true;
      } else g.lineTo(xx, yy);
    }
    g.stroke();
  }

  // ----- label harga terakhir -----
  {
    const yy = y(last.c);
    const color = last.c >= last.o ? COLORS.up : COLORS.down;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(L, Math.round(yy) + 0.5);
    g.lineTo(L + cw, Math.round(yy) + 0.5);
    g.stroke();
    g.restore();
    g.font = `bold 20px ${family}`;
    g.fillStyle = color;
    g.fillRect(L + cw + 4, yy - 13, R - 8, 26);
    g.fillStyle = "#fff";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(fmtPrice(last.c), L + cw + 10, yy + 1);
  }

  // ----- legenda -----
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.font = `bold 26px ${family}`;
  g.fillStyle = "#1b1f27";
  const title = `${coin}/USDT  ${tf}`;
  g.fillText(title, L, 26);
  let lx = L + g.measureText(title).width + 34;
  g.font = `20px ${family}`;
  for (const { p, v } of emas) {
    const val = v[candles.length - 1];
    g.fillStyle = COLORS.ema[p];
    g.fillRect(lx, 20, 26, 5);
    lx += 34;
    g.fillStyle = COLORS.text;
    const txt = `EMA ${p}  ${val == null ? "-" : fmtPrice(val)}`;
    g.fillText(txt, lx, 24);
    lx += g.measureText(txt).width + 28;
  }
  // baris kedua legenda: arti garis
  g.font = `18px ${family}`;
  let ly = 50;
  let lx2 = L;
  const key = (color, text, dashed) => {
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 2;
    if (dashed) g.setLineDash([8, 5]);
    g.beginPath();
    g.moveTo(lx2, ly);
    g.lineTo(lx2 + 30, ly);
    g.stroke();
    g.restore();
    g.fillStyle = COLORS.text;
    g.fillText(text, lx2 + 38, ly + 1);
    lx2 += 38 + g.measureText(text).width + 26;
  };
  if (rs.length) key(COLORS.r, "Resistance (R)", true);
  if (ss.length) key(COLORS.s, "Support (S)", true);

  // frame
  g.strokeStyle = "#d3d6dc";
  g.lineWidth = 1;
  g.strokeRect(L + 0.5, T + 0.5, cw, ch);

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
  return renderChart({
    candles: cs,
    coin,
    tf,
    resistance: (report.key_levels?.resistance || []).filter((v) => typeof v === "number"),
    support: (report.key_levels?.support || []).filter((v) => typeof v === "number"),
  });
}

module.exports = { buildChartPng, renderChart, fetchCandles, binanceSymbol };
