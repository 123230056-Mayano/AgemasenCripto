"use strict";

/**
 * state/cryptoStore.js
 * ------------------------------------------------------------------
 * Penyimpanan watchlist, alert harga/level, ringkasan harian, dan alarm
 * divergence (Command Kripto - Bagian 5). Semuanya PER USER (jid pengirim asli),
 * jadi watchlist & alert satu orang tidak terlihat orang lain walau di grup yang sama.
 *
 * ARSITEKTUR (sama pola dengan languageStore.js / subscriptionStore.js):
 *   - Sumber kebenaran = Supabase (supabase/crypto_alerts.sql), jadi data aman
 *     walau Railway redeploy / filesystem baru.
 *   - Semua pembacaan MURNI dari memori (sinkron). Pengecekan alert harga tiap
 *     30 detik tidak menambah request ke Supabase.
 *   - Penulisan: memori diperbarui langsung (API tetap sinkron, pemanggil lama
 *     tidak perlu diubah), lalu ditulis ke Supabase "di belakang layar" dengan
 *     debounce + retry berjenjang. Perintah user yang mengubah data memanggil
 *     flushUser() supaya user diberi tahu kalau penyimpanan gagal
 *     (lihat features/kripto/syncNotice.js).
 *   - Cadangan lokal: setiap perubahan juga ditulis atomik ke
 *     data/crypto_watch.json (override CRYPTO_STATE_FILE), termasuk daftar
 *     perubahan yang BELUM terkirim ke Supabase ("pending"). Kalau Supabase
 *     gangguan lalu bot restart, perubahan itu dikirim ulang saat start.
 *   - Fail-safe: SUPABASE_URL/SUPABASE_SERVICE_KEY kosong -> perilaku lama
 *     (hanya file JSON). Supabase tidak terjangkau saat start -> bot jalan
 *     dari file cadangan, load ulang tiap 60 detik sampai berhasil.
 *   - Impor otomatis: kalau tabel Supabase masih kosong (atau file lokal masih
 *     format lama), isi crypto_watch.json lama dikirim ke Supabase satu kali.
 *     Untuk memaksa: scripts/import-crypto-to-supabase.js.
 *
 * Bentuk data (tidak berubah dari versi file JSON):
 *   users[userJid] = {
 *     watch:   ["SOL", "ETH"],
 *     nextId:  4,                         // ID alert berikutnya (per user)
 *     alerts:  [
 *       { id, chat, coin, type: "price", price, dir: "up"|"down", createdAt },
 *       { id, chat, coin, type: "level", tf, createdAt, armed: { S: true, R: true } },
 *     ],
 *     daily:   { chat, hour, minute, lastSent: "YYYY-MM-DD" | null } | null,
 *     divAlerts: [
 *       { id: "d1", chat, coin: "BTC"|"*"|"WATCHLIST", tf: "15M"|"1H"|"4H"|"1D",
 *         indicators: ["rsi","macd"], dirs: [], kinds: [], createdAt, active: true },
 *     ],
 *     nextDivId: 2,
 *     tf: "4H",
 *   }
 *
 * State global alarm divergence:
 *   divergence = {
 *     lastClosedByTf: { "4H": <ms waktu tutup candle terakhir yang sudah diproses> },
 *     sent: { "<kunci dedupe>": <ms waktu kirim> },   // dibersihkan berkala (TTL, DIV_SENT_TTL_MS)
 *   }
 *
 * Tabel Supabase (semua ber-bot_id, lihat supabase/crypto_alerts.sql):
 *   crypto_users(bot_id, jid, data jsonb)      <- users[jid]
 *   crypto_div_closed(bot_id, tf, closed_ms)   <- divergence.lastClosedByTf
 *   crypto_div_sent(bot_id, key, sent_at)      <- divergence.sent (satu baris per sinyal)
 */

const fs = require("fs");
const path = require("path");
const { BOT_STATE_DATA_DIR, BOT_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY } = require("../config/env");
const { supabaseRest } = require("./subscriptionStore");

