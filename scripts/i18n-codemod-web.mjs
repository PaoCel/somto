#!/usr/bin/env node
/**
 * i18n-codemod-web.mjs — avvolge in `t(...)` le stringhe user-facing della PWA.
 *
 * Usa @babel/parser SOLO per individuare le posizioni, poi sostituisce nel
 * testo sorgente per offset (dall'ultima alla prima, cosi' gli offset restano
 * validi). **Non** rigenera i file dall'AST: farlo riscriverebbe formattazione
 * e commenti di 114 file e produrrebbe diff illeggibili, in cui una modifica
 * sbagliata sparirebbe nel rumore.
 *
 * Cosa trasforma:
 *   "Salva"                    ->  t("Salva")
 *   `Hai ${n} titoli`          ->  t("Hai {n} titoli", { n })
 *   `Ciao ${u.displayName}`    ->  t("Ciao {displayName}", { displayName: u.displayName })
 *
 * Cosa NON tocca, di proposito:
 *   - template che contengono HTML (`<`): finirebbero nel dizionario con i tag
 *     dentro, e un traduttore che sposta un `</div>` rompe la pagina. Vanno
 *     spezzati a mano nelle loro parti testuali. Lo script li conta e li elenca.
 *   - stringhe gia' dentro t()
 *   - selettori DOM, chiavi Firestore, path di import, console.*, nomi evento
 *
 * Uso:
 *   node scripts/i18n-codemod-web.mjs <file.js|dir> [--write]
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
  console.error("Uso: node scripts/i18n-codemod-web.mjs <file.js|dir> [--write]");
  process.exit(2);
}

const IT_WORDS = [
  "il","lo","la","le","gli","un","una","del","della","dei","delle","per","con",
  "che","non","sei","hai","puoi","tuo","tua","tuoi","questo","questa","ancora",
  "adesso","prima","dopo","nessun","nessuna","sono","siamo","stai","devi",
  "sulla","sulle","dalla","come","quando","perche","gia","solo","anche","piu",
  "molto","tutti","tutte","vuoi",
];
const IT_RE = new RegExp(`\\b(${IT_WORDS.join("|")})\\b`, "i");
const ACCENT_RE = /[àèéìòùÀÈÉÌÒÙ]/;

// Il catalogo iOS e' un elenco di 1732 stringhe GIA' certificate come testo per
// l'utente — e gia' tradotte. Usarlo come dizionario di riconoscimento risolve
// il punto cieco dell'euristica: "Accedi", "Salva", "Chiudi" sono parole
// singole senza accenti, indistinguibili da un identificatore guardando solo la
// forma. Qui invece sappiamo che sono UI perche' su iOS lo sono gia'.
let IOS_KEYS = new Set();
try {
  const cat = JSON.parse(readFileSync("ios/TwoWatch/Resources/Localizable.xcstrings", "utf8"));
  IOS_KEYS = new Set(Object.keys(cat.strings || {}));
} catch {
  // Catalogo assente: si resta sulla sola euristica.
}

function looksUiText(s) {
  const t = String(s).trim();
  if (t.length < 3) return false;
  if (!/[a-zA-ZÀ-ù]/.test(t)) return false;
  if (/^https?:\/\//.test(t) || t.startsWith("/")) return false;
  if (/^[.#][\w-]+$/.test(t)) return false;
  // Una parola singola tutta minuscola e' quasi sempre un identificatore
  // (valore CSS, id di tab, case di enum) anche quando compare nel catalogo
  // iOS: li' "auto" e "community" sono etichette, qui sono `style.height` e
  // l'id con cui si riconosce la tab. Il filtro di forma viene PRIMA della
  // whitelist, non dopo.
  if (/^[a-z][a-z0-9_-]*$/.test(t)) return false;
  if (IOS_KEYS.has(t)) return true;                  // certificata da iOS
  if (/^[\w-]+$/.test(t) && !ACCENT_RE.test(t)) return false;
  if (/^[a-z]+([A-Z][a-z]+)+$/.test(t)) return false;
  if (/^[a-z0-9_]+$/.test(t)) return false;
  // Serve una prova che sia ITALIANO. La sola presenza di spazi non basta:
  // "analytics init failed" e' una frase, ma e' un log di debug in inglese.
  return ACCENT_RE.test(t) || IT_RE.test(t);
}

// Proprieta' il cui VALORE e' un identificatore, non testo. Il caso che ha
// rotto tutto al primo giro: `{ id: "community" }` nella config delle tab.
// "community" e' anche una chiave del catalogo iOS, quindi la whitelist iOS
// scavalcava i filtri di forma e lo wrappava — traducendo l'id con cui si
// riconosce la tab attiva, cioe' rompendo la navigazione in inglese.
const IDENTIFIER_PROPS = new Set([
  "id", "key", "name", "type", "kind", "scope", "mode", "tab", "slug", "status",
  "source", "action", "event", "variant", "role", "state", "level", "target",
  "field", "path", "collection", "provider", "method", "code", "icon",
]);

const MACHINE_CALLEES =
  /^(querySelector|querySelectorAll|getElementById|getElementsByClassName|createElement|setAttribute|getAttribute|removeAttribute|addEventListener|removeEventListener|matches|closest|contains|add|remove|toggle|collection|doc|where|orderBy|startAt|endAt|getItem|setItem|removeItem|log|warn|error|debug|info|logEvent|assert|t|debugLog|debugWarn|reportClientError|trackEvent)$/;

function inMachineContext(path) {
  const p = path.parent;
  if (!p) return false;
  if (p.type === "ImportDeclaration" || p.type === "ExportNamedDeclaration") return true;
  // Chiave di un oggetto: { "post_like": ... }
  if (p.type === "ObjectProperty" && p.key === path.node && !p.computed) return true;
  // VALORE di una proprieta' identificativa: { id: "community" }
  if (
    p.type === "ObjectProperty" &&
    p.value === path.node &&
    p.key &&
    IDENTIFIER_PROPS.has(p.key.name || p.key.value)
  ) {
    return true;
  }
  // Confronti: `if (x === "community")` — se lo traduci, il confronto fallisce.
  if (p.type === "BinaryExpression" && /^([!=]==?)$/.test(p.operator)) return true;
  if (p.type === "SwitchCase" && p.test === path.node) return true;
  if (p.type === "CallExpression") {
    const c = p.callee;
    const name =
      (c.type === "MemberExpression" && c.property && c.property.name) ||
      (c.type === "Identifier" && c.name) || "";
    if (MACHINE_CALLEES.test(name)) return true;
  }
  return false;
}

/** Nome leggibile per un'espressione interpolata. */
function varName(node, used) {
  let base = null;
  if (node.type === "Identifier") base = node.name;
  else if (node.type === "MemberExpression" && node.property && node.property.name) {
    base = node.property.name;
  }
  if (!base || !/^[A-Za-z_]\w*$/.test(base) || used.has(base)) {
    let i = 0;
    while (used.has(`v${i}`)) i++;
    base = `v${i}`;
  }
  used.add(base);
  return base;
}

