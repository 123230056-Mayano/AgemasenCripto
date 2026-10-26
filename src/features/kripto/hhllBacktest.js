"use strict";

/**
 * features/kripto/hhllBacktest.js
 * ------------------------------------------------------------------
 * Logika MURNI backtest HHLL (rencana HHLL fase 0 dan 4): tanpa jaringan, tanpa file. I/O ada di scripts/backtest-hhll.js.
 *
 * Untuk tiap candle closed i (setelah WARMUP) dijalankan detectEvents PERSIS seperti alarm produksi pada jendela
 * candle yang berakhir di i (paling banyak WINDOW candle), jadi tidak ada lookahead. Tiap kejadian dinilai hhllContext
 * (grade + fitur) lalu diamati HORIZON candle ke depan:
 *   lanjut  : MFE >= CONTINUE_ATR x ATR tercapai SEBELUM close kembali ke dalam level
 *   gagal   : close kembali ke dalam level dalam FAIL_BARS candle pertama
 *   lainnya : "neither" (kembali ke level setelah FAIL_BARS tanpa sempat lanjut, atau tidak ke mana-mana)
 *   MFE/MAE : gerak maksimum searah / berlawanan dari close X selama HORIZON candle, dalam kelipatan ATR (selalu positif)
 * Level "dalam/luar" untuk tahap konfirmasi = level swing yang ditembus; untuk tahap dini = swing baru (HL/LH) itu sendiri.
 *
 * Tambahan: simulasi trade sederhana (entry close X, SL = invalidasi, TP = target measured move, SL didahulukan bila satu
 * candle menyentuh keduanya) dalam satuan R, kotor dan bersih fee+slip.
 *
 * BATAS YANG HARUS DISEBUT DI LAPORAN (hasil cenderung terlalu optimistis; sama seperti suddenBacktest.js):
 *   - entry di close candle X tanpa slip nyata/spread/gap melewati SL (slip dan fee hanya asumsi tetap di HHLL_BACKTEST_CONFIG);
 *   - kejadian berdekatan memakai jendela ke depan yang tumpang tindih, jadi sampel tidak sepenuhnya independen;
 *   - ambang yang dilihat pada data yang sama dengan yang diukur akan tampak bagus (overfit): pakai pembagian waktu / walk-forward;
 *   - riwayat satu koin pendek untuk 4H/1D: gabungkan koin sejenis dan sembunyikan statistik bila N kecil.
 */

const { HHLL_BACKTEST_CONFIG: BT } = require("../../config/indicatorConfig");
const { detectEvents } = require("./hhllAlertCore");
const { assessEvent } = require("./hhllContext");

const isNum = (v) => typeof v === "number" && isFinite(v);

const MAJOR = new Set(["BTC", "ETH"]);
const LARGE = new Set(["BNB", "SOL", "XRP", "ADA", "DOGE", "AVAX", "TRX", "LINK", "DOT", "TON", "POL", "MATIC", "LTC", "BCH", "ATOM", "NEAR", "UNI", "ETC", "XLM", "FIL", "APT", "ARB", "OP", "SUI", "HBAR"]);
/** Kelompok koin untuk statistik gabungan: major (BTC/ETH), large (large cap), alt (sisanya). */
const coinGroup = (coin) => (MAJOR.has(coin) ? "major" : LARGE.has(coin) ? "large" : "alt");

