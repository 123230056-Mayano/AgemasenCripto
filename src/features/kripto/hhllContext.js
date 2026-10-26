"use strict";

/**
 * features/kripto/hhllContext.js
 * ------------------------------------------------------------------
 * Penilai KONTEKS untuk kejadian HHLL (rencana HHLL fase 1). Logika MURNI: tanpa fetch, tanpa store.
 * Detektor swing (hhllCore.js) dan deteksi kejadian (hhllAlertCore.detectEvents) TIDAK diubah; modul ini hanya
 * menilai kejadian yang sudah ada dan hasilnya skenario bersyarat ("lanjut jika ..., batal jika ..."), bukan ramalan.
 *
 * Fitur (angka di HHLL_CONTEXT_CONFIG, semuanya titik awal usulan):
 *   align    searah / melawan / range terhadap struktur TF besar (15M->1H, 1H->4H, 4H->1D), dari computeStructure
 *   volume   volume candle X / rata-rata 20 candle sebelumnya >= VOL_MULT           (hanya tahap konfirmasi)
 *   close    close melewati level >= CLOSE_BEYOND_ATR x ATR dan ditutup di 30% ujung range candle (konfirmasi)
 *   leg      leg swing yang ditembus >= k x ATR (pengganti MIN_SWING_PCT yang tetap)
 *   pullback kedalaman retrace HL/LH di 38,2-78,6% dari leg sebelumnya
 *   level    invalidasi = swing berlawanan terakhir; target = measured move (tinggi leg dari level tembusan); R:R
 *
 * Grade hanya tiga tingkat (strong / medium / weak) supaya tidak terlihat presisi palsu:
 *   weak   = melawan TF besar, atau lolos <= 25% fitur yang berlaku
 *   strong = lolos >= 75% fitur yang berlaku (dan tidak melawan TF besar)
 *   medium = selain itu
 * Fitur yang tidak berlaku (data tidak ada / bukan tahap yang sesuai) bernilai null dan tidak dihitung.
 *
 * TIDAK ADA LOOKAHEAD: candle TF besar yang dipakai hanya yang SUDAH closed pada saat candle X closed.
 */

const { HHLL_CONTEXT_CONFIG: CX, HHLL_CONFIG } = require("../../config/indicatorConfig");
const { atr: atrSeries } = require("./indicators");
const { computeStructure } = require("./hhllCore");
const { TF_MS } = require("./divAlertCore");
const { detectEvents } = require("./hhllAlertCore");

const isNum = (v) => typeof v === "number" && isFinite(v);

/** Timeframe konteks untuk sebuah TF (null kalau tidak ada, mis. 1D). */
const htfOf = (tf) => CX.HTF[tf] || null;

/**
 * Kedalaman retrace sama dengan fib.retraceDepth (0 = di ujung leg, 1 = kembali ke awal leg). Ditulis ulang di sini
 * karena fib.js memuat canvas (chart) dan modul ini harus tetap murni/bisa diuji tanpa dependensi gambar.
 * @param {"up"|"down"} legDir arah leg yang di-retrace
 */
function retraceDepth(legDir, legStart, legEnd, price) {
  const range = Math.abs(legEnd - legStart);
  if (!(range > 0)) return null;
  return legDir === "up" ? (legEnd - price) / range : (price - legEnd) / range;
}

/** Candle TF besar yang sudah closed PADA SAAT candle X (TF kecil) closed. */
function htfClosedAt(htfCandles, tf, X) {
  const htfTf = htfOf(tf);
  if (!htfTf || !htfCandles || !htfCandles.length) return [];
  const htfMs = TF_MS[htfTf];
  const cutoff = X.t + TF_MS[tf];
  return htfCandles.filter((c) => c.closed !== false && c.t + htfMs <= cutoff);
}

/** "with" | "against" | "range" | null (null = TF besar tidak ada / datanya kurang). */
function alignOf(dir, htfTrend) {
  if (!htfTrend) return null;
  if (htfTrend === "range") return "range";
  return (htfTrend === "up") === (dir === "up") ? "with" : "against";
}

/** Rasio volume X terhadap rata-rata `lookback` candle sebelumnya; null kalau data volume tidak ada. */
function volumeRatio(closed, lookback = CX.VOL_LOOKBACK) {
  const n = closed.length;
  const X = closed[n - 1];
  const prev = closed.slice(Math.max(0, n - 1 - lookback), n - 1);
  if (!isNum(X?.v) || prev.length < Math.min(lookback, 5)) return null;
  const mean = prev.reduce((a, c) => a + (isNum(c.v) ? c.v : 0), 0) / prev.length;
  return mean > 0 ? X.v / mean : null;
}

/** Posisi swing di array swings (dicocokkan lewat index candle + tipe). */
const posOf = (swings, sw) => (sw ? swings.findIndex((s) => s.i === sw.i && s.type === sw.type) : -1);

