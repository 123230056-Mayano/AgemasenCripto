"use strict";

/**
 * arXiv API -- cari preprint (judul/kata kunci) + tautan abstrak & PDF.
 * Ketentuan arXiv: maksimal 1 request per ~3 detik, jadi semua request
 * lewat antrean throttle di sini.
 */

const cheerio = require("cheerio");
const { getText, cached, HOUR } = require("./http");
const { titleSimilarity, stripTags } = require("./text");

const SERVICE = "arXiv";
const ENDPOINT = "https://export.arxiv.org/api/query";
const MATCH_THRESHOLD = 0.85;

let gapMs = 3000;
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + gapMs;
  if (start > now) await new Promise((r) => setTimeout(r, start - now));
}
/** Dipakai test supaya gak nunggu 3 detik. */
function configure({ gap } = {}) {
  if (typeof gap === "number") gapMs = gap;
  nextSlot = 0;
}

/** arXiv id dari DOI bentuk 10.48550/arXiv.2101.00001 (tanpa perlu search). */
function arxivIdFromDoi(doi) {
  const m = String(doi || "").match(/^10\.48550\/arxiv\.(.+)$/i);
  return m ? m[1] : null;
}

function buildRecord(id) {
  const clean = id.replace(/v\d+$/i, "");
  return { arxivId: clean, absUrl: `https://arxiv.org/abs/${clean}`, pdfUrl: `https://arxiv.org/pdf/${clean}` };
}

function parseFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];
  $("entry").each((_, el) => {
    const e = $(el);
    const rawId = e.children("id").first().text().trim();
    const m = rawId.match(/arxiv\.org\/abs\/(.+)$/i);
    if (!m) return; // entry error dari arXiv gak punya id /abs/
    const published = e.children("published").first().text().trim();
    out.push({
      source: SERVICE,
      ...buildRecord(m[1]),
      title: stripTags(e.children("title").first().text()),
      authors: e.children("author").map((__, a) => $(a).children("name").first().text().trim()).get().filter(Boolean),
      year: published ? Number(published.slice(0, 4)) || null : null,
      doi: (e.children("arxiv\\:doi").first().text().trim() || null),
      venue: stripTags(e.children("arxiv\\:journal_ref").first().text()) || "arXiv",
    });
  });
  return out;
}

function toQuery(text) {
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.slice(0, 12).map((t) => `all:${t}`).join(" AND ");
}

function runQuery(searchQuery, maxResults) {
  return cached(`arxiv:${maxResults}:${searchQuery}`, 6 * HOUR, async () => {
    await throttle();
    const xml = await getText(SERVICE, ENDPOINT, {
      params: { search_query: searchQuery, start: 0, max_results: maxResults, sortBy: "relevance" },
    });
    return parseFeed(xml || "");
  });
}

/** Cari preprint dari kata kunci (perintah arxiv). */
async function search(query, limit = 3) {
  const q = toQuery(query);
  if (!q) return [];
  return runQuery(q, limit);
}

/** Cari preprint yang judulnya cocok dengan sebuah publikasi. Null kalau tidak ada. */
async function findByTitle(title, doi) {
  const direct = arxivIdFromDoi(doi);
  if (direct) return { ...buildRecord(direct), matched: "doi" };

  const tokens = String(title || "").match(/[A-Za-z0-9]+/g);
  if (!tokens || tokens.length < 2) return null;
  const items = await runQuery(`ti:"${tokens.join(" ")}"`, 3);

  let best = null;
  let bestScore = 0;
  for (const it of items) {
    const score = titleSimilarity(title, it.title);
    if (score > bestScore) {
      best = it;
      bestScore = score;
    }
  }
  return best && bestScore >= MATCH_THRESHOLD
    ? { arxivId: best.arxivId, absUrl: best.absUrl, pdfUrl: best.pdfUrl, matched: "title" }
    : null;
}

module.exports = { search, findByTitle, parseFeed, arxivIdFromDoi, configure };
