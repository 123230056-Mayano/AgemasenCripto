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
 *   - alarm titik balik S/R (!alertsnr): reject / tembus, hanya konfirmasi (candle closed). Mesinnya di snrAlertEngine.js.
 *   - alarm Higher High / Lower Low (!alerthhll): swing baru (dini) + close menembus swing (konfirmasi), dari candle closed.
 *     Mesinnya di hhllAlertEngine.js; banyak kejadian dikirim sebagai 1 PDF per penerima.
 *   - alarm indikator lanjutan (!alertind, item 10): bias berubah + crossover baru, mode closed (tiap candle tutup)
 *     atau live (refresh berkala, candle belum closed ditandai jelas). Mesinnya di advAlertEngine.js; di sini hanya
 *     dibuat satu engine dan timer-nya. Tidak ada WebSocket (opsi 3 menunggu keputusan client).
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
const { DAILY_TZ, DAILY_TZ_LABEL, loadWatchRows, loadWatchRowsBulk, formatWatchCompact, WATCH_PDF_MIN, formatWatchTable } = require("./watchlist");
const { detectDivergenceAll } = require("./divergence");
const { buildDivergencePdf } = require("./divPdf");
const { refreshSnapshot, CONCURRENCY: SCAN_CONCURRENCY } = require("./statistik");
const {
  TF_MS,
  ALERT_DIV,
  lastCandleOpen,
  dueTfs,
  collectItems,
  groupByRecipient,
  ChatRateLimiter,
  buildSingleText,
  buildSections,
  chooseReportMode,
  buildPdfIntro,
  buildGroupedText,
  fmtCandleTime,
  COIN_ALL,
  COIN_WATCHLIST,
} = require("./divAlertCore");

const { createAdvEngine } = require("./advAlertEngine");
const { createSnrEngine } = require("./snrAlertEngine");
const { createHhllEngine } = require("./hhllAlertEngine");
const { buildHhllPdf } = require("./hhllPdf");
const { ADV_ALERT_CONFIG: ADV, SNR_ALERT_CONFIG: SNR, HHLL_ALERT_CONFIG: HHLL } = require("../../config/indicatorConfig");

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
let advBusy = false;
let snrBusy = false;
let hhllBusy = false;

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
        const tf = getDefaultTf(userJid);
        if (coins.length > WATCH_PDF_MIN) {
          // Watchlist panjang: ringkasan pendek (jumlah per tren + naik/turun terbesar); daftar lengkap lewat !watchlist (PDF).
          const rows = await loadWatchRowsBulk(lang, coins, tf);
          watchPart = t(lang, "daily.watchBig", { summary: formatWatchCompact(lang, rows, tf) });
        } else {
          const rows = await loadWatchRows(coins, tf);
          watchPart = t(lang, "daily.watch", { table: formatWatchTable(lang, rows) });
        }
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
 * divsByCoin = sinyal terkonfirmasi; earlyByCoin = sinyal DINI (hanya dipakai langganan dengan opsi `dini`).
 * @returns {Promise<{divsByCoin: Map, earlyByCoin: Map, allCoins: Set, failures: number, requests: number}>}
 */
async function gatherDivergences(tf, boundary, subsTf) {
  const expectedOpen = lastCandleOpen(tf, boundary);
  const divsByCoin = new Map();
  const earlyByCoin = new Map();
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
          earlyByCoin.set(c.ticker, c.divEarly || []);
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
      const dv = detectDivergenceAll(candles, { indicators: ["rsi", "macd"] });
      divsByCoin.set(coin, dv.confirmed);
      earlyByCoin.set(coin, dv.early);
    } catch (err) {
      if (err instanceof UnsupportedCoinError) return; // koin sudah tidak ada di Binance: dilewati, bukan kegagalan putaran
      failures++;
    }
  });
  return { divsByCoin, earlyByCoin, allCoins, failures, requests };
}

