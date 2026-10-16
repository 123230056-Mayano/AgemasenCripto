"use strict";

/**
 * features/kripto/statistik.js
 * ------------------------------------------------------------------
 * Statistik & scanner pasar (Command Kripto - Bagian 4):
 *   !ringkasan        -> mood pasar, jumlah koin di atas/bawah EMA 200, kondisi BTC
 *   !stat             -> jumlah bullish / bearish / sideways + di atas/bawah EMA 50 & 200
 *   !scan <kondisi> [tf] -> screener koin berdasarkan kondisi teknikal
 *
 * Kondisi !scan: diatas_ema200, dibawah_ema200, dekat_support, dekat_resistance,
 *                golden_cross, death_cross, breakout, breakdown.
 *
 * Timeframe: !ringkasan & !stat memakai default pengguna (!tf, awal 4H);
 * !scan memakai [tf] kalau diisi.
 *
 * Cara kerja: satu "snapshot" per timeframe = candle semua koin yang tersedia
 * (lihat kriptoList.js) diambil dari Binance dengan konkurensi terbatas, lalu
 * tiap koin dihitung SEKALI (EMA, tren, cross, S/R, breakout). Ketiga command
 * membaca snapshot yang sama. Snapshot di-cache 3 menit dan permintaan yang
 * datang bersamaan berbagi satu proses, jadi tidak membebani API Binance.
 * Aturan tren/EMA/level persis sama dengan !tren, !ema, dan !level.
 */

const { t } = require("../../i18n");
const { getAvailableCoins } = require("./kriptoList");
const { getMarketRows } = require("./pasar");
const { computeEmas, classifyTrend, detectCross } = require("./indicators");
const { TIMEFRAMES, TF_LABEL, fetchCandles, computeLevels, fmtUsd, fmtLevel, fmtPct, pctFrom } = require("./market");

const SNAPSHOT_TTL_MS = 3 * 60_000;
const CONCURRENCY = 8; // request candle paralel ke Binance
const MIN_SUCCESS_RATIO = 0.5; // di bawah ini dianggap gagal total (mis. Binance down)
const NEAR_PCT = 2; // "dekat" support/resistance = jarak <= 2%
const BREAK_LOOKBACK = 20; // breakout/breakdown = close menembus high/low 20 candle sebelumnya
const SCAN_MAX = 25;
const MOOD_BULL_PCT = 60; // >= 60% koin di atas EMA 200 -> mood bullish
const MOOD_BEAR_PCT = 40; // <= 40% -> bearish; di antaranya netral

// ---------- kondisi scan ----------
// Nama kanonik (Indonesia, sesuai PDF) + alias Inggris. Dicocokkan setelah normalisasi
// (huruf kecil, spasi/strip -> underscore).
const CONDITIONS = {
  diatas_ema200: { aliases: ["above_ema200", "above_ema_200", "diatas_ema_200", "di_atas_ema200"] },
  dibawah_ema200: { aliases: ["below_ema200", "below_ema_200", "dibawah_ema_200", "di_bawah_ema200"] },
  dekat_support: { aliases: ["near_support"] },
  dekat_resistance: { aliases: ["near_resistance", "dekat_resisten"] },
  golden_cross: { aliases: ["goldencross"] },
  death_cross: { aliases: ["deathcross"] },
  breakout: { aliases: [] },
  breakdown: { aliases: [] },
};

function matchCondition(raw) {
  const key = String(raw).toLowerCase().trim().replace(/[\s-]+/g, "_");
  for (const [name, def] of Object.entries(CONDITIONS)) {
    if (key === name || def.aliases.includes(key)) return name;
  }
  return null;
}

// ---------- analisis satu koin ----------
/**
 * Hitung semua yang dibutuhkan 3 command dari candle closed + harga live.
 * @returns {object|null} null kalau data belum cukup untuk EMA 200.
 */
