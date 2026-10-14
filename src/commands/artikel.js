"use strict";

/**
 * commands/artikel.js
 * ------------------------------------------------------------------
 * Command "!artikel" / "!article" -- pencarian publikasi ilmiah + (untuk
 * link) Article/Document Downloader.
 *
 * Mode input (lihat parseArticleInput di services/journal):
 *   !artikel <kata kunci> [-n 5] -> OpenAlex -> Crossref -> Unpaywall -> arXiv
 *                                   (-n = jumlah hasil, default 3, maks 10)
 *   !artikel doi <DOI>         -> metadata DOI + sitasi + PDF legal
 *   !artikel arxiv <kata kunci>-> cari preprint di arXiv
 *   !artikel <URL>             -> alur lama (downloader, di bawah)
 *
 * File ini punya DUA lapisan yang sengaja dipisah:
 *
 *   1. handleArticleCommand(message, url)  -- LOGIC MURNI, gak nyentuh
 *      Baileys/WhatsApp sama sekali. Return objek terstruktur (lihat
 *      README/spesifikasi). Ini yang gampang di-unit-test.
 *
 *   2. runArtikelCommand(sock, jid, url, senderId) -- WRAPPER integrasi
 *      WhatsApp: kirim pesan progress, panggil handleArticleCommand(),
 *      lalu kirim hasil akhirnya (dokumen atau teks) + bersihkan file
 *      temporary + rate limiting per user.
 *
 * Alur mode URL (alur lama, tidak berubah):
 *   validasi URL -> deteksi provider -> ambil metadata -> cek file
 *   publik langsung -> kalau ada: download & kirim -> kalau gak ada:
 *   cari Open Access resmi -> kalau ketemu: kirim link -> kalau gak:
 *   kirim link artikel asli.
 */

const fs = require("fs");
const { t } = require("../i18n");

const { assertSafeToFetch } = require("../utils/validation");
const { findProviderForUrl } = require("../providers");
const { downloadDocument, safeUnlink, safeRmdir } = require("../services/pdfDownloader");
const { findOpenAccess } = require("../services/openAccessFinder");
const { parseArticleInput, searchJournal, lookupDoi, searchArxiv } = require("../services/journal");
const { formatJournalReply } = require("../services/journal/format");

// =====================================================
// Rate limiting per user (in-memory, sederhana).
// -- Batasi: minimal jeda N detik antar request, dan gak boleh nembak
//    request baru selagi request sebelumnya (dari user yang sama)
//    masih diproses.
// =====================================================
const RATE_LIMIT_COOLDOWN_MS = 20_000; // 20 detik antar-request per user
const lastRequestAt = new Map(); // senderId -> timestamp
const inFlight = new Set(); // senderId yang requestnya lagi jalan

function checkRateLimit(senderId, lang) {
  if (!senderId) return { allowed: true };

  if (inFlight.has(senderId)) {
    return {
      allowed: false,
      reason: t(lang, "art.busy"),
    };
  }

  const last = lastRequestAt.get(senderId);
  if (last && Date.now() - last < RATE_LIMIT_COOLDOWN_MS) {
    const remainingSec = Math.ceil((RATE_LIMIT_COOLDOWN_MS - (Date.now() - last)) / 1000);
    return {
      allowed: false,
      reason: t(lang, "art.cooldown", { sec: remainingSec }),
    };
  }

  return { allowed: true };
}

// =====================================================
// 1) LOGIC MURNI -- tidak menyentuh Baileys sama sekali.
// =====================================================

/**
 * @param {object} message - konteks pesan asal (opsional, dipakai buat logging).
 * @param {string} url - URL artikel/dokumen yang mau diproses.
 * @param {object} [opts]
 * @param {(text: string) => void} [opts.onProgress] - callback dipanggil
 *   di tiap tahap proses (buat kirim status "⏳ ..." ke user).
 * @returns {Promise<object>} salah satu dari:
 *   { success: true, title, provider, filePath, sourceUrl }               (file didownload)
 *   { success: true, title, provider, filePath: null, pdfUrl, sourceUrl } (cuma link OA)
 *   { success: false, reason, sourceUrl, message }                        (gagal)
 */
