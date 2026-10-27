"use strict";

/**
 * features/kripto/trenState.js
 * ------------------------------------------------------------------
 * Logika MURNI !trenstate (catatan desain "!trenstate"): tanpa fetch, tanpa kirim pesan, tanpa canvas, jadi bisa diuji
 * unit (src/test/trenState.test.js). Menjawab satu pertanyaan per koin + timeframe: harga sedang LANJUT tren,
 * PULLBACK SEHAT, WASPADA REVERSAL, REVERSAL TERKONFIRMASI, atau RANGE. Hasilnya label bersyarat + alasan + level batal,
 * bukan ramalan.
 *
 * Tidak ada rumus baru: modul ini hanya menggabungkan hhllCore (struktur), hhllContext (TF besar, retraceDepth),
 * divergence, suddenMove (sweep / wick reject), dan indicators (EMA, ATR).
 *
 * Alur (berurutan):
 *   1. Tren asal   : computeStructure(closed).trend. "range" -> status RANGE. null -> data belum cukup (null).
 *   2. Fase        : kedalaman retrace leg terakhir (retraceDepth).
 *                    - close melewati swing HL/LH terakhir (struktur patah)  -> REVERSAL TERKONFIRMASI (aturan keras, tanpa skor)
 *                    - HH/LL baru (close melewati ujung leg lama) atau retrace < CONTINUE_DEPTH -> LANJUT
 *                    - selain itu -> fase koreksi
 *   3. Skor bukti  : 13 fitur dua sisi (lanjut vs reversal), tiap fitur ya / tidak / null (null tidak dihitung).
 *   4. Putusan     : selisih skor >= VERDICT_GAP = PULLBACK SEHAT atau WASPADA REVERSAL; selisih tipis = "koreksi, belum jelas"
 *                    (status internal `correction`, bukan salah satu dari lima status; ditampilkan apa adanya).
 *   5. Histeresis  : status baru dianggap berubah setelah bertahan HYST_BARS candle closed berturut-turut. Diputar ulang
 *                    dari HYST_WINDOW candle terakhir (fungsi murni, tanpa state), jadi hasil sama untuk input sama.
 *   6. Trendline   : alat bantu baca (trenStateTrendline.js), dihitung untuk semua status termasuk RANGE. TIDAK ikut skor /
 *                    status, jadi statistik backtest tidak berubah. opts.trendline:false = lewati (backtest, replay histeresis).
 *
 * Aturan: hanya candle CLOSED, tanpa lookahead. Candle TF besar hanya yang sudah tutup saat candle terakhir closed
 * (htfClosedAt). Semua ambang di TRENSTATE_CONFIG (nilai awal usulan, belum tervalidasi backtest).
 */

const { TRENSTATE_CONFIG: CFG, HHLL_CONFIG } = require("../../config/indicatorConfig");
const { ema, atr: atrSeries } = require("./indicators");
const { computeStructure } = require("./hhllCore");
const { htfOf, htfClosedAt, alignOf, retraceDepth } = require("./hhllContext");
const { TF_MS } = require("./divAlertCore");
const { detectDivergence } = require("./divergence");
const { wickReject, sweep } = require("./suddenMove");
const { computeTrendlines } = require("./trenStateTrendline");

const STATUS = Object.freeze({
  CONTINUE: "continue", // LANJUT
  PULLBACK: "pullback", // PULLBACK SEHAT
  WARN: "warn", // WASPADA REVERSAL
  REVERSAL: "reversal", // REVERSAL TERKONFIRMASI
  RANGE: "range", // RANGE / TIDAK JELAS
  CORRECTION: "correction", // koreksi, selisih bukti tipis ("belum jelas")
});

const isNum = (v) => typeof v === "number" && isFinite(v);
const lastNum = (arr) => [...arr].reverse().find(isNum);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/** Item bukti. ok: true / false / null (null = tidak bisa dinilai, tidak dihitung). */
const item = (key, side, ok, weight = 1, value = null) => ({ key, side, ok, weight, value });

