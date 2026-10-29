"use strict";

/**
 * features/forex/forexNewsCommand.js
 * ------------------------------------------------------------------
 *   !fxnews [jumlah]                 headline forex terbaru (default 5, maks 10)
 *   !fxnews on [berita|kalender|semua] [medium|high]   aktifkan alert di chat ini
 *   !fxnews off                      matikan alert di chat ini
 *   !fxnews status                   status langganan + kesehatan tiap sumber (berita & kalender)
 *   !fxcal [hari ini|besok|minggu] [high|medium|all] [mata uang...]   kalender ekonomi
 * Alias: !berita, !fxberita | !kalender, !fxkalender, !fxcalendar.
 *
 * Di grup, on/off hanya untuk admin grup atau owner (status & daftar boleh semua anggota).
 */

const { t } = require("../../i18n");
const { isOwnerMsg } = require("../../utils/whatsapp");
const { isGroupAdmin } = require("../settings/languageCommand");
const { sendCommandDetail } = require("../menu/menu");
const store = require("./forexNewsStore");
const news = require("./forexNews");
const cal = require("./forexCalendar");
const fmt = require("./forexNewsFormat");

const RE = /^[!.](fxnews|fxberita|berita|fxcal|fxcalendar|fxkalender|kalender)(?:\s+([\s\S]*))?$/i;
const CCYS = new Set(["usd", "eur", "gbp", "jpy", "aud", "nzd", "cad", "chf", "cny", "idr"]);
const REMINDER_MIN = Math.max(1, Number(process.env.FXNEWS_REMINDER_MIN) || 15);
const LATEST_DEFAULT = 5;
const LATEST_MAX = 10;

const words = (s) => String(s || "").toLowerCase().split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------
// !fxnews
// ---------------------------------------------------------------------
async function replyLatest(sock, jid, lang, limit) {
  try {
    const r = await news.latestHeadlines(limit);
    await sock.sendMessage(jid, { text: fmt.formatLatest(r.items, lang) });
  } catch (err) {
    if (!(err instanceof news.NewsUnavailableError)) throw err;
    const stale = news.dedupeForDisplay(err.staleItems || []).slice(0, limit);
    if (!stale.length) {
      await sock.sendMessage(jid, { text: t(lang, "fxnews.unavailable") });
      return;
    }
    const okAt = Math.max(0, ...news.getNewsHealth().map((s) => s.okAt || 0));
    await sock.sendMessage(jid, { text: fmt.formatLatest(stale, lang, { stale: true, staleAgeMs: Date.now() - okAt }) });
  }
}

function waitText(ms, lang) {
  return fmt.ago(Math.max(0, ms), lang);
}

function srcLine(s, lang, now) {
  const base = { name: s.name };
  if (s.status === "off") return t(lang, "fxnews.src.off", { ...base, reason: s.offReason || "-" });
  if (s.status === "idle") return t(lang, "fxnews.src.idle", base);
  if (s.status === "ok") return t(lang, "fxnews.src.ok", { ...base, ago: fmt.ago(now - s.okAt, lang) });
  const key = s.status === "cooldown" ? "fxnews.src.cooldown" : "fxnews.src.retry";
  return t(lang, key, { ...base, fails: s.fails, wait: waitText((s.nextTryAt || now) - now, lang), error: s.lastError || "?" });
}

function statusText(jid, lang) {
  const now = Date.now();
  const sub = store.getSub(jid);
  const yn = (v) => t(lang, v ? "fxnews.yes" : "fxnews.no");
  const lines = [t(lang, "fxnews.status.header"), ""];
  lines.push(sub ? t(lang, "fxnews.status.sub.on", { news: yn(sub.news), cal: yn(sub.cal), impact: t(lang, `fxcal.impact.${sub.impact === "medium" ? "medium" : "high"}`) }) : t(lang, "fxnews.status.sub.off"));
  lines.push("", t(lang, "fxnews.status.news"));
  for (const s of news.getNewsHealth(now)) lines.push(srcLine(s, lang, now));
  const ch = cal.getCalendarHealth(now);
  lines.push("", t(lang, "fxnews.status.cal"));
  for (const s of ch.sources) lines.push(srcLine(s, lang, now));
  lines.push(ch.snapshotAt ? t(lang, "fxnews.cal.snapshot", { ago: fmt.ago(now - ch.snapshotAt, lang) }) : t(lang, "fxnews.cal.snapshot.none"));
  return lines.join("\n");
}

async function canManage(sock, msg, jid) {
  if (!jid.endsWith("@g.us") || isOwnerMsg(msg)) return { ok: true };
  try {
    return (await isGroupAdmin(sock, jid, msg)) ? { ok: true } : { ok: false, reason: "fxnews.adminOnly" };
  } catch {
    return { ok: false, reason: "fxnews.adminCheckFailed" };
  }
}

