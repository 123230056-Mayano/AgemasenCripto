"use strict";

/**
 * features/kripto/advAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm indikator lanjutan (!alertind, item 10): bias berubah + crossover baru.
 * Semua ketergantungan (store, fetch candle, kirim pesan, bahasa) disuntik lewat createAdvEngine(),
 * jadi seluruh alur (jadwal, dedupe, cooldown, batas pesan) bisa diuji dengan data palsu tanpa jaringan.
 * alertMonitor.js membuat satu engine dan memanggil tick() tiap ADV.CHECK_MS.
 *
 * Dua jalur dalam satu tick:
 *   closed : TF yang punya candle closed baru (jadwal sama dengan alarm divergence, tunggu DELAY_MS agar data final).
 *            Memakai penanda terpisah "adv:<TF>" di store, jadi tidak mengganggu alarm divergence.
 *            TF yang closed bersamaan digabung: tiap penerima mendapat satu pesan (dipecah bila > LINES_PER_MSG baris).
 *   live   : opsi 1 (refresh berkala). Tiap pasangan koin+TF dihitung ulang paling cepat tiap LIVE_INTERVAL_MS,
 *            memakai candle yang BELUM closed, maksimal LIVE_MAX_PAIRS pasangan per putaran (sisanya bergilir).
 *            Perubahan bias harus terlihat LIVE_CONFIRM evaluasi berturut-turut; ada cooldown per penerima+koin+TF.
 *
 * Aturan pengiriman: kejadian baru dianggap TERKIRIM (state bias diperbarui / kunci dedupe dicatat) hanya setelah
 * pesan berhasil. Gagal / ditunda (cooldown, batas pesan per jam) -> tidak ditandai, dicoba lagi di putaran berikutnya.
 */

const { ADV_ALERT_CONFIG: ADV } = require("../../config/indicatorConfig");
const { TF_MS, COIN_WATCHLIST, ChatRateLimiter, dueTfs, lastCandleOpen } = require("./divAlertCore");
const { stepBias, detectNewCrosses, crossKey, CooldownTracker, selectLivePairs, chunk, sortEvents, buildAdvText } = require("./advAlertCore");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Jalankan fn untuk semua item dengan batas konkurensi; error ditangani di dalam fn. */
async function runPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** Skor bias koin dari candle (computeBias item 07, tanpa mood/BTC). null = data kurang. */
function defaultScoreOf(candles) {
  const { buildCoinInputs, computeBias } = require("./bias");
  if (!candles || candles.length < 51) return null;
  const inputs = buildCoinInputs(candles, candles[candles.length - 1].c);
  if (!inputs) return null;
  const r = computeBias(inputs);
  return r.insufficient ? null : r;
}

const defaultEmasOf = (candles) => require("./indicators").computeEmas(candles);

/**
 * @param {{
 *   store: object,                                   // cryptoStore (allAdvAlerts, getWatch, wasSent, markSent, persist, getLastClosedMap, setLastClosed)
 *   fetchCandles: (coin:string, tf:string, opts?:{includeOpen?:boolean}) => Promise<object[]>,
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   langFor: (chat:string, userJid:string) => string,
 *   scoreOf?: (candles:object[]) => ({score:number}|null),
 *   emasOf?: (candles:object[]) => ({series:object}),
 *   isUnsupported?: (err:Error) => boolean,
 *   limiter?: ChatRateLimiter, sleep?: Function, log?: Function
 * }} deps
 */
