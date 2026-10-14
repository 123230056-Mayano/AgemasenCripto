// Statistik + endpoint GET /stats untuk dashboard web (Vercel).
//
// Yang dikirim ke dashboard:
//   - command per hari / terpopuler        (Postgres, tabel command_log)
//   - daftar grup + jumlah anggota + status (live dari WhatsApp)
//   - daftar user yang pernah PC bot        (dari state/userState.js)
//   - command hari ini per grup / per user  (Postgres, WIB)
//   - foto profil (PP) grup & user          (WhatsApp, di-cache)
//   - GET /group?id=  & GET /user?number=   detail satu grup / satu user
//   - POST /toggle {type,id,enabled}        aktif/nonaktifkan bot per grup / user
//   - POST /subscription {type,id,action,days}  atur langganan (add|set|expire)
//   - GET /qr  status koneksi + QR login terbaru (untuk scan lewat web)
//   - POST /session {action}  action: "restart" (sambung ulang) | "reset" (hapus sesi & minta QR baru)
//   - POST /language {type,id,lang}  atur bahasa bot (id|en|default) per grup / user
//     datanya di Supabase (lihat state/subscriptionStore.js)
//
// MULTI-BOT: tiap server bot punya STATS_TOKEN + URL sendiri. Web (dashboard)
// memanggil semuanya, lalu menandai tiap baris dengan botId. Semua respons di
// sini menyertakan botId/botLabel/botNumber, dan request tulis (/toggle,
// /subscription) yang membawa botId milik bot LAIN ditolak (409) supaya salah
// routing di web tidak pernah mematikan/memperpanjang grup di bot yang salah.
//
// Env: BOT_ID, BOT_LABEL (identitas bot), STATS_TOKEN (wajib), PORT (otomatis dari Railway), SUPABASE_URL + SUPABASE_SERVICE_KEY
// (opsional, backup command_log ke Supabase), DATABASE_URL (opsional,
// tanpa ini grafik command kosong tapi grup & user tetap tampil).
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const { Pool } = require("pg");
const { BOT_ID, BOT_LABEL, SUPABASE_URL, SUPABASE_SERVICE_KEY } = require("../../config/env");
const { isBotDisabledFor, disableGroup, enableGroup } = require("../../state/botState");
const { getKnownUsers, isUserDisabled, disableUser, enableUser } = require("../../state/userState");
const { getCachedName } = require("../../state/nameCache");
const { getSession } = require("../../state/sessionState");
const { DEFAULT_LANG, SUPPORTED_LANGS, isSupportedLang } = require("../../i18n");
const {
  isLanguageStoreEnabled,
  getLang,
  hasExplicitLang,
  setLang,
  clearLang,
} = require("../../state/languageStore");
const {
  MAX_DAYS,
  isSubscriptionEnabled,
  getSubInfo,
  addDays,
  setDays,
  expireNow,
} = require("../../state/subscriptionStore");

// Pool UTAMA (Railway): dipakai untuk menulis DAN membaca (dashboard /stats).
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

// BACKUP (Supabase): hanya ditulis (dual-write), tidak pernah dibaca
// dashboard. Lewat REST (PostgREST) memakai SUPABASE_URL &
// SUPABASE_SERVICE_KEY yang SUDAH dipakai fitur langganan -- tidak butuh
// env var baru, SSL, atau pooler. Kalau salah satunya kosong, backup mati
// dan perilakunya sama persis seperti sebelumnya.
// Tabelnya harus dibuat manual sekali: jalankan supabase/command_log.sql
// di SQL Editor Supabase (REST tidak bisa CREATE TABLE).
const backupEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const BACKUP_TABLE = "command_log";

// Listener wajib: tanpa ini, koneksi idle yang putus bisa bikin proses crash.
if (pool) pool.on("error", (e) => console.log("[stats] db utama idle error:", e.message));

