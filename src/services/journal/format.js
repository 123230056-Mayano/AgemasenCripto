"use strict";

/** Susun pesan WhatsApp dari hasil orchestrator (teks di-i18n lewat t()). */

const MAX_AUTHORS = 3;
const MAX_TITLE = 250;

function cut(str, n) {
  const s = String(str || "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatRecord(t, lang, rec, index) {
  const lines = [];
  lines.push(`*${index}. ${cut(rec.title, MAX_TITLE) || t(lang, "art.untitled")}*`);

  if (rec.authors?.length) {
    const shown = rec.authors.slice(0, MAX_AUTHORS).join(", ");
    const more = rec.authors.length > MAX_AUTHORS ? ` ${t(lang, "art.jr.etAl")}` : "";
    lines.push(t(lang, "art.jr.authors", { authors: shown + more }));
  }
  if (rec.year) lines.push(t(lang, "art.jr.year", { year: rec.year }));
  if (rec.venue) lines.push(t(lang, "art.jr.venue", { venue: cut(rec.venue, 120) }));
  if (rec.doi) lines.push(t(lang, "art.jr.doi", { doi: rec.doi }));
  if (rec.publisherUrl) lines.push(t(lang, "art.jr.link", { url: rec.publisherUrl }));

  if (!rec.arxivOnly) {
    lines.push(
      rec.citations !== null && rec.citations !== undefined
        ? t(lang, "art.jr.cites", { count: rec.citations, source: rec.citationSource })
        : t(lang, "art.jr.citesNA"),
    );
  }

  const pdf = rec.pdf || { status: "unknown" };
  if (pdf.status === "available") {
    lines.push(t(lang, pdf.kind === "page" ? "art.jr.pdfPage" : "art.jr.pdfAvailable", { source: pdf.source }));
    lines.push(pdf.url);
  } else if (pdf.status === "not_found") {
    lines.push(t(lang, "art.jr.pdfNotFound"));
  } else {
    lines.push(t(lang, "art.jr.pdfUnknown"));
  }

  if (rec.arxiv && rec.arxiv.pdfUrl !== pdf.url) {
    lines.push(t(lang, "art.jr.arxiv", { url: rec.arxiv.absUrl }));
  }
  return lines.join("\n");
}

/**
 * @param {Function} t - fungsi i18n t(lang, key, vars)
 * @param {object} outcome - hasil searchJournal/lookupDoi/searchArxiv
 * @returns {string} teks siap kirim
 */
function formatJournalReply(t, lang, outcome) {
  if (outcome.allFailed) return t(lang, "art.jr.allFailed");

  if (!outcome.results.length) {
    return outcome.mode === "doi"
      ? t(lang, "art.jr.doiNotFound", { doi: outcome.doi })
      : t(lang, "art.jr.empty", { query: outcome.query });
  }

  const parts = [];
  parts.push(
    outcome.mode === "doi"
      ? t(lang, "art.jr.headerDoi", { doi: outcome.doi })
      : t(lang, outcome.mode === "arxiv" ? "art.jr.headerArxiv" : "art.jr.header", {
          query: outcome.query,
          count: outcome.results.length,
        }),
  );
  parts.push(outcome.results.map((r, i) => formatRecord(t, lang, r, i + 1)).join("\n\n"));

  const notes = [];
  if (outcome.failed?.length) notes.push(t(lang, "art.jr.partial", { services: outcome.failed.join(", ") }));
  if (outcome.mode !== "arxiv") notes.push(t(lang, "art.jr.footer"));
  if (notes.length) parts.push(notes.join("\n\n"));

  return parts.join("\n\n");
}

module.exports = { formatJournalReply, formatRecord };