function createAdvEngine(deps) {
  const { store, fetchCandles, notify, langFor } = deps;
  const scoreOf = deps.scoreOf || defaultScoreOf;
  const emasOf = deps.emasOf || defaultEmasOf;
  const isUnsupported = deps.isUnsupported || (() => false);
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: ADV.MAX_MSG_PER_CHAT_HOUR });

  const cooldown = new CooldownTracker();
  const retry = new Map(); // tf -> { boundary, attempts, nextAt } (hanya jalur closed)
  const livePending = new Map(); // "user|subId|coin" -> { label, n } (konfirmasi bias live, di memori)
  const liveLastRun = new Map(); // "COIN|TF" -> ms hitung terakhir

  const resolveCoins = ({ userJid, sub }) => (sub.coin === COIN_WATCHLIST ? store.getWatch(userJid) : [sub.coin]);
  const cdKey = (ev) => `${ev.chat}|${ev.userJid}|${ev.coin}|${ev.tf}`;

  /** Hapus state koin yang sudah tidak ada di daftar langganan (mis. keluar dari watchlist). @returns {boolean} berubah */
  function pruneState(sub, coins) {
    if (!sub.state) return false;
    const keep = new Set(coins);
    let changed = false;
    for (const k of Object.keys(sub.state)) {
      if (!keep.has(k)) {
        delete sub.state[k];
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Evaluasi satu langganan untuk satu koin. Tidak mengirim apa pun.
   * @returns {{events:object[], baselineKeys:string[], dirty:boolean}}
   */
  function evaluate(entry, coin, candles, { live }) {
    const { userJid, sub } = entry;
    const tf = sub.tf;
    const tfMs = TF_MS[tf];
    const out = { events: [], baselineKeys: [], dirty: false };
    if (!candles || !candles.length) return out;
    if (!sub.state) sub.state = {};
    const hadState = Object.prototype.hasOwnProperty.call(sub.state, coin);
    if (!hadState) {
      sub.state[coin] = { bias: null }; // evaluasi pertama = baseline: bias sekarang dicatat, tidak diumumkan
      out.dirty = true;
    }
    const st = sub.state[coin];
    const base = { chat: sub.chat, userJid, coin, tf, subId: sub.id, live };

    if (sub.types.includes("bias")) {
      const r = scoreOf(candles);
      if (r) {
        const pendKey = `${userJid}|${sub.id}|${coin}`;
        const step = stepBias({ prev: st.bias, score: r.score, pending: livePending.get(pendKey) || null, confirm: live ? ADV.LIVE_CONFIRM : 1 });
        if (step.action === "baseline") {
          st.bias = step.label;
          out.dirty = true;
        } else if (step.action === "wait") {
          livePending.set(pendKey, step.pending);
        } else if (step.action === "none") {
          livePending.delete(pendKey);
        } else if (step.action === "alert") {
          // Konfirmasi tetap dianggap terpenuhi kalau pengiriman ditunda (cooldown / batas pesan).
          livePending.set(pendKey, { label: step.to, n: live ? ADV.LIVE_CONFIRM : 1 });
          out.events.push({
            ...base,
            type: "bias",
            from: step.from,
            to: step.to,
            score: r.score,
            commit: () => {
              st.bias = step.to;
              livePending.delete(pendKey);
              out.dirty = true;
            },
          });
        }
      }
    }

    if (sub.types.includes("cross")) {
      const maxAgo = live ? ADV.CROSS_MAX_BARS_AGO_LIVE : ADV.CROSS_MAX_BARS_AGO_CLOSED;
      const { series } = emasOf(candles);
      for (const c of detectNewCrosses(series, candles, maxAgo)) {
        if (c.crossT + tfMs <= sub.createdAt) continue; // terjadi sebelum alarm dibuat
        const key = crossKey(sub.chat, userJid, coin, tf, c.pair, c.type, c.crossT);
        if (store.wasSent(key)) continue;
        if (live && !hadState) {
          out.baselineKeys.push(key); // mode live: yang sudah ada saat evaluasi pertama bukan kejadian baru
          continue;
        }
        out.events.push({ ...base, type: "cross", pair: c.pair, crossType: c.type, barsAgo: c.barsAgo, crossT: c.crossT, key, commit: () => store.markSent([key]) });
      }
    }
    return out;
  }

  /**
   * Kirim kejadian satu penerima. Cooldown dicek per koin+TF; sisanya dipecah per LINES_PER_MSG baris.
   * @returns {{sent:number, failed:number, held:number, deferred:number}} held = tertahan cooldown, deferred = batas pesan per jam
   */
  async function deliver(chat, userJid, events, { live, ms, now = Date.now() }) {
    const lang = langFor(chat, userJid);
    const gap = live ? ADV.COOLDOWN_LIVE_MS : ADV.COOLDOWN_CLOSED_MS;
    const ready = [];
    let held = 0;
    for (const ev of events) {
      if (cooldown.ready(cdKey(ev), gap, now)) ready.push(ev);
      else held++;
    }
    const res = { sent: 0, failed: 0, held, deferred: 0 };
    const parts = chunk(sortEvents(ready), ADV.LINES_PER_MSG);
    for (let i = 0; i < parts.length; i++) {
      if (limiter.remaining(chat) < 1) {
        res.deferred += parts.slice(i).reduce((n, p) => n + p.length, 0);
        break;
      }
      const ok = await notify(chat, userJid, buildAdvText(lang, parts[i], { live, ms, part: i + 1, parts: parts.length }));
      if (!ok) {
        res.failed++;
        break;
      }
      limiter.record(chat);
      res.sent++;
      for (const ev of parts[i]) {
        ev.commit();
        cooldown.mark(cdKey(ev), now);
      }
      if (ADV.SEND_GAP_MS && i < parts.length - 1) await sleep(ADV.SEND_GAP_MS);
    }
    return res;
  }

  /** Kelompokkan kejadian per penerima (chat + user) lalu kirim. @returns {Promise<{failedTfs:Set<string>, totals:object}>} */
  async function deliverAll(events, { live, ms, now = Date.now() }) {
    const groups = new Map();
    for (const ev of events) {
      const k = `${ev.chat}|${ev.userJid}`;
      if (!groups.has(k)) groups.set(k, { chat: ev.chat, userJid: ev.userJid, events: [] });
      groups.get(k).events.push(ev);
    }
    const failedTfs = new Set();
    const totals = { sent: 0, failed: 0, held: 0, deferred: 0 };
    for (const g of groups.values()) {
      let r;
      try {
        r = await deliver(g.chat, g.userJid, g.events, { live, ms, now });
      } catch (err) {
        log("[advalert] gagal mengirim:", err.message);
        for (const ev of g.events) failedTfs.add(ev.tf);
        totals.failed++;
        continue;
      }
      if (r.failed) for (const ev of g.events) failedTfs.add(ev.tf);
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    return { failedTfs, totals };
  }

  // ---------------------------------------------------------------
  // Jalur closed
  // ---------------------------------------------------------------
  async function collectClosedTf(d, entries) {
    const startedAt = Date.now();
    const mine = entries.filter((e) => e.sub.tf === d.tf);
    const expectedOpen = lastCandleOpen(d.tf, d.boundary);
    const coins = new Set();
    for (const e of mine) for (const c of resolveCoins(e)) coins.add(c);

    const candlesBy = new Map();
    let failures = 0;
    await runPool([...coins], ADV.CONCURRENCY, async (coin) => {
      try {
        const candles = await fetchCandles(coin, d.tf);
        const last = candles[candles.length - 1];
        if (!last || last.t !== expectedOpen) {
          failures++; // candle terbaru belum final / koin berhenti diperdagangkan
          return;
        }
        candlesBy.set(coin, candles);
      } catch (err) {
        if (isUnsupported(err)) return; // koin sudah tidak ada di Binance: dilewati, bukan kegagalan putaran
        failures++;
      }
    });

    const events = [];
    const baselineKeys = [];
    let dirty = false;
    for (const e of mine) {
      const list = resolveCoins(e);
      if (e.sub.coin === COIN_WATCHLIST && pruneState(e.sub, list)) dirty = true;
      for (const coin of list) {
        const r = evaluate(e, coin, candlesBy.get(coin), { live: false });
        events.push(...r.events);
        baselineKeys.push(...r.baselineKeys);
        dirty = dirty || r.dirty;
      }
    }
    return { ...d, tf: d.tf, subs: mine.length, coins: coins.size, fetched: candlesBy.size, failures, events, baselineKeys, dirty, ms: Date.now() - startedAt };
  }

  function finishClosedTf(g, problems, now, tickStartedAt) {
    const { tf, boundary, attempts } = g;
    if (!problems) {
      store.setLastClosed(`adv:${tf}`, boundary);
      retry.delete(tf);
    } else if (attempts + 1 >= ADV.MAX_ATTEMPTS) {
      store.setLastClosed(`adv:${tf}`, boundary); // menyerah; kejadian yang belum terkirim masih bisa muncul di candle berikutnya selama masih "baru"
      retry.delete(tf);
      log(`[advalert] ${tf}: menyerah setelah ${attempts + 1} percobaan (${problems} masalah)`);
    } else {
      retry.set(tf, { boundary, attempts: attempts + 1, nextAt: now + (Date.now() - tickStartedAt) + ADV.RETRY_MS });
    }
  }

  async function runClosed(entries, now) {
    const tfs = [...new Set(entries.map((e) => e.sub.tf))].filter((tf) => TF_MS[tf]);
    const closedMap = store.getLastClosedMap();
    const lastClosed = {};
    for (const tf of tfs) lastClosed[tf] = closedMap[`adv:${tf}`] || 0;
    const due = dueTfs({ tfs, now, lastClosed, retry });
    if (!due.length) return;

    const tickStartedAt = Date.now();
    const gathered = [];
    for (const d of due) {
      try {
        gathered.push(await collectClosedTf(d, entries));
      } catch (err) {
        log(`[advalert] ${d.tf} putaran gagal:`, err.message);
        finishClosedTf({ tf: d.tf, boundary: d.boundary, attempts: d.attempts }, 1, now, tickStartedAt);
      }
    }
    if (!gathered.length) return;

    const baselineKeys = gathered.flatMap((g) => g.baselineKeys);
    if (baselineKeys.length) store.markSent(baselineKeys);
    const closedMs = Math.max(...gathered.map((g) => g.boundary));
    const { failedTfs, totals } = await deliverAll(
      gathered.flatMap((g) => g.events),
      { live: false, ms: closedMs, now },
    );
    // State (baseline / bias terkonfirmasi) disimpan sekali per putaran, bukan per koin.
    if (gathered.some((g) => g.dirty) || totals.sent) store.persist();

    for (const g of gathered) {
      const problems = g.failures + (failedTfs.has(g.tf) ? 1 : 0);
      finishClosedTf(g, problems, now, tickStartedAt);
      log(
        `[advalert] closed ${g.tf} candle=${new Date(g.boundary).toISOString()} langganan=${g.subs} koin=${g.coins}/${g.fetched} ` +
          `kejadian=${g.events.length} masalah=${problems} ambil=${g.ms}ms total=${Date.now() - tickStartedAt}ms`,
      );
    }
    if (totals.held || totals.deferred || totals.failed) {
      log(`[advalert] closed pesan=${totals.sent} gagal=${totals.failed} tertahan_cooldown=${totals.held} ditunda_batas_jam=${totals.deferred}`);
    }
  }

  // ---------------------------------------------------------------
  // Jalur live (opsi 1: refresh berkala, candle belum closed ikut dihitung)
  // ---------------------------------------------------------------
  async function runLive(entries, now) {
    const byPair = new Map(); // "COIN|TF" -> entries
    let pruned = false;
    for (const e of entries) {
      const list = resolveCoins(e);
      if (e.sub.coin === COIN_WATCHLIST && pruneState(e.sub, list)) pruned = true;
      for (const coin of list) {
        const k = `${coin}|${e.sub.tf}`;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push(e);
      }
    }
    for (const k of liveLastRun.keys()) if (!byPair.has(k)) liveLastRun.delete(k);
    cooldown.sweep(Math.max(ADV.COOLDOWN_LIVE_MS, ADV.COOLDOWN_CLOSED_MS) * 2 || 3_600_000, now);

    const chosen = selectLivePairs([...byPair.keys()], liveLastRun, now);
    if (!chosen.length) {
      if (pruned) store.persist();
      return;
    }
    const tickStartedAt = Date.now();
    const events = [];
    const baselineKeys = [];
    let dirty = pruned;
    let failures = 0;
    await runPool(chosen, ADV.CONCURRENCY, async (pair) => {
      const [coin, tf] = pair.split("|");
      liveLastRun.set(pair, now); // dicatat saat mencoba: gagal pun baru dicoba lagi setelah interval (tidak menghantam API)
      let candles;
      try {
        candles = await fetchCandles(coin, tf, { includeOpen: true });
      } catch (err) {
        if (!isUnsupported(err)) failures++;
        return;
      }
      for (const e of byPair.get(pair)) {
        const r = evaluate(e, coin, candles, { live: true });
        events.push(...r.events);
        baselineKeys.push(...r.baselineKeys);
        dirty = dirty || r.dirty;
      }
    });
    if (baselineKeys.length) store.markSent(baselineKeys);
    const { totals } = await deliverAll(events, { live: true, ms: now, now });
    if (dirty || totals.sent) store.persist();
    log(
      `[advalert] live pasangan=${chosen.length}/${byPair.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed + failures} ` +
        `tertahan_cooldown=${totals.held} ditunda_batas_jam=${totals.deferred} total=${Date.now() - tickStartedAt}ms`,
    );
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allAdvAlerts();
    if (!all.length) return;
    const closed = all.filter((x) => x.sub.mode !== "live");
    const live = all.filter((x) => x.sub.mode === "live");
    if (closed.length) await runClosed(closed, now);
    if (live.length) await runLive(live, now);
  }

  return { tick, evaluate, deliver, _state: { retry, livePending, liveLastRun, cooldown, limiter } };
}

module.exports = { createAdvEngine, defaultScoreOf, runPool };