async function backupRest(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Supabase ${res.status}: ${detail}`);
  }
}
const STARTED = Date.now();
let sockRef = null;
let serverStarted = false;

function setSocket(sock) { sockRef = sock; }

// Nomor WA yang sedang dipakai bot ini (tanpa suffix device / domain).
function botNumber() {
  const id = String(sockRef?.user?.id || "");
  return id ? id.split(":")[0].split("@")[0] : null;
}
const botIdentity = () => ({ botId: BOT_ID, botLabel: BOT_LABEL, botNumber: botNumber() });

// CPU: dihitung dari selisih pemakaian tiap 5 detik (persen dari 1 core).
let cpuPct = 0, lastCpu = process.cpuUsage(), lastT = process.hrtime.bigint();
setInterval(() => {
  const cur = process.cpuUsage(), now = process.hrtime.bigint();
  const usedUs = (cur.user - lastCpu.user) + (cur.system - lastCpu.system);
  cpuPct = (100 * usedUs) / (Number(now - lastT) / 1000);
  lastCpu = cur; lastT = now;
}, 5000).unref();

function systemStats() {
  const m = process.memoryUsage();
  return {
    cpuPercent: Math.round(cpuPct * 10) / 10,
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    arch: process.arch,
  };
}

async function init() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS command_log(
      id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), command text,
      chat_id text, is_group boolean, ok boolean DEFAULT true, ms int DEFAULT 0)`);
    // MULTI-BOT: baris lama otomatis dianggap milik bot ini (BOT_ID sudah
    // disaring ke [a-z0-9_-], aman dipakai di DEFAULT).
    await pool.query(`ALTER TABLE command_log ADD COLUMN IF NOT EXISTS bot_id text DEFAULT '${BOT_ID}'`);
    await pool.query("CREATE INDEX IF NOT EXISTS command_log_ts ON command_log(ts)");
    await pool.query("CREATE INDEX IF NOT EXISTS command_log_bot_ts ON command_log(bot_id, ts)");
  } else {
    console.log("[stats] DATABASE_URL kosong, grafik command nonaktif.");
  }
  // Cek tabel backup ada. Gagal di sini TIDAK mematikan stats utama.
  if (backupEnabled) {
    await backupRest(`${BACKUP_TABLE}?select=id&limit=1`)
      .then(() => console.log("[stats] backup Supabase aktif (dual-write)."))
      .catch((e) => console.log(
        "[stats] backup Supabase belum siap -- sudah jalankan supabase/command_log.sql? ->", e.message));
  }
}

// Log error backup dibatasi 1x/menit supaya log tidak banjir kalau Supabase down.
let lastBackupErrAt = 0;
function reportBackupError(err) {
  const now = Date.now();
  if (now - lastBackupErrAt < 60_000) return;
  lastBackupErrAt = now;
  console.log("[stats] insert backup gagal:", err.message);
}

// Fire-and-forget: tidak pernah mengganggu command.
// Dual-write: Railway (utama, via pg) + Supabase (backup, via REST),
// dikirim paralel. ts dibuat SEKALI di sini lalu dipakai kedua insert,
// jadi baris yang sama punya timestamp identik di kedua database.
function logCommand({ command, jid }) {
  const ts = new Date();
  const cmd = String(command).slice(0, 40);
  const chatId = String(jid);
  const isGroup = chatId.endsWith("@g.us");

  if (pool) {
    pool.query(
      "INSERT INTO command_log(ts,command,chat_id,is_group,bot_id) VALUES($1,$2,$3,$4,$5)",
      [ts, cmd, chatId, isGroup, BOT_ID],
    ).catch(() => {});
  }
  if (backupEnabled) {
    backupRest(BACKUP_TABLE, {
      method: "POST",
      prefer: "return=minimal",
      body: { ts: ts.toISOString(), command: cmd, chat_id: chatId, is_group: isGroup, bot_id: BOT_ID },
    }).catch(reportBackupError);
  }
}

// ---------------------------------------------------------------
// Foto profil (PP). URL-nya dari WhatsApp, jadi:
//  - TIDAK diambil saat request dashboard (bisa ratusan jid sekaligus =
//    pola mirip spam ke server WA). Diambil pelan-pelan lewat antrean:
//    satu per satu, jeda 400 ms.
//  - di-cache 6 jam (1 jam kalau kosong / gagal). Nilai null = tidak ada PP,
//    web akan menampilkan inisial.
// ---------------------------------------------------------------
const PP_TTL_OK = 6 * 3600e3;
const PP_TTL_NONE = 3600e3;
const ppCache = new Map();   // jid -> { url, at }
const ppQueued = new Set();
const ppQueue = [];
let ppRunning = false;

