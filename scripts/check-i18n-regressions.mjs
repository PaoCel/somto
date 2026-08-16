#!/usr/bin/env node
/**
 * check-i18n-regressions.mjs
 *
 * Impedisce che un file GIA' migrato a i18n torni ad avere stringhe italiane
 * hardcoded.
 *
 * Perche' esiste: il repo rilascia piu' volte a settimana. Senza un controllo
 * automatico, mentre si traduce da una parte si ri-italianizza dall'altra, e
 * dopo qualche mese si torna a fare lo stesso audit da capo. La stessa logica
 * sta anche in `scripts/hooks/pre-commit`, ma quello e' un hook LOCALE: va
 * installato a mano dopo ogni clone e si aggira con `--no-verify`. Questo gira
 * in CI, dove non si aggira e non va installato.
 *
 * L'invariante e' volutamente auto-limitante: un file conta come "migrato" solo
 * quando ha gia' adottato il meccanismo i18n. Su un file non ancora migrato il
 * controllo tace, perche' li' l'italiano hardcoded e' ancora la norma. Oggi
 * quindi passa a vuoto, e inizia a mordere esattamente quando parte la Fase 1.
 *
 * Uso: node scripts/check-i18n-regressions.mjs
 * Esce 1 se trova regressioni.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["ios/TwoWatch", "public/js"];

// Parole italiane comuni: la presenza di una di queste dentro un literal con
// spazi e' un segnale forte che sia testo per l'utente e non una chiave.
const IT_WORDS = [
  "il", "lo", "la", "le", "gli", "un", "una", "del", "della", "dei", "per",
  "con", "che", "non", "sei", "hai", "puoi", "tuo", "tua", "questo", "questa",
  "ancora", "adesso", "prima", "dopo", "nessun", "nessuna", "sono", "siamo",
  "stai", "devi", "sulla", "sulle", "dalla", "come", "quando", "perche",
];
const IT_WORD_RE = new RegExp(`\\b(${IT_WORDS.join("|")})\\b`, "i");
const ACCENT_RE = /[àèéìòùÀÈÉÌÒÙ]/;

// Posizioni SwiftUI in cui un literal e' gia' un LocalizedStringKey.
const SWIFTUI_AUTOLOCALIZED_RE =
  /\b(Text|Label|Button|Toggle|Section|TextField|SecureField|Picker|Stepper|Link|NavigationLink)\s*\(\s*"|\.(navigationTitle|alert|confirmationDialog|help|labelsHidden)\s*\(\s*"/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "i18n") continue;
      walk(full, out);
    } else if ([".swift", ".js"].includes(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

/** Un file conta se ha gia' adottato il meccanismo i18n della sua piattaforma. */
function isMigrated(file, src) {
  if (file.endsWith(".swift")) return src.includes("String(localized:");
  return /from\s+["'][^"']*\/i18n\//.test(src) || /["'][^"']*\/i18n\/index\.js["']/.test(src);
}

// Verita' di riferimento per Swift: il String Catalog. Una stringa che e' una
// chiave del catalogo E' localizzata, comunque ci arrivi — SwiftUI localizza da
// solo i literal in posizione LocalizedStringKey (Text, ma anche i parametri
// tipizzati delle view custom), quindi cercare `String(localized:)` nel sorgente
// non dice niente. Il primo taglio di questo script lo faceva e produceva 35
// falsi positivi su un solo file.
const CATALOG_PATH = "ios/TwoWatch/Resources/Localizable.xcstrings";
let catalogKeys = new Set();
try {
  catalogKeys = new Set(Object.keys(JSON.parse(readFileSync(CATALOG_PATH, "utf8")).strings || {}));
} catch {
  // Catalogo assente: il controllo Swift si disattiva invece di dare falsi allarmi.
}

/** L'interpolazione Swift `\(x)` diventa `%@`/`%lld` come chiave nel catalogo. */
function inCatalog(literal) {
  if (catalogKeys.has(literal)) return true;
  // `\"` nel sorgente e' una virgoletta vera nella chiave del catalogo.
  const normalized = literal.replace(/\\\([^)]*\)/g, "%@").replace(/\\"/g, '"');
  if (catalogKeys.has(normalized)) return true;
  // Il tipo del placeholder dipende dalla variabile interpolata: se la forma con
  // %@ non c'e', prova le altre invece di gridare al lupo.
  return [...catalogKeys].some(
    (k) => k.replace(/%(lld|ld|d|lu|@)/g, "%@") === normalized
  );
}

function looksItalianUiString(literal) {
  if (!literal.includes(" ")) return false;
  if (literal.length < 4) return false;
  if (/^https?:\/\//.test(literal)) return false;
  return ACCENT_RE.test(literal) || IT_WORD_RE.test(literal);
}

const findings = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!isMigrated(file, src)) continue;

    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      // Via d'uscita esplicita: un checker a espressioni regolari non puo'
      // sapere che tipo ha un parametro di una view custom. Quando un literal
      // finisce in un `LocalizedStringKey` (es. EmptyStateView) e' gia'
      // localizzato: si marca la riga, o quella sopra, con `// i18n-ok`.
      if (line.includes("i18n-ok")) return;
      if (idx > 0 && lines[idx - 1].includes("i18n-ok")) return;
      if (idx > 1 && lines[idx - 2].includes("i18n-ok")) return;

      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      if (/\bconsole\.(log|warn|error|debug|info)\b/.test(line)) return;
      // SwiftUI localizza da solo i literal passati a Text/Label/Button e ai
      // modificatori che prendono LocalizedStringKey: li' la stringa passa gia'
      // dal catalogo, segnalarla sarebbe un falso positivo. Il problema vero
      // sono i literal in posizione String: assegnazioni, costanti, parametri
      // tipizzati String, `return` da computed property.
      if (SWIFTUI_AUTOLOCALIZED_RE.test(line)) return;

      // Una stringa gia' passata dal catalogo non e' una regressione: la si
      // toglie dalla riga prima di analizzarla, cosi' il resto della riga
      // resta comunque sotto controllo.
      const scannable = line
        .replace(/String\(\s*localized:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g, "String(localized:")
        // `t(` ma anche l'alias standard delle pagine (`import { t as i18nT }`):
        // senza, ogni stringa i18nT con accenti finiva flaggata come hardcoded.
        // Il pattern gestisce anche le virgolette escapate dentro la chiave.
        .replace(/\b(?:i18nT|t)\(\s*"[^"\\]*(?:\\.[^"\\]*)*"/g, "t(");

      for (const m of scannable.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
        if (!looksItalianUiString(m[1])) continue;
        // Se sta nel catalogo e' gia' localizzata, comunque ci arrivi.
        if (file.endsWith(".swift") && inCatalog(m[1])) continue;
        findings.push({ file, line: idx + 1, text: m[1] });
      }
    });
  }
}

