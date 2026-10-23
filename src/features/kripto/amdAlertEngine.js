"use strict";

/**
 * features/kripto/amdAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm AMD (!alertamd): tahap DINI (sweep / manipulasi terjadi) dan KONFIRMASI (close pertama menembus
 * swing berlawanan = awal distribusi). Semua dinilai dari candle CLOSED. Definisi fase: amdCore.js.
 * Semua ketergantungan (store, fetch candle, kirim pesan, bahasa) disuntik lewat createAmdEngine(), jadi seluruh
 * alur bisa diuji dengan data palsu tanpa jaringan. alertMonitor.js membuat satu engine dan memanggil tick()
 * tiap AMD_ALERT_CONFIG.CHECK_MS.
 *
 * Tiap pasangan koin+TF diambil ulang paling cepat tiap INTERVAL_MS, lalu candle closed TERAKHIR dinilai terhadap
 * candle sebelumnya (setelah FINAL_DELAY_MS agar data Binance final). Dinilai ulang tiap putaran selama masih
 * candle closed terakhir; kunci dedupe mencegah kiriman ganda, dan kiriman yang ditunda (batas pesan per jam)
 * dicoba lagi di putaran berikutnya.
 *
 * Aturan pengiriman: kejadian dianggap TERKIRIM (kunci dedupe dicatat) hanya setelah pesan berhasil.
 * Hanya candle yang closed SETELAH alarm dibuat yang diumumkan (kejadian lama tidak).
 * Format: SATU pesan per kejadian = gambar chart (dengan zona SL/TP) + caption berisi rencana SL/TP.
 * Kalau chart gagal dibuat / dikirim, kejadian dikirim sebagai teks saja supaya alarm tidak hilang.
 */

const { AMD_ALERT_CONFIG: HA } = require("../../config/indicatorConfig");
const { TF_MS, COIN_WATCHLIST, ChatRateLimiter } = require("./divAlertCore");
const { selectLivePairs } = require("./advAlertCore");
const { runPool } = require("./advAlertEngine");
const { detectEvents, matchSub, amdKey, sortEvents, buildAmdCaption, computePlan } = require("./amdAlertCore");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   store: object,   // cryptoStore (allAmdAlerts, getWatch, wasSent, markSent, persist)
 *   fetchCandles: (coin:string, tf:string, opts?:object) => Promise<object[]>,
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   notifyImage?: (chat:string, userJid:string, png:Buffer, caption:string) => Promise<boolean>,
 *   renderChart?: (ev:object) => Buffer|Promise<Buffer>,   // ev.closed = candle closed, ev.st = state chart, ev.plan = rencana SL/TP
 *   langFor: (chat:string, userJid:string) => string,
 *   isUnsupported?: (err:Error) => boolean,
 *   limiter?: ChatRateLimiter, sleep?: Function, log?: Function
 * }} deps
 */
function createAmdEngine(deps) {
  const { store, fetchCandles, notify, langFor } = deps;
  const notifyImage = deps.notifyImage || null;
  const renderChart = deps.renderChart || null;
  const isUnsupported = deps.isUnsupported || (() => false);
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: HA.MAX_MSG_PER_CHAT_HOUR });

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
      const key = amdKey(sub.chat, userJid, coin, tf, ev.stage, ev.dir, X.t);
      if (store.wasSent(key)) continue;
      const plan = computePlan(ev, { rr: sub.rr, sl: sub.sl, tp: sub.tp });
      out.events.push({ ...base, ...ev, candleT: X.t, key, plan, closed });
    }
    return out;
  }

  const commitAll = (events) => store.markSent(events.map((e) => e.key));

  /** Chart satu kejadian; null kalau tidak ada renderer atau gagal (kejadian tetap dikirim sebagai teks). */
  async function chartFor(ev) {
    if (!renderChart || !notifyImage) return null;
    try {
      return await renderChart(ev);
    } catch (err) {
      log(`[amdalert] chart ${ev.coin} ${ev.tf} gagal, kirim teks saja:`, err.message);
      return null;
    }
  }

  /**
   * SL/TP nominal + konfirmasi -> daftarkan posisi supaya dipantau positionEngine (peringatan mendekati / kena TP atau SL, seperti !posisi).
   * Entry = close konfirmasi. Dedupe di store.addPosition ("exists" saat kirim ulang) mencegah posisi ganda.
   * @returns {true|"full"|null} null = tidak berlaku (bukan konfirmasi / tanpa level nominal yang valid)
   */
  function registerPosition(ev) {
    if (ev.stage !== "confirm" || !ev.plan || !ev.plan.custom || typeof store.addPosition !== "function") return null;
    const p = ev.plan;
    const added = store.addPosition(ev.userJid, { chat: ev.chat, coin: ev.coin, tf: ev.tf, dir: ev.dir === "up" ? "long" : "short", entry: p.entry, sl: p.sl, sl0: p.sl, tp1: p.tps[0], source: "amd" });
    return added === "full" || added === "chatFull" ? "full" : true;
  }

  /** Kirim satu kejadian: gambar chart + caption (atau teks saja kalau chart tidak ada / gagal terkirim). */
  async function sendEvent(chat, userJid, ev, lang, ms) {
    ev.monitored = registerPosition(ev);
    const caption = buildAmdCaption(lang, ev, { ms });
    const png = await chartFor(ev);
    if (png && (await notifyImage(chat, userJid, png, caption))) return true;
    if (png) log(`[amdalert] gambar ${ev.coin} ${ev.tf} gagal terkirim, coba kirim teks`);
    return notify(chat, userJid, caption);
  }

  /** Satu pesan per kejadian (gambar + caption). Kejadian yang jatah pesannya habis ditunda ke putaran berikutnya. */
  async function deliverEvents(chat, userJid, events, lang, ms, res) {
    const sorted = sortEvents(events);
    for (let i = 0; i < sorted.length; i++) {
      if (limiter.remaining(chat) < 1) {
        res.deferred += sorted.length - i;
        break;
      }
      const ok = await sendEvent(chat, userJid, sorted[i], lang, ms);
      if (!ok) {
        res.failed++;
        break;
      }
      limiter.record(chat);
      res.sent++;
      commitAll([sorted[i]]);
      if (HA.SEND_GAP_MS && i < sorted.length - 1) await sleep(HA.SEND_GAP_MS);
    }
  }

  /** Kirim kejadian satu penerima. @returns {{sent:number, failed:number, deferred:number}} */
  async function deliver(chat, userJid, events, { ms }) {
    const lang = langFor(chat, userJid);
    const res = { sent: 0, failed: 0, deferred: 0 };
    await deliverEvents(chat, userJid, events, lang, ms, res);
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
        log("[amdalert] gagal mengirim:", err.message);
        totals.failed++;
        continue;
      }
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    return totals;
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allAmdAlerts();
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
    log(`[amdalert] pasangan=${chosen.length}/${byPair.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed + failures} ditunda_batas_jam=${totals.deferred} total=${Date.now() - startedAt}ms`);
  }

  return { tick, evaluate, deliver, _state: { lastRun, limiter } };
}

module.exports = { createAmdEngine };
