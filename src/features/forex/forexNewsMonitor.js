"use strict";

/**
 * features/forex/forexNewsMonitor.js
 * ------------------------------------------------------------------
 * Pemantau latar belakang alert berita forex. connection.js memanggil setNewsSocket(sock) tiap kali socket
 * Baileys dibuat; timer hanya dibuat sekali (pola sama dengan kripto/alertMonitor.js).
 *
 * Tiap siklus (FXNEWS_POLL_MS, default 45 dtk):
 *   1. fetchAll(): semua sumber headline aktif dipoll (lihat forexNews.js; sumber yang gagal dilewati sementara).
 *   2. selectFresh(): buang yang sudah pernah diproses / duplikat judul antar-sumber / terlalu lama.
 *      Siklus PERTAMA setelah state kosong hanya menandai (baseline), tidak mengirim apa pun.
 *   3. Kirim headline baru ke chat yang berlangganan (maks FXNEWS_MAX_PER_TICK terbaru per siklus).
 *   4. Pengingat kalender: rilis dampak tinggi/sedang yang tinggal <= FXNEWS_REMINDER_MIN menit (default 15),
 *      satu pesan per waktu rilis, sekali saja (kunci rem:<waktu> disimpan di state).
 *   5. Semua sumber headline gagal > 10 menit -> owner dikabari sekali, dan sekali lagi saat pulih.
 *
 * Chat yang grupnya dimatikan (!bot off) atau langganan botnya habis dilewati. FXNEWS_DISABLED=1 mematikan monitor.
 */

const { OWNER_JID } = require("../../config/env");
const { t } = require("../../i18n");
const { getLang } = require("../../state/languageStore");
const { isBotDisabledFor } = require("../../state/botState");
const { checkSubscription } = require("../../state/subscriptionStore");
const store = require("./forexNewsStore");
const news = require("./forexNews");
const cal = require("./forexCalendar");
const fmt = require("./forexNewsFormat");

const MAX_PER_TICK = Math.max(1, Number(process.env.FXNEWS_MAX_PER_TICK) || 5);
const REMINDER_MS = Math.max(1, Number(process.env.FXNEWS_REMINDER_MIN) || 15) * 60_000;
const OUTAGE_NOTICE_MS = 10 * 60_000;
const OWNER_NOTICE = process.env.FXNEWS_OWNER_NOTICE !== "0";

let sockRef = null;
let timer = null;
let busy = false;
let outageSince = 0;
let outageNotified = false;

const langFor = (chat) => getLang(chat.endsWith("@g.us") ? "group" : "user", chat);

/** Chat berlangganan yang boleh menerima kiriman sekarang. */
function activeSubs(kind) {
  return store.listSubs().filter((s) => {
    if (kind === "news" && !s.news) return false;
    if (kind === "cal" && !s.cal) return false;
    if (isBotDisabledFor(s.chat)) return false;
    if (s.chat === OWNER_JID) return true;
    const isGroup = s.chat.endsWith("@g.us");
    try {
      return checkSubscription(isGroup ? "group" : "user", s.chat).allowed;
    } catch {
      return true;
    }
  });
}

async function send(chat, text) {
  if (!sockRef) return false;
  try {
    await sockRef.sendMessage(chat, { text });
    return true;
  } catch (err) {
    console.log(`[fxnews] gagal kirim ke ${chat}:`, err.message);
    return false;
  }
}

async function noticeOwner(text) {
  if (OWNER_JID && OWNER_NOTICE) await send(OWNER_JID, text);
}

function trackOutage(err, now) {
  if (!outageSince) outageSince = now;
  if (!outageNotified && now - outageSince >= OUTAGE_NOTICE_MS) {
    outageNotified = true;
    const detail = (err?.sources || []).map((s) => `${s.id}: ${s.status}`).join(", ");
    noticeOwner(t(langFor(OWNER_JID || ""), "fxnews.owner.down", { mins: Math.round((now - outageSince) / 60_000), detail })).catch(() => {});
  }
}

function clearOutage() {
  if (outageNotified) noticeOwner(t(langFor(OWNER_JID || ""), "fxnews.owner.up")).catch(() => {});
  outageSince = 0;
  outageNotified = false;
}

async function newsPass(now) {
  let data;
  try {
    data = await news.fetchAll({ now });
  } catch (err) {
    if (err instanceof news.NewsUnavailableError) trackOutage(err, now);
    else console.log("[fxnews] fetchAll error:", err.message);
    return;
  }
  clearOutage();

  const baseline = !store.isBaselined();
  const { fresh } = news.selectFresh(data.items, { store, now, baseline });
  if (baseline) {
    store.setBaselined();
    store.flushSync();
    console.log(`[fxnews] baseline: ${data.items.length} berita ditandai tanpa dikirim.`);
    return;
  }
  if (!fresh.length) return;

  const subs = activeSubs("news");
  if (!subs.length) return;
  const batch = fresh.slice(-MAX_PER_TICK); // yang lebih lama dari batas ikut ditandai sudah-dilihat, tidak dikirim
  for (const s of subs) {
    const lang = langFor(s.chat);
    for (const it of batch) await send(s.chat, fmt.formatHeadline(it, lang));
  }
}

async function calendarPass(now) {
  const subs = activeSubs("cal");
  if (!subs.length) return;
  let c;
  try {
    c = await cal.getCalendar({ now });
  } catch {
    return; // tidak ada kalender sama sekali: lewati siklus ini
  }
  const upcoming = c.events.filter((e) => e.ts > now && e.ts - now <= REMINDER_MS && e.impact !== "holiday");
  const byTs = new Map();
  for (const e of upcoming) byTs.set(e.ts, [...(byTs.get(e.ts) || []), e]);

  for (const [ts, events] of byTs) {
    const key = `rem:${ts}`;
    if (store.hasSeen(key)) continue;
    store.markSeen(key, now);
    const minsLeft = (ts - now) / 60_000;
    for (const s of subs) {
      const mine = cal.filterEvents(events, { minImpact: s.impact === "medium" ? "medium" : "high" });
      if (mine.length) await send(s.chat, fmt.formatReminder(mine, minsLeft, langFor(s.chat)));
    }
  }
}

async function tick() {
  if (busy || !sockRef) return;
  busy = true;
  const now = Date.now();
  try {
    await newsPass(now);
    await calendarPass(now);
  } catch (err) {
    console.log("[fxnews] tick error:", err);
  } finally {
    busy = false;
  }
}

/** Dipanggil connection.js tiap socket baru dibuat. Timer hanya dibuat sekali. */
function setNewsSocket(sock) {
  sockRef = sock;
  if (timer || process.env.FXNEWS_DISABLED === "1") return;
  timer = setInterval(() => tick().catch(() => {}), news.POLL_MS);
  timer.unref?.();
  const first = setTimeout(() => tick().catch(() => {}), 8_000);
  first.unref?.();
}

module.exports = { setNewsSocket, tick, activeSubs, _setSocket: (s) => (sockRef = s), _resetOutage: () => { outageSince = 0; outageNotified = false; } };
