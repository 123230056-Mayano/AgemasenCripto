"use strict";

/**
 * features/kripto/linePatterns.js
 * ------------------------------------------------------------------
 * Fase 5 (Tahap C, bagian GARIS): segitiga naik / turun / simetris, wedge naik / turun, channel (konteks), flag.
 * Logika MURNI, belum tersambung ke bot. Paling rawan subjektif, jadi nilainya HARUS diputuskan backtest (patternBacktest.js).
 *
 * Garis: kuadrat terkecil ke swing H dan swing L (swing dari hhllCore, tidak ada pivot kedua). Sentuhan = jarak swing ke
 * garis <= LN_TOUCH_ATR x ATR. Kemiringan dalam ATR per candle. Menyempit = lebar akhir <= LN_CONTRACT_RATIO x lebar awal.
 *   segitiga naik  : garis atas rata, bawah naik     (condong bullish)
 *   segitiga turun : bawah rata, atas turun          (condong bearish)
 *   segitiga simetris: atas turun, bawah naik        (netral sampai tembus)
 *   rising wedge   : dua garis naik, menyempit       (condong bearish)
 *   falling wedge  : dua garis turun, menyempit      (condong bullish)
 *   channel        : dua garis sejajar, tidak menyempit; konteks, tidak pernah jadi sinyal (dir netral, tidak diuji backtest)
 * Konfirmasi = close menembus garis (arah = sisi tembus); batal = close kembali melewati level tembus.
 * Flag: impuls >= FLAG_POLE_ATR x ATR dalam <= FLAG_POLE_BARS candle, koreksi <= FLAG_RETRACE_MAX x impuls selama
 * FLAG_MIN_BARS..FLAG_MAX_BARS candle, konfirmasi = close melewati ujung impuls. Flag dan pennant tidak dibedakan (satu kind "flag").
 * Tanpa lookahead: hanya swing sah dan candle closed. Target dari titik tembus, bukan dari ujung pola.
 */

const { PATTERN_CONFIG: CFG } = require("../../config/indicatorConfig");
const { CFG: HHLL_CFG } = require("./hhllCore");
const core = require("./patternCore");

const { STATUS, DIR, FAMILY } = core;
const isNum = (v) => typeof v === "number" && isFinite(v);
const WIN = HHLL_CFG.PIVOT_WIN;
const knownI = (s) => s.i + WIN;

/** Garis kuadrat terkecil; x dipusatkan supaya stabil secara numerik. */
function fitLine(pts) {
  const n = pts.length;
  const x0 = pts[0].x;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const x = p.x - x0;
    sx += x; sy += p.y; sxx += x * x; sxy += x * p.y;
  }
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const icpt = (sy - slope * sx) / n;
  return { slope, at: (x) => icpt + slope * (x - x0) };
}

/** Klasifikasi dua garis (kemiringan dalam ATR/candle). null bila bukan pola yang dikenali. */
function classify(sU, sL, contracting) {
  const flat = (s) => Math.abs(s) <= CFG.LN_FLAT_SLOPE_ATR;
  const fU = flat(sU);
  const fL = flat(sL);
  if (contracting) {
    if (fU && sL > CFG.LN_FLAT_SLOPE_ATR) return { kind: "triangleAscending", dir: DIR.BULL };
    if (fL && sU < -CFG.LN_FLAT_SLOPE_ATR) return { kind: "triangleDescending", dir: DIR.BEAR };
    if (sU < -CFG.LN_FLAT_SLOPE_ATR && sL > CFG.LN_FLAT_SLOPE_ATR) return { kind: "triangleSymmetric", dir: DIR.NEUTRAL };
    if (sU > CFG.LN_FLAT_SLOPE_ATR && sL > CFG.LN_FLAT_SLOPE_ATR) return { kind: "risingWedge", dir: DIR.BEAR };
    if (sU < -CFG.LN_FLAT_SLOPE_ATR && sL < -CFG.LN_FLAT_SLOPE_ATR) return { kind: "fallingWedge", dir: DIR.BULL };
    return null;
  }
  if (Math.abs(sU - sL) <= CFG.LN_PARALLEL_TOL && !(fU && fL)) return { kind: sU > 0 ? "channelUp" : sU < 0 ? "channelDown" : "channelFlat", dir: DIR.NEUTRAL, channel: true };
  return null;
}

