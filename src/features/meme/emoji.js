const fs = require("fs");
const axios = require("axios");

const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");

// Path font teks (bukan emoji) buat !meme / !smeme: Impact.
// Impact font berlisensi (tidak boleh dibundel sembarangan), jadi file-nya
// harus ditaruh sendiri di assets/fonts/impact.ttf (ambil dari
// C:/Windows/Fonts/impact.ttf). Urutan pencarian:
//   1. env MEME_FONT_PATH (kalau di-set)
//   2. assets/fonts/impact.ttf | Impact.ttf
//   3. font sistem (msttcorefonts di Linux)
//   4. DejaVu Sans Bold (cadangan terakhir kalau Impact tidak ketemu)
const path = require("path");
const FONT_DIR = path.join(__dirname, "../../../assets/fonts");
const MEME_FONT_CANDIDATES = [
  process.env.MEME_FONT_PATH,
  path.join(FONT_DIR, "impact.ttf"),
  path.join(FONT_DIR, "Impact.ttf"),
  "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf",
  "/usr/share/fonts/truetype/msttcorefonts/impact.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
].filter(Boolean);
const MEME_FONT_PATH =
  MEME_FONT_CANDIDATES.find((f) => fs.existsSync(f)) ||
  MEME_FONT_CANDIDATES[0];
const MEME_FONT_FAMILY = "MemeFont";

// Font emoji gaya WhatsApp (WhatsAppEmoji.ttf). Semua emoji di renderer canvas
// sekarang digambar dari font ini. Urutan pencarian file:
//   1. env EMOJI_FONT_PATH (kalau di-set)
//   2. assets/fonts/WhatsAppEmoji.ttf
// Kalau file-nya tidak ada (atau sebuah emoji tidak ada glyph-nya di font),
// emoji itu otomatis jatuh balik ke gambar Twemoji seperti sebelumnya.
const WA_EMOJI_FAMILY = "WhatsAppEmoji";
const WA_EMOJI_PATH = [
  process.env.EMOJI_FONT_PATH,
  path.join(FONT_DIR, "WhatsAppEmoji.ttf"),
].filter(Boolean).find((f) => fs.existsSync(f)) || null;

// Sumber gambar emoji (Twemoji), bisa dioverride lewat env var kalau CDN ini
// diblokir di server. {code} diganti dengan codepoint hex (mis. "1f602").
const EMOJI_IMAGE_BASE_URL =
  process.env.EMOJI_IMAGE_BASE_URL ||
  "https://raw.githubusercontent.com/jdecked/twemoji/main/assets/72x72";

let fontsRegistered = false;

function ensureFontsRegistered() {
  if (fontsRegistered) return;
  fontsRegistered = true;

  if (WA_EMOJI_PATH) {
    GlobalFonts.registerFromPath(WA_EMOJI_PATH, WA_EMOJI_FAMILY);
  } else {
    console.log(
      "⚠️ WhatsAppEmoji.ttf tidak ditemukan (taruh di assets/fonts atau set env EMOJI_FONT_PATH) -- emoji pakai Twemoji.",
    );
  }

  if (fs.existsSync(MEME_FONT_PATH)) {
    GlobalFonts.registerFromPath(MEME_FONT_PATH, MEME_FONT_FAMILY);
  } else {
    console.log(
      `⚠️ Font meme tidak ditemukan di ${MEME_FONT_PATH} (taruh impact.ttf di assets/fonts atau set env MEME_FONT_PATH).`,
    );
  }
}

// Regex Unicode buat nangkep 1 "cluster" emoji utuh supaya tidak kepotong
// jadi beberapa gambar terpisah. Mendukung:
//   - bendera (2 regional indicator, mis. 🇮🇩)
//   - emoji + variation selector (❤️) dan skin tone (👍🏽)
//   - emoji gabungan pakai ZWJ (👨‍👩‍👧, ❤️‍🔥, 🧑🏽‍💻)
const EMOJI_MODIFIER = "[\\u{1F3FB}-\\u{1F3FF}]";
const EMOJI_UNIT = `\\p{Extended_Pictographic}\\uFE0F?${EMOJI_MODIFIER}?`;
const EMOJI_REGEX = new RegExp(
  `\\p{Regional_Indicator}{2}|${EMOJI_UNIT}(?:\\u200D${EMOJI_UNIT})*`,
  "gu",
);

// "😂" -> "1f602" (dipakai buat nama file Twemoji). Aturan Twemoji:
// variation selector (U+FE0F) dibuang, KECUALI untuk emoji gabungan pakai
// ZWJ (U+200D) -- di situ FE0F harus tetap ada (mis. 2764-fe0f-200d-1f525).
function emojiToCodepoints(emoji) {
  const hasZwj = emoji.includes("\u200D");
  return Array.from(emoji)
    .map((ch) => ch.codePointAt(0))
    .filter((cp) => hasZwj || cp !== 0xfe0f)
    .map((cp) => cp.toString(16))
    .join("-");
}

