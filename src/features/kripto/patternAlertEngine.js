"use strict";

/**
 * features/kripto/patternAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm pola (!alertpola), Fitur 5A Paket 2/4. Aturan murninya ada di patternAlertCore.js.
 * Meniru hhllAlertEngine.js: semua ketergantungan (store, fetch candle, pindai pola, kirim pesan, bahasa)
 * disuntik lewat createPatternEngine(), jadi seluruh alur bisa diuji dengan data palsu tanpa jaringan.
 * alertMonitor.js membuat satu engine dan memanggil tick() tiap PATTERN_ALERT_CONFIG.CHECK_MS.
 *
 * Cara menilai satu pasangan koin+TF:
 *   1. Ambil candle, buang yang belum closed. X = candle closed terakhir; dinilai setelah FINAL_DELAY_MS agar data Binance final.
 *   2. Pindai dua kali dengan scanTf (patternCommand.js, tanpa lookahead): SEBELUM X (prefix) dan SAMPAI X.
 *   3. detectEvents(sebelum, sesudah) -> kejadian dini (CALON baru) dan konfirmasi (baru terkonfirmasi di X).
 *   4. Saring sesuai langganan (arah, tahap, kuat), buang yang sudah terkirim (kunci dedupe), lalu kirim.
 *
 * Aturan pengiriman:
 *   - Hanya candle closed, dan hanya candle yang TUTUP setelah alarm dibuat (kejadian lama tidak diumumkan).
 *   - Kejadian dianggap TERKIRIM (kunci dedupe dicatat lewat store.markSent) hanya setelah pesan berhasil.
 *     Pesan gagal -> kejadian belum ditandai, dicoba lagi di putaran berikutnya selama X masih candle closed terakhir.
 *   - Batas pesan per chat per jam (ChatRateLimiter): yang tidak muat ditunda, bukan dibuang.
 *   - Dua langganan yang cocok dengan kejadian yang sama -> dikirim sekali (kunci sama).
 *   - Kalau salah satu pindaian (sebelum / sesudah) gagal atau datanya kurang, TIDAK ada kejadian: kalau tidak, semua pola
 *     yang sudah ada akan tampak "baru".
 *
 * Kunci dedupe memakai WAKTU candle penutup pola (bukan index array), supaya tidak berubah kalau jendela candle bergeser.
 * Versi A sengaja tanpa kekuatan tren / Gaussian / TF besar (scanTf dipanggil tanpa candle TF besar), supaya ringan dan mandiri.
 */

const { PATTERN_ALERT_CONFIG: PA } = require("../../config/indicatorConfig");
const { TF_MS, COIN_WATCHLIST, ChatRateLimiter } = require("./divAlertCore");
const { selectLivePairs } = require("./advAlertCore");
const { runPool } = require("./advAlertEngine");
const { coinDecimals } = require("../../utils/priceFormat");
const { pairInfo } = require("../forex/forexPairs");
const { detectEvents, matchSub, isAfterCreation, patKey, chunk, sortEvents, buildPatternText, capCoins } = require("./patternAlertCore");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCAN_CACHE_MAX = 200;

/**
 * Pindai bawaan: scanTf dari patternCommand.js, tanpa candle TF besar. Dimuat malas supaya modul ini ringan saat diuji.
 * @returns {object[]|null} daftar pola; null = data belum cukup / pindai gagal
 */
function defaultScan(tf, candles, coin) {
  const { scanTf } = require("./patternCommand");
  // Pair forex: toleransi level 0,2%, presisi = digits pair, dan pola yang melibatkan gap ditandai (p.fxGap).
  const market = pairInfo(String(coin || "").toUpperCase()) ? require("../forex/forexMarket").createForexMarket(coin) : null;
  const res = scanTf(tf, candles, null, market ? { market } : {});
  return res && res.ok ? res.patterns || [] : null;
}

/** Pasar forex tutup menurut kalender (akhir pekan)? Kripto / pair tak dikenal = false. */
function fxMarketClosed(coin, now) {
  if (!pairInfo(String(coin || "").toUpperCase())) return false;
  return require("../forex/forexMarket").marketStatus(now).open === false;
}

