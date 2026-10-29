"use strict";

/**
 * features/forex/forexNews.js
 * ------------------------------------------------------------------
 * Berita forex dari BEBERAPA sumber yang saling backup (lihat Catatan: API Berita Forex Gratis dan Cepat).
 *
 * Sumber headline (semua dipoll bersamaan, bukan bergantian):
 *   1. investingLive (dulu ForexLive)  RSS, tercepat. Punya mirror URL (domain lama forexlive.com).
 *   2. investingLive Bank Sentral      RSS kategori centralbank.
 *   3. FXStreet                        RSS. Punya mirror URL.
 *   4. Finnhub /news?category=forex    JSON resmi, aktif hanya kalau FINNHUB_KEY diisi. Lebih lambat (agregator),
 *                                      jadi dipoll lebih jarang (120 dtk) dan berfungsi sebagai cadangan resmi.
 *   + sumber RSS tambahan lewat env FXNEWS_EXTRA_RSS (pisahkan dengan koma).
 *
 * Cara saling backup:
 *   - Mirror: tiap sumber punya daftar URL; yang pertama berhasil dipakai. Respons 200 tapi tanpa item
 *     (mis. halaman blokir) dianggap GAGAL dan lanjut ke mirror berikutnya.
 *   - Cooldown eksponensial: sumber yang gagal dilewati sementara (30 dtk -> maks 10 menit; 401/403/429 minimal
 *     5 menit) tanpa mengganggu sumber lain. Pulih otomatis begitu satu panggilan berhasil.
 *   - Karena semua sumber aktif dipoll, satu sumber mati tidak menunda berita dari sumber lain.
 *   - Berita yang sama dari sumber berbeda hanya dikirim SEKALI: yang tiba paling awal menang. Kecocokan
 *     dinilai dari id sumber, judul ternormalisasi, dan kemiripan kata (Jaccard) pada judul.
 *   - Semua sumber gagal -> NewsUnavailableError (membawa headline lama yang masih segar untuk ditampilkan
 *     bertanda data lama). Hasil error TIDAK di-cache.
 *
 * Env opsional: FXNEWS_SOURCES (daftar id dipisah koma; default semua), FXNEWS_POLL_MS (default 45000, min 15000),
 * FXNEWS_EXTRA_RSS, FINNHUB_KEY, FXNEWS_MAX_AGE_MIN (default 45).
 */

const cheerio = require("cheerio");
const http = require("./newsHttp");
const health = require("./newsHealth");

const POLL_MS = Math.max(15_000, Number(process.env.FXNEWS_POLL_MS) || 45_000);
const FINNHUB_POLL_MS = Math.max(POLL_MS, 120_000);
const ALL_TTL_MS = 10_000; // permintaan berdekatan (alert + command) memakai satu hasil
const STALE_MAX_MS = 30 * 60_000; // headline lama yang masih boleh ditampilkan saat semua sumber gagal
const MAX_AGE_MS = Math.max(5, Number(process.env.FXNEWS_MAX_AGE_MIN) || 45) * 60_000;
const SIMILAR_MIN = 0.75; // Jaccard minimal judul dianggap sama
const SIMILAR_MIN_TOKENS = 4; // judul sependek ini hanya cocok kalau persis sama

class NewsUnavailableError extends Error {
  constructor(msg, { staleItems = [], sources = [] } = {}) {
    super(msg);
    this.code = "FXNEWS_UNAVAILABLE";
    this.staleItems = staleItems;
    this.sources = sources;
  }
}

// ---------------------------------------------------------------------
// Parser (fungsi murni)
// ---------------------------------------------------------------------
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** HTML/CDATA -> teks biasa (tag dibuang, entitas didekode). */
function htmlToText(s) {
  if (!s) return "";
  return oneLine(cheerio.load(`<div>${s}</div>`).text());
}

function childText(node, names) {
  let found = "";
  node.children().each((_, c) => {
    if (!found && names.includes(c.name)) found = cheerio.load("", { xmlMode: true })(c).text();
  });
  return found.trim();
}

