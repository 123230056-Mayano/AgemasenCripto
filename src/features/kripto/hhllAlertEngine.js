"use strict";

/**
 * features/kripto/hhllAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm Higher High / Lower Low (!alerthhll): tahap DINI (swing baru terkonfirmasi) dan KONFIRMASI
 * (close pertama menembus swing). Semua dinilai dari candle CLOSED.
 * Semua ketergantungan (store, fetch candle, kirim pesan/PDF, bahasa) disuntik lewat createHhllEngine(),
 * jadi seluruh alur bisa diuji dengan data palsu tanpa jaringan. alertMonitor.js membuat satu engine dan
 * memanggil tick() tiap HHLL.CHECK_MS.
 *
 * Tiap pasangan koin+TF diambil ulang paling cepat tiap HHLL.INTERVAL_MS, lalu candle closed TERAKHIR dinilai
 * terhadap swing dari candle sebelumnya (setelah FINAL_DELAY_MS agar data Binance final). Dinilai ulang tiap
 * putaran selama masih candle closed terakhir; kunci dedupe mencegah kiriman ganda, dan kiriman yang ditunda
 * (batas pesan per jam) dicoba lagi di putaran berikutnya.
 *
 * Aturan pengiriman: kejadian dianggap TERKIRIM (kunci dedupe dicatat) hanya setelah pesan berhasil.
 * Hanya candle yang closed SETELAH alarm dibuat yang diumumkan (kejadian lama tidak).
 *
 * Banyak kejadian untuk satu penerima (>= HHLL.PDF_MIN) -> 1 pesan pengantar + 1 PDF (dikelompokkan per TF).
 * Kalau PDF gagal dibuat, otomatis jatuh ke teks berpotongan supaya alarm tidak hilang.
 */

const { HHLL_ALERT_CONFIG: HA } = require("../../config/indicatorConfig");
const { TF_MS, COIN_WATCHLIST, ChatRateLimiter } = require("./divAlertCore");
const { selectLivePairs } = require("./advAlertCore");
const { runPool } = require("./advAlertEngine");
const { detectEvents, matchSub, hhllKey, chunk, sortEvents, buildHhllText, buildHhllPdfIntro } = require("./hhllAlertCore");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   store: object,   // cryptoStore (allHhllAlerts, getWatch, wasSent, markSent, persist)
 *   fetchCandles: (coin:string, tf:string, opts?:object) => Promise<object[]>,
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   notifyDocument?: (chat:string, userJid:string, buffer:Buffer, fileName:string) => Promise<boolean>,
 *   buildPdf?: (p:{events:object[], lang:string, ms:number}) => Promise<Buffer>,
 *   langFor: (chat:string, userJid:string) => string,
 *   isUnsupported?: (err:Error) => boolean,
 *   limiter?: ChatRateLimiter, sleep?: Function, log?: Function
 * }} deps
 */
function createHhllEngine(deps) {
  const { store, fetchCandles, notify, langFor } = deps;
  const isUnsupported = deps.isUnsupported || (() => false);
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: HA.MAX_MSG_PER_CHAT_HOUR });
  const pdfMin = deps.pdfMin ?? HA.PDF_MIN;

  const lastRun = new Map(); // "COIN|TF" -> ms hitung terakhir
  const resolveCoins = ({ userJid, sub }) => (sub.coin === COIN_WATCHLIST ? store.getWatch(userJid) : [sub.coin]);

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
    const finalReady = X.t + tfMs + HA.FINAL_DELAY_MS <= now;
    if (!finalReady || X.t + tfMs <= sub.createdAt) return out;

    const base = { chat: sub.chat, userJid, coin, tf, subId: sub.id };
    for (const ev of detectEvents(closed)) {
      if (!matchSub(ev, sub)) continue;
      const key = hhllKey(sub.chat, userJid, coin, tf, ev.stage, ev.dir, X.t);
      if (store.wasSent(key)) continue;
      out.events.push({ ...base, ...ev, candleT: X.t, key });
    }
    return out;
  }

  const commitAll = (events) => store.markSent(events.map((e) => e.key));

  /** Teks berpotongan (dipakai kalau kejadian sedikit atau PDF gagal). */
  async function deliverText(chat, userJid, events, lang, ms, res) {
    const sorted = sortEvents(events);
    const parts = chunk(sorted, HA.LINES_PER_MSG);
    for (let i = 0; i < parts.length; i++) {
      if (limiter.remaining(chat) < 1) {
        res.deferred += parts.slice(i).reduce((n, p) => n + p.length, 0);
        break;
      }
      const ok = await notify(chat, userJid, buildHhllText(lang, parts[i], { ms, part: i + 1, parts: parts.length, total: events.length }));
      if (!ok) {
        res.failed++;
        break;
      }
      limiter.record(chat);
      res.sent++;
      commitAll(parts[i]);
      if (HA.SEND_GAP_MS && i < parts.length - 1) await sleep(HA.SEND_GAP_MS);
    }
  }

  /** Kirim kejadian satu penerima. @returns {{sent:number, failed:number, deferred:number, mode:string}} */
  async function deliver(chat, userJid, events, { ms }) {
    const lang = langFor(chat, userJid);
    const res = { sent: 0, failed: 0, deferred: 0, mode: "text" };

    if (events.length >= pdfMin && deps.notifyDocument && deps.buildPdf) {
      if (limiter.remaining(chat) < 2) {
        res.deferred += events.length; // tidak muat jatah per jam -> coba lagi putaran berikutnya
        res.mode = "pdf";
        return res;
      }
      let pdf = null;
      try {
        pdf = await deps.buildPdf({ events: sortEvents(events), lang, ms });
      } catch (err) {
        log("[hhllalert] gagal membuat PDF, kirim sebagai teks:", err.message);
      }
      if (pdf) {
        res.mode = "pdf";
        const stamp = new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, "");
        const okIntro = await notify(chat, userJid, buildHhllPdfIntro(lang, events, { ms }));
        if (!okIntro) {
          res.failed++;
          return res;
        }
        limiter.record(chat);
        res.sent++;
        if (HA.SEND_GAP_MS) await sleep(HA.SEND_GAP_MS);
        const sendPdf = () => deps.notifyDocument(chat, userJid, pdf, `HHLL-${stamp}UTC.pdf`);
        const okPdf = (await sendPdf()) || (await sendPdf()); // satu percobaan ulang langsung
        if (!okPdf) {
          res.failed++;
          return res; // kejadian belum ditandai terkirim -> putaran berikutnya mengirim ulang
        }
        limiter.record(chat);
        res.sent++;
        commitAll(events);
        return res;
      }
    }
    await deliverText(chat, userJid, events, lang, ms, res);
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
        log("[hhllalert] gagal mengirim:", err.message);
        totals.failed++;
        continue;
      }
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    return totals;
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allHhllAlerts();
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

    const chosen = selectLivePairs([...byPair.keys()], lastRun, now, { intervalMs: HA.INTERVAL_MS, max: HA.MAX_PAIRS });
    if (!chosen.length) return;

    const startedAt = Date.now();
    const byKey = new Map(); // dua langganan yang cocok dengan kejadian sama -> kirim sekali
    let failures = 0;
    await runPool(chosen, HA.CONCURRENCY, async (pair) => {
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
    if (totals.sent) store.persist();
    log(`[hhllalert] pasangan=${chosen.length}/${byPair.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed + failures} ditunda_batas_jam=${totals.deferred} total=${Date.now() - startedAt}ms`);
  }

  return { tick, evaluate, deliver, _state: { lastRun, limiter } };
}

module.exports = { createHhllEngine };
