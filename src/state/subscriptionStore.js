// Langganan bot per GRUP / per NOMOR (DM), datanya disimpan di Supabase.
//
// Cara kerja:
//  - Sumber kebenaran = tabel "subscriptions" di Supabase (lihat
//    supabase/subscriptions.sql), jadi data aman walau Railway redeploy.
//  - Bot menyalin isinya ke MEMORI (cache) dan menyegarkannya tiap 60 detik.
//    Cek per-pesan (checkSubscription) murni baca memori -> tidak ada request
//    jaringan per pesan, dan bot tetap jalan walau Supabase sedang gangguan.
//  - Kedaluwarsa dihitung dari timestamp (expires_at > sekarang), bukan dari
//    cron/timer, jadi langganan habis TEPAT waktunya tanpa nunggu refresh.
//  - Akses ke Supabase lewat REST (PostgREST) pakai fetch bawaan Node, jadi
//    tidak ada dependency baru.
//
// Fail-open: sebelum data pertama berhasil dimuat (mis. Supabase lagi down
// saat bot baru nyala), semua dianggap BOLEH supaya tidak ada grup yang
// tiba-tiba mati gara-gara masalah koneksi. Kalau refresh berikutnya gagal,
// cache terakhir yang bagus tetap dipakai.
const {
  BOT_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUBSCRIPTION_REQUIRED,
} = require("../config/env");

// MULTI-BOT: tabel "subscriptions" dipakai bersama oleh semua bot, dibedakan
// kolom bot_id. Bot ini HANYA membaca & menulis baris dengan bot_id = BOT_ID,
// jadi grup yang sama di bot lain punya langganan sendiri (tidak tercampur).
// Lihat supabase/multi_bot.sql.

const { t } = require("../i18n");

const TABLE = "subscriptions";
const REFRESH_MS = 60 * 1000;
const PAGE = 1000; // batas default PostgREST per request
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 3650;

const enabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// "group:1203...@g.us" -> { kind, jid, name, expiresAt(ms), startedAt(ms) }
let cache = new Map();
let loaded = false;
let started = false;

const keyOf = (kind, jid) => `${kind}:${jid}`;

function fromRow(r) {
  return {
    kind: r.kind,
    jid: r.jid,
    name: r.name || null,
    expiresAt: Date.parse(r.expires_at),
    startedAt: Date.parse(r.started_at),
  };
}

async function rest(path, { method = "GET", body, prefer } = {}) {
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
  // return=minimal membalas 201 tanpa body, jadi jangan langsung res.json().
  const raw = await res.text();
  return raw ? JSON.parse(raw) : null;
}

async function refreshSubscriptions() {
  if (!enabled) return;
  const next = new Map();
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(
      `${TABLE}?select=*&bot_id=eq.${encodeURIComponent(BOT_ID)}&order=kind.asc,jid.asc&limit=${PAGE}&offset=${offset}`,
    );
    for (const r of page) {
      const s = fromRow(r);
      next.set(keyOf(s.kind, s.jid), s);
    }
    if (page.length < PAGE) break;
  }
  cache = next;
  loaded = true;
}

// Idempotent: startBot() dipanggil ulang tiap reconnect.
function initSubscriptions() {
  if (started) return;
  started = true;
  if (!enabled) {
    console.log("[langganan] SUPABASE_URL/SUPABASE_SERVICE_KEY kosong, fitur langganan nonaktif.");
    return;
  }
  const tick = () =>
    refreshSubscriptions().catch((e) =>
      console.log("[langganan] gagal refresh dari Supabase:", e.message),
    );
  tick().then(() =>
    console.log(
      `[langganan] aktif untuk bot "${BOT_ID}", ${cache.size} data dimuat (wajib untuk: ${SUBSCRIPTION_REQUIRED}).`,
    ),
  );
  setInterval(tick, REFRESH_MS).unref();
}

function isSubscriptionEnabled() {
  return enabled;
}

function requiredFor(kind) {
  return (
    SUBSCRIPTION_REQUIRED === "all" || SUBSCRIPTION_REQUIRED === `${kind}s`
  );
}