const median = (arr) => {
  const a = arr.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mean = (arr) => {
  const a = arr.filter(isNum);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
};

// =====================================================================
// 1. Hasil satu kejadian
// =====================================================================
/**
 * @param {{dir:"up"|"down", level:number}} ev
 * @param {number} base close candle X
 * @param {{h:number,l:number,c:number}[]} future candle sesudah X (urut lama -> baru)
 * @returns {{outcome:"continue"|"fail"|"neither", mfe:number, mae:number, bars:number|null}}
 */
function outcomeOf(ev, base, future, atr, { failBars = BT.FAIL_BARS, continueAtr = BT.CONTINUE_ATR } = {}) {
  const up = ev.dir === "up";
  const inside = (c) => (up ? c.c <= ev.level : c.c >= ev.level);
  let mfe = 0;
  let mae = 0;
  let outcome = null;
  let bars = null;
  future.forEach((c, k) => {
    const fav = (up ? c.h - base : base - c.l) / atr;
    const adv = (up ? base - c.l : c.h - base) / atr;
    if (outcome == null) {
      // close kembali ke dalam level didahulukan (konservatif bila satu candle juga menyentuh MFE)
      if (inside(c)) {
        outcome = k < failBars ? "fail" : "neither";
        bars = k + 1;
      } else if (Math.max(mfe, fav) >= continueAtr) {
        outcome = "continue";
        bars = k + 1;
      }
    }
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);
  });
  return { outcome: outcome || "neither", mfe, mae, bars };
}

/**
 * Simulasi trade: entry = close X, SL = invalidasi, TP = target. R bersih dikurangi fee+slip (dua sisi) dalam R.
 * @returns {{r:number, rNet:number, result:"TP"|"SL"|"TIMEOUT"}|null} null kalau SL/TP tidak valid
 */
function simulateTrade(dir, entry, sl, tp, future, { feePct = BT.FEE_PCT, slipPct = BT.SLIP_PCT } = {}) {
  const s = dir === "up" ? 1 : -1;
  const risk = Math.abs(entry - sl);
  if (![entry, sl, tp].every(isNum) || !(risk > 0) || !future.length) return null;
  if ((entry - sl) * s <= 0 || (tp - entry) * s <= 0) return null;
  const rr = Math.abs(tp - entry) / risk;
  const cost = (((feePct + slipPct) * 2) / 100) * entry / risk;
  let r = null;
  let result = "TIMEOUT";
  for (const c of future) {
    if (s === 1 ? c.l <= sl : c.h >= sl) {
      r = -1;
      result = "SL";
      break;
    }
    if (s === 1 ? c.h >= tp : c.l <= tp) {
      r = rr;
      result = "TP";
      break;
    }
  }
  if (r == null) r = ((future[future.length - 1].c - entry) * s) / risk;
  return { r, rNet: r - cost, result };
}

// =====================================================================
// 2. Backtest satu deret candle
// =====================================================================
/**
 * @param {object[]} candles closed urut lama -> baru {t,o,h,l,c,v}
 * @param {{coin?:string, tf:string, htf?:object[]|null, horizon?:number, warmup?:number, window?:number,
 *          from?:number, to?:number, stages?:string[]}} opts
 *   htf = candle TF besar (urut lama -> baru) untuk fitur searah; tanpa itu align = null.
 * @returns {object[]} sampel
 */
function runHhllBacktest(candles, opts = {}) {
  const { tf, coin = "?", htf = null, horizon = BT.HORIZON, warmup = BT.WARMUP, window = BT.WINDOW } = opts;
  const stages = opts.stages || ["early", "confirm"];
  const n = candles.length;
  const out = [];
  if (!tf || n < warmup + horizon + 2) return out;
  const from = Math.max(warmup, opts.from ?? warmup);
  const to = Math.min(n - horizon - 1, opts.to ?? n - horizon - 1);
  const cache = new Map();

  for (let i = from; i <= to; i++) {
    const closed = candles.slice(Math.max(0, i - window + 1), i + 1);
    const evs = detectEvents(closed).filter((e) => stages.includes(e.stage));
    if (!evs.length) continue;
    const future = candles.slice(i + 1, i + 1 + horizon);
    for (const ev of evs) {
      const ctx = assessEvent(closed, ev, htf, { tf, cache });
      if (!ctx) continue;
      const atr = ctx.atr;
      const res = outcomeOf(ev, candles[i].c, future, atr);
      const trade = isNum(ctx.invalidation) && isNum(ctx.target) ? simulateTrade(ev.dir, candles[i].c, ctx.invalidation, ctx.target, future) : null;
      const f = ctx.features;
      out.push({
        coin,
        tf,
        i,
        t: candles[i].t,
        stage: ev.stage,
        dir: ev.dir,
        flip: !!ev.flip,
        level: ev.level,
        grade: ctx.grade,
        align: f.align,
        volOk: f.volume.ok,
        volRatio: f.volume.ratio,
        closeOk: f.close.ok,
        legOk: f.leg.ok,
        pbOk: f.pullback.ok,
        rr: ctx.rr,
        outcome: res.outcome,
        mfe: res.mfe,
        mae: res.mae,
        bars: res.bars,
        r: trade ? trade.r : null,
        rNet: trade ? trade.rNet : null,
        tradeResult: trade ? trade.result : null,
      });
    }
  }
  return out;
}

