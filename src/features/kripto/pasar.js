"use strict";

/**
 * features/kripto/pasar.js
 * ------------------------------------------------------------------
 * Daftar & pencarian pasar (Command Kripto - Bagian 3):
 *   !semua [kategori] [tf]  -> semua koin + harga + % perubahan, dipaginasi (!next)
 *   !top [jumlah]           -> top gainers 24 jam (default 10)
 *   !flop [jumlah]          -> top losers 24 jam (default 10)
 *   !kategori               -> daftar kategori + jumlah koin
 *   !cari <nama>            -> cari koin berdasarkan nama / ticker (parsial)
 *
 * Data langsung dari Binance (sama seperti market.js). % perubahan !semua
 * mengikuti timeframe lewat rolling-window ticker Binance (15m/1H/4H/1D);
 * !top / !flop selalu 24 jam. Hasil di-cache 60 detik supaya !next dan
 * perintah beruntun tidak membebani API.
 */

const axios = require("axios");
const { t } = require("../../i18n");
const { COINS } = require("./coinList");
const { getAvailableCoins } = require("./kriptoList");
const { binanceSymbol } = require("../analisis/analisisChart");
const { TIMEFRAMES, TF_LABEL, fmtUsd, fmtPct } = require("./market");
const { getSenderJid } = require("../../utils/whatsapp");

const BINANCE = (process.env.BINANCE_BASE || "https://data-api.binance.vision").replace(/\/+$/, "");
const CACHE_MS = 60_000;
const CHUNK = 100; // batas simbol per request Binance
const PAGE_SIZE = 25;
const PAGER_TTL_MS = 15 * 60_000;
const TOP_DEFAULT = 10;
const TOP_MAX = 25;
const SEARCH_MAX = 15;

// ---------- kategori ----------
// Kunci = nama kategori Indonesia di coinList.js (kanonik, tidak tergantung bahasa).
const CATEGORY_DEFS = {
  "Koin Utama & Blockchain Layer 1": { key: "layer1", aliases: ["layer1", "l1", "utama", "main"] },
  "Layer 2 & Interoperabilitas": { key: "layer2", aliases: ["layer2", "l2", "interop", "interoperabilitas", "interoperability"] },
  "Stablecoin & Aset Berbasis Komoditas": { key: "komoditas", aliases: ["komoditas", "commodity", "stable", "stablecoin", "emas", "gold"] },
  DeFi: { key: "defi", aliases: ["defi"] },
  "Meme Coin": { key: "meme", aliases: ["meme", "memecoin"] },
  "AI & Data": { key: "ai", aliases: ["ai", "data"] },
  "Gaming, Metaverse & NFT": { key: "gaming", aliases: ["gaming", "game", "metaverse", "nft"] },
  "Token Exchange": { key: "exchange", aliases: ["exchange", "cex", "bursa"] },
  "Privasi, Penyimpanan & Infrastruktur": { key: "infra", aliases: ["infra", "infrastruktur", "infrastructure", "privasi", "privacy", "storage", "penyimpanan"] },
};

// ticker -> { name, catId, catEn }
const COIN_META = new Map(COINS.map(([ticker, name, catId, catEn]) => [ticker, { name, catId, catEn }]));
const CAT_EN = new Map(COINS.map(([, , catId, catEn]) => [catId, catEn]));
const catName = (lang, catId) => (lang === "en" ? CAT_EN.get(catId) : catId) || catId;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/** "layer 1" / "meme" / "l2" -> daftar catId yang cocok (kosong kalau tidak ada). */
function matchCategories(keyword) {
  const kw = norm(keyword);
  if (!kw) return [];
  return Object.entries(CATEGORY_DEFS)
    .filter(([, d]) => d.aliases.some((a) => a === kw || (kw.length >= 3 && a.startsWith(kw))))
    .map(([catId]) => catId);
}

// ---------- data pasar ----------
const isInvalidSymbol = (err) => err?.response?.status === 400 || err?.response?.data?.code === -1121;