/** Tren TF besar dari candle yang sudah closed pada saat candle X (TF kecil) closed. Sama dengan hhllContext.assessEvent. */
function htfTrendOf(htfCandles, tf, X, cache) {
  const htfTf = htfOf(tf);
  if (!htfTf) return { htfTf: null, htfTrend: null };
  const htfClosed = htfClosedAt(htfCandles, tf, X);
  if (htfClosed.length < HHLL_CONFIG.MIN_CANDLES) return { htfTf, htfTrend: null };
  const ck = `${htfTf}|${htfClosed[htfClosed.length - 1].t}|${htfClosed.length}`;
  if (cache && cache.has(ck)) return { htfTf, htfTrend: cache.get(ck) };
  const trend = computeStructure(htfClosed).trend;
  if (cache) cache.set(ck, trend);
  return { htfTf, htfTrend: trend };
}

/** Harga pada kedalaman retrace d dari ujung leg (kebalikan retraceDepth). */
const priceAtDepth = (up, extreme, range, d) => (up ? extreme - d * range : extreme + d * range);

/**
 * Penilaian MENTAH satu candle (tanpa histeresis).
 * @param {object[]} closed candle closed urut lama -> baru { t, o, h, l, c, v? }
 * @param {object[]|null} htfCandles candle TF besar (boleh belum difilter)
 * @param {{tf:string, cache?:Map, trendline?:boolean}} opts trendline:false = tanpa trendline
 * @returns {null|{
 *   trendline:null|object, // lihat trenStateTrendline.computeTrendlines
 *   status:string, grade:"strong"|"medium"|"weak"|null, trend:"up"|"down"|"range", dir:"up"|"down"|null,
 *   depth:number|null, atr:number, close:number, t:number, htfTf:string|null, htfTrend:string|null, align:string|null,
 *   evidence:{key:string, side:"continue"|"reversal", ok:boolean|null, weight:number, value:number|null}[],
 *   scoreCont:number, scoreRev:number, applicable:number, unknown:number,
 *   levels:{extreme:number|null, reclaim:number|null, invalidation:number|null, target:number|null, rangeHigh:number|null, rangeLow:number|null}
 * }} null = data belum cukup (bukan error)
 */