// Dipanggil router tiap pesan (sinkron, murni baca memori).
//   state: "off"     fitur mati / data belum termuat -> selalu boleh
//          "none"    belum punya langganan
//          "active"  langganan berjalan
//          "expired" langganan habis
function checkSubscription(kind, jid) {
  if (!enabled || !loaded) {
    return { allowed: true, state: "off", expiresAt: null, remainingMs: null };
  }
  const s = cache.get(keyOf(kind, jid));
  if (!s) {
    return {
      allowed: !requiredFor(kind),
      state: "none",
      expiresAt: null,
      remainingMs: null,
    };
  }
  const left = s.expiresAt - Date.now();
  return {
    allowed: left > 0,
    state: left > 0 ? "active" : "expired",
    expiresAt: s.expiresAt,
    remainingMs: Math.max(0, left),
  };
}

// Bentuk ringkas untuk dashboard web: { expiresAt, active } atau null.
function getSubInfo(kind, jid) {
  const s = cache.get(keyOf(kind, jid));
  if (!s) return null;
  return { expiresAt: s.expiresAt, active: s.expiresAt > Date.now() };
}

function listSubscriptions(kind) {
  return [...cache.values()]
    .filter((s) => s.kind === kind)
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

async function upsert(kind, jid, expiresAtMs, name) {
  if (!enabled) throw new Error("Supabase belum dikonfigurasi di bot.");
  const existing = cache.get(keyOf(kind, jid));
  const nowIso = new Date().toISOString();
  const rows = await rest(`${TABLE}?on_conflict=bot_id,kind,jid`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      bot_id: BOT_ID,
      kind,
      jid,
      name: name || existing?.name || null,
      expires_at: new Date(expiresAtMs).toISOString(),
      started_at: existing
        ? new Date(existing.startedAt).toISOString()
        : nowIso,
      updated_at: nowIso,
    },
  });
  const saved = fromRow(rows[0]);
  cache.set(keyOf(kind, jid), saved);
  loaded = true;
  return saved;
}

// Pastikan cache sudah pernah dimuat sebelum nambah hari, supaya "tambah
// 30 hari" tidak salah mulai dari sekarang padahal sebenarnya masih ada sisa.
async function ensureLoaded() {
  if (!enabled) throw new Error("Supabase belum dikonfigurasi di bot.");
  if (!loaded) await refreshSubscriptions();
}

function validDays(days) {
  return Number.isInteger(days) && days >= 1 && days <= MAX_DAYS;
}

// Perpanjang: kalau masih aktif, dihitung dari tanggal habis (sisa hari
// tidak hangus). Kalau sudah habis / belum pernah, dihitung dari sekarang.
async function addDays(kind, jid, days, name) {
  if (!validDays(days)) throw new Error(`Jumlah hari harus 1-${MAX_DAYS}.`);
  await ensureLoaded();
  const cur = cache.get(keyOf(kind, jid));
  const base = cur && cur.expiresAt > Date.now() ? cur.expiresAt : Date.now();
  return upsert(kind, jid, base + days * DAY_MS, name);
}

// Timpa: langganan dimulai dari sekarang selama N hari (sisa lama dibuang).
async function setDays(kind, jid, days, name) {
  if (!validDays(days)) throw new Error(`Jumlah hari harus 1-${MAX_DAYS}.`);
  await ensureLoaded();
  return upsert(kind, jid, Date.now() + days * DAY_MS, name);
}

// Hentikan sekarang. Barisnya tetap disimpan (status "habis"), bukan dihapus,
// supaya tidak jatuh balik jadi "gratis" saat SUBSCRIPTION_REQUIRED=none.
async function expireNow(kind, jid, name) {
  await ensureLoaded();
  return upsert(kind, jid, Date.now(), name);
}

function formatRemaining(ms, lang) {
  if (ms == null || ms <= 0) return t(lang, "time.expired");
  // Dibulatkan ke atas: baru ditambah 30 hari harus tampil "30 hari 0 jam",
  // bukan "29 hari 23 jam" gara-gara selisih beberapa milidetik.
  const totalMin = Math.ceil(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return t(lang, "time.dhm.days", { d, h });
  if (h > 0) return t(lang, "time.dhm.hours", { h, m });
  return t(lang, "time.dhm.minutes", { m });
}

function formatDateWIB(ms, lang) {
  return (
    new Date(ms).toLocaleString(lang === "en" ? "en-GB" : "id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    }) + " WIB"
  );
}

module.exports = {
  MAX_DAYS,
  supabaseRest: rest,
  initSubscriptions,
  refreshSubscriptions,
  isSubscriptionEnabled,
  checkSubscription,
  getSubInfo,
  listSubscriptions,
  addDays,
  setDays,
  expireNow,
  formatRemaining,
  formatDateWIB,
};
