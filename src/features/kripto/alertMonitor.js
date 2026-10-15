"use strict";

/**
 * features/kripto/alertMonitor.js
 * ------------------------------------------------------------------
 * Pemantau latar belakang untuk watchlist & alert (Command Kripto - Bagian 5):
 *   - alert harga (!alert): cek harga tiap ALERT_POLL_MS (default 30 dtk);
 *     terkirim sekali saat harga menyentuh/menembus angka, lalu alert dihapus.
 *   - alert level (!alertlevel): level support/resistance terdekat dihitung
 *     ulang tiap 10 menit; notifikasi saat harga mendekati (<= 0.5%) atau
 *     menyentuh level, aktif lagi setelah harga menjauh > 1.5% / level berganti.
 *   - ringkasan harian (!harian): dikirim sekali per hari pada jam pilihan user.
 *
 * Socket Baileys berganti tiap reconnect, jadi connection.js memanggil
 * setAlertSocket(sock) setiap kali socket baru dibuat; timer hanya dibuat sekali.
 * Notifikasi baru dianggap terkirim (dan alert dihapus / lastSent diisi)
 * setelah sendMessage berhasil, jadi kalau bot sedang offline alert tidak hilang.
 */

const axios = require("axios");
const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { getLang } = require("../../state/languageStore");
const { binanceSymbol } = require("../analisis/analisisChart");
const { getMarketRows } = require("./pasar");
const { getDefaultTf } = require("./defaultTf");
const { TF_LABEL, fetchCandles, computeLevels, fmtUsd, fmtLevel, fmtPct } = require("./market");
const { DAILY_TZ, DAILY_TZ_LABEL, loadWatchRows, formatWatchTable } = require("./watchlist");

const BINANCE = (process.env.BINANCE_BASE || "https://data-api.binance.vision").replace(/\/+$/, "");
const POLL_MS = Math.max(10_000, Number(process.env.ALERT_POLL_MS) || 30_000);
const DAILY_CHECK_MS = 30_000;
const DAILY_WINDOW_MIN = 180; // terlambat > 3 jam dari jadwal (mis. bot mati) -> lewati hari itu
const LEVEL_REFRESH_MS = 10 * 60_000;
const NEAR_PCT = 0.5; // "mendekati" level
const REARM_PCT = 1.5; // jarak yang membuat alert level aktif lagi
const SYMBOL_CHUNK = 100;

let sockRef = null;
let started = false;
let pricesBusy = false;
let dailyBusy = false;

// ---------- helper ----------
const langFor = (chat, userJid) => (chat.endsWith("@g.us") ? getLang("group", chat) : getLang("user", userJid));

/** Kirim ke chat tujuan (mention user di grup). @returns {Promise<boolean>} true kalau terkirim. */
async function notify(chat, userJid, text) {
  if (!sockRef) return false;
  try {
    if (chat.endsWith("@g.us")) {
      await sockRef.sendMessage(chat, { text: `@${userJid.split("@")[0]}\n${text}`, mentions: [userJid] });
    } else {
      await sockRef.sendMessage(chat, { text });
    }
    return true;
  } catch (err) {
    console.log("[alert] gagal kirim notifikasi:", err.message);
    return false;
  }
}

const isInvalidSymbol = (err) => err?.response?.status === 400 || err?.response?.data?.code === -1121;

/** Harga terakhir banyak simbol sekaligus; simbol tidak valid dilewati (dibagi dua sampai ketemu). */
async function fetchPriceChunk(symbols, out) {
  if (!symbols.length) return;
  try {
    const res = await axios.get(`${BINANCE}/api/v3/ticker/price`, {
      params: { symbols: JSON.stringify(symbols) },
      timeout: 10_000,
    });
    for (const row of res.data || []) {
      const p = Number(row.price);
      if (isFinite(p)) out.set(row.symbol, p);
    }
  } catch (err) {
    if (!isInvalidSymbol(err) || symbols.length === 1) {
      if (!isInvalidSymbol(err)) throw err;
      return;
    }
    const mid = Math.ceil(symbols.length / 2);
    await fetchPriceChunk(symbols.slice(0, mid), out);
    await fetchPriceChunk(symbols.slice(mid), out);
  }
}

/** @returns {Promise<Map<string, number>>} ticker -> harga */
async function fetchPrices(coins) {
  const symbols = coins.map(binanceSymbol);
  const bySymbol = new Map();
  for (let i = 0; i < symbols.length; i += SYMBOL_CHUNK) {
    await fetchPriceChunk(symbols.slice(i, i + SYMBOL_CHUNK), bySymbol);
  }
  const out = new Map();
  for (const c of coins) {
    const p = bySymbol.get(binanceSymbol(c));
    if (p != null) out.set(c, p);
  }
  return out;
}

// ---------- level support/resistance (cache) ----------
const levelCache = new Map(); // "COIN|TF" -> { at, S, R }

async function getLevels(coin, tf, price) {
  const key = `${coin}|${tf}`;
  const hit = levelCache.get(key);
  if (hit && Date.now() - hit.at < LEVEL_REFRESH_MS) return hit;
  const candles = await fetchCandles(coin, tf);
  const { resistance, support } = computeLevels(candles, price);
  const entry = { at: Date.now(), S: support[0] ?? null, R: resistance[0] ?? null };
  levelCache.set(key, entry);
  return entry;
}

