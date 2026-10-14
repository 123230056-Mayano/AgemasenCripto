// =====================================================
// Error khusus buat pipeline "!gif" (lihat gifService.js).
//
// Kenapa perlu class error sendiri (bukan Error biasa): gifService.js
// perlu tau ALASAN sebuah provider gagal (API key gak ada / API error /
// timeout / hasil kosong) buat mutusin apa perlu lanjut fallback ke
// provider berikutnya atau enggak, tanpa harus cek isi string message
// pakai regex di banyak tempat.
// =====================================================

// Dilempar oleh giphy.js/tenor.js kalau PROVIDER ITU SENDIRI yang gagal
// (network/timeout/rate-limit/API key invalid atau gak ada/hasil kosong).
// gifService.js menangkap ini buat mutusin lanjut coba provider lain.
class GifProviderError extends Error {
  constructor(message, { provider, reason } = {}) {
    super(message);
    this.name = "GifProviderError";
    this.provider = provider; // "giphy" | "tenor"
    this.reason = reason; // "no_api_key" | "api_error" | "timeout" | "empty"
  }
}

// Dilempar gifService.js kalau KEDUA provider (GIPHY & Tenor) sudah dicoba
// dan tetap gagal/tidak ada hasil -- inilah yang akhirnya sampai ke user
// sebagai pesan gagal (lihat router.js, command "!gif").
class NoGifFoundError extends Error {
  // i18nKey: key terjemahan (src/i18n/locales) yang dipakai router buat
  // nampilin pesan ini ke user sesuai bahasa chat-nya. `message` tetap diisi
  // (Indonesia) buat log/debug.
  constructor(message, i18nKey) {
    super(message);
    this.name = "NoGifFoundError";
    this.i18nKey = i18nKey || "gif.providerFail";
  }
}

module.exports = { GifProviderError, NoGifFoundError };
