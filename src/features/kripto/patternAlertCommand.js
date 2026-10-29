"use strict";

/**
 * features/kripto/patternAlertCommand.js
 * ------------------------------------------------------------------
 * !alertpola: alarm pola candlestick / swing baru dari candle closed (Fitur 5A, Paket 3/4).
 *
 *   !alertpola btc 4h                    -> kabari saat pola baru terbentuk (dini) dan saat terkonfirmasi
 *   !alertpola btc 4h naik               -> hanya pola bullish (turun = hanya bearish)
 *   !alertpola eth 1h konfirmasi         -> hanya saat close sudah menembus level konfirmasi
 *   !alertpola sol 1h dini               -> hanya pola CALON yang baru terbentuk
 *   !alertpola watchlist 4h konfirmasi kuat -> hanya pola grade kuat (otomatis hanya konfirmasi)
 *   !alertpola list | off | hapus <id|semua>
 *
 * FOREX: pair dikenali otomatis (!alertpola eurusd 4h, !alertpola eur/usd 1h naik, !alertpola xauusd 4h konfirmasi;
 * alias !alertfxpola). Data Yahoo lewat forex/forexMarket.js, level dengan digits pair, tanpa volume, pola yang
 * melibatkan gap pembukaan diberi tanda. Watchlist hanya kripto.
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * patternAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di patternAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker } = require("./market");
const { resolvePair, normalizePairText, allowedTfs } = require("../forex/forexPairs");
const { COIN_WATCHLIST, TF_LABEL, DAILY_TZ_LABEL } = require("./divAlertCore");
const { parsePatternArgs, describePattern, capCoins } = require("./patternAlertCore");

const PATALERT_COMMANDS = {
  alertpola: { re: /^!(?:alertpola|alertpattern|alertfxpola|alertfxpattern)(?:\s+([\s\S]*))?$/i },
};

// "eur/usd" -> "eurusd" (pair forex; parser koin menolak karakter "/")
const parsePatternAlertArgs = (name, raw, defaultTf) => parsePatternArgs(normalizePairText(raw), defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const targetLabel = (lang, coin) => (coin === COIN_WATCHLIST ? t(lang, "divalert.target.watch") : coin);

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, dirs, anyDir, stages, strongOnly = false } = args;
  const pair = coin === COIN_WATCHLIST ? null : resolvePair(coin);
  if (pair) {
    // Forex: TF yang tidak didukung ditolak di sini (USDIDR mulai 1H); data Yahoo dicek dulu (gagal -> FOREX_DATA, ditangani pemanggil).
    if (!allowedTfs(pair).includes(tf)) return say(sock, jid, msg, t(lang, "pola.fx.tfNotAllowed", { pair }));
    await require("../forex/forexMarket").loadTicker(pair);
  } else if (coin !== COIN_WATCHLIST) await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)

  const entry = store.addPatternAlert(senderId, { chat: jid, coin, tf, dirs, anyDir, stages, strongOnly });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "patalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "patalert.full", { max: store.MAX_PATTERN_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "patalert.chatFull", { max: store.MAX_PATTERN_ALERTS_PER_CHAT }));

  let note = "";
  if (pair) note = "\n" + t(lang, "patalert.created.fx");
  if (coin === COIN_WATCHLIST) {
    const { used, cut } = capCoins(store.getWatch(senderId));
    if (cut > 0) note = "\n" + t(lang, "patalert.created.bigWatch", { n: used.length + cut, max: used.length, cut });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "patalert.created", {
      id: entry.id,
      target: targetLabel(lang, coin),
      tf: TF_LABEL[tf],
      what: describePattern(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      tz: DAILY_TZ_LABEL,
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getPatternAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "patalert.list.empty"));
  const rows = subs.map((a) => [a.id, targetLabel(lang, a.coin), TF_LABEL[a.tf] || a.tf, describePattern(lang, a), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "patalert.list.body", { n: subs.length, max: store.MAX_PATTERN_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removePatternAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "patalert.deleted" : "patalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearPatternAlerts(senderId);
  const key = !n ? "patalert.list.empty" : args.viaOff ? "patalert.off.done" : "patalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runPatternAlert(sock, msg, ctx, args) {
  const { lang, jid } = ctx;
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "noAll":
      return say(sock, jid, msg, t(lang, "patalert.noAll"));
    case "conflict":
      return say(sock, jid, msg, t(lang, `patalert.conflict.${args.reason}`));
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const PATALERT_RUNNERS = { alertpola: withSyncNotice(runPatternAlert) };

module.exports = { PATALERT_COMMANDS, PATALERT_RUNNERS, parsePatternAlertArgs };
