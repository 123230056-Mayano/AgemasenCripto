"use strict";

/**
 * features/kripto/kriptoCommand.js
 * ------------------------------------------------------------------
 * Command analisis dasar yang melengkapi !analisis:
 *   !listkripto [kata kunci] -> daftar koin yang tersedia (lihat kriptoList.js)
 *   !chart <koin> [tf]   -> gambar candlestick + EMA 20/50/200 + garis S/R
 *   !harga <koin>        -> harga live USDT + Rupiah + % perubahan 24 jam
 *   !level <koin> [tf]   -> R1/R2/S1/S2 + jarak % dari harga sekarang
 *   !ema <koin> [tf]     -> EMA 20/50/200 + posisi harga (di atas / di bawah)
 *   !tren <koin> [tf]    -> bullish / bearish / sideways (+ golden/death cross baru)
 *   !mtf <koin>          -> tabel tren di 15m, 1H, 4H, 1D sekaligus
 *   !bandingkan <k1> <k2> -> dua koin berdampingan + kesimpulan siapa lebih kuat
 *   !semua [kategori] [tf] -> semua koin + harga + % (dipaginasi, lanjut pakai !next)
 *   !top / !flop [jumlah] -> top gainers / losers 24 jam
 *   !kategori            -> daftar kategori koin
 *   !cari <nama>         -> cari koin berdasarkan nama / ticker
 *   (lima terakhir ada di pasar.js)
 *   !ringkasan / !stat / !scan <kondisi> [tf] -> statistik & screener pasar (statistik.js)
 *   !bias <koin> [tf|semua] -> bias arah gabungan indikator per timeframe (bias.js)
 *   !alertdivergent (!alertdiv) <koin|semua|watchlist> [tf] [rsi|macd] | list | hapus <id|semua>
 *                        -> alarm divergence otomatis tiap candle closed (divAlertCommand.js, alertMonitor.js)
 *   !watch / !unwatch / !watchlist / !alert / !alertlevel / !alerts / !hapusalert /
 *   !harian / !stopharian -> watchlist & alert pribadi (watchlist.js, alertMonitor.js)
 *   !kurs / !konversi / !tf -> utilitas (utilitas.js)
 *
 * [tf] = 15m | 1H | 4H | 1D; kosong -> default pengguna (awal 4H).
 */

const { t } = require("../../i18n");
const { sendCommandDetail } = require("../menu/menu");
const { getSenderJid } = require("../../utils/whatsapp");
const { renderChart } = require("../analisis/analisisChart");
const { getDefaultTf } = require("./defaultTf");
const { getAvailableCoins, filterCoins, buildMessages } = require("./kriptoList");
const { PASAR_COMMANDS, PASAR_RUNNERS, parsePasarArgs } = require("./pasar");
const { STAT_COMMANDS, STAT_RUNNERS, parseStatArgs } = require("./statistik");
const { BIAS_COMMANDS, BIAS_RUNNERS, parseBiasArgs } = require("./bias");
const { DIVALERT_COMMANDS, DIVALERT_RUNNERS, parseDivAlertArgs } = require("./divAlertCommand");
const { WATCH_COMMANDS, WATCH_RUNNERS, parseWatchArgs } = require("./watchlist");
const { UTIL_COMMANDS, UTIL_RUNNERS, parseUtilArgs } = require("./utilitas");
const { EMA_PERIODS, computeEmas, classifyTrendAuto, detectCross } = require("./indicators");
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
  ema: { re: /^!ema(?:\s+([\s\S]*))?$/i, useTf: true },
  tren: { re: /^!(?:tren|trend)(?:\s+([\s\S]*))?$/i, useTf: true },
  mtf: { re: /^!mtf(?:\s+([\s\S]*))?$/i, useTf: false },
  bandingkan: { re: /^!(?:bandingkan|compare)(?:\s+([\s\S]*))?$/i, useTf: false, coins: 2 },
};

/**
 * "sol 4h" -> { coin: "SOL", tf: "4H" | null }. null kalau format salah.
 * Command dua koin (coins: 2), mis. "sol eth" -> { coin: "SOL", coin2: "ETH", tf: null }.
 */
