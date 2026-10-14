// !trainer <nama|id>  -> daftar trainer mirip -> reply nomor -> kartu trainer (gambar).
const { t } = require("../../i18n");
const { findTrainers, MAX_LIST } = require("./trainerService");
const { renderTrainerCard } = require("./cardImage");
const { getLookup } = require("./lookup");
const { UmaApiError, umaProfile } = require("./umaApi");

// promptMsgId (ID pesan daftar) -> { items, q, page, expires }
// Dikunci per pesan daftar (bukan per pengirim), jadi tidak bentrok dengan sesi !img/!pin,
// dan beberapa daftar bisa aktif bersamaan. Hasil banyak (maks 800) dibagi per halaman;
// tiap halaman = satu pesan, reply "next"/"prev"/"hal 5" ke pesan itu untuk pindah halaman.
const PAGE_SIZE = Math.max(10, Math.min(60, Number(process.env.TRAINER_PAGE_SIZE) || 30));
const pending = new Map();
const PENDING_TTL_MS = 15 * 60 * 1000;
const PENDING_MAX = 400;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}, 5 * 60 * 1000).unref();

function errorText(err, lang) {
  if (err instanceof UmaApiError) {
    const key = { NO_KEY: "trainer.noKey", AUTH: "trainer.auth", RATE: "trainer.rate" }[err.code];
    if (key) return t(lang, key);
  }
  console.log("[trainer]", err?.code || "", err?.message || err);
  return t(lang, "trainer.fail");
}

// Team Stadium: gagal tidak menggagalkan kartu, cukup ditandai ok:false.
async function loadStadium(accountId) {
  try {
    const p = await umaProfile(accountId);
    return { ok: true, members: Array.isArray(p.team_stadium) ? p.team_stadium : [] };
  } catch (err) {
    console.log("[trainer] profil/team stadium gagal:", err?.code || "", err?.message || err);
    return { ok: false, members: [] };
  }
}

async function sendCard(sock, jid, msg, item, lang) {
  try { await sock.sendPresenceUpdate("composing", jid); } catch {}
  const [lookup, stadium] = await Promise.all([getLookup(), loadStadium(item.account_id)]);
  const caption = t(lang, "trainer.caption", { name: item.trainer_name || "-", id: item.account_id });
  try {
    const image = await renderTrainerCard(item, { lang, lookup, stadium });
    await sock.sendMessage(jid, { image, mimetype: "image/jpeg", caption }, { quoted: msg });
  } catch (err) {
    console.log("[trainer] gagal render kartu:", err);
    await sock.sendMessage(jid, { text: `${t(lang, "trainer.cardFail")}\n\n${caption}` }, { quoted: msg });
  }
}

const pageCount = (items) => Math.max(1, Math.ceil(items.length / PAGE_SIZE));

function buildList(items, q, lang, page = 0) {
  const pages = pageCount(items);
  const start = page * PAGE_SIZE;
  const width = String(items.length).length;
  const lines = items
    .slice(start, start + PAGE_SIZE)
    .map((it, i) => `${String(start + i + 1).padStart(width, " ")}. ${it.trainer_name || "-"}  —  ${it.account_id}`)
    .join("\n");
  const head = t(lang, "trainer.listTitle", { count: items.length, q });
  const pageLine = pages > 1 ? `\n${t(lang, "trainer.listPage", { page: page + 1, pages })}` : "";
  const nav = pages > 1 ? `\n${t(lang, "trainer.listNav")}` : "";
  return `${head}${pageLine}\n\n${lines}\n\n${t(lang, "trainer.listHint")}${nav}`;
}

// Kirim satu halaman daftar & daftarkan pesannya supaya reply berikutnya dikenali.
async function sendListPage(sock, jid, msg, items, q, lang, page) {
  const sent = await sock.sendMessage(jid, { text: buildList(items, q, lang, page) }, { quoted: msg });
  const promptId = sent?.key?.id;
  if (promptId) {
    if (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value);
    pending.set(promptId, { items, q, page, expires: Date.now() + PENDING_TTL_MS });
  }
}

// "12" -> pilih nomor 12 | "next"/"n"/">" | "prev"/"p"/"<" | "hal 5"/"page 5"/"p5"
function parseReply(text) {
  const s = text.trim().toLowerCase();
  if (/^\d{1,3}$/.test(s)) return { type: "pick", n: parseInt(s, 10) };
  if (/^(n|next|lanjut|>|>>)$/.test(s)) return { type: "next" };
  if (/^(p|prev|back|mundur|<|<<)$/.test(s)) return { type: "prev" };
  const m = s.match(/^(?:hal(?:aman)?|page|h|p)\s*(\d{1,3})$/);
  return m ? { type: "page", n: parseInt(m[1], 10) } : null;
}

async function handleTrainerCommand(sock, msg, { jid, text, lang }) {
  const m = text.match(/^!trainer(?:\s+([\s\S]*))?$/i);
  if (!m) return false;

  const q = (m[1] || "").replace(/\s+/g, " ").trim();
  if (!q) {
    await sock.sendMessage(jid, { text: t(lang, "cmd.trainer") }, { quoted: msg });
    return true;
  }
  if (q.length > 40) {
    await sock.sendMessage(jid, { text: t(lang, "trainer.tooLong") }, { quoted: msg });
    return true;
  }

  try {
    const { items } = await findTrainers(q);
    if (!items.length) {
      await sock.sendMessage(jid, { text: t(lang, "trainer.notFound", { q }) }, { quoted: msg });
      return true;
    }
    if (items.length === 1) {
      await sendCard(sock, jid, msg, items[0], lang);
      return true;
    }

    await sendListPage(sock, jid, msg, items.slice(0, MAX_LIST), q, lang, 0);
  } catch (err) {
    await sock.sendMessage(jid, { text: errorText(err, lang) }, { quoted: msg });
  }
  return true;
}

// Dipanggil sebelum handler angka milik !img. true = pesan ini balasan ke daftar trainer.
async function handleTrainerPick(sock, msg, { jid, text, lang }) {
  const reply = parseReply(text || "");
  if (!reply) return false;
  const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const entry = stanzaId ? pending.get(stanzaId) : null;
  if (!entry || entry.expires < Date.now()) return false;

  const pages = pageCount(entry.items);
  if (reply.type !== "pick") {
    const target = reply.type === "next" ? entry.page + 1 : reply.type === "prev" ? entry.page - 1 : reply.n - 1;
    if (target < 0 || target >= pages) {
      await sock.sendMessage(jid, { text: t(lang, "trainer.invalidPage", { max: pages }) }, { quoted: msg });
      return true;
    }
    await sendListPage(sock, jid, msg, entry.items, entry.q, lang, target);
    return true;
  }

  const item = entry.items[reply.n - 1];
  if (!item) {
    await sock.sendMessage(jid, { text: t(lang, "trainer.invalidNumber", { max: entry.items.length }) }, { quoted: msg });
    return true;
  }
  try {
    await sendCard(sock, jid, msg, item, lang);
  } catch (err) {
    await sock.sendMessage(jid, { text: errorText(err, lang) }, { quoted: msg });
  }
  return true;
}

module.exports = { handleTrainerCommand, handleTrainerPick };
