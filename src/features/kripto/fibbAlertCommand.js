"use strict";

/**
 * features/kripto/fibbAlertCommand.js
 * ------------------------------------------------------------------
 * !alertfibb: alarm Fibo + Bollinger (BUY / SELL area baru di candle closed).
 *
 *   !alertfibb btc 1h                 -> BUY + SELL, zona retracement 0.382 - 0.786
 *   !alertfibb eth 4h buy             -> hanya BUY area
 *   !alertfibb sol 15m sell golden    -> hanya SELL, hanya golden zone 0.5 - 0.618
 *   !alertfibb btc 4h kuat            -> wajib konfluens (level fib berimpit dengan pita Bollinger)
 *   !alertfibb watchlist 1h
 *   !alertfibb list | off | hapus <id|semua>
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * fibbAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di fibbCore.js. Kripto saja.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker } = require("./market");
const { COIN_WATCHLIST, TF_LABEL, DAILY_TZ_LABEL } = require("./divAlertCore");
const { ACFG, CFG, parseFibbAlertArgs: parseCore, describeFibbAlert } = require("./fibbCore");

const FIBBALERT_COMMANDS = {
  alertfibb: { re: /^!alertfibb(?:\s+([\s\S]*))?$/i },
};

const parseFibbAlertArgs = (name, raw, defaultTf) => parseCore(raw, defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const targetLabel = (lang, coin) => (coin === COIN_WATCHLIST ? t(lang, "divalert.target.watch") : coin);

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, dirs, zone, strong } = args;
  if (coin !== COIN_WATCHLIST) await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)

  const entry = store.addFibbAlert(senderId, { chat: jid, coin, tf, dirs, zone, strong });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "fibbalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "fibbalert.full", { max: store.MAX_FIBB_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "fibbalert.chatFull", { max: store.MAX_FIBB_ALERTS_PER_CHAT }));

  let note = "";
  if (coin === COIN_WATCHLIST) {
    const n = store.getWatch(senderId).length;
    if (n > ACFG.MAX_PAIRS) note = "\n" + t(lang, "fibbalert.created.bigWatch", { n, max: ACFG.MAX_PAIRS });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "fibbalert.created", {
      id: entry.id,
      target: targetLabel(lang, coin),
      tf: TF_LABEL[tf],
      what: describeFibbAlert(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      bb: `${CFG.BB_PERIOD}, ${CFG.BB_K}`,
      tz: DAILY_TZ_LABEL,
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getFibbAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "fibbalert.list.empty"));
  const rows = subs.map((a) => [a.id, targetLabel(lang, a.coin), TF_LABEL[a.tf] || a.tf, describeFibbAlert(lang, a), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "fibbalert.list.body", { n: subs.length, max: store.MAX_FIBB_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeFibbAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "fibbalert.deleted" : "fibbalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearFibbAlerts(senderId);
  const key = !n ? "fibbalert.list.empty" : args.viaOff ? "fibbalert.off.done" : "fibbalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runFibbAlert(sock, msg, ctx, args) {
  const { lang, jid } = ctx;
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "noAll":
      return say(sock, jid, msg, t(lang, "fibbalert.noAll"));
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const FIBBALERT_RUNNERS = { alertfibb: withSyncNotice(runFibbAlert) };

module.exports = { FIBBALERT_COMMANDS, FIBBALERT_RUNNERS, parseFibbAlertArgs };
