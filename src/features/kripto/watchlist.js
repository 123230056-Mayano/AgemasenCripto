"use strict";

/**
 * features/kripto/watchlist.js
 * ------------------------------------------------------------------
 * Watchlist & alert (Command Kripto - Bagian 5). Pantauan pribadi per user:
 *   !watch <koin ...>      -> tambah satu/beberapa koin (!watch BTC ETH SOL), atau !watch all
 *   !unwatch <koin>        -> hapus koin dari watchlist
 *   !watchlist [pdf]       -> watchlist + harga, % 24 jam, tren singkat (lebih dari WATCH_PDF_MIN koin = PDF)
 *   !alert <koin> <harga>  -> alert harga (arah naik/turun ditentukan dari harga sekarang)
 *   !alertlevel <koin>     -> alert otomatis dekat support/resistance terdekat
 *   !alerts                -> semua alert aktif + ID
 *   !hapusalert <id>       -> hapus alert
 *   !harian [jam]          -> langganan ringkasan harian (mis. !harian 07:30, default 08:00)
 *   !stopharian            -> berhenti langganan
 *
 * Data disimpan di state/cryptoStore.js; pengiriman notifikasi otomatis
 * (alert & ringkasan harian) ada di alertMonitor.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { getDefaultTf } = require("./defaultTf");
const { computeEmas, classifyTrendAuto } = require("./indicators");
const { TF_LABEL, UnsupportedCoinError, fetchTicker, fetchCandles, computeLevels, fmtUsd, fmtLevel, fmtPct } = require("./market");
const { getAvailableCoins } = require("./kriptoList");
const { COINS } = require("./coinList");
const stat = require("./statistik"); // snapshot cache bersama (dipanggil lewat stat.getSnapshot supaya mudah diuji)
const { buildWatchlistPdf, summarize } = require("./watchPdf");

// Zona waktu ringkasan harian. Default WIB; ganti lewat env DAILY_TZ (nama zona IANA).
const DAILY_TZ = process.env.DAILY_TZ || "Asia/Jakarta";
const DAILY_TZ_LABEL = process.env.DAILY_TZ_LABEL || (DAILY_TZ === "Asia/Jakarta" ? "WIB" : DAILY_TZ);
const DAILY_DEFAULT = { hour: 8, minute: 0 };

const COIN_RE = /^[A-Z0-9]{1,15}$/;
const WATCH_ALL_TOKENS = new Set(["ALL", "SEMUA"]);
const WATCH_MAX_TOKENS = 50; // batas koin per perintah !watch (melindungi API Binance dari satu pesan raksasa)
const WATCH_LIST_CAP = 40; // maksimal ticker yang dirinci per baris balasan
// Watchlist lebih panjang dari ini dikirim sebagai PDF (bukan tabel teks). Default 20 = kapasitas tabel teks lama.
const WATCH_PDF_MIN = Number.isInteger(Number(process.env.WATCHLIST_PDF_MIN)) && Number(process.env.WATCHLIST_PDF_MIN) > 0 ? Number(process.env.WATCHLIST_PDF_MIN) : 20;
const WATCH_FALLBACK_MAX = 40; // koin di luar snapshot yang boleh diambil satu per satu (sisanya ditandai gagal)
const NAME_OF = new Map(COINS.map(([ticker, name]) => [ticker, name]));
const pad = (s, n) => String(s).padEnd(n, " ");
const hhmm = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const TREND_ICON = { bullish: "🟢", bearish: "🔴", sideways: "🟡", nodata: "⚪" };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const WATCH_COMMANDS = {
  watch: { re: /^!watch(?:\s+([\s\S]*))?$/i },
  unwatch: { re: /^!unwatch(?:\s+([\s\S]*))?$/i },
  watchlist: { re: /^!watchlist(?:\s+([\s\S]*))?$/i },
  alert: { re: /^!alert(?:\s+([\s\S]*))?$/i },
  alertlevel: { re: /^!alertlevel(?:\s+([\s\S]*))?$/i },
  alerts: { re: /^!alerts(?:\s+([\s\S]*))?$/i },
  hapusalert: { re: /^!hapusalert(?:\s+([\s\S]*))?$/i },
  harian: { re: /^!harian(?:\s+([\s\S]*))?$/i },
  stopharian: { re: /^!stopharian(?:\s+([\s\S]*))?$/i },
};

// ---------- parsing ----------
/** "100" / "100.5" / "0,5" / "$100" -> angka positif, atau null. */
function parsePrice(raw) {
  let s = String(raw).trim().replace(/^\$/, "");
  if (/^\d+,\d+$/.test(s)) s = s.replace(",", "."); // desimal koma
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return isFinite(n) && n > 0 ? n : null;
}

