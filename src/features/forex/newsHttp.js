"use strict";

/**
 * features/forex/newsHttp.js
 * ------------------------------------------------------------------
 * Pengambil HTTP tunggal untuk modul berita/kalender forex. Dipisah supaya bisa diganti saat uji
 * tanpa jaringan (pola sama dengan _setHttp di forexMarket.js).
 * Respons selalu berupa TEKS mentah (RSS/XML/JSON di-parse sendiri), ukuran dibatasi, redirect dibatasi.
 */

const axios = require("axios");

const DEFAULT_UA = "Mozilla/5.0 (compatible; AgemasenBot/1.0; +forex-news)";
const real = (url, cfg) =>
  axios.get(url, {
    timeout: 10_000,
    maxRedirects: 3,
    maxContentLength: 3 * 1024 * 1024,
    responseType: "text",
    transformResponse: (r) => r, // jangan auto-parse JSON: parser kita sendiri yang memutuskan
    headers: { "User-Agent": DEFAULT_UA, Accept: "application/rss+xml, application/xml, application/json, text/xml, */*" },
    ...cfg,
    // header dari pemanggil digabung (bukan menimpa) supaya UA bawaan tetap ada
  });

let impl = real;

function get(url, cfg = {}) {
  const headers = { "User-Agent": DEFAULT_UA, Accept: "application/rss+xml, application/xml, application/json, text/xml, */*", ...(cfg.headers || {}) };
  return impl(url, { ...cfg, headers });
}

/** Ganti pengambil HTTP (untuk uji). Panggil tanpa argumen untuk mengembalikan yang asli. */
function _setHttp(fn) {
  impl = fn || real;
}

module.exports = { get, _setHttp };