/** Kirim dokumen PDF ke chat tujuan. @returns {Promise<boolean>} true kalau terkirim. */
async function notifyDocument(chat, userJid, buffer, fileName) {
  if (!sockRef) return false;
  try {
    await sockRef.sendMessage(chat, { document: buffer, mimetype: "application/pdf", fileName });
    return true;
  } catch (err) {
    console.log("[alert] gagal kirim PDF:", err.message);
    return false;
  }
}

/**
 * Kirim laporan divergence untuk SATU penerima (chat + user): semua TF yang closed bersamaan, semua koin.
 *  - sinyal banyak / lintas TF -> pesan pengantar 1 baris + 1 PDF gabungan (maksimal 2 pesan)
 *  - sinyal sedikit            -> 1 pesan teks singkat (1 sinyal memakai format alarm tunggal)
 * Sinyal ditandai terkirim hanya kalau semua pesan berhasil. Jatah pesan per jam tidak cukup -> ditunda
 * (tidak ditandai, dicoba lagi di putaran berikutnya selama masih "baru").
 * @param {{chat:string,userJid:string,items:object[]}} group
 * @param {string[]} tfs TF (kunci) yang closed bersamaan dan dilanggan penerima ini
 * @param {number} closedMs waktu tutup candle (ms) untuk teks pengantar
 */
async function deliverDivergence(group, tfs, closedMs) {
  const lang = langFor(group.chat, group.userJid);
  const sections = buildSections(group.items, tfs);
  const mode = chooseReportMode(sections);
  const res = { sent: 0, failed: 0, deferred: false, mode, pdfMs: 0, pdfBytes: 0 };
  if (mode === "none") return res;

  let asPdf = mode === "pdf";
  if (divLimiter.remaining(group.chat) < (asPdf ? 2 : 1)) {
    res.deferred = true;
    console.log(`[divalert] batas pesan per jam tercapai untuk ${group.chat}; ${group.items.length} sinyal ditunda`);
    return res;
  }
  const time = fmtCandleTime(lang, closedMs);

  let pdf = null;
  if (asPdf) {
    const t0 = Date.now();
    try {
      pdf = await buildDivergencePdf({ sections, mode: "alert", time, lang });
      res.pdfMs = Date.now() - t0;
      res.pdfBytes = pdf.length;
    } catch (err) {
      console.log("[divalert] gagal membuat PDF, kirim sebagai teks:", err.message);
      asPdf = false; // jangan sampai alarm hilang hanya karena PDF gagal dibuat
    }
  }

  const send = async (fn) => {
    const ok = await fn();
    if (ok) {
      divLimiter.record(group.chat);
      res.sent++;
      if (ALERT_DIV.SEND_GAP_MS) await sleep(ALERT_DIV.SEND_GAP_MS);
    }
    return ok;
  };

  let ok;
  if (asPdf) {
    const stamp = new Date(closedMs).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    ok = await send(() => notify(group.chat, group.userJid, buildPdfIntro(lang, sections, { mode: "alert", time })));
    if (ok) {
      const sendPdf = () => notifyDocument(group.chat, group.userJid, pdf, `Divergence-${stamp}UTC.pdf`);
      ok = await send(async () => (await sendPdf()) || (await sendPdf())); // satu percobaan ulang langsung
    }
  } else {
    const text = group.items.length === 1 ? buildSingleText(lang, group.items[0]) : buildGroupedText(lang, sections, { mode: "alert", time });
    ok = await send(() => notify(group.chat, group.userJid, text));
  }

  if (ok) store.markSent(group.items.map((i) => i.key)); // ditandai SETELAH terkirim (dan langsung disimpan)
  else res.failed++;
  return res;
}

