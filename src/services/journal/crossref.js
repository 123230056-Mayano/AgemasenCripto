"use strict";

/** Crossref -- cek DOI & ambil metadata (judul, penulis, jurnal, tahun, link penerbit). */

const { getJson, cached, HOUR, CONTACT_EMAIL } = require("./http");
const { extractDoi, doiPath, stripTags, titleSimilarity } = require("./text");

const SERVICE = "Crossref";
const BASE = "https://api.crossref.org";
const SELECT = "DOI,title,author,issued,container-title,URL,is-referenced-by-count";
const MATCH_THRESHOLD = 0.9;

function normalizeItem(m) {
  if (!m) return null;
  const title = stripTags(Array.isArray(m.title) ? m.title[0] : m.title);
  const doi = extractDoi(m.DOI);
  if (!title && !doi) return null;
  return {
    source: SERVICE,
    title: title || null,
    authors: (m.author || [])
      .map((a) => [a.given, a.family].filter(Boolean).join(" ") || a.name)
      .filter(Boolean),
    year: m.issued?.["date-parts"]?.[0]?.[0] || null,
    venue: stripTags(Array.isArray(m["container-title"]) ? m["container-title"][0] : m["container-title"]) || null,
    doi,
    publisherUrl: m.URL || null,
    citations: Number.isFinite(m["is-referenced-by-count"]) ? m["is-referenced-by-count"] : null,
  };
}

/** Metadata dari DOI. Null kalau DOI gak terdaftar di Crossref. */
function getByDoi(doi) {
  return cached(`crossref:doi:${doi}`, 24 * HOUR, async () => {
    const data = await getJson(SERVICE, `${BASE}/works/${doiPath(doi)}`, {
      params: { mailto: CONTACT_EMAIL },
    });
    return normalizeItem(data?.message);
  });
}

/** Pencarian bibliografis (dipakai sbg fallback kalau OpenAlex mati). */
function search(query, rows = 3) {
  return cached(`crossref:search:${rows}:${query.toLowerCase()}`, 6 * HOUR, async () => {
    const data = await getJson(SERVICE, `${BASE}/works`, {
      params: { "query.bibliographic": query, rows, select: SELECT, mailto: CONTACT_EMAIL },
    });
    return (data?.message?.items || []).map(normalizeItem).filter(Boolean);
  });
}

/** Cocokkan judul -> DOI. Null kalau gak ada yang cukup mirip (cegah nyasar ke artikel lain). */
async function findByTitle(title) {
  if (!title || title.trim().length < 6) return null;
  const items = await search(title, 3);
  let best = null;
  let bestScore = 0;
  for (const it of items) {
    const score = titleSimilarity(title, it.title);
    if (score > bestScore) {
      best = it;
      bestScore = score;
    }
  }
  return best && bestScore >= MATCH_THRESHOLD ? best : null;
}

module.exports = { getByDoi, search, findByTitle, normalizeItem };
