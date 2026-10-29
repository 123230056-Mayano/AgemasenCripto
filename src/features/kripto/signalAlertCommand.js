"use strict";

/**
 * features/kripto/signalAlertCommand.js
 * ------------------------------------------------------------------
 * !alertsignal: alarm skenario sinyal (seperti !signal) saat skenario LONG / SHORT baru muncul di candle closed.
 *
 *   !alertsignal pepe 15m                  -> LONG + SHORT, hanya status entri VALID (default)
 *   !alertsignal btc 4h long               -> hanya LONG
 *   !alertsignal eth 1h tunggu             -> status TUNGGU ikut dikabari
 *   !alertsignal watchlist 1h
 *   !alertsignal list | off | hapus <id|semua>
 *
 * FOREX: pair dikenali otomatis (!alertsignal eurusd 1h, !alertsignal eur/usd 4h long, !alertsignal xauusd 4h; alias
 * !alertfxsignal). SL/TP dalam pip, pasar tutup (akhir pekan) = tidak dikirim (VALID turun jadi TUNGGU). Watchlist hanya kripto.
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * signalAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di signalAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker } = require("./market");
const { resolvePair, normalizePairText, allowedTfs } = require("../forex/forexPairs");
const { COIN_WATCHLIST, TF_LABEL, DAILY_TZ_LABEL } = require("./divAlertCore");
const { CFG, parseSignalAlertArgs: parseCore, describeSignalAlert } = require("./signalAlertCore");

const SIGNALALERT_COMMANDS = {
  alertsignal: { re: /^!(?:alertsignal|alertsinyal|alertfxsignal|alertfxsinyal)(?:\s+([\s\S]*))?$/i },
};

// "eur/usd" -> "eurusd" (pair forex; parser koin menolak karakter "/")
const parseSignalAlertArgs = (name, raw, defaultTf) => parseCore(normalizePairText(raw), defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const targetLabel = (lang, coin) => (coin === COIN_WATCHLIST ? t(lang, "divalert.target.watch") : coin);

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, dirs, wait } = args;
  const pair = coin === COIN_WATCHLIST ? null : resolvePair(coin);
  if (pair) {
    // Forex: TF yang tidak didukung ditolak (USDIDR mulai 1H); data Yahoo dicek dulu (gagal -> FOREX_DATA, ditangani pemanggil).
    if (!allowedTfs(pair).includes(tf)) return say(sock, jid, msg, t(lang, "sinyal.fx.tfNotAllowed", { pair }));
    await require("../forex/forexMarket").loadTicker(pair);
  } else if (coin !== COIN_WATCHLIST) await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)

  const entry = store.addSignalAlert(senderId, { chat: jid, coin, tf, dirs, wait });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "signalalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "signalalert.full", { max: store.MAX_SIGNAL_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "signalalert.chatFull", { max: store.MAX_SIGNAL_ALERTS_PER_CHAT }));

  let note = "";
  if (pair) note = "\n" + t(lang, "signalalert.created.fx");
  if (coin === COIN_WATCHLIST) {
    const n = store.getWatch(senderId).length;
    if (n > CFG.MAX_PAIRS) note = "\n" + t(lang, "signalalert.created.bigWatch", { n, max: CFG.MAX_PAIRS });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "signalalert.created", {
      id: entry.id,
      target: targetLabel(lang, coin),
      tf: TF_LABEL[tf],
      what: describeSignalAlert(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      tz: DAILY_TZ_LABEL,
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getSignalAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "signalalert.list.empty"));
  const rows = subs.map((a) => [a.id, targetLabel(lang, a.coin), TF_LABEL[a.tf] || a.tf, describeSignalAlert(lang, a), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "signalalert.list.body", { n: subs.length, max: store.MAX_SIGNAL_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeSignalAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "signalalert.deleted" : "signalalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearSignalAlerts(senderId);
  const key = !n ? "signalalert.list.empty" : args.viaOff ? "signalalert.off.done" : "signalalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runSignalAlert(sock, msg, ctx, args) {
  const { lang, jid } = ctx;
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "noAll":
      return say(sock, jid, msg, t(lang, "signalalert.noAll"));
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const SIGNALALERT_RUNNERS = { alertsignal: withSyncNotice(runSignalAlert) };

module.exports = { SIGNALALERT_COMMANDS, SIGNALALERT_RUNNERS, parseSignalAlertArgs };
