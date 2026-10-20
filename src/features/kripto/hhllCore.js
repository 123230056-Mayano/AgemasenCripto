"use strict";

/**
 * features/kripto/hhllCore.js
 * ------------------------------------------------------------------
 * Logika MURNI market structure (Higher High / Higher Low / Lower High / Lower Low).
 * Tanpa fetch, tanpa kirim pesan, jadi bisa diuji unit (src/test/hhll.test.js).
 * Dipakai !hhll (hhll.js) dan alarm !alerthhll (hhllAlertCore.js).
 *
 * Alur:
 *   1. findPivots : pivot high/low = candle yang high/low-nya tertinggi/terendah dalam +-PIVOT_WIN candle.
 *                   Pivot baru sah setelah PIVOT_WIN candle di kanannya closed, jadi candle yang belum closed
 *                   tidak pernah memunculkan atau mengubah swing.
 *   2. buildSwings: pivot disusun selang-seling high-low-high-low. Dua pivot sejenis berurutan -> ambil yang lebih
 *                   ekstrem. Pivot yang gerak dari swing sebelumnya < MIN_SWING_PCT dibuang (noise).
 *   3. labelSwings: tiap swing high dibanding swing high sebelumnya (HH / LH / EH sama), tiap swing low
 *                   dibanding swing low sebelumnya (HL / LL / EL sama).
 *   4. trend      : swing high terakhir HH + swing low terakhir HL = "up"; LH + LL = "down"; selain itu "range".
 *
 * Semua fungsi menerima candle CLOSED urut lama -> baru: { t, o, h, l, c }.
 */

const { HHLL_CONFIG: CFG } = require("../../config/indicatorConfig");

/**
 * Pivot high/low. Urutan menurut index; kalau satu candle jadi pivot high DAN low (outside bar),
 * candle bullish: low dulu lalu high, candle bearish: high dulu lalu low.
 * @returns {{i:number, t:number, type:"H"|"L", price:number}[]}
 */
function findPivots(candles, win = CFG.PIVOT_WIN) {
  const out = [];
  const n = candles.length;
  for (let i = win; i <= n - 1 - win; i++) {
    const cur = candles[i];
    let isH = true;
    let isL = true;
    for (let k = 1; k <= win; k++) {
      // kiri: harus lebih ekstrem (>), kanan: boleh sama (>=) supaya deretan high yang sama cuma menghasilkan satu pivot
      if (!(cur.h > candles[i - k].h) || !(cur.h >= candles[i + k].h)) isH = false;
      if (!(cur.l < candles[i - k].l) || !(cur.l <= candles[i + k].l)) isL = false;
      if (!isH && !isL) break;
    }
    const hi = { i, t: cur.t, type: "H", price: cur.h };
    const lo = { i, t: cur.t, type: "L", price: cur.l };
    if (isH && isL) out.push(...(cur.c >= cur.o ? [lo, hi] : [hi, lo]));
    else if (isH) out.push(hi);
    else if (isL) out.push(lo);
  }
  return out;
}

/**
 * Susun pivot jadi swing selang-seling.
 * @param {number} minPct gerak minimal (persen) dari swing sebelumnya
 */
function buildSwings(pivots, minPct = CFG.MIN_SWING_PCT) {
  const swings = [];
  for (const p of pivots) {
    const last = swings[swings.length - 1];
    if (!last) {
      swings.push({ ...p });
      continue;
    }
    if (last.type === p.type) {
      // sejenis berurutan: simpan yang lebih ekstrem
      const better = p.type === "H" ? p.price > last.price : p.price < last.price;
      if (better) swings[swings.length - 1] = { ...p };
      continue;
    }
    const move = (Math.abs(p.price - last.price) / last.price) * 100;
    if (move < minPct) continue; // gerak terlalu kecil -> noise
    swings.push({ ...p });
  }
  return swings;
}

/**
 * Beri label tiap swing terhadap swing sejenis sebelumnya.
 * label: "HH" | "LH" | "EH" (high) / "HL" | "LL" | "EL" (low); swing sejenis pertama label-nya null.
 * @returns {{i:number,t:number,type:"H"|"L",price:number,label:string|null}[]}
 */
function labelSwings(swings, equalPct = CFG.EQUAL_PCT) {
  let prevH = null;
  let prevL = null;
  const eq = equalPct / 100;
  return swings.map((s) => {
    let label = null;
    if (s.type === "H") {
      if (prevH != null) label = s.price > prevH * (1 + eq) ? "HH" : s.price < prevH * (1 - eq) ? "LH" : "EH";
      prevH = s.price;
    } else {
      if (prevL != null) label = s.price > prevL * (1 + eq) ? "HL" : s.price < prevL * (1 - eq) ? "LL" : "EL";
      prevL = s.price;
    }
    return { ...s, label };
  });
}

/** "up" | "down" | "range" dari swing yang sudah berlabel. null kalau belum ada pasangan high & low berlabel. */
function trendOf(labeled) {
  const lastH = [...labeled].reverse().find((s) => s.type === "H" && s.label);
  const lastL = [...labeled].reverse().find((s) => s.type === "L" && s.label);
  if (!lastH || !lastL) return null;
  if (lastH.label === "HH" && lastL.label === "HL") return "up";
  if (lastH.label === "LH" && lastL.label === "LL") return "down";
  return "range";
}

/**
 * Struktur lengkap dari candle closed.
 * @returns {{
 *   swings: object[],        // berlabel, lama -> baru
 *   trend: "up"|"down"|"range"|null,
 *   lastHigh: object|null,   // swing high terakhir (apa pun labelnya)
 *   lastLow: object|null,
 *   lastHighLabel: string|null, lastLowLabel: string|null   // label swing high / low terakhir yang berlabel
 * }}
 */
function computeStructure(candles, opts = {}) {
  const win = opts.win || CFG.PIVOT_WIN;
  const swings = labelSwings(buildSwings(findPivots(candles, win), opts.minPct ?? CFG.MIN_SWING_PCT), opts.equalPct ?? CFG.EQUAL_PCT);
  const lastHigh = [...swings].reverse().find((s) => s.type === "H") || null;
  const lastLow = [...swings].reverse().find((s) => s.type === "L") || null;
  return {
    swings,
    trend: trendOf(swings),
    lastHigh,
    lastLow,
    lastHighLabel: lastHigh?.label ?? null,
    lastLowLabel: lastLow?.label ?? null,
  };
}

module.exports = { CFG, findPivots, buildSwings, labelSwings, trendOf, computeStructure };