const FILE = process.env.CRYPTO_STATE_FILE || path.join(BOT_STATE_DATA_DIR, "crypto_watch.json");

// Batas watchlist per user. Default 300 supaya !watch all muat semua koin yang didukung (hasilnya dikirim sebagai PDF,
// lihat watchPdf.js). Bisa diubah lewat env WATCH_MAX.
const MAX_WATCH = Number.isInteger(Number(process.env.WATCH_MAX)) && Number(process.env.WATCH_MAX) > 0 ? Number(process.env.WATCH_MAX) : 300;
const MAX_ALERTS = 20;

// Batas alarm divergence (usulan PDF 5.5: 10 per user). Bisa diubah lewat env.
const posInt = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
const MAX_DIV_ALERTS = posInt(process.env.DIV_ALERT_MAX_PER_USER, 10);
const MAX_DIV_ALERTS_PER_CHAT = posInt(process.env.DIV_ALERT_MAX_PER_CHAT, 20);
// Batas alarm indikator lanjutan (!alertind, item 10); angka sama dengan ADV_ALERT_CONFIG.
const { ADV_ALERT_CONFIG } = require("../config/indicatorConfig");
const MAX_ADV_ALERTS = ADV_ALERT_CONFIG.MAX_PER_USER;
const MAX_ADV_ALERTS_PER_CHAT = ADV_ALERT_CONFIG.MAX_PER_CHAT;
// Kunci dedupe harus bertahan lebih lama dari jendela deteksi ulang (LOOKBACK + 1 candle 1D = 4 hari).
const DIV_SENT_TTL_MS = posInt(process.env.DIV_SENT_TTL_DAYS, 7) * 86_400_000;

// ---------- pengaturan sinkronisasi Supabase ----------
const T_USERS = "crypto_users";
const T_CLOSED = "crypto_div_closed";
const T_SENT = "crypto_div_sent";
const PAGE = 1000; // batas default PostgREST per request
const BATCH_USERS = 100;
const BATCH_SENT = 200;
const SYNC_DEBOUNCE_MS = Number.isInteger(Number(process.env.CRYPTO_SYNC_DEBOUNCE_MS)) && Number(process.env.CRYPTO_SYNC_DEBOUNCE_MS) >= 0
  ? Number(process.env.CRYPTO_SYNC_DEBOUNCE_MS)
  : 1500;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const LOAD_RETRY_MS = 60_000;

const enabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

let users = {};
let divState = { lastClosedByTf: {}, sent: {} };

let loaded = false; // data Supabase sudah pernah berhasil dimuat/digabung
let legacyLocal = false; // file lokal belum bertanda v2 -> seluruh isinya diimpor ke Supabase

// Perubahan yang belum sampai ke Supabase. Nilai = nomor versi; kalau data berubah lagi
// saat request berjalan, versinya naik sehingga tidak ikut terhapus dari antrean.
const dirtyUsers = new Map(); // jid -> ver
const dirtyClosed = new Map(); // tf -> ver
const dirtySent = new Map(); // key -> ver
let pruneBefore = null; // hapus baris crypto_div_sent dengan sent_at < nilai ini
let ver = 0;

const snapshots = new Map(); // jid -> JSON terakhir yang sudah ditandai (untuk persist() mendeteksi perubahan)

let timer = null;
let running = null;
let failures = 0;
let started = false;

// ---------- helper ----------
const isEmpty = (u) => !u || (!u.watch?.length && !u.alerts?.length && !u.divAlerts?.length && !u.advAlerts?.length && !u.daily && !u.tf);
const snap = (jid) => (isEmpty(users[jid]) ? null : JSON.stringify(users[jid]));
const hasPending = () => dirtyUsers.size > 0 || dirtyClosed.size > 0 || dirtySent.size > 0 || pruneBefore != null;

