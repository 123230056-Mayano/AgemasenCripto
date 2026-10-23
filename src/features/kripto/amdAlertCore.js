"use strict";

/**
 * features/kripto/amdAlertCore.js
 * ------------------------------------------------------------------
 * Aturan MURNI alarm !alertamd (tanpa jaringan, bisa diuji unit: src/test/amd.test.js).
 *
 * Dua tahap, keduanya dinilai dari candle CLOSED terakhir (X). Definisi fase ada di amdCore.js.
 *   DINI (early)  : sweep (manipulasi) terjadi tepat di X: range akumulasi ditembus wick lalu X close kembali ke dalam range.
 *                   naik  = sweep tepi bawah (bullish), turun = sweep tepi atas (bearish).
 *                   Belum ada break struktur; ini tanda awal dan bisa gagal.
 *   KONFIRMASI    : close PERTAMA setelah sweep yang menembus swing berlawanan (break market structure) di X,
 *                   dalam CONFIRM_BARS candle sejak sweep dan sebelum close menembus ekstrem sweep.
 *                   Ini awal fase distribusi.
 * Satu sweep paling banyak menghasilkan satu pesan dini dan satu pesan konfirmasi.
 */

const { t } = require("../../i18n");
const { AMD_ALERT_CONFIG: AA } = require("../../config/indicatorConfig");
const { CFG, findManipulations, mssLevel } = require("./amdCore");
const { COIN_WATCHLIST, TF_MS, TF_LABEL, TF_ORDER, DAILY_TZ_LABEL, fmtCandleTime } = require("./divAlertCore");

const DIRS = ["up", "down"];
const STAGES = ["early", "confirm"];
const dirOf = (d) => (d === "bullish" ? "up" : "down");

// =====================================================================
// 1. Deteksi kejadian
// =====================================================================
/**
 * @param {object[]} closed candle closed urut lama -> baru (X = elemen terakhir)
 * @returns {{stage:"early"|"confirm", dir:"up"|"down", edge:number, extreme:number, level:number, now:number, rangeHi:number, rangeLo:number, bars:number}[]}
 *   edge    = tepi range yang disapu (low range untuk naik, high range untuk turun)
 *   extreme = low / high sweep
 *   level   = level break struktur: yang HARUS ditembus (dini) atau yang BARU ditembus (konfirmasi)
 */
function detectEvents(closed, opts = {}) {
  const n = closed.length;
  const min = opts.minCandles ?? CFG.MIN_CANDLES;
  if (n < min) return [];
  const X = closed[n - 1];
  const out = [];
  for (const mp of findManipulations(closed, { lookback: CFG.CONFIRM_BARS })) {
    const base = {
      dir: dirOf(mp.dir),
      edge: mp.dir === "bullish" ? mp.range.lo : mp.range.hi,
      extreme: mp.extreme,
      now: X.c,
      rangeHi: mp.range.hi,
      rangeLo: mp.range.lo,
      bars: mp.range.bars,
    };
    if (mp.i === n - 1) out.push({ stage: "early", ...base, level: mssLevel(closed, mp).price });
    if (mp.status === "confirmed" && mp.at === n - 1) out.push({ stage: "confirm", ...base, level: mp.level.price });
  }
  return out;
}

/** Saring kejadian sesuai langganan { dirs, stages }. */
function matchSub(ev, sub) {
  return sub.dirs.includes(ev.dir) && sub.stages.includes(ev.stage);
}

// =====================================================================
// 2. Kunci dedupe
// =====================================================================
/** candleT = waktu BUKA candle X yang dinilai. Satu kejadian (tahap+arah) per candle per penerima. */
const amdKey = (chat, userJid, coin, tf, stage, dir, candleT) => ["amd", "v1", chat, userJid, coin, tf, stage, dir, candleT].join("|");

