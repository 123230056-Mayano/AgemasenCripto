"use strict";

/**
 * features/forex/forexCalendar.js
 * ------------------------------------------------------------------
 * Kalender ekonomi (jadwal rilis NFP, CPI, FOMC, suku bunga, dst) dengan rantai cadangan:
 *
 *   1. Forex Factory JSON mingguan (tidak resmi), host utama
 *   2. Forex Factory JSON mingguan, host mirror
 *   3. Finnhub /calendar/economic (resmi; hanya kalau FINNHUB_KEY diisi, dan bisa saja butuh tier berbayar:
 *      kalau ditolak 401/403, sumber ini masuk cooldown dan dilewati)
 *   4. Snapshot terakhir yang berhasil (data/forex_calendar.json), ditandai `stale: true`
 *
 * Aturan:
 *   - Cache 5 menit (FXCAL_CACHE_MS) karena rate limit Forex Factory ketat. Gagal tidak di-cache.
 *   - Sumber yang gagal masuk cooldown (newsHealth.js) supaya tidak dipukul terus; 429 -> minimal 5 menit.
 *   - Permintaan bersamaan memakai satu fetch (coalescing).
 *   - Tiap sumber dinormalisasi ke {id, ts, ccy, title, impact, forecast, previous, src}; ts = ms UTC,
 *     impact = "high" | "medium" | "low" | "holiday".
 */

const fs = require("fs");
const path = require("path");
const { BOT_STATE_DATA_DIR } = require("../../config/env");
const http = require("./newsHttp");
const health = require("./newsHealth");

const CACHE_MS = Number.isFinite(Number(process.env.FXCAL_CACHE_MS)) && process.env.FXCAL_CACHE_MS ? Number(process.env.FXCAL_CACHE_MS) : 5 * 60_000;
const SNAPSHOT_FILE = process.env.FXCAL_SNAPSHOT_FILE || path.join(BOT_STATE_DATA_DIR, "forex_calendar.json");
const SNAPSHOT_MAX_AGE_MS = 10 * 86_400_000;
const IMPACT_RANK = { holiday: 0, low: 1, medium: 2, high: 3 };

class CalendarUnavailableError extends Error {
  constructor(msg, sources = []) {
    super(msg);
    this.code = "FXCAL_UNAVAILABLE";
    this.sources = sources;
  }
}

// ---------------------------------------------------------------------
// Normalisasi (fungsi murni)
// ---------------------------------------------------------------------
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function normImpact(v) {
  const s = String(v || "").toLowerCase();
  if (s.startsWith("high") || s === "3") return "high";
  if (s.startsWith("med") || s === "2") return "medium";
  if (s.startsWith("hol")) return "holiday";
  return "low";
}

const clean = (v) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "" ? null : s;
};

/** Forex Factory JSON: [{title, country:"USD", date:"2026-10-30T08:30:00-04:00", impact, forecast, previous}] */
function parseFactory(raw) {
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
    const ts = Date.parse(r?.date);
    const title = clean(r?.title);
    if (!Number.isFinite(ts) || !title) continue;
    const ccy = String(r.country || "").toUpperCase().slice(0, 3);
    out.push({ id: `${ts}|${ccy}|${slug(title)}`, ts, ccy, title, impact: normImpact(r.impact), forecast: clean(r.forecast), previous: clean(r.previous), src: "forexfactory" });
  }
  return out;
}

// kode negara Finnhub -> mata uang
const COUNTRY_CCY = { US: "USD", EU: "EUR", EZ: "EUR", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", GB: "GBP", UK: "GBP", JP: "JPY", CH: "CHF", AU: "AUD", NZ: "NZD", CA: "CAD", CN: "CNY", ID: "IDR" };

/** Finnhub: {economicCalendar:[{actual, country:"US", estimate, event, impact, prev, time:"2026-10-30 12:30:00" (UTC), unit}]} */
function parseFinnhubCalendar(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const arr = Array.isArray(obj?.economicCalendar) ? obj.economicCalendar : [];
  const out = [];
  for (const r of arr) {
    const ts = Date.parse(String(r?.time || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(r?.time)) ? "" : "Z"));
    const title = clean(r?.event);
    if (!Number.isFinite(ts) || !title) continue;
    const cc = String(r.country || "").toUpperCase();
    const ccy = COUNTRY_CCY[cc] || cc.slice(0, 3);
    const unit = r.unit ? String(r.unit) : "";
    const withUnit = (v) => (clean(v) === null ? null : `${v}${unit}`);
    out.push({ id: `${ts}|${ccy}|${slug(title)}`, ts, ccy, title, impact: normImpact(r.impact), forecast: withUnit(r.estimate), previous: withUnit(r.prev), src: "finnhub" });
  }
  return out;
}

