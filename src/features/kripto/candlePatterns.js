"use strict";

/**
 * features/kripto/candlePatterns.js
 * ------------------------------------------------------------------
 * Fase 1 pengenal pola: CANDLESTICK (catatan saran "Pengenalan Pola", Tahap A + aturan konteks).
 * Logika MURNI: tanpa fetch, tanpa kirim pesan, tanpa canvas -> bisa diuji unit (src/test/candlePatterns.test.js).
 * Memakai fondasi patternCore.js (makePattern, resolvePatterns, prepare) dan config PATTERN_CONFIG.
 *
 * Pola: engulfing, pin bar (hammer / hanging man / shooting star / inverted hammer), doji (+ dragonfly / gravestone /
 * long-legged / spinning top sebagai KETERANGAN), morning / evening star, inside bar, tweezer top / bottom, harami,
 * piercing line / dark cloud cover, marubozu (+ belt hold sebagai keterangan), three white soldiers / three black crows,
 * rising / falling three methods.
 *
 * Aturan:
 *   - Hanya candle CLOSED. Detektor untuk candle e hanya membaca candle 0..e dan irisan swing/level sampai e (tanpa lookahead).
 *   - Ukuran dalam ATR dan rasio body/range. Semua ambang di PATTERN_CONFIG (nilai awal usulan, belum tervalidasi).
 *   - Konteks wajib: pola dihitung hanya di ekstrem (low/high berjalan, swing terkonfirmasi, atau zona SNR). Tanpa konteks = tidak dilaporkan.
 *     "Keluar dari range" (marubozu, three soldiers/crows) hanya sah bila struktur sebelum pola memang "range" menurut hhllCore;
 *     di tren yang sedang berjalan, close di low/high baru bukan keluar range (kalau tidak, tiap tiga candle merah di tren turun jadi "three black crows").
 *   - Pola = bukti bersyarat: level konfirmasi (close menembus ujung pola) dan level batal (close melewati ujung sebaliknya).
 *   - Dua tahap: CALON (baru terbentuk) -> TERKONFIRMASI (close menembus) atau BATAL. Hanya hasil, bukan sinyal beli/jual.
 */

const { PATTERN_CONFIG: CFG } = require("../../config/indicatorConfig");
const { computeStructure } = require("./hhllCore");
const { wickReject } = require("./suddenMove");
const core = require("./patternCore");

const { STATUS, DIR, FAMILY } = core;
const isNum = (v) => typeof v === "number" && isFinite(v);

// ------------------------------------------------------------------
// Geometri satu candle
// ------------------------------------------------------------------

function geo(c) {
  const range = c.h - c.l;
  const top = Math.max(c.o, c.c);
  const bot = Math.min(c.o, c.c);
  const body = top - bot;
  return {
    range,
    top,
    bot,
    body,
    up: c.c > c.o,
    down: c.c < c.o,
    upper: c.h - top,
    lower: bot - c.l,
    bodyPct: range > 0 ? body / range : 0,
    upperPct: range > 0 ? (c.h - top) / range : 0,
    lowerPct: range > 0 ? (bot - c.l) / range : 0,
  };
}

/** Gerak searah sebelum candle f: PRIOR_MOVE_BARS close beruntun menurun ("down") / menaik ("up"). */
function priorMove(cs, f, dir) {
  const n = CFG.PRIOR_MOVE_BARS;
  if (f - n - 1 < 0) return false;
  for (let k = 1; k <= n; k++) {
    const a = cs[f - k].c;
    const b = cs[f - k - 1].c;
    if (dir === "down" ? !(a < b) : !(a > b)) return false;
  }
  return true;
}

function volRatio(cs, e) {
  const prev = cs.slice(Math.max(0, e - CFG.EV_VOL_LOOKBACK), e);
  if (!isNum(cs[e]?.v) || prev.length < Math.min(CFG.EV_VOL_LOOKBACK, 5)) return null;
  const mean = prev.reduce((a, c) => a + (isNum(c.v) ? c.v : 0), 0) / prev.length;
  return mean > 0 ? cs[e].v / mean : null;
}

// ------------------------------------------------------------------
// Lingkungan per candle e (semua dipotong sampai e: tanpa lookahead)
// ------------------------------------------------------------------

