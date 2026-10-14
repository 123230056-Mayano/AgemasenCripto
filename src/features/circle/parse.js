// Port dari lib/ranks.ts, lib/circles.ts, lib/club.ts (UMA-API-TESTER) ke JS biasa.
// Dibuat toleran: bentuk response uma.moe tidak harus persis.

// Tier circle: rank_index 1..11 -> D, D+, C, C+, B, B+, A, A+, S, S+, SS
const RANK_NAMES = ["D", "D+", "C", "C+", "B", "B+", "A", "A+", "S", "S+", "SS"];
const rankIcon = (rank) =>
  `https://uma.moe/assets/images/icon/circle_rank/utx_ico_circle_rank_${String(rank).padStart(2, "0")}.webp`;

const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v)) return +v;
  return null;
};
const str = (v) => (v === null || v === undefined ? "" : String(v));
const pick = (o, keys) => { for (const k of keys) if (o[k] != null) return o[k]; return null; };

// ---------- rank thresholds ----------
const RANK_KEYS = ["rank_index", "club_rank", "rank", "tier", "level", "rank_id", "id"];

function toRank(v) {
  if (typeof v === "number" && v >= 1 && v <= 11) return v;
  if (typeof v === "string") {
    const i = RANK_NAMES.indexOf(v.trim().toUpperCase());
    if (i >= 0) return i + 1;
    if (/^\d+$/.test(v) && +v >= 1 && +v <= 11) return +v;
  }
  return null;
}

function findEntries(body) {
  if (Array.isArray(body)) return body.map((x, i) => [String(i), x]);
  if (body && typeof body === "object") {
    for (const v of Object.values(body)) if (Array.isArray(v) && v.length) return v.map((x, i) => [String(i), x]);
    const keys = Object.keys(body);
    if (keys.some((k) => toRank(k) !== null)) return keys.map((k) => [k, body[k]]);
    for (const v of Object.values(body)) if (v && typeof v === "object") { const r = findEntries(v); if (r.length) return r; }
  }
  return [];
}

// -> [{ rank, name, icon, fields: { ranking_from: 1, ... } }] urut D..SS
function parseRanks(body) {
  const entries = findEntries(body);
  const rows = [];
  entries.forEach(([key, val], i) => {
    let rank = null;
    let fields = {};
    if (val && typeof val === "object" && !Array.isArray(val)) {
      for (const k of RANK_KEYS) if (rank === null && k in val) rank = toRank(val[k]);
      for (const [k, v] of Object.entries(val)) {
        if (RANK_KEYS.includes(k) && toRank(v) === rank) continue;
        if (k === "name") continue;
        fields[k] = v;
      }
    }
    if (rank === null && key !== null) rank = toRank(key);
    if (rank === null && entries.length === 11) rank = i + 1; // urutan array = D..SS
    if (rank === null) return;
    rows.push({ rank, name: RANK_NAMES[rank - 1], icon: rankIcon(rank), fields });
  });
  return rows.sort((a, b) => a.rank - b.rank);
}

// ---------- daftar circle ----------
function findList(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const vals = Object.values(body);
    const arr = vals.find((v) => Array.isArray(v) && v.length && typeof v[0] === "object");
    if (arr) return arr;
    for (const v of vals) if (v && typeof v === "object") { const r = findList(v); if (r.length) return r; }
  }
  return [];
}

function findTotal(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const k of ["total", "total_count", "count", "total_circles"]) { const n = num(body[k]); if (n !== null) return n; }
  for (const v of Object.values(body)) if (v && typeof v === "object" && !Array.isArray(v)) { const n = findTotal(v); if (n !== null) return n; }
  return null;
}

// Tier dari posisi ranking, memakai ranking_from/ranking_to di rank-thresholds.
function tierFromPosition(pos, th) {
  for (const t of th || []) {
    const from = num(t.fields.ranking_from);
    const to = num(t.fields.ranking_to);
    if (from !== null && pos >= from && (to === null || pos <= to)) return t.rank;
  }
  return null;
}

function parseCircles(body, offset = 0, th = []) {
  return findList(body).flatMap((it, i) => {
    if (!it || typeof it !== "object") return [];
    const inner = it.circle && typeof it.circle === "object" ? it.circle : {};
    const o = { ...inner, ...it };
    const rank = num(pick(o, ["live_rank", "monthly_rank", "rank", "ranking", "position"])) ?? offset + i + 1;
    const tierRaw = num(pick(o, ["club_rank", "rank_index", "tier"]));
    const tier = tierRaw !== null && tierRaw >= 1 && tierRaw <= 11 ? tierRaw : tierFromPosition(rank, th);
    const ld = o.leader && typeof o.leader === "object" ? o.leader : {};
    const leaderId = pick(o, ["leader_viewer_id", "leader_id", "leader_account_id"]) ?? pick(ld, ["viewer_id", "account_id", "id"]);
    const leaderName = pick(o, ["leader_name", "leader_trainer_name"]) ?? pick(ld, ["trainer_name", "name"]);
    return [{
      id: str(pick(o, ["circle_id", "id"])),
      name: str(pick(o, ["name", "circle_name"])) || "(tanpa nama)",
      rank, tier,
      live: num(pick(o, ["live_points", "live_fans", "live_point"])),
      monthly: num(pick(o, ["monthly_point", "monthly_points", "monthly_fans"])),
      members: num(pick(o, ["member_count", "members"])),
      leaderId: leaderId != null ? String(leaderId) : "",
      leaderName: leaderName != null ? String(leaderName) : null,
    }];
  });
}