function analyzeCoin(ticker, name, candles, live) {
  if (!candles || candles.length < 201) return null;
  const { series, latest } = computeEmas(candles);
  if (latest[200] == null) return null;

  const lastClose = candles[candles.length - 1].c;
  const price = live && isFinite(live.price) ? live.price : lastClose;
  const info = classifyTrend(price, latest);
  const { resistance, support } = computeLevels(candles, price);

  // Breakout/breakdown: candle closed terakhir menutup di luar rentang N candle sebelumnya.
  const prev = candles.slice(-1 - BREAK_LOOKBACK, -1);
  const prevHigh = Math.max(...prev.map((c) => c.h));
  const prevLow = Math.min(...prev.map((c) => c.l));

  return {
    ticker,
    name,
    price,
    pct24: live && isFinite(live.pct) ? live.pct : null,
    latest,
    info,
    cross: detectCross(series),
    r1: resistance[0] ?? null,
    s1: support[0] ?? null,
    breakout: lastClose > prevHigh ? { level: prevHigh } : null,
    breakdown: lastClose < prevLow ? { level: prevLow } : null,
  };
}

/** Jalankan fn untuk tiap item dengan batas konkurensi; error per item diabaikan (hasil null). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- snapshot + cache ----------
const snapshots = new Map(); // tf -> { at, data }
const building = new Map(); // tf -> Promise

function hasFreshSnapshot(tf) {
  const hit = snapshots.get(tf);
  return !!hit && Date.now() - hit.at < SNAPSHOT_TTL_MS;
}

/** true kalau snapshot TF ini sudah di cache atau sedang dibangun (dipakai !bias untuk satu pesan "memindai"). */
function isSnapshotWarm(tf) {
  return hasFreshSnapshot(tf) || building.has(tf);
}

/**
 * @returns {Promise<{coins: object[], skipped: number, total: number}>}
 *   coins = hasil analisis koin yang datanya cukup; skipped = koin yang dilewati
 *   (candle < 201 atau gagal diambil).
 */
async function getSnapshot(lang, tf) {
  const hit = snapshots.get(tf);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.data;
  if (building.has(tf)) return building.get(tf);

  const job = (async () => {
    const list = await getAvailableCoins(lang);
    // Harga live + % 24 jam: satu request massal (cache 60 detik di pasar.js).
    let liveMap = new Map();
    try {
      const rows = await getMarketRows(lang, "24H");
      liveMap = new Map(rows.map((r) => [r.ticker, { price: r.price, pct: r.pct }]));
    } catch {
      /* tanpa harga live: pakai close candle terakhir */
    }

    const results = await mapLimit(list, CONCURRENCY, async (c) => {
      const candles = await fetchCandles(c.ticker, tf);
      return analyzeCoin(c.ticker, c.name, candles, liveMap.get(c.ticker));
    });

    const coins = results.filter(Boolean);
    if (!list.length || coins.length < list.length * MIN_SUCCESS_RATIO) throw new Error("SNAPSHOT_INCOMPLETE");
    const data = { coins, skipped: list.length - coins.length, total: list.length };
    snapshots.set(tf, { at: Date.now(), data });
    return data;
  })().finally(() => building.delete(tf));

  building.set(tf, job);
  return job;
}

// ---------- hitung statistik ----------
function computeStats(coins) {
  const s = {
    n: coins.length,
    bullish: 0,
    bearish: 0,
    sideways: 0,
    above50: 0,
    below50: 0,
    above200: 0,
    below200: 0,
  };
  for (const c of coins) {
    s[c.info.trend]++;
    if (c.info.pos[50] === true) s.above50++;
    else if (c.info.pos[50] === false) s.below50++;
    if (c.info.pos[200] === true) s.above200++;
    else if (c.info.pos[200] === false) s.below200++;
  }
  return s;
}

/** "bullish" | "bearish" | "neutral" dari persentase koin di atas EMA 200. */
function moodOf(abovePct) {
  if (abovePct >= MOOD_BULL_PCT) return "bullish";
  if (abovePct <= MOOD_BEAR_PCT) return "bearish";
  return "neutral";
}
const MOOD_ICON = { bullish: "🟢", bearish: "🔴", neutral: "🟡" };
const TREND_ICON = { bullish: "🟢", bearish: "🔴", sideways: "🟡" };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function skippedNote(lang, snap) {
  return snap.skipped > 0 ? "\n" + t(lang, "stat.skipped", { n: snap.skipped }) : "";
}

