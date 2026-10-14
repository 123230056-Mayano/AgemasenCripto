const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { searchTenor } = require("./tenor");
const { searchGiphy } = require("./giphy");
const { GifProviderError, NoGifFoundError } = require("./errors");
const { runFfmpeg } = require("../media/ffmpeg");

// =====================================================
// Fitur: cari GIF berdasarkan keyword ("!gif <keyword>")
// -----------------------------------------------------
// Command handler di router.js SENGAJA cuma manggil getRandomGif(keyword)
// dari sini dan gak tau apa-apa soal GIPHY/Tenor/cache/ffmpeg (poin 16
// spesifikasi: "Command handler hanya menangani: !gif <keyword>") --
// semua logic provider/normalisasi/fallback/random/download ada di sini.
//
// Alur lengkap:
//
//   searchGif(keyword)
//     -> cek cache dulu (TTL, lihat GIF_CACHE_TTL_MS)
//     -> Tenor (searchTenor) -- DIUTAMAKAN
//          gagal/kosong -> GIPHY (searchGiphy)
//               gagal/kosong juga -> NoGifFoundError
//     -> simpan hasil VALID ke cache, return { results, provider }
//
//   getRandomGif(keyword)  <- ini yang dipanggil router.js
//     -> searchGif(keyword)
//     -> acak urutan hasil (shuffle), coba download satu-satu dari situ
//        (maks MAX_DOWNLOAD_ATTEMPTS kali) sampai ada yang berhasil --
//        jaga-jaga kalau kebetulan URL yang kepilih random itu rusak/mati
//     -> kalau formatnya bukan mp4 (jarang terjadi, lihat komentar di
//        ensureMp4Buffer), convert dulu pakai ffmpeg
//     -> return Buffer siap kirim
// =====================================================

// -----------------------------------------------------
// 1) CACHE sederhana per-keyword (in-memory, hilang kalau bot restart --
//    itu gak masalah, cache ini murni buat nahan spam API jangka pendek,
//    bukan penyimpanan permanen).
// -----------------------------------------------------
// TTL 10 menit -- di tengah rentang 5-15 menit yang diminta spesifikasi.
const GIF_CACHE_TTL_MS = 10 * 60 * 1000;
const gifCache = new Map();

function normalizeKeyword(keyword) {
  return keyword.trim().toLowerCase().replace(/\s+/g, " ");
}

function getCached(key) {
  const entry = gifCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > GIF_CACHE_TTL_MS) {
    gifCache.delete(key);
    return null;
  }
  return entry;
}

function setCached(key, results, provider) {
  gifCache.set(key, { results, provider, timestamp: Date.now() });
}

function isValidGif(item) {
  return Boolean(item && item.mediaUrl);
}

