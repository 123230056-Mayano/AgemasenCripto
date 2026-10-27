"use strict";

/**
 * features/kripto/zonePatterns.js
 * ------------------------------------------------------------------
 * Fase 5 (Tahap C, bagian ZONA): Fair Value Gap dan Order Block. Logika MURNI, belum tersambung ke bot.
 * Hasilnya ZONA + STATUS, bukan label sinyal.
 *
 * Konvensi (agar cocok dengan makePattern): confirmLevel = ujung DEKAT zona (tempat harga kembali menyentuh),
 * invalidLevel = ujung JAUH zona. Status core: CANDIDATE = zona masih hidup, INVALIDATED = close menembus ujung jauh.
 * Status zona sendiri ada di p.zoneState: "untouched" | "partial" | "filled" (sumbu mencapai ujung jauh).
 *
 *   FVG bullish : low candle e > high candle e-2; gap >= ZN_GAP_ATR x ATR; range candle e-1 >= ZN_IMPULSE_ATR x ATR.
 *   Order block : impuls >= ZN_OB_IMPULSE_ATR x ATR dalam <= ZN_OB_IMPULSE_BARS candle yang close PERTAMA-nya melewati
 *                 swing terakhir (BOS); zona = BODY candle berlawanan terakhir sebelum/di dasar impuls. Sah karena BOS
 *                 sudah menjadi syarat deteksi (bukan filter terpisah).
 * Tanpa lookahead: zona terbentuk di candle e hanya memakai candle <= e dan swing yang sudah sah.
 */

const { PATTERN_CONFIG: CFG } = require("../../config/indicatorConfig");
const { CFG: HHLL_CFG } = require("./hhllCore");
const core = require("./patternCore");

const { STATUS, DIR, FAMILY } = core;
const isNum = (v) => typeof v === "number" && isFinite(v);
const WIN = HHLL_CFG.PIVOT_WIN;

/** Putar ulang candle setelah zona terbentuk: sentuhan pertama, status zona, batal. */
function replayZone(p, candles, from, lastI) {
  const bull = p.dir === DIR.BULL;
  p.zoneState = "untouched";
  p.firstTouchI = null;
  for (let i = from; i <= lastI; i++) {
    const c = candles[i];
    if (bull ? c.c < p.zone.bottom : c.c > p.zone.top) {
      p.status = STATUS.INVALIDATED;
      if (p.firstTouchI == null) p.firstTouchI = i;
      break;
    }
    const touched = bull ? c.l <= p.zone.top : c.h >= p.zone.bottom;
    if (!touched) continue;
    if (p.firstTouchI == null) p.firstTouchI = i;
    const filled = bull ? c.l <= p.zone.bottom : c.h >= p.zone.top;
    if (filled) p.zoneState = "filled";
    else if (p.zoneState !== "filled") p.zoneState = "partial";
  }
  return p;
}

function mkZone({ kind, dir, startI, endI, top, bottom, atr, extra = {}, evidence = [] }) {
  const bull = dir === DIR.BULL;
  const p = core.makePattern({
    kind,
    family: FAMILY.ZONE,
    dir,
    startI,
    endI,
    status: STATUS.CANDIDATE,
    confirmLevel: bull ? top : bottom,
    invalidLevel: bull ? bottom : top,
    evidence,
  });
  p.zone = { top, bottom, sizeAtr: Number(((top - bottom) / atr).toFixed(2)) };
  p.formedI = endI;
  p.knownI = endI;
  Object.assign(p, extra);
  return p;
}

/** FVG yang selesai terbentuk TEPAT di candle e (3 candle: e-2, e-1, e). */
function fvgAt(candles, atr, e) {
  if (e < 2) return null;
  const A = atr[e];
  if (!isNum(A) || A <= 0) return null;
  const c1 = candles[e - 2];
  const c2 = candles[e - 1];
  const c3 = candles[e];
  if (c2.h - c2.l < CFG.ZN_IMPULSE_ATR * A) return null;
  if (c3.l > c1.h && c3.l - c1.h >= CFG.ZN_GAP_ATR * A) {
    return mkZone({ kind: "fvg", dir: DIR.BULL, startI: e - 2, endI: e, top: c3.l, bottom: c1.h, atr: A, evidence: [{ sign: "+", text: "gapSize", key: "gapSize", params: { atr: Number(((c3.l - c1.h) / A).toFixed(2)) } }] });
  }
  if (c3.h < c1.l && c1.l - c3.h >= CFG.ZN_GAP_ATR * A) {
    return mkZone({ kind: "fvg", dir: DIR.BEAR, startI: e - 2, endI: e, top: c1.l, bottom: c3.h, atr: A, evidence: [{ sign: "+", text: "gapSize", key: "gapSize", params: { atr: Number(((c1.l - c3.h) / A).toFixed(2)) } }] });
  }
  return null;
}