function parseArgs(raw, { useTf, coins = 1 }) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const found = [];
  let tf = null;
  for (const tok of tokens) {
    const up = tok.toUpperCase();
    if (useTf && TIMEFRAMES[up]) tf = up;
    else if (found.length < coins && /^[A-Z0-9]{1,15}$/.test(up)) found.push(up);
    else return null;
  }
  if (found.length !== coins) return null;
  if (coins === 2 && found[0] === found[1]) return null; // bandingkan koin yang sama tidak ada artinya
  return { coin: found[0], coin2: found[1] || null, tf };
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

// ---------- indikator & tren ----------
const PERIODS_TXT = (list) => list.join(", ");

/** Ambil candle + harga live lalu hitung EMA, tren, cross. */
async function analyze(coin, tf, tick) {
  const [candles, ticker] = await Promise.all([fetchCandles(coin, tf), tick ? Promise.resolve(tick) : fetchTicker(coin)]);
  const { series, latest } = computeEmas(candles);
  const info = classifyTrendAuto(ticker.price, latest);
  return { candles, tick: ticker, series, latest, info, cross: detectCross(series) };
}

const capTrend = (trend) => trend.charAt(0).toUpperCase() + trend.slice(1); // Bullish / Bearish / Sideways
const trendIcon = { bullish: "🟢", bearish: "🔴", sideways: "🟡", nodata: "⚪" };
/** Label tren; data < 200 candle diberi tanda *, data < 50 candle ditulis "data kurang" (bukan sideways). */
function trendText(lang, info) {
  if (info.trend === "nodata") return t(lang, "kripto.trend.noData");
  return capTrend(info.trend) + (info.limited ? "*" : "");
}

async function runEma(sock, msg, { jid, lang }, { coin, tf }) {
  const { tick, latest, info } = await analyze(coin, tf);
  const emaLine = EMA_PERIODS.map((p) => `EMA ${p} ${fmtLevel(latest[p])}`).join(" | ");
  const status = EMA_PERIODS.map((p) => {
    if (info.pos[p] == null) return `• EMA ${p}: ${t(lang, "kripto.ema.noData")}`;
    const key = info.pos[p] ? "kripto.ema.above" : "kripto.ema.below";
    return `${info.pos[p] ? "🟢" : "🔴"} ${t(lang, key, { p, pct: fmtPct(pctFrom(latest[p], tick.price)) })}`;
  });
  await sock.sendMessage(
    jid,
    { text: t(lang, "kripto.ema.body", { coin, tf: TF_LABEL[tf], price: fmtUsd(tick.price), emas: emaLine, status: status.join("\n") }) },
    { quoted: msg },
  );
}

/** "harga di atas EMA 20, 50, di bawah EMA 200. EMA 20 di bawah EMA 50." */
function describeTrend(lang, info) {
  const parts = [];
  if (info.above.length) parts.push(t(lang, "kripto.tren.above", { list: PERIODS_TXT(info.above) }));
  if (info.below.length) parts.push(t(lang, "kripto.tren.below", { list: PERIODS_TXT(info.below) }));
  let txt = t(lang, "kripto.tren.price", { parts: parts.join(", ") });
  if (info.ema20AboveEma50 != null) {
    txt += " " + t(lang, info.ema20AboveEma50 ? "kripto.tren.ema20Above" : "kripto.tren.ema20Below");
  }
  return txt;
}

async function runTren(sock, msg, { jid, lang }, { coin, tf }) {
  const { tick, info, cross } = await analyze(coin, tf);
  const lines = [
    t(lang, "kripto.tren.head", { coin, tf: TF_LABEL[tf], price: fmtUsd(tick.price) }),
    "",
    info.trend === "nodata"
      ? `${trendIcon.nodata} *${trendText(lang, info)}*`
      : `${trendIcon[info.trend]} *${capTrend(info.trend)}*: ${describeTrend(lang, info)}`,
  ];
  if (info.limited) lines.push("", `ℹ️ ${t(lang, "kripto.trend.limitedNote")}`);
  if (cross) {
    lines.push(
      "",
      t(lang, cross.type === "golden" ? "kripto.tren.golden" : "kripto.tren.death", {
        ago: cross.barsAgo === 0 ? t(lang, "kripto.tren.justNow") : t(lang, "kripto.tren.barsAgo", { n: cross.barsAgo }),
      }),
    );
  }
  lines.push("", t(lang, "kripto.disclaimer"));
  await sock.sendMessage(jid, { text: lines.join("\n") }, { quoted: msg });
}