function jsString(s) {
  return JSON.stringify(s);
}

function files(p) {
  if (statSync(p).isFile()) return [p];
  const out = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) {
        if (n !== "i18n" && n !== "node_modules") walk(f);
      } else if (extname(n) === ".js") out.push(f);
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

let totWrapped = 0, totHtmlSkipped = 0, totFiles = 0;
const htmlExamples = [];

for (const file of files(target)) {
  if (CLASSIC_SCRIPTS.has(file)) { console.log(`  (salto script classico) ${file}`); continue; }
  const src = readFileSync(file, "utf8");
  let ast;
  try {
    ast = parser.parse(src, { sourceType: "module", plugins: ["topLevelAwait"] });
  } catch (e) {
    console.error(`  ! parse fallito: ${file}`);
    continue;
  }

  const edits = [];
  let htmlSkipped = 0;

  traverse(ast, {
    StringLiteral(path) {
      if (inMachineContext(path)) return;
      if (!looksUiText(path.node.value)) return;
      // Anche una stringa normale puo' contenere markup (assegnata a
      // innerHTML): se la wrappo intera, i tag finiscono nel dizionario e un
      // traduttore che sposta un </div> rompe la pagina. Se ne occupa
      // i18n-codemod-html-templates.mjs, che estrae solo il testo.
      if (/<[a-zA-Z/]/.test(path.node.value)) return;
      const { start, end } = path.node;
      edits.push({ start, end, text: `i18nT(${jsString(path.node.value)})` });
    },
    TemplateLiteral(path) {
      if (path.parent && path.parent.type === "TaggedTemplateExpression") return;
      const cooked = path.node.quasis.map((q) => q.value.cooked ?? "");
      const joined = cooked.join(" ");
      if (!looksUiText(joined.replace(/ /g, " "))) return;
      // HTML dentro il template: non finisce nel dizionario.
      if (/[<>]/.test(joined)) {
        htmlSkipped++;
        if (htmlExamples.length < 6) {
          htmlExamples.push(`${file}:${path.node.loc.start.line}`);
        }
        return;
      }
      const used = new Set();
      const names = path.node.expressions.map((e) => varName(e, used));
      let key = cooked[0];
      for (let i = 0; i < path.node.expressions.length; i++) {
        key += `{${names[i]}}` + cooked[i + 1];
      }
      const varsSrc = path.node.expressions
        .map((e, i) => {
          const exprSrc = src.slice(e.start, e.end);
          return exprSrc === names[i] ? names[i] : `${names[i]}: ${exprSrc}`;
        })
        .join(", ");
      const call = varsSrc
        ? `i18nT(${jsString(key)}, { ${varsSrc} })`
        : `i18nT(${jsString(key)})`;
      edits.push({ start: path.node.start, end: path.node.end, text: call });
    },
  });

  if (!edits.length) {
    totHtmlSkipped += htmlSkipped;
    continue;
  }

  // Scarta gli edit annidati (una stringa dentro un template gia' sostituito).
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const keep = [];
  let lastEnd = -1;
  for (const e of edits) {
    if (e.start >= lastEnd) { keep.push(e); lastEnd = e.end; }
  }

  let out = src;
  for (const e of [...keep].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  // Import di t(), se manca.
  // Controllare un import QUALSIASI da i18n non basta: un file puo'
  // gia' importare initI18n senza avere la funzione di traduzione, e in
  // quel caso resterebbe undefined a runtime. Si verifica il BINDING.
  if (!/\bi18nT\b\s*[,}]/.test(out.split("\n").filter(l => l.startsWith("import")).join("\n"))) {
    const rel = relative(dirname(file), "public/js/i18n/index.js").replace(/\\/g, "/");
    const spec = rel.startsWith(".") ? rel : "./" + rel;
    const firstImport = out.match(/^import .*?;$/m);
    const line = `import { t as i18nT } from "${spec}";\n`;
    out = firstImport ? out.replace(firstImport[0], firstImport[0] + "\n" + line.trim()) : line + out;
  }

  if (write) writeFileSync(file, out, "utf8");
  totWrapped += keep.length;
  totHtmlSkipped += htmlSkipped;
  totFiles++;
  console.log(`  ${String(keep.length).padStart(4)} wrap  ${String(htmlSkipped).padStart(3)} html-skip  ${file}`);
}

console.log(`\nFile modificati : ${totFiles}`);
console.log(`Stringhe wrappate: ${totWrapped}`);
console.log(`Template con HTML saltati (da fare a mano): ${totHtmlSkipped}`);
if (htmlExamples.length) console.log("  es: " + htmlExamples.join(", "));
if (!write) console.log("\nDry-run. Rilancia con --write.");
