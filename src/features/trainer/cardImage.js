// Render "kartu trainer" jadi gambar (mirip TrainerCard + StadiumView di UMA-API-TESTER).
const fs = require("fs");
const axios = require("axios");
const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const { fontStack, EMOJI_FONT_AVAILABLE } = require("../text/fonts");
const {
  splitCharaId, charaImgUrl, supportImgUrl, factorLabel, uniqueSkillId,
  DISTANCE, STYLE, apt, splitSkill, splitSupport,
} = require("./decode");

const W = 900;
const PAD = 32;
const TILE_PAD = 12;
const SCALE = 2; // render 2x biar tajam di HP

const C = {
  bg: "#12151c", card: "#1b1f2a", tile: "#222838", ink: "#e8ebf3", muted: "#9aa3b8", line: "#2c3242", accent: "#7c93ff",
  gold: "#f5b942", ok: "#4cc38a",
  blue: "#3b82f6", pink: "#ec4899", green: "#22a559", white: "#8892a6",
};
const SPARKS = [
  ["Blue", "blue_sparks", C.blue],
  ["Pink", "pink_sparks", C.pink],
  ["Green", "green_sparks", C.green],
  ["White", "white_sparks", C.white],
];

const LABELS = {
  id: {
    follower: "Follower", seen: "Dilihat", borrowed: "Dipinjam", update: "Update", main: "Main parent",
    left: "Parent kiri", right: "Parent kanan", noName: "(tanpa nama)", locale: "id-ID",
    stadium: "Team Stadium", total: "Total Team Score (semua tim)", team: "Team Score",
    noStadium: "Trainer ini tidak punya data Team Stadium.", stadiumFail: "Data Team Stadium gagal dimuat.",
  },
  en: {
    follower: "Followers", seen: "Views", borrowed: "Borrowed", update: "Updated", main: "Main parent",
    left: "Left parent", right: "Right parent", noName: "(no name)", locale: "en-GB",
    stadium: "Team Stadium", total: "Total Team Score (all teams)", team: "Team Score",
    noStadium: "This trainer has no Team Stadium data.", stadiumFail: "Could not load Team Stadium data.",
  },
};

// ---------- font ----------
// DejaVu = huruf Latin. CJK (kana/kanji) opsional: dicari di beberapa lokasi umum, atau set TRAINER_CJK_FONT_PATH.
const FONT_FILES = [
  [process.env.TRAINER_FONT_PATH || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "TrainerSans"],
  [process.env.TRAINER_FONT_BOLD_PATH || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "TrainerSans-Bold"],
  ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "TrainerMono"],
];
const CJK_REGULAR = [
  process.env.TRAINER_CJK_FONT_PATH,
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
].filter(Boolean);

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  fontsReady = true;
  for (const [p, fam] of FONT_FILES) if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, fam);
  const reg = CJK_REGULAR.find((p) => fs.existsSync(p));
  if (reg) {
    GlobalFonts.registerFromPath(reg, "TrainerCJK");
    const bold = reg.replace("Regular", "Bold");
    if (bold !== reg && fs.existsSync(bold)) GlobalFonts.registerFromPath(bold, "TrainerCJK-Bold");
  }
}
const SANS = fontStack(["TrainerSans", "TrainerCJK", "Noto Sans CJK JP"]);
const BOLD = fontStack(["TrainerSans-Bold", "TrainerCJK-Bold", "TrainerCJK", "Noto Sans CJK JP"]);
const MONO = '"TrainerMono", "DejaVu Sans Mono", monospace';

// Karakter fullwidth (［］Ａ．Ｚ） tidak ada di DejaVu -> tampil kotak. NFKC mengubahnya ke ASCII biasa
// (dan spasi ideografik jadi spasi). Kana/kanji tidak terpengaruh.
// Emoji dibuang HANYA kalau font emoji (WhatsAppEmoji.ttf) tidak ada (canvas -> kotak).
// Kalau font-nya ada, emoji dibiarkan dan digambar lewat fontStack(). Nama asli tetap utuh di caption/daftar WhatsApp.
const clean = (s) => {
  let t = String(s ?? "").normalize("NFKC");
  if (!EMOJI_FONT_AVAILABLE) t = t.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, "");
  return t.replace(/\s{2,}/g, " ").trim();
};

