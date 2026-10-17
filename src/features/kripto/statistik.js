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
 *                golden_cross, death_cross, breakout, breakdown,
 *                div_bull, div_bear (divergence RSI/MACD, lihat divergence.js).
 * !scandivergent (!scandiv) [tf] [rsi|macd]: TANPA argumen = semua koin, 4 TF, RSI+MACD, reguler+tersembunyi,
 *   bullish+bearish. Hasil dikelompokkan per TF lalu Bullish/Bearish; banyak sinyal = PDF (format sama dengan
 *   alarm !alertdiv, divPdf.js). Token lama bull|bear dan reguler|tersembunyi tetap diterima sebagai filter tambahan.
 *
 * Timeframe: !ringkasan [tf] & !stat [tf] (15m/1H/4H/1D). TANPA argumen = tabel padat
 * keempat TF sekaligus (item 03), dibaca dari snapshot cache yang sama (tanpa beban API baru).
 * !scan memakai [tf] kalau diisi, kalau tidak default pengguna (!tf, awal 4H).
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
const { detectDivergence, DIV } = require("./divergence");
const { buildDivergencePdf } = require("./divPdf");
const { buildSections, chooseReportMode, buildPdfIntro, buildGroupedText, describeFilters, fmtCandleTime } = require("./divAlertCore");
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
  div_bull: { aliases: ["divbull", "div_bullish", "divbullish", "divergence_bull", "divergence_bullish", "bullish_divergence"] },
  div_bear: { aliases: ["divbear", "div_bearish", "divbearish", "divergence_bear", "divergence_bearish", "bearish_divergence"] },
};
const isDivCondition = (cond) => cond === "div_bull" || cond === "div_bear";

// Modifier khusus scan divergence (token terpisah, tidak pernah bagian dari nama kondisi lain).
const DIV_IND_TOKENS = { rsi: "rsi", macd: "macd" };
const DIV_KIND_TOKENS = { reguler: "regular", regular: "regular", reg: "regular", tersembunyi: "hidden", hidden: "hidden", hid: "hidden" };
const DIV_DIR_TOKENS = { bull: "div_bull", bullish: "div_bull", naik: "div_bull", bear: "div_bear", bearish: "div_bear", turun: "div_bear" };

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
    lastCandleT: candles[candles.length - 1].t, // waktu BUKA candle closed terakhir (alarm divergence memastikan data sudah final)
    pct24: live && isFinite(live.pct) ? live.pct : null,
    latest,
    info,
    cross: detectCross(series),
    r1: resistance[0] ?? null,
    s1: support[0] ?? null,
    breakout: lastClose > prevHigh ? { level: prevHigh } : null,
    breakdown: lastClose < prevLow ? { level: prevLow } : null,
    // Divergence RSI/MACD dari candle closed (field terpisah dari field lama). [] kalau tidak ada.
    div: detectDivergence(candles),
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

/**
 * Bangun ulang snapshot TF ini dari awal (abaikan cache 3 menit). Dipakai alarm divergence tepat setelah
 * candle closed, supaya hasilnya memuat candle baru dan bukan snapshot lama. Kalau ada pembangunan yang
 * sedang berjalan, ditunggu dulu (bisa sudah basi) lalu dibangun ulang sekali.
 */
