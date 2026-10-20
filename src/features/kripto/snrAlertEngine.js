"use strict";

/**
 * features/kripto/snrAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm titik balik S/R (!alertsnr): reject + tembus, hanya KONFIRMASI (candle closed).
 * Semua ketergantungan (store, fetch candle, kirim pesan, bahasa, hitung level) disuntik lewat
 * createSnrEngine(), jadi seluruh alur bisa diuji dengan data palsu tanpa jaringan.
 * alertMonitor.js membuat satu engine dan memanggil tick() tiap SNR.CHECK_MS.
 *
 * Tiap pasangan koin+TF diambil ulang paling cepat tiap SNR.INTERVAL_MS, lalu candle closed TERAKHIR
 * dinilai terhadap level dari candle closed sebelum dia (setelah FINAL_DELAY_MS agar data final).
 * Dinilai ulang tiap putaran selama masih candle closed terakhir; kunci dedupe mencegah kiriman ganda,
 * dan kiriman yang ditunda (batas pesan per jam) dicoba lagi di putaran berikutnya.
 *
 * Aturan pengiriman: kejadian dianggap TERKIRIM (kunci dedupe dicatat) hanya setelah pesan berhasil.
 * Konfirmasi hanya untuk candle yang closed SETELAH alarm dibuat (kejadian lama tidak diumumkan).
 */

const { SNR_ALERT_CONFIG: SNR } = require("../../config/indicatorConfig");
const { TF_MS, COIN_WATCHLIST, ChatRateLimiter } = require("./divAlertCore");
const { selectLivePairs } = require("./advAlertCore");
const { runPool } = require("./advAlertEngine");
const { watchedLevels, candleHits, snrKey, chunk, sortEvents, buildSnrText } = require("./snrAlertCore");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   store: object,   // cryptoStore (allSnrAlerts, getWatch, wasSent, markSent, persist)
 *   fetchCandles: (coin:string, tf:string, opts?:object) => Promise<object[]>,
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   langFor: (chat:string, userJid:string) => string,
 *   computeSnr?: Function,
 *   isUnsupported?: (err:Error) => boolean,
 *   limiter?: ChatRateLimiter, sleep?: Function, log?: Function
 * }} deps
 */
function createSnrEngine(deps) {
  const { store, fetchCandles, notify, langFor } = deps;
  const isUnsupported = deps.isUnsupported || (() => false);
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: SNR.MAX_MSG_PER_CHAT_HOUR });
  const buf = SNR.BUFFER_PCT / 100;

  const lastRun = new Map(); // "COIN|TF" -> ms hitung terakhir

  const resolveCoins = ({ userJid, sub }) => (sub.coin === COIN_WATCHLIST ? store.getWatch(userJid) : [sub.coin]);
  const levelOpts = (sub) => ({ strong: !!sub.strong, computeSnr: deps.computeSnr });

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
    if (!candles || !candles.length) return out;

    const closed = candles.filter((c) => c.closed !== false);
    if (closed.length < SNR.MIN_CANDLES) return out;

    const base = { chat: sub.chat, userJid, coin, tf, subId: sub.id };
    const X = closed[closed.length - 1];
    const finalReady = X.t + tfMs + SNR.FINAL_DELAY_MS <= now;
    if (!finalReady || X.t + tfMs <= sub.createdAt) return out;

    const hits = candleHits(X, watchedLevels(closed.slice(0, -1), levelOpts(sub)), buf);
    for (const h of hits) {
      if (!sub.kinds.includes(h.type)) continue;
      const key = snrKey(sub.chat, userJid, coin, tf, h.type, h.side, h.rank, X.t);
      if (store.wasSent(key)) continue;
      out.events.push({ ...base, ...h, candleT: X.t, key, commit: () => store.markSent([key]) });
    }
    return out;
  }

  /** Kirim kejadian satu penerima, dipecah per LINES_PER_MSG baris. @returns {{sent:number, failed:number, deferred:number}} */
  async function deliver(chat, userJid, events, { ms }) {
    const lang = langFor(chat, userJid);
    const res = { sent: 0, failed: 0, deferred: 0 };
    const parts = chunk(sortEvents(events), SNR.LINES_PER_MSG);
    for (let i = 0; i < parts.length; i++) {
      if (limiter.remaining(chat) < 1) {
        res.deferred += parts.slice(i).reduce((n, p) => n + p.length, 0);
        break;
      }
      const ok = await notify(chat, userJid, buildSnrText(lang, parts[i], { ms, part: i + 1, parts: parts.length }));
      if (!ok) {
        res.failed++;
        break;
      }
      limiter.record(chat);
      res.sent++;
      for (const ev of parts[i]) ev.commit();
      if (SNR.SEND_GAP_MS && i < parts.length - 1) await sleep(SNR.SEND_GAP_MS);
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
        log("[snralert] gagal mengirim:", err.message);
        totals.failed++;
        continue;
      }
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    return totals;
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allSnrAlerts();
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

    const chosen = selectLivePairs([...byPair.keys()], lastRun, now, { intervalMs: SNR.INTERVAL_MS, max: SNR.MAX_PAIRS });
    if (!chosen.length) return;

    const startedAt = Date.now();
    const events = [];
    let failures = 0;
    await runPool(chosen, SNR.CONCURRENCY, async (pair) => {
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
        const r = evaluate(e, coin, candles, now);
        events.push(...r.events);
      }
    });
    const totals = await deliverAll(events, { ms: now });
    if (totals.sent) store.persist();
    log(`[snralert] pasangan=${chosen.length}/${byPair.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed + failures} ditunda_batas_jam=${totals.deferred} total=${Date.now() - startedAt}ms`);
  }

  return { tick, evaluate, deliver, _state: { lastRun, limiter } };
}

module.exports = { createSnrEngine };
