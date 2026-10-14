// Render kartu: detail club, rank threshold, leaderboard (mirip tab Detail club / Rank thresholds /
// Circle rank di UMA-API-TESTER). Memakai helper gambar yang sama dengan kartu trainer.
const { createCanvas } = require("@napi-rs/canvas");
const { gfx, clean } = require("../trainer/cardImage");
const { RANK_NAMES, rankIcon, detectLeft, windowGain, clubEndDay, clubWeeklyBuckets } = require("./parse");

const { C, SANS, BOLD, MONO, ensureFonts, loadAll, rr, fit, makeText, f, dashedLine } = gfx;

const W = 900;
const PAD = 32;
const SCALE = 2;
const inner = W - PAD * 2;
const BAD = "#ef6b6b";
const GOOD = "#4cc38a";
const SILVER = "#c0c7d6";
const BRONZE = "#d99a6c";

const LABELS = {
  id: {
    locale: "id-ID", circleId: "Circle ID", leaderId: "ID leader", members: "Member", tier: "Tier",
    liveFans: "Live fans", monthlyFans: "Monthly fans", rankLive: "Rank live", rankMonthly: "Rank bulanan",
    toNext: "Ke tier atas", bufferLower: "Buffer tier bawah", totalGain: "Total gain member", updated: "Update terakhir",
    week7: "Fans 7 hari terakhir", colWeek: "Gain 7 hari", clubWeeks: "Fans club per minggu", weekN: "Minggu", running: "berjalan",
    memberTitle: "Member", active: "aktif", left: "keluar", sortedBy: "urut gain bulan ini",
    colMember: "Member", colTotal: "Total fans", colGain: "Gain bulan ini", colLast: "Gain terakhir", colAvg: "Rata-rata/hari",
    leader: "Leader", out: "Keluar", likelyOut: "Diduga keluar", prevIn: "sebelumnya di",
    thTitle: "Rank Threshold Circle", thSub: "Tier SS → D (11 rank)", rank: "Peringkat",
    lbTitle: "Leaderboard Circle", lbSub: "Top {n} · urut peringkat live", live: "Live fans", monthly: "Monthly",
    asOf: "Diambil", noTier: "Tier -", noData: "(tidak ada data)",
  },
  en: {
    locale: "en-GB", circleId: "Circle ID", leaderId: "Leader ID", members: "Members", tier: "Tier",
    liveFans: "Live fans", monthlyFans: "Monthly fans", rankLive: "Live rank", rankMonthly: "Monthly rank",
    toNext: "To next tier", bufferLower: "Buffer to lower tier", totalGain: "Total member gain", updated: "Last update",
    week7: "Fans last 7 days", colWeek: "7-day gain", clubWeeks: "Club fans per week", weekN: "Week", running: "ongoing",
    memberTitle: "Members", active: "active", left: "left", sortedBy: "sorted by monthly gain",
    colMember: "Member", colTotal: "Total fans", colGain: "Monthly gain", colLast: "Last gain", colAvg: "Avg/day",
    leader: "Leader", out: "Left", likelyOut: "Likely left", prevIn: "previously in",
    thTitle: "Circle Rank Thresholds", thSub: "Tier SS → D (11 ranks)", rank: "Ranking",
    lbTitle: "Circle Leaderboard", lbSub: "Top {n} · by live rank", live: "Live fans", monthly: "Monthly",
    asOf: "Fetched", noTier: "Tier -", noData: "(no data)",
  },
};

// angka dengan pemisah ribuan manual (id: 1.234.567, en: 1,234,567) -> tidak bergantung ICU server
function fmtNum(n, lang) {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return "-";
  const v = Math.round(Number(n));
  const sep = lang === "en" ? "," : ".";
  return (v < 0 ? "-" : "") + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
const sgn = (n, lang) => (n === null || n === undefined ? "-" : (n > 0 ? "+" : "") + fmtNum(n, lang));
const nowText = (L) => new Date().toLocaleString(L.locale, { timeZone: "Asia/Jakarta" });

function tierIcon(ctx, draw, img, tier, x, y, size) {
  if (!draw) return;
  if (img) { ctx.drawImage(img, x, y, size, size * (img.height / img.width)); return; }
  ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 - 2, 0, Math.PI * 2); ctx.fillStyle = C.bg; ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
  const t = makeText(ctx, true);
  t(tier ? RANK_NAMES[tier - 1] : "-", x + size / 2, y + size / 2 + 5, { font: BOLD, size: size * 0.32, color: C.muted, align: "center" });
}

