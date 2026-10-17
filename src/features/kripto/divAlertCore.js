"use strict";

/**
 * features/kripto/divAlertCore.js
 * ------------------------------------------------------------------
 * Logika MURNI untuk !alertdivergent (alarm divergence). Tanpa fetch, tanpa membaca
 * store/cache, tanpa kirim pesan, jadi bisa diuji unit (src/test/alertdiv.test.js).
 * Yang ada di sini:
 *   - jadwal candle closed per TF (kapan sebuah TF "jatuh tempo" diproses)
 *   - kunci dedupe + pencocokan hasil detectDivergence ke langganan
 *   - perencanaan pesan (satu per sinyal vs satu ringkasan) + pembatas pesan per chat per jam
 *   - parser argumen command
 *   - pembuat teks pesan (i18n) dan format waktu candle
 *
 * Pengambilan data, state persisten, dan pengiriman ada di alertMonitor.js + cryptoStore.js.
 *
 * Catatan zona waktu: candle Binance berbasis UTC. Waktu di pesan ditampilkan dalam DAILY_TZ
 * (default WIB, sama dengan ringkasan harian); ubah lewat env DAILY_TZ / DAILY_TZ_LABEL.
 *
 * Changelog parameter: v1 (2026-10-16) nilai awal usulan PDF 5.4-5.6.
 */

const { t } = require("../../i18n");

// ---------- konstanta (satu tempat) ----------
const posInt = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);

const TF_MS = { "15M": 15 * 60_000, "1H": 3_600_000, "4H": 4 * 3_600_000, "1D": 86_400_000 };
const TF_ORDER = ["1D", "4H", "1H", "15M"]; // diproses dari TF besar ke kecil saat jatuh tempo bersamaan
const TF_LABEL = { "15M": "15m", "1H": "1H", "4H": "4H", "1D": "1D" };

const ALERT_DIV = {
  CHECK_MS: Math.max(5_000, posInt(process.env.DIV_CHECK_MS, 15_000)), // pemeriksaan ringan (PDF 5.4: 15-30 dtk)
  DELAY_MS: posInt(process.env.DIV_DELAY_MS, 10_000), // tunggu setelah candle tutup agar data Binance final (5-15 dtk)
  RETRY_MS: 60_000, // jeda antar percobaan ulang kalau sebagian gagal
  MAX_ATTEMPTS: 3, // total percobaan per candle closed sebelum menyerah (dedupe mencegah ganda)
  // Ambang teks vs PDF (usulan PDF 17 Okt, BELUM diputuskan client): PDF bila sinyal > PDF_MIN_SIGNALS
  // ATAU jumlah TF yang punya sinyal >= PDF_MIN_TFS (0 = aturan TF dimatikan). Selain itu teks singkat.
  PDF_MIN_SIGNALS: posInt(process.env.DIV_PDF_MIN_SIGNALS ?? process.env.DIV_SUMMARY_THRESHOLD, 5),
  PDF_MIN_TFS: Number.isInteger(Number(process.env.DIV_PDF_MIN_TFS)) && Number(process.env.DIV_PDF_MIN_TFS) >= 0 ? Number(process.env.DIV_PDF_MIN_TFS) : 2,
  MAX_MSG_PER_CHAT_HOUR: posInt(process.env.DIV_MAX_MSG_PER_CHAT_HOUR, 20), // pengaman terakhir
  SEND_GAP_MS: posInt(process.env.DIV_SEND_GAP_MS, 1_000), // jeda antar pesan supaya tidak terlihat spam
  FRESH_RATIO: 0.8, // minimal 80% koin snapshot sudah memuat candle closed terbaru
};
// Alarm "semua koin" hanya untuk TF ini (15m untuk semua terlalu berat, PDF 5.6).
const ALL_COINS_TFS = (process.env.DIV_ALERT_ALL_TFS || "1H,4H,1D")
  .split(",")
  .map((x) => x.trim().toUpperCase())
  .filter((x) => TF_MS[x]);

