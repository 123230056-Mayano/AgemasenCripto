"use strict";

/**
 * features/kripto/divergence.js
 * ------------------------------------------------------------------
 * Deteksi divergence harga vs RSI / histogram MACD (dipakai !scandivergent,
 * !scan div_bull|div_bear, dan nanti !alertdiv).
 *
 * FUNGSI MURNI: tanpa fetch, tanpa cache, tanpa kirim pesan. Input sama -> output sama
 * (waktu "sekarang" hanya dipakai untuk membuang candle berjalan dan bisa disuntik lewat opts.now).
 *
 * Empat jenis:
 *   reguler bullish     : harga lower low  , indikator higher low   (potensi pembalikan naik)
 *   reguler bearish     : harga higher high, indikator lower high   (potensi pembalikan turun)
 *   tersembunyi bullish : harga higher low , indikator lower low    (potensi lanjutan naik)
 *   tersembunyi bearish : harga lower high , indikator higher high  (potensi lanjutan turun)
 *
 * Aturan penting:
 *   - Hanya candle CLOSED. Candle di ujung deret yang belum tutup dibuang dulu (closed === false,
 *     atau ct >= now, ct = waktu tutup dalam ms).
 *   - Pivot butuh PIVOT_WIN candle konfirmasi di kanan, jadi sinyal selalu terlambat PIVOT_WIN
 *     candle dari puncak/lembah sebenarnya. Disengaja agar hasil tidak berubah-ubah.
 *   - Satu cara pivot saja: pivot indikator = nilai indikator di candle pivot HARGA yang sama.
 *   - Kebaruan: pivot kedua harus terkonfirmasi <= LOOKBACK candle terakhir (inklusif, jadi
 *     barsAgo 0..LOOKBACK; sesuai contoh PDF yang menampilkan "3 candle").
 *
 * Changelog parameter: v1 (2026-10-16) nilai awal usulan PDF. Setel setelah dibandingkan dengan chart.
 */

const { rsi, macd, atr } = require("./indicators");

const DIV_VERSION = 1;
const DIV = {
  PIVOT_WIN: 3, // seperti levels() di analyst
  MIN_BARS: 5, // jarak minimum antar dua pivot
  MAX_BARS: 60, // jarak maksimum antar dua pivot
  LOOKBACK: 3, // pivot terbaru harus terkonfirmasi dalam N candle terakhir
  MIN_IND_DIFF_RSI: 2, // selisih RSI minimum antar pivot (poin)
  MIN_IND_DIFF_MACD_PCT: 0.05, // selisih hist MACD minimum = 5% dari rentang hist terbaru
  MACD_RANGE_BARS: 100, // "terbaru" untuk rentang histogram = 100 candle closed terakhir
  MIN_PRICE_ATR: 0.1, // selisih harga minimum, dalam kelipatan ATR(14) di pivot kedua
  RSI_PERIOD: 14,
  ATR_PERIOD: 14,
};
const DEFAULT_INDICATORS = ["rsi", "macd"];
const MIN_CANDLES = 40; // MACD butuh warmup 26 + 9 - 1 = 34 candle; di bawah ini dilewati (bukan error)

/** Buang candle berjalan di ujung deret. Candle tanpa ct/closed dianggap sudah closed. */
function dropUnclosed(candles, now = Date.now()) {
  let end = candles.length;
  while (end > 0) {
    const c = candles[end - 1];
    if (c.closed === false || (c.ct != null && c.ct >= now)) end--;
    else break;
  }
  return end === candles.length ? candles : candles.slice(0, end);
}

/**
 * Index pivot: lebih rendah/tinggi dari `win` candle di KIRI (strict) dan tidak lebih tinggi/rendah dari
 * `win` candle di KANAN (boleh sama). Kalau ada dataran dengan harga yang persis sama (umum di koin
 * berharga kecil dengan tick size kasar), yang dihitung pivot hanya yang paling awal, jadi tidak ada
 * pivot ganda dan tidak ada pivot yang hilang. Hanya yang sudah terkonfirmasi (i + win <= candle terakhir).
 */
