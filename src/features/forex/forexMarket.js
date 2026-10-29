"use strict";

/**
 * features/forex/forexMarket.js
 * ------------------------------------------------------------------
 * Adapter pasar FOREX untuk bot (antarmuka sama dengan adapter kripto, lihat kripto/marketAdapter.js).
 * Sumber data: Yahoo Finance (tidak resmi). Mandiri seperti Binance di kripto/market.js, tidak lewat web.
 *
 * Aturan data (Catatan Rencana Fitur Forex, bagian 4 dan 6):
 *   - candle closed saja, urut lama -> baru, bentuk {t,o,h,l,c,ct} (ms). TANPA field v: Yahoo tidak punya volume forex
 *     yang berarti, dan v = 0 lolos pengecekan isNum, jadi field dihapus supaya semua pemeriksaan volume
 *     (volumeSpike, bukti volume pola, rasio volume AMD) memperlakukannya sebagai "tidak bisa dinilai".
 *   - harga dibulatkan ke digits pair (membuang float panjang Yahoo).
 *   - 4H = gabungan 1H per grid 4 jam UTC; 1D mengikuti definisi hari Yahoo. Batas ini bisa beda dari broker/TradingView.
 *   - candle pembuka setelah jeda pasar yang melompat jauh dari close sebelumnya ditandai `gap: true`.
 *   - XAUUSD = futures GC=F (harga beda dari spot, ada gap pergantian kontrak).
 *   - cache + request coalescing: permintaan identik yang bersamaan memakai satu fetch.
 *
 * Env opsional: YAHOO_BASE (default https://query1.finance.yahoo.com), FOREX_CACHE_MS (default 30000)
 */

const axios = require("axios");
const { PAIRS, resolvePair, roundPrice, toPips, allowedTfs } = require("./forexPairs");
const { fmtPrice } = require("../../utils/priceFormat");

const YAHOO = (process.env.YAHOO_BASE || "https://query1.finance.yahoo.com").replace(/\/+$/, "");
const CACHE_MS = Number.isFinite(Number(process.env.FOREX_CACHE_MS)) && process.env.FOREX_CACHE_MS ? Number(process.env.FOREX_CACHE_MS) : 30_000;
const FETCH_LIMIT = 320; // sama dengan kripto/market.js, supaya EMA200 dan level punya porsi data yang sama
const GAP_ATR_MULT = 1; // gap pembuka > N x rata-rata range 14 candle sebelumnya = ditandai
const LEVEL_TOL = 0.002; // toleransi gabung level S/R forex (0,2%, sama dengan web /api/forex)
const MARKET_CLOSE = { day: 5, hour: 22 }; // Jumat 22:00 UTC
const MARKET_OPEN = { day: 0, hour: 22 }; // Minggu 22:00 UTC (perkiraan; bergeser 1 jam mengikuti DST AS)
const STALE_MS = 3 * 3600_000;