/** RSS 2.0 atau Atom -> [{src,id,title,summary,link,ts}] (ts ms atau null). Item tanpa judul dibuang. */
function parseRss(xml, srcId) {
  const $ = cheerio.load(String(xml || ""), { xmlMode: true });
  const nodes = $("item").length ? $("item") : $("entry");
  const out = [];
  nodes.each((_, el) => {
    const n = $(el);
    const title = oneLine(childText(n, ["title"]));
    if (!title) return;
    const linkEl = n.children("link").first();
    const link = (linkEl.text() || linkEl.attr("href") || "").trim();
    const id = childText(n, ["guid", "id"]) || link || title;
    const dateStr = childText(n, ["pubDate", "dc:date", "published", "updated"]);
    const t = dateStr ? Date.parse(dateStr) : NaN;
    const summary = htmlToText(childText(n, ["description", "summary", "content:encoded", "content"]));
    out.push({ src: srcId, id: String(id), title, summary, link, ts: Number.isFinite(t) ? t : null });
  });
  return out;
}

/** Finnhub /news -> item bentuk sama. `datetime` detik UNIX. */
function parseFinnhub(raw, srcId = "finnhub") {
  let arr = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const r of arr) {
    const title = oneLine(r?.headline);
    if (!title) continue;
    const t = Number(r.datetime) * 1000;
    out.push({
      src: srcId,
      id: String(r.id ?? r.url ?? title),
      title,
      summary: htmlToText(r.summary || ""),
      link: r.url || "",
      ts: Number.isFinite(t) && t > 0 ? t : null,
      via: r.source || null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Dedupe judul (fungsi murni)
// ---------------------------------------------------------------------
const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "at", "for", "and", "as", "is", "are", "by", "with", "from", "after", "amid", "says", "said", "its", "it"]);

/** Judul -> huruf kecil, tanpa tanda baca (angka, titik desimal, % dipertahankan), spasi dirapikan. */
function normTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/^\s*(forexlive|investinglive|fxstreet)\s*[:\-|]\s*/i, "")
    .replace(/[^\p{L}\p{N}\s.%]/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokensOf = (norm) => norm.split(" ").filter((w) => w.length > 1 && !STOP.has(w));

function isSimilarTitle(a, b) {
  if (a === b) return true;
  const ta = new Set(tokensOf(a));
  const tb = new Set(tokensOf(b));
  if (ta.size < SIMILAR_MIN_TOKENS || tb.size < SIMILAR_MIN_TOKENS) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter) >= SIMILAR_MIN;
}

/**
 * Pilih berita yang BELUM pernah diproses. Mengubah store (menandai id + judul sebagai sudah dilihat),
 * jadi satu item tidak pernah lolos dua kali walau siklus tumpang tindih.
 *
 * Urutan pemrosesan: waktu terbit paling awal dulu (tie -> prioritas sumber), sehingga kalau dua sumber
 * membawa berita yang sama, yang tiba duluan yang menang.
 *
 * @param {object[]} items          hasil fetchAll().items
 * @param {{store, now?:number, maxAgeMs?:number, baseline?:boolean}} opts
 *        baseline=true: semua ditandai sudah-dilihat tanpa dikirim (siklus pertama setelah state kosong).
 * @returns {{fresh:object[], skipped:{seen:number, dup:number, old:number}}} fresh urut lama -> baru
 */
function selectFresh(items, { store, now = Date.now(), maxAgeMs = MAX_AGE_MS, baseline = false }) {
  const eff = (it) => Math.min(it.ts ?? now, now); // tanpa tanggal / tanggal masa depan -> dianggap sekarang
  const sorted = [...items].sort((a, b) => eff(a) - eff(b) || (a.prio ?? 99) - (b.prio ?? 99));
  const recent = store.recentTitles().map((r) => r.n);
  const batch = [];
  const skipped = { seen: 0, dup: 0, old: 0 };
  const fresh = [];

  for (const it of sorted) {
    const idKey = `n:${it.src}:${it.id}`;
    if (store.hasSeen(idKey)) {
      skipped.seen++;
      continue;
    }
    const norm = normTitle(it.title);
    const ts = eff(it);
    const isDup = recent.some((r) => isSimilarTitle(norm, r)) || batch.some((r) => isSimilarTitle(norm, r));
    store.markSeen(idKey, now);
    if (isDup) {
      skipped.dup++;
      continue;
    }
    store.addRecent(norm, ts);
    batch.push(norm);
    if (baseline) continue;
    if (now - ts > maxAgeMs) {
      skipped.old++;
      continue;
    }
    fresh.push({ ...it, ts });
  }
  return { fresh, skipped };
}

