"use strict";

/**
 * features/kripto/signalAll.js
 * ------------------------------------------------------------------
 *   !signal all            -> SEMUA koin x SEMUA timeframe (15m, 1H, 4H, 1D)
 *   !signal all 4h         -> semua koin, hanya timeframe yang dipilih
 *   !signal all 1h 4h      -> semua koin, beberapa timeframe pilihan
 *   (urutan bebas: "!signal 4h all" sama saja)
 *
 * Hasil: satu blok per timeframe. Tiap blok berisi
 *   - ringkasan jumlah VALID / TUNGGU / HINDARI / SIDEWAYS,
 *   - TABEL skenario yang VALID (arah, entry, SL, TP1, RR),
 *   - daftar singkat koin TUNGGU, HINDARI, SIDEWAYS, dan data kurang.
 *
 * Status "valid" = status Sudden Move Guard (signal.js -> suddenMove.assessEntry) yang sama dengan
 * !signal <koin>; tidak ada rumus baru, jadi hasilnya selalu konsisten dengan command per koin.
 *
 * Berat (199 koin x TF), jadi: hasil di-cache 3 menit per kombinasi TF dan permintaan bersamaan
 * berbagi satu proses (pola sama dengan allPdf.js).
 */

const { t } = require("../../i18n");
const { getAvailableCoins } = require("./kriptoList");
const { getMarketRows } = require("./pasar");
const { fetchTicker, fmtLevel } = require("./market");

const CONCURRENCY = 6; // koin diproses paralel; tiap koin menarik semua TF terpilih sekaligus
const TTL_MS = 3 * 60_000;
const MIN_SUCCESS_RATIO = 0.5;
const MSG_MAX = 3000; // batas aman satu pesan WhatsApp (sama dengan kriptoList.js)
const TF_LABEL = { "15M": "15m", "1H": "1H", "4H": "4H", "1D": "1D" };

const cache = new Map(); // key -> { at, data }
const building = new Map(); // key -> Promise

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

// =====================================================================
// Klasifikasi (murni)
// =====================================================================

/**
 * Kelompokkan hasil satu TF satu koin.
 * @returns {{cls:"VALID"|"TUNGGU"|"HINDARI"|"SIDEWAYS"|"NODATA", dir?:"long"|"short", conditional?:boolean, sc?:object, confidence?:number}}
 */
function classify(row) {
  const sc = row?.scenario;
  if (!row?.bias || !sc || sc.status === "nodata") return { cls: "NODATA" };
  if (sc.status === "range") return { cls: "SIDEWAYS", sc };
  const status = sc.guard?.status || "VALID"; // tanpa guard (data kurang) diperlakukan seperti v1: VALID
  return {
    cls: status,
    dir: sc.status,
    conditional: !!sc.guard?.conditional,
    sc,
    confidence: row.bias.confidence,
  };
}

/** Kelompokkan semua koin untuk satu TF -> { VALID:[], TUNGGU:[], HINDARI:[], SIDEWAYS:[], NODATA:[] } berisi { ticker, ...classify }. */
function groupByTf(coins, tf) {
  const groups = { VALID: [], TUNGGU: [], HINDARI: [], SIDEWAYS: [], NODATA: [] };
  for (const c of coins) {
    const row = c.rows.find((r) => r.tf === tf);
    const k = classify(row);
    groups[k.cls].push({ ticker: c.ticker, ...k });
  }
  // VALID: keyakinan bias tertinggi dulu, lalu RR TP1 terbaik
  groups.VALID.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || (b.sc.tps[0].rr ?? 0) - (a.sc.tps[0].rr ?? 0));
  return groups;
}

// =====================================================================
// Pengumpul data (I/O)
// =====================================================================

async function collectAllUncached(lang, tfs) {
  const { collectSignal } = require("./signal");
  const stat = require("./statistik");

  const list = await getAvailableCoins(lang);

  // Harga live semua koin dalam satu request; tanpa itu tiap koin ambil ticker sendiri.
  let live = new Map();
  try {
    const rows = await getMarketRows(lang, "24H");
    live = new Map(rows.map((r) => [r.ticker, r]));
  } catch {
    /* fallback per koin di bawah */
  }

  // Hangatkan snapshot mood pasar & BTC per TF satu kali (bukan dibangun berebutan oleh tiap koin).
  await Promise.all(tfs.map((tf) => stat.getSnapshot(lang, tf).catch(() => null)));

  const results = await mapLimit(list, CONCURRENCY, async (c) => {
    const lv = live.get(c.ticker);
    const tick = lv && isFinite(lv.price) ? { price: lv.price, changePct: lv.pct } : await fetchTicker(c.ticker);
    const rows = await collectSignal(c.ticker, tfs, { lang, tick, skipAmd: true });
    return rows.some((r) => r.bias) ? { ticker: c.ticker, rows } : null;
  });

  const coins = results.filter(Boolean);
  if (!list.length || coins.length < list.length * MIN_SUCCESS_RATIO) throw new Error("SNAPSHOT_INCOMPLETE");
  return { coins, total: list.length, at: Date.now() };
}

