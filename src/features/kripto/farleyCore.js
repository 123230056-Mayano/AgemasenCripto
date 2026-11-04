"use strict";

/**
 * features/kripto/farleyCore.js
 * ------------------------------------------------------------------
 * Logika MURNI pendekatan Alan S. Farley untuk !farley dan !alertfarley. Tanpa fetch, tanpa i18n, tanpa store,
 * jadi bisa diuji unit. Mengikuti dokumen "Teori Indikator Alan S. Farley untuk Bot (rev 1)":
 *
 *   - Ribbon SMA 5-8-13, Bollinger 13 periode 2 SD (garis tengah = SMA 13 yang SAMA, dihitung sekali),
 *     Stochastic lima-bar yang dihaluskan, MACD 12-26-9 di timeframe konteks (bagian 3-6, 8).
 *   - Hanya candle CLOSED (bagian 10): pemanggil wajib membuang candle yang masih berjalan.
 *   - Indikator searah dikelompokkan per jenis informasi, tidak dijumlah sebagai bukti independen:
 *     arah tren (ribbon) -> volatilitas (Bollinger) -> momentum osilasi (Stochastic) -> momentum menengah (MACD TF besar).
 *   - Keluaran = kondisi + alasan + skenario bersyarat (BUY / SELL, SL, TP). Bukan perintah dan bukan jaminan.
 *
 * Aturan skenario (semua angka di config/indicatorConfig.js -> FARLEY_CONFIG; yang bukan dari buku = DEFAULT SISTEM):
 *   Syarat dasar BUY : ribbon bullish (SMA5 > SMA8 > SMA13, ketiganya miring naik, lebar tidak terkompresi) dan close > SMA13.
 *   Pemicu BUY       : (a) PULLBACK  - low menyentuh area SMA8 dalam PULLBACK_BARS candle tanpa close di bawah SMA13,
 *                                       close X kembali di atas SMA8, Stochastic berbalik naik dan belum overbought.
 *                      (b) BREAKOUT  - close X di atas high tertinggi BREAKOUT_BARS candle sebelumnya, bandwidth Bollinger
 *                                       tidak menyempit (tembusan saat volatilitas rendah rawan palsu).
 *   Penahan          : struktur TF besar berlawanan (counter-trend), risiko SL terlalu lebar, atau level lawan terlalu dekat
 *                      -> status TUNGGU, bukan BUY/SELL. Breakout juga ditahan bila sudah melar (%B di luar pita, jauh dari SMA 8,
 *                      atau Stochastic baru berbalik), kecuali pullback valid.
 *   SL               : di luar low (BUY) / high (SELL) SL_SWING_BARS candle terakhir atau SMA 13 (yang lebih jauh) + buffer ATR,
 *                      jarak dijepit minimal MIN_RISK_ATR x ATR (stop satu candle sangat bergantung volatilitas).
 *   TP               : TP1 = TP1_R x risiko, TP2 = TP2_R x risiko. Level S/R lawan terdekat dilaporkan; kalau ia memotong TP1 diberi catatan.
 *                      Aturan keluar dari artikel (take profit saat persilangan SMA berikutnya) ditampilkan sebagai aturan dinamis.
 *   SELL             : cermin dari BUY.
 *
 * Status: "buy" | "sell" | "wait" | "range" | "nodata".
 */

const { FARLEY_CONFIG: CFG } = require("../../config/indicatorConfig");
const { atr, macd } = require("./indicators");
const { computeStructure } = require("./hhllCore");

const last = (a) => (a.length ? a[a.length - 1] : null);

// =====================================================================
// 1. Indikator
// =====================================================================
/** SMA sepanjang `values`; null sebelum n nilai non-null berurutan tersedia. */
function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) {
      sum = 0;
      run = 0;
      continue;
    }
    sum += v;
    run++;
    if (run > n) sum -= values[i - n];
    if (run >= n) out[i] = sum / n;
  }
  return out;
}

/**
 * Bollinger Bands. Garis tengah dipakai dari `mid` (SMA yang sudah dihitung) supaya SMA 13 ribbon dan garis tengah
 * pita adalah satu garis yang sama. Standar deviasi populasi (cara Bollinger).
 * @returns {{mid:(number|null)[], upper:(number|null)[], lower:(number|null)[], bandwidth:(number|null)[], pctB:(number|null)[]}}
 */
