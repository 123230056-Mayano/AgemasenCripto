"use strict";

/**
 * features/kripto/suddenMove.js
 * ------------------------------------------------------------------
 * Sudden Move Guard: logika MURNI (tanpa fetch, tanpa store, tanpa kirim pesan, tanpa AI) untuk
 *   1. pendeteksi   : wickReject, sweep, rangeAtr, volumeSpike, rapidMove
 *   2. gerbang entri: assessEntry   -> status VALID | TUNGGU | HINDARI + SL yang disesuaikan
 *   3. posisi       : assessPosition -> INFO | WASPADA | CUT (+ time stop, saran break-even)
 *   4. bantu        : positionSize, trailStop
 *
 * Semua ambang dibaca dari config/indicatorConfig.js -> SUDDEN_CONFIG. Angkanya NILAI AWAL USULAN, bukan hasil
 * backtest. Bot hanya mengirim pesan; tidak menutup posisi. Polling 15-60 detik bisa kehilangan spike, dan
 * eksekusi nyata bisa slip / gap melewati SL.
 *
 * Konvensi:
 *   - candle: { t, o, h, l, c, v?, qv? } urut lama -> baru, hanya candle CLOSED kecuali dinyatakan lain.
 *   - levels: { resistance: number[], support: number[] } (hasil computeLevels di market.js).
 *   - dir: "long" | "short".
 *   - Fungsi pendeteksi mengembalikan null bila tidak ada kejadian atau data tidak cukup (tidak pernah menebak).
 */

const { SUDDEN_CONFIG: CFG } = require("../../config/indicatorConfig");

const STATUS = Object.freeze({ VALID: "VALID", TUNGGU: "TUNGGU", HINDARI: "HINDARI" });
const LEVEL = Object.freeze({ INFO: "INFO", WASPADA: "WASPADA", CUT: "CUT" });

const isNum = (v) => typeof v === "number" && isFinite(v);
const sgn = (dir) => (dir === "long" ? 1 : -1);

// =====================================================================
// 1. Pendeteksi
// =====================================================================

/**
 * Wick reject: harga masuk zona level lalu ditolak dengan wick panjang dan body kecil.
 *   bearish : wick ATAS >= WICK_MIN_PCT x range, body <= BODY_MAX_PCT x range, high masuk zona resistance,
 *             close tidak di atas resistance.
 *   bullish : bayangan cermin di support (wick BAWAH).
 * Zona = level -/+ ZONE_ATR x ATR. Bila beberapa level cocok, dipilih yang paling dekat ke ekstrem candle.
 * @returns {{dir:"bearish"|"bullish", level:number, extreme:number, wickPct:number, bodyPct:number}|null}
 */
function wickReject(candle, levels, atr, cfg = CFG) {
  if (!candle || !isNum(atr) || atr <= 0) return null;
  const { o, h, l, c } = candle;
  const range = h - l;
  if (![o, h, l, c].every(isNum) || range <= 0) return null;
  const body = Math.abs(c - o);
  const bodyPct = body / range;
  if (bodyPct > cfg.BODY_MAX_PCT) return null;
  const zone = cfg.ZONE_ATR * atr;

  const upperPct = (h - Math.max(o, c)) / range;
  if (upperPct >= cfg.WICK_MIN_PCT) {
    const hit = (levels?.resistance || []).filter((r) => isNum(r) && h >= r - zone && c < r).sort((a, b) => Math.abs(a - h) - Math.abs(b - h))[0];
    if (hit != null) return { dir: "bearish", level: hit, extreme: h, wickPct: upperPct, bodyPct };
  }
  const lowerPct = (Math.min(o, c) - l) / range;
  if (lowerPct >= cfg.WICK_MIN_PCT) {
    const hit = (levels?.support || []).filter((s) => isNum(s) && l <= s + zone && c > s).sort((a, b) => Math.abs(a - l) - Math.abs(b - l))[0];
    if (hit != null) return { dir: "bullish", level: hit, extreme: l, wickPct: lowerPct, bodyPct };
  }
  return null;
}

