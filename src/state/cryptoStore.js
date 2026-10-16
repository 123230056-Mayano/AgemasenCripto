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
 *     divAlerts: [                        // alarm divergence (!alertdivergent)
 *       { id: "d1", chat, coin: "BTC"|"*"|"WATCHLIST", tf: "15M"|"1H"|"4H"|"1D",
 *         indicators: ["rsi","macd"], dirs: [], kinds: [], createdAt, active: true },
 *     ],
 *     nextDivId: 2,
 *   }
 *
 * State global alarm divergence (harus tahan restart, jadi disimpan di file yang sama):
 *   divergence = {
 *     lastClosedByTf: { "4H": <ms waktu tutup candle terakhir yang sudah diproses> },
 *     sent: { "<kunci dedupe>": <ms waktu kirim> },   // dibersihkan berkala (TTL, lihat DIV_SENT_TTL_MS)
 *   }
 */

const fs = require("fs");
const path = require("path");
const { BOT_STATE_DATA_DIR } = require("../config/env");

const FILE = process.env.CRYPTO_STATE_FILE || path.join(BOT_STATE_DATA_DIR, "crypto_watch.json");

const MAX_WATCH = 20;
const MAX_ALERTS = 20;

// Batas alarm divergence (usulan PDF 5.5: 10 per user). Bisa diubah lewat env.
const posInt = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
const MAX_DIV_ALERTS = posInt(process.env.DIV_ALERT_MAX_PER_USER, 10);
const MAX_DIV_ALERTS_PER_CHAT = posInt(process.env.DIV_ALERT_MAX_PER_CHAT, 20);
// Kunci dedupe harus bertahan lebih lama dari jendela deteksi ulang (LOOKBACK + 1 candle 1D = 4 hari).
const DIV_SENT_TTL_MS = posInt(process.env.DIV_SENT_TTL_DAYS, 7) * 86_400_000;

let users = {};
let divState = { lastClosedByTf: {}, sent: {} };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    users = parsed && typeof parsed.users === "object" && parsed.users ? parsed.users : {};
    const d = parsed && typeof parsed.divergence === "object" && parsed.divergence ? parsed.divergence : {};
    divState = {
      lastClosedByTf: d.lastClosedByTf && typeof d.lastClosedByTf === "object" ? d.lastClosedByTf : {},
      sent: d.sent && typeof d.sent === "object" ? d.sent : {},
    };
  } catch {
    users = {}; // belum ada file / rusak -> mulai kosong
    divState = { lastClosedByTf: {}, sent: {} };
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users, divergence: divState }, null, 2));
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
  if (!Array.isArray(u.divAlerts)) u.divAlerts = [];
  if (!u.nextDivId) u.nextDivId = 1;
  return u;
}

/** Hapus entri user yang sudah kosong supaya file tidak membengkak. */
function prune(jid) {
  const u = users[jid];
  if (u && !u.watch.length && !u.alerts.length && !(u.divAlerts && u.divAlerts.length) && !u.daily && !u.tf) delete users[jid];
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

// ---------- alarm divergence (!alertdivergent) ----------
const getDivAlerts = (jid) => [...user(jid).divAlerts];

const sameList = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * @returns {object|"full"|"chatFull"|"exists"} alarm yang dibuat, atau alasan penolakan:
 *   full = batas per user, chatFull = batas per chat, exists = alarm identik sudah ada.
 */
function addDivAlert(jid, sub) {
  const u = user(jid);
  if (u.divAlerts.some((a) => a.chat === sub.chat && a.coin === sub.coin && a.tf === sub.tf && sameList(a.indicators, sub.indicators) && sameList(a.dirs || [], sub.dirs || []) && sameList(a.kinds || [], sub.kinds || []))) {
    return "exists";
  }
  if (u.divAlerts.length >= MAX_DIV_ALERTS) return "full";
  if (countDivAlertsInChat(sub.chat) >= MAX_DIV_ALERTS_PER_CHAT) return "chatFull";
  const entry = { ...sub, id: `d${u.nextDivId++}`, createdAt: Date.now(), active: true };
  u.divAlerts.push(entry);
  save();
  return entry;
}

function countDivAlertsInChat(chat) {
  let n = 0;
  for (const u of Object.values(users)) for (const a of u.divAlerts || []) if (a.chat === chat) n++;
  return n;
}

/** id boleh "d12" / "D12" / "12". @returns {boolean} true kalau ada yang dihapus */
function removeDivAlert(jid, id) {
  const u = user(jid);
  const want = /^\d+$/.test(String(id)) ? `d${id}` : String(id).toLowerCase();
  const i = u.divAlerts.findIndex((a) => a.id === want);
  if (i < 0) return false;
  u.divAlerts.splice(i, 1);
  prune(jid);
  save();
  return true;
}

/** @returns {number} jumlah alarm yang dihapus */
function clearDivAlerts(jid) {
  const u = user(jid);
  const n = u.divAlerts.length;
  if (!n) return 0;
  u.divAlerts = [];
  prune(jid);
  save();
  return n;
}

/** Semua alarm aktif semua user (untuk monitor). */
function allDivAlerts() {
  const out = [];
  for (const [jid, u] of Object.entries(users)) {
    for (const a of u.divAlerts || []) if (a.active !== false) out.push({ userJid: jid, sub: a });
  }
  return out;
}

const getLastClosed = (tf) => divState.lastClosedByTf[tf] || 0;
const getLastClosedMap = () => ({ ...divState.lastClosedByTf });
function setLastClosed(tf, ms) {
  divState.lastClosedByTf[tf] = ms;
  save();
}
const hasLastClosed = (tf) => divState.lastClosedByTf[tf] != null;

const wasSent = (key) => divState.sent[key] != null;

/** Tandai terkirim lalu simpan (dipanggil SETELAH sendMessage berhasil, supaya restart tidak mengirim ulang). */
function markSent(keys, now = Date.now()) {
  for (const k of keys) divState.sent[k] = now;
  save();
}

/** Buang kunci dedupe yang lebih tua dari TTL. @returns {number} jumlah yang dibuang */
function pruneSent(now = Date.now(), ttl = DIV_SENT_TTL_MS) {
  let n = 0;
  for (const [k, at] of Object.entries(divState.sent)) {
    if (!(now - at < ttl)) {
      delete divState.sent[k];
      n++;
    }
  }
  if (n) save();
  return n;
}

const sentCount = () => Object.keys(divState.sent).length;

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
  MAX_DIV_ALERTS,
  MAX_DIV_ALERTS_PER_CHAT,
  DIV_SENT_TTL_MS,
  getWatch,
  addWatch,
  removeWatch,
  getAlerts,
  addAlert,
  findLevelAlert,
  removeAlert,
  allAlerts,
  getDivAlerts,
  addDivAlert,
  removeDivAlert,
  clearDivAlerts,
  allDivAlerts,
  countDivAlertsInChat,
  getLastClosed,
  getLastClosedMap,
  setLastClosed,
  hasLastClosed,
  wasSent,
  markSent,
  pruneSent,
  sentCount,
  getTf,
  setTf,
  getDaily,
  setDaily,
  clearDaily,
  allDaily,
  persist,
};
