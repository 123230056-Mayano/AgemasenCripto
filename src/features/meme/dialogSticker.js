const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const { fontStack } = require("../text/fonts");
const { isRTLText, bidiWrap } = require("../text/script");
const {
  splitTextEmoji,
  preloadEmojisInText,
  emojiImageCache,
  emojiToCodepoints,
} = require("./emoji");

// =====================================================
// Fitur: "!schat Nama|Pesan|badge" -- stiker "dialog chat" ala WhatsApp
// MODE GELAP (avatar bulat di kiri + bubble gelap berisi nama pengirim,
// pesan, dan jam di kanan bawah).
//
// Desainnya MENIRU tampilan chat di section "Bot preview" situs web
// (AgemasenWeb: components/BotPreview.tsx + kelas .wa-* di globals.css):
// bubble #202020 radius 8, nama kuning #e8c36a, teks #e9edef, jam #8696a0,
// **teks tebal** didukung. Ukuran di CONFIG = nilai CSS web x ~1.6 supaya
// tetap tajam setelah dikecilkan ke kanvas stiker 512x512.
//
// Render pakai @napi-rs/canvas (Node) dan sadar EMOJI (emoji.js, sama
// seperti bratSticker.js) karena font sistem (DejaVu Sans) gak punya glyph
// emoji berwarna.
//
// Avatar itu OPSIONAL: kalau user reply/kirim gambar bareng "!schat",
// gambar itu dipakai (di-crop bulat). Kalau enggak ada, fallback ke
// lingkaran warna solid (dari nama, deterministik) + huruf awal nama --
// sama seperti fallbackPalette() di HTML generator-nya.
// =====================================================

// Font sistem yang sudah pasti ada di server (dipakai fitur lain juga --
// lihat emoji.js untuk MEME_FONT_PATH & bratSticker.js untuk fallback-nya).
// Bisa dioverride lewat env kalau lokasinya beda.
const NAME_FONT_PATH =
  process.env.DIALOG_NAME_FONT_PATH ||
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const MSG_FONT_PATH =
  process.env.DIALOG_MSG_FONT_PATH ||
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const NAME_FONT_FAMILY = "DialogNameFont";
const MSG_FONT_FAMILY = "DialogMsgFont";

let fontsRegistered = false;
function ensureDialogFontsRegistered() {
  if (fontsRegistered) return;
  fontsRegistered = true;

  if (fs.existsSync(NAME_FONT_PATH)) {
    GlobalFonts.registerFromPath(NAME_FONT_PATH, NAME_FONT_FAMILY);
  } else {
    console.log(
      `⚠️ Font nama dialog tidak ditemukan di ${NAME_FONT_PATH} (set env DIALOG_NAME_FONT_PATH).`,
    );
  }
  if (fs.existsSync(MSG_FONT_PATH)) {
    GlobalFonts.registerFromPath(MSG_FONT_PATH, MSG_FONT_FAMILY);
  } else {
    console.log(
      `⚠️ Font pesan dialog tidak ditemukan di ${MSG_FONT_PATH} (set env DIALOG_MSG_FONT_PATH).`,
    );
  }
}

// --- Parameter layout (acuan: .wa-* di AgemasenWeb/app/globals.css) -------
const CONFIG = {
  avatarSize: 56, // .wa-av 32px
  avatarGap: 16, // jarak avatar -> bubble (.wa-bub margin-left 16px)
  bubbleRadius: 12, // .wa-bub border-radius 8px
  bubbleTail: true, // "ekor" WhatsApp di kiri atas bubble (menunjuk avatar)
  tailScale: 1.5, // skala bentuk ekor asli WhatsApp Web (8x13 unit)
  bubblePaddingLeft: 15, // padding 6px 8px 6px 9px
  bubblePaddingRight: 13,
  bubblePaddingTop: 10,
  bubblePaddingBottom: 10,
  nameFontSize: 20, // .wa-name 12.8px
  messageFontSize: 23, // .wa-txt 14.2px
  timeFontSize: 17.5, // .wa-time 11px
  timeGap: 22, // jarak teks -> jam (margin-left 14px)
  nameMarginBottom: 4,
  maxBubbleWidth: 400,
  minBubbleWidth: 150,
  canvasPadding: 14,
  lineHeightMul: 1.34, // 19px / 14.2px
  bubbleFill: "#202020", // --wa-bubble
  bubbleShadow: "rgba(0,0,0,0.45)",
  nameColor: "#e8c36a", // --wa-yellow (warna nama bot di preview)
  messageColor: "#e9edef", // --wa-text
  timeColor: "#8696a0", // --wa-sub
  renderScale: 3, // supersample, hasil akhir di-downscale ke kanvas stiker
  // Warna nama yang terbaca di atas bubble gelap (gaya WhatsApp dark).
  nameColorPalette: [
    "#e8c36a", "#53bdeb", "#06cf9c", "#ff8a8a", "#c39bff",
    "#ff9f5a", "#7fd6a8", "#f58bb8", "#6fb1ff", "#d4e157",
  ],
};