/**
 * @param {object[]} candles candle closed, lama -> baru
 * @param {(number|null)[]} atr seri ATR sejajar candles
 * @param {number} e index candle penutup pola
 * @param {{levelsFn?:Function, levels?:object, htfTrendFn?:Function, htfTf?:string}} opts
 *   levelsFn(sliceCandles, price) -> {resistance:number[], support:number[]} (mis. computeLevels dari market.js; boleh tidak ada = SNR tidak dipakai)
 *   htfTrendFn(candleX) -> "up"|"down"|"range"|null : tren TF besar yang SUDAH closed saat candle X closed
 */
function buildEnv(candles, atr, e, opts = {}) {
  const slice = candles.slice(0, e + 1);
  const st = computeStructure(slice);
  const price = candles[e].c;
  const levelsFn = typeof opts.levelsFn === "function" ? opts.levelsFn : null;
  const levels = levelsFn ? levelsFn(slice, price) : opts.levels || null;
  const levelsPrev = levelsFn && e >= 1 ? levelsFn(candles.slice(0, e), candles[e - 1].c) : opts.levels || null; // level relatif harga sebelum candle e (untuk deteksi tembus)
  const memo = new Map();
  return {
    candles,
    e,
    atr: atr[e],
    swings: st.swings,
    trend: st.trend,
    levels,
    levelsPrev,
    htfTrend: typeof opts.htfTrendFn === "function" ? opts.htfTrendFn(candles[e]) : null,
    htfTf: opts.htfTf || null,
    /** tren struktur tepat sebelum candle f (hanya memakai candle < f) */
    trendBefore(f) {
      if (f < 10) return null;
      if (!memo.has(f)) memo.set(f, computeStructure(candles.slice(0, f)).trend);
      return memo.get(f);
    },
  };
}

// ------------------------------------------------------------------
// Konteks lokasi (wajib)
// ------------------------------------------------------------------

/**
 * Apakah pola (candle f..e) berada di ekstrem sisi bawah ("low") dan/atau atas ("high")?
 * Prioritas label: swing terkonfirmasi > zona SNR > ekstrem berjalan.
 * @returns {{low:{kind:string,level:number}|null, high:{kind:string,level:number}|null}}
 */
function locate(env, f, e) {
  const cs = env.candles;
  const A = env.atr;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = f; i <= e; i++) {
    lo = Math.min(lo, cs[i].l);
    hi = Math.max(hi, cs[i].h);
  }
  const res = { low: null, high: null };

  // ekstrem berjalan: dibanding EXT_LOOKBACK candle sebelum pola
  const from = Math.max(0, f - CFG.EXT_LOOKBACK);
  if (f - from >= 5) {
    let pl = Infinity;
    let ph = -Infinity;
    for (let i = from; i < f; i++) {
      pl = Math.min(pl, cs[i].l);
      ph = Math.max(ph, cs[i].h);
    }
    if (lo <= pl + CFG.EXT_TOL_ATR * A) res.low = { kind: "range", level: pl };
    if (hi >= ph - CFG.EXT_TOL_ATR * A) res.high = { kind: "range", level: ph };
  }

  // zona SNR (termasuk sweep: sumbu menembus level tetapi close kembali di sisi yang benar)
  const z = CFG.SNR_ZONE_ATR * A;
  const close = cs[e].c;
  for (const s of env.levels?.support || []) {
    if (!isNum(s)) continue;
    if (Math.abs(lo - s) <= z || (lo < s && close > s)) res.low = { kind: "snr", level: s };
  }
  for (const r of env.levels?.resistance || []) {
    if (!isNum(r)) continue;
    if (Math.abs(hi - r) <= z || (hi > r && close < r)) res.high = { kind: "snr", level: r };
  }

  // swing terkonfirmasi sebelum pola (env.swings sudah dipotong sampai e)
  for (const s of env.swings) {
    if (s.i >= f || f - s.i > CFG.SWING_LOOKBACK) continue;
    if (s.type === "L" && Math.abs(lo - s.price) <= CFG.SWING_TOL_ATR * A) res.low = { kind: "swing", level: s.price };
    if (s.type === "H" && Math.abs(hi - s.price) <= CFG.SWING_TOL_ATR * A) res.high = { kind: "swing", level: s.price };
  }
  return res;
}