/**
 * Sweep / fakeout dalam SWEEP_LOOKBACK candle closed terakhir:
 *   bearish : high > resistance tetapi close < resistance  (stop di atas level tersapu, harga kembali turun)
 *   bullish : low  < support    tetapi close > support     (stop di bawah level tersapu, harga kembali naik)
 * Candle paling baru didahulukan. `closedBack` = close candle TERAKHIR sudah di sisi yang benar (di bawah resistance /
 * di atas support), dipakai gerbang entri untuk "boleh entry hanya setelah close di sisi yang benar".
 * @returns {{dir:"bearish"|"bullish", level:number, extreme:number, barsAgo:number, closedBack:boolean}|null}
 */
function sweep(candles, levels, cfg = CFG) {
  if (!candles?.length) return null;
  const last = candles[candles.length - 1];
  const n = Math.min(cfg.SWEEP_LOOKBACK, candles.length);
  for (let back = 0; back < n; back++) {
    const k = candles[candles.length - 1 - back];
    if (![k.h, k.l, k.c].every(isNum)) continue;
    // Level yang disapu bisa sudah di bawah/atas harga terakhir; cocokkan terhadap candle itu sendiri.
    const res = (levels?.resistance || []).filter((r) => isNum(r) && k.h > r && k.c < r).sort((a, b) => a - b)[0]; // penetrasi terdalam = resistance terendah yang tertembus
    const sup = (levels?.support || []).filter((s) => isNum(s) && k.l < s && k.c > s).sort((a, b) => b - a)[0]; // penetrasi terdalam = support tertinggi yang tertembus
    // Bila dua-duanya (candle sangat besar), pilih yang penetrasinya lebih dalam.
    const pen = (x) => (x == null ? -1 : x.depth);
    const A = res != null ? { dir: "bearish", level: res, extreme: k.h, depth: k.h - res } : null;
    const B = sup != null ? { dir: "bullish", level: sup, extreme: k.l, depth: sup - k.l } : null;
    const pick = pen(A) >= pen(B) ? A : B;
    if (pick) {
      const closedBack = pick.dir === "bearish" ? last.c < pick.level : last.c > pick.level;
      return { dir: pick.dir, level: pick.level, extreme: pick.extreme, barsAgo: back, closedBack };
    }
  }
  return null;
}

/**
 * Candle ekspansi: range candle terakhir dibanding ATR(14) SEBELUM candle itu (jadi candle itu tidak ikut
 * menaikkan pembanginya). `atrBefore` = ATR dari candle sebelum candle terakhir.
 * @returns {{ratio:number, expanded:boolean, dir:"up"|"down"|"flat"}|null}
 */
function rangeAtr(candle, atrBefore, cfg = CFG) {
  if (!candle || !isNum(atrBefore) || atrBefore <= 0) return null;
  const range = candle.h - candle.l;
  if (!isNum(range) || range < 0) return null;
  const ratio = range / atrBefore;
  const dir = candle.c > candle.o ? "up" : candle.c < candle.o ? "down" : "flat";
  return { ratio, expanded: ratio >= cfg.EXPANSION_ATR, dir };
}

/**
 * Lonjakan volume candle terakhir terhadap rata-rata VOLUME_LOOKBACK candle closed SEBELUMNYA.
 * Mengembalikan null bila volume tidak tersedia (mis. data lama tanpa field v) atau rata-rata nol, jadi
 * pemanggil tahu "tidak bisa dinilai" dan bukan "tidak ada lonjakan".
 * @returns {{ratio:number, spike:boolean, dir:"up"|"down"|"flat"}|null}
 */
function volumeSpike(candles, cfg = CFG) {
  const n = candles?.length || 0;
  if (n < cfg.VOLUME_LOOKBACK + 1) return null;
  const last = candles[n - 1];
  const prev = candles.slice(n - 1 - cfg.VOLUME_LOOKBACK, n - 1);
  if (!isNum(last.v) || !prev.every((k) => isNum(k.v))) return null;
  const avg = prev.reduce((a, k) => a + k.v, 0) / prev.length;
  if (!(avg > 0)) return null;
  const ratio = last.v / avg;
  const dir = last.c > last.o ? "up" : last.c < last.o ? "down" : "flat";
  return { ratio, spike: ratio >= cfg.VOLUME_MULT, dir };
}