// -----------------------------------------------------
// 2) SEARCH: Tenor DIUTAMAKAN, fallback GIPHY kalau Tenor gagal/kosong.
//    Random TIDAK dilakukan di sini (poin 13 spesifikasi: random harus
//    terjadi SETELAH hasil pencarian didapat) -- itu tugas getRandomGif()
//    di bawah.
// -----------------------------------------------------
async function searchGif(rawKeyword) {
  const cacheKey = normalizeKeyword(rawKeyword);

  const cached = getCached(cacheKey);
  if (cached) {
    console.log(
      `[GIF] Cache hit: "${cacheKey}" (provider sebelumnya: ${cached.provider})`,
    );
    return { results: cached.results, provider: cached.provider };
  }

  console.log(`[GIF] Query: ${cacheKey}`);

  let tenorFailReason = null;
  try {
    const tenorResults = await searchTenor(cacheKey);
    console.log("[GIF] Provider: Tenor");
    console.log(`[GIF] Results: ${tenorResults.length}`);

    const valid = tenorResults.filter(isValidGif);
    console.log(`[GIF] Valid: ${valid.length}`);

    if (valid.length > 0) {
      setCached(cacheKey, valid, "tenor");
      return { results: valid, provider: "tenor" };
    }

    tenorFailReason = "empty";
  } catch (err) {
    tenorFailReason =
      err instanceof GifProviderError ? err.reason : "api_error";
    console.log(`[GIF] Tenor failed (${tenorFailReason}): ${err.message}`);
  }

  console.log("[GIF] Falling back to GIPHY");

  let giphyFailReason = null;
  try {
    const giphyResults = await searchGiphy(cacheKey);
    console.log(`[GIF] GIPHY results: ${giphyResults.length}`);

    const valid = giphyResults.filter(isValidGif);
    console.log(`[GIF] Valid: ${valid.length}`);

    if (valid.length > 0) {
      setCached(cacheKey, valid, "giphy");
      return { results: valid, provider: "giphy" };
    }

    giphyFailReason = "empty";
  } catch (err) {
    giphyFailReason =
      err instanceof GifProviderError ? err.reason : "api_error";
    console.log(`[GIF] GIPHY failed (${giphyFailReason}): ${err.message}`);
  }

  // Tenor sekarang scraping (lihat tenor.js), jadi gak punya reason
  // "no_api_key" lagi -- satu-satunya provider yang masih butuh env var
  // adalah GIPHY. Kalau GIPHY emang belum dikonfigurasi DAN Tenor
  // (scraping, provider utama) tetap gagal/kosong juga, kasih tau owner
  // biar langsung ngerti harus benerin ENV VAR GIPHY, bukan keduanya lagi
  // down.
  if (giphyFailReason === "no_api_key") {
    throw new NoGifFoundError(
      "⚙️ GIPHY_API_KEY belum di-set (Tenor tetap dicoba duluan, tapi gagal/kosong juga barusan). Set env var GIPHY_API_KEY buat fallback yang lebih lengkap.",
      "gif.noApiKey",
    );
  }

  throw new NoGifFoundError("GIF nggak ketemu atau providernya lagi ngambek.", "gif.providerFail");
}

// Dipisah jadi fungsi sendiri (bukan cuma dipakai inline di getRandomGif)
// SESUAI poin 5/13 spesifikasi yang eksplisit ngasih contoh nama fungsi
// ini -- gampang diuji/dipakai ulang terpisah dari getRandomGif kalau
// suatu saat perlu (mis. buat command lain yang butuh "1 GIF random dari
// hasil pencarian yang SUDAH ada", tanpa nyari ulang).
function pickRandomGif(results) {
  return results[Math.floor(Math.random() * results.length)];
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// -----------------------------------------------------
// 3) DOWNLOAD media hasil pencarian jadi Buffer.
//    TIDAK nulis ke temporary file (langsung in-memory pakai axios
//    responseType "arraybuffer") -- sama polanya kayak downloadImage() di
//    features/booru/safebooru.js, cukup buat ukuran GIF/video yang
//    normalnya cuma ratusan KB - beberapa MB. Temp file baru dipakai nanti
//    di ensureMp4Buffer(), KHUSUS buat kebutuhan ffmpeg (lihat komentar
//    di sana).
// -----------------------------------------------------
const GIF_DOWNLOAD_TIMEOUT_MS = 15000;
// GIF/video hasil GIPHY/Tenor normalnya cuma beberapa ratus KB sampai
// beberapa MB -- 20MB jauh di atas itu, cukup buat jaga-jaga (poin 7 & 17
// spesifikasi: batasi ukuran download) tanpa bikin bot ngunduh file
// raksasa gara-gara URL yang aneh/salah.
const GIF_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ["video/mp4", "image/gif", "image/webp"];

function mimetypeFromContentType(contentType) {
  if (!contentType) return null;
  return contentType.split(";")[0].trim().toLowerCase();
}

// Return { buffer, mimetype }. Melempar Error BIASA (bukan GifProviderError
// -- di titik ini provider sudah dipilih & hasil pencarian sudah final,
// gak ada lagi provider lain buat di-fallback, jadi gak perlu dibedain
// alasannya kayak GifProviderError).
async function downloadGif(url) {
  let res;
  try {
    res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: GIF_DOWNLOAD_TIMEOUT_MS,
      maxContentLength: GIF_MAX_DOWNLOAD_BYTES,
      maxBodyLength: GIF_MAX_DOWNLOAD_BYTES,
    });
  } catch (err) {
    if (
      err.code === "ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED" ||
      /maxContentLength/i.test(err.message || "")
    ) {
      throw new Error("File GIF-nya kegedean, di atas batas yang diizinkan.");
    }
    throw new Error(`Gagal download GIF: ${err.message}`);
  }

  const contentType = mimetypeFromContentType(res.headers?.["content-type"]);
  if (
    contentType &&
    !ALLOWED_CONTENT_TYPES.some((t) => contentType.startsWith(t))
  ) {
    throw new Error(`Tipe media GIF tidak didukung: ${contentType}`);
  }

  const buffer = Buffer.from(res.data);
  if (!buffer || buffer.length === 0) {
    throw new Error("File GIF kosong setelah diunduh.");
  }

  return { buffer, mimetype: contentType || "video/mp4" };
}