// ------------------------------------------------------------------
// Pembangun pola
// ------------------------------------------------------------------

function buildEvidence(env, { dir, loc, bodyAtr, e }) {
  const ev = [];
  const add = (sign, key, params = {}) => ev.push({ sign, text: key, key, params });
  if (loc) add("+", `loc.${loc.kind}`, { level: loc.level ?? null });
  if (isNum(bodyAtr) && bodyAtr >= CFG.EV_BIG_BODY_ATR) add("+", "bigBody");
  const vr = volRatio(env.candles, e);
  if (vr != null) {
    if (vr >= CFG.EV_VOL_HIGH) add("+", "volHigh", { x: Number(vr.toFixed(1)) });
    else if (vr <= CFG.EV_VOL_LOW) add("-", "volLow", { x: Number(vr.toFixed(1)) });
  }
  if ((dir === DIR.BULL || dir === DIR.BEAR) && (env.htfTrend === "up" || env.htfTrend === "down")) {
    const with_ = (env.htfTrend === "up") === (dir === DIR.BULL);
    add(with_ ? "+" : "-", with_ ? "htfWith" : "htfAgainst", { htf: env.htfTf });
  }
  return ev;
}

/**
 * Bangun objek pola. Level default: bullish -> konfirmasi = high pola, batal = low pola; bearish kebalikannya;
 * netral -> konfirmasi = high, batal = low (hanya batas, tidak dipakai menentukan status).
 */
function mk(env, o) {
  const cs = env.candles;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = o.f; i <= o.e; i++) {
    hi = Math.max(hi, cs[i].h);
    lo = Math.min(lo, cs[i].l);
  }
  const bull = o.dir === DIR.BULL;
  const bear = o.dir === DIR.BEAR;
  const confirmLevel = isNum(o.confirmLevel) ? o.confirmLevel : bear ? lo : hi;
  const invalidLevel = isNum(o.invalidLevel) ? o.invalidLevel : bear ? hi : lo;
  const p = core.makePattern({
    kind: o.kind,
    family: FAMILY.CANDLE,
    dir: o.dir,
    startI: o.f,
    endI: o.e,
    keyIdx: o.keyIdx || [o.e],
    status: o.status || STATUS.CANDIDATE,
    confirmLevel,
    invalidLevel,
    confirmPrice: o.confirmPrice,
    evidence: buildEvidence(env, { dir: o.dir, loc: o.loc, bodyAtr: o.bodyAtr, e: o.e }),
  });
  p.variant = o.variant || null; // sub-jenis / nama konteks (hammer, hangingMan, dragonfly, beltHold, ...)
  p.loc = o.loc || null;
  p.confirmI = o.status === STATUS.CONFIRMED ? o.e : null;
  p.side = o.side || null; // untuk pola netral: sisi ekstrem ("low" | "high")
  void bull;
  return p;
}

/** Pilih sisi lokasi untuk pola tak berarah (pin bar, doji): satu sisi saja, atau tren/gerak sebelumnya bila keduanya. */
function pickSide(env, loc, f) {
  if (loc.low && !loc.high) return "low";
  if (loc.high && !loc.low) return "high";
  if (!loc.low && !loc.high) return null;
  if (env.trend === "up") return "high";
  if (env.trend === "down") return "low";
  if (priorMove(env.candles, f, "down")) return "low";
  if (priorMove(env.candles, f, "up")) return "high";
  return null;
}

// ------------------------------------------------------------------
// Detektor (tiap fungsi: (env, e) -> pola | null | pola[])
// ------------------------------------------------------------------

function detectEngulfing(env, e) {
  if (e < 1) return null;
  const cs = env.candles;
  const A = env.atr;
  const a = geo(cs[e - 1]);
  const b = geo(cs[e]);
  if (!(a.body > 0) || b.body < CFG.BODY_MIN_ATR * A) return null;
  const f = e - 1;
  const loc = locate(env, f, e);
  const engulfs = b.top >= a.top && b.bot <= a.bot;
  if (a.down && b.up && engulfs && loc.low && priorMove(cs, f, "down")) {
    return mk(env, { kind: "engulfing", dir: DIR.BULL, f, e, loc: loc.low, bodyAtr: b.body / A, keyIdx: [e - 1, e] });
  }
  if (a.up && b.down && engulfs && loc.high && priorMove(cs, f, "up")) {
    return mk(env, { kind: "engulfing", dir: DIR.BEAR, f, e, loc: loc.high, bodyAtr: b.body / A, keyIdx: [e - 1, e] });
  }
  return null;
}