function assessRaw(closed, htfCandles, opts = {}) {
  const tf = opts.tf;
  const n = closed ? closed.length : 0;
  if (!tf || !TF_MS[tf] || n < CFG.MIN_CANDLES) return null;
  const X = closed[n - 1];
  const atrVal = lastNum(atrSeries(closed));
  if (!isNum(atrVal) || !(atrVal > 0)) return null;

  const st = computeStructure(closed);
  if (!st.trend || !st.lastHigh || !st.lastLow) return null;

  const base = {
    trendline: null,
    status: null,
    grade: null,
    trend: st.trend,
    dir: null,
    depth: null,
    atr: atrVal,
    close: X.c,
    t: X.t,
    htfTf: null,
    htfTrend: null,
    align: null,
    evidence: [],
    scoreCont: 0,
    scoreRev: 0,
    applicable: 0,
    unknown: 0,
    levels: { extreme: null, reclaim: null, invalidation: null, target: null, rangeHigh: null, rangeLow: null },
  };
  const { htfTf, htfTrend } = htfTrendOf(htfCandles, tf, X, opts.cache);
  base.htfTf = htfTf;
  base.htfTrend = htfTrend;

  // ---------- trendline (informasi saja; gagal hitung tidak boleh mematikan penilaian) ----------
  if (opts.trendline !== false && CFG.TL_ENABLED) {
    try {
      base.trendline = computeTrendlines(closed, st.swings, { atr: atrVal, dir: st.trend === "up" || st.trend === "down" ? st.trend : null });
    } catch {
      base.trendline = null;
    }
  }

  // ---------- 1. tren asal ----------
  if (st.trend === "range") {
    base.status = STATUS.RANGE;
    base.levels.rangeHigh = st.lastHigh.price;
    base.levels.rangeLow = st.lastLow.price;
    return base;
  }
  const up = st.trend === "up";
  const dir = st.trend;
  base.dir = dir;
  base.align = alignOf(dir, htfTrend);

  const legEnd = up ? st.lastHigh : st.lastLow; // ujung leg impuls (swing)
  const prot = up ? st.lastLow : st.lastHigh; // swing yang dilindungi: HL (naik) / LH (turun)
  const legEndPos = st.swings.findIndex((s) => s.i === legEnd.i && s.type === legEnd.type);
  const origin = legEndPos > 0 ? st.swings[legEndPos - 1] : null; // awal leg impuls
  if (!origin || origin.type === legEnd.type) return null;
  base.levels.invalidation = prot.price;

  // ---------- 2. fase ----------
  // ekstrem terbaru sejak ujung leg (bisa lebih jauh dari swing kalau pivotnya belum terkonfirmasi)
  let extremeIdx = legEnd.i;
  let extreme = legEnd.price;
  for (let k = legEnd.i + 1; k < n; k++) {
    if (up ? closed[k].h > extreme : closed[k].l < extreme) {
      extreme = up ? closed[k].h : closed[k].l;
      extremeIdx = k;
    }
  }
  base.levels.extreme = extreme;

  // 2a. struktur patah: close melewati HL/LH terakhir = aturan keras
  const broken = up ? X.c < prot.price : X.c > prot.price;
  if (broken) {
    base.status = STATUS.REVERSAL;
    const beyond = (up ? prot.price - X.c : X.c - prot.price) / atrVal;
    const prev = closed.slice(Math.max(0, n - 1 - CFG.VOL_LOOKBACK), n - 1).map((c) => c.v);
    const pm = prev.length >= 5 && prev.every(isNum) ? mean(prev) : null;
    const volOk = isNum(X.v) && pm > 0 ? X.v / pm >= CFG.VOL_SPIKE_MULT : null;
    const hits = (beyond >= CFG.CONFIRM_BEYOND_ATR ? 1 : 0) + (volOk ? 1 : 0);
    base.grade = hits >= 2 ? "strong" : hits === 1 ? "medium" : "weak";
    base.evidence = [item("closeBeyond", "reversal", beyond >= CFG.CONFIRM_BEYOND_ATR, 1, beyond), item("volBreak", "reversal", volOk, 1, null)];
    return base;
  }

  // leg impuls: dari awal leg ke ekstrem. Kalau sudah ada low/high pivot SESUDAH ujung leg lama dan ekstrem baru lewat dari
  // ujung leg lama, leg impuls yang relevan dimulai dari pivot itu (HL/LH yang baru).
  const legStart = extremeIdx > legEnd.i && prot.i > legEnd.i ? prot : origin;
  const range = Math.abs(extreme - legStart.price);
  if (!(range > 0)) return null;
  const depth = retraceDepth(dir, legStart.price, extreme, X.c);
  if (depth == null) return null;
  base.depth = depth;

  // 2b. HH/LL baru: ada close melewati ujung leg lama dan ekstremnya masih segar (pivotnya belum sempat terkonfirmasi)
  const closedBeyond = closed.slice(legEnd.i + 1).some((c) => (up ? c.c > legEnd.price : c.c < legEnd.price));
  const freshExtreme = closedBeyond && n - 1 - extremeIdx <= HHLL_CONFIG.PIVOT_WIN;
  if (freshExtreme || depth < CFG.CONTINUE_DEPTH) {
    base.status = STATUS.CONTINUE;
    const ema50 = lastNum(ema(closed.map((c) => c.c), 50));
    const hold = isNum(ema50) ? (up ? X.c > ema50 : X.c < ema50) : null;
    base.evidence = [item("holdEma50", "continue", hold), item("htfWith", "continue", base.align === "with" ? true : base.align === "against" ? false : null)];
    base.grade = base.align === "against" ? "weak" : hold && base.align === "with" ? "strong" : "medium";
    base.scoreCont = base.evidence.filter((e) => e.ok === true).length;
    base.applicable = base.evidence.filter((e) => e.ok != null).length;
    base.unknown = base.evidence.length - base.applicable;
    return base;
  }

  // ---------- 3. skor bukti (fase koreksi) ----------
  const corrFrom = extremeIdx + 1;
  const corr = closed.slice(corrFrom); // candle koreksi (>= 1 karena depth >= CONTINUE_DEPTH > 0)
  const impulse = closed.slice(legStart.i + 1, extremeIdx + 1);
  const closes = closed.map((c) => c.c);
  const ema20 = lastNum(ema(closes, 20));
  const ema50 = lastNum(ema(closes, 50));
  const isCounter = (c) => (up ? c.c < c.o : c.c > c.o); // candle melawan tren

  // volume
  const vOk = (arr) => arr.length > 0 && arr.every((c) => isNum(c.v));
  let volDry = null;
  if (corr.length >= 2 && impulse.length >= 3 && vOk(corr) && vOk(impulse)) {
    const mi = mean(impulse.map((c) => c.v));
    volDry = mi > 0 ? mean(corr.map((c) => c.v)) / mi <= CFG.VOL_CORR_MAX : null;
  }
  let volSpike = null;
  if (corr.length >= 1 && vOk(corr)) {
    volSpike = false;
    for (let k = corrFrom; k < n; k++) {
      if (!isCounter(closed[k])) continue;
      const prev = closed.slice(Math.max(0, k - CFG.VOL_LOOKBACK), k).map((c) => c.v);
      if (prev.length < 5 || !prev.every(isNum)) continue;
      const pm = mean(prev);
      if (pm > 0 && closed[k].v / pm >= CFG.VOL_SPIKE_MULT) {
        volSpike = true;
        break;
      }
    }
  }

  // kecepatan koreksi vs impuls (ATR per candle)
  let fast = null;
  const impBars = extremeIdx - legStart.i;
  if (corr.length >= 2 && impBars >= 1) {
    const corrSpeed = Math.abs(extreme - X.c) / atrVal / corr.length;
    const impSpeed = range / atrVal / impBars;
    fast = corrSpeed >= CFG.SPEED_MULT * impSpeed;
  }

  // body candle koreksi
  const smallBody = corr.length >= 1 ? mean(corr.map((c) => Math.abs(c.c - c.o))) / atrVal <= CFG.BODY_ATR_MAX : null;

  // divergence di ekstrem terakhir (reguler = reversal, tersembunyi searah tren = lanjut)
  let divReg = null;
  let divHid = null;
  try {
    const divs = detectDivergence(closed, { LOOKBACK: CFG.DIV_LOOKBACK }).filter((d) => d.pivot2 && d.pivot2.idx >= extremeIdx - CFG.DIV_RADIUS);
    divReg = divs.some((d) => d.kind === "regular" && d.dir === (up ? "bear" : "bull"));
    divHid = divs.some((d) => d.kind === "hidden" && d.dir === (up ? "bull" : "bear"));
  } catch {
    divReg = null;
    divHid = null;
  }

  // sweep / wick reject di ekstrem (suddenMove.js)
  let reject = null;
  try {
    const want = up ? "bearish" : "bullish";
    const before = st.swings.filter((s) => s.i < extremeIdx);
    const levels = {
      resistance: before.filter((s) => s.type === "H").slice(-3).map((s) => s.price),
      support: before.filter((s) => s.type === "L").slice(-3).map((s) => s.price),
    };
    const sw = sweep(closed.slice(0, extremeIdx + 1), levels);
    const wr = wickReject(closed[extremeIdx], up ? { resistance: [extreme] } : { support: [extreme] }, atrVal);
    reject = (sw && sw.dir === want) || (wr && wr.dir === want) ? true : false;
  } catch {
    reject = null;
  }

  // EMA
  const holdEma50 = isNum(ema50) ? (up ? X.c > ema50 : X.c < ema50) : null;
  const lostEma = isNum(ema20) && isNum(ema50) ? (up ? X.c < ema20 && X.c < ema50 : X.c > ema20 && X.c > ema50) : null;

  const deep = depth > CFG.HEALTHY_MAX;
  const ev = [
    // condong lanjut (pullback sehat)
    item("volDry", "continue", volDry),
    item("retraceHealthy", "continue", depth >= CFG.HEALTHY_MIN && depth <= CFG.HEALTHY_MAX, 1, depth),
    item("holdEma50", "continue", holdEma50),
    item("divHidden", "continue", divHid),
    item("htfWith", "continue", base.align === "with" ? true : base.align === "against" ? false : null),
    item("smallBody", "continue", smallBody),
    // condong reversal
    item("divRegular", "reversal", divReg),
    item("volSpike", "reversal", volSpike),
    item("retraceDeep", "reversal", deep, depth > CFG.DEEP_MAX ? CFG.DEEP_WEIGHT : 1, depth),
    item("fastCorrection", "reversal", fast),
    item("sweepReject", "reversal", reject),
    item("htfAgainst", "reversal", base.align === "against" ? true : base.align === "with" ? false : null),
    item("lostEma", "reversal", lostEma),
  ];
  base.evidence = ev;
  base.scoreCont = ev.filter((e) => e.side === "continue" && e.ok === true).reduce((a, e) => a + e.weight, 0);
  base.scoreRev = ev.filter((e) => e.side === "reversal" && e.ok === true).reduce((a, e) => a + e.weight, 0);
  base.applicable = ev.filter((e) => e.ok != null).length;
  base.unknown = ev.length - base.applicable;

  // ---------- 4. putusan ----------
  const lead = base.scoreCont - base.scoreRev;
  if (lead >= CFG.VERDICT_GAP) base.status = STATUS.PULLBACK;
  else if (lead <= -CFG.VERDICT_GAP) base.status = STATUS.WARN;
  else base.status = STATUS.CORRECTION;
  if (base.status === STATUS.CORRECTION) base.grade = null;
  else if (base.applicable < CFG.MIN_APPLICABLE) base.grade = "weak";
  else base.grade = Math.abs(lead) >= CFG.GRADE_STRONG_LEAD ? "strong" : "medium";

  // ---------- level ----------
  const reclaimPrice = depth <= CFG.RECLAIM_DEPTH ? extreme : priceAtDepth(up, extreme, range, CFG.RECLAIM_DEPTH);
  const pbExtreme = corr.length ? (up ? Math.min(...corr.map((c) => c.l)) : Math.max(...corr.map((c) => c.h))) : X.c;
  base.levels.reclaim = reclaimPrice;
  base.levels.target = up ? pbExtreme + range : pbExtreme - range; // measured move dari dasar/puncak pullback
  return base;
}

