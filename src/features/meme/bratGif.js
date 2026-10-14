const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { runFfmpeg, STICKER_MAX_BYTES } = require("../media/ffmpeg");
const { preloadEmojisInText } = require("./emoji");
const {
  normalizeText,
  stripUnavailableEmoji,
  splitWords,
  renderBratPngSync,
  pngToFriedJpeg,
} = require("./bratSticker");

// =====================================================
// Fitur: "!gifbrat <teks>" (alias ".gifbrat") -- GIF animasi gaya BRAT yang
// "mengetik" per kata.
//
// Cara kerjanya: teks dipecah jadi kata-kata, lalu frame ke-N = hasil render
// brat (renderBratPngSync, PERSIS fungsi yang dipakai !sbrat) dari kata ke-1
// sampai ke-N. Jadi tiap frame adalah layout brat yang lengkap dan benar:
// font otomatis mengecil dan teks otomatis wrap/justify ulang setiap ada kata
// baru -- itu yang bikin kelihatan "proses bikin bratnya". Frame terakhir =
// hasil akhir yang sama dengan stiker !sbrat. Efek "fried" (blur + JPEG
// jelek) ikut di-apply per frame.
//
// Output: video MP4 (H.264) yang dikirim sebagai video+gifPlayback -- ini
// cara WhatsApp menampilkan "GIF" (sama seperti !togif dan !gif).
//
// Semua angka bisa diatur lewat env:
//   BRATGIF_WORD_DELAY_MS  jeda tiap kata muncul          (default 500)
//   BRATGIF_END_HOLD_MS    lama frame terakhir ditahan    (default 2000)
//   BRATGIF_SIZE           sisi video dalam piksel (genap)(default 512)
//   BRATGIF_FRIED_LEVEL    blur + efek fried 1-100        (default 40)
//   BRATGIF_MAX_WORDS      batas jumlah kata              (default 30)
//   BRATGIF_MAX_CHARS      batas jumlah karakter          (default 300)
// =====================================================

