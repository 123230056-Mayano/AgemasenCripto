"use strict";

/**
 * features/kripto/mstrutPlanBtCommand.js
 * ------------------------------------------------------------------
 * !mstruct [koin ...] [M15|H1|H4|D1 ...] [bars N] [nocost] [overlap] [nobe]
 *   -> backtest SKENARIO !mstrut (Entry Zone / SL / TP1 / TP2), laporan dikirim sebagai PDF (bukan teks panjang).
 *
 * Logika backtest ada di mstrutPlanBacktest.js (murni); PDF di mstrutPlanBtPdf.js. File ini hanya:
 *   parse argumen -> ambil candle (market.fetchCandlesHistory) -> runPlanBacktest per koin+TF -> buildPlanStatsFile
 *   -> PDF -> kirim dokumen + caption pendek. Padanan WhatsApp dari scripts/backtest-mstrut-plan.js.
 *
 * Perlindungan beban: maksimal 5 koin, total (koin x TF x bars) dibatasi, hanya satu backtest berjalan sekaligus di
 * seluruh bot, hasil di-cache 15 menit, dan tiap job memberi jeda ke event loop (setImmediate) agar koneksi WhatsApp
 * tidak tersendat.
 *
 * Catatan nama: !mstruct dulu alias !mstrut (analisis). Sekarang !mstruct = backtest; analisis tetap lewat
 * !mstrut / !marketstructure / !mstuct.
 */

const { t } = require("../../i18n");
const { fetchCandlesHistory, UnsupportedCoinError } = require("./market");
const { runPlanBacktest, buildPlanStatsFile } = require("./mstrutPlanBacktest");
const { buildMstrutPlanBtPdf } = require("./mstrutPlanBtPdf");

const DEFAULT_COINS = ["BTC", "ETH", "SOL"];
const DEFAULT_TFS = ["1H", "4H"];
const ALLOWED_TFS = ["15M", "1H", "4H", "1D"];
const TF_INPUT = Object.freeze({ M15: "15M", "15M": "15M", H1: "1H", "1H": "1H", H4: "4H", "4H": "4H", D1: "1D", "1D": "1D" });
const LIMITS = Object.freeze({ MAX_COINS: 5, MIN_BARS: 500, MAX_BARS: 5000, DEFAULT_BARS: 3000, MAX_TOTAL_BARS: 30_000 });
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 20;
const CAPTION_MAX = 1000; // batas aman caption dokumen WhatsApp (1024)

const FLAG_NOCOST = new Set(["NOCOST", "TANPABIAYA"]);
const FLAG_OVERLAP = new Set(["OVERLAP", "TUMPANG"]);
const FLAG_NOBE = new Set(["NOBE", "TANPABE"]);
const FLAG_BARS = new Set(["BARS", "CANDLE"]);

const MSTRUCTBT_COMMANDS = {
  mstruct: { re: /^!(?:mstruct|mstructbt|mstrutbt)(?:\s+([\s\S]*))?$/i },
};

/**
 * "btc eth 1h 4h bars 2000 nocost" -> { coins, tfs, bars, sim }. null kalau format salah / melebihi batas
 * (pemanggil lalu mengirim penjelasan cmd.mstruct).
 */
function parseMstructBtArgs(name, raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  const coins = [];
  const tfs = [];
  let bars = LIMITS.DEFAULT_BARS;
  let barsSet = false;
  const sim = { feeBps: 10, slipBps: 5, nonOverlap: true, beAfterTp1: true };
  for (let i = 0; i < tokens.length; i++) {
    const raw1 = tokens[i];
    const up = raw1.toUpperCase();
    const eq = up.match(/^(BARS|CANDLE)=(\d+)$/); // "bars=2000"
    if (eq) {
      if (barsSet) return null;
      bars = Number(eq[2]);
      barsSet = true;
    } else if (FLAG_BARS.has(up)) {
      const n = tokens[i + 1];
      if (barsSet || !/^\d{1,6}$/.test(n || "")) return null;
      bars = Number(n);
      barsSet = true;
      i++;
    } else if (FLAG_NOCOST.has(up)) {
      sim.feeBps = 0;
      sim.slipBps = 0;
    } else if (FLAG_OVERLAP.has(up)) sim.nonOverlap = false;
    else if (FLAG_NOBE.has(up)) sim.beAfterTp1 = false;
    else if (TF_INPUT[up]) {
      if (!tfs.includes(TF_INPUT[up])) tfs.push(TF_INPUT[up]);
    } else {
      const s = up.replace(/[/\-_]/g, "");
      const base = s.length > 4 && s.endsWith("USDT") ? s.slice(0, -4) : s; // "BTCUSDT" -> "BTC"
      if (!/^[A-Z0-9]{1,15}$/.test(base)) return null;
      if (!coins.includes(base)) coins.push(base);
    }
  }
  if (coins.length > LIMITS.MAX_COINS) return null;
  if (bars < LIMITS.MIN_BARS || bars > LIMITS.MAX_BARS) return null;
  const outCoins = coins.length ? coins : DEFAULT_COINS;
  const outTfs = (tfs.length ? tfs : DEFAULT_TFS).filter((x) => ALLOWED_TFS.includes(x));
  if (outCoins.length * outTfs.length * bars > LIMITS.MAX_TOTAL_BARS) return null;
  return { coins: outCoins, tfs: ALLOWED_TFS.filter((x) => outTfs.includes(x)), bars, sim };
}

