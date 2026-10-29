"use strict";

/**
 * features/kripto/marketAdapter.js
 * ------------------------------------------------------------------
 * Adapter pasar KRIPTO: hanya membungkus market.js (Binance) dengan antarmuka yang sama dengan adapter forex
 * (forex/forexMarket.js), supaya signal.js / bias.js bisa memakai `ctx.market` tanpa tahu jenis pasarnya.
 * Perilaku kripto TIDAK berubah: semua fungsi memanggil fungsi lama di market.js.
 *
 * Antarmuka adapter:
 *   id, symbol, label, hasVolume, noSnapshot, digits (forex: presisi tetap; kripto: null = ikut data)
 *   fetchTicker() -> {price, changePct}      fetchCandles(tf) -> candle[]    fetchCandlesHistory(tf, {bars}) -> candle[] panjang
 *   computeLevels(candles, price, opts?)     fmtLevel(v)  fmtPrice(v, dp?)  (harga header)  fmtPct(v)
 *   pips(distance) -> number|null            status() -> {open, reason}
 */

const mkt = require("./market");

function createCryptoMarket(coin) {
  return {
    id: "crypto",
    symbol: coin,
    label: `${coin}/USDT`,
    hasVolume: true,
    noSnapshot: false, // mood pasar + tren BTC dari snapshot
    proxy: null,
    allowedTfs: (tfs) => [...tfs],
    fetchTicker: () => mkt.fetchTicker(coin),
    fetchCandles: (tf) => mkt.fetchCandles(coin, tf),
    fetchCandlesHistory: (tf, opts) => mkt.fetchCandlesHistory(coin, tf, opts),
    computeLevels: (candles, price, opts) => mkt.computeLevels(candles, price, opts),
    fmtLevel: (v) => mkt.fmtLevel(v),
    fmtPrice: (v, dp) => mkt.fmtUsd(v, dp), // dp = presisi koin (header !pola); tanpa dp perilaku lama
    fmtPct: (v) => mkt.fmtPct(v),
    digits: null,
    pips: () => null,
    status: async () => ({ open: true, reason: null }), // kripto 24/7
  };
}

/** Adapter untuk simbol dari command: pair forex dikenali lebih dulu, selain itu kripto. */
function resolveMarket(symbol) {
  const { resolvePair } = require("../forex/forexPairs");
  if (resolvePair(symbol)) return require("../forex/forexMarket").createForexMarket(symbol);
  return createCryptoMarket(String(symbol || "").toUpperCase());
}

module.exports = { createCryptoMarket, resolveMarket };
