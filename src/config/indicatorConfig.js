"use strict";

/**
 * config/indicatorConfig.js
 * ------------------------------------------------------------------
 * Satu-satunya tempat parameter indikator dasar (item 01 Fondasi Indikator).
 * Dipakai features/kripto/indicators.js (dan divergence.js untuk RSI/ATR).
 * Nilai default = nilai standar yang sama dengan web analyst (lib/indicators.js),
 * jadi angka bot dan web tetap identik. Ubah di sini, jangan di tiap fitur.
 */

const INDICATOR_CONFIG = Object.freeze({
  EMA_PERIODS: Object.freeze([20, 50, 200]),
  RSI_PERIOD: 14,
  MACD_FAST: 12,
  MACD_SLOW: 26,
  MACD_SIGNAL: 9,
  ATR_PERIOD: 14,
  // Jumlah candle closed minimum agar indikator terisi penuh.
  EMA_FULL_MIN: 200, // EMA 200 + klasifikasi tren penuh
  EMA_LIMITED_MIN: 50, // di bawah EMA_FULL_MIN: tren cadangan EMA 20/50
  // Item 02 EMA Crossover. Cross dianggap "baru" bila terjadi <= CROSS_LOOKBACK candle closed lalu.
  CROSS_LOOKBACK: 10,
  // Pasangan [cepat, lambat] yang ditampilkan di !mtf (urutan = urutan kolom).
  CROSS_PAIRS: Object.freeze([Object.freeze([20, 50]), Object.freeze([50, 200])]),
});

module.exports = { INDICATOR_CONFIG };
