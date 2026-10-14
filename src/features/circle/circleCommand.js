// !club <nama|id>  -> daftar club mirip (nama, ID, leader) -> reply nomor -> kartu club (gambar)
// !threshold       -> kartu rank threshold circle, urut SS -> D
// !leaderboard     -> kartu leaderboard circle rank 1-50
const { t } = require("../../i18n");
const { UmaApiError } = require("../trainer/umaApi");
const { getThresholds, getClub, searchClubs, getLeaderboard, isCircleId, LEADERBOARD_SIZE } = require("./circleService");
const { renderClubCard, renderThresholdCard, renderLeaderboardCard } = require("./circleImage");
const { RANK_NAMES } = require("./parse");

// promptMsgId (ID pesan daftar) -> { items, q, expires }  (sama seperti daftar !trainer: dikunci per pesan daftar)
const pending = new Map();
const PENDING_TTL_MS = 15 * 60 * 1000;
const PENDING_MAX = 200;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}, 5 * 60 * 1000).unref();

function errorText(err, lang) {
  if (err instanceof UmaApiError) {
    const key = { NO_KEY: "trainer.noKey", AUTH: "trainer.auth", RATE: "trainer.rate" }[err.code];
    if (key) return t(lang, key);
  }
  console.log("[circle]", err?.code || "", err?.message || err);
  return t(lang, "trainer.fail");
}

// Kartu threshold & leaderboard sama untuk semua orang -> cache gambar sebentar supaya
// banyak yang minta berurutan tidak membanjiri uma.moe. key -> { buf, expires } / { promise }
const cardCache = new Map();
async function cachedCard(key, ttlMs, build) {
  const hit = cardCache.get(key);
  if (hit?.buf && hit.expires > Date.now()) return hit.buf;
  if (hit?.promise) return hit.promise;
  const promise = build()
    .then((buf) => { cardCache.set(key, { buf, expires: Date.now() + ttlMs }); return buf; })
    .catch((e) => { cardCache.delete(key); throw e; });
  cardCache.set(key, { promise });
  return promise;
}

const typing = async (sock, jid) => { try { await sock.sendPresenceUpdate("composing", jid); } catch {} };

async function sendJpeg(sock, jid, msg, image, caption) {
  await sock.sendMessage(jid, { image, mimetype: "image/jpeg", caption }, { quoted: msg });
}

// ---------------------------------------------------------------- !club
async function sendClubCard(sock, jid, msg, circleId, lang) {
  await typing(sock, jid);
  const club = await getClub(circleId);
  if (!club || !club.id) {
    await sock.sendMessage(jid, { text: t(lang, "club.gone", { id: circleId }) }, { quoted: msg });
    return;
  }
  const caption = t(lang, "club.caption", {
    name: club.name, id: club.id, tier: club.tier ? RANK_NAMES[club.tier - 1] : "-", leader: club.leaderName || club.leaderId || "-",
  });
  try {
    await sendJpeg(sock, jid, msg, await renderClubCard(club, { lang }), caption);
  } catch (err) {
    console.log("[circle] gagal render kartu club:", err);
    await sock.sendMessage(jid, { text: `${t(lang, "circle.cardFail")}\n\n${caption}` }, { quoted: msg });
  }
}

function buildClubList(items, q, lang) {
  const lines = items
    .map((c, i) => {
      const tier = c.tier ? ` · ${RANK_NAMES[c.tier - 1]}` : "";
      const members = c.members !== null ? ` · ${c.members} ${lang === "en" ? "members" : "member"}` : "";
      return `${i + 1}. *${c.name}*${tier}\n    🆔 ${c.id}\n    👑 ${c.leaderName || "-"}${members}`;
    })
    .join("\n");
  return `${t(lang, "club.listTitle", { count: items.length, q })}\n\n${lines}\n\n${t(lang, "club.listHint")}`;
}

