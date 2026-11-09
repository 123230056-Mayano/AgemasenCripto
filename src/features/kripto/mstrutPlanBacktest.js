"use strict";

/**
 * features/kripto/mstrutPlanBacktest.js
 * ------------------------------------------------------------------
 * Logika MURNI backtest SKENARIO !mstrut (Entry Zone, Stop Loss, TP1 / TP2 dari buildPlan): tanpa jaringan,
 * tanpa file. I/O ada di scripts/backtest-mstrut-plan.js. Pola sama dengan mstrutBacktest.js.
 *
 * Pertanyaan yang dijawab: "kalau skenario !mstrut diikuti apa adanya, hasilnya untung atau rugi?"
 *
 * Tiap candle closed i (setelah BT_WARMUP, tiap `step` candle) skenario dibuat dari jendela paling banyak BT_WINDOW
 * candle yang berakhir di i (sama dengan produksi), lewat analyzeStructure + buildPlan. TIDAK ADA lookahead.
 * Hasil WAIT dihitung sebagai "tidak ada trade" (dan dilaporkan, bukan disembunyikan).
 *
 * SIMULASI (konservatif, supaya tidak terlalu optimistis):
 *   Entry   : limit di tengah Entry Zone. Harus tersentuh dalam `fillBars` candle (default = horizon skenario, 24 jam).
 *             Tidak tersentuh = tidak ada trade (dicatat sebagai "tidak terisi").
 *   Di candle terisi: hanya SL yang diperiksa (kalau SL juga tersentuh di candle itu -> dianggap kena SL).
 *   Keluar  : SL / TP1 / TP2 diperiksa tiap candle. Kalau SL dan TP tersentuh di candle yang SAMA -> dianggap SL dulu.
 *   Posisi  : `tp1Share` (default 50%) ditutup di TP1, sisanya ke TP2. Setelah TP1, SL digeser ke entry (break-even)
 *             bila `beAfterTp1` (default true).
 *   Batas   : posisi yang belum selesai setelah `holdBars` candle sejak terisi ditutup di close candle terakhir (timeout).
 *   Biaya   : (fee + slippage) x 2 sisi, dalam bps dari harga entry, diubah ke satuan R dan dikurangkan.
 *   Tumpang : bila `nonOverlap` (default true), satu koin+timeframe hanya punya satu skenario aktif; sampel berikutnya
 *             menunggu skenario sebelumnya selesai / kedaluwarsa. Jadi N tidak digelembungkan oleh trade yang tumpang tindih.
 *
 * PEMBANDING (dihitung di sampel yang sama, memakai jarak SL / TP1 / TP2 yang SAMA dengan skenario):
 *   random : masuk di close, arah diacak (seed tetap, bisa diulang). Jawab: "apakah arah + tempat zona dari struktur
 *            lebih baik daripada lempar koin dengan R:R yang sama?"
 *   market : masuk di close, arah sama dengan skenario. Jawab: "apakah menunggu retrace ke zona lebih baik daripada
 *            langsung masuk?"
 *
 * BATAS YANG HARUS DISEBUT DI LAPORAN:
 *   - sejarah saja, bukan jaminan; candle OHLC tidak memberi urutan harga di dalam satu candle (aturan konservatif di atas);
 *   - fee / slippage hanya perkiraan (bps), slippage nyata di kondisi sepi / volatil bisa lebih besar;
 *   - bobot / aturan buildPlan belum dioptimalkan; angka oos hanya dari bagian waktu terakhir (walk-forward 60 / 40);
 *   - riwayat pendek untuk 4H / 1D: gabungkan koin (statistik pooled per timeframe);
 *   - max drawdown dihitung dari urutan waktu sinyal dengan risiko tetap 1R per trade (bukan ukuran posisi nyata).
 */

const { MSTRUT_PROB_CONFIG: CFG } = require("../../config/indicatorConfig");
const { analyzeStructure } = require("./mstrutCore");
const { buildPlan, TF_MINUTES } = require("./mstrutPlan");
const { wilson } = require("./mstrutBacktest");

const isNum = (v) => typeof v === "number" && isFinite(v);

const PLAN_BT_DEFAULTS = Object.freeze({
  horizonHours: 24,
  fillBars: null, // null = horizon skenario (jam -> candle)
  holdBars: null, // null = sama dengan fillBars
  tp1Share: 0.5,
  beAfterTp1: true,
  feeBps: 10, // per sisi (spot taker Binance ~10 bps)
  slipBps: 5, // per sisi
  nonOverlap: true,
  seed: 12345,
});