// -----------------------------------------------------
// 4) Pastikan hasil akhirnya video mp4 (format yang paling kompatibel
//    dikirim ke WhatsApp sbg "GIF" -- video+gifPlayback, sama kayak
//    !togif). GIPHY & TENOR SELALU ditanya varian mp4 duluan (lihat
//    pickBestMediaUrl di giphy.js/tenor.js), jadi fungsi ini praktiknya
//    JARANG kepakai beneran -- cuma jaring pengaman kalau suatu entri
//    kebetulan gak punya varian mp4 sama sekali sehingga downloadGif()
//    kepaksa fallback ke gif/webp mentah. WhatsApp/Baileys TIDAK bisa
//    muterin file gif/webp mentah lewat field "video" (butuh kontainer
//    video beneran), makanya dikonversi dulu di sini -- pola PERSIS sama
//    kayak animatedStickerToGifVideo() di features/media/sticker.js.
// -----------------------------------------------------
const EXT_BY_MIMETYPE = {
  "image/gif": ".gif",
  "image/webp": ".webp",
};

async function ensureMp4Buffer(buffer, mimetype) {
  if (mimetype && mimetype.startsWith("video/")) {
    return buffer;
  }

  const ext = EXT_BY_MIMETYPE[mimetype] || ".gif";
  const tmpDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(tmpDir, `gifcmd-in-${uid}${ext}`);
  const outputPath = path.join(tmpDir, `gifcmd-out-${uid}.mp4`);
  fs.writeFileSync(inputPath, buffer);

  try {
    await runFfmpeg(
      [
        "-y",
        "-i",
        inputPath,
        "-movflags",
        "+faststart",
        "-pix_fmt",
        "yuv420p",
        // Lebar/tinggi wajib genap buat yuv420p.
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-an",
        outputPath,
      ],
      // quiet: redam log verbose ffmpeg (lihat komentar di runFfmpeg) --
      // item WebP korup dari Tenor bisa ngedump banyak baris log
      // per-thread/per-frame tiap gagal, dan berkat retry pool di bawah
      // ini SEKARANG bisa kejadian berkali-kali beruntun per request user.
      { quiet: true },
    );
    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

// -----------------------------------------------------
// 5) Pipeline lengkap yang dipanggil router.js: search -> random -> (kalau
//    download gagal, coba lagi hasil random lain, maks MAX_DOWNLOAD_ATTEMPTS
//    kali -- jaga-jaga URL yang kepilih random kebetulan rusak/mati) ->
//    pastikan mp4. Return { buffer, provider, title, keyword }.
// -----------------------------------------------------
const MAX_DOWNLOAD_ATTEMPTS = 3;

async function getRandomGif(rawKeyword) {
  const keyword = rawKeyword.trim().replace(/\s+/g, " ");
  const { results, provider } = await searchGif(keyword);

  const candidates = shuffle(results).slice(
    0,
    Math.min(MAX_DOWNLOAD_ATTEMPTS, results.length),
  );

  let lastErr;
  for (const selected of candidates) {
    console.log(`[GIF] Selected: ${selected.id}`);
    console.log("[GIF] Downloading...");

    try {
      const downloaded = await downloadGif(selected.mediaUrl);
      const videoBuffer = await ensureMp4Buffer(
        downloaded.buffer,
        downloaded.mimetype,
      );
      return { buffer: videoBuffer, provider, title: selected.title, keyword };
    } catch (err) {
      lastErr = err;
      console.log(
        `[GIF] Download gagal (${selected.mediaUrl}): ${err.message}`,
      );
    }
  }

  console.log(
    `[GIF] Semua percobaan download gagal. Error terakhir: ${lastErr?.message}`,
  );
  throw new NoGifFoundError("GIF nggak ketemu atau providernya lagi ngambek.", "gif.providerFail");
}

// -----------------------------------------------------
// 6) Sesi pooled per-keyword -- SUPAYA "!gif <keyword>" bisa numpang ke
//    mekanisme session/"!next"/kode-sesi yang sama kayak "!img"/"!pin"
//    (lihat newCandidateSession/loadMoreCandidates di
//    features/booru/safebooru.js buat pola aslinya, dan
//    newPinterestSession/loadMorePinterestCandidates di
//    features/pinterest/pinterest.js buat contoh provider lain yang sudah
//    numpang ke pola yang sama).
//
//    Bedanya dari Safebooru/Pinterest: "halaman" di sini BUKAN next-page
//    asli dari provider -- baik scraping Tenor maupun search GIPHY di atas
//    cuma narik SATU batch hasil per keyword (gak ada cursor/bookmark asli
//    kayak Pinterest atau pid kayak Safebooru). Jadi pool-nya diisi dari
//    satu pemanggilan searchGif() (yang sendiri sudah gabungan
//    Tenor->fallback GIPHY, dengan cache 10 menit -- lihat GIF_CACHE_TTL_MS
//    di atas), lalu tiap "!next"/kode-sesi ngambil random dari batch itu
//    (lewat pickRandom() generik punya safebooru.js) sampai batch-nya
//    habis. Begitu habis, refillPool() di router.js reset seenIds & narik
//    ulang searchGif() -- karena biasanya masih dalam TTL cache, hasilnya
//    balik yang SAMA, jadi keliatan "muter ulang dari awal" (pesan generik
//    "sudah pernah semua, mulai ulang" yang sama kayak !img/!pin).
// -----------------------------------------------------
function newGifSession(keyword) {
  return {
    source: "gif",
    tag: keyword,
    pool: [],
    seenIds: new Set(),
    noMore: false,
  };
}

// Isi ulang session.pool dengan hasil BARU (belum ada di seenIds) dari
// searchGif(). Return true kalau berhasil (ada hasil buat dikirim), false
// kalau memang tidak ada hasil valid sama sekali buat keyword ini (atau
// batch yang ada sudah habis semua).
async function loadMoreGifCandidates(session) {
  if (session.noMore) return false;

  const { results } = await searchGif(session.tag);

  const fresh = results.filter((r) => !session.seenIds.has(String(r.id)));

  if (fresh.length > 0) {
    session.pool.push(...fresh);
    return true;
  }

  session.noMore = true;
  return false;
}

// Download 1 hasil GIF terpilih (item dari pool, sudah di-pickRandom() di
// router.js) sampai jadi Buffer video mp4 siap kirim -- gabungan
// downloadGif() + ensureMp4Buffer() yang sudah ada di atas, dipisah jadi
// fungsi sendiri supaya router.js/safebooru.js gak perlu tau soal
// ensureMp4Buffer sama sekali (poin 16 spesifikasi: command handler cuma
// nyentuh pipeline lewat gifService.js).
async function downloadGifPost(post) {
  const { buffer, mimetype } = await downloadGif(post.mediaUrl);
  return ensureMp4Buffer(buffer, mimetype);
}

// Berapa kali maksimal coba item LAIN dari pool session kalau satu item
// gagal diproses (download gagal, atau ffmpeg crash pas convert -- lihat
// komentar panjang soal WebP korup Tenor di ensureMp4Buffer). Angkanya
// disamain sama MAX_DOWNLOAD_ATTEMPTS punya getRandomGif() (poin 13
// spesifikasi: jaga-jaga kalau item yang kepilih random kebetulan
// rusak/mati), supaya perilakunya konsisten dari sisi user baik dia lagi
// pertama kali "!gif <keyword>" maupun lanjut "!next"/kode sesi.
const GIF_POOL_DOWNLOAD_ATTEMPTS = MAX_DOWNLOAD_ATTEMPTS;

// Ambil 1 GIF dari pool session dan download sampai jadi Buffer siap
// kirim, OTOMATIS coba item lain di pool kalau item yang kepilih gagal
// diproses -- sampai GIF_POOL_DOWNLOAD_ATTEMPTS kali atau sampai pool-nya
// keburu habis duluan.
//
// SEBELUM ADA FUNGSI INI, pemanggil (searchAndSendImage/!next/kode sesi)
// cuma nyoba 1 item pool via pickRandom()+downloadGifPost(), dan kalau
// GAGAL (mis. ffmpeg exit code 69 gara-gara WebP animasi korup) errornya
// langsung dilempar ke user & di-console.log() penuh (stderr ffmpeg
// ikutan kebawa) -- beda dari getRandomGif() yang dari awal memang sudah
// auto-retry ke kandidat lain. User yang kena error kemungkinan besar
// spam ulang command, dan tiap kali gagal ffmpeg nyetak banyak baris
// sekaligus -> ini yang bikin kena limit 500 log/detik Railway
// ("Messages dropped"). Fungsi ini nyamain perilaku pool (!next/kode
// sesi) dengan getRandomGif(), jadi user cuma lihat error kalau BENERAN
// semua percobaan gagal.
//
// `pickRandomFn` di-INJECT dari pemanggil (bukan di-require langsung dari
// safebooru.js) supaya gifService.js gak perlu import balik dari
// safebooru.js (yang sendiri sudah import gifService.js) -- hindarin
// circular dependency.
async function downloadGifFromPool(session, pickRandomFn) {
  let lastErr;
  let attempts = 0;

  while (attempts < GIF_POOL_DOWNLOAD_ATTEMPTS && session.pool.length > 0) {
    attempts++;
    const post = pickRandomFn(session);

    try {
      const buffer = await downloadGifPost(post);
      return { buffer, post };
    } catch (err) {
      lastErr = err;
      console.log(
        `[GIF] Item pool gagal diproses (${post.mediaUrl}): ${err.message}`,
      );
    }
  }

  console.log(
    `[GIF] Semua percobaan pool gagal (${attempts}x). Error terakhir: ${lastErr?.message}`,
  );
  throw new NoGifFoundError("GIF nggak ketemu atau providernya lagi ngambek.", "gif.providerFail");
}

module.exports = {
  GIF_CACHE_TTL_MS,
  GIF_DOWNLOAD_TIMEOUT_MS,
  GIF_MAX_DOWNLOAD_BYTES,
  searchGif,
  pickRandomGif,
  downloadGif,
  getRandomGif,
  newGifSession,
  loadMoreGifCandidates,
  downloadGifPost,
  downloadGifFromPool,
  GIF_POOL_DOWNLOAD_ATTEMPTS,
};
