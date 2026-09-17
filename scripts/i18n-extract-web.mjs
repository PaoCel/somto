#!/usr/bin/env node
/**
 * i18n-extract-web.mjs — trova le stringhe user-facing nei controller della PWA.
 *
 * Lato iOS l'estrazione la fa il compilatore Swift. Sul web non c'e' nessun
 * compilatore, quindi tocca farla qui — con un parser vero, non con grep: un
 * `grep '"'` su 114 file restituisce quindici volte piu' rumore che segnale
 * (selettori CSS, chiavi Firestore, path di import, nomi di evento).
 *
 * Usa @babel/parser (gia' presente in functions/node_modules).
 *
 * Uso:
 *   node scripts/i18n-extract-web.mjs                 # riepilogo per file
 *   node scripts/i18n-extract-web.mjs <file.js>       # dettaglio di un file
 *   node scripts/i18n-extract-web.mjs --json <out>    # elenco completo
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(process.cwd(), "functions/package.json"));
const parser = require("@babel/parser");
const traverseMod = require("@babel/traverse");
const traverse = traverseMod.default || traverseMod;

const ROOT = "public/js";

// Il dizionario e' la fonte, non un file da analizzare.
const SKIP_DIRS = new Set(["i18n", "node_modules"]);

const IT_WORDS = [
  "il", "lo", "la", "le", "gli", "un", "una", "del", "della", "dei", "delle",
  "per", "con", "che", "non", "sei", "hai", "puoi", "tuo", "tua", "tuoi",
  "questo", "questa", "ancora", "adesso", "prima", "dopo", "nessun", "nessuna",
  "sono", "siamo", "stai", "devi", "sulla", "sulle", "dalla", "come", "quando",
  "perche", "gia", "solo", "anche", "piu", "molto", "tutti", "tutte", "vuoi",
];
const IT_RE = new RegExp(`\\b(${IT_WORDS.join("|")})\\b`, "i");
const ACCENT_RE = /[àèéìòùÀÈÉÌÒÙ]/;

/** Sembra testo per una persona, non un identificatore per una macchina. */
function looksUiText(s) {
  const t = s.trim();
  if (t.length < 3) return false;
  if (!/[a-zA-ZÀ-ù]/.test(t)) return false;          // solo simboli/numeri
  if (/^https?:\/\//.test(t) || t.startsWith("/")) return false;
  if (/^[.#][\w-]+$/.test(t)) return false;          // selettore CSS
  if (/^[\w-]+$/.test(t) && !ACCENT_RE.test(t)) return false; // singola parola-id
  if (/^[a-z]+([A-Z][a-z]+)+$/.test(t)) return false; // camelCase
  if (/^[a-z0-9_]+$/.test(t)) return false;           // snake_case / chiave
  return ACCENT_RE.test(t) || IT_RE.test(t) || / [a-zà-ù]/.test(t);
}

/** Contesti in cui una stringa non e' mai testo per l'utente. */
function inMachineContext(path) {
  const p = path.parent;
  if (!p) return false;
  if (p.type === "ImportDeclaration" || p.type === "ExportNamedDeclaration") return true;
  if (p.type === "CallExpression") {
    const c = p.callee;
    const name =
      (c.type === "MemberExpression" && c.property && c.property.name) ||
      (c.type === "Identifier" && c.name) ||
      "";
    // DOM, console, eventi, Firestore: la stringa e' un selettore o una chiave.
    if (/^(querySelector|querySelectorAll|getElementById|getElementsByClassName|createElement|setAttribute|getAttribute|removeAttribute|addEventListener|removeEventListener|matches|closest|contains|add|remove|toggle|collection|doc|where|orderBy|startAt|endAt|getItem|setItem|removeItem|log|warn|error|debug|info|logEvent|assert)$/.test(name)) {
      return true;
    }
  }
  // Chiave di un oggetto usata come mappa tecnica: { "post_like": ... }
  if (p.type === "ObjectProperty" && p.key === path.node) return true;
  return false;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (extname(name) === ".js") out.push(full);
  }
  return out;
}

const only = process.argv.find((a) => a.endsWith(".js") && a !== process.argv[1]);
const jsonIdx = process.argv.indexOf("--json");
const files = only ? [only] : walk(ROOT);

const found = [];
let parseErrors = 0;

for (const file of files) {
  let ast;
  try {
    ast = parser.parse(readFileSync(file, "utf8"), {
      sourceType: "module",
      plugins: ["topLevelAwait", "optionalChaining", "nullishCoalescingOperator"],
    });
  } catch {
    parseErrors++;
    continue;
  }

  traverse(ast, {
    StringLiteral(path) {
      if (inMachineContext(path)) return;
      if (looksUiText(path.node.value)) {
        found.push({ file, line: path.node.loc.start.line, text: path.node.value, kind: "string" });
      }
    },
    TemplateLiteral(path) {
      // Un template con interpolazione va segnalato per intero: il placeholder
      // sta DENTRO la frase e va gestito come tale, non spezzato.
      const raw = path.node.quasis.map((q) => q.value.cooked).join("{}");
      if (looksUiText(raw)) {
        found.push({
          file,
          line: path.node.loc.start.line,
          text: raw,
          kind: path.node.expressions.length ? "template+interp" : "template",
        });
      }
    },
  });
}

if (jsonIdx >= 0) {
  const out = process.argv[jsonIdx + 1];
  writeFileSync(out, JSON.stringify(found, null, 1) + "\n", "utf8");
  console.log(`${found.length} stringhe scritte in ${out}`);
  process.exit(0);
}

if (only) {
  for (const f of found) console.log(`  ${f.line}\t[${f.kind}]\t${JSON.stringify(f.text.slice(0, 90))}`);
  console.log(`\n${found.length} stringhe in ${only}`);
  process.exit(0);
}

const byFile = new Map();
for (const f of found) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
const uniq = new Set(found.map((f) => f.text));
const interp = found.filter((f) => f.kind === "template+interp").length;

console.log(`File analizzati : ${files.length}${parseErrors ? ` (${parseErrors} non parsati)` : ""}`);
console.log(`Stringhe UI     : ${found.length}  (uniche ${uniq.size})`);
console.log(`Con interpolazione dentro la frase: ${interp}\n`);
for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(n).padStart(4)}  ${f}`);
}
