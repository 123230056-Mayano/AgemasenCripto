"use strict";

/**
 * state/cryptoStore.js
 * ------------------------------------------------------------------
 * Penyimpanan watchlist, alert harga/level, dan langganan ringkasan harian
 * (Command Kripto - Bagian 5). Semuanya PER USER (jid pengirim asli), jadi
 * watchlist & alert satu orang tidak terlihat orang lain walau di grup yang sama.
 *
 * Disimpan di data/crypto_watch.json (override lewat env CRYPTO_STATE_FILE)
 * dengan penulisan atomik (tulis file sementara lalu rename), jadi tetap ada
 * setelah bot restart/redeploy.
 *
 * Bentuk data:
 *   users[userJid] = {
 *     watch:   ["SOL", "ETH"],
 *     nextId:  4,                         // ID alert berikutnya (per user)
 *     alerts:  [
 *       { id, chat, coin, type: "price", price, dir: "up"|"down", createdAt },
 *       { id, chat, coin, type: "level", tf, createdAt, armed: { S: true, R: true } },
 *     ],
 *     daily:   { chat, hour, minute, lastSent: "YYYY-MM-DD" | null } | null,
 *   }
 */

const fs = require("fs");
const path = require("path");
const { BOT_STATE_DATA_DIR } = require("../config/env");

const FILE = process.env.CRYPTO_STATE_FILE || path.join(BOT_STATE_DATA_DIR, "crypto_watch.json");

const MAX_WATCH = 20;
const MAX_ALERTS = 20;

let users = {};

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    users = parsed && typeof parsed.users === "object" && parsed.users ? parsed.users : {};
  } catch {
    users = {}; // belum ada file / rusak -> mulai kosong
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.log("[kripto] gagal menyimpan crypto_watch.json:", err.message);
  }
}

function user(jid) {
  if (!users[jid]) users[jid] = { watch: [], nextId: 1, alerts: [], daily: null };
  const u = users[jid];
  if (!Array.isArray(u.watch)) u.watch = [];
  if (!Array.isArray(u.alerts)) u.alerts = [];
  if (!u.nextId) u.nextId = 1;
  return u;
}

/** Hapus entri user yang sudah kosong supaya file tidak membengkak. */
function prune(jid) {
  const u = users[jid];
  if (u && !u.watch.length && !u.alerts.length && !u.daily && !u.tf) delete users[jid];
}

// ---------- watchlist ----------
const getWatch = (jid) => [...user(jid).watch];

/** @returns {"added"|"exists"|"full"} */
function addWatch(jid, coin) {
  const u = user(jid);
  if (u.watch.includes(coin)) return "exists";
  if (u.watch.length >= MAX_WATCH) return "full";
  u.watch.push(coin);
  save();
  return "added";
}

/** @returns {boolean} true kalau ada yang dihapus */
function removeWatch(jid, coin) {
  const u = user(jid);
  const i = u.watch.indexOf(coin);
  if (i < 0) return false;
  u.watch.splice(i, 1);
  prune(jid);
  save();
  return true;
}

// ---------- alert ----------
const getAlerts = (jid) => [...user(jid).alerts];

/** @returns {object|"full"} alert yang dibuat, atau "full" kalau sudah mencapai batas */
function addAlert(jid, alert) {
  const u = user(jid);
  if (u.alerts.length >= MAX_ALERTS) return "full";
  const entry = { ...alert, id: u.nextId++, createdAt: Date.now() };
  u.alerts.push(entry);
  save();
  return entry;
}

/** Alert level untuk koin yang sama diperbarui, bukan digandakan. */
function findLevelAlert(jid, coin) {
  return user(jid).alerts.find((a) => a.type === "level" && a.coin === coin) || null;
}

function removeAlert(jid, id) {
  const u = user(jid);
  const i = u.alerts.findIndex((a) => a.id === id);
  if (i < 0) return false;
  u.alerts.splice(i, 1);
  prune(jid);
  save();
  return true;
}

/** Semua alert semua user (untuk monitor). */
function allAlerts() {
  const out = [];
  for (const [jid, u] of Object.entries(users)) {
    for (const a of u.alerts || []) out.push({ userJid: jid, alert: a });
  }
  return out;
}

// ---------- ringkasan harian ----------
const getDaily = (jid) => user(jid).daily;

function setDaily(jid, chat, hour, minute) {
  const u = user(jid);
  u.daily = { chat, hour, minute, lastSent: null };
  save();
}

function clearDaily(jid) {
  const u = user(jid);
  if (!u.daily) return false;
  u.daily = null;
  prune(jid);
  save();
  return true;
}

function allDaily() {
  const out = [];
  for (const [jid, u] of Object.entries(users)) if (u.daily) out.push({ userJid: jid, daily: u.daily });
  return out;
}

// ---------- timeframe default (!tf) ----------
/** @returns {string|null} timeframe tersimpan (\"15M\"|\"1H\"|\"4H\"|\"1D\") atau null. */
const getTf = (jid) => users[jid]?.tf || null;

function setTf(jid, tf) {
  user(jid).tf = tf;
  save();
}

/** Dipanggil setelah mengubah field alert/daily secara langsung (mis. lastSent, armed). */
const persist = save;

load();

module.exports = {
  MAX_WATCH,
  MAX_ALERTS,
  getWatch,
  addWatch,
  removeWatch,
  getAlerts,
  addAlert,
  findLevelAlert,
  removeAlert,
  allAlerts,
  getTf,
  setTf,
  getDaily,
  setDaily,
  clearDaily,
  allDaily,
  persist,
};