/** Pesan "sedang memindai" hanya kalau snapshot belum ada di cache (prosesnya bisa belasan detik). */
async function ensureSnapshot(sock, msg, { jid, lang }, tf) {
  if (!hasFreshSnapshot(tf) && !building.has(tf)) {
    await sock.sendMessage(jid, { text: t(lang, "stat.scanning", { tf: TF_LABEL[tf] }) }, { quoted: msg });
  }
  return getSnapshot(lang, tf);
}

// ---------- !ringkasan ----------
async function runRingkasan(sock, msg, ctx, { tf }) {
  const { jid, lang } = ctx;
  const snap = await ensureSnapshot(sock, msg, ctx, tf);
  const s = computeStats(snap.coins);
  const abovePct = (s.above200 / s.n) * 100;
  const mood = moodOf(abovePct);

  const btc = snap.coins.find((c) => c.ticker === "BTC");
  let btcLine;
  if (btc) {
    const vs200 = pctFrom(btc.latest[200], btc.price);
    btcLine = t(lang, "stat.ringkasan.btc", {
      price: fmtUsd(btc.price),
      icon: TREND_ICON[btc.info.trend],
      trend: cap(btc.info.trend),
      pos: t(lang, btc.info.pos[200] ? "stat.ringkasan.above" : "stat.ringkasan.below"),
      pct: fmtPct(vs200),
      change: btc.pct24 == null ? "-" : fmtPct(btc.pct24),
    });
  } else {
    btcLine = t(lang, "stat.ringkasan.btcNone");
  }

  await sock.sendMessage(
    jid,
    {
      text: t(lang, "stat.ringkasan.body", {
        tf: TF_LABEL[tf],
        icon: MOOD_ICON[mood],
        mood: t(lang, `stat.mood.${mood}`),
        above: s.above200,
        total: s.n,
        pct: abovePct.toFixed(0),
        btc: btcLine,
        note: skippedNote(lang, snap),
      }),
    },
    { quoted: msg },
  );
}

// ---------- !stat ----------
async function runStat(sock, msg, ctx, { tf }) {
  const { jid, lang } = ctx;
  const snap = await ensureSnapshot(sock, msg, ctx, tf);
  const s = computeStats(snap.coins);
  await sock.sendMessage(
    jid,
    {
      text: t(lang, "stat.stat.body", {
        tf: TF_LABEL[tf],
        total: s.n,
        bullish: s.bullish,
        bearish: s.bearish,
        sideways: s.sideways,
        a50: s.above50,
        b50: s.below50,
        a200: s.above200,
        b200: s.below200,
        note: skippedNote(lang, snap),
      }),
    },
    { quoted: msg },
  );
}

// ---------- !scan ----------
/**
 * Filter + urutkan koin untuk satu kondisi.
 * @returns {Array<{coin: object, detail: string, sortKey: number}>}
 */
