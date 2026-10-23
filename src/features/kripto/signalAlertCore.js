"use strict";

/**
 * features/kripto/signalAlertCore.js
 * ------------------------------------------------------------------
 * Logika MURNI alarm skenario sinyal (!alertsignal). Tanpa fetch, tanpa membaca store, tanpa kirim pesan,
 * jadi bisa diuji unit (src/test/signalalert.test.js).
 *
 * Alarm mengirim skenario yang sama dengan !signal (entry / SL / TP1 / TP2 / RR + status entri) saat skenario
 * LONG atau SHORT BARU muncul. Dinilai dari candle CLOSED saja:
 *   skenario sekarang  = dari semua candle closed (candle terakhir = X)
 *   skenario sebelumnya = dari candle closed tanpa X
 *   "baru"             = sekarang memenuhi syarat DAN sebelumnya tidak memenuhi syarat di arah yang sama
 * Jadi alarm tidak bolak-balik selama skenario bertahan, dan tidak butuh status tersimpan.
 *
 * Syarat sebuah skenario dikabari: arah long/short sesuai pilihan, status entri VALID
 * (opsi `tunggu`: TUNGGU juga). HINDARI dan SIDEWAYS tidak pernah dikirim.
 *
 * Konfigurasi: config/indicatorConfig.js -> SIGNAL_ALERT_CONFIG.
 */

const { t } = require("../../i18n");
const { SIGNAL_ALERT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { TF_MS, TF_ORDER, TF_LABEL, COIN_WATCHLIST, fmtCandleTime } = require("./divAlertCore");

const DIRS = ["long", "short"];

// =====================================================================
// 1. Deteksi
// =====================================================================
/**
 * Apakah skenario memenuhi syarat langganan.
 * @param {{status:string, guard?:{status:string}|null}|null} sc hasil computeScenario (signal.js)
 * @param {{dirs:string[], wait?:boolean}} sub
 */
function qualifies(sc, sub) {
  if (!sc || (sc.status !== "long" && sc.status !== "short")) return false;
  if (!sub.dirs.includes(sc.status)) return false;
  const g = sc.guard?.status;
  if (!g) return false; // tanpa penilaian Sudden Move Guard tidak ada status entri -> tidak dikabari
  return g === "VALID" || (!!sub.wait && g === "TUNGGU");
}

/**
 * Skenario baru? `cur` dan `prev` = hasil computeScenario untuk candle closed terakhir dan sebelumnya.
 * @returns {{dir:"long"|"short", status:string}|null}
 */
function detectNewSignal(cur, prev, sub) {
  if (!qualifies(cur, sub)) return null;
  if (qualifies(prev, sub) && prev.status === cur.status) return null; // arah sama sudah berjalan
  return { dir: cur.status, status: cur.guard.status };
}

// =====================================================================
// 2. Kunci dedupe
// =====================================================================
/** candleT = waktu BUKA candle closed yang dinilai. Satu alarm per penerima + koin + TF + arah + candle. */
const signalKey = (chat, userJid, coin, tf, dir, candleT) => ["sigalert", chat, userJid, coin, tf, dir, candleT].join("|");

// =====================================================================
// 3. Parser command
// =====================================================================
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const DIR_TOKENS = { long: "long", buy: "long", naik: "long", short: "short", sell: "short", turun: "short" };
const WAIT_TOKENS = new Set(["tunggu", "wait", "waiting"]);
const VALID_TOKENS = new Set(["valid"]); // default; diterima supaya eksplisit boleh
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);

/**
 * !alertsignal <koin|watchlist> [tf] [long|short] [tunggu]
 * !alertsignal list | off | hapus <id|semua>
 * @returns {object|null} null = format salah (-> tampilkan penjelasan command)
 */
function parseSignalAlertArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?g?(\d{1,6})$/);
    return m ? { action: "delete", id: `g${Number(m[1])}` } : null;
  }

  let coin = null;
  let tf = null;
  let wait = false;
  const dirs = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (DIR_TOKENS[low]) dirs.push(DIR_TOKENS[low]);
    else if (WAIT_TOKENS.has(low)) wait = true;
    else if (VALID_TOKENS.has(low)) continue;
    else if (coin == null) {
      if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (ALL_TOKENS.has(low)) return { action: "noAll" }; // semua koin terlalu berat; pakai watchlist
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null;
  }
  if (!coin) return null;
  // Urutan tetap, tanpa duplikat; tanpa kata arah = dua arah.
  const picked = dirs.length ? DIRS.filter((d) => dirs.includes(d)) : [...DIRS];
  return { action: "create", coin, tf: tf || defaultTf, dirs: picked, wait };
}

// =====================================================================
// 4. Teks pesan
// =====================================================================
/** TF besar dulu, lalu koin, lalu long sebelum short. */
function sortEvents(events) {
  const rank = (tf) => TF_ORDER.indexOf(tf);
  return [...events].sort((a, b) => rank(a.tf) - rank(b.tf) || a.coin.localeCompare(b.coin) || a.dir.localeCompare(b.dir));
}

/** Pecah daftar jadi potongan berisi paling banyak `size` elemen (tidak ada yang dibuang). */
function chunk(list, size = CFG.BLOCKS_PER_MSG) {
  const out = [];
  for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + Math.max(1, size)));
  return out;
}

/**
 * Satu blok skenario (judul koin + isi persis seperti !signal untuk satu TF).
 * @param {object} ev { coin, tf, price, row:{tf,bias,scenario} }
 */
function buildBlock(lang, ev) {
  const { fmtUsd } = require("./market");
  const { formatTfBlock } = require("./signal");
  const head = t(lang, "signalalert.blockHead", { coin: ev.coin, tf: TF_LABEL[ev.tf] || ev.tf, price: fmtUsd(ev.price) });
  return `${head}\n${formatTfBlock(lang, ev.row, { overall: null })}`;
}

/** Teks satu pesan alarm. ms = waktu candle closed (tutup). */
function buildSignalText(lang, events, { ms, part = 1, parts = 1 }) {
  const blocks = sortEvents(events).map((ev) => buildBlock(lang, ev));
  const head = t(lang, "signalalert.head", { time: fmtCandleTime(lang, ms), n: events.length });
  const partTag = parts > 1 ? ` (${part}/${parts})` : "";
  return `${head}${partTag}\n\n${blocks.join("\n\n")}\n\n${t(lang, "signalalert.foot")}\n${t(lang, "sinyal.disclaimer")}`;
}

/** Ringkasan satu langganan untuk !alertsignal list / pesan konfirmasi. */
function describeSignalAlert(lang, sub) {
  const dirs = sub.dirs.length === DIRS.length ? t(lang, "signalalert.dir.both") : t(lang, `signalalert.dir.${sub.dirs[0]}`);
  return `${dirs}, ${t(lang, sub.wait ? "signalalert.status.wait" : "signalalert.status.valid")}`;
}

module.exports = {
  CFG,
  DIRS,
  qualifies,
  detectNewSignal,
  signalKey,
  parseSignalAlertArgs,
  sortEvents,
  chunk,
  buildBlock,
  buildSignalText,
  describeSignalAlert,
};