/**
 * Trendline SAJA, untuk saat struktur swing tidak bisa dinilai (assessTrenState = null: swing belum cukup, harga mengalir
 * tanpa pivot, dsb.). Justru di kondisi "tidak ada pola yang jelas" inilah garis swing / jalur regresi paling berguna.
 * Tidak ada status, grade, atau level: hanya { trendline, atr, close } supaya pemanggil menampilkannya sebagai informasi.
 * @param {object[]} closed candle closed urut lama -> baru
 * @returns {null|{trendline:object, status:string, dir:null, atr:number, close:number, t:number}} null = data < 20 candle / ATR tidak valid / trendline dimatikan
 */
function assessTrendlineOnly(closed) {
  const n = closed ? closed.length : 0;
  if (!CFG.TL_ENABLED || n < 20) return null;
  const atrVal = lastNum(atrSeries(closed));
  if (!isNum(atrVal) || !(atrVal > 0)) return null;
  let swings = [];
  try {
    swings = computeStructure(closed).swings;
  } catch {
    swings = [];
  }
  let trendline = null;
  try {
    trendline = computeTrendlines(closed, swings, { atr: atrVal, dir: null });
  } catch {
    trendline = null;
  }
  const X = closed[n - 1];
  return trendline ? { trendline, status: STATUS.RANGE, dir: null, atr: atrVal, close: X.c, t: X.t } : null;
}

