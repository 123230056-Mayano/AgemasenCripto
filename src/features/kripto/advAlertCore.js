"use strict";

/**
 * features/kripto/advAlertCore.js
 * ------------------------------------------------------------------
 * Logika MURNI alarm indikator lanjutan (!alertind, item 10 Real-time dan Alarm Lanjutan).
 * Tanpa fetch, tanpa membaca store, tanpa kirim pesan, jadi bisa diuji unit (src/test/advalert.test.js).
 *
 * Jenis alarm:
 *   bias  : label bias koin (bullish / netral / bearish) BERUBAH. Skor dari computeBias (item 07), memakai
 *           komponen milik koin sendiri (tren, cross, RSI, MACD); mood pasar & BTC tidak dipakai supaya
 *           murah dan stabil di mode live. Dilengkapi histeresis agar tidak bolak-balik di sekitar ambang.
 *   cross : crossover EMA BARU (golden / death) pada pasangan di INDICATOR_CONFIG.CROSS_PAIRS (20/50, 50/200).
 *   (divergence baru tetap lewat !alertdiv; jalurnya sudah ada di alertMonitor.)
 *
 * Mode data:
 *   closed : hanya candle closed, dievaluasi tiap candle tutup (stabil). Default.
 *   live   : candle yang belum closed ikut dihitung, dievaluasi berkala; SETIAP pesan ditandai "belum closed".
 *
 * Konfigurasi: config/indicatorConfig.js -> ADV_ALERT_CONFIG.
 */

const { t } = require("../../i18n");
const { ADV_ALERT_CONFIG: ADV, BIAS_CONFIG, INDICATOR_CONFIG } = require("../../config/indicatorConfig");
const { TF_MS, TF_ORDER, TF_LABEL, COIN_WATCHLIST, fmtCandleTime } = require("./divAlertCore");
const { detectCrossPair } = require("./indicators");

const TYPES = ["bias", "cross"];
const MODES = ["closed", "live"];

// =====================================================================
// 1. Aturan bias berubah (histeresis + konfirmasi)
// =====================================================================
/** "bull" | "flat" | "bear" dari skor, tanpa histeresis (ambang sama dengan !bias, eksklusif). */
const labelFromScore = (score, bull = BIAS_CONFIG.BULL, bear = BIAS_CONFIG.BEAR) => (score > bull ? "bull" : score < bear ? "bear" : "flat");

/**
 * Label yang stabil: masuk bullish/bearish di ambang yang sama dengan !bias, tetapi KELUAR dari sana baru
 * bila skor sudah lewat ambang sejauh `hyst`. Mencegah alarm bolak-balik saat skor menempel di ambang.
 */
function stableLabel(prev, score, { bull = BIAS_CONFIG.BULL, bear = BIAS_CONFIG.BEAR, hyst = ADV.BIAS_HYST } = {}) {
  if (prev === "bull" && score > bull - hyst) return "bull";
  if (prev === "bear" && score < bear + hyst) return "bear";
  return labelFromScore(score, bull, bear);
}

/**
 * Satu langkah mesin status bias untuk satu koin.
 * @param {{prev:string|null, score:number, pending?:{label:string,n:number}|null, confirm?:number}} p
 *   prev null = belum pernah dievaluasi -> baseline (tidak pernah mengirim alarm).
 * @returns {{action:"baseline"|"none"|"wait"|"alert", label?:string, from?:string, to?:string, pending:object|null}}
 */
function stepBias({ prev, score, pending = null, confirm = 1, opts }) {
  if (prev == null) return { action: "baseline", label: labelFromScore(score), pending: null };
  const target = stableLabel(prev, score, opts);
  if (target === prev) return { action: "none", pending: null };
  const n = pending && pending.label === target ? pending.n + 1 : 1;
  if (n >= Math.max(1, confirm)) return { action: "alert", from: prev, to: target, pending: null };
  return { action: "wait", pending: { label: target, n } };
}