/**
 * Gerak cepat (live): perubahan harga dalam RAPID_MINUTES terakhir, diukur dalam ATR TF yang dipakai.
 * @param {{t:number, price:number}[]} samples sampel harga urut lama -> baru (mis. dari polling ticker)
 * @param {number} atr ATR TF itu
 * @param {number} [now]
 * @returns {{moveAtr:number, dir:"up"|"down", fast:boolean}|null} null bila sampel belum cukup menutup jendela
 *   (minimal separuh jendela), supaya tidak menyimpulkan dari dua titik yang berdekatan.
 */
function rapidMove(samples, atr, now = Date.now(), cfg = CFG) {
  if (!Array.isArray(samples) || samples.length < 2 || !isNum(atr) || atr <= 0) return null;
  const windowMs = cfg.RAPID_MINUTES * 60_000;
  const inWin = samples.filter((s) => isNum(s?.t) && isNum(s?.price) && s.t >= now - windowMs && s.t <= now);
  if (inWin.length < 2) return null;
  const first = inWin[0];
  const last = inWin[inWin.length - 1];
  if (last.t - first.t < windowMs / 2) return null;
  const move = (last.price - first.price) / atr;
  return { moveAtr: Math.abs(move), dir: move >= 0 ? "up" : "down", fast: Math.abs(move) >= cfg.RAPID_ATR };
}

// =====================================================================
// 2. Bantu: ukuran posisi dan geser SL
// =====================================================================

/** Ukuran posisi = risiko uang / |entry - SL|. null bila input tidak valid atau jarak SL nol. */
function positionSize(riskMoney, entry, sl) {
  if (![riskMoney, entry, sl].every(isNum) || riskMoney <= 0) return null;
  const dist = Math.abs(entry - sl);
  return dist > 0 ? riskMoney / dist : null;
}

/**
 * SL hanya boleh digeser searah profit: long -> naik saja, short -> turun saja. Usulan yang melebarkan SL diabaikan.
 * @returns {number} SL yang berlaku
 */
function trailStop(dir, currentSl, proposedSl) {
  if (!isNum(proposedSl)) return currentSl;
  if (!isNum(currentSl)) return proposedSl;
  return dir === "long" ? Math.max(currentSl, proposedSl) : Math.min(currentSl, proposedSl);
}

// =====================================================================
// 3. Gerbang entri
// =====================================================================

/**
 * Nilai kondisi pasar terakhir dari candle closed. Dipisah supaya assessEntry dan assessPosition memakai
 * pembacaan yang sama.
 */
function readMarket(candles, levels, atrSeries, cfg = CFG) {
  const n = candles?.length || 0;
  if (!n) return { expansion: null, wick: null, sweep: null, volume: null, atrNow: null };
  const last = candles[n - 1];
  const atrNow = atrSeries?.[n - 1] ?? null;
  const atrBefore = n >= 2 ? atrSeries?.[n - 2] ?? null : null;
  return {
    atrNow,
    expansion: rangeAtr(last, atrBefore, cfg),
    wick: wickReject(last, levels, atrNow ?? atrBefore, cfg),
    sweep: sweep(candles, levels, cfg),
    volume: volumeSpike(candles, cfg),
  };
}