// Pecah teks jadi array segmen { type: "text" | "emoji", value }.
function splitTextEmoji(text) {
  const segments = [];
  let lastIndex = 0;

  for (const match of text.matchAll(EMOJI_REGEX)) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        value: text.slice(lastIndex, match.index),
      });
    }
    segments.push({ type: "emoji", value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  return segments;
}

// Cache in-memory: codepoint -> Image (atau null kalau gagal/tidak ada,
// supaya tidak coba fetch berulang-ulang untuk emoji yang sama yang gagal).
const emojiImageCache = new Map();

// --- Render emoji dari font WhatsApp -> canvas persegi -------------------
// Hasilnya canvas 1:1 yang bisa langsung dipakai ctx.drawImage() oleh semua
// renderer (sama seperti gambar Twemoji sebelumnya), jadi kode di
// textRender / bratSticker / dialogSticker tidak perlu diubah.
const WA_FONT_PX = 96;
const WA_CELL = Math.ceil(WA_FONT_PX * 1.25); // 120px, lalu di-scale saat digambar
const WA_BASELINE = Math.round(WA_FONT_PX * 0.97);
let waTofuPixels;

function drawWaGlyph(text) {
  const canvas = createCanvas(WA_CELL, WA_CELL);
  const ctx = canvas.getContext("2d");
  ctx.font = `${WA_FONT_PX}px "${WA_EMOJI_FAMILY}"`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const w = ctx.measureText(text).width;
  ctx.fillText(text, (WA_CELL - w) / 2, WA_BASELINE);
  return { canvas, pixels: ctx.getImageData(0, 0, WA_CELL, WA_CELL).data };
}

// Balikin canvas emoji, atau null kalau glyph-nya tidak ada di font
// (kosong / kotak "tofu") supaya pemanggil jatuh balik ke Twemoji.
function renderEmojiFromFont(emoji) {
  if (!WA_EMOJI_PATH) return null;
  ensureFontsRegistered();
  try {
    const { canvas, pixels } = drawWaGlyph(emoji);
    if (!pixels.some((v, i) => i % 4 === 3 && v > 0)) return null; // kosong
    if (waTofuPixels === undefined) {
      waTofuPixels = Buffer.from(drawWaGlyph("\u{10FFFF}").pixels);
    }
    if (Buffer.from(pixels).equals(waTofuPixels)) return null; // kotak tofu
    return canvas;
  } catch (err) {
    console.log(`⚠️ Gagal render emoji "${emoji}" dari font:`, err.message);
    return null;
  }
}

async function getEmojiImage(emoji) {
  const code = emojiToCodepoints(emoji);
  if (emojiImageCache.has(code)) return emojiImageCache.get(code);

  const fromFont = renderEmojiFromFont(emoji);
  if (fromFont) {
    emojiImageCache.set(code, fromFont);
    return fromFont;
  }

  try {
    const res = await axios.get(`${EMOJI_IMAGE_BASE_URL}/${code}.png`, {
      responseType: "arraybuffer",
      timeout: 8000,
    });
    const img = await loadImage(Buffer.from(res.data));
    emojiImageCache.set(code, img);
    return img;
  } catch (err) {
    console.log(
      `⚠️ Gagal ambil gambar emoji "${emoji}" (${code}):`,
      err.message,
    );
    // Cache "tidak ada" HANYA kalau memang 404 (emoji tidak ada di Twemoji).
    // Gagal karena jaringan/timeout gak di-cache, biar dicoba lagi lain kali
    // (kalau di-cache, emoji itu hilang terus sampai bot direstart).
    if (err.response && err.response.status === 404) {
      emojiImageCache.set(code, null);
    }
    return null;
  }
}

// Pra-load semua emoji unik yang dipakai di sebuah teks (dipanggil sebelum
// render, supaya proses gambar di canvas sendiri tetap synchronous/simpel).
async function preloadEmojisInText(text) {
  if (!text) return;
  const emojis = new Set(
    splitTextEmoji(text)
      .filter((s) => s.type === "emoji")
      .map((s) => s.value),
  );
  await Promise.all([...emojis].map(getEmojiImage));
}

module.exports = {
  MEME_FONT_PATH,
  MEME_FONT_FAMILY,
  WA_EMOJI_FAMILY,
  WA_EMOJI_PATH,
  EMOJI_IMAGE_BASE_URL,
  ensureFontsRegistered,
  emojiToCodepoints,
  splitTextEmoji,
  getEmojiImage,
  preloadEmojisInText,
  emojiImageCache,
};