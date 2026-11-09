"use strict";

/**
 * features/kripto/mstructAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm market structure (!alertmstruct): BOS, CHoCH, MSS, sweep BSL / SSL. Hanya KONFIRMASI (candle closed).
 * Semua ketergantungan (store, fetch candle, kirim pesan, bahasa) disuntik lewat createMstructEngine(), jadi seluruh
 * alur bisa diuji dengan data palsu tanpa jaringan. alertMonitor.js membuat satu engine dan memanggil tick()
 * tiap MSTRUCT_ALERT_CONFIG.CHECK_MS.
 *
 * Tiap pasangan koin+TF diambil ulang paling cepat tiap INTERVAL_MS, lalu candle closed TERAKHIR dinilai
 * (setelah FINAL_DELAY_MS agar data final). Dinilai ulang tiap putaran selama masih candle closed terakhir; kunci
 * dedupe mencegah kiriman ganda, dan kiriman yang ditunda (batas pesan per jam) dicoba lagi di putaran berikutnya.
 *
 * Aturan pengiriman: kejadian dianggap TERKIRIM (kunci dedupe dicatat) hanya setelah pesan berhasil.
 * Hanya candle yang closed SETELAH alarm dibuat yang diumumkan (kejadian lama tidak).
 *
 * FOREX: pair (eurusd, xauusd, ...) ikut jalur yang sama; candle Yahoo datang dari fetchCandles yang disuntik.
 */

const { MSTRUCT_ALERT_CONFIG: MA, MSTRUT_CONFIG } = require("../../config/indicatorConfig");
const { TF_MS, COIN_WATCHLIST, ChatRateLimiter } = require("./divAlertCore");
const { selectLivePairs } = require("./advAlertCore");
const { runPool } = require("./advAlertEngine");
const { detectMstruct, filterByKinds, mstructKey, chunk, sortEvents, buildMstructText } = require("./mstructAlertCore");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   store: object,   // cryptoStore (allMstructAlerts, getWatch, wasSent, markSent, persist)
 *   fetchCandles: (coin:string, tf:string, opts?:object) => Promise<object[]>,
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   langFor: (chat:string, userJid:string) => string,
 *   isUnsupported?: (err:Error) => boolean,
 *   limiter?: ChatRateLimiter, sleep?: Function, log?: Function
 * }} deps
 */
