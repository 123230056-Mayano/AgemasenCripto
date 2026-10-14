// =====================================================
// Ambil teks dari pesan yang di-REPLY user (contextInfo.quotedMessage).
// Dipakai supaya AI tahu isi pesan yang dibalas, bukan cuma pertanyaan
// user-nya. Return null kalau gak ada reply / pesan yang di-reply gak
// punya teks (mis. gambar tanpa caption -- itu ditangani vision.js).
// =====================================================
function getQuotedText(msg, maxChars = 800) {
  const m = msg.message || {};
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo;

  const q = ctx?.quotedMessage;
  if (!q) return null;

  const text =
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    q.documentMessage?.caption ||
    "";

  const clean = text.trim();
  if (!clean) return null;

  return {
    text: clean.length > maxChars ? clean.slice(0, maxChars) + "…" : clean,
    participant: ctx.participant || null, // JID pengirim pesan asli
  };
}

module.exports = { getQuotedText };