function detectPinBar(env, e) {
  const cs = env.candles;
  const A = env.atr;
  const g = geo(cs[e]);
  if (!(g.range >= CFG.PIN_RANGE_ATR * A)) return null;
  const lowerPin = g.lowerPct >= CFG.PIN_WICK_PCT && g.lower >= CFG.PIN_WICK_BODY_MULT * g.body && (g.bot - cs[e].l) / g.range >= 2 / 3;
  const upperPin = g.upperPct >= CFG.PIN_WICK_PCT && g.upper >= CFG.PIN_WICK_BODY_MULT * g.body && (cs[e].h - g.top) / g.range >= 2 / 3;
  if (lowerPin === upperPin) return null; // bukan pin bar, atau kedua sumbu panjang (itu long-legged doji)
  const loc = locate(env, e, e);
  const side = pickSide(env, loc, e);
  if (!side) return null;
  let variant;
  let dir;
  if (lowerPin) [variant, dir] = side === "low" ? ["hammer", DIR.BULL] : ["hangingMan", DIR.BEAR];
  else [variant, dir] = side === "high" ? ["shootingStar", DIR.BEAR] : ["invertedHammer", DIR.BULL];
  const p = mk(env, { kind: "pinBar", dir, f: e, e, loc: loc[side], variant, bodyAtr: g.body / A });
  // wickReject (suddenMove) = bukti tambahan bila sumbu menolak level SNR searah
  const wr = wickReject(cs[e], env.levels, A);
  if (wr && ((wr.dir === "bullish" && dir === DIR.BULL) || (wr.dir === "bearish" && dir === DIR.BEAR))) {
    p.evidence.push({ sign: "+", text: "wickReject", key: "wickReject", params: { level: wr.level } });
  }
  return p;
}

function detectDoji(env, e) {
  const cs = env.candles;
  const A = env.atr;
  const g = geo(cs[e]);
  if (!(g.range >= CFG.DOJI_RANGE_ATR * A) || g.bodyPct > CFG.DOJI_BODY_PCT) return null;
  const loc = locate(env, e, e);
  const side = pickSide(env, loc, e) || (loc.low ? "low" : loc.high ? "high" : null);
  if (!side) return null;
  let variant = null;
  if (g.lowerPct >= CFG.DOJI_LONG_WICK_PCT && g.upperPct <= CFG.DOJI_SHORT_WICK_PCT) variant = "dragonfly";
  else if (g.upperPct >= CFG.DOJI_LONG_WICK_PCT && g.lowerPct <= CFG.DOJI_SHORT_WICK_PCT) variant = "gravestone";
  else if (g.upperPct >= CFG.LEGGED_WICK_PCT && g.lowerPct >= CFG.LEGGED_WICK_PCT && g.range >= CFG.LEGGED_RANGE_ATR * A) variant = "longLegged";
  else if (g.bodyPct <= CFG.SPINNING_BODY_PCT && g.upperPct >= CFG.SPINNING_WICK_PCT && g.lowerPct >= CFG.SPINNING_WICK_PCT) variant = "spinningTop";
  return mk(env, { kind: "doji", dir: DIR.NEUTRAL, f: e, e, loc: loc[side], side, variant });
}

function detectStar(env, e) {
  if (e < 2) return null;
  const cs = env.candles;
  const A = env.atr;
  const [g1, g2, g3] = [geo(cs[e - 2]), geo(cs[e - 1]), geo(cs[e])];
  if (g1.body < CFG.BIG_BODY_ATR * A || g2.body > CFG.SMALL_BODY_ATR * A) return null;
  const mid = (cs[e - 2].o + cs[e - 2].c) / 2;
  const f = e - 2;
  const loc = locate(env, f, e);
  if (g1.down && g3.up && cs[e].c > mid && loc.low) {
    return mk(env, { kind: "morningStar", dir: DIR.BULL, f, e, loc: loc.low, bodyAtr: g3.body / A, keyIdx: [e - 2, e - 1, e] });
  }
  if (g1.up && g3.down && cs[e].c < mid && loc.high) {
    return mk(env, { kind: "eveningStar", dir: DIR.BEAR, f, e, loc: loc.high, bodyAtr: g3.body / A, keyIdx: [e - 2, e - 1, e] });
  }
  return null;
}