function detectConverging(ctx) {
  const { swings, atr, candles, lastI } = ctx;
  if (swings.length < 4) return [];
  let best = null;
  const lastK = swings.length - 1;
  for (let endK = lastK; endK >= Math.max(3, lastK - 1); endK--) {
    for (let size = Math.min(CFG.LN_MAX_SWINGS, endK + 1); size >= 4; size--) {
      const win = swings.slice(endK - size + 1, endK + 1);
      const hs = win.filter((s) => s.type === "H");
      const ls = win.filter((s) => s.type === "L");
      if (hs.length < 2 || ls.length < 2) continue;
      const kI = knownI(win[win.length - 1]);
      if (kI > lastI) continue;
      const A = atr[kI];
      if (!isNum(A) || A <= 0) continue;
      const x0 = win[0].i;
      const x1 = win[win.length - 1].i;
      if (x1 - x0 < CFG.LN_MIN_BARS) continue;
      const up = fitLine(hs.map((s) => ({ x: s.i, y: s.price })));
      const lo = fitLine(ls.map((s) => ({ x: s.i, y: s.price })));
      const wStart = up.at(x0) - lo.at(x0);
      const wEnd = up.at(x1) - lo.at(x1);
      if (wStart < CFG.LN_MIN_HEIGHT_ATR * A || wEnd <= 0) continue;
      const touches = hs.filter((s) => Math.abs(s.price - up.at(s.i)) <= CFG.LN_TOUCH_ATR * A).length + ls.filter((s) => Math.abs(s.price - lo.at(s.i)) <= CFG.LN_TOUCH_ATR * A).length;
      if (touches < CFG.LN_MIN_TOUCHES) continue;
      const cls = classify(up.slope / A, lo.slope / A, wEnd <= CFG.LN_CONTRACT_RATIO * wStart);
      if (!cls) continue;
      if (!best || size > best.win.length || (size === best.win.length && endK > best.endK)) best = { win, endK, up, lo, kI, A, wStart, touches, cls, x0, x1 };
      break; // ukuran terbesar yang lolos untuk endK ini
    }
  }
  if (!best) return [];
  const { win, up, lo, kI, A, wStart, touches, cls } = best;
  let status = STATUS.CANDIDATE;
  let dir = cls.dir;
  let confirmI = null;
  let confirmPrice = null;
  let brkLevel = null;
  for (let i = kI + 1; i <= lastI; i++) {
    const c = candles[i].c;
    const u = up.at(i);
    const l = lo.at(i);
    if (status === STATUS.CANDIDATE) {
      if (cls.channel) {
        if (c > u + A || c < l - A) status = STATUS.INVALIDATED; // channel dilanggar jauh: konteks tidak berlaku lagi
        continue;
      }
      if (u <= l) {
        status = STATUS.INVALIDATED; // dua garis bersilang: pola kedaluwarsa tanpa tembus
        break;
      }
      if (c > u) [status, dir, confirmI, confirmPrice, brkLevel] = [STATUS.CONFIRMED, DIR.BULL, i, c, u];
      else if (c < l) [status, dir, confirmI, confirmPrice, brkLevel] = [STATUS.CONFIRMED, DIR.BEAR, i, c, l];
    } else if (status === STATUS.CONFIRMED) {
      if (dir === DIR.BULL ? c <= brkLevel : c >= brkLevel) status = STATUS.INVALIDATED; // kembali ke dalam pola
    }
  }
  const xl = candles.length ? Math.min(lastI, Math.max(kI, win[win.length - 1].i)) : lastI;
  const uNow = up.at(lastI);
  const lNow = lo.at(lastI);
  const bull = dir === DIR.BULL;
  const confirmed = status === STATUS.CONFIRMED || (status === STATUS.INVALIDATED && confirmI != null);
  const p = core.makePattern({
    kind: cls.kind,
    family: FAMILY.LINE,
    dir,
    startI: win[0].i,
    endI: win[win.length - 1].i,
    keyIdx: win.map((s) => s.i),
    status,
    confirmLevel: confirmed ? brkLevel : bull || dir === DIR.NEUTRAL ? uNow : lNow,
    invalidLevel: confirmed ? brkLevel : bull || dir === DIR.NEUTRAL ? lNow : uNow,
    confirmPrice,
    target: isNum(confirmPrice) ? (bull ? confirmPrice + wStart : confirmPrice - wStart) : null,
    evidence: [
      { sign: "+", text: "lineTouches", key: "lineTouches", params: { n: touches } },
      ...(touches >= CFG.LN_MIN_TOUCHES + 2 ? [{ sign: "+", text: "manyTouches", key: "manyTouches", params: { n: touches } }] : []),
    ],
  });
  p.knownI = kI;
  p.confirmI = confirmI;
  p.lines = { upper: { i1: win[0].i, p1: up.at(win[0].i), i2: lastI, p2: uNow }, lower: { i1: win[0].i, p1: lo.at(win[0].i), i2: lastI, p2: lNow } };
  p.pts = win.map((s) => ({ i: s.i, price: s.price, role: "line" }));
  p.height = wStart;
  void xl;
  return [p];
}

function volMean(cs, a, b) {
  let s = 0, n = 0;
  for (let i = a; i <= b; i++) if (isNum(cs[i]?.v)) { s += cs[i].v; n++; }
  return n ? s / n : null;
}