function bollinger(closes, n, k, mid) {
  const len = closes.length;
  const upper = new Array(len).fill(null);
  const lower = new Array(len).fill(null);
  const bandwidth = new Array(len).fill(null);
  const pctB = new Array(len).fill(null);
  for (let i = n - 1; i < len; i++) {
    if (mid[i] == null) continue;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(ss / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
    bandwidth[i] = mid[i] !== 0 ? (upper[i] - lower[i]) / mid[i] : null;
    const w = upper[i] - lower[i];
    pctB[i] = w > 0 ? (closes[i] - lower[i]) / w : null;
  }
  return { mid, upper, lower, bandwidth, pctB };
}

/**
 * Stochastic dihaluskan. %K mentah = 100 x (C - LL_n) / (HH_n - LL_n); %K lambat = SMA(%K mentah, smooth); %D = SMA(%K lambat, d).
 * Penyebut nol (High == Low sepanjang jendela) -> pakai nilai mentah sebelumnya (atau 50 kalau belum ada), tidak NaN.
 * Parameter smooth & d = DEFAULT SISTEM, bukan setelan Farley.
 */
function stochastic(candles, n = CFG.STOCH_N, smooth = CFG.STOCH_SMOOTH, d = CFG.STOCH_D) {
  const len = candles.length;
  const raw = new Array(len).fill(null);
  let prev = 50;
  for (let i = n - 1; i < len; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (candles[j].h > hh) hh = candles[j].h;
      if (candles[j].l < ll) ll = candles[j].l;
    }
    const den = hh - ll;
    raw[i] = den > 0 ? (100 * (candles[i].c - ll)) / den : prev;
    prev = raw[i];
  }
  const k = sma(raw, smooth);
  const dd = sma(k, d);
  return { raw, k, d: dd };
}

/** Persentil nilai terakhir terhadap `lookback` nilai valid terakhir (0..100). null kalau data kurang. */
function percentileOfLast(series, lookback) {
  const vals = [];
  for (let i = series.length - 1; i >= 0 && vals.length < lookback; i--) if (series[i] != null) vals.push(series[i]);
  if (vals.length < Math.min(lookback, 20)) return null;
  const x = vals[0];
  return (vals.filter((v) => v <= x).length / vals.length) * 100;
}

// =====================================================================
// 2. Pembacaan per lapisan
// =====================================================================
/** Ribbon: urutan, kemiringan, lebar, pullback, menempel SMA 5. */
function readRibbon(candles, s5, s8, s13, a) {
  const i = candles.length - 1;
  const k = CFG.SLOPE_BARS;
  const c = candles[i].c;
  const slope = { s5: s5[i] - s5[i - k], s8: s8[i] - s8[i - k], s13: s13[i] - s13[i - k] };
  const thr = CFG.SLOPE_MIN_ATR * a;
  const up = slope.s5 >= thr && slope.s8 >= thr && slope.s13 >= thr;
  const down = slope.s5 <= -thr && slope.s8 <= -thr && slope.s13 <= -thr;
  const widthAtr = Math.abs(s5[i] - s13[i]) / a;
  const compressed = widthAtr < CFG.RIBBON_MIN_ATR;
  let state = "mixed";
  if (!compressed && s5[i] > s8[i] && s8[i] > s13[i] && up) state = "bullish";
  else if (!compressed && s5[i] < s8[i] && s8[i] < s13[i] && down) state = "bearish";

  // Pullback sehat: menyentuh area SMA 8 tanpa close menembus SMA 13, lalu close X kembali melewati SMA 8.
  const from = Math.max(0, i - CFG.PULLBACK_BARS + 1);
  let touchedBull = false;
  let touchedBear = false;
  let allAbove13 = true;
  let allBelow13 = true;
  for (let j = from; j <= i; j++) {
    if (candles[j].c < s13[j]) allAbove13 = false;
    if (candles[j].c > s13[j]) allBelow13 = false;
    if (candles[j].l <= s8[j] + CFG.TOUCH_ATR * a) touchedBull = true;
    if (candles[j].h >= s8[j] - CFG.TOUCH_ATR * a) touchedBear = true;
  }
  const pullbackBull = touchedBull && allAbove13 && c > s8[i];
  const pullbackBear = touchedBear && allBelow13 && c < s8[i];

  // Menempel SMA 5 (tren kuat): tiga close terakhir dekat SMA 5. Informasi saja.
  let hug = true;
  for (let j = Math.max(0, i - 2); j <= i; j++) if (Math.abs(candles[j].c - s5[j]) > CFG.HUG_ATR * a) hug = false;

  return {
    state,
    sma5: s5[i],
    sma8: s8[i],
    sma13: s13[i],
    widthPct: ((s5[i] - s13[i]) / c) * 100,
    widthAtr,
    compressed,
    slope,
    phase: c >= s13[i] ? "above" : "below", // fase relatif terhadap garis tengah
    pullbackBull,
    pullbackBear,
    hug,
  };
}

