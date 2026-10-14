const path = require("path");

// =====================================================
// Owner & saklar aktif/nonaktif bot PER GRUP
//
// - OWNER_NUMBER: nomor WA owner (format: kode negara + nomor, TANPA "+"
//   dan TANPA spasi/strip. Contoh Indonesia: "6281234567890"). Wajib diisi
//   lewat env var OWNER_NUMBER (lihat README/.env) supaya nomor pribadi
//   gak ke-commit ke git. Kalau env var-nya kosong, fitur owner otomatis
//   nonaktif semua (gak ada yang dianggap owner) -- aman by default.
// - Cuma owner yang boleh pakai "!bot on" / "!bot off" / "!bot status".
//   Saklar ini di-scope PER GRUP (per jid grup), jadi grup A bisa aktif
//   sementara grup B nonaktif, gak saling ganggu.
// - Kalau grup lagi dinonaktifin, bot TETAP baca semua pesan yang masuk
//   (biar owner tetap bisa "!bot on" buat nyalain lagi), tapi buat
//   siapa pun SELAIN owner yang ketik command ("!..."), bot cuma bales
//   sekali "ngambek" (nge-tag owner) terus behenti -- gak ada command lain
//   yang diproses. Owner sendiri TIDAK kena blokir ini sama sekali.
// - State-nya ditulis ke file JSON (data/bot_state.json) supaya gak reset
//   ke default tiap kali bot restart/redeploy. Override lokasinya lewat
//   env var BOT_STATE_FILE kalau perlu (sama pola kayak GROQ_HISTORY_FILE
//   di agemasenTsundere.js).
// =====================================================
// =====================================================
// IDENTITAS BOT (untuk menjalankan BEBERAPA bot / nomor WA dengan satu
// Supabase + satu dashboard web)
//
// - BOT_ID    : kode unik bot ini, huruf kecil/angka/_/- (mis. "bot1",
//               "bot2"). WAJIB beda di tiap server/nomor. Semua data
//               langganan, daftar chat, dan log command ditandai BOT_ID ini,
//               jadi grup yang sama di dua bot TIDAK saling tabrakan.
//               Default "bot1" -> kalau cuma ada 1 bot, tidak perlu diisi.
// - BOT_LABEL : nama tampilan di dashboard (opsional), mis. "Bot Utama".
//               Default = BOT_ID. Nomor WA-nya ditambahkan otomatis.
// =====================================================
const BOT_ID =
  (process.env.BOT_ID || "bot1")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 20) || "bot1";
const BOT_LABEL = (process.env.BOT_LABEL || "").trim().slice(0, 40) || BOT_ID;

const OWNER_NUMBER = (process.env.OWNER_NUMBER || "").replace(/\D/g, "");
const OWNER_JID = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;

const ROOT_DIR = path.join(__dirname, "..", "..");

const BOT_STATE_DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const BOT_STATE_FILE =
  process.env.BOT_STATE_FILE ||
  path.join(BOT_STATE_DATA_DIR, "bot_state.json");

// =====================================================
// Monitoring & saklar aktif/nonaktif bot PER NOMOR (DM pribadi)
//
// - Setiap orang yang pernah DM bot ini bakal otomatis kecatet
//   (nomor, jumlah pesan, terakhir kontak) di file JSON ini.
// - Owner bisa lihat daftarnya lewat "!listuser", dan bisa
//   block/unblock nomor tertentu lewat "!user on/off/status <nomor>"
//   dari MANA PUN (DM lain, grup owner, dll) -- gak perlu ngetik
//   langsung dari nomor WA yang jadi bot.
// - State-nya kepisah dari bot_state.json (yang itu buat grup),
//   supaya on/off grup dan on/off per-nomor gak nyampur.
// =====================================================
const USER_STATE_FILE =
  process.env.USER_STATE_FILE ||
  path.join(BOT_STATE_DATA_DIR, "user_state.json");