/** "8" / "08:30" / "8.30" -> { hour, minute }, atau null. */
function parseTime(raw) {
  const m = String(raw).trim().match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] == null ? 0 : Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** @returns {object|null} argumen terurai, atau null kalau format salah (-> tampilkan penjelasan command). */
function parseWatchArgs(name, raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  const coinOf = (tok) => (tok && COIN_RE.test(tok.toUpperCase()) ? tok.toUpperCase() : null);

  switch (name) {
    case "watch": {
      const toks = tokens.flatMap((tok) => tok.split(/[,;]+/)).filter(Boolean);
      if (!toks.length || toks.length > WATCH_MAX_TOKENS) return null;
      if (toks.length === 1 && WATCH_ALL_TOKENS.has(toks[0].toUpperCase())) return { all: true };
      const coins = [...new Set(toks.map((tok) => tok.toUpperCase()))];
      if (coins.some((c) => WATCH_ALL_TOKENS.has(c))) return null; // "all" tidak bisa dicampur dengan koin lain
      return { coins };
    }
    case "unwatch":
    case "alertlevel": {
      const coin = tokens.length === 1 ? coinOf(tokens[0]) : null;
      return coin ? { coin } : null;
    }
    case "alert": {
      if (tokens.length !== 2) return null;
      const coin = coinOf(tokens[0]);
      const price = parsePrice(tokens[1]);
      return coin && price ? { coin, price } : null;
    }
    case "hapusalert": {
      if (tokens.length !== 1 || !/^#?\d{1,6}$/.test(tokens[0])) return null;
      return { id: Number(tokens[0].replace("#", "")) };
    }
    case "harian": {
      if (!tokens.length) return { ...DAILY_DEFAULT };
      if (tokens.length > 1) return null;
      return parseTime(tokens[0]);
    }
    case "watchlist":
      if (!tokens.length) return {};
      return tokens.length === 1 && tokens[0].toLowerCase() === "pdf" ? { pdf: true } : null;
    default: // alerts, stopharian: tanpa argumen
      return tokens.length ? null : {};
  }
}

// ---------- data watchlist (dipakai juga oleh ringkasan harian) ----------
/** Jalankan fn untuk semua item dengan konkurensi terbatas. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Harga, % 24 jam, dan tren untuk tiap koin. Koin yang gagal diambil -> { coin, error: true }. */
async function loadWatchRows(coins, tf) {
  return mapLimit(coins, 4, async (coin) => {
    try {
      const [tick, candles] = await Promise.all([fetchTicker(coin), fetchCandles(coin, tf)]);
      const { latest } = computeEmas(candles);
      const info = classifyTrendAuto(tick.price, latest);
      return { coin, price: tick.price, pct: tick.changePct, trend: info.trend, limited: info.limited };
    } catch (err) {
      return { coin, error: true };
    }
  });
}

/**
 * Versi massal untuk watchlist panjang: pakai snapshot cache (satu pembangunan untuk semua koin, bersama !ringkasan,
 * !stat, !scan), bukan 2 panggilan API per koin. Koin yang tidak ada di snapshot (di luar daftar atau candle < 201)
 * diambil satu per satu, maksimal WATCH_FALLBACK_MAX; sisanya ditandai gagal.
 * @returns {Promise<Array<{coin,name?,price?,pct?,trend?,limited?,error?}>>} urut sama dengan `coins`
 */
async function loadWatchRowsBulk(lang, coins, tf) {
  let byTicker = new Map();
  try {
    const snap = await stat.getSnapshot(lang, tf);
    byTicker = new Map(snap.coins.map((c) => [c.ticker, c]));
  } catch (err) {
    console.log("[watchlist] snapshot gagal, pakai pengambilan per koin:", err.message);
  }
  const rows = new Array(coins.length);
  const missing = [];
  coins.forEach((coin, i) => {
    const c = byTicker.get(coin);
    if (c) rows[i] = { coin, name: c.name, price: c.price, pct: c.pct24, trend: c.info.trend, limited: false };
    else missing.push(i);
  });
  const todo = missing.slice(0, WATCH_FALLBACK_MAX);
  const got = await loadWatchRows(todo.map((i) => coins[i]), tf);
  todo.forEach((i, k) => (rows[i] = { ...got[k], name: NAME_OF.get(coins[i]) || "" }));
  missing.slice(WATCH_FALLBACK_MAX).forEach((i) => (rows[i] = { coin: coins[i], error: true }));
  return rows;
}

/** Ringkasan teks pendek untuk watchlist panjang (ringkasan harian): jumlah per tren + naik/turun terbesar 24 jam. */
function formatWatchCompact(lang, rows, tf) {
  const s = summarize(rows);
  const movers = rows.filter((r) => !r.error && typeof r.pct === "number" && isFinite(r.pct)).sort((a, b) => b.pct - a.pct);
  const fmt = (list) => list.map((r) => `${r.coin} ${fmtPct(r.pct)}`).join(", ") || "-";
  const up = fmt(movers.filter((r) => r.pct > 0).slice(0, 5));
  const down = fmt(movers.filter((r) => r.pct < 0).slice(-5).reverse());
  return t(lang, "watch.compact", { n: rows.length, tf: TF_LABEL[tf] || tf, bull: s.bullish, bear: s.bearish, side: s.sideways, nodata: s.nodata + s.error, up, down });
}

/** Tabel monospace: koin | harga | % | tren. */
function formatWatchTable(lang, rows) {
  const prices = rows.map((r) => (r.error ? "-" : fmtUsd(r.price)));
  const wCoin = Math.max(4, ...rows.map((r) => r.coin.length));
  const wPrice = Math.max(...prices.map((p) => p.length));
  const lines = rows.map((r, i) => {
    if (r.error) return `${pad(r.coin, wCoin)} ${t(lang, "watch.rowError")}`;
    return `${pad(r.coin, wCoin)} ${pad(prices[i], wPrice)} ${fmtPct(r.pct).padStart(8)} ${TREND_ICON[r.trend]} ${r.trend === "nodata" ? t(lang, "kripto.trend.noData") : cap(r.trend) + (r.limited ? "*" : "")}`;
  });
  const note = rows.some((r) => r.limited) ? `\n* ${t(lang, "kripto.trend.limitedNote")}` : "";
  return "```\n" + lines.join("\n") + "\n```" + note;
}

// ---------- runner ----------
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });

