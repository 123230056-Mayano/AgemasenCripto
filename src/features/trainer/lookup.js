// Data master GameTora (nama karakter, support card, skill). Endpoint TIDAK resmi,
// sama seperti di UMA-API-TESTER/lib/gametora.ts. Di-cache di memori 24 jam.
// Kalau gagal, kartu tetap jadi -- nama tampil sebagai ID.
const axios = require("axios");

const BASE = "https://gametora.com";
const TTL_OK = 24 * 60 * 60 * 1000;
const TTL_FAIL = 10 * 60 * 1000;
const RARITY = { 1: "R", 2: "SR", 3: "SSR" };

const EMPTY = { charas: {}, cards: {}, supports: {}, skills: { byId: {}, byGroup: {} } };
let cache = null; // { data, expires }
let inflight = null;

async function getJson(url) {
  const res = await axios.get(url, { timeout: 15000, headers: { "User-Agent": "agemasen-bot" } });
  return res.data;
}

function buildSkillIndex(list) {
  const idx = { byId: {}, byGroup: {} };
  for (const s of list) {
    idx.byId[s.id] = s;
    if (s.group && (!idx.byGroup[s.group] || Number(s.id) < Number(idx.byGroup[s.group].id))) idx.byGroup[s.group] = s;
  }
  return idx;
}

async function fetchLookup() {
  const manifest = await getJson(`${BASE}/data/manifests/umamusume.json`);
  const url = (key) => {
    if (!manifest[key]) throw new Error(`key "${key}" tidak ada di manifest GameTora`);
    return `${BASE}/data/umamusume/${key}.${manifest[key]}.json`;
  };
  const [chars, sups] = await Promise.all([getJson(url("character-cards")), getJson(url("support-cards"))]);

  const charas = {};
  const cards = {};
  for (const c of chars) {
    if (!c?.card_id || !c?.name_en) continue;
    const id = String(c.card_id);
    const title = String(c.title_en_gl || c.title || "").replace(/^\[(.+)\]$/, "$1").trim();
    cards[id] = { name: c.name_en, title };
    charas[id.slice(0, 4)] ||= c.name_en;
  }
  const supports = {};
  for (const s of sups) {
    if (!s?.support_id) continue;
    supports[String(s.support_id)] = { name: s.char_name || `Support #${s.support_id}`, rarity: RARITY[s.rarity] || "?", type: String(s.type || "") };
  }

  // skill: format belum terverifikasi -> toleran, gagal tidak mengganggu data lain
  let skills = { byId: {}, byGroup: {} };
  try {
    const key = Object.keys(manifest).find((k) => /^skills?(-data)?$/.test(k));
    if (key) {
      const raw = await getJson(url(key));
      const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
      skills = buildSkillIndex(
        arr
          .map((s) => ({
            id: String(s?.id ?? s?.skill_id ?? ""),
            name: String(s?.name_en || s?.enname || s?.name || s?.name_jp || ""),
            group: (s?.group_id ?? s?.gene_id) != null ? String(s.group_id ?? s.gene_id) : null,
          }))
          .filter((s) => s.id && s.name),
      );
    }
  } catch (e) {
    console.log("⚠️ [trainer] data skill GameTora gagal dimuat:", e.message);
  }
  return { charas, cards, supports, skills };
}

async function getLookup() {
  if (cache && cache.expires > Date.now()) return cache.data;
  if (!inflight) {
    inflight = fetchLookup()
      .then((data) => { cache = { data, expires: Date.now() + TTL_OK }; return data; })
      .catch((e) => {
        console.log("⚠️ [trainer] data GameTora gagal dimuat:", e.message);
        cache = { data: cache?.data || EMPTY, expires: Date.now() + TTL_FAIL };
        return cache.data;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

module.exports = { getLookup, EMPTY };
