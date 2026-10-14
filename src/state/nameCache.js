const fs = require("fs");
const path = require("path");
const { BOT_STATE_DATA_DIR } = require("../config/env");

// Disimpan ke disk (debounced) supaya nama tidak hilang tiap bot restart --
// dipakai !groupinfo untuk menampilkan nama admin berbentuk @lid.
const NAME_CACHE_FILE =
  process.env.NAME_CACHE_FILE || path.join(BOT_STATE_DATA_DIR, "name_cache.json");
const MAX_ENTRIES = 5000;
const SAVE_DEBOUNCE_MS = 10_000;

const nameCache = new Map();
let saveTimer = null;

try {
  const parsed = JSON.parse(fs.readFileSync(NAME_CACHE_FILE, "utf8"));
  for (const [jid, name] of Object.entries(parsed || {})) {
    if (typeof name === "string" && name) nameCache.set(jid, name);
  }
} catch {
  // belum ada file / rusak -> mulai kosong
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(NAME_CACHE_FILE), { recursive: true });
      const tmp = NAME_CACHE_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(nameCache)));
      fs.renameSync(tmp, NAME_CACHE_FILE); // atomik
    } catch (err) {
      console.log("Gagal nyimpen name_cache.json:", err.message);
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

function rememberName(jid, pushName) {
  if (!jid || !pushName) return;
  const trimmed = String(pushName).trim();
  if (!trimmed) return;
  if (nameCache.get(jid) === trimmed) return; // tidak berubah -> tidak perlu tulis disk
  nameCache.set(jid, trimmed);
  if (nameCache.size > MAX_ENTRIES) {
    nameCache.delete(nameCache.keys().next().value); // buang yang paling lama
  }
  scheduleSave();
}

function getCachedName(jid) {
  if (!jid) return null;
  return nameCache.get(jid) || null;
}

module.exports = { rememberName, getCachedName };