// ---------- file lokal (cadangan + antrean pending) ----------
function loadLocal() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    users = parsed && typeof parsed.users === "object" && parsed.users ? parsed.users : {};
    const d = parsed && typeof parsed.divergence === "object" && parsed.divergence ? parsed.divergence : {};
    divState = {
      lastClosedByTf: d.lastClosedByTf && typeof d.lastClosedByTf === "object" ? d.lastClosedByTf : {},
      sent: d.sent && typeof d.sent === "object" ? d.sent : {},
    };
    legacyLocal = !(parsed && parsed.v === 2);
    const p = parsed && typeof parsed.pending === "object" && parsed.pending ? parsed.pending : {};
    for (const j of Array.isArray(p.users) ? p.users : []) dirtyUsers.set(j, ++ver);
    for (const k of Array.isArray(p.closed) ? p.closed : []) dirtyClosed.set(k, ++ver);
    for (const k of Array.isArray(p.sent) ? p.sent : []) dirtySent.set(k, ++ver);
    if (Number.isFinite(p.pruneBefore)) pruneBefore = p.pruneBefore;
  } catch {
    users = {}; // belum ada file / rusak -> mulai kosong
    divState = { lastClosedByTf: {}, sent: {} };
    legacyLocal = false;
  }
  snapshots.clear();
  for (const jid of Object.keys(users)) snapshots.set(jid, snap(jid));
}

function saveLocal() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    const body = {
      v: legacyLocal ? 1 : 2, // 1 = belum pernah digabung dengan Supabase (diimpor saat start)
      users,
      divergence: divState,
      pending: { users: [...dirtyUsers.keys()], closed: [...dirtyClosed.keys()], sent: [...dirtySent.keys()], pruneBefore },
    };
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.log("[kripto] gagal menyimpan crypto_watch.json:", err.message);
  }
}

// ---------- antrean tulis ke Supabase ----------
function scheduleFlush(ms = SYNC_DEBOUNCE_MS) {
  if (!enabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flush().catch(() => {});
  }, ms);
  timer.unref?.();
}

/** Tandai satu user berubah (tulis/hapus baris di crypto_users). */
function touch(jid) {
  dirtyUsers.set(jid, ++ver);
  snapshots.set(jid, snap(jid));
}

/** Simpan lokal sekarang + jadwalkan kirim ke Supabase. */
function commit() {
  saveLocal();
  scheduleFlush();
}

async function fetchAll(table, select, order) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await supabaseRest(
      `${table}?select=${select}&bot_id=eq.${encodeURIComponent(BOT_ID)}&order=${order}&limit=${PAGE}&offset=${offset}`,
    );
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/**
 * Muat dari Supabase dan gabungkan dengan state lokal.
 *  - Supabase = sumber kebenaran.
 *  - Perubahan lokal yang masih pending MENANG (belum sempat terkirim).
 *  - File lokal format lama, atau Supabase masih kosong -> isi lokal dikirim (impor).
 */