async function runPPQueue() {
  if (ppRunning) return;
  ppRunning = true;
  while (ppQueue.length) {
    const jid = ppQueue.shift();
    ppQueued.delete(jid);
    let url = null;
    try {
      if (sockRef) url = (await sockRef.profilePictureUrl(jid, "preview")) || null;
    } catch { /* tidak ada PP / privasi -> null */ }
    ppCache.set(jid, { url, at: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
  }
  ppRunning = false;
}

// Balikkan URL dari cache (atau null) dan jadwalkan pengambilan kalau perlu.
function getPP(jid) {
  const c = ppCache.get(jid);
  const ttl = c && c.url ? PP_TTL_OK : PP_TTL_NONE;
  if ((!c || Date.now() - c.at > ttl) && !ppQueued.has(jid) && sockRef) {
    ppQueued.add(jid);
    ppQueue.push(jid);
    runPPQueue();
  }
  return c ? c.url : null;
}

// Cache 60 detik supaya refresh dashboard tidak membanjiri server WhatsApp.
let groupCache = { at: 0, data: [] };
async function fetchGroups() {
  if (Date.now() - groupCache.at < 60000) return groupCache.data;
  if (!sockRef) return groupCache.data;
  try {
    const all = await sockRef.groupFetchAllParticipating();
    groupCache = {
      at: Date.now(),
      data: Object.values(all || {}).map((g) => ({
        id: g.id,
        name: g.subject || "(tanpa nama)",
        members: (g.participants || []).length,
        created: g.creation ? g.creation * 1000 : null,
      })),
    };
  } catch (e) {
    console.log("[stats] gagal ambil grup:", e.message);
  }
  return groupCache.data;
}

function listUsers(perChat = {}) {
  return [...getKnownUsers().entries()]
    .map(([jid, u]) => ({
      number: jid.split("@")[0],
      name: u.name || null,
      count: u.count || 0,
      firstSeen: u.firstSeen,
      lastSeen: u.lastSeen,
      blocked: isUserDisabled(jid),
      cmdToday: perChat[jid]?.today || 0,
      pp: getPP(jid),
      sub: getSubInfo("user", jid),
    }))
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

// "Hari ini" = hari kalender WIB (Asia/Jakarta), bukan 24 jam terakhir.
const TODAY_WIB = "(ts AT TIME ZONE 'Asia/Jakarta')::date = (now() AT TIME ZONE 'Asia/Jakarta')::date";

async function commandStats() {
  if (!pool) return { today: 0, week: 0, top: [], daily: [], perChat: {} };
  const W = "WHERE bot_id = $1 AND ts > now() - interval '7 days'";
  const B = [BOT_ID];
  const [t, top, daily, pc] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE ${TODAY_WIB})::int today, count(*)::int week FROM command_log ${W}`, B),
    pool.query(`SELECT command, count(*)::int n FROM command_log ${W} GROUP BY 1 ORDER BY n DESC LIMIT 10`, B),
    pool.query(`SELECT to_char((ts AT TIME ZONE 'Asia/Jakarta')::date,'DD/MM') d, count(*)::int n
      FROM command_log WHERE bot_id = $1 AND ts > now() - interval '14 days'
      GROUP BY (ts AT TIME ZONE 'Asia/Jakarta')::date, 1 ORDER BY (ts AT TIME ZONE 'Asia/Jakarta')::date`, B),
    // Per chat (grup maupun PC): hari ini + 7 hari. chat_id grup = jid grup,
    // chat_id PC = jid user, jadi satu query cukup untuk keduanya.
    pool.query(`SELECT chat_id, count(*) FILTER (WHERE ${TODAY_WIB})::int today, count(*)::int week
      FROM command_log ${W} GROUP BY 1`, B),
  ]);
  return {
    ...t.rows[0], top: top.rows, daily: daily.rows,
    perChat: Object.fromEntries(pc.rows.map((r) => [r.chat_id, { today: r.today, week: r.week }])),
  };
}

async function buildStats() {
  const [cmd, groups] = await Promise.all([commandStats(), fetchGroups()]);
  const { perChat, ...rest } = cmd;
  const users = listUsers(perChat);
  return {
    ...rest,
    ...botIdentity(),
    botOnline: !!sockRef?.user,
    subscriptionEnabled: isSubscriptionEnabled(),
    uptimeSec: Math.round((Date.now() - STARTED) / 1000),
    system: systemStats(),
    totalMembers: groups.reduce((s, g) => s + g.members, 0),
    groups: groups
      .map((g) => ({
        ...g,
        disabled: isBotDisabledFor(g.id),
        cmd7: perChat[g.id]?.week || 0,
        cmdToday: perChat[g.id]?.today || 0,
        pp: getPP(g.id),
        sub: getSubInfo("group", g.id),
      }))
      .sort((a, b) => b.members - a.members),
    users,
  };
}

// ---------------------------------------------------------------
// Detail satu grup / satu user (dipanggil saat baris di dashboard diklik).
// ---------------------------------------------------------------
const nameOf = (jid) => getCachedName(jid) || null;
const numberOf = (p) => {
  const pn = p.phoneNumber || (String(p.id).endsWith("@s.whatsapp.net") ? p.id : null);
  return pn ? String(pn).split("@")[0] : null;
};

// Ringkasan command satu chat (grup atau PC) dari command_log.
async function chatCommandStats(chatId) {
  const empty = { today: 0, week: 0, total: 0, last: null, top: [] };
  if (!pool) return empty;
  const [sum, top] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE ${TODAY_WIB})::int today,
              count(*) FILTER (WHERE ts > now() - interval '7 days')::int week,
              count(*)::int total, max(ts) last
       FROM command_log WHERE chat_id=$1 AND bot_id=$2`, [chatId, BOT_ID]),
    pool.query(
      `SELECT command, count(*)::int n FROM command_log
       WHERE chat_id=$1 AND bot_id=$2 AND ts > now() - interval '7 days'
       GROUP BY 1 ORDER BY n DESC LIMIT 5`, [chatId, BOT_ID]),
  ]);
  return { ...sum.rows[0], top: top.rows };
}

