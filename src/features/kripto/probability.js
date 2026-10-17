"use strict";

/**
 * features/kripto/probability.js
 * ------------------------------------------------------------------
 * Item 09: probabilitas Bull / Bear / Sideways (tiga angka, jumlah selalu 100%).
 *
 * Dihitung HANYA dari skor bias (item 07: computeBias / computeOverallBias), tanpa AI dan tanpa fetch.
 * Aturan lengkap + angka ada di config/indicatorConfig.js -> PROB_CONFIG (naikkan VERSION bila diubah).
 * Dipakai !bias dan !sinyal; fungsi murni sehingga mudah diuji.
 *
 * Hasil = ESTIMASI dari skor indikator, BUKAN jaminan dan bukan ajakan beli/jual.
 */

const { t } = require("../../i18n");
const { PROB_CONFIG: CFG } = require("../../config/indicatorConfig");

const PROB_VERSION = CFG.VERSION;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = (v) => typeof v === "number" && isFinite(v);

/**
 * Bulatkan bobot (jumlah 1) ke persen bulat yang jumlahnya TEPAT 100 (metode sisa terbesar).
 * @param {number[]} shares
 * @returns {number[]}
 */
function roundTo100(shares) {
  const raw = shares.map((s) => s * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) floors[order[k].i] += 1;
  return floors;
}

/**
 * @param {{score:number, confidence:number, insufficient?:boolean}|null} bias hasil computeBias / computeOverallBias
 * @param {object} [cfg] override config (untuk uji)
 * @returns {{version:number, bull:number, bear:number, sideways:number,
 *            dominant:"bull"|"bear"|"sideways", basis:{score:number, confidence:number, strength:number}}|null}
 *          null bila data tidak cukup (jangan menampilkan angka karangan).
 */
function computeProbability(bias, cfg = CFG) {
  if (!bias || bias.insufficient || !isNum(bias.score) || !isNum(bias.confidence)) return null;
  const score = clamp(bias.score, -1, 1);
  const conf = clamp(bias.confidence, 0, 1);

  const strength = Math.min(1, Math.abs(score) / cfg.FULL_SCORE);
  const sw = clamp(cfg.SW_RANGE * (1 - strength) + cfg.SW_CONF * (1 - conf), cfg.SW_MIN, cfg.SW_MAX);
  const lean = clamp(score * cfg.SPLIT_GAIN, -1, 1) * cfg.SPLIT_MAX;
  const bull = (1 - sw) * (1 + lean) / 2;
  const bear = (1 - sw) - bull;

  const [pBull, pBear, pSide] = roundTo100([bull, bear, sw]);
  const top = Math.max(pBull, pBear, pSide);
  // Seri: urutan sideways > bull > bear tidak dipakai untuk memihak; seri dianggap sideways (paling netral).
  const dominant = pSide === top ? "sideways" : pBull === top ? "bull" : "bear";
  return {
    version: PROB_VERSION,
    bull: pBull,
    bear: pBear,
    sideways: pSide,
    dominant,
    basis: { score, confidence: conf, strength },
  };
}

// =====================================================================
// Tampilan (dipakai !bias dan !sinyal)
// =====================================================================
const fmtScore = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
const pct = (v) => `${v}%`;

/** Satu baris: "Bull 50% | Bear 16% | Sideways 34%". */
function formatProbLine(lang, p) {
  return t(lang, "prob.line", { bull: p.bull, bear: p.bear, side: p.sideways });
}

/** Dasar singkat: "skor +0.31, keyakinan 60%". */
function formatProbBasis(lang, p) {
  return t(lang, "prob.basis", { score: fmtScore(p.basis.score), conf: Math.round(p.basis.confidence * 100) });
}

/**
 * Tabel monospace (dibungkus ``` oleh pemanggil): satu baris per TF + baris Total bila ada.
 * @param {{label:string, prob:object|null}[]} rows
 * @param {{label:string, prob:object}|null} total
 */
function formatProbTable(lang, rows, total) {
  const W = Math.max(4, ...rows.map((r) => r.label.length), total ? total.label.length : 0);
  const cell = (v) => (v == null ? "-" : pct(v)).padStart(4, " ");
  const line = (label, p) => `${label.padEnd(W, " ")} ${cell(p?.bull)} ${cell(p?.bear)} ${cell(p?.sideways)}`;
  const header = `${t(lang, "kripto.mtf.colTf").padEnd(W, " ")} ${"Bull".padStart(4)} ${"Bear".padStart(4)} ${"Side".padStart(4)}`;
  const body = rows.map((r) => line(r.label, r.prob));
  if (total) body.push("-".repeat(header.length), line(total.label, total.prob));
  return [header, ...body].join("\n");
}

module.exports = { PROB_VERSION, computeProbability, roundTo100, formatProbLine, formatProbBasis, formatProbTable };
