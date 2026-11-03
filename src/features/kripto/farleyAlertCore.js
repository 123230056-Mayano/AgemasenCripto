"use strict";

/**
 * features/kripto/farleyAlertCore.js
 * ------------------------------------------------------------------
 * Logika MURNI alarm Farley (!alertfarley): deteksi skenario BUY / SELL baru, kunci dedupe, parser command, teks pesan.
 * Tanpa fetch, tanpa store, tanpa kirim pesan. Dinilai dari candle CLOSED saja:
 *   skenario sekarang  = dari semua candle closed (terakhir = X)
 *   skenario sebelumnya = dari candle closed tanpa X
 *   "baru"             = sekarang BUY/SELL sesuai pilihan DAN sebelumnya bukan arah yang sama
 * TUNGGU / RANGE tidak pernah dikirim.
 */

const { t } = require("../../i18n");
const { FARLEY_ALERT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { TF_MS, TF_ORDER, TF_LABEL, COIN_WATCHLIST, fmtCandleTime } = require("./divAlertCore");

const DIRS = ["buy", "sell"];

const qualifies = (sc, sub) => !!sc && (sc.status === "buy" || sc.status === "sell") && sub.dirs.includes(sc.status);

/** @returns {{dir:"buy"|"sell", trigger:string}|null} */
function detectNewFarley(cur, prev, sub) {
  if (!qualifies(cur, sub)) return null;
  if (qualifies(prev, sub) && prev.status === cur.status) return null; // arah sama sudah berjalan
  return { dir: cur.status, trigger: cur.trigger };
}

/** candleT = waktu BUKA candle closed yang dinilai. Satu alarm per penerima + koin + TF + arah + candle. */
const farleyKey = (chat, userJid, coin, tf, dir, candleT) => ["farleyalert", chat, userJid, coin, tf, dir, candleT].join("|");

// ---------- parser ----------
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const DIR_TOKENS = { buy: "buy", long: "buy", naik: "buy", sell: "sell", short: "sell", turun: "sell" };
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);

/**
 * !alertfarley <koin|watchlist> [tf] [buy|sell] | list | off | hapus <id|semua>
 * @returns {object|null} null = format salah (-> tampilkan penjelasan command)
 */
function parseFarleyAlertArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?f?(\d{1,6})$/);
    return m ? { action: "delete", id: `f${Number(m[1])}` } : null;
  }

  let coin = null;
  let tf = null;
  const dirs = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (DIR_TOKENS[low]) dirs.push(DIR_TOKENS[low]);
    else if (coin == null) {
      if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (ALL_TOKENS.has(low)) return { action: "noAll" };
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null;
  }
  if (!coin) return null;
  const picked = dirs.length ? DIRS.filter((d) => dirs.includes(d)) : [...DIRS];
  return { action: "create", coin, tf: tf || defaultTf, dirs: picked };
}

// ---------- teks ----------
function sortEvents(events) {
  const rank = (tf) => TF_ORDER.indexOf(tf);
  return [...events].sort((a, b) => rank(a.tf) - rank(b.tf) || a.coin.localeCompare(b.coin) || a.dir.localeCompare(b.dir));
}

function chunk(list, size = CFG.BLOCKS_PER_MSG) {
  const out = [];
  const n = Math.max(1, size);
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function buildBlock(lang, ev) {
  const { fmtUsd } = require("./market");
  const { buildFarleyBlock } = require("./farleyText");
  return buildFarleyBlock(lang, { coin: ev.coin, tf: ev.tf, tfLabel: TF_LABEL[ev.tf] || ev.tf, price: fmtUsd(ev.price), sc: ev.sc });
}

/** Teks satu pesan alarm. ms = waktu candle closed (tutup). */
function buildFarleyAlertText(lang, events, { ms, part = 1, parts = 1 }) {
  const { buildFarleyFooter } = require("./farleyText");
  const { ctxTfOf } = require("./farleyCore");
  const blocks = sortEvents(events).map((ev) => buildBlock(lang, ev));
  const head = t(lang, "farleyalert.head", { time: fmtCandleTime(lang, ms), n: events.length });
  const partTag = parts > 1 ? ` (${part}/${parts})` : "";
  const foot = [t(lang, "farleyalert.foot"), buildFarleyFooter(lang, { ctxTf: ctxTfOf(events[0].tf) })];
  return `${head}${partTag}\n\n${blocks.join("\n\n")}\n\n${foot.join("\n")}`;
}

function describeFarleyAlert(lang, sub) {
  return sub.dirs.length === DIRS.length ? t(lang, "farleyalert.dir.both") : t(lang, `farleyalert.dir.${sub.dirs[0]}`);
}

module.exports = { CFG, DIRS, qualifies, detectNewFarley, farleyKey, parseFarleyAlertArgs, sortEvents, chunk, buildBlock, buildFarleyAlertText, describeFarleyAlert };
