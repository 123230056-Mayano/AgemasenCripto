"use strict";

/**
 * features/kripto/amdCore.js
 * ------------------------------------------------------------------
 * Logika MURNI Accumulation - Manipulation - Distribution (AMD / "Power of 3").
 * Tanpa fetch, tanpa kirim pesan, jadi bisa diuji unit (src/test/amd.test.js).
 * Dipakai !amd (amd.js) dan alarm !alertamd (amdAlertCore.js).
 *
 * Tiga fase, semuanya dari candle CLOSED (urut lama -> baru: { t, o, h, l, c, v? }):
 *   1. AKUMULASI  : range sempit. Lebar (high-low) <= RANGE_MAX_ATR x ATR, minimal RANGE_MIN_BARS candle, harga
 *                   sideways (drift kecil), tepi atas dan tepi bawah sama-sama tersentuh >= EDGE_MIN_TOUCHES kali.
 *   2. MANIPULASI : satu candle closed menembus tepi range (wick keluar >= SWEEP_MIN_ATR x ATR) lalu CLOSE kembali
 *                   ke dalam range (sweep / stop hunt).
 *                   bullish = sweep tepi BAWAH (jebakan jual, lalu naik); bearish = sweep tepi ATAS (jebakan beli, lalu turun).
 *   3. DISTRIBUSI : setelah sweep, close PERTAMA yang menembus swing berlawanan (break market structure, swing dari
 *                   hhllCore.js) dalam CONFIRM_BARS candle.
 *                   bullish: close > swing high terakhir (di atas harga close sweep); bearish: close < swing low terakhir.
 *                   Kalau tidak ada swing yang memenuhi, dipakai tepi range sebagai level.
 *   Gagal   : close menembus ekstrem sweep (bullish: close < low sweep; bearish: close > high sweep) = tembusan asli, bukan jebakan.
 *   Kedaluwarsa: CONFIRM_BARS candle lewat tanpa break struktur.
 *
 * Satu episode = satu sweep. Sweep searah yang muncul <= CONFIRM_BARS candle setelah sweep sebelumnya (yang belum
 * gagal) dianggap bagian episode yang sama dan tidak dihitung ulang.
 * Angka di AMD_CONFIG (config/indicatorConfig.js) adalah nilai awal usulan, bukan hasil backtest.
 */

const { AMD_CONFIG: CFG } = require("../../config/indicatorConfig");
const { atr: calcAtr } = require("./indicators");
const { computeStructure } = require("./hhllCore");

const isNum = (v) => typeof v === "number" && isFinite(v);

// =====================================================================
// 1. Akumulasi: range sideways
// =====================================================================
/**
 * Statistik satu jendela candle [s..e] (inklusif) dan apakah layak disebut range akumulasi.
 * @returns {{startI:number,endI:number,bars:number,hi:number,lo:number,mid:number,width:number,widthAtr:number,widthPct:number,topTouches:number,botTouches:number,drift:number,ok:boolean}|null}
 */
function windowStats(candles, s, e, atrVal, cfg = CFG) {
  if (s < 0 || e >= candles.length || e < s || !isNum(atrVal) || atrVal <= 0) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = s; i <= e; i++) {
    if (candles[i].h > hi) hi = candles[i].h;
    if (candles[i].l < lo) lo = candles[i].l;
  }
  const width = hi - lo;
  if (!(width > 0)) return null;
  const topEdge = hi - cfg.EDGE_FRAC * width;
  const botEdge = lo + cfg.EDGE_FRAC * width;
  let topTouches = 0;
  let botTouches = 0;
  for (let i = s; i <= e; i++) {
    if (candles[i].h >= topEdge) topTouches++;
    if (candles[i].l <= botEdge) botTouches++;
  }
  const drift = Math.abs(candles[e].c - candles[s].c) / width;
  const widthAtr = width / atrVal;
  const ok = widthAtr <= cfg.RANGE_MAX_ATR && topTouches >= cfg.EDGE_MIN_TOUCHES && botTouches >= cfg.EDGE_MIN_TOUCHES && drift <= cfg.DRIFT_MAX;
  return { startI: s, endI: e, bars: e - s + 1, hi, lo, mid: (hi + lo) / 2, width, widthAtr, widthPct: (width / ((hi + lo) / 2)) * 100, topTouches, botTouches, drift, ok };
}