// --- ratchet ---------------------------------------------------------------
// Durante una migrazione un file e' normalmente migrato A META': una guardia
// che blocca ogni commit finche' un file non e' al 100% diventa ostile proprio
// mentre ci stai lavorando, e finisce aggirata con --no-verify.
//
// Quindi: il debito gia' noto sta in una baseline e non blocca. Blocca solo
// cio' che NON e' in baseline, cioe' le stringhe nuove. La baseline puo' solo
// calare: quando una stringa viene migrata sparisce dai findings e va tolta con
// --update-baseline. Se qualcuno la rimettesse, tornerebbe a bloccare.
const BASELINE_PATH = "scripts/i18n-baseline.json";
const key = (f) => `${f.file}|${f.text}`;

let baseline = new Set();
try {
  baseline = new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
} catch {
  // Nessuna baseline: tutto e' considerato nuovo.
}

const fresh = findings.filter((f) => !baseline.has(key(f)));
const stillOwed = findings.filter((f) => baseline.has(key(f)));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(fresh, null, 1));
  process.exit(0);
}

if (process.argv.includes("--update-baseline")) {
  const next = [...new Set(findings.map(key))].sort();
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 1) + "\n", "utf8");
  console.log(`✓ Baseline aggiornata: ${next.length} stringhe ancora da migrare.`);
  process.exit(0);
}

if (fresh.length) {
  console.error(`\n✖ ${fresh.length} stringa/e italiana/e NUOVA/E fuori dal catalogo:\n`);
  for (const f of fresh.slice(0, 40)) {
    console.error(`  ${f.file}:${f.line}  "${f.text}"`);
  }
  if (fresh.length > 40) console.error(`  … e altre ${fresh.length - 40}.`);
  console.error(`\n  Passale dal catalogo. Glossario: docs/I18N_GLOSSARY.md`);
  console.error(`  (debito preesistente in ${BASELINE_PATH}: ${stillOwed.length} stringhe)\n`);
  process.exit(1);
}

if (stillOwed.length) {
  console.log(`✓ Nessuna regressione i18n. Debito noto ancora da migrare: ${stillOwed.length}.`);
} else {
  console.log("✓ Nessuna regressione i18n nei file migrati.");
}
