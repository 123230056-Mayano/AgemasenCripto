"use strict";

/**
 * features/forex/forexNewsStore.js
 * ------------------------------------------------------------------
 * Penyimpanan persisten untuk alert berita forex (file JSON, default data/forex_news.json,
 * override FXNEWS_STATE_FILE). Isinya:
 *   - seen   : kunci berita/pengingat yang SUDAH diproses -> waktu (dedupe, tahan restart)
 *   - recent : judul ternormalisasi terbaru (dedupe judul yang sama dari sumber berbeda)
 *   - subs   : chat yang berlangganan alert { news, cal, impact, by, at }
 *   - baselined : true setelah siklus pertama (berita yang sudah ada saat pertama jalan TIDAK dikirim)
 *
 * Penulisan atomik (tulis ke .tmp lalu rename) dan di-debounce. Di Railway, arahkan DATA_DIR ke Volume
 * supaya file ini selamat dari redeploy; kalau hilang, filter umur berita (FXNEWS_MAX_AGE_MIN) tetap
 * mencegah banjir pesan lama.
 */

const fs = require("fs");
const path = require("path");
const { BOT_STATE_DATA_DIR } = require("../../config/env");

const FILE = process.env.FXNEWS_STATE_FILE || path.join(BOT_STATE_DATA_DIR, "forex_news.json");
const SEEN_TTL_MS = 3 * 86_400_000;
const SEEN_MAX = 5000;
const RECENT_MAX = 300;
const SAVE_DEBOUNCE_MS = 1500;

const blank = () => ({ v: 1, baselined: false, seen: {}, recent: [], subs: {} });
let data = blank();
let saveTimer = null;
let dirty = false;

function load() {
  data = blank();
  try {
    const p = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (p && typeof p === "object") {
      if (p.seen && typeof p.seen === "object") data.seen = p.seen;
      if (Array.isArray(p.recent)) data.recent = p.recent.filter((r) => r && typeof r.n === "string");
      if (p.subs && typeof p.subs === "object") data.subs = p.subs;
      data.baselined = !!p.baselined;
    }
  } catch {
    /* belum ada file / rusak: mulai kosong */
  }
}

function flushSync() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
    dirty = false;
  } catch (err) {
    console.log("[fxnews] gagal menyimpan state:", err.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flushSync, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

function prune(now) {
  const keys = Object.keys(data.seen);
  if (keys.length <= SEEN_MAX) return;
  for (const k of keys) if (now - data.seen[k] > SEEN_TTL_MS) delete data.seen[k];
  const left = Object.keys(data.seen);
  if (left.length > SEEN_MAX) {
    left.sort((a, b) => data.seen[a] - data.seen[b]);
    for (const k of left.slice(0, left.length - SEEN_MAX)) delete data.seen[k];
  }
}

// ---- seen / recent ----
const hasSeen = (key) => Object.prototype.hasOwnProperty.call(data.seen, key);

function markSeen(key, now = Date.now()) {
  data.seen[key] = now;
  prune(now);
  scheduleSave();
}

const recentTitles = () => data.recent;

function addRecent(norm, ts) {
  if (!norm) return;
  data.recent.push({ n: norm, ts });
  if (data.recent.length > RECENT_MAX) data.recent.splice(0, data.recent.length - RECENT_MAX);
  scheduleSave();
}

const isBaselined = () => data.baselined;
function setBaselined() {
  data.baselined = true;
  scheduleSave();
}

// ---- langganan ----
const DEFAULT_SUB = { news: true, cal: true, impact: "high" };

function setSub(chat, opts = {}) {
  const prev = data.subs[chat] || {};
  data.subs[chat] = { ...DEFAULT_SUB, ...prev, ...opts, at: prev.at || Date.now() };
  scheduleSave();
  return data.subs[chat];
}

function removeSub(chat) {
  const had = !!data.subs[chat];
  delete data.subs[chat];
  if (had) scheduleSave();
  return had;
}

const getSub = (chat) => data.subs[chat] || null;
const listSubs = () => Object.entries(data.subs).map(([chat, s]) => ({ chat, ...s }));

function _reset() {
  data = blank();
  dirty = false;
  clearTimeout(saveTimer);
  saveTimer = null;
}

load();
process.once("exit", flushSync);

module.exports = { FILE, hasSeen, markSeen, recentTitles, addRecent, isBaselined, setBaselined, setSub, removeSub, getSub, listSubs, flushSync, load, _reset };
