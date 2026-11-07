"use strict";

/**
 * features/kripto/mstrutProb.js
 * ------------------------------------------------------------------
 * Probabilitas LONG / SHORT / SIDEWAYS dari market structure untuk !mstrut. Logika MURNI (tanpa fetch, tanpa
 * kirim pesan): hanya memakai hasil analyzeStructure (mstrutCore.js), jadi bisa diuji dan dipakai backtest.
 *
 * Langkah:
 *   1. Skor struktur -1..+1 (+ = bullish) = jumlah komponen berbobot (bobot di MSTRUT_PROB_CONFIG):
 *        trend  : label swing HH+HL = +1, LH+LL = -1, campuran = 0
 *        break  : arah tembusan struktur terakhir (BOS / CHoCH) naik = +1, turun = -1
 *        mss    : MSS terbaru bullish +1 / bearish -1 (memudar menurut umur)
 *        sweep  : sweep SSL terbaru = +1 (stop sisi jual sudah disapu), sweep BSL = -1 (memudar menurut umur)
 *        zone   : posisi harga di range swing terakhir: discount (bawah 50%) = +, premium (atas 50%) = -
 *   2. Keyakinan = seberapa searah komponen yang aktif (|jumlah| / jumlah |komponen|). Komponen yang saling
 *      bertentangan -> keyakinan rendah -> porsi sideways naik.
 *   3. Skor + keyakinan diubah jadi tiga persen (jumlah tepat 100) oleh computeProbability (probability.js),
 *      aturan yang sama dengan !bias / !sinyal.
 *
 * Hasil = ESTIMASI berbasis aturan, BUKAN jaminan arah harga. Seberapa benar angkanya diukur terpisah oleh
 * mstrutBacktest.js (kalibrasi: apakah "Long 60%" memang naik lebih dulu ~60% kali?).
 */

const { MSTRUT_PROB_CONFIG: CFG } = require("../../config/indicatorConfig");
const { computeProbability } = require("./probability");

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = (v) => typeof v === "number" && isFinite(v);

/**
 * Komponen skor (masing-masing -1..+1) dari hasil analyzeStructure.
 * @param {object} res hasil analyzeStructure
 * @returns {{trend:number, break:number, mss:number, sweep:number, zone:number}}
 */
function structureComponents(res, cfg = CFG) {
  const trend = res.trend === "up" ? 1 : res.trend === "down" ? -1 : 0;
  const brk = res.smTrend === "up" ? 1 : res.smTrend === "down" ? -1 : 0;

  let mss = 0;
  const m = res.events && res.events.mss;
  if (m && isNum(m.age) && m.age <= cfg.MSS_MAX_AGE) {
    const fade = 1 - (0.5 * m.age) / cfg.MSS_MAX_AGE; // umur 0 = penuh, batas umur = setengah
    mss = (m.dir === "bull" ? 1 : -1) * fade;
  }

  let sweep = 0;
  const s = res.sweep;
  if (s && isNum(s.age) && s.age <= cfg.SWEEP_MAX_AGE) {
    const fade = 1 - (0.5 * s.age) / cfg.SWEEP_MAX_AGE;
    sweep = (s.side === "SSL" ? 1 : -1) * fade;
  }

  let zone = 0;
  const hi = res.lastHigh && res.lastHigh.price;
  const lo = res.lastLow && res.lastLow.price;
  if (isNum(hi) && isNum(lo) && hi > lo && isNum(res.price)) {
    const pos = (res.price - lo) / (hi - lo); // 0 = di swing low, 1 = di swing high
    zone = clamp((0.5 - pos) * 2, -1, 1);
  }
  return { trend, break: brk, mss, sweep, zone };
}

/**
 * Skor + keyakinan struktur.
 * @returns {{score:number, confidence:number, comps:object}}
 */
function structureScore(res, cfg = CFG) {
  const comps = structureComponents(res, cfg);
  const w = { trend: cfg.W_TREND, break: cfg.W_BREAK, mss: cfg.W_MSS, sweep: cfg.W_SWEEP, zone: cfg.W_ZONE };
  let sum = 0;
  let mag = 0;
  for (const k of Object.keys(w)) {
    sum += w[k] * comps[k];
    mag += w[k] * Math.abs(comps[k]);
  }
  const score = clamp(sum, -1, 1);
  const confidence = mag > 0 ? clamp(Math.abs(sum) / mag, 0, 1) : 0;
  return { score, confidence, comps };
}

/**
 * Probabilitas market structure.
 * @param {object} res hasil analyzeStructure
 * @returns {{version:number, long:number, short:number, sideways:number, dominant:"long"|"short"|"sideways",
 *            top:"long"|"short"|null, pTop:number|null, pDir:number|null, basis:object}|null}
 *   top  = sisi tertinggi antara long vs short (null kalau persis seri)
 *   pTop = persen sisi top; pDir = porsi top terhadap long+short (50..100), dasar kalibrasi backtest
 *   null kalau data tidak cukup (jangan menampilkan angka karangan).
 */
function computeMstrutProb(res, cfg = CFG) {
  if (!res) return null;
  const { score, confidence, comps } = structureScore(res, cfg);
  const p = computeProbability({ score, confidence });
  if (!p) return null;
  const long = p.bull;
  const short = p.bear;
  const top = long === short ? null : long > short ? "long" : "short";
  const pTop = top === "long" ? long : top === "short" ? short : null;
  const dirSum = long + short;
  const pDir = top && dirSum > 0 ? (Math.max(long, short) / dirSum) * 100 : null;
  const dominant = p.dominant === "bull" ? "long" : p.dominant === "bear" ? "short" : "sideways";
  return {
    version: cfg.VERSION,
    long,
    short,
    sideways: p.sideways,
    dominant,
    top,
    pTop,
    pDir,
    basis: { score, confidence, comps },
  };
}

/** Kelompok kalibrasi menurut pDir (mis. "50-59", "60-69", "70+"). null kalau pDir tidak ada. */
function binOf(pDir, edges = CFG.BIN_EDGES) {
  if (!isNum(pDir)) return null;
  for (let i = 0; i < edges.length - 1; i++) {
    if (pDir >= edges[i] && pDir < edges[i + 1]) return i === edges.length - 2 ? `${edges[i]}+` : `${edges[i]}-${edges[i + 1] - 1}`;
  }
  return null;
}

module.exports = { structureComponents, structureScore, computeMstrutProb, binOf };