function scanCoins(coins, cond, lang) {
  const out = [];
  const push = (coin, detail, sortKey) => out.push({ coin, detail, sortKey });

  for (const c of coins) {
    switch (cond) {
      case "diatas_ema200":
        if (c.info.pos[200] === true) {
          const d = pctFrom(c.latest[200], c.price);
          push(c, `EMA200 ${fmtLevel(c.latest[200])} (${fmtPct(d)})`, d); // terdekat ke EMA dulu = baru menembus
        }
        break;
      case "dibawah_ema200":
        if (c.info.pos[200] === false) {
          const d = pctFrom(c.latest[200], c.price);
          push(c, `EMA200 ${fmtLevel(c.latest[200])} (${fmtPct(d)})`, Math.abs(d));
        }
        break;
      case "dekat_support":
        if (c.s1 != null) {
          const d = pctFrom(c.price, c.s1); // negatif (support di bawah harga)
          if (Math.abs(d) <= NEAR_PCT) push(c, `S1 ${fmtLevel(c.s1)} (${fmtPct(d)})`, Math.abs(d));
        }
        break;
      case "dekat_resistance":
        if (c.r1 != null) {
          const d = pctFrom(c.price, c.r1);
          if (Math.abs(d) <= NEAR_PCT) push(c, `R1 ${fmtLevel(c.r1)} (${fmtPct(d)})`, Math.abs(d));
        }
        break;
      case "golden_cross":
      case "death_cross": {
        const type = cond === "golden_cross" ? "golden" : "death";
        if (c.cross && c.cross.type === type) {
          const ago = c.cross.barsAgo === 0 ? t(lang, "kripto.tren.justNow") : t(lang, "kripto.tren.barsAgo", { n: c.cross.barsAgo });
          push(c, `EMA50/200 (${ago})`, c.cross.barsAgo);
        }
        break;
      }
      case "breakout":
        if (c.breakout) {
          const d = pctFrom(c.breakout.level, c.price);
          push(c, `${t(lang, "stat.scan.above")} ${fmtLevel(c.breakout.level)} (${fmtPct(d)})`, -d); // tembusan paling kuat dulu
        }
        break;
      case "breakdown":
        if (c.breakdown) {
          const d = pctFrom(c.breakdown.level, c.price);
          push(c, `${t(lang, "stat.scan.below")} ${fmtLevel(c.breakdown.level)} (${fmtPct(d)})`, d);
        }
        break;
      default:
        break;
    }
  }
  return out.sort((a, b) => a.sortKey - b.sortKey);
}

async function runScan(sock, msg, ctx, { condition, tf }) {
  const { jid, lang } = ctx;
  const snap = await ensureSnapshot(sock, msg, ctx, tf);
  const hits = scanCoins(snap.coins, condition, lang);
  const label = t(lang, `stat.scan.cond.${condition}`);

  if (!hits.length) {
    await sock.sendMessage(jid, { text: t(lang, "stat.scan.empty", { cond: label, tf: TF_LABEL[tf], total: snap.coins.length }) }, { quoted: msg });
    return;
  }

  const shown = hits.slice(0, SCAN_MAX);
  const rows = shown.map((h, i) => `${i + 1}. *${h.coin.ticker}* ${fmtUsd(h.coin.price)} | ${h.detail}`);
  const more = hits.length > shown.length ? "\n" + t(lang, "stat.scan.more", { n: hits.length - shown.length }) : "";
  await sock.sendMessage(
    jid,
    {
      text: t(lang, "stat.scan.body", {
        cond: label,
        tf: TF_LABEL[tf],
        n: hits.length,
        total: snap.coins.length,
        rows: rows.join("\n") + more,
      }),
    },
    { quoted: msg },
  );
}

// ---------- parsing & registrasi ----------
const STAT_COMMANDS = {
  ringkasan: { re: /^!ringkasan(?:\s+([\s\S]*))?$/i },
  stat: { re: /^!stats?(?:\s+([\s\S]*))?$/i },
  scan: { re: /^!scan(?:\s+([\s\S]*))?$/i },
};

/** @returns {object|null} argumen terurai, atau null kalau format salah (-> tampilkan penjelasan command). */
function parseStatArgs(name, raw, defaultTf) {
  const text = String(raw || "").trim();
  if (name === "ringkasan" || name === "stat") return text ? null : { tf: defaultTf };

  // scan: token timeframe dikenali di mana saja, sisanya digabung jadi nama kondisi
  // ("dekat support 4H" == "dekat_support 4H").
  let tf = null;
  const words = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (TIMEFRAMES[tok.toUpperCase()]) tf = tok.toUpperCase();
    else words.push(tok);
  }
  if (!words.length) return null;
  const condition = matchCondition(words.join("_"));
  if (!condition) return null;
  return { condition, tf: tf || defaultTf };
}

const STAT_RUNNERS = { ringkasan: runRingkasan, stat: runStat, scan: runScan };

module.exports = {
  STAT_COMMANDS,
  STAT_RUNNERS,
  parseStatArgs,
  // dipakai bias.js
  getSnapshot,
  isSnapshotWarm,
  // diekspor untuk pengujian
  matchCondition,
  analyzeCoin,
  computeStats,
  moodOf,
  scanCoins,
};