// ---------- alert harga & level ----------
async function checkPriceAlerts() {
  const all = store.allAlerts();
  if (!all.length || !sockRef) return;

  const coins = [...new Set(all.map((x) => x.alert.coin))];
  const prices = await fetchPrices(coins);

  for (const { userJid, alert } of all) {
    const price = prices.get(alert.coin);
    if (price == null) continue;
    const lang = langFor(alert.chat, userJid);

    if (alert.type === "price") {
      const hit = alert.dir === "up" ? price >= alert.price : price <= alert.price;
      if (!hit) continue;
      const text = t(lang, alert.dir === "up" ? "alert.fired.up" : "alert.fired.down", {
        id: alert.id,
        coin: alert.coin,
        target: fmtLevel(alert.price),
        now: fmtUsd(price),
      });
      if (await notify(alert.chat, userJid, text)) store.removeAlert(userJid, alert.id);
      continue;
    }

    if (alert.type === "level") {
      let levels;
      try {
        levels = await getLevels(alert.coin, alert.tf, price);
      } catch (err) {
        continue; // data candle gagal -> coba lagi di putaran berikutnya
      }
      if (!alert.fired) alert.fired = { S: null, R: null };
      let changed = false;

      for (const side of ["S", "R"]) {
        const lvl = levels[side];
        const firedAt = alert.fired[side];

        // Aktifkan ulang kalau harga sudah menjauh atau levelnya sudah berganti.
        if (firedAt != null && (lvl !== firedAt || (Math.abs(price - firedAt) / firedAt) * 100 > REARM_PCT)) {
          alert.fired[side] = null;
          changed = true;
        }
        if (lvl == null || alert.fired[side] != null) continue;

        const distPct = (Math.abs(price - lvl) / lvl) * 100;
        if (distPct > NEAR_PCT) continue;

        const touched = side === "S" ? price <= lvl : price >= lvl;
        const text = t(lang, side === "S" ? "alert.level.firedS" : "alert.level.firedR", {
          coin: alert.coin,
          tf: TF_LABEL[alert.tf] || alert.tf,
          level: fmtLevel(lvl),
          now: fmtUsd(price),
          state: t(lang, touched ? "alert.level.touched" : "alert.level.near"),
        });
        if (await notify(alert.chat, userJid, text)) {
          alert.fired[side] = lvl;
          changed = true;
        }
      }
      if (changed) store.persist();
    }
  }
}

// ---------- ringkasan harian ----------
/** { date: "YYYY-MM-DD", minutes: menit sejak 00:00 } di zona waktu DAILY_TZ. */
function localNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DAILY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** Bagian pasar (BTC + naik/turun + top 3) untuk satu bahasa. Di-cache per putaran oleh pemanggil. */
async function buildMarketPart(lang) {
  const rows = await getMarketRows(lang, "24H");
  if (!rows.length) throw new Error("EMPTY_MARKET");
  const up = rows.filter((r) => r.pct >= 0).length;
  const sorted = [...rows].sort((a, b) => b.pct - a.pct);
  const line = (r) => `${r.ticker} ${fmtUsd(r.price)} (${fmtPct(r.pct)})`;
  const btc = rows.find((r) => r.ticker === "BTC");
  return t(lang, "daily.market", {
    btc: btc ? `₿ BTC ${fmtUsd(btc.price)} (${fmtPct(btc.pct)})` : "₿ BTC -",
    up,
    down: rows.length - up,
    total: rows.length,
    gainers: sorted.slice(0, 3).map(line).join("\n"),
    losers: sorted.slice(-3).reverse().map(line).join("\n"),
  });
}

async function checkDaily() {
  const subs = store.allDaily();
  if (!subs.length || !sockRef) return;

  const now = localNow();
  const due = subs.filter(({ daily }) => {
    if (daily.lastSent === now.date) return false;
    const late = now.minutes - (daily.hour * 60 + daily.minute);
    return late >= 0 && late <= DAILY_WINDOW_MIN;
  });
  if (!due.length) return;

  const marketByLang = new Map(); // pakai ulang satu putaran
  for (const { userJid, daily } of due) {
    const lang = langFor(daily.chat, userJid);
    try {
      if (!marketByLang.has(lang)) marketByLang.set(lang, await buildMarketPart(lang));

      let watchPart = t(lang, "daily.noWatch");
      const coins = store.getWatch(userJid);
      if (coins.length) {
        const rows = await loadWatchRows(coins, getDefaultTf(userJid));
        watchPart = t(lang, "daily.watch", { table: formatWatchTable(lang, rows) });
      }

      const text = t(lang, "daily.body", { tz: DAILY_TZ_LABEL, market: marketByLang.get(lang), watch: watchPart });
      if (await notify(daily.chat, userJid, text)) {
        daily.lastSent = now.date;
        store.persist();
      }
    } catch (err) {
      console.log("[harian] gagal menyusun ringkasan:", err.message); // dicoba lagi putaran berikutnya
    }
  }
}

// ---------- start ----------
/** Dipanggil connection.js tiap socket baru dibuat; timer hanya dibuat sekali. */
function setAlertSocket(sock) {
  sockRef = sock;
  if (started) return;
  started = true;

  setInterval(async () => {
    if (pricesBusy) return;
    pricesBusy = true;
    try {
      await checkPriceAlerts();
    } catch (err) {
      console.log("[alert] pengecekan gagal:", err.message);
    } finally {
      pricesBusy = false;
    }
  }, POLL_MS).unref?.();

  setInterval(async () => {
    if (dailyBusy) return;
    dailyBusy = true;
    try {
      await checkDaily();
    } catch (err) {
      console.log("[harian] pengecekan gagal:", err.message);
    } finally {
      dailyBusy = false;
    }
  }, DAILY_CHECK_MS).unref?.();
}

module.exports = { setAlertSocket, checkPriceAlerts, checkDaily, localNow, fetchPrices };
