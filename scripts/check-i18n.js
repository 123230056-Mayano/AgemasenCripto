// Pastikan id.js & en.js punya key yang SAMA persis + placeholder {x} sama.
const id = require("../src/i18n/locales/id");
const en = require("../src/i18n/locales/en");
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(",");
let bad = 0;
for (const k of new Set([...Object.keys(id), ...Object.keys(en)])) {
  if (!(k in id)) { console.log("HILANG di id.js:", k); bad++; }
  else if (!(k in en)) { console.log("HILANG di en.js:", k); bad++; }
  else if (ph(id[k]) !== ph(en[k])) { console.log("PLACEHOLDER beda:", k, ph(id[k]), "vs", ph(en[k])); bad++; }
}
console.log(bad ? `\n${bad} masalah.` : `OK: ${Object.keys(id).length} key sama di id & en.`);
process.exit(bad ? 1 : 0);
