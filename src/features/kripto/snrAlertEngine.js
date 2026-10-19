"use strict";

/**
 * features/kripto/snrAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm titik balik S/R (!alertsnr): reject + tembus, tahap dini + konfirmasi (+ batal).
 * Semua ketergantungan (store, fetch candle, kirim pesan, bahasa, hitung level) disuntik lewat
 * createSnrEngine(), jadi seluruh alur bisa diuji dengan data palsu tanpa jaringan.
 * alertMonitor.js membuat satu engine dan memanggil tick() tiap SNR.CHECK_MS.
 *
 * Satu jalur untuk dua tahap: tiap pasangan koin+TF diambil ulang paling cepat tiap SNR.INTERVAL_MS
 * (candle yang belum closed ikut diambil), lalu dua penilaian:
 *   dini  : candle berjalan vs level dari candle closed sebelumnya. Hanya bila langganan memuat tahap dini.
 *   final : candle closed TERAKHIR vs level dari candle closed sebelum dia (setelah FINAL_DELAY_MS agar data final).
 *           Dinilai ulang tiap putaran selama masih candle closed terakhir; kunci dedupe mencegah kiriman ganda,
 *           dan kiriman yang ditunda (batas pesan per jam) dicoba lagi di putaran berikutnya.
 *   batal : sinyal dini yang sudah terkirim tetapi tidak terpenuhi saat candle closed (state di memori;
 *           setelah restart sinyal dini yang menggantung tidak dibatalkan, hanya tidak ada konfirmasinya).
 *
 * Aturan pengiriman: kejadian dianggap TERKIRIM (kunci dedupe dicatat) hanya setelah pesan berhasil.
 * Evaluasi pertama untuk sebuah koin = baseline: kondisi dini yang sudah ada saat alarm dibuat tidak diumumkan.
 * Konfirmasi hanya untuk candle yang closed SETELAH alarm dibuat.
 */