// ---------- gambar (cache dibatasi per ukuran memori) ----------
const imgCache = new Map();
let cacheBytes = 0;
const CACHE_MAX_BYTES = 120 * 1024 * 1024;
async function fetchImage(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  let img = null;
  try {
    const res = await axios.get(url, { responseType: "arraybuffer", timeout: 8000, headers: { "User-Agent": "agemasen-bot" } });
    img = await loadImage(Buffer.from(res.data));
  } catch {
    img = null; // gagal -> placeholder
  }
  const size = img ? img.width * img.height * 4 : 0;
  imgCache.set(url, { img, size });
  cacheBytes += size;
  while (cacheBytes > CACHE_MAX_BYTES && imgCache.size > 1) {
    const [k, v] = imgCache.entries().next().value;
    imgCache.delete(k);
    cacheBytes -= v.size;
  }
  return imgCache.get(url);
}
async function loadAll(urls, limit = 8) {
  const list = Array.from(new Set(urls.filter(Boolean)));
  const out = {};
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (i < list.length) {
        const url = list[i++];
        const hit = await fetchImage(url);
        out[url] = hit?.img || null;
      }
    }),
  );
  return out;
}

// ---------- helper gambar ----------
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fit(ctx, text, maxW, font) {
  if (font) ctx.font = font;
  let s = clean(text);
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}
const show = (v) => (Array.isArray(v) ? (v.length ? v.join(", ") : "-") : String(v));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

// teks: selalu dinormalisasi; mengembalikan lebar teks
function makeText(ctx, draw) {
  return (s, x, y, { font = SANS, size = 13, color = C.ink, align = "left" } = {}) => {
    const str = clean(s);
    ctx.font = `${font === BOLD ? "bold " : ""}${size}px ${font}`;
    const w = ctx.measureText(str).width;
    if (draw) {
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(str, x, y);
    }
    return w;
  };
}
const f = (size, font = SANS) => `${font === BOLD ? "bold " : ""}${size}px ${font}`;

function dashedLine(ctx, draw, x1, x2, y) {
  if (!draw) return;
  ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = C.line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x1, y + 0.5); ctx.lineTo(x2, y + 0.5); ctx.stroke(); ctx.restore();
}

// Baris chip yang otomatis turun baris. list: [{ text, color, stripe, bold, textColor }].
// Mengembalikan y paling bawah (tepi bawah baris terakhir).
function flowChips(ctx, draw, list, x, y, w, { h = 18, size = 10.5, gap = 4 } = {}) {
  const t = makeText(ctx, draw);
  let cx = x;
  for (const c of list) {
    const font = c.bold ? BOLD : SANS;
    const label = fit(ctx, c.text, w - 18, f(size, font));
    const cw = Math.min(ctx.measureText(label).width + (c.stripe ? 19 : 15), w);
    if (cx + cw > x + w + 0.5 && cx > x) { cx = x; y += h + gap; }
    if (draw) {
      rr(ctx, cx, y, cw, h, h / 2); ctx.fillStyle = c.fill || C.bg; ctx.fill();
      ctx.strokeStyle = c.color; ctx.lineWidth = 1; ctx.stroke();
      if (c.stripe) { ctx.save(); rr(ctx, cx, y, cw, h, h / 2); ctx.clip(); ctx.fillStyle = c.color; ctx.fillRect(cx, y, 5, h); ctx.restore(); }
    }
    t(label, cx + (c.stripe ? 10 : 7.5), y + h / 2 + size * 0.36, { font, size, color: c.textColor || C.ink });
    cx += cw + gap;
  }
  return list.length ? y + h : y;
}

