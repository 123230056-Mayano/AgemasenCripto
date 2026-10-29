"use strict";

/**
 * utils/priceFormat.js
 * ------------------------------------------------------------------
 * Satu formatter angka harga untuk pesan, alert, dan chart (!pola dan turunannya).
 * Fungsi MURNI, tanpa dependency (tanpa canvas/axios/i18n), supaya bisa diuji unit di mana saja.
 *
 * Aturan:
 *   - Angka dari data candle/ticker (high/low/close, harga header) ditampilkan PENUH: tidak ada pembulatan, tidak ada
 *     notasi ilmiah (0.0000012345, bukan 1.2345e-6), noise floating point dibuang (0.30000000000000004 -> 0.3).
 *   - Angka hasil hitungan (target, level SNR, level berbasis ATR, garis tren) memakai PRESISI KOIN: jumlah desimal
 *     terbanyak yang muncul di data candle koin itu (coinDecimals), bukan tingkat tetap per harga.
 *   - Pemisah desimal selalu titik, ribuan koma (sama dengan exchange dan chart).
 *   - Bukan angka (null/undefined/NaN/Infinity) -> "-".
 */

const isNum = (v) => typeof v === "number" && isFinite(v);

/** Batas desimal yang ditampilkan (batas aman Intl.NumberFormat lintas versi Node). */
const MAX_DECIMALS = 20;

/**
 * Jumlah desimal pada representasi terpendek sebuah angka, tanpa noise floating point.
 * 67123.45 -> 2 | 0.00001234 -> 8 | 1e-7 -> 7 | 0.30000000000000004 -> 1 | 1234 -> 0
 */
function decimalsOf(v) {
  if (!isNum(v)) return 0;
  const s = String(Number(v.toPrecision(15))).toLowerCase();
  const m = s.match(/^-?(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/);
  if (!m) return 0;
  const frac = m[2] ? m[2].length : 0;
  const exp = m[3] ? Number(m[3]) : 0;
  return Math.min(MAX_DECIMALS, Math.max(0, frac - exp));
}

/** Presisi koin: desimal terbanyak di o/h/l/c semua candle. Data kosong -> 0. */
function coinDecimals(candles) {
  let d = 0;
  if (!Array.isArray(candles)) return d;
  for (const c of candles) {
    if (!c) continue;
    for (const k of ["o", "h", "l", "c"]) {
      const v = c[k];
      if (isNum(v)) d = Math.max(d, decimalsOf(v));
    }
  }
  return d;
}

const asDp = (dp) => (isNum(dp) ? Math.min(MAX_DECIMALS, Math.max(0, Math.floor(dp))) : null);

/** Format dengan jumlah desimal TETAP (en-US: koma ribuan, titik desimal). */
function fixed(v, dp) {
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/**
 * Format harga.
 *   fmtPrice(v)     : angka mentah, tampil penuh persis seperti nilainya (tanpa pembulatan).
 *   fmtPrice(v, dp) : angka hasil hitungan, tampil dengan dp desimal (dp = presisi koin dari coinDecimals).
 */
function fmtPrice(v, dp) {
  if (!isNum(v)) return "-";
  const d = asDp(dp);
  return fixed(v, d == null ? decimalsOf(v) : d);
}

/**
 * Seperti fmtPrice dengan awalan "$", untuk harga header (ticker MENTAH): tidak pernah membulatkan.
 * dp (presisi koin) hanya menjadi batas MINIMUM desimal (supaya 67123.4 tampil 67,123.40 seperti di exchange);
 * tanpa dp: minimal 2 desimal bila harga >= 1, harga di bawah 1 tampil persis nilainya.
 */
function fmtUsdExact(v, dp) {
  if (!isNum(v)) return "-";
  const d = asDp(dp);
  const min = d != null ? d : Math.abs(v) >= 1 ? 2 : 0;
  return "$" + fixed(v, Math.max(min, decimalsOf(v)));
}

/**
 * Format lama (tingkat desimal tetap menurut harga). HANYA untuk pemanggil yang belum tahu presisi koin
 * (!ema, !statistik, !signal, !chart); !pola selalu memakai fmtPrice(v, dp).
 */
function fmtTiered(p) {
  if (!isNum(p)) return "-";
  const d = p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 8;
  return fixed(p, d);
}

/**
 * Angka indikator (RSI, MACD, histogram) dengan desimal penuh dari hasil hitung, tanpa Math.round / toFixed.
 * Hanya noise floating point (digit ke-16 dst) yang dibuang.
 */
function fmtExact(v) {
  if (!isNum(v)) return "-";
  return fixed(v, decimalsOf(v));
}

/** Persen dengan 2 desimal, titik desimal (bukan koma), tanda + untuk positif. */
function fmtPercent(v, d = 2) {
  if (!isNum(v)) return "-";
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
}

/** Angka kecil (rasio, R2, jarak ATR) dengan d desimal dan SELALU titik desimal. */
function fmtNum(v, d = 2) {
  return isNum(v) ? v.toFixed(d) : "-";
}

module.exports = { MAX_DECIMALS, decimalsOf, coinDecimals, fmtPrice, fmtUsdExact, fmtTiered, fmtExact, fmtPercent, fmtNum };