/** Ambil data + cocokkan langganan untuk satu TF (belum mengirim apa pun). */
async function collectDivTf(tf, boundary, allSubs) {
  const startedAt = Date.now();
  const subsTf = allSubs.filter((x) => x.sub.tf === tf);
  const gathered = await gatherDivergences(tf, boundary, subsTf);
  const items = collectItems({
    subs: subsTf,
    tf,
    divsByCoin: gathered.divsByCoin,
    earlyByCoin: gathered.earlyByCoin,
    allCoins: gathered.allCoins,
    watchOf: (jid) => store.getWatch(jid),
    isSent: (key) => store.wasSent(key),
  });
  return { tf, boundary, subsTf, items, ...gathered, ms: Date.now() - startedAt };
}

/** Tandai TF selesai, atau jadwalkan percobaan ulang (logika sama dengan versi per-TF sebelumnya). */
function finishDivTf(g, attempts, problems, now, tickStartedAt) {
  const { tf, boundary } = g;
  if (!problems) {
    store.setLastClosed(tf, boundary); // sukses penuh: tandai selesai
    divRetry.delete(tf);
  } else if (attempts + 1 >= ALERT_DIV.MAX_ATTEMPTS) {
    store.setLastClosed(tf, boundary); // menyerah; sinyal yang gagal dikirim masih bisa muncul di putaran TF itu berikutnya selama masih "baru"
    divRetry.delete(tf);
    console.log(`[divalert] ${tf}: menyerah setelah ${attempts + 1} percobaan (${problems} masalah)`);
  } else {
    divRetry.set(tf, { boundary, attempts: attempts + 1, nextAt: now + (Date.now() - tickStartedAt) + ALERT_DIV.RETRY_MS });
  }
}

/**
 * Pemeriksaan ringan: kerja berat hanya kalau ada candle closed baru pada TF yang punya langganan.
 * TF yang jatuh tempo bersamaan (mis. 1D/4H/1H/15m pukul 07:00 WIB) dikumpulkan dulu, lalu tiap penerima
 * mendapat SATU laporan gabungan (urut 1D > 4H > 1H > 15m), bukan satu pesan per TF.
 */
async function checkDivergence(now = Date.now()) {
  const subs = store.allDivAlerts();
  if (!subs.length || !sockRef) return;
  const tfs = [...new Set(subs.map((x) => x.sub.tf))].filter((tf) => TF_MS[tf]);
  const due = dueTfs({ tfs, now, lastClosed: store.getLastClosedMap(), retry: divRetry });
  if (!due.length) return;

  const tickStartedAt = Date.now();
  const gathered = []; // urut TF besar -> kecil (urutan `due`)
  for (const d of due) {
    try {
      gathered.push({ ...(await collectDivTf(d.tf, d.boundary, subs)), attempts: d.attempts });
    } catch (err) {
      console.log(`[divalert] ${d.tf} putaran gagal:`, err.message); // TF lain tetap diproses; dicoba lagi lewat jalur retry
      finishDivTf({ tf: d.tf, boundary: d.boundary }, d.attempts, 1, now, tickStartedAt);
    }
  }
  if (!gathered.length) return;

  // Kirim: satu laporan per penerima untuk semua TF yang closed bersamaan.
  const closedMs = Math.max(...gathered.map((g) => g.boundary));
  const sendFailedTfs = new Set();
  const sentByTf = new Map(gathered.map((g) => [g.tf, 0]));
  for (const group of groupByRecipient(gathered.flatMap((g) => g.items))) {
    // TF yang datanya gagal diambil (dan belum menghasilkan sinyal) tidak ikut dilaporkan: "0 sinyal" di PDF akan
    // menyesatkan. TF itu dicoba lagi lewat jalur retry dan dikirim terpisah kalau berhasil.
    const myTfs = gathered
      .filter((g) => g.subsTf.some((x) => x.userJid === group.userJid && x.sub.chat === group.chat))
      .filter((g) => g.failures === 0 || g.items.length > 0)
      .map((g) => g.tf);
    try {
      const r = await deliverDivergence(group, myTfs, closedMs);
      if (r.failed) for (const it of group.items) sendFailedTfs.add(it.tf);
      if (r.sent && !r.failed) for (const it of group.items) sentByTf.set(it.tf, sentByTf.get(it.tf) + 1);
      console.log(
        `[divalert] kirim penerima=${group.chat} mode=${r.mode} tf=${myTfs.join("+")} sinyal=${group.items.length} pesan=${r.sent} gagal=${r.failed}` +
          (r.pdfBytes ? ` pdf=${r.pdfMs}ms/${Math.round(r.pdfBytes / 1024)}KB` : "") +
          (r.deferred ? " ditunda" : ""),
      );
    } catch (err) {
      for (const it of group.items) sendFailedTfs.add(it.tf);
      console.log("[divalert] gagal mengirim:", err.message);
    }
  }

  for (const g of gathered) {
    const problems = g.failures + (sendFailedTfs.has(g.tf) ? 1 : 0);
    finishDivTf(g, g.attempts, problems, now, tickStartedAt);
    const pruned = store.pruneSent();
    console.log(
      `[divalert] ${g.tf} candle=${new Date(g.boundary).toISOString()} langganan=${g.subsTf.length} koin=${g.divsByCoin.size} request~${g.requests} ` +
        `sinyal=${g.items.length} penerima_terkirim=${sentByTf.get(g.tf)} masalah=${problems} dedupe=${store.sentCount()}(-${pruned}) ambil=${g.ms}ms total=${Date.now() - tickStartedAt}ms`,
    );
  }
}