/** RNG kecil dengan seed (hasil bisa diulang). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulasikan SATU trade pada candle sesudah sampel.
 * @param {{dir:"long"|"short", entry:number, sl:number, tp1:number, tp2:number, mode?:"limit"|"market"}} t
 * @param {{h:number,l:number,c:number}[]} future candle sesudah sampel (lama -> baru)
 * @param {{fillBars:number, holdBars:number, tp1Share?:number, beAfterTp1?:boolean, costBps?:number}} o
 *        costBps = biaya PULANG-PERGI total (bps dari harga entry)
 * @returns {null|{filled:false, exitIdx:number}|{filled:true, fillIdx:number, exitIdx:number, exit:string, tp1Hit:boolean,
 *          grossR:number, costR:number, netR:number, bars:number}} null kalau input tidak valid
 */
function simulateTrade(t, future, o) {
  const { dir, entry, sl, tp1, tp2, mode = "limit" } = t;
  if (!(dir === "long" || dir === "short") || ![entry, sl, tp1, tp2].every(isNum)) return null;
  const s = dir === "long" ? 1 : -1;
  const risk = s * (entry - sl);
  if (!(risk > 0)) return null;
  if (!(s * (tp1 - entry) > 0) || !(s * (tp2 - entry) > 0)) return null;
  const { fillBars, holdBars, tp1Share = 0.5, beAfterTp1 = true, costBps = 0 } = o;
  const costR = ((costBps / 1e4) * entry) / risk;

  let fillIdx = -1; // market: terisi di close sampel (sebelum candle pertama)
  if (mode === "limit") {
    fillIdx = -1;
    for (let j = 0; j < Math.min(fillBars, future.length); j++) {
      const c = future[j];
      if (s === 1 ? c.l <= entry : c.h >= entry) {
        fillIdx = j;
        break;
      }
    }
    if (fillIdx < 0) return { filled: false, exitIdx: Math.min(fillBars, future.length) - 1 };
    // Di candle terisi hanya SL yang diperiksa (urutan di dalam candle tidak diketahui -> konservatif).
    const c = future[fillIdx];
    if (s === 1 ? c.l <= sl : c.h >= sl) {
      const grossR = -1;
      return { filled: true, fillIdx, exitIdx: fillIdx, exit: "sl", tp1Hit: false, grossR, costR, netR: grossR - costR, bars: 1 };
    }
  }

  const start = fillIdx + 1;
  const end = Math.min(future.length, start + holdBars);
  let remaining = 1;
  let realized = 0;
  let stop = sl;
  let tp1Hit = false;
  let exit = null;
  let exitIdx = end - 1;
  for (let k = start; k < end; k++) {
    const c = future[k];
    const hitSL = s === 1 ? c.l <= stop : c.h >= stop;
    if (hitSL) {
      realized += (remaining * s * (stop - entry)) / risk;
      remaining = 0;
      exit = tp1Hit ? (stop === entry ? "tp1_be" : "tp1_sl") : "sl";
      exitIdx = k;
      break;
    }
    if (!tp1Hit && (s === 1 ? c.h >= tp1 : c.l <= tp1)) {
      const share = Math.min(1, Math.max(0, tp1Share));
      realized += (share * s * (tp1 - entry)) / risk;
      remaining -= share;
      tp1Hit = true;
      if (beAfterTp1) stop = entry;
      if (remaining <= 1e-12) {
        remaining = 0;
        exit = "tp1";
        exitIdx = k;
        break;
      }
    }
    if (tp1Hit && (s === 1 ? c.h >= tp2 : c.l <= tp2)) {
      realized += (remaining * s * (tp2 - entry)) / risk;
      remaining = 0;
      exit = "tp2";
      exitIdx = k;
      break;
    }
  }
  if (remaining > 0) {
    const last = future[end - 1];
    if (last) realized += (remaining * s * (last.c - entry)) / risk;
    exit = "timeout";
    exitIdx = end - 1;
  }
  return { filled: true, fillIdx, exitIdx, exit, tp1Hit, grossR: realized, costR, netR: realized - costR, bars: exitIdx - fillIdx };
}

/** Pembanding: masuk di close dengan jarak SL / TP1 / TP2 yang sama dengan skenario. */
function baselineTrade(price, dir, dSl, d1, d2, future, o) {
  const s = dir === "long" ? 1 : -1;
  return simulateTrade({ dir, entry: price, sl: price - s * dSl, tp1: price + s * d1, tp2: price + s * d2, mode: "market" }, future, o);
}

