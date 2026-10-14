// Port dari lib/stadium.ts + lib/skills.ts (UMA-API-TESTER): decode ID factor/spark.
const BLUE = { 1: "Speed", 2: "Stamina", 3: "Power", 4: "Guts", 5: "Wit" };
const PINK = {
  11: "Turf", 12: "Dirt", 21: "Front Runner", 22: "Pace Chaser", 23: "Late Surger", 24: "End Closer",
  31: "Sprint", 32: "Mile", 33: "Medium", 34: "Long",
};

// blue 401 = Guts 1★ | pink 1102 = Turf 2★ | green 10020102 = unique card 100201, 2★ | white = <group skill><bintang>
function decodeFactor(id) {
  const s = String(id);
  const stars = id % 100;
  const base = Math.floor(id / 100);
  if (s.length <= 3 && BLUE[base]) return { kind: "blue", base, stars, label: BLUE[base] };
  if (s.length === 4 && PINK[base]) return { kind: "pink", base, stars, label: PINK[base] };
  if (s.length === 8) return { kind: "green", base, stars, label: "Unique" };
  return { kind: "white", base, stars, label: `#${base}` };
}

// 100201 -> 100021 (unique skill dari card_id)
function uniqueSkillId(cardId) {
  const s = String(cardId).replace(/\D/g, "");
  if (s.length !== 6) return null;
  const chara = Number(s.slice(0, 4));
  const costume = Number(s.slice(4));
  if (!costume) return null;
  return String(100000 + (costume - 1) * 10000 + (chara % 1000) * 10 + 1);
}

function skillByWhiteBase(idx, base) {
  return idx.byGroup[String(base)] || idx.byId[String(base * 10 + 1)] || idx.byId[String(base * 10 + 2)];
}

// Pecah ID chara: 4 digit (1068) atau card ID 6 digit (106801)
function splitCharaId(raw) {
  const s = String(raw ?? "").replace(/\D/g, "");
  if (!s || /^0+$/.test(s)) return null;
  if (s.length <= 4) {
    const chara = s.padStart(4, "0");
    return { chara, card: `${chara}01` };
  }
  return { chara: s.slice(0, 4), card: s.slice(0, 6) };
}

const charaImgUrl = ({ chara, card }) =>
  `https://gametora.com/images/umamusume/characters/chara_stand_${chara}_${card}.png`;
const supportImgUrl = (id) => `https://media.gametora.com/umamusume/supports/full/small/${id}.png`;

// Label factor -> teks siap tampil, pakai data nama dari GameTora kalau ada.
function factorLabel(id, lookup) {
  const f = decodeFactor(id);
  let label = f.label;
  if (f.kind === "green") {
    const uid = uniqueSkillId(f.base);
    label = (uid && lookup.skills.byId[uid]?.name) || lookup.cards[String(f.base)]?.name || `#${f.base}`;
  } else if (f.kind === "white") {
    label = skillByWhiteBase(lookup.skills, f.base)?.name || f.label;
  }
  return { kind: f.kind, text: `${label} ${f.stars}★` };
}

const DISTANCE = { 1: "Sprint", 2: "Mile", 3: "Classic", 4: "Long", 5: "Dirt" };
const STYLE = { 1: "Front Runner", 2: "Pace Chaser", 3: "Late Surger", 4: "End Closer" };
const APT = ["-", "G", "F", "E", "D", "C", "B", "A", "S"]; // proper_* : 1=G ... 8=S
const apt = (n) => APT[n] ?? String(n);
// skill di Team Stadium: <skill_id 6 digit><level 1 digit>, mis. 2003311 -> skill 200331 lv 1
const splitSkill = (raw) => ({ id: String(Math.floor(raw / 10)), level: raw % 10 });
// support di Team Stadium: <support_id 5 digit><limit break 1 digit>, mis. 300284 -> 30028, LB 4
const splitSupport = (raw) => {
  const s = String(raw);
  return s.length === 6 ? { id: s.slice(0, 5), lb: Number(s[5]) } : { id: s, lb: null };
};

module.exports = {
  DISTANCE, STYLE, apt, splitSkill, splitSupport, decodeFactor, uniqueSkillId, skillByWhiteBase, splitCharaId, charaImgUrl, supportImgUrl, factorLabel };
