"use strict";

/**
 * features/kripto/divAlertCommand.js
 * ------------------------------------------------------------------
 * !alertdivergent (alias !alertdiv, !alertdivergence): alarm divergence RSI/MACD otomatis.
 *
 *   !alertdiv btc 1h rsi            -> alarm BTC, 1H, RSI saja
 *   !alertdiv btc 4h                -> RSI + MACD (default)
 *   !alertdiv semua 4h macd         -> semua koin (hanya 1H/4H/1D, lihat DIV_ALERT_ALL_TFS)
 *   !alertdiv watchlist 1d          -> semua koin di watchlist kamu (dibaca saat tiap putaran)
 *   !alertdiv btc 4h bull reguler   -> filter arah / jenis (opsional)
 *   !alertdiv list                  -> alarm milik saya
 *   !alertdiv hapus <id>            -> hapus satu alarm
 *   !alertdiv hapus semua           -> hapus semua alarm saya
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan candle closed
 * dan pengiriman alarm ada di alertMonitor.js; logika murninya di divAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { DIV } = require("./divergence");
const { fetchTicker } = require("./market");
const {
  TF_LABEL,
  ALERT_DIV,
  ALL_COINS_TFS,
  COIN_ALL,
  COIN_WATCHLIST,
  DAILY_TZ_LABEL,
  lastClosedBoundary,
  parseAlertDivArgs,
  describeFilters,
} = require("./divAlertCore");

const DIVALERT_COMMANDS = {
  alertdivergent: { re: /^!alertdiv(?:ergent|ergence)?(?:\s+([\s\S]*))?$/i },
};

/** @returns {object|null} argumen terurai, atau null kalau format salah (-> tampilkan penjelasan command). */
const parseDivAlertArgs = (name, raw, defaultTf) => parseAlertDivArgs(raw, defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");

const targetLabel = (lang, coin) => {
  if (coin === COIN_ALL) return t(lang, "divalert.target.all");
  if (coin === COIN_WATCHLIST) return t(lang, "divalert.target.watch");
  return coin;
};

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, indicators, dirs, kinds } = args;

  if (coin === COIN_ALL && !ALL_COINS_TFS.includes(tf)) {
    await say(sock, jid, msg, t(lang, "divalert.allTf", { tfs: ALL_COINS_TFS.map((x) => TF_LABEL[x]).join(", ") }));
    return;
  }
  // Koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil, sama dengan !watch).
  if (coin !== COIN_ALL && coin !== COIN_WATCHLIST) await fetchTicker(coin);

  const entry = store.addDivAlert(senderId, { chat: jid, coin, tf, indicators, dirs, kinds });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "divalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "divalert.full", { max: store.MAX_DIV_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "divalert.chatFull", { max: store.MAX_DIV_ALERTS_PER_CHAT }));

  // Kalau ini satu-satunya alarm di TF tsb, mulai dari candle closed terakhir (tidak mengejar candle yang sudah lewat).
  // Kalau sudah ada alarm lain di TF itu, penanda yang dikelola monitor tidak disentuh.
  const activeInTf = store.allDivAlerts().filter((x) => x.sub.tf === tf).length;
  if (activeInTf <= 1 || !store.hasLastClosed(tf)) store.setLastClosed(tf, lastClosedBoundary(tf, Date.now()));

  await say(
    sock,
    jid,
    msg,
    t(lang, "divalert.created", {
      id: entry.id,
      target: targetLabel(lang, coin),
      tf: TF_LABEL[tf],
      filters: describeFilters(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      delay: Math.round(ALERT_DIV.DELAY_MS / 1000),
      win: DIV.PIVOT_WIN,
      tz: DAILY_TZ_LABEL,
    }),
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getDivAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "divalert.list.empty"));
  const rows = subs.map((a) => [
    a.id,
    targetLabel(lang, a.coin),
    TF_LABEL[a.tf] || a.tf,
    describeFilters(lang, a),
    t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private"),
  ]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "divalert.list.body", { n: subs.length, max: store.MAX_DIV_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeDivAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "divalert.deleted" : "divalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }) {
  const n = store.clearDivAlerts(senderId);
  await say(sock, jid, msg, t(lang, n ? "divalert.deletedAll" : "divalert.list.empty", { n }));
}

async function runAlertDiv(sock, msg, ctx, args) {
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx);
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const DIVALERT_RUNNERS = { alertdivergent: runAlertDiv };

module.exports = { DIVALERT_COMMANDS, DIVALERT_RUNNERS, parseDivAlertArgs };