/** Filter: rentang waktu [from, to), impact minimal, daftar mata uang (kosong = semua). Urut waktu. */
function filterEvents(events, { from = -Infinity, to = Infinity, minImpact = "low", ccys = [] } = {}) {
  const min = IMPACT_RANK[minImpact] ?? 1;
  const set = new Set(ccys.map((c) => c.toUpperCase()));
  return events
    .filter((e) => e.ts >= from && e.ts < to && (IMPACT_RANK[e.impact] ?? 0) >= min && e.impact !== "holiday" && (!set.size || set.has(e.ccy)))
    .sort((a, b) => a.ts - b.ts || (IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact]));
}

// ---------------------------------------------------------------------
// Sumber + failover
// ---------------------------------------------------------------------
function getCalendarSources() {
  const key = process.env.FINNHUB_KEY || "";
  const week = () => {
    const d = new Date();
    const from = d.toISOString().slice(0, 10);
    const to = new Date(d.getTime() + 8 * 86_400_000).toISOString().slice(0, 10);
    return `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}`;
  };
  return [
    { id: "ff", name: "Forex Factory", urls: ["https://nfs.faireconomy.media/ff_calendar_thisweek.json"], parse: parseFactory, enabled: true },
    { id: "ff-mirror", name: "Forex Factory (mirror)", urls: ["https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json"], parse: parseFactory, enabled: true },
    { id: "finnhub", name: "Finnhub", urls: [week()], headers: key ? { "X-Finnhub-Token": key } : {}, parse: parseFinnhubCalendar, enabled: !!key, offReason: key ? null : "FINNHUB_KEY kosong" },
  ];
}

const states = new Map();
const stateOf = (id) => {
  if (!states.has(id)) states.set(id, health.createHealth());
  return states.get(id);
};

let cache = null; // {at, value}
let inflight = null;

function readSnapshot() {
  try {
    const p = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
    if (Array.isArray(p?.events) && Number.isFinite(p.fetchedAt)) return p;
  } catch {
    /* tidak ada / rusak */
  }
  return null;
}

function writeSnapshot(events, src, fetchedAt) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt, src, events }));
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch (err) {
    console.log("[fxcal] gagal menyimpan snapshot:", err.message);
  }
}

async function doGetCalendar(now) {
  const attempts = [];
  for (const def of getCalendarSources()) {
    const h = stateOf(def.id);
    if (!def.enabled) {
      attempts.push({ id: def.id, status: "off" });
      continue;
    }
    if (!health.canTry(h, now)) {
      attempts.push({ id: def.id, status: "cooldown" });
      continue;
    }
    try {
      const res = await http.get(def.urls[0], { headers: def.headers });
      const events = def.parse(res?.data);
      if (!events.length) throw new Error("EMPTY_CALENDAR");
      health.markOk(h, now, { url: def.urls[0], count: events.length });
      writeSnapshot(events, def.id, now);
      return { events, src: def.id, srcName: def.name, stale: false, fetchedAt: now, attempts };
    } catch (err) {
      health.markFail(h, now, err);
      attempts.push({ id: def.id, status: "down", error: h.lastError });
      console.log(`[fxcal] sumber ${def.id} gagal (${h.fails}x): ${h.lastError}`);
    }
  }
  // semua sumber hidup gagal -> snapshot terakhir
  const snap = readSnapshot();
  if (snap && now - snap.fetchedAt < SNAPSHOT_MAX_AGE_MS) {
    return { events: snap.events, src: snap.src, srcName: "snapshot", stale: true, fetchedAt: snap.fetchedAt, attempts };
  }
  throw new CalendarUnavailableError("ALL_CALENDAR_SOURCES_FAILED", attempts);
}

/**
 * Kalender minggu ini. Berhasil dari sumber hidup -> stale:false. Semua sumber gagal -> snapshot lama (stale:true).
 * Tidak ada snapshot -> CalendarUnavailableError. Hasil stale TIDAK dimasukkan ke cache (supaya dicoba lagi
 * begitu cooldown habis); hasil error juga tidak.
 */
async function getCalendar({ now = Date.now(), force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const value = await doGetCalendar(now);
      if (!value.stale) cache = { at: Date.now(), value };
      return value;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function getCalendarHealth(now = Date.now()) {
  const snap = readSnapshot();
  return {
    sources: getCalendarSources().map((def) => {
      const h = stateOf(def.id);
      return { id: def.id, name: def.name, enabled: def.enabled, offReason: def.offReason || null, status: def.enabled ? health.statusOf(h, now) : "off", fails: h.fails, okAt: h.okAt || null, nextTryAt: h.nextTryAt || null, lastError: h.lastError };
    }),
    snapshotAt: snap ? snap.fetchedAt : null,
  };
}

function _reset() {
  states.clear();
  cache = null;
  inflight = null;
}

module.exports = { CalendarUnavailableError, IMPACT_RANK, SNAPSHOT_FILE, getCalendar, getCalendarHealth, filterEvents, parseFactory, parseFinnhubCalendar, _reset };
