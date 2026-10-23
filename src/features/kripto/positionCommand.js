"use strict";

/**
 * features/kripto/positionCommand.js
 * ------------------------------------------------------------------
 * !posisi: catat posisi yang SUDAH kamu buka supaya bot bisa mengirim peringatan WASPADA / CUT.
 *
 *   !posisi buka btc 1h long entry 98200 sl 97150 [tp 99800]
 *   !posisi list
 *   !posisi sl <id> <harga>        geser SL (hanya searah profit; melebarkan SL ditolak)
 *   !posisi tp <id> <harga>        ganti TP (harus di sisi untung dari entry)
 *   !posisi tutup <id|semua>       berhenti memantau (tidak menutup posisi di exchange)
 *
 * TP dan SL juga dipantau berdasarkan HARGA: peringatan saat mendekati, konfirmasi saat tersentuh (positionLevels.js).
 * Posisi didaftarkan MANUAL: bot tidak tahu apakah kamu benar-benar masuk di harga itu. Bot hanya mengirim pesan.
 * Pemeriksaan berkala ada di positionEngine.js; aturan murninya di suddenMove.js (assessPosition).
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");
const { withSyncNotice } = require("./syncNotice");
const { fetchTicker, fetchCandles, fmtLevel } = require("./market");
const { atr: atrSeries } = require("./indicators");
const { TF_MS, TF_LABEL } = require("./divAlertCore");
const { trailStop } = require("./suddenMove");
const { SIGNAL_CONFIG, POSITION_CONFIG: POS } = require("../../config/indicatorConfig");

const POSITION_COMMANDS = {
  posisi: { re: /^!posisi(?:\s+([\s\S]*))?$/i },
};

// =====================================================================
// Parser
// =====================================================================
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const OPEN_TOKENS = new Set(["buka", "open", "add", "baru"]);
const CLOSE_TOKENS = new Set(["tutup", "close", "hapus", "delete", "del", "remove", "rm"]);
const SL_TOKENS = new Set(["sl", "stop", "stoploss"]);
const ALL_TOKENS = new Set(["semua", "all"]);
const DIR_TOKENS = { long: "long", short: "short" };
const ENTRY_TOKENS = new Set(["entry", "masuk"]);
const TP_TOKENS = new Set(["tp", "tp1", "target"]);
const MAX_ENTRY_DEVIATION = 0.5; // entry yang jauh dari harga sekarang > 50% dianggap salah ketik / salah format angka

/** Angka polos dengan titik desimal. Koma dan pemisah ribuan berlapis (1.234.567) ditolak, bukan ditebak. */
function parsePrice(tok) {
  if (typeof tok !== "string" || !/^\d+(\.\d+)?$/.test(tok) || /^\d{1,3}(\.\d{3}){2,}$/.test(tok)) return null;
  const n = Number(tok);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Id boleh "p3" / "P3" / "3". */
function parseId(tok) {
  const m = String(tok || "").toLowerCase().match(/^#?p?(\d{1,6})$/);
  return m ? `p${Number(m[1])}` : null;
}

/** @returns {object|null} null = format salah (-> penjelasan command) */
function parsePositionArgs(name, raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;

  if (CLOSE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    if (ALL_TOKENS.has(tokens[1].toLowerCase())) return { action: "closeAll" };
    const id = parseId(tokens[1]);
    return id ? { action: "close", id } : null;
  }

  if (SL_TOKENS.has(first)) {
    if (tokens.length !== 3) return null;
    const id = parseId(tokens[1]);
    const price = parsePrice(tokens[2]);
    return id && price != null ? { action: "sl", id, price } : null;
  }

  if (TP_TOKENS.has(first)) {
    if (tokens.length !== 3) return null;
    const id = parseId(tokens[1]);
    const price = parsePrice(tokens[2]);
    return id && price != null ? { action: "tp", id, price } : null;
  }

  if (!OPEN_TOKENS.has(first)) return null;
  let coin = null;
  let tf = null;
  let dir = null;
  let entry = null;
  let sl = null;
  let tp = null;
  const rest = tokens.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const low = rest[i].toLowerCase();
    const up = rest[i].toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (DIR_TOKENS[low]) dir = DIR_TOKENS[low];
    else if (ENTRY_TOKENS.has(low) || SL_TOKENS.has(low) || TP_TOKENS.has(low)) {
      const v = parsePrice(rest[++i]);
      if (v == null) return null;
      if (ENTRY_TOKENS.has(low)) entry = v;
      else if (SL_TOKENS.has(low)) sl = v;
      else tp = v;
    } else if (coin == null && COIN_RE.test(up)) coin = up;
    else return null;
  }
  if (!coin || !dir || entry == null || sl == null) return null;
  return { action: "open", coin, tf: tf || defaultTf, dir, entry, sl, tp };
}

// =====================================================================
// Runner
// =====================================================================
const pad = (s, n) => String(s).padEnd(n, " ");
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const isGroup = (chat) => String(chat).endsWith("@g.us");
const fx = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "-");

