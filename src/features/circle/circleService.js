// Pengambilan data circle/club + cache. Dipakai !club, !threshold, !leaderboard.
const { umaCircle, umaCircleList, umaThresholds, UmaApiError } = require("../trainer/umaApi");
const { nameVariants, matchScore } = require("../trainer/names");
const { parseRanks, parseCircles, parseClub } = require("./parse");

const CLUB_MAX_LIST = Math.max(2, Math.min(50, Number(process.env.CLUB_MAX_LIST) || 30));
const LEADERBOARD_SIZE = 50;
const LEADER_CONCURRENCY = 5;

// ---------- cache kecil ----------
const THRESH_TTL = 5 * 60 * 1000;
let threshCache = null; // { rows, expires }
let threshInflight = null;

async function getThresholds() {
  if (threshCache && threshCache.expires > Date.now()) return threshCache.rows;
  if (!threshInflight) {
    threshInflight = umaThresholds()
      .then((body) => {
        const rows = parseRanks(body);
        if (!rows.length) throw new UmaApiError("HTTP", "rank-thresholds kosong/tidak dikenali");
        threshCache = { rows, expires: Date.now() + THRESH_TTL };
        return rows;
      })
      .finally(() => { threshInflight = null; });
  }
  return threshInflight;
}

// untuk tier ikon di daftar: gagal tidak boleh menggagalkan fitur
async function getThresholdsSafe() {
  try { return await getThresholds(); } catch { return threshCache?.rows || []; }
}

// leader jarang berubah -> cache 6 jam. circle_id -> { id, name, expires }
const leaderCache = new Map();
const LEADER_TTL = 6 * 60 * 60 * 1000;
const LEADER_CACHE_MAX = 3000;

async function fetchLeader(circleId) {
  const hit = leaderCache.get(circleId);
  if (hit && hit.expires > Date.now()) return hit;
  const club = parseClub(await umaCircle(circleId));
  const val = { id: club?.leaderId || "", name: club?.leaderName || null, expires: Date.now() + LEADER_TTL };
  if (leaderCache.size >= LEADER_CACHE_MAX) leaderCache.delete(leaderCache.keys().next().value);
  leaderCache.set(circleId, val);
  return val;
}

// Isi leaderName/leaderId yang kosong lewat endpoint detail (paralel terbatas). Gagal -> dibiarkan kosong.
async function fillLeaders(rows) {
  const todo = rows.filter((r) => r.id && !r.leaderName);
  let i = 0;
  let stop = false; // kena rate limit -> berhenti, sisanya "-"
  await Promise.all(
    Array.from({ length: Math.min(LEADER_CONCURRENCY, todo.length) }, async () => {
      while (!stop && i < todo.length) {
        const r = todo[i++];
        try {
          const l = await fetchLeader(r.id);
          if (l.name) r.leaderName = l.name;
          if (l.id && !r.leaderId) r.leaderId = l.id;
        } catch (e) {
          if (e instanceof UmaApiError && (e.code === "RATE" || e.code === "AUTH" || e.code === "NO_KEY")) stop = true;
        }
      }
    }),
  );
  return rows;
}

// ---------- !club ----------
const isCircleId = (q) => /^\d{5,12}$/.test(q.replace(/[\s-]/g, ""));

// -> club (parseClub) atau null kalau ID tidak ada
async function getClub(circleId) {
  try {
    return parseClub(await umaCircle(circleId));
  } catch (e) {
    if (e instanceof UmaApiError && e.code === "HTTP") return null; // 404 dsb -> anggap tidak ada
    throw e;
  }
}

async function listByName(name) {
  const body = await umaCircleList({ page: 0, limit: 50, name });
  return parseCircles(body, 0, []);
}

// Cari circle dari nama: asli dulu, kalau kosong coba varian kurung/tanda baca.
async function searchClubs(query) {
  const q = query.trim();
  let rows = await listByName(q);
  if (!rows.length) {
    for (const v of nameVariants(q).slice(1)) {
      try { rows = await listByName(v); } catch (e) { if (!(e instanceof UmaApiError) || e.code !== "NETWORK") throw e; }
      if (rows.length) break;
    }
  }
  const seen = new Set();
  rows = rows.filter((r) => r.id && !seen.has(r.id) && seen.add(r.id));
  rows.sort((a, b) => matchScore(a.name, q) - matchScore(b.name, q)); // sort stabil: urutan API dipertahankan
  rows = rows.slice(0, CLUB_MAX_LIST);

  const th = await getThresholdsSafe();
  const { tierFromPosition } = require("./parse");
  for (const r of rows) if (!r.tier) r.tier = tierFromPosition(r.rank, th);
  await fillLeaders(rows);
  return rows;
}

// ---------- !leaderboard ----------
async function getLeaderboard() {
  const [body, th] = await Promise.all([umaCircleList({ page: 0, limit: LEADERBOARD_SIZE }), getThresholdsSafe()]);
  let rows = parseCircles(body, 0, th).sort((a, b) => a.rank - b.rank).slice(0, LEADERBOARD_SIZE);
  await fillLeaders(rows);
  return rows;
}

module.exports = { getThresholds, getClub, searchClubs, getLeaderboard, isCircleId, CLUB_MAX_LIST, LEADERBOARD_SIZE };