async function handleClubCommand(sock, msg, { jid, text, lang }) {
  const m = text.match(/^!club(?:\s+([\s\S]*))?$/i);
  if (!m) return false;

  const q = (m[1] || "").replace(/\s+/g, " ").trim();
  if (!q) {
    await sock.sendMessage(jid, { text: t(lang, "cmd.club") }, { quoted: msg });
    return true;
  }
  if (q.length > 40) {
    await sock.sendMessage(jid, { text: t(lang, "club.tooLong") }, { quoted: msg });
    return true;
  }

  try {
    await typing(sock, jid);
    // Angka saja = Circle ID -> langsung kartu (kalau ID tidak ada, dianggap nama).
    if (isCircleId(q)) {
      const id = q.replace(/[\s-]/g, "");
      const club = await getClub(id);
      if (club?.id) {
        await sendClubCard(sock, jid, msg, id, lang);
        return true;
      }
    }

    const items = await searchClubs(q);
    if (!items.length) {
      await sock.sendMessage(jid, { text: t(lang, "club.notFound", { q }) }, { quoted: msg });
      return true;
    }
    if (items.length === 1) {
      await sendClubCard(sock, jid, msg, items[0].id, lang);
      return true;
    }
    const sent = await sock.sendMessage(jid, { text: buildClubList(items, q, lang) }, { quoted: msg });
    const promptId = sent?.key?.id;
    if (promptId) {
      if (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value);
      pending.set(promptId, { items, q, expires: Date.now() + PENDING_TTL_MS });
    }
  } catch (err) {
    await sock.sendMessage(jid, { text: errorText(err, lang) }, { quoted: msg });
  }
  return true;
}

// Dipanggil bersama handleTrainerPick. true = pesan ini balasan ke daftar club.
async function handleClubPick(sock, msg, { jid, text, lang }) {
  if (!/^\d{1,3}$/.test(text)) return false;
  const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const entry = stanzaId ? pending.get(stanzaId) : null;
  if (!entry || entry.expires < Date.now()) return false;

  const item = entry.items[parseInt(text, 10) - 1];
  if (!item) {
    await sock.sendMessage(jid, { text: t(lang, "club.invalidNumber", { max: entry.items.length }) }, { quoted: msg });
    return true;
  }
  try {
    await sendClubCard(sock, jid, msg, item.id, lang);
  } catch (err) {
    await sock.sendMessage(jid, { text: errorText(err, lang) }, { quoted: msg });
  }
  return true;
}

// ---------------------------------------------------------------- !threshold
async function handleThresholdCommand(sock, msg, { jid, text, lang }) {
  if (!/^!(?:thresholds?|tresholds?)$/i.test(text)) return false;
  try {
    await typing(sock, jid);
    const image = await cachedCard(`th:${lang}`, 5 * 60 * 1000, async () => renderThresholdCard(await getThresholds(), { lang }));
    await sendJpeg(sock, jid, msg, image, t(lang, "threshold.caption"));
  } catch (err) {
    await sock.sendMessage(jid, { text: errorText(err, lang) }, { quoted: msg });
  }
  return true;
}

// ---------------------------------------------------------------- !leaderboard
async function handleLeaderboardCommand(sock, msg, { jid, text, lang }) {
  if (!/^!(?:leaderboard|lb)$/i.test(text)) return false;
  try {
    await typing(sock, jid);
    const image = await cachedCard(`lb:${lang}`, 3 * 60 * 1000, async () => renderLeaderboardCard(await getLeaderboard(), { lang }));
    await sendJpeg(sock, jid, msg, image, t(lang, "leaderboard.caption", { n: LEADERBOARD_SIZE }));
  } catch (err) {
    await sock.sendMessage(jid, { text: errorText(err, lang) }, { quoted: msg });
  }
  return true;
}

module.exports = { handleClubCommand, handleClubPick, handleThresholdCommand, handleLeaderboardCommand };