const isInside = (c, m) => c.h <= m.h && c.l >= m.l;

/**
 * Inside bar. (A) candle e di dalam candle induk e-1 -> CALON netral (arah ditentukan close yang menembus induk).
 * (B) candle e-1 inside induk e-2 dan candle e close menembus induk -> TERKONFIRMASI searah tembusan.
 * Tidak butuh konteks ekstrem (penanda kompresi), hanya induk cukup besar (INSIDE_MOTHER_MIN_ATR x ATR).
 */
function detectInsideBar(env, e) {
  const cs = env.candles;
  const A = env.atr;
  const out = [];
  const bigEnough = (m) => m.h - m.l >= CFG.INSIDE_MOTHER_MIN_ATR * A;
  if (e >= 1 && isInside(cs[e], cs[e - 1]) && bigEnough(cs[e - 1])) {
    out.push(mk(env, { kind: "insideBar", dir: DIR.NEUTRAL, f: e - 1, e, confirmLevel: cs[e - 1].h, invalidLevel: cs[e - 1].l, keyIdx: [e - 1, e] }));
  }
  if (e >= 2 && isInside(cs[e - 1], cs[e - 2]) && bigEnough(cs[e - 2])) {
    const m = cs[e - 2];
    if (cs[e].c > m.h) {
      out.push(mk(env, { kind: "insideBar", dir: DIR.BULL, f: e - 2, e, status: STATUS.CONFIRMED, confirmLevel: m.h, invalidLevel: m.l, confirmPrice: cs[e].c, keyIdx: [e - 2, e - 1, e] }));
    } else if (cs[e].c < m.l) {
      out.push(mk(env, { kind: "insideBar", dir: DIR.BEAR, f: e - 2, e, status: STATUS.CONFIRMED, confirmLevel: m.l, invalidLevel: m.h, confirmPrice: cs[e].c, keyIdx: [e - 2, e - 1, e] }));
    }
  }
  return out;
}

function detectTweezer(env, e) {
  if (e < 1) return null;
  const cs = env.candles;
  const A = env.atr;
  const [a, b] = [geo(cs[e - 1]), geo(cs[e])];
  if (a.range < CFG.TWEEZER_RANGE_ATR * A || b.range < CFG.TWEEZER_RANGE_ATR * A) return null;
  const f = e - 1;
  const loc = locate(env, f, e);
  if (a.up && b.down && Math.abs(cs[e - 1].h - cs[e].h) <= CFG.TWEEZER_TOL_ATR * A && loc.high && priorMove(cs, f, "up")) {
    return mk(env, { kind: "tweezerTop", dir: DIR.BEAR, f, e, loc: loc.high, bodyAtr: b.body / A, keyIdx: [e - 1, e] });
  }
  if (a.down && b.up && Math.abs(cs[e - 1].l - cs[e].l) <= CFG.TWEEZER_TOL_ATR * A && loc.low && priorMove(cs, f, "down")) {
    return mk(env, { kind: "tweezerBottom", dir: DIR.BULL, f, e, loc: loc.low, bodyAtr: b.body / A, keyIdx: [e - 1, e] });
  }
  return null;
}

function detectHarami(env, e) {
  if (e < 1) return null;
  const cs = env.candles;
  const A = env.atr;
  const [a, b] = [geo(cs[e - 1]), geo(cs[e])];
  if (a.body < CFG.HARAMI_BODY_ATR * A) return null;
  if (!(b.top <= a.top && b.bot >= a.bot)) return null;
  const f = e - 1;
  const loc = locate(env, f, e);
  if (a.down && b.up && loc.low) return mk(env, { kind: "harami", dir: DIR.BULL, f, e, loc: loc.low, bodyAtr: a.body / A, keyIdx: [e - 1, e] });
  if (a.up && b.down && loc.high) return mk(env, { kind: "harami", dir: DIR.BEAR, f, e, loc: loc.high, bodyAtr: a.body / A, keyIdx: [e - 1, e] });
  return null;
}

