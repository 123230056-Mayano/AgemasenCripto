"use strict";

/**
 * features/kripto/amdAlertCommand.js
 * ------------------------------------------------------------------
 * !alertamd: alarm Accumulation / Manipulation / Distribution (AMD), dari candle closed. Dua tahap:
 * dini (sweep terdeteksi) dan konfirmasi (break market structure ke arah berlawanan sweep).
 *
 *   !alertamd btc 4h                  -> dua arah (bullish + bearish), dini + konfirmasi
 *   !alertamd btc 4h naik             -> hanya sweep bawah yang berbalik naik
 *   !alertamd eth 1h turun konfirmasi -> hanya konfirmasi bearish
 *   !alertamd sol 1h dini             -> hanya tanda awal (sweep)
 *   !alertamd watchlist 1h
 *   !alertamd list | off | hapus <id|semua>
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * amdAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di amdAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker } = require("./market");
const { COIN_WATCHLIST, TF_LABEL, DAILY_TZ_LABEL } = require("./divAlertCore");
const { parseAmdArgs, describeAmd } = require("./amdAlertCore");
const { AMD_ALERT_CONFIG: HA } = require("../../config/indicatorConfig");

const AMDALERT_COMMANDS = {
  alertamd: { re: /^!alertamd(?:\s+([\s\S]*))?$/i },
};

const parseAmdAlertArgs = (name, raw, defaultTf) => parseAmdArgs(raw, defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const targetLabel = (lang, coin) => (coin === COIN_WATCHLIST ? t(lang, "divalert.target.watch") : coin);

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, dirs, stages } = args;
  if (coin !== COIN_WATCHLIST) await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)

  const entry = store.addAmdAlert(senderId, { chat: jid, coin, tf, dirs, stages });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "amdalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "amdalert.full", { max: store.MAX_AMD_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "amdalert.chatFull", { max: store.MAX_AMD_ALERTS_PER_CHAT }));

  let note = "";
  if (coin === COIN_WATCHLIST) {
    const n = store.getWatch(senderId).length;
    if (n > HA.MAX_PAIRS) note = "\n" + t(lang, "amdalert.created.bigWatch", { n, max: HA.MAX_PAIRS });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "amdalert.created", {
      id: entry.id,
      target: targetLabel(lang, coin),
      tf: TF_LABEL[tf],
      what: describeAmd(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      tz: DAILY_TZ_LABEL,
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getAmdAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "amdalert.list.empty"));
  const rows = subs.map((a) => [a.id, targetLabel(lang, a.coin), TF_LABEL[a.tf] || a.tf, describeAmd(lang, a), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "amdalert.list.body", { n: subs.length, max: store.MAX_AMD_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeAmdAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "amdalert.deleted" : "amdalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearAmdAlerts(senderId);
  const key = !n ? "amdalert.list.empty" : args.viaOff ? "amdalert.off.done" : "amdalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runAmdAlert(sock, msg, ctx, args) {
  const { lang, jid } = ctx;
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "noAll":
      return say(sock, jid, msg, t(lang, "amdalert.noAll"));
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const AMDALERT_RUNNERS = { alertamd: withSyncNotice(runAmdAlert) };

module.exports = { AMDALERT_COMMANDS, AMDALERT_RUNNERS, parseAmdAlertArgs };