const COIN_ALL = "*"; // semua koin yang tersedia
const COIN_WATCHLIST = "WATCHLIST"; // watchlist pribadi pemilik alarm (dibaca saat putaran berjalan)

const DAILY_TZ = process.env.DAILY_TZ || "Asia/Jakarta";
const DAILY_TZ_LABEL = process.env.DAILY_TZ_LABEL || (DAILY_TZ === "Asia/Jakarta" ? "WIB" : DAILY_TZ);

// =====================================================================
// 1. Jadwal candle closed
// =====================================================================
/**
 * Waktu (ms, UTC) saat candle terakhir yang sudah tutup berakhir = awal candle yang sedang berjalan.
 * Binance menyelaraskan candle 15m/1H/4H/1D ke epoch UTC, jadi cukup pembulatan ke bawah.
 */
const lastClosedBoundary = (tf, now) => Math.floor(now / TF_MS[tf]) * TF_MS[tf];

/** Waktu BUKA candle closed terakhir untuk boundary tertentu (dipakai memeriksa data Binance sudah final). */
const lastCandleOpen = (tf, boundary) => boundary - TF_MS[tf];

/**
 * TF mana yang jatuh tempo diproses sekarang.
 * Jatuh tempo = ada candle closed baru (boundary > lastClosed[tf]), sudah lewat delayMs sejak tutup,
 * dan (kalau sedang menunggu percobaan ulang untuk boundary yang sama) sudah lewat nextAt.
 * @param {{tfs:string[], now:number, lastClosed:Record<string,number>, delayMs?:number,
 *   retry?:Map<string,{boundary:number,attempts:number,nextAt:number}>}} p
 * @returns {Array<{tf:string, boundary:number, attempts:number}>} urut TF besar -> kecil
 */
function dueTfs({ tfs, now, lastClosed, delayMs = ALERT_DIV.DELAY_MS, retry }) {
  const out = [];
  for (const tf of TF_ORDER) {
    if (!tfs.includes(tf)) continue;
    const boundary = lastClosedBoundary(tf, now);
    if (boundary <= (lastClosed[tf] || 0)) continue; // belum ada candle closed baru
    if (now < boundary + delayMs) continue; // tunggu data final
    const r = retry && retry.get(tf);
    if (r && r.boundary === boundary && now < r.nextAt) continue; // menunggu percobaan ulang
    out.push({ tf, boundary, attempts: r && r.boundary === boundary ? r.attempts : 0 });
  }
  return out;
}

// =====================================================================
// 2. Dedupe + pencocokan
// =====================================================================
/**
 * Kunci unik: tujuan | koin | tf | indikator | jenis | arah | waktu pivot kedua (PDF 5.5).
 * "Tujuan" (chat + user) ikut di kunci supaya dua orang yang memantau koin yang sama sama-sama
 * dapat alarmnya, tetapi satu orang tidak dapat dua kali walau punya dua alarm yang tumpang tindih.
 */
const dedupeKey = (chat, userJid, coin, tf, indicator, kind, dir, pivotTime) =>
  [chat, userJid, coin, tf, indicator, kind, dir, pivotTime].join("|");

/** Koin yang dipantau satu langganan. */
function subCoins(sub, { allCoins, watchOf, userJid }) {
  if (sub.coin === COIN_ALL) return [...allCoins];
  if (sub.coin === COIN_WATCHLIST) return watchOf(userJid);
  return [sub.coin];
}

/**
 * Cocokkan hasil detectDivergence ke langganan, buang yang sudah terkirim, dedupe dalam satu putaran.
 * Aturan "baru": divergence harus terkonfirmasi (candle konfirmasi tutup) SETELAH alarm dibuat, jadi
 * membuat alarm tidak memicu sinyal lama yang sudah ada.
 *
 * @param {{subs:Array<{userJid:string, sub:object}>, tf:string,
 *   divsByCoin:Map<string,object[]>, allCoins:Iterable<string>,
 *   watchOf:(jid:string)=>string[], isSent:(key:string)=>boolean}} p
 * @returns {Array<{key,chat,userJid,coin,tf,indicator,kind,dir,pivot2Time,confirmedCloseTime,barsAgo}>}
 */