/** Ubah daftar ticker jadi teks "A, B, C (+N lainnya)". */
function listCoins(lang, coins) {
  const shown = coins.slice(0, WATCH_LIST_CAP).join(", ");
  const rest = coins.length - WATCH_LIST_CAP;
  return rest > 0 ? `${shown} ${t(lang, "watch.multi.more", { n: rest })}` : shown;
}

/** Ticker mentah dari user -> aman ditampilkan (tanpa karakter format WhatsApp). */
const safeTicker = (c) => c.replace(/[^A-Z0-9]/g, "").slice(0, 15) || "?";

/**
 * Pisahkan koin valid / tidak dikenal / gagal dicek.
 * Pakai daftar koin yang didukung (cache 1 jam, tanpa panggilan API per koin). Koin di luar daftar
 * dicek langsung ke Binance (seperti perilaku !watch satu koin sebelumnya), konkurensi 4.
 */
async function resolveWatchCoins(lang, coins) {
  const supported = new Set((await getAvailableCoins(lang)).map((c) => c.ticker));
  const valid = [];
  const unknown = [];
  const failed = [];
  const probe = [];
  for (const c of coins) {
    if (!COIN_RE.test(c)) unknown.push(safeTicker(c));
    else if (supported.has(c)) valid.push(c);
    else probe.push(c);
  }
  const results = await mapLimit(probe, 4, async (c) => {
    try {
      await fetchTicker(c);
      return "ok";
    } catch (err) {
      return err instanceof UnsupportedCoinError ? "unknown" : "failed";
    }
  });
  probe.forEach((c, i) => (results[i] === "ok" ? valid : results[i] === "unknown" ? unknown : failed).push(c));
  // Pertahankan urutan input untuk koin valid.
  const order = new Map(coins.map((c, i) => [c, i]));
  valid.sort((a, b) => order.get(a) - order.get(b));
  return { valid, unknown, failed };
}

