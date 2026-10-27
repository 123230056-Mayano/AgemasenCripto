"use strict";

/**
 * features/kripto/swingPatterns.js
 * ------------------------------------------------------------------
 * Fase 2 pengenal pola: POLA SWING KLASIK + STRUKTUR (catatan saran "Pengenalan Pola", Langkah 2 / Tahap B).
 * Logika MURNI: tanpa fetch, tanpa kirim pesan, tanpa canvas -> bisa diuji unit (src/test/swingPatterns.test.js).
 * Memakai fondasi patternCore.js dan swing dari hhllCore (tidak ada algoritma pivot kedua, jadi tidak bertentangan dengan !hhll).
 *
 * Pola: double top / double bottom, head and shoulders (dan kebalikannya), equal highs / lows (konteks likuiditas),
 *       rectangle / range, BOS, CHoCH, breakout-retest (flip SNR).
 *
 * Aturan:
 *   - Hanya candle CLOSED, tanpa lookahead. Swing baru "diketahui" PIVOT_WIN candle setelah index-nya (knownI);
 *     status pola hanya diputar ulang dari knownI + 1 ke depan.
 *   - Toleransi dalam ATR (bukan persen tetap). Semua ambang di PATTERN_CONFIG (nilai awal usulan, belum tervalidasi).
 *   - Dua tahap: CALON -> TERKONFIRMASI (close menembus garis leher / batas) atau BATAL (close melewati level batal).
 *   - Target dihitung dari titik KONFIRMASI (bukan dari puncaknya). Bukan sinyal beli/jual.
 */

const { PATTERN_CONFIG: CFG } = require("../../config/indicatorConfig");
const { CFG: HHLL_CFG, trendOf } = require("./hhllCore");
const core = require("./patternCore");

const { STATUS, DIR, FAMILY } = core;
const isNum = (v) => typeof v === "number" && isFinite(v);
const WIN = HHLL_CFG.PIVOT_WIN;

/** Candle tempat swing s baru sah diketahui (PIVOT_WIN candle di kanannya sudah closed). */
const knownI = (s) => s.i + WIN;

// ------------------------------------------------------------------
// Bukti (+/-) - sama gaya dengan candlePatterns
// ------------------------------------------------------------------

function volRatio(cs, e) {
  const prev = cs.slice(Math.max(0, e - CFG.EV_VOL_LOOKBACK), e);
  if (!isNum(cs[e]?.v) || prev.length < Math.min(CFG.EV_VOL_LOOKBACK, 5)) return null;
  const mean = prev.reduce((a, c) => a + (isNum(c.v) ? c.v : 0), 0) / prev.length;
  return mean > 0 ? cs[e].v / mean : null;
}

function evidenceAt(ctx, { dir, e, trendBefore, reversal }) {
  const ev = [];
  const add = (sign, key, params = {}) => ev.push({ sign, text: key, key, params });
  if (reversal && (trendBefore === "up" || trendBefore === "down")) {
    const ok = (trendBefore === "up") === (dir === DIR.BEAR);
    add(ok ? "+" : "-", ok ? "afterTrend" : "noPriorTrend");
  }
  const vr = isNum(e) ? volRatio(ctx.candles, e) : null;
  if (vr != null) {
    if (vr >= CFG.EV_VOL_HIGH) add("+", "volHigh", { x: Number(vr.toFixed(1)) });
    else if (vr <= CFG.EV_VOL_LOW) add("-", "volLow", { x: Number(vr.toFixed(1)) });
  }
  if ((dir === DIR.BULL || dir === DIR.BEAR) && (ctx.htfTrend === "up" || ctx.htfTrend === "down")) {
    const with_ = (ctx.htfTrend === "up") === (dir === DIR.BULL);
    add(with_ ? "+" : "-", with_ ? "htfWith" : "htfAgainst", { htf: ctx.htfTf });
  }
  return ev;
}

// ------------------------------------------------------------------
// Replay status (tanpa lookahead: mulai setelah swing terakhir diketahui)
// ------------------------------------------------------------------

/**
 * Putar ulang close setelah knownI. levelAt(i) = level garis leher di candle i (boleh miring).
 * bear: konfirmasi close < garis leher, batal close > invalidLevel. bull: kebalikannya.
 */