// ---------- tile satu anggota Team Stadium ----------
// Mengembalikan tinggi tile. draw=false -> hanya mengukur. panelH = tinggi panel seragam satu baris.
function memberTile(ctx, draw, x, y0, w, m, d, panelH) {
  const { lookup, imgs } = d;
  const t = makeText(ctx, draw);
  const px = x + TILE_PAD;
  const iw = w - TILE_PAD * 2;
  let y = y0 + TILE_PAD;

  if (draw && panelH) {
    rr(ctx, x, y0, w, panelH, 10); ctx.fillStyle = C.tile; ctx.fill();
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
  }

  // portrait (cover, rata atas, tengah horizontal)
  const ph = 168;
  const ref = splitCharaId(m.card_id);
  if (draw) {
    ctx.save();
    rr(ctx, px, y, iw, ph, 8); ctx.fillStyle = C.bg; ctx.fill(); ctx.clip();
    const img = ref ? imgs[charaImgUrl(ref)] : null;
    if (img) {
      const r = Math.max(iw / img.width, ph / img.height);
      ctx.drawImage(img, px + (iw - img.width * r) / 2, y, img.width * r, img.height * r);
    } else {
      t("no image", px + iw / 2, y + ph / 2, { size: 11, color: C.muted, align: "center" });
    }
    ctx.restore();
  }
  y += ph + 20;

  const card = lookup.cards[String(m.card_id)];
  t(fit(ctx, card?.name || `Card ${m.card_id}`, iw, f(14, BOLD)), px, y, { font: BOLD, size: 14 });
  y += 16;
  if (card?.title) {
    t(fit(ctx, card.title, iw, f(11.5)), px, y, { size: 11.5, color: C.muted });
    y += 15;
  }
  t(`card ${m.card_id} · ${m.rarity}★`, px, y, { font: MONO, size: 10, color: C.muted });
  y += 11;

  // gaya lari + rank score
  const style = STYLE[m.running_style] || `Style ${m.running_style}`;
  ctx.font = f(11, BOLD);
  const bw = ctx.measureText(style).width + 18;
  if (draw) { rr(ctx, px, y, bw, 19, 9.5); ctx.fillStyle = C.accent; ctx.fill(); }
  t(style, px + 9, y + 13.5, { font: BOLD, size: 11, color: "#12151c" });
  t(fmt(m.rank_score), px + iw, y + 14, { font: BOLD, size: 13, color: C.gold, align: "right" });
  y += 29;

  // status (dalam kotak supaya rapi)
  if (draw) { rr(ctx, px, y, iw, 38, 7); ctx.fillStyle = C.bg; ctx.fill(); }
  [["Spd", m.speed], ["Sta", m.stamina], ["Pow", m.power], ["Gut", m.guts], ["Wit", m.wiz]].forEach(([k, v], i) => {
    const cx = px + (iw / 5) * (i + 0.5);
    t(k, cx, y + 14, { size: 9.5, color: C.muted, align: "center" });
    t(String(v), cx, y + 30, { font: BOLD, size: 12.5, align: "center" });
  });
  y += 38 + 8;

  // aptitude: grid 4 kolom tetap (sel berisi label kiri, grade kanan) -> selalu lurus
  const rows = [
    [["Turf", m.proper_ground_turf], ["Dirt", m.proper_ground_dirt]],
    [["Sprint", m.proper_distance_short], ["Mile", m.proper_distance_mile], ["Mid", m.proper_distance_middle], ["Long", m.proper_distance_long]],
    [["Front", m.proper_running_style_nige], ["Pace", m.proper_running_style_senko], ["Late", m.proper_running_style_sashi], ["End", m.proper_running_style_oikomi]],
  ];
  const ag = 4;
  const aw = (iw - ag * 3) / 4;
  for (const row of rows) {
    row.forEach(([k, v], i) => {
      const cx = px + i * (aw + ag);
      const g = apt(v);
      if (draw) { rr(ctx, cx, y, aw, 19, 5); ctx.fillStyle = C.bg; ctx.fill(); }
      t(k, cx + 6, y + 13.5, { size: 9.5, color: C.muted });
      t(g, cx + aw - 6, y + 14, { font: BOLD, size: 11.5, color: g === "S" ? C.gold : g === "A" ? C.ok : C.ink, align: "right" });
    });
    y += 23;
  }
  y += 6;

  // factor (chip berwarna)
  const factors = (m.factors || []).map((id) => factorLabel(id, lookup));
  if (factors.length) {
    const bottom = flowChips(ctx, draw, factors.map((fc) => ({ text: fc.text, color: C[fc.kind], stripe: true })), px, y, iw, { h: 18, size: 10.5 });
    y = bottom + 12;
  }

  // support card (thumbnail + LB)
  const sups = (m.support_cards || []).slice(0, 6).map(splitSupport);
  if (sups.length) {
    const sg = 4;
    const sw = (iw - sg * 5) / 6;
    const sh = sw / 0.76;
    sups.forEach((s, i) => {
      const sx = px + i * (sw + sg);
      if (draw) {
        ctx.save(); rr(ctx, sx, y, sw, sh, 4); ctx.clip(); ctx.fillStyle = C.bg; ctx.fillRect(sx, y, sw, sh);
        const img = imgs[supportImgUrl(s.id)];
        if (img) ctx.drawImage(img, sx, y, sw, sh);
        ctx.restore();
      }
      t(s.lb != null ? `LB${s.lb}` : s.id, sx + sw / 2, y + sh + 11, { size: 9.5, color: C.muted, align: "center" });
    });
    y += sh + 24;
  }

  // skill: unique (emas) dulu, sisanya chip rapi
  const parsed = (m.skills || []).map(splitSkill);
  const uid = uniqueSkillId(m.card_id);
  const uniq = parsed.find((s) => s.id === uid) || parsed.find((s) => s.id.length === 6 && s.id[0] === "1");
  const rest = parsed.filter((s) => s !== uniq);
  const nameOf = (id) => lookup.skills.byId[id]?.name || `#${id}`;
  if (parsed.length) {
    if (draw) { ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, y - 6.5); ctx.lineTo(px + iw, y - 6.5); ctx.stroke(); }
    t(`Skills · ${parsed.length}`, px, y + 7, { font: BOLD, size: 10.5, color: C.muted });
    y += 15;
    const chips = [];
    if (uniq) {
      chips.push({ text: `★ Lv${uniq.level}`, color: C.gold, fill: "#2d2a1c", textColor: C.gold, bold: true });
      chips.push({ text: nameOf(uniq.id), color: C.gold, fill: "#2d2a1c", textColor: C.gold, bold: true });
    }
    for (const s of rest) {
      const name = nameOf(s.id);
      chips.push({ text: name, color: name.startsWith("#") ? C.line : "#3a4258", textColor: name.startsWith("#") ? C.muted : C.ink });
    }
    y = flowChips(ctx, draw, chips, px, y, iw, { h: 18, size: 10.5 }) + 4;
  }
  return y - y0 + TILE_PAD;
}