async function refreshSnapshot(lang, tf) {
  if (building.has(tf)) {
    try {
      await building.get(tf);
    } catch {
      /* gagal pun tidak masalah, dibangun ulang di bawah */
    }
  }
  snapshots.delete(tf);
  return getSnapshot(lang, tf);
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

// ---------- !ringkasan & !stat: banyak TF (item 03) ----------
const ALL_TFS = Object.keys(TIMEFRAMES); // 15M, 1H, 4H, 1D (urutan tampil)

/**
 * Ambil snapshot beberapa TF berurutan (konkurensi tetap 8, tidak dikali jumlah TF).
 * TF yang sudah di cache langsung kembali; hanya yang dingin yang memindai ulang.
 * Satu TF gagal tidak menggagalkan yang lain (baris itu tampil "belum tersedia"); semua gagal -> lempar error.
 * @returns {Promise<{tf: string, snap: object|null}[]>}
 */
async function loadSnapshots(sock, msg, { jid, lang }, tfs) {
  const cold = tfs.filter((tf) => !hasFreshSnapshot(tf) && !building.has(tf));
  if (cold.length) {
    await sock.sendMessage(
      jid,
      { text: t(lang, cold.length > 1 ? "stat.scanning.multi" : "stat.scanning", { tf: cold.map((x) => TF_LABEL[x]).join(", ") }) },
      { quoted: msg },
    );
  }
  const out = [];
  let lastErr = null;
  for (const tf of tfs) {
    try {
      out.push({ tf, snap: await getSnapshot(lang, tf) });
    } catch (err) {
      lastErr = err;
      out.push({ tf, snap: null });
    }
  }
  if (out.every((e) => !e.snap)) throw lastErr || new Error("SNAPSHOT_INCOMPLETE");
  return out;
}

/** Catatan "data kurang" per TF: koin yang dilewati (candle < 201 / gagal diambil). "" kalau tidak ada. */
function skippedMultiNote(lang, entries) {
  const parts = entries.filter((e) => e.snap && e.snap.skipped > 0).map((e) => `${TF_LABEL[e.tf]}: ${e.snap.skipped}`);
  return parts.length ? "\n" + t(lang, "stat.skipped.multi", { list: parts.join(" | ") }) : "";
}

const pad = (v, n) => String(v).padStart(n);

/** Teks !ringkasan untuk banyak TF. entries = [{tf, snap|null}]. Murni (tanpa I/O), mudah diuji. */
function buildRingkasanMulti(lang, entries) {
  const rows = [];
  let btcLine = null;
  for (const { tf, snap } of entries) {
    if (!snap) {
      rows.push(t(lang, "stat.ringkasan.rowNone", { tf: TF_LABEL[tf] }));
      continue;
    }
    const s = computeStats(snap.coins);
    const abovePct = s.n ? (s.above200 / s.n) * 100 : 0;
    const mood = moodOf(abovePct);
    const btc = snap.coins.find((c) => c.ticker === "BTC");
    const btcRow = btc
      ? t(lang, "stat.ringkasan.rowBtc", {
          icon: TREND_ICON[btc.info.trend],
          trend: t(lang, `stat.trend.${btc.info.trend}`),
          pct: fmtPct(pctFrom(btc.latest[200], btc.price)),
        })
      : t(lang, "stat.ringkasan.rowBtcNone");
    if (btc && !btcLine) {
      btcLine = t(lang, "stat.ringkasan.btcPrice", { price: fmtUsd(btc.price), change: btc.pct24 == null ? "-" : fmtPct(btc.pct24) });
    }
    rows.push(
      t(lang, "stat.ringkasan.row", {
        icon: MOOD_ICON[mood],
        tf: TF_LABEL[tf],
        mood: t(lang, `stat.mood.${mood}`),
        above: s.above200,
        total: s.n,
        pct: abovePct.toFixed(0),
        btc: btcRow,
      }),
    );
  }
  return t(lang, "stat.ringkasan.multi.body", {
    rows: rows.join("\n"),
    btc: btcLine || t(lang, "stat.ringkasan.btcNone"),
    note: skippedMultiNote(lang, entries),
  });
}

/** Teks !stat untuk banyak TF: dua blok monospace (tren, lalu posisi terhadap EMA). Murni, mudah diuji. */
function buildStatMulti(lang, entries) {
  const trend = [t(lang, "stat.stat.multi.hdrTrend")];
  const ema = [t(lang, "stat.stat.multi.hdrEma")];
  for (const { tf, snap } of entries) {
    const label = TF_LABEL[tf].padEnd(3);
    if (!snap) {
      trend.push(`${label} n/a`);
      ema.push(`${label} n/a`);
      continue;
    }
    const s = computeStats(snap.coins);
    trend.push(`${label} ${pad(s.n, 4)} ${pad(s.bullish, 5)} ${pad(s.bearish, 5)} ${pad(s.sideways, 5)}`);
    ema.push(`${label} ${pad(s.above50, 5)} ${pad(s.below50, 5)} ${pad(s.above200, 5)} ${pad(s.below200, 5)}`);
  }
  return t(lang, "stat.stat.multi.body", {
    trend: trend.join("\n"),
    ema: ema.join("\n"),
    note: skippedMultiNote(lang, entries),
  });
}

// ---------- !ringkasan ----------
async function runRingkasan(sock, msg, ctx, { tf }) {
  const { jid, lang } = ctx;
  if (!tf) {
    const entries = await loadSnapshots(sock, msg, ctx, ALL_TFS);
    await sock.sendMessage(jid, { text: buildRingkasanMulti(lang, entries) }, { quoted: msg });
    return;
  }
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
  if (!tf) {
    const entries = await loadSnapshots(sock, msg, ctx, ALL_TFS);
    await sock.sendMessage(jid, { text: buildStatMulti(lang, entries) }, { quoted: msg });
    return;
  }
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
function scanCoins(coins, cond, lang, opts = {}) {
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
      case "div_bull":
      case "div_bear": {
        const dir = cond === "div_bull" ? "bull" : "bear";
        const inds = opts.indicators && opts.indicators.length ? opts.indicators : ["rsi", "macd"];
        const kinds = opts.kinds && opts.kinds.length ? opts.kinds : ["regular", "hidden"];
        const found = (c.div || []).filter((d) => d.dir === dir && inds.includes(d.indicator) && kinds.includes(d.kind));
        if (found.length) {
          const parts = found.map((d) => {
            const ago = d.barsAgo === 0 ? t(lang, "kripto.tren.justNow") : t(lang, "kripto.tren.barsAgo", { n: d.barsAgo });
            return `${t(lang, `div.kind.${d.kind}`)} ${d.indicator.toUpperCase()} (${ago})`;
          });
          push(c, parts.join(" + "), Math.min(...found.map((d) => d.barsAgo))); // terbaru dulu
        }
        break;
      }
      default:
        break;
    }
  }
  return out.sort((a, b) => a.sortKey - b.sortKey);
}