// ---------- detail club ----------
// daily_fans[i] = total fans kumulatif member di akhir hari i (0 = baseline akhir bulan lalu).
// Negatif = penanda pindah circle, 0 di tengah = scrape terlewat.
function analyse(daily) {
  const raw = Array.isArray(daily) ? daily.map((x) => num(x)) : [];
  const first = raw.findIndex((x) => x !== null && x > 0);
  let last = -1;
  raw.forEach((x, i) => { if (x !== null && x > 0) last = i; });
  const neg = raw.findIndex((x, i) => x !== null && x < 0 && (first < 0 || i > first));
  const leftDay = neg >= 0 && last < neg ? neg : null;
  if (first < 0) return { total: null, monthGain: null, lastDayGain: null, avgPerDay: null, days: [], joinedDay: -1, lastDay: -1, leftDay, raw };
  const f = [];
  for (let i = first; i <= last; i++) f[i] = raw[i] !== null && raw[i] > 0 ? raw[i] : f[i - 1];
  const days = [];
  for (let i = first + 1; i <= last; i++) days.push({ day: i, gain: f[i] - f[i - 1] });
  const monthGain = f[last] - f[first];
  const present = Math.max(1, last - first);
  return {
    total: f[last], monthGain, lastDayGain: days.length ? days[days.length - 1].gain : 0,
    avgPerDay: Math.round(monthGain / present), days, joinedDay: first, lastDay: last, leftDay, raw,
  };
}

function parseClub(body) {
  if (!body || typeof body !== "object") return null;
  const c = body.circle && typeof body.circle === "object" ? body.circle : body;
  const leaderId = str(c.leader_viewer_id);
  const members = (Array.isArray(body.members) ? body.members : []).flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const viewerId = str(o.viewer_id);
    return [{
      viewerId, name: str(o.trainer_name) || "(tanpa nama)", isLeader: viewerId !== "" && viewerId === leaderId,
      updated: o.last_updated ? str(o.last_updated) : null,
      prevCircleName: str(o.previous_circle_name),
      ...analyse(o.daily_fans),
    }];
  });
  const leader = members.find((m) => m.isLeader);
  const tier = num(body.club_rank);
  return {
    id: str(c.circle_id), name: str(c.name) || "(tanpa nama)", leaderId, leaderName: leader?.name ?? null,
    memberCount: num(c.member_count), tier: tier !== null && tier >= 1 && tier <= 11 ? tier : null,
    liveRank: num(c.live_rank), monthlyRank: num(c.monthly_rank),
    livePoints: num(c.live_points), monthlyPoint: num(c.monthly_point),
    lastUpdated: c.last_live_update ? str(c.last_live_update) : c.last_updated ? str(c.last_updated) : null,
    toNext: num(body.fans_to_next_tier), toLower: num(body.fans_to_lower_tier), members,
  };
}

// Member yang sudah tidak di circle: "marker" (daily_fans negatif) atau "likely" (baris lebih banyak dari member_count).
function detectLeft(c) {
  const out = new Map();
  c.members.forEach((m) => { if (m.leftDay !== null) out.set(m.viewerId, "marker"); });
  if (c.memberCount === null) return out;
  const extra = c.members.length - out.size - c.memberCount;
  if (extra <= 0) return out;
  const rest = c.members.filter((m) => !out.has(m.viewerId));
  if (!rest.length) return out;
  const t = (m) => { const v = m.updated ? Date.parse(m.updated) : NaN; return Number.isNaN(v) ? 0 : v; };
  const maxDay = Math.max(...rest.map((m) => m.lastDay));
  const maxUpd = Math.max(...rest.map(t));
  rest
    .filter((m) => m.lastDay < maxDay || t(m) < maxUpd - 6 * 3600e3)
    .sort((a, b) => a.lastDay - b.lastDay || t(a) - t(b))
    .slice(0, extra)
    .forEach((m) => out.set(m.viewerId, "likely"));
  return out;
}

// Gain N hari terakhir (default 7) dengan jendela yang sama untuk semua member: hari kompetisi (endDay-n+1 .. endDay).
// Member yang baru masuk / datanya berhenti lebih awal otomatis hanya terhitung pada hari yang tercatat.
function windowGain(days, endDay, n = 7) {
  if (endDay < 1) return null;
  const sel = days.filter((d) => d.day > endDay - n && d.day <= endDay);
  return sel.length ? sel.reduce((s, d) => s + d.gain, 0) : 0;
}

// Gain per minggu kalender kompetisi: Minggu 1 = H1-7, Minggu 2 = H8-14, dst. Minggu terakhir bisa belum penuh.
function weeklyBuckets(days, endDay) {
  const out = [];
  for (let w = 1; (w - 1) * 7 + 1 <= endDay; w++) {
    const from = (w - 1) * 7 + 1;
    const to = Math.min(w * 7, endDay);
    const gain = days.filter((d) => d.day >= from && d.day <= to).reduce((s, d) => s + d.gain, 0);
    out.push({ week: w, from, to, gain, partial: to - from + 1 < 7 });
  }
  return out;
}

// Hari kompetisi terbaru di club (dipakai sebagai ujung jendela 7 hari / minggu).
const clubEndDay = (club) => Math.max(-1, ...club.members.map((m) => m.lastDay));

// Fans club per minggu: gain harian semua member dijumlahkan per hari, lalu dikelompokkan per minggu.
function clubWeeklyBuckets(club) {
  const endDay = clubEndDay(club);
  if (endDay < 1) return [];
  const byDay = new Map();
  for (const m of club.members) for (const d of m.days) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.gain);
  return weeklyBuckets([...byDay].map(([day, gain]) => ({ day, gain })), endDay);
}

module.exports = {
  RANK_NAMES, rankIcon, parseRanks, parseCircles, parseClub, detectLeft, findTotal, tierFromPosition,
  windowGain, weeklyBuckets, clubEndDay, clubWeeklyBuckets,
};