/** Order block yang BOS-nya terjadi TEPAT di candle e. swings = swing yang sudah sah di e. */
function orderBlockAt(candles, atr, swings, e) {
  const A = atr[e];
  if (e < 2 || !isNum(A) || A <= 0) return null;
  const known = swings.filter((s) => s.i + WIN <= e);
  const lastH = [...known].reverse().find((s) => s.type === "H");
  const lastL = [...known].reverse().find((s) => s.type === "L");
  const from = Math.max(0, e - CFG.ZN_OB_IMPULSE_BARS + 1);
  const c = candles[e].c;
  const prev = candles[e - 1].c;
  for (const bull of [true, false]) {
    const sw = bull ? lastH : lastL;
    if (!sw) continue;
    if (bull ? !(c > sw.price && prev <= sw.price) : !(c < sw.price && prev >= sw.price)) continue; // close PERTAMA melewati swing
    let j = from;
    for (let k = from; k <= e; k++) if (bull ? candles[k].l < candles[j].l : candles[k].h > candles[j].h) j = k;
    let move = 0;
    for (let k = j; k <= e; k++) move = Math.max(move, bull ? candles[k].h - candles[j].l : candles[j].h - candles[k].l);
    if (move < CFG.ZN_OB_IMPULSE_ATR * A) continue;
    let k = null;
    for (let x = j; x >= Math.max(0, j - CFG.ZN_OB_BACK); x--) {
      if (bull ? candles[x].c < candles[x].o : candles[x].c > candles[x].o) {
        k = x;
        break;
      }
    }
    if (k == null) continue;
    const top = Math.max(candles[k].o, candles[k].c);
    const bottom = Math.min(candles[k].o, candles[k].c);
    if (!(top > bottom)) continue;
    return mkZone({
      kind: "orderBlock", dir: bull ? DIR.BULL : DIR.BEAR, startI: k, endI: e, top, bottom, atr: A,
      extra: { bosI: e, bosLevel: sw.price },
      evidence: [{ sign: "+", text: "impulse", key: "impulse", params: { atr: Number((move / A).toFixed(1)) } }],
    });
  }
  return null;
}

/**
 * Pindai zona yang masih hidup di candle closed terakhir.
 * @returns {{ok:false, reason:string, have:number, need:number} | {ok:true, patterns:object[], invalidated:number, atrLast:number, lastI:number, lastT:number}}
 */
function scanZones(candles, opts = {}) {
  const prep = core.prepare(candles, { minSwings: 0 });
  if (!prep.ok) return prep;
  const lastI = candles.length - 1;
  const from = Math.max(2, lastI - CFG.ZN_MAX_AGE + 1);
  const raw = [];
  for (let e = from; e <= lastI; e++) {
    const f = fvgAt(candles, prep.atr, e);
    if (f) raw.push(f);
    const o = orderBlockAt(candles, prep.atr, prep.swings, e);
    if (o) raw.push(o);
  }
  let invalidated = 0;
  const patterns = [];
  for (const p of raw) {
    replayZone(p, candles, p.formedI + 1, lastI);
    if (p.status === STATUS.INVALIDATED) {
      invalidated++;
      continue;
    }
    p.grade = core.gradeOf(p, prep.atrLast);
    patterns.push(p);
  }
  patterns.sort((a, b) => b.formedI - a.formedI);
  return { ok: true, patterns, invalidated, atrLast: prep.atrLast, lastI, lastT: candles[lastI].t };
}

module.exports = { replayZone, fvgAt, orderBlockAt, scanZones };
