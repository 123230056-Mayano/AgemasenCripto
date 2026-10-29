"use strict";

/**
 * features/kripto/market.js
 * ------------------------------------------------------------------
 * Data pasar langsung dari Binance (tanpa lewat web KriptoPredict, jadi
 * !harga / !chart / !level tetap jalan walau ANALYST_URL kosong):
 *   - ticker 24 jam (harga live + % perubahan)
 *   - candle closed (15m / 1H / 4H / 1D)
 *   - kurs USD -> IDR
 *   - level support / resistance (swing high/low, sama dengan web)
 *
 * Env opsional: BINANCE_BASE (default https://data-api.binance.vision)
 */

const axios = require("axios");
const { binanceSymbol } = require("../analisis/analisisChart");
const { fmtPrice, fmtUsdExact, fmtTiered, fmtPercent } = require("../../utils/priceFormat");

const BINANCE = (process.env.BINANCE_BASE || "https://data-api.binance.vision").replace(/\/+$/, "");

const TIMEFRAMES = { "15M": "15m", "1H": "1h", "4H": "4h", "1D": "1d" };
const TF_LABEL = { "15M": "15m", "1H": "1H", "4H": "4H", "1D": "1D" };
const FETCH_LIMIT = 320;

class UnsupportedCoinError extends Error {
  constructor(coin) {
    super("COIN_UNSUPPORTED");
    this.code = "COIN_UNSUPPORTED";
    this.coin = coin;
  }
}

function isInvalidSymbol(err) {
  return err?.response?.status === 400 || err?.response?.data?.code === -1121;
}

/** @returns {Promise<{price:number, changePct:number}>} */
async function fetchTicker(coin) {
  try {
    const res = await axios.get(`${BINANCE}/api/v3/ticker/24hr`, {
      params: { symbol: binanceSymbol(coin) },
      timeout: 10_000,
    });
    const price = Number(res.data.lastPrice);
    const changePct = Number(res.data.priceChangePercent);
    if (!isFinite(price)) throw new Error("INVALID_TICKER");
    return { price, changePct: isFinite(changePct) ? changePct : 0 };
  } catch (err) {
    if (isInvalidSymbol(err)) throw new UnsupportedCoinError(coin);
    throw err;
  }
}

/**
 * Candle closed saja (default), urut lama -> baru.
 * includeOpen: true -> candle yang sedang berjalan ikut dikembalikan di ujung deret; setiap candle diberi
 * `closed` (true/false). Dipakai HANYA oleh alarm live (item 10); semua pemanggil lain tidak berubah.
 */
async function fetchCandles(coin, tf, { includeOpen = false } = {}) {
  const interval = TIMEFRAMES[tf];
  if (!interval) throw new Error("TF_UNSUPPORTED");
  try {
    const res = await axios.get(`${BINANCE}/api/v3/klines`, {
      params: { symbol: binanceSymbol(coin), interval, limit: FETCH_LIMIT },
      timeout: 10_000,
    });
    const now = Date.now();
    const rows = includeOpen ? res.data : res.data.filter((k) => k[6] < now);
    return rows.map((k) => {
      const c = { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[7], ct: k[6] }; // ct = waktu tutup (ms), dipakai divergence.js untuk memastikan candle closed; v = volume koin, qv = volume dalam USDT (dipakai suddenMove.js)
      if (includeOpen) c.closed = k[6] < now;
      return c;
    });
  } catch (err) {
    if (isInvalidSymbol(err)) throw new UnsupportedCoinError(coin);
    throw err;
  }
}

/**
 * Candle closed historis berhalaman (Binance membatasi 1000 candle per permintaan), urut lama -> baru.
 * Dipakai backtest (scripts/backtest-sudden.js); fetchCandles biasa hanya 320 candle terakhir.
 * @param {string} coin
 * @param {string} tf "15M"|"1H"|"4H"|"1D"
 * @param {{bars?:number, endTime?:number, pageSize?:number, get?:Function}} [opts]
 *   get = pengganti axios.get (untuk uji tanpa jaringan)
 */