/** Balasan rinci: ditambah / sudah ada / melebihi batas / tidak dikenal / gagal dicek. */
function formatWatchSummary(lang, senderId, res, { unknown, failed }) {
  const lines = [t(lang, "watch.multi.head", { n: store.getWatch(senderId).length, max: store.MAX_WATCH })];
  const add = (key, coins) => coins.length && lines.push(t(lang, key, { n: coins.length, list: listCoins(lang, coins) }));
  add("watch.multi.added", res.added);
  add("watch.multi.exists", res.exists);
  add("watch.multi.over", res.full);
  add("watch.multi.unknown", unknown);
  add("watch.multi.failed", failed);
  if (res.full.length) lines.push(t(lang, "watch.multi.overHint", { max: store.MAX_WATCH }));
  if (store.getWatch(senderId).length > WATCH_PDF_MIN) lines.push(t(lang, "watch.multi.pdfHint"));
  return lines.join("\n");
}

async function runWatch(sock, msg, { jid, lang, senderId }, { coin, coins, all }) {
  let input = coins || (coin ? [coin] : []);

  // Satu koin: perilaku lama (balasan singkat, error Binance diteruskan ke pemanggil).
  if (!all && input.length === 1) {
    const only = input[0];
    if (!COIN_RE.test(only)) throw new UnsupportedCoinError(safeTicker(only));
    await fetchTicker(only); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)
    const res = store.addWatch(senderId, only);
    const key = { added: "watch.added", exists: "watch.exists", full: "watch.full" }[res];
    await say(sock, jid, msg, t(lang, key, { coin: only, max: store.MAX_WATCH }));
    return;
  }

  let unknown = [];
  let failed = [];
  if (all) {
    input = (await getAvailableCoins(lang)).map((c) => c.ticker);
  } else {
    ({ valid: input, unknown, failed } = await resolveWatchCoins(lang, input));
  }
  const res = store.addWatchMany(senderId, input);
  await say(sock, jid, msg, formatWatchSummary(lang, senderId, res, { unknown, failed }));
}

async function runUnwatch(sock, msg, { jid, lang, senderId }, { coin }) {
  const ok = store.removeWatch(senderId, coin);
  await say(sock, jid, msg, t(lang, ok ? "watch.removed" : "watch.notFound", { coin }));
}

async function runWatchlist(sock, msg, { jid, lang, senderId }, args = {}) {
  const coins = store.getWatch(senderId);
  if (!coins.length) {
    await say(sock, jid, msg, t(lang, "watch.empty"));
    return;
  }
  const tf = getDefaultTf(senderId);

  // Panjang (atau diminta "pdf"): satu PDF berisi semua koin, dari snapshot cache.
  if (args.pdf || coins.length > WATCH_PDF_MIN) {
    if (!stat.isSnapshotWarm(tf)) await say(sock, jid, msg, t(lang, "watch.pdf.working", { n: coins.length }));
    const rows = await loadWatchRowsBulk(lang, coins, tf);
    if (rows.every((r) => r.error)) throw new Error("WATCHLIST_FETCH_FAILED");
    const pdf = await buildWatchlistPdf({ rows, tf: TF_LABEL[tf], lang });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    await sock.sendMessage(
      jid,
      {
        document: pdf,
        mimetype: "application/pdf",
        fileName: `Watchlist-${TF_LABEL[tf]}-${stamp}.pdf`,
        caption: t(lang, "watch.pdf.caption", { n: coins.length, max: store.MAX_WATCH, tf: TF_LABEL[tf] }),
      },
      { quoted: msg },
    );
    return;
  }

  const rows = await loadWatchRows(coins, tf);
  if (rows.every((r) => r.error)) throw new Error("WATCHLIST_FETCH_FAILED");
  await say(
    sock,
    jid,
    msg,
    t(lang, "watch.list.body", { n: coins.length, max: store.MAX_WATCH, tf: TF_LABEL[tf], table: formatWatchTable(lang, rows) }),
  );
}

