"use strict";

/**
 * features/kripto/movave.js
 * ------------------------------------------------------------------
 * !movave <koin> [tf] [sma|ema]  -> Moving Average (alias: !ma, !movingaverage)
 *   - SMA & EMA periode 20 / 50 / 200 (periode dari INDICATOR_CONFIG.EMA_PERIODS)
 *   - posisi harga live terhadap tiap MA (di atas / di bawah + jarak %)
 *   - golden / death cross 50/200 dalam CROSS_LOOKBACK candle closed terakhir
 *   - kesimpulan singkat (berapa MA yang ada di bawah harga)
 *   - opsional kata "sma" atau "ema" untuk menampilkan salah satu saja
 *
 * EMA memakai fungsi yang sama dengan !ema (indicators.js), jadi angkanya identik.
 * Data langsung dari Binance (market.js), tidak butuh ANALYST_URL.
 */

const { t } = require("../../i18n");
const { INDICATOR_CONFIG: CFG } = require("../../config/indicatorConfig");
const { ema, detectCrossPair, CROSS_LOOKBACK } = require("./indicators");
const { TF_LABEL, fetchCandles, fetchTicker, fmtUsd, fmtLevel, fmtPct, pctFrom } = require("./market");

const PERIODS = [...CFG.EMA_PERIODS]; // [20, 50, 200]
const TYPES = ["SMA", "EMA"];

/** SMA klasik. Seri sepanjang `values`; null sebelum terisi penuh (index < period - 1). */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

/**
 * Hitung SMA & EMA untuk semua periode + posisi harga + cross 50/200.
 * @param {Array<{c:number}>} candles candle closed, urut lama -> baru
 * @param {number} price harga live
 */
function computeMovave(candles, price) {
  const closes = candles.map((c) => c.c);
  const result = {};
  for (const type of TYPES) {
    const fn = type === "SMA" ? sma : ema;
    const series = {};
    const rows = PERIODS.map((p) => {
      series[p] = fn(closes, p);
      const value = last(series[p]);
      return { period: p, value, above: value == null ? null : price >= value };
    });
    const hasPair = series[50] && series[200] && last(series[50]) != null && last(series[200]) != null;
    result[type] = {
      rows,
      cross: hasPair ? detectCrossPair(series, 50, 200, CROSS_LOOKBACK) : null,
      crossReady: Boolean(hasPair),
    };
  }
  return result;
}

function rowsText(lang, type, data, price) {
  return data.rows
    .map((r) => {
      if (r.value == null) return `⚪ ${type} ${r.period}: ${t(lang, "kripto.movave.noData")}`;
      const pct = fmtPct(pctFrom(r.value, price));
      return `${r.above ? "🟢" : "🔴"} ${type} ${r.period}: ${fmtLevel(r.value)} (${r.above ? "▲" : "▼"} ${pct})`;
    })
    .join("\n");
}

function crossText(lang, type, data) {
  if (!data.crossReady) return `• ${type} 50/200: ${t(lang, "kripto.movave.crossNa")}`;
  if (!data.cross) return `• ${type} 50/200: ${t(lang, "kripto.movave.crossNone", { n: CROSS_LOOKBACK })}`;
  const key = data.cross.type === "golden" ? "kripto.movave.crossGolden" : "kripto.movave.crossDeath";
  return `• ${type} 50/200: ${t(lang, key, { n: data.cross.barsAgo })}`;
}

function verdictText(lang, result, types) {
  let above = 0;
  let total = 0;
  for (const type of types) {
    for (const r of result[type].rows) {
      if (r.above == null) continue;
      total++;
      if (r.above) above++;
    }
  }
  if (!total) return t(lang, "kripto.movave.verdictNone");
  const ratio = above / total;
  const key = ratio === 1 ? "kripto.movave.verdictAll" : ratio === 0 ? "kripto.movave.verdictNoneAbove" : ratio >= 0.5 ? "kripto.movave.verdictMostly" : "kripto.movave.verdictFew";
  return t(lang, key, { above, total });
}

async function runMovave(sock, msg, { jid, lang }, { coin, tf, type }) {
  const [candles, tick] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin)]);
  const result = computeMovave(candles, tick.price);
  const types = type ? [type] : TYPES;

  const sections = types.map((tp) => `*${tp}*\n${rowsText(lang, tp, result[tp], tick.price)}`).join("\n\n");
  const crosses = types.map((tp) => crossText(lang, tp, result[tp])).join("\n");

  await sock.sendMessage(
    jid,
    {
      text: t(lang, "kripto.movave.body", {
        coin,
        tf: TF_LABEL[tf],
        price: fmtUsd(tick.price),
        sections,
        crosses,
        verdict: verdictText(lang, result, types),
      }),
    },
    { quoted: msg },
  );
}

module.exports = { runMovave, computeMovave, sma, MOVAVE_TYPES: TYPES };