// Satu fungsi dipakai dua kali: draw=false (ukur tinggi) lalu draw=true (gambar).
function layout(ctx, draw, d) {
  const { item, L, imgs, lookup, stadium } = d;
  const inh = item.inheritance;
  const sc = item.support_card;
  const inner = W - PAD * 2;
  const text = makeText(ctx, draw);
  let y = PAD;

  // --- header ---
  text(fit(ctx, item.trainer_name || L.noName, inner, f(26, BOLD)), PAD, y + 24, { font: BOLD, size: 26 });
  y += 24 + 20;
  text(String(item.account_id ?? "-"), PAD, y, { font: MONO, size: 13, color: C.muted });
  y += 24;

  const updated = item.last_updated
    ? new Date(item.last_updated).toLocaleString(L.locale, { timeZone: "Asia/Jakarta" })
    : "-";
  const meta = [[L.follower, item.follower_num ?? "-"], [L.seen, item.borrow_view_count ?? 0], [L.borrowed, item.borrow_copy_count ?? 0], [L.update, updated]];
  let mx = PAD;
  for (const [k, v] of meta) {
    mx += text(k, mx, y, { color: C.muted }) + 6;
    mx += text(String(v), mx, y, { font: BOLD }) + 18;
  }
  y += 16;
  if (draw) { ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(W - PAD, y + 0.5); ctx.stroke(); }
  y += 22;

  // --- inheritance ---
  if (inh) {
    text("Inheritance", PAD, y, { font: BOLD, size: 14, color: C.muted });
    y += 14;

    const gap = 14;
    const tw = (inner - gap * 2) / 3;
    const th = 250;
    [[L.main, inh.main_parent_id], [L.left, inh.parent_left_id], [L.right, inh.parent_right_id]].forEach(([label, id], i) => {
      const x = PAD + i * (tw + gap);
      const ref = splitCharaId(id);
      if (draw) {
        ctx.save();
        rr(ctx, x, y, tw, th, 8); ctx.fillStyle = C.bg; ctx.fill();
        ctx.clip();
        const img = ref ? imgs[charaImgUrl(ref)] : null;
        if (img) {
          const r = Math.min(tw / img.width, th / img.height);
          ctx.drawImage(img, x + (tw - img.width * r) / 2, y, img.width * r, img.height * r);
        } else {
          text(ref ? "no image" : "kosong", x + tw / 2, y + th / 2, { size: 12, color: C.muted, align: "center" });
        }
        ctx.restore();
        rr(ctx, x + 0.5, y + 0.5, tw - 1, th - 1, 8); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
      }
      const cx = x + tw / 2;
      const name = ref ? lookup.cards[ref.card]?.name || lookup.charas[ref.chara] || "—" : "—";
      const title = ref ? lookup.cards[ref.card]?.title || "" : "";
      text(label, cx, y + th + 22, { font: BOLD, size: 14, align: "center" });
      text(fit(ctx, name, tw, f(12)), cx, y + th + 42, { size: 12, color: C.muted, align: "center" });
      text(fit(ctx, title, tw, f(12)), cx, y + th + 59, { size: 12, color: C.muted, align: "center" });
      text(String(id ?? "-"), cx, y + th + 76, { font: MONO, size: 11, color: C.muted, align: "center" });
    });
    y += th + 76 + 20;

    const stats = [
      ["Parent rank", inh.parent_rank], ["Parent rarity", inh.parent_rarity], ["Win count", inh.win_count],
      ["White count", inh.white_count], ["Main blue factors", inh.main_blue_factors], ["Main pink factors", inh.main_pink_factors],
      ["Main green factors", inh.main_green_factors], ["Main white count", inh.main_white_count], ["Affinity score", inh.affinity_score],
      ["Inheritance ID", inh.inheritance_id],
    ].filter(([, v]) => v !== undefined && v !== null);
    const cg = 24;
    const cw = (inner - cg * 2) / 3;
    stats.forEach(([k, v], i) => {
      const x = PAD + (i % 3) * (cw + cg);
      const yy = y + Math.floor(i / 3) * 28;
      text(k, x, yy + 15, { color: C.muted });
      text(String(v), x + cw, yy + 15, { font: BOLD, align: "right" });
      dashedLine(ctx, draw, x, x + cw, yy + 22);
    });
    y += Math.ceil(stats.length / 3) * 28;

    if (inh.main_white_factors?.length) {
      text("Main white factors", PAD, y + 15, { color: C.muted });
      text(fit(ctx, show(inh.main_white_factors), inner - 140, f(13, BOLD)), W - PAD, y + 15, { font: BOLD, align: "right" });
      dashedLine(ctx, draw, PAD, W - PAD, y + 22);
      y += 28;
    }
    y += 14;

    for (const [label, key, color] of SPARKS) {
      const list = inh[key] || [];
      const pillW = 56;
      const rowH = 24;
      let x = PAD + pillW + 8;
      let rowY = y;
      if (draw) { rr(ctx, PAD, rowY, pillW, 22, 11); ctx.fillStyle = color; ctx.fill(); }
      text(label, PAD + pillW / 2, rowY + 15, { font: BOLD, size: 12, color: "#fff", align: "center" });
      if (!list.length) text("-", x, rowY + 15, { color: C.muted });
      for (const id of list) {
        const fc = factorLabel(id, lookup);
        ctx.font = f(12);
        const cwid = Math.min(ctx.measureText(clean(fc.text)).width + 22, inner - pillW - 8);
        if (x + cwid > W - PAD) { x = PAD + pillW + 8; rowY += rowH; }
        if (draw) {
          rr(ctx, x, rowY, cwid, 22, 11); ctx.fillStyle = C.bg; ctx.fill(); ctx.strokeStyle = C[fc.kind]; ctx.lineWidth = 1; ctx.stroke();
          ctx.save(); rr(ctx, x, rowY, cwid, 22, 11); ctx.clip(); ctx.fillStyle = C[fc.kind]; ctx.fillRect(x, rowY, 6, 22); ctx.restore();
        }
        text(fit(ctx, fc.text, cwid - 20, f(12)), x + 14, rowY + 15, { size: 12 });
        x += cwid + 6;
      }
      y = rowY + rowH + 6;
    }
  }

  // --- support card ---
  if (sc) {
    y += 8;
    text("Support card", PAD, y + 12, { font: BOLD, size: 14, color: C.muted });
    y += 24;
    const tw = 84;
    const th = 112;
    if (draw) {
      ctx.save(); rr(ctx, PAD, y, tw, th, 8); ctx.clip(); ctx.fillStyle = C.bg; ctx.fillRect(PAD, y, tw, th);
      const img = sc.support_card_id != null ? imgs[supportImgUrl(sc.support_card_id)] : null;
      if (img) ctx.drawImage(img, PAD, y, tw, th);
      ctx.restore();
    }
    const sup = sc.support_card_id != null ? lookup.supports[String(sc.support_card_id)] : null;
    const rows = [
      ["Support card ID", sc.support_card_id],
      ["Nama", sup ? `${sup.name} (${sup.rarity}, ${sup.type})` : null],
      ["Limit break", sc.limit_break_count],
      ["Experience", sc.experience],
    ].filter(([, v]) => v !== undefined && v !== null);
    const sx = PAD + tw + 18;
    rows.forEach(([k, v], i) => {
      const yy = y + i * 28;
      text(k, sx, yy + 15, { color: C.muted });
      text(fit(ctx, String(v), W - PAD - sx - 130, f(13, BOLD)), W - PAD, yy + 15, { font: BOLD, align: "right" });
      dashedLine(ctx, draw, sx, W - PAD, yy + 22);
    });
    y += Math.max(th, rows.length * 28) + 8;
  }

  if (!inh && !sc) {
    text("Tidak ada data inheritance atau support card.", PAD, y + 14, { color: C.muted });
    y += 30;
  }

  // --- Team Stadium ---
  y += 10;
  if (draw) { ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(W - PAD, y + 0.5); ctx.stroke(); }
  y += 22;
  text(L.stadium, PAD, y, { font: BOLD, size: 14, color: C.muted });
  y += 14;

  if (!stadium.ok) {
    text(L.stadiumFail, PAD, y + 14, { color: C.muted });
    y += 30;
  } else if (!stadium.members.length) {
    text(L.noStadium, PAD, y + 14, { color: C.muted });
    y += 30;
  } else {
    const members = stadium.members;
    const grand = members.reduce((sum, m) => sum + (m.rank_score || 0), 0);
    if (draw) { rr(ctx, PAD, y, inner, 34, 6); ctx.fillStyle = C.bg; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke(); }
    text(L.total, PAD + 12, y + 22, { size: 13 });
    text(fmt(grand), W - PAD - 12, y + 23, { font: BOLD, size: 16, color: C.accent, align: "right" });
    y += 34 + 14;

    const groups = [...new Set(members.map((m) => m.distance_type))].sort((a, b) => a - b);
    const gap = 14;
    const tw = (inner - gap * 2) / 3;
    for (const g of groups) {
      const list = members.filter((m) => m.distance_type === g).sort((a, b) => a.member_id - b.member_id);
      const teamScore = list.reduce((sum, m) => sum + (m.rank_score || 0), 0);
      text(DISTANCE[g] || `Tipe ${g}`, PAD, y + 12, { font: BOLD, size: 14 });
      text(L.team, W - PAD - 90, y + 12, { size: 12, color: C.muted, align: "right" });
      text(fmt(teamScore), W - PAD, y + 12, { font: BOLD, size: 13, align: "right" });
      y += 24;
      for (let i = 0; i < list.length; i += 3) {
        const row = list.slice(i, i + 3);
        const hs = row.map((m, j) => memberTile(ctx, false, PAD + j * (tw + gap), y, tw, m, d));
        const rowH = Math.max(...hs); // panel satu baris dibuat sama tinggi
        if (draw) row.forEach((m, j) => memberTile(ctx, true, PAD + j * (tw + gap), y, tw, m, d, rowH));
        y += rowH + 14;
      }
      y += 4;
    }
  }
  return y + PAD - 6;
}

