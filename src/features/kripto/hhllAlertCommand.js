"use strict";

/**
 * features/kripto/hhllAlertCommand.js
 * ------------------------------------------------------------------
 * !alerthhll: alarm Higher High / Lower Low (market structure), dari candle closed.
 *
 *   !alerthhll btc 4h                  -> kabari saat struktur mulai naik (HL baru) dan saat close menembus swing high
 *   !alerthhll btc 4h naik turun       -> dua arah
 *   !alerthhll eth 1h konfirmasi       -> hanya saat close sudah menembus
 *   !alerthhll sol 1h dini             -> hanya tanda awal (HL baru / LH baru)
 *   !alerthhll watchlist 1h balik      -> hanya yang berbalik arah (bukan lanjutan tren)
 *   !alerthhll list | off | hapus <id|semua>
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * hhllAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di hhllAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker } = require("./market");
const { COIN_WATCHLIST, TF_LABEL, DAILY_TZ_LABEL } = require("./divAlertCore");
const { parseHhllArgs, describeHhll } = require("./hhllAlertCore");
const { HHLL_ALERT_CONFIG: HA } = require("../../config/indicatorConfig");

const HHLLALERT_COMMANDS = {
  alerthhll: { re: /^!alerthhll(?:\s+([\s\S]*))?$/i },
};

const parseHhllAlertArgs = (name, raw, defaultTf) => parseHhllArgs(raw, defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const targetLabel = (lang, coin) => (coin === COIN_WATCHLIST ? t(lang, "divalert.target.watch") : coin);

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, dirs, stages, flipOnly } = args;
  if (coin !== COIN_WATCHLIST) await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)

  const entry = store.addHhllAlert(senderId, { chat: jid, coin, tf, dirs, stages, flipOnly });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "hhllalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "hhllalert.full", { max: store.MAX_HHLL_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "hhllalert.chatFull", { max: store.MAX_HHLL_ALERTS_PER_CHAT }));

  let note = "";
  if (coin === COIN_WATCHLIST) {
    const n = store.getWatch(senderId).length;
    if (n > HA.MAX_PAIRS) note = "\n" + t(lang, "hhllalert.created.bigWatch", { n, max: HA.MAX_PAIRS });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "hhllalert.created", {
      id: entry.id,
      target: targetLabel(lang, coin),
      tf: TF_LABEL[tf],
      what: describeHhll(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      tz: DAILY_TZ_LABEL,
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getHhllAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "hhllalert.list.empty"));
  const rows = subs.map((a) => [a.id, targetLabel(lang, a.coin), TF_LABEL[a.tf] || a.tf, describeHhll(lang, a), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "hhllalert.list.body", { n: subs.length, max: store.MAX_HHLL_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeHhllAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "hhllalert.deleted" : "hhllalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearHhllAlerts(senderId);
  const key = !n ? "hhllalert.list.empty" : args.viaOff ? "hhllalert.off.done" : "hhllalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runHhllAlert(sock, msg, ctx, args) {
  const { lang, jid } = ctx;
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "noAll":
      return say(sock, jid, msg, t(lang, "hhllalert.noAll"));
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const HHLLALERT_RUNNERS = { alerthhll: withSyncNotice(runHhllAlert) };

module.exports = { HHLLALERT_COMMANDS, HHLLALERT_RUNNERS, parseHhllAlertArgs };
