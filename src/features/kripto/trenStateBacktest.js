"use strict";

/**
 * features/kripto/trenStateBacktest.js
 * ------------------------------------------------------------------
 * Logika MURNI backtest !trenstate (fase 3 catatan desain): tanpa jaringan, tanpa file. I/O ada di
 * scripts/backtest-trenstate.js. Pola sama dengan hhllBacktest.js.
 *
 * Untuk tiap candle closed i (setelah BT_WARMUP) status dihitung dari jendela paling banyak BT_WINDOW candle yang
 * berakhir di i (sama dengan produksi), jadi tidak ada lookahead. Histeresis diterapkan pada deret status itu; satu
 * SAMPEL dibuat tiap kali status stabil berganti (bukan tiap candle), lalu diamati BT_HORIZON candle ke depan:
 *   LANJUT / PULLBACK / WASPADA / koreksi:
 *     continue : close melewati ujung leg (ekstrem) searah tren SEBELUM close melewati level batal (HL/LH)
 *     fail     : close melewati level batal lebih dulu (struktur patah)
 *     neither  : keduanya tidak terjadi dalam horizon
 *   REVERSAL TERKONFIRMASI (arah lawan tren asal):
 *     continue : harga bergerak >= BT_CONTINUE_ATR x ATR ke arah reversal SEBELUM close kembali melewati level batal
 *     fail     : close kembali melewati level batal lebih dulu (dicek lebih dulu dalam satu candle = konservatif)
 *     neither  : keduanya tidak terjadi
 *   RANGE tidak diberi hasil (tidak ada klaim arah).
 * Sampel yang horizon ke depannya belum penuh dibuang (tidak dihitung setengah).
 *
 * BATAS YANG HARUS DISEBUT DI LAPORAN (hasil cenderung terlalu optimistis, sama seperti hhllBacktest.js):
 *   - tanpa fee/slip/spread/gap nyata: ini statistik arah, bukan hasil trading;
 *   - sampel berdekatan memakai horizon yang tumpang tindih, jadi tidak sepenuhnya independen;
 *   - ambang yang disetel pada data yang sama dengan yang diukur akan tampak bagus (overfit): statistik yang ditampilkan
 *     bot hanya dari bagian waktu TERAKHIR (oos, 1 - TRAIN_FRAC) dan hanya bila N >= MIN_N_SHOW;
 *   - riwayat satu koin pendek untuk 4H/1D: gabungkan koin (statistik pooled per timeframe).
 */

const { TRENSTATE_CONFIG: CFG } = require("../../config/indicatorConfig");
const { assessRaw, STATUS } = require("./trenState");

const isNum = (v) => typeof v === "number" && isFinite(v);

/** Ringkas satu penilaian mentah jadi data yang dibutuhkan hasil (hemat memori). */
const light = (r) => ({ status: r.status, grade: r.grade, dir: r.dir, atr: r.atr, close: r.close, t: r.t, inval: r.levels.invalidation, extreme: r.levels.extreme });

/**
 * @param {{status:string, dir:"up"|"down"|null, atr:number, close:number, inval:number|null, extreme:number|null}} a
 * @param {{h:number,l:number,c:number}[]} future candle sesudah candle sampel (urut lama -> baru), panjang = horizon
 * @returns {"continue"|"fail"|"neither"|null} null = tidak ada klaim (range / data level kosong)
 */
function outcomeOf(a, future, { continueAtr = CFG.BT_CONTINUE_ATR } = {}) {
  if (!a.dir || !isNum(a.inval)) return null;
  const up = a.dir === "up";
  if (a.status === STATUS.REVERSAL) {
    for (const f of future) {
      if (up ? f.c > a.inval : f.c < a.inval) return "fail"; // kembali melewati level batal
      if (up ? f.l <= a.close - continueAtr * a.atr : f.h >= a.close + continueAtr * a.atr) return "continue";
    }
    return "neither";
  }
  if (!isNum(a.extreme)) return null;
  for (const f of future) {
    if (up ? f.c < a.inval : f.c > a.inval) return "fail";
    if (up ? f.c > a.extreme : f.c < a.extreme) return "continue";
  }
  return "neither";
}

/**
 * Backtest satu koin + satu timeframe.
 * @param {object[]} candles candle closed urut lama -> baru
 * @param {object[]|null} htfCandles candle closed TF besar (boleh null untuk 1D)
 * @param {{coin?:string, tf:string, horizon?:number, hystBars?:number}} opts
 * @returns {{coin:string, tf:string, t:number, status:string, grade:string|null, outcome:"continue"|"fail"|"neither"}[]}
 */
