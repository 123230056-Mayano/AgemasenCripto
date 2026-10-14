// =====================================================
// i18n sederhana: 2 bahasa (id = Indonesia, en = English).
//
//   t(lang, "key", { var: 1 })  ->  string terjemahan, {var} diganti nilainya
//
// Urutan fallback kalau key gak ada: bahasa yang diminta -> bahasa default
// -> nama key itu sendiri (supaya kelihatan jelas di chat kalau ada key
// yang lupa ditambahin, bukan crash).
//
// Bahasa DEFAULT diatur lewat env DEFAULT_LANG (id/en), default "id" --
// jadi perilaku bot lama (semua Indonesia) tetap sama buat grup/nomor yang
// belum pernah ganti bahasa.
// =====================================================
const id = require("./locales/id");
const en = require("./locales/en");

const LOCALES = { id, en };
const SUPPORTED_LANGS = Object.keys(LOCALES);
const LANG_NAMES = { id: "Bahasa Indonesia", en: "English" };

const envDefault = String(process.env.DEFAULT_LANG || "id").trim().toLowerCase();
const DEFAULT_LANG = SUPPORTED_LANGS.includes(envDefault) ? envDefault : "id";

// Alias yang boleh diketik user -> kode bahasa resmi. null kalau gak dikenal.
const ALIASES = {
  id: "id",
  ind: "id",
  indo: "id",
  indonesia: "id",
  indonesian: "id",
  "bahasa indonesia": "id",
  en: "en",
  eng: "en",
  english: "en",
  inggris: "en",
  "bahasa inggris": "en",
};

function normalizeLang(input) {
  const key = String(input || "").trim().toLowerCase();
  return ALIASES[key] || null;
}

function isSupportedLang(lang) {
  return SUPPORTED_LANGS.includes(lang);
}

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) =>
    vars[name] === undefined || vars[name] === null ? m : String(vars[name]),
  );
}

function t(lang, key, vars) {
  const l = isSupportedLang(lang) ? lang : DEFAULT_LANG;
  const raw = LOCALES[l][key] ?? LOCALES[DEFAULT_LANG][key] ?? key;
  return interpolate(raw, vars);
}

// Bikin fungsi pendek terikat ke 1 bahasa: const tr = translator("en");
function translator(lang) {
  return (key, vars) => t(lang, key, vars);
}

module.exports = {
  t,
  translator,
  normalizeLang,
  isSupportedLang,
  SUPPORTED_LANGS,
  LANG_NAMES,
  DEFAULT_LANG,
};