// stadium = { ok: boolean, members: [...] }
async function renderTrainerCard(item, { lang = "id", lookup, stadium = { ok: true, members: [] } }) {
  ensureFonts();
  const L = LABELS[lang] || LABELS.id;
  const inh = item.inheritance;

  const urls = [];
  for (const id of [inh?.main_parent_id, inh?.parent_left_id, inh?.parent_right_id]) {
    const r = splitCharaId(id);
    if (r) urls.push(charaImgUrl(r));
  }
  if (item.support_card?.support_card_id != null) urls.push(supportImgUrl(item.support_card.support_card_id));
  for (const m of stadium.members || []) {
    const r = splitCharaId(m.card_id);
    if (r) urls.push(charaImgUrl(r));
    for (const raw of (m.support_cards || []).slice(0, 6)) urls.push(supportImgUrl(splitSupport(raw).id));
  }
  const imgs = await loadAll(urls);
  const d = { item, L, lookup, imgs, stadium };

  const measure = createCanvas(W, 10).getContext("2d");
  const height = Math.ceil(layout(measure, false, d));

  const canvas = createCanvas(W * SCALE, height * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, height);
  rr(ctx, 6, 6, W - 12, height - 12, 12); ctx.fillStyle = C.card; ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
  layout(ctx, true, d);
  // JPEG: kartu jadi tinggi kalau ada Team Stadium, PNG bisa belasan MB
  return canvas.toBuffer("image/jpeg", 90);
}

module.exports = {
  renderTrainerCard, clean,
  // helper gambar dipakai ulang oleh features/circle/circleImage.js
  gfx: { C, SANS, BOLD, MONO, ensureFonts, loadAll, rr, fit, makeText, f, dashedLine },
};
