#!/usr/bin/env node
/**
 * i18n-seed-web-from-ios.mjs — riusa sul web le traduzioni gia' fatte per iOS.
 *
 * App e sito dicono le stesse cose: "Salva", "Nessun titolo trovato", "Accedi
 * per commentare". Su iOS quelle stringhe sono gia' tradotte e revisionate.
 * Ritradurle sul web sarebbe lavoro doppio e, peggio, produrrebbe due rese
 * diverse per la stessa frase in due superfici dello stesso prodotto — che e'
 * esattamente il bug "Log in / Sign In" gia' capitato.
 *
 * Trasferisce solo le chiavi SENZA placeholder: iOS usa `%@`/`%lld`, il web usa
 * `{nome}`, e una conversione automatica sbaglierebbe l'ordine degli argomenti.
 * Quelle restano ai batch di traduzione.
 *
 * Uso: node scripts/i18n-seed-web-from-ios.mjs [--write]
 */

import { readFileSync, writeFileSync } from "node:fs";

const CATALOG = "ios/TwoWatch/Resources/Localizable.xcstrings";
const EN = "public/js/i18n/en.js";
const write = process.argv.includes("--write");

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
const src = readFileSync(EN, "utf8");

// Chiavi gia' presenti nel dizionario web: non si sovrascrive nulla.
const existing = new Set([...src.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1]));

const seeded = [];
for (const [key, value] of Object.entries(catalog.strings || {})) {
  if (key.includes("%")) continue;             // placeholder iOS, non convertibile
  if (existing.has(key)) continue;
  const unit = value?.localizations?.en?.stringUnit;
  if (unit?.state !== "translated") continue;
  const en = String(unit.value || "").trim();
  if (!en || en === key) continue;             // invariata: inutile in dizionario
  seeded.push([key, en]);
}

seeded.sort((a, b) => a[0].localeCompare(b[0], "it"));

console.log(`Chiavi iOS tradotte e trasferibili : ${seeded.length}`);
console.log(`Gia' presenti sul web              : ${existing.size}`);

if (!write) {
  for (const [k, v] of seeded.slice(0, 10)) console.log(`  ${JSON.stringify(k)} -> ${JSON.stringify(v)}`);
  console.log("\nDry-run. Rilancia con --write.");
  process.exit(0);
}

const block = seeded
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join("\n");

const marker = "  // popolato dai batch di traduzione";
const next = src.includes(marker)
  ? src.replace(marker, `${marker}\n\n  // --- ereditate dal catalogo iOS (stesse stringhe, stessa resa) ---\n${block}`)
  : src.replace(/\n};\s*$/, `\n\n${block}\n};\n`);

writeFileSync(EN, next, "utf8");
console.log(`\n✓ ${seeded.length} traduzioni ereditate da iOS in ${EN}.`);
