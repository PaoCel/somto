#!/usr/bin/env node
/**
 * i18n-codemod-html-templates.mjs — estrae il testo dai template HTML.
 *
 * Il codemod principale salta i template che contengono markup, e fa bene: se
 * finisce un `<div>` dentro il dizionario, un traduttore che sposta un tag
 * rompe la pagina. Ma il testo dentro quei template va comunque tradotto.
 *
 * Qui il markup NON entra nel dizionario: si isola solo il testo che sta FRA i
 * tag e lo si avvolge in `${t("...")}`, lasciando la struttura HTML intatta
 * nel sorgente.
 *
 *   `<span>Contiene spoiler</span>`
 *   -> `<span>${t("Contiene spoiler")}</span>`
 *
 * Traduce anche gli attributi che l'utente legge (placeholder, title,
 * aria-label, alt), che sono testo a tutti gli effetti anche se stanno dentro
 * un tag.
 *
 * NON tocca: contenuto di <script>/<style>, parti gia' dentro ${...}, testo
 * senza indizi di italiano.
 *
 * Uso: node scripts/i18n-codemod-html-templates.mjs <file|dir> [--write]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(process.cwd(), "functions/package.json"));
const parser = require("@babel/parser");
const traverseMod = require("@babel/traverse");
const traverse = traverseMod.default || traverseMod;

const target = process.argv[2];
const write = process.argv.includes("--write");
if (!target) {
  console.error("Uso: node scripts/i18n-codemod-html-templates.mjs <file|dir> [--write]");
  process.exit(2);
}

// Stessa euristica del codemod HTML: la prima versione era troppo stretta e
// lasciava passare frasi senza accenti ne' articoli — "Cerca in Somto" e' finita
// cosi' in produzione dentro il pannello di ricerca, in italiano, con la lingua
// impostata su inglese.
const IT_RE = /\b(il|lo|la|le|gli|un|una|del|della|dei|delle|per|con|che|non|sei|hai|puoi|tuo|tua|questo|questa|ancora|nessun|nessuna|sono|stai|devi|come|quando|tutti|tutte|vuoi|piu|gia|anche|solo|oppure|senza|dal|alla|ai|tra|fra|suo|sua|di|e|ed|da|su|sul|sulla|nel|nella|negli|degli|dello|si|ti|mi|ci|ma|se|ogni|dove|cosa|dopo|prima|ora|poi|qui|quale|quali|altri|altre|altro|altra|meno|molto|troppo|tuoi|tue|miei|mie|suoi|nostri|nostre|vostri|vostre|loro)\b/i;
const ACCENT_RE = /[àèéìòùÀÈÉÌÒÙ]/;
const UI_VERBS = /^(accedi|registrati|salva|chiudi|annulla|conferma|continua|invia|cerca|aggiungi|rimuovi|elimina|modifica|apri|indietro|avanti|fatto|riprova|accetta|rifiuta|gestisci|condividi|segui|copia|carica|scarica|importa|esporta|filtra|ordina|vota|commenta|pubblica|impostazioni|notifiche|profilo|supporto|ricerca|moderazione)\b/i;

// Catalogo iOS + dizionario web: stringhe gia' certificate come testo utente.
let KNOWN = new Set();
try {
  KNOWN = new Set(
    Object.keys(JSON.parse(readFileSync("ios/TwoWatch/Resources/Localizable.xcstrings", "utf8")).strings || {})
  );
} catch {}
try {
  const en = readFileSync("public/js/i18n/en.js", "utf8");
  for (const m of en.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)) {
    try { KNOWN.add(JSON.parse(`"${m[1]}"`)); } catch {}
  }
} catch {}

function isItalianText(s) {
  const t = s.trim();
  if (t.length < 3) return false;
  if (!/[a-zA-ZÀ-ù]/.test(t)) return false;
  if (/^\$\{/.test(t)) return false;
  return KNOWN.has(t) || ACCENT_RE.test(t) || IT_RE.test(t) || UI_VERBS.test(t);
}

/** Attributi il cui valore l'utente legge davvero. */
const TEXT_ATTRS = /\b(placeholder|title|aria-label|alt)="([^"${]*)"/g;

