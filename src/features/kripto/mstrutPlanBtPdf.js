"use strict";

/**
 * features/kripto/mstrutPlanBtPdf.js
 * ------------------------------------------------------------------
 * Laporan PDF backtest SKENARIO !mstrut (hasil mstrutPlanBacktest.js). Dikirim !mstruct ke WhatsApp supaya pesan chat
 * tidak panjang. A4 LANDSCAPE (tabel statistik lebar), multi-halaman, header tabel diulang, kurva ekuitas out-of-sample
 * digambar vektor dengan pdf-lib. Pakai pdf-lib + Helvetica (sama dengan watchPdf.js / hhllPdf.js): tanpa dependensi
 * baru. Helvetica cuma Latin (WinAnsi): semua teks dibersihkan lewat clean(), jadi pakai ASCII ("s/d", ">=").
 *
 * Fungsi ini MURNI (tanpa jaringan / file): input = hasil buildPlanStatsFile + sampel, output = Buffer PDF.
 */

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { makeCleaner, wibStamp, PDF_STYLE } = require("./watchPdf");

const { MARGIN, C: BASE } = PDF_STYLE;
const PAGE_W = 841.89; // A4 landscape
const PAGE_H = 595.28;
const ROW_H = 15;
const HEAD_H = 18;
const C = {
  ...BASE,
  good: rgb(0.09, 0.55, 0.3),
  bad: rgb(0.8, 0.18, 0.18),
  warn: rgb(0.55, 0.45, 0.1),
  grey: rgb(0.5, 0.5, 0.5),
  chartBg: rgb(0.985, 0.988, 0.992),
};

const TF_ORDER = ["15M", "1H", "4H", "1D"];
const TF_NAME = { "15M": "M15", "1H": "H1", "4H": "H4", "1D": "D1" };
const EXIT_ORDER = ["tp2", "tp1", "tp1_be", "tp1_sl", "sl", "timeout", "no_fill"];