function pill(ctx, draw, text, x, y, color) {
  const t = makeText(ctx, draw);
  ctx.font = f(10, BOLD);
  const w = ctx.measureText(clean(text)).width + 14;
  if (draw) { rr(ctx, x, y, w, 16, 8); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); }
  t(text, x + 7, y + 11.5, { font: BOLD, size: 10, color });
  return w;
}

// ---------- rangka umum: ukur tinggi (draw=false) lalu gambar (draw=true) ----------
function paint(layout, d) {
  ensureFonts();
  const measure = createCanvas(W, 10).getContext("2d");
  const height = Math.ceil(layout(measure, false, d));
  const canvas = createCanvas(W * SCALE, height * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, height);
  rr(ctx, 6, 6, W - 12, height - 12, 12); ctx.fillStyle = C.card; ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
  layout(ctx, true, d);
  return canvas.toBuffer("image/jpeg", 90);
}

function title(ctx, draw, d, head, sub) {
  const text = makeText(ctx, draw);
  let y = PAD;
  text(fit(ctx, head, inner, f(26, BOLD)), PAD, y + 24, { font: BOLD, size: 26 });
  y += 24 + 20;
  text(sub, PAD, y, { size: 13, color: C.muted });
  text(`${d.L.asOf}: ${nowText(d.L)}`, W - PAD, y, { size: 12, color: C.muted, align: "right" });
  y += 16;
  if (draw) { ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(W - PAD, y + 0.5); ctx.stroke(); }
  return y + 22;
}