function detectPiercing(env, e) {
  if (e < 1) return null;
  const cs = env.candles;
  const A = env.atr;
  const [a, b] = [geo(cs[e - 1]), geo(cs[e])];
  if (a.body < CFG.BIG_BODY_ATR * A) return null;
  const mid = (cs[e - 1].o + cs[e - 1].c) / 2;
  const tol = CFG.PIERCE_OPEN_TOL_ATR * A;
  const f = e - 1;
  const loc = locate(env, f, e);
  // piercing: candle 2 naik, open di/bawah close candle 1, close di atas titik tengah tetapi belum menelan (close < open candle 1)
  if (a.down && b.up && cs[e].o <= cs[e - 1].c + tol && cs[e].c > mid && cs[e].c < cs[e - 1].o && loc.low) {
    return mk(env, { kind: "piercing", dir: DIR.BULL, f, e, loc: loc.low, bodyAtr: b.body / A, keyIdx: [e - 1, e] });
  }
  if (a.up && b.down && cs[e].o >= cs[e - 1].c - tol && cs[e].c < mid && cs[e].c > cs[e - 1].o && loc.high) {
    return mk(env, { kind: "darkCloud", dir: DIR.BEAR, f, e, loc: loc.high, bodyAtr: b.body / A, keyIdx: [e - 1, e] });
  }
  return null;
}

function detectMarubozu(env, e) {
  const cs = env.candles;
  const A = env.atr;
  const g = geo(cs[e]);
  if (!(g.range >= CFG.MARUBOZU_RANGE_ATR * A) || g.bodyPct < CFG.MARUBOZU_BODY_PCT) return null;
  const dir = g.up ? DIR.BULL : g.down ? DIR.BEAR : null;
  if (!dir) return null;
  const c = cs[e];
  const from = Math.max(0, e - CFG.BREAKOUT_LOOKBACK);
  if (e - from < 5) return null;
  let loc = null;
  if (dir === DIR.BULL) {
    const r = (env.levelsPrev?.resistance || []).filter((x) => isNum(x) && c.c > x && c.o <= x + CFG.SNR_ZONE_ATR * A).sort((x, y) => y - x)[0];
    let ph = -Infinity;
    for (let i = from; i < e; i++) ph = Math.max(ph, cs[i].h);
    if (r != null) loc = { kind: "snrBreak", level: r };
    else if (c.c > ph && env.trendBefore(e) === "range") loc = { kind: "rangeBreak", level: ph };
  } else {
    const s = (env.levelsPrev?.support || []).filter((x) => isNum(x) && c.c < x && c.o >= x - CFG.SNR_ZONE_ATR * A).sort((x, y) => x - y)[0];
    let pl = Infinity;
    for (let i = from; i < e; i++) pl = Math.min(pl, cs[i].l);
    if (s != null) loc = { kind: "snrBreak", level: s };
    else if (c.c < pl && env.trendBefore(e) === "range") loc = { kind: "rangeBreak", level: pl };
  }
  if (!loc) return null;
  // belt hold (keterangan): open di ekstrem (sumbu sisi open <= 5% range) dan melawan arah sebelumnya
  const openWick = dir === DIR.BULL ? g.lowerPct : g.upperPct;
  const against = dir === DIR.BULL ? priorMove(cs, e, "down") || env.trend === "down" : priorMove(cs, e, "up") || env.trend === "up";
  const variant = openWick <= CFG.BELT_OPEN_WICK_PCT && against ? "beltHold" : null;
  return mk(env, { kind: "marubozu", dir, f: e, e, loc, variant, bodyAtr: g.body / A });
}