const L = {
  id: {
    title: "Backtest Skenario !mstrut",
    sub: (time, coins, tfs, bars) => `${time} WIB | Koin: ${coins} | TF: ${tfs} | ${bars} candle per TF`,
    sub2: (cut, nTrain, nOos) => `Pemisah train/oos: ${cut} | sampel train ${nTrain} | sampel oos ${nOos}`,
    assume: (p) =>
      `Asumsi: entry limit di tengah Entry Zone | TP1 ${p.tp1Pct}% lalu ${p.be ? "SL digeser ke entry" : "SL tetap"} | biaya ${p.cost} bps pulang-pergi | ${p.nonOverlap ? "satu skenario aktif per koin+TF" : "skenario boleh tumpang tindih"}`,
    secVerdict: "Kesimpulan per timeframe (out-of-sample)",
    verdict: {
      edge: "ADA KEUNGGULAN",
      no_edge: "TIDAK TERBUKTI",
      insufficient: "DATA KURANG",
    },
    verdictLong: {
      edge: "Expectancy positif (CI 95% > 0) dan mengalahkan pembanding acak.",
      no_edge: "Expectancy tidak beda nyata dari 0 atau tidak mengalahkan pembanding acak.",
      insufficient: "Trade belum cukup (minimal {min}), tidak ada kesimpulan.",
    },
    noTrades: "tidak ada trade",
    verdictLine: (g) => `N ${g.n} trade | avgR ${g.avg} (CI95 ${g.ci}) | win ${g.win}% | maxDD ${g.dd}R`,
    secTable: "Statistik per kelompok (out-of-sample)",
    cols: ["Kelompok", "WAIT%", "Skenario", "Terisi%", "Trade", "Win%", "AvgR", "Total R", "PF", "MaxDD", "Acak", "Market"],
    grpAll: (tf) => `${tf} semua arah`,
    grpLong: (tf) => `${tf} long`,
    grpShort: (tf) => `${tf} short`,
    legend: "avgR = expectancy per trade (R) setelah biaya. Acak / Market = avgR pembanding dengan jarak SL/TP sama: arah diacak / masuk langsung di close searah skenario.",
    secExit: "Hasil keluar trade (out-of-sample, semua koin)",
    exitCols: { tp2: "TP2", tp1: "TP1", tp1_be: "TP1 lalu BE", tp1_sl: "TP1 lalu SL", sl: "SL", timeout: "Timeout", no_fill: "Tak terisi" },
    exitHead: "Timeframe",
    secEq: "Kurva ekuitas out-of-sample (R kumulatif setelah biaya, urut waktu)",
    eqX: (n) => `${n} trade`,
    eqNone: "Trade kurang untuk kurva",
    secWait: "Alasan WAIT (out-of-sample)",
    wait: { nodir: "Arah tidak jelas", conflict: "Sinyal bertentangan", smallLeg: "Leg impuls terlalu kecil", invalid: "Level tidak valid", nostruct: "Struktur belum cukup", farEntry: "Entry terlalu jauh dari harga", lowRR: "R:R TP1 terlalu kecil" },
    waitCols: ["Timeframe", "Alasan", "Jumlah"],
    secCaveat: "Batas yang perlu diingat",
    caveats: [
      "Backtest sejarah, bukan jaminan hasil.",
      "Fee dan slippage hanya perkiraan (bps). Urutan harga di dalam satu candle tidak diketahui (aturan konservatif: SL dulu).",
      "Aturan skenario belum dioptimalkan; angka oos hanya dari bagian waktu terakhir (walk-forward 60/40).",
      "Max drawdown dihitung dengan risiko tetap 1R per trade, bukan ukuran posisi nyata.",
      "Statistik digabung (pooled) antar koin per timeframe. Kesimpulan hanya bila N >= {min}.",
    ],
    foot: "Edukasi, bukan ajakan beli/jual. Hasil masa lalu tidak menjamin hasil di masa depan.",
    page: (p, n) => `Hal. ${p}/${n}`,
    skipped: (list) => `Koin dilewati (tidak ada di Binance): ${list}`,
  },
  en: {
    title: "!mstrut Scenario Backtest",
    sub: (time, coins, tfs, bars) => `${time} WIB | Coins: ${coins} | TF: ${tfs} | ${bars} candles per TF`,
    sub2: (cut, nTrain, nOos) => `Train/oos split: ${cut} | train samples ${nTrain} | oos samples ${nOos}`,
    assume: (p) =>
      `Assumptions: limit entry at the middle of the Entry Zone | TP1 ${p.tp1Pct}% then ${p.be ? "SL moved to entry" : "SL unchanged"} | ${p.cost} bps round-trip cost | ${p.nonOverlap ? "one active scenario per coin+TF" : "scenarios may overlap"}`,
    secVerdict: "Conclusion per timeframe (out-of-sample)",
    verdict: {
      edge: "EDGE FOUND",
      no_edge: "NOT PROVEN",
      insufficient: "NOT ENOUGH DATA",
    },
    verdictLong: {
      edge: "Positive expectancy (95% CI > 0) and beats the random benchmark.",
      no_edge: "Expectancy is not significantly different from 0, or does not beat the random benchmark.",
      insufficient: "Not enough trades (minimum {min}), no conclusion.",
    },
    noTrades: "no trades",
    verdictLine: (g) => `N ${g.n} trades | avgR ${g.avg} (CI95 ${g.ci}) | win ${g.win}% | maxDD ${g.dd}R`,
    secTable: "Statistics per group (out-of-sample)",
    cols: ["Group", "WAIT%", "Scenarios", "Filled%", "Trades", "Win%", "AvgR", "Total R", "PF", "MaxDD", "Random", "Market"],
    grpAll: (tf) => `${tf} all directions`,
    grpLong: (tf) => `${tf} long`,
    grpShort: (tf) => `${tf} short`,
    legend: "avgR = expectancy per trade (R) after costs. Random / Market = benchmark avgR with the same SL/TP distances: random direction / entering at the close in the scenario's direction.",
    secExit: "Trade exits (out-of-sample, all coins)",
    exitCols: { tp2: "TP2", tp1: "TP1", tp1_be: "TP1 then BE", tp1_sl: "TP1 then SL", sl: "SL", timeout: "Timeout", no_fill: "Not filled" },
    exitHead: "Timeframe",
    secEq: "Out-of-sample equity curve (cumulative R after costs, in time order)",
    eqX: (n) => `${n} trades`,
    eqNone: "Not enough trades for a curve",
    secWait: "WAIT reasons (out-of-sample)",
    wait: { nodir: "No clear direction", conflict: "Conflicting signals", smallLeg: "Impulse leg too small", invalid: "Invalid levels", nostruct: "Not enough structure", farEntry: "Entry too far from price", lowRR: "TP1 R:R too low" },
    waitCols: ["Timeframe", "Reason", "Count"],
    secCaveat: "Limits to keep in mind",
    caveats: [
      "Historical backtest, not a guarantee of results.",
      "Fees and slippage are estimates (bps). Price order inside a single candle is unknown (conservative rule: SL first).",
      "Scenario rules are not optimized; oos figures come only from the latest part of the timeline (walk-forward 60/40).",
      "Max drawdown uses a fixed 1R risk per trade, not real position sizing.",
      "Statistics are pooled across coins per timeframe. A conclusion is only drawn when N >= {min}.",
    ],
    foot: "Educational, not buy/sell advice. Past results do not guarantee future results.",
    page: (p, n) => `Page ${p}/${n}`,
    skipped: (list) => `Coins skipped (not on Binance): ${list}`,
  },
};