/**
 * KONTROL (pembanding "tanpa pola"): tiap candle yang close-nya naik dari close sebelumnya dianggap "tembusan naik" dengan
 * level = close sebelumnya (turun: simetris), lalu diukur dengan aturan hasil yang SAMA. Definisi "lanjut" (MFE >= 1 ATR dalam
 * horizon) mudah dicapai noise, jadi angka kejadian HHLL baru bermakna kalau lebih baik dari kontrol ini pada TF dan periode yang sama.
 * @returns {object[]} sampel dengan stage "control" (field sama seperti runHhllBacktest, tanpa grade/fitur)
 */
function runControl(candles, opts = {}) {
  const { tf, coin = "?", horizon = BT.HORIZON, warmup = BT.WARMUP } = opts;
  const n = candles.length;
  const out = [];
  if (!tf || n < warmup + horizon + 2) return out;
  const atrAll = require("./indicators").atr(candles);
  const from = Math.max(warmup, opts.from ?? warmup);
  const to = Math.min(n - horizon - 1, opts.to ?? n - horizon - 1);
  for (let i = from; i <= to; i++) {
    const atr = atrAll[i];
    if (!isNum(atr) || !(atr > 0)) continue;
    const c = candles[i];
    const prev = candles[i - 1];
    if (c.c === prev.c) continue;
    const ev = { dir: c.c > prev.c ? "up" : "down", level: prev.c };
    const res = outcomeOf(ev, c.c, candles.slice(i + 1, i + 1 + horizon), atr);
    out.push({ coin, tf, i, t: c.t, stage: "control", dir: ev.dir, flip: false, grade: null, outcome: res.outcome, mfe: res.mfe, mae: res.mae, bars: res.bars, r: null, rNet: null });
  }
  return out;
}

// =====================================================================
// 3. Ringkasan
// =====================================================================
/** Ringkasan satu kelompok sampel. Persentase dalam 0-100; null bila kelompok kosong. */
function summarize(samples) {
  const n = samples.length;
  if (!n) return { n: 0, contPct: null, failPct: null, neitherPct: null, medMfe: null, medMae: null, avgR: null, avgRNet: null, nTrades: 0 };
  const pct = (o) => (samples.filter((x) => x.outcome === o).length / n) * 100;
  const trades = samples.filter((x) => isNum(x.rNet));
  return {
    n,
    contPct: pct("continue"),
    failPct: pct("fail"),
    neitherPct: pct("neither"),
    medMfe: median(samples.map((x) => x.mfe)),
    medMae: median(samples.map((x) => x.mae)),
    avgR: mean(trades.map((x) => x.r)),
    avgRNet: mean(trades.map((x) => x.rNet)),
    nTrades: trades.length,
  };
}

const flipKey = (s) => (s.flip ? "flip" : "cont");

/**
 * Ringkasan per kelompok untuk laporan: TF x tahap x flip/lanjutan x kelompok koin (+ per koin).
 * @returns {Object<string, object>} kunci "scope|tf|stage|flip|grade" (grade "any" = semua grade)
 */
function buildGroups(samples) {
  const buckets = new Map();
  const add = (key, s) => {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  };
  for (const s of samples) {
    const scopes = [`coin:${s.coin}`, `grp:${coinGroup(s.coin)}`, "all"];
    for (const sc of scopes) {
      const base = `${sc}|${s.tf}|${s.stage}|${flipKey(s)}`;
      add(`${base}|any`, s);
      if (s.grade) add(`${base}|${s.grade}`, s);
    }
  }
  const out = {};
  for (const [k, arr] of buckets) out[k] = summarize(arr);
  return out;
}

