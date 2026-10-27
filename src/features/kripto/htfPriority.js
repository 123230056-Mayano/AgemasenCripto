"use strict";

/**
 * features/kripto/htfPriority.js
 * ------------------------------------------------------------------
 * Fitur 2: label PRIORITAS / COUNTER-TREND / NETRAL berdasarkan arah timeframe besar. Logika MURNI (tanpa fetch,
 * tanpa i18n). Tidak mengubah grade / status pola; hanya label tambahan. Label ini bukan perintah beli / jual.
 *
 * Aturan (htfTrend dari computeStructure: "up" | "down" | "range" | null):
 *   TF besar naik  + pola bullish = PRIORITY      TF besar naik  + pola bearish = COUNTER
 *   TF besar turun + pola bearish = PRIORITY      TF besar turun + pola bullish = COUNTER
 *   TF besar range                = NEUTRAL
 *   TF besar null (gagal ambil / data kurang) = UNAVAILABLE (jangan menebak)
 *   Pola berarah netral (doji, dll.) = tidak diberi label (null)
 */

const PRIORITY = Object.freeze({ PRIORITY: "priority", COUNTER: "counter", NEUTRAL: "neutral", UNAVAILABLE: "unavailable" });

const isBull = (dir) => dir === "bullish";
const isBear = (dir) => dir === "bearish";

/**
 * @param {"bullish"|"bearish"|"netral"} dir arah pola
 * @param {"up"|"down"|"range"|null} htfTrend tren TF besar (sudah closed saat candle pola closed)
 * @returns {string|null} salah satu PRIORITY, atau null untuk pola berarah netral
 */
function priorityOf(dir, htfTrend) {
  if (!isBull(dir) && !isBear(dir)) return null;
  if (htfTrend !== "up" && htfTrend !== "down" && htfTrend !== "range") return PRIORITY.UNAVAILABLE;
  if (htfTrend === "range") return PRIORITY.NEUTRAL;
  return (htfTrend === "up") === isBull(dir) ? PRIORITY.PRIORITY : PRIORITY.COUNTER;
}

/** Ringkasan satu TF besar: { tf, trend, state } dengan state = "up" | "down" | "range" | "unavailable" | "none" (tidak ada TF besar, mis. 1D). */
function htfSummary(htfTf, htfTrend) {
  if (!htfTf) return { tf: null, trend: null, state: "none" };
  if (htfTrend === "up" || htfTrend === "down" || htfTrend === "range") return { tf: htfTf, trend: htfTrend, state: htfTrend };
  return { tf: htfTf, trend: null, state: "unavailable" };
}

/** Pasang p.priority pada tiap pola (mutasi in-place, return array yang sama). hasHtf=false (mis. 1D, tidak ada TF di atasnya) = tanpa label. */
function labelPatterns(patterns, htfTrend, hasHtf = true) {
  for (const p of patterns) p.priority = hasHtf ? priorityOf(p.dir, htfTrend) : null;
  return patterns;
}

/** Urutan tampil: PRIORITY dulu, lalu NEUTRAL / UNAVAILABLE / tanpa label, COUNTER terakhir. Stabil (urutan lama dipertahankan). */
const RANK = { priority: 0, neutral: 1, unavailable: 1, counter: 2 };
function sortByPriority(patterns) {
  return patterns
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (RANK[a.p.priority] ?? 1) - (RANK[b.p.priority] ?? 1) || a.i - b.i)
    .map((x) => x.p);
}

module.exports = { PRIORITY, priorityOf, htfSummary, labelPatterns, sortByPriority };