// =====================================================
// Fitur "!gif <keyword>" (lihat src/features/gif/) -- API key GIPHY.
// Sengaja TIDAK divalidasi/dilempar error di sini: giphy.js yang cek
// sendiri lewat process.env langsung & kasih GifProviderError yang jelas
// kalau kosong, biar bot TETAP JALAN normal buat fitur lain walau key ini
// belum di-set (cuma !gif yang kena, bukan seluruh bot -- lihat poin 3
// spesifikasi soal ini). Diekspor dari sini juga (bukan cuma dibaca
// langsung dari process.env di giphy.js) supaya konsisten sama pola env
// var lain di file ini, dan gampang dicek lewat satu tempat kalau perlu
// debug.
//
// CATATAN: TENOR_API_KEY SENGAJA DIHAPUS dari sini. tenor.js sekarang
// scraping halaman pencarian publik Tenor (bukan Tenor API v2 resmi lagi),
// jadi gak butuh API key sama sekali -- lihat komentar di
// src/features/gif/tenor.js buat detailnya.
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || "";

// =====================================================
// LANGGANAN (subscription) -- data disimpan di Supabase
//
// - SUPABASE_URL          : mis. https://xxxx.supabase.co
// - SUPABASE_SERVICE_KEY  : service_role key (Settings > API). RAHASIA,
//                           cuma boleh ada di server bot, JANGAN di web.
// - SUBSCRIPTION_REQUIRED : siapa yang WAJIB punya langganan aktif:
//     all    (default) -> bot DEFAULT MATI: grup & DM wajib punya langganan
//                         aktif (diaktifkan owner/admin lewat !sub atau
//                         dashboard) baru boleh pakai bot.
//     groups -> cuma grup yang wajib; DM tetap gratis
//     users  -> cuma DM yang wajib; grup tetap gratis
//     none   -> perilaku lama: yang gak punya data langganan tetap gratis.
//               Yang PUNYA data langganan tetap dihitung mundur & otomatis
//               mati saat habis.
// Kalau SUPABASE_URL / SUPABASE_SERVICE_KEY kosong, seluruh fitur langganan
// mati dan bot jalan seperti biasa (aman by default).
// =====================================================
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const SUBSCRIPTION_REQUIRED = (process.env.SUBSCRIPTION_REQUIRED || "all")
  .trim()
  .toLowerCase();

// =====================================================
// Fitur "!artikel" -- pencarian publikasi (src/services/journal/)
//
// - OPENALEX_API_KEY : (disarankan) API key gratis dari openalex.org/settings/api.
//                      Sejak Feb 2026 OpenAlex memakai kuota harian; tanpa key
//                      kuotanya jauh lebih kecil. Kosong = tetap jalan, tapi
//                      mudah kena batas.
// - OPEN_ACCESS_CONTACT_EMAIL : email kontak yang WAJIB dikirim ke Unpaywall
//                      (& dipakai di User-Agent Crossref/OpenAlex). Unpaywall
//                      menolak email @example.com, jadi isi dengan email asli.
// Keduanya dibaca langsung dari process.env di modul journal; diekspor di sini
// supaya terdokumentasi di satu tempat.
// =====================================================
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY || "";
const OPEN_ACCESS_CONTACT_EMAIL = process.env.OPEN_ACCESS_CONTACT_EMAIL || "";

// =====================================================
// BAHASA BOT (id / en) -- lihat src/i18n/ dan src/state/languageStore.js
//
// - DEFAULT_LANG : bahasa untuk grup/nomor yang BELUM pernah memilih
//                  ("id" = Indonesia (default), "en" = English). Dibaca
//                  langsung di src/i18n/index.js.
// - Pilihan per grup / per nomor disimpan di Supabase (tabel chat_settings,
//   lihat supabase/chat_settings.sql) memakai SUPABASE_URL &
//   SUPABASE_SERVICE_KEY yang sama dengan fitur langganan. User mengganti
//   lewat command: !lang en / !lang id (grup: khusus admin grup/owner).
// =====================================================

module.exports = {
  BOT_ID,
  BOT_LABEL,
  ROOT_DIR,
  OWNER_NUMBER,
  OWNER_JID,
  BOT_STATE_DATA_DIR,
  BOT_STATE_FILE,
  USER_STATE_FILE,
  GIPHY_API_KEY,
  OPENALEX_API_KEY,
  OPEN_ACCESS_CONTACT_EMAIL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUBSCRIPTION_REQUIRED,
};