function detectThreeSoldiers(env, e) {
  if (e < 2) return null;
  const cs = env.candles;
  const A = env.atr;
  const f = e - 2;
  const trio = [cs[f], cs[f + 1], cs[e]];
  const gs = trio.map(geo);
  const bodyOk = gs.every((g) => g.body >= CFG.SOLDIER_BODY_ATR * A);
  if (!bodyOk) return null;
  const tb = env.trendBefore(f);
  const from = Math.max(0, f - CFG.BREAKOUT_LOOKBACK);
  if (f - from < 5) return null;
  let ph = -Infinity;
  let pl = Infinity;
  for (let i = from; i < f; i++) {
    ph = Math.max(ph, cs[i].h);
    pl = Math.min(pl, cs[i].l);
  }
  const up = gs.every((g) => g.up) && trio[1].c > trio[0].c && trio[2].c > trio[1].c && gs.every((g) => g.upperPct <= CFG.SOLDIER_WICK_PCT);
  const down = gs.every((g) => g.down) && trio[1].c < trio[0].c && trio[2].c < trio[1].c && gs.every((g) => g.lowerPct <= CFG.SOLDIER_WICK_PCT);
  if (up) {
    const loc = tb === "down" ? { kind: "afterTrend", level: null } : tb === "range" && cs[e].c > ph ? { kind: "rangeBreak", level: ph } : null;
    if (loc) return mk(env, { kind: "threeWhiteSoldiers", dir: DIR.BULL, f, e, loc, bodyAtr: gs[2].body / A, keyIdx: [f, f + 1, e] });
  }
  if (down) {
    const loc = tb === "up" ? { kind: "afterTrend", level: null } : tb === "range" && cs[e].c < pl ? { kind: "rangeBreak", level: pl } : null;
    if (loc) return mk(env, { kind: "threeBlackCrows", dir: DIR.BEAR, f, e, loc, bodyAtr: gs[2].body / A, keyIdx: [f, f + 1, e] });
  }
  return null;
}

/** Rising / falling three methods: lanjutan tren, SUDAH terkonfirmasi di candle penutup (close melewati ekstrem candle pertama). */
function detectThreeMethods(env, e) {
  if (e < 4) return null;
  const cs = env.candles;
  const A = env.atr;
  const f = e - 4;
  const g1 = geo(cs[f]);
  const g5 = geo(cs[e]);
  const big = CFG.THREE_METHODS_BIG_ATR * A;
  if (g1.body < big || g5.body < big) return null;
  const mid = [1, 2, 3].map((k) => cs[f + k]);
  const within = mid.every((c) => c.h <= cs[f].h && c.l >= cs[f].l);
  const small = mid.every((c) => geo(c).body <= CFG.THREE_METHODS_SMALL_RATIO * g1.body);
  if (!within || !small) return null;
  const tb = env.trendBefore(f);
  const corrLow = Math.min(...mid.map((c) => c.l));
  const corrHigh = Math.max(...mid.map((c) => c.h));
  if (g1.up && mid.every((c) => c.c < c.o) && g5.up && cs[e].c > cs[f].h && tb === "up") {
    return mk(env, { kind: "threeMethods", dir: DIR.BULL, f, e, variant: "risingThreeMethods", loc: { kind: "trendHealthy", level: null }, status: STATUS.CONFIRMED, confirmLevel: cs[f].h, invalidLevel: corrLow, confirmPrice: cs[e].c, bodyAtr: g5.body / A, keyIdx: [f, e] });
  }
  if (g1.down && mid.every((c) => c.c > c.o) && g5.down && cs[e].c < cs[f].l && tb === "down") {
    return mk(env, { kind: "threeMethods", dir: DIR.BEAR, f, e, variant: "fallingThreeMethods", loc: { kind: "trendHealthy", level: null }, status: STATUS.CONFIRMED, confirmLevel: cs[f].l, invalidLevel: corrHigh, confirmPrice: cs[e].c, bodyAtr: g5.body / A, keyIdx: [f, e] });
  }
  return null;
}

const DETECTORS = Object.freeze([detectEngulfing, detectPinBar, detectDoji, detectStar, detectInsideBar, detectTweezer, detectHarami, detectPiercing, detectMarubozu, detectThreeSoldiers, detectThreeMethods]);

/** Semua kind yang bisa dihasilkan (dipakai tes dan pengecekan i18n). */
const KINDS = Object.freeze(["engulfing", "pinBar", "doji", "morningStar", "eveningStar", "insideBar", "tweezerTop", "tweezerBottom", "harami", "piercing", "darkCloud", "marubozu", "threeWhiteSoldiers", "threeBlackCrows", "threeMethods"]);
const VARIANTS = Object.freeze(["hammer", "hangingMan", "shootingStar", "invertedHammer", "dragonfly", "gravestone", "longLegged", "spinningTop", "beltHold", "risingThreeMethods", "fallingThreeMethods"]);

