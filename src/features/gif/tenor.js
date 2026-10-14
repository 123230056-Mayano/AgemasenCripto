const axios = require("axios");
const { GifProviderError } = require("./errors");
const { normalizeQuery, buildTenorSearchUrl, removeDuplicateResults } = require("./tenorUtils");
const { parseTenorHtml } = require("./tenorParser");

// =====================================================
// Provider GIF: Tenor (fallback kalau GIPHY gagal/kosong -- lihat
// gifService.js).
//
// GANTI TOTAL dari versi lama (Tenor API v2 resmi pakai TENOR_API_KEY) ke
// versi SCRAPING, logikanya diadaptasi dari proyek "TENOR-Scrapper" milik
// user (src/lib/tenor/{scraper,parser,utils}.ts) -- lihat tenorParser.js
// dan tenorUtils.js buat parsing/validasi/dedup yang dipindah APA ADANYA.
//
// SATU PERBEDAAN SENGAJA dari scraper aslinya: scraper asli pakai
// Playwright (headless Chromium) buat buka tenor.com/search/<query>, lalu
// scroll beberapa kali biar grid hasil yang lazy-load ikut ke-load sebelum
// HTML-nya dibaca. Di bot ini kita GAK pakai Playwright -- fetch HTML-nya
// pakai request HTTP biasa (axios) doang, tanpa render/scroll browser.
// Alasannya: headless Chromium itu dependency berat (perlu install
// Chromium + banyak lib sistem) yang gak cocok jalan bareng bot WhatsApp di
// Railway (bikin build/deploy jauh lebih berat & rawan gagal) -- lihat
// nixpacks.toml buat gambaran constraint deploy project ini.
//
// Konsekuensinya: hasil yang kekumpul cuma dari HTML yang di-serve Tenor
// di request pertama (initial/SSR), TANPA hasil tambahan yang harusnya
// muncul kalau halamannya di-scroll manual di browser asli. Kalau suatu
// saat Tenor ternyata gak nyertain cukup data di initial HTML (mis. grid
// hasil di-render 100% client-side lewat JS tanpa SSR sama sekali), 4
// strategi parsing di tenorParser.js bisa aja return kosong -- di titik itu
// searchTenor() bakal return array kosong (bukan error), dan gifService.js
// yang udah nangani "hasil provider kosong" bakal lanjut ke alur gagal
// normalnya (lihat NoGifFoundError di sana).
//
// Karena ini scraping (bukan API resmi), TIDAK ada API key yang dibutuhkan
// sama sekali -- beda dari giphy.js yang masih butuh GIPHY_API_KEY.
// =====================================================
const TENOR_TIMEOUT_MS = 15000;
// Sengaja TANPA batas atas artifisial di sini -- beda dari dulu (dipotong
// ke 10 lewat parsed.slice()). Karena ini scraping (bukan API dengan
// parameter "limit" beneran), jumlah hasil yang ada MEMANG sudah dibatasi
// sendiri sama berapa banyak yang ke-render di HTML awal Tenor sebelum
// di-scroll (lihat komentar panjang soal ini di atas) -- jadi gak ada
// gunanya motong lagi di sisi kita, ambil aja SEMUA yang berhasil di-parse
// & valid (ada mediaUrl-nya).
const TENOR_SEARCH_LIMIT = Infinity;

// User-Agent browser Chrome biasa -- MATCH persis sama yang dipakai di
// scraper.ts aslinya, supaya server Tenor nganggep ini request dari browser
// asli, bukan script/bot kosong.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Ambil raw HTML dari halaman pencarian publik Tenor buat query yang SUDAH
// dinormalisasi. Melempar GifProviderError kalau network-nya gagal/timeout,
// atau kalau Tenor keliatan mem-blok/rate-limit/nampilin captcha -- SAMA
// PERSIS filosofinya kayak fetchTenorSearchHtml() di scraper.ts asli: kalau
// kedetek anti-bot challenge, kita LANGSUNG berhenti, GAK pernah nyoba
// bypass captcha apa pun caranya.
async function fetchTenorSearchHtml(query) {
  const url = buildTenorSearchUrl(query);

  let res;
  try {
    res = await axios.get(url, {
      timeout: TENOR_TIMEOUT_MS,
      responseType: "text",
      // Biar status non-2xx (403/429/503 dll) gak langsung ngelempar dari
      // axios -- kita perlu bedain reason-nya secara manual di bawah
      // (blocked vs error biasa), bukan cuma "request gagal" generik.
      validateStatus: () => true,
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
  } catch (err) {
    const isTimeout = err.code === "ECONNABORTED" || /timeout/i.test(err.message || "");
    throw new GifProviderError(`Tenor scrape gagal: ${err.message}`, {
      provider: "tenor",
      reason: isTimeout ? "timeout" : "api_error",
    });
  }

  // Respons gaya anti-bot/rate-limit. TIDAK dicoba di-workaround -- cuma
  // dilaporin sbg error yang jelas (persis komentar di scraper.ts asli).
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw new GifProviderError(`Tenor blokir/rate-limit request ini (HTTP ${res.status}).`, {
      provider: "tenor",
      reason: "blocked",
    });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new GifProviderError(`Tenor merespons HTTP ${res.status}.`, {
      provider: "tenor",
      reason: "api_error",
    });
  }

  const html = typeof res.data === "string" ? res.data : String(res.data ?? "");

  // Deteksi ringan halaman CAPTCHA/block -- kalau kedetek, berhenti di
  // sini, JANGAN dilanjut ke parsing sama sekali.
  const lower = html.toLowerCase();
  if (
    lower.includes("captcha") &&
    (lower.includes("verify you are human") || lower.includes("checking your browser"))
  ) {
    throw new GifProviderError("Tenor nampilin tantangan anti-bot (captcha).", {
      provider: "tenor",
      reason: "blocked",
    });
  }

  return html;
}

// Cari GIF di Tenor (via scraping halaman pencarian publiknya) buat sebuah
// keyword. Return array hasil yang sudah dinormalisasi ke format internal
// yang SAMA PERSIS strukturnya kayak searchGiphy() (lihat komentar panjang
// soal ini di gifService.js), jadi command handler & gifService.js gak
// perlu tau apa-apa soal bedanya struktur asli GIPHY vs Tenor, ATAUPUN
// soal Tenor sekarang scraping bukan API resmi lagi.
async function searchTenor(keyword, { limit = TENOR_SEARCH_LIMIT } = {}) {
  const normalizedQuery = normalizeQuery(keyword);
  if (!normalizedQuery) {
    throw new GifProviderError("Keyword Tenor tidak valid.", {
      provider: "tenor",
      reason: "api_error",
    });
  }

  const html = await fetchTenorSearchHtml(normalizedQuery);

  let parsed;
  try {
    parsed = removeDuplicateResults(parseTenorHtml(html));
  } catch (err) {
    throw new GifProviderError(`Gagal parse hasil Tenor: ${err.message}`, {
      provider: "tenor",
      reason: "api_error",
    });
  }

  return parsed.slice(0, limit).map((item) => ({
    id: item.id,
    title: item.title || "",
    previewUrl: item.previewUrl || item.mediaUrl || null,
    mediaUrl: item.mediaUrl || null,
    width: item.width || null,
    height: item.height || null,
    source: "tenor",
  })).filter((g) => g.mediaUrl);
}

module.exports = { searchTenor, TENOR_SEARCH_LIMIT, TENOR_TIMEOUT_MS };
