"use strict";

/**
 * journal/index.js -- orchestrator pencarian publikasi.
 *
 * Alur (sesuai rancangan):
 *   1. Pengguna kirim perintah  -> parseArticleInput()
 *   2. Cari publikasi di OpenAlex (fallback Crossref kalau OpenAlex gagal)
 *   3. Ambil/cocokkan metadata DOI lewat Crossref
 *   4. Kalau ada DOI -> cek Open Access lewat Unpaywall
 *   5. Cari versi terkait di arXiv
 *   6. Gabungkan semuanya jadi satu record per publikasi
 *
 * Kegagalan satu layanan TIDAK menggagalkan seluruh proses: layanan
 * yang gagal dicatat di `failed`, status PDF jadi "unknown" bila perlu.
 */

const openalex = require("./openalex");
const crossref = require("./crossref");
const unpaywall = require("./unpaywall");
const arxiv = require("./arxivSearch");
const { extractDoi } = require("./text");

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10; // batas atas opsi -n (jumlah hasil)
const MIN_QUERY_LEN = 3;

// -------------------- parsing input --------------------

/**
 * Ambil opsi "-n <angka>" (jumlah hasil) dari teks, di posisi mana pun.
 * Angka dijepit ke 1..MAX_LIMIT. "-n" tanpa angka valid dibiarkan apa adanya.
 * @returns {{ text: string, limit: number|undefined }}
 */
function extractLimit(input) {
  const m = input.match(/(?:^|\s)-n\s*(\d{1,4})(?=\s|$)/i);
  if (!m) return { text: input, limit: undefined };
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(m[1], 10)));
  const text = (input.slice(0, m.index) + " " + input.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { text, limit };
}

/**
 * Tentukan mode dari teks setelah "!artikel":
 *   (kosong)               -> empty
 *   arxiv <kata kunci>     -> arxiv
 *   doi <DOI> / DOI / link doi.org -> doi
 *   http(s)://...          -> url   (alur lama: downloader URL)
 *   selain itu             -> keyword (pencarian OpenAlex)
 * Opsi "-n <angka>" (1..10) mengatur jumlah hasil untuk mode keyword & arxiv.
 */