async function handleArticleCommand(message, url, opts = {}) {
  const lang = opts.lang;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};

  // --- Validasi URL (bentuk + anti-SSRF) ---
  try {
    await assertSafeToFetch(url);
  } catch (err) {
    return {
      success: false,
      reason: "INVALID_URL",
      sourceUrl: url,
      message: err.message,
    };
  }

  onProgress(t(lang, "art.detecting"));

  // --- Deteksi provider yang cocok ---
  let provider;
  try {
    provider = await findProviderForUrl(url);
  } catch (err) {
    return {
      success: false,
      reason: "PROVIDER_DETECTION_FAILED",
      sourceUrl: url,
      message: err.message,
    };
  }

  if (!provider) {
    // Seharusnya gak pernah kejadian (GenericProvider selalu fallback),
    // tapi dijaga juga buat keamanan.
    return { success: false, reason: "NO_PROVIDER", sourceUrl: url };
  }

  // --- Ambil metadata (judul, DOI, dll) ---
  let metadata = null;
  try {
    metadata = await provider.getMetadata(url);
  } catch (err) {
    console.log(`[artikel] getMetadata gagal (${provider.name}):`, err.message);
  }
  const title = metadata?.title || null;
  const doi = metadata?.doi || null;

  onProgress(t(lang, "art.findingPdf"));

  // --- Cek apakah ada file publik langsung dari provider ---
  let downloadUrl = null;
  try {
    downloadUrl = await provider.getDownloadUrl(url);
  } catch (err) {
    console.log(`[artikel] getDownloadUrl gagal (${provider.name}):`, err.message);
  }

  if (downloadUrl) {
    try {
      const { filePath } = await downloadDocument(downloadUrl, { suggestedTitle: title });
      return {
        success: true,
        title: title || t(lang, "art.untitled"),
        provider: provider.name,
        filePath,
        sourceUrl: url,
      };
    } catch (err) {
      console.log(`[artikel] download file gagal:`, err.message);
      // Jangan langsung nyerah -- lanjut coba Open Access Finder di bawah,
      // siapa tahu ada versi lain yang lebih bisa diakses.
    }
  }

  // --- Fallback: cari versi Open Access resmi lewat DOI/judul ---
  onProgress(t(lang, "art.findingOA"));

  let openAccess = null;
  try {
    openAccess = await findOpenAccess({ title, doi });
  } catch (err) {
    console.log("[artikel] openAccessFinder gagal:", err.message);
  }

  if (openAccess?.pdfUrl) {
    return {
      success: true,
      title: title || openAccess.title || t(lang, "art.untitled"),
      provider: "Open Access",
      filePath: null,
      pdfUrl: openAccess.pdfUrl,
      sourceUrl: url,
    };
  }

  // --- Gak ketemu apa pun yang bisa diakses publik & legal ---
  return {
    success: false,
    reason: "PUBLIC_FILE_NOT_FOUND",
    sourceUrl: url,
    title,
  };
}

// =====================================================
// 1b) LOGIC MURNI mode pencarian jurnal (keyword / DOI / arXiv).
// =====================================================

/**
 * @param {{mode:string, query?:string, doi?:string}} parsed - hasil parseArticleInput().
 * @param {object} [opts]
 * @param {(stage: string) => void} [opts.onProgress] - dipanggil dengan "enriching"
 *   begitu pencarian awal selesai & pengayaan (Crossref/Unpaywall/arXiv) mulai.
 * @returns {Promise<object>} { mode, query|doi, results[], failed[], rateLimited[], allFailed }
 */
async function handleJournalCommand(parsed, opts = {}) {
  const { onProgress } = opts;
  if (parsed.mode === "doi") return lookupDoi(parsed.doi, { onProgress });
  if (parsed.mode === "arxiv") return searchArxiv(parsed.query, { limit: parsed.limit });
  return searchJournal(parsed.query, { limit: parsed.limit, onProgress });
}

// =====================================================
// 2) WRAPPER integrasi WhatsApp (Baileys) -- panggil ini dari index.js.
// =====================================================