async function loadRemote() {
  const [ru, rc, rs] = await Promise.all([
    fetchAll(T_USERS, "jid,data", "jid.asc"),
    fetchAll(T_CLOSED, "tf,closed_ms", "tf.asc"),
    fetchAll(T_SENT, "key,sent_at", "key.asc"),
  ]);
  const now = Date.now();
  const seed = legacyLocal || (!ru.length && !rc.length && !rs.length);

  // users
  const remoteUsers = new Map(ru.filter((r) => r.data && typeof r.data === "object").map((r) => [r.jid, r.data]));
  const nextUsers = {};
  for (const [jid, data] of remoteUsers) if (!dirtyUsers.has(jid)) nextUsers[jid] = data;
  for (const jid of dirtyUsers.keys()) if (users[jid] && !isEmpty(users[jid])) nextUsers[jid] = users[jid];
  if (seed) {
    for (const jid of Object.keys(users)) {
      if (!remoteUsers.has(jid) && !(jid in nextUsers) && !isEmpty(users[jid])) {
        nextUsers[jid] = users[jid];
        dirtyUsers.set(jid, ++ver);
      }
    }
  }

  // candle closed terakhir per timeframe
  const nextClosed = {};
  for (const r of rc) nextClosed[r.tf] = Number(r.closed_ms);
  for (const tf of dirtyClosed.keys()) if (divState.lastClosedByTf[tf] != null) nextClosed[tf] = divState.lastClosedByTf[tf];
  if (seed) {
    for (const [tf, ms] of Object.entries(divState.lastClosedByTf)) {
      if (!(tf in nextClosed)) {
        nextClosed[tf] = ms;
        dirtyClosed.set(tf, ++ver);
      }
    }
  }

  // kunci dedupe (yang lewat TTL tidak dipakai & dibuang dari Supabase)
  const nextSent = {};
  let expiredRemote = false;
  for (const r of rs) {
    const at = Number(r.sent_at);
    if (now - at < DIV_SENT_TTL_MS) nextSent[r.key] = at;
    else expiredRemote = true;
  }
  for (const k of dirtySent.keys()) if (divState.sent[k] != null) nextSent[k] = divState.sent[k];
  if (seed) {
    const remoteKeys = new Set(rs.map((r) => r.key));
    for (const [k, at] of Object.entries(divState.sent)) {
      if (!remoteKeys.has(k) && !(k in nextSent) && now - at < DIV_SENT_TTL_MS) {
        nextSent[k] = at;
        dirtySent.set(k, ++ver);
      }
    }
  }
  if (expiredRemote) pruneBefore = Math.max(pruneBefore ?? 0, now - DIV_SENT_TTL_MS);

  users = nextUsers;
  divState = { lastClosedByTf: nextClosed, sent: nextSent };
  snapshots.clear();
  for (const jid of Object.keys(users)) snapshots.set(jid, snap(jid));
  loaded = true;
  legacyLocal = false;
  saveLocal();
  return { users: Object.keys(users).length, closed: Object.keys(nextClosed).length, sent: Object.keys(nextSent).length, seeded: seed };
}

async function doFlush() {
  if (!loaded) await loadRemote();
  const nowIso = new Date().toISOString();
  const bot = encodeURIComponent(BOT_ID);

  // users: upsert yang masih berisi, hapus yang sudah kosong
  const ups = [];
  const dels = [];
  for (const [jid, v] of dirtyUsers) {
    if (!isEmpty(users[jid])) ups.push([jid, v]);
    else dels.push([jid, v]);
  }
  for (let i = 0; i < ups.length; i += BATCH_USERS) {
    const part = ups.slice(i, i + BATCH_USERS);
    await supabaseRest(`${T_USERS}?on_conflict=bot_id,jid`, {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: part.map(([jid]) => ({ bot_id: BOT_ID, jid, data: users[jid], updated_at: nowIso })),
    });
    for (const [jid, v] of part) if (dirtyUsers.get(jid) === v) dirtyUsers.delete(jid);
  }
  for (const [jid, v] of dels) {
    await supabaseRest(`${T_USERS}?bot_id=eq.${bot}&jid=eq.${encodeURIComponent(jid)}`, { method: "DELETE", prefer: "return=minimal" });
    if (dirtyUsers.get(jid) === v) dirtyUsers.delete(jid);
  }

  // candle closed terakhir
  if (dirtyClosed.size) {
    const part = [...dirtyClosed].filter(([tf]) => divState.lastClosedByTf[tf] != null);
    if (part.length) {
      await supabaseRest(`${T_CLOSED}?on_conflict=bot_id,tf`, {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: part.map(([tf]) => ({ bot_id: BOT_ID, tf, closed_ms: divState.lastClosedByTf[tf] })),
      });
    }
    for (const [tf, v] of [...dirtyClosed]) if (dirtyClosed.get(tf) === v) dirtyClosed.delete(tf);
  }

  // dedupe: satu baris per sinyal, insert saja (tidak menimpa yang sudah ada)
  if (dirtySent.size) {
    const all = [...dirtySent];
    const live = all.filter(([k]) => divState.sent[k] != null);
    for (let i = 0; i < live.length; i += BATCH_SENT) {
      const part = live.slice(i, i + BATCH_SENT);
      await supabaseRest(`${T_SENT}?on_conflict=bot_id,key`, {
        method: "POST",
        prefer: "resolution=ignore-duplicates,return=minimal",
        body: part.map(([key]) => ({ bot_id: BOT_ID, key, sent_at: divState.sent[key] })),
      });
    }
    for (const [k, v] of all) if (dirtySent.get(k) === v) dirtySent.delete(k);
  }

  // pembersihan berkala (TTL)
  if (pruneBefore != null) {
    const cut = pruneBefore;
    await supabaseRest(`${T_SENT}?bot_id=eq.${bot}&sent_at=lt.${cut}`, { method: "DELETE", prefer: "return=minimal" });
    if (pruneBefore === cut) pruneBefore = null;
  }
  saveLocal(); // antrean pending lokal ikut mengecil
}

