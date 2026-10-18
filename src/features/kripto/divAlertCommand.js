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
 *   !alertdiv btc 4h dini           -> tambah sinyal DINI (pivot belum penuh terkonfirmasi, berlabel "dini"); default mati
 *   !alertdiv on [tf] [rsi|macd]    -> jalan pintas: semua koin (1H/4H/1D) + watchlist untuk 15m
 *   !alertdiv off                   -> matikan semua alarm saya (sama dengan hapus semua)
 *   !alertdiv list                  -> alarm milik saya
 *   !alertdiv hapus <id>            -> hapus satu alarm
 *   !alertdiv hapus semua           -> hapus semua alarm saya
 *
 * Hanya membuat/melihat/menghapus langganan (state/cryptoStore.js). Pemeriksaan candle closed
 * dan pengiriman alarm (PDF gabungan per penutupan candle) ada di alertMonitor.js; logika murninya di divAlertCore.js.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { DIV } = require("./divergence");
const { fetchTicker } = require("./market");
const {
  TF_LABEL,
  TF_ORDER,
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

/**
 * Kalau ini satu-satunya alarm di TF tsb, mulai dari candle closed terakhir (tidak mengejar candle yang sudah lewat).
 * Kalau sudah ada alarm lain di TF itu, penanda yang dikelola monitor tidak disentuh.
 */
function armLastClosed(tf) {
  const activeInTf = store.allDivAlerts().filter((x) => x.sub.tf === tf).length;
  if (activeInTf <= 1 || !store.hasLastClosed(tf)) store.setLastClosed(tf, lastClosedBoundary(tf, Date.now()));
}

async function runCreate(sock, msg, { jid, lang, senderId }, args) {
  const { coin, tf, indicators, dirs, kinds, early } = args;

  if (coin === COIN_ALL && !ALL_COINS_TFS.includes(tf)) {
    await say(sock, jid, msg, t(lang, "divalert.allTf", { tfs: ALL_COINS_TFS.map((x) => TF_LABEL[x]).join(", ") }));
    return;
  }
  // Koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil, sama dengan !watch).
  if (coin !== COIN_ALL && coin !== COIN_WATCHLIST) await fetchTicker(coin);

  const entry = store.addDivAlert(senderId, { chat: jid, coin, tf, indicators, dirs, kinds, early: !!early });
  if (entry === "exists") return say(sock, jid, msg, t(lang, "divalert.exists"));
  if (entry === "full") return say(sock, jid, msg, t(lang, "divalert.full", { max: store.MAX_DIV_ALERTS }));
  if (entry === "chatFull") return say(sock, jid, msg, t(lang, "divalert.chatFull", { max: store.MAX_DIV_ALERTS_PER_CHAT }));

  armLastClosed(tf);

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
      win: DIV.PIVOT_RIGHT,
      tz: DAILY_TZ_LABEL,
    }) + (early ? "\n\n" + t(lang, "divalert.created.early", { win: DIV.PIVOT_RIGHT }) : ""),
  );
}

/**
 * !alertdiv on [tf] [rsi|macd] [bull|bear] [reguler|tersembunyi]
 * Jalan pintas menyalakan alarm untuk SEMUA koin. Tanpa [tf] = keempat TF: 1H/4H/1D untuk semua koin, sedangkan
 * 15m hanya untuk watchlist (semua koin di 15m terlalu berat, lihat ALL_COINS_TFS). Memakai addDivAlert yang sama
 * dengan sintaks langganan, jadi batas alarm dan dedupe tidak berubah.
 */
async function runOn(sock, msg, { jid, lang, senderId }, args) {
  const { tf, indicators, dirs, kinds, early } = args;
  const tfs = tf ? [tf] : [...TF_ORDER].reverse(); // 15M, 1H, 4H, 1D (urutan tampil sama seperti menu)
  const created = [];
  let skipped = 0;
  let full = null;
  for (const x of tfs) {
    const coin = ALL_COINS_TFS.includes(x) ? COIN_ALL : COIN_WATCHLIST;
    const entry = store.addDivAlert(senderId, { chat: jid, coin, tf: x, indicators, dirs, kinds, early: !!early });
    if (typeof entry === "string") {
      skipped++;
      if (entry !== "exists") full = entry;
      continue;
    }
    armLastClosed(x);
    created.push(entry);
  }
  if (!created.length) {
    if (full === "full") return say(sock, jid, msg, t(lang, "divalert.full", { max: store.MAX_DIV_ALERTS }));
    if (full === "chatFull") return say(sock, jid, msg, t(lang, "divalert.chatFull", { max: store.MAX_DIV_ALERTS_PER_CHAT }));
    return say(sock, jid, msg, t(lang, "divalert.exists"));
  }
  const lines = created.map((a) => t(lang, "divalert.on.line", { target: targetLabel(lang, a.coin), tf: TF_LABEL[a.tf], filters: describeFilters(lang, a) })).join("\n");
  const text =
    t(lang, "divalert.on.created", { lines, dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private") }) +
    (skipped ? "\n" + t(lang, "divalert.on.skipped", { n: skipped }) : "");
  await say(sock, jid, msg, text);
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

async function runDeleteAll(sock, msg, { jid, lang, senderId }, args = {}) {
  const n = store.clearDivAlerts(senderId);
  const key = !n ? "divalert.list.empty" : args.viaOff ? "divalert.off.done" : "divalert.deletedAll";
  await say(sock, jid, msg, t(lang, key, { n }));
}

async function runAlertDiv(sock, msg, ctx, args) {
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "delete":
      return runDelete(sock, msg, ctx, args);
    case "deleteAll":
      return runDeleteAll(sock, msg, ctx, args);
    case "on":
      return runOn(sock, msg, ctx, args);
    default:
      return runCreate(sock, msg, ctx, args);
  }
}

const DIVALERT_RUNNERS = { alertdivergent: withSyncNotice(runAlertDiv) };

module.exports = { DIVALERT_COMMANDS, DIVALERT_RUNNERS, parseDivAlertArgs };