function files(p) {
  if (statSync(p).isFile()) return [p];
  const out = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) { if (n !== "i18n" && n !== "node_modules") walk(f); }
      else if (extname(n) === ".js") out.push(f);
    }
  })(p);
  return out;
}


// File caricati come `<script>` CLASSICO (non type="module"): un import qui e'
// un SyntaxError e il file non parte. Ricavati dall'HTML, non a mano.
const CLASSIC_SCRIPTS = new Set();
try {
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync("public").filter((n) => n.endsWith(".html"))) {
    const html = readFileSync(join("public", f), "utf8");
    for (const m of html.matchAll(/<script(?![^>]*type="module")[^>]*src="(\/js\/[^"]+)"/g)) {
      CLASSIC_SCRIPTS.add("public" + m[1].split("?")[0]);
    }
  }
} catch {}

let totText = 0, totAttr = 0, totFiles = 0;

for (const file of files(target)) {
  if (CLASSIC_SCRIPTS.has(file)) { console.log(`  (salto script classico) ${file}`); continue; }
  const src = readFileSync(file, "utf8");
  let ast;
  try { ast = parser.parse(src, { sourceType: "module", plugins: ["topLevelAwait"] }); }
  catch { continue; }

  const edits = [];

  traverse(ast, {
    TemplateLiteral(path) {
      if (path.parent?.type === "TaggedTemplateExpression") return;
      const raw = src.slice(path.node.start, path.node.end);
      if (!/[<>]/.test(raw)) return;                 // gestito dal codemod principale

      // Ogni quasi e' un pezzo statico fra due interpolazioni: lavorare qui
      // evita di toccare cio' che sta dentro ${...}.
      for (const q of path.node.quasis) {
        const chunk = src.slice(q.start, q.end);
        let out = chunk;

        // 1) testo fra i tag: >   testo   <
        out = out.replace(/>([^<>{}]+)</g, (whole, inner) => {
          if (!isItalianText(inner)) return whole;
          const lead = inner.match(/^\s*/)[0];
          const tail = inner.match(/\s*$/)[0];
          // Il testo arriva dal SORGENTE, quindi una escape come `\u2190` qui
          // e' ancora la sequenza di 6 caratteri. Passarla a JSON.stringify
          // la ri-escaperebbe e l'utente vedrebbe scritto "\u2190" invece
          // della freccia. Si interpreta prima, poi si ri-serializza.
          let text = inner.trim();
          try { text = JSON.parse(`"${text.replace(/"/g, '\\"')}"`); } catch {}
          totText++;
          return `>${lead}\${i18nT(${JSON.stringify(text)})}${tail}<`;
        });

        // 2) attributi leggibili
        out = out.replace(TEXT_ATTRS, (whole, attr, value) => {
          if (!isItalianText(value)) return whole;
          totAttr++;
          return `${attr}="\${i18nT(${JSON.stringify(value.trim())})}"`;
        });

        if (out !== chunk) edits.push({ start: q.start, end: q.end, text: out });
      }
    },
  });

  if (!edits.length) continue;

  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  // Controllare un import QUALSIASI da i18n non basta: un file puo'
  // gia' importare initI18n senza avere la funzione di traduzione, e in
  // quel caso resterebbe undefined a runtime. Si verifica il BINDING.
  if (!/\bi18nT\b\s*[,}]/.test(out.split("\n").filter(l => l.startsWith("import")).join("\n"))) {
    const rel = relative(dirname(file), "public/js/i18n/index.js").replace(/\\/g, "/");
    const spec = rel.startsWith(".") ? rel : "./" + rel;
    const first = out.match(/^import .*?;$/m);
    const line = `import { t as i18nT } from "${spec}";`;
    out = first ? out.replace(first[0], first[0] + "\n" + line) : line + "\n" + out;
  }

  if (write) writeFileSync(file, out, "utf8");
  totFiles++;
  console.log(`  ${file}`);
}

console.log(`\nFile modificati : ${totFiles}`);
console.log(`Testi fra i tag : ${totText}`);
console.log(`Attributi       : ${totAttr}`);
if (!write) console.log("\nDry-run. Rilancia con --write.");