function collectItems({ subs, tf, divsByCoin, allCoins, watchOf, isSent }) {
  const items = new Map(); // key -> item (dedupe dalam putaran)
  const tfMs = TF_MS[tf];
  const all = allCoins instanceof Set ? allCoins : new Set(allCoins || []);

  for (const { userJid, sub } of subs) {
    if (sub.tf !== tf) continue;
    for (const coin of subCoins(sub, { allCoins: all, watchOf, userJid })) {
      for (const d of divsByCoin.get(coin) || []) {
        if (!sub.indicators.includes(d.indicator)) continue;
        if (sub.dirs && sub.dirs.length && !sub.dirs.includes(d.dir)) continue;
        if (sub.kinds && sub.kinds.length && !sub.kinds.includes(d.kind)) continue;
        const confirmedCloseTime = d.confirmedAtTime + tfMs;
        if (confirmedCloseTime <= sub.createdAt) continue; // terbentuk sebelum alarm dibuat
        const key = dedupeKey(sub.chat, userJid, coin, tf, d.indicator, d.kind, d.dir, d.pivot2.time);
        if (items.has(key) || isSent(key)) continue;
        items.set(key, {
          key,
          chat: sub.chat,
          userJid,
          coin,
          tf,
          indicator: d.indicator,
          kind: d.kind,
          dir: d.dir,
          pivot2Time: d.pivot2.time,
          confirmedCloseTime,
          barsAgo: d.barsAgo,
        });
      }
    }
  }
  return [...items.values()].sort(
    (a, b) => a.coin.localeCompare(b.coin) || a.indicator.localeCompare(b.indicator) || a.kind.localeCompare(b.kind) || a.dir.localeCompare(b.dir),
  );
}

/** Kelompokkan per tujuan (chat + user). Satu grup = satu penerima pesan. */
function groupByRecipient(items) {
  const groups = new Map();
  for (const it of items) {
    const k = `${it.chat}|${it.userJid}`;
    if (!groups.has(k)) groups.set(k, { chat: it.chat, userJid: it.userJid, items: [] });
    groups.get(k).items.push(it);
  }
  return [...groups.values()];
}

// =====================================================================
// 3. Laporan gabungan (teks singkat atau PDF) + pembatas laju
// =====================================================================
const DIR_ORDER = ["bull", "bear"];
const cmpRow = (a, b) => a.coin.localeCompare(b.coin) || a.indicator.localeCompare(b.indicator) || a.kind.localeCompare(b.kind);

/**
 * Kelompokkan sinyal per TF (urut TF_ORDER: 1D > 4H > 1H > 15m), lalu Bullish / Bearish.
 * TF di `tfs` tanpa sinyal tetap muncul (bagian kosong), supaya jelas TF itu sudah dicek.
 * @param {Array<{tf:string, coin:string, indicator:string, kind:string, dir:'bull'|'bear'}>} items
 * @param {string[]} tfs kunci TF yang dilaporkan ("1D", "4H", "1H", "15M")
 * @returns {Array<{tf:string, key:string, bull:object[], bear:object[]}>} tf = label tampil ("15m")
 */
function buildSections(items, tfs) {
  return TF_ORDER.filter((k) => tfs.includes(k)).map((k) => {
    const mine = items.filter((it) => it.tf === k);
    const pick = (dir) => mine.filter((it) => it.dir === dir).map((it) => ({ coin: it.coin, indicator: it.indicator, kind: it.kind })).sort(cmpRow);
    return { key: k, tf: TF_LABEL[k], bull: pick("bull"), bear: pick("bear") };
  });
}

const sectionCount = (s) => s.bull.length + s.bear.length;
const totalSignals = (sections) => sections.reduce((n, s) => n + sectionCount(s), 0);

/**
 * @returns {"none"|"text"|"pdf"} none = tidak ada sinyal.
 */