/**
 * Nilai satu skenario LONG/SHORT. Murni, tidak mengubah input.
 *
 * @param {{
 *   dir: "long"|"short",
 *   price: number,                       // harga sekarang
 *   entry: {price:number, kind:string},  // dari pickEntry
 *   sl: {price:number},                  // SL dasar dari pickStopLoss
 *   tps: {price:number}[],               // TP dasar; jaraknya dihitung sebagai kelipatan risiko dasar (R)
 *   atr: number,                         // ATR(14) candle closed terakhir
 *   candles: object[], atrSeries: (number|null)[],  // atrSeries sejajar dengan candles
 *   levels: {resistance:number[], support:number[]},
 *   emas?: Record<number, number|null>,
 *   slMaxAtr?: number                    // batas SL_MAX_ATR dari SIGNAL_CONFIG (pengaman)
 * }} input
 * @returns {{
 *   status: "VALID"|"TUNGGU"|"HINDARI",
 *   conditional: boolean,                // VALID bersyarat (sweep: entry hanya setelah close di sisi benar)
 *   reasons: {code:string, vars:object}[],
 *   sl: number, slWidened: boolean, volatile: boolean,
 *   rr1: number|null,                    // RR ke TP1 dari angka final
 *   tps: {price:number}[],               // TP final: kelipatan R yang SAMA dari risiko final (ikut menjauh bila SL dilebarkan)
 *   pullback: {price:number, source:string}|null,
 *   confirmAt: number|null,              // tunggu close melewati harga ini (wick reject)
 *   market: object
 * }}
 */
