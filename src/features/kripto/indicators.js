"use strict";

/**
 * features/kripto/indicators.js
 * ------------------------------------------------------------------
 * Indikator untuk !ema / !tren / !mtf / !bandingkan.
 * EMA persis sama dengan lib/indicators.js di web (seed = SMA periode
 * pertama), jadi angkanya identik dengan !chart dan !analisis.
 */

const { INDICATOR_CONFIG: CFG } = require("../../config/indicatorConfig");

const EMA_PERIODS = [...CFG.EMA_PERIODS];
const CROSS_LOOKBACK = 10; // golden/death cross dianggap "baru" kalau terjadi <= 10 candle lalu

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

/**
 * Seri EMA 20/50/200 dari candle closed.
 * @returns {{ series: Record<number, (number|null)[]>, latest: Record<number, number|null> }}
 */
function computeEmas(candles) {
  const closes = candles.map((c) => c.c);
  const series = {};
  const latest = {};
  for (const p of EMA_PERIODS) {
    series[p] = ema(closes, p);
    latest[p] = last(series[p]);
  }
  return { series, latest };
}

/** Harga di atas (true) / di bawah (false) tiap EMA. null kalau EMA belum terisi. */
function pricePosition(price, latest) {
  const pos = {};
  for (const p of EMA_PERIODS) pos[p] = latest[p] == null ? null : price >= latest[p];
  return pos;
}

/**
 * Status tren:
 *   bullish  = harga di atas EMA 20, 50, 200 DAN EMA 20 di atas EMA 50
 *   bearish  = harga di bawah EMA 20, 50, 200 DAN EMA 20 di bawah EMA 50
 *   sideways = selain itu (sinyal campur)
 * @returns {{ trend: "bullish"|"bearish"|"sideways", pos, above: number[], below: number[], ema20AboveEma50: boolean|null }}
 */
function classifyTrend(price, latest) {
  const pos = pricePosition(price, latest);
  const above = EMA_PERIODS.filter((p) => pos[p] === true);
  const below = EMA_PERIODS.filter((p) => pos[p] === false);
  const ema20AboveEma50 = latest[20] == null || latest[50] == null ? null : latest[20] > latest[50];

  let trend = "sideways";
  if (above.length === 3 && ema20AboveEma50 === true) trend = "bullish";
  else if (below.length === 3 && ema20AboveEma50 === false) trend = "bearish";
  return { trend, pos, above, below, ema20AboveEma50 };
}

/**
 * Cross generik antara dua EMA (fast memotong slow) dalam `lookback` candle closed terakhir.
 * Dipakai !bias untuk 20/50 dan 50/200. Aturan sama persis dengan detectCross lama.
 * @returns {{ type: "golden"|"death", barsAgo: number } | null}
 */
function detectCrossPair(series, fastP, slowP, lookback = CROSS_LOOKBACK) {
  const fast = series[fastP];
  const slow = series[slowP];
  if (!fast || !slow) return null;
  const n = Math.min(fast.length, slow.length);
  for (let i = n - 1; i > n - 1 - lookback && i >= 1; i--) {
    if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) continue;
    const before = fast[i - 1] - slow[i - 1];
    const now = fast[i] - slow[i];
    if (before <= 0 && now > 0) return { type: "golden", barsAgo: n - 1 - i };
    if (before >= 0 && now < 0) return { type: "death", barsAgo: n - 1 - i };
  }
  return null;
}

/**
 * Golden cross (EMA 50 naik memotong EMA 200) / death cross (turun memotong)
 * yang terjadi dalam CROSS_LOOKBACK candle closed terakhir. Perilaku TIDAK berubah
 * (dipakai !tren dan !scan); sekarang hanya pembungkus detectCrossPair.
 * @returns {{ type: "golden"|"death", barsAgo: number } | null}
 */
function detectCross(series, lookback = CROSS_LOOKBACK) {
  return detectCrossPair(series, 50, 200, lookback);
}


/**
 * Status tren cadangan untuk koin baru (< 200 candle): hanya EMA 20 dan 50.
 *   bullish  = harga di atas EMA 20 & 50 DAN EMA 20 di atas EMA 50
 *   bearish  = kebalikannya; selain itu sideways.
 * Skor kekuatan 0..3 (jumlah EMA yang ditembus ke atas + EMA 20 di atas EMA 50).
 * @returns {{ trend: string, score: number, max: 3, above: number[], ema20AboveEma50: boolean|null, limited: true }}
 */
