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
 *   - alarm divergence (!alertdivergent): job TERPISAH dari polling harga; pemeriksaan ringan tiap
 *     ~15 dtk hanya membandingkan waktu candle closed terakhir per TF dengan state tersimpan, dan baru
 *     bekerja (fetch + deteksi + kirim) sekali per candle closed per TF. Dedupe & penanda candle yang
 *     sudah diproses disimpan persisten (cryptoStore), jadi restart tidak mengirim ulang.
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
const { TF_LABEL, UnsupportedCoinError, fetchCandles, computeLevels, fmtUsd, fmtLevel, fmtPct } = require("./market");
const { DAILY_TZ, DAILY_TZ_LABEL, loadWatchRows, formatWatchTable } = require("./watchlist");
const { detectDivergence } = require("./divergence");
const { refreshSnapshot, CONCURRENCY: SCAN_CONCURRENCY } = require("./statistik");
const {
  TF_MS,
  ALERT_DIV,
  lastCandleOpen,
  dueTfs,
  collectItems,
  groupByRecipient,
  planMessages,
  ChatRateLimiter,
  buildSingleText,
  buildSummaryText,
  COIN_ALL,
  COIN_WATCHLIST,
} = require("./divAlertCore");

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
let divBusy = false;

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

// ---------- alarm divergence ----------
const divRetry = new Map(); // tf -> { boundary, attempts, nextAt } (di memori; setelah restart cukup dihitung ulang, dedupe persisten)
const divLimiter = new ChatRateLimiter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Jalankan fn untuk semua item dengan batas konkurensi; error ditangani di dalam fn. */
async function runPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/**
 * Kumpulkan hasil divergence untuk satu TF.
 *  - Langganan "semua": satu snapshot yang dibangun ulang (bukan cache 3 menit yang mungkin sebelum candle tutup).
 *  - Koin tertentu / watchlist: kalau sudah ada di snapshot dipakai ulang, kalau tidak diambil langsung
 *    (konkurensi sama dengan scan). Satu koin tidak pernah diambil dua kali.
 * @returns {Promise<{divsByCoin: Map, allCoins: Set, failures: number, requests: number}>}
 */
async function gatherDivergences(tf, boundary, subsTf) {
  const expectedOpen = lastCandleOpen(tf, boundary);
  const divsByCoin = new Map();
  const allCoins = new Set();
  let failures = 0;
  let requests = 0;

  if (subsTf.some((x) => x.sub.coin === COIN_ALL)) {
    try {
      const snap = await refreshSnapshot("id", tf);
      requests += snap.total;
      const fresh = snap.coins.filter((c) => c.lastCandleT === expectedOpen).length;
      if (fresh < snap.coins.length * ALERT_DIV.FRESH_RATIO) {
        failures++; // Binance belum menyajikan candle yang baru tutup -> coba lagi nanti
        console.log(`[divalert] ${tf}: snapshot belum memuat candle terbaru (${fresh}/${snap.coins.length})`);
      } else {
        for (const c of snap.coins) {
          divsByCoin.set(c.ticker, c.div || []);
          allCoins.add(c.ticker);
        }
      }
    } catch (err) {
      failures++;
      console.log(`[divalert] ${tf}: snapshot gagal:`, err.message);
    }
  }

  const explicit = new Set();
  for (const { userJid, sub } of subsTf) {
    if (sub.coin === COIN_WATCHLIST) for (const c of store.getWatch(userJid)) explicit.add(c);
    else if (sub.coin !== COIN_ALL) explicit.add(sub.coin);
  }
  const direct = [...explicit].filter((c) => !divsByCoin.has(c));
  await runPool(direct, SCAN_CONCURRENCY, async (coin) => {
    requests++;
    try {
      const candles = await fetchCandles(coin, tf);
      const last = candles[candles.length - 1];
      if (!last || last.t !== expectedOpen) {
        failures++; // candle terbaru belum final / koin berhenti diperdagangkan
        return;
      }
      divsByCoin.set(coin, detectDivergence(candles, { indicators: ["rsi", "macd"] }));
    } catch (err) {
      if (err instanceof UnsupportedCoinError) return; // koin sudah tidak ada di Binance: dilewati, bukan kegagalan putaran
      failures++;
    }
  });
  return { divsByCoin, allCoins, failures, requests };
}