const isNum = (v) => typeof v === "number" && isFinite(v);
const f1 = (v) => (isNum(v) ? v.toFixed(1) : "-");
const f2 = (v) => (isNum(v) ? v.toFixed(2) : "-");
const pf = (v) => (v === Infinity ? "inf" : f2(v));
const sgn = (v) => (isNum(v) ? (v > 0 ? "+" : "") + v.toFixed(2) : "-");

/** Urutan baris tabel: per TF -> semua / long / short, lalu tiap koin. */
function groupOrder(stats, tfs, coins) {
  const out = [];
  for (const tf of tfs) {
    for (const kind of ["any", "long", "short"]) {
      const key = `${tf}|${kind}`;
      if (stats.oos[key]) out.push({ key, tf, kind, g: stats.oos[key] });
    }
    for (const coin of coins) {
      const key = `${coin}|${tf}`;
      if (stats.oos[key]) out.push({ key, tf, kind: "coin", coin, g: stats.oos[key] });
    }
  }
  return out;
}

/** Ekuitas kumulatif (R) trade terisi di bagian oos, per TF, urut waktu. */
function equitySeries(samples, cutoff, tf) {
  const rs = samples
    .filter((s) => s.kind === "plan" && s.filled && s.tf === tf && cutoff != null && s.t >= cutoff)
    .sort((a, b) => a.t - b.t)
    .map((s) => s.netR);
  let eq = 0;
  return rs.map((r) => (eq += r));
}

/**
 * @param {{stats: object, samples: object[], lang?: string, coins: string[], tfs: string[], bars: number,
 *          params?: object, skipped?: string[]}} p
 *        stats = buildPlanStatsFile(...); samples = semua sampel (untuk kurva ekuitas)
 * @returns {Promise<Buffer>}
 */
