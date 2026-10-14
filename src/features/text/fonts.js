// Registrasi font cadangan (fallback) bersama untuk SEMUA renderer canvas.
//
// Masalah lama: tiap renderer cuma daftar 1-2 font Latin (Archivo Narrow /
// DejaVu). Karakter Jepang/Mandarin/Korea tidak ada di font itu -> tampil
// kotak kosong. Font di sini dipasang sebagai cadangan; canvas otomatis
// memilih font berikutnya di daftar untuk karakter yang tidak ada glyph-nya.
//
// File font ikut di repo (assets/fonts, lisensi OFL) supaya tidak
// bergantung pada font sistem server Railway.
const fs = require("fs");
const path = require("path");
const { GlobalFonts } = require("@napi-rs/canvas");

const FONT_DIR = path.join(__dirname, "../../../assets/fonts");

// Urutan penting: font paling awal yang punya glyph-nya yang dipakai.
// JP dulu (kana + kanji), KR (Hangul), SC (hanzi sederhana yang tidak ada di JP).
const FALLBACKS = [
  ["FbArabic", process.env.FALLBACK_ARABIC_FONT_PATH || path.join(FONT_DIR, "NotoSansArabic-Regular.ttf")],
  ["FbJP", process.env.FALLBACK_JP_FONT_PATH || path.join(FONT_DIR, "NotoSansJP-Regular.otf")],
  ["FbKR", process.env.FALLBACK_KR_FONT_PATH || path.join(FONT_DIR, "NotoSansKR-Regular.otf")],
  ["FbSC", process.env.FALLBACK_SC_FONT_PATH || path.join(FONT_DIR, "NotoSansSC-Regular.otf")],
  ["FbSymbols", process.env.FALLBACK_SYMBOLS_FONT_PATH || path.join(FONT_DIR, "NotoSansSymbols2-Regular.ttf")],
  // Emoji gaya WhatsApp. Ditaruh PALING AKHIR supaya teks biasa tetap pakai
  // font Latin/CJK di atas, dan hanya emoji yang jatuh ke font ini.
  ["WhatsAppEmoji", process.env.EMOJI_FONT_PATH || path.join(FONT_DIR, "WhatsAppEmoji.ttf")],
];

// true kalau file WhatsAppEmoji.ttf ada -> renderer boleh menampilkan emoji.
const EMOJI_FONT_AVAILABLE = fs.existsSync(FALLBACKS[FALLBACKS.length - 1][1]);

// Nama family yang dipakai di stack, urut sesuai prioritas.
const FALLBACK_FAMILIES = FALLBACKS.map(([name]) => name);

let registered = false;
function ensureFallbackFontsRegistered() {
  if (registered) return;
  registered = true;
  for (const [family, file] of FALLBACKS) {
    if (fs.existsSync(file)) {
      GlobalFonts.registerFromPath(file, family);
    } else {
      console.log(`⚠️ Font cadangan ${family} tidak ditemukan di ${file}`);
    }
  }
}

// Bangun string untuk ctx.font:
//   fontStack(["MemeFont"]) -> '"MemeFont", "FbArabic", "FbJP", ..., "DejaVu Sans", sans-serif'
function fontStack(primaryFamilies = []) {
  ensureFallbackFontsRegistered();
  const all = [...primaryFamilies, ...FALLBACK_FAMILIES, "DejaVu Sans"];
  return all.map((f) => `"${f}"`).join(", ") + ", sans-serif";
}

module.exports = { ensureFallbackFontsRegistered, fontStack, FALLBACK_FAMILIES, EMOJI_FONT_AVAILABLE };