// ---------- alarm indikator lanjutan (!alertind) ----------
const advEngine = createAdvEngine({
  store,
  fetchCandles,
  notify,
  langFor,
  isUnsupported: (err) => err instanceof UnsupportedCoinError,
});

/** Pemeriksaan alarm indikator lanjutan (closed + live). Dipanggil timer; aman dipanggil manual untuk uji. */
const checkAdvAlerts = (now) => (sockRef ? advEngine.tick(now) : undefined);

// ---------- alarm titik balik S/R (!alertsnr) ----------
const snrEngine = createSnrEngine({
  store,
  fetchCandles,
  notify,
  langFor,
  isUnsupported: (err) => err instanceof UnsupportedCoinError,
});

/** Pemeriksaan alarm S/R (konfirmasi). Dipanggil timer; aman dipanggil manual untuk uji. */
const checkSnrAlerts = (now) => (sockRef ? snrEngine.tick(now) : undefined);

// ---------- alarm Higher High / Lower Low (!alerthhll) ----------
const hhllEngine = createHhllEngine({
  store,
  fetchCandles,
  notify,
  notifyDocument,
  buildPdf: buildHhllPdf,
  langFor,
  isUnsupported: (err) => err instanceof UnsupportedCoinError,
});

/** Pemeriksaan alarm HH/LL (dini + konfirmasi). Dipanggil timer; aman dipanggil manual untuk uji. */
const checkHhllAlerts = (now) => (sockRef ? hhllEngine.tick(now) : undefined);

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

  setInterval(async () => {
    if (advBusy) return;
    advBusy = true;
    try {
      await checkAdvAlerts();
    } catch (err) {
      console.log("[advalert] pengecekan gagal:", err.message);
    } finally {
      advBusy = false;
    }
  }, ADV.CHECK_MS).unref?.();

  setInterval(async () => {
    if (snrBusy) return;
    snrBusy = true;
    try {
      await checkSnrAlerts();
    } catch (err) {
      console.log("[snralert] pengecekan gagal:", err.message);
    } finally {
      snrBusy = false;
    }
  }, SNR.CHECK_MS).unref?.();

  setInterval(async () => {
    if (hhllBusy) return;
    hhllBusy = true;
    try {
      await checkHhllAlerts();
    } catch (err) {
      console.log("[hhllalert] pengecekan gagal:", err.message);
    } finally {
      hhllBusy = false;
    }
  }, HHLL.CHECK_MS).unref?.();
}

module.exports = { setAlertSocket, checkPriceAlerts, checkDaily, checkDivergence, checkAdvAlerts, checkSnrAlerts, checkHhllAlerts, localNow, fetchPrices };