/**
 * Range akumulasi TERPANJANG yang berakhir di candle index `e` (RANGE_MIN_BARS..RANGE_MAX_BARS candle).
 * @param {number[]} atrSeries hasil indicators.atr(candles) (null sebelum warmup)
 * @returns {object|null} windowStats dengan ok = true, atau null
 */
function bestRange(candles, e, atrSeries, cfg = CFG) {
  const a = atrSeries[e];
  if (!isNum(a) || a <= 0) return null;
  let best = null;
  for (let L = cfg.RANGE_MIN_BARS; L <= cfg.RANGE_MAX_BARS; L++) {
    const w = windowStats(candles, e - L + 1, e, a, cfg);
    if (!w) break; // jendela sudah melewati awal data
    if (w.ok) best = w;
  }
  return best;
}

/** Rasio rata-rata volume range terhadap VOL_LOOKBACK candle sebelum range. null kalau volume tidak tersedia. */
function rangeVolRatio(candles, range, cfg = CFG) {
  const from = range.startI - cfg.VOL_LOOKBACK;
  if (from < 0) return null;
  const inR = candles.slice(range.startI, range.endI + 1);
  const pre = candles.slice(from, range.startI);
  if (![...inR, ...pre].every((k) => isNum(k.v))) return null;
  const avg = (arr) => arr.reduce((s, k) => s + k.v, 0) / arr.length;
  const base = avg(pre);
  return base > 0 ? avg(inR) / base : null;
}

// =====================================================================
// 2. Manipulasi: sweep tepi range lalu close balik
// =====================================================================
/**
 * Sweep di candle index m terhadap range akumulasi yang berakhir di m-1.
 * @returns {{i:number,t:number,dir:"bullish"|"bearish",extreme:number,depth:number,close:number,range:object}|null}
 */
function sweepAt(candles, m, atrSeries, cfg = CFG) {
  if (m < 1) return null;
  const range = bestRange(candles, m - 1, atrSeries, cfg);
  if (!range) return null;
  const a = atrSeries[m - 1];
  const X = candles[m];
  if (![X.h, X.l, X.c].every(isNum)) return null;
  const minPen = cfg.SWEEP_MIN_ATR * a;
  const bull = X.l < range.lo - minPen && X.c > range.lo && X.c < range.hi ? { dir: "bullish", extreme: X.l, depth: range.lo - X.l } : null;
  const bear = X.h > range.hi + minPen && X.c < range.hi && X.c > range.lo ? { dir: "bearish", extreme: X.h, depth: X.h - range.hi } : null;
  const pick = bull && bear ? (bull.depth >= bear.depth ? bull : bear) : bull || bear;
  if (!pick) return null;
  return { i: m, t: X.t, ...pick, close: X.c, range };
}

// =====================================================================
// 3. Distribusi: break market structure setelah sweep
// =====================================================================
/**
 * Level yang harus ditembus close agar sweep terkonfirmasi, dihitung dari candle `slice` (candle SEBELUM yang dinilai).
 *   bullish: swing high terakhir (index >= awal range) yang harganya di atas close sweep; bearish: swing low di bawah close sweep.
 *   Tidak ada -> tepi range seberangnya (high untuk bullish, low untuk bearish).
 * @returns {{price:number, kind:"swing"|"range", i:number|null}}
 */
function mssLevel(slice, sw) {
  const st = computeStructure(slice);
  const want = sw.dir === "bullish" ? "H" : "L";
  const ok = (s) => s.type === want && s.i >= sw.range.startI && (sw.dir === "bullish" ? s.price > sw.close : s.price < sw.close);
  const hit = [...st.swings].reverse().find(ok);
  if (hit) return { price: hit.price, kind: "swing", i: hit.i };
  return { price: sw.dir === "bullish" ? sw.range.hi : sw.range.lo, kind: "range", i: null };
}

/**
 * Nasib sebuah sweep dari candle sesudahnya.
 * @returns {{status:"confirmed"|"failed"|"pending"|"expired", at?:number, level?:{price:number,kind:string,i:number|null}}}
 */