/** Kirim semua pesan untuk satu tujuan (chat + user). @returns {Promise<{sent:number, failed:number}>} */
async function deliverDivergence(group) {
  const lang = langFor(group.chat, group.userJid);
  const plans = planMessages(group.items, { remaining: divLimiter.remaining(group.chat) });
  if (!plans.length && group.items.length) {
    console.log(`[divalert] batas pesan per jam tercapai untuk ${group.chat}; ${group.items.length} sinyal ditunda`);
  }
  let sent = 0;
  let failed = 0;
  for (const plan of plans) {
    if (divLimiter.remaining(group.chat) <= 0) break; // jatah habis di tengah jalan: sisanya ditunda (belum ditandai terkirim)
    const text = plan.summary ? buildSummaryText(lang, plan.items) : buildSingleText(lang, plan.items[0]);
    if (await notify(group.chat, group.userJid, text)) {
      store.markSent(plan.items.map((i) => i.key)); // ditandai SETELAH terkirim (dan langsung disimpan)
      divLimiter.record(group.chat);
      sent++;
      if (ALERT_DIV.SEND_GAP_MS) await sleep(ALERT_DIV.SEND_GAP_MS);
    } else {
      failed++;
    }
  }
  return { sent, failed };
}

/** Proses satu TF yang baru saja closed. */
async function processDivTf(tf, boundary, attempts, allSubs, now) {
  const startedAt = Date.now();
  const retryAt = () => now + (Date.now() - startedAt) + ALERT_DIV.RETRY_MS; // = Date.now() + RETRY_MS di produksi; mengikuti `now` yang disuntik di test
  const subsTf = allSubs.filter((x) => x.sub.tf === tf);
  const { divsByCoin, allCoins, failures: fetchFailures, requests } = await gatherDivergences(tf, boundary, subsTf);

  const items = collectItems({
    subs: subsTf,
    tf,
    divsByCoin,
    allCoins,
    watchOf: (jid) => store.getWatch(jid),
    isSent: (key) => store.wasSent(key),
  });

  let sent = 0;
  let sendFailed = 0;
  for (const group of groupByRecipient(items)) {
    try {
      const r = await deliverDivergence(group);
      sent += r.sent;
      sendFailed += r.failed;
    } catch (err) {
      sendFailed++;
      console.log("[divalert] gagal mengirim:", err.message);
    }
  }

  const problems = fetchFailures + sendFailed;
  if (!problems) {
    store.setLastClosed(tf, boundary); // sukses penuh: tandai selesai
    divRetry.delete(tf);
  } else if (attempts + 1 >= ALERT_DIV.MAX_ATTEMPTS) {
    store.setLastClosed(tf, boundary); // menyerah; sinyal yang gagal dikirim masih bisa muncul di putaran TF itu berikutnya selama masih "baru"
    divRetry.delete(tf);
    console.log(`[divalert] ${tf}: menyerah setelah ${attempts + 1} percobaan (${problems} masalah)`);
  } else {
    divRetry.set(tf, { boundary, attempts: attempts + 1, nextAt: retryAt() });
  }
  const pruned = store.pruneSent();
  console.log(
    `[divalert] ${tf} candle=${new Date(boundary).toISOString()} langganan=${subsTf.length} koin=${divsByCoin.size} request~${requests} ` +
      `sinyal=${items.length} terkirim=${sent} masalah=${problems} dedupe=${store.sentCount()}(-${pruned}) durasi=${Date.now() - startedAt}ms`,
  );
}

/** Pemeriksaan ringan: kerja berat hanya kalau ada candle closed baru pada TF yang punya langganan. */
async function checkDivergence(now = Date.now()) {
  const subs = store.allDivAlerts();
  if (!subs.length || !sockRef) return;
  const tfs = [...new Set(subs.map((x) => x.sub.tf))].filter((tf) => TF_MS[tf]);
  const due = dueTfs({ tfs, now, lastClosed: store.getLastClosedMap(), retry: divRetry });
  for (const { tf, boundary, attempts } of due) {
    const startedAt = Date.now();
    try {
      await processDivTf(tf, boundary, attempts, subs, now);
    } catch (err) {
      console.log(`[divalert] ${tf} putaran gagal:`, err.message); // TF lain tetap diproses; dicoba lagi lewat jalur retry
      divRetry.set(tf, { boundary, attempts: attempts + 1, nextAt: now + (Date.now() - startedAt) + ALERT_DIV.RETRY_MS });
      if (attempts + 1 >= ALERT_DIV.MAX_ATTEMPTS) {
        store.setLastClosed(tf, boundary);
        divRetry.delete(tf);
      }
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

  setInterval(async () => {
    if (divBusy) return;
    divBusy = true;
    try {
      await checkDivergence();
    } catch (err) {
      console.log("[divalert] pengecekan gagal:", err.message);
    } finally {
      divBusy = false;
    }
  }, ALERT_DIV.CHECK_MS).unref?.();
}

module.exports = { setAlertSocket, checkPriceAlerts, checkDaily, checkDivergence, localNow, fetchPrices };
