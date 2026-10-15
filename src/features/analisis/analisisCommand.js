"use strict";

/**
 * features/analisis/analisisCommand.js
 * ------------------------------------------------------------------
 * Command "!analisis <koin> [15m|1H|4H|1D]" (alias "!analysis").
 *
 * Alur:
 *   1. Parse argumen (koin + timeframe, default 4H).
 *   2. POST ke web KriptoPredict  -> {ANALYST_URL}/api/analyze
 *      (+ GET /api/fx buat kurs Rupiah, opsional).
 *   3. Render hasilnya jadi PDF (analisisPdf.js) lalu kirim sebagai dokumen.
 *
 * Validasi koin/timeframe dilakukan oleh web-nya sendiri, jadi daftar
 * koin gak perlu di-hardcode lagi di bot.
 *
 * Env: ANALYST_URL = alamat web analyst, mis. https://kriptopredict.up.railway.app
 */

const axios = require("axios");
const { t } = require("../../i18n");
const { ANALYST_URL } = require("../../config/env");
const { sendCommandDetail } = require("../menu/menu");
const { getSenderJid } = require("../../utils/whatsapp");
const { buildAnalysisPdf, fmtUsd } = require("./analisisPdf");

const TIMEFRAMES = ["15M", "1H", "4H", "1D"];
const DEFAULT_TF = "4H";
const ANALYZE_TIMEOUT_MS = 70_000; // Gemini di server timeout 40 dtk + fetch data
const COOLDOWN_MS = 30_000;

const lastRequestAt = new Map(); // sender -> timestamp
const inFlight = new Set();

function parseArgs(raw) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let coin = null;
  let tf = DEFAULT_TF;
  for (const tok of tokens) {
    const up = tok.toUpperCase();
    if (TIMEFRAMES.includes(up)) tf = up;
    else if (!coin && /^[A-Z0-9]{1,15}$/.test(up)) coin = up;
    else return null; // token asing -> format salah
  }
  return coin ? { coin, tf } : null;
}

function baseUrl() {
  return (ANALYST_URL || "").replace(/\/+$/, "");
}

async function fetchAnalysis(coin, tf) {
  const res = await axios.post(
    `${baseUrl()}/api/analyze`,
    { coin, timeframe: tf },
    { timeout: ANALYZE_TIMEOUT_MS, headers: { "Content-Type": "application/json" } },
  );
  return res.data;
}

async function fetchFx() {
  try {
    const res = await axios.get(`${baseUrl()}/api/fx`, { timeout: 10_000 });
    return res.data?.fx || null;
  } catch {
    return null; // kurs cuma pelengkap
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * @returns {Promise<boolean>} true kalau pesan ini command !analisis (sudah ditangani).
 */
async function handleAnalisisCommand(sock, msg, { jid, text, lang }) {
  const m = text.match(/^!(analisis|analysis)(?:\s+([\s\S]*))?$/i);
  if (!m) return false;

  const args = parseArgs(m[2] || "");
  if (!args) {
    await sendCommandDetail(sock, jid, "analisis", lang);
    return true;
  }

  if (!baseUrl()) {
    await sock.sendMessage(jid, { text: t(lang, "analisis.noUrl") });
    return true;
  }

  const senderId = getSenderJid(msg) || jid;
  if (inFlight.has(senderId)) {
    await sock.sendMessage(jid, { text: t(lang, "analisis.busy") });
    return true;
  }
  const wait = COOLDOWN_MS - (Date.now() - (lastRequestAt.get(senderId) || 0));
  if (wait > 0) {
    await sock.sendMessage(jid, { text: t(lang, "analisis.cooldown", { sec: Math.ceil(wait / 1000) }) });
    return true;
  }

  inFlight.add(senderId);
  lastRequestAt.set(senderId, Date.now());
  try {
    await sock.sendMessage(jid, { text: t(lang, "analisis.working", { coin: args.coin, tf: args.tf }) });

    const [data, fx] = await Promise.all([fetchAnalysis(args.coin, args.tf), fetchFx()]);
    if (!data?.report || !data?.backend) throw new Error("INVALID_RESPONSE");

    const pdf = await buildAnalysisPdf(data, fx);
    const main = data.backend.main;
    await sock.sendMessage(
      jid,
      {
        document: pdf,
        mimetype: "application/pdf",
        fileName: `Analisis-${main.coin}-${args.tf}-${stamp()}.pdf`,
        caption: t(lang, "analisis.caption", {
          coin: main.coin,
          tf: args.tf,
          trend: String(data.report.trend || "-").toUpperCase(),
          price: fmtUsd(main.price),
        }),
      },
      { quoted: msg },
    );
  } catch (err) {
    console.log("[analisis] gagal:", err.response?.data?.error || err.message);
    let key = "analisis.fail";
    let params = {};
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") key = "analisis.timeout";
    else if (err.response?.status === 400) {
      key = "analisis.unsupported";
      params = { coin: args.coin, tf: args.tf };
    } else if (err.response?.data?.error) {
      key = "analisis.failDetail";
      params = { detail: String(err.response.data.error).slice(0, 200) };
    }
    await sock.sendMessage(jid, { text: t(lang, key, params) });
  } finally {
    inFlight.delete(senderId);
  }
  return true;
}

module.exports = { handleAnalisisCommand, parseArgs };
