"use strict";

/**
 * features/kripto/chartKit.js
 * ------------------------------------------------------------------
 * Gaya chart bersama: tema gelap, palet, font, panah biru + titik pivot, dan chip label.
 * Dipakai !scandivergent <koin> (divChart.js) dan !chart / !analisis (analisisChart.js)
 * supaya tampilannya sama persis. Fungsi murni, tanpa fetch / kirim pesan.
 */

const fs = require("fs");
const path = require("path");
const { GlobalFonts } = require("@napi-rs/canvas");

const FONT_FILE = path.join(__dirname, "../../../assets/fonts/ArchivoNarrow-Variable.ttf");
let fontReady = false;
function fontFamily() {
  if (!fontReady) {
    fontReady = true;
    try {
      if (fs.existsSync(FONT_FILE)) GlobalFonts.registerFromPath(FONT_FILE, "ChartFont");
    } catch {
      /* pakai font bawaan */
    }
  }
  return 'ChartFont, "DejaVu Sans", Arial, sans-serif';
}

const C = {
  bg: "#0b0e14",
  panel: "#0f131b",
  grid: "#1d222d",
  axis: "#8b93a1",
  text: "#c3c9d4",
  title: "#f1f3f7",
  up: "#26a69a",
  down: "#ef5350",
  arrow: "#4f8cff",
  macdLine: "#3b82f6",
  macdSig: "#fb923c",
  rsiLine: "#a78bfa",
  rsiMa: "#facc15",
  bull: "#26a69a",
  bear: "#ef5350",
  // !chart / !analisis
  res: "#ef5350",
  sup: "#26a69a",
  ema: { 20: "#facc15", 50: "#3b82f6", 200: "#a78bfa" },
};

const fmtPrice = (p) => {
  if (typeof p !== "number" || !isFinite(p)) return "-";
  const d = p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 8;
  return p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};

function niceStep(range, target) {
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
}

const WIB = { timeZone: "Asia/Jakarta" };
const tickLabel = (t, tf) => {
  const d = new Date(t);
  const day = d.toLocaleString("en-GB", { ...WIB, day: "numeric", month: "short" });
  if (tf === "1D") return day;
  return `${day} ${d.toLocaleString("en-GB", { ...WIB, hour: "2-digit", minute: "2-digit", hour12: false })}`;
};

/**
 * Panah dengan kepala segitiga. Default: biru tebal (dipakai chart lama, tidak berubah).
 * opts (opsional): { color, width, dash:[a,b] (garis putus), alpha, head }.
 */
function arrow(g, x1, y1, x2, y2, opts = {}) {
  const color = opts.color || C.arrow;
  const width = opts.width || 4;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = opts.head || 20;
  const bx = x2 - Math.cos(ang) * head * 0.8;
  const by = y2 - Math.sin(ang) * head * 0.8;
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = width;
  g.lineCap = "round";
  if (opts.alpha != null) g.globalAlpha = opts.alpha;
  if (opts.dash) g.setLineDash(opts.dash);
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(bx, by);
  g.stroke();
  g.setLineDash([]);
  g.beginPath();
  g.moveTo(x2, y2);
  g.lineTo(x2 - Math.cos(ang - 0.42) * head, y2 - Math.sin(ang - 0.42) * head);
  g.lineTo(x2 - Math.cos(ang + 0.42) * head, y2 - Math.sin(ang + 0.42) * head);
  g.closePath();
  g.fill();
  g.restore();
}

/** Titik awal panah (pivot). */
function dot(g, x, y) {
  g.save();
  g.strokeStyle = C.arrow;
  g.fillStyle = C.bg;
  g.lineWidth = 3;
  g.beginPath();
  g.arc(x, y, 6, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.restore();
}

/**
 * Chip teks kecil berwarna, dijepit di dalam area panel.
 * `placed` (opsional): daftar kotak chip yang sudah digambar; kalau bertabrakan, chip digeser
 * ke atas/bawah sampai bebas supaya label tidak saling menimpa.
 */
function chip(g, family, text, cx, cy, box, color, placed) {
  g.save();
  g.font = `bold 19px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  const w = g.measureText(text).width + 16;
  const h = 26;
  const x = Math.min(Math.max(cx - w / 2, box.x + 4), box.x + box.w - w - 4);
  const clampY = (v) => Math.min(Math.max(v - h / 2, box.y + 4), box.y + box.h - h - 4);
  let y = clampY(cy);
  if (placed) {
    const hit = (yy) => placed.some((r) => x < r.x + r.w + 4 && x + w + 4 > r.x && yy < r.y + r.h + 4 && yy + h + 4 > r.y);
    const dir = cy >= box.y + box.h / 2 ? -1 : 1; // geser menjauhi tepi terdekat
    for (let k = 1; hit(y) && k <= 14; k++) {
      const up = clampY(cy + dir * k * (h + 6));
      const down = clampY(cy - dir * k * (h + 6));
      if (!hit(up)) {
        y = up;
        break;
      }
      if (!hit(down)) {
        y = down;
        break;
      }
    }
    placed.push({ x, y, w, h });
  }
  g.fillStyle = "rgba(11,14,20,0.88)";
  g.fillRect(x, y, w, h);
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  g.fillStyle = color;
  g.fillText(text, x + 8, y + h / 2 + 1);
  g.restore();
}

module.exports = { C, fontFamily, fmtPrice, niceStep, tickLabel, arrow, dot, chip };
