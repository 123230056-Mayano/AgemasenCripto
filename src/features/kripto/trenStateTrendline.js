"use strict";

/**
 * features/kripto/trenStateTrendline.js
 * ------------------------------------------------------------------
 * Trendline untuk !trenstate. Logika MURNI (tanpa fetch, tanpa kirim pesan, tanpa canvas), bisa diuji unit
 * (src/test/trenStateTrendline.test.js). Tujuannya membantu membaca arah saat pola / struktur tidak jelas
 * (RANGE, "koreksi, belum jelas"), dan memberi peringatan dini kalau garis tren patah sebelum struktur swing patah.
 *
 * Dua sumber garis, berurutan:
 *   1. GARIS SWING : garis lewat >= 2 swing sejenis (swing dari hhllCore, tidak ada pivot baru).
 *                    support = lewat swing low, resistance = lewat swing high. Dari semua pasangan swing terakhir
 *                    dipilih yang paling banyak sentuhannya, lalu yang paling baru. Garis GUGUR kalau ada close lama
 *                    yang melewatinya lebih dari TL_VIOL_ATR x ATR. Beberapa candle terakhir (TL_BREAK_MEMORY) boleh
 *                    sudah di seberang garis: itu artinya garis baru patah, dilaporkan sebagai tembus.
 *                    Kalau hanya satu sisi yang valid, sisi lawannya dibuat PARALEL (derived) lewat swing paling
 *                    ekstrem di seberangnya, asalnya lebar jalur >= TL_MIN_WIDTH_ATR x ATR.
 *   2. JALUR REGRESI: kalau tidak ada garis swing valid sama sekali. Regresi linear close TL_REG_BARS candle terakhir,
 *                    jalur = garis tengah +- TL_REG_K x simpangan baku residu. Selalu ada selama data cukup, jadi
 *                    "tidak ada pola" tetap menghasilkan arah kasar + batas jalur. R2 dilaporkan sebagai grade
 *                    kecocokan; R2 rendah = arah regresi tidak dijadikan condong.
 *
 * Aturan: hanya candle CLOSED, tanpa lookahead (swing sudah sah, tembus dinilai dari close). Hasil = alat bantu baca,
 * BUKAN sinyal dan TIDAK mengubah skor / status trenState (statistik backtest tetap berlaku). Semua ambang di
 * TRENSTATE_CONFIG (TL_*), nilai awal usulan, belum divalidasi backtest.
 *
 * Garis disimpan sebagai { i0, p0, slope }: harga pada index candle x = p0 + slope * (x - i0), index mengacu ke
 * array `closed` yang sama dengan yang dinilai (chart memakai array yang sama).
 */

const { TRENSTATE_CONFIG: CFG } = require("../../config/indicatorConfig");

const isNum = (v) => typeof v === "number" && isFinite(v);

/** Harga garis pada index x. */
const priceAt = (line, x) => line.p0 + line.slope * (x - line.i0);

/** Garis jadi objek hasil (serializable) dari jangkar + kemiringan. */
function makeLine({ i0, t0, p0, slope }, atr, n, extra) {
  return {
    i0,
    t0,
    p0,
    slope,
    slopeAtr: slope / atr, // ATR per candle
    dir: Math.abs(slope / atr) <= CFG.TL_FLAT_SLOPE_ATR ? "flat" : slope > 0 ? "up" : "down",
    levelNow: p0 + slope * (n - 1 - i0), // di candle terakhir
    levelNext: p0 + slope * (n - i0), // di candle berikutnya
    touches: 0,
    anchors: [],
    derived: false,
    ...extra,
  };
}

/**
 * Apakah garis masih "menahan": tidak ada CLOSE lama yang melewatinya lebih dari viol.
 * support (sup=true): close tidak boleh di bawah garis; resistance: tidak boleh di atas.
 * Candle terakhir sebanyak `mem` dikecualikan (boleh sudah menembus = baru patah).
 */
function holds(closed, line, sup, viol, mem) {
  const end = closed.length - 1 - mem;
  for (let k = Math.max(0, line.i0); k <= end; k++) {
    const c = closed[k].c;
    const p = priceAt(line, k);
    if (sup ? c < p - viol : c > p + viol) return false;
  }
  return true;
}

/** Swing yang menyentuh garis (jarak <= tol), hanya yang berada di/ sesudah jangkar pertama. */
function touching(swings, line, tol) {
  return swings.filter((s) => s.i >= line.i0 && Math.abs(s.price - priceAt(line, s.i)) <= tol);
}

/**
 * Garis terbaik lewat swing sejenis. type "L" = support, "H" = resistance. null kalau tidak ada yang valid.
 */