function detectFlags(ctx) {
  const { candles, atr, lastI } = ctx;
  const out = [];
  const from = Math.max(CFG.FLAG_POLE_BARS, lastI - CFG.FLAG_SCAN_BARS);
  for (let b = from; b <= lastI - CFG.FLAG_MIN_BARS; b++) {
    const A = atr[b];
    if (!isNum(A) || A <= 0) continue;
    for (const bull of [true, false]) {
      let a = b - CFG.FLAG_POLE_BARS;
      for (let k = a; k <= b; k++) if (bull ? candles[k].l < candles[a].l : candles[k].h > candles[a].h) a = k;
      if (a >= b) continue;
      let top = -Infinity, bot = Infinity;
      for (let k = a; k <= b; k++) { top = Math.max(top, candles[k].h); bot = Math.min(bot, candles[k].l); }
      if (bull ? candles[b].h < top : candles[b].l > bot) continue; // ujung impuls harus ekstrem di dalam impuls
      const move = top - bot;
      if (move < CFG.FLAG_POLE_ATR * A) continue;
      const end = bull ? top : bot;
      const retrLvl = bull ? end - CFG.FLAG_RETRACE_MAX * move : end + CFG.FLAG_RETRACE_MAX * move;
      let status = STATUS.CANDIDATE;
      let confirmI = null, confirmPrice = null, brkI = null, dead = false;
      for (let i = b + 1; i <= lastI; i++) {
        const c = candles[i].c;
        if (status === STATUS.CANDIDATE) {
          if (bull ? c > end : c < end) {
            if (i - b - 1 < CFG.FLAG_MIN_BARS) { dead = true; break; } // tembus terlalu cepat: bukan flag
            [status, confirmI, confirmPrice] = [STATUS.CONFIRMED, i, c];
          } else if (bull ? c < retrLvl : c > retrLvl) { status = STATUS.INVALIDATED; brkI = i; break; } // koreksi terlalu dalam
          else if (i - b > CFG.FLAG_MAX_BARS) { dead = true; break; } // kedaluwarsa
        } else if (status === STATUS.CONFIRMED && (bull ? c <= end : c >= end)) { status = STATUS.INVALIDATED; break; }
      }
      if (dead) continue;
      if (status === STATUS.INVALIDATED && confirmI == null) continue; // koreksi terlalu dalam = bukan flag, bukan sampel
      if (status === STATUS.CANDIDATE && lastI - b < CFG.FLAG_MIN_BARS) continue;
      const pv = volMean(candles, a, b);
      const cv = volMean(candles, b + 1, confirmI != null ? confirmI - 1 : lastI);
      const ev = [{ sign: "+", text: "pole", key: "pole", params: { atr: Number((move / A).toFixed(1)) } }];
      if (pv != null && cv != null) ev.push(cv < pv ? { sign: "+", text: "volDryUp", key: "volDryUp" } : { sign: "-", text: "volNotDry", key: "volNotDry" });
      const dir = bull ? DIR.BULL : DIR.BEAR;
      const p = core.makePattern({
        kind: "flag", family: FAMILY.LINE, dir, startI: a, endI: confirmI != null ? confirmI - 1 : lastI, keyIdx: [a, b],
        status, confirmLevel: end, invalidLevel: retrLvl, confirmPrice,
        target: isNum(confirmPrice) ? (bull ? confirmPrice + move : confirmPrice - move) : null,
        evidence: ev,
      });
      p.knownI = b + CFG.FLAG_MIN_BARS;
      p.confirmI = confirmI;
      p.pole = { a, b, move };
      void brkI;
      out.push(p);
    }
  }
  return out;
}

/**
 * Pindai pola garis pada candle closed.
 * @returns {{ok:false, reason:string, have:number, need:number} | {ok:true, patterns:object[], absorbed:object[], dropped:object[], invalidated:number, atrLast:number, lastI:number, lastT:number}}
 */
function scanLinePatterns(candles, opts = {}) {
  const prep = core.prepare(candles);
  if (!prep.ok) return prep;
  const lastI = candles.length - 1;
  const ctx = { candles, atr: prep.atr, swings: prep.swings, lastI };
  const raw = [...detectConverging(ctx), ...detectFlags(ctx)];
  const fresh = raw.filter((p) => {
    if (p.status === STATUS.INVALIDATED) return true;
    if (p.status === STATUS.CANDIDATE) return lastI - (p.knownI ?? p.endI) <= CFG.SW_CANDIDATE_BARS;
    return lastI - (p.confirmI ?? p.endI) <= CFG.SW_RECENT_BARS;
  });
  const res = core.resolvePatterns(fresh, prep.atrLast);
  const invalidated = res.kept.filter((p) => p.status === STATUS.INVALIDATED).length;
  const patterns = res.kept.filter((p) => p.status !== STATUS.INVALIDATED).sort((a, b) => (b.confirmI ?? b.endI) - (a.confirmI ?? a.endI));
  return { ok: true, patterns, absorbed: res.absorbed, dropped: res.dropped, invalidated, atrLast: prep.atrLast, lastI, lastT: candles[lastI].t };
}

module.exports = { fitLine, classify, detectConverging, detectFlags, scanLinePatterns };