/** Satu request ke Binance; kalau ada simbol tidak valid, bagi dua sampai ketemu (tidak menggagalkan semuanya). */
async function fetchChunk(url, baseParams, symbols) {
  try {
    const res = await axios.get(url, {
      params: { ...baseParams, symbols: JSON.stringify(symbols), type: "MINI" },
      timeout: 15_000,
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    if (!isInvalidSymbol(err)) throw err;
    if (symbols.length <= 1) return [];
    const mid = Math.ceil(symbols.length / 2);
    const [a, b] = await Promise.all([
      fetchChunk(url, baseParams, symbols.slice(0, mid)),
      fetchChunk(url, baseParams, symbols.slice(mid)),
    ]);
    return [...a, ...b];
  }
}

const cache = new Map(); // windowKey -> { at, map }
const pending = new Map(); // windowKey -> Promise

/**
 * @param {"15M"|"1H"|"4H"|"1D"|"24H"} windowKey
 * @returns {Promise<Map<string,{price:number,pct:number}>>} simbol Binance -> data
 */
async function getTickerMap(windowKey, symbols) {
  const hit = cache.get(windowKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.map;
  if (pending.has(windowKey)) return pending.get(windowKey);

  const job = (async () => {
    const is24 = windowKey === "24H";
    const url = is24 ? `${BINANCE}/api/v3/ticker/24hr` : `${BINANCE}/api/v3/ticker`;
    const base = is24 ? {} : { windowSize: TIMEFRAMES[windowKey] };
    const chunks = [];
    for (let i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));
    const parts = await Promise.all(chunks.map((c) => fetchChunk(url, base, c)));

    const map = new Map();
    for (const row of parts.flat()) {
      const price = Number(row.lastPrice);
      const open = Number(row.openPrice);
      if (!isFinite(price) || !isFinite(open) || open <= 0) continue;
      map.set(row.symbol, { price, pct: ((price - open) / open) * 100 });
    }
    if (!map.size) throw new Error("EMPTY_MARKET");
    cache.set(windowKey, { at: Date.now(), map });
    return map;
  })().finally(() => pending.delete(windowKey));

  pending.set(windowKey, job);
  return job;
}

/** Koin yang tersedia + harga & % untuk window tertentu (urutan sama dengan coinList). */
async function getMarketRows(lang, windowKey) {
  const coins = await getAvailableCoins(lang);
  const map = await getTickerMap(windowKey, coins.map((c) => binanceSymbol(c.ticker)));
  const rows = [];
  for (const c of coins) {
    const d = map.get(binanceSymbol(c.ticker));
    if (d) rows.push({ ticker: c.ticker, name: c.name, cat: c.cat, catId: COIN_META.get(c.ticker)?.catId, price: d.price, pct: d.pct });
  }
  return rows;
}

// ---------- format ----------
const pad = (s, n) => String(s).padEnd(n, " ");
const icon = (pct) => (pct >= 0 ? "🟢" : "🔴");

/** Baris tabel dengan lebar kolom menyesuaikan isi halaman (ticker panjang seperti FARTCOIN tetap rapi). */
function tableRows(startNo, slice) {
  const prices = slice.map((r) => fmtUsd(r.price));
  const wTicker = Math.max(4, ...slice.map((r) => r.ticker.length));
  const wPrice = Math.max(...prices.map((p) => p.length));
  return slice.map((r, i) => `${String(startNo + i).padStart(3)} ${pad(r.ticker, wTicker)} ${pad(prices[i], wPrice)} ${fmtPct(r.pct).padStart(8)}`);
}

// ---------- !semua + pagination ----------
const pagers = new Map(); // senderId -> { tf, catIds, tickers, page, at }

function renderPage(lang, pager, rowMap) {
  const total = pager.tickers.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  const from = pager.page * PAGE_SIZE;
  const slice = pager.tickers.slice(from, from + PAGE_SIZE).map((tk) => rowMap.get(tk)).filter(Boolean);
  const label = pager.catIds ? [...new Set(pager.catIds.map((c) => catName(lang, c)))].join(" / ") : t(lang, "pasar.semua.all");

  const lines = [
    t(lang, "pasar.semua.head", { label, tf: TF_LABEL[pager.tf], total, page: pager.page + 1, pages }),
    "",
    "```",
    ...tableRows(from + 1, slice),
    "```",
    "",
    pager.page + 1 < pages ? t(lang, "pasar.semua.next") : t(lang, "pasar.semua.last"),
    t(lang, "kripto.disclaimer"),
  ];
  return lines.join("\n");
}

async function runSemua(sock, msg, { jid, lang, senderId }, { catKeyword, tf }) {
  const rows = await getMarketRows(lang, tf);
  let list = rows;
  let catIds = null;
  if (catKeyword) {
    catIds = matchCategories(catKeyword);
    list = catIds.length ? rows.filter((r) => catIds.includes(r.catId)) : [];
  }
  if (!list.length) {
    await sock.sendMessage(jid, { text: t(lang, "pasar.semua.empty", { q: catKeyword.slice(0, 40) }) }, { quoted: msg });
    return;
  }
  const pager = { tf, catIds, tickers: list.map((r) => r.ticker), page: 0, at: Date.now() };
  pagers.set(senderId, pager);
  const rowMap = new Map(rows.map((r) => [r.ticker, r]));
  await sock.sendMessage(jid, { text: renderPage(lang, pager, rowMap) }, { quoted: msg });
}

const nextInFlight = new Set();

/**
 * Dipanggil router sebelum handler !next gambar.
 * @param {number} otherSessionAt waktu terakhir sesi gambar pengirim dipakai (0 kalau tidak ada);
 *   kalau sesi gambar lebih baru dari daftar pasar, !next dibiarkan untuk gambar.
 * @returns {Promise<boolean>} true kalau !next ini sudah ditangani sebagai halaman berikutnya !semua.
 */
async function handleKriptoNext(sock, msg, { jid, lang, otherSessionAt = 0 }) {
  const senderId = getSenderJid(msg) || jid;
  const pager = pagers.get(senderId);
  if (!pager) return false;
  if (Date.now() - pager.at > PAGER_TTL_MS) {
    pagers.delete(senderId);
    return false;
  }
  if (otherSessionAt > pager.at) return false;
  if (nextInFlight.has(senderId)) return true;

  nextInFlight.add(senderId);
  try {
    const pages = Math.ceil(pager.tickers.length / PAGE_SIZE);
    if (pager.page + 1 >= pages) {
      pagers.delete(senderId);
      await sock.sendMessage(jid, { text: t(lang, "pasar.semua.done") }, { quoted: msg });
      return true;
    }
    const rows = await getMarketRows(lang, pager.tf);
    pager.page += 1;
    pager.at = Date.now();
    await sock.sendMessage(jid, { text: renderPage(lang, pager, new Map(rows.map((r) => [r.ticker, r]))) }, { quoted: msg });
  } catch (err) {
    console.log("[kripto] !next (semua) gagal:", err.message);
    const key = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" ? "kripto.timeout" : "kripto.fail";
    await sock.sendMessage(jid, { text: t(lang, key) });
  } finally {
    nextInFlight.delete(senderId);
  }
  return true;
}

// ---------- !top / !flop ----------
async function runTopFlop(sock, msg, { jid, lang }, { n }, losers) {
  const rows = await getMarketRows(lang, "24H");
  const sorted = [...rows].sort((a, b) => (losers ? a.pct - b.pct : b.pct - a.pct)).slice(0, n);
  const lines = sorted.map((r, i) => `${i + 1}. *${r.ticker}* ${fmtUsd(r.price)} | ${icon(r.pct)} ${fmtPct(r.pct)}`);
  await sock.sendMessage(
    jid,
    { text: t(lang, losers ? "pasar.flop.body" : "pasar.top.body", { n: sorted.length, rows: lines.join("\n") }) },
    { quoted: msg },
  );
}
const runTop = (sock, msg, ctx, args) => runTopFlop(sock, msg, ctx, args, false);
const runFlop = (sock, msg, ctx, args) => runTopFlop(sock, msg, ctx, args, true);

// ---------- !kategori ----------
async function runKategori(sock, msg, { jid, lang }) {
  const coins = await getAvailableCoins(lang);
  const counts = new Map();
  for (const c of coins) {
    const catId = COIN_META.get(c.ticker)?.catId;
    counts.set(catId, (counts.get(catId) || 0) + 1);
  }
  const rows = Object.entries(CATEGORY_DEFS)
    .filter(([catId]) => counts.get(catId))
    .map(([catId, d]) => t(lang, "pasar.kategori.row", { name: catName(lang, catId), n: counts.get(catId), key: d.key }));
  await sock.sendMessage(jid, { text: t(lang, "pasar.kategori.body", { total: coins.length, rows: rows.join("\n") }) }, { quoted: msg });
}

// ---------- !cari ----------
function searchScore(c, q) {
  const tk = c.ticker.toLowerCase();
  const nm = norm(c.name);
  if (tk === q) return 0;
  if (tk.startsWith(q)) return 1;
  if (nm.startsWith(q)) return 2;
  if (tk.includes(q)) return 3;
  if (nm.includes(q)) return 4;
  return -1;
}

async function runCari(sock, msg, { jid, lang }, { query }) {
  const q = norm(query);
  const coins = await getAvailableCoins(lang);
  const hits = coins
    .map((c) => ({ c, s: q ? searchScore(c, q) : -1 }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s);
  if (!hits.length) {
    await sock.sendMessage(jid, { text: t(lang, "pasar.cari.empty", { q: query.slice(0, 40) }) }, { quoted: msg });
    return;
  }
  const shown = hits.slice(0, SEARCH_MAX);
  const rows = shown.map(({ c }) => `• *${c.ticker}* - ${c.name}`).join("\n");
  const more = hits.length > shown.length ? "\n" + t(lang, "pasar.cari.more", { n: hits.length - shown.length }) : "";
  await sock.sendMessage(
    jid,
    { text: t(lang, "pasar.cari.body", { q: query.slice(0, 40), n: hits.length, rows: rows + more }) },
    { quoted: msg },
  );
}

// ---------- parsing & registrasi ----------
const PASAR_COMMANDS = {
  semua: { re: /^!semua(?:\s+([\s\S]*))?$/i },
  top: { re: /^!top(?:\s+([\s\S]*))?$/i },
  flop: { re: /^!flop(?:\s+([\s\S]*))?$/i },
  kategori: { re: /^!kategori(?:\s+([\s\S]*))?$/i },
  cari: { re: /^!cari(?:\s+([\s\S]*))?$/i },
};

/** @returns {object|null} argumen terurai, atau null kalau format salah (-> tampilkan penjelasan command). */
function parsePasarArgs(name, raw, defaultTf) {
  const text = String(raw || "").trim();
  switch (name) {
    case "semua": {
      let tf = null;
      const words = [];
      for (const tok of text.split(/\s+/).filter(Boolean)) {
        if (TIMEFRAMES[tok.toUpperCase()]) tf = tok.toUpperCase();
        else words.push(tok);
      }
      const catKeyword = words.join(" ");
      if (catKeyword.length > 40) return null;
      return { catKeyword, tf: tf || defaultTf };
    }
    case "top":
    case "flop": {
      if (!text) return { n: TOP_DEFAULT };
      if (!/^\d{1,2}$/.test(text)) return null;
      const n = Number(text);
      return n >= 1 && n <= TOP_MAX ? { n } : null;
    }
    case "kategori":
      return text ? null : {};
    case "cari":
      return text && text.length <= 30 ? { query: text } : null;
    default:
      return null;
  }
}

const PASAR_RUNNERS = { semua: runSemua, top: runTop, flop: runFlop, kategori: runKategori, cari: runCari };

module.exports = {
  PASAR_COMMANDS,
  PASAR_RUNNERS,
  parsePasarArgs,
  handleKriptoNext,
  getMarketRows,
  matchCategories,
  PAGE_SIZE,
};