async function buildMstrutPlanBtPdf({ stats, samples = [], lang = "id", coins, tfs, bars, params = {}, skipped = [] }) {
  const tx = L[lang] || L.id;
  const pdf = await PDFDocument.create();
  pdf.setTitle(tx.title);
  pdf.setCreator("AgemasenBot");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const clean = makeCleaner(font);
  const cw = PAGE_W - MARGIN * 2;
  const bottom = MARGIN + 30; // ruang footer
  const tfList = TF_ORDER.filter((tf) => tfs.includes(tf));
  const minN = stats.minN ?? 30;

  const pages = [];
  const newPage = () => {
    const p = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(p);
    return p;
  };
  let page = newPage();
  let y = PAGE_H - MARGIN;
  const ensure = (need) => {
    if (y - need < bottom) {
      page = newPage();
      y = PAGE_H - MARGIN;
    }
  };
  const text = (s, x, yy, size, f, color) => page.drawText(clean(s), { x, y: yy, size, font: f, color });
  const section = (title) => {
    ensure(40);
    text(title, MARGIN, y, 12, bold, C.ink);
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + cw, y }, thickness: 0.6, color: C.line });
    y -= 14;
  };
  /** Teks panjang dipecah per kata sesuai lebar. */
  const paragraph = (s, size, f, color, width = cw, lead = size + 3) => {
    const words = clean(s).split(" ");
    let line = "";
    const flush = () => {
      if (!line) return;
      ensure(lead);
      page.drawText(line, { x: MARGIN, y, size, font: f, color });
      y -= lead;
      line = "";
    };
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(test, size) > width && line) {
        flush();
        line = w;
      } else line = test;
    }
    flush();
  };
  /** Tulis sel tabel: dipotong dengan "." bila melebihi lebar kolom. */
  const put = (col, s, yy, f, size, color) => {
    const pad = 4;
    let str = clean(s);
    const orig = str;
    while (str.length > 1 && f.widthOfTextAtSize(str, size) > col.w - pad * 2) str = str.slice(0, -1);
    if (str !== orig) str = str.slice(0, -1) + ".";
    const w = f.widthOfTextAtSize(str, size);
    page.drawText(str, { x: MARGIN + col.x + (col.a === "r" ? col.w - pad - w : pad), y: yy, size, font: f, color });
  };
  const layoutCols = (widths, aligns) => {
    let x = 0;
    return widths.map((w, i) => {
      const col = { x, w, a: aligns[i] };
      x += w;
      return col;
    });
  };
  const drawHead = (cols, names) => {
    page.drawRectangle({ x: MARGIN, y: y - 5, width: cw, height: HEAD_H, color: C.head });
    names.forEach((n, i) => put(cols[i], n, y, bold, 8.5, C.white));
    y -= HEAD_H + 2;
  };

  // ---------- judul ----------
  const cost = 2 * ((params.feeBps ?? 10) + (params.slipBps ?? 5));
  text(tx.title, MARGIN, y - 14, 20, bold, C.ink);
  y -= 36;
  text(tx.sub(wibStamp(), coins.join(", "), tfList.map((t) => TF_NAME[t]).join(", "), bars), MARGIN, y, 9.5, font, C.muted);
  y -= 13;
  const cut = stats.cutoff ? new Date(stats.cutoff).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-";
  text(tx.sub2(cut, stats.nTrain ?? 0, stats.nOos ?? 0), MARGIN, y, 9.5, font, C.muted);
  y -= 13;
  paragraph(
    tx.assume({ tp1Pct: Math.round((params.tp1Share ?? 0.5) * 100), be: params.beAfterTp1 !== false, cost, nonOverlap: params.nonOverlap !== false }),
    9,
    font,
    C.muted,
  );
  if (skipped.length) paragraph(tx.skipped(skipped.join(", ")), 9, bold, C.warn);
  y -= 10;

  // ---------- kesimpulan per TF ----------
  section(tx.secVerdict);
  for (const tf of tfList) {
    ensure(48);
    const g = stats.oos[`${tf}|any`];
    const v = g && g.nTrades ? g.verdict : "insufficient";
    const color = v === "edge" ? C.good : v === "no_edge" ? C.bad : C.grey;
    page.drawRectangle({ x: MARGIN, y: y - 30, width: cw, height: 38, color: C.zebra });
    page.drawRectangle({ x: MARGIN, y: y - 30, width: 4, height: 38, color });
    text(TF_NAME[tf], MARGIN + 12, y - 8, 12, bold, C.ink);
    text(tx.verdict[v], MARGIN + 52, y - 8, 11, bold, color);
    if (g && g.nTrades) {
      const ci = isNum(g.expCiLo) ? `${f2(g.expCiLo)} ${lang === "id" ? "s/d" : "to"} ${f2(g.expCiHi)}` : "-";
      text(tx.verdictLine({ n: g.nTrades, avg: sgn(g.expectancyR), ci, win: (g.winRate ?? 0).toFixed(0), dd: f1(g.maxDrawdownR) }), MARGIN + 190, y - 8, 9, font, C.ink);
    } else text(tx.noTrades, MARGIN + 190, y - 8, 9, font, C.muted);
    text(tx.verdictLong[v].replace("{min}", minN), MARGIN + 52, y - 23, 8.5, font, C.muted);
    y -= 46;
  }
  y -= 4;

  // ---------- tabel statistik ----------
  section(tx.secTable);
  const fixed = [52, 62, 56, 50, 50, 52, 58, 44, 52, 52, 58]; // kolom selain "Kelompok"
  const tcols = layoutCols([cw - fixed.reduce((a, b) => a + b, 0), ...fixed], ["l", ...fixed.map(() => "r")]);
  ensure(HEAD_H + ROW_H * 3);
  drawHead(tcols, tx.cols);
  const rows = groupOrder(stats, tfList, coins);
  rows.forEach((r, i) => {
    if (y - ROW_H < bottom) {
      page = newPage();
      y = PAGE_H - MARGIN;
      drawHead(tcols, tx.cols);
    }
    const g = r.g;
    if (r.kind === "any") page.drawRectangle({ x: MARGIN, y: y - 4, width: cw, height: ROW_H, color: C.zebra });
    const isTfRow = r.kind !== "coin";
    const name = r.kind === "any" ? tx.grpAll(TF_NAME[r.tf]) : r.kind === "long" ? tx.grpLong(TF_NAME[r.tf]) : r.kind === "short" ? tx.grpShort(TF_NAME[r.tf]) : `${r.coin} ${TF_NAME[r.tf]}`;
    const f = r.kind === "any" ? bold : font;
    const dirOnly = r.kind === "long" || r.kind === "short";
    const avgColor = !g.nTrades ? C.muted : g.expectancyR > 0 ? C.good : g.expectancyR < 0 ? C.bad : C.ink;
    const totColor = !g.nTrades ? C.muted : g.totalR > 0 ? C.good : g.totalR < 0 ? C.bad : C.ink;
    const cells = [
      [name, f, C.ink],
      [dirOnly ? "-" : f1(g.waitRate), font, C.ink],
      [String(g.nPlans), font, C.ink],
      [f1(g.fillRate), font, C.ink],
      [String(g.nTrades), f, C.ink],
      [f1(g.winRate), font, C.ink],
      [sgn(g.expectancyR), bold, avgColor],
      [sgn(g.totalR), font, totColor],
      [g.nTrades ? pf(g.profitFactor) : "-", font, C.ink],
      [g.nTrades ? f1(g.maxDrawdownR) : "-", font, C.ink],
      [sgn(g.baseline?.randomR), font, C.muted],
      [sgn(g.baseline?.marketR), font, C.muted],
    ];
    cells.forEach(([s, ff, col], k) => put(tcols[k], s, y, ff, 8.5, col));
    if (isTfRow && rows[i + 1] && rows[i + 1].kind === "coin") {
      /* garis tipis antara kelompok arah dan per-koin */
    }
    y -= ROW_H;
  });
  y -= 4;
  paragraph(tx.legend, 8, font, C.muted);
  y -= 8;

  // ---------- distribusi keluar ----------
  section(tx.secExit);
  const present = EXIT_ORDER.filter((k) => tfList.some((tf) => (stats.oos[`${tf}|any`]?.exits?.[k] ?? 0) > 0));
  if (present.length) {
    const ew = Math.min(95, (cw - 80) / present.length);
    const ecols = layoutCols([80, ...present.map(() => ew)], ["l", ...present.map(() => "r")]);
    ensure(HEAD_H + ROW_H * tfList.length);
    drawHead(ecols, [tx.exitHead, ...present.map((k) => tx.exitCols[k])]);
    for (const tf of tfList) {
      const g = stats.oos[`${tf}|any`];
      if (!g) continue;
      ensure(ROW_H);
      const tot = Object.values(g.exits || {}).reduce((a, b) => a + b, 0) || 1;
      put(ecols[0], TF_NAME[tf], y, bold, 8.5, C.ink);
      present.forEach((k, i) => {
        const n = g.exits?.[k] ?? 0;
        const color = k === "tp2" || k === "tp1" ? C.good : k === "sl" || k === "tp1_sl" ? C.bad : C.ink;
        put(ecols[i + 1], `${n} (${Math.round((n / tot) * 100)}%)`, y, font, 8.5, n ? color : C.muted);
      });
      y -= ROW_H;
    }
    y -= 8;
  }

  // ---------- kurva ekuitas ----------
  section(tx.secEq);
  const chartW = (cw - 20) / 2;
  const chartH = 120;
  for (let i = 0; i < tfList.length; i += 2) {
    ensure(chartH + 24);
    const pair = tfList.slice(i, i + 2);
    pair.forEach((tf, k) => {
      const x0 = MARGIN + k * (chartW + 20);
      const series = equitySeries(samples, stats.cutoff, tf);
      page.drawRectangle({ x: x0, y: y - chartH, width: chartW, height: chartH, color: C.chartBg, borderColor: C.line, borderWidth: 0.6 });
      text(`${TF_NAME[tf]} | ${tx.eqX(series.length)}`, x0 + 6, y - 12, 9, bold, C.ink);
      if (series.length < 2) {
        text(tx.eqNone, x0 + 6, y - chartH / 2, 9, font, C.muted);
        return;
      }
      const pad = { l: 38, r: 10, t: 22, b: 12 };
      const gx = x0 + pad.l;
      const gw = chartW - pad.l - pad.r;
      const gy = y - chartH + pad.b;
      const gh = chartH - pad.t - pad.b;
      let lo = Math.min(0, ...series);
      let hi = Math.max(0, ...series);
      if (hi - lo < 1e-9) hi = lo + 1;
      const sy = (v) => gy + ((v - lo) / (hi - lo)) * gh;
      const sx = (idx) => gx + (idx / (series.length - 1)) * gw;
      page.drawLine({ start: { x: gx, y: sy(0) }, end: { x: gx + gw, y: sy(0) }, thickness: 0.6, color: C.muted, dashArray: [3, 2] });
      for (let j = 1; j < series.length; j++) {
        page.drawLine({ start: { x: sx(j - 1), y: sy(series[j - 1]) }, end: { x: sx(j), y: sy(series[j]) }, thickness: 1.2, color: series[series.length - 1] >= 0 ? C.good : C.bad });
      }
      text(`${f1(hi)}R`, x0 + 4, gy + gh - 6, 7, font, C.muted);
      text(`${f1(lo)}R`, x0 + 4, gy, 7, font, C.muted);
      const last = series[series.length - 1];
      const label = `${sgn(last)}R`;
      page.drawText(clean(label), { x: x0 + chartW - pad.r - bold.widthOfTextAtSize(clean(label), 9), y: y - 12, size: 9, font: bold, color: last >= 0 ? C.good : C.bad });
    });
    y -= chartH + 12;
  }

  // ---------- alasan WAIT ----------
  const waitRows = [];
  for (const tf of tfList) {
    const wr = stats.oos[`${tf}|any`]?.waitReasons || {};
    for (const [reason, n] of Object.entries(wr).sort((a, b) => b[1] - a[1])) waitRows.push({ tf, reason, n });
  }
  if (waitRows.length) {
    y -= 4;
    section(tx.secWait);
    const wcols = layoutCols([80, 300, 70], ["l", "l", "r"]);
    ensure(HEAD_H + ROW_H * 2);
    drawHead(wcols, tx.waitCols);
    for (const r of waitRows) {
      if (y - ROW_H < bottom) {
        page = newPage();
        y = PAGE_H - MARGIN;
        drawHead(wcols, tx.waitCols);
      }
      put(wcols[0], TF_NAME[r.tf], y, bold, 8.5, C.ink);
      put(wcols[1], tx.wait[r.reason] || r.reason, y, font, 8.5, C.ink);
      put(wcols[2], String(r.n), y, font, 8.5, C.ink);
      y -= ROW_H;
    }
    y -= 8;
  }

  // ---------- batasan ----------
  section(tx.secCaveat);
  for (const c of tx.caveats) paragraph(`- ${c.replace("{min}", minN)}`, 9, font, C.ink);

  // ---------- footer semua halaman ----------
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN + 14 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 14 }, thickness: 0.5, color: C.line });
    p.drawText(clean(tx.foot), { x: MARGIN, y: MARGIN + 3, size: 7, font, color: C.muted });
    const label = tx.page(i + 1, pages.length);
    p.drawText(label, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, 8), y: MARGIN + 3, size: 8, font, color: C.muted });
  });

  return Buffer.from(await pdf.save());
}

module.exports = { buildMstrutPlanBtPdf, groupOrder, equitySeries };