async function runAlert(sock, msg, { jid, lang, senderId }, { coin, price }) {
  const tick = await fetchTicker(coin);
  if (Math.abs(price - tick.price) / tick.price < 1e-9) {
    await say(sock, jid, msg, t(lang, "alert.same", { coin, price: fmtLevel(price) }));
    return;
  }
  const dir = price > tick.price ? "up" : "down";
  const entry = store.addAlert(senderId, { chat: jid, coin, type: "price", price, dir });
  if (entry === "full") {
    await say(sock, jid, msg, t(lang, "alert.full", { max: store.MAX_ALERTS }));
    return;
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "alert.created", {
      id: entry.id,
      coin,
      op: dir === "up" ? ">=" : "<=",
      price: fmtLevel(price),
      now: fmtUsd(tick.price),
    }),
  );
}

async function runAlertLevel(sock, msg, { jid, lang, senderId }, { coin }) {
  const tf = getDefaultTf(senderId);
  const [candles, tick] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin)]);
  const { resistance, support } = computeLevels(candles, tick.price);
  if (resistance[0] == null && support[0] == null) {
    await say(sock, jid, msg, t(lang, "alert.level.none", { coin, tf: TF_LABEL[tf] }));
    return;
  }

  const existing = store.findLevelAlert(senderId, coin);
  if (existing) {
    // Sudah ada: perbarui timeframe & chat tujuan, aktifkan ulang.
    existing.tf = tf;
    existing.chat = jid;
    existing.fired = { S: null, R: null };
    store.persist();
  } else {
    const entry = store.addAlert(senderId, { chat: jid, coin, type: "level", tf, fired: { S: null, R: null } });
    if (entry === "full") {
      await say(sock, jid, msg, t(lang, "alert.full", { max: store.MAX_ALERTS }));
      return;
    }
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "alert.level.created", {
      coin,
      tf: TF_LABEL[tf],
      s1: support[0] == null ? "-" : fmtLevel(support[0]),
      r1: resistance[0] == null ? "-" : fmtLevel(resistance[0]),
    }),
  );
}

async function runAlerts(sock, msg, { jid, lang, senderId }) {
  const alerts = store.getAlerts(senderId);
  if (!alerts.length) {
    await say(sock, jid, msg, t(lang, "alert.list.empty"));
    return;
  }
  const rows = alerts.map((a) => {
    if (a.type === "level") return [`#${a.id}`, a.coin, t(lang, "alert.list.levelPrice", { tf: TF_LABEL[a.tf] || a.tf }), t(lang, "alert.list.dirLevel")];
    return [`#${a.id}`, a.coin, `${a.dir === "up" ? ">=" : "<="} ${fmtLevel(a.price)}`, t(lang, a.dir === "up" ? "alert.list.dirUp" : "alert.list.dirDown")];
  });
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${r[3]}`).join("\n");
  await say(sock, jid, msg, t(lang, "alert.list.body", { n: alerts.length, max: store.MAX_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runHapusAlert(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "alert.deleted" : "alert.notFound", { id }));
}

async function runHarian(sock, msg, { jid, lang, senderId }, { hour, minute }) {
  const was = store.getDaily(senderId);
  store.setDaily(senderId, jid, hour, minute);
  await say(sock, jid, msg, t(lang, was ? "daily.updated" : "daily.on", { time: hhmm(hour, minute), tz: DAILY_TZ_LABEL }));
}

async function runStopHarian(sock, msg, { jid, lang, senderId }) {
  const ok = store.clearDaily(senderId);
  await say(sock, jid, msg, t(lang, ok ? "daily.off" : "daily.notOn"));
}

const WATCH_RUNNERS = {
  watch: withSyncNotice(runWatch),
  unwatch: withSyncNotice(runUnwatch),
  watchlist: runWatchlist,
  alert: withSyncNotice(runAlert),
  alertlevel: withSyncNotice(runAlertLevel),
  alerts: runAlerts,
  hapusalert: withSyncNotice(runHapusAlert),
  harian: withSyncNotice(runHarian),
  stopharian: withSyncNotice(runStopHarian),
};

module.exports = {
  WATCH_COMMANDS,
  WATCH_RUNNERS,
  parseWatchArgs,
  // dipakai alertMonitor.js
  DAILY_TZ,
  DAILY_TZ_LABEL,
  loadWatchRows,
  loadWatchRowsBulk,
  formatWatchCompact,
  WATCH_PDF_MIN,
  formatWatchTable,
  hhmm,
  // diekspor untuk pengujian
  parsePrice,
  parseTime,
};