function chooseReportMode(sections, { minSignals = ALERT_DIV.PDF_MIN_SIGNALS, minTfs = ALERT_DIV.PDF_MIN_TFS } = {}) {
  const n = totalSignals(sections);
  if (!n) return "none";
  const tfsWithSignals = sections.filter((s) => sectionCount(s) > 0).length;
  if (n > minSignals || (minTfs > 0 && tfsWithSignals >= minTfs)) return "pdf";
  return "text";
}

/** "1D 3, 4H 2, 1H 0" (hanya dipakai di teks pengantar). */
const countsLabel = (sections) => sections.map((s) => `${s.tf}: ${sectionCount(s)}`).join(", ");

/** Pesan pengantar SATU baris sebelum PDF. mode: "alert" | "scan". */
function buildPdfIntro(lang, sections, { mode = "alert", time }) {
  return t(lang, `divreport.intro.${mode}`, { time, counts: countsLabel(sections), n: totalSignals(sections) });
}

/**
 * Teks singkat (sinyal sedikit): dikelompokkan per TF lalu Bullish / Bearish. Tidak ada batas baris
 * (kalau sinyalnya banyak, chooseReportMode sudah memilih PDF).
 */
function buildGroupedText(lang, sections, { mode = "alert", time, filters = "" }) {
  const blocks = [];
  for (const s of sections) {
    const n = sectionCount(s);
    if (!n) continue;
    const lines = [t(lang, "divreport.tfHead", { tf: s.tf, n })];
    for (const dir of DIR_ORDER) {
      const rows = s[dir];
      if (!rows.length) continue;
      lines.push(t(lang, `divreport.group.${dir}`));
      for (const r of rows) lines.push(t(lang, "divreport.row", { coin: r.coin, ind: indLabel(r.indicator), kind: t(lang, `div.kind.${r.kind}`) }));
    }
    blocks.push(lines.join("\n"));
  }
  return t(lang, `divreport.head.${mode}`, { n: totalSignals(sections), time, filters }) + "\n\n" + blocks.join("\n\n") + "\n\n" + t(lang, "divreport.foot");
}

/** Batas pesan per chat per jam (jendela bergeser, di memori; reset saat bot restart). */
class ChatRateLimiter {
  constructor({ max = ALERT_DIV.MAX_MSG_PER_CHAT_HOUR, windowMs = 3_600_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.log = new Map(); // chat -> number[] (waktu kirim)
  }
  _trim(chat, now) {
    const arr = (this.log.get(chat) || []).filter((at) => now - at < this.windowMs);
    if (arr.length) this.log.set(chat, arr);
    else this.log.delete(chat);
    return arr;
  }
  remaining(chat, now = Date.now()) {
    return Math.max(0, this.max - this._trim(chat, now).length);
  }
  record(chat, now = Date.now()) {
    const arr = this._trim(chat, now);
    arr.push(now);
    this.log.set(chat, arr);
  }
}

// =====================================================================
// 4. Parser argumen command
// =====================================================================
const IND_TOKENS = { rsi: "rsi", macd: "macd" };
const KIND_TOKENS = { reguler: "regular", regular: "regular", tersembunyi: "hidden", hidden: "hidden" };
const DIR_TOKENS = { bull: "bull", bullish: "bull", naik: "bull", bear: "bear", bearish: "bear", turun: "bear" };
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const ALL_TOKENS = new Set(["semua", "all"]);
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const ON_TOKENS = new Set(["on", "aktif", "nyala"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const COIN_RE = /^[A-Z0-9]{1,15}$/;

/**
 * !alertdiv <koin|semua|watchlist> [tf] [rsi|macd] [bull|bear] [reguler|tersembunyi]
 * !alertdiv on [tf] [rsi|macd] [bull|bear] [reguler|tersembunyi]   (semua koin; 15m lewat watchlist)
 * !alertdiv off                                                      (matikan semua alarm saya)
 * !alertdiv list
 * !alertdiv hapus <id|semua>
 * @returns {object|null} null kalau format salah (-> tampilkan penjelasan command)
 */
function parseAlertDivArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();

  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;

  // on/off (item 05): on = jalan pintas "semua koin", off = hapus semua alarm milik saya.
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (ON_TOKENS.has(first)) {
    const parsed = parseAlertDivArgs(["semua", ...tokens.slice(1)].join(" "), null);
    return parsed && parsed.action === "create" ? { ...parsed, action: "on" } : null;
  }

  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?d?(\d{1,6})$/);
    return m ? { action: "delete", id: `d${Number(m[1])}` } : null;
  }

