"use strict";

/**
 * features/kripto/indicators.js
 * ------------------------------------------------------------------
 * Indikator untuk !ema / !tren / !mtf / !bandingkan.
 * EMA persis sama dengan lib/indicators.js di web (seed = SMA periode
 * pertama), jadi angkanya identik dengan !chart dan !analisis.
 */

const EMA_PERIODS = [20, 50, 200];
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
 * Golden cross (EMA 50 naik memotong EMA 200) / death cross (turun memotong)
 * yang terjadi dalam CROSS_LOOKBACK candle closed terakhir.
 * @returns {{ type: "golden"|"death", barsAgo: number } | null}
 */
function detectCross(series, lookback = CROSS_LOOKBACK) {
  const fast = series[50];
  const slow = series[200];
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

/** Skor kekuatan 0..4: jumlah EMA yang ditembus ke atas (0-3) + EMA 20 di atas EMA 50 (0-1). */
function strengthScore(info) {
  return info.above.length + (info.ema20AboveEma50 === true ? 1 : 0);
}

module.exports = { EMA_PERIODS, CROSS_LOOKBACK, ema, computeEmas, pricePosition, classifyTrend, detectCross, strengthScore };