const tick = () => new Promise((r) => setImmediate(r));

/**
 * Ambil candle + jalankan backtest. fetchHistory bisa diganti (uji tanpa jaringan).
 * Koin yang tidak ada di Binance dilewati (dicatat di `skipped`); kalau SEMUA dilewati, UnsupportedCoinError dilempar.
 * @returns {Promise<{samples: object[], stats: object, skipped: string[], params: object}>}
 */
const deps = { fetchHistory: fetchCandlesHistory }; // bisa diganti saat uji (tanpa jaringan)

async function collectBacktest({ coins, tfs, bars, sim }, { fetchHistory = deps.fetchHistory } = {}) {
  const samples = [];
  const skipped = [];
  const used = [];
  let firstErr = null;
  for (const coin of coins) {
    let ok = false;
    for (const tf of tfs) {
      let candles;
      try {
        candles = await fetchHistory(coin, tf, { bars });
      } catch (err) {
        if (err instanceof UnsupportedCoinError || err?.code === "COIN_UNSUPPORTED") {
          firstErr = firstErr || err;
          break; // koin ini tidak ada: lewati semua TF-nya
        }
        throw err;
      }
      samples.push(...runPlanBacktest(candles, { coin, tf, ...sim }));
      ok = true;
      await tick(); // beri napas ke event loop antar job
    }
    if (ok) used.push(coin);
    else skipped.push(coin);
  }
  if (!used.length) throw firstErr || new Error("MSTRUCT_BT_NO_COIN");
  const params = { ...sim, bars };
  const stats = buildPlanStatsFile(samples, { coins: used, tfs }, params);
  return { samples, stats, skipped, params, coins: used };
}

// ---------- cache hasil (bukan PDF; PDF murah dan tergantung bahasa) ----------
const cache = new Map();
const cacheKey = (a) => JSON.stringify([a.coins, a.tfs, a.bars, a.sim]);
function cacheGet(k, now = Date.now()) {
  const e = cache.get(k);
  if (!e) return null;
  if (now - e.at > CACHE_TTL_MS) {
    cache.delete(k);
    return null;
  }
  return e.value;
}
function cacheSet(k, value, now = Date.now()) {
  cache.set(k, { at: now, value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

let running = false; // satu backtest sekaligus untuk seluruh bot

const TF_NAME = { "15M": "M15", "1H": "H1", "4H": "H4", "1D": "D1" };

function buildCaption(lang, a, stats, skipped) {
  const lines = a.tfs.map((tf) => {
    const g = stats.oos[`${tf}|any`];
    if (!g || !g.nTrades) return t(lang, "mstructbt.line.none", { tf: TF_NAME[tf] });
    return t(lang, "mstructbt.line", {
      tf: TF_NAME[tf],
      verdict: t(lang, `mstructbt.v.${g.verdict}`),
      n: g.nTrades,
      avg: (g.expectancyR > 0 ? "+" : "") + g.expectancyR.toFixed(2),
    });
  });
  let cap = t(lang, "mstructbt.caption", { coins: stats.coins.join(", "), tfs: a.tfs.map((x) => TF_NAME[x]).join(", "), bars: a.bars, lines: lines.join("\n") });
  if (skipped.length) cap += "\n" + t(lang, "mstructbt.skipped", { list: skipped.join(", ") });
  return cap.slice(0, CAPTION_MAX);
}

async function runMstructBacktest(sock, msg, { jid, lang }, args) {
  if (running) {
    await sock.sendMessage(jid, { text: t(lang, "mstructbt.busy") }, { quoted: msg });
    return;
  }
  running = true;
  try {
    const key = cacheKey(args);
    let res = cacheGet(key);
    if (!res) {
      await sock.sendMessage(jid, { text: t(lang, "mstructbt.working", { coins: args.coins.join(", "), tfs: args.tfs.map((x) => TF_NAME[x]).join(", "), bars: args.bars }) }, { quoted: msg });
      res = await collectBacktest(args);
      cacheSet(key, res);
    }
    if (!res.samples.length) {
      await sock.sendMessage(jid, { text: t(lang, "mstructbt.nodata") }, { quoted: msg });
      return;
    }
    const pdf = await buildMstrutPlanBtPdf({ stats: res.stats, samples: res.samples, lang, coins: res.coins, tfs: args.tfs, bars: args.bars, params: res.params, skipped: res.skipped });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const fileName = `MSTRUCT-Backtest-${res.coins.join("-")}-${args.tfs.join("-")}-${stamp}.pdf`.slice(0, 120);
    await sock.sendMessage(
      jid,
      { document: pdf, mimetype: "application/pdf", fileName, caption: buildCaption(lang, args, res.stats, res.skipped) },
      { quoted: msg },
    );
  } finally {
    running = false;
  }
}

const MSTRUCTBT_RUNNERS = { mstruct: runMstructBacktest };

module.exports = {
  MSTRUCTBT_COMMANDS,
  MSTRUCTBT_RUNNERS,
  parseMstructBtArgs,
  collectBacktest,
  runMstructBacktest,
  buildCaption,
  LIMITS,
  _deps: deps,
  _cache: { get: cacheGet, set: cacheSet, clear: () => cache.clear() },
};
