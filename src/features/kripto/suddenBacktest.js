"use strict";

/**
 * features/kripto/suddenBacktest.js
 * ------------------------------------------------------------------
 * Logika MURNI backtest Sudden Move Guard (tanpa jaringan, tanpa store). I/O ada di scripts/backtest-sudden.js.
 *
 * Untuk tiap candle closed i (setelah WARMUP), skenario LONG dan SHORT dibangun dengan aturan yang sama seperti
 * signal.js (pickEntry + pickStopLoss + assessEntry), lalu disimulasikan HORIZON candle ke depan:
 *   - TP1 tercapai lebih dulu  -> hasil +rr1 (dalam R, dari risiko final)
 *   - SL tercapai lebih dulu   -> hasil -1 R
 *   - keduanya di candle yang sama -> dihitung SL (asumsi konservatif)
 *   - tidak ada yang tercapai  -> TIMEOUT, hasil = close candle terakhir terhadap entry, dalam R
 *
 * BATAS YANG HARUS DISEBUT DI LAPORAN (hasil cenderung terlalu optimistis):
 *   - entry di close candle i, tanpa slip, tanpa spread, tanpa fee, tanpa gap melewati SL;
 *   - kedua arah dinilai pada tiap candle (bukan hanya arah yang dipilih bias !sinyal);
 *   - ambang yang dilihat pada data yang sama dengan yang diukur akan tampak bagus (overfit): pakai pembagian waktu.
 */

const { SUDDEN_CONFIG, SIGNAL_CONFIG } = require("../../config/indicatorConfig");
const { atr: atrSeriesOf, computeEmas } = require("./indicators");
const { computeLevels } = require("./market");
const { pickEntry, pickStopLoss } = require("./signal");
const { assessEntry } = require("./suddenMove");

const isNum = (v) => typeof v === "number" && isFinite(v);
const WINDOW = 320; // sama dengan FETCH_LIMIT produksi: level dan EMA dihitung dari paling banyak 320 candle

/**
 * Simulasi satu skenario ke depan.
 * @param {"long"|"short"} dir
 * @param {number} entry @param {number} sl @param {number} tp1
 * @param {{h:number,l:number,c:number}[]} future candle setelah candle entri (urut lama -> baru)
 * @returns {{outcome:"TP1"|"SL"|"TIMEOUT", r:number, bars:number}|null} null bila data tidak cukup/invalid
 */
function simulate(dir, entry, sl, tp1, future) {
  const s = dir === "long" ? 1 : -1;
  const risk = Math.abs(entry - sl);
  if (![entry, sl, tp1].every(isNum) || !(risk > 0) || !future?.length) return null;
  if ((entry - sl) * s <= 0 || (tp1 - entry) * s <= 0) return null; // SL harus di sisi rugi, TP di sisi untung
  const rr1 = Math.abs(tp1 - entry) / risk;
  for (let k = 0; k < future.length; k++) {
    const c = future[k];
    const hitSl = s === 1 ? c.l <= sl : c.h >= sl;
    const hitTp = s === 1 ? c.h >= tp1 : c.l <= tp1;
    if (hitSl) return { outcome: "SL", r: -1, bars: k + 1 }; // SL didahulukan bila satu candle menyentuh keduanya
    if (hitTp) return { outcome: "TP1", r: rr1, bars: k + 1 };
  }
  const last = future[future.length - 1];
  return { outcome: "TIMEOUT", r: ((last.c - entry) * s) / risk, bars: future.length };
}

/**
 * Jalankan backtest satu deret candle.
 * @param {object[]} candles candle closed urut lama -> baru
 * @param {{warmup?:number, horizon?:number, from?:number, to?:number, dirs?:string[], sudden?:object, signal?:object}} [opts]
 *   from/to = rentang indeks candle entri (to eksklusif); sudden = override SUDDEN_CONFIG (mis. untuk uji ambang)
 * @returns {object[]} sampel: {i,t,dir,status,conditional,volatile,slWidened,rr1,outcome,r,baseOutcome,baseR}
 */