// ------------------------------------------------------------------
// Status: calon -> terkonfirmasi / batal (hanya close, tanpa lookahead)
// ------------------------------------------------------------------

/**
 * Putar ulang candle SETELAH pola sampai candle terakhir. Pola berarah:
 *   CALON  -> TERKONFIRMASI bila close melewati level konfirmasi; BATAL bila close melewati level batal.
 *   TERKONFIRMASI -> BATAL bila kemudian close melewati level batal. BATAL bersifat final.
 * Pola netral (doji, inside bar calon) tidak berubah status.
 */
function settle(p, candles, lastI) {
  if (p.dir === DIR.NEUTRAL) return p;
  const bull = p.dir === DIR.BULL;
  for (let i = p.endI + 1; i <= lastI; i++) {
    const c = candles[i].c;
    if (p.status === STATUS.INVALIDATED) break;
    if (bull ? c < p.invalidLevel : c > p.invalidLevel) {
      p.status = STATUS.INVALIDATED;
      break;
    }
    if (p.status === STATUS.CANDIDATE && (bull ? c > p.confirmLevel : c < p.confirmLevel)) {
      p.status = STATUS.CONFIRMED;
      p.confirmPrice = c;
      p.confirmI = i;
    }
  }
  return p;
}

// ------------------------------------------------------------------
// Pemindai
// ------------------------------------------------------------------

/**
 * Pindai pola candlestick pada RECENT_BARS candle closed terakhir.
 * @param {object[]} candles candle closed, lama -> baru
 * @param {object} [opts] lihat buildEnv (levelsFn, htfTrendFn, htfTf). opts.bars = jumlah candle terakhir yang dipindai.
 * @returns {{ok:false, reason:string, have:number, need:number} |
 *           {ok:true, patterns:object[], absorbed:object[], dropped:object[], invalidated:number, atrLast:number, lastI:number, lastT:number, trend:string|null}}
 */
function scanCandlePatterns(candles, opts = {}) {
  const prep = core.prepare(candles, { minSwings: 0 });
  if (!prep.ok) return prep;
  const lastI = candles.length - 1;
  const bars = opts.bars ?? CFG.RECENT_BARS;
  const from = Math.max(0, lastI - bars + 1);
  let raw = [];
  for (let e = from; e <= lastI; e++) {
    if (!isNum(prep.atr[e]) || prep.atr[e] <= 0) continue;
    const env = buildEnv(candles, prep.atr, e, opts);
    for (const det of DETECTORS) {
      const r = det(env, e);
      if (!r) continue;
      if (Array.isArray(r)) raw.push(...r);
      else raw.push(r);
    }
  }
  for (const p of raw) settle(p, candles, lastI);

  // Pola netral hanya relevan di candle terakhir (calon yang sedang menunggu close berikutnya).
  raw = raw.filter((p) => p.dir !== DIR.NEUTRAL || p.endI === lastI);
  // Inside bar calon digantikan inside bar terkonfirmasi dengan candle induk yang sama.
  raw = raw.filter((p) => !(p.kind === "insideBar" && p.dir === DIR.NEUTRAL && raw.some((q) => q.kind === "insideBar" && q.dir !== DIR.NEUTRAL && q.startI === p.startI)));

  const res = core.resolvePatterns(raw, prep.atrLast);
  const invalidated = res.kept.filter((p) => p.status === STATUS.INVALIDATED).length;
  const rank = { kuat: 3, sedang: 2, lemah: 1 };
  const patterns = res.kept
    .filter((p) => p.status !== STATUS.INVALIDATED)
    .sort((a, b) => b.endI - a.endI || rank[b.grade] - rank[a.grade]);
  return { ok: true, patterns, absorbed: res.absorbed, dropped: res.dropped, invalidated, atrLast: prep.atrLast, lastI, lastT: candles[lastI].t, trend: computeStructure(candles).trend };
}

module.exports = {
  CFG,
  KINDS,
  VARIANTS,
  DETECTORS,
  geo,
  priorMove,
  locate,
  buildEnv,
  settle,
  scanCandlePatterns,
  detectEngulfing,
  detectPinBar,
  detectDoji,
  detectStar,
  detectInsideBar,
  detectTweezer,
  detectHarami,
  detectPiercing,
  detectMarubozu,
  detectThreeSoldiers,
  detectThreeMethods,
};
