"use strict";

/**
 * features/forex/forexList.js
 * ------------------------------------------------------------------
 * !listforex [kata kunci]  (alias !listfx)
 *
 * Menampilkan pair forex yang didukung bot, dikelompokkan per kategori
 * (Mayor, Cross, Logam, Eksotik). Sumber data: PAIRS di forexPairs.js, jadi
 * daftar ini otomatis ikut kalau pair baru ditambahkan di sana.
 * Fungsi MURNI, tanpa jaringan (beda dengan !listkripto yang menyaring lewat Binance).
 *
 * Kata kunci opsional memfilter berdasarkan kategori, kode mata uang, ticker, atau nama:
 *   !listforex jpy   |   !listforex emas   |   !listforex cross   |   !listforex eur/usd
 */

const { t } = require("../../i18n");
const { PAIRS } = require("./forexPairs");

const CAT_ORDER = ["major", "cross", "metal", "exotic"];

// Nama mata uang per bahasa. Kode yang tidak ada di sini jatuh ke kodenya sendiri.
const CCY_NAME = {
  id: { EUR: "Euro", USD: "Dolar AS", GBP: "Poundsterling", JPY: "Yen Jepang", CHF: "Franc Swiss", AUD: "Dolar Australia", CAD: "Dolar Kanada", NZD: "Dolar Selandia Baru", XAU: "Emas", IDR: "Rupiah" },
  en: { EUR: "Euro", USD: "US Dollar", GBP: "British Pound", JPY: "Japanese Yen", CHF: "Swiss Franc", AUD: "Australian Dollar", CAD: "Canadian Dollar", NZD: "New Zealand Dollar", XAU: "Gold", IDR: "Indonesian Rupiah" },
};

// Kata kunci kategori yang diterima di dua bahasa (selain label tampilan).
const CAT_WORDS = {
  major: ["major", "mayor"],
  cross: ["cross", "silang"],
  metal: ["metal", "logam", "emas", "gold"],
  exotic: ["exotic", "eksotik"],
};

const ccyName = (lang, code) => (CCY_NAME[lang === "en" ? "en" : "id"][code]) || code;
const norm = (s) => String(s || "").toLowerCase().replace(/[\/\-_\s]/g, "");

/** @returns {Array<{pair,base,quote,cat,name,minTf,futures}>} urut sesuai PAIRS */
function getForexList(lang) {
  return Object.entries(PAIRS).map(([pair, p]) => ({
    pair,
    base: p.base,
    quote: p.quote,
    cat: p.cat,
    name: `${ccyName(lang, p.base)} / ${ccyName(lang, p.quote)}`,
    minTf: p.minTf || null,
    futures: p.proxy === "futures",
  }));
}

/** Filter berdasarkan kategori, ticker (awalan), kode mata uang, atau nama. Kosong = semua. */
function filterForex(list, keyword) {
  const q = norm(keyword);
  if (!q) return list;
  return list.filter(
    (f) =>
      f.pair.toLowerCase().startsWith(q) ||
      f.pair.toLowerCase().includes(q) ||
      f.base.toLowerCase() === q ||
      f.quote.toLowerCase() === q ||
      norm(f.name).includes(q) ||
      (CAT_WORDS[f.cat] || []).some((w) => w.startsWith(q)),
  );
}

function pairLine(lang, f) {
  let line = `• *${f.pair}* (${f.base}/${f.quote}) - ${f.name}`;
  if (f.futures) line += ` ${t(lang, "forex.list.noteFutures")}`;
  if (f.minTf) line += ` ${t(lang, "forex.list.noteMinTf", { tf: f.minTf })}`;
  return line;
}

/** Susun satu pesan teks (daftar forex kecil, tidak perlu dipecah). */
function buildForexMessage(lang, list) {
  const blocks = [];
  for (const cat of CAT_ORDER) {
    const items = list.filter((f) => f.cat === cat);
    if (!items.length) continue;
    blocks.push(`*${t(lang, `forex.list.cat.${cat}`)}* (${items.length})\n${items.map((f) => pairLine(lang, f)).join("\n")}`);
  }
  return `${t(lang, "forex.list.header", { total: list.length })}\n\n${blocks.join("\n\n")}\n\n${t(lang, "forex.list.footer")}`;
}

async function runListForex(sock, msg, { jid, lang }, keyword) {
  const list = filterForex(getForexList(lang), keyword);
  if (!list.length) {
    await sock.sendMessage(jid, { text: t(lang, "forex.list.empty", { q: String(keyword).trim().slice(0, 40) }) }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { text: buildForexMessage(lang, list) }, { quoted: msg });
}

module.exports = { getForexList, filterForex, buildForexMessage, runListForex };