// =====================================================================
// 3. Parser command
// =====================================================================
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const DIR_TOKENS = { naik: "up", up: "up", bull: "up", bullish: "up", turun: "down", down: "down", bear: "down", bearish: "down" };
const STAGE_TOKENS = { dini: "early", early: "early", konfirmasi: "confirm", confirm: "confirm", confirmed: "confirm", final: "confirm", closed: "confirm" };
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);

/**
 * !alertamd <koin|watchlist> [tf] [naik|turun] [dini|konfirmasi]
 * !alertamd list | off | hapus <id|semua>
 * Tanpa naik/turun = dua arah (bullish dan bearish). Tanpa dini/konfirmasi = keduanya.
 * @returns {object|null} null = format salah (-> tampilkan penjelasan command)
 */
function parseAmdArgs(raw, defaultTf) {
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
  const dirs = [];
  const stages = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (DIR_TOKENS[low]) dirs.push(DIR_TOKENS[low]);
    else if (STAGE_TOKENS[low]) stages.push(STAGE_TOKENS[low]);
    else if (coin == null) {
      if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (ALL_TOKENS.has(low)) return { action: "noAll" }; // semua koin terlalu berat; pakai watchlist
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null;
  }
  if (!coin) return null;
  const pick = (arr, all) => (arr.length ? all.filter((x) => arr.includes(x)) : [...all]);
  return { action: "create", coin, tf: tf || defaultTf, dirs: pick(dirs, DIRS), stages: pick(stages, STAGES) };
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
    lo: fmtLevel(ev.rangeLo),
    hi: fmtLevel(ev.rangeHi),
    bars: ev.bars,
    edge: fmtLevel(ev.edge),
    extreme: fmtLevel(ev.extreme),
    level: fmtLevel(ev.level),
    now: fmtUsd(ev.now),
  };
  return t(lang, `amdalert.line.${ev.stage}.${ev.dir}`, vars);
}

/** TF besar dulu, konfirmasi sebelum dini, arah naik sebelum turun, lalu koin. */
function sortEvents(events) {
  const tfRank = (tf) => TF_ORDER.indexOf(tf);
  return [...events].sort(
    (a, b) =>
      tfRank(a.tf) - tfRank(b.tf) ||
      (a.stage === b.stage ? 0 : a.stage === "confirm" ? -1 : 1) ||
      (a.dir === b.dir ? 0 : a.dir === "up" ? -1 : 1) ||
      a.coin.localeCompare(b.coin),
  );
}

/** Pecah daftar jadi potongan berisi paling banyak `size` elemen (tidak ada yang dibuang). */
function chunk(list, size = AA.LINES_PER_MSG) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Teks satu pesan alarm. ms = waktu evaluasi. */
function buildAmdText(lang, events, { ms, part = 1, parts = 1, total = events.length }) {
  const lines = sortEvents(events).map((ev) => buildLine(lang, ev));
  const head = t(lang, "amdalert.head", { time: fmtCandleTime(lang, ms), n: total });
  const partTag = parts > 1 ? ` (${part}/${parts})` : "";
  return `${head}${partTag}\n${lines.join("\n")}\n\n${t(lang, "amdalert.foot")}`;
}

/** Ringkasan satu langganan untuk !alertamd list / pesan konfirmasi. */
function describeAmd(lang, sub) {
  const dirs = sub.dirs.length === DIRS.length ? t(lang, "amdalert.dir.both") : t(lang, `amdalert.dir.${sub.dirs[0]}`);
  const stages = sub.stages.length === STAGES.length ? t(lang, "amdalert.stage.both") : t(lang, `amdalert.stage.${sub.stages[0]}`);
  return `${dirs}, ${stages}`;
}

module.exports = {
  AA,
  DIRS,
  STAGES,
  detectEvents,
  matchSub,
  amdKey,
  parseAmdArgs,
  buildLine,
  buildAmdText,
  sortEvents,
  chunk,
  describeAmd,
  DAILY_TZ_LABEL,
};
