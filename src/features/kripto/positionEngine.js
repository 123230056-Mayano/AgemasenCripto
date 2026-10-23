"use strict";

/**
 * features/kripto/positionEngine.js
 * ------------------------------------------------------------------
 * Mesin peringatan posisi (!posisi): memanggil suddenMove.assessPosition untuk tiap posisi aktif dan mengirim
 * WASPADA / CUT / time stop / saran break-even lewat formatPositionAlert. Semua ketergantungan (store, harga,
 * candle, kirim pesan, bahasa) disuntik lewat createPositionEngine(), jadi seluruh alur bisa diuji tanpa jaringan.
 * alertMonitor.js membuat satu engine dan memanggil tick() tiap POSITION_CONFIG.CHECK_MS.
 *
 * Tiap putaran:
 *   1. satu permintaan harga batch untuk semua koin yang punya posisi (fetchPrices); tiap harga disimpan sebagai sampel
 *      (buffer per koin) untuk rapidMove (gerak cepat dalam SUDDEN_CONFIG.RAPID_MINUTES);
 *   2. candle closed per koin+TF diambil ulang paling cepat tiap INTERVAL_MS (cache), ATR dan level dihitung dari situ;
 *   3. tiap posisi dinilai, aturan kirim diterapkan, pesan dikirim.
 *
 * Aturan kirim (anti-spam):
 *   - INFO tidak dikirim.
 *   - WASPADA paling banyak sekali per candle TF per posisi (pos.lastWarnCandle); tidak dikirim lagi setelah CUT.
 *   - CUT sekali per posisi (pos.cutAt); direset saat SL digeser lewat !posisi sl. CUT tidak ikut terhenti oleh batas
 *     pesan per jam (kejadian paling penting), tetapi tetap dihitung di limiter.
 *   - Time stop dan saran break-even sekali per posisi (pos.timeStopAt / pos.beAt).
 *   - Status dicatat HANYA setelah pesan berhasil terkirim; pesan yang tertunda/gagal dicoba lagi di putaran berikutnya.
 *   - Posisi TIDAK dihapus otomatis saat CUT. Bot hanya mengirim pesan.
 *
 * Batas: harga di-polling tiap CHECK_MS, jadi spike yang selesai dalam hitungan detik bisa terlewat (tanpa WebSocket).
 */

const { POSITION_CONFIG: POS, SUDDEN_CONFIG } = require("../../config/indicatorConfig");
const { TF_MS, TF_LABEL, ChatRateLimiter } = require("./divAlertCore");
const { runPool } = require("./advAlertEngine");
const { assessPosition, rapidMove, LEVEL } = require("./suddenMove");
const { formatPositionAlert } = require("./suddenMoveText");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   store: object,   // cryptoStore (allPositions, persist)
 *   fetchPrices: (coins:string[]) => Promise<Map<string, number>>,
 *   fetchCandles: (coin:string, tf:string) => Promise<object[]>,   // candle closed
 *   notify: (chat:string, userJid:string, text:string) => Promise<boolean>,
 *   langFor: (chat:string, userJid:string) => string,
 *   atrSeries?: Function, computeLevels?: Function,
 *   isUnsupported?: (err:Error) => boolean,
 *   limiter?: ChatRateLimiter, sleep?: Function, log?: Function
 * }} deps
 */