/**
 * Kirim semua perubahan pending ke Supabase sekarang.
 * @returns {Promise<boolean>} true kalau semuanya tersimpan (atau Supabase tidak dipakai).
 */
async function flush() {
  if (!enabled) return true;
  while (running) await running.catch(() => {});
  if (loaded && !hasPending()) return true;
  running = (async () => {
    try {
      await doFlush();
      failures = 0;
      return true;
    } catch (err) {
      failures++;
      const wait = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      console.log(`[kripto] gagal menyimpan ke Supabase (${err.message}); coba lagi ${Math.round(wait / 1000)} dtk`);
      scheduleFlush(wait);
      return false;
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Tunggu perubahan milik satu user sampai tersimpan di Supabase.
 * @returns {Promise<boolean>} false kalau gagal (perubahan tetap aman di memori + file lokal, dicoba ulang otomatis).
 */
async function flushUser(jid) {
  if (!enabled) return true;
  await flush();
  return !dirtyUsers.has(jid);
}

/** Paksa kirim SEMUA data lokal ke Supabase (menimpa baris yang sama). Dipakai skrip impor. */
async function pushAll() {
  for (const jid of Object.keys(users)) if (!isEmpty(users[jid])) dirtyUsers.set(jid, ++ver);
  for (const tf of Object.keys(divState.lastClosedByTf)) dirtyClosed.set(tf, ++ver);
  for (const k of Object.keys(divState.sent)) dirtySent.set(k, ++ver);
  saveLocal();
  return flush();
}

const isCryptoStoreEnabled = () => enabled;
const syncStatus = () => ({
  enabled,
  loaded,
  pending: dirtyUsers.size + dirtyClosed.size + dirtySent.size + (pruneBefore != null ? 1 : 0),
});

/**
 * Dipanggil connection.js tiap socket dibuat (idempotent). Memuat dari Supabase; kalau gagal,
 * bot tetap jalan dari file cadangan dan mencoba lagi tiap 60 detik.
 */
function initCryptoStore() {
  if (started) return;
  started = true;
  if (!enabled) {
    console.log("[kripto] SUPABASE_URL/SUPABASE_SERVICE_KEY kosong, alert hanya disimpan di file JSON lokal.");
    return;
  }
  const attempt = () =>
    loadRemote()
      .then((r) => {
        console.log(
          `[kripto] Supabase aktif untuk bot "${BOT_ID}": ${r.users} user, ${r.closed} timeframe, ${r.sent} kunci dedupe dimuat` +
            (r.seeded ? " (data lokal lama diimpor)" : "") +
            ".",
        );
        if (hasPending()) scheduleFlush(0);
      })
      .catch((e) => {
        console.log(`[kripto] gagal memuat dari Supabase (${e.message}); pakai file cadangan, coba lagi 60 dtk.`);
        const t = setTimeout(attempt, LOAD_RETRY_MS);
        t.unref?.();
      });
  attempt();
}

function user(jid) {
  if (!users[jid]) users[jid] = { watch: [], nextId: 1, alerts: [], daily: null };
  const u = users[jid];
  if (!Array.isArray(u.watch)) u.watch = [];
  if (!Array.isArray(u.alerts)) u.alerts = [];
  if (!u.nextId) u.nextId = 1;
  if (!Array.isArray(u.divAlerts)) u.divAlerts = [];
  if (!u.nextDivId) u.nextDivId = 1;
  if (!Array.isArray(u.advAlerts)) u.advAlerts = [];
  if (!u.nextAdvId) u.nextAdvId = 1;
  return u;
}

/** Hapus entri user yang sudah kosong supaya data tidak membengkak. */
function prune(jid) {
  const u = users[jid];
  if (u && isEmpty(u)) delete users[jid];
}

/** Simpan perubahan satu user (pengganti save() lama). */
function save(jid) {
  touch(jid);
  commit();
}

// ---------- watchlist ----------
const getWatch = (jid) => [...user(jid).watch];

/** @returns {"added"|"exists"|"full"} */
function addWatch(jid, coin) {
  const u = user(jid);
  if (u.watch.includes(coin)) return "exists";
  if (u.watch.length >= MAX_WATCH) return "full";
  u.watch.push(coin);
  save(jid);
  return "added";
}

/**
 * Tambah banyak koin sekaligus dengan satu kali simpan. MAX_WATCH dicek sebelum menyimpan:
 * koin yang masih muat ditambahkan (urut sesuai input), sisanya dilaporkan, tidak dibuang diam-diam.
 * @param {string[]} coins ticker huruf besar (duplikat dalam input diabaikan)
 * @returns {{added:string[], exists:string[], full:string[]}}
 */
function addWatchMany(jid, coins) {
  const u = user(jid);
  const out = { added: [], exists: [], full: [] };
  const seen = new Set();
  for (const coin of coins) {
    if (seen.has(coin)) continue;
    seen.add(coin);
    if (u.watch.includes(coin)) out.exists.push(coin);
    else if (u.watch.length >= MAX_WATCH) out.full.push(coin);
    else {
      u.watch.push(coin);
      out.added.push(coin);
    }
  }
  if (out.added.length) save(jid);
  return out;
}

/** @returns {boolean} true kalau ada yang dihapus */
function removeWatch(jid, coin) {
  const u = user(jid);
  const i = u.watch.indexOf(coin);
  if (i < 0) return false;
  u.watch.splice(i, 1);
  prune(jid);
  save(jid);
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
  save(jid);
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
  save(jid);
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
  save(jid);
}

function clearDaily(jid) {
  const u = user(jid);
  if (!u.daily) return false;
  u.daily = null;
  prune(jid);
  save(jid);
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
  save(jid);
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
  save(jid);
  return true;
}

/** @returns {number} jumlah alarm yang dihapus */
function clearDivAlerts(jid) {
  const u = user(jid);
  const n = u.divAlerts.length;
  if (!n) return 0;
  u.divAlerts = [];
  prune(jid);
  save(jid);
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

// ---------- alarm indikator lanjutan (!alertind, item 10) ----------
/**
 * advAlerts: [{ id: "a1", chat, coin: "BTC"|"WATCHLIST", tf, types: ["bias","cross"], mode: "closed"|"live",
 *               createdAt, active: true, state: { BTC: { bias: "bull"|"flat"|"bear"|null } } }]
 * `state` = bias terakhir yang sudah DIUMUMKAN / di-baseline per koin (supaya restart tidak mengirim ulang).
 * Penanda cross memakai kunci dedupe yang sama dengan divergence (wasSent / markSent).
 */
const getAdvAlerts = (jid) => [...user(jid).advAlerts];

/** @returns {object|"full"|"chatFull"|"exists"} */
function addAdvAlert(jid, sub) {
  const u = user(jid);
  if (u.advAlerts.some((a) => a.chat === sub.chat && a.coin === sub.coin && a.tf === sub.tf && a.mode === sub.mode && sameList(a.types, sub.types))) {
    return "exists";
  }
  if (u.advAlerts.length >= MAX_ADV_ALERTS) return "full";
  if (countAdvAlertsInChat(sub.chat) >= MAX_ADV_ALERTS_PER_CHAT) return "chatFull";
  const entry = { ...sub, id: `a${u.nextAdvId++}`, createdAt: Date.now(), active: true, state: {} };
  u.advAlerts.push(entry);
  save(jid);
  return entry;
}

function countAdvAlertsInChat(chat) {
  let n = 0;
  for (const u of Object.values(users)) for (const a of u.advAlerts || []) if (a.chat === chat) n++;
  return n;
}

/** id boleh "a3" / "A3" / "3". @returns {boolean} */
function removeAdvAlert(jid, id) {
  const u = user(jid);
  const want = /^\d+$/.test(String(id)) ? `a${id}` : String(id).toLowerCase();
  const i = u.advAlerts.findIndex((a) => a.id === want);
  if (i < 0) return false;
  u.advAlerts.splice(i, 1);
  prune(jid);
  save(jid);
  return true;
}

/** @returns {number} jumlah alarm yang dihapus */
function clearAdvAlerts(jid) {
  const u = user(jid);
  const n = u.advAlerts.length;
  if (!n) return 0;
  u.advAlerts = [];
  prune(jid);
  save(jid);
  return n;
}

/** Semua alarm indikator aktif semua user (untuk monitor). */
function allAdvAlerts() {
  const out = [];
  for (const [jid, u] of Object.entries(users)) {
    for (const a of u.advAlerts || []) if (a.active !== false) out.push({ userJid: jid, sub: a });
  }
  return out;
}

const getLastClosed = (tf) => divState.lastClosedByTf[tf] || 0;
const getLastClosedMap = () => ({ ...divState.lastClosedByTf });
function setLastClosed(tf, ms) {
  divState.lastClosedByTf[tf] = ms;
  dirtyClosed.set(tf, ++ver);
  commit();
}
const hasLastClosed = (tf) => divState.lastClosedByTf[tf] != null;

const wasSent = (key) => divState.sent[key] != null;

/** Tandai terkirim lalu simpan (dipanggil SETELAH sendMessage berhasil, supaya restart tidak mengirim ulang). */
function markSent(keys, now = Date.now()) {
  for (const k of keys) {
    divState.sent[k] = now;
    dirtySent.set(k, ++ver);
  }
  commit();
}

/** Buang kunci dedupe yang lebih tua dari TTL. @returns {number} jumlah yang dibuang */
function pruneSent(now = Date.now(), ttl = DIV_SENT_TTL_MS) {
  let n = 0;
  for (const [k, at] of Object.entries(divState.sent)) {
    if (!(now - at < ttl)) {
      delete divState.sent[k];
      dirtySent.delete(k);
      n++;
    }
  }
  if (n) {
    pruneBefore = Math.max(pruneBefore ?? 0, now - ttl);
    commit();
  }
  return n;
}

const sentCount = () => Object.keys(divState.sent).length;

// ---------- timeframe default (!tf) ----------
/** @returns {string|null} timeframe tersimpan ("15M"|"1H"|"4H"|"1D") atau null. */
const getTf = (jid) => users[jid]?.tf || null;

function setTf(jid, tf) {
  user(jid).tf = tf;
  save(jid);
}

/**
 * Dipanggil setelah mengubah field alert/daily secara langsung (mis. lastSent, armed, fired).
 * Mendeteksi user mana yang berubah dengan membandingkan isinya dengan yang terakhir disimpan.
 */
function persist() {
  let changed = false;
  for (const jid of new Set([...Object.keys(users), ...snapshots.keys()])) {
    if (snap(jid) !== (snapshots.get(jid) ?? null)) {
      touch(jid);
      changed = true;
    }
  }
  if (changed) commit();
}

loadLocal();

module.exports = {
  MAX_WATCH,
  addWatchMany,
  MAX_ALERTS,
  MAX_DIV_ALERTS,
  MAX_DIV_ALERTS_PER_CHAT,
  MAX_ADV_ALERTS,
  MAX_ADV_ALERTS_PER_CHAT,
  DIV_SENT_TTL_MS,
  initCryptoStore,
  isCryptoStoreEnabled,
  syncStatus,
  flush,
  flushUser,
  pushAll,
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
  getAdvAlerts,
  addAdvAlert,
  removeAdvAlert,
  clearAdvAlerts,
  allAdvAlerts,
  countAdvAlertsInChat,
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