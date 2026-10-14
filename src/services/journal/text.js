"use strict";

/** Util teks kecil: DOI, kemiripan judul, bersih-bersih string. */

const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/i;

/** Ambil DOI (huruf kecil, tanpa prefix/tanda baca ujung) dari teks/URL apa pun. Null kalau gak ada. */
function extractDoi(input) {
  if (!input) return null;
  let s = String(input).trim();
  try {
    s = decodeURIComponent(s);
  } catch (_) {
    /* biarkan apa adanya */
  }
  const m = s.match(DOI_RE);
  if (!m) return null;
  return m[0].replace(/[)\].,;:]+$/, "").toLowerCase();
}

/** Path DOI buat URL API: slash tetap, karakter lain di-encode. */
function doiPath(doi) {
  return encodeURIComponent(doi).replace(/%2F/gi, "/");
}

function normalizeTitle(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0..1. Sama/mengandung -> 1, selain itu Jaccard antar kata. */
function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = shorter === na ? nb : na;
  if (shorter.length >= 15 && longer.includes(shorter)) return 1;

  const A = new Set(na.split(" "));
  const B = new Set(nb.split(" "));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

module.exports = { extractDoi, doiPath, normalizeTitle, titleSimilarity, stripTags };
