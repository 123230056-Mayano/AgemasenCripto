// !lang / !bahasa / !language -- ganti bahasa bot.
//
//   !lang            lihat bahasa sekarang + cara ganti
//   !lang en         ganti ke English
//   !lang id         ganti ke Bahasa Indonesia
//
// Cakupan pengaturan:
//   - DM (chat pribadi): disimpan PER NOMOR user itu.
//   - Grup:              disimpan PER GRUP (berlaku buat seluruh anggota).
//                        Yang boleh ganti: admin grup atau owner bot.
//                        Anggota biasa tetap boleh LIHAT bahasa sekarang.
const { jidNormalizedUser } = require("@whiskeysockets/baileys");
const { isOwnerMsg, getSenderJid } = require("../../utils/whatsapp");
const { t, normalizeLang, SUPPORTED_LANGS, LANG_NAMES } = require("../../i18n");
const {
  getLang,
  setLang,
  hasExplicitLang,
  isLanguageStoreEnabled,
} = require("../../state/languageStore");

const safeNormalize = (jid) => {
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid;
  }
};

// Admin grup? Peserta bisa berbentuk @lid atau nomor asli, jadi cocokkan ke
// KEDUA bentuk (id & phoneNumber) terhadap semua jid pengirim yang mungkin.
async function isGroupAdmin(sock, groupJid, msg) {
  const meta = await sock.groupMetadata(groupJid);
  const senderForms = [
    msg.key.participant,
    msg.key.participantPn,
    getSenderJid(msg),
  ]
    .filter(Boolean)
    .map(safeNormalize);

  return (meta.participants || []).some((p) => {
    if (p.admin !== "admin" && p.admin !== "superadmin") return false;
    const forms = [p.id, p.phoneNumber].filter(Boolean).map(safeNormalize);
    return forms.some((f) => senderForms.includes(f));
  });
}

async function handleLanguageCommand(sock, msg, { jid, text, lang }) {
  const m = text.match(/^[!.](?:lang|bahasa|language)(?:\s+(.+))?\s*$/i);
  if (!m) return false;

  const isGroup = jid.endsWith("@g.us");
  const kind = isGroup ? "group" : "user";
  const targetJid = isGroup ? jid : getSenderJid(msg);
  if (!targetJid) return true;

  const arg = (m[1] || "").trim();
  const scopeLabel = t(lang, isGroup ? "lang.scope.group" : "lang.scope.user");
  const langList = SUPPORTED_LANGS.map((l) => `• *!lang ${l}* -> ${LANG_NAMES[l]}`).join("\n");

  // Tanpa argumen -> tampilkan status.
  if (!arg) {
    await sock.sendMessage(jid, {
      text: t(lang, "lang.current", {
        scope: scopeLabel,
        language: LANG_NAMES[lang],
        source: t(lang, hasExplicitLang(kind, targetJid) ? "lang.source.set" : "lang.source.default"),
        list: langList,
      }),
    });
    return true;
  }

  const newLang = normalizeLang(arg);
  if (!newLang) {
    await sock.sendMessage(jid, {
      text: t(lang, "lang.invalid", { input: arg.slice(0, 40), list: langList }),
    });
    return true;
  }

  if (!isLanguageStoreEnabled()) {
    await sock.sendMessage(jid, { text: t(lang, "lang.notConfigured") });
    return true;
  }

  // Grup: cuma admin/owner. (Gagal ambil metadata -> tolak dengan pesan error,
  // bukan diloloskan, supaya anggota biasa tidak bisa lewat saat WA gangguan.)
  if (isGroup && !isOwnerMsg(msg)) {
    let allowed = false;
    try {
      allowed = await isGroupAdmin(sock, jid, msg);
    } catch (err) {
      console.log("[!lang] gagal cek admin grup:", err.message || err);
      await sock.sendMessage(jid, { text: t(lang, "lang.adminCheckFailed") });
      return true;
    }
    if (!allowed) {
      await sock.sendMessage(jid, { text: t(lang, "lang.adminOnly") });
      return true;
    }
  }

  if (newLang === lang && hasExplicitLang(kind, targetJid)) {
    await sock.sendMessage(jid, {
      text: t(lang, "lang.already", { language: LANG_NAMES[lang] }),
    });
    return true;
  }

  try {
    await setLang(kind, targetJid, newLang, getSenderJid(msg));
  } catch (err) {
    console.log("[!lang] gagal simpan ke Supabase:", err.message || err);
    await sock.sendMessage(jid, { text: t(lang, "lang.saveFailed") });
    return true;
  }

  // Konfirmasi pakai bahasa BARU supaya langsung kelihatan efeknya.
  await sock.sendMessage(jid, {
    text: t(newLang, "lang.changed", {
      scope: t(newLang, isGroup ? "lang.scope.group" : "lang.scope.user"),
      language: LANG_NAMES[newLang],
    }),
  });
  return true;
}

module.exports = { handleLanguageCommand, isGroupAdmin };
