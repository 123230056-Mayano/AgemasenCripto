"use strict";

/**
 * features/kripto/signalAll.js
 * ------------------------------------------------------------------
 *   !signal all            -> SEMUA koin x SEMUA timeframe (15m, 1H, 4H, 1D)
 *   !signal all 4h         -> semua koin, hanya timeframe yang dipilih
 *   !signal all 1h 4h      -> semua koin, beberapa timeframe pilihan
 *   (urutan bebas: "!signal 4h all" sama saja)
 *
 * Filter status (opsional, boleh digabung dengan timeframe, urutan bebas):
 *   !signal all valid           -> PDF hanya berisi koin VALID
 *   !signal all tunggu          -> hanya TUNGGU
 *   !signal all tidak valid     -> hanya HINDARI ("hindari" / "invalid" / "avoid" juga bisa)
 *   !signal all sideways        -> hanya SIDEWAYS
 *   !signal all valid tunggu 4h -> VALID + TUNGGU di 4H
 *
 * Hasil dikirim sebagai SATU PDF (signalAllPdf.js), satu bagian per timeframe. Tiap bagian berisi ringkasan
 * jumlah VALID / TUNGGU / HINDARI / SIDEWAYS, tabel VALID (arah, entry, SL, TP1, RR), tabel TUNGGU dan HINDARI
 * (lengkap dengan alasan), serta daftar koin SIDEWAYS dan data kurang. Chat hanya menerima caption ringkas.
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
const { fetchTicker } = require("./market");

const CONCURRENCY = 6; // koin diproses paralel; tiap koin menarik semua TF terpilih sekaligus
const TTL_MS = 3 * 60_000;
const MIN_SUCCESS_RATIO = 0.5;
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
// Runner
// =====================================================================
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const ALL_STATUS = ["VALID", "TUNGGU", "HINDARI", "SIDEWAYS"];
const PART_KEY = { VALID: "valid", TUNGGU: "wait", HINDARI: "avoid", SIDEWAYS: "side" };

/** Normalisasi filter status: kosong / tidak valid = semua status. */
function normalizeOnly(only) {
  const o = ALL_STATUS.filter((k) => (only || []).includes(k));
  return o.length ? o : [...ALL_STATUS];
}

/** Caption singkat di chat: hitungan per timeframe (hanya status yang dipilih) + disclaimer. Detail ada di PDF. */
function buildCaption(lang, tfs, groupsByTf, total, only) {
  const sel = normalizeOnly(only);
  const filtered = sel.length < ALL_STATUS.length;
  const lines = tfs.map((tf) => {
    const g = groupsByTf[tf];
    const parts = sel.map((k) => t(lang, `sinyal.all.part.${PART_KEY[k]}`, { n: g[k].length }));
    return `*${TF_LABEL[tf]}*: ${parts.join(" | ")}`;
  });
  const head = [t(lang, "sinyal.all.caption.head", { total })];
  if (filtered) head.push(t(lang, "sinyal.all.caption.filter", { f: sel.map((k) => t(lang, `sinyal.all.status.${PART_KEY[k]}`)).join(", ") }));
  return [...head, ...lines, "", t(lang, "sinyal.disclaimer")].join("\n");
}

async function runSinyalAll(sock, msg, ctx, { tfs, only }) {
  const { jid, lang } = ctx;
  const { buildSignalAllPdf } = require("./signalAllPdf");
  const sel = normalizeOnly(only);
  const filtered = sel.length < ALL_STATUS.length;

  await sock.sendMessage(jid, { text: t(lang, "sinyal.all.scanning", { tfs: tfs.map((x) => TF_LABEL[x]).join(", ") }) }, { quoted: msg });

  const { coins, total } = await collectAll(lang, tfs);
  const groupsByTf = Object.fromEntries(tfs.map((tf) => [tf, groupByTf(coins, tf)]));

  const buf = await buildSignalAllPdf(lang, { tfs, total, groupsByTf, only: sel });
  const tfPart = tfs.length === 4 ? "semua-TF" : tfs.map((x) => TF_LABEL[x]).join("-");
  const statusPart = filtered ? `${sel.map((k) => PART_KEY[k]).join("-")}-` : "";
  await sock.sendMessage(
    jid,
    { document: buf, mimetype: "application/pdf", fileName: `SIGNAL-${statusPart}semua-koin-${tfPart}-${stamp()}.pdf`, caption: buildCaption(lang, tfs, groupsByTf, total, only) },
    { quoted: msg },
  );
}

module.exports = { runSinyalAll, collectAll, classify, groupByTf, buildCaption };
