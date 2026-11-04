"use strict";

/**
 * features/kripto/farleyAlertCommand.js
 * ------------------------------------------------------------------
 * !alertfarley: alarm skenario Farley (BUY / SELL baru di candle closed).
 *
 *   !alertfarley btc 1h                 -> BUY + SELL
 *   !alertfarley eth 4h buy             -> hanya BUY
 *   !alertfarley sol 15m sell           -> hanya SELL
 *   !alertfarley eurusd 1h              -> FOREX (juga eur/usd, xauusd; alias !alertfxfarley)
 *   !alertfarley major 1h               -> SEMUA pair mayor (juga: cross, exotic, logam/emas, forex = semua pair)
 *   !alertfarley watchlist 1h
 *   !alertfarley list | off | hapus <id|semua>
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * farleyAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di farleyAlertCore.js. Kripto dan forex (pair dikenali otomatis;
 * TF 15m ditolak untuk USDIDR; saat pasar tutup tidak ada kiriman). Kategori forex (major/cross/exotic/logam/forex) = satu langganan
 * yang memantau semua pair kategori itu (engine menguraikannya per pair). Watchlist hanya kripto.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker } = require("./market");
const { resolvePair, normalizePairText, allowedTfs, isCategoryTarget, categoryOfTarget, pairsOfTarget } = require("../forex/forexPairs");
const { COIN_WATCHLIST, TF_LABEL, DAILY_TZ_LABEL } = require("./divAlertCore");
const { CFG, parseFarleyAlertArgs: parseCore, describeFarleyAlert } = require("./farleyAlertCore");

const FARLEYALERT_COMMANDS = {
  alertfarley: { re: /^!(?:alertfarley|alertfxfarley)(?:\s+([\s\S]*))?$/i },
};

// "eur/usd" -> "eurusd" (pair forex; parser koin menolak karakter "/")
const parseFarleyAlertArgs = (name, raw, defaultTf) => parseCore(normalizePairText(raw), defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
/** Label target: koin/pair apa adanya, watchlist, atau kategori forex ("Forex Mayor (7 pair)"; n menyesuaikan TF bila diberikan). */
function targetLabel(lang, coin, tf = null) {
  if (coin === COIN_WATCHLIST) return t(lang, "divalert.target.watch");
  if (!isCategoryTarget(coin)) return coin;
  const cat = categoryOfTarget(coin);
  const n = pairsOfTarget(coin, tf).length;
  return cat === "all" ? t(lang, "farleyalert.target.all", { n }) : t(lang, "farleyalert.target.cat", { cat: t(lang, `forex.list.cat.${cat}`), n });
}

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, dirs } = args;
  const isCat = isCategoryTarget(coin);
  const pair = coin === COIN_WATCHLIST || isCat ? null : resolvePair(coin);
  const catPairs = isCat ? pairsOfTarget(coin, tf) : [];
  if (isCat) {
    // Kategori forex: pair yang tidak mendukung TF ini dilewati (USDIDR di 15m); data Yahoo dicek lewat satu pair (gagal -> FOREX_DATA, ditangani pemanggil).
    if (!catPairs.length) return say(sock, jid, msg, t(lang, "farley.fx.tfNotAllowed", { pair: t(lang, `forex.list.cat.${categoryOfTarget(coin)}`) }));
    await require("../forex/forexMarket").loadTicker(catPairs[0]);
  } else if (pair) {
    // Forex: TF yang tidak didukung ditolak (USDIDR mulai 1H); data Yahoo dicek dulu (gagal -> FOREX_DATA, ditangani pemanggil).
    if (!allowedTfs(pair).includes(tf)) return say(sock, jid, msg, t(lang, "farley.fx.tfNotAllowed", { pair }));
    await require("../forex/forexMarket").loadTicker(pair);
  } else if (coin !== COIN_WATCHLIST) await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)

  const entry = store.addFarleyAlert(senderId, { chat: jid, coin, tf, dirs });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "farleyalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "farleyalert.full", { max: store.MAX_FARLEY_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "farleyalert.chatFull", { max: store.MAX_FARLEY_ALERTS_PER_CHAT }));

  let note = "";
  if (pair) note = "\n" + t(lang, "farleyalert.created.fx");
  if (isCat) {
    note = "\n" + t(lang, "farleyalert.created.fx") + "\n" + t(lang, "farleyalert.created.cat", { pairs: catPairs.join(", ") });
    const skipped = pairsOfTarget(coin).filter((p) => !catPairs.includes(p));
    if (skipped.length) note += "\n" + t(lang, "farleyalert.created.catSkip", { skipped: skipped.join(", "), tf: TF_LABEL[tf] });
  }
  if (coin === COIN_WATCHLIST) {
    const n = store.getWatch(senderId).length;
    if (n > CFG.MAX_PAIRS) note = "\n" + t(lang, "farleyalert.created.bigWatch", { n, max: CFG.MAX_PAIRS });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "farleyalert.created", {
      id: entry.id,
      target: targetLabel(lang, coin, tf),
      tf: TF_LABEL[tf],
      what: describeFarleyAlert(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      tz: DAILY_TZ_LABEL,
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getFarleyAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "farleyalert.list.empty"));
  const rows = subs.map((a) => [a.id, targetLabel(lang, a.coin, a.tf), TF_LABEL[a.tf] || a.tf, describeFarleyAlert(lang, a), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "farleyalert.list.body", { n: subs.length, max: store.MAX_FARLEY_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeFarleyAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "farleyalert.deleted" : "farleyalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearFarleyAlerts(senderId);
  const key = !n ? "farleyalert.list.empty" : args.viaOff ? "farleyalert.off.done" : "farleyalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runFarleyAlert(sock, msg, ctx, args) {
  const { lang, jid } = ctx;
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "noAll":
      return say(sock, jid, msg, t(lang, "farleyalert.noAll"));
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const FARLEYALERT_RUNNERS = { alertfarley: withSyncNotice(runFarleyAlert) };

module.exports = { FARLEYALERT_COMMANDS, FARLEYALERT_RUNNERS, parseFarleyAlertArgs };