// Batas biar rendernya cepat & stikernya gak jadi raksasa gak jelas.
const MAX_NAME_CHARS = 40;
const MAX_MESSAGE_CHARS = 500;

// --- Teks + emoji: ukur & gambar ----------------------------------------
// Emoji digambar sebagai gambar persegi (Twemoji, lewat emoji.js) karena
// font DejaVu Sans gak punya glyph emoji berwarna. Ukuran relatif ke
// font size teks di sekitarnya.
const EMOJI_SIZE_EM = 0.92;
const EMOJI_TOP_EM = 0.02;

function getEmojiImg(emoji) {
  return emojiImageCache.get(emojiToCodepoints(emoji)) || null;
}

function stripUnavailableEmoji(text) {
  return splitTextEmoji(text)
    .filter((seg) => seg.type !== "emoji" || getEmojiImg(seg.value))
    .map((seg) => seg.value)
    .join("");
}

function emojiBox(size) {
  return size * EMOJI_SIZE_EM;
}

// Lebar 1 "kata" (campuran teks + emoji) dengan konteks font yang sedang
// aktif di ctx (nameFont/messageFont beda ukuran, jadi ctx harus sudah
// di-set font-nya SEBELUM manggil ini).
function measureWordEmoji(ctx, word, size) {
  let width = 0;
  for (const seg of splitTextEmoji(word)) {
    width += seg.type === "emoji" ? emojiBox(size) : ctx.measureText(seg.value).width;
  }
  return width;
}

// Pecah 1 kata jadi unit-unit sekecil mungkin buat forced-break (1 huruf
// teks, atau 1 emoji utuh -- emoji gabungan gak boleh kepotong tengah).
function splitUnitsEmoji(word) {
  return splitTextEmoji(word).flatMap((seg) =>
    seg.type === "emoji" ? [seg.value] : Array.from(seg.value),
  );
}

