"use strict";

/**
 * features/kripto/hhllFmt.js
 * ------------------------------------------------------------------
 * Formatter harga untuk teks / PDF HHLL yang sadar jenis pasar. Murni (tanpa jaringan, tanpa canvas).
 *   - pair forex (EURUSD, XAUUSD, ...) : digits tetap per pair (forexPairs.js), TANPA tanda "$".
 *   - selain itu (kripto)              : fungsi lama di market.js (fmtLevel / fmtUsd), perilaku TIDAK berubah.
 */

const { pairInfo } = require("../forex/forexPairs");
const { fmtPrice } = require("../../utils/priceFormat");

/** Pair forex dari nama simbol, null kalau bukan pair (kripto / watchlist). */
const fxInfoOf = (coin) => pairInfo(String(coin || "").toUpperCase());

/**
 * @param {string} coin ticker kripto atau nama pair forex
 * @returns {{isFx:boolean, fmtLevel:(v:number)=>string, fmtPx:(v:number)=>string, pips:(d:number)=>number|null}}
 */
function hhllFormatters(coin) {
  const info = fxInfoOf(coin);
  if (info) {
    const f = (v) => fmtPrice(v, info.digits);
    const { toPips } = require("../forex/forexPairs");
    const pair = String(coin).toUpperCase();
    return { isFx: true, fmtLevel: f, fmtPx: f, pips: (d) => toPips(pair, d) };
  }
  const m = require("./market");
  return { isFx: false, fmtLevel: (v) => m.fmtLevel(v), fmtPx: (v) => m.fmtUsd(v), pips: () => null };
}

module.exports = { hhllFormatters, fxInfoOf };
