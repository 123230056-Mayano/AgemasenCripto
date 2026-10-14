"use strict";

// =====================================================
// Ambil link dari pesan yang di-REPLY user (contextInfo.quotedMessage).
// Dipakai !dl / !dlr / !dlt supaya user bisa reply sebuah link lalu
// cukup ketik "!dl" (tanpa nempel ulang link-nya).
//
// Sumber link, urut prioritas:
//   1. Teks pesan yang di-reply (conversation / extendedTextMessage /
//      caption gambar-video-dokumen)
//   2. Metadata link preview (canonicalUrl / matchedText) -- berguna kalau
//      teks pesannya kepotong atau link-nya cuma ada di preview.
// =====================================================
const URL_RE = /https?:\/\/[^\s<>"']+/i;

// Buang tanda baca yang sering nempel di ujung link waktu dikutip di chat,
// mis. "lihat https://youtu.be/abc)." -> "https://youtu.be/abc"
function cleanUrl(raw) {
  return String(raw || "").replace(/[)\]}>,.;:!?'"]+$/, "");
}

function getContextInfo(msg) {
  const m = msg?.message || {};
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    null
  );
}

function getQuotedUrl(msg) {
  const q = getContextInfo(msg)?.quotedMessage;
  if (!q) return null;

  const text =
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    q.documentMessage?.caption ||
    "";

  const fromText = String(text).match(URL_RE);
  if (fromText) return cleanUrl(fromText[0]);

  const ext = q.extendedTextMessage;
  const fromPreview = ext?.canonicalUrl || ext?.matchedText;
  if (fromPreview && URL_RE.test(fromPreview)) return cleanUrl(fromPreview);

  return null;
}

// Cek apakah user memang me-reply sebuah pesan (terlepas ada link/tidak),
// dipakai buat milih pesan error yang tepat.
function hasQuotedMessage(msg) {
  return Boolean(getContextInfo(msg)?.quotedMessage);
}

module.exports = { getQuotedUrl, hasQuotedMessage, cleanUrl };