// Bahasa bot untuk satu chat: yang sedang berlaku + apakah diatur sendiri
// (explicit) atau masih bawaan (DEFAULT_LANG). available = pilihan di dashboard.
function languageInfo(kind, jid) {
  return {
    lang: getLang(kind, jid),
    explicit: hasExplicitLang(kind, jid),
    default: DEFAULT_LANG,
    available: SUPPORTED_LANGS,
    enabled: isLanguageStoreEnabled(),
  };
}

const metaCache = new Map(); // jid grup -> { at, data }
async function groupDetail(id) {
  const base = (await fetchGroups()).find((g) => g.id === id);
  if (!base) return null; // hanya grup yang memang diikuti bot
  let meta = null;
  const c = metaCache.get(id);
  if (c && Date.now() - c.at < 30000) meta = c.data;
  else if (sockRef) {
    try { meta = await sockRef.groupMetadata(id); metaCache.set(id, { at: Date.now(), data: meta }); }
    catch (e) { console.log("[stats] gagal ambil metadata grup:", e.message); }
  }
  const parts = meta?.participants || [];
  const admins = parts.filter((p) => p.admin === "admin" || p.admin === "superadmin");
  const creator = parts.find((p) => p.admin === "superadmin");
  const desc = meta?.desc ? String(meta.desc) : null;
  return {
    type: "group",
    ...botIdentity(),
    id,
    name: meta?.subject || base.name,
    members: parts.length || base.members,
    disabled: isBotDisabledFor(id),
    pp: getPP(id),
    subscription: getSubInfo("group", id),
    language: languageInfo("group", id),
    created: base.created,
    desc: desc && desc.length > 500 ? desc.slice(0, 500) + "…" : desc,
    adminCount: admins.length,
    creator: creator ? { name: nameOf(creator.id), number: numberOf(creator) } : null,
    onlyAdminsSend: !!meta?.announce,
    onlyAdminsEdit: !!meta?.restrict,
    admins: admins.slice(0, 30).map((p) => ({ name: nameOf(p.id), number: numberOf(p), super: p.admin === "superadmin" })),
    commands: await chatCommandStats(id),
  };
}

// Cari jid user dari nomornya, tapi HANYA yang sudah pernah PC bot.
function findUserJid(number) {
  for (const jid of getKnownUsers().keys()) if (jid.split("@")[0] === number) return jid;
  return null;
}

async function userDetail(number) {
  const jid = findUserJid(number);
  if (!jid) return null;
  const u = getKnownUsers().get(jid);
  return {
    type: "user",
    ...botIdentity(),
    id: number,
    name: u.name || null,
    number,
    blocked: isUserDisabled(jid),
    pp: getPP(jid),
    subscription: getSubInfo("user", jid),
    language: languageInfo("user", jid),
    messages: u.count || 0,
    firstSeen: u.firstSeen,
    lastSeen: u.lastSeen,
    commands: await chatCommandStats(jid),
  };
}