function bestSwingLine(closed, swings, type, atr) {
  const n = closed.length;
  const sup = type === "L";
  const pts = swings.filter((s) => s.type === type).slice(-CFG.TL_MAX_SWINGS);
  const viol = CFG.TL_VIOL_ATR * atr;
  const tol = CFG.TL_TOUCH_ATR * atr;
  let best = null;
  for (let x = 0; x < pts.length - 1; x++) {
    for (let y = x + 1; y < pts.length; y++) {
      const a = pts[x];
      const b = pts[y];
      if (b.i - a.i < CFG.TL_MIN_SPAN) continue;
      const slope = (b.price - a.price) / (b.i - a.i);
      const raw = { i0: a.i, t0: a.t, p0: a.price, slope };
      if (!(priceAt(raw, n - 1) > 0)) continue; // garis yang menembus nol tidak masuk akal
      if (!holds(closed, raw, sup, viol, CFG.TL_BREAK_MEMORY)) continue;
      const hit = touching(pts, raw, tol);
      if (hit.length < CFG.TL_MIN_TOUCHES) continue;
      const span = b.i - a.i;
      const score = hit.length * 10 + 4 * (b.i / n) + (3 * Math.min(span, 60)) / 60;
      if (!best || score > best.score) best = { score, raw, hit };
    }
  }
  if (!best) return null;
  return makeLine(best.raw, atr, n, {
    touches: best.hit.length,
    anchors: best.hit.map((s) => ({ i: s.i, t: s.t, price: s.price })),
  });
}

/**
 * Garis paralel di seberang `base` lewat swing paling ekstrem di sisi itu (channel turunan).
 * oppType "H" = garis atas dari base support; "L" = garis bawah dari base resistance.
 */
function parallelLine(closed, swings, base, oppType, atr) {
  const n = closed.length;
  const upper = oppType === "H";
  const cand = swings.filter((s) => s.type === oppType && s.i >= base.i0);
  if (!cand.length) return null;
  let pick = null;
  let off = upper ? -Infinity : Infinity;
  for (const s of cand) {
    const d = s.price - priceAt(base, s.i);
    if (upper ? d > off : d < off) {
      off = d;
      pick = s;
    }
  }
  if (!pick || Math.abs(off) < CFG.TL_MIN_WIDTH_ATR * atr) return null;
  if (upper ? off <= 0 : off >= 0) return null; // swing harus benar-benar di seberang
  const raw = { i0: base.i0, t0: base.t0, p0: base.p0 + off, slope: base.slope };
  if (!(priceAt(raw, n - 1) > 0)) return null;
  // jalur turunan hanya dipakai kalau close tidak menembus garis seberang ini dengan jauh
  if (!holds(closed, raw, !upper, CFG.TL_VIOL_ATR * atr, CFG.TL_BREAK_MEMORY)) return null;
  const hit = touching(cand, raw, CFG.TL_TOUCH_ATR * atr);
  return makeLine(raw, atr, n, {
    derived: true,
    touches: hit.length,
    anchors: hit.map((s) => ({ i: s.i, t: s.t, price: s.price })),
  });
}

/** Jalur regresi linear dari close terakhir. null kalau data < 20 candle atau tanpa variasi. */
function regressionChannel(closed, atr) {
  const n = closed.length;
  const m = Math.min(CFG.TL_REG_BARS, n);
  if (m < 20) return null;
  const s = n - m;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let k = 0; k < m; k++) {
    const y = closed[s + k].c;
    sx += k;
    sy += y;
    sxx += k * k;
    sxy += k * y;
  }
  const den = m * sxx - sx * sx;
  const slope = den ? (m * sxy - sx * sy) / den : 0;
  const icpt = (sy - slope * sx) / m;
  const my = sy / m;
  let ssr = 0;
  let sst = 0;
  for (let k = 0; k < m; k++) {
    const y = closed[s + k].c;
    ssr += (y - (icpt + slope * k)) ** 2;
    sst += (y - my) ** 2;
  }
  const sd = Math.sqrt(ssr / m);
  if (!(sd > 0)) return null;
  const r2 = sst > 0 ? Math.max(0, 1 - ssr / sst) : 0;
  const midNow = icpt + slope * (m - 1);
  const half = CFG.TL_REG_K * sd;
  const close = closed[n - 1].c;
  return {
    i0: s,
    t0: closed[s].t,
    p0: icpt,
    slope,
    slopeAtr: slope / atr,
    dir: Math.abs(slope / atr) <= CFG.TL_FLAT_SLOPE_ATR ? "flat" : slope > 0 ? "up" : "down",
    bars: m,
    sd,
    k: CFG.TL_REG_K,
    half,
    r2,
    fit: r2 >= 0.6 ? "strong" : r2 >= CFG.TL_REG_MIN_R2 ? "medium" : "weak",
    midNow,
    upperNow: midNow + half,
    lowerNow: midNow - half,
    z: (close - midNow) / sd,
  };
}