function createPositionEngine(deps) {
  const { store, fetchPrices, fetchCandles, notify, langFor } = deps;
  const isUnsupported = deps.isUnsupported || (() => false);
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || ((...a) => console.log(...a));
  const limiter = deps.limiter || new ChatRateLimiter({ max: POS.MAX_MSG_PER_CHAT_HOUR });
  const atrOf = deps.atrSeries || ((c) => require("./indicators").atr(c));
  const levelsOf = deps.computeLevels || ((c, p) => require("./market").computeLevels(c, p));

  const samples = new Map(); // koin -> [{t, price}] urut lama -> baru
  const candleCache = new Map(); // "COIN|TF" -> { at, candles, atrAll, failed }

  /** Simpan sampel harga; buang yang lebih tua dari 2x jendela gerak cepat dan batasi jumlahnya. */
  function recordSample(coin, price, now) {
    if (!Number.isFinite(price)) return;
    const keepFrom = now - 2 * SUDDEN_CONFIG.RAPID_MINUTES * 60_000;
    const arr = (samples.get(coin) || []).filter((s) => s.t >= keepFrom);
    arr.push({ t: now, price });
    samples.set(coin, arr.slice(-POS.SAMPLE_MAX));
  }

  /**
   * Nilai satu posisi dan tentukan apa yang perlu dikirim. Tidak mengirim dan tidak mengubah posisi.
   * @param {{userJid:string, pos:object}} item
   * @param {{price:number, candles:object[]|null, atrAll:(number|null)[]|null, levels:object, now:number}} ctx
   * @returns {{text:string, patch:object, isCut:boolean, assessment:object}|null} null = tidak ada yang dikirim
   */
  function evaluate(item, ctx) {
    const { userJid, pos } = item;
    const { price, candles, atrAll, levels, now } = ctx;
    const tfMs = TF_MS[pos.tf];
    const atr = atrAll?.at(-1);
    if (!tfMs || !Number.isFinite(price) || !(atr > 0)) return null;

    // Candle closed terakhir yang masih sebelum posisi dibuka tidak boleh memicu CUT (mis. close di bawah SL sebelum entri).
    const last = candles?.at(-1);
    const usable = !!last && last.t + tfMs > pos.openedAt;
    const candlesSince = Math.floor((now - pos.openedAt) / tfMs);
    const rapid = rapidMove(samples.get(pos.coin), atr, now);

    const a = assessPosition({
      dir: pos.dir,
      entry: pos.entry,
      sl: pos.sl,
      price,
      atr,
      candles: usable ? candles : [],
      atrSeries: usable ? atrAll : undefined,
      levels,
      candlesSince,
      rapid,
    });

    // --- aturan kirim ---
    const candleId = Math.floor(now / tfMs) * tfMs;
    const out = { ...a, reasons: [...a.reasons] };
    const patch = {};
    let isCut = false;
    if (a.level === LEVEL.CUT) {
      if (!pos.cutAt) {
        isCut = true;
        Object.assign(patch, { cutAt: now, lastLevel: LEVEL.CUT, lastAlertAt: now });
      } else {
        out.level = LEVEL.INFO;
        out.reasons = [];
      }
    } else if (a.level === LEVEL.WASPADA) {
      if (!pos.cutAt && pos.lastWarnCandle !== candleId) Object.assign(patch, { lastWarnCandle: candleId, lastLevel: LEVEL.WASPADA, lastAlertAt: now });
      else {
        out.level = LEVEL.INFO;
        out.reasons = [];
      }
    }
    if (a.timeStop && !pos.timeStopAt) Object.assign(patch, { timeStopAt: now });
    else out.timeStop = false;
    if (a.moveToBreakEven && !pos.beAt && !pos.cutAt) Object.assign(patch, { beAt: now });
    else out.moveToBreakEven = false;

    const text = formatPositionAlert(
      langFor(pos.chat, userJid),
      { coin: pos.coin, tf: pos.tf, tfLabel: TF_LABEL[pos.tf] || pos.tf, dir: pos.dir, entry: pos.entry, sl: pos.sl, price },
      out,
      { candlesSince },
    );
    if (!text) return null; // INFO tanpa hal baru: tidak dikirim, dan status tidak dicatat
    return { text, patch, isCut, assessment: a };
  }

  /** @returns {"sent"|"deferred"|"failed"} */
  async function deliver(item, result) {
    const { pos, userJid } = item;
    if (!result.isCut && limiter.remaining(pos.chat) < 1) return "deferred";
    let ok = false;
    try {
      ok = await notify(pos.chat, userJid, result.text);
    } catch (err) {
      log("[posisi] gagal mengirim:", err.message);
    }
    if (!ok) return "failed";
    limiter.record(pos.chat);
    Object.assign(pos, result.patch); // dicatat hanya setelah terkirim
    return "sent";
  }

  /** Ambil ulang candle pasangan yang cache-nya sudah lewat INTERVAL_MS. Gagal = cache lama dipakai, dicoba lagi nanti. */
  async function refreshCandles(pairs, now) {
    const stale = pairs.filter((k) => now - (candleCache.get(k)?.at ?? 0) >= POS.INTERVAL_MS).slice(0, POS.MAX_PAIRS);
    let failures = 0;
    await runPool(stale, POS.CONCURRENCY, async (k) => {
      const [coin, tf] = k.split("|");
      const prev = candleCache.get(k);
      candleCache.set(k, { ...(prev || {}), at: now }); // dicatat saat mencoba: gagal pun baru dicoba lagi setelah interval
      try {
        const candles = await fetchCandles(coin, tf);
        candleCache.set(k, { at: now, candles, atrAll: atrOf(candles) });
      } catch (err) {
        if (!isUnsupported(err)) failures++;
      }
    });
    return failures;
  }

  /** Dipanggil berkala oleh alertMonitor. */
  async function tick(now = Date.now()) {
    const all = store.allPositions();
    if (!all.length) {
      samples.clear();
      candleCache.clear();
      return;
    }
    const startedAt = Date.now();
    const coins = [...new Set(all.map((x) => x.pos.coin))];
    let prices;
    try {
      prices = await fetchPrices(coins);
    } catch (err) {
      log("[posisi] gagal ambil harga:", err.message);
      return;
    }
    for (const c of coins) if (prices.has(c)) recordSample(c, prices.get(c), now);
    for (const c of [...samples.keys()]) if (!coins.includes(c)) samples.delete(c);

    const pairs = [...new Set(all.map((x) => `${x.pos.coin}|${x.pos.tf}`))];
    for (const k of [...candleCache.keys()]) if (!pairs.includes(k)) candleCache.delete(k);
    const failures = await refreshCandles(pairs, now);

    const tally = { sent: 0, failed: 0, deferred: 0, evaluated: 0 };
    for (const item of all) {
      const price = prices.get(item.pos.coin);
      const cache = candleCache.get(`${item.pos.coin}|${item.pos.tf}`);
      if (price == null || !cache?.candles) continue;
      let result;
      try {
        const levels = levelsOf(cache.candles, price);
        result = evaluate(item, { price, candles: cache.candles, atrAll: cache.atrAll, levels, now });
      } catch (err) {
        log("[posisi] gagal menilai", item.pos.id, err.message);
        continue;
      }
      tally.evaluated++;
      if (!result) continue;
      const r = await deliver(item, result);
      tally[r]++;
      if (r === "sent" && POS.SEND_GAP_MS) await sleep(POS.SEND_GAP_MS);
    }
    if (tally.sent) store.persist();
    log(`[posisi] posisi=${all.length} dinilai=${tally.evaluated} pesan=${tally.sent} gagal=${tally.failed + failures} ditunda_batas_jam=${tally.deferred} total=${Date.now() - startedAt}ms`);
  }

  return { tick, evaluate, deliver, recordSample, _state: { samples, candleCache, limiter } };
}

module.exports = { createPositionEngine };
