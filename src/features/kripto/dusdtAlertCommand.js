"use strict";

/**
 * features/kripto/dusdtAlertCommand.js
 * ------------------------------------------------------------------
 * !alertdusdt: alarm saat USDT.D (USDT Dominance, sama dengan !dusdt) MASUK ke golden zone Fibonacci 0.5-0.618.
 *
 *   !alertdusdt 4h                 -> alarm timeframe 4H
 *   !alertdusdt 1d
 *   !alertdusdt list | off | hapus <id|semua>
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan dan pengiriman ada di
 * dusdtAlertEngine.js (dijalankan alertMonitor.js); aturan murninya di dusdtAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { TF_LABEL, DAILY_TZ_LABEL } = require("./divAlertCore");
const { getDusdt } = require("./dusdt");
const { depthOf, goldenZone, swingKey, stepZone, parseDusdtAlertArgs: parseCore, describeDusdtAlert } = require("./dusdtAlertCore");

const DUSDTALERT_COMMANDS = {
  alertdusdt: { re: /^!alertdusdt(?:\s+([\s\S]*))?$/i },
};

const parseDusdtAlertArgs = (name, raw, defaultTf) => parseCore(raw, defaultTf);

const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const fmtDom = (v) => `${v.toFixed(3)}%`;

/**
 * Posisi USDT.D terhadap golden zone saat alarm dibuat. Sekaligus menanam status awal supaya kondisi yang
 * sudah ada tidak diumumkan. Data gagal diambil -> null (status ditanam mesin pada pengecekan pertama).
 */
async function currentStatus(lang, entry) {
  let r = null;
  try {
    r = await getDusdt(entry.tf);
  } catch (err) {
    console.log("[dusdtalert] status awal gagal:", err.message);
  }
  if (!r || r.stale || !r.fib) return t(lang, "dusdtalert.status.na");
  const depth = depthOf(r.fib, r.level);
  if (depth == null) return t(lang, "dusdtalert.status.na");

  const step = stepZone({ prevInZone: null, prevSwing: null, depth, swing: swingKey(r.fib, r.candles) });
  entry.inZone = step.inZone;
  entry.swing = step.swing;
  store.persist();

  const zone = goldenZone(r.fib);
  return t(lang, step.inZone ? "dusdtalert.status.in" : "dusdtalert.status.out", {
    level: fmtDom(r.level),
    min: fmtDom(zone.min),
    max: fmtDom(zone.max),
  });
}

async function runCreate(sock, msg, { jid, lang, senderId }, { tf }) {
  const entry = store.addDusdtAlert(senderId, { chat: jid, tf });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "dusdtalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "dusdtalert.full", { max: store.MAX_DUSDT_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "dusdtalert.chatFull", { max: store.MAX_DUSDT_ALERTS_PER_CHAT }));

  const status = await currentStatus(lang, entry);
  await say(
    sock,
    jid,
    msg,
    t(lang, "dusdtalert.created", {
      id: entry.id,
      tf: TF_LABEL[tf],
      what: describeDusdtAlert(lang),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
      status,
      tz: DAILY_TZ_LABEL,
    }),
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const subs = store.getDusdtAlerts(senderId);
  if (!subs.length) return say(sock, jid, msg, t(lang, "dusdtalert.list.empty"));
  const rows = subs.map((a) => [a.id, TF_LABEL[a.tf] || a.tf, describeDusdtAlert(lang), t(lang, isGroup(a.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${r[3]}`).join("\n");
  await say(sock, jid, msg, t(lang, "dusdtalert.list.body", { n: subs.length, max: store.MAX_DUSDT_ALERTS, table: "```\n" + table + "\n```" }));
}

async function runDelete(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removeDusdtAlert(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "dusdtalert.deleted" : "dusdtalert.notFound", { id }));
}

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearDusdtAlerts(senderId);
  const key = !n ? "dusdtalert.list.empty" : args.viaOff ? "dusdtalert.off.done" : "dusdtalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runDusdtAlert(sock, msg, ctx, args) {
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const DUSDTALERT_RUNNERS = { alertdusdt: withSyncNotice(runDusdtAlert) };

module.exports = { DUSDTALERT_COMMANDS, DUSDTALERT_RUNNERS, parseDusdtAlertArgs };
