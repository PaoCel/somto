#!/usr/bin/env node
/**
 * i18n-apply-web.mjs — scrive un batch di traduzioni in public/js/i18n/en.js.
 *
 * Valida PRIMA di scrivere e si ferma al primo problema. Il controllo che conta
 * e' sui segnaposto `{nome}`: se un nome cambia o sparisce, a runtime l'utente
 * vede il segnaposto grezzo o un valore nel posto sbagliato. E' l'unico errore
 * di traduzione che non si vede rileggendo il testo.
 *
 * Uso: node scripts/i18n-apply-web.mjs <batch.json> [--write]
 */
import { readFileSync, writeFileSync } from "node:fs";

const EN = "public/js/i18n/en.js";
const batchPath = process.argv.find((a) => a.endsWith(".json"));
const write = process.argv.includes("--write");
if (!batchPath) { console.error("Uso: node scripts/i18n-apply-web.mjs <batch.json> [--write]"); process.exit(2); }

const batch = JSON.parse(readFileSync(batchPath, "utf8"));
const src = readFileSync(EN, "utf8");
const existing = new Set([...src.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1]));

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const errors = [], toAdd = [];
batch.forEach((row, i) => {
  const { it, en } = row || {};
  if (typeof it !== "string" || typeof en !== "string" || !it || !en) { errors.push(`[${i}] riga malformata`); return; }
  if (ph(it) !== ph(en)) { errors.push(`[${i}] segnaposto diversi\n      it: ${JSON.stringify(it)}\n      en: ${JSON.stringify(en)}`); return; }
  if (existing.has(it.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))) return; // gia' presente
  toAdd.push([it, en]);
});

console.log(`Batch: ${batch.length} | da aggiungere: ${toAdd.length} | problemi: ${errors.length}`);
if (errors.length) { console.error("\n" + errors.slice(0, 15).join("\n")); process.exit(1); }
if (!write) { console.log("Dry-run. Rilancia con --write."); process.exit(0); }

const block = toAdd.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
writeFileSync(EN, src.replace(/\n};\s*$/, `\n\n${block}\n};\n`), "utf8");
console.log(`✓ ${toAdd.length} traduzioni aggiunte a ${EN}.`);