function assessEntry(input, cfg = CFG) {
  const { dir, price, entry, sl, tps, atr, candles, atrSeries, levels, emas } = input;
  const slMaxAtr = input.slMaxAtr ?? 4;
  const s = sgn(dir);
  const reasons = [];
  const base = { status: STATUS.VALID, conditional: false, reasons, sl: sl?.price, slWidened: false, volatile: false, rr1: null, tps: tps || [], pullback: null, confirmAt: null, market: null };
  if (![price, entry?.price, sl?.price, atr].every(isNum) || atr <= 0 || !tps?.length || !candles?.length) return base;
  if (Math.abs(entry.price - sl.price) <= 0) return base;

  const mk = readMarket(candles, levels, atrSeries, cfg);
  base.market = mk;
  const exp = mk.expansion;
  const vol = mk.volume;
  const wantUp = dir === "long";
  const against = (d) => (wantUp ? d === "bearish" : d === "bullish"); // arah wick/sweep melawan entry

  let hindari = false;
  let tunggu = false;

  // --- Volatilitas tinggi: ekspansi atau lonjakan volume ---
  const volatile = !!(exp?.expanded || vol?.spike);
  base.volatile = volatile;
  if (vol?.spike) reasons.push({ code: "volSpike", vars: { x: vol.ratio } });

  // --- Sweep / wick reject: ekstrem untuk SL dan syarat konfirmasi ---
  const sw = mk.sweep;
  const wk = mk.wick;
  let slExtreme = null; // ekstrem yang mendukung arah entry -> SL harus di luarnya
  if (sw) {
    if (against(sw.dir)) {
      // Sweep melawan arah entry (mis. long, tapi baru sweep ke atas lalu balik turun).
      tunggu = true;
      reasons.push({ code: "sweepAgainst", vars: { lvl: sw.level } });
      base.confirmAt = sw.extreme;
    } else if (sw.closedBack) {
      // Fakeout searah arah kembali, candle terakhir sudah close di sisi benar: VALID bersyarat.
      base.conditional = true;
      slExtreme = sw.extreme;
      reasons.push({ code: "sweepWith", vars: { lvl: sw.level, ext: sw.extreme } });
    } else {
      // Sweep searah entry tetapi close terakhir belum di sisi benar: belum boleh.
      tunggu = true;
      reasons.push({ code: "sweepNoClose", vars: { lvl: sw.level } });
      base.confirmAt = sw.level;
    }
  }
  if (wk) {
    if (against(wk.dir)) {
      tunggu = true;
      reasons.push({ code: "wickAgainst", vars: { lvl: wk.level, wick: wk.wickPct * 100, vol: vol?.ratio ?? null } });
      // Konfirmasi = close menembus ekstrem wick (long: di atas high wick, short: di bawah low wick).
      base.confirmAt = base.confirmAt ?? wk.extreme;
    } else {
      slExtreme = slExtreme == null ? wk.extreme : wantUp ? Math.min(slExtreme, wk.extreme) : Math.max(slExtreme, wk.extreme);
    }
  }

  // --- Candle terakhir ekspansi searah entry: jangan kejar ---
  if (exp?.expanded && ((wantUp && exp.dir === "up") || (!wantUp && exp.dir === "down"))) {
    tunggu = true;
    reasons.push({ code: "expansion", vars: { x: exp.ratio } });
    // Pullback ke EMA20 (bila ada di sisi pullback) atau level terdekat.
    const e20 = emas?.[20];
    if (isNum(e20) && (wantUp ? e20 < price : e20 > price)) base.pullback = { price: e20, source: "EMA20" };
    else {
      const pool = (wantUp ? levels?.support : levels?.resistance) || [];
      const near = pool.filter((v) => isNum(v) && (wantUp ? v < price : v > price)).sort((a, b) => Math.abs(a - price) - Math.abs(b - price))[0];
      if (near != null) base.pullback = { price: near, source: wantUp ? "S1" : "R1" };
    }
  }

  // --- Harga sudah lari jauh melewati entry rencana (kecuali gaya retest: harga memang di seberang entry) ---
  if (entry.kind !== "retest" && (price - entry.price) * s > cfg.CHASE_ATR * atr) {
    hindari = true;
    reasons.push({ code: "chase", vars: { x: ((price - entry.price) * s) / atr } });
  }

  // --- Stop loss: di luar ekstrem + buffer; lebar 1,25x saat volatil; tidak pernah lebih sempit dari dasar ---
  const baseDist = Math.abs(entry.price - sl.price);
  let dist = baseDist * (volatile ? cfg.VOL_SL_MULT : 1);
  if (slExtreme != null) {
    const needed = (entry.price - slExtreme) * s + cfg.SL_BUFFER_ATR * atr; // jarak entry -> (ekstrem - buffer)
    if (needed > dist) dist = needed;
  }
  const finalSl = entry.price - s * dist;
  const widened = dist > baseDist + 1e-12;
  base.sl = finalSl;
  base.slWidened = widened;
  if (widened) reasons.push({ code: "slWidened", vars: { sl: finalSl, mult: dist / baseDist, sized: true } });

  if (dist > slMaxAtr * atr) {
    hindari = true;
    reasons.push({ code: "slTooWide", vars: { x: dist / atr, max: slMaxAtr } });
  }

  // --- TP final + RR dari angka final ---
  // TP dipertahankan sebagai kelipatan R yang sama dari risiko FINAL (SL melebar -> TP ikut menjauh), jadi RR tidak
  // jatuh hanya karena SL dilebarkan oleh filter volatilitas. Konsekuensinya TP lebih jauh = lebih sulit tercapai;
  // itu sebabnya ukuran posisi dikecilkan (lihat alasan slWidened). Pemeriksaan MIN_RR tetap berlaku sebagai pengaman
  // bila TP_RR[0] dikonfigurasi di bawah MIN_RR.
  base.tps = tps.map((tp) => {
    const mult = Math.abs(tp.price - entry.price) / baseDist;
    return { ...tp, price: entry.price + s * mult * dist };
  });
  const rr1 = dist > 0 ? Math.abs(base.tps[0].price - entry.price) / dist : null;
  base.rr1 = rr1;
  if (rr1 != null && rr1 < cfg.MIN_RR - 1e-9) {
    hindari = true;
    reasons.push({ code: "rrLow", vars: { rr: rr1, min: cfg.MIN_RR } });
  }

  base.status = hindari ? STATUS.HINDARI : tunggu ? STATUS.TUNGGU : STATUS.VALID;
  if (base.status !== STATUS.VALID) base.conditional = false;
  return base;
}

// =====================================================================
// 4. Peringatan setelah entri
// =====================================================================

/**
 * Nilai posisi yang sedang berjalan. `candles` = candle closed TERBARU (idealnya sejak entri); `candlesSince` =
 * jumlah candle TF yang sudah lewat sejak entri. `rapid` opsional dari rapidMove (live).
 *
 * @param {{
 *   dir: "long"|"short", entry: number, sl: number, price: number, atr: number,
 *   candles: object[], atrSeries?: (number|null)[], levels?: object,
 *   candlesSince?: number, rapid?: {moveAtr:number, dir:"up"|"down"}|null
 * }} input
 * @returns {{
 *   level: "INFO"|"WASPADA"|"CUT", reasons: {code:string, vars:object}[],
 *   timeStop: boolean, moveToBreakEven: boolean, profitR: number|null, adverseAtr: number
 * }}
 */
