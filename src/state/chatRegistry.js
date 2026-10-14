// Daftar SEMUA grup tempat bot berada + semua nomor yang pernah DM bot,
// disimpan di Supabase (tabel "chats", lihat supabase/chats.sql).
//
// Tujuannya: admin bisa melihat grup/DM yang BELUM berlangganan (bot default
// mati), dan data langganan (tabel "subscriptions") ikut tersinkron lewat
// view "chat_overview" yang menggabungkan keduanya.
//
// Pemicu sinkron:
//   - bot tersambung (connection "open")
//   - bot masuk / keluar grup (groups.upsert, group-participants.update)
//   - nama grup berubah (groups.update)
//   - berkala tiap 6 jam sebagai jaring pengaman
//   - tiap ada DM baru (registerUser, di-throttle)
// Semua fire-and-forget: error Supabase cuma di-log, tidak mengganggu bot.
const { BOT_ID } = require("../config/env");
const { supabaseRest, isSubscriptionEnabled } = require("./subscriptionStore");

// MULTI-BOT: tabel "chats" dipakai bersama semua bot, dibedakan kolom bot_id.
// Tiap bot hanya menulis / menandai "keluar" baris miliknya sendiri.
const { getKnownUsers } = require("./userState");

const TABLE = "chats";
const CHUNK = 200;
const PAGE = 1000;
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const USER_WRITE_GAP_MS = 10 * 60 * 1000;
const UPSERT = {
  method: "POST",
  prefer: "resolution=merge-duplicates,return=minimal",
};

let sockRef = null;
let timer = null;
let debounce = null;
let running = false;
const userWritten = new Map(); // jid -> kapan terakhir ditulis ke Supabase

async function upsertRows(rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await supabaseRest(`${TABLE}?on_conflict=bot_id,kind,jid`, {
      ...UPSERT,
      body: rows.slice(i, i + CHUNK).map((r) => ({ bot_id: BOT_ID, ...r })),
    });
  }
}

// Bulk upsert PostgREST butuh semua objek punya kunci yang sama. Nama kosong
// dipisah supaya tidak menimpa nama lama yang sudah tersimpan jadi null.
async function syncKnownUsers(nowIso) {
  const withName = [];
  const noName = [];
  for (const [jid, u] of getKnownUsers()) {
    const base = {
      kind: "user",
      jid,
      bot_present: true,
      left_at: null,
      last_seen: u.lastSeen || nowIso,
    };
    if (u.name) withName.push({ ...base, name: u.name });
    else noName.push(base);
  }
  await upsertRows(withName);
  await upsertRows(noName);
  return withName.length + noName.length;
}

async function markLeftGroups(presentIds, nowIso) {
  const stored = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await supabaseRest(
      `${TABLE}?select=jid&bot_id=eq.${encodeURIComponent(BOT_ID)}&kind=eq.group&bot_present=eq.true&order=jid.asc&limit=${PAGE}&offset=${offset}`,
    );
    stored.push(...page.map((r) => r.jid));
    if (page.length < PAGE) break;
  }
  const gone = stored.filter((jid) => !presentIds.has(jid));
  for (const jid of gone) {
    await supabaseRest(
      `${TABLE}?bot_id=eq.${encodeURIComponent(BOT_ID)}&kind=eq.group&jid=eq.${encodeURIComponent(jid)}`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: { bot_present: false, left_at: nowIso },
      },
    );
  }
  return gone.length;
}

async function syncGroups() {
  if (!isSubscriptionEnabled() || !sockRef?.user || running) return;
  running = true;
  try {
    const all = Object.values((await sockRef.groupFetchAllParticipating()) || {});
    const nowIso = new Date().toISOString();

    await upsertRows(
      all.map((g) => ({
        kind: "group",
        jid: g.id,
        name: g.subject || null,
        member_count: (g.participants || []).length,
        bot_present: true,
        left_at: null,
        last_seen: nowIso,
      })),
    );

    // Hanya tandai "keluar" kalau WhatsApp benar-benar mengembalikan daftar;
    // daftar kosong bisa saja gangguan sementara, jangan sampai menandai
    // semua grup sebagai sudah ditinggalkan.
    const left =
      all.length > 0
        ? await markLeftGroups(new Set(all.map((g) => g.id)), nowIso)
        : 0;
    const users = await syncKnownUsers(nowIso);

    console.log(
      `[chats:${BOT_ID}] sinkron ke Supabase: ${all.length} grup, ${users} nomor DM, ${left} grup sudah ditinggalkan.`,
    );
  } catch (e) {
    console.log("[chats] gagal sinkron ke Supabase:", e.message);
  } finally {
    running = false;
  }
}

// Gabungkan banyak event beruntun jadi satu kali sinkron.
function scheduleSync(delayMs = 5000) {
  if (!isSubscriptionEnabled()) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => syncGroups(), delayMs);
  debounce.unref();
}

// Dipanggil tiap startBot() (termasuk reconnect): perbarui socket yang
// dipakai, tapi interval berkala cukup dibuat sekali.
function startChatRegistry(sock) {
  sockRef = sock;
  if (timer || !isSubscriptionEnabled()) return;
  timer = setInterval(() => syncGroups(), SYNC_EVERY_MS);
  timer.unref();
}

// jid bisa berbentuk "628xxx:12@s.whatsapp.net" (ada suffix device).
const normalize = (jid) => String(jid || "").replace(/:\d+(?=@)/, "");

// Apakah bot sendiri termasuk dalam daftar peserta event grup?
// (id bisa nomor telepon atau "@lid", peserta bisa string atau objek.)
function botInParticipants(sock, participants) {
  const me = [sock.user?.id, sock.user?.lid].filter(Boolean).map(normalize);
  return (participants || []).some((p) =>
    me.includes(normalize(typeof p === "string" ? p : p?.id)),
  );
}

// DM masuk: catat nomornya (nomor baru langsung muncul di daftar admin).
function registerUser(jid, name) {
  if (!isSubscriptionEnabled() || !jid) return;
  const now = Date.now();
  if (now - (userWritten.get(jid) || 0) < USER_WRITE_GAP_MS) return;
  userWritten.set(jid, now);

  supabaseRest(`${TABLE}?on_conflict=bot_id,kind,jid`, {
    ...UPSERT,
    body: {
      bot_id: BOT_ID,
      kind: "user",
      jid,
      bot_present: true,
      left_at: null,
      last_seen: new Date(now).toISOString(),
      ...(name ? { name } : {}),
    },
  }).catch((e) => {
    userWritten.delete(jid); // coba lagi di pesan berikutnya
    console.log("[chats] gagal catat user:", e.message);
  });
}

module.exports = {
  startChatRegistry,
  scheduleSync,
  syncGroups,
  botInParticipants,
  registerUser,
};