/**
 * Geometri leg yang berkaitan dengan kejadian.
 * confirm : leg = dari swing sebelum swing yang ditembus (origin) sampai swing yang ditembus; pullback = swing
 *           berlawanan sesudahnya (kalau ada); invalidasi = swing berlawanan terakhir.
 * early   : leg = dari origin ke swing sebelum swing baru (HL/LH); pullback = swing baru itu sendiri; invalidasi = swing baru.
 * @returns {{legSize:number|null, pullback:number|null, invalidation:number|null, target:number|null, trigger:number|null}}
 */
function geometry(ev, st) {
  const up = ev.dir === "up";
  const out = { legSize: null, pullback: null, invalidation: null, target: null, trigger: null };
  const sw = st.swings;

  if (ev.stage === "early") {
    // swing baru = elemen terakhir; sebelumnya swing sejenis lawan (puncak/lembah asal pullback), lalu origin
    const n = sw.length;
    const fresh = sw[n - 1];
    const from = sw[n - 2];
    const origin = sw[n - 3];
    out.invalidation = ev.level;
    out.trigger = ev.ref ?? null;
    if (fresh && from && origin) {
      const leg = Math.abs(from.price - origin.price);
      out.legSize = leg;
      out.pullback = retraceDepth(up ? "up" : "down", origin.price, from.price, fresh.price);
      if (isNum(ev.ref)) out.target = up ? ev.ref + leg : ev.ref - leg;
    }
    return out;
  }

  // confirm (termasuk prospektif): swing yang ditembus = lastHigh (naik) / lastLow (turun)
  const broken = up ? st.lastHigh : st.lastLow;
  const opposite = up ? st.lastLow : st.lastHigh;
  const idx = posOf(sw, broken);
  const origin = idx > 0 ? sw[idx - 1] : null;
  const after = idx >= 0 ? sw[idx + 1] : null; // pullback sesudah swing yang ditembus (kalau ada)
  out.trigger = ev.level;
  out.invalidation = opposite ? opposite.price : null;
  if (broken && origin) {
    const leg = Math.abs(broken.price - origin.price);
    out.legSize = leg;
    out.target = up ? ev.level + leg : ev.level - leg;
    if (after && after.type !== broken.type) out.pullback = retraceDepth(up ? "up" : "down", origin.price, broken.price, after.price);
  }
  return out;
}

/**
 * Nilai satu kejadian.
 * @param {object[]} closed candle closed urut lama -> baru (X = elemen terakhir)
 * @param {{stage:string, dir:"up"|"down", level:number, ref?:number|null, now:number, flip?:boolean, prospective?:boolean}} ev
 *   prospective: true = belum ada tembusan (dipakai !hhll untuk status "menunggu"): volume & close tidak dinilai.
 * @param {object[]|null} htfCandles candle TF besar (boleh belum difilter; yang belum closed saat X closed dibuang)
 * @param {{tf:string, cache?:Map, atrVal?:number}} opts tf wajib; cache = Map opsional untuk struktur TF besar (backtest)
 * @returns {{grade:"strong"|"medium"|"weak"|null, score:number, applicable:number, atr:number|null,
 *   features:{align:string|null, volume:{ok:boolean|null, ratio:number|null}, close:{ok:boolean|null, beyondAtr:number|null, pos:number|null},
 *             leg:{ok:boolean|null, atrs:number|null}, pullback:{ok:boolean|null, depth:number|null}},
 *   htfTf:string|null, htfTrend:string|null, trigger:number|null, invalidation:number|null, target:number|null, rr:number|null}|null}
 *   null kalau data tidak cukup (bukan error).
 */
