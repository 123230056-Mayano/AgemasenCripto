const axios = require("axios");
const { t } = require("../../i18n");
const sharp = require("sharp");
const {
  API_PAGE_SIZE,
  SAFEBOORU_TIMEOUT_MS,
  downloadImage,
} = require("../booru/safebooru");

function isBannerEligible(width, height) {
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio >= 0.95; // < 0.95 = portrait, ditolak
}

// Ambil SATU gambar acak yang ORIENTASINYA cocok buat banner !menu
// (landscape/square -- lihat isBannerEligible) -- dipakai cuma buat hiasan
// !menu, jadi cukup cepat & ringan tiap kali user ketik !menu. Gambar
// portrait DILEWATI dan dicari gambar lain (bukan langsung dipakai apa
// adanya), makanya narik beberapa halaman kalau perlu sampai nemu
// setidaknya beberapa kandidat yang layak, atau sampai halamannya habis.
async function fetchRandomImageForHelp(tag) {
  const MAX_PAGES = 3;
  const eligible = [];

  try {
    for (let pid = 0; pid < MAX_PAGES; pid++) {
      const res = await axios.get("https://safebooru.org/index.php", {
        params: {
          page: "dapi",
          s: "post",
          q: "index",
          json: 1,
          limit: API_PAGE_SIZE,
          pid,
          tags: tag,
        },
      });

      const data = Array.isArray(res.data) ? res.data : [];
      if (data.length === 0) break; // gak ada hasil sama sekali / halaman habis

      for (const p of data) {
        if (p.file_url && isBannerEligible(Number(p.width), Number(p.height))) {
          eligible.push(p);
        }
      }

      // Ini cuma hiasan, gak perlu nyisir semua halaman sampai abis --
      // begitu kandidat udah cukup buat dipilih acak, berhenti.
      if (eligible.length >= API_PAGE_SIZE) break;
      if (data.length < API_PAGE_SIZE) break; // halaman terakhir
    }
  } catch (err) {
    console.log(`⚠️ Gagal ambil gambar hiasan !menu ("${tag}"):`, err.message);
    return null;
  }

  if (eligible.length === 0) return null;

  return eligible[Math.floor(Math.random() * eligible.length)];
}

// Tag khusus buat gambar hiasan di !menu.
const HELP_IMAGE_TAG = "special_week_(umamusume)";

// Teks !menu & penjelasan detail per command SEKARANG ada di
// src/i18n/locales/{id,en}.menu.js (key "menu.text" & "cmd.<nama>") supaya
// bisa dua bahasa. Penjelasan detail dikirim otomatis kapan pun user
// salah/kurang lengkap nulis command-nya, jadi user gak perlu buka !menu.

// Batas ukuran banner !menu (cuma buat jaga-jaga biar filenya gak
// kegedean/ngirim gambar mentah beresolusi tinggi). BUKAN kanvas tetap --
// rasio asli gambar dipertahankan (lihat toMenuBanner), gak dipaksa 16:9
// lagi. Ini aman dipakai karena fetchRandomImageForHelp sudah menyaring
// cuma gambar landscape/square yang lolos (lihat isBannerEligible), jadi
// gak akan ada sumber portrait yang perlu di-crop.
const MENU_BANNER_MAX_WIDTH = 1280;
const MENU_BANNER_MAX_HEIGHT = 1280;

async function toMenuBanner(buffer) {
  return sharp(buffer)
    .resize(MENU_BANNER_MAX_WIDTH, MENU_BANNER_MAX_HEIGHT, {
      fit: "inside", // cuma diperkecil kalau kelewat besar, TIDAK di-crop/pad -- rasio asli tetap
      withoutEnlargement: true, // gambar yang udah kecil gak dipaksa diperbesar
    })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function sendMenu(sock, jid, lang) {
  const menuText = t(lang, "menu.text");
  const post = await fetchRandomImageForHelp(HELP_IMAGE_TAG);

  if (post) {
    try {
      const rawBuffer = await downloadImage(post.file_url);
      const bannerBuffer = await toMenuBanner(rawBuffer);
      await sock.sendMessage(jid, { image: bannerBuffer, caption: menuText });
      return;
    } catch (err) {
      console.log(
        "⚠️ Gagal kirim gambar hiasan !menu, fallback ke teks polos:",
        err.message,
      );
    }
  }

  // Fallback: kalau gambar gagal diambil/dikirim, tetap kirim teksnya saja
  // supaya !menu tidak pernah gagal total gara-gara masalah di sisi gambar.
  await sock.sendMessage(jid, { text: menuText });
}

// Kirim penjelasan detail command tertentu (dipanggil otomatis saat user
// salah/kurang lengkap nulis command itu).
async function sendCommandDetail(sock, jid, commandKey, lang) {
  await sock.sendMessage(jid, { text: t(lang, `cmd.${commandKey}`) });
}

module.exports = {
  HELP_IMAGE_TAG,
  MENU_BANNER_MAX_WIDTH,
  MENU_BANNER_MAX_HEIGHT,
  isBannerEligible,
  fetchRandomImageForHelp,
  toMenuBanner,
  sendMenu,
  sendCommandDetail,
};