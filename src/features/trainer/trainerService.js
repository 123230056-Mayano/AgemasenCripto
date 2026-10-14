const { umaSearch, UmaApiError } = require("./umaApi");
const { nameVariants, buildQueries, matchScore } = require("./names");

// Total hasil pencarian yang diambil & bisa dipilih (default 800, batas atas 800).
// TRAINER_MAX_LIST tetap dibaca supaya env lama di server tidak error.
const MAX_LIST = Math.max(2, Math.min(800, Number(process.env.TRAINER_MAX_LIST || process.env.TRAINER_MAX_RESULTS) || 800));
const FETCH_LIMIT = 50;      // item per request ke uma.moe
const PARALLEL_PAGES = 3;    // berapa halaman API diambil bersamaan (jaga rate limit)

// ID trainer = 9-12 digit (spasi/strip dibuang: "2430-2808-5654")
function parseTrainerId(q) {
  const digits = q.replace(/[\s-]/g, "");
  return /^\d{9,12}$/.test(digits) ? digits : null;
}

// Gabung item dengan account_id sama (API bisa memberi baris inheritance & support card terpisah).
function mergeItems(lists) {
  const map = new Map();
  for (const items of lists) {
    for (const it of items || []) {
      const id = String(it?.account_id ?? "");
      if (!id) continue;
      const prev = map.get(id);
      map.set(id, prev ? { ...prev, ...it, inheritance: it.inheritance || prev.inheritance, support_card: it.support_card || prev.support_card } : it);
    }
  }
  return Array.from(map.values());
}

const baseParams = { page: 0, limit: FETCH_LIMIT, search_type: "all" };

// Jumlah halaman total dari respons (nama field beda-beda antar versi API -> toleran).
function totalPagesOf(data, perPage) {
  const direct = Number(data?.total_pages ?? data?.totalPages ?? data?.pages);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const total = Number(data?.total ?? data?.total_count ?? data?.count);
  if (Number.isFinite(total) && total >= 0) return Math.max(1, Math.ceil(total / perPage));
  return null; // tidak diketahui -> lanjut sampai halaman kosong
}

// Ambil semua halaman hasil pencarian sampai `cap` item (atau habis).
// Halaman pertama gagal -> error dilempar. Halaman berikutnya gagal -> pakai yang sudah didapat.
async function searchAllPages(params, cap = MAX_LIST) {
  const first = await umaSearch({ ...params, page: 0 });
  const perPage = Math.max(1, Number(params.limit) || FETCH_LIMIT);
  const totalPages = totalPagesOf(first, perPage);
  const seen = new Set();
  const items = [];
  const take = (list) => {
    let added = 0;
    for (const it of list || []) {
      const id = String(it?.account_id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(it);
      added++;
    }
    return added;
  };
  let lastAdded = take(first.items);
  let next = 1;
  let done = (first.items || []).length < perPage || (totalPages != null && totalPages <= 1);

  while (!done && items.length < cap && lastAdded > 0) {
    const pages = [];
    for (let i = 0; i < PARALLEL_PAGES && (totalPages == null || next + i < totalPages); i++) pages.push(next + i);
    if (!pages.length) break;
    const res = await Promise.allSettled(pages.map((pg) => umaSearch({ ...params, page: pg })));
    for (const r of res) {
      if (r.status !== "fulfilled") { done = true; break; } // sebagian saja -> berhenti, simpan yang ada
      lastAdded = take(r.value.items);
      if ((r.value.items || []).length < perPage || lastAdded === 0) { done = true; break; }
    }
    next += pages.length;
    if (totalPages != null && next >= totalPages) done = true;
  }
  return items.slice(0, cap);
}

// -> { mode: "id" | "name", items: [...] }  (items sudah diurutkan paling mirip dulu)
async function findTrainers(query) {
  const q = query.trim();
  const id = parseTrainerId(q);
  if (id) {
    const data = await umaSearch({ ...baseParams, limit: 5, trainer_id: id });
    return { mode: "id", items: mergeItems([data.items]) };
  }

  const queries = buildQueries(q);
  const settled = await Promise.allSettled(queries.map((name) => searchAllPages({ ...baseParams, trainer_name: name })));
  const ok = settled.filter((s) => s.status === "fulfilled");
  if (!ok.length) throw settled[0].reason; // semua gagal -> lempar error pertama
  let items = mergeItems(ok.map((s) => s.value));

  // kosong -> coba varian tanda baca (fullwidth/ASCII/tanpa kurung), berurutan
  if (!items.length) {
    for (const v of nameVariants(q).slice(1)) {
      try {
        items = mergeItems([await searchAllPages({ ...baseParams, trainer_name: v })]);
        if (items.length) break;
      } catch (e) {
        if (!(e instanceof UmaApiError) || e.code !== "NETWORK") throw e;
      }
    }
  }

  items.sort(
    (a, b) =>
      matchScore(a.trainer_name, q) - matchScore(b.trainer_name, q) ||
      (b.follower_num || 0) - (a.follower_num || 0),
  );
  return { mode: "name", items: items.slice(0, MAX_LIST) };
}

module.exports = { findTrainers, parseTrainerId, MAX_LIST };