const envInt = (name, fallback, min, max) => {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const WORD_DELAY_MS = envInt("BRATGIF_WORD_DELAY_MS", 500, 100, 3000);
const END_HOLD_MS = envInt("BRATGIF_END_HOLD_MS", 2000, 0, 10000);
const VIDEO_SIZE = envInt("BRATGIF_SIZE", 512, 128, 1024) & ~1; // wajib genap (yuv420p)
const MAX_WORDS = envInt("BRATGIF_MAX_WORDS", 30, 1, 120);
const MAX_CHARS = envInt("BRATGIF_MAX_CHARS", 300, 10, 3000);
const OUTPUT_FPS = 15;
// Tingkat blur + "fried" khusus !gifbrat (1-100). Makin kecil = makin tajam.
// Terpisah dari BRAT_FRIED_LEVEL (punya !sbrat) supaya keduanya bisa beda.
const GIF_FRIED_LEVEL = envInt("BRATGIF_FRIED_LEVEL", 40, 1, 100);

// Render canvas di sini SINKRON & CPU-bound (satu thread untuk seluruh bot).
// Antar-frame kita "menyerahkan giliran" ke event loop supaya bot tetap bisa
// membalas pesan orang lain selagi GIF dibuat.
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// Teks -> daftar kata yang akan dianimasikan (sudah lowercase, emoji yang
// gambarnya gagal diambil sudah dibuang -- sama seperti !sbrat).
async function prepareWords(text) {
  const normalized = normalizeText(text);
  await preloadEmojisInText(normalized);
  return splitWords(stripUnavailableEmoji(normalized));
}

// Jumlah kata dari teks mentah (dipakai router buat validasi sebelum render).
function countWords(text) {
  return splitWords(text).length;
}

// Render 1 frame JPEG per kata (kumulatif: kata 1..N) ke workDir sebagai
// f0001.jpg, f0002.jpg, ... Dipakai bareng oleh versi video dan versi stiker.
async function renderFrames(words, workDir) {
  for (let i = 1; i <= words.length; i++) {
    const png = renderBratPngSync(words.slice(0, i).join(" "));
    const jpeg = await pngToFriedJpeg(png, GIF_FRIED_LEVEL, VIDEO_SIZE);
    fs.writeFileSync(
      path.join(workDir, `f${String(i).padStart(4, "0")}.jpg`),
      jpeg,
    );
    await yieldToEventLoop();
  }
}

// Tangga kualitas stiker: dicoba dari yang terbaik, turun terus sampai muat
// di bawah batas WhatsApp (~500KB). Durasi TIDAK dipotong (animasinya harus
// sampai kata terakhir), jadi yang diturunkan cuma quality & ukuran konten.
const STICKER_LADDER = [
  { quality: 70, size: 512 },
  { quality: 55, size: 512 },
  { quality: 40, size: 448 },
  { quality: 30, size: 384 },
  { quality: 20, size: 320 },
];

// Dipanggil dari router: teks -> buffer MP4 siap kirim sebagai GIF.
async function textToBratGifVideo(text) {
  const words = await prepareWords(text);
  if (words.length === 0) words.push("brat");

  const uid = crypto.randomBytes(6).toString("hex");
  const workDir = path.join(os.tmpdir(), `gifbrat-${uid}`);
  const outputPath = path.join(os.tmpdir(), `gifbrat-out-${uid}.mp4`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1) Render 1 frame per kata (kumulatif: kata 1..N).
    await renderFrames(words, workDir);

    // 2) Gabung jadi MP4. Tiap gambar tampil WORD_DELAY_MS (-framerate input
    // = 1000/delay), lalu frame terakhir ditahan END_HOLD_MS lewat tpad supaya
    // hasil akhirnya sempat terbaca sebelum GIF mengulang dari awal.
    const args = [
      "-y",
      "-framerate",
      String(1000 / WORD_DELAY_MS),
      "-i",
      path.join(workDir, "f%04d.jpg"),
      "-vf",
      `scale=${VIDEO_SIZE}:${VIDEO_SIZE},tpad=stop_mode=clone:stop_duration=${(
        END_HOLD_MS / 1000
      ).toFixed(2)},format=yuv420p`,
      "-r",
      String(OUTPUT_FPS),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-movflags",
      "+faststart",
      "-an",
      outputPath,
    ];
    await runFfmpeg(args, { quiet: true });

    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

// Dipanggil dari router: teks -> buffer stiker WebP ANIMASI siap kirim
// (sendMessage({ sticker, isAnimated: true })). Frame-nya sama persis dengan
// versi video; bedanya dikemas jadi WebP 512x512 dengan loop tak terbatas.
async function textToBratGifSticker(text) {
  const words = await prepareWords(text);
  if (words.length === 0) words.push("brat");

  const uid = crypto.randomBytes(6).toString("hex");
  const workDir = path.join(os.tmpdir(), `gifbrat-st-${uid}`);
  const outputPath = path.join(os.tmpdir(), `gifbrat-st-out-${uid}.webp`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    await renderFrames(words, workDir);

    let buffer = null;
    for (let i = 0; i < STICKER_LADDER.length; i++) {
      const step = STICKER_LADDER[i];
      // Konten diskalakan ke step.size lalu di-pad ke kanvas 512x512
      // (wajib untuk stiker WA). Frame terakhir ditahan END_HOLD_MS.
      const vf = [
        "format=rgba",
        `scale=${step.size}:${step.size}`,
        "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
        `tpad=stop_mode=clone:stop_duration=${(END_HOLD_MS / 1000).toFixed(2)}`,
      ].join(",");

      await runFfmpeg(
        [
          "-y",
          "-framerate",
          String(1000 / WORD_DELAY_MS),
          "-i",
          path.join(workDir, "f%04d.jpg"),
          "-vf",
          vf,
          "-vcodec",
          "libwebp",
          "-pix_fmt",
          "yuva420p",
          "-loop",
          "0",
          "-preset",
          "default",
          "-quality",
          String(step.quality),
          "-compression_level",
          "6",
          "-an",
          "-fps_mode",
          "cfr",
          outputPath,
        ],
        { quiet: true },
      );

      buffer = fs.readFileSync(outputPath);
      if (buffer.length <= STICKER_MAX_BYTES) break;
    }

    return buffer;
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

module.exports = {
  MAX_WORDS,
  MAX_CHARS,
  countWords,
  textToBratGifVideo,
  textToBratGifSticker,
};
