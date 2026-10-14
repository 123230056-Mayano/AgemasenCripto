// =====================================================
// Alias command lintas bahasa.
//
// Nama command "kanonik" di kode tetap yang lama (!ringkas, !artikel,
// !lupain, !langganan) supaya log/dashboard & kebiasaan user lama gak
// berubah. Tapi menu bahasa Inggris sekarang menampilkan nama Inggrisnya
// (!summarize, !article, !forget, !subscription), jadi di sini nama-nama
// itu DIPETAKAN balik ke nama kanonik sebelum router memproses pesan.
// Dua-duanya selalu valid di bahasa mana pun.
// =====================================================
const COMMAND_ALIASES = {
  "!summarize": "!ringkas",
  "!summary": "!ringkas",
  "!article": "!artikel",
  "!forget": "!lupain",
  "!subscription": "!langganan",
  "!thread": "!dlt",
};

// "!Summarize tolong fokus ke kesimpulan" -> "!ringkas tolong fokus ke kesimpulan"
// Hanya kata command pertama yang diganti; sisa teks (argumen) tidak disentuh.
function normalizeCommandAlias(text) {
  if (typeof text !== "string" || !text.startsWith("!")) return text;
  const m = text.match(/^(\S+)([\s\S]*)$/);
  if (!m) return text;
  const canonical = COMMAND_ALIASES[m[1].toLowerCase()];
  return canonical ? canonical + m[2] : text;
}

module.exports = { COMMAND_ALIASES, normalizeCommandAlias };