function runBacktest(candles, opts = {}) {
  const { warmup = 60, horizon = 24, dirs = ["long", "short"] } = opts;
  const sudden = { ...SUDDEN_CONFIG, ...(opts.sudden || {}) };
  const sig = { ...SIGNAL_CONFIG, ...(opts.signal || {}) };
  const n = candles.length;
  const out = [];
  if (n < warmup + horizon + 2) return out;
  const atrAll = atrSeriesOf(candles);
  const from = Math.max(warmup, opts.from ?? warmup);
  const to = Math.min(n - horizon - 1, opts.to ?? n - horizon - 1);

  for (let i = from; i <= to; i++) {
    const atr = atrAll[i];
    if (!isNum(atr) || atr <= 0) continue;
    const start = Math.max(0, i - WINDOW + 1);
    const win = candles.slice(start, i + 1);
    const atrWin = atrAll.slice(start, i + 1);
    const price = candles[i].c;
    const levels = computeLevels(win, price);
    const emas = computeEmas(win).latest;
    const future = candles.slice(i + 1, i + 1 + horizon);

    for (const dir of dirs) {
      const entry = pickEntry({ dir, price, atr, levels, emas }, sig);
      if (entry.kind !== "market") continue; // simulasi hanya untuk entri di harga close (ENTRY_STYLE "trend")
      const baseSl = pickStopLoss({ dir, entry: entry.price, atr, levels }, sig);
      const sign = dir === "long" ? 1 : -1;
      const risk = Math.abs(entry.price - baseSl.price);
      if (!(risk > 0)) continue;
      const tps = sig.TP_RR.map((m) => ({ price: entry.price + sign * m * risk }));
      const g = assessEntry({ dir, price, entry, sl: baseSl, tps, atr, candles: win, atrSeries: atrWin, levels, emas, slMaxAtr: sig.SL_MAX_ATR }, sudden);
      const fin = simulate(dir, entry.price, g.sl, g.tps[0].price, future);
      const base = simulate(dir, entry.price, baseSl.price, tps[0].price, future);
      if (!fin || !base) continue;
      out.push({
        i,
        t: candles[i].t,
        dir,
        status: g.status,
        conditional: g.conditional,
        volatile: g.volatile,
        slWidened: g.slWidened,
        rr1: g.rr1,
        outcome: fin.outcome,
        r: fin.r,
        baseOutcome: base.outcome,
        baseR: base.r,
      });
    }
  }
  return out;
}

/** Ringkasan satu kelompok sampel. avgR memakai hasil final; avgBaseR = tanpa filter (SL/TP dasar). */
function summarize(samples) {
  const n = samples.length;
  if (!n) return { n: 0, tp1Pct: null, slPct: null, timeoutPct: null, avgR: null, avgBaseR: null };
  const cnt = (o) => samples.filter((x) => x.outcome === o).length;
  const avg = (f) => samples.reduce((a, x) => a + f(x), 0) / n;
  return {
    n,
    tp1Pct: (cnt("TP1") / n) * 100,
    slPct: (cnt("SL") / n) * 100,
    timeoutPct: (cnt("TIMEOUT") / n) * 100,
    avgR: avg((x) => x.r),
    avgBaseR: avg((x) => x.baseR),
  };
}

/** Ringkasan per status + kelompok kontrol "SEMUA" (tanpa filter, SL/TP dasar). */
function groupByStatus(samples) {
  const by = (st) => summarize(samples.filter((x) => x.status === st));
  const all = summarize(samples);
  return {
    VALID: by("VALID"),
    TUNGGU: by("TUNGGU"),
    HINDARI: by("HINDARI"),
    SEMUA_TANPA_FILTER: { ...all, tp1Pct: samples.length ? (samples.filter((x) => x.baseOutcome === "TP1").length / samples.length) * 100 : null, avgR: all.avgBaseR },
  };
}

/** Bagi sampel menurut waktu: indeks < splitIndex = periode stel, sisanya = periode ukur. */
function splitSamples(samples, splitIndex) {
  return { train: samples.filter((x) => x.i < splitIndex), test: samples.filter((x) => x.i >= splitIndex) };
}

/**
 * Uji satu ambang pada beberapa nilai, dengan pembagian waktu (stel di awal, ukur di akhir).
 * @param {object[]} candles
 * @param {string} key nama kunci SUDDEN_CONFIG (mis. "WICK_MIN_PCT")
 * @param {number[]} values
 * @param {{trainFrac?:number}&object} [opts] diteruskan ke runBacktest
 * @returns {{value:number, train:object, test:object}[]} ringkasan kelompok VALID vs BUKAN-VALID per periode
 */
function sweepThreshold(candles, key, values, opts = {}) {
  const { trainFrac = 0.6, ...rest } = opts;
  const splitIndex = Math.floor(candles.length * trainFrac);
  return values.map((value) => {
    const samples = runBacktest(candles, { ...rest, sudden: { ...(rest.sudden || {}), [key]: value } });
    const { train, test } = splitSamples(samples, splitIndex);
    const pack = (arr) => ({
      valid: summarize(arr.filter((x) => x.status === "VALID")),
      rest: summarize(arr.filter((x) => x.status !== "VALID")),
    });
    return { value, train: pack(train), test: pack(test) };
  });
}

module.exports = { simulate, runBacktest, summarize, groupByStatus, splitSamples, sweepThreshold };