async function fetchCandlesHistory(coin, tf, { bars = 3000, endTime = Date.now(), pageSize = 1000, get } = {}) {
  const interval = TIMEFRAMES[tf];
  if (!interval) throw new Error("TF_UNSUPPORTED");
  const http = get || ((url, cfg) => axios.get(url, cfg));
  const out = [];
  let end = endTime;
  try {
    while (out.length < bars) {
      const res = await http(`${BINANCE}/api/v3/klines`, {
        params: { symbol: binanceSymbol(coin), interval, limit: Math.min(pageSize, 1000), endTime: end },
        timeout: 15_000,
      });
      const rows = res.data || [];
      if (!rows.length) break;
      const page = rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[7], ct: k[6] }));
      out.unshift(...page);
      const nextEnd = rows[0][0] - 1; // mundur: halaman berikutnya berakhir tepat sebelum candle tertua
      if (rows.length < Math.min(pageSize, 1000) || nextEnd >= end) break;
      end = nextEnd;
    }
  } catch (err) {
    if (isInvalidSymbol(err)) throw new UnsupportedCoinError(coin);
    throw err;
  }
  const now = Date.now();
  const seen = new Set();
  const uniq = out.filter((k) => k.ct < now && !seen.has(k.t) && seen.add(k.t)).sort((a, b) => a.t - b.t);
  return uniq.slice(-bars);
}

// Kurs USD -> IDR, cache 10 menit. Sumber utama open.er-api.com, cadangan USDTIDR Binance.
let fxCache = { at: 0, rate: null };
async function fetchUsdIdr() {
  if (fxCache.rate && Date.now() - fxCache.at < 600_000) return fxCache.rate;
  let rate = null;
  try {
    const res = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 8_000 });
    if (res.data?.result === "success" && res.data.rates?.IDR) rate = Number(res.data.rates.IDR);
  } catch {
    /* coba cadangan */
  }
  if (!rate) {
    try {
      const res = await axios.get(`${BINANCE}/api/v3/ticker/price`, {
        params: { symbol: "USDTIDR" },
        timeout: 8_000,
      });
      if (res.data?.price) rate = Number(res.data.price);
    } catch {
      /* pakai kurs lama / null */
    }
  }
  if (rate && isFinite(rate)) fxCache = { at: Date.now(), rate };
  return fxCache.rate; // bisa null -> Rupiah dilewati
}

/**
 * Support/resistance dari swing high/low (port dari lib/indicators.js web).
 * Resistance urut terdekat -> terjauh (R1, R2), support terdekat -> terjauh (S1, S2).
 */
function computeLevels(candles, price, { lookback = 150, win = 3, count = 2, tol = 0.01 } = {}) {
  const slice = candles.slice(-lookback);
  const highs = [];
  const lows = [];
  for (let i = win; i < slice.length - win; i++) {
    const around = slice.slice(i - win, i + win + 1);
    if (slice[i].h === Math.max(...around.map((c) => c.h))) highs.push(slice[i].h);
    if (slice[i].l === Math.min(...around.map((c) => c.l))) lows.push(slice[i].l);
  }
  const uniq = (arr) => {
    const out = [];
    for (const v of [...arr].sort((a, b) => a - b)) {
      if (!out.length || Math.abs(v - out[out.length - 1]) / v > tol) out.push(v); // tol: toleransi gabung level (kripto 1%, forex 0,2% lewat adapter forex)
    }
    return out;
  };
  const resistance = uniq(highs).filter((v) => v > price).slice(0, count);
  const support = uniq(lows).filter((v) => v < price).slice(-count).reverse();
  return { resistance, support };
}

// ---------- format ----------
// Harga header (ticker mentah dari exchange): tampil penuh tanpa pembulatan (utils/priceFormat.js). dp (opsional) = presisi koin dari data candle.
const fmtUsd = (v, dp) => fmtUsdExact(v, dp);
const fmtIdr = (v) => {
  if (typeof v !== "number" || !isFinite(v)) return "-";
  const o = v >= 100 ? { maximumFractionDigits: 0 } : v >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 };
  return "Rp" + v.toLocaleString("id-ID", o);
};
// Sama dengan label harga di gambar chart supaya angkanya identik. dp = presisi koin (coinDecimals): angka tampil dengan dp desimal.
// Tanpa dp (pemanggil lama: !ema, !statistik, !signal) tingkat desimal lama dipertahankan.
const fmtLevel = (p, dp) => (dp == null ? fmtTiered(p) : fmtPrice(p, dp));
const fmtPct = (v) => fmtPercent(v);
const pctFrom = (price, level) => ((level - price) / price) * 100;

module.exports = {
  TIMEFRAMES,
  TF_LABEL,
  UnsupportedCoinError,
  fetchTicker,
  fetchCandles,
  fetchCandlesHistory,
  fetchUsdIdr,
  computeLevels,
  fmtUsd,
  fmtIdr,
  fmtLevel,
  fmtPct,
  pctFrom,
};
