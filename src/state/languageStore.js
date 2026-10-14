// Bahasa bot per GRUP / per NOMOR (DM), disimpan di Supabase
// (tabel "chat_settings", lihat supabase/chat_settings.sql).
//
// Pola sama persis dengan subscriptionStore.js:
//  - Sumber kebenaran = Supabase. Isinya disalin ke MEMORI dan disegarkan
//    tiap 60 detik, jadi cek bahasa per-pesan (getLang) murni baca memori,
//    nol request jaringan per pesan.
//  - Saat user ganti bahasa (setLang): tulis ke Supabase DULU, baru cache
//    diperbarui -- kalau Supabase gagal, user dikasih tahu (bukan pura-pura
//    sukses lalu balik lagi ke bahasa lama setelah restart).
//  - Fail-safe: kalau Supabase belum dikonfigurasi / lagi gangguan, bot
//    tetap jalan pakai bahasa default (atau cache terakhir yang bagus).
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = require("../config/env");
const { supabaseRest } = require("./subscriptionStore");
const { DEFAULT_LANG, isSupportedLang } = require("../i18n");

const TABLE = "chat_settings";
const REFRESH_MS = 60 * 1000;
const PAGE = 1000;

const enabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// "group:1203...@g.us" / "user:628...@s.whatsapp.net" -> "id" | "en"
let cache = new Map();
let started = false;

const keyOf = (kind, jid) => `${kind}:${jid}`;

async function refreshLanguages() {
  if (!enabled) return;
  const next = new Map();
  for (let offset = 0; ; offset += PAGE) {
    const page = await supabaseRest(
      `${TABLE}?select=kind,jid,lang&order=kind.asc,jid.asc&limit=${PAGE}&offset=${offset}`,
    );
    for (const r of page) {
      if (isSupportedLang(r.lang)) next.set(keyOf(r.kind, r.jid), r.lang);
    }
    if (page.length < PAGE) break;
  }
  cache = next;
}

// Idempotent: startBot() dipanggil ulang tiap reconnect.
function initLanguageStore() {
  if (started) return;
  started = true;
  if (!enabled) {
    console.log(
      `[bahasa] SUPABASE_URL/SUPABASE_SERVICE_KEY kosong, semua chat pakai bahasa default (${DEFAULT_LANG}).`,
    );
    return;
  }
  const tick = () =>
    refreshLanguages().catch((e) =>
      console.log("[bahasa] gagal refresh dari Supabase:", e.message),
    );
  tick().then(() =>
    console.log(`[bahasa] aktif, ${cache.size} pengaturan dimuat (default: ${DEFAULT_LANG}).`),
  );
  setInterval(tick, REFRESH_MS).unref();
}

function isLanguageStoreEnabled() {
  return enabled;
}

// Sinkron, murni baca memori -- aman dipanggil tiap pesan.
// kind: "group" | "user". Gak ada pengaturan -> bahasa default.
function getLang(kind, jid) {
  if (!kind || !jid) return DEFAULT_LANG;
  return cache.get(keyOf(kind, jid)) || DEFAULT_LANG;
}

// Apakah chat ini SUDAH pernah milih bahasa sendiri (bukan sekadar default)?
function hasExplicitLang(kind, jid) {
  return cache.has(keyOf(kind, jid));
}

async function setLang(kind, jid, lang, updatedBy) {
  if (!enabled) throw new Error("Supabase belum dikonfigurasi di bot.");
  if (kind !== "group" && kind !== "user") throw new Error("kind tidak valid.");
  if (!isSupportedLang(lang)) throw new Error("Bahasa tidak didukung.");

  await supabaseRest(`${TABLE}?on_conflict=kind,jid`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      kind,
      jid,
      lang,
      updated_by: updatedBy || null,
      updated_at: new Date().toISOString(),
    },
  });
  cache.set(keyOf(kind, jid), lang);
  return lang;
}

// Hapus pengaturan -> chat kembali ke bahasa default (DEFAULT_LANG).
async function clearLang(kind, jid) {
  if (!enabled) throw new Error("Supabase belum dikonfigurasi di bot.");
  if (kind !== "group" && kind !== "user") throw new Error("kind tidak valid.");

  await supabaseRest(
    `${TABLE}?kind=eq.${encodeURIComponent(kind)}&jid=eq.${encodeURIComponent(jid)}`,
    { method: "DELETE", prefer: "return=minimal" },
  );
  cache.delete(keyOf(kind, jid));
}

module.exports = {
  initLanguageStore,
  refreshLanguages,
  isLanguageStoreEnabled,
  getLang,
  hasExplicitLang,
  setLang,
  clearLang,
};
