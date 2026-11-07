"use strict";

/**
 * features/kripto/mstrutBacktest.js
 * ------------------------------------------------------------------
 * Logika MURNI backtest probabilitas !mstrut: tanpa jaringan, tanpa file. I/O ada di scripts/backtest-mstrut.js.
 * Pola sama dengan trenStateBacktest.js.
 *
 * Pertanyaan yang dijawab: "kalau bot bilang LONG 60%, apakah harga memang naik lebih dulu sekitar 60% kali?"
 *
 * Untuk tiap candle closed i (setelah BT_WARMUP, tiap BT_STEP candle) probabilitas dihitung dari jendela paling
 * banyak BT_WINDOW candle yang berakhir di i (sama dengan produksi), jadi TIDAK ADA lookahead. Lalu diamati
 * BT_HORIZON candle ke depan dengan dua pagar simetris dari close sampel:
 *     naik  : high >= close + BT_BARRIER_ATR x ATR
 *     turun : low  <= close - BT_BARRIER_ATR x ATR
 *   - pagar yang tersentuh LEBIH DULU menentukan hasil ("up" / "down");
 *   - kedua pagar tersentuh di candle yang sama = "both" (urutan tidak diketahui, dibuang dari hitungan, konservatif);
 *   - tidak ada yang tersentuh = "none" (dibuang dari hitungan hit-rate, tetap dilaporkan).
 * Karena pagarnya simetris, tebakan acak ~50% dari kasus yang selesai. Pembanding lain yang ikut dilaporkan: porsi
 * "up" di seluruh sampel (baseUp). Bot yang selalu menebak LONG saat pasar naik juga akan tampak bagus, jadi
 * hit-rate harus mengalahkan max(baseUp, 100 - baseUp) untuk dianggap punya keunggulan nyata.
 *
 * Klaim yang diuji = sisi tertinggi antara long vs short (top) dan porsinya pDir = max(long, short) / (long + short).
 * Sampel tanpa top (long persis sama dengan short) tidak diberi klaim.
 *
 * BATAS YANG HARUS DISEBUT DI LAPORAN (hasil cenderung terlalu optimistis):
 *   - tanpa fee/slip/spread/gap nyata: ini statistik arah, bukan hasil trading;
 *   - sampel berdekatan memakai horizon yang tumpang tindih, jadi tidak sepenuhnya independen
 *     (BT_STEP mengurangi, tidak menghilangkan);
 *   - bobot yang disetel pada data yang sama dengan yang diukur akan tampak bagus (overfit): statistik yang
 *     ditampilkan bot hanya dari bagian waktu TERAKHIR (oos, 1 - TRAIN_FRAC) dan hanya bila N >= MIN_N_SHOW;
 *   - riwayat satu koin pendek untuk 4H/1D: gabungkan koin (statistik pooled per timeframe).
 */

const { MSTRUT_PROB_CONFIG: CFG } = require("../../config/indicatorConfig");
const { analyzeStructure } = require("./mstrutCore");
const { computeMstrutProb, binOf } = require("./mstrutProb");

const isNum = (v) => typeof v === "number" && isFinite(v);

/**
 * Hasil satu sampel: pagar mana yang tersentuh lebih dulu.
 * @param {number} close close candle sampel
 * @param {number} atr ATR saat sampel
 * @param {{h:number,l:number}[]} future candle sesudah sampel (urut lama -> baru), panjang = horizon
 * @returns {"up"|"down"|"both"|"none"|null} null kalau close / ATR tidak valid
 */
function outcomeOf(close, atr, future, { barrierAtr = CFG.BT_BARRIER_ATR } = {}) {
  if (!isNum(close) || !isNum(atr) || atr <= 0) return null;
  const up = close + barrierAtr * atr;
  const dn = close - barrierAtr * atr;
  for (const f of future) {
    const hitUp = f.h >= up;
    const hitDn = f.l <= dn;
    if (hitUp && hitDn) return "both";
    if (hitUp) return "up";
    if (hitDn) return "down";
  }
  return "none";
}

/**
 * Backtest satu koin + satu timeframe.
 * @param {object[]} candles candle closed urut lama -> baru
 * @param {{coin?:string, tf:string, horizon?:number, step?:number}} opts
 * @returns {{coin:string, tf:string, t:number, long:number, short:number, sideways:number, top:"long"|"short",
 *            pDir:number, bin:string, outcome:"up"|"down"|"both"|"none"}[]}
 */
function runMstrutBacktest(candles, opts = {}) {
  const { tf, coin = "?", horizon = CFG.BT_HORIZON, step = CFG.BT_STEP } = opts;
  const n = candles ? candles.length : 0;
  const samples = [];
  for (let i = CFG.BT_WARMUP; i < n; i += Math.max(1, step)) {
    if (i + horizon >= n) break; // horizon ke depan belum penuh: buang (tidak dihitung setengah)
    const win = candles.slice(Math.max(0, i + 1 - CFG.BT_WINDOW), i + 1);
    const res = analyzeStructure(win);
    if (!res) continue;
    const p = computeMstrutProb(res);
    if (!p || !p.top) continue;
    const outcome = outcomeOf(candles[i].c, res.atr, candles.slice(i + 1, i + 1 + horizon));
    if (!outcome) continue;
    samples.push({ coin, tf, t: candles[i].t, long: p.long, short: p.short, sideways: p.sideways, top: p.top, pDir: p.pDir, bin: binOf(p.pDir), outcome });
  }
  return samples;
}

