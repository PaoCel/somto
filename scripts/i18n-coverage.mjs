#!/usr/bin/env node
/**
 * i18n-coverage.mjs — quanto e' davvero tradotta l'app.
 *
 * Serve a rendere applicabile il gate di rilascio: SwiftUI localizza da solo i
 * `Text("literal")`, quindi appena il String Catalog e' nel binario un iPhone
 * in inglese vede l'app tradotta SOLO per le chiavi coperte, e italiana per
 * tutto il resto. Un'interfaccia mezza e mezza e' peggio di una coerente.
 *
 * Regola (docs/I18N-ANALYSIS-2026-07-29.md): non si taglia una release pubblica
 * con copertura EN sotto l'80%. Sotto soglia, togliere l'entry
 * `Localizable.xcstrings` da `ios/project.yml` per quella build.
 *
 * Uso:
 *   node scripts/i18n-coverage.mjs            # report
 *   node scripts/i18n-coverage.mjs --gate     # esce 1 sotto soglia
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const CATALOG = "ios/TwoWatch/Resources/Localizable.xcstrings";
const WEB_IT = "public/js/i18n/it.js";
const WEB_EN = "public/js/i18n/en.js";
const THRESHOLD = 80;

const gate = process.argv.includes("--gate");

// --- iOS: String Catalog ---------------------------------------------------
const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
const keys = Object.entries(catalog.strings || {});
const total = keys.length;

function translatedIn(lang) {
  return keys.filter(([, v]) => {
    const unit = v?.localizations?.[lang]?.stringUnit;
    return unit?.state === "translated" && String(unit?.value || "").trim() !== "";
  }).length;
}

const iosEn = translatedIn("en");
const iosEs = translatedIn("es");

// Il denominatore che conta NON e' il catalogo: e' l'insieme delle stringhe
// user-facing che stanno nel codice. Un catalogo tradotto al 100% ma con un
// terzo delle stringhe dentro produce comunque un'app mezza inglese.
const IT_WORDS =
  /\b(il|lo|la|le|gli|un|una|del|della|dei|per|con|che|non|sei|hai|puoi|tuo|tua|questo|questa|ancora|nessun|nessuna|sono|stai|devi|come|quando)\b/i;
const ACCENT = /[àèéìòùÀÈÉÌÒÙ]/;

function swiftFiles(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) swiftFiles(full, out);
    else if (extname(name) === ".swift") out.push(full);
  }
  return out;
}

const appStrings = new Set();
for (const file of swiftFiles("ios/TwoWatch")) {
  const src = readFileSync(file, "utf8");
  // I blocchi di preview non sono UI di produzione.
  if (file.endsWith("PreviewSupport.swift")) continue;
  for (const m of src.matchAll(/"([^"\\\n]{4,200})"/g)) {
    const s = m[1];
    if (!s.includes(" ")) continue;
    if (/^https?:\/\//.test(s)) continue;
    if (ACCENT.test(s) || IT_WORDS.test(s)) appStrings.add(s);
  }
}

// Attenzione al numero facile: una chiave PRESENTE nel catalogo ma senza
// traduzione EN non serve a niente per un utente inglese — vedrebbe comunque
// l'italiano. Il gate di rilascio deve contare le chiavi TRADOTTE.
const catalogKeys = new Set(Object.keys(catalog.strings || {}));
const enTranslated = new Set(
  Object.entries(catalog.strings || {})
    .filter(([, v]) => {
      const u = v?.localizations?.en?.stringUnit;
      return u?.state === "translated" && String(u?.value || "").trim() !== "";
    })
    .map(([k]) => k)
);
const inCatalog = [...appStrings].filter((s) => catalogKeys.has(s)).length;
const covered = [...appStrings].filter((s) => enTranslated.has(s)).length;
const iosEnPct = appStrings.size ? Math.round((covered / appStrings.size) * 100) : 0;

// --- Web: dizionari --------------------------------------------------------
function webKeys(file) {
  const src = readFileSync(file, "utf8");
  return new Set([...src.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]));
}
const itKeys = webKeys(WEB_IT);
const enKeys = webKeys(WEB_EN);
const missingWeb = [...itKeys].filter((k) => !enKeys.has(k));
const webPct = itKeys.size ? Math.round(((itKeys.size - missingWeb.length) / itKeys.size) * 100) : 100;

console.log("Copertura i18n\n");
console.log(`  iOS  stringhe UI nel codice : ${appStrings.size}`);
console.log(`       presenti nel catalogo  : ${inCatalog}`);
console.log(`       TRADOTTE in EN         : ${covered}  (${iosEnPct}%)   <-- e' questo che conta`);
console.log(`  iOS  catalogo               : ${total} chiavi, EN ${iosEn}, ES ${iosEs}`);
console.log(`  Web  IT       : ${itKeys.size} chiavi`);
console.log(`       EN       : ${itKeys.size - missingWeb.length}/${itKeys.size}  (${webPct}%)`);
if (missingWeb.length) {
  console.log(`\n  Chiavi web senza EN: ${missingWeb.slice(0, 10).join(", ")}${missingWeb.length > 10 ? " …" : ""}`);
}

// Il denominatore vero non e' il catalogo, sono le stringhe dell'app: finche' la
// Fase 1 non le ha estratte tutte, una copertura "100%" del catalogo non
// significa un'app tradotta al 100%. Lo diciamo esplicitamente per non farsi
// ingannare dal numero.
console.log(
  `\n  La percentuale iOS e' sul CODICE, non sul catalogo: un catalogo` +
  `\n  tradotto al 100% ma con un terzo delle stringhe dentro produce` +
  `\n  comunque un'app mezza inglese. Stima euristica, ±5-10%.`
);

if (gate) {
  if (iosEnPct < THRESHOLD || webPct < THRESHOLD) {
    console.error(`\n✖ Sotto la soglia del ${THRESHOLD}%: non tagliare una release pubblica col catalogo attivo.`);
    process.exit(1);
  }
  console.log(`\n✓ Copertura sopra il ${THRESHOLD}%.`);
}
