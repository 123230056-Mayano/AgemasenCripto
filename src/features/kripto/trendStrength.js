"use strict";

/**
 * features/kripto/trendStrength.js
 * ------------------------------------------------------------------
 * Fitur 3: KEKUATAN TREN (seberapa kuat tren sekarang), dijelaskan lewat alasan [+] / [-]. Logika MURNI: tanpa fetch,
 * tanpa i18n, tanpa canvas, bisa diuji unit (src/test/trendStrength.test.js).
 *
 * Beda dengan !trenstate: trenState menjawab "lanjut atau berbalik"; modul ini menjawab "seberapa kuat". Tidak ada rumus
 * indikator baru: hanya menggabungkan hhllCore (swing), trenStateTrendline (kemiringan + R2), trenState (kedalaman retrace,
 * tren TF besar), dan geo() dari candlePatterns (body / sumbu).
 *
 * Tujuh komponen, masing-masing ya (true) / tidak (false) / tidak bisa dinilai (null, tidak dihitung):
 *   swing    HH+HL (naik) / LL+LH (turun) berurutan >= SWING_RUN_MIN swing
 *   slope    kemiringan garis searah tren >= SLOPE_ATR_MIN x ATR per candle (garis swing; cadangan: regresi)
 *   r2       kerapian garis: R2 regresi >= R2_MIN dan arah regresi searah tren
 *   candles  >= CANDLE_MIN dari CANDLE_BARS candle terakhir: searah, body besar, sumbu melawan pendek
 *   retrace  retrace leg terakhir <= RETRACE_MAX (dangkal)
 *   volume   rata-rata volume candle searah >= VOL_RATIO_MIN x candle berlawanan (VOL_BARS terakhir)
 *   htf      TF besar searah (TF besar range / tidak tersedia = tidak dinilai, tidak membantu dan tidak merugikan)
 *
 * Keluaran tiga tingkat: strong / medium / weak (bukan persen; skor internal tidak ditampilkan):
 *   - struktur sudah patah (status REVERSAL di trenState) = weak
 *   - komponen yang bisa dinilai < MIN_APPLICABLE = paling tinggi weak (terlalu sedikit bukti, tidak menebak)
 *   - lolos >= STRONG_RATIO = strong, <= WEAK_RATIO = weak, selain itu medium
 *   - tren "range" tidak diberi kekuatan (state "range"); data < MIN_CANDLES = state "nodata"
 *
 * Aturan: hanya candle CLOSED, tanpa lookahead (TF besar lewat htfClosedAt di dalam htfTrendOf). Semua ambang di
 * STRENGTH_CONFIG: nilai awal usulan, BELUM divalidasi backtest, jadi tampilkan sebagai heuristik awal.
 */

const { STRENGTH_CONFIG: CFG } = require("../../config/indicatorConfig");
const { atr: atrSeries } = require("./indicators");
const { computeStructure } = require("./hhllCore");
const { computeTrendlines, regressionChannel } = require("./trenStateTrendline");
const { assessRaw, htfTrendOf, STATUS } = require("./trenState");
const { alignOf } = require("./hhllContext");
const { geo } = require("./candlePatterns");

const isNum = (v) => typeof v === "number" && isFinite(v);
const lastNum = (arr) => [...arr].reverse().find(isNum);
const item = (key, ok, value = null) => ({ key, ok, value });
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** Berapa swing berlabel terakhir yang beruntun searah tren (naik: HH / HL, turun: LL / LH). Berhenti di swing pertama yang tidak searah. */
function swingRun(swings, up) {
  const labeled = swings.filter((s) => s.label);
  const ok = up ? new Set(["HH", "HL"]) : new Set(["LL", "LH"]);
  let run = 0;
  for (let k = labeled.length - 1; k >= 0 && ok.has(labeled[k].label); k--) run++;
  return { run, total: labeled.length };
}

/** Komponen candle: hitung candle terakhir yang searah, body besar (>= BODY_ATR_MIN x ATR) dan sumbu melawan pendek. */
function candleCount(closed, up, atr) {
  const bars = closed.slice(-CFG.CANDLE_BARS);
  let count = 0;
  for (const c of bars) {
    const g = geo(c);
    const withDir = up ? g.up : g.down;
    const wickAgainst = up ? g.upperPct : g.lowerPct;
    if (withDir && g.body >= CFG.BODY_ATR_MIN * atr && wickAgainst <= CFG.WICK_AGAINST_MAX) count++;
  }
  return { count, of: bars.length };
}

/** Rasio rata-rata volume candle searah terhadap berlawanan pada VOL_BARS candle terakhir; null kalau volume / salah satu sisi tidak ada. */
function volumeBias(closed, up) {
  const bars = closed.slice(-CFG.VOL_BARS);
  if (bars.length < CFG.VOL_BARS || !bars.every((c) => isNum(c.v))) return null;
  const withV = bars.filter((c) => (up ? c.c > c.o : c.c < c.o)).map((c) => c.v);
  const againstV = bars.filter((c) => (up ? c.c < c.o : c.c > c.o)).map((c) => c.v);
  if (!withV.length || !againstV.length) return null;
  const denom = mean(againstV);
  return denom > 0 ? mean(withV) / denom : null;
}