/**
 * Histeresis murni: status baru dianggap berubah setelah bertahan `k` entri berturut-turut.
 * Entri null (data kurang) dilewati.
 * @param {(string|null)[]} seq status mentah, lama -> baru
 * @returns {{status:string|null, barsSince:number|null, pending:{status:string,count:number}|null}}
 *   barsSince = jumlah candle (termasuk yang terakhir) status stabil sudah bertahan sejak berganti di dalam jendela; null = tidak berganti dalam jendela
 */
function stabilize(seq, k = CFG.HYST_BARS) {
  let stable = null;
  let pend = null;
  let cnt = 0;
  let startIdx = null;
  seq.forEach((s, i) => {
    if (s == null) return;
    if (stable == null) {
      stable = s;
      return;
    }
    if (s === stable) {
      pend = null;
      cnt = 0;
      return;
    }
    if (s === pend) cnt++;
    else {
      pend = s;
      cnt = 1;
    }
    if (cnt >= Math.max(1, k)) {
      stable = pend;
      startIdx = i - cnt + 1;
      pend = null;
      cnt = 0;
    }
  });
  return {
    status: stable,
    barsSince: startIdx == null ? null : seq.length - startIdx, // termasuk candle terakhir (>= 1)
    pending: pend ? { status: pend, count: cnt } : null,
  };
}

