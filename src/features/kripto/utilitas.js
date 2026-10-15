"use strict";

/**
 * features/kripto/utilitas.js
 * ------------------------------------------------------------------
 * Utilitas kripto (Command Kripto - Bagian 6):
 *   !kurs                       -> kurs 1 USDT ke Rupiah
 *   !konversi <jumlah> <koin>   -> jumlah koin ke USDT + Rupiah
 *   !tf <timeframe>             -> simpan timeframe default per user (15m, 1H, 4H, 1D)
 *
 * USDT dianggap setara 1 USD (sama seperti !harga). Kurs Rupiah dari
 * fetchUsdIdr() di market.js (cache 10 menit).
 */

const { t } = require("../../i18n");
const { setDefaultTf } = require("./defaultTf");
const { TIMEFRAMES, TF_LABEL, fetchTicker, fetchUsdIdr, fmtUsd, fmtIdr } = require("./market");

const UTIL_COMMANDS = {
  kurs: { re: /^!kurs(?:\s+([\s\S]*))?$/i },
  konversi: { re: /^!konversi(?:\s+([\s\S]*))?$/i },
  tf: { re: /^!tf(?:\s+([\s\S]*))?$/i },
};

const COIN_RE = /^[A-Z0-9]{1,15}$/;
const STABLES = new Set(["USDT", "USD"]); // harga tetap 1 USDT

/** "2" / "0.5" / "0,5" / "1.000" -> angka positif, atau null. */
function parseAmount(raw) {
  let s = String(raw).trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 1.000,5
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", "."); // 0,5
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return isFinite(n) && n > 0 && n <= 1e12 ? n : null;
}

/** @returns {object|null} argumen terurai, atau null kalau format salah (-> penjelasan command). */
function parseUtilArgs(name, raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  switch (name) {
    case "kurs":
      return tokens.length ? null : {};
    case "tf": {
      if (tokens.length !== 1) return null;
      const tf = tokens[0].toUpperCase();
      return TIMEFRAMES[tf] ? { tf } : null;
    }
    case "konversi": {
      if (tokens.length !== 2) return null;
      let amount = parseAmount(tokens[0]);
      let coinTok = tokens[1];
      if (amount == null) {
        // toleransi urutan terbalik: "sol 2"
        amount = parseAmount(tokens[1]);
        coinTok = tokens[0];
      }
      const coin = coinTok.toUpperCase();
      return amount != null && COIN_RE.test(coin) ? { amount, coin } : null;
    }
    default:
      return null;
  }
}

const fmtAmount = (n) =>
  n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 8 : 10, useGrouping: false });

async function runKurs(sock, msg, { jid, lang }) {
  const rate = await fetchUsdIdr();
  if (!rate) {
    await sock.sendMessage(jid, { text: t(lang, "kripto.kurs.unavailable") }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { text: t(lang, "kripto.kurs.body", { rate: fmtIdr(rate) }) }, { quoted: msg });
}

async function runKonversi(sock, msg, { jid, lang }, { amount, coin }) {
  const [price, rate] = await Promise.all([
    STABLES.has(coin) ? Promise.resolve(1) : fetchTicker(coin).then((tk) => tk.price),
    fetchUsdIdr(),
  ]);
  const usd = amount * price;
  const body = rate
    ? t(lang, "kripto.konversi.body", { amount: fmtAmount(amount), coin, usd: fmtUsd(usd), idr: fmtIdr(usd * rate) })
    : t(lang, "kripto.konversi.noIdr", { amount: fmtAmount(amount), coin, usd: fmtUsd(usd) });
  await sock.sendMessage(jid, { text: body }, { quoted: msg });
}

async function runTf(sock, msg, { jid, lang, senderId }, { tf }) {
  setDefaultTf(senderId, tf);
  await sock.sendMessage(jid, { text: t(lang, "kripto.tf.set", { tf: TF_LABEL[tf] }) }, { quoted: msg });
}

const UTIL_RUNNERS = { kurs: runKurs, konversi: runKonversi, tf: runTf };

module.exports = { UTIL_COMMANDS, UTIL_RUNNERS, parseUtilArgs, parseAmount };