// Aktif/nonaktif bot. enabled=true -> bot menjawab lagi.
async function setEnabled(type, id, enabled) {
  if (type === "group") {
    if (!(await fetchGroups()).some((g) => g.id === id)) return false;
    enabled ? enableGroup(id) : disableGroup(id);
    return true;
  }
  if (type === "user") {
    const jid = findUserJid(id);
    if (!jid) return false;
    enabled ? enableUser(jid) : disableUser(jid);
    return true;
  }
  return false;
}

// Atur langganan dari dashboard. Return { code, body }.
//   action: "add" (tambah hari, sisa tidak hangus) | "set" (mulai ulang dari
//   sekarang) | "expire" (hentikan sekarang).
async function applySubscription(type, id, action, days) {
  if (!isSubscriptionEnabled()) {
    return { code: 503, body: { error: "Supabase belum dikonfigurasi di bot (SUPABASE_URL / SUPABASE_SERVICE_KEY)." } };
  }
  if (!["add", "set", "expire"].includes(action)) {
    return { code: 400, body: { error: "action harus add, set, atau expire." } };
  }
  if (action !== "expire" && !(Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) {
    return { code: 400, body: { error: `days harus bilangan bulat 1-${MAX_DAYS}.` } };
  }

  let kind, jid, name = null;
  if (type === "group") {
    const g = (await fetchGroups()).find((x) => x.id === id);
    if (!g) return { code: 404, body: { error: "Grup tidak ditemukan." } };
    kind = "group"; jid = id; name = g.name;
  } else if (type === "user") {
    if (!/^\d{5,25}$/.test(id)) return { code: 400, body: { error: "Nomor tidak valid." } };
    kind = "user";
    jid = findUserJid(id) || `${id}@s.whatsapp.net`;
    name = getKnownUsers().get(jid)?.name || null;
  } else {
    return { code: 400, body: { error: "type harus group atau user." } };
  }

  const saved =
    action === "add" ? await addDays(kind, jid, days, name)
    : action === "set" ? await setDays(kind, jid, days, name)
    : await expireNow(kind, jid, name);
  return {
    code: 200,
    body: { ok: true, sub: { expiresAt: saved.expiresAt, active: saved.expiresAt > Date.now() } },
  };
}

// Atur bahasa dari dashboard. lang: kode bahasa ("id"/"en") atau "default"
// (hapus pengaturan -> pakai DEFAULT_LANG). Return { code, body }.
async function applyLanguage(type, id, lang) {
  if (!isLanguageStoreEnabled()) {
    return { code: 503, body: { error: "Supabase belum dikonfigurasi di bot (SUPABASE_URL / SUPABASE_SERVICE_KEY)." } };
  }
  if (lang !== "default" && !isSupportedLang(lang)) {
    return { code: 400, body: { error: `lang harus default atau salah satu dari: ${SUPPORTED_LANGS.join(", ")}.` } };
  }

  let kind, jid;
  if (type === "group") {
    if (!(await fetchGroups()).some((g) => g.id === id)) return { code: 404, body: { error: "Grup tidak ditemukan." } };
    kind = "group"; jid = id;
  } else if (type === "user") {
    jid = findUserJid(id);
    if (!jid) return { code: 404, body: { error: "User tidak ditemukan." } };
    kind = "user";
  } else {
    return { code: 400, body: { error: "type harus group atau user." } };
  }

  if (lang === "default") await clearLang(kind, jid);
  else await setLang(kind, jid, lang, "web");
  return { code: 200, body: { ok: true, language: languageInfo(kind, jid) } };
}

// Request tulis dari web membawa botId. Kalau ada dan BUKAN milik bot ini,
// tolak -- artinya web salah mengarahkan request ke server yang keliru.
const wrongBot = (botId) => botId != null && String(botId) !== BOT_ID;

function readJson(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > max) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

function startStatsServer() {
  if (serverStarted) return; // startBot() dipanggil ulang saat reconnect
  serverStarted = true;
  init().catch((e) => console.log("[stats] init gagal:", e.message));
  const token = process.env.STATS_TOKEN;
  if (!token) return console.log("[stats] STATS_TOKEN kosong, endpoint /stats tidak dibuka.");
  const send = (res, code, body) => {
    res.writeHead(code, body === undefined ? {} : { "Content-Type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization || "");
    const want = Buffer.from("Bearer " + token);
    const ok = auth.length === want.length && crypto.timingSafeEqual(auth, want);
    if (!ok) return send(res, 401);
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/stats") return send(res, 200, await buildStats());
      if (req.method === "GET" && (url.pathname === "/group" || url.pathname === "/user") && wrongBot(url.searchParams.get("botId"))) {
        return send(res, 409, { error: `Request untuk bot "${url.searchParams.get("botId")}", ini bot "${BOT_ID}".` });
      }
      if (req.method === "GET" && url.pathname === "/group") {
        const d = await groupDetail(String(url.searchParams.get("id") || ""));
        return d ? send(res, 200, d) : send(res, 404, { error: "Grup tidak ditemukan." });
      }
      if (req.method === "GET" && url.pathname === "/user") {
        const d = await userDetail(String(url.searchParams.get("number") || ""));
        return d ? send(res, 200, d) : send(res, 404, { error: "User tidak ditemukan." });
      }
      if (req.method === "GET" && url.pathname === "/qr") {
        if (wrongBot(url.searchParams.get("botId"))) {
          return send(res, 409, { error: `Request untuk bot "${url.searchParams.get("botId")}", ini bot "${BOT_ID}".` });
        }
        const ss = getSession();
        return send(res, 200, {
          ...botIdentity(),
          status: ss.status,
          qr: ss.status === "qr" ? ss.qr : null,
          qrAt: ss.qrAt,
          number: ss.status === "connected" ? (ss.number || botNumber()) : null,
          reason: ss.reason,
          updatedAt: ss.updatedAt,
        });
      }
      if (req.method === "POST" && url.pathname === "/session") {
        const b = await readJson(req);
        if (wrongBot(b.botId)) return send(res, 409, { error: `Request untuk bot "${b.botId}", ini bot "${BOT_ID}".` });
        if (b.action !== "restart" && b.action !== "reset") return send(res, 400, { error: "action harus restart atau reset." });
        // require lazy: connection.js sendiri me-require stats.js (hindari circular import).
        const { restartSession } = require("../../bot/connection");
        console.log(`[session] ${b.action} diminta dari dashboard web`);
        restartSession({ wipe: b.action === "reset" }).catch((e) => console.log("[session] gagal:", e.message));
        return send(res, 200, { ok: true, action: b.action });
      }
      if (req.method === "POST" && url.pathname === "/toggle") {
        const b = await readJson(req);
        if (wrongBot(b.botId)) return send(res, 409, { error: `Request untuk bot "${b.botId}", ini bot "${BOT_ID}".` });
        if (typeof b.enabled !== "boolean") return send(res, 400, { error: "enabled harus true/false." });
        const done = await setEnabled(String(b.type), String(b.id), b.enabled);
        return done ? send(res, 200, { ok: true, enabled: b.enabled }) : send(res, 404, { error: "Grup/user tidak ditemukan." });
      }
      if (req.method === "POST" && url.pathname === "/subscription") {
        const b = await readJson(req);
        if (wrongBot(b.botId)) return send(res, 409, { error: `Request untuk bot "${b.botId}", ini bot "${BOT_ID}".` });
        try {
          const r = await applySubscription(String(b.type), String(b.id), String(b.action), Number(b.days));
          return send(res, r.code, r.body);
        } catch (e) {
          console.log("[stats] langganan gagal:", e.message);
          return send(res, 502, { error: "Gagal menyimpan ke Supabase: " + e.message });
        }
      }
      if (req.method === "POST" && url.pathname === "/language") {
        const b = await readJson(req);
        if (wrongBot(b.botId)) return send(res, 409, { error: `Request untuk bot "${b.botId}", ini bot "${BOT_ID}".` });
        try {
          const r = await applyLanguage(String(b.type), String(b.id), String(b.lang));
          return send(res, r.code, r.body);
        } catch (e) {
          console.log("[stats] bahasa gagal:", e.message);
          return send(res, 502, { error: "Gagal menyimpan ke Supabase: " + e.message });
        }
      }
      send(res, 404);
    } catch (e) { console.log("[stats]", e.message); send(res, 500); }
  }).listen(process.env.PORT || 3000, () => console.log(`[stats] endpoint /stats aktif (bot "${BOT_ID}")`));
}

module.exports = { logCommand, startStatsServer, setSocket };