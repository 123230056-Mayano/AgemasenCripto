"use strict";

/**
 * features/kripto/advAlertCommand.js
 * ------------------------------------------------------------------
 * !alertindikator (alias !alertind, !alertindicator): alarm indikator lanjutan (item 10).
 *
 *   !alertind btc 4h                 -> bias berubah + crossover baru, BTC 4H, tiap candle closed (default)
 *   !alertind btc 1h bias            -> hanya bias berubah
 *   !alertind eth 4h cross           -> hanya crossover baru (EMA 20/50 dan 50/200)
 *   !alertind watchlist 1h           -> semua koin di watchlist kamu
 *   !alertind btc 15m live           -> mode LIVE: dihitung berkala dengan candle yang BELUM closed (ditandai di pesan)
 *   !alertind list | off | hapus <id|semua>
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * advAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di advAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker } = require("./market");
const { COIN_WATCHLIST, TF_LABEL, DAILY_TZ_LABEL, lastClosedBoundary } = require("./divAlertCore");
const { ADV, parseAdvArgs, describeAdv } = require("./advAlertCore");

const ADVALERT_COMMANDS = {
  alertind: { re: /^!alertind(?:ikator|icator)?(?:\s+([\s\S]*))?$/i },
};

const parseAdvAlertArgs = (name, raw, defaultTf) => parseAdvArgs(raw, defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const targetLabel = (lang, coin) => (coin === COIN_WATCHLIST ? t(lang, "divalert.target.watch") : coin);

/** Penanda candle closed terakhir per TF memakai kunci "adv:<TF>", terpisah dari alarm divergence. */
function armLastClosed(tf) {
  const key = `adv:${tf}`;
  const activeInTf = store.allAdvAlerts().filter((x) => x.sub.tf === tf && x.sub.mode !== "live").length;
  if (activeInTf <= 1 || !store.hasLastClosed(key)) store.setLastClosed(key, lastClosedBoundary(tf, Date.now()));
}

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, types, mode } = args;
  if (coin !== COIN_WATCHLIST) await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)

  const entry = store.addAdvAlert(senderId, { chat: jid, coin, tf, types, mode });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "advalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "advalert.full", { max: store.MAX_ADV_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "advalert.chatFull", { max: store.MAX_ADV_ALERTS_PER_CHAT }));
  if (mode !== "live") armLastClosed(tf);

  const live = mode === "live";
  let note = "";
  if (live && coin === COIN_WATCHLIST) {
    const n = store.getWatch(senderId).length;
    if (n > ADV.LIVE_MAX_PAIRS) note = "\n" + t(lang, "advalert.created.bigWatch", { n, max: ADV.LIVE_MAX_PAIRS });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, live ? "advalert.created.live" : "advalert.created.closed", {
      id: entry.id,
      target: targetLabel(lang, coin),
      tf: TF_LABEL[tf],
      what: describeAdv(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      min: Math.round(ADV.LIVE_INTERVAL_MS / 60_000),
      confirm: ADV.LIVE_CONFIRM,
      cool: Math.round(ADV.COOLDOWN_LIVE_MS / 60_000),
      delay: Math.round(require("./divAlertCore").ALERT_DIV.DELAY_MS / 1000),
      tz: DAILY_TZ_LABEL,
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getAdvAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "advalert.list.empty"));
  const rows = subs.map((a) => [a.id, targetLabel(lang, a.coin), TF_LABEL[a.tf] || a.tf, describeAdv(lang, a), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "advalert.list.body", { n: subs.length, max: store.MAX_ADV_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeAdvAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "advalert.deleted" : "advalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearAdvAlerts(senderId);
  const key = !n ? "advalert.list.empty" : args.viaOff ? "advalert.off.done" : "advalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runAdvAlert(sock, msg, ctx, args) {
  const { lang, jid } = ctx;
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "div":
      return say(sock, jid, msg, t(lang, "advalert.useAlertDiv"));
    case "noAll":
      return say(sock, jid, msg, t(lang, "advalert.noAll"));
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const ADVALERT_RUNNERS = { alertind: withSyncNotice(runAdvAlert) };

module.exports = { ADVALERT_COMMANDS, ADVALERT_RUNNERS, parseAdvAlertArgs };