async function handleNews(sock, msg, { jid, lang }, args) {
  const w = words(args);
  const first = w[0];

  if (first === "status" || first === "info") {
    await sock.sendMessage(jid, { text: statusText(jid, lang) });
    return;
  }

  if (first === "on" || first === "aktif" || first === "off" || first === "mati") {
    const perm = await canManage(sock, msg, jid);
    if (!perm.ok) {
      await sock.sendMessage(jid, { text: t(lang, perm.reason) });
      return;
    }
    if (first === "off" || first === "mati") {
      const had = store.removeSub(jid);
      store.flushSync();
      await sock.sendMessage(jid, { text: t(lang, had ? "fxnews.off" : "fxnews.off.none") });
      return;
    }
    const opts = w.slice(1);
    const onlyNews = opts.some((x) => ["berita", "news"].includes(x));
    const onlyCal = opts.some((x) => ["kalender", "calendar", "cal"].includes(x));
    const both = opts.some((x) => ["semua", "all"].includes(x)) || onlyNews === onlyCal;
    const impact = opts.some((x) => ["medium", "sedang"].includes(x)) ? "medium" : "high";
    const sub = store.setSub(jid, { news: both || onlyNews, cal: both || onlyCal, impact });
    store.flushSync();
    const yn = (v) => t(lang, v ? "fxnews.yes" : "fxnews.no");
    await sock.sendMessage(jid, { text: t(lang, "fxnews.on", { news: yn(sub.news), cal: yn(sub.cal), impact: t(lang, `fxcal.impact.${sub.impact}`), lead: REMINDER_MIN }) });
    return;
  }

  const n = first ? Number(first) : LATEST_DEFAULT;
  if (first && !(Number.isInteger(n) && n >= 1)) {
    await sendCommandDetail(sock, jid, "fxnews", lang);
    return;
  }
  await replyLatest(sock, jid, lang, Math.min(LATEST_MAX, n));
}

// ---------------------------------------------------------------------
// !fxcal
// ---------------------------------------------------------------------
const RANGE_WORDS = {
  today: ["today", "hari", "harini", "hariini", "ini", "sekarang"],
  tomorrow: ["tomorrow", "besok"],
  week: ["week", "minggu", "pekan", "mingguan"],
};

function parseCalArgs(args) {
  const w = words(args);
  const out = { range: "today", minImpact: "medium", ccys: [] };
  for (const x of w) {
    const range = Object.keys(RANGE_WORDS).find((k) => RANGE_WORDS[k].includes(x));
    if (range) out.range = range;
    else if (["high", "tinggi"].includes(x)) out.minImpact = "high";
    else if (["medium", "sedang"].includes(x)) out.minImpact = "medium";
    else if (["all", "semua", "low", "rendah"].includes(x)) out.minImpact = "low";
    else if (CCYS.has(x)) out.ccys.push(x.toUpperCase());
    else return null; // kata tidak dikenal -> tampilkan bantuan
  }
  return out;
}

async function handleCalendar(sock, msg, { jid, lang }, args) {
  const p = parseCalArgs(args);
  if (!p) {
    await sendCommandDetail(sock, jid, "fxcal", lang);
    return;
  }
  let c;
  try {
    c = await cal.getCalendar();
  } catch (err) {
    if (err instanceof cal.CalendarUnavailableError) {
      await sock.sendMessage(jid, { text: t(lang, "fxcal.unavailable") });
      return;
    }
    throw err;
  }
  const now = Date.now();
  const today = fmt.dayKey(now);
  const tomorrow = fmt.dayKey(now + 86_400_000);
  const inRange = c.events.filter((e) => {
    const dk = fmt.dayKey(e.ts);
    if (p.range === "today") return dk === today;
    if (p.range === "tomorrow") return dk === tomorrow;
    return dk >= today;
  });
  const events = cal.filterEvents(inRange, { minImpact: p.minImpact, ccys: p.ccys });
  await sock.sendMessage(jid, { text: fmt.formatCalendar(events, lang, { rangeKey: p.range, stale: c.stale, fetchedAt: c.fetchedAt, now }) });
}

// ---------------------------------------------------------------------
async function handleForexNewsCommand(sock, msg, { jid, text, lang }) {
  const m = String(text || "").trim().match(RE);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const args = m[2] || "";
  try {
    if (["fxnews", "fxberita", "berita"].includes(cmd)) await handleNews(sock, msg, { jid, lang }, args);
    else await handleCalendar(sock, msg, { jid, lang }, args);
  } catch (err) {
    console.log("[fxnews] command error:", err);
    await sock.sendMessage(jid, { text: t(lang, "common.error") });
  }
  return true;
}

module.exports = { handleForexNewsCommand, parseCalArgs };