/** Jarak SL dalam ATR terhadap rentang yang dianjurkan; null bila ATR tidak tersedia. */
async function slAtrDistance(coin, tf, entry, sl) {
  try {
    const candles = await fetchCandles(coin, tf);
    const atr = atrSeries(candles).at(-1);
    return atr > 0 ? Math.abs(entry - sl) / atr : null;
  } catch {
    return null; // peringatan ini opsional; gagal ambil candle tidak menggagalkan pencatatan
  }
}

async function runOpen(sock, msg, { jid, lang, senderId }, a) {
  const { coin, tf, dir, entry, sl } = a;
  const tick = await fetchTicker(coin); // koin tidak ada di Binance -> UnsupportedCoinError (ditangani pemanggil)
  if (Math.abs(entry - tick.price) / tick.price > MAX_ENTRY_DEVIATION) {
    return say(sock, jid, msg, t(lang, "position.entryFar", { entry: fmtLevel(entry), price: fmtLevel(tick.price) }));
  }
  const loss = dir === "long" ? sl < entry : sl > entry;
  if (!loss) return say(sock, jid, msg, t(lang, dir === "long" ? "position.slSide.long" : "position.slSide.short"));
  const risk = Math.abs(entry - sl);
  const s = dir === "long" ? 1 : -1;
  const tp1 = a.tp ?? entry + s * SIGNAL_CONFIG.TP_RR[0] * risk;
  if ((tp1 - entry) * s <= 0) return say(sock, jid, msg, t(lang, "position.tpSide"));
  // TP/SL yang sudah terlewati harga sekarang akan langsung "tercapai": hampir pasti salah ketik.
  if ((tp1 - tick.price) * s <= 0) return say(sock, jid, msg, t(lang, "position.beyond.tp", { level: fmtLevel(tp1), price: fmtLevel(tick.price) }));
  if ((tick.price - sl) * s <= 0) return say(sock, jid, msg, t(lang, "position.beyond.sl", { level: fmtLevel(sl), price: fmtLevel(tick.price) }));

  const added = store.addPosition(senderId, { chat: jid, coin, tf, dir, entry, sl, sl0: sl, tp1 });
  if (added === "exists") return say(sock, jid, msg, t(lang, "position.exists"));
  if (added === "full") return say(sock, jid, msg, t(lang, "position.full", { max: store.MAX_POSITIONS }));
  if (added === "chatFull") return say(sock, jid, msg, t(lang, "position.chatFull", { max: store.MAX_POSITIONS_PER_CHAT }));

  let note = "";
  const dist = await slAtrDistance(coin, tf, entry, sl);
  if (dist != null && (dist < SIGNAL_CONFIG.SL_MIN_ATR || dist > SIGNAL_CONFIG.SL_MAX_ATR)) {
    note = "\n" + t(lang, "position.warn.slDist", { x: fx(dist), min: SIGNAL_CONFIG.SL_MIN_ATR, max: SIGNAL_CONFIG.SL_MAX_ATR });
  }
  await say(
    sock,
    jid,
    msg,
    t(lang, "position.created", {
      id: added.id,
      coin,
      tf: TF_LABEL[tf] || tf,
      dir: dir.toUpperCase(),
      entry: fmtLevel(entry),
      sl: fmtLevel(sl),
      tp1: fmtLevel(tp1),
      riskPct: fx((risk / entry) * 100, 2),
      dest: t(lang, isGroup(jid) ? "divalert.dest.group" : "divalert.dest.private"),
    }) + note,
  );
}

async function runList(sock, msg, { jid, lang, senderId }) {
  const list = store.getPositions(senderId);
  if (!list.length) return say(sock, jid, msg, t(lang, "position.list.empty"));
  const rows = list.map((p) => [p.id, `${p.coin} ${TF_LABEL[p.tf] || p.tf} ${p.dir.toUpperCase()}`, fmtLevel(p.entry), fmtLevel(p.sl), fmtLevel(p.tp1), t(lang, isGroup(p.chat) ? "divalert.where.group" : "divalert.where.private")]);
  const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const table = rows.map((r) => `${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(r[2], w[2])} | ${pad(r[3], w[3])} | ${pad(r[4], w[4])} | ${r[5]}`).join("\n");
  await say(sock, jid, msg, t(lang, "position.list.body", { n: list.length, max: store.MAX_POSITIONS, table: "```\n" + table + "\n```" }));
}