function assessEvent(closed, ev, htfCandles, opts = {}) {
  const tf = opts.tf;
  const n = closed ? closed.length : 0;
  if (!n || !ev || !tf || !TF_MS[tf]) return null;
  const X = closed[n - 1];

  const atrVal = isNum(opts.atrVal) ? opts.atrVal : [...atrSeries(closed)].reverse().find(isNum);
  if (!isNum(atrVal) || !(atrVal > 0)) return null;

  // struktur yang dipakai: konfirmasi -> sebelum X (swing yang ditembus ada di situ); dini/prospektif -> sesudah X
  let st;
  if (ev.stage === "confirm" && !ev.prospective) {
    if (n < 2) return null;
    st = computeStructure(closed.slice(0, -1));
  } else {
    st = computeStructure(closed);
  }
  if (!st.swings.length) return null;

  // ----- TF besar -----
  const htfTf = htfOf(tf);
  let htfTrend = null;
  if (htfTf) {
    const htfClosed = htfClosedAt(htfCandles, tf, X);
    if (htfClosed.length >= HHLL_CONFIG.MIN_CANDLES) {
      const ck = `${htfTf}|${htfClosed[htfClosed.length - 1].t}|${htfClosed.length}`;
      if (opts.cache && opts.cache.has(ck)) htfTrend = opts.cache.get(ck);
      else {
        htfTrend = computeStructure(htfClosed).trend;
        if (opts.cache) opts.cache.set(ck, htfTrend);
      }
    }
  }
  const align = alignOf(ev.dir, htfTrend);

  // ----- fitur -----
  const geo = geometry(ev, st);
  const up = ev.dir === "up";
  const isConfirm = ev.stage === "confirm" && !ev.prospective;

  let volume = { ok: null, ratio: null };
  let close = { ok: null, beyondAtr: null, pos: null };
  if (isConfirm) {
    const ratio = volumeRatio(closed);
    if (ratio != null) volume = { ok: ratio >= CX.VOL_MULT, ratio };
    const range = X.h - X.l;
    const beyond = (up ? X.c - ev.level : ev.level - X.c) / atrVal;
    // pos = seberapa dekat close ke ujung searah (1 = tepat di ujung)
    const pos = range > 0 ? (up ? (X.c - X.l) / range : (X.h - X.c) / range) : null;
    close = { ok: pos != null ? beyond >= CX.CLOSE_BEYOND_ATR && pos >= 1 - CX.CLOSE_POS : null, beyondAtr: beyond, pos };
  }
  const legK = CX.LEG_ATR_BY_TF[tf] ?? CX.LEG_ATR;
  const legAtrs = geo.legSize != null ? geo.legSize / atrVal : null;
  const leg = { ok: legAtrs != null ? legAtrs >= legK : null, atrs: legAtrs };
  const pullback = { ok: geo.pullback != null ? geo.pullback >= CX.PULLBACK_MIN && geo.pullback <= CX.PULLBACK_MAX : null, depth: geo.pullback };

  // ----- skor + grade -----
  const flags = [volume.ok, close.ok, leg.ok, pullback.ok].filter((v) => v != null);
  const applicable = flags.length;
  const score = flags.filter(Boolean).length;
  let grade = null;
  if (applicable) {
    if (align === "against" || score <= Math.floor(applicable * 0.25)) grade = "weak";
    else if (score >= Math.ceil(applicable * 0.75)) grade = "strong";
    else grade = "medium";
  }

  // ----- invalidasi, target, R:R (dari harga X.c; prospektif memakai ev.now) -----
  const ref = isNum(ev.now) ? ev.now : X.c;
  let rr = null;
  if (isNum(geo.target) && isNum(geo.invalidation)) {
    const reward = up ? geo.target - ref : ref - geo.target;
    const risk = up ? ref - geo.invalidation : geo.invalidation - ref;
    if (risk > 0 && reward > 0) rr = reward / risk;
  }

  return {
    grade,
    score,
    applicable,
    atr: atrVal,
    features: { align, volume, close, leg, pullback },
    htfTf,
    htfTrend,
    trigger: geo.trigger,
    invalidation: geo.invalidation,
    target: geo.target,
    rr,
  };
}

/**
 * Nilai kejadian alarm. Untuk tahap "failed" yang dinilai adalah tembusan ASLINYA (ev.breakout) pada candle
 * tembusan, supaya grade "tembusan gagal" = grade tembusan yang gagal itu (bukan grade candle saat gagal).
 */
function assessAlertEvent(closed, ev, htfCandles, opts = {}) {
  if (ev.stage === "failed") {
    if (!ev.breakout || !ev.since) return null;
    return assessEvent(closed.slice(0, closed.length - ev.since), ev.breakout, htfCandles, opts);
  }
  return assessEvent(closed, ev, htfCandles, opts);
}

/**
 * Status untuk !hhll: pola sudah terbentuk tetapi menunggu tembusan, sudah terkonfirmasi, atau gagal.
 * Memindai tembusan konfirmasi searah `dir` dalam STATUS_LOOKBACK candle terakhir (memakai detectEvents yang sama
 * dengan alarm, per prefix candle, jadi tidak ada lookahead).
 * @returns {{status:"waiting"|"confirmed"|"failed", ev:object|null, barsAgo:number|null, level:number|null}}
 */
function scanStatus(closed, dir, opts = {}) {
  const lookback = opts.lookback ?? CX.STATUS_LOOKBACK;
  const failBars = opts.failBars ?? CX.FAIL_BARS;
  const n = closed.length;
  for (let k = 0; k < lookback && n - k >= HHLL_CONFIG.MIN_CANDLES; k++) {
    const evs = detectEvents(closed.slice(0, n - k)).filter((e) => e.stage === "confirm" && e.dir === dir);
    if (!evs.length) continue;
    const ev = evs[0];
    const after = closed.slice(n - k); // candle sesudah candle tembusan (indeks n-1-k)
    const inside = (c) => (dir === "up" ? c.c <= ev.level : c.c >= ev.level);
    const failedEarly = after.slice(0, failBars).some(inside);
    const lastInside = k > 0 && inside(closed[n - 1]);
    return { status: failedEarly || lastInside ? "failed" : "confirmed", ev, barsAgo: k, level: ev.level };
  }
  return { status: "waiting", ev: null, barsAgo: null, level: null };
}

module.exports = { CX, htfOf, htfClosedAt, alignOf, volumeRatio, retraceDepth, geometry, assessEvent, assessAlertEvent, scanStatus };
