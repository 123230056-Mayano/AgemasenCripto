"use strict";

/**
 * features/kripto/dominance.js
 * ------------------------------------------------------------------
 * Data dominance pasar kripto (BTC.D, ETH.D, USDT.D) untuk panel chart + laporan !analisis / !chart.
 *
 *   - fetchDominanceNow()    : angka terkini dari CoinGecko  GET /api/v3/global  (publik, tanpa key)
 *   - fetchDominanceSeries() : deret waktu BTC.D / ETH.D dari data-api CoinMarketCap (endpoint yang dipakai
 *                              webnya, publik tanpa key; bentuk respons bisa berubah, jadi parser dibuat longgar)
 *   - getDominance()         : gabungan keduanya, cache 5 menit. TIDAK PERNAH melempar error:
 *                              gagal -> null, dan pemanggil cukup melewati panel dominance.
 *
 * Env opsional: COINGECKO_BASE (default https://api.coingecko.com), CMC_DATA_BASE (default https://api.coinmarketcap.com)
 */

const axios = require("axios");

const CG = (process.env.COINGECKO_BASE || "https://api.coingecko.com").replace(/\/+$/, "");
const CMC = (process.env.CMC_DATA_BASE || "https://api.coinmarketcap.com").replace(/\/+$/, "");
const CMC_INTERVAL = { "15M": "15m", "1H": "1h", "4H": "4h", "1D": "1d" };
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, value }

/** @returns {Promise<{btc:number, eth:number|null, usdt:number|null}|null>} persen (0..100) */
async function fetchDominanceNow() {
  try {
    const res = await axios.get(`${CG}/api/v3/global`, { timeout: 10_000 });
    const p = res.data?.data?.market_cap_percentage;
    const btc = Number(p?.btc);
    if (!isFinite(btc)) return null;
    const eth = Number(p?.eth);
    const usdt = Number(p?.usdt);
    return { btc, eth: isFinite(eth) ? eth : null, usdt: isFinite(usdt) ? usdt : null };
  } catch (err) {
    console.log("[dominance] now gagal:", err.response?.status || err.message);
    return null;
  }
}

/**
 * @param {string} tf        "15M" | "1H" | "4H" | "1D"
 * @param {number} fromMs    awal rentang (ms), biasanya waktu candle tertampil paling kiri
 * @returns {Promise<Array<{t:number, btc:number, eth:number|null}>|null>} urut lama -> baru
 */
async function fetchDominanceSeries(tf, fromMs) {
  const interval = CMC_INTERVAL[tf];
  if (!interval) return null;
  try {
    const res = await axios.get(`${CMC}/data-api/v3/global-metrics/quotes/historical`, {
      params: {
        convertId: 2781, // USD
        timeStart: Math.floor(fromMs / 1000),
        timeEnd: Math.floor(Date.now() / 1000),
        interval,
      },
      timeout: 12_000,
    });
    const quotes = res.data?.data?.quotes;
    if (!Array.isArray(quotes)) return null;
    const out = [];
    for (const q of quotes) {
      const t = Date.parse(q.timestamp || q.quote?.[0]?.timestamp);
      const btc = Number(q.btcDominance ?? q.quote?.[0]?.btcDominance);
      const eth = Number(q.ethDominance ?? q.quote?.[0]?.ethDominance);
      if (!isFinite(t) || !isFinite(btc)) continue;
      out.push({ t, btc, eth: isFinite(eth) ? eth : null });
    }
    out.sort((a, b) => a.t - b.t);
    return out.length >= 2 ? out : null;
  } catch (err) {
    console.log("[dominance] series gagal:", err.response?.status || err.message);
    return null;
  }
}

/**
 * @returns {Promise<{now:object|null, series:Array|null}|null>} null bila dua-duanya gagal
 */
async function getDominance(tf, fromMs) {
  const key = `${tf}:${Math.floor(fromMs / 3_600_000)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const [now, series] = await Promise.all([fetchDominanceNow(), fetchDominanceSeries(tf, fromMs)]);
  const value = now || series ? { now: now || (series ? { btc: series[series.length - 1].btc, eth: series[series.length - 1].eth, usdt: null } : null), series } : null;
  if (value) cache.set(key, { at: Date.now(), value });
  return value;
}

/** Sejajarkan deret dominance ke candle: nilai terakhir yang waktunya <= waktu candle (null bila belum ada). */
function alignToCandles(series, candles) {
  if (!series?.length) return candles.map(() => null);
  let j = 0;
  return candles.map((c) => {
    while (j + 1 < series.length && series[j + 1].t <= c.t) j++;
    return series[j].t <= c.t + 1 ? series[j] : null;
  });
}

module.exports = { getDominance, fetchDominanceNow, fetchDominanceSeries, alignToCandles };
