const axios = require("axios");
const { GifProviderError } = require("./errors");

// =====================================================
// Provider GIF: GIPHY (dipakai duluan, lihat gifService.js buat urutan
// fallback-nya ke Tenor).
//
// Dokumentasi resmi: https://developers.giphy.com/docs/api/endpoint/#search
// =====================================================
const GIPHY_TIMEOUT_MS = 10000;
// 50 = batas MAKSIMAL yang diizinkan endpoint search resmi GIPHY (limit
// default mereka cuma 25 kalau parameter ini gak dikirim). Ini beda dari
// Tenor di atas: GIPHY beneran punya parameter "limit" di API resminya,
// jadi di sini kita minta SEBANYAK YANG DIIZINKAN, bukan "semua yang ada"
// (gak ada konsep "semua" di API search berbayar/rate-limited kayak gini
// -- GIPHY sendiri yang bakal nolak/motong kalau angkanya di atas 50).
const GIPHY_SEARCH_LIMIT = 50;
// "pg-13" -- cukup aman buat grup WA campuran (keluarga/kerja/teman) tanpa
// terlalu ketat kayak "g" (yang bikin banyak keyword umum jadi kering
// hasilnya). Rating GIPHY: g, pg, pg-13, r.
const GIPHY_RATING = "pg-13";

// Tiap item GIPHY punya banyak "rendition" di bawah `images` (original,
// fixed_height, downsized, dst), dan tiap rendition itu punya beberapa
// varian FORMAT (url = gif mentah, mp4, webp). Kita ambil dari rendition
// "original" (paling gede/gak di-downscale) dan prioritaskan mp4 dulu
// (poin 6 spesifikasi -- paling kompatibel dikirim sbg video+gifPlayback
// di WhatsApp/Baileys), baru gif mentah, baru webp kalau kepepet banget.
function pickBestMediaUrl(images) {
  return (
    images?.original?.mp4 ||
    images?.original?.url ||
    images?.original?.webp ||
    null
  );
}

// Cari GIF di GIPHY buat sebuah keyword. Return array hasil yang SUDAH
// dinormalisasi ke format internal (lihat komentar panjang soal ini di
// gifService.js) -- item yang ternyata gak punya media URL valid sama
// sekali langsung dibuang di sini (poin 5 spesifikasi: "filter result yang
// tidak memiliki media URL yang valid").
//
// Melempar GifProviderError (BUKAN error axios mentah) kalau API key gak
// ada atau request-nya gagal -- caller (gifService.js) yang mutusin mau
// fallback ke Tenor atau enggak berdasarkan error ini.
async function searchGiphy(keyword, { limit = GIPHY_SEARCH_LIMIT } = {}) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    throw new GifProviderError("GIPHY_API_KEY belum di-set.", {
      provider: "giphy",
      reason: "no_api_key",
    });
  }

  let res;
  try {
    res = await axios.get("https://api.giphy.com/v1/gifs/search", {
      params: {
        api_key: apiKey,
        q: keyword,
        limit,
        rating: GIPHY_RATING,
        lang: "id",
      },
      timeout: GIPHY_TIMEOUT_MS,
    });
  } catch (err) {
    const isTimeout =
      err.code === "ECONNABORTED" || /timeout/i.test(err.message || "");
    throw new GifProviderError(`GIPHY request gagal: ${err.message}`, {
      provider: "giphy",
      reason: isTimeout ? "timeout" : "api_error",
    });
  }

  const items = Array.isArray(res.data?.data) ? res.data.data : [];

  return items
    .map((item) => ({
      id: item.id,
      title: item.title || "",
      previewUrl:
        item.images?.preview_gif?.url ||
        item.images?.fixed_width_small?.url ||
        null,
      mediaUrl: pickBestMediaUrl(item.images),
      width: Number(item.images?.original?.width) || null,
      height: Number(item.images?.original?.height) || null,
      source: "giphy",
    }))
    .filter((g) => g.mediaUrl);
}

module.exports = { searchGiphy, GIPHY_SEARCH_LIMIT, GIPHY_TIMEOUT_MS };