// =====================================================================
// DETAIL CLUB
// =====================================================================
function layoutClub(ctx, draw, d) {
  const { club, L, lang, imgs } = d;
  const text = makeText(ctx, draw);
  let y = PAD;

  // header
  const icon = 84;
  tierIcon(ctx, draw, club.tier ? imgs[rankIcon(club.tier)] : null, club.tier, PAD, y, icon);
  const hx = PAD + icon + 18;
  text(fit(ctx, club.name, W - PAD - hx, f(28, BOLD)), hx, y + 34, { font: BOLD, size: 28 });
  const meta = [
    [L.circleId, club.id || "-"],
    [L.leaderId, `${club.leaderId || "-"}${club.leaderName ? ` (${club.leaderName})` : ""}`],
  ];
  let my = y + 58;
  for (const [k, v] of meta) {
    const kw = text(k, hx, my, { size: 13, color: C.muted });
    text(fit(ctx, v, W - PAD - hx - kw - 8, f(13, BOLD)), hx + kw + 8, my, { font: BOLD, size: 13 });
    my += 20;
  }
  let mx = hx;
  mx += text(L.members, mx, my, { size: 13, color: C.muted }) + 8;
  mx += text(String(club.memberCount ?? club.members.length), mx, my, { font: BOLD, size: 13 }) + 22;
  if (club.tier) {
    mx += text(L.tier, mx, my, { size: 13, color: C.muted }) + 8;
    text(RANK_NAMES[club.tier - 1], mx, my, { font: BOLD, size: 13 });
  }
  y += icon + 18;
  if (draw) { ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(W - PAD, y + 0.5); ctx.stroke(); }
  y += 18;

  // KPI 3 x 3
  const endDay = clubEndDay(club);
  const sumGain = club.members.reduce((s, m) => s + (m.monthGain ?? 0), 0);
  const sumWeek = club.members.reduce((s, m) => s + (windowGain(m.days, endDay, 7) ?? 0), 0);
  const upd = club.lastUpdated ? new Date(club.lastUpdated).toLocaleString(L.locale, { timeZone: "Asia/Jakarta" }) : "-";
  const kpis = [
    [L.liveFans, fmtNum(club.livePoints, lang)], [L.monthlyFans, fmtNum(club.monthlyPoint, lang)],
    [L.rankLive, club.liveRank !== null ? `#${fmtNum(club.liveRank, lang)}` : "-"], [L.rankMonthly, club.monthlyRank !== null ? `#${fmtNum(club.monthlyRank, lang)}` : "-"],
    [L.toNext, fmtNum(club.toNext, lang)], [L.bufferLower, fmtNum(club.toLower, lang)],
    [L.totalGain, fmtNum(sumGain, lang)], [L.week7, sgn(sumWeek, lang)], [L.updated, upd],
  ];
  const kg = 12;
  const kw = (inner - kg * 2) / 3;
  const kh = 60;
  kpis.forEach(([k, v], i) => {
    const x = PAD + (i % 3) * (kw + kg);
    const yy = y + Math.floor(i / 3) * (kh + kg);
    if (draw) { rr(ctx, x, yy, kw, kh, 8); ctx.fillStyle = C.bg; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke(); }
    text(k, x + 12, yy + 22, { size: 11.5, color: C.muted });
    text(fit(ctx, v, kw - 24, f(i === 8 ? 13 : 17, BOLD)), x + 12, yy + 45, { font: BOLD, size: i === 8 ? 13 : 17 });
  });
  y += kh * 3 + kg * 2 + 24;

  // fans club per minggu (Minggu 1 = H1-7, dst.; minggu terakhir bisa belum penuh)
  const weeks = clubWeeklyBuckets(club);
  if (weeks.length) {
    text(L.clubWeeks, PAD, y, { font: BOLD, size: 14, color: C.muted });
    y += 12;
    let cx = PAD;
    let cy = y;
    for (const w of weeks) {
      const label = `${L.weekN} ${w.week}${w.partial ? ` (${L.running})` : ""}: `;
      const val = sgn(w.gain, lang);
      ctx.font = f(11.5);
      const lw = ctx.measureText(clean(label)).width;
      ctx.font = f(11.5, BOLD);
      const vw = ctx.measureText(clean(val)).width;
      const cw = lw + vw + 24;
      if (cx + cw > W - PAD && cx > PAD) { cx = PAD; cy += 28; }
      if (draw) { rr(ctx, cx, cy, cw, 22, 11); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke(); }
      text(label, cx + 10, cy + 15, { size: 11.5, color: C.muted });
      text(val, cx + 14 + lw, cy + 15, { font: BOLD, size: 11.5, color: w.gain > 0 ? GOOD : C.muted });
      cx += cw + 8;
    }
    y = cy + 22 + 24;
  }

  // member
  const leftMap = detectLeft(club);
  const members = [...club.members].sort((a, b) => (b.monthGain ?? -Infinity) - (a.monthGain ?? -Infinity));
  const nLeft = leftMap.size;
  text(`${L.memberTitle} (${club.members.length - nLeft} ${L.active}${nLeft ? ` · ${nLeft} ${L.left}` : ""})`, PAD, y, { font: BOLD, size: 14, color: C.muted });
  text(L.sortedBy, W - PAD, y, { size: 11.5, color: C.muted, align: "right" });
  y += 16;

  const col = { rank: PAD + 6, name: PAD + 40, total: PAD + 405, gain: PAD + 510, week: PAD + 610, last: PAD + 710, avg: W - PAD - 6 };
  const hd = (s, x, align = "right") => text(s, x, y + 14, { font: BOLD, size: 11.5, color: C.muted, align });
  hd("#", col.rank, "left"); hd(L.colMember, col.name, "left"); hd(L.colTotal, col.total); hd(L.colGain, col.gain); hd(L.colWeek, col.week); hd(L.colLast, col.last); hd(L.colAvg, col.avg);
  y += 24;
  if (draw) { ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(W - PAD, y + 0.5); ctx.stroke(); }
  y += 4;

  const maxGain = Math.max(1, ...members.map((m) => m.monthGain ?? 0));
  const rh = 46;
  members.forEach((m, i) => {
    const status = leftMap.get(m.viewerId);
    if (draw && status) ctx.globalAlpha = 0.55;
    if (draw && (m.monthGain ?? 0) > 0) {
      const bw = Math.max(2, ((m.monthGain ?? 0) / maxGain) * 90);
      ctx.fillStyle = "rgba(76,195,138,0.16)"; ctx.fillRect(col.gain - bw, y + 6, bw, rh - 12);
    }
    text(String(i + 1), col.rank, y + 27, { size: 13, color: C.muted });
    const nameMax = 230;
    const nm = fit(ctx, m.name, nameMax, f(14, BOLD));
    const nw = text(nm, col.name, y + 20, { font: BOLD, size: 14 });
    let bx = col.name + nw + 8;
    if (m.isLeader) bx += pill(ctx, draw, L.leader, bx, y + 8, C.muted) + 4;
    if (status) pill(ctx, draw, status === "marker" ? L.out : L.likelyOut, bx, y + 8, BAD);
    const sub = `${m.viewerId}${m.prevCircleName ? ` · ${L.prevIn} ${m.prevCircleName}` : ""}`;
    text(fit(ctx, sub, 300, f(10.5, MONO)), col.name, y + 36, { font: MONO, size: 10.5, color: C.muted });
    text(fmtNum(m.total, lang), col.total, y + 27, { size: 13.5, align: "right" });
    text(sgn(m.monthGain, lang), col.gain, y + 27, { font: BOLD, size: 13.5, color: (m.monthGain ?? 0) > 0 ? GOOD : C.muted, align: "right" });
    text(sgn(windowGain(m.days, endDay, 7), lang), col.week, y + 27, { size: 13.5, color: (windowGain(m.days, endDay, 7) ?? 0) > 0 ? C.ink : C.muted, align: "right" });
    text(sgn(m.lastDayGain, lang), col.last, y + 27, { size: 13.5, color: (m.lastDayGain ?? 0) > 0 ? C.ink : C.muted, align: "right" });
    text(fmtNum(m.avgPerDay, lang), col.avg, y + 27, { size: 13.5, align: "right" });
    if (draw) ctx.globalAlpha = 1;
    dashedLine(ctx, draw, PAD, W - PAD, y + rh);
    y += rh;
  });
  return y + PAD;
}