/** Bollinger 13,2: bandwidth, %B, status squeeze / normal / ekspansi, dan apakah bandwidth sedang menyempit atau melebar. */
function readBollinger(bb, i) {
  const bw = bb.bandwidth[i];
  const pct = percentileOfLast(bb.bandwidth.slice(0, i + 1), CFG.BW_LOOKBACK);
  let state = "normal";
  if (pct != null && pct <= CFG.BW_SQUEEZE_PCT) state = "squeeze";
  else if (pct != null && pct >= CFG.BW_EXPAND_PCT) state = "expansion";
  const ref = bb.bandwidth[i - 3];
  const trend = ref == null || bw == null ? null : bw > ref ? "widening" : bw < ref ? "narrowing" : "flat";
  return { mid: bb.mid[i], upper: bb.upper[i], lower: bb.lower[i], bandwidth: bw, bwPercentile: pct, pctB: bb.pctB[i], state, trend };
}

/** Stochastic: posisi, zona, persilangan, arah berbalik. */
function readStoch(st, i) {
  const k = st.k[i];
  const d = st.d[i];
  const kp = st.k[i - 1];
  const dp = st.d[i - 1];
  if (k == null || d == null || kp == null || dp == null) return null;
  const zone = k >= CFG.STOCH_OB ? "overbought" : k <= CFG.STOCH_OS ? "oversold" : "mid";
  return {
    k,
    d,
    zone,
    crossUp: kp <= dp && k > d,
    crossDown: kp >= dp && k < d,
    turnUp: k > d && k > kp,
    turnDown: k < d && k < kp,
  };
}

/** Konteks timeframe besar: struktur (HH/HL vs LH/LL) + histogram MACD 12-26-9 dari candle closed TF besar. */
function readContext(ctxCandles, ctxTf, self) {
  if (!ctxCandles || ctxCandles.length < CFG.MIN_HTF_CANDLES) return { tf: ctxTf, self, trend: null, macd: null };
  const structure = computeStructure(ctxCandles);
  const m = macd(ctxCandles.map((c) => c.c), CFG.MACD_FAST, CFG.MACD_SLOW, CFG.MACD_SIGNAL);
  const h = m.hist;
  const now = h[h.length - 1];
  const prev = h[h.length - 2];
  let macdInfo = null;
  if (now != null && prev != null) {
    macdInfo = { hist: now, prevHist: prev, sign: now >= 0 ? "pos" : "neg", direction: now > prev ? "rising" : now < prev ? "falling" : "flat" };
  }
  return { tf: ctxTf, self, trend: structure.trend, macd: macdInfo };
}

// =====================================================================
// 3. Skenario
// =====================================================================
/** SL / TP satu arah. @returns {{ok:true, entry, sl, tp1, tp2, risk, riskAtr, rr1, rr2, widened:boolean}|{ok:false, reason:string}} */
function planLevels(candles, dir, s13, a, levels) {
  const i = candles.length - 1;
  const entry = candles[i].c;
  const win = candles.slice(Math.max(0, i - CFG.SL_SWING_BARS + 1), i + 1);
  let sl;
  if (dir === "buy") sl = Math.min(...win.map((x) => x.l), s13[i]) - CFG.SL_BUFFER_ATR * a;
  else sl = Math.max(...win.map((x) => x.h), s13[i]) + CFG.SL_BUFFER_ATR * a;
  let risk = dir === "buy" ? entry - sl : sl - entry;
  let widened = false;
  if (risk < CFG.MIN_RISK_ATR * a) {
    risk = CFG.MIN_RISK_ATR * a;
    sl = dir === "buy" ? entry - risk : entry + risk;
    widened = true;
  }
  if (risk > CFG.MAX_RISK_ATR * a) return { ok: false, reason: "risk", risk, riskAtr: risk / a };
  const sign = dir === "buy" ? 1 : -1;
  const tp1 = entry + sign * CFG.TP1_R * risk;
  const tp2 = entry + sign * CFG.TP2_R * risk;
  // Level lawan terdekat (resistance untuk BUY, support untuk SELL).
  const opp = dir === "buy" ? levels?.resistance?.[0] : levels?.support?.[0];
  let level = null;
  if (opp != null && (dir === "buy" ? opp > entry : opp < entry)) {
    const room = Math.abs(opp - entry) / risk;
    if (room < CFG.MIN_RR_TO_LEVEL) return { ok: false, reason: "levelNear", level: opp, room, risk, riskAtr: risk / a };
    level = { price: opp, room, cutsTp1: room < CFG.TP1_R, cutsTp2: room < CFG.TP2_R };
  }
  return { ok: true, entry, sl, tp1, tp2, risk, riskAtr: risk / a, rr1: CFG.TP1_R, rr2: CFG.TP2_R, widened, level };
}