/**
 * @param {object[]} candles candle closed urut lama -> baru ({t,o,h,l,c,v}); candle yang closed === false dibuang
 * @param {object[]|null} htfCandles candle TF besar (boleh belum difilter; htfClosedAt membuang yang belum closed saat candle terakhir closed)
 * @param {{tf?:string, trendline?:object|null, cache?:Map, minApplicable?:number}} [opts] tf wajib agar TF besar & retrace bisa dinilai (tanpa tf: dua komponen itu null);
 *   trendline = hasil computeTrendlines yang sudah ada (hemat hitung); undefined = hitung sendiri
 * @returns {{state:"ok"|"range"|"nodata", level:"strong"|"medium"|"weak"|null, dir:"up"|"down"|null,
 *   items:{key:string, ok:boolean|null, value:any}[], score:number, applicable:number, capped:boolean, broken:boolean,
 *   htfTf:string|null, htfTrend:string|null, rawStatus:string|null, levels:{extreme:number|null, invalidation:number|null}|null, atr:number}}
 *   rawStatus + levels = dari trenState (dipakai backtest untuk menilai "lanjut" vs "gagal"), null kalau tf tidak diberikan
 */
function trendStrength(candles, htfCandles, opts = {}) {
  const none = (state, extra = {}) => ({ state, level: null, dir: null, items: [], score: 0, applicable: 0, capped: false, broken: false, htfTf: null, htfTrend: null, rawStatus: null, levels: null, atr: null, ...extra });
  const closed = Array.isArray(candles) ? candles.filter((c) => c && c.closed !== false) : [];
  const n = closed.length;
  if (n < CFG.MIN_CANDLES) return none("nodata");
  const atr = lastNum(atrSeries(closed));
  if (!isNum(atr) || !(atr > 0)) return none("nodata");

  const st = computeStructure(closed);
  if (!st.trend) return none("nodata");
  if (st.trend === "range") return none("range");
  const up = st.trend === "up";
  const dir = st.trend;
  const X = closed[n - 1];

  // TF besar (tanpa lookahead)
  const { htfTf, htfTrend } = opts.tf ? htfTrendOf(htfCandles, opts.tf, X, opts.cache) : { htfTf: null, htfTrend: null };

  // garis: swing (searah tren) lalu regresi sebagai cadangan; regresi selalu dihitung untuk R2
  let tl = opts.trendline;
  if (tl === undefined) {
    try {
      tl = computeTrendlines(closed, st.swings, { atr, dir });
    } catch {
      tl = null;
    }
  }
  const reg = (tl && tl.regression) || regressionChannel(closed, atr);
  const line = tl ? (up ? tl.support : tl.resistance) : null;
  const slopeAtr = line && isNum(line.slopeAtr) ? line.slopeAtr : reg ? reg.slopeAtr : null;

  // retrace + struktur patah dari trenState (tidak ada rumus baru)
  let raw = null;
  if (opts.tf) {
    try {
      raw = assessRaw(closed, htfCandles, { tf: opts.tf, trendline: false, cache: opts.cache });
    } catch {
      raw = null;
    }
  }
  const broken = !!raw && raw.status === STATUS.REVERSAL;

  const { run, total } = swingRun(st.swings, up);
  const cc = candleCount(closed, up, atr);
  const vr = volumeBias(closed, up);
  const align = alignOf(dir, htfTrend);

  const items = [
    item("swing", total >= CFG.SWING_RUN_MIN ? run >= CFG.SWING_RUN_MIN : null, run),
    item("slope", isNum(slopeAtr) ? (up ? slopeAtr : -slopeAtr) >= CFG.SLOPE_ATR_MIN : null, isNum(slopeAtr) ? Math.abs(slopeAtr) : null),
    item("r2", reg ? reg.r2 >= CFG.R2_MIN && reg.dir === dir : null, reg ? reg.r2 : null),
    item("candles", cc.of >= CFG.CANDLE_BARS ? cc.count >= CFG.CANDLE_MIN : null, cc),
    item("retrace", broken ? false : raw && isNum(raw.depth) ? raw.depth <= CFG.RETRACE_MAX : null, raw ? raw.depth : null),
    item("volume", vr != null ? vr >= CFG.VOL_RATIO_MIN : null, vr),
    item("htf", align === "with" ? true : align === "against" ? false : null, htfTrend),
  ];

  const flags = items.filter((i) => i.ok != null);
  const applicable = flags.length;
  const score = flags.filter((i) => i.ok).length;
  const minApp = isNum(opts.minApplicable) ? opts.minApplicable : CFG.MIN_APPLICABLE; // override hanya untuk uji
  const capped = applicable < minApp;
  let level = "weak";
  if (!broken && applicable) {
    const ratio = score / applicable;
    level = ratio >= CFG.STRONG_RATIO ? "strong" : ratio <= CFG.WEAK_RATIO ? "weak" : "medium";
  }
  if (capped) level = "weak"; // bukti terlalu tipis: paling tinggi LEMAH

  return {
    state: "ok",
    level,
    dir,
    items,
    score,
    applicable,
    capped,
    broken,
    htfTf,
    htfTrend,
    rawStatus: raw ? raw.status : null,
    levels: raw ? { extreme: raw.levels.extreme, invalidation: raw.levels.invalidation } : null,
    atr,
  };
}

module.exports = { CFG, trendStrength, swingRun, candleCount, volumeBias };