function assessPosition(input, cfg = CFG) {
  const { dir, entry, sl, price, atr, candles, atrSeries, levels, candlesSince, rapid } = input;
  const out = { level: LEVEL.INFO, reasons: [], timeStop: false, moveToBreakEven: false, profitR: null, adverseAtr: 0 };
  if (![entry, sl, price, atr].every(isNum) || atr <= 0) return out;
  const s = sgn(dir);
  const longPos = dir === "long";
  const risk = Math.abs(entry - sl);
  const adverse = ((entry - price) * s) / atr; // > 0 = harga melawan posisi
  out.adverseAtr = Math.max(0, adverse);
  out.profitR = risk > 0 ? ((price - entry) * s) / risk : null;

  const mk = candles?.length ? readMarket(candles, levels, atrSeries, cfg) : { wick: null, sweep: null, volume: null };
  const last = candles?.length ? candles[candles.length - 1] : null;
  const againstDir = (d) => (longPos ? d === "bearish" : d === "bullish");
  const againstCandle = (d) => (longPos ? d === "down" : d === "up");

  // --- CUT ---
  const closeBeyondSl = last && isNum(last.c) && (longPos ? last.c < sl : last.c > sl);
  if (closeBeyondSl) out.reasons.push({ code: "cutClose", vars: { sl, close: last.c } });
  const rapidAgainst = rapid && (longPos ? rapid.dir === "down" : rapid.dir === "up") && rapid.moveAtr >= cfg.CUT_RAPID_ATR;
  if (rapidAgainst && mk.volume?.spike) out.reasons.push({ code: "cutRapid", vars: { x: rapid.moveAtr, vol: mk.volume.ratio } });
  const isCut = out.reasons.length > 0;

  // --- WASPADA ---
  const warn = [];
  if (adverse >= cfg.WARN_ADVERSE_ATR) warn.push({ code: "warnAdverse", vars: { x: adverse } });
  if (mk.wick && againstDir(mk.wick.dir)) warn.push({ code: "warnWick", vars: { lvl: mk.wick.level, wick: mk.wick.wickPct * 100 } });
  if (mk.sweep && againstDir(mk.sweep.dir) && mk.sweep.barsAgo === 0) warn.push({ code: "warnSweep", vars: { lvl: mk.sweep.level } });
  if (mk.volume?.spike && againstCandle(mk.volume.dir)) warn.push({ code: "warnVolume", vars: { x: mk.volume.ratio } });

  if (isCut) out.level = LEVEL.CUT;
  else if (warn.length) {
    out.level = LEVEL.WASPADA;
    out.reasons.push(...warn);
  }

  // --- Time stop (pengingat, tidak menaikkan level) ---
  if (isNum(candlesSince) && candlesSince >= cfg.TIME_STOP_CANDLES && ((price - entry) * s) / atr < cfg.TIME_STOP_PROGRESS_ATR) {
    out.timeStop = true;
  }

  // --- Saran break-even: sudah profit >= BREAKEVEN_AT_R dan SL masih di sisi rugi ---
  const slStillLoss = longPos ? sl < entry : sl > entry;
  if (out.profitR != null && out.profitR >= cfg.BREAKEVEN_AT_R && slStillLoss) out.moveToBreakEven = true;
  if (out.level === LEVEL.WASPADA && out.profitR != null && out.profitR > 0 && slStillLoss) out.moveToBreakEven = true;

  return out;
}

module.exports = {
  STATUS,
  LEVEL,
  wickReject,
  sweep,
  rangeAtr,
  volumeSpike,
  rapidMove,
  positionSize,
  trailStop,
  readMarket,
  assessEntry,
  assessPosition,
};
