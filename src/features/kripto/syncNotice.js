"use strict";

/**
 * features/kripto/syncNotice.js
 * ------------------------------------------------------------------
 * Setelah command yang mengubah data (watchlist, alert, harian, alarm divergence, !tf)
 * selesai membalas, tunggu penyimpanan ke Supabase. Kalau gagal, user diberi tahu
 * (bukan pura-pura sukses) -- pola sama dengan setLang di languageStore.js.
 *
 * Perubahan yang gagal tersimpan tetap aman di memori + file cadangan dan dicoba lagi
 * otomatis oleh store, jadi pesan ini hanya peringatan, bukan error.
 */

const { t } = require("../../i18n");
const store = require("../../state/cryptoStore");

async function warnIfUnsynced(sock, msg, { jid, lang, senderId }) {
  try {
    if (await store.flushUser(senderId)) return;
    await sock.sendMessage(jid, { text: t(lang, "store.unsynced") }, { quoted: msg });
  } catch (err) {
    console.log("[kripto] gagal mengirim peringatan sinkronisasi:", err.message);
  }
}

/** Bungkus runner: jalankan seperti biasa, lalu peringatkan user kalau penyimpanan gagal. */
const withSyncNotice = (fn) => async (sock, msg, ctx, args) => {
  const result = await fn(sock, msg, ctx, args);
  await warnIfUnsynced(sock, msg, ctx);
  return result;
};

module.exports = { warnIfUnsynced, withSyncNotice };
