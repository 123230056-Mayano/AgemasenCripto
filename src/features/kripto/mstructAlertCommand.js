"use strict";

/**
 * features/kripto/mstructAlertCommand.js
 * ------------------------------------------------------------------
 * !alertmstruct: alarm market structure: BOS, CHoCH, MSS, dan sweep BSL / SSL, hanya konfirmasi (candle closed).
 *
 *   !alertmstruct btc 4h                -> semua jenis: BOS, CHoCH, MSS, sweep BSL, sweep SSL (default)
 *   !alertmstruct btc 1h choch mss      -> hanya CHoCH dan MSS
 *   !alertmstruct eth 15m bos           -> hanya BOS
 *   !alertmstruct sol 1h sweep          -> hanya sweep (BSL + SSL); boleh juga bsl / ssl saja
 *   !alertmstruct watchlist 1h
 *   !alertmstruct list | off | hapus <id|semua>
 *
 * FOREX: pair dikenali otomatis (!alertmstruct eurusd 1h, eur/usd 4h, xauusd 4h; alias !alertfxmstruct). Data Yahoo.
 * TF yang tidak didukung pair (mis. 15m USDIDR) ditolak. Watchlist hanya kripto.
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * mstructAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di mstructAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker } = require("./market");
const { resolvePair, normalizePairText, allowedTfs } = require("../forex/forexPairs");
const { COIN_WATCHLIST, TF_LABEL, DAILY_TZ_LABEL } = require("./divAlertCore");
const { MA, parseMstructArgs, describeMstruct } = require("./mstructAlertCore");
const { MSTRUT_CONFIG } = require("../../config/indicatorConfig");

const MSTRUCTALERT_COMMANDS = {
  alertmstruct: { re: /^!(?:alertmstruct|alertmstrut|alertmstuct|alertfxmstruct|alertmarketstructure)(?:\s+([\s\S]*))?$/i },
};

// "eur/usd" -> "eurusd" (pair forex; parser koin menolak karakter "/")
const parseMstructAlertArgs = (name, raw, defaultTf) => parseMstructArgs(normalizePairText(raw), defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const targetLabel = (lang, coin) => (coin === COIN_WATCHLIST ? t(lang, "divalert.target.watch") : coin);

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, kinds } = args;
  const pair = coin === COIN_WATCHLIST ? null : resolvePair(coin);
  if (pair) {
    // Forex: TF yang tidak didukung ditolak (USDIDR mulai 1H); data Yahoo dicek dulu (gagal -> FOREX_DATA, ditangani pemanggil).
    if (!allowedTfs(pair).includes(tf)) return say(sock, jid, msg, t(lang, "hhll.fx.tfNotAllowed", { pair }));
    await require("../forex/forexMarket").loadTicker(pair);
  } else if (coin !== COIN_WATCHLIST) await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)

  const entry = store.addMstructAlert(senderId, { chat: jid, coin, tf, kinds });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "mstructalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "mstructalert.full", { max: store.MAX_MSTRUCT_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "mstructalert.chatFull", { max: store.MAX_MSTRUCT_ALERTS_PER_CHAT }));

  let note = "";
  if (pair) note = "\n" + t(lang, "mstructalert.created.fx");
  if (coin === COIN_WATCHLIST) {
    const n = store.getWatch(senderId).length;
    if (n > MA.MAX_PAIRS) note = "\n" + t(lang, "mstructalert.created.bigWatch", { n, max: MA.MAX_PAIRS });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "mstructalert.created", {
      id: entry.id,
      target: targetLabel(lang, coin),
      tf: TF_LABEL[tf],
      what: describeMstruct(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      min: MSTRUT_CONFIG.MIN_CANDLES,
      tz: DAILY_TZ_LABEL,
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getMstructAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "mstructalert.list.empty"));
  const rows = subs.map((a) => [a.id, targetLabel(lang, a.coin), TF_LABEL[a.tf] || a.tf, describeMstruct(lang, a), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "mstructalert.list.body", { n: subs.length, max: store.MAX_MSTRUCT_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeMstructAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "mstructalert.deleted" : "mstructalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearMstructAlerts(senderId);
  const key = !n ? "mstructalert.list.empty" : args.viaOff ? "mstructalert.off.done" : "mstructalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runMstructAlert(sock, msg, ctx, args) {
  const { lang, jid } = ctx;
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "noAll":
      return say(sock, jid, msg, t(lang, "mstructalert.noAll"));
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const MSTRUCTALERT_RUNNERS = { alertmstruct: withSyncNotice(runMstructAlert) };

module.exports = { MSTRUCTALERT_COMMANDS, MSTRUCTALERT_RUNNERS, parseMstructAlertArgs };
