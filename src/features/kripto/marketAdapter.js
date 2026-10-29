"use strict";

/**
 * features/kripto/marketAdapter.js
 * ------------------------------------------------------------------
 * Adapter pasar KRIPTO: hanya membungkus market.js (Binance) dengan antarmuka yang sama dengan adapter forex
 * (forex/forexMarket.js), supaya signal.js / bias.js bisa memakai `ctx.market` tanpa tahu jenis pasarnya.
 * Perilaku kripto TIDAK berubah: semua fungsi memanggil fungsi lama di market.js.
 *
 * Antarmuka adapter:
 *   id, symbol, label, hasVolume, noSnapshot
 *   fetchTicker() -> {price, changePct}      fetchCandles(tf) -> candle[]
 *   computeLevels(candles, price)            fmtLevel(v)  fmtPrice(v)  (harga header)
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
    computeLevels: (candles, price) => mkt.computeLevels(candles, price),
    fmtLevel: (v) => mkt.fmtLevel(v),
    fmtPrice: (v) => mkt.fmtUsd(v),
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
