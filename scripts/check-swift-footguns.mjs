#!/usr/bin/env node
/**
 * Guardia sui footgun Swift noti di Somto.
 *
 * Perche' esiste (e perche' NON e' una regola SwiftLint):
 *   `Dictionary(uniqueKeysWithValues:)` crasha con fatalError su chiavi
 *   duplicate. E' legittimo su un doc id Firestore (unico per definizione) e
 *   pericoloso su qualunque chiave DERIVATA (lowercased, normalize, slug,
 *   nome, hash). Una regex secca non sa distinguere i due casi: sul repo
 *   produceva 23 segnalazioni di cui quasi tutte corrette. Serve l'allowlist,
 *   quindi serve codice.
 *
 *   Incidente di riferimento: v0.3.22, "La Casa di Carta Korea" crashava a
 *   ogni apertura in `mergeCharacters` (collisione di cast con nome
 *   normalizzato uguale). Fix in v0.3.23.
 *
 * Perche' e' condiviso hook+CI:
 *   l'hook pre-commit vede solo le righe AGGIUNTE nel commit corrente, ed e'
 *   aggirabile con --no-verify. La CI vede tutto l'albero e non e' aggirabile.
 *   Tenere due copie della stessa logica le fa divergere (e' gia' successo,
 *   cfr. scripts/check-i18n-regressions.mjs).
 *
 * Uso:
 *   node scripts/check-swift-footguns.mjs            # tutto l'albero (CI)
 *   node scripts/check-swift-footguns.mjs a.swift …  # solo questi file (hook)
 *
 * Exit 0 = pulito, 1 = violazioni.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PATTERN = 'Dictionary(uniqueKeysWithValues:';

/**
 * Marcatori che rendono la chiave un id di documento, quindi unica per
 * costruzione. Allineati all'allowlist di scripts/hooks/pre-commit: se si
 * aggiunge un marcatore qui, va aggiunto anche li'.
 */
const ID_KEY_MARKERS = [
  '.id',
  '.titleId',
  '.uid',
  '.documentID',
  '.tmdbId',
  '.userID',
  '.itemId',
];

const repoRoot = path.resolve(import.meta.dirname, '..');

function swiftFilesTracked() {
  const out = execFileSync('git', ['ls-files', '*.swift'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

/**
 * Il pattern puo' comparire dentro un commento che SPIEGA perche' e' evitato
 * (es. TitleDetailView.swift:526). Segnalarlo significherebbe punire
 * esattamente la documentazione del footgun.
 */
function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function violationsIn(relativePath) {
  // I percorsi possono arrivare assoluti (hook, invocazione manuale) o
  // relativi alla radice del repo (git ls-files).
  const absolute = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(repoRoot, relativePath);

  let source;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch (error) {
    // Un file cancellato nel commit corrente e' normale: si salta.
    // Qualunque ALTRO errore di lettura no: trattarlo come "pulito"
    // significherebbe che la guardia smette di guardare in silenzio.
    if (error.code === 'ENOENT') return [];
    console.error(`✗ ${relativePath}: illeggibile (${error.code}).`);
    process.exitCode = 1;
    return [];
  }

  const found = [];
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    if (!line.includes(PATTERN)) return;
    if (isComment(line)) return;

    // La chiave puo' stare sulla riga successiva quando la chiamata e'
    // spezzata su piu' righe: si guarda una piccola finestra.
    const window = lines.slice(index, index + 3).join(' ');
    if (ID_KEY_MARKERS.some((marker) => window.includes(marker))) return;

    found.push({ file: relativePath, line: index + 1, text: line.trim() });
  });

  return found;
}

const argv = process.argv.slice(2);
const targets = argv.length > 0
  ? argv.filter((f) => f.endsWith('.swift'))
  : swiftFilesTracked();

const violations = targets.flatMap(violationsIn);

if (violations.length === 0) {
  console.log(`✓ Nessun footgun Swift. File controllati: ${targets.length}.`);
  process.exit(0);
}

console.error(`✗ ${violations.length} uso/i di uniqueKeysWithValues su chiave non-id:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}`);
}
console.error('\n  fix: Dictionary(_:uniquingKeysWith: { first, _ in first })');
console.error('       (uniqueKeysWithValues crasha con fatalError su chiavi duplicate)');
process.exit(1);