function breakLongWordEmoji(ctx, word, maxWidth, size) {
  if (measureWordEmoji(ctx, word, size) <= maxWidth) return [word];

  const chunks = [];
  let current = "";
  for (const unit of splitUnitsEmoji(word)) {
    const test = current + unit;
    if (current && measureWordEmoji(ctx, test, size) > maxWidth) {
      chunks.push(current);
      current = unit;
    } else {
      current = test;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Word-wrap per paragraf (baris baru manual dari "\n" tetap dihormati),
// sadar emoji & kata kepanjangan (dipenggal paksa) -- port dari
// wrapLines() di dialog-sticker-generator.html, ditambah dukungan emoji.
function wrapLinesEmoji(ctx, text, maxWidth, size) {
  const paragraphs = String(text).split("\n");
  const lines = [];

  for (const para of paragraphs) {
    if (para === "") {
      lines.push("");
      continue;
    }

    const words = para
      .split(" ")
      .flatMap((w) => breakLongWordEmoji(ctx, w, maxWidth, size));

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current === "" || measureWordEmoji(ctx, candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines;
}

// Gambar 1 baris teks (bisa campur teks+emoji) di (x, y) -- textBaseline
// HARUS "alphabetic" & textAlign "left" sebelum manggil ini. `y` dianggap
// baseline teks; emoji digambar sedikit di atas baseline supaya optically
// center dengan huruf teks di sekitarnya.
function drawTextEmojiRun(ctx, text, x, y, size) {
  const rtl = isRTLText(text);
  let cursor = x;
  const parts = splitTextEmoji(text);
  // Baris RTL: blok teks/emoji dipasang dari kanan -> urutan visualnya dibalik.
  for (const seg of rtl ? parts.reverse() : parts) {
    if (seg.type === "emoji") {
      const img = getEmojiImg(seg.value);
      if (img) {
        const box = emojiBox(size);
        ctx.drawImage(img, cursor, y - size * (0.78 - EMOJI_TOP_EM), box, box);
      }
      cursor += emojiBox(size);
    } else {
      ctx.fillText(bidiWrap(seg.value, rtl), cursor, y);
      cursor += ctx.measureText(seg.value).width;
    }
  }
}

// --- Avatar --------------------------------------------------------------
function fallbackPalette(seed) {
  const palettes = ["#2f6f5a", "#7a4fb5", "#c1573a", "#2b6ea8", "#9b8b2c", "#b2497e"];
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palettes[h % palettes.length];
}

function drawAvatar(ctx, img, cx, cy, size, senderName) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (img) {
    const s = Math.max(size / img.width, size / img.height);
    const w = img.width * s;
    const h = img.height * s;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.fillStyle = fallbackPalette(senderName || "A");
    ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = `700 ${Math.round(size * 0.42)}px ${fontStack([NAME_FONT_FAMILY])}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((senderName || "A").trim().charAt(0).toUpperCase(), cx, cy + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  ctx.restore();
}

// --- Bubble ----------------------------------------------------------------
function roundRectPath(ctx, x, y, w, h, r, cornerTL) {
  const rTL = cornerTL === undefined ? r : cornerTL;
  ctx.beginPath();
  ctx.moveTo(x + rTL, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, rTL);
  ctx.closePath();
}

// "Ekor" bubble ala WhatsApp Web (incoming): segitiga melengkung di sudut
// kiri atas yang menyatu dengan bubble. Bentuknya dari path SVG aslinya
// (viewBox 8x13): sisi kanan ekor (x=8) menempel di tepi kiri bubble.
function tailPath(ctx, bubbleX, bubbleY, k) {
  const X = (x) => bubbleX + (x - 8) * k;
  const Y = (y) => bubbleY + (y - 1) * k;
  ctx.beginPath();
  ctx.moveTo(X(1.533), Y(3.568));
  ctx.lineTo(X(8), Y(12.837));
  ctx.lineTo(X(8), Y(1));
  ctx.lineTo(X(2.812), Y(1));
  ctx.bezierCurveTo(X(1.042), Y(1), X(0.474), Y(2.156), X(1.533), Y(3.568));
  ctx.closePath();
}

// --- Teks kaya (**tebal**) -----------------------------------------------
// Pesan dipecah jadi "token kata" {text, bold}. **...** = tebal (sama seperti
// rich() di BotPreview.tsx). Kalau tanda ** gak berpasangan, apa adanya.
function parseRichWords(text) {
  const words = [];
  for (const para of String(text).split("\n")) {
    const row = [];
    const re = /\*\*([^*]+)\*\*/g;
    let last = 0;
    let m;
    const push = (chunk, bold) => {
      for (const w of chunk.split(" ")) if (w !== "") row.push({ text: w, bold });
    };
    while ((m = re.exec(para))) {
      push(para.slice(last, m.index), false);
      push(m[1], true);
      last = m.index + m[0].length;
    }
    push(para.slice(last), false);
    words.push(row);
  }
  return words; // array paragraf -> array token
}

function msgFont(bold) {
  return bold
    ? `bold ${CONFIG.messageFontSize}px ${fontStack([NAME_FONT_FAMILY])}`
    : `${CONFIG.messageFontSize}px ${fontStack([MSG_FONT_FAMILY])}`;
}

function measureToken(ctx, tok) {
  ctx.font = msgFont(tok.bold);
  return measureWordEmoji(ctx, tok.text, CONFIG.messageFontSize);
}

function spaceWidth(ctx) {
  ctx.font = msgFont(false);
  return ctx.measureText(" ").width;
}

// Word-wrap token berstyle. Return array baris; tiap baris = {tokens, width}.
function wrapRichLines(ctx, text, maxWidth) {
  const size = CONFIG.messageFontSize;
  const sp = spaceWidth(ctx);
  const lines = [];

  for (const para of parseRichWords(text)) {
    if (para.length === 0) {
      lines.push({ tokens: [], width: 0 });
      continue;
    }
    // Kata kepanjangan dipenggal paksa (tetap membawa flag bold-nya).
    const tokens = para.flatMap((tok) => {
      ctx.font = msgFont(tok.bold);
      return breakLongWordEmoji(ctx, tok.text, maxWidth, size).map((t) => ({ text: t, bold: tok.bold }));
    });

    let cur = [];
    let curW = 0;
    for (const tok of tokens) {
      const w = measureToken(ctx, tok);
      if (cur.length === 0) {
        cur = [tok];
        curW = w;
      } else if (curW + sp + w <= maxWidth) {
        cur.push(tok);
        curW += sp + w;
      } else {
        lines.push({ tokens: cur, width: curW });
        cur = [tok];
        curW = w;
      }
    }
    if (cur.length) lines.push({ tokens: cur, width: curW });
  }
  return lines;
}

// Jam "HH:MM" zona Asia/Jakarta (sama seperti jam di bubble preview web).
function formatClock(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Jakarta",
    }).format(date);
  } catch {
    return date.toTimeString().slice(0, 5);
  }
}

// Render kartu dialog (avatar + bubble gelap berisi nama, pesan, jam) ->
// canvas @napi-rs/canvas seukuran konten (dipadding ke 512x512 di
// textToDialogSticker).
function renderDialogCanvasSync({ avatarImg, senderName, badge, message, nameColor, time }) {
  ensureDialogFontsRegistered();
  const cfg = CONFIG;
  const scale = cfg.renderScale;

  const measureCanvas = createCanvas(10, 10);
  const mctx = measureCanvas.getContext("2d");

  const nameFont = `bold ${cfg.nameFontSize}px ${fontStack([NAME_FONT_FAMILY])}`;
  const badgeSize = cfg.nameFontSize;
  const badgeFont = `${badgeSize}px ${fontStack([MSG_FONT_FAMILY])}`;
  const timeFont = `${cfg.timeFontSize}px ${fontStack([MSG_FONT_FAMILY])}`;

  const padX = cfg.bubblePaddingLeft + cfg.bubblePaddingRight;
  const contentMax = cfg.maxBubbleWidth - padX;

  mctx.font = nameFont;
  const nameWidth = measureWordEmoji(mctx, senderName, cfg.nameFontSize);
  mctx.font = badgeFont;
  const badgeWidth = badge ? measureWordEmoji(mctx, badge, badgeSize) : 0;
  const nameRowWidth = nameWidth + (badge ? 6 + badgeWidth : 0);

  const lines = wrapRichLines(mctx, message, contentMax);
  const maxLine = lines.reduce((m, l) => Math.max(m, l.width), 0);

  mctx.font = timeFont;
  const timeWidth = mctx.measureText(time).width;

  // Jam ikut baris terakhir kalau muat (perilaku WhatsApp), kalau tidak
  // turun ke baris sendiri di kanan bawah.
  const lastW = lines.length ? lines[lines.length - 1].width : 0;
  const timeInline = lastW + cfg.timeGap + timeWidth <= contentMax;

  const contentW = Math.max(
    nameRowWidth,
    maxLine,
    timeInline ? lastW + cfg.timeGap + timeWidth : timeWidth,
  );
  const bubbleWidth = Math.min(
    Math.max(contentW + padX, cfg.minBubbleWidth),
    cfg.maxBubbleWidth,
  );

  const lineHeight = cfg.messageFontSize * cfg.lineHeightMul;
  const nameHeight = cfg.nameFontSize * 1.25 + cfg.nameMarginBottom;
  const timeRow = timeInline ? 0 : cfg.timeFontSize * 1.2;
  const bubbleHeight =
    cfg.bubblePaddingTop + nameHeight + lines.length * lineHeight + timeRow + cfg.bubblePaddingBottom;

  const avatarSize = cfg.avatarSize;
  const bubbleX = cfg.canvasPadding + avatarSize + cfg.avatarGap;
  const bubbleY = cfg.canvasPadding;

  const totalW = bubbleX + bubbleWidth + cfg.canvasPadding;
  const totalH = Math.max(bubbleY + bubbleHeight, cfg.canvasPadding + avatarSize) + cfg.canvasPadding;

  const canvas = createCanvas(Math.ceil(totalW * scale), Math.ceil(totalH * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, totalW, totalH);

  // Avatar sejajar bagian atas bubble (seperti .wa-row align-items:flex-start).
  drawAvatar(
    ctx,
    avatarImg,
    cfg.canvasPadding + avatarSize / 2,
    bubbleY + avatarSize / 2,
    avatarSize,
    senderName,
  );

  // Bubble gelap + bayangan tipis (.wa-bub box-shadow).
  ctx.save();
  ctx.shadowColor = cfg.bubbleShadow;
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 2;
  // Dengan ekor, sudut kiri atas bubble dibuat tajam (radius 0) seperti WA.
  roundRectPath(
    ctx, bubbleX, bubbleY, bubbleWidth, bubbleHeight, cfg.bubbleRadius,
    cfg.bubbleTail ? 0 : undefined,
  );
  ctx.fillStyle = cfg.bubbleFill;
  ctx.fill();
  if (cfg.bubbleTail) {
    tailPath(ctx, bubbleX, bubbleY, cfg.tailScale);
    ctx.fill();
  }
  ctx.restore();

  const textX = bubbleX + cfg.bubblePaddingLeft;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Nama (+ badge)
  const nameBaseline = bubbleY + cfg.bubblePaddingTop + cfg.nameFontSize * 0.95;
  ctx.font = nameFont;
  ctx.fillStyle = nameColor;
  drawTextEmojiRun(ctx, senderName, textX, nameBaseline, cfg.nameFontSize);
  if (badge) {
    ctx.font = badgeFont;
    drawTextEmojiRun(ctx, badge, textX + nameWidth + 6, nameBaseline, badgeSize);
  }

  // Pesan
  ctx.fillStyle = cfg.messageColor;
  let ly = bubbleY + cfg.bubblePaddingTop + nameHeight + cfg.messageFontSize * 0.9;
  const sp = spaceWidth(ctx);
  const rightEdge = bubbleX + bubbleWidth - cfg.bubblePaddingRight;
  for (const line of lines) {
    const plain = line.tokens.map((t) => t.text).join(" ");
    if (isRTLText(plain)) {
      // Baris Arab/Ibrani: rata KANAN, gaya tebal diabaikan.
      ctx.font = msgFont(false);
      const w = measureWordEmoji(ctx, plain, cfg.messageFontSize);
      drawTextEmojiRun(ctx, plain, rightEdge - w, ly, cfg.messageFontSize);
    } else {
      let x = textX;
      line.tokens.forEach((tok, i) => {
        ctx.font = msgFont(tok.bold);
        drawTextEmojiRun(ctx, tok.text, x, ly, cfg.messageFontSize);
        x += measureToken(ctx, tok) + (i < line.tokens.length - 1 ? sp : 0);
      });
    }
    ly += lineHeight;
  }

  // Jam di kanan bawah
  ctx.font = timeFont;
  ctx.fillStyle = cfg.timeColor;
  ctx.textAlign = "right";
  ctx.fillText(time, rightEdge, bubbleY + bubbleHeight - cfg.bubblePaddingBottom - 2);
  ctx.textAlign = "left";

  return canvas;
}

function pickRandomNameColor() {
  const palette = CONFIG.nameColorPalette;
  return palette[Math.floor(Math.random() * palette.length)];
}

// Dipanggil dari router: { avatarBuffer?, senderName, badge?, message,
// randomNameColor?, time? } -> Buffer WebP siap kirim sbg stiker WA (statis,
// dipadding transparan ke kanvas 512x512 seperti !s/!meme/!sbrat).
async function textToDialogSticker({
  avatarBuffer,
  senderName,
  badge = "",
  message,
  randomNameColor = false,
  time,
}) {
  ensureDialogFontsRegistered();

  const cleanName = String(senderName || "Sender").replace(/\s+/g, " ").trim() || "Sender";
  const cleanBadge = String(badge || "").trim();
  const cleanMessage = String(message || " ");

  // Emoji yang gagal di-fetch dibuang dulu (bukan jadi kotak kosong).
  await preloadEmojisInText(`${cleanName} ${cleanBadge} ${cleanMessage}`);
  const finalName = stripUnavailableEmoji(cleanName) || "Sender";
  const finalBadge = stripUnavailableEmoji(cleanBadge);
  const finalMessage = stripUnavailableEmoji(cleanMessage) || " ";

  let avatarImg = null;
  if (avatarBuffer) {
    try {
      avatarImg = await loadImage(avatarBuffer);
    } catch (err) {
      console.log("⚠️ Gagal load avatar buat !schat, lanjut tanpa avatar:", err.message);
      avatarImg = null;
    }
  }

  const nameColor = randomNameColor ? pickRandomNameColor() : CONFIG.nameColor;

  const canvas = renderDialogCanvasSync({
    avatarImg,
    senderName: finalName,
    badge: finalBadge,
    message: finalMessage,
    nameColor,
    time: time || formatClock(),
  });

  const contentPng = canvas.toBuffer("image/png");

  // Padding transparan ke kanvas stiker WA 512x512 (konten diperkecil kalau
  // perlu, TIDAK di-crop) -- konvensi yang sama dengan !s/!meme/!smeme.
  const STICKER_SIZE = 512;
  const resized = await sharp(contentPng)
    .resize(STICKER_SIZE, STICKER_SIZE, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .toBuffer();
  const meta = await sharp(resized).metadata();

  const padded = await sharp({
    create: {
      width: STICKER_SIZE,
      height: STICKER_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: resized,
        left: Math.max(0, Math.round((STICKER_SIZE - meta.width) / 2)),
        top: Math.max(0, Math.round((STICKER_SIZE - meta.height) / 2)),
      },
    ])
    .png()
    .toBuffer();

  return sharp(padded).webp({ quality: 92 }).toBuffer();
}

module.exports = {
  MAX_NAME_CHARS,
  MAX_MESSAGE_CHARS,
  CONFIG,
  wrapLinesEmoji,
  wrapRichLines,
  renderDialogCanvasSync,
  textToDialogSticker,
};