async function runScanDiv(sock, msg, ctx, { condition, tf, indicators, kinds }, snap) {
  const { jid, lang } = ctx;
  const dir = condition === "div_bull" ? "bull" : "bear";
  const inds = indicators && indicators.length ? indicators : ["rsi", "macd"];
  const filters = [inds.map((i) => i.toUpperCase()).join("/")];
  if (kinds && kinds.length === 1) filters.push(t(lang, `div.kind.${kinds[0]}`));
  const hits = scanCoins(snap.coins, condition, lang, { indicators: inds, kinds });

  if (!hits.length) {
    await sock.sendMessage(
      jid,
      { text: t(lang, "div.scan.empty", { dir: t(lang, `div.dir.${dir}`), filters: filters.join(", "), tf: TF_LABEL[tf], total: snap.coins.length, look: DIV.LOOKBACK }) },
      { quoted: msg },
    );
    return;
  }
  const shown = hits.slice(0, SCAN_MAX);
  const rows = shown.map((h, i) => `${i + 1}. *${h.coin.ticker}* ${fmtUsd(h.coin.price)} | ${h.detail}`);
  const more = hits.length > shown.length ? "\n" + t(lang, "stat.scan.more", { n: hits.length - shown.length }) : "";
  await sock.sendMessage(
    jid,
    {
      text: t(lang, "div.scan.body", {
        dir: dir.toUpperCase(), // "BULL" / "BEAR" sesuai contoh PDF 4.6
        filters: filters.join(", "),
        tf: TF_LABEL[tf],
        n: hits.length,
        total: snap.coins.length,
        rows: rows.join("\n") + more,
        win: DIV.PIVOT_WIN,
      }),
    },
    { quoted: msg },
  );
}