/**
 * Backtest satu koin + satu timeframe.
 * @param {object[]} candles candle closed urut lama -> baru
 * @param {{coin?:string, tf:string, step?:number} & Partial<typeof PLAN_BT_DEFAULTS>} opts
 * @returns {object[]} sampel; kind "wait" (tanpa skenario) atau "plan" (ada skenario; filled true/false)
 */
function runPlanBacktest(candles, opts = {}) {
  const { tf, coin = "?", step = CFG.BT_STEP } = opts;
  const P = { ...PLAN_BT_DEFAULTS, ...opts };
  const mins = TF_MINUTES[tf] || 60;
  const fillBars = P.fillBars || Math.max(1, Math.round((P.horizonHours * 60) / mins));
  const holdBars = P.holdBars || fillBars;
  const costBps = 2 * (P.feeBps + P.slipBps);
  const simOpts = { fillBars, holdBars, tp1Share: P.tp1Share, beAfterTp1: P.beAfterTp1, costBps };
  const rng = mulberry32(P.seed);
  const n = candles ? candles.length : 0;
  const samples = [];
  let busyUntil = -1;
  for (let i = CFG.BT_WARMUP; i < n; i += Math.max(1, step)) {
    if (i + 1 + fillBars + holdBars > n) break; // masa depan belum penuh: buang
    if (P.nonOverlap && i <= busyUntil) continue;
    const win = candles.slice(Math.max(0, i + 1 - CFG.BT_WINDOW), i + 1);
    const res = analyzeStructure(win);
    if (!res) continue;
    const plan = buildPlan(res, win, { tf, price: candles[i].c, horizonHours: P.horizonHours });
    if (!plan) continue;
    if (plan.dir === "wait") {
      samples.push({ coin, tf, t: candles[i].t, kind: "wait", reason: plan.reason });
      continue;
    }
    const future = candles.slice(i + 1, i + 1 + fillBars + holdBars);
    const entry = plan.entry.mid;
    const trade = { dir: plan.dir, entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2, mode: "limit" };
    const sim = simulateTrade(trade, future, simOpts);
    if (!sim) continue;
    // pembanding di sampel yang sama
    const dSl = Math.abs(plan.sl - entry);
    const d1 = Math.abs(plan.tp1 - entry);
    const d2 = Math.abs(plan.tp2 - entry);
    const price = candles[i].c;
    const rndDir = rng() < 0.5 ? "long" : "short";
    const rnd = baselineTrade(price, rndDir, dSl, d1, d2, future, simOpts);
    const mkt = baselineTrade(price, plan.dir, dSl, d1, d2, future, simOpts);
    busyUntil = i + 1 + sim.exitIdx;
    samples.push({
      coin,
      tf,
      t: candles[i].t,
      kind: "plan",
      dir: plan.dir,
      grade: plan.grade,
      state: plan.state,
      rr1: plan.rr1,
      rr2: plan.rr2,
      riskPct: (Math.abs(plan.sl - entry) / entry) * 100,
      filled: sim.filled,
      exit: sim.filled ? sim.exit : "no_fill",
      tp1Hit: sim.filled ? sim.tp1Hit : false,
      bars: sim.filled ? sim.bars : 0,
      grossR: sim.filled ? sim.grossR : 0,
      netR: sim.filled ? sim.netR : 0,
      rndNetR: rnd ? rnd.netR : null,
      mktNetR: mkt ? mkt.netR : null,
    });
  }
  return samples;
}

// ---------- statistik ----------
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}

/** Max drawdown (dalam R) dari urutan netR menurut waktu. */
function maxDrawdown(rs) {
  let peak = 0;
  let eq = 0;
  let dd = 0;
  for (const r of rs) {
    eq += r;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  }
  return dd;
}

/**
 * Ringkas satu kelompok sampel.
 * @returns {null|object}
 */