/**
 * Berkas statistik untuk !hhll (data/hhll-stats.json). Hanya field yang dipakai tampilan.
 */
function buildStatsFile(samples, meta = {}) {
  const groups = {};
  for (const [k, v] of Object.entries(buildGroups(samples))) {
    groups[k] = {
      n: v.n,
      cont: round(v.contPct, 1),
      fail: round(v.failPct, 1),
      mfe: round(v.medMfe, 2),
      mae: round(v.medMae, 2),
    };
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    params: { horizon: BT.HORIZON, failBars: BT.FAIL_BARS, continueAtr: BT.CONTINUE_ATR, ...meta },
    note: "Estimasi dari backtest sendiri; bukan jaminan hasil. Simulasi optimistis (lihat hhllBacktest.js).",
    groups,
  };
}
const round = (v, d) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/**
 * Cari statistik terbaik untuk satu kejadian: per koin, lalu kelompok koin, lalu semua koin; hanya yang N >= minN.
 * Grade dicocokkan kalau diketahui (supaya "kejadian serupa" memang serupa), selain itu semua grade.
 * @returns {{scope:"coin"|"major"|"large"|"alt"|"all", n:number, cont:number, fail:number, mfe:number}|null}
 */
function lookupStats(stats, { coin, tf, stage, flip, grade }, minN = BT.MIN_N_SHOW) {
  if (!stats || !stats.groups) return null;
  const g = grade || "any";
  const tail = `${tf}|${stage}|${flip ? "flip" : "cont"}|${g}`;
  const tries = [
    ["coin", `coin:${coin}|${tail}`],
    [coinGroup(coin), `grp:${coinGroup(coin)}|${tail}`],
    ["all", `all|${tail}`],
  ];
  for (const [scope, key] of tries) {
    const v = stats.groups[key];
    if (v && v.n >= minN && isNum(v.cont) && isNum(v.fail)) return { scope, n: v.n, cont: v.cont, fail: v.fail, mfe: v.mfe };
  }
  return null;
}

// =====================================================================
// 4. Validasi filter (fase 4): pembagian waktu + walk-forward
// =====================================================================
/** Waktu pemisah: kuantil `frac` dari waktu semua sampel (adil untuk koin dengan panjang riwayat berbeda). */
function cutoffTime(samples, frac = BT.TRAIN_FRAC) {
  if (!samples.length) return null;
  const ts = samples.map((s) => s.t).sort((a, b) => a - b);
  return ts[Math.min(ts.length - 1, Math.floor(ts.length * frac))];
}
const splitByTime = (samples, frac = BT.TRAIN_FRAC) => {
  const cut = cutoffTime(samples, frac);
  return { cut, train: samples.filter((s) => s.t < cut), test: samples.filter((s) => s.t >= cut) };
};
/** Potong jadi `k` bagian waktu berurutan dengan jumlah sampel hampir sama. */
function timeFolds(samples, k = BT.FOLDS) {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const size = Math.ceil(sorted.length / k) || 1;
  return Array.from({ length: k }, (_, f) => sorted.slice(f * size, (f + 1) * size));
}

/** Filter yang diuji pada sampel konfirmasi. */
const FILTERS = {
  align: (s) => s.align === "with",
  volume: (s) => s.volOk === true,
  close: (s) => s.closeOk === true,
  leg: (s) => s.legOk === true,
  pullback: (s) => s.pbOk === true,
  strong: (s) => s.grade === "strong",
};

const delta = (pass, all) => (pass.n && all.n && isNum(pass.contPct) && isNum(all.contPct) ? pass.contPct - all.contPct : null);

