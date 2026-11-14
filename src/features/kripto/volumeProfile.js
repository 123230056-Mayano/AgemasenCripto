"use strict";

/**
 * features/kripto/volumeProfile.js
 * ------------------------------------------------------------------
 * Volume Profile (gaya VPVR) dari leg swing high <-> swing low TERBARU. Logika MURNI: tanpa fetch,
 * tanpa kirim pesan, jadi bisa diuji unit (src/test/volume-profile.test.js). Dipakai !hhll (hhll.js).
 *
 * Alur:
 *   1. legRange     : rentang candle = dari swing pertama sampai swing kedua (high/low terakhir dari
 *                     computeStructure, urutan waktu tidak dipaksa: ambil yang lebih lama -> lebih baru).
 *   2. buildProfile : rentang harga (low terendah .. high tertinggi leg) dibagi BINS bin. Volume tiap
 *                     candle dibagi rata ke semua bin yang dilewati high-low-nya (proporsional terhadap
 *                     panjang irisan); candle tanpa range (h == l) masuk satu bin.
 *   3. POC          : bin dengan volume terbesar (harga = titik tengah bin).
 *   4. Value Area   : mulai dari POC, tambahkan bin tetangga yang volumenya lebih besar (atas / bawah,
 *                     dua bin sekaligus seperti metode TradingView) sampai >= VA_PCT persen total.
 *                     VAH = batas atas bin teratas VA, VAL = batas bawah bin terbawah VA.
 *
 * Data tanpa volume (forex dari Yahoo) -> mengembalikan null; pemanggil cukup melewati fitur ini.
 * Semua fungsi menerima candle closed: { t, o, h, l, c, v }.
 */

const { VOLUME_PROFILE_CONFIG: CFG } = require("../../config/indicatorConfig");

/**
 * Potong candle untuk leg swing terakhir.
 * @param {object[]} candles
 * @param {{i:number}|null} lastHigh
 * @param {{i:number}|null} lastLow
 * @returns {{from:number, to:number, candles:object[]}|null}
 */
function legRange(candles, lastHigh, lastLow) {
  if (!candles || !lastHigh || !lastLow) return null;
  const from = Math.min(lastHigh.i, lastLow.i);
  const to = Math.max(lastHigh.i, lastLow.i);
  if (!(from >= 0) || to >= candles.length) return null;
  const slice = candles.slice(from, to + 1);
  if (slice.length < CFG.MIN_CANDLES) return null;
  return { from, to, candles: slice };
}

/**
 * @param {object[]} legCandles candle di dalam leg (lama -> baru)
 * @param {{bins?:number, vaPct?:number}} [opts]
 * @returns {{
 *   low:number, high:number, binSize:number,
 *   bins:{lo:number, hi:number, mid:number, vol:number, inVA:boolean}[],
 *   total:number, maxVol:number,
 *   poc:{price:number, idx:number},
 *   vah:number, val:number
 * }|null}
 */
function buildProfile(legCandles, opts = {}) {
  const nBins = Math.max(4, opts.bins || CFG.BINS);
  const vaPct = opts.vaPct ?? CFG.VA_PCT;
  if (!legCandles || !legCandles.length) return null;

  let low = Infinity;
  let high = -Infinity;
  let anyVol = false;
  for (const c of legCandles) {
    if (!isFinite(c.h) || !isFinite(c.l)) return null;
    if (c.l < low) low = c.l;
    if (c.h > high) high = c.h;
    if (c.v > 0) anyVol = true;
  }
  if (!anyVol || !(high > low)) return null;

  const binSize = (high - low) / nBins;
  const vols = new Array(nBins).fill(0);
  const clampIdx = (p) => Math.min(nBins - 1, Math.max(0, Math.floor((p - low) / binSize)));

  for (const c of legCandles) {
    const v = c.v;
    if (!(v > 0)) continue;
    if (c.h <= c.l) {
      vols[clampIdx(c.l)] += v;
      continue;
    }
    const b0 = clampIdx(c.l);
    const b1 = clampIdx(c.h);
    const span = c.h - c.l;
    for (let b = b0; b <= b1; b++) {
      const binLo = low + b * binSize;
      const binHi = binLo + binSize;
      const overlap = Math.min(c.h, binHi) - Math.max(c.l, binLo);
      if (overlap > 0) vols[b] += v * (overlap / span);
    }
  }

  const total = vols.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;

  // POC: bin volume terbesar. Kalau kembar, ambil yang paling dekat tengah range (hasil lebih stabil).
  let pocIdx = 0;
  const mid = (nBins - 1) / 2;
  for (let b = 1; b < nBins; b++) {
    if (vols[b] > vols[pocIdx] || (vols[b] === vols[pocIdx] && Math.abs(b - mid) < Math.abs(pocIdx - mid))) pocIdx = b;
  }

  // Value Area: melebar dari POC, pilih sisi (2 bin) yang volumenya lebih besar sampai >= vaPct%.
  let lo = pocIdx;
  let hi = pocIdx;
  let acc = vols[pocIdx];
  const target = (total * vaPct) / 100;
  while (acc < target && (lo > 0 || hi < nBins - 1)) {
    const upSum = (hi + 1 < nBins ? vols[hi + 1] : 0) + (hi + 2 < nBins ? vols[hi + 2] : 0);
    const dnSum = (lo - 1 >= 0 ? vols[lo - 1] : 0) + (lo - 2 >= 0 ? vols[lo - 2] : 0);
    const canUp = hi < nBins - 1;
    const canDn = lo > 0;
    if (canUp && (!canDn || upSum >= dnSum)) {
      const add = Math.min(2, nBins - 1 - hi);
      for (let k = 1; k <= add; k++) acc += vols[hi + k];
      hi += add;
    } else {
      const add = Math.min(2, lo);
      for (let k = 1; k <= add; k++) acc += vols[lo - k];
      lo -= add;
    }
  }

  const bins = vols.map((vol, b) => {
    const bLo = low + b * binSize;
    return { lo: bLo, hi: bLo + binSize, mid: bLo + binSize / 2, vol, inVA: b >= lo && b <= hi };
  });

  return {
    low,
    high,
    binSize,
    bins,
    total,
    maxVol: Math.max(...vols),
    poc: { price: bins[pocIdx].mid, idx: pocIdx },
    vah: bins[hi].hi,
    val: bins[lo].lo,
  };
}