  let coin = null;
  let tf = null;
  const inds = [];
  const dirs = [];
  const kinds = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (IND_TOKENS[low]) inds.push(IND_TOKENS[low]);
    else if (DIR_TOKENS[low]) dirs.push(DIR_TOKENS[low]);
    else if (KIND_TOKENS[low]) kinds.push(KIND_TOKENS[low]);
    else if (coin == null) {
      if (ALL_TOKENS.has(low)) coin = COIN_ALL;
      else if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null; // lebih dari satu koin / token tak dikenal
  }
  if (!coin) return null;
  return {
    action: "create",
    coin,
    tf: tf || defaultTf,
    indicators: inds.length ? [...new Set(inds)] : ["rsi", "macd"], // default RSI + MACD (PDF 5.2)
    dirs: [...new Set(dirs)].length === 2 ? [] : [...new Set(dirs)], // dua arah = semua arah
    kinds: [...new Set(kinds)].length === 2 ? [] : [...new Set(kinds)],
  };
}

// =====================================================================
// 5. Teks pesan
// =====================================================================
/** "15 Okt 2026 15:00 WIB" (id) / "15 Oct 2026 15:00 WIB" (en). */
function fmtCandleTime(lang, ms, tz = DAILY_TZ, tzLabel = DAILY_TZ_LABEL) {
  const date = new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "id-ID", {
    timeZone: tz,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(ms));
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return `${date} ${time} ${tzLabel}`;
}

/** "Reguler Bullish" */
const kindDir = (lang, kind, dir) => `${t(lang, `div.kind.${kind}`)} ${t(lang, `div.dir.${dir}`)}`;

/** "RSI" / "MACD" */
const indLabel = (indicator) => indicator.toUpperCase();

function buildSingleText(lang, it) {
  return t(lang, "divalert.msg.single", {
    coin: it.coin,
    tf: TF_LABEL[it.tf] || it.tf,
    ind: indLabel(it.indicator),
    kd: kindDir(lang, it.kind, it.dir),
    desc: t(lang, `divalert.desc.${it.kind}.${it.dir}`, { ind: t(lang, `divalert.indDesc.${it.indicator}`) }),
    time: fmtCandleTime(lang, it.confirmedCloseTime),
  });
}

/** Ringkasan filter alarm: "RSI/MACD" + arah + jenis kalau dibatasi. */
function describeFilters(lang, sub) {
  const parts = [sub.indicators.map((i) => i.toUpperCase()).join("/")];
  if (sub.dirs && sub.dirs.length) parts.push(sub.dirs.map((d) => t(lang, `div.dir.${d}`)).join("/"));
  if (sub.kinds && sub.kinds.length) parts.push(sub.kinds.map((k) => t(lang, `div.kind.${k}`)).join("/"));
  return parts.join(", ");
}

module.exports = {
  TF_MS,
  TF_ORDER,
  TF_LABEL,
  ALERT_DIV,
  ALL_COINS_TFS,
  COIN_ALL,
  COIN_WATCHLIST,
  DAILY_TZ,
  DAILY_TZ_LABEL,
  lastClosedBoundary,
  lastCandleOpen,
  dueTfs,
  dedupeKey,
  collectItems,
  groupByRecipient,
  buildSections,
  totalSignals,
  chooseReportMode,
  buildPdfIntro,
  buildGroupedText,
  ChatRateLimiter,
  parseAlertDivArgs,
  fmtCandleTime,
  buildSingleText,
  describeFilters,
};
