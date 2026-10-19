"use strict";

/**
 * features/kripto/snrAlertCommand.js
 * ------------------------------------------------------------------
 * !alertsnr: alarm titik balik Support/Resistance (reject / tembus), tahap dini + konfirmasi.
 *
 *   !alertsnr btc 4h                      -> reject + tembus di R1/S1, dini + konfirmasi (default)
 *   !alertsnr btc 4h reject               -> hanya reject
 *   !alertsnr eth 1h tembus konfirmasi    -> hanya tembus, hanya setelah candle closed
 *   !alertsnr btc 4h dini                 -> hanya sinyal dini (candle belum closed)
 *   !alertsnr btc 4h kuat                 -> level kuat (>= 5 sentuhan) di R1..R3 / S1..S3
 *   !alertsnr watchlist 1h
 *   !alertsnr list | off | hapus <id|semua>
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * snrAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di snrAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker } = require("./market");
const { COIN_WATCHLIST, TF_LABEL, DAILY_TZ_LABEL } = require("./divAlertCore");
const { SNR, parseSnrArgs, describeSnr } = require("./snrAlertCore");

const SNRALERT_COMMANDS = {
  alertsnr: { re: /^!alertsnr(?:\s+([\s\S]*))?$/i },
};

const parseSnrAlertArgs = (name, raw, defaultTf) => parseSnrArgs(raw, defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const targetLabel = (lang, coin) => (coin === COIN_WATCHLIST ? t(lang, "divalert.target.watch") : coin);

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, kinds, stages, strong } = args;
  if (coin !== COIN_WATCHLIST) await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)

  const entry = store.addSnrAlert(senderId, { chat: jid, coin, tf, kinds, stages, strong });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "snralert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "snralert.full", { max: store.MAX_SNR_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "snralert.chatFull", { max: store.MAX_SNR_ALERTS_PER_CHAT }));

  let note = "";
  if (coin === COIN_WATCHLIST) {
    const n = store.getWatch(senderId).length;
    if (n > SNR.MAX_PAIRS) note = "\n" + t(lang, "snralert.created.bigWatch", { n, max: SNR.MAX_PAIRS });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "snralert.created", {
      id: entry.id,
      target: targetLabel(lang, coin),
      tf: TF_LABEL[tf],
      what: describeSnr(lang, entry),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      buf: SNR.BUFFER_PCT,
      min: Math.max(1, Math.round(SNR.INTERVAL_MS / 60_000)),
      strongMin: SNR.STRONG_MIN_TOUCHES,
      tz: DAILY_TZ_LABEL,
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getSnrAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "snralert.list.empty"));
  const rows = subs.map((a) => [a.id, targetLabel(lang, a.coin), TF_LABEL[a.tf] || a.tf, describeSnr(lang, a), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${r[4]}`).join("\n");
  await say(sock, jid, msg, t(lang, "snralert.list.body", { n: subs.length, max: store.MAX_SNR_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeSnrAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "snralert.deleted" : "snralert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearSnrAlerts(senderId);
  const key = !n ? "snralert.list.empty" : args.viaOff ? "snralert.off.done" : "snralert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runSnrAlert(sock, msg, ctx, args) {
  const { lang, jid } = ctx;
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "noAll":
      return say(sock, jid, msg, t(lang, "snralert.noAll"));
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const SNRALERT_RUNNERS = { alertsnr: withSyncNotice(runSnrAlert) };

module.exports = { SNRALERT_COMMANDS, SNRALERT_RUNNERS, parseSnrAlertArgs };