/**
 * Jalan pintas untuk !hhll: leg swing terakhir -> profile. null kalau data tidak cukup / tanpa volume.
 * @param {object[]} candles
 * @param {{lastHigh:object|null, lastLow:object|null}} st hasil computeStructure
 */
function volumeProfileForStructure(candles, st, opts = {}) {
  const leg = legRange(candles, st && st.lastHigh, st && st.lastLow);
  if (!leg) return null;
  const vp = buildProfile(leg.candles, opts);
  if (!vp) return null;
  return { ...vp, from: leg.from, to: leg.to };
}

/**
 * Dua profile sekaligus (cara baca: "sampai mana koreksinya"):
 *   macro : dari swing high acuan (swing high lebih tinggi tepat sebelum LH terbaru) sampai swing low terakhir.
 *           Ini profile besar seluruh turunan.
 *   lh    : dari Lower High (LH) terbaru sampai candle terakhir. Ini profile koreksi terbaru.
 * Harga tembus VAH profile LH -> peluang breakout / lanjut naik. Gagal tembus dan jatuh di bawah VAL -> balik ke dasar.
 * Syarat: ada swing high berlabel "LH" dan swing high acuan sebelumnya. Kalau tidak ada, macro = null dan
 * pemanggil memakai volumeProfileForStructure biasa; lh = null.
 * @param {object[]} candles
 * @param {{swings:object[], lastLow:object|null}} st hasil computeStructure
 * @returns {{macro:object|null, lh:object|null}}
 */
function dualVolumeProfiles(candles, st, opts = {}) {
  const none = { macro: null, lh: null };
  if (!candles || !candles.length || !st || !Array.isArray(st.swings)) return none;
  const highs = st.swings.filter((s) => s.type === "H");
  let lhIdx = -1;
  for (let k = highs.length - 1; k >= 0; k--) {
    if (highs[k].label === "LH") {
      lhIdx = k;
      break;
    }
  }
  if (lhIdx < 0) return none;
  const lhSwing = highs[lhIdx];

  // profile LH: dari pivot LH sampai candle terakhir
  let lh = null;
  const lhCandles = candles.slice(lhSwing.i);
  if (lhCandles.length >= CFG.MIN_CANDLES) {
    const p = buildProfile(lhCandles, opts);
    if (p) lh = { ...p, from: lhSwing.i, to: candles.length - 1, anchor: lhSwing.price };
  }

  // profile macro: swing high acuan (lebih tinggi dari LH, terdekat sebelum LH) -> swing low terakhir
  let ref = null;
  for (let k = lhIdx - 1; k >= 0; k--) {
    if (highs[k].price > lhSwing.price) {
      ref = highs[k];
      break;
    }
  }
  let macro = null;
  if (ref && st.lastLow && st.lastLow.i > ref.i) {
    const leg = legRange(candles, ref, st.lastLow);
    const p = leg && buildProfile(leg.candles, opts);
    if (p) macro = { ...p, from: leg.from, to: leg.to };
  }
  return { macro, lh };
}

/** "above" | "inside" | "below": posisi harga terhadap value area. */
function pricePosition(vp, price) {
  if (price > vp.vah) return "above";
  if (price < vp.val) return "below";
  return "inside";
}

module.exports = { CFG, legRange, buildProfile, volumeProfileForStructure, dualVolumeProfiles, pricePosition };
