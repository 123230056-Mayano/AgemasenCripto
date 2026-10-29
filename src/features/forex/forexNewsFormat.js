"use strict";

/**
 * features/forex/forexNewsFormat.js
 * ------------------------------------------------------------------
 * Pemformat pesan WhatsApp untuk berita & kalender forex (teks via i18n id/en).
 * Zona waktu tampilan: env FXNEWS_TZ (default Asia/Jakarta) dengan label FXNEWS_TZ_LABEL (default WIB).
 */

const { t } = require("../../i18n");

const TZ = process.env.FXNEWS_TZ || "Asia/Jakarta";
const TZ_LABEL = process.env.FXNEWS_TZ_LABEL || (TZ === "Asia/Jakarta" ? "WIB" : TZ);
const IMPACT_EMOJI = { high: "🔴", medium: "🟠", low: "🟡" };
const SUMMARY_MAX = 280;
const CAL_MAX_LINES = 40;

const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }); // YYYY-MM-DD

const fmtTime = (ts) => timeFmt.format(ts);
const dayKey = (ts) => dayKeyFmt.format(ts);
const dayHeader = (ts, lang) => new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "id-ID", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(ts);

/** Selisih ms -> "45 dtk" / "12 mnt" / "3 jam" (sesuai bahasa). */
function ago(ms, lang) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return t(lang, "fxnews.ago.s", { n: s });
  const m = Math.round(s / 60);
  if (m < 90) return t(lang, "fxnews.ago.m", { n: m });
  return t(lang, "fxnews.ago.h", { n: Math.round(m / 60) });
}

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Satu headline -> teks pesan. */
function formatHeadline(it, lang) {
  const lines = [t(lang, "fxnews.header", { source: it.srcName || it.src }), `*${it.title}*`];
  // ringkasan hanya ditampilkan kalau menambah informasi (bukan sekadar mengulang judul)
  if (it.summary && !it.summary.toLowerCase().startsWith(it.title.toLowerCase().slice(0, 40))) lines.push("", clip(it.summary, SUMMARY_MAX));
  lines.push("", t(lang, "fxnews.time", { time: fmtTime(it.ts), tz: TZ_LABEL }));
  if (it.link) lines.push(it.link);
  return lines.join("\n");
}

/** Daftar headline untuk !fxnews. */
function formatLatest(items, lang, { stale = false, staleAgeMs = 0 } = {}) {
  const lines = [t(lang, "fxnews.latest.header", { n: items.length })];
  if (stale) lines.push(t(lang, "fxnews.latest.stale", { age: ago(staleAgeMs, lang) }));
  lines.push("");
  items.forEach((it, i) => {
    lines.push(`${i + 1}. *${it.title}*`);
    lines.push(`   ${fmtTime(it.ts ?? Date.now())} ${TZ_LABEL} · ${it.srcName || it.src}${it.link ? `\n   ${it.link}` : ""}`);
  });
  lines.push("", t(lang, "fxnews.disclaimer"));
  return lines.join("\n");
}

const impactLabel = (lang, imp) => t(lang, `fxcal.impact.${imp}`);

function eventLine(e, lang) {
  const base = `${IMPACT_EMOJI[e.impact] || "⚪"} ${fmtTime(e.ts)} *${e.ccy}* ${e.title}`;
  if (e.forecast || e.previous) return `${base}\n     ${t(lang, "fxcal.values", { forecast: e.forecast || "-", previous: e.previous || "-" })}`;
  return base;
}

/** Kalender untuk !fxcal, dikelompokkan per hari. */
function formatCalendar(events, lang, { rangeKey = "today", stale = false, fetchedAt = 0, now = Date.now() } = {}) {
  const lines = [t(lang, "fxcal.header", { range: t(lang, `fxcal.range.${rangeKey}`) })];
  if (stale) lines.push(t(lang, "fxcal.stale", { ago: ago(now - fetchedAt, lang) }));
  if (!events.length) {
    lines.push("", t(lang, "fxcal.empty"));
    return lines.join("\n");
  }
  let lastDay = "";
  let shown = 0;
  for (const e of events) {
    if (shown >= CAL_MAX_LINES) break;
    const dk = dayKey(e.ts);
    if (dk !== lastDay) {
      lines.push("", `*${dayHeader(e.ts, lang)}*`);
      lastDay = dk;
    }
    lines.push(eventLine(e, lang));
    shown++;
  }
  if (events.length > shown) lines.push("", t(lang, "fxcal.more", { n: events.length - shown }));
  lines.push("", `🔴 ${impactLabel(lang, "high")}  🟠 ${impactLabel(lang, "medium")}  🟡 ${impactLabel(lang, "low")}`);
  return lines.join("\n");
}

/** Pengingat sebelum rilis (semua event pada waktu rilis yang sama dalam satu pesan). */
function formatReminder(events, minsLeft, lang) {
  const ts = events[0].ts;
  const lines = [t(lang, "fxcal.reminder.header", { mins: Math.max(1, Math.round(minsLeft)), time: fmtTime(ts), tz: TZ_LABEL }), ""];
  for (const e of events) lines.push(eventLine(e, lang));
  lines.push("", t(lang, "fxcal.reminder.footer"));
  return lines.join("\n");
}

module.exports = { TZ, TZ_LABEL, fmtTime, dayKey, ago, formatHeadline, formatLatest, formatCalendar, formatReminder };