function parseArticleInput(raw) {
  const cleaned = String(raw || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return { mode: "empty" };

  // Link biasa bisa saja memuat " -n 5"; jangan disentuh, biarkan alur URL/DOI.
  const { text: input, limit } = /^https?:\/\//i.test(cleaned)
    ? { text: cleaned, limit: undefined }
    : extractLimit(cleaned);
  if (!input) return { mode: "empty" };

  const arx = input.match(/^arxiv\s+(.+)$/i);
  if (arx) {
    return arx[1].length >= MIN_QUERY_LEN
      ? { mode: "arxiv", query: arx[1].slice(0, 200), ...(limit ? { limit } : {}) }
      : { mode: "empty" };
  }

  const isUrl = /^https?:\/\//i.test(input);
  const doi = extractDoi(input);
  const isDoiUrl = /^https?:\/\/(dx\.)?doi\.org\//i.test(input);

  if (/^doi\b/i.test(input) || isDoiUrl) {
    return doi ? { mode: "doi", doi } : { mode: "invalidDoi" };
  }
  if (isUrl) return { mode: "url", url: input };
  if (/^10\.\d{4,9}\/\S+$/i.test(input)) return doi ? { mode: "doi", doi } : { mode: "invalidDoi" };

  if (input.length < MIN_QUERY_LEN) return { mode: "empty" };
  return { mode: "keyword", query: input.slice(0, 200), ...(limit ? { limit } : {}) };
}

// -------------------- merge --------------------

function firstTruthy(...vals) {
  return vals.find((v) => v !== null && v !== undefined && v !== "") ?? null;
}

/**
 * Status PDF: "available" | "not_found" | "unknown".
 * "not_found" HANYA kalau Unpaywall sudah benar-benar memeriksa (bukan
 * gagal / DOI gak dikenal) DAN arXiv juga sudah dicek tanpa hasil --
 * selain itu "unknown", karena tidak ketemu di satu API bukan berarti
 * pasti tidak ada PDF gratis.
 */
function resolvePdf({ up, arxivHit, arxivChecked, oa }) {
  if (up?.pdfUrl) return { status: "available", kind: "pdf", url: up.pdfUrl, source: "Unpaywall" };
  if (arxivHit) return { status: "available", kind: "pdf", url: arxivHit.pdfUrl, source: "arXiv" };
  if (oa?.pdfUrl) return { status: "available", kind: "pdf", url: oa.pdfUrl, source: "OpenAlex" };
  if (up?.landingUrl) return { status: "available", kind: "page", url: up.landingUrl, source: "Unpaywall" };
  if (oa?.isOa && oa.landingUrl) return { status: "available", kind: "page", url: oa.landingUrl, source: "OpenAlex" };
  if (up && up.isOa === false && arxivChecked) return { status: "not_found", kind: null, url: null, source: null };
  return { status: "unknown", kind: null, url: null, source: null };
}

function buildRecord({ base, cr, doi, up, arxivHit, arxivChecked }) {
  // Sitasi diambil dari sumber dasar (OpenAlex; atau Crossref kalau OpenAlex
  // gagal & Crossref jadi sumber cadangan), baru jatuh ke Crossref hasil
  // pencocokan DOI. Labelnya selalu nama penyedia aslinya.
  const hasBaseCites = base.citations !== null && base.citations !== undefined;
  const citations = hasBaseCites ? base.citations : cr?.citations ?? null;
  const citationSource = hasBaseCites ? base.source || "OpenAlex" : cr?.citations != null ? "Crossref" : null;

  return {
    title: firstTruthy(base.title, cr?.title),
    authors: base.authors?.length ? base.authors : cr?.authors || [],
    year: firstTruthy(base.year, cr?.year),
    venue: firstTruthy(base.venue, cr?.venue),
    doi,
    publisherUrl: doi ? `https://doi.org/${doi}` : firstTruthy(cr?.publisherUrl, base.landingUrl),
    citations,
    citationSource: citations === null ? null : citationSource,
    pdf: resolvePdf({ up, arxivHit, arxivChecked, oa: base.oa }),
    arxiv: arxivHit ? { id: arxivHit.arxivId, absUrl: arxivHit.absUrl, pdfUrl: arxivHit.pdfUrl } : null,
  };
}

// -------------------- enrichment per publikasi --------------------

function noteFailure(failed, err, service) {
  failed.set(err?.service || service, err?.kind || "error");
}

async function enrich(base, failed) {
  // Cabang A: Crossref -> Unpaywall (Unpaywall butuh DOI dari Crossref/OpenAlex)
  const branchA = (async () => {
    let cr = null;
    let doi = base.doi || null;
    try {
      if (doi) cr = await crossref.getByDoi(doi);
      else if (base.title) {
        cr = await crossref.findByTitle(base.title);
        if (cr?.doi) doi = cr.doi;
      }
    } catch (err) {
      noteFailure(failed, err, "Crossref");
    }
    let up = null;
    if (doi) {
      try {
        up = await unpaywall.check(doi);
      } catch (err) {
        noteFailure(failed, err, "Unpaywall");
      }
    }
    return { cr, doi, up };
  })();

  // Cabang B: arXiv (cari lewat judul, gak perlu nunggu DOI kecuali DOI arXiv)
  const branchB = (async () => {
    if (!base.title) return { arxivHit: null, arxivChecked: false };
    try {
      return { arxivHit: await arxiv.findByTitle(base.title, base.doi), arxivChecked: true };
    } catch (err) {
      noteFailure(failed, err, "arXiv");
      return { arxivHit: null, arxivChecked: false };
    }
  })();

  const [a, b] = await Promise.all([branchA, branchB]);
  return buildRecord({ base, cr: a.cr, doi: a.doi, up: a.up, ...b });
}

// -------------------- entry points --------------------

function summarizeFailures(failed) {
  return {
    failed: [...failed.keys()],
    rateLimited: [...failed.entries()].filter(([, k]) => k === "rate_limited").map(([s]) => s),
  };
}

/** Mode keyword: OpenAlex -> (Crossref, Unpaywall, arXiv). */
async function searchJournal(query, { limit = DEFAULT_LIMIT, onProgress } = {}) {
  const failed = new Map();
  let bases = [];
  let searchOk = true;

  try {
    bases = await openalex.search(query, limit);
  } catch (err) {
    noteFailure(failed, err, "OpenAlex");
    searchOk = false;
  }

  if (!searchOk) {
    // OpenAlex mati -> Crossref sebagai sumber pencarian cadangan.
    try {
      bases = (await crossref.search(query, limit)).map((c) => ({ ...c, oa: null, landingUrl: c.publisherUrl }));
      searchOk = true;
    } catch (err) {
      noteFailure(failed, err, "Crossref");
    }
  }

  if (!searchOk) {
    return { mode: "keyword", query, results: [], allFailed: true, ...summarizeFailures(failed) };
  }
  if (!bases.length) {
    return { mode: "keyword", query, results: [], allFailed: false, ...summarizeFailures(failed) };
  }

  if (onProgress) onProgress("enriching");
  const results = await Promise.all(bases.map((b) => enrich(b, failed)));
  return { mode: "keyword", query, results, allFailed: false, ...summarizeFailures(failed) };
}

/** Mode DOI: metadata Crossref + sitasi OpenAlex + Unpaywall + arXiv. */
async function lookupDoi(doi, { onProgress } = {}) {
  const failed = new Map();
  let base = null;
  let sourceOk = false;

  const [oaRes, crRes] = await Promise.allSettled([openalex.getByDoi(doi), crossref.getByDoi(doi)]);
  if (oaRes.status === "fulfilled") {
    sourceOk = true;
    base = oaRes.value;
  } else noteFailure(failed, oaRes.reason, "OpenAlex");

  let crossrefHit = null;
  if (crRes.status === "fulfilled") {
    sourceOk = true;
    crossrefHit = crRes.value;
  } else noteFailure(failed, crRes.reason, "Crossref");

  if (!sourceOk) return { mode: "doi", doi, results: [], allFailed: true, ...summarizeFailures(failed) };
  if (!base && !crossrefHit) return { mode: "doi", doi, results: [], allFailed: false, ...summarizeFailures(failed) };

  if (!base) {
    base = { ...crossrefHit, oa: null, landingUrl: crossrefHit.publisherUrl };
  }
  base = { ...base, doi: base.doi || doi };

  if (onProgress) onProgress("enriching");
  const record = await enrich(base, failed);
  return { mode: "doi", doi, results: [record], allFailed: false, ...summarizeFailures(failed) };
}

/** Mode arXiv: cari preprint langsung (tanpa sitasi). */
async function searchArxiv(query, { limit = DEFAULT_LIMIT } = {}) {
  const failed = new Map();
  let items = [];
  try {
    items = await arxiv.search(query, limit);
  } catch (err) {
    noteFailure(failed, err, "arXiv");
    return { mode: "arxiv", query, results: [], allFailed: true, ...summarizeFailures(failed) };
  }
  const results = items.map((it) => ({
    title: it.title,
    authors: it.authors,
    year: it.year,
    venue: it.venue,
    doi: it.doi ? extractDoi(it.doi) : null,
    publisherUrl: it.doi ? `https://doi.org/${extractDoi(it.doi)}` : null,
    citations: null,
    citationSource: null,
    arxivOnly: true,
    pdf: { status: "available", kind: "pdf", url: it.pdfUrl, source: "arXiv" },
    arxiv: { id: it.arxivId, absUrl: it.absUrl, pdfUrl: it.pdfUrl },
  }));
  return { mode: "arxiv", query, results, allFailed: false, ...summarizeFailures(failed) };
}

module.exports = {
  parseArticleInput,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  searchJournal,
  lookupDoi,
  searchArxiv,
  // diekspor buat test
  resolvePdf,
  buildRecord,
};