// ---------------------------------------------------------------------
// Registri sumber + pengambilan dengan failover
// ---------------------------------------------------------------------
function getSources() {
  const only = process.env.FXNEWS_SOURCES ? process.env.FXNEWS_SOURCES.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  const key = process.env.FINNHUB_KEY || "";
  const defs = [
    {
      id: "investinglive",
      name: "investingLive",
      kind: "rss",
      urls: ["https://investinglive.com/feed/news/", "https://www.forexlive.com/feed/news"],
      minIntervalMs: POLL_MS,
      prio: 1,
    },
    {
      id: "investinglive-cb",
      name: "investingLive Bank Sentral",
      kind: "rss",
      urls: ["https://investinglive.com/feed/centralbank/", "https://www.forexlive.com/feed/centralbank"],
      minIntervalMs: POLL_MS,
      prio: 2,
    },
    {
      id: "fxstreet",
      name: "FXStreet",
      kind: "rss",
      urls: ["https://www.fxstreet.com/rss/news", "https://subscriptions.fxstreet.com/RSS/News.aspx"],
      minIntervalMs: POLL_MS,
      prio: 3,
    },
    {
      id: "finnhub",
      name: "Finnhub",
      kind: "finnhub",
      urls: ["https://finnhub.io/api/v1/news?category=forex"],
      headers: key ? { "X-Finnhub-Token": key } : {},
      needsKey: !key,
      minIntervalMs: FINNHUB_POLL_MS,
      prio: 4,
    },
  ];
  (process.env.FXNEWS_EXTRA_RSS || "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .forEach((u, i) => defs.push({ id: `custom${i + 1}`, name: `RSS ${new URL(u).hostname}`, kind: "rss", urls: [u], minIntervalMs: POLL_MS, prio: 5 + i }));

  return defs.map((d) => ({ ...d, enabled: !d.needsKey && (!only || only.includes(d.id)), offReason: d.needsKey ? "FINNHUB_KEY kosong" : only && !only.includes(d.id) ? "dimatikan via FXNEWS_SOURCES" : null }));
}

const states = new Map(); // id sumber -> health
const stateOf = (id) => {
  if (!states.has(id)) states.set(id, health.createHealth());
  return states.get(id);
};

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "url";
  }
};

/** Coba URL satu per satu (mirror). Yang pertama menghasilkan >= 1 item menang. */
async function fetchSource(def) {
  const errors = [];
  for (const url of def.urls) {
    try {
      const res = await http.get(url, { headers: def.headers });
      const items = def.kind === "finnhub" ? parseFinnhub(res?.data, def.id) : parseRss(res?.data, def.id);
      if (!items.length) throw new Error("EMPTY_FEED");
      return { items, url };
    } catch (err) {
      errors.push(`${hostOf(url)}: ${health.errMessage(err)}`);
      // 401/403/429 dari mirror pertama biasanya berlaku juga untuk mirror di host yang sama; host lain tetap dicoba.
      if (def.kind === "finnhub") break;
    }
  }
  const e = new Error(errors.join("; "));
  e.code = "SOURCE_FAILED";
  // teruskan status HTTP terakhir supaya markFail bisa memperpanjang cooldown untuk 401/403/429
  const m = errors.join(" ").match(/HTTP (401|403|429)/);
  if (m) e.response = { status: Number(m[1]) };
  throw e;
}

let allCache = null;
let inflight = null;