/**
 * Hitung kondisi dan skenario Farley dari candle CLOSED.
 * @param {object[]} candles candle closed TF yang dianalisis ({t,o,h,l,c,v})
 * @param {{ ctxCandles?: object[]|null, ctxTf?: string|null, levels?: {resistance:number[], support:number[]} }} [opts]
 *   ctxCandles = candle CLOSED TF besar (hanya yang sudah tutup pada waktu candle X tutup). null/kurang = konteks "tidak tersedia".
 *   Untuk 1D (tanpa TF lebih besar) pemanggil mengirim candles itu sendiri dengan ctxSelf = true.
 * @returns {object}
 */
function computeFarley(candles, opts = {}) {
  const n = candles?.length || 0;
  if (n < CFG.MIN_CANDLES) return { status: "nodata", reason: "candles", have: n, need: CFG.MIN_CANDLES };
  const closes = candles.map((c) => c.c);
  const i = n - 1;
  const atrSeries = atr(candles);
  const a = atrSeries[i];
  if (a == null || !(a > 0)) return { status: "nodata", reason: "atr", have: n, need: CFG.MIN_CANDLES };

  const s5 = sma(closes, CFG.SMA_FAST);
  const s8 = sma(closes, CFG.SMA_MID);
  const s13 = sma(closes, CFG.SMA_SLOW); // satu-satunya SMA 13: dipakai ribbon DAN garis tengah Bollinger
  const bb = bollinger(closes, CFG.BB_PERIOD, CFG.BB_K, s13);
  const stochSeries = stochastic(candles);
  if (s5[i - CFG.SLOPE_BARS] == null || s13[i - CFG.SLOPE_BARS] == null || bb.upper[i] == null) {
    return { status: "nodata", reason: "warmup", have: n, need: CFG.MIN_CANDLES };
  }

  const price = closes[i];
  const ribbon = readRibbon(candles, s5, s8, s13, a);
  const boll = readBollinger(bb, i);
  const stoch = readStoch(stochSeries, i);
  const ctx = readContext(opts.ctxCandles, opts.ctxTf ?? null, !!opts.ctxSelf);
  const levels = opts.levels || { resistance: [], support: [] };

  // Volume: informasi tambahan saja (bukan syarat). Bandingkan volume X dengan rata-rata candle sebelumnya.
  let volume = null;
  const vFrom = Math.max(0, i - CFG.VOL_LOOKBACK);
  const vs = candles.slice(vFrom, i).map((x) => x.v).filter((v) => typeof v === "number" && v > 0);
  if (vs.length >= 5 && typeof candles[i].v === "number") {
    const avg = vs.reduce((x, y) => x + y, 0) / vs.length;
    volume = { ratio: avg > 0 ? candles[i].v / avg : null, high: avg > 0 && candles[i].v >= CFG.VOL_MULT * avg };
  }

  const base = { version: CFG.VERSION, price, atr: a, ribbon, bollinger: boll, stoch, context: ctx, levels, volume, candleT: candles[i].t };

  // Ribbon campuran / terkompresi = range: keluarkan status, jangan paksa arah.
  if (ribbon.state === "mixed") return { ...base, status: "range", dir: null, why: ribbon.compressed ? "compressed" : "mixed" };

  const dir = ribbon.state === "bullish" ? "buy" : "sell";
  const isBuy = dir === "buy";

  // Pemicu
  const brkN = CFG.BREAKOUT_BARS;
  const prior = candles.slice(Math.max(0, i - brkN), i);
  const priorHigh = Math.max(...prior.map((x) => x.h));
  const priorLow = Math.min(...prior.map((x) => x.l));
  const bwOk = boll.state !== "squeeze" && boll.trend !== "narrowing";
  const breakoutRaw = isBuy ? price > priorHigh && price > s13[i] && bwOk : price < priorLow && price < s13[i] && bwOk;
  // Anti-chasing: harga yang sudah melar (close di luar Bollinger atau jauh dari SMA 8) tidak dijadikan entry, baik untuk
  // pemicu breakout maupun pullback (candle breakout besar bisa kebetulan memenuhi syarat pullback). Stochastic yang baru
  // berbalik melawan arah hanya menahan pemicu breakout.
  const pctB = boll.pctB;
  const stretchAtr = Math.abs(price - s8[i]) / a;
  const overBand = pctB != null && (isBuy ? pctB > CFG.CHASE_PCTB_MAX : pctB < 1 - CFG.CHASE_PCTB_MAX);
  const extChase = overBand || stretchAtr > CFG.CHASE_SMA8_ATR ? { why: "extended", pctB, stretchAtr } : null;
  const stochChase = CFG.BREAKOUT_BLOCK_STOCH_CROSS && stoch && (isBuy ? stoch.crossDown : stoch.crossUp) ? { why: "stochFade", pctB, stretchAtr } : null;
  const breakout = breakoutRaw && !extChase && !stochChase;
  const pullbackSeen = isBuy ? ribbon.pullbackBull : ribbon.pullbackBear;
  const stochTurn = stoch && (isBuy ? stoch.turnUp && stoch.zone !== "overbought" : stoch.turnDown && stoch.zone !== "oversold");
  const pullback = pullbackSeen && !!stochTurn;
  const trigger = breakout ? "breakout" : pullback && !extChase ? "pullback" : null;
  // Alasan penahan hanya dilaporkan bila memang ada pemicu yang dibatalkan olehnya.
  const chase = breakoutRaw ? extChase || stochChase : pullback ? extChase : null;
  const breakoutLevel = isBuy ? priorHigh : priorLow;

  const common = { ...base, dir, trigger, pullbackSeen, breakoutLevel, invalidation: s13[i] };
  if (!trigger) return chase ? { ...common, status: "wait", why: chase.why, blocked: chase } : { ...common, status: "wait", why: "noTrigger" };

  // Penahan: konteks TF besar berlawanan.
  const counter = (isBuy && ctx.trend === "down") || (!isBuy && ctx.trend === "up");
  if (counter) return { ...common, status: "wait", why: "counter" };

  const plan = planLevels(candles, dir, s13, a, levels);
  if (!plan.ok) return { ...common, status: "wait", why: plan.reason, blocked: plan };

  return { ...common, status: dir, why: trigger, plan, ctxAligned: ctx.trend === (isBuy ? "up" : "down") };
}