async function runSl(sock, msg, { jid, lang, senderId }, { id, price }) {
  const pos = store.getPositions(senderId).find((p) => p.id === id);
  if (!pos) return say(sock, jid, msg, t(lang, "position.notFound", { id }));
  const next = trailStop(pos.dir, pos.sl, price);
  if (next === pos.sl) {
    // trailStop mengabaikan usulan yang melebarkan SL; usulan yang sama dengan SL sekarang = tidak ada perubahan.
    const key = price === pos.sl ? "position.sl.same" : "position.sl.widen";
    return say(sock, jid, msg, t(lang, key, { id, sl: fmtLevel(pos.sl), asked: fmtLevel(price) }));
  }
  // SL yang sudah terlewati harga sekarang = langsung "tercapai"; tolak. Gagal ambil harga tidak menggagalkan pergeseran.
  const live = await livePrice(pos.coin);
  if (live != null && (live - next) * (pos.dir === "long" ? 1 : -1) <= 0) {
    return say(sock, jid, msg, t(lang, "position.beyond.sl", { level: fmtLevel(next), price: fmtLevel(live) }));
  }
  // SL baru = status lama (CUT/break-even/mendekati/tersentuh) tidak berlaku lagi. `from` dicatat dulu: updatePosition mengubah objek yang sama.
  const from = pos.sl;
  store.updatePosition(senderId, id, { sl: next, cutAt: null, beAt: null, nearSlAt: null, slHitAt: null, slSetAt: Date.now() });
  await say(sock, jid, msg, t(lang, "position.sl.moved", { id, from: fmtLevel(from), to: fmtLevel(next) }));
}

/** Harga terakhir, atau null bila gagal (dipakai sebagai pengaman opsional). */
async function livePrice(coin) {
  try {
    const tick = await fetchTicker(coin);
    return Number.isFinite(tick?.price) ? tick.price : null;
  } catch {
    return null;
  }
}

async function runTp(sock, msg, { jid, lang, senderId }, { id, price }) {
  const pos = store.getPositions(senderId).find((p) => p.id === id);
  if (!pos) return say(sock, jid, msg, t(lang, "position.notFound", { id }));
  const s = pos.dir === "long" ? 1 : -1;
  if ((price - pos.entry) * s <= 0) return say(sock, jid, msg, t(lang, "position.tpSide"));
  if (price === pos.tp1) return say(sock, jid, msg, t(lang, "position.tp.same", { id, tp: fmtLevel(pos.tp1) }));
  const live = await livePrice(pos.coin);
  if (live != null && (price - live) * s <= 0) return say(sock, jid, msg, t(lang, "position.beyond.tp", { level: fmtLevel(price), price: fmtLevel(live) }));
  const from = pos.tp1;
  store.updatePosition(senderId, id, { tp1: price, nearTpAt: null, tpHitAt: null, tpSetAt: Date.now() });
  await say(sock, jid, msg, t(lang, "position.tp.moved", { id, from: fmtLevel(from), to: fmtLevel(price) }));
}

async function runClose(sock, msg, { jid, lang, senderId }, { id }) {
  const ok = store.removePosition(senderId, id);
  await say(sock, jid, msg, t(lang, ok ? "position.closed" : "position.notFound", { id }));
}

async function runCloseAll(sock, msg, { jid, lang, senderId }) {
  const n = store.clearPositions(senderId);
  await say(sock, jid, msg, t(lang, n ? "position.closedAll" : "position.list.empty", { n }));
}

async function runPosition(sock, msg, ctx, args) {
  switch (args.action) {
    case "list":
      return runList(sock, msg, ctx);
    case "sl":
      return runSl(sock, msg, ctx, args);
    case "tp":
      return runTp(sock, msg, ctx, args);
    case "close":
      return runClose(sock, msg, ctx, args);
    case "closeAll":
      return runCloseAll(sock, msg, ctx);
    default:
      return runOpen(sock, msg, ctx, args);
  }
}

const POSITION_RUNNERS = { posisi: withSyncNotice(runPosition) };
const parsePositionCommandArgs = (name, raw, defaultTf) => parsePositionArgs(name, raw, defaultTf);

module.exports = { POSITION_COMMANDS, POSITION_RUNNERS, parsePositionArgs, parsePositionCommandArgs, parsePrice, parseId, POS };