async function doFetchAll(now) {
  const defs = getSources();
  const results = await Promise.all(
    defs.map(async (def) => {
      const h = stateOf(def.id);
      if (!def.enabled) return { def, status: "off", items: [] };
      if (!health.canTry(h, now)) return { def, status: "cooldown", items: [] };
      if (h.lastItems && h.fails === 0 && now - h.lastPollAt < def.minIntervalMs) return { def, status: "ok", items: h.lastItems };
      try {
        const { items, url } = await fetchSource(def);
        h.lastItems = items;
        health.markOk(h, now, { url, count: items.length });
        return { def, status: "ok", items };
      } catch (err) {
        health.markFail(h, now, err);
        console.log(`[fxnews] sumber ${def.id} gagal (${h.fails}x): ${err.message}`);
        return { def, status: "down", items: [] };
      }
    }),
  );

  const sources = results.map((r) => ({ id: r.def.id, name: r.def.name, status: r.status }));
  const ok = results.filter((r) => r.status === "ok");
  if (!ok.length) {
    const stale = [];
    for (const def of defs) {
      const h = stateOf(def.id);
      if (h.lastItems && now - h.okAt < STALE_MAX_MS) stale.push(...h.lastItems.map((it) => ({ ...it, prio: def.prio, srcName: def.name })));
    }
    throw new NewsUnavailableError("ALL_SOURCES_FAILED", { staleItems: stale, sources });
  }
  const items = ok.flatMap((r) => r.items.map((it) => ({ ...it, prio: r.def.prio, srcName: it.via ? `${r.def.name}/${it.via}` : r.def.name })));
  return { items, sources, okCount: ok.length };
}

/**
 * Ambil headline dari semua sumber yang aktif dan tidak sedang cooldown. Permintaan bersamaan memakai satu fetch
 * (coalescing) dan hasil sukses di-cache ALL_TTL_MS. Gagal total tidak di-cache.
 * @returns {Promise<{items:object[], sources:object[], okCount:number}>}
 * @throws {NewsUnavailableError} bila tidak ada satu pun sumber yang berhasil.
 */
async function fetchAll({ now = Date.now(), force = false } = {}) {
  if (!force && allCache && Date.now() - allCache.at < ALL_TTL_MS) return allCache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const value = await doFetchAll(now);
      allCache = { at: Date.now(), value };
      return value;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Headline terbaru untuk ditampilkan (judul duplikat antar-sumber digabung). Bisa melempar NewsUnavailableError. */
async function latestHeadlines(limit = 5) {
  const data = await fetchAll();
  return { items: dedupeForDisplay(data.items).slice(0, limit), sources: data.sources, stale: false };
}

function dedupeForDisplay(items) {
  const now = Date.now();
  const sorted = [...items].sort((a, b) => Math.min(b.ts ?? now, now) - Math.min(a.ts ?? now, now) || (a.prio ?? 99) - (b.prio ?? 99));
  const kept = [];
  const norms = [];
  for (const it of sorted) {
    const n = normTitle(it.title);
    if (norms.some((x) => isSimilarTitle(n, x))) continue;
    norms.push(n);
    kept.push(it);
  }
  return kept;
}

/** Laporan kesehatan semua sumber (untuk !fxnews status). */
function getNewsHealth(now = Date.now()) {
  return getSources().map((def) => {
    const h = stateOf(def.id);
    return {
      id: def.id,
      name: def.name,
      enabled: def.enabled,
      offReason: def.offReason,
      status: def.enabled ? health.statusOf(h, now) : "off",
      fails: h.fails,
      okAt: h.okAt || null,
      nextTryAt: h.nextTryAt || null,
      lastError: h.lastError,
      lastUrl: h.lastUrl,
      lastCount: h.lastCount,
    };
  });
}

function _reset() {
  states.clear();
  allCache = null;
  inflight = null;
}

module.exports = {
  POLL_MS,
  MAX_AGE_MS,
  NewsUnavailableError,
  fetchAll,
  latestHeadlines,
  dedupeForDisplay,
  getNewsHealth,
  getSources,
  selectFresh,
  // diekspor untuk pengujian
  parseRss,
  parseFinnhub,
  normTitle,
  isSimilarTitle,
  _reset,
};