async function runJournalFlow(sock, jid, parsed, lang) {
  const searchingKey =
    parsed.mode === "doi" ? "art.lookingUpDoi" : parsed.mode === "arxiv" ? "art.searchingArxiv" : "art.searching";
  await sock.sendMessage(jid, { text: t(lang, searchingKey) });

  let enrichingSent = false;
  const outcome = await handleJournalCommand(parsed, {
    onProgress: (stage) => {
      if (stage !== "enriching" || enrichingSent) return;
      enrichingSent = true;
      sock.sendMessage(jid, { text: t(lang, "art.enriching") }).catch((err) => {
        console.log("[artikel] gagal kirim progress:", err.message);
      });
    },
  });

  await sock.sendMessage(jid, { text: formatJournalReply(t, lang, outcome) });
}

async function runUrlFlow(sock, jid, url, lang, state) {
  await sock.sendMessage(jid, { text: t(lang, "art.processing") });

  const result = await handleArticleCommand({ jid }, url, {
    lang,
    onProgress: (text) => {
      // fire-and-forget -- gak perlu di-await berurutan biar gak nge-blok,
      // tapi tetap ditangkap errornya biar gak jadi unhandled rejection.
      sock.sendMessage(jid, { text }).catch((err) => {
        console.log("[artikel] gagal kirim progress:", err.message);
      });
    },
  });

  if (result.success && result.filePath) {
    state.workDirToClean = require("path").dirname(result.filePath);

    await sock.sendMessage(jid, {
      text: t(lang, "art.found", { title: result.title, provider: result.provider }),
    });

    const buffer = fs.readFileSync(result.filePath);
    const fileName = require("path").basename(result.filePath);

    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: "application/pdf",
      fileName,
      caption: t(lang, "art.caption", { title: result.title, url: result.sourceUrl }),
    });

    // Spec: hapus file setelah berhasil dikirim.
    safeUnlink(result.filePath);
    safeRmdir(state.workDirToClean);
    return;
  }

  if (result.success && result.pdfUrl) {
    await sock.sendMessage(jid, {
      text: t(lang, "art.oaFound", { title: result.title, url: result.pdfUrl }),
    });
    return;
  }

  // Gagal total.
  if (result.reason === "INVALID_URL") {
    await sock.sendMessage(jid, { text: t(lang, "art.invalid") });
    return;
  }

  await sock.sendMessage(jid, {
    text: t(lang, "art.notFound", { url: result.sourceUrl }),
  });
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid - chat tujuan (grup atau pribadi).
 * @param {string} rawInput - teks setelah "!artikel" (kata kunci, DOI, "arxiv ...", atau URL).
 * @param {string} [senderId] - jid pengirim ASLI, dipakai buat rate limiting per user.
 */
async function runArtikelCommand(sock, jid, rawInput, senderId, lang) {
  const effectiveSender = senderId || jid;
  const parsed = parseArticleInput(rawInput);

  if (parsed.mode === "empty") {
    await sock.sendMessage(jid, { text: t(lang, "art.usage") });
    return;
  }
  if (parsed.mode === "invalidDoi") {
    await sock.sendMessage(jid, { text: t(lang, "art.invalidDoi") });
    return;
  }

  const rateCheck = checkRateLimit(effectiveSender, lang);
  if (!rateCheck.allowed) {
    await sock.sendMessage(jid, { text: `⏳ ${rateCheck.reason}` });
    return;
  }

  inFlight.add(effectiveSender);
  lastRequestAt.set(effectiveSender, Date.now());

  const state = { workDirToClean: null };

  try {
    if (parsed.mode === "url") {
      await runUrlFlow(sock, jid, parsed.url, lang, state);
    } else {
      await runJournalFlow(sock, jid, parsed, lang);
    }
  } catch (err) {
    console.log("=== [!artikel] error tak terduga ===");
    console.log(err.message || err);
    console.log("=====================================");
    await sock.sendMessage(jid, {
      text: t(lang, "art.error"),
    });

    // Jaga-jaga: kalau error terjadi setelah file sempat ke-download
    // tapi sebelum sempat dibersihkan di jalur normal.
    if (state.workDirToClean) safeRmdir(state.workDirToClean);
  } finally {
    inFlight.delete(effectiveSender);
  }
}

module.exports = {
  handleArticleCommand,
  handleJournalCommand,
  runArtikelCommand,
};
