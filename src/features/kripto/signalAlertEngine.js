"use strict";

/**
 * features/kripto/signalAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm skenario sinyal (!alertsignal): kirim skenario LONG / SHORT baru (status entri VALID, opsi TUNGGU)
 * saat candle closed. Semua ketergantungan (store, fetch candle, kirim pesan, bahasa, hitung skenario) disuntik
 * lewat createSignalEngine(), jadi seluruh alur bisa diuji dengan data palsu tanpa jaringan.
 * alertMonitor.js membuat satu engine dan memanggil tick() tiap CFG.CHECK_MS.
 *
 * Tiap pasangan koin+TF diambil ulang paling cepat tiap CFG.INTERVAL_MS, lalu candle closed TERAKHIR dinilai
 * (setelah FINAL_DELAY_MS agar data final) dan dibandingkan dengan skenario candle closed sebelumnya.
 * Skenario dihitung sekali per pasangan per candle (cache di memori), dipakai semua langganan yang sama.
 * Dinilai ulang tiap putaran selama masih candle closed terakhir; kunci dedupe mencegah kiriman ganda, dan
 * kiriman yang ditunda (batas pesan per jam) atau gagal dicoba lagi di putaran berikutnya.
 *
 * Aturan pengiriman: kejadian dianggap TERKIRIM (kunci dedupe dicatat) hanya setelah pesan berhasil.
 * Hanya candle yang closed SETELAH alarm dibuat yang diumumkan (skenario yang sudah ada saat alarm dibuat tidak).
 */

