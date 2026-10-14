"use strict";

/**
 * OpenAlex -- sumber utama pencarian (judul/kata kunci, penulis, tahun, sitasi).
 *
 * CATATAN KUOTA: sejak Feb 2026 OpenAlex mewajibkan API key & memakai
 * kuota harian berbasis biaya (tanpa key jauh lebih kecil, pencarian
 * keyword lebih mahal daripada lookup DOI satuan). Isi OPENALEX_API_KEY
 * (gratis, openalex.org/settings/api) supaya kuota harian lebih lega.
 * Hasil di-cache supaya pencarian yang sama gak menghabiskan kuota.
 */

const { getJson, cached, HOUR, CONTACT_EMAIL } = require("./http");
const { extractDoi, doiPath, stripTags } = require("./text");

const SERVICE = "OpenAlex";
const BASE = "https://api.openalex.org";
const SELECT = [
  "id", "doi", "display_name", "publication_year", "cited_by_count",
  "authorships", "primary_location", "open_access", "best_oa_location",
].join(",");

function authParams() {
  const p = { select: SELECT };
  if (process.env.OPENALEX_API_KEY) p.api_key = process.env.OPENALEX_API_KEY;
  else p.mailto = CONTACT_EMAIL;
  return p;
}

function normalizeWork(w) {
  if (!w) return null;
  const title = stripTags(w.display_name || w.title);
  if (!title) return null;
  return {
    source: SERVICE,
    openalexId: w.id || null,
    title,
    authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year || null,
    venue: w.primary_location?.source?.display_name || null,
    doi: extractDoi(w.doi),
    landingUrl: w.primary_location?.landing_page_url || null,
    citations: Number.isFinite(w.cited_by_count) ? w.cited_by_count : null,
    oa: {
      isOa: w.open_access?.is_oa === true,
      pdfUrl: w.best_oa_location?.pdf_url || null,
      landingUrl: w.best_oa_location?.landing_page_url || null,
    },
  };
}

/** Cari publikasi dari kata kunci/judul. Return array record ter-normalisasi. */
function search(query, limit = 3) {
  const key = `openalex:search:${limit}:${query.toLowerCase()}`;
  return cached(key, 6 * HOUR, async () => {
    const data = await getJson(SERVICE, `${BASE}/works`, {
      params: { ...authParams(), search: query, per_page: limit },
    });
    return (data?.results || []).map(normalizeWork).filter(Boolean);
  });
}

/** Lookup satuan berdasarkan DOI (gratis di OpenAlex). Null kalau gak ada. */
function getByDoi(doi) {
  return cached(`openalex:doi:${doi}`, 24 * HOUR, async () => {
    const data = await getJson(SERVICE, `${BASE}/works/https://doi.org/${doiPath(doi)}`, {
      params: authParams(),
    });
    return normalizeWork(data);
  });
}

module.exports = { search, getByDoi, normalizeWork };