function settleLine(p, candles, from, lastI, levelAt) {
  const bear = p.dir === DIR.BEAR;
  for (let i = from; i <= lastI; i++) {
    const c = candles[i].c;
    if (p.status === STATUS.INVALIDATED) break;
    if (bear ? c > p.invalidLevel : c < p.invalidLevel) {
      p.status = STATUS.INVALIDATED;
      break;
    }
    const lvl = levelAt(i);
    if (p.status === STATUS.CANDIDATE && (bear ? c < lvl : c > lvl)) {
      p.status = STATUS.CONFIRMED;
      p.confirmPrice = c;
      p.confirmI = i;
      p.confirmLevel = lvl; // level garis leher TEPAT di candle konfirmasi
    }
  }
  return p;
}

// ------------------------------------------------------------------
// Double top / bottom
// ------------------------------------------------------------------

function detectDoubleTopBottom(ctx) {
  const { swings, atr, candles, lastI } = ctx;
  const out = [];
  for (let k = 0; k + 2 < swings.length; k++) {
    const a = swings[k];
    const v = swings[k + 1];
    const b = swings[k + 2];
    if (a.type === v.type || a.type !== b.type) continue;
    const top = a.type === "H";
    const kI = knownI(b);
    if (kI > lastI) continue;
    const A = atr[kI];
    if (!isNum(A) || A <= 0) continue;
    const gap = b.i - a.i;
    if (gap < CFG.SW_MIN_BARS || gap > CFG.SW_MAX_BARS) continue;
    if (Math.abs(a.price - b.price) > CFG.EQUAL_TOL_ATR * A) continue;
    const depth = top ? Math.min(a.price, b.price) - v.price : v.price - Math.max(a.price, b.price);
    if (depth < CFG.DT_VALLEY_ATR * A) continue;
    // wajib ada tren sebelumnya (hanya swing yang sudah ada sampai puncak pertama)
    const trendBefore = trendOf(swings.slice(0, k + 1));
    if (trendBefore !== (top ? "up" : "down")) continue;

    const extreme = top ? Math.max(a.price, b.price) : Math.min(a.price, b.price);
    const neck = v.price;
    const dir = top ? DIR.BEAR : DIR.BULL;
    const p = core.makePattern({
      kind: top ? "doubleTop" : "doubleBottom",
      family: FAMILY.SWING,
      dir,
      startI: a.i,
      endI: b.i,
      keyIdx: [a.i, v.i, b.i],
      status: STATUS.CANDIDATE,
      confirmLevel: neck,
      invalidLevel: extreme,
      trendBefore,
      evidence: [{ sign: "+", text: "equalPeaks", key: "equalPeaks", params: { atr: Number((Math.abs(a.price - b.price) / A).toFixed(2)) } }],
    });
    p.knownI = kI;
    p.neckline = { i1: v.i, p1: neck, i2: v.i, p2: neck };
    p.height = Math.abs(extreme - neck);
    settleLine(p, candles, kI + 1, lastI, () => neck);
    p.target = top ? neck - p.height : neck + p.height; // ukuran pola diproyeksikan dari neckline
    p.confirmI = p.confirmI ?? null;
    p.evidence.push(...evidenceAt(ctx, { dir, e: p.confirmI ?? kI, trendBefore, reversal: true }));
    out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------
// Head and shoulders (dan kebalikannya). Neckline boleh miring.
// ------------------------------------------------------------------

function detectHeadShoulders(ctx) {
  const { swings, atr, candles, lastI } = ctx;
  const out = [];
  for (let k = 0; k + 4 < swings.length; k++) {
    const [ls, n1, hd, n2, rs] = swings.slice(k, k + 5);
    if (ls.type !== hd.type || hd.type !== rs.type || n1.type === ls.type || n2.type === ls.type) continue;
    const top = ls.type === "H";
    const kI = knownI(rs);
    if (kI > lastI) continue;
    const A = atr[kI];
    if (!isNum(A) || A <= 0) continue;
    const sgn = top ? 1 : -1; // top: harga makin tinggi = lebih ekstrem
    const headOver = Math.min(sgn * (hd.price - ls.price), sgn * (hd.price - rs.price));
    if (headOver < CFG.HS_HEAD_ATR * A) continue;
    if (Math.abs(ls.price - rs.price) > CFG.SHOULDER_TOL_ATR * A) continue;
    if (rs.i - ls.i > CFG.SW_MAX_BARS * 2) continue;
    const trendBefore = trendOf(swings.slice(0, k + 1));
    const slope = (n2.price - n1.price) / Math.max(1, n2.i - n1.i);
    const necklineAt = (i) => n1.price + slope * (i - n1.i);
    const dir = top ? DIR.BEAR : DIR.BULL;
    const rsLevel = rs.price; // batal: close melewati bahu kanan
    const p = core.makePattern({
      kind: top ? "headAndShoulders" : "inverseHeadAndShoulders",
      family: FAMILY.SWING,
      dir,
      startI: ls.i,
      endI: rs.i,
      keyIdx: [ls.i, n1.i, hd.i, n2.i, rs.i],
      status: STATUS.CANDIDATE,
      confirmLevel: necklineAt(kI),
      invalidLevel: rsLevel,
      trendBefore,
      evidence: [{ sign: "+", text: "headOverShoulders", key: "headOverShoulders", params: { atr: Number((headOver / A).toFixed(2)) } }],
    });
    p.knownI = kI;
    p.neckline = { i1: n1.i, p1: n1.price, i2: n2.i, p2: n2.price };
    p.height = Math.abs(hd.price - necklineAt(hd.i));
    settleLine(p, candles, kI + 1, lastI, necklineAt);
    const base = isNum(p.confirmPrice) ? necklineAt(p.confirmI) : necklineAt(kI);
    p.target = top ? base - p.height : base + p.height;
    p.evidence.push(...evidenceAt(ctx, { dir, e: p.confirmI ?? kI, trendBefore, reversal: true }));
    out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------
// Equal highs / lows (konteks likuiditas, bukan sinyal arah)
// ------------------------------------------------------------------

function detectEqualLevels(ctx) {
  const { swings, atr, candles, lastI } = ctx;
  const out = [];
  for (let k = 0; k + 2 < swings.length; k++) {
    const a = swings[k];
    const b = swings[k + 2];
    if (a.type !== b.type) continue;
    const kI = knownI(b);
    if (kI > lastI) continue;
    const A = atr[kI];
    if (!isNum(A) || A <= 0) continue;
    const gap = b.i - a.i;
    if (gap < CFG.SW_MIN_BARS || gap > CFG.SW_MAX_BARS) continue;
    if (Math.abs(a.price - b.price) > CFG.EQ_TOL_ATR * A) continue;
    const top = a.type === "H";
    const level = top ? Math.max(a.price, b.price) : Math.min(a.price, b.price);
    // level yang sudah ditembus close (>= EQ_TOL) bukan lagi likuiditas yang menunggu
    let taken = false;
    for (let i = kI + 1; i <= lastI; i++) {
      if (top ? candles[i].c > level + CFG.EQ_TOL_ATR * A : candles[i].c < level - CFG.EQ_TOL_ATR * A) {
        taken = true;
        break;
      }
    }
    const p = core.makePattern({
      kind: top ? "equalHighs" : "equalLows",
      family: FAMILY.SWING,
      dir: DIR.NEUTRAL,
      startI: a.i,
      endI: b.i,
      keyIdx: [a.i, b.i],
      status: taken ? STATUS.INVALIDATED : STATUS.CANDIDATE,
      confirmLevel: level,
      invalidLevel: level,
      evidence: [{ sign: "+", text: "equalPeaks", key: "equalPeaks", params: { atr: Number((Math.abs(a.price - b.price) / A).toFixed(2)) } }],
    });
    p.knownI = kI;
    out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------
// Rectangle / range
// ------------------------------------------------------------------

function detectRectangle(ctx) {
  const { swings, atr, candles, lastI } = ctx;
  if (swings.length < 4) return [];
  let best = null;
  const lastK = swings.length - 1;
  for (let endK = lastK; endK >= Math.max(3, lastK - 2); endK--) {
    for (let startK = Math.max(0, endK - (CFG.RECT_MAX_SWINGS - 1)); startK <= endK - 3; startK++) {
      const win = swings.slice(startK, endK + 1);
      const hs = win.filter((s) => s.type === "H").map((s) => s.price);
      const ls = win.filter((s) => s.type === "L").map((s) => s.price);
      if (hs.length < 2 || ls.length < 2) continue;
      const kI = knownI(win[win.length - 1]);
      if (kI > lastI) continue;
      const A = atr[kI];
      if (!isNum(A) || A <= 0) continue;
      const topLvl = Math.max(...hs);
      const botLvl = Math.min(...ls);
      if (topLvl - Math.min(...hs) > CFG.RECT_TOL_ATR * A) continue;
      if (Math.max(...ls) - botLvl > CFG.RECT_TOL_ATR * A) continue;
      const height = topLvl - botLvl;
      if (height < CFG.RECT_MIN_HEIGHT_ATR * A) continue;
      if (win[win.length - 1].i - win[0].i < CFG.RECT_MIN_BARS) continue;
      // tidak ada tren dominan di dalamnya
      const tr = trendOf(swings.slice(0, endK + 1));
      if (tr === "up" || tr === "down") continue;
      const size = win.length;
      if (!best || size > best.win.length || (size === best.win.length && endK > best.endK)) best = { win, startK, endK, topLvl, botLvl, height, kI };
    }
  }
  if (!best) return [];
  const { win, topLvl, botLvl, height, kI } = best;
  const first = win[0];
  const lastS = win[win.length - 1];
  // Replay: tembus -> terkonfirmasi (arah = sisi tembus); kembali ke dalam range = batal.
  let status = STATUS.CANDIDATE;
  let dir = DIR.NEUTRAL;
  let confirmI = null;
  let confirmPrice = null;
  for (let i = kI + 1; i <= lastI; i++) {
    const c = candles[i].c;
    if (status === STATUS.CANDIDATE) {
      if (c > topLvl) [status, dir, confirmI, confirmPrice] = [STATUS.CONFIRMED, DIR.BULL, i, c];
      else if (c < botLvl) [status, dir, confirmI, confirmPrice] = [STATUS.CONFIRMED, DIR.BEAR, i, c];
    } else if (status === STATUS.CONFIRMED) {
      if (dir === DIR.BULL ? c <= topLvl : c >= botLvl) status = STATUS.INVALIDATED; // kembali ke dalam range
    }
  }
  const bull = dir === DIR.BULL;
  const p = core.makePattern({
    kind: "rectangle",
    family: FAMILY.SWING,
    dir,
    startI: first.i,
    endI: lastS.i,
    keyIdx: win.map((s) => s.i),
    status,
    confirmLevel: dir === DIR.NEUTRAL ? topLvl : bull ? topLvl : botLvl,
    invalidLevel: dir === DIR.NEUTRAL ? botLvl : bull ? topLvl : botLvl,
    confirmPrice,
    // target dari titik TEMBUS, bukan dari dasar range
    target: isNum(confirmPrice) ? (bull ? confirmPrice + height : confirmPrice - height) : null,
    evidence: [
      { sign: "+", text: "rangeTouches", key: "rangeTouches", params: { n: win.length } },
      ...evidenceAt(ctx, { dir, e: confirmI ?? kI, reversal: false }),
    ],
  });
  p.knownI = kI;
  p.confirmI = confirmI;
  p.rect = { top: topLvl, bottom: botLvl, height, breakI: confirmI };
  return [p];
}

// ------------------------------------------------------------------
// BOS / CHoCH
// ------------------------------------------------------------------

/**
 * Untuk tiap candle e di jendela terbaru: swing yang SUDAH diketahui di e, tren dari swing itu saja,
 * lalu close pertama yang menembus swing H / L terakhir.
 *   tren naik : close > swing H terakhir = BOS bullish; close < swing L terakhir = CHoCH bearish.
 *   tren turun: close < swing L terakhir = BOS bearish; close > swing H terakhir = CHoCH bullish.
 */
function detectBosChoch(ctx) {
  const { swings, atr, candles, lastI } = ctx;
  const out = [];
  const seen = new Set();
  const from = Math.max(1, lastI - CFG.SW_RECENT_BARS + 1);
  for (let e = from; e <= lastI; e++) {
    const known = swings.filter((s) => knownI(s) < e); // swing sah sebelum candle e (tanpa lookahead)
    const trend = trendOf(known);
    if (trend !== "up" && trend !== "down") continue;
    const A = atr[e];
    if (!isNum(A) || A <= 0) continue;
    const lastH = [...known].reverse().find((s) => s.type === "H");
    const lastL = [...known].reverse().find((s) => s.type === "L");
    for (const [sw, upBreak] of [[lastH, true], [lastL, false]]) {
      if (!sw) continue;
      const c = candles[e].c;
      const broke = upBreak ? c > sw.price : c < sw.price;
      if (!broke) continue;
      // hanya close PERTAMA yang menembus swing ini sejak swing itu sah
      let first = true;
      for (let i = knownI(sw) + 1; i < e; i++) {
        if (upBreak ? candles[i].c > sw.price : candles[i].c < sw.price) {
          first = false;
          break;
        }
      }
      if (!first) continue;
      const key = `${sw.i}|${upBreak}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const withTrend = (trend === "up") === upBreak;
      const dir = upBreak ? DIR.BULL : DIR.BEAR;
      const opposite = upBreak ? lastL : lastH; // batal: struktur berbalik melewati swing berlawanan
      const p = core.makePattern({
        kind: withTrend ? "bos" : "choch",
        family: FAMILY.STRUCTURE,
        dir,
        startI: sw.i,
        endI: e,
        keyIdx: [sw.i, e],
        status: STATUS.CONFIRMED,
        confirmLevel: sw.price,
        confirmPrice: c,
        invalidLevel: opposite ? opposite.price : sw.price,
        trendBefore: trend,
        evidence: [
          ...(candles[e] && Math.abs(candles[e].c - candles[e].o) >= CFG.EV_BIG_BODY_ATR * A ? [{ sign: "+", text: "bigBody", key: "bigBody" }] : []),
          ...evidenceAt(ctx, { dir, e, reversal: false }),
        ],
      });
      p.confirmI = e;
      p.broken = { i: sw.i, price: sw.price };
      // status akhir: batal bila kemudian close melewati swing berlawanan
      for (let i = e + 1; i <= lastI; i++) {
        if (dir === DIR.BULL ? candles[i].c < p.invalidLevel : candles[i].c > p.invalidLevel) {
          p.status = STATUS.INVALIDATED;
          break;
        }
      }
      out.push(p);
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Breakout-retest / flip SNR
// ------------------------------------------------------------------

/**
 * levels: [{ price, parent?: "rectangle", height?: number }] dari batas rectangle terkonfirmasi dan/atau level SNR (opts.levels).
 * Tembus: close melewati level dengan body >= BREAK_BODY_ATR x ATR. Retest: dalam RETEST_MIN..MAX_BARS candle, sumbu kembali
 * menyentuh level (<= RETEST_TOUCH_ATR x ATR) dari sisi seberang. Terkonfirmasi: close berikutnya bertahan di sisi baru.
 * Batal: close kembali melewati level ke sisi lama.
 */
function detectBreakoutRetest(ctx, levels) {
  const { atr, candles, lastI } = ctx;
  const out = [];
  for (const lv of levels) {
    if (!isNum(lv.price)) continue;
    const P = lv.price;
    const lo = Math.max(1, lastI - (CFG.RETEST_MAX_BARS + CFG.SW_RECENT_BARS + 2));
    for (let b = lo; b <= lastI; b++) {
      const A = atr[b];
      if (!isNum(A) || A <= 0) continue;
      const cb = candles[b];
      const up = candles[b - 1].c <= P && cb.c > P;
      const dn = candles[b - 1].c >= P && cb.c < P;
      if (!up && !dn) continue;
      if (Math.abs(cb.c - cb.o) < CFG.BREAK_BODY_ATR * A) continue;
      const dir = up ? DIR.BULL : DIR.BEAR;
      const tol = CFG.RETEST_TOUCH_ATR * A;
      let status = STATUS.CANDIDATE;
      let touchI = null;
      let confirmI = null;
      let confirmPrice = null;
      for (let i = b + 1; i <= lastI && i <= b + CFG.RETEST_MAX_BARS + 1; i++) {
        const c = candles[i];
        if (up ? c.c < P : c.c > P) {
          status = STATUS.INVALIDATED; // close kembali ke sisi lama = flip gagal
          break;
        }
        if (touchI == null) {
          const bars = i - b;
          const touched = up ? c.l <= P + tol : c.h >= P - tol;
          if (touched && bars >= CFG.RETEST_MIN_BARS && bars <= CFG.RETEST_MAX_BARS) touchI = i;
          continue;
        }
        if (confirmI == null && i > touchI && (up ? c.c > P : c.c < P)) {
          confirmI = i;
          confirmPrice = c.c;
          status = STATUS.CONFIRMED;
        }
      }
      if (touchI == null) continue; // belum ada retest -> belum jadi pola
      const bull = up;
      const p = core.makePattern({
        kind: "breakoutRetest",
        family: FAMILY.SWING,
        dir,
        startI: b,
        endI: touchI,
        keyIdx: [b, touchI],
        status,
        confirmLevel: P,
        invalidLevel: P,
        confirmPrice,
        // target dari titik RETEST (bukan dari titik tembus), bila level berasal dari pola induk berukuran
        target: isNum(lv.height) ? (bull ? P + lv.height : P - lv.height) : null,
        stage: "retest",
        evidence: [
          { sign: "+", text: "retestHeld", key: "retestHeld" },
          ...evidenceAt(ctx, { dir, e: confirmI ?? touchI, reversal: false }),
        ],
      });
      p.knownI = touchI;
      p.confirmI = confirmI;
      p.parent = lv.parent || "snr";
      out.push(p);
      break; // satu breakout per level
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Pemindai
// ------------------------------------------------------------------

const GRADE_RANK = { kuat: 3, sedang: 2, lemah: 1 };

/**
 * Pindai pola swing pada candle closed.
 * @param {object[]} candles candle closed, lama -> baru
 * @param {{levels?:{support?:number[],resistance?:number[]}, htfTrend?:string, htfTf?:string}} [opts]
 * @returns {{ok:false, reason:string, have:number, need:number} |
 *           {ok:true, patterns:object[], absorbed:object[], dropped:object[], invalidated:number, atrLast:number, lastI:number, lastT:number, trend:string|null}}
 */
function scanSwingPatterns(candles, opts = {}) {
  const prep = core.prepare(candles);
  if (!prep.ok) return prep;
  const lastI = candles.length - 1;
  const ctx = {
    candles,
    atr: prep.atr,
    swings: prep.swings,
    lastI,
    htfTrend: opts.htfTrend ?? null,
    htfTf: opts.htfTf ?? null,
  };

  const raw = [...detectDoubleTopBottom(ctx), ...detectHeadShoulders(ctx), ...detectEqualLevels(ctx), ...detectRectangle(ctx), ...detectBosChoch(ctx)];

  // Level untuk breakout-retest: batas rectangle terkonfirmasi (membawa tinggi pola induk) + level SNR dari opts.
  const levels = [];
  for (const r of raw.filter((p) => p.kind === "rectangle" && p.rect)) {
    levels.push({ price: r.rect.top, parent: "rectangle", height: r.rect.height });
    levels.push({ price: r.rect.bottom, parent: "rectangle", height: r.rect.height });
  }
  for (const x of [...(opts.levels?.support || []), ...(opts.levels?.resistance || [])]) {
    if (isNum(x) && !levels.some((l) => Math.abs(l.price - x) < 1e-9)) levels.push({ price: x });
  }
  raw.push(...detectBreakoutRetest(ctx, levels));

  // Filter kesegaran: calon masih "hidup", terkonfirmasi / BOS / CHoCH hanya yang baru.
  const fresh = raw.filter((p) => {
    if (p.status === STATUS.INVALIDATED) return true; // dihitung di core (kept lalu disaring)
    const known = p.knownI ?? p.endI;
    if (p.status === STATUS.CANDIDATE) return lastI - known <= CFG.SW_CANDIDATE_BARS;
    return lastI - (p.confirmI ?? p.endI) <= CFG.SW_RECENT_BARS;
  });

  const res = core.resolvePatterns(fresh, prep.atrLast);
  const kept = res.kept;

  // CHoCH lemah sampai ada BOS searah baru setelahnya (Bagian 4).
  for (const p of kept) {
    if (p.kind === "choch" && !kept.some((q) => q.kind === "bos" && q.dir === p.dir && q.endI > p.endI)) {
      p.grade = core.GRADE.WEAK;
      p.notes.push("CHoCH: grade lemah sampai ada BOS searah baru");
    }
  }

  const invalidated = kept.filter((p) => p.status === STATUS.INVALIDATED).length;
  const patterns = kept
    .filter((p) => p.status !== STATUS.INVALIDATED)
    .sort((a, b) => (b.confirmI ?? b.endI) - (a.confirmI ?? a.endI) || GRADE_RANK[b.grade] - GRADE_RANK[a.grade]);

  return {
    ok: true,
    patterns,
    absorbed: res.absorbed,
    dropped: res.dropped,
    invalidated,
    atrLast: prep.atrLast,
    lastI,
    lastT: candles[lastI].t,
    trend: prep.structure.trend,
  };
}

module.exports = {
  CFG,
  knownI,
  settleLine,
  detectDoubleTopBottom,
  detectHeadShoulders,
  detectEqualLevels,
  detectRectangle,
  detectBosChoch,
  detectBreakoutRetest,
  scanSwingPatterns,
};
