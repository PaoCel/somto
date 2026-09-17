#!/usr/bin/env node
/**
 * i18n-sync-catalog.mjs — porta nel String Catalog le chiavi che il
 * compilatore Swift ha gia' estratto durante la build.
 *
 * Perche' esiste: con `SWIFT_EMIT_LOC_STRINGS: YES` il compilatore emette un
 * `.stringsdata` per file Swift con TUTTE le stringhe localizzabili, gia' con
 * i placeholder convertiti (`Text("Hai \(n) titoli")` -> `"Hai %lld titoli"`).
 * Quello che l'analisi dava come il pezzo piu' costoso della Fase 1 — le 384
 * stringhe con interpolazione — lo risolve il compilatore. Xcode riscrive il
 * catalogo da solo, ma solo l'IDE: da riga di comando serve questo.
 *
 * NON traduce e NON tocca le traduzioni esistenti: aggiunge solo le chiavi
 * mancanti. La traduzione e' un passo separato.
 *
 * Uso:
 *   1) build con estrazione attiva (qualsiasi configurazione)
 *   2) node scripts/i18n-sync-catalog.mjs <derivedDataPath> [--write]
 *
 * Senza --write fa un dry-run e stampa il diff.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CATALOG = "ios/TwoWatch/Resources/Localizable.xcstrings";
const derivedData = process.argv[2];
const write = process.argv.includes("--write");

if (!derivedData || derivedData.startsWith("--")) {
  console.error("Uso: node scripts/i18n-sync-catalog.mjs <derivedDataPath> [--write]");
  process.exit(2);
}

function findStringsData(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) findStringsData(full, out);
    // Gli App Intents hanno la loro tabella: non e' UI dell'app.
    else if (name.endsWith(".stringsdata") && !name.startsWith("ExtractedAppShortcuts")) {
      out.push(full);
    }
  }
  return out;
}

const extracted = new Map(); // key -> file sorgente (per il report)
for (const file of findStringsData(derivedData)) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  const source = data.source || file;
  for (const entries of Object.values(data.tables || {})) {
    for (const entry of entries || []) {
      if (entry?.key && !extracted.has(entry.key)) extracted.set(entry.key, source);
    }
  }
}

if (extracted.size === 0) {
  console.error(
    "Nessuna chiave estratta. Serve SWIFT_EMIT_LOC_STRINGS: YES in ios/project.yml\n" +
    "e una build fatta DOPO averlo attivato."
  );
  process.exit(1);
}

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
catalog.strings = catalog.strings || {};

const existing = new Set(Object.keys(catalog.strings));
const missing = [...extracted.keys()].filter((k) => !existing.has(k)).sort();
const orphans = [...existing].filter((k) => !extracted.has(k)).sort();

console.log(`Estratte dalla build : ${extracted.size}`);
console.log(`Gia' nel catalogo    : ${extracted.size - missing.length}`);
console.log(`Da aggiungere        : ${missing.length}`);
console.log(`Orfane nel catalogo  : ${orphans.length}  (non le tocco: potrebbero servire ancora)`);

if (!write) {
  console.log("\nEsempi da aggiungere:");
  for (const k of missing.slice(0, 15)) console.log(`  ${JSON.stringify(k.slice(0, 70))}`);
  console.log("\nDry-run. Rilancia con --write per applicare.");
  process.exit(0);
}

// Una chiave senza `localizations` usa la chiave stessa come stringa nella
// lingua sorgente (it). Le traduzioni si aggiungono dopo, per lingua.
for (const key of missing) {
  catalog.strings[key] = { extractionState: "manual", localizations: {} };
}

writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + "\n", "utf8");
console.log(`\n✓ Aggiunte ${missing.length} chiavi a ${CATALOG}.`);
console.log("  Traduzione: passo separato. Nessuna traduzione esistente e' stata toccata.");