const { SNR_ALERT_CONFIG: SNR } = require("../../config/indicatorConfig");
const { TF_MS, COIN_WATCHLIST, ChatRateLimiter } = require("./divAlertCore");
const { selectLivePairs } = require("./advAlertCore");
const { runPool } = require("./advAlertEngine");
const { watchedLevels, candleHits, levelId, snrKey, chunk, sortEvents, buildSnrText } = require("./snrAlertCore");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   store: object,   // cryptoStore (allSnrAlerts, getWatch, wasSent, markSent, persist)
 *   fetchCandles: (coin:string, tf:string, opts?:{includeOpen?:boolean}) => Promise<object[]>,
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
  const pending = new Map(); // "user|subId|coin" -> Map("candleT|S1|break" -> {hit info}) sinyal dini yang sudah terkirim

  const resolveCoins = ({ userJid, sub }) => (sub.coin === COIN_WATCHLIST ? store.getWatch(userJid) : [sub.coin]);
  const levelOpts = (sub) => ({ strong: !!sub.strong, computeSnr: deps.computeSnr });

  /** Hapus state koin yang sudah tidak ada di daftar langganan (mis. keluar dari watchlist). @returns {boolean} berubah */
  function pruneState(entry, coins) {
    const { sub, userJid } = entry;
    let changed = false;
    if (sub.state) {
      const keep = new Set(coins);
      for (const k of Object.keys(sub.state)) {
        if (!keep.has(k)) {
          delete sub.state[k];
          changed = true;
        }
      }
    }
    for (const k of [...pending.keys()]) {
      const [u, id, coin] = k.split("|");
      if (u === userJid && id === sub.id && !coins.includes(coin)) pending.delete(k);
    }
    return changed;
  }

  /**
   * Evaluasi satu langganan untuk satu koin. Tidak mengirim apa pun.
   * @param {object[]} candles hasil fetchCandles(..., {includeOpen:true}); tiap candle punya `closed`
   * @returns {{events:object[], baselineKeys:string[], dirty:boolean}}
   */
  function evaluate(entry, coin, candles, now = Date.now()) {
    const { userJid, sub } = entry;
    const tf = sub.tf;
    const tfMs = TF_MS[tf];
    const out = { events: [], baselineKeys: [], dirty: false };
    if (!candles || !candles.length) return out;
    if (!sub.state) sub.state = {};
    const hadState = Object.prototype.hasOwnProperty.call(sub.state, coin);
    if (!hadState) {
      sub.state[coin] = { base: true }; // evaluasi pertama = baseline untuk tahap dini
      out.dirty = true;
    }

    const closed = candles.filter((c) => c.closed !== false);
    const open = candles.find((c) => c.closed === false) || null;
    if (closed.length < SNR.MIN_CANDLES) return out;

    const wantDini = sub.stages.includes("dini");
    const wantFinal = sub.stages.includes("final");
    const wantKind = (type) => sub.kinds.includes(type);
    const base = { chat: sub.chat, userJid, coin, tf, subId: sub.id };
    const pendKey = `${userJid}|${sub.id}|${coin}`;
    const mkKey = (stage, h, candleT) => snrKey(sub.chat, userJid, coin, tf, stage, h.type, h.side, h.rank, candleT);
    const pend = () => {
      if (!pending.has(pendKey)) pending.set(pendKey, new Map());
      return pending.get(pendKey);
    };

    // ---------- konfirmasi (+ batal) : candle closed terakhir ----------
    const X = closed[closed.length - 1];
    const finalReady = X.t + tfMs + SNR.FINAL_DELAY_MS <= now;
    if (finalReady && X.t + tfMs > sub.createdAt) {
      const hits = candleHits(X, watchedLevels(closed.slice(0, -1), levelOpts(sub)), buf);
      const matched = new Set(hits.map((h) => `${levelId(h)}|${h.type}`));
      const mine = pending.get(pendKey);
      if (mine) {
        for (const [pk, info] of [...mine]) {
          const sameCandle = info.candleT === X.t;
          if (!sameCandle || matched.has(`${levelId(info)}|${info.type}`)) {
            if (info.candleT <= X.t) mine.delete(pk); // sudah terkonfirmasi / candle lewat: bersihkan tanpa kabar
            continue;
          }
          const key = mkKey("cancel", info, X.t);
          if (store.wasSent(key)) {
            mine.delete(pk);
            continue;
          }
          out.events.push({
            ...base,
            stage: "cancel",
            type: info.type,
            side: info.side,
            rank: info.rank,
            price: info.price,
            touches: info.touches,
            now: X.c,
            extreme: info.side === "R" ? X.h : X.l,
            candleT: X.t,
            key,
            commit: () => {
              store.markSent([key]);
              mine.delete(pk);
            },
          });
        }
      }
      if (wantFinal) {
        for (const h of hits) {
          if (!wantKind(h.type)) continue;
          const key = mkKey("final", h, X.t);
          if (store.wasSent(key)) continue;
          out.events.push({ ...base, stage: "final", ...h, candleT: X.t, key, commit: () => store.markSent([key]) });
        }
      }
    }

    // ---------- dini : candle berjalan ----------
    if (wantDini && open && closed.length && open.t === closed[closed.length - 1].t + tfMs) {
      const hits = candleHits(open, watchedLevels(closed, levelOpts(sub)), buf);
      for (const h of hits) {
        if (!wantKind(h.type)) continue;
        const key = mkKey("dini", h, open.t);
        if (store.wasSent(key)) continue;
        if (!hadState) {
          out.baselineKeys.push(key); // sudah terjadi sebelum alarm dibuat: bukan kejadian baru
          continue;
        }
        out.events.push({
          ...base,
          stage: "dini",
          ...h,
          candleT: open.t,
          key,
          commit: () => {
            store.markSent([key]);
            pend().set(`${open.t}|${levelId(h)}|${h.type}`, { candleT: open.t, side: h.side, rank: h.rank, price: h.price, touches: h.touches, type: h.type });
          },
        });
      }
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
    let dirty = false;
    for (const e of all) {
      const list = resolveCoins(e);
      if (e.sub.coin === COIN_WATCHLIST && pruneState(e, list)) dirty = true;
      for (const coin of list) {
        const k = `${coin}|${e.sub.tf}`;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push(e);
      }
    }
    for (const k of lastRun.keys()) if (!byPair.has(k)) lastRun.delete(k);
    const liveKeys = new Set(all.map((e) => `${e.userJid}|${e.sub.id}`));
    for (const k of pending.keys()) {
      const [u, id] = k.split("|");
      if (!liveKeys.has(`${u}|${id}`)) pending.delete(k); // langganan sudah dihapus
    }

    const chosen = selectLivePairs([...byPair.keys()], lastRun, now, { intervalMs: SNR.INTERVAL_MS, max: SNR.MAX_PAIRS });
    if (!chosen.length) {
      if (dirty) store.persist();
      return;
    }

    const startedAt = Date.now();
    const events = [];
    const baselineKeys = [];
    let failures = 0;
    await runPool(chosen, SNR.CONCURRENCY, async (pair) => {
      const [coin, tf] = pair.split("|");
      lastRun.set(pair, now); // dicatat saat mencoba: gagal pun baru dicoba lagi setelah interval (tidak menghantam API)
      let candles;
      try {
        candles = await fetchCandles(coin, tf, { includeOpen: true });
      } catch (err) {
        if (!isUnsupported(err)) failures++;
        return;
      }
      for (const e of byPair.get(pair)) {
        const r = evaluate(e, coin, candles, now);
        events.push(...r.events);
        baselineKeys.push(...r.baselineKeys);
        dirty = dirty || r.dirty;
      }
    });
    if (baselineKeys.length) store.markSent(baselineKeys);
    const totals = await deliverAll(events, { ms: now });
    if (dirty || totals.sent) store.persist();
    log(`[snralert] pasangan=${chosen.length}/${byPair.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed + failures} ditunda_batas_jam=${totals.deferred} total=${Date.now() - startedAt}ms`);
  }

  return { tick, evaluate, deliver, _state: { lastRun, pending, limiter } };
}

module.exports = { createSnrEngine };