const MTF_TFS = ["15M", "1H", "4H", "1D"];
const pad = (s, n) => String(s).padEnd(n, " ");

/** Level terdekat (R1 atau S1, mana yang lebih dekat ke harga). */
function nearestLevel(candles, price) {
  const { resistance, support } = computeLevels(candles, price);
  const opts = [];
  if (resistance[0] != null) opts.push({ tag: "R", v: resistance[0] });
  if (support[0] != null) opts.push({ tag: "S", v: support[0] });
  if (!opts.length) return null;
  opts.sort((a, b) => Math.abs(pctFrom(price, a.v)) - Math.abs(pctFrom(price, b.v)));
  return opts[0];
}

async function runMtf(sock, msg, { jid, lang }, { coin }) {
  const tick = await fetchTicker(coin);
  const results = await Promise.all(MTF_TFS.map((tf) => analyze(coin, tf, tick)));

  const rows = results.map((r, i) => {
    const lv = nearestLevel(r.candles, tick.price);
    const vs200 = r.info.pos[200] == null ? "-" : t(lang, r.info.pos[200] ? "kripto.mtf.above" : "kripto.mtf.below");
    return `${pad(TF_LABEL[MTF_TFS[i]], 4)} ${pad(trendText(lang, r.info), 11)} ${pad(vs200, 6)} ${lv ? `${lv.tag} ${fmtLevel(lv.v)}` : "-"}`;
  });
  const header = `${pad(t(lang, "kripto.mtf.colTf"), 4)} ${pad(t(lang, "kripto.mtf.colTrend"), 11)} ${pad("EMA200", 6)} ${t(lang, "kripto.mtf.colLevel")}`;

  const counts = { bullish: 0, bearish: 0, sideways: 0, nodata: 0 };
  for (const r of results) counts[r.info.trend]++;
  let verdict;
  if (counts.bullish === results.length) verdict = t(lang, "kripto.mtf.alignBull");
  else if (counts.bearish === results.length) verdict = t(lang, "kripto.mtf.alignBear");
  else if (counts.bullish > counts.bearish && counts.bullish >= 2) verdict = t(lang, "kripto.mtf.leanBull", { n: counts.bullish, total: results.length });
  else if (counts.bearish > counts.bullish && counts.bearish >= 2) verdict = t(lang, "kripto.mtf.leanBear", { n: counts.bearish, total: results.length });
  else verdict = t(lang, "kripto.mtf.mixed");
  if (results.some((r) => r.info.limited)) verdict += "\n* " + t(lang, "kripto.trend.limitedNote");

  await sock.sendMessage(
    jid,
    {
      text: t(lang, "kripto.mtf.body", {
        coin,
        price: fmtUsd(tick.price),
        table: "```\n" + [header, ...rows].join("\n") + "\n```",
        verdict,
      }),
    },
    { quoted: msg },
  );
}