/**
 * Putuskan tiap filter PER TF (bukan satu angka global). Aturan (HHLL_BACKTEST_CONFIG):
 *   keep         : N lolos di periode ukur >= MIN_N_FILTER, tingkat lanjut naik >= MIN_GAIN_PP poin di periode ukur,
 *                  naik juga di periode stel, jumlah sinyal tersisa >= MIN_KEEP_RATIO, dan naik di mayoritas potongan walk-forward
 *   insufficient : N lolos di periode ukur < MIN_N_FILTER (belum bisa diputuskan)
 *   drop         : selain itu
 * @param {object[]} samples sampel dari runHhllBacktest (semua koin/TF; difilter di sini ke tahap konfirmasi)
 * @returns {object[]} baris { tf, filter, train, test, deltaTrain, deltaTest, keepRatio, folds:(number|null)[], decision, reason }
 */
function evaluateFilters(samples, cfg = BT, stage = "confirm") {
  const rows = [];
  const tfs = [...new Set(samples.map((s) => s.tf))];
  for (const tf of tfs) {
    const all = samples.filter((s) => s.tf === tf && s.stage === stage);
    if (!all.length) continue;
    const { train, test } = splitByTime(all, cfg.TRAIN_FRAC);
    const folds = timeFolds(all, cfg.FOLDS);
    for (const [name, pred] of Object.entries(FILTERS)) {
      const trainPass = summarize(train.filter(pred));
      const testPass = summarize(test.filter(pred));
      const trainAll = summarize(train);
      const testAll = summarize(test);
      const dTrain = delta(trainPass, trainAll);
      const dTest = delta(testPass, testAll);
      const keepRatio = testAll.n ? testPass.n / testAll.n : 0;
      const foldDeltas = folds.map((f) => (f.filter(pred).length >= 30 && f.length >= 30 ? delta(summarize(f.filter(pred)), summarize(f)) : null));
      const known = foldDeltas.filter((d) => d != null);
      const foldsPositive = known.length > 0 && known.filter((d) => d > 0).length > known.length / 2;
      let decision;
      let reason;
      if (testPass.n < cfg.MIN_N_FILTER) {
        decision = "insufficient";
        reason = `N lolos periode ukur ${testPass.n} < ${cfg.MIN_N_FILTER}`;
      } else if (dTest == null || dTest < cfg.MIN_GAIN_PP) {
        decision = "drop";
        reason = `kenaikan tingkat lanjut di periode ukur ${dTest == null ? "-" : dTest.toFixed(1)} poin < ${cfg.MIN_GAIN_PP}`;
      } else if (dTrain == null || dTrain <= 0) {
        decision = "drop";
        reason = "tidak naik di periode stel (tidak konsisten)";
      } else if (keepRatio < cfg.MIN_KEEP_RATIO) {
        decision = "drop";
        reason = `sinyal tersisa ${(keepRatio * 100).toFixed(0)}% < ${(cfg.MIN_KEEP_RATIO * 100).toFixed(0)}%`;
      } else if (!foldsPositive) {
        decision = "drop";
        reason = "tidak naik di mayoritas potongan walk-forward";
      } else {
        decision = "keep";
        reason = "naik konsisten, sampel cukup";
      }
      rows.push({ tf, filter: name, train: trainPass, test: testPass, base: { train: trainAll, test: testAll }, deltaTrain: dTrain, deltaTest: dTest, keepRatio, folds: foldDeltas, decision, reason });
    }
  }
  return rows;
}

/** Tingkat lanjut per grade (periksa apakah Kuat > Sedang > Lemah), per TF, tahap konfirmasi. */
function gradeTable(samples, stage = "confirm") {
  const out = {};
  for (const tf of [...new Set(samples.map((s) => s.tf))]) {
    out[tf] = {};
    for (const g of ["strong", "medium", "weak"]) out[tf][g] = summarize(samples.filter((s) => s.tf === tf && s.stage === stage && s.grade === g));
  }
  return out;
}

module.exports = {
  BT,
  coinGroup,
  outcomeOf,
  simulateTrade,
  runHhllBacktest,
  runControl,
  summarize,
  buildGroups,
  buildStatsFile,
  lookupStats,
  cutoffTime,
  splitByTime,
  timeFolds,
  FILTERS,
  evaluateFilters,
  gradeTable,
};