/**
 * Posisi close terhadap garis swing (support / resistance boleh salah satu null).
 * pos: breakUp | breakDown | nearSupport | nearResistance | inside | aboveSupport | belowResistance
 * dSup / dRes = (close - level) / ATR (bertanda).
 */
function swingPosition(close, sup, res, atr) {
  const brk = CFG.TL_BREAK_ATR * atr;
  const near = CFG.TL_NEAR_ATR * atr;
  const supNow = sup ? sup.levelNow : null;
  const resNow = res ? res.levelNow : null;
  const dSup = supNow != null ? (close - supNow) / atr : null;
  const dRes = resNow != null ? (close - resNow) / atr : null;
  let pos;
  if (res && close > resNow + brk) pos = "breakUp";
  else if (sup && close < supNow - brk) pos = "breakDown";
  else {
    const nearSup = sup && close >= supNow - brk && close - supNow <= near;
    const nearRes = res && close <= resNow + brk && resNow - close <= near;
    if (nearSup && nearRes) pos = close - supNow <= resNow - close ? "nearSupport" : "nearResistance";
    else if (nearSup) pos = "nearSupport";
    else if (nearRes) pos = "nearResistance";
    else pos = sup && res ? "inside" : sup ? "aboveSupport" : "belowResistance";
  }
  return { pos, dSup, dRes };
}

/**
 * Trendline lengkap untuk candle closed terakhir.
 * @param {object[]} closed candle closed urut lama -> baru { t, o, h, l, c }
 * @param {object[]} swings swing dari computeStructure(closed).swings
 * @param {{atr:number, dir?:"up"|"down"|null}} opts dir = tren asal (null = range / tidak jelas)
 * @returns {null|{
 *   mode:"swing"|"regression", support:object|null, resistance:object|null, regression:object|null,
 *   pos:string, dSup:number|null, dRes:number|null,
 *   lean:{dir:"up"|"down", basis:"break"|"edge"|"slope", level:number|null}|null,
 *   breakAgainst:boolean, breakLevel:number|null
 * }}
 */
function computeTrendlines(closed, swings, opts = {}) {
  const n = closed ? closed.length : 0;
  const atr = opts.atr;
  if (!n || !isNum(atr) || !(atr > 0)) return null;
  const dir = opts.dir === "up" || opts.dir === "down" ? opts.dir : null;
  const close = closed[n - 1].c;
  const sw = Array.isArray(swings) ? swings : [];

  let support = bestSwingLine(closed, sw, "L", atr);
  let resistance = bestSwingLine(closed, sw, "H", atr);
  if (support && !resistance) resistance = parallelLine(closed, sw, support, "H", atr);
  else if (resistance && !support) support = parallelLine(closed, sw, resistance, "L", atr);

  const regression = regressionChannel(closed, atr);

  if (support || resistance) {
    const { pos, dSup, dRes } = swingPosition(close, support, resistance, atr);
    let lean = null;
    if (pos === "breakUp") lean = { dir: "up", basis: "break", level: resistance.levelNow };
    else if (pos === "breakDown") lean = { dir: "down", basis: "break", level: support.levelNow };
    else if (pos === "nearSupport") lean = { dir: "up", basis: "edge", level: support.levelNow };
    else if (pos === "nearResistance") lean = { dir: "down", basis: "edge", level: resistance.levelNow };
    // garis lawan tren patah padahal struktur swing belum patah = peringatan dini
    const breakAgainst = (dir === "up" && pos === "breakDown") || (dir === "down" && pos === "breakUp");
    return {
      mode: "swing",
      support,
      resistance,
      regression,
      pos,
      dSup,
      dRes,
      lean,
      breakAgainst,
      breakLevel: breakAgainst ? (dir === "up" ? support.levelNow : resistance.levelNow) : null,
    };
  }

  if (!regression) return null;
  const pos = regression.z >= 1 ? "regUpper" : regression.z <= -1 ? "regLower" : "regMid";
  const usable = regression.dir !== "flat" && regression.r2 >= CFG.TL_REG_MIN_R2;
  const lean = usable
    ? { dir: regression.dir, basis: "slope", level: regression.dir === "up" ? regression.lowerNow : regression.upperNow }
    : null;
  return { mode: "regression", support: null, resistance: null, regression, pos, dSup: null, dRes: null, lean, breakAgainst: false, breakLevel: null };
}

module.exports = { CFG, priceAt, holds, bestSwingLine, parallelLine, regressionChannel, swingPosition, computeTrendlines };
