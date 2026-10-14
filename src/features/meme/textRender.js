const { createCanvas } = require("@napi-rs/canvas");
const { fontStack } = require("../text/fonts");
const { isRTLText, bidiWrap } = require("../text/script");
const { splitTextEmoji, getEmojiImage, ensureFontsRegistered, MEME_FONT_FAMILY, preloadEmojisInText, emojiImageCache, emojiToCodepoints } = require("./emoji");

// Ukur lebar total 1 baris (campuran teks+emoji), emoji dihitung selebar
// fontSize (persegi).
function measureSegments(ctx, segments, fontSize) {
  let width = 0;
  for (const seg of segments) {
    width += seg.type === "emoji" ? fontSize : ctx.measureText(seg.value).width;
  }
  return width;
}

// Pecah teks (boleh mengandung emoji) jadi baris-baris yang muat dalam
// maxWidth. Wrapping dilakukan per KATA (dipisah spasi), tapi emoji di
// dalam kata tetap dihitung sebagai unit lebar sendiri lewat measureSegments.
function wrapMixedText(ctx, text, fontSize, maxWidth) {
  ctx.font = `${fontSize}px ${fontStack([MEME_FONT_FAMILY])}`;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let current = [];

  for (const word of words) {
    // untuk kata kedua dst, gabungkan spasi ke potongan pertama word itu
    const candidateSegments = current.length
      ? [...current, ...prependSpace(splitTextEmoji(word))]
      : splitTextEmoji(word);

    if (
      current.length &&
      measureSegments(ctx, candidateSegments, fontSize) > maxWidth
    ) {
      lines.push(current);
      current = splitTextEmoji(word);
    } else {
      current = candidateSegments;
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

function prependSpace(segments) {
  if (segments.length === 0) return segments;
  const [first, ...rest] = segments;
  if (first.type === "text") {
    return [{ type: "text", value: " " + first.value }, ...rest];
  }
  return [{ type: "text", value: " " }, first, ...rest];
}

// Cari ukuran font terbesar (mulai dari startSize, turun bertahap) yang
// bikin teks tetap muat dalam maxWidth x maxLines baris.
function fitMixedTextLines(
  ctx,
  text,
  { startSize, maxWidth, maxLines, minSize = 20 },
) {
  for (let size = startSize; size >= minSize; size -= 2) {
    const lines = wrapMixedText(ctx, text, size, maxWidth);
    if (lines.length <= maxLines) return { size, lines };
  }
  return { size: minSize, lines: wrapMixedText(ctx, text, minSize, maxWidth) };
}

function mergeTextSegments(segments) {
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (seg.type === "text" && last && last.type === "text") {
      out[out.length - 1] = { type: "text", value: last.value + seg.value };
    } else {
      out.push(seg);
    }
  }
  return out;
}

// Gambar 1 baris (segmen teks+emoji campuran) terpusat secara horizontal
// di y tertentu. Teks pakai stroke hitam + fill putih (gaya meme klasik);
// emoji ditempel apa adanya (drawImage) sejajar tengah baris itu.
function drawMixedLine(ctx, rawSegments, centerX, y, fontSize) {
  // Segmen teks yang bersebelahan (per kata) HARUS digabung jadi 1 string.
  // Kalau digambar per kata dari kiri ke kanan, urutan kata Arab jadi terbalik.
  const segments = mergeTextSegments(rawSegments);
  const rtl = isRTLText(segments.map((s) => s.value).join(""));
  ctx.font = `${fontSize}px ${fontStack([MEME_FONT_FAMILY])}`;
  const totalWidth = measureSegments(ctx, segments, fontSize);
  let x = centerX - totalWidth / 2;

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(4, Math.round(fontSize / 9));

  // Baris RTL: blok teks/emoji dipasang dari kanan -> urutan visualnya dibalik.
  const visualSegments = rtl ? [...segments].reverse() : segments;
  for (const seg of visualSegments) {
    if (seg.type === "emoji") {
      const img = emojiImageCache.get(emojiToCodepoints(seg.value));
      if (img) {
        ctx.drawImage(img, x, y - fontSize / 2, fontSize, fontSize);
      }
      x += fontSize;
    } else {
      ctx.strokeStyle = "black";
      ctx.fillStyle = "white";
      const text = bidiWrap(seg.value, rtl);
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
      x += ctx.measureText(seg.value).width;
    }
  }
}

// Render teks atas/bawah (bisa berisi emoji WA) jadi 1 lembar PNG 512x512
// transparan, siap di-overlay ke frame video/gif. `marginTop`/`marginBottom`
// = jarak aman dari tepi (dihitung computeSafeMargins berdasar rasio asli
// video sumber).
async function renderMemeOverlayPng({ top, bottom, marginTop, marginBottom }) {
  ensureFontsRegistered();
  await Promise.all([preloadEmojisInText(top), preloadEmojisInText(bottom)]);

  const CANVAS_SIZE = 512;
  const MAX_WIDTH = 470;
  // Ukuran awal (terbesar). fitMixedTextLines otomatis menurunkannya
  // kalau teks panjang / lebih dari MAX_LINES baris, jadi teks pendek
  // tampil besar dan teks panjang mengecil sendiri. Bisa diubah lewat
  // env MEME_FONT_SIZE (default 64; sebelumnya 46).
  const START_SIZE = Number(process.env.MEME_FONT_SIZE) || 64;
  const MAX_LINES = 3;
  const LINE_HEIGHT = 1.15;

  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d");

  if (top) {
    const { size, lines } = fitMixedTextLines(ctx, top, {
      startSize: START_SIZE,
      maxWidth: MAX_WIDTH,
      maxLines: MAX_LINES,
    });
    const lineGap = size * LINE_HEIGHT;
    let y = marginTop + size / 2;
    for (const line of lines) {
      drawMixedLine(ctx, line, CANVAS_SIZE / 2, y, size);
      y += lineGap;
    }
  }

  if (bottom) {
    const { size, lines } = fitMixedTextLines(ctx, bottom, {
      startSize: START_SIZE,
      maxWidth: MAX_WIDTH,
      maxLines: MAX_LINES,
    });
    const lineGap = size * LINE_HEIGHT;
    const totalHeight = lineGap * (lines.length - 1);
    let y = CANVAS_SIZE - marginBottom - size / 2 - totalHeight;
    for (const line of lines) {
      drawMixedLine(ctx, line, CANVAS_SIZE / 2, y, size);
      y += lineGap;
    }
  }

  return canvas.toBuffer("image/png");
}

module.exports = {
  measureSegments,
  wrapMixedText,
  prependSpace,
  fitMixedTextLines,
  drawMixedLine,
  renderMemeOverlayPng,
};