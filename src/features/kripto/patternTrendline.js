"use strict";

/**
 * features/kripto/patternTrendline.js
 * ------------------------------------------------------------------
 * Jembatan trendline -> !pola (Fitur 1, pekerjaan #4). Logika MURNI (tanpa jaringan / canvas), bisa diuji unit.
 * Garis dihitung oleh trenStateTrendline.computeTrendlines (tidak ada rumus baru); modul ini hanya memanggilnya dengan
 * swing + ATR dari hasil scan !pola dan menyederhanakan posisinya jadi tiga status yang mudah dibaca:
 *   intact  = garis utuh (harga di dalam jalur / di atas support / di bawah resistance)
 *   near    = dekat garis (<= TL_NEAR_ATR x ATR)
 *   broke   = baru tembus (close melewati garis >= TL_BREAK_ATR x ATR)
 *   regression = tidak ada garis swing valid; jalur regresi sebagai cadangan
 *
 * Aturan: informasi saja. TIDAK mengubah grade / status / skor pola (statistik backtest tetap berlaku).
 */

const { TRENSTATE_CONFIG: CFG } = require("../../config/indicatorConfig");
const { computeStructure } = require("./hhllCore");
const { computeTrendlines } = require("./trenStateTrendline");

/**
 * @param {object[]} candles candle closed, lama -> baru (array yang sama dengan yang dipindai)
 * @param {number} atrLast ATR candle terakhir (dari scanCandlePatterns)
 * @param {string|null} trend tren struktur ("up"|"down"|"range"|null)
 * @returns {null|object} hasil computeTrendlines, null bila dimatikan / data kurang / gagal hitung
 */
function buildTrendline(candles, atrLast, trend) {
  if (!CFG.TL_ENABLED) return null;
  if (!Array.isArray(candles) || candles.length < 20) return null;
  if (!(typeof atrLast === "number" && atrLast > 0)) return null;
  try {
    const st = computeStructure(candles);
    return computeTrendlines(candles, st.swings, { atr: atrLast, dir: trend === "up" || trend === "down" ? trend : null });
  } catch {
    return null; // trendline tidak boleh mematikan !pola
  }
}

/**
 * Status sederhana dari hasil computeTrendlines.
 * @returns {null|{kind:"intact"|"near"|"broke"|"regression", side:"support"|"resistance"|"up"|"down"|null, dist:number|null, level:number|null}}
 */
function trendlineStatus(tl) {
  if (!tl) return null;
  if (tl.mode === "regression") return { kind: "regression", side: tl.regression ? tl.regression.dir : null, dist: null, level: null };
  switch (tl.pos) {
    case "breakUp":
      return { kind: "broke", side: "up", dist: Math.abs(tl.dRes ?? 0), level: tl.resistance ? tl.resistance.levelNow : null };
    case "breakDown":
      return { kind: "broke", side: "down", dist: Math.abs(tl.dSup ?? 0), level: tl.support ? tl.support.levelNow : null };
    case "nearSupport":
      return { kind: "near", side: "support", dist: Math.abs(tl.dSup ?? 0), level: tl.support ? tl.support.levelNow : null };
    case "nearResistance":
      return { kind: "near", side: "resistance", dist: Math.abs(tl.dRes ?? 0), level: tl.resistance ? tl.resistance.levelNow : null };
    default:
      return { kind: "intact", side: null, dist: null, level: null };
  }
}

module.exports = { buildTrendline, trendlineStatus };