function findPivots(candles, win, type) {
  const key = type === "low" ? "l" : "h";
  const out = [];
  for (let i = win; i <= candles.length - 1 - win; i++) {
    const v = candles[i][key];
    let ok = true;
    for (let j = 1; j <= win; j++) {
      const l = candles[i - j][key];
      const r = candles[i + j][key];
      if (type === "low" ? !(v < l && v <= r) : !(v > l && v >= r)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function histRange(hist, n, bars) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = Math.max(0, n - bars); i < n; i++) {
    if (hist[i] == null) continue;
    if (hist[i] < lo) lo = hist[i];
    if (hist[i] > hi) hi = hist[i];
  }
  return hi > lo ? hi - lo : 0;
}

/**
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,ct?:number,closed?:boolean}>} candles urut lama -> baru
 * @param {{indicators?:string[], now?:number}&Partial<typeof DIV>} [opts]
 * @returns {Array<{indicator:'rsi'|'macd', kind:'regular'|'hidden', dir:'bull'|'bear',
 *   pivot1:{idx:number,time:number,price:number,ind:number}, pivot2:{idx:number,time:number,price:number,ind:number},
 *   confirmedAtTime:number, barsAgo:number}>} terbaru dulu
 */
function detectDivergence(candles, opts = {}) {
  const { indicators = DEFAULT_INDICATORS, now = Date.now(), ...over } = opts;
  const P = { ...DIV, ...over };
  if (!Array.isArray(candles)) return [];

  const cs = dropUnclosed(candles, now); // langkah 1
  const n = cs.length;
  if (n < MIN_CANDLES) return [];

  // langkah 2: indikator atas deret closed saja
  const closes = cs.map((c) => c.c);
  const series = {};
  const minDiff = {};
  if (indicators.includes("rsi")) {
    series.rsi = rsi(closes, P.RSI_PERIOD);
    minDiff.rsi = P.MIN_IND_DIFF_RSI;
  }
  if (indicators.includes("macd")) {
    const hist = macd(closes).hist;
    series.macd = hist;
    minDiff.macd = P.MIN_IND_DIFF_MACD_PCT * histRange(hist, n, P.MACD_RANGE_BARS);
  }
  const atrS = atr(cs, P.ATR_PERIOD);
  const last = n - 1;
  const out = [];

  // langkah 3: pivot terkonfirmasi (i + win <= last dijamin findPivots)
  for (const type of ["low", "high"]) {
    const piv = findPivots(cs, P.PIVOT_WIN, type);
    if (piv.length < 2) continue;
    const i1 = piv[piv.length - 2]; // langkah 4: dua pivot terakhir yang sejenis
    const i2 = piv[piv.length - 1];
    const gap = i2 - i1;
    if (gap < P.MIN_BARS || gap > P.MAX_BARS) continue;

    const confirmIdx = i2 + P.PIVOT_WIN;
    const barsAgo = last - confirmIdx; // langkah 8: kebaruan
    if (barsAgo > P.LOOKBACK) continue;

    const key = type === "low" ? "l" : "h";
    const price1 = cs[i1][key];
    const price2 = cs[i2][key];
    const a = atrS[i2];
    if (a == null || !(a > 0)) continue;
    if (Math.abs(price2 - price1) < P.MIN_PRICE_ATR * a) continue; // langkah 6: filter harga

    for (const ind of Object.keys(series)) {
      const v1 = series[ind][i1]; // langkah 5: nilai di candle pivot yang sama
      const v2 = series[ind][i2];
      if (v1 == null || v2 == null) continue;
      if (Math.abs(v2 - v1) < minDiff[ind] || v2 === v1) continue; // langkah 6: filter indikator

      const priceUp = price2 > price1;
      const indUp = v2 > v1;
      let kind = null;
      let dir = null;
      if (type === "low") {
        dir = "bull";
        if (!priceUp && indUp) kind = "regular"; // lower low + higher low
        else if (priceUp && !indUp) kind = "hidden"; // higher low + lower low
      } else {
        dir = "bear";
        if (priceUp && !indUp) kind = "regular"; // higher high + lower high
        else if (!priceUp && indUp) kind = "hidden"; // lower high + higher high
      }
      if (!kind) continue; // langkah 7

      out.push({
        indicator: ind,
        kind,
        dir,
        pivot1: { idx: i1, time: cs[i1].t, price: price1, ind: v1 },
        pivot2: { idx: i2, time: cs[i2].t, price: price2, ind: v2 },
        confirmedAtTime: cs[confirmIdx].t,
        barsAgo,
      });
    }
  }
  return out.sort((x, y) => x.barsAgo - y.barsAgo || (x.indicator < y.indicator ? -1 : x.indicator > y.indicator ? 1 : 0));
}

module.exports = { DIV, DIV_VERSION, DEFAULT_INDICATORS, MIN_CANDLES, detectDivergence, dropUnclosed, findPivots };
