"use strict";

/**
 * features/kripto/dusdtAlertEngine.js
 * ------------------------------------------------------------------
 * Mesin alarm USDT.D masuk golden zone (!alertdusdt). Semua ketergantungan (store, ambil data USDT.D, kirim pesan,
 * render chart, bahasa) disuntik lewat createDusdtEngine(), jadi seluruh alur bisa diuji dengan data palsu tanpa
 * jaringan. alertMonitor.js membuat satu engine dan memanggil tick() tiap DUSDT_ALERT_CONFIG.CHECK_MS.
 *
 * Tiap timeframe yang dipantau diambil ulang paling cepat tiap INTERVAL_MS (satu kali per timeframe, berapa pun
 * jumlah pelanggannya). Level USDT.D yang dinilai adalah nilai terkini (sama dengan !dusdt), zonanya dari swing
 * Fibonacci candle closed USDT.D. Aturan "masuk" ada di dusdtAlertCore.js (stepZone).
 *
 * Aturan pengiriman: status inZone sebuah alarm baru berubah jadi "di dalam" SETELAH pesan berhasil terkirim,
 * jadi pengiriman yang gagal / tertunda (batas pesan per jam) dicoba lagi di putaran berikutnya.
 * Status lain (keluar zona, swing berganti) langsung dicatat dan disimpan lewat store.persist().
 */

const { DUSDT_ALERT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { ChatRateLimiter } = require("./divAlertCore");
const { depthOf, goldenZone, swingKey, stepZone, buildDusdtAlertText } = require("./dusdtAlertCore");

/**
 * @param {{
 *   store: object,   // cryptoStore (allDusdtAlerts, persist)
 *   getDusdt: (tf:string) => Promise<object|null>,   // dusdt.js getDusdt: { level, fib, candles, stale, ... }
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   notifyImage?: (chat:string, userJid:string, png:Buffer, caption:string) => Promise<boolean>,
 *   renderChart?: (result:object) => Buffer|null,    // chart USDT.D lengkap dengan golden zone (opsional)
 *   langFor: (chat:string, userJid:string) => string,
 *   limiter?: ChatRateLimiter, log?: Function
 * }} deps
 */
function createDusdtEngine(deps) {
  const { store, getDusdt, notify, langFor } = deps;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: CFG.MAX_MSG_PER_CHAT_HOUR });
  const lastRun = new Map(); // tf -> ms pengambilan terakhir

  /**
   * Nilai satu alarm terhadap hasil getDusdt(tf). Tidak mengirim apa pun.
   * Status "keluar zona" / "swing berganti" langsung dicatat di sub; status "masuk" baru dicatat lewat event.commit().
   * @returns {{event:object|null, changed:boolean}}
   */
  function evaluate(entry, result) {
    const { userJid, sub } = entry;
    const out = { event: null, changed: false };
    if (!result || result.stale || !result.fib) return out; // tidak ada swing / data penyedia basi -> jangan ubah status
    const depth = depthOf(result.fib, result.level);
    if (depth == null) return out;

    const swing = swingKey(result.fib, result.candles);
    const step = stepZone({ prevInZone: sub.inZone, prevSwing: sub.swing, depth, swing });
    if (step.entered) {
      out.event = {
        chat: sub.chat,
        userJid,
        tf: sub.tf,
        subId: sub.id,
        level: result.level,
        depth,
        fib: result.fib,
        zone: goldenZone(result.fib),
        result,
        commit: () => {
          sub.inZone = true;
          sub.swing = swing;
        },
      };
      return out;
    }
    if (sub.inZone !== step.inZone || sub.swing !== step.swing) {
      sub.inZone = step.inZone;
      sub.swing = step.swing;
      out.changed = true;
    }
    return out;
  }

  /** Kirim satu kejadian. @returns {"sent"|"failed"|"deferred"} */
  async function deliver(ev, { ms, pngCache }) {
    if (limiter.remaining(ev.chat) < 1) return "deferred";
    const lang = langFor(ev.chat, ev.userJid);
    const text = buildDusdtAlertText(lang, ev, { ms });

    let png = null;
    if (deps.renderChart && deps.notifyImage) {
      if (!pngCache.has(ev.tf)) {
        try {
          pngCache.set(ev.tf, deps.renderChart(ev.result) || null);
        } catch (err) {
          log("[dusdtalert] render chart gagal:", err.message);
          pngCache.set(ev.tf, null);
        }
      }
      png = pngCache.get(ev.tf);
    }

    let ok = false;
    try {
      ok = png ? await deps.notifyImage(ev.chat, ev.userJid, png, text) : await notify(ev.chat, ev.userJid, text);
    } catch (err) {
      log("[dusdtalert] gagal mengirim:", err.message);
    }
    if (!ok) return "failed";
    limiter.record(ev.chat);
    ev.commit();
    return "sent";
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allDusdtAlerts();
    if (!all.length) {
      lastRun.clear();
      return;
    }
    const byTf = new Map(); // tf -> entries
    for (const e of all) {
      if (!byTf.has(e.sub.tf)) byTf.set(e.sub.tf, []);
      byTf.get(e.sub.tf).push(e);
    }
    for (const tf of lastRun.keys()) if (!byTf.has(tf)) lastRun.delete(tf);

    const startedAt = Date.now();
    const events = [];
    let changed = false;
    let fetched = 0;
    let unavailable = 0;
    for (const [tf, entries] of byTf) {
      if (now - (lastRun.get(tf) || 0) < CFG.INTERVAL_MS) continue;
      lastRun.set(tf, now); // dicatat saat mencoba: gagal pun baru dicoba lagi setelah interval (tidak menghantam API)
      fetched++;
      let result = null;
      try {
        result = await getDusdt(tf);
      } catch (err) {
        log("[dusdtalert] ambil data gagal:", err.message);
      }
      if (!result) {
        unavailable++;
        continue;
      }
      for (const e of entries) {
        const r = evaluate(e, result);
        if (r.event) events.push(r.event);
        if (r.changed) changed = true;
      }
    }

    const totals = { sent: 0, failed: 0, deferred: 0 };
    const pngCache = new Map();
    for (const ev of events) totals[await deliver(ev, { ms: now, pngCache })]++;

    if (changed || totals.sent) store.persist();
    if (fetched) {
      log(`[dusdtalert] tf=${fetched}/${byTf.size} kejadian=${events.length} pesan=${totals.sent} gagal=${totals.failed} ditunda_batas_jam=${totals.deferred} data_kosong=${unavailable} total=${Date.now() - startedAt}ms`);
    }
  }

  return { tick, evaluate, deliver, _state: { lastRun, limiter } };
}

module.exports = { createDusdtEngine };