// =====================================================================
// 3b. Pasar tutup (forex)
// =====================================================================
/**
 * Pasar tutup (forex akhir pekan / data macet): BUY / SELL diturunkan jadi TUNGGU dengan alasan yang jelas, rencana entry/SL/TP
 * dibuang karena belum bisa dieksekusi. RANGE / TUNGGU / data kurang tidak diubah. Mengembalikan objek BARU (sc asli utuh).
 * Tanpa `status` (kripto, 24/7) tidak melakukan apa pun.
 * @param {object} sc hasil computeFarley
 * @param {{open:boolean, reason:string|null}|null|undefined} status dari market.status() / marketStatus()
 */
function applyMarketClosed(sc, status) {
  if (!status || status.open !== false || !sc || (sc.status !== "buy" && sc.status !== "sell")) return sc;
  const { plan, ctxAligned, ...rest } = sc;
  return { ...rest, status: "wait", why: status.reason === "stale" ? "marketStale" : "marketClosed", heldFrom: sc.status };
}

// =====================================================================
// 4. Konteks TF besar untuk pemanggil
// =====================================================================
/** Timeframe konteks (null untuk 1D). */
const ctxTfOf = (tf) => CFG.HTF[tf] ?? null;

/**
 * Pilih candle konteks yang SUDAH TUTUP pada saat candle X (TF utama) tutup. Mencegah memakai candle TF besar yang masih berjalan
 * (repainting). @param {number} xCloseMs waktu tutup candle X; @param {number} ctxMs durasi candle TF konteks
 */
function closedContext(ctxCandles, xCloseMs, ctxMs) {
  if (!Array.isArray(ctxCandles)) return null;
  return ctxCandles.filter((c) => c.closed !== false && c.t + ctxMs <= xCloseMs);
}

module.exports = {
  CFG,
  sma,
  bollinger,
  stochastic,
  percentileOfLast,
  readContext,
  computeFarley,
  planLevels,
  ctxTfOf,
  closedContext,
  applyMarketClosed,
  last,
};