function createMstructEngine(deps) {
  const { store, fetchCandles, notify, langFor } = deps;
  const isUnsupported = deps.isUnsupported || (() => false);
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: MA.MAX_MSG_PER_CHAT_HOUR });

  const lastRun = new Map(); // "COIN|TF" -> ms hitung terakhir

  const resolveCoins = ({ userJid, sub }) => (sub.coin === COIN_WATCHLIST ? store.getWatch(userJid) : [sub.coin]);

  /**
   * Evaluasi satu langganan untuk satu koin. Tidak mengirim apa pun.
   * @param {object[]} candles hasil fetchCandles(coin, tf); candle yang belum closed (closed === false) diabaikan
   * @param {object[]|null} [shared] hasil detectMstruct yang sudah dihitung untuk koin+TF ini (hemat hitung antar langganan)
   * @returns {{events:object[]}}
   */
  function evaluate(entry, coin, candles, now = Date.now(), shared = null) {
    const { userJid, sub } = entry;
    const tf = sub.tf;
    const tfMs = TF_MS[tf];
    const out = { events: [] };
    if (!candles || !candles.length || !tfMs) return out;

    const closed = candles.filter((c) => c.closed !== false);
    if (closed.length < MSTRUT_CONFIG.MIN_CANDLES) return out;

    const X = closed[closed.length - 1];
    const finalReady = X.t + tfMs + MA.FINAL_DELAY_MS <= now;
    if (!finalReady || X.t + tfMs <= sub.createdAt) return out;

    const base = { chat: sub.chat, userJid, coin, tf, subId: sub.id };
    const detected = shared || detectMstruct(closed);
    for (const ev of filterByKinds(detected, sub.kinds)) {
      const key = mstructKey(sub.chat, userJid, coin, tf, ev.type, ev.dir || ev.side, X.t);
      if (store.wasSent(key)) continue;
      out.events.push({ ...base, ...ev, candleT: X.t, key, commit: () => store.markSent([key]) });
    }
    return out;
  }

  /** Kirim kejadian satu penerima, dipecah per LINES_PER_MSG baris. @returns {{sent:number, failed:number, deferred:number}} */
  async function deliver(chat, userJid, events, { ms }) {
    const lang = langFor(chat, userJid);
    const res = { sent: 0, failed: 0, deferred: 0 };
    const parts = chunk(sortEvents(events), MA.LINES_PER_MSG);
    for (let i = 0; i < parts.length; i++) {
      if (limiter.remaining(chat) < 1) {
        res.deferred += parts.slice(i).reduce((n, p) => n + p.length, 0);
        break;
      }
      const ok = await notify(chat, userJid, buildMstructText(lang, parts[i], { ms, part: i + 1, parts: parts.length }));
      if (!ok) {
        res.failed++;
        break;
      }
      limiter.record(chat);
      res.sent++;
      for (const ev of parts[i]) ev.commit();
      if (MA.SEND_GAP_MS && i < parts.length - 1) await sleep(MA.SEND_GAP_MS);
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
        log("[mstructalert] gagal mengirim:", err.message);
        totals.failed++;
        continue;
      }
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    return totals;
  }

  /**
   * Dua langganan satu pemilik di chat yang sama bisa cocok dengan kejadian yang sama (mis. satu `mss`, satu `choch`).
   * Kunci yang sama dikirim sekali. Untuk satu penembusan yang berstatus MSS, versi CHoCH-nya digabung ke versi MSS:
   * tidak dikirim sendiri, tetapi kuncinya ikut dicatat saat pesan MSS terkirim, supaya putaran berikutnya tidak
   * mengirimnya lagi sebagai CHoCH.
   */
  function mergeEvents(list) {
    const byKey = new Map();
    for (const ev of list) if (!byKey.has(ev.key)) byKey.set(ev.key, ev);
    const groups = new Map();
    for (const ev of byKey.values()) {
      const g = `${ev.chat}|${ev.userJid}|${ev.coin}|${ev.tf}|${ev.candleT}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(ev);
    }
    const out = [];
    for (const arr of groups.values()) {
      const mssByDir = new Map(arr.filter((e) => e.type === "mss").map((e) => [e.dir, e]));
      for (const e of arr) {
        const host = e.type === "choch" && e.canMss ? mssByDir.get(e.dir) : null;
        if (host) {
          const hostCommit = host.commit;
          host.commit = () => {
            hostCommit();
            e.commit();
          };
          continue;
        }
        out.push(e);
      }
    }
    return out;
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allMstructAlerts();
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

    const chosen = selectLivePairs([...byPair.keys()], lastRun, now, { intervalMs: MA.INTERVAL_MS, max: MA.MAX_PAIRS });
    if (!chosen.length) return;

    const startedAt = Date.now();
    const rawEvents = [];
    let failures = 0;
    await runPool(chosen, MA.CONCURRENCY, async (pair) => {
      const [coin, tf] = pair.split("|");
      lastRun.set(pair, now); // dicatat saat mencoba: gagal pun baru dicoba lagi setelah interval (tidak menghantam API)
      let candles;
      try {
        candles = await fetchCandles(coin, tf);
      } catch (err) {
        if (!isUnsupported(err)) failures++;
        return;
      }
      let shared = null; // analisis struktur dihitung sekali per koin+TF, dipakai semua langganan
      try {
        const closed = (candles || []).filter((c) => c.closed !== false);
        if (closed.length >= MSTRUT_CONFIG.MIN_CANDLES) shared = detectMstruct(closed);
      } catch (err) {
        log(`[mstructalert] gagal menganalisis ${coin} ${tf}:`, err.message);
        return;
      }
      for (const e of byPair.get(pair)) rawEvents.push(...evaluate(e, coin, candles, now, shared).events);
    });
    const events = mergeEvents(rawEvents);
    const totals = await deliverAll(events, { ms: now });
    if (totals.sent) store.persist();
    log(`[mstructalert] pasangan=${chosen.length}/${byPair.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed + failures} ditunda_batas_jam=${totals.deferred} total=${Date.now() - startedAt}ms`);
  }

  return { tick, evaluate, deliver, mergeEvents, _state: { lastRun, limiter } };
}

module.exports = { createMstructEngine };