function summarizePlans(samples, cfg = CFG) {
  const total = samples.length;
  if (!total) return null;
  const waits = samples.filter((s) => s.kind === "wait");
  const plans = samples.filter((s) => s.kind === "plan");
  const trades = plans.filter((s) => s.filled).sort((a, b) => a.t - b.t);
  const nT = trades.length;
  const rs = trades.map((s) => s.netR);
  const wins = trades.filter((s) => s.netR > 0).length;
  const { lo: wLo, hi: wHi } = wilson(wins, nT);
  const m = mean(rs);
  const sd = stdev(rs);
  const se = sd != null && nT ? sd / Math.sqrt(nT) : null;
  const ciLo = m != null && se != null ? m - 1.96 * se : null;
  const ciHi = m != null && se != null ? m + 1.96 * se : null;
  const gp = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const gl = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  const exits = {};
  for (const s of plans) exits[s.exit] = (exits[s.exit] || 0) + 1;
  const rndR = plans.map((s) => s.rndNetR).filter(isNum);
  const mktR = plans.map((s) => s.mktNetR).filter(isNum);
  const waitReasons = {};
  for (const s of waits) waitReasons[s.reason] = (waitReasons[s.reason] || 0) + 1;
  const expectancy = m;
  const rndMean = mean(rndR);
  const mktMean = mean(mktR);
  let verdict = "insufficient";
  if (nT >= cfg.MIN_N_SHOW) {
    verdict = ciLo > 0 && rndMean != null && expectancy > rndMean ? "edge" : "no_edge";
  }
  return {
    nSamples: total,
    nWait: waits.length,
    waitRate: (waits.length / total) * 100,
    waitReasons,
    nPlans: plans.length,
    nTrades: nT,
    fillRate: plans.length ? (nT / plans.length) * 100 : null,
    winRate: nT ? (wins / nT) * 100 : null,
    winCiLo: wLo,
    winCiHi: wHi,
    avgWinR: mean(rs.filter((r) => r > 0)),
    avgLossR: mean(rs.filter((r) => r <= 0)),
    expectancyR: expectancy,
    expCiLo: ciLo,
    expCiHi: ciHi,
    expPerSignalR: plans.length ? rs.reduce((a, b) => a + b, 0) / plans.length : null, // tak terisi = 0R
    totalR: rs.reduce((a, b) => a + b, 0),
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : null,
    maxDrawdownR: maxDrawdown(rs),
    tp1HitRate: nT ? (trades.filter((s) => s.tp1Hit).length / nT) * 100 : null,
    avgBars: mean(trades.map((s) => s.bars)),
    avgRR1: mean(plans.map((s) => s.rr1).filter(isNum)),
    exits,
    baseline: { randomR: rndMean, marketR: mktMean, nBaseline: rndR.length },
    verdict,
  };
}

/** Kelompok: `${tf}|any`, `${tf}|long`, `${tf}|short`, `${coin}|${tf}`. */
function buildPlanGroups(samples) {
  const buckets = new Map();
  const add = (k, s) => (buckets.has(k) ? buckets.get(k).push(s) : buckets.set(k, [s]));
  for (const s of samples) {
    add(`${s.tf}|any`, s);
    add(`${s.coin}|${s.tf}`, s);
    if (s.kind === "plan") add(`${s.tf}|${s.dir}`, s);
  }
  const out = {};
  for (const [k, arr] of buckets) out[k] = summarizePlans(arr);
  return out;
}

/** Waktu pemisah train / oos (sama dengan mstrutBacktest). */
function cutoffTime(samples, frac = CFG.TRAIN_FRAC) {
  if (!samples.length) return null;
  const ts = samples.map((s) => s.t).sort((a, b) => a - b);
  return ts[Math.min(ts.length - 1, Math.floor(ts.length * frac))];
}

/** Isi data/mstrut-plan-stats.json (file TERPISAH dari data/mstrut-stats.json yang dibaca !mstrut). */
function buildPlanStatsFile(samples, meta = {}, params = {}) {
  const cut = cutoffTime(samples);
  const train = cut == null ? [] : samples.filter((s) => s.t < cut);
  const oos = cut == null ? [] : samples.filter((s) => s.t >= cut);
  return {
    generatedAt: new Date().toISOString(),
    minN: CFG.MIN_N_SHOW,
    cutoff: cut,
    nTrain: train.length,
    nOos: oos.length,
    params,
    ...meta,
    caveats: [
      "backtest sejarah, bukan jaminan hasil",
      "fee + slippage hanya perkiraan (bps); urutan harga di dalam satu candle tidak diketahui (aturan konservatif: SL dulu)",
      "aturan skenario belum dioptimalkan; angka oos hanya dari bagian waktu terakhir (walk-forward)",
      "max drawdown dengan risiko tetap 1R per trade, bukan ukuran posisi nyata",
    ],
    train: buildPlanGroups(train),
    oos: buildPlanGroups(oos),
  };
}

module.exports = { PLAN_BT_DEFAULTS, mulberry32, simulateTrade, baselineTrade, runPlanBacktest, summarizePlans, buildPlanGroups, buildPlanStatsFile, cutoffTime, maxDrawdown };