const TF_STEP = { "15M": 900_000, "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000 };
// interval + range Yahoo per TF (4H dibentuk dari 1H). 15m maksimum 60 hari di Yahoo; dipakai 30 hari.
const YAHOO_REQ = { "15M": { interval: "15m", range: "30d" }, "1H": { interval: "60m", range: "180d" }, "4H": { interval: "60m", range: "180d" }, "1D": { interval: "1d", range: "2y" } };

class ForexDataError extends Error {
  constructor(msg, cause) {
    super(msg);
    this.code = "FOREX_DATA";
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------------
// HTTP, cache, coalescing
// ---------------------------------------------------------------------
let http = (url, cfg) => axios.get(url, cfg);
/** Ganti pengambil HTTP (untuk uji tanpa jaringan). */
function _setHttp(fn) {
  http = fn || ((url, cfg) => axios.get(url, cfg));
  cache.clear();
}
const cache = new Map(); // key -> { at, value } | { at, promise }

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit) {
    if (hit.promise) return hit.promise;
    if (Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
  }
  const promise = fn().then(
    (value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    },
    (err) => {
      cache.delete(key); // gagal tidak di-cache
      throw err;
    },
  );
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

async function yahooChart(symbol, { interval, range }) {
  const res = await http(`${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}`, {
    params: { interval, range, includePrePost: false },
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AgemasenBot/1.0)", Accept: "application/json" },
    timeout: 12_000,
  });
  const r = res?.data?.chart?.result?.[0];
  if (!r) throw new ForexDataError(res?.data?.chart?.error?.description || "YAHOO_NO_RESULT");
  return r;
}

// ---------------------------------------------------------------------
// Fungsi murni: parse, agregasi 4H, filter closed, gap
// ---------------------------------------------------------------------
const isNum = (v) => typeof v === "number" && isFinite(v);

/**
 * Respons chart Yahoo -> candle {t,o,h,l,c}. Baris dengan OHLC null dibuang, harga dibulatkan ke digits pair,
 * high/low dipastikan mencakup open/close. TANPA v.
 */
function parseYahooCandles(result, pair) {
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (![ts[i], o, h, l, c].every(isNum)) continue;
    const ro = roundPrice(pair, o);
    const rc = roundPrice(pair, c);
    out.push({ t: ts[i] * 1000, o: ro, h: Math.max(roundPrice(pair, h), ro, rc), l: Math.min(roundPrice(pair, l), ro, rc), c: rc });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 1H -> 4H per grid 4 jam UTC (00,04,08,12,16,20). Grup di tepi sesi boleh berisi kurang dari 4 candle 1H. */
function aggregate4h(h1) {
  const STEP = TF_STEP["4H"];
  const groups = new Map();
  for (const k of h1) {
    const g = Math.floor(k.t / STEP) * STEP;
    const cur = groups.get(g);
    if (!cur) groups.set(g, { t: g, o: k.o, h: k.h, l: k.l, c: k.c });
    else {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
    }
  }
  return [...groups.values()].sort((a, b) => a.t - b.t);
}

/** Buang candle yang belum selesai (t + step > now) dan isi ct = t + step - 1 (dipakai divergence.js). */
function closedOnly(candles, tf, now = Date.now()) {
  const step = TF_STEP[tf];
  return candles.filter((k) => k.t + step <= now).map((k) => ({ ...k, ct: k.t + step - 1 }));
}

/**
 * Tandai candle pembuka yang melompat jauh dari close sebelumnya setelah jeda pasar (akhir pekan / rollover):
 * jeda waktu > 1,5 x step DAN |open - close sebelumnya| > GAP_ATR_MULT x rata-rata range 14 candle sebelumnya.
 * Hanya menambah field `gap: true`; tidak mengubah harga.
 */
function flagGaps(candles, tf, mult = GAP_ATR_MULT) {
  const step = TF_STEP[tf];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    if (cur.t - prev.t <= step * 1.5) continue;
    const from = Math.max(0, i - 14);
    let sum = 0;
    for (let j = from; j < i; j++) sum += candles[j].h - candles[j].l;
    const avg = sum / (i - from);
    if (avg > 0 && Math.abs(cur.o - prev.c) > mult * avg) cur.gap = true;
  }
  return candles;
}

/**
 * Status pasar dari kalender: tutup Jumat 22:00 UTC sampai Minggu 22:00 UTC. `lastT` (waktu candle terakhir, ms)
 * opsional: bila kalender bilang buka tetapi data terakhir sudah > STALE_MS, dianggap tidak aktif (libur / data macet).
 * @returns {{open:boolean, reason:"weekend"|"stale"|null}}
 */
function marketStatus(now = Date.now(), lastT = null) {
  const d = new Date(now);
  const dow = d.getUTCDay();
  const h = d.getUTCHours();
  const afterClose = dow === MARKET_CLOSE.day && h >= MARKET_CLOSE.hour;
  const beforeOpen = dow === MARKET_OPEN.day && h < MARKET_OPEN.hour;
  if (afterClose || dow === 6 || beforeOpen) return { open: false, reason: "weekend" };
  if (isNum(lastT) && now - lastT > STALE_MS) return { open: false, reason: "stale" };
  return { open: true, reason: null };
}

// ---------------------------------------------------------------------
// Pengambil data (I/O)
// ---------------------------------------------------------------------
async function loadCandles(pair, tf, now = Date.now()) {
  const info = PAIRS[pair];
  const req = YAHOO_REQ[tf];
  if (!info || !req) throw new Error("TF_UNSUPPORTED");
  if (!allowedTfs(pair).includes(tf)) throw new ForexDataError("TF_NOT_ALLOWED");
  const raw = await cached(`c:${pair}:${req.interval}:${req.range}`, CACHE_MS, async () => {
    try {
      return parseYahooCandles(await yahooChart(info.yahoo, req), pair);
    } catch (err) {
      throw err instanceof ForexDataError ? err : new ForexDataError("YAHOO_FETCH_FAILED", err);
    }
  });
  const base = tf === "4H" ? aggregate4h(raw) : raw;
  const closed = flagGaps(closedOnly(base, tf, now), tf);
  if (!closed.length) throw new ForexDataError("NO_CANDLES");
  return closed.slice(-FETCH_LIMIT);
}

/** @returns {Promise<{price:number, changePct:number, asOf:number|null}>} */
async function loadTicker(pair, now = Date.now()) {
  const info = PAIRS[pair];
  if (!info) throw new ForexDataError("PAIR_UNSUPPORTED");
  return cached(`t:${pair}`, Math.min(CACHE_MS, 15_000), async () => {
    let r;
    try {
      r = await yahooChart(info.yahoo, { interval: "15m", range: "5d" });
    } catch (err) {
      throw err instanceof ForexDataError ? err : new ForexDataError("YAHOO_FETCH_FAILED", err);
    }
    const rows = parseYahooCandles(r, pair);
    const last = rows[rows.length - 1];
    const live = r?.meta?.regularMarketPrice;
    const price = roundPrice(pair, isNum(live) ? live : last?.c);
    if (!isNum(price)) throw new ForexDataError("INVALID_TICKER");
    // Perubahan 24 jam dihitung sendiri (Yahoo tidak memberi): terhadap close candle terakhir yang <= 24 jam sebelum data terakhir.
    let changePct = 0;
    if (last) {
      const ref = [...rows].reverse().find((k) => k.t <= last.t - 86_400_000);
      if (ref && ref.c) changePct = ((price - ref.c) / ref.c) * 100;
    }
    return { price, changePct, asOf: last ? last.t + TF_STEP["15M"] : null };
  });
}

// ---------------------------------------------------------------------
// Adapter per pair
// ---------------------------------------------------------------------
/**
 * Adapter pasar untuk satu pair. Antarmuka sama dengan kripto/marketAdapter.js.
 * Properti: id, symbol, label, hasVolume, noSnapshot (tanpa mood pasar / tren BTC).
 */
function createForexMarket(pairInput) {
  const pair = resolvePair(pairInput);
  if (!pair) return null;
  const info = PAIRS[pair];
  const { computeLevels } = require("../kripto/market");
  return {
    id: "forex",
    symbol: pair,
    label: pair,
    hasVolume: false,
    noSnapshot: true,
    digits: info.digits,
    proxy: info.proxy || null,
    allowedTfs: (tfs) => allowedTfs(pair, tfs),
    fetchTicker: () => loadTicker(pair),
    fetchCandles: (tf) => loadCandles(pair, tf),
    computeLevels: (candles, price) => computeLevels(candles, price, { tol: LEVEL_TOL }),
    fmtLevel: (v) => fmtPrice(v, info.digits),
    fmtPrice: (v) => fmtPrice(v, info.digits),
    pips: (distance) => toPips(pair, distance),
    status: async () => {
      let lastT = null;
      try {
        lastT = (await loadTicker(pair)).asOf;
      } catch {
        /* tanpa data terakhir: pakai kalender saja */
      }
      return marketStatus(Date.now(), lastT);
    },
  };
}

module.exports = {
  ForexDataError,
  TF_STEP,
  createForexMarket,
  loadCandles,
  loadTicker,
  marketStatus,
  // diekspor untuk pengujian
  parseYahooCandles,
  aggregate4h,
  closedOnly,
  flagGaps,
  _setHttp,
};