async function runBandingkan(sock, msg, { jid, lang, senderId }, { coin, coin2 }) {
  const tf = getDefaultTf(senderId);
  const [a, b] = await Promise.all([analyze(coin, tf), analyze(coin2, tf)]);

  const posTxt = (r) =>
    EMA_PERIODS.map((p) => (r.info.pos[p] == null ? "-" : r.info.pos[p] ? "▲" : "▼")).join(" ");
  const rows = [
    [t(lang, "kripto.cmp.price"), fmtUsd(a.tick.price), fmtUsd(b.tick.price)],
    [t(lang, "kripto.cmp.change"), fmtPct(a.tick.changePct), fmtPct(b.tick.changePct)],
    [t(lang, "kripto.cmp.trend"), trendText(lang, a.info), trendText(lang, b.info)],
    ["EMA 20/50/200", posTxt(a), posTxt(b)],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length), 1);
  const w1 = Math.max(coin.length, ...rows.map((r) => r[1].length));
  const w2 = Math.max(coin2.length, ...rows.map((r) => r[2].length));
  const table = [
    `${pad("", w0)}  ${pad(coin, w1)}  ${coin2}`,
    ...rows.map((r) => `${pad(r[0], w0)}  ${pad(r[1], w1)}  ${r[2]}`),
  ].join("\n");

  // Pemenang: skor EMA (0-4) lebih tinggi; kalau seri, perubahan 24 jam; selisih < 0.5% dianggap seimbang.
  const sa = a.info.score;
  const sb = b.info.score;
  let verdict;
  const diffChange = a.tick.changePct - b.tick.changePct;
  if (sa === sb && Math.abs(diffChange) < 0.5) {
    verdict = t(lang, "kripto.cmp.even", { a: coin, b: coin2 });
  } else {
    const aWins = sa !== sb ? sa > sb : diffChange > 0;
    const [w, l, ws, ls] = aWins ? [coin, coin2, sa, sb] : [coin2, coin, sb, sa];
    verdict = t(lang, "kripto.cmp.stronger", { w, l, ws, ls });
  }

  await sock.sendMessage(
    jid,
    { text: t(lang, "kripto.cmp.body", { a: coin, b: coin2, tf: TF_LABEL[tf], table: "```\n" + table + "\n```", verdict }) },
    { quoted: msg },
  );
}

const RUNNERS = { chart: runChart, harga: runHarga, level: runLevel, ema: runEma, tren: runTren, mtf: runMtf, bandingkan: runBandingkan };

async function runList(sock, msg, { jid, lang }, keyword) {
  const all = await getAvailableCoins(lang);
  const coins = filterCoins(all, keyword);
  if (!coins.length) {
    await sock.sendMessage(jid, { text: t(lang, "kripto.list.empty", { q: keyword.trim().slice(0, 40) }) }, { quoted: msg });
    return;
  }
  const header = t(lang, "kripto.list.header", { total: coins.length });
  const footer = t(lang, "kripto.list.footer");
  const messages = buildMessages(coins, header, footer);
  for (let i = 0; i < messages.length; i++) {
    await sock.sendMessage(jid, { text: messages[i] }, i === 0 ? { quoted: msg } : undefined);
  }
}

/**
 * @returns {Promise<boolean>} true kalau pesan ini salah satu command kripto dasar.
 */