/**
 * !scandivergent (item 05). Semua koin x (satu TF atau keempat TF), dibaca dari snapshot cache yang sama
 * dengan !scan. condition null = dua arah. tf null = keempat TF.
 */
async function runScanDivergent(sock, msg, ctx, { condition, tf, indicators, kinds }) {
  const { jid, lang } = ctx;
  const tfs = tf ? [tf] : ALL_TFS;
  const entries = await loadSnapshots(sock, msg, ctx, tfs);
  const inds = indicators && indicators.length ? indicators : ["rsi", "macd"];
  const kindList = kinds && kinds.length ? kinds : ["regular", "hidden"];
  const dirs = condition ? [condition === "div_bull" ? "bull" : "bear"] : ["bull", "bear"];

  const items = [];
  for (const { tf: key, snap } of entries) {
    if (!snap) continue;
    for (const c of snap.coins) {
      for (const d of c.div || []) {
        if (dirs.includes(d.dir) && inds.includes(d.indicator) && kindList.includes(d.kind)) {
          items.push({ coin: c.ticker, tf: key, indicator: d.indicator, kind: d.kind, dir: d.dir });
        }
      }
    }
  }
  const okTfs = entries.filter((e) => e.snap).map((e) => e.tf);
  const missing = entries.filter((e) => !e.snap).map((e) => TF_LABEL[e.tf]);
  const sections = buildSections(items, okTfs);
  const mode = chooseReportMode(sections);
  const filters = describeFilters(lang, { indicators: inds, dirs: condition ? dirs : [], kinds: kinds || [] });
  const time = fmtCandleTime(lang, Date.now());
  const notes = (missing.length ? "\n" + t(lang, "divreport.scan.missing", { tfs: missing.join(", ") }) : "") + skippedMultiNote(lang, entries);
  const say = (text) => sock.sendMessage(jid, { text }, { quoted: msg });

  if (mode === "none") {
    const total = Math.max(...entries.map((e) => (e.snap ? e.snap.coins.length : 0)));
    await say(t(lang, "divreport.scan.empty", { filters, tfs: okTfs.map((x) => TF_LABEL[x]).join(", "), total, look: DIV.LOOKBACK }) + notes);
    return;
  }
  if (mode === "text") {
    await say(buildGroupedText(lang, sections, { mode: "scan", time, filters }) + notes);
    return;
  }

  // PDF: satu baris pengantar + satu PDF (maksimal 2 pesan, sama dengan alarm).
  const t0 = Date.now();
  let pdf;
  try {
    pdf = await buildDivergencePdf({ sections, mode: "scan", time, lang });
  } catch (err) {
    console.log("[scandiv] gagal membuat PDF, kirim sebagai teks:", err.message);
    await say(buildGroupedText(lang, sections, { mode: "scan", time, filters }) + notes);
    return;
  }
  console.log(`[scandiv] tf=${okTfs.join("+")} sinyal=${items.length} pdf=${Date.now() - t0}ms/${Math.round(pdf.length / 1024)}KB`);
  await say(buildPdfIntro(lang, sections, { mode: "scan", time }) + notes);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  await sock.sendMessage(jid, { document: pdf, mimetype: "application/pdf", fileName: `ScanDivergence-${stamp}UTC.pdf` }, { quoted: msg });
}

async function runScan(sock, msg, ctx, { condition, tf, indicators, kinds }) {
  const { jid, lang } = ctx;
  const snap = await ensureSnapshot(sock, msg, ctx, tf);
  if (isDivCondition(condition)) return runScanDiv(sock, msg, ctx, { condition, tf, indicators, kinds }, snap);
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
  // alias khusus divergence: !scandivergent / !scandivergence / !scandiv
  scandivergent: { re: /^!scandiv(?:ergent|ergence)?(?:\s+([\s\S]*))?$/i },
};

