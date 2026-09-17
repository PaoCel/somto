#!/usr/bin/env node
/**
 * i18n-apply-translations.mjs — scrive un batch di traduzioni nel String Catalog.
 *
 * Input: JSON `[{ "it": "<chiave>", "<lang>": "<traduzione>" }, ...]`
 *
 * Valida PRIMA di scrivere, e si ferma al primo problema. Il controllo che conta
 * e' quello sui placeholder: se `%@` o `%lld` non combaciano tra sorgente e
 * traduzione, a runtime i valori finiscono nel posto sbagliato o l'app crasha
 * sulla format string. E' l'unico errore di traduzione che non si vede a
 * rileggere il testo, quindi va preso da una macchina.
 *
 * Uso:
 *   node scripts/i18n-apply-translations.mjs <batch.json> [--lang en] [--write]
 */

import { readFileSync, writeFileSync } from "node:fs";

const CATALOG = "ios/TwoWatch/Resources/Localizable.xcstrings";
const args = process.argv.slice(2);
const batchPath = args.find((a) => !a.startsWith("--"));
const write = args.includes("--write");
const langIdx = args.indexOf("--lang");
const lang = langIdx >= 0 ? args[langIdx + 1] : "en";

if (!batchPath) {
  console.error("Uso: node scripts/i18n-apply-translations.mjs <batch.json> [--lang en] [--write]");
  process.exit(2);
}

const batch = JSON.parse(readFileSync(batchPath, "utf8"));
const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
catalog.strings = catalog.strings || {};

/** Placeholder printf in ordine di apparizione, forma posizionale normalizzata. */
function placeholders(s) {
  return [...String(s).matchAll(/%(?:\d+\$)?(?:lld|ld|lu|d|@|[a-zA-Z])/g)]
    .map((m) => m[0].replace(/^%\d+\$/, "%"));
}

const errors = [];
const toApply = [];

batch.forEach((row, i) => {
  const it = row?.it;
  const translated = row?.[lang];
  if (typeof it !== "string" || typeof translated !== "string" || !it || !translated) {
    errors.push(`[${i}] riga malformata: servono "it" e "${lang}"`);
    return;
  }
  if (!catalog.strings[it]) {
    errors.push(`[${i}] chiave assente dal catalogo: ${JSON.stringify(it.slice(0, 60))}`);
    return;
  }
  const a = placeholders(it).sort().join(",");
  const b = placeholders(translated).sort().join(",");
  if (a !== b) {
    errors.push(
      `[${i}] placeholder diversi\n      it: ${JSON.stringify(it)}\n      ${lang}: ${JSON.stringify(translated)}`
    );
    return;
  }
  toApply.push({ it, translated });
});

console.log(`Batch      : ${batch.length} righe`);
console.log(`Applicabili: ${toApply.length}`);
console.log(`Problemi   : ${errors.length}`);
if (errors.length) {
  console.error("\n" + errors.slice(0, 20).join("\n"));
  if (errors.length > 20) console.error(`… e altri ${errors.length - 20}.`);
  console.error("\nNiente scritto: risolvi prima i problemi.");
  process.exit(1);
}

if (!write) {
  console.log("\nDry-run ok. Rilancia con --write per applicare.");
  process.exit(0);
}

for (const { it, translated } of toApply) {
  const entry = catalog.strings[it];
  entry.localizations = entry.localizations || {};
  entry.localizations[lang] = { stringUnit: { state: "translated", value: translated } };
}

writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + "\n", "utf8");
console.log(`\n✓ Applicate ${toApply.length} traduzioni (${lang}) a ${CATALOG}.`);