async function handleKriptoCommand(sock, msg, { jid, text, lang }) {
  const listMatch = text.match(/^!(?:listkripto|listcrypto)(?:\s+([\s\S]*))?$/i);
  let name = null;
  let match = null;
  if (listMatch) {
    name = "list";
    match = listMatch;
  }
  for (const [key, def] of Object.entries(COMMANDS)) {
    if (name) break;
    const m = text.match(def.re);
    if (m) {
      name = key;
      match = m;
      break;
    }
  }
  // Daftar & pencarian pasar (!semua, !top, !flop, !kategori, !cari) -> lihat pasar.js
  let isPasar = false;
  if (!name) {
    for (const [key, def] of Object.entries(PASAR_COMMANDS)) {
      const m = text.match(def.re);
      if (m) {
        name = key;
        match = m;
        isPasar = true;
        break;
      }
    }
  }
  // Statistik & scanner (!ringkasan, !stat, !scan) -> lihat statistik.js
  let isStat = false;
  if (!name) {
    for (const [key, def] of Object.entries(STAT_COMMANDS)) {
      const m = text.match(def.re);
      if (m) {
        name = key;
        match = m;
        isStat = true;
        break;
      }
    }
  }
  // Bias market (!bias) -> lihat bias.js
  let isBias = false;
  if (!name) {
    for (const [key, def] of Object.entries(BIAS_COMMANDS)) {
      const m = text.match(def.re);
      if (m) {
        name = key;
        match = m;
        isBias = true;
        break;
      }
    }
  }
  // Alarm divergence (!alertdivergent / !alertdiv) -> lihat divAlertCommand.js
  let isDivAlert = false;
  if (!name) {
    for (const [key, def] of Object.entries(DIVALERT_COMMANDS)) {
      const m = text.match(def.re);
      if (m) {
        name = key;
        match = m;
        isDivAlert = true;
        break;
      }
    }
  }
  // Watchlist & alert pribadi (!watch, !alert, !harian, ...) -> lihat watchlist.js
  let isWatch = false;
  if (!name) {
    for (const [key, def] of Object.entries(WATCH_COMMANDS)) {
      const m = text.match(def.re);
      if (m) {
        name = key;
        match = m;
        isWatch = true;
        break;
      }
    }
  }
  // Utilitas (!kurs, !konversi, !tf) -> lihat utilitas.js
  let isUtil = false;
  if (!name) {
    for (const [key, def] of Object.entries(UTIL_COMMANDS)) {
      const m = text.match(def.re);
      if (m) {
        name = key;
        match = m;
        isUtil = true;
        break;
      }
    }
  }
  if (!name) return false;

  const senderId = getSenderJid(msg) || jid;
  let args;
  if (isPasar) args = parsePasarArgs(name, match[1] || "", getDefaultTf(senderId));
  else if (isStat) args = parseStatArgs(name, match[1] || "", getDefaultTf(senderId));
  else if (isBias) args = parseBiasArgs(name, match[1] || "");
  else if (isDivAlert) args = parseDivAlertArgs(name, match[1] || "", getDefaultTf(senderId));
  else if (isWatch) args = parseWatchArgs(name, match[1] || "");
  else if (isUtil) args = parseUtilArgs(name, match[1] || "");
  else if (name === "list") args = { coin: null, coin2: null, tf: null, keyword: match[1] || "" };
  else args = parseArgs(match[1] || "", COMMANDS[name]);
  if (!args) {
    await sendCommandDetail(sock, jid, name, lang);
    return true;
  }

  // !tf cuma menyimpan preferensi (tanpa data pasar), jadi tidak kena cooldown.
  if (isUtil && name === "tf") {
    await UTIL_RUNNERS.tf(sock, msg, { jid, lang, senderId }, args);
    return true;
  }

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
    if (isPasar) {
      await PASAR_RUNNERS[name](sock, msg, { jid, lang, senderId }, args);
      return true;
    }
    if (isStat) {
      await STAT_RUNNERS[name](sock, msg, { jid, lang, senderId }, args);
      return true;
    }
    if (isBias) {
      await BIAS_RUNNERS[name](sock, msg, { jid, lang, senderId }, args);
      return true;
    }
    if (isDivAlert) {
      await DIVALERT_RUNNERS[name](sock, msg, { jid, lang, senderId }, args);
      return true;
    }
    if (isWatch) {
      await WATCH_RUNNERS[name](sock, msg, { jid, lang, senderId }, args);
      return true;
    }
    if (isUtil) {
      await UTIL_RUNNERS[name](sock, msg, { jid, lang, senderId }, args);
      return true;
    }
    if (name === "list") {
      await runList(sock, msg, { jid, lang }, args.keyword);
      return true;
    }
    const tf = args.tf || getDefaultTf(senderId);
    await RUNNERS[name](sock, msg, { jid, lang, senderId }, { coin: args.coin, coin2: args.coin2, tf });
  } catch (err) {
    console.log(`[kripto] !${name} gagal:`, err.message);
    let key = "kripto.fail";
    let params = {};
    if (err instanceof UnsupportedCoinError) {
      key = "kripto.unsupported";
      params = { coin: err.coin || args.coin };
    } else if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") key = "kripto.timeout";
    await sock.sendMessage(jid, { text: t(lang, key, params) });
  } finally {
    inFlight.delete(senderId);
  }
  return true;
}

module.exports = { handleKriptoCommand, parseArgs };