/** @returns {object|null} argumen terurai, atau null kalau format salah (-> tampilkan penjelasan command). */
function parseStatArgs(name, raw, defaultTf) {
  const text = String(raw || "").trim();
  // !ringkasan / !stat: tanpa argumen = semua TF (tf: null); satu token TF = hanya TF itu; selain itu -> penjelasan command.
  if (name === "ringkasan" || name === "stat") {
    if (!text) return { tf: null };
    const key = text.toUpperCase();
    return TIMEFRAMES[key] ? { tf: key } : null;
  }

  // !scandivergent [tf] [rsi|macd]  (tanpa argumen = semua koin, 4 TF, RSI+MACD, dua arah, dua jenis).
  // Token bull|bear dan reguler|tersembunyi tetap diterima sebagai filter tambahan (kompatibel dengan versi lama).
  if (name === "scandivergent") {
    let tf = null;
    let condition = null;
    const inds = [];
    const kinds = [];
    const dirs = new Set();
    for (const tok of text.split(/\s+/).filter(Boolean)) {
      const low = tok.toLowerCase();
      if (TIMEFRAMES[tok.toUpperCase()]) tf = tok.toUpperCase();
      else if (DIV_DIR_TOKENS[low]) dirs.add(DIV_DIR_TOKENS[low]);
      else if (DIV_IND_TOKENS[low]) inds.push(DIV_IND_TOKENS[low]);
      else if (DIV_KIND_TOKENS[low]) kinds.push(DIV_KIND_TOKENS[low]);
      else return null; // token tidak dikenal -> tampilkan penjelasan command
    }
    if (dirs.size === 1) condition = [...dirs][0]; // dua arah sekaligus = semua arah
    return { condition, tf, indicators: [...new Set(inds)], kinds: [...new Set(kinds)] };
  }

  // scan: token timeframe dikenali di mana saja, sisanya digabung jadi nama kondisi
  // ("dekat support 4H" == "dekat_support 4H"). Modifier divergence (rsi/macd/reguler/tersembunyi)
  // dipisah dulu dan hanya sah untuk div_bull / div_bear.
  let tf = null;
  const words = [];
  const inds = [];
  const kinds = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    const low = tok.toLowerCase();
    if (TIMEFRAMES[tok.toUpperCase()]) tf = tok.toUpperCase();
    else if (DIV_IND_TOKENS[low]) inds.push(DIV_IND_TOKENS[low]);
    else if (DIV_KIND_TOKENS[low]) kinds.push(DIV_KIND_TOKENS[low]);
    else words.push(tok);
  }
  if (!words.length) return null;
  const condition = matchCondition(words.join("_"));
  if (!condition) return null;
  if (!isDivCondition(condition) && (inds.length || kinds.length)) return null;
  const res = { condition, tf: tf || defaultTf };
  if (isDivCondition(condition)) {
    res.indicators = [...new Set(inds)];
    res.kinds = [...new Set(kinds)];
  }
  return res;
}

// !scandivergent punya runner sendiri (semua TF, Bullish+Bearish, PDF); !scan div_bull|div_bear tetap lewat runScan.
const STAT_RUNNERS = { ringkasan: runRingkasan, stat: runStat, scan: runScan, scandivergent: runScanDivergent };

module.exports = {
  STAT_COMMANDS,
  STAT_RUNNERS,
  parseStatArgs,
  // dipakai bias.js
  getSnapshot,
  refreshSnapshot,
  isSnapshotWarm,
  CONCURRENCY,
  // diekspor untuk pengujian
  matchCondition,
  buildRingkasanMulti,
  buildStatMulti,
  analyzeCoin,
  computeStats,
  moodOf,
  scanCoins,
  runScanDiv,
  runScanDivergent,
};