/** Semua koin x TF terpilih. Cache 3 menit; permintaan bersamaan berbagi satu proses. */
async function collectAll(lang, tfs) {
  const key = `${lang}:${tfs.join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  if (building.has(key)) return building.get(key);
  const job = collectAllUncached(lang, tfs)
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => building.delete(key));
  building.set(key, job);
  return job;
}

// =====================================================================
// Format pesan
// =====================================================================
const pad = (s, n) => String(s).padEnd(n, " ");
const fmtRR = (v) => (v == null ? "-" : v.toFixed(2).replace(/\.?0+$/, ""));
const dirLetter = (dir) => (dir === "long" ? "L" : "S");

/** Pecah baris-baris jadi beberapa pesan <= MSG_MAX. `wrap` membungkus tiap pesan dengan ``` (tabel monospace). */
function chunkLines(lines, { head = "", repeatHead = [], wrap = false } = {}) {
  const wrapIt = (arr) => (wrap ? ["```", ...arr, "```"] : arr);
  const out = [];
  let cur = [...repeatHead];
  let len = head.length + repeatHead.join("\n").length;
  for (const line of lines) {
    if (len + line.length + 1 > MSG_MAX - 8 && cur.length > repeatHead.length) {
      out.push(cur);
      cur = [...repeatHead];
      len = repeatHead.join("\n").length;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) out.push(cur);
  return out.map((arr, i) => (i === 0 && head ? `${head}\n` : "") + wrapIt(arr).join("\n"));
}

/** Tabel skenario VALID (monospace). */
function validTable(lang, valid) {
  const rows = valid.map((v) => {
    const sc = v.sc;
    return {
      coin: v.ticker,
      dir: `${dirLetter(v.dir)}${v.conditional ? "*" : ""}`,
      entry: fmtLevel(sc.entry.price),
      sl: fmtLevel(sc.sl.price),
      tp1: fmtLevel(sc.tps[0].price),
      rr: fmtRR(sc.tps[0].rr),
    };
  });
  const hdr = { coin: t(lang, "sinyal.all.colCoin"), dir: t(lang, "sinyal.all.colDir"), entry: "Entry", sl: "SL", tp1: "TP1", rr: "RR" };
  const w = {};
  for (const k of Object.keys(hdr)) w[k] = Math.max(hdr[k].length, ...rows.map((r) => r[k].length));
  const line = (r) => `${pad(r.coin, w.coin)} ${pad(r.dir, w.dir)} ${pad(r.entry, w.entry)} ${pad(r.sl, w.sl)} ${pad(r.tp1, w.tp1)} ${r.rr}`;
  return { header: line(hdr), lines: rows.map(line) };
}

/** Pesan-pesan untuk satu TF. */
function formatTf(lang, tf, groups, total, ver) {
  const n = (k) => groups[k].length;
  const head = t(lang, "sinyal.all.head", {
    tf: TF_LABEL[tf],
    ver,
    total,
    valid: n("VALID"),
    wait: n("TUNGGU"),
    avoid: n("HINDARI"),
    side: n("SIDEWAYS"),
  });

  const messages = [];

  // 1) Tabel VALID
  if (n("VALID")) {
    const tbl = validTable(lang, groups.VALID);
    const title = `${head}\n\n${t(lang, "sinyal.all.validTitle", { n: n("VALID") })}`;
    messages.push(...chunkLines(tbl.lines, { head: title, repeatHead: [tbl.header], wrap: true }));
  } else {
    messages.push(`${head}\n\n${t(lang, "sinyal.all.noneValid")}`);
  }

  // 2) Daftar singkat yang tidak valid (teks, bukan tabel: ratusan baris tabel tidak muat di layar HP)
  const tag = (g) => (g.dir ? `${g.ticker}-${dirLetter(g.dir)}` : g.ticker);
  const blocks = [];
  for (const [key, titleKey] of [
    ["TUNGGU", "sinyal.all.waitTitle"],
    ["HINDARI", "sinyal.all.avoidTitle"],
    ["SIDEWAYS", "sinyal.all.sideTitle"],
    ["NODATA", "sinyal.all.nodataTitle"],
  ]) {
    if (!n(key)) continue;
    blocks.push(`${t(lang, titleKey, { n: n(key) })}\n${groups[key].map(tag).join(", ")}`);
  }
  if (blocks.length) messages.push(...chunkLines(blocks.flatMap((b) => [b, ""]).slice(0, -1)));

  return messages;
}

// =====================================================================
// Runner
// =====================================================================
async function runSinyalAll(sock, msg, ctx, { tfs }) {
  const { jid, lang } = ctx;
  const { SIGNAL_VERSION } = require("./signal");

  await sock.sendMessage(jid, { text: t(lang, "sinyal.all.scanning", { tfs: tfs.map((x) => TF_LABEL[x]).join(", ") }) }, { quoted: msg });

  const { coins, total } = await collectAll(lang, tfs);

  let first = true;
  for (const tf of tfs) {
    const groups = groupByTf(coins, tf);
    for (const text of formatTf(lang, tf, groups, total, SIGNAL_VERSION)) {
      await sock.sendMessage(jid, { text }, first ? { quoted: msg } : undefined);
      first = false;
    }
  }
  await sock.sendMessage(jid, { text: `${t(lang, "sinyal.all.note")}\n\n${t(lang, "sinyal.disclaimer")}` });
}

module.exports = { runSinyalAll, collectAll, classify, groupByTf, formatTf, chunkLines, validTable };