/**
 * Penilaian lengkap + histeresis untuk candle terakhir.
 * @param {object[]} closed candle closed
 * @param {object[]|null} htfCandles
 * @param {{tf:string, cache?:Map, hyst?:boolean}} opts hyst:false = tanpa histeresis (backtest memakai stabilize sendiri)
 * @returns {null|(ReturnType<typeof assessRaw> & {rawStatus:string, stable:boolean, barsSince:number|null,
 *   pending:{status:string,count:number}|null})}
 */
function assessTrenState(closed, htfCandles, opts = {}) {
  const n = closed ? closed.length : 0;
  const cache = opts.cache || new Map();
  const latest = assessRaw(closed, htfCandles, { ...opts, cache });
  if (!latest) return null;
  if (opts.hyst === false || CFG.HYST_BARS <= 1) return { ...latest, rawStatus: latest.status, stable: true, barsSince: null, pending: null };

  const seq = [];
  for (let j = Math.max(CFG.MIN_CANDLES, n - CFG.HYST_WINDOW); j < n; j++) {
    const r = assessRaw(closed.slice(0, j), htfCandles, { ...opts, cache, trendline: false }); // replay hanya butuh status
    seq.push(r ? r.status : null);
  }
  seq.push(latest.status);
  const sb = stabilize(seq, CFG.HYST_BARS);
  const stable = sb.status === latest.status;
  return {
    ...latest,
    rawStatus: latest.status,
    status: sb.status || latest.status,
    grade: stable ? latest.grade : null, // grade milik status mentah, jangan ditempel ke status stabil yang berbeda
    stable,
    barsSince: sb.barsSince,
    pending: sb.pending,
  };
}

module.exports = { CFG, STATUS, assessRaw, assessTrenState, assessTrendlineOnly, stabilize, htfTrendOf };
