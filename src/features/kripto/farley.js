"use strict";

/**
 * features/kripto/farley.js
 * ------------------------------------------------------------------
 * !farley <koin> [tf] : analisis pendekatan Alan S. Farley (ribbon SMA 5-8-13 + Bollinger 13,2 + Stochastic + MACD TF besar)
 * -> status BUY / SELL / TUNGGU / RANGE + entry, SL, TP1, TP2 + kondisi dan alasan. Hanya candle closed.
 * Logika murni di farleyCore.js, teks di farleyText.js. Alarm otomatis: !alertfarley (farleyAlert*.js).
 */

const { t } = require("../../i18n");
const { TF_LABEL, fetchCandles, fetchTicker, computeLevels, fmtUsd } = require("./market");
const { TF_MS } = require("./divAlertCore");
const { computeFarley, ctxTfOf, closedContext } = require("./farleyCore");
const { buildFarleyBlock, buildFarleyFooter } = require("./farleyText");

/**
 * Hitung skenario Farley dari candle mentah (membuang candle yang belum closed). Dipakai !farley dan engine alarm.
 * @param {object[]} candles candle TF utama
 * @param {object[]|null} ctxRaw candle TF konteks (null = tidak tersedia)
 * @param {string} tf
 * @returns {{sc:object, closed:object[], ctxTf:string|null}}
 */
function analyze(candles, ctxRaw, tf) {
  const closed = (candles || []).filter((c) => c.closed !== false);
  const ctxTf = ctxTfOf(tf);
  const X = closed[closed.length - 1];
  let ctxCandles = null;
  let ctxSelf = false;
  if (X) {
    if (ctxTf) ctxCandles = closedContext(ctxRaw, X.t + TF_MS[tf], TF_MS[ctxTf]);
    else {
      ctxCandles = closed; // 1D: tidak ada TF lebih besar, konteks dari TF sendiri (diberi label)
      ctxSelf = true;
    }
  }
  const price = X ? X.c : null;
  const levels = price != null && closed.length >= 20 ? computeLevels(closed, price) : { resistance: [], support: [] };
  const sc = computeFarley(closed, { ctxCandles, ctxTf: ctxTf || tf, ctxSelf, levels });
  return { sc, closed, ctxTf };
}

async function runFarley(sock, msg, { jid, lang }, { coin, tf }) {
  const ctxTf = ctxTfOf(tf);
  const [candles, tick, ctxRaw] = await Promise.all([
    fetchCandles(coin, tf),
    fetchTicker(coin),
    ctxTf ? fetchCandles(coin, ctxTf).catch(() => null) : null,
  ]);
  const { sc } = analyze(candles, ctxRaw, tf);
  const block = buildFarleyBlock(lang, { coin, tf, tfLabel: TF_LABEL[tf], price: fmtUsd(tick.price), sc });
  const text = `${block}\n\n${buildFarleyFooter(lang, { ctxTf })}`;
  await sock.sendMessage(jid, { text }, { quoted: msg });
}

module.exports = { runFarley, analyze };
