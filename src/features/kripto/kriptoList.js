"use strict";

/**
 * features/kripto/kriptoList.js
 * ------------------------------------------------------------------
 * !listkripto [kata kunci]  (alias !listcrypto)
 *
 * Menampilkan koin yang bisa dipakai di !harga / !chart / !level / !analisis,
 * dikelompokkan per kategori. Daftar bawaan (coinList.js) disaring dengan
 * pasangan USDT yang masih TRADING di Binance (cache 1 jam); kalau Binance
 * tidak bisa dihubungi, daftar bawaan lengkap yang dipakai.
 *
 * Kata kunci opsional memfilter berdasarkan kategori, ticker, atau nama:
 *   !listkripto meme   |   !listkripto sol   |   !listkripto layer
 */

const axios = require("axios");
const { COINS } = require("./coinList");
const { binanceSymbol } = require("../analisis/analisisChart");

const BINANCE = (process.env.BINANCE_BASE || "https://data-api.binance.vision").replace(/\/+$/, "");
const CACHE_MS = 3600_000;
const MAX_MSG_CHARS = 3000;

let cache = { at: 0, live: null };

async function liveSymbols() {
  if (cache.live && Date.now() - cache.at < CACHE_MS) return cache.live;
  try {
    const res = await axios.get(`${BINANCE}/api/v3/exchangeInfo`, {
      params: { permissions: "SPOT" },
      timeout: 15_000,
    });
    const live = new Set(
      res.data.symbols.filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT").map((s) => s.symbol),
    );
    if (live.size) cache = { at: Date.now(), live };
  } catch {
    /* pakai cache lama atau null */
  }
  return cache.live;
}

/** @returns {Promise<Array<{ticker,name,cat}>>} */
async function getAvailableCoins(lang) {
  const live = await liveSymbols();
  return COINS.filter(([ticker]) => !live || live.has(binanceSymbol(ticker))).map(([ticker, name, catId, catEn]) => ({
    ticker,
    name,
    cat: lang === "en" ? catEn : catId,
  }));
}

function filterCoins(coins, keyword) {
  const q = keyword.trim().toLowerCase();
  if (!q) return coins;
  return coins.filter(
    (c) => c.ticker.toLowerCase() === q || c.cat.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.ticker.toLowerCase().startsWith(q),
  );
}

/**
 * Susun teks per kategori lalu pecah jadi beberapa pesan (<= MAX_MSG_CHARS)
 * supaya tidak kepanjangan untuk WhatsApp. Pemecahan hanya di batas kategori.
 * Kalau hasil filter kecil (<= 25 koin), nama koin ikut ditampilkan.
 */
function buildMessages(coins, header, footer) {
  const withName = coins.length <= 25;
  const groups = new Map();
  for (const c of coins) {
    if (!groups.has(c.cat)) groups.set(c.cat, []);
    groups.get(c.cat).push(c);
  }
  const blocks = [...groups].map(([cat, list]) => {
    const body = withName ? list.map((c) => `${c.ticker} (${c.name})`).join(", ") : list.map((c) => c.ticker).join(", ");
    return `*${cat}* (${list.length})\n${body}`;
  });

  const messages = [];
  let cur = header;
  for (const b of blocks) {
    if (cur.length + b.length + 2 > MAX_MSG_CHARS && cur !== header && cur.trim()) {
      messages.push(cur.trimEnd());
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + b;
  }
  messages.push(`${cur}\n\n${footer}`.trimStart());
  return messages;
}

module.exports = { getAvailableCoins, filterCoins, buildMessages };
