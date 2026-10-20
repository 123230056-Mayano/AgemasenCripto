"use strict";

/**
 * features/kripto/hhllAlertCore.js
 * ------------------------------------------------------------------
 * Aturan MURNI alarm !alerthhll (tanpa jaringan, bisa diuji unit).
 *
 * Dua tahap, keduanya dinilai dari candle CLOSED terakhir (X):
 *   DINI (early)    : swing baru terkonfirmasi tepat saat X closed.
 *                     naik  = HL baru (swing low lebih tinggi) padahal struktur sebelumnya BUKAN naik
 *                     turun = LH baru (swing high lebih rendah) padahal struktur sebelumnya BUKAN turun
 *                     Belum ada tembusan; ini tanda awal.
 *   KONFIRMASI      : close PERTAMA yang menembus swing terakhir.
 *                     naik  = close X > swing high terakhir, close sebelumnya masih <= level
 *                     turun = close X < swing low terakhir, close sebelumnya masih >= level
 *                     flip = true kalau struktur sebelum tembusan BUKAN searah (berbalik arah / CHoCH);
 *                     flip = false kalau sekadar melanjutkan tren (BOS).
 * Alarm baru aktif kalau struktur sebelum X sudah terbentuk (ada swing high dan swing low berlabel).
 *
 * Swing yang dipakai hanya yang sudah pasti (PIVOT_WIN candle di kanannya closed). Satu pengecualian wajar: swing
 * terakhir bisa digantikan pivot sejenis yang lebih ekstrem kalau belum ada pullback >= MIN_SWING_PCT.
 */

const { t } = require("../../i18n");
const { HHLL_ALERT_CONFIG: HA } = require("../../config/indicatorConfig");
const { computeStructure, CFG } = require("./hhllCore");
const { COIN_WATCHLIST, TF_MS, TF_LABEL, DAILY_TZ_LABEL, fmtCandleTime } = require("./divAlertCore");

const DIRS = ["up", "down"];
const STAGES = ["early", "confirm"];
const TF_ORDER = ["1D", "4H", "1H", "15M"];

// =====================================================================
// 1. Deteksi kejadian
// =====================================================================
/**
 * @param {object[]} closed candle closed urut lama -> baru (X = elemen terakhir)
 * @returns {{stage:"early"|"confirm", dir:"up"|"down", label:string, level:number, ref:number|null, now:number, flip:boolean}[]}
 */
function detectEvents(closed, opts = {}) {
  const win = opts.win || CFG.PIVOT_WIN;
  const n = closed.length;
  const out = [];
  if (n < (opts.minCandles ?? CFG.MIN_CANDLES)) return out;

  const X = closed[n - 1];
  const history = closed.slice(0, -1);
  const prev = history[history.length - 1];
  const before = computeStructure(history, opts);
  const after = computeStructure(closed, opts);
  // Struktur sebelum X belum terbentuk (belum ada swing high DAN swing low berlabel): tidak ada yang bisa
  // dibilang "berbalik" atau "lanjut", jadi tidak ada alarm. Hanya terjadi di koin dengan data sangat sedikit.
  if (!before.trend) return out;

  // ----- KONFIRMASI: close pertama menembus swing terakhir (dari data SEBELUM X) -----
  const hi = before.lastHigh;
  if (hi && X.c > hi.price && prev.c <= hi.price) {
    out.push({ stage: "confirm", dir: "up", label: before.trend === "up" ? "HH" : "BREAK", level: hi.price, ref: hi.price, now: X.c, flip: before.trend !== "up" });
  }
  const lo = before.lastLow;
  if (lo && X.c < lo.price && prev.c >= lo.price) {
    out.push({ stage: "confirm", dir: "down", label: before.trend === "down" ? "LL" : "BREAK", level: lo.price, ref: lo.price, now: X.c, flip: before.trend !== "down" });
  }

  // ----- DINI: swing baru yang tepat terkonfirmasi di X (pivot ada di index n-1-win) -----
  const fresh = after.swings[after.swings.length - 1];
  if (fresh && fresh.i === n - 1 - win) {
    if (fresh.type === "L" && fresh.label === "HL" && before.trend !== "up") {
      out.push({ stage: "early", dir: "up", label: "HL", level: fresh.price, ref: after.lastHigh?.price ?? null, now: X.c, flip: true });
    }
    if (fresh.type === "H" && fresh.label === "LH" && before.trend !== "down") {
      out.push({ stage: "early", dir: "down", label: "LH", level: fresh.price, ref: after.lastLow?.price ?? null, now: X.c, flip: true });
    }
  }
  return out;
}

/** Saring kejadian sesuai langganan { dirs, stages, flipOnly }. */
function matchSub(ev, sub) {
  if (!sub.dirs.includes(ev.dir)) return false;
  if (!sub.stages.includes(ev.stage)) return false;
  if (sub.flipOnly && !ev.flip) return false;
  return true;
}

// =====================================================================
// 2. Kunci dedupe
// =====================================================================
/** candleT = waktu BUKA candle X yang dinilai. Satu kejadian (arah+tahap) per candle per penerima. */
const hhllKey = (chat, userJid, coin, tf, stage, dir, candleT) => ["hhll", "v1", chat, userJid, coin, tf, stage, dir, candleT].join("|");

