"use strict";

/**
 * features/kripto/chartInsight.js
 * ------------------------------------------------------------------
 * Insight singkat di bawah gambar !chart (req klien: "tambahin insight nya di !chart").
 * Murni rule-based dari data yang sudah ada (tanpa AI), isinya:
 *   🧭 Tren      : bullish / bearish / sideways dari posisi harga vs EMA 20/50/200
 *   ⚡ Momentum  : RSI 14 + MACD (garis vs signal, histogram menguat / melemah)
 *   🧱 Level     : R1 & S1 terdekat + jarak % dari harga
 *   📐 Fibonacci : arah swing, kedalaman retracement, posisi terhadap golden zone
 *   💡 Kesimpulan: gabungan tren + momentum (+ peringatan RSI ekstrem)
 * Teks lewat i18n (kripto.chart.insight.*) supaya id/en sama-sama jalan.
 */

const { t } = require("../../i18n");
const { classifyTrendAuto, computeEmas, latestIndicators } = require("./indicators");
const { fmtLevel, fmtPct, pctFrom } = require("./market");
const { retraceDepth } = require("./fib");

const K = "kripto.chart.insight.";
const ratioLabel = (r) => (Number.isInteger(r) && r > 1 ? r.toFixed(1) : String(r));

function trendLine(lang, info) {
  if (!info || info.trend === "nodata") return t(lang, K + "trendNone");
  const parts = [];
  if (info.above.length) parts.push(t(lang, K + "above", { list: info.above.join(", ") }));
  if (info.below.length) parts.push(t(lang, K + "below", { list: info.below.join(", ") }));
  return t(lang, K + "trend." + info.trend, { detail: parts.join(", ") });
}

function rsiZone(v) {
  if (v >= 70) return "overbought";
  if (v >= 60) return "strong";
  if (v > 40) return "neutral";
  if (v > 30) return "weak";
  return "oversold";
}

function momentumLine(lang, ind) {
  const parts = [];
  if (ind.rsi != null) parts.push(t(lang, K + "rsi", { v: ind.rsi.toFixed(0), zone: t(lang, K + "zone." + rsiZone(ind.rsi)) }));
  if (ind.macd) {
    const above = ind.macd.line > ind.macd.signal;
    const growing = ind.macd.prevHist != null ? Math.abs(ind.macd.hist) > Math.abs(ind.macd.prevHist) : null;
    let m = t(lang, above ? K + "macdAbove" : K + "macdBelow");
    if (growing != null) m += " " + t(lang, growing ? K + "histGrow" : K + "histFade");
    parts.push(m);
  }
  return parts.length ? t(lang, K + "momentum", { text: parts.join("; ") }) : null;
}

function levelLine(lang, price, resistance, support) {
  const r = resistance[0];
  const s = support[0];
  if (r == null && s == null) return null;
  const parts = [];
  if (r != null) parts.push(`R1 ${fmtLevel(r)} (${fmtPct(pctFrom(price, r))})`);
  if (s != null) parts.push(`S1 ${fmtLevel(s)} (${fmtPct(pctFrom(price, s))})`);
  return t(lang, K + "levels", { text: parts.join(" · ") });
}

function fibLine(lang, fib, price) {
  if (!fib) return null;
  const up = fib.trend === "up";
  const depth = retraceDepth(fib, price);
  const dir = t(lang, up ? K + "fibUp" : K + "fibDown");
  if (depth < 0) return t(lang, K + "fibBeyond", { dir });
  if (depth > 1) return t(lang, K + "fibBroken", { dir });
  const r = fib.retracement;
  let k = 0;
  for (let i = 0; i < r.length - 1; i++) if (depth >= r[i].ratio) k = i;
  const a = r[k];
  const b = r[Math.min(k + 1, r.length - 1)];
  const inGolden = depth >= 0.5 && depth <= 0.618;
  return t(lang, inGolden ? K + "fibGolden" : K + "fibDepth", {
    dir,
    pct: (depth * 100).toFixed(1),
    a: ratioLabel(a.ratio),
    b: ratioLabel(b.ratio),
  });
}

function conclusion(lang, info, ind) {
  let score = 0;
  if (info?.trend === "bullish") score += 1;
  else if (info?.trend === "bearish") score -= 1;
  if (ind.macd) score += ind.macd.hist > 0 ? 1 : -1;
  if (ind.rsi != null) {
    if (ind.rsi > 55) score += 1;
    else if (ind.rsi < 45) score -= 1;
  }
  let key = "mixed";
  if (score >= 2) key = "up";
  else if (score <= -2) key = "down";
  let txt = t(lang, K + "concl." + key);
  if (ind.rsi != null && ind.rsi >= 70) txt += " " + t(lang, K + "cautionHot");
  else if (ind.rsi != null && ind.rsi <= 30) txt += " " + t(lang, K + "cautionCold");
  return txt;
}

/**
 * @param {string} lang
 * @param {object} o
 * @param {Array<{t,o,h,l,c}>} o.candles
 * @param {number} o.price
 * @param {number[]} o.resistance
 * @param {number[]} o.support
 * @param {object|null} o.fib    hasil computeFib() (null = tidak ada swing jelas)
 * @returns {string} blok teks siap ditempel ke caption
 */
function buildChartInsight(lang, { candles, price, resistance = [], support = [], fib = null }) {
  const { latest } = computeEmas(candles);
  const info = classifyTrendAuto(price, latest);
  const ind = latestIndicators(candles);

  const lines = [t(lang, K + "head"), trendLine(lang, info)];
  for (const l of [momentumLine(lang, ind), levelLine(lang, price, resistance, support), fibLine(lang, fib, price)]) {
    if (l) lines.push(l);
  }
  lines.push(conclusion(lang, info, ind));
  return lines.join("\n");
}

module.exports = { buildChartInsight };