// ---------- statistik ----------
/** Batas bawah / atas interval Wilson 95% untuk proporsi k dari n (dalam persen). */
function wilson(k, n, z = 1.96) {
  if (!n) return { lo: null, hi: null };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: ((c - m) / d) * 100, hi: ((c + m) / d) * 100 };
}

/**
 * Ringkas satu kelompok sampel.
 * @returns {null|{n:number, nRes:number, nNone:number, nBoth:number, hit:number, hitRate:number|null, ciLo:number|null,
 *                 ciHi:number|null, claim:number|null, baseUp:number|null, beatsBase:boolean, verdict:string}}
 */
function summarize(samples, cfg = CFG) {
  const n = samples.length;
  if (!n) return null;
  const res = samples.filter((s) => s.outcome === "up" || s.outcome === "down");
  const nRes = res.length;
  const hit = res.filter((s) => (s.top === "long" ? s.outcome === "up" : s.outcome === "down")).length;
  const hitRate = nRes ? (hit / nRes) * 100 : null;
  const { lo, hi } = wilson(hit, nRes);
  const claim = nRes ? res.reduce((a, s) => a + s.pDir, 0) / nRes : null;
  const baseUp = nRes ? (res.filter((s) => s.outcome === "up").length / nRes) * 100 : null;
  const baseBest = baseUp == null ? null : Math.max(baseUp, 100 - baseUp);
  const beatsBase = hitRate != null && baseBest != null && hitRate > baseBest;
  let verdict = "insufficient";
  if (nRes >= cfg.MIN_N_SHOW) {
    verdict = lo > 50 && hitRate - 50 >= cfg.MIN_EDGE_PTS && beatsBase ? "edge" : "no_edge";
  }
  return {
    n,
    nRes,
    nNone: samples.filter((s) => s.outcome === "none").length,
    nBoth: samples.filter((s) => s.outcome === "both").length,
    hit,
    hitRate,
    ciLo: lo,
    ciHi: hi,
    claim,
    baseUp,
    beatsBase,
    verdict,
  };
}

/** Kelompok per timeframe: `${tf}|any` (semua), `${tf}|long`, `${tf}|short`, `${tf}|bin:<label>`. */
function buildGroups(samples) {
  const buckets = new Map();
  const add = (k, s) => (buckets.has(k) ? buckets.get(k).push(s) : buckets.set(k, [s]));
  for (const s of samples) {
    add(`${s.tf}|any`, s);
    add(`${s.tf}|${s.top}`, s);
    if (s.bin) add(`${s.tf}|bin:${s.bin}`, s);
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
 * Isi data/mstrut-stats.json. `oos` = hanya bagian waktu terakhir; itu yang dibaca !mstrut.
 * `train` ikut disimpan (perbandingan train vs oos menunjukkan seberapa goyah angkanya).
 */
function buildStatsFile(samples, meta = {}) {
  const cut = cutoffTime(samples);
  const train = cut == null ? [] : samples.filter((s) => s.t < cut);
  const oos = cut == null ? [] : samples.filter((s) => s.t >= cut);
  return {
    version: CFG.VERSION,
    generatedAt: new Date().toISOString(),
    horizon: CFG.BT_HORIZON,
    barrierAtr: CFG.BT_BARRIER_ATR,
    minN: CFG.MIN_N_SHOW,
    cutoff: cut,
    nTrain: train.length,
    nOos: oos.length,
    ...meta,
    caveats: [
      "tanpa fee/slip/spread nyata; ini statistik arah, bukan hasil trading",
      "sampel berdekatan tumpang tindih (tidak independen)",
      "bobot belum dioptimalkan; angka oos hanya dari bagian waktu terakhir",
    ],
    train: buildGroups(train),
    oos: buildGroups(oos),
  };
}

/**
 * Cari statistik untuk tampilan. Hanya dari `oos` dan hanya bila N selesai >= minN. Urutan: kelompok persen (bin) dulu,
 * lalu seluruh timeframe.
 * @returns {{scope:"bin"|"tf", bin:string|null, ...summary}|null}
 */
function lookupMstrutStats(stats, { tf, pDir }, minN = CFG.MIN_N_SHOW) {
  if (!stats || !stats.oos || stats.version !== CFG.VERSION) return null;
  const bin = binOf(pDir);
  const keys = [bin && { k: `${tf}|bin:${bin}`, scope: "bin" }, { k: `${tf}|any`, scope: "tf" }].filter(Boolean);
  for (const { k, scope } of keys) {
    const g = stats.oos[k];
    if (g && g.nRes >= minN) return { ...g, scope, bin: scope === "bin" ? bin : null };
  }
  return null;
}

module.exports = { outcomeOf, runMstrutBacktest, wilson, summarize, buildGroups, cutoffTime, buildStatsFile, lookupMstrutStats };