const { SIGNAL_ALERT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { TF_MS, COIN_WATCHLIST, ChatRateLimiter } = require("./divAlertCore");
const { selectLivePairs } = require("./advAlertCore");
const { runPool, defaultScoreOf } = require("./advAlertEngine");
const { detectNewSignal, signalKey, chunk, sortEvents, buildSignalText } = require("./signalAlertCore");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Skenario satu TF dari candle closed (sama dengan collectSignal di signal.js, tanpa mood pasar & BTC).
 * Harga acuan = close candle terakhir. null = data kurang.
 * @returns {{bias:object, scenario:object}|null}
 */
function defaultScenarioOf(candles) {
  const { computeScenario } = require("./signal");
  const { computeLevels } = require("./market");
  const { computeEmas, atr } = require("./indicators");
  const bias = defaultScoreOf(candles);
  if (!bias) return null;
  const price = candles[candles.length - 1].c;
  const atrAll = atr(candles);
  const scenario = computeScenario({
    bias,
    price,
    atr: atrAll.at(-1),
    levels: computeLevels(candles, price),
    emas: computeEmas(candles).latest,
    candles,
    atrSeries: atrAll,
  });
  return { bias, scenario };
}

/**
 * @param {{
 *   store: object,   // cryptoStore (allSignalAlerts, getWatch, wasSent, markSent, persist)
 *   fetchCandles: (coin:string, tf:string, opts?:object) => Promise<object[]>,
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   langFor: (chat:string, userJid:string) => string,
 *   scenarioOf?: (candles:object[]) => ({bias:object, scenario:object}|null),
 *   isUnsupported?: (err:Error) => boolean,
 *   limiter?: ChatRateLimiter, sleep?: Function, log?: Function
 * }} deps
 */
function createSignalEngine(deps) {
  const { store, fetchCandles, notify, langFor } = deps;
  const scenarioOf = deps.scenarioOf || defaultScenarioOf;
  const isUnsupported = deps.isUnsupported || (() => false);
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: CFG.MAX_MSG_PER_CHAT_HOUR });

  const lastRun = new Map(); // "COIN|TF" -> ms hitung terakhir
  const cache = new Map(); // "COIN|TF" -> { t, cur, prev } skenario candle closed terakhir (X.t = waktu buka)

  const resolveCoins = ({ userJid, sub }) => (sub.coin === COIN_WATCHLIST ? store.getWatch(userJid) : [sub.coin]);

  /** Skenario candle terakhir (cur) dan sebelumnya (prev), dihitung sekali per pasangan per candle. */
  function scenariosFor(coin, tf, closed) {
    const X = closed[closed.length - 1];
    const k = `${coin}|${tf}`;
    const hit = cache.get(k);
    if (hit && hit.t === X.t) return hit;
    const cur = scenarioOf(closed);
    const prev = scenarioOf(closed.slice(0, -1));
    const entry = { t: X.t, cur: cur?.scenario ?? null, curBias: cur?.bias ?? null, prev: prev?.scenario ?? null };
    cache.set(k, entry);
    return entry;
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
    if (!candles || !candles.length) return out;

    const closed = candles.filter((c) => c.closed !== false);
    if (closed.length < CFG.MIN_CANDLES) return out;

    const X = closed[closed.length - 1];
    const finalReady = X.t + tfMs + CFG.FINAL_DELAY_MS <= now;
    if (!finalReady || X.t + tfMs <= sub.createdAt) return out;

    const sc = scenariosFor(coin, tf, closed);
    const hit = detectNewSignal(sc.cur, sc.prev, sub);
    if (!hit) return out;

    const key = signalKey(sub.chat, userJid, coin, tf, hit.dir, X.t);
    if (store.wasSent(key)) return out;
    // Jeda arah sama: bias yang menempel di ambang bisa memunculkan skenario yang sama berulang kali.
    for (let k = 1; k <= CFG.COOLDOWN_CANDLES; k++) {
      if (store.wasSent(signalKey(sub.chat, userJid, coin, tf, hit.dir, X.t - k * tfMs))) return out;
    }
    out.events.push({
      chat: sub.chat,
      userJid,
      coin,
      tf,
      subId: sub.id,
      dir: hit.dir,
      status: hit.status,
      price: X.c,
      candleT: X.t,
      closeMs: X.t + tfMs,
      row: { tf, bias: sc.curBias, limited: false, scenario: sc.cur },
      key,
      commit: () => store.markSent([key]),
    });
    return out;
  }

  /** Kirim kejadian satu penerima, dipecah per BLOCKS_PER_MSG. @returns {{sent:number, failed:number, deferred:number}} */
  async function deliver(chat, userJid, events) {
    const lang = langFor(chat, userJid);
    const res = { sent: 0, failed: 0, deferred: 0 };
    const parts = chunk(sortEvents(events), CFG.BLOCKS_PER_MSG);
    for (let i = 0; i < parts.length; i++) {
      if (limiter.remaining(chat) < 1) {
        res.deferred += parts.slice(i).reduce((n, p) => n + p.length, 0);
        break;
      }
      const ms = Math.max(...parts[i].map((e) => e.closeMs));
      const ok = await notify(chat, userJid, buildSignalText(lang, parts[i], { ms, part: i + 1, parts: parts.length }));
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
        log("[signalalert] gagal mengirim:", err.message);
        totals.failed++;
        continue;
      }
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    return totals;
  }

  /**
   * Dua langganan satu pemilik di koin+TF+arah+candle yang sama (mis. satu semua arah, satu long saja) menghasilkan
   * kunci yang sama: kirim sekali.
   */
  function mergeEvents(list) {
    const byKey = new Map();
    for (const ev of list) if (!byKey.has(ev.key)) byKey.set(ev.key, ev);
    return [...byKey.values()];
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allSignalAlerts();
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
    for (const k of cache.keys()) if (!byPair.has(k)) cache.delete(k);

    const chosen = selectLivePairs([...byPair.keys()], lastRun, now, { intervalMs: CFG.INTERVAL_MS, max: CFG.MAX_PAIRS });
    if (!chosen.length) return;

    const startedAt = Date.now();
    const rawEvents = [];
    let failures = 0;
    await runPool(chosen, CFG.CONCURRENCY, async (pair) => {
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
        try {
          rawEvents.push(...evaluate(e, coin, candles, now).events);
        } catch (err) {
          failures++;
          log(`[signalalert] gagal menghitung ${pair}:`, err.message);
        }
      }
    });
    const events = mergeEvents(rawEvents);
    const totals = await deliverAll(events);
    if (totals.sent) store.persist();
    log(`[signalalert] pasangan=${chosen.length}/${byPair.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed + failures} ditunda_batas_jam=${totals.deferred} total=${Date.now() - startedAt}ms`);
  }

  return { tick, evaluate, deliver, mergeEvents, _state: { lastRun, cache, limiter } };
}

module.exports = { createSignalEngine, defaultScenarioOf };