function runTrenStateBacktest(candles, htfCandles, opts) {
  const { tf, coin = "?", horizon = CFG.BT_HORIZON, hystBars = CFG.HYST_BARS } = opts;
  const n = candles ? candles.length : 0;
  const cache = new Map();
  const samples = [];
  let stable = null;
  let pend = null;
  let cnt = 0;
  for (let i = CFG.BT_WARMUP; i < n; i++) {
    const win = candles.slice(Math.max(0, i + 1 - CFG.BT_WINDOW), i + 1);
    const r = assessRaw(win, htfCandles, { tf, cache, trendline: false });
    if (!r) continue;
    const s = r.status;
    let changed = false;
    if (stable == null) stable = s;
    else if (s === stable) {
      pend = null;
      cnt = 0;
    } else {
      if (s === pend) cnt++;
      else {
        pend = s;
        cnt = 1;
      }
      if (cnt >= Math.max(1, hystBars)) {
        stable = pend;
        pend = null;
        cnt = 0;
        changed = true;
      }
    }
    if (!changed || stable === STATUS.RANGE) continue;
    if (i + horizon >= n) continue; // horizon ke depan belum penuh
    const a = light(r);
    const outcome = outcomeOf(a, candles.slice(i + 1, i + 1 + horizon));
    if (outcome) samples.push({ coin, tf, t: a.t, status: stable, grade: a.grade, outcome });
  }
  return samples;
}

// ---------- ringkasan ----------
function summarize(samples) {
  const n = samples.length;
  if (!n) return null;
  const c = (o) => samples.filter((s) => s.outcome === o).length;
  return { n, cont: (c("continue") / n) * 100, fail: (c("fail") / n) * 100, neither: (c("neither") / n) * 100 };
}

/** Kelompok: `${tf}|${status}|any` dan `${tf}|${status}|${grade}`. */
function buildGroups(samples) {
  const buckets = new Map();
  const add = (k, s) => (buckets.has(k) ? buckets.get(k).push(s) : buckets.set(k, [s]));
  for (const s of samples) {
    add(`${s.tf}|${s.status}|any`, s);
    if (s.grade) add(`${s.tf}|${s.status}|${s.grade}`, s);
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
 * Isi data/trenstate-stats.json. `oos` = hanya bagian waktu terakhir; itu yang dibaca !trenstate.
 * `all` ikut disimpan untuk laporan (perbandingan train vs oos menunjukkan seberapa goyah angkanya).
 */
function buildStatsFile(samples, meta = {}) {
  const cut = cutoffTime(samples);
  const train = cut == null ? [] : samples.filter((s) => s.t < cut);
  const oos = cut == null ? [] : samples.filter((s) => s.t >= cut);
  return {
    version: CFG.VERSION,
    generatedAt: new Date().toISOString(),
    horizon: CFG.BT_HORIZON,
    minN: CFG.MIN_N_SHOW,
    cutoff: cut,
    nTrain: train.length,
    nOos: oos.length,
    ...meta,
    caveats: [
      "tanpa fee/slip/spread nyata; ini statistik arah, bukan hasil trading",
      "sampel berdekatan tumpang tindih (tidak independen)",
      "ambang awal belum dioptimalkan; angka oos hanya dari bagian waktu terakhir",
    ],
    train: buildGroups(train),
    oos: buildGroups(oos),
  };
}

/**
 * Cari statistik untuk tampilan. Hanya dari `oos` dan hanya bila N >= minN; urutan: tf+status+grade, lalu tf+status.
 * @returns {{n:number, cont:number, fail:number, neither:number, scope:string}|null}
 */
function lookupTrenStats(stats, { tf, status, grade }, minN = CFG.MIN_N_SHOW) {
  if (!stats || !stats.oos || stats.version !== CFG.VERSION) return null;
  const keys = [grade && `${tf}|${status}|${grade}`, `${tf}|${status}|any`].filter(Boolean);
  for (const k of keys) {
    const g = stats.oos[k];
    if (g && g.n >= minN) return { ...g, scope: k.endsWith("|any") ? "status" : "grade" };
  }
  return null;
}

module.exports = { outcomeOf, runTrenStateBacktest, summarize, buildGroups, cutoffTime, buildStatsFile, lookupTrenStats };