// =====================================================================
// 2. Crossover baru
// =====================================================================
/**
 * Crossover EMA yang terjadi paling banyak `maxBarsAgo` candle lalu (0 = di candle terakhir).
 * `series` = hasil computeEmas().series; `candles` = candle yang dipakai menghitung (untuk waktu candle cross).
 * @returns {{pair:string, type:"golden"|"death", barsAgo:number, crossT:number}[]}
 */
function detectNewCrosses(series, candles, maxBarsAgo, pairs = INDICATOR_CONFIG.CROSS_PAIRS) {
  const out = [];
  const n = candles.length;
  for (const [fastP, slowP] of pairs) {
    const ready = (a) => Array.isArray(a) && a.length > 0 && a[a.length - 1] != null;
    if (!ready(series[fastP]) || !ready(series[slowP])) continue; // data kurang (mis. EMA200): dilewati, bukan error
    const c = detectCrossPair(series, fastP, slowP, maxBarsAgo + 1);
    if (!c || c.barsAgo > maxBarsAgo) continue;
    const candle = candles[n - 1 - c.barsAgo];
    if (!candle) continue;
    out.push({ pair: `${fastP}/${slowP}`, type: c.type, barsAgo: c.barsAgo, crossT: candle.t });
  }
  return out;
}

// =====================================================================
// 3. Kunci dedupe, cooldown, jadwal live
// =====================================================================
const crossKey = (chat, userJid, coin, tf, pair, type, crossT) => ["adv", "cross", chat, userJid, coin, tf, pair, type, crossT].join("|");

/** Jeda minimum antar alarm per kunci (penerima + koin + TF). Di memori; setelah restart cukup mulai dari nol. */
class CooldownTracker {
  constructor() {
    this.last = new Map();
  }
  ready(key, gapMs, now = Date.now()) {
    if (!gapMs) return true;
    const at = this.last.get(key);
    return at == null || now - at >= gapMs;
  }
  mark(key, now = Date.now()) {
    this.last.set(key, now);
  }
  /** Buang catatan yang sudah lewat `maxAgeMs` supaya Map tidak membengkak. */
  sweep(maxAgeMs, now = Date.now()) {
    for (const [k, at] of this.last) if (now - at > maxAgeMs) this.last.delete(k);
  }
}

/**
 * Pilih pasangan koin+TF live yang jatuh tempo dihitung ulang (paling lama menunggu dulu), maksimal `max`.
 * Kalau pasangan lebih banyak dari `max`, sisanya otomatis kebagian di putaran berikutnya (bergilir).
 * @param {string[]} pairs "COIN|TF" unik
 * @param {Map<string,number>} lastRun
 * @returns {string[]}
 */
function selectLivePairs(pairs, lastRun, now, { intervalMs = ADV.LIVE_INTERVAL_MS, max = ADV.LIVE_MAX_PAIRS } = {}) {
  return pairs
    .filter((p) => now - (lastRun.get(p) || 0) >= intervalMs)
    .sort((a, b) => (lastRun.get(a) || 0) - (lastRun.get(b) || 0) || a.localeCompare(b))
    .slice(0, max);
}

/** Pecah daftar jadi potongan berisi paling banyak `size` elemen (tidak ada yang dibuang). */
function chunk(list, size = ADV.LINES_PER_MSG) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// =====================================================================
// 4. Parser command
// =====================================================================
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const TYPE_TOKENS = { bias: "bias", cross: "cross", crossover: "cross" };
const LIVE_TOKENS = new Set(["live", "realtime", "real-time"]);
const CLOSED_TOKENS = new Set(["closed", "close", "tutup"]);
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);
const DIV_TOKENS = new Set(["div", "divergence", "divergent"]);

/**
 * !alertind <koin|watchlist> [tf] [bias|cross] [live|closed]
 * !alertind list | off | hapus <id|semua>
 * @returns {object|null} null = format salah (-> tampilkan penjelasan command);
 *   { action: "div" } = user minta divergence (diarahkan ke !alertdiv).
 */
function parseAdvArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?a?(\d{1,6})$/);
    return m ? { action: "delete", id: `a${Number(m[1])}` } : null;
  }

  let coin = null;
  let tf = null;
  let mode = null;
  const types = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (DIV_TOKENS.has(low)) return { action: "div" };
    if (TF_MS[up]) tf = up;
    else if (TYPE_TOKENS[low]) types.push(TYPE_TOKENS[low]);
    else if (LIVE_TOKENS.has(low)) mode = "live";
    else if (CLOSED_TOKENS.has(low)) mode = "closed";
    else if (coin == null) {
      if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (ALL_TOKENS.has(low)) return { action: "noAll" }; // "semua koin" belum didukung (terlalu berat), pakai watchlist
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null;
  }
  if (!coin) return null;
  return { action: "create", coin, tf: tf || defaultTf, types: types.length ? [...new Set(types)] : [...TYPES], mode: mode || "closed" };
}

// =====================================================================
// 5. Teks pesan
// =====================================================================
const BIAS_LABEL_KEY = { bull: "advalert.bias.bull", flat: "advalert.bias.flat", bear: "advalert.bias.bear" };
const fmtScore = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

/** Satu baris per kejadian. ev.type: "bias" | "cross". */
function buildLine(lang, ev) {
  const tf = TF_LABEL[ev.tf] || ev.tf;
  if (ev.type === "bias") {
    return t(lang, "advalert.line.bias", {
      coin: ev.coin,
      tf,
      to: t(lang, BIAS_LABEL_KEY[ev.to]),
      from: t(lang, BIAS_LABEL_KEY[ev.from]),
      score: fmtScore(ev.score),
    });
  }
  return t(lang, "advalert.line.cross", {
    coin: ev.coin,
    tf,
    kind: t(lang, ev.crossType === "golden" ? "advalert.cross.golden" : "advalert.cross.death"),
    pair: ev.pair,
    when: ev.barsAgo === 0 ? t(lang, "advalert.when.now") : t(lang, "advalert.when.ago", { n: ev.barsAgo }),
  });
}

/** Urutkan: TF besar dulu (1D > 4H > 1H > 15m), lalu koin, lalu bias sebelum cross. */
function sortEvents(events) {
  const rank = (tf) => TF_ORDER.indexOf(tf);
  return [...events].sort((a, b) => rank(a.tf) - rank(b.tf) || a.coin.localeCompare(b.coin) || a.type.localeCompare(b.type));
}

/**
 * Teks satu pesan alarm. live = true -> header + peringatan "candle belum closed" (wajib, PDF 10).
 * @param {string} lang
 * @param {object[]} events
 * @param {{live:boolean, ms:number, part?:number, parts?:number}} meta ms = waktu evaluasi / candle tutup
 */
function buildAdvText(lang, events, { live, ms, part = 1, parts = 1 }) {
  const lines = sortEvents(events).map((ev) => buildLine(lang, ev));
  const head = t(lang, live ? "advalert.head.live" : "advalert.head.closed", { time: fmtCandleTime(lang, ms), n: events.length });
  const partTag = parts > 1 ? ` (${part}/${parts})` : "";
  return `${head}${partTag}\n${lines.join("\n")}\n\n${t(lang, live ? "advalert.foot.live" : "advalert.foot.closed")}`;
}

/** Ringkasan satu langganan untuk !alertind list / pesan konfirmasi. */
function describeAdv(lang, sub) {
  const types = sub.types.map((x) => t(lang, `advalert.type.${x}`)).join(" + ");
  return `${types}, ${t(lang, sub.mode === "live" ? "advalert.mode.live" : "advalert.mode.closed")}`;
}

module.exports = {
  ADV,
  TYPES,
  MODES,
  labelFromScore,
  stableLabel,
  stepBias,
  detectNewCrosses,
  crossKey,
  CooldownTracker,
  selectLivePairs,
  chunk,
  parseAdvArgs,
  buildLine,
  buildAdvText,
  sortEvents,
  describeAdv,
};