function classifyTrendLimited(price, latest) {
  const ps = [20, 50];
  const above = ps.filter((p) => latest[p] != null && price >= latest[p]);
  const below = ps.filter((p) => latest[p] != null && price < latest[p]);
  const ema20AboveEma50 = latest[20] == null || latest[50] == null ? null : latest[20] > latest[50];
  let trend = "sideways";
  if (above.length === 2 && ema20AboveEma50 === true) trend = "bullish";
  else if (below.length === 2 && ema20AboveEma50 === false) trend = "bearish";
  return { trend, score: above.length + (ema20AboveEma50 === true ? 1 : 0), max: 3, above, ema20AboveEma50, limited: true };
}

/**
 * RSI Wilder (default 14). Seri sepanjang `values`; null sebelum warmup (index < period).
 * Deret naik terus -> 100, turun terus -> 0.
 */
function rsi(values, period = CFG.RSI_PERIOD) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const toRsi = () => (avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL));
  out[period] = toRsi();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi();
  }
  return out;
}

/**
 * MACD (12, 26, 9). EMA sinyal memakai seed SMA sama seperti ema(). Seri sepanjang `values`.
 * hist = macd - signal. Index awal bernilai null sampai warmup (26 + 9 - 1 candle).
 */
function macd(values, fast = CFG.MACD_FAST, slow = CFG.MACD_SLOW, signalP = CFG.MACD_SIGNAL) {
  const n = values.length;
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (ef[i] != null && es[i] != null) line[i] = ef[i] - es[i];
  const signal = new Array(n).fill(null);
  const hist = new Array(n).fill(null);
  const first = line.findIndex((v) => v != null);
  if (first !== -1 && n - first >= signalP) {
    const sig = ema(line.slice(first), signalP);
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] == null) continue;
      signal[first + i] = sig[i];
      hist[first + i] = line[first + i] - sig[i];
    }
  }
  return { macd: line, signal, hist };
}

/**
 * ATR Wilder (default 14) dari candle {h,l,c}. Seri sepanjang `candles`; null sebelum warmup (index < period).
 * True range candle pertama = h - l.
 */
function atr(candles, period = CFG.ATR_PERIOD) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) =>
    i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c)),
  );
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i];
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Klasifikasi tren yang tidak pernah memaksa "sideways" karena data kurang.
 *   EMA 200 ada          -> classifyTrend penuh                         (limited: false)
 *   EMA 50 ada, 200 belum -> classifyTrendLimited (EMA 20/50)           (limited: true)
 *   EMA 50 pun belum ada -> trend "nodata" (tampilkan "data kurang")    (limited: true, insufficient: true)
 * Selalu mengembalikan `pos`, `above`, `below`, `ema20AboveEma50`, `score` supaya pemanggil bisa
 * memakainya tanpa cek tipe.
 */
function classifyTrendAuto(price, latest) {
  const pos = pricePosition(price, latest);
  if (latest[200] != null) {
    const info = classifyTrend(price, latest);
    return { ...info, score: strengthScore(info), max: 4, limited: false, insufficient: false };
  }
  if (latest[50] != null) {
    const info = classifyTrendLimited(price, latest);
    return { ...info, pos, below: [20, 50].filter((p) => latest[p] != null && price < latest[p]), insufficient: false };
  }
  return {
    trend: "nodata",
    pos,
    above: [],
    below: [],
    ema20AboveEma50: null,
    score: 0,
    max: 3,
    limited: true,
    insufficient: true,
  };
}

/**
 * Nilai terbaru RSI / MACD / ATR dari candle closed, siap pakai untuk fitur 03, 07, 08, 09.
 * Tiap nilai null bila data belum cukup (bukan error, bukan angka karangan).
 * @returns {{ rsi: number|null, macd: {line,signal,hist,prevHist}|null, atr: number|null, n: number }}
 */
function latestIndicators(candles) {
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const r = rsi(closes);
  const m = macd(closes);
  const a = atr(candles);
  const i = n - 1;
  return {
    n,
    rsi: n ? r[i] : null,
    macd:
      n && m.hist[i] != null
        ? { line: m.macd[i], signal: m.signal[i], hist: m.hist[i], prevHist: i > 0 ? m.hist[i - 1] : null }
        : null,
    atr: n ? a[i] : null,
  };
}

/** Skor kekuatan 0..4: jumlah EMA yang ditembus ke atas (0-3) + EMA 20 di atas EMA 50 (0-1). */
function strengthScore(info) {
  return info.above.length + (info.ema20AboveEma50 === true ? 1 : 0);
}

module.exports = {
  EMA_PERIODS,
  CROSS_LOOKBACK,
  ema,
  computeEmas,
  pricePosition,
  classifyTrend,
  classifyTrendLimited,
  classifyTrendAuto,
  latestIndicators,
  detectCross,
  detectCrossPair,
  strengthScore,
  rsi,
  macd,
  atr,
};