// =====================================================================
// 3. Parser command
// =====================================================================
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const DIR_TOKENS = { naik: "up", up: "up", bull: "up", bullish: "up", turun: "down", down: "down", bear: "down", bearish: "down" };
const STAGE_TOKENS = { dini: "early", early: "early", konfirmasi: "confirm", confirm: "confirm", confirmed: "confirm", final: "confirm", closed: "confirm" };
const FLIP_TOKENS = new Set(["balik", "reversal", "flip", "choch"]);
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);

/**
 * !alerthhll <koin|watchlist> [tf] [naik|turun] [dini|konfirmasi] [balik]
 * !alerthhll list | off | hapus <id|semua>
 * Tanpa naik/turun = hanya naik (sesuai tujuan "kabari kalau mau terbang"); tulis keduanya untuk dua arah.
 * Tanpa dini/konfirmasi = keduanya.
 * @returns {object|null} null = format salah (-> tampilkan penjelasan command)
 */
function parseHhllArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?h?(\d{1,6})$/);
    return m ? { action: "delete", id: `h${Number(m[1])}` } : null;
  }

  let coin = null;
  let tf = null;
  let flipOnly = false;
  const dirs = [];
  const stages = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (DIR_TOKENS[low]) dirs.push(DIR_TOKENS[low]);
    else if (STAGE_TOKENS[low]) stages.push(STAGE_TOKENS[low]);
    else if (FLIP_TOKENS.has(low)) flipOnly = true;
    else if (coin == null) {
      if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (ALL_TOKENS.has(low)) return { action: "noAll" }; // semua koin terlalu berat; pakai watchlist
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null;
  }
  if (!coin) return null;
  const pick = (arr, all, dflt) => (arr.length ? all.filter((x) => arr.includes(x)) : dflt);
  return { action: "create", coin, tf: tf || defaultTf, dirs: pick(dirs, DIRS, ["up"]), stages: pick(stages, STAGES, [...STAGES]), flipOnly };
}

// =====================================================================
// 4. Teks pesan
// =====================================================================
const fmt = () => require("./market");

/** Satu baris per kejadian. */
function buildLine(lang, ev) {
  const { fmtLevel, fmtUsd } = fmt();
  const vars = {
    coin: ev.coin,
    tf: TF_LABEL[ev.tf] || ev.tf,
    level: fmtLevel(ev.level),
    now: fmtUsd(ev.now),
    ref: ev.ref != null ? fmtLevel(ev.ref) : "-",
  };
  const key = ev.stage === "early" ? `hhllalert.line.early.${ev.dir}` : `hhllalert.line.confirm.${ev.dir}.${ev.flip ? "flip" : "cont"}`;
  return t(lang, key, vars);
}

/** TF besar dulu, lalu balik arah sebelum lanjutan, konfirmasi sebelum dini, arah naik sebelum turun, lalu koin. */
function sortEvents(events) {
  const tfRank = (tf) => TF_ORDER.indexOf(tf);
  return [...events].sort(
    (a, b) =>
      tfRank(a.tf) - tfRank(b.tf) ||
      (a.dir === b.dir ? 0 : a.dir === "up" ? -1 : 1) ||
      Number(b.flip) - Number(a.flip) ||
      (a.stage === b.stage ? 0 : a.stage === "confirm" ? -1 : 1) ||
      a.coin.localeCompare(b.coin),
  );
}

/** Pecah daftar jadi potongan berisi paling banyak `size` elemen (tidak ada yang dibuang). */
function chunk(list, size = HA.LINES_PER_MSG) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Teks satu pesan alarm. ms = waktu evaluasi. */
function buildHhllText(lang, events, { ms, part = 1, parts = 1, total = events.length }) {
  const lines = sortEvents(events).map((ev) => buildLine(lang, ev));
  const head = t(lang, "hhllalert.head", { time: fmtCandleTime(lang, ms), n: total });
  const partTag = parts > 1 ? ` (${part}/${parts})` : "";
  return `${head}${partTag}\n${lines.join("\n")}\n\n${t(lang, "hhllalert.foot")}`;
}

/** Pesan pengantar sebelum PDF. */
function buildHhllPdfIntro(lang, events, { ms }) {
  const tfs = TF_ORDER.filter((k) => events.some((e) => e.tf === k)).map((k) => TF_LABEL[k]);
  const up = events.filter((e) => e.dir === "up").length;
  return t(lang, "hhllalert.pdf.intro", { time: fmtCandleTime(lang, ms), n: events.length, up, down: events.length - up, tfs: tfs.join(", ") });
}

/** Ringkasan satu langganan untuk !alerthhll list / pesan konfirmasi. */
function describeHhll(lang, sub) {
  const dirs = sub.dirs.map((x) => t(lang, `hhllalert.dir.${x}`)).join(" + ");
  const stages = sub.stages.length === STAGES.length ? t(lang, "hhllalert.stage.both") : t(lang, `hhllalert.stage.${sub.stages[0]}`);
  return `${dirs}, ${stages}${sub.flipOnly ? ", " + t(lang, "hhllalert.flipOnly") : ""}`;
}

module.exports = {
  DIRS,
  STAGES,
  TF_ORDER,
  detectEvents,
  matchSub,
  hhllKey,
  parseHhllArgs,
  buildLine,
  buildHhllText,
  buildHhllPdfIntro,
  sortEvents,
  chunk,
  describeHhll,
  DAILY_TZ_LABEL,
};
