"use strict";

/**
 * features/kripto/kriptoCommand.js
 * ------------------------------------------------------------------
 * Command analisis dasar yang melengkapi !analisis:
 *   !chart <koin> [tf]   -> gambar candlestick + EMA 20/50/200 + garis S/R
 *   !harga <koin>        -> harga live USDT + Rupiah + % perubahan 24 jam
 *   !level <koin> [tf]   -> R1/R2/S1/S2 + jarak % dari harga sekarang
 *
 * [tf] = 15m | 1H | 4H | 1D; kosong -> default pengguna (awal 4H).
 */

const { t } = require("../../i18n");
const { sendCommandDetail } = require("../menu/menu");
const { getSenderJid } = require("../../utils/whatsapp");
const { renderChart } = require("../analisis/analisisChart");
const { getDefaultTf } = require("./defaultTf");
const {
  TIMEFRAMES,
  TF_LABEL,
  UnsupportedCoinError,
  fetchTicker,
  fetchCandles,
  fetchUsdIdr,
  computeLevels,
  fmtUsd,
  fmtIdr,
  fmtLevel,
  fmtPct,
  pctFrom,
} = require("./market");

const COOLDOWN_MS = 5_000;
const lastRequestAt = new Map(); // sender -> timestamp
const inFlight = new Set();

const COMMANDS = {
  chart: { re: /^!chart(?:\s+([\s\S]*))?$/i, useTf: true },
  harga: { re: /^!(?:harga|price)(?:\s+([\s\S]*))?$/i, useTf: false },
  level: { re: /^!(?:level|levels)(?:\s+([\s\S]*))?$/i, useTf: true },
};

/** "sol 4h" -> { coin: "SOL", tf: "4H" | null }. null kalau format salah. */
function parseArgs(raw, { useTf }) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let coin = null;
  let tf = null;
  for (const tok of tokens) {
    const up = tok.toUpperCase();
    if (useTf && TIMEFRAMES[up]) tf = up;
    else if (!coin && /^[A-Z0-9]{1,15}$/.test(up)) coin = up;
    else return null;
  }
  return coin ? { coin, tf } : null;
}

async function runHarga(sock, msg, { jid, lang }, { coin }) {
  const [tick, rate] = await Promise.all([fetchTicker(coin), fetchUsdIdr()]);
  const parts = [`${coin}/USDT ${fmtUsd(tick.price)}`];
  if (rate) parts.push(fmtIdr(tick.price * rate));
  parts.push(fmtPct(tick.changePct));
  await sock.sendMessage(jid, { text: parts.join(" | ") }, { quoted: msg });
}

async function runChart(sock, msg, { jid, lang }, { coin, tf }) {
  const [candles, tick] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin)]);
  const { resistance, support } = computeLevels(candles, tick.price);
  const png = renderChart({ candles, coin, tf: TF_LABEL[tf], resistance, support });
  await sock.sendMessage(
    jid,
    {
      image: png,
      caption: t(lang, "kripto.chart.caption", {
        coin,
        tf: TF_LABEL[tf],
        price: fmtUsd(tick.price),
        change: fmtPct(tick.changePct),
      }),
    },
    { quoted: msg },
  );
}

async function runLevel(sock, msg, { jid, lang }, { coin, tf }) {
  const [candles, tick] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin)]);
  const { resistance, support } = computeLevels(candles, tick.price);
  const line = (label, v) => (v == null ? `${label} -` : `${label} ${fmtLevel(v)} (${fmtPct(pctFrom(tick.price, v))})`);
  const rows = [
    line("🔴 R1", resistance[0]),
    line("🔴 R2", resistance[1]),
    line("🟢 S1", support[0]),
    line("🟢 S2", support[1]),
  ];
  await sock.sendMessage(
    jid,
    {
      text: t(lang, "kripto.level.body", {
        coin,
        tf: TF_LABEL[tf],
        price: fmtUsd(tick.price),
        rows: rows.join("\n"),
      }),
    },
    { quoted: msg },
  );
}

const RUNNERS = { chart: runChart, harga: runHarga, level: runLevel };

/**
 * @returns {Promise<boolean>} true kalau pesan ini salah satu command kripto dasar.
 */
async function handleKriptoCommand(sock, msg, { jid, text, lang }) {
  let name = null;
  let match = null;
  for (const [key, def] of Object.entries(COMMANDS)) {
    const m = text.match(def.re);
    if (m) {
      name = key;
      match = m;
      break;
    }
  }
  if (!name) return false;

  const args = parseArgs(match[1] || "", COMMANDS[name]);
  if (!args) {
    await sendCommandDetail(sock, jid, name, lang);
    return true;
  }

  const senderId = getSenderJid(msg) || jid;
  if (inFlight.has(senderId)) {
    await sock.sendMessage(jid, { text: t(lang, "kripto.busy") });
    return true;
  }
  const wait = COOLDOWN_MS - (Date.now() - (lastRequestAt.get(senderId) || 0));
  if (wait > 0) {
    await sock.sendMessage(jid, { text: t(lang, "kripto.cooldown", { sec: Math.ceil(wait / 1000) }) });
    return true;
  }

  inFlight.add(senderId);
  lastRequestAt.set(senderId, Date.now());
  try {
    const tf = args.tf || getDefaultTf(senderId);
    await RUNNERS[name](sock, msg, { jid, lang }, { coin: args.coin, tf });
  } catch (err) {
    console.log(`[kripto] !${name} gagal:`, err.message);
    let key = "kripto.fail";
    let params = {};
    if (err instanceof UnsupportedCoinError) {
      key = "kripto.unsupported";
      params = { coin: args.coin };
    } else if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") key = "kripto.timeout";
    await sock.sendMessage(jid, { text: t(lang, key, params) });
  } finally {
    inFlight.delete(senderId);
  }
  return true;
}

module.exports = { handleKriptoCommand, parseArgs };
