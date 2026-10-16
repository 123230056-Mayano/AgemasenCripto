"use strict";

/**
 * features/kripto/watchlist.js
 * ------------------------------------------------------------------
 * Watchlist & alert (Command Kripto - Bagian 5). Pantauan pribadi per user:
 *   !watch <koin>          -> tambah koin ke watchlist
 *   !unwatch <koin>        -> hapus koin dari watchlist
 *   !watchlist             -> watchlist + harga, % 24 jam, tren singkat
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
const { TF_LABEL, fetchTicker, fetchCandles, computeLevels, fmtUsd, fmtLevel, fmtPct } = require("./market");

// Zona waktu ringkasan harian. Default WIB; ganti lewat env DAILY_TZ (nama zona IANA).
const DAILY_TZ = process.env.DAILY_TZ || "Asia/Jakarta";
const DAILY_TZ_LABEL = process.env.DAILY_TZ_LABEL || (DAILY_TZ === "Asia/Jakarta" ? "WIB" : DAILY_TZ);
const DAILY_DEFAULT = { hour: 8, minute: 0 };

const COIN_RE = /^[A-Z0-9]{1,15}$/;
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
    case "watch":
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
    default: // watchlist, alerts, stopharian: tanpa argumen
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

async function runWatch(sock, msg, { jid, lang, senderId }, { coin }) {
  await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)
  const res = store.addWatch(senderId, coin);
  const key = { added: "watch.added", exists: "watch.exists", full: "watch.full" }[res];
  await say(sock, jid, msg, t(lang, key, { coin, max: store.MAX_WATCH }));
}

async function runUnwatch(sock, msg, { jid, lang, senderId }, { coin }) {
  const ok = store.removeWatch(senderId, coin);
  await say(sock, jid, msg, t(lang, ok ? "watch.removed" : "watch.notFound", { coin }));
}

async function runWatchlist(sock, msg, { jid, lang, senderId }) {
  const coins = store.getWatch(senderId);
  if (!coins.length) {
    await say(sock, jid, msg, t(lang, "watch.empty"));
    return;
  }
  const tf = getDefaultTf(senderId);
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
  formatWatchTable,
  hhmm,
  // diekspor untuk pengujian
  parsePrice,
  parseTime,
};
