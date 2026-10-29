"use strict";

/**
 * features/forex/forexPairs.js
 * ------------------------------------------------------------------
 * Daftar pair forex yang didukung bot + aturan tampilan (digits, pip) + pengenalan input.
 * Fungsi MURNI, tanpa jaringan. Daftar sama dengan lib/forex.js di web KriptoPredict (12 pair).
 *
 * Konvensi pip (KEPUTUSAN SEMENTARA, belum dijawab client - Catatan Rencana bagian 9 no. 3):
 *   - pair JPY                 : 1 pip = 0,01
 *   - mayor & cross lain       : 1 pip = 0,0001
 *   - XAUUSD                   : 1 pip = 0,10 USD (konvensi umum broker; ubah di sini kalau client minta lain)
 *   - USDIDR                   : tanpa pip (pip: null) -> jarak ditampilkan sebagai harga saja
 * Digits (presisi tampilan): JPY = 3, XAUUSD = 2, USDIDR = 0, lainnya = 5.
 */

const PAIRS = Object.freeze({
  EURUSD: { base: "EUR", quote: "USD", cat: "major", digits: 5, pip: 0.0001, yahoo: "EURUSD=X" },
  GBPUSD: { base: "GBP", quote: "USD", cat: "major", digits: 5, pip: 0.0001, yahoo: "GBPUSD=X" },
  USDJPY: { base: "USD", quote: "JPY", cat: "major", digits: 3, pip: 0.01, yahoo: "USDJPY=X" },
  USDCHF: { base: "USD", quote: "CHF", cat: "major", digits: 5, pip: 0.0001, yahoo: "USDCHF=X" },
  AUDUSD: { base: "AUD", quote: "USD", cat: "major", digits: 5, pip: 0.0001, yahoo: "AUDUSD=X" },
  USDCAD: { base: "USD", quote: "CAD", cat: "major", digits: 5, pip: 0.0001, yahoo: "USDCAD=X" },
  NZDUSD: { base: "NZD", quote: "USD", cat: "major", digits: 5, pip: 0.0001, yahoo: "NZDUSD=X" },
  EURGBP: { base: "EUR", quote: "GBP", cat: "cross", digits: 5, pip: 0.0001, yahoo: "EURGBP=X" },
  EURJPY: { base: "EUR", quote: "JPY", cat: "cross", digits: 3, pip: 0.01, yahoo: "EURJPY=X" },
  GBPJPY: { base: "GBP", quote: "JPY", cat: "cross", digits: 3, pip: 0.01, yahoo: "GBPJPY=X" },
  // Emas: Yahoo tidak punya spot XAUUSD yang andal, dipetakan ke futures emas GC=F (harga beda dari spot, ada gap kontrak).
  XAUUSD: { base: "XAU", quote: "USD", cat: "metal", digits: 2, pip: 0.1, yahoo: "GC=F", proxy: "futures" },
  // Likuiditas tipis, candle sering datar (doji palsu): TF 15m tidak dipakai.
  USDIDR: { base: "USD", quote: "IDR", cat: "exotic", digits: 0, pip: null, yahoo: "USDIDR=X", minTf: "1H" },
});

const TF_ORDER = ["15M", "1H", "4H", "1D"];

/** Pair dengan USD sebagai quote: arah komponen "kekuatan USD" dibalik (dipakai fase lanjut). */
const USD_QUOTE = Object.freeze(["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "XAUUSD"]);
const USD_BASE = Object.freeze(["USDJPY", "USDCHF", "USDCAD"]);

/**
 * Normalisasi input pair: "eur/usd", "EUR-USD", "eur_usd", "eurusd" -> "EURUSD". Bukan pair -> null.
 * Hanya mengembalikan nama jika ada di daftar (jadi "BTCUSD" atau "ETH/USD" tidak lolos).
 */
function resolvePair(input) {
  if (typeof input !== "string") return null;
  const s = input.trim().toUpperCase().replace(/[\/\-_\s]/g, "");
  return Object.prototype.hasOwnProperty.call(PAIRS, s) ? s : null;
}

/**
 * Ubah penulisan berpisah di dalam argumen command menjadi satu token: "eur/usd 4h" -> "eurusd 4h".
 * Hanya menyentuh pola 3 huruf + pemisah + 3 huruf, jadi argumen lain tidak berubah.
 */
function normalizePairText(raw) {
  return String(raw || "").replace(/\b([A-Za-z]{3})\s?[\/\-_]\s?([A-Za-z]{3})\b/g, (m, a, b) => (resolvePair(a + b) ? a + b : m));
}

const pairInfo = (pair) => PAIRS[pair] || null;
const listPairs = () => Object.keys(PAIRS);

/** TF yang boleh dipakai pair ini (USDIDR: mulai 1H). */
function allowedTfs(pair, tfs = TF_ORDER) {
  const min = PAIRS[pair]?.minTf;
  if (!min) return [...tfs];
  const from = TF_ORDER.indexOf(min);
  return tfs.filter((tf) => TF_ORDER.indexOf(tf) >= from);
}

/**
 * Jarak harga -> pip (nilai mutlak). null bila pair tanpa pip (USDIDR) atau input tidak valid.
 * Dibulatkan 1 desimal (mis. 27,4 pip).
 */
function toPips(pair, distance) {
  const pip = PAIRS[pair]?.pip;
  if (!pip || typeof distance !== "number" || !isFinite(distance)) return null;
  return Math.round((Math.abs(distance) / pip) * 10) / 10;
}

/** Bulatkan harga ke digits pair (membuang float panjang dari Yahoo). */
function roundPrice(pair, v) {
  const d = PAIRS[pair]?.digits;
  if (d == null || typeof v !== "number" || !isFinite(v)) return v;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

module.exports = { PAIRS, TF_ORDER, USD_QUOTE, USD_BASE, resolvePair, normalizePairText, pairInfo, listPairs, allowedTfs, toPips, roundPrice };
