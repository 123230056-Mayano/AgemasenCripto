"use strict";

/**
 * features/kripto/trendStrengthBacktest.js
 * ------------------------------------------------------------------
 * Backtest KEKUATAN TREN (Fitur 3, pekerjaan #5). Logika MURNI: tanpa jaringan, tanpa file (I/O ada di
 * scripts/backtest-kekuatan-tren.js). Pola sama dengan trenStateBacktest.js dan memakai outcomeOf-nya.
 *
 * Pertanyaan yang diuji: apakah tren berlabel KUAT benar lebih sering LANJUT dibanding LEMAH?
 * Untuk tiap candle closed i (tiap BT_STEP candle, setelah BT_WARMUP), kekuatan dihitung dari jendela paling banyak
 * BT_WINDOW candle yang berakhir di i (sama dengan produksi, tanpa lookahead), lalu BT_HORIZON candle ke depan diamati:
 *   continue : close melewati ujung leg (ekstrem) searah tren SEBELUM close melewati level batal (HL / LH)
 *   fail     : close melewati level batal lebih dulu
 *   neither  : keduanya tidak terjadi dalam horizon
 * Sampel tanpa level (range, data kurang) dan sampel yang struktur trennya sudah patah (REVERSAL) tidak dihitung: tidak ada
 * klaim "lanjut" di sana. Sampel yang horizon ke depannya belum penuh dibuang.
 *
 * Kesimpulan jujur (verdict) per timeframe, hanya dari bagian waktu TERAKHIR (out-of-sample):
 *   better       : N KUAT dan N LEMAH >= MIN_N_SHOW, % lanjut KUAT > LEMAH dan z >= Z_MIN
 *   not_better   : N cukup tetapi KUAT tidak terbukti lebih baik (termasuk kalau malah lebih buruk)
 *   insufficient : N salah satu kelompok < MIN_N_SHOW (tidak ada kesimpulan)
 *
 * BATAS YANG HARUS DISEBUT DI LAPORAN (hasil cenderung terlalu optimistis):
 *   - tanpa fee / slip / spread / gap nyata: statistik arah, bukan hasil trading;
 *   - sampel berdekatan memakai horizon yang tumpang tindih, jadi tidak independen (z terlalu percaya diri);
 *   - ambang STRENGTH_* masih nilai awal usulan dan belum dioptimalkan; angka oos hanya dari bagian waktu terakhir;
 *   - riwayat satu koin pendek untuk 4H / 1D: gabungkan koin (pooled per timeframe);
 *   - "lanjut" didefinisikan lewat ujung leg vs level batal, bukan besar keuntungan.
 */

const { STRENGTH_CONFIG: CFG } = require("../../config/indicatorConfig");
const { trendStrength } = require("./trendStrength");
const { outcomeOf } = require("./trenStateBacktest");
const { STATUS } = require("./trenState");

const isNum = (v) => typeof v === "number" && isFinite(v);

/**
 * Backtest satu koin + satu timeframe.
 * @param {object[]} candles candle closed urut lama -> baru
 * @param {object[]|null} htfCandles candle closed TF besar (boleh null untuk 1D)
 * @param {{coin?:string, tf:string, horizon?:number, step?:number}} opts
 * @returns {{coin:string, tf:string, t:number, level:"strong"|"medium"|"weak", capped:boolean, dir:"up"|"down", outcome:"continue"|"fail"|"neither"}[]}
 */
function runStrengthBacktest(candles, htfCandles, opts) {
  const { tf, coin = "?", horizon = CFG.BT_HORIZON, step = CFG.BT_STEP } = opts;
  const n = candles ? candles.length : 0;
  const cache = new Map();
  const samples = [];
  for (let i = CFG.BT_WARMUP; i + horizon < n; i += Math.max(1, step)) {
    const win = candles.slice(Math.max(0, i + 1 - CFG.BT_WINDOW), i + 1);
    const r = trendStrength(win, htfCandles, { tf, cache });
    if (r.state !== "ok" || !r.levels || !isNum(r.levels.invalidation) || r.rawStatus === STATUS.REVERSAL) continue;
    const a = { status: r.rawStatus, dir: r.dir, atr: r.atr, close: win[win.length - 1].c, inval: r.levels.invalidation, extreme: r.levels.extreme };
    const outcome = outcomeOf(a, candles.slice(i + 1, i + 1 + horizon));
    if (outcome) samples.push({ coin, tf, t: win[win.length - 1].t, level: r.level, capped: r.capped, dir: r.dir, outcome });
  }
  return samples;
}

