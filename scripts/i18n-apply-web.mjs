#!/usr/bin/env node
/**
 * i18n-apply-web.mjs — scrive un batch nel dizionario web richiesto.
 *
 * Valida PRIMA di scrivere e si ferma al primo problema. Il controllo che conta
 * e' sui segnaposto `{nome}`: se un nome cambia o sparisce, a runtime l'utente
 * vede il segnaposto grezzo o un valore nel posto sbagliato. E' l'unico errore
 * di traduzione che non si vede rileggendo il testo.
 *
 * Uso: node scripts/i18n-apply-web.mjs <batch.json> [--lang en] [--write]
 */
import { readFileSync, writeFileSync } from "node:fs";

const batchPath = process.argv.find((a) => a.endsWith(".json"));
const langArg = process.argv.indexOf("--lang");
const lang = langArg >= 0 ? String(process.argv[langArg + 1] || "").trim().toLowerCase() : "en";
if (!/^[a-z]{2,3}$/.test(lang)) { console.error("Codice lingua non valido."); process.exit(2); }
const target = `public/js/i18n/${lang}.js`;
const write = process.argv.includes("--write");
if (!batchPath) { console.error("Uso: node scripts/i18n-apply-web.mjs <batch.json> [--lang en] [--write]"); process.exit(2); }

const batch = JSON.parse(readFileSync(batchPath, "utf8"));
const src = readFileSync(target, "utf8");
const existing = new Set([...src.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1]));

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const errors = [], toAdd = [];
batch.forEach((row, i) => {
  const it = row?.it;
  const translated = row?.[lang];
  const values = typeof translated === "string"
    ? [translated]
    : (translated && typeof translated === "object" && !Array.isArray(translated)
      ? Object.values(translated)
      : []);
  if (typeof it !== "string" || !it || !values.length || values.some((value) => typeof value !== "string" || !value)) {
    errors.push(`[${i}] riga malformata: servono "it" e "${lang}" (stringa o forme plurali)`);
    return;
  }
  if (values.some((value) => ph(it) !== ph(value))) {
    errors.push(`[${i}] segnaposto diversi\n      it: ${JSON.stringify(it)}\n      ${lang}: ${JSON.stringify(translated)}`);
    return;
  }
  if (existing.has(it.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))) return; // gia' presente
  toAdd.push([it, translated]);
});

console.log(`Batch: ${batch.length} | da aggiungere: ${toAdd.length} | problemi: ${errors.length}`);
if (errors.length) { console.error("\n" + errors.slice(0, 15).join("\n")); process.exit(1); }
if (!write) { console.log("Dry-run. Rilancia con --write."); process.exit(0); }

const block = toAdd.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
writeFileSync(target, src.replace(/\n};\s*$/, `\n\n${block}\n};\n`), "utf8");
console.log(`✓ ${toAdd.length} traduzioni aggiunte a ${target}.`);
