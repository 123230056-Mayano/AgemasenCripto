// src/utils/humanize.js
//
// Membungkus sock.sendMessage supaya pola kirim bot lebih mirip orang:
//   1. Tiap chat diproses berurutan (tidak ada 2 pesan ke chat yang sama
//      terkirim bersamaan).
//   2. Ada jeda antar-kirim GLOBAL (lintas chat) dengan jitter acak, jadi
//      bot tidak "menembak" belasan pesan dalam sekian ratus ms.
//   3. Ada batas pesan per menit (global & per chat). Kelebihan antre, bukan dibuang.
//   4. Sebelum kirim: "typing..." (composing) dengan durasi sesuai panjang
//      teks + acak. Sesudah kirim: "paused".
//   5. Opsional: tandai pesan masuk sebagai dibaca dengan jeda acak.
//
// Semua angka bisa diubah lewat env var (lihat CFG di bawah).

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);

const CFG = {
  // Jeda minimum antar-kirim global (ms), ditambah jitter acak 0..JITTER.
  GLOBAL_GAP_MS: num(process.env.HUMAN_GLOBAL_GAP_MS, 1200),
  GLOBAL_JITTER_MS: num(process.env.HUMAN_GLOBAL_JITTER_MS, 1500),
  // Jeda minimum antar-pesan ke chat YANG SAMA.
  CHAT_GAP_MS: num(process.env.HUMAN_CHAT_GAP_MS, 1500),
  // Batas kirim per 60 detik.
  MAX_GLOBAL_PER_MIN: num(process.env.HUMAN_MAX_GLOBAL_PER_MIN, 25),
  MAX_CHAT_PER_MIN: num(process.env.HUMAN_MAX_CHAT_PER_MIN, 8),
  // Durasi "typing": base + perChar * panjang teks, dibatasi min/max, lalu diacak +-25%.
  TYPE_BASE_MS: num(process.env.HUMAN_TYPE_BASE_MS, 500),
  TYPE_PER_CHAR_MS: num(process.env.HUMAN_TYPE_PER_CHAR_MS, 25),
  TYPE_MIN_MS: num(process.env.HUMAN_TYPE_MIN_MS, 700),
  TYPE_MAX_MS: num(process.env.HUMAN_TYPE_MAX_MS, 4500),
  // Untuk media (gambar/video/sticker/dokumen) cukup jeda singkat.
  MEDIA_PAUSE_MS: num(process.env.HUMAN_MEDIA_PAUSE_MS, 900),
  // Matikan semua humanizer: HUMAN_DISABLE=1
  DISABLED: process.env.HUMAN_DISABLE === "1",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const jitter = (ms, pct = 0.25) => Math.round(ms * rand(1 - pct, 1 + pct));

function isHumanizable(content) {
  if (!content || typeof content !== "object") return false;
  // react / delete / edit / forward / poll dll. dilewatkan apa adanya.
  return (
    "text" in content ||
    "image" in content ||
    "video" in content ||
    "sticker" in content ||
    "document" in content ||
    "audio" in content
  );
}

function typingMs(content) {
  const text = content.text || content.caption || "";
  if (!text) return jitter(CFG.MEDIA_PAUSE_MS);
  const raw = CFG.TYPE_BASE_MS + text.length * CFG.TYPE_PER_CHAR_MS;
  return jitter(Math.min(CFG.TYPE_MAX_MS, Math.max(CFG.TYPE_MIN_MS, raw)));
}

function installHumanizer(sock) {
  if (CFG.DISABLED || sock.__humanized) return sock;
  sock.__humanized = true;

  const original = sock.sendMessage.bind(sock);

  const chatTail = new Map(); // jid -> Promise terakhir di rantai chat itu
  const chatLastSent = new Map(); // jid -> timestamp kirim terakhir
  const chatTimes = new Map(); // jid -> [timestamp] 60 detik terakhir
  const globalTimes = [];
  let nextGlobalSlot = 0;

  // Hapus timestamp > 60 detik, lalu kalau sudah mencapai batas, tunggu
  // sampai yang paling tua kedaluwarsa.
  async function respectPerMinute(arr, max) {
    for (;;) {
      const now = Date.now();
      while (arr.length && now - arr[0] > 60_000) arr.shift();
      if (arr.length < max) return;
      await sleep(arr[0] + 60_000 - now + rand(50, 400));
    }
  }

  // Reservasi slot global: slot berikutnya selalu >= gap + jitter dari slot sebelumnya.
  async function waitGlobalSlot() {
    const now = Date.now();
    const slot = Math.max(now, nextGlobalSlot);
    nextGlobalSlot = slot + CFG.GLOBAL_GAP_MS + rand(0, CFG.GLOBAL_JITTER_MS);
    if (slot > now) await sleep(slot - now);
  }

  async function humanSend(jid, content, options) {
    if (!isHumanizable(content)) return original(jid, content, options);

    const arr = chatTimes.get(jid) || [];
    chatTimes.set(jid, arr);

    // Jeda minimum ke chat yang sama.
    const sinceChat = Date.now() - (chatLastSent.get(jid) || 0);
    if (sinceChat < CFG.CHAT_GAP_MS) await sleep(CFG.CHAT_GAP_MS - sinceChat + rand(0, 500));

    await respectPerMinute(arr, CFG.MAX_CHAT_PER_MIN);
    await respectPerMinute(globalTimes, CFG.MAX_GLOBAL_PER_MIN);
    await waitGlobalSlot();

    try {
      await sock.sendPresenceUpdate("composing", jid);
    } catch {}
    await sleep(typingMs(content));

    try {
      return await original(jid, content, options);
    } finally {
      const t = Date.now();
      arr.push(t);
      globalTimes.push(t);
      chatLastSent.set(jid, t);
      sock.sendPresenceUpdate("paused", jid).catch(() => {});
    }
  }

  // Serialisasi per chat: pesan ke jid yang sama selalu berurutan.
  sock.sendMessage = (jid, content, options) => {
    const prev = chatTail.get(jid) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => humanSend(jid, content, options));
    chatTail.set(jid, run);
    run.finally(() => {
      if (chatTail.get(jid) === run) chatTail.delete(jid);
    }).catch(() => {});
    return run;
  };

  return sock;
}

// Tandai pesan masuk sudah dibaca dengan jeda acak (seperti orang membuka chat).
// Panggil di awal handleSingleMessage, hanya untuk pesan yang memang akan dibalas.
async function markReadHuman(sock, msg) {
  if (CFG.DISABLED || !msg?.key) return;
  try {
    await sleep(rand(600, 2200));
    await sock.readMessages([msg.key]);
  } catch {}
}

module.exports = { installHumanizer, markReadHuman, sleep, rand };