async function renderClubCard(club, { lang = "id" } = {}) {
  const L = LABELS[lang] || LABELS.id;
  const imgs = club.tier ? await loadAll([rankIcon(club.tier)]) : {};
  return paint(layoutClub, { club, L, lang: lang === "en" ? "en" : "id", imgs });
}

// =====================================================================
// RANK THRESHOLD
// =====================================================================
const TH_FIELDS = [
  ["current_min_fans", { id: "Min fans sekarang", en: "Min fans now" }],
  ["current_fans_per_day", { id: "Fans/hari sekarang", en: "Fans/day now" }],
  ["yesterday_min_fans", { id: "Min fans kemarin", en: "Min fans yesterday" }],
  ["yesterday_fans_per_day", { id: "Fans/hari kemarin", en: "Fans/day yesterday" }],
  ["daily_fans_delta", { id: "Selisih harian", en: "Daily delta" }],
  ["last_month_min_fans", { id: "Min fans bulan lalu", en: "Min fans last month" }],
  ["last_month_fans_per_day", { id: "Fans/hari bulan lalu", en: "Fans/day last month" }],
  ["current_vs_last_month_delta", { id: "Vs bulan lalu", en: "Vs last month" }],
];
const TH_KNOWN = new Set(["ranking_from", "ranking_to", ...TH_FIELDS.map(([k]) => k)]);

function rangeText(fields, L, lang) {
  const from = fields.ranking_from, to = fields.ranking_to;
  const has = (v) => v !== null && v !== undefined && v !== "";
  if (has(from) && has(to)) return `${L.rank} ${fmtNum(from, lang)} – ${fmtNum(to, lang)}`;
  if (has(from)) return `${L.rank} ${fmtNum(from, lang)}+`;
  return `${L.rank} -`;
}

function layoutThreshold(ctx, draw, d) {
  const { tiers, L, lang, imgs } = d; // tiers: array 11 (SS..D)
  const text = makeText(ctx, draw);
  let y = title(ctx, draw, d, L.thTitle, L.thSub);
  const ix = PAD + 14;
  const gx = PAD + 100;
  const gw = (W - PAD - 14 - gx) / 3;
  for (const t of tiers) {
    const extras = Object.keys(t.fields).filter((k) => !TH_KNOWN.has(k)).slice(0, 6);
    const cells = [
      ...TH_FIELDS.map(([k, lab]) => [lab[lang], t.fields[k], k]),
      ...extras.map((k) => [k, t.fields[k], k]),
    ];
    const rows = Math.ceil(cells.length / 3);
    const bh = 52 + rows * 40 + 10;
    if (draw) { rr(ctx, PAD, y, inner, bh, 10); ctx.fillStyle = C.tile; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke(); }
    tierIcon(ctx, draw, imgs[t.icon], t.rank, ix, y + 18, 66);
    text(t.name, gx, y + 36, { font: BOLD, size: 26 });
    const nw = (() => { ctx.font = f(26, BOLD); return ctx.measureText(t.name).width; })();
    text(`#${t.rank}`, gx + nw + 10, y + 36, { size: 13, color: C.muted });
    text(rangeText(t.fields, L, lang), W - PAD - 14, y + 34, { font: BOLD, size: 15, color: C.accent, align: "right" });
    cells.forEach(([lab, v, k], i) => {
      const cx = gx + (i % 3) * gw;
      const cy = y + 62 + Math.floor(i / 3) * 40;
      const isNum = typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v));
      const shown = v === null || v === undefined || v === "" ? "-" : isNum ? (k.includes("delta") ? sgn(+v, lang) : fmtNum(+v, lang)) : String(v);
      const color = isNum && +v < 0 ? BAD : k === "current_min_fans" ? C.gold : C.ink;
      text(fit(ctx, lab, gw - 8, f(11)), cx, cy, { size: 11, color: C.muted });
      text(fit(ctx, shown, gw - 8, f(15, BOLD)), cx, cy + 19, { font: BOLD, size: 15, color });
    });
    y += bh + 10;
  }
  return y + PAD - 10;
}