function outcomeOf(candles, sw, memo, cfg = CFG) {
  const n = candles.length;
  const end = Math.min(n - 1, sw.i + cfg.CONFIRM_BARS);
  for (let k = sw.i + 1; k <= end; k++) {
    const c = candles[k].c;
    if (sw.dir === "bullish" ? c < sw.extreme : c > sw.extreme) return { status: "failed", at: k };
    if (!memo.has(k)) memo.set(k, new Map());
    const m = memo.get(k);
    if (!m.has(sw.dir + sw.i)) m.set(sw.dir + sw.i, mssLevel(candles.slice(0, k), sw));
    const level = m.get(sw.dir + sw.i);
    if (sw.dir === "bullish" ? c > level.price : c < level.price) return { status: "confirmed", at: k, level };
  }
  return { status: n - 1 >= sw.i + cfg.CONFIRM_BARS ? "expired" : "pending" };
}

// =====================================================================
// 4. Gabungan
// =====================================================================
/**
 * Semua sweep (episode) dalam `lookback` candle terakhir beserta statusnya, urut lama -> baru.
 * @returns {{i,t,dir,extreme,depth,close,range,status,at?,level?}[]}
 */
function findManipulations(closed, { lookback = CFG.STATE_LOOKBACK } = {}, cfg = CFG) {
  const n = closed.length;
  if (n < cfg.MIN_CANDLES) return [];
  const atrSeries = calcAtr(closed);
  const memo = new Map();
  const from = Math.max(cfg.RANGE_MIN_BARS + 1, n - 1 - lookback - cfg.CONFIRM_BARS);
  const lastBy = { bullish: null, bearish: null }; // episode terakhir per arah
  const out = [];
  for (let m = from; m < n; m++) {
    const sw = sweepAt(closed, m, atrSeries, cfg);
    if (!sw) continue;
    const prev = lastBy[sw.dir];
    if (prev && sw.i - prev.i <= cfg.CONFIRM_BARS && prev.status !== "failed") continue; // episode yang sama
    const res = outcomeOf(closed, sw, memo, cfg);
    const full = { ...sw, ...res };
    lastBy[sw.dir] = full;
    if (sw.i >= n - 1 - lookback) out.push(full);
  }
  return out;
}

/**
 * Kondisi AMD saat ini untuk !amd.
 * @param {object[]} closed candle closed
 * @param {{computeSnr?:Function}} [opts] computeSnr (snr.js) dipakai untuk menandai R1/S1 di dalam range
 * @returns {null|{
 *   phase: "accumulation"|"manipulation"|"distribution"|"failed"|"none",
 *   dir: "bullish"|"bearish"|null,
 *   range: object|null, sweep: object|null, level: object|null, confirmAt: number|null,
 *   volRatio: number|null, lock: {resistance:object|null, support:object|null}|null,
 *   barsSince: number|null,
 * }}
 */
function detectAmd(closed, opts = {}, cfg = CFG) {
  const n = closed.length;
  if (n < cfg.MIN_CANDLES) return null;
  const latest = findManipulations(closed, {}, cfg).pop();
  let phase = "none";
  let range = null;
  let sweep = null;
  let level = null;
  let confirmAt = null;
  let dir = null;

  if (latest && latest.status !== "expired") {
    phase = latest.status === "confirmed" ? "distribution" : latest.status === "failed" ? "failed" : "manipulation";
    dir = latest.dir;
    sweep = latest;
    range = latest.range;
    level = latest.level || null;
    confirmAt = latest.status === "confirmed" ? latest.at : null;
    if (!level && latest.status === "pending") level = mssLevel(closed, latest); // level yang ditunggu
  } else {
    range = bestRange(closed, n - 1, calcAtr(closed), cfg);
    if (range) phase = "accumulation";
  }

  let lock = null;
  if (range && opts.computeSnr) {
    try {
      const win = closed.slice(range.startI, range.endI + 1);
      const z = opts.computeSnr(win, range.mid, { count: 1 });
      lock = { resistance: z.resistance[0] || null, support: z.support[0] || null };
    } catch {
      lock = null;
    }
  }
  return {
    phase,
    dir,
    range,
    sweep,
    level,
    confirmAt,
    volRatio: range ? rangeVolRatio(closed, range, cfg) : null,
    lock,
    barsSince: sweep ? n - 1 - sweep.i : null,
  };
}

module.exports = { CFG, windowStats, bestRange, rangeVolRatio, sweepAt, mssLevel, outcomeOf, findManipulations, detectAmd };