/**
 * @param {{
 *   store: object,   // cryptoStore (allPatternAlerts, getWatch, wasSent, markSent, persist)
 *   fetchCandles: (coin:string, tf:string, opts?:object) => Promise<object[]>,
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   langFor: (chat:string, userJid:string) => string,
 *   scan?: (tf:string, candles:object[], coin:string) => object[]|null,   // default: scanTf tanpa TF besar (forex: dengan adapter pasar)
 *   isUnsupported?: (err:Error) => boolean,
 *   limiter?: ChatRateLimiter, sleep?: Function, log?: Function
 * }} deps
 */
function createPatternEngine(deps) {
  const { store, fetchCandles, notify, langFor } = deps;
  const scan = deps.scan || defaultScan;
  const isUnsupported = deps.isUnsupported || (() => false);
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: PA.MAX_MSG_PER_CHAT_HOUR });

  const lastRun = new Map(); // "COIN|TF" -> ms hitung terakhir
  const scanCache = new Map(); // "COIN|TF|candleT|n" -> { prev, now }; satu pindaian dipakai semua langganan pasangan yang sama

  /** Koin yang dipantau satu langganan. Watchlist dipotong ke MAX_COINS_PER_ALERT (urutan asli dipertahankan). */
  const resolveCoins = ({ userJid, sub }) => (sub.coin === COIN_WATCHLIST ? capCoins(store.getWatch(userJid)).used : [sub.coin]);

  /**
   * Pola sebelum X dan sampai X untuk satu pasangan (di-cache per candle X). null = salah satu pindaian gagal.
   * Candle dipotong ke `closed` sehingga pindaian tidak pernah melihat candle yang belum tutup.
   */
  function scanPair(coin, tf, closed) {
    const X = closed[closed.length - 1];
    const k = `${coin}|${tf}|${X.t}|${closed.length}`;
    if (scanCache.has(k)) return scanCache.get(k);
    let out = null;
    try {
      const prev = scan(tf, closed.slice(0, -1), coin);
      const now = prev ? scan(tf, closed, coin) : null;
      if (prev && now) out = { prev, now };
    } catch (err) {
      log(`[patalert] gagal memindai ${coin} ${tf}:`, err.message);
    }
    if (scanCache.size >= SCAN_CACHE_MAX) scanCache.clear();
    scanCache.set(k, out);
    return out;
  }

  /**
   * Evaluasi satu langganan untuk satu koin. Tidak mengirim apa pun.
   * @param {object[]} candles hasil fetchCandles(coin, tf); candle yang belum closed (closed === false) diabaikan
   * @returns {{events:object[]}}
   */
  function evaluate(entry, coin, candles, now = Date.now()) {
    const { userJid, sub } = entry;
    const tf = sub.tf;
    const tfMs = TF_MS[tf];
    const out = { events: [] };
    if (!candles || !candles.length || !tfMs) return out;

    const closed = candles.filter((c) => c.closed !== false);
    const X = closed[closed.length - 1];
    if (!X) return out;
    const finalReady = X.t + tfMs + PA.FINAL_DELAY_MS <= now;
    if (!finalReady || !isAfterCreation(sub, X.t, tfMs)) return out;

    const pair = scanPair(coin, tf, closed);
    if (!pair) return out;
    // Presisi: kripto = desimal terbanyak di data candle (level tampil tanpa pembulatan); forex = digits tetap per pair.
    const dp = pairInfo(String(coin).toUpperCase())?.digits ?? coinDecimals(closed);
    const fxClosed = fxMarketClosed(coin, now);

    for (const raw of detectEvents(pair.prev, pair.now)) {
      if (!matchSub(raw, sub)) continue;
      // id berbasis waktu candle penutup pola (tahan terhadap pergeseran jendela candle)
      const endT = closed[raw.endI]?.t ?? raw.endI;
      const id = [raw.variant || raw.kind, raw.dir, endT].join(":");
      const ev = { ...raw, id, chat: sub.chat, userJid, coin, tf, subId: sub.id, candleT: X.t, now: X.c, dp, fxClosed };
      const key = patKey(sub.chat, userJid, coin, tf, ev.stage, ev, X.t);
      if (store.wasSent(key)) continue;
      out.events.push({ ...ev, key });
    }
    return out;
  }

  const commitAll = (events) => store.markSent(events.map((e) => e.key));

  /** Kirim kejadian satu penerima sebagai teks berpotongan. @returns {{sent:number, failed:number, deferred:number}} */
  async function deliver(chat, userJid, events, { ms }) {
    const lang = langFor(chat, userJid);
    const res = { sent: 0, failed: 0, deferred: 0 };
    const parts = chunk(sortEvents(events), PA.LINES_PER_MSG);
    for (let i = 0; i < parts.length; i++) {
      if (limiter.remaining(chat) < 1) {
        res.deferred += parts.slice(i).reduce((n, p) => n + p.length, 0);
        break;
      }
      const ok = await notify(chat, userJid, buildPatternText(lang, parts[i], { ms, part: i + 1, parts: parts.length, total: events.length }));
      if (!ok) {
        res.failed++;
        break; // kejadian bagian ini belum ditandai terkirim -> dicoba lagi putaran berikutnya
      }
      limiter.record(chat);
      res.sent++;
      commitAll(parts[i]);
      if (PA.SEND_GAP_MS && i < parts.length - 1) await sleep(PA.SEND_GAP_MS);
    }
    return res;
  }

  async function deliverAll(events, { ms }) {
    const groups = new Map();
    for (const ev of events) {
      const k = `${ev.chat}|${ev.userJid}`;
      if (!groups.has(k)) groups.set(k, { chat: ev.chat, userJid: ev.userJid, events: [] });
      groups.get(k).events.push(ev);
    }
    const totals = { sent: 0, failed: 0, deferred: 0 };
    for (const g of groups.values()) {
      let r;
      try {
        r = await deliver(g.chat, g.userJid, g.events, { ms });
      } catch (err) {
        log("[patalert] gagal mengirim:", err.message);
        totals.failed++;
        continue;
      }
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    return totals;
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allPatternAlerts();
    if (!all.length) return;

    const byPair = new Map(); // "COIN|TF" -> entries
    for (const e of all) {
      for (const coin of resolveCoins(e)) {
        const k = `${coin}|${e.sub.tf}`;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push(e);
      }
    }
    for (const k of lastRun.keys()) if (!byPair.has(k)) lastRun.delete(k);

    const chosen = selectLivePairs([...byPair.keys()], lastRun, now, { intervalMs: PA.INTERVAL_MS, max: PA.MAX_PAIRS });
    if (!chosen.length) return;

    const startedAt = Date.now();
    const byKey = new Map(); // dua langganan yang cocok dengan kejadian sama -> kirim sekali
    let failures = 0;
    await runPool(chosen, PA.CONCURRENCY, async (pair) => {
      const [coin, tf] = pair.split("|");
      lastRun.set(pair, now); // dicatat saat mencoba: gagal pun baru dicoba lagi setelah interval (tidak menghantam API)
      let candles;
      try {
        candles = await fetchCandles(coin, tf);
      } catch (err) {
        if (!isUnsupported(err)) failures++;
        return;
      }
      for (const e of byPair.get(pair)) {
        for (const ev of evaluate(e, coin, candles, now).events) if (!byKey.has(ev.key)) byKey.set(ev.key, ev);
      }
    });
    const events = [...byKey.values()];
    const totals = await deliverAll(events, { ms: now });
    if (totals.sent) store.persist?.();
    log(`[patalert] pasangan=${chosen.length}/${byPair.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed + failures} ditunda_batas_jam=${totals.deferred} total=${Date.now() - startedAt}ms`);
  }

  return { tick, evaluate, deliver, _state: { lastRun, limiter, scanCache } };
}

module.exports = { createPatternEngine };
