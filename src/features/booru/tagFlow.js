// =====================================================================
// Pencarian !img yang fleksibel (gak perlu nulis tag persis kayak di
// Safebooru).
//
//   !img special week                -> daftar pilihan tag untuk "special week"
//   !img special week silence suzuka -> daftar pilihan untuk "special week",
//                                       lalu daftar untuk "silence suzuka",
//                                       lalu gambar yang memuat keduanya
//
// Cara kerja:
//  1. Kata-kata dipotong jadi beberapa "slot" (satu slot = satu tag).
//     Pemotongan dicoba dari kelompok kata TERPANJANG dulu yang punya tag
//     cocok di Safebooru ("special week" lebih dulu daripada "special").
//  2. Tiap slot dicari tag yang cocok lewat wildcard (special%week).
//  3. Slot yang jawabannya sudah jelas (ada tag yang namanya persis sama,
//     mis. "umamusume", atau cuma ada 1 kandidat) dipilih otomatis. Sisanya
//     ditanyakan ke user satu per satu.
//
// Kata yang ditulis dengan gaya tag asli (ada "_", "(", ":" dst, atau
// diawali "-" / "~") dianggap SUDAH berupa tag & dipakai apa adanya, jadi
// cara lama (!img special_week_(umamusume)) tetap jalan.
// =====================================================================
const { fetchMatchingTags } = require("./safebooru");

// Batas jumlah kata supaya jumlah request ke Safebooru tetap wajar.
const MAX_WORDS = 8;
// Batas jumlah pilihan yang ditampilkan di daftar (diurutkan dari post
// terbanyak), biar pesan WhatsApp gak kepanjangan.
const MAX_CHOICES = 20;
// Kandidat tag per slot cukup ditarik dari beberapa halaman pertama.
const MAX_TAG_PAGES = 3;

function isExplicitTagToken(tok) {
  return /[_():*]/.test(tok) || /^[-~]/.test(tok);
}

// True kalau SEMUA kata sudah berupa tag asli -> pakai alur lama.
function isAllExplicit(raw) {
  const toks = String(raw).replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
  return toks.length > 0 && toks.every(isExplicitTagToken);
}

// Pemisah antar-karakter: KOMA. Kalau ada koma, tiap bagian di antara koma
// dianggap SATU karakter/tag (gak dipotong otomatis lagi):
//   !img special week, silence suzuka
// Kalau gak ada koma sama sekali, bot menebak potongannya sendiri (lihat
// pemotongan "terpanjang dulu" di bawah).
async function buildSlots(raw) {
  const parts = String(raw)
    .split(",")
    .map((p) => p.trim().split(/\s+/).filter(Boolean))
    .filter((p) => p.length > 0);
  const commaMode = parts.length > 1 || String(raw).includes(",");

  const plainCount = parts
    .flat()
    .filter((t) => !isExplicitTagToken(t)).length;
  if (plainCount > MAX_WORDS) return { ok: false, tooMany: true };

  // Cache per-pencarian supaya pola yang sama gak ditarik 2x.
  const cache = new Map();
  const lookup = (words) => {
    const key = words.join(" ").toLowerCase();
    if (!cache.has(key)) {
      cache.set(key, fetchMatchingTags(key, { maxPages: MAX_TAG_PAGES }));
    }
    return cache.get(key);
  };

  const slots = [];

  for (const toks of parts) {
    let i = 0;

    while (i < toks.length) {
      if (isExplicitTagToken(toks[i])) {
        slots.push({ fixed: toks[i] });
        i++;
        continue;
      }

      // ambil run kata biasa (sampai ketemu token tag-asli berikutnya)
      let runEnd = i;
      while (runEnd < toks.length && !isExplicitTagToken(toks[runEnd])) runEnd++;
      const run = toks.slice(i, runEnd);

      if (commaMode) {
        // satu bagian di antara koma = satu tag, tanpa dipotong lagi
        const matches = await lookup(run);
        if (matches.length === 0) return { ok: false, failedWord: run.join(" ") };
        slots.push({ words: run, matches });
        i = runEnd;
        continue;
      }

      let p = 0;
      while (p < run.length) {
        // coba semua panjang kelompok sekaligus (paralel), pilih terpanjang
        // yang ada hasilnya.
        const ends = [];
        for (let e = p + 1; e <= run.length; e++) ends.push(e);
        const results = await Promise.all(
          ends.map((e) => lookup(run.slice(p, e))),
        );

        let pick = -1;
        for (let k = ends.length - 1; k >= 0; k--) {
          if (results[k].length > 0) {
            pick = k;
            break;
          }
        }

        if (pick === -1) return { ok: false, failedWord: run[p] };

        const words = run.slice(p, ends[pick]);
        slots.push({ words, matches: results[pick] });
        p = ends[pick];
      }

      i = runEnd;
    }
  }

  return { ok: true, slots };
}

// Maju ke slot berikutnya yang BELUM terpilih. Slot yang jelas dipilih
// otomatis. Return:
//   { done: true, tags: [...] }                       -> semua slot beres
//   { done: false, slotIdx, slot, matches, total }    -> perlu ditanyakan
function advance(flow) {
  const { slots, picked } = flow;

  for (let i = 0; i < slots.length; i++) {
    if (picked[i]) continue;
    const slot = slots[i];

    if (slot.fixed) {
      picked[i] = slot.fixed;
      continue;
    }

    const exact = slot.matches.find(
      (m) => m.name.toLowerCase() === slot.words.join("_").toLowerCase(),
    );
    if (exact) {
      picked[i] = exact.name;
      continue;
    }
    if (slot.matches.length === 1) {
      picked[i] = slot.matches[0].name;
      continue;
    }

    return {
      done: false,
      slotIdx: i,
      slot,
      matches: slot.matches.slice(0, MAX_CHOICES),
      total: slot.matches.length,
    };
  }

  // hilangkan duplikat tag (mis. dipilih 2x) tapi jaga urutan
  return { done: true, tags: [...new Set(picked)] };
}

// Hitung berapa slot yang butuh pertanyaan (buat label "1/2").
function countAskable(slots) {
  return slots.filter(
    (s) =>
      !s.fixed &&
      s.matches.length > 1 &&
      !s.matches.some(
        (m) => m.name.toLowerCase() === s.words.join("_").toLowerCase(),
      ),
  ).length;
}

module.exports = {
  MAX_CHOICES,
  isAllExplicit,
  buildSlots,
  advance,
  countAskable,
};
