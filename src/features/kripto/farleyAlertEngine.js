"use strict";

/**
 * features/kripto/farleyAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm Farley (!alertfarley): kirim skenario BUY / SELL baru saat candle closed. Semua ketergantungan
 * (store, fetch candle, kirim pesan, bahasa) disuntik lewat createFarleyEngine() supaya bisa diuji tanpa jaringan.
 * alertMonitor.js membuat satu engine dan memanggil tick() tiap CFG.CHECK_MS. Pola sama dengan signalAlertEngine.js.
 *
 * Tiap pasangan koin+TF diambil ulang paling cepat tiap CFG.INTERVAL_MS (beserta candle TF konteks), lalu candle closed
 * TERAKHIR dinilai (setelah FINAL_DELAY_MS) dan dibandingkan dengan skenario candle sebelumnya. Kejadian dianggap
 * TERKIRIM (kunci dedupe dicatat) hanya setelah pesan berhasil. Hanya candle yang closed SETELAH alarm dibuat yang diumumkan.
 */

const { FARLEY_ALERT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { TF_MS, COIN_WATCHLIST, ChatRateLimiter } = require("./divAlertCore");
const { selectLivePairs } = require("./advAlertCore");
const { runPool } = require("./advAlertEngine");
const { ctxTfOf } = require("./farleyCore");
const { detectNewFarley, farleyKey, chunk, sortEvents, buildFarleyAlertText } = require("./farleyAlertCore");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Skenario Farley dari candle mentah + candle konteks (default = analyze() di farley.js). */
function defaultAnalyze(candles, ctxRaw, tf) {
  return require("./farley").analyze(candles, ctxRaw, tf).sc;
}

/**
 * Bila notifyImage + renderChart disuntik, tiap kejadian dikirim sebagai SATU gambar chart + caption (teks saja kalau chart gagal
 * dibuat / dikirim). Tanpa keduanya, perilaku lama: teks, beberapa blok per pesan.
 * @param {{
 *   store: object,   // cryptoStore (allFarleyAlerts, getWatch, wasSent, markSent, persist)
 *   fetchCandles: (coin:string, tf:string, opts?:object) => Promise<object[]>,
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   notifyImage?: (chat:string, userJid:string, png:Buffer, caption:string) => Promise<boolean>,
 *   renderChart?: (ev:object, lang:string) => Buffer|Promise<Buffer>,   // ev.closed = candle closed, ev.sc = skenario
 *   langFor: (chat:string, userJid:string) => string,
 *   analyze?: (candles:object[], ctxRaw:object[]|null, tf:string) => object,
 *   isUnsupported?: (err:Error) => boolean,
 *   limiter?: ChatRateLimiter, sleep?: Function, log?: Function
 * }} deps
 */
function createFarleyEngine(deps) {
  const { store, fetchCandles, notify, langFor } = deps;
  const notifyImage = deps.notifyImage || null;
  const renderChart = deps.renderChart || null;
  const analyze = deps.analyze || defaultAnalyze;
  const isUnsupported = deps.isUnsupported || (() => false);
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: CFG.MAX_MSG_PER_CHAT_HOUR });

  const lastRun = new Map(); // "COIN|TF" -> ms hitung terakhir
  const cache = new Map(); // "COIN|TF" -> { t, cur, prev }

  const resolveCoins = ({ userJid, sub }) => (sub.coin === COIN_WATCHLIST ? store.getWatch(userJid) : [sub.coin]);

  function scenariosFor(coin, tf, closed, ctxRaw) {
    const X = closed[closed.length - 1];
    const k = `${coin}|${tf}`;
    const hit = cache.get(k);
    if (hit && hit.t === X.t) return hit;
    const entry = { t: X.t, cur: analyze(closed, ctxRaw, tf), prev: analyze(closed.slice(0, -1), ctxRaw, tf) };
    cache.set(k, entry);
    return entry;
  }

  /** Evaluasi satu langganan untuk satu koin. Tidak mengirim apa pun. @returns {{events:object[]}} */
  function evaluate(entry, coin, candles, ctxRaw, now = Date.now()) {
    const { userJid, sub } = entry;
    const tf = sub.tf;
    const tfMs = TF_MS[tf];
    const out = { events: [] };
    if (!candles || !candles.length) return out;
    const closed = candles.filter((c) => c.closed !== false);
    if (closed.length < CFG.MIN_CANDLES) return out;

    const X = closed[closed.length - 1];
    const finalReady = X.t + tfMs + CFG.FINAL_DELAY_MS <= now;
    if (!finalReady || X.t + tfMs <= sub.createdAt) return out;

    const sc = scenariosFor(coin, tf, closed, ctxRaw);
    const hit = detectNewFarley(sc.cur, sc.prev, sub);
    if (!hit) return out;

    const key = farleyKey(sub.chat, userJid, coin, tf, hit.dir, X.t);
    if (store.wasSent(key)) return out;
    // Jeda arah sama: skenario yang menempel di ambang bisa muncul berulang.
    for (let k = 1; k <= CFG.COOLDOWN_CANDLES; k++) {
      if (store.wasSent(farleyKey(sub.chat, userJid, coin, tf, hit.dir, X.t - k * tfMs))) return out;
    }
    out.events.push({
      chat: sub.chat,
      userJid,
      coin,
      tf,
      subId: sub.id,
      dir: hit.dir,
      trigger: hit.trigger,
      price: X.c,
      candleT: X.t,
      closeMs: X.t + tfMs,
      sc: sc.cur,
      closed,
      key,
      commit: () => store.markSent([key]),
    });
    return out;
  }

  /** Chart satu kejadian; null kalau tidak ada renderer atau gagal (kejadian tetap dikirim sebagai teks). */
  async function chartFor(ev, lang) {
    if (!renderChart || !notifyImage) return null;
    try {
      return await renderChart(ev, lang);
    } catch (err) {
      log(`[farleyalert] chart ${ev.coin} ${ev.tf} gagal, kirim teks saja:`, err.message);
      return null;
    }
  }

  /** Satu kejadian = satu pesan: gambar chart + caption (atau teks saja kalau chart tidak ada / gagal terkirim). */
  async function sendEvent(chat, userJid, ev, lang) {
    const caption = buildFarleyAlertText(lang, [ev], { ms: ev.closeMs });
    const png = await chartFor(ev, lang);
    if (png && (await notifyImage(chat, userJid, png, caption))) return true;
    if (png) log(`[farleyalert] gambar ${ev.coin} ${ev.tf} gagal terkirim, coba kirim teks`);
    return notify(chat, userJid, caption);
  }

  async function deliver(chat, userJid, events) {
    const lang = langFor(chat, userJid);
    const res = { sent: 0, failed: 0, deferred: 0 };

    // Dengan chart: satu pesan per kejadian. Jatah pesan per jam habis -> sisanya ditunda ke putaran berikutnya.
    if (renderChart && notifyImage) {
      const sorted = sortEvents(events);
      for (let i = 0; i < sorted.length; i++) {
        if (limiter.remaining(chat) < 1) {
          res.deferred += sorted.length - i;
          break;
        }
        const ok = await sendEvent(chat, userJid, sorted[i], lang);
        if (!ok) {
          res.failed++;
          break;
        }
        limiter.record(chat);
        res.sent++;
        sorted[i].commit();
        if (CFG.SEND_GAP_MS && i < sorted.length - 1) await sleep(CFG.SEND_GAP_MS);
      }
      return res;
    }

    const parts = chunk(sortEvents(events), CFG.BLOCKS_PER_MSG);
    for (let i = 0; i < parts.length; i++) {
      if (limiter.remaining(chat) < 1) {
        res.deferred += parts.slice(i).reduce((n, p) => n + p.length, 0);
        break;
      }
      const ms = Math.max(...parts[i].map((e) => e.closeMs));
      const ok = await notify(chat, userJid, buildFarleyAlertText(lang, parts[i], { ms, part: i + 1, parts: parts.length }));
      if (!ok) {
        res.failed++;
        break;
      }
      limiter.record(chat);
      res.sent++;
      for (const ev of parts[i]) ev.commit();
      if (CFG.SEND_GAP_MS && i < parts.length - 1) await sleep(CFG.SEND_GAP_MS);
    }
    return res;
  }

  async function deliverAll(events) {
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
        r = await deliver(g.chat, g.userJid, g.events);
      } catch (err) {
        log("[farleyalert] gagal mengirim:", err.message);
        totals.failed++;
        continue;
      }
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    return totals;
  }

  /** Dua langganan satu pemilik di koin+TF+arah+candle yang sama menghasilkan kunci sama: kirim sekali. */
  function mergeEvents(list) {
    const byKey = new Map();
    for (const ev of list) if (!byKey.has(ev.key)) byKey.set(ev.key, ev);
    return [...byKey.values()];
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allFarleyAlerts();
    if (!all.length) return;

    const byPair = new Map();
    for (const e of all) {
      for (const coin of resolveCoins(e)) {
        const k = `${coin}|${e.sub.tf}`;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push(e);
      }
    }
    for (const k of lastRun.keys()) if (!byPair.has(k)) lastRun.delete(k);
    for (const k of cache.keys()) if (!byPair.has(k)) cache.delete(k);

    const chosen = selectLivePairs([...byPair.keys()], lastRun, now, { intervalMs: CFG.INTERVAL_MS, max: CFG.MAX_PAIRS });
    if (!chosen.length) return;

    const startedAt = Date.now();
    const rawEvents = [];
    let failures = 0;
    await runPool(chosen, CFG.CONCURRENCY, async (pair) => {
      const [coin, tf] = pair.split("|");
      lastRun.set(pair, now);
      let candles;
      let ctxRaw = null;
      try {
        const ctxTf = ctxTfOf(tf);
        [candles, ctxRaw] = await Promise.all([fetchCandles(coin, tf), ctxTf ? fetchCandles(coin, ctxTf).catch(() => null) : null]);
      } catch (err) {
        if (!isUnsupported(err)) failures++;
        return;
      }
      for (const e of byPair.get(pair)) {
        try {
          rawEvents.push(...evaluate(e, coin, candles, ctxRaw, now).events);
        } catch (err) {
          failures++;
          log(`[farleyalert] gagal menghitung ${pair}:`, err.message);
        }
      }
    });
    const events = mergeEvents(rawEvents);
    const totals = await deliverAll(events);
    if (totals.sent) store.persist();
    log(`[farleyalert] pasangan=${chosen.length}/${byPair.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed + failures} ditunda_batas_jam=${totals.deferred} total=${Date.now() - startedAt}ms`);
  }

  return { tick, evaluate, deliver, mergeEvents, _state: { lastRun, cache, limiter } };
}

module.exports = { createFarleyEngine };