async function renderThresholdCard(rows, { lang = "id" } = {}) {
  const L = LABELS[lang] || LABELS.id;
  const byRank = new Map(rows.map((r) => [r.rank, r]));
  const tiers = [];
  for (let r = 11; r >= 1; r--) tiers.push(byRank.get(r) || { rank: r, name: RANK_NAMES[r - 1], icon: rankIcon(r), fields: {} }); // SS -> D
  const imgs = await loadAll(tiers.map((t) => t.icon));
  return paint(layoutThreshold, { tiers, L, lang: lang === "en" ? "en" : "id", imgs });
}

// =====================================================================
// LEADERBOARD
// =====================================================================
function layoutBoard(ctx, draw, d) {
  const { rows, L, lang, imgs } = d;
  const text = makeText(ctx, draw);
  let y = title(ctx, draw, d, L.lbTitle, L.lbSub.replace("{n}", String(rows.length)));
  const rh = 64;
  rows.forEach((c) => {
    if (draw) { rr(ctx, PAD, y, inner, rh, 10); ctx.fillStyle = C.tile; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke(); }
    const rc = c.rank === 1 ? C.gold : c.rank === 2 ? SILVER : c.rank === 3 ? BRONZE : C.ink;
    text(`#${fmtNum(c.rank, lang)}`, PAD + 14, y + 38, { font: BOLD, size: 19, color: rc });
    tierIcon(ctx, draw, c.tier ? imgs[rankIcon(c.tier)] : null, c.tier, PAD + 76, y + 9, 46);
    const nx = PAD + 138;
    const rightW = 200;
    text(fit(ctx, c.name, W - PAD - rightW - nx, f(16, BOLD)), nx, y + 22, { font: BOLD, size: 16 });
    const sub = `${c.tier ? `Tier ${RANK_NAMES[c.tier - 1]}` : L.noTier} · ${c.id}${c.members !== null ? ` · ${c.members} ${L.members.toLowerCase()}` : ""}`;
    text(fit(ctx, sub, W - PAD - rightW - nx, f(11.5)), nx, y + 40, { size: 11.5, color: C.muted });
    const lead = `${L.leader} ${c.leaderName || "-"}${c.leaderId ? ` · ${c.leaderId}` : ""}`;
    text(fit(ctx, lead, W - PAD - rightW - nx, f(11.5)), nx, y + 56, { size: 11.5, color: C.muted });
    const rx = W - PAD - 14;
    text(L.live, rx, y + 17, { size: 10.5, color: C.muted, align: "right" });
    text(fmtNum(c.live ?? c.monthly, lang), rx, y + 38, { font: BOLD, size: 18, color: C.accent, align: "right" });
    if (c.monthly !== null) text(`${L.monthly} ${fmtNum(c.monthly, lang)}`, rx, y + 56, { size: 11.5, color: C.muted, align: "right" });
    y += rh + 8;
  });
  return y + PAD - 8;
}

async function renderLeaderboardCard(rows, { lang = "id" } = {}) {
  const L = LABELS[lang] || LABELS.id;
  const imgs = await loadAll(rows.filter((r) => r.tier).map((r) => rankIcon(r.tier)));
  return paint(layoutBoard, { rows, L, lang: lang === "en" ? "en" : "id", imgs });
}

module.exports = { renderClubCard, renderThresholdCard, renderLeaderboardCard, fmtNum };