/** Ringkas satu kelompok sampel: jumlah dan persen lanjut / gagal / tak satupun. null kalau kosong. */
function summarize(samples) {
  const n = samples.length;
  if (!n) return null;
  const c = (o) => samples.filter((s) => s.outcome === o).length;
  return { n, cont: (c("continue") / n) * 100, fail: (c("fail") / n) * 100, neither: (c("neither") / n) * 100 };
}

/** Kelompok: `${tf}|any` dan `${tf}|${level}`. */
function buildGroups(samples) {
  const buckets = new Map();
  const add = (k, s) => (buckets.has(k) ? buckets.get(k).push(s) : buckets.set(k, [s]));
  for (const s of samples) {
    add(`${s.tf}|any`, s);
    add(`${s.tf}|${s.level}`, s);
  }
  const out = {};
  for (const [k, arr] of buckets) out[k] = summarize(arr);
  return out;
}

/** Waktu pemisah: TRAIN_FRAC awal (stel) vs sisanya (ukur / out-of-sample). */
function cutoffTime(samples, frac = CFG.TRAIN_FRAC) {
  if (!samples.length) return null;
  const ts = samples.map((s) => s.t).sort((a, b) => a - b);
  return ts[Math.min(ts.length - 1, Math.floor(ts.length * frac))];
}

/**
 * Uji dua proporsi (satu sisi): apakah % lanjut KUAT lebih tinggi dari LEMAH secara nyata?
 * @returns {{verdict:"better"|"not_better"|"insufficient", diff:number|null, z:number|null, nStrong:number, nWeak:number}}
 */
function verdictFor(strong, weak, { minN = CFG.MIN_N_SHOW, zMin = CFG.Z_MIN } = {}) {
  const nS = strong ? strong.n : 0;
  const nW = weak ? weak.n : 0;
  if (nS < minN || nW < minN) return { verdict: "insufficient", diff: null, z: null, nStrong: nS, nWeak: nW };
  const p1 = strong.cont / 100;
  const p2 = weak.cont / 100;
  const pool = (p1 * nS + p2 * nW) / (nS + nW);
  const se = Math.sqrt(pool * (1 - pool) * (1 / nS + 1 / nW));
  const z = se > 0 ? (p1 - p2) / se : p1 > p2 ? Infinity : 0;
  const diff = (p1 - p2) * 100;
  return { verdict: diff > 0 && z >= zMin ? "better" : "not_better", diff, z, nStrong: nS, nWeak: nW };
}

/**
 * Isi data/kekuatan-tren-stats.json. Kesimpulan hanya dari `oos`; `train` ikut disimpan sebagai pembanding (selisih train vs
 * oos menunjukkan seberapa goyah angkanya).
 */
function buildStatsFile(samples, meta = {}) {
  const cut = cutoffTime(samples);
  const train = cut == null ? [] : samples.filter((s) => s.t < cut);
  const oos = cut == null ? [] : samples.filter((s) => s.t >= cut);
  const tfs = [...new Set(samples.map((s) => s.tf))];
  const oosGroups = buildGroups(oos);
  const verdicts = {};
  for (const tf of tfs) verdicts[tf] = verdictFor(oosGroups[`${tf}|strong`], oosGroups[`${tf}|weak`]);
  return {
    version: CFG.VERSION,
    generatedAt: new Date().toISOString(),
    horizon: CFG.BT_HORIZON,
    step: CFG.BT_STEP,
    minN: CFG.MIN_N_SHOW,
    zMin: CFG.Z_MIN,
    cutoff: cut,
    nTrain: train.length,
    nOos: oos.length,
    ...meta,
    caveats: [
      "tanpa fee/slip/spread nyata; ini statistik arah, bukan hasil trading",
      "sampel berdekatan tumpang tindih (tidak independen), jadi z terlalu percaya diri",
      "ambang STRENGTH_* nilai awal usulan, belum dioptimalkan; angka oos hanya dari bagian waktu terakhir",
      'lanjut = close melewati ujung leg sebelum close melewati level batal (bukan besar keuntungan)',
    ],
    train: buildGroups(train),
    oos: oosGroups,
    verdicts,
  };
}

module.exports = { runStrengthBacktest, summarize, buildGroups, cutoffTime, verdictFor, buildStatsFile };
