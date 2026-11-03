"use strict";

/**
 * features/kripto/farleyText.js
 * ------------------------------------------------------------------
 * Teks pesan Farley (dipakai !farley dan !alertfarley). Keluaran = kondisi + alasan + skenario bersyarat
 * (BUY / SELL, SL, TP), bukan perintah transaksi. Parameter yang dipakai selalu ditampilkan (rekomendasi bagian 10 teori),
 * dengan label "default sistem" untuk angka yang bukan dari Farley.
 */

const { t } = require("../../i18n");
const { FARLEY_CONFIG: CFG } = require("../../config/indicatorConfig");
const { fmtLevel } = require("./market");

const f1 = (v) => (typeof v === "number" && isFinite(v) ? v.toFixed(1) : "-");
const f2 = (v) => (typeof v === "number" && isFinite(v) ? v.toFixed(2) : "-");
const pct = (v) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(2)}%` : "-");

function statusLine(lang, sc) {
  switch (sc.status) {
    case "buy":
    case "sell":
      return t(lang, `farley.st.${sc.status}`, { trigger: t(lang, `farley.trigger.${sc.trigger}`) });
    case "wait":
      return t(lang, "farley.st.wait", { reason: t(lang, `farley.why.${sc.why}`, reasonParams(lang, sc)) });
    case "range":
      return t(lang, "farley.st.range", { reason: t(lang, `farley.why.${sc.why}`) });
    default:
      return t(lang, "farley.st.nodata", { have: sc.have ?? 0, need: sc.need ?? CFG.MIN_CANDLES });
  }
}

function reasonParams(lang, sc) {
  return { dir: t(lang, `farley.dir.${sc.dir === "buy" ? "buy" : "sell"}`) };
}

function planLines(lang, sc) {
  const p = sc.plan;
  if (!p) return [];
  const label = t(lang, `farley.plan.${sc.status}`, { entry: fmtLevel(p.entry) });
  const out = [
    label,
    t(lang, "farley.plan.sl", { sl: fmtLevel(p.sl), riskPct: f2((p.risk / p.entry) * 100), riskAtr: f2(p.riskAtr) }),
    t(lang, "farley.plan.tp1", { tp: fmtLevel(p.tp1), rr: p.rr1 }),
    t(lang, "farley.plan.tp2", { tp: fmtLevel(p.tp2), rr: p.rr2 }),
  ];
  if (p.widened) out.push(t(lang, "farley.plan.widened", { atr: CFG.MIN_RISK_ATR }));
  if (p.level?.cutsTp1) out.push(t(lang, "farley.plan.levelCuts", { level: fmtLevel(p.level.price), room: f2(p.level.room), which: "TP1" }));
  else if (p.level?.cutsTp2) out.push(t(lang, "farley.plan.levelCuts", { level: fmtLevel(p.level.price), room: f2(p.level.room), which: "TP2" }));
  return out;
}

function blockedLines(lang, sc) {
  const b = sc.blocked;
  if (!b) return [];
  if (sc.why === "risk") return [t(lang, "farley.blocked.risk", { atr: f2(b.riskAtr), max: CFG.MAX_RISK_ATR })];
  if (sc.why === "levelNear") return [t(lang, "farley.blocked.levelNear", { level: fmtLevel(b.level), room: f2(b.room), min: CFG.MIN_RR_TO_LEVEL })];
  return [];
}

function contextLine(lang, ctx) {
  if (!ctx || (ctx.trend == null && !ctx.macd)) return t(lang, "farley.cond.ctxNa", { tf: ctx?.tf || "-" });
  const trend = t(lang, `farley.trend.${ctx.trend || "na"}`);
  const m = ctx.macd
    ? t(lang, "farley.macd.fmt", { sign: t(lang, `farley.macd.${ctx.macd.sign}`), dir: t(lang, `farley.macd.${ctx.macd.direction}`) })
    : t(lang, "farley.trend.na");
  return t(lang, ctx.self ? "farley.cond.ctxSelf" : "farley.cond.ctx", { tf: ctx.tf || "-", trend, macd: m });
}

/** Satu blok analisis Farley. @param {{coin:string, tf:string, tfLabel:string, price:string, sc:object, short?:boolean}} ev */
function buildFarleyBlock(lang, ev) {
  const { sc } = ev;
  const lines = [t(lang, "farley.head", { coin: ev.coin, tf: ev.tfLabel, price: ev.price }), statusLine(lang, sc)];
  if (sc.status === "nodata") return lines.join("\n");

  const plan = planLines(lang, sc);
  if (plan.length) lines.push("", ...plan);
  const blocked = blockedLines(lang, sc);
  if (blocked.length) lines.push(...blocked);

  const r = sc.ribbon;
  const b = sc.bollinger;
  const s = sc.stoch;
  lines.push("", t(lang, "farley.cond.title"));
  lines.push(contextLine(lang, sc.context));
  lines.push(
    t(lang, "farley.cond.ribbon", {
      state: t(lang, r.compressed && r.state === "mixed" ? "farley.ribbon.compressed" : `farley.ribbon.${r.state}`),
      s5: fmtLevel(r.sma5),
      s8: fmtLevel(r.sma8),
      s13: fmtLevel(r.sma13),
      width: f2(r.widthPct),
      phase: t(lang, `farley.phase.${r.phase}`),
    }),
  );
  lines.push(
    t(lang, "farley.cond.bb", {
      state: t(lang, `farley.bb.${b.state}`),
      bw: f2(b.bandwidth * 100),
      pctl: b.bwPercentile == null ? "-" : Math.round(b.bwPercentile),
      trend: b.trend ? t(lang, `farley.bb.${b.trend}`) : "-",
      pctB: f2(b.pctB),
    }),
  );
  if (s) {
    lines.push(
      t(lang, "farley.cond.stoch", {
        k: f1(s.k),
        d: f1(s.d),
        zone: t(lang, `farley.stoch.${s.zone}`),
        cross: s.crossUp ? t(lang, "farley.stoch.crossUp") : s.crossDown ? t(lang, "farley.stoch.crossDown") : t(lang, "farley.stoch.noCross"),
      }),
    );
  }
  const lv = sc.levels || {};
  if (lv.resistance?.length || lv.support?.length) {
    lines.push(t(lang, "farley.cond.levels", { r1: lv.resistance?.[0] != null ? fmtLevel(lv.resistance[0]) : "-", s1: lv.support?.[0] != null ? fmtLevel(lv.support[0]) : "-" }));
  }
  if (sc.volume?.ratio != null) lines.push(t(lang, "farley.cond.volume", { ratio: f2(sc.volume.ratio), note: sc.volume.high ? t(lang, "farley.volume.high") : t(lang, "farley.volume.normal") }));

  if (sc.dir && sc.invalidation != null) {
    lines.push("", t(lang, `farley.inval.${sc.dir}`, { sma13: fmtLevel(sc.invalidation) }));
  }
  if (sc.status === "buy" || sc.status === "sell") lines.push(t(lang, "farley.exit"));
  return lines.join("\n");
}

/** Catatan parameter + disclaimer (di bawah pesan). */
function buildFarleyFooter(lang, { ctxTf }) {
  return [
    t(lang, "farley.params", { sm: CFG.STOCH_SMOOTH, d: CFG.STOCH_D, ctx: ctxTf || t(lang, "farley.ctxSelfName"), tp1: CFG.TP1_R, tp2: CFG.TP2_R }),
    t(lang, "farley.disclaimer"),
  ].join("\n");
}

/**
 * Label teks untuk chart Farley (farleyChart.js): status singkat berwarna + nama level. Tanpa markdown / emoji
 * karena digambar di canvas.
 * @returns {{title:string, status:string, tone:string, entry:string, sl:string, tp1:string, tp2:string, brk:string, tp2Out:string, stoch:string, foot:string}}
 */
function chartLabels(lang, sc) {
  const tone = sc && ["buy", "sell", "wait", "range", "nodata"].includes(sc.status) ? sc.status : "nodata";
  let status = t(lang, `farleychart.st.${tone}`);
  if ((tone === "buy" || tone === "sell") && sc.trigger) status += ` | ${t(lang, `farleychart.trigger.${sc.trigger}`)}`;
  else if (tone === "wait" && sc.why) status += ` | ${t(lang, `farleychart.why.${sc.why}`)}`;
  return {
    title: t(lang, "farleychart.title"),
    status,
    tone,
    entry: t(lang, "farleychart.entry"),
    sl: "SL",
    tp1: "TP1",
    tp2: "TP2",
    brk: t(lang, "farleychart.brk"),
    tp2Out: "",
    stoch: t(lang, "farleychart.stoch", { sm: CFG.STOCH_SMOOTH, d: CFG.STOCH_D }),
    foot: t(lang, "farleychart.foot"),
  };
}

module.exports = { buildFarleyBlock, buildFarleyFooter, chartLabels };
