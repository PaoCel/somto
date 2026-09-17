#!/usr/bin/env node
/**
 * i18n-codemod-html.mjs — marca il testo italiano nell'HTML statico.
 *
 * Il codemod JS copre solo cio' che il codice scrive a runtime. Ma meta' del
 * testo della PWA sta direttamente nell'HTML delle 50 pagine, e li' non passa
 * da nessuna funzione: resta italiano qualunque lingua scelga l'utente.
 *
 * Qui NON si riscrive il testo: si aggiunge un marcatore, e la traduzione
 * avviene a runtime con `applyStaticTranslations()`. La chiave e' il testo
 * italiano stesso, quindi l'HTML resta leggibile e se la traduzione manca
 * l'italiano e' gia' a schermo.
 *
 *   <h1>Accedi</h1>             ->  <h1 data-i18n>Accedi</h1>
 *   <input placeholder="Cerca"> ->  <input data-i18n-attr="placeholder" placeholder="Cerca">
 *
 * Regola di sicurezza: si marca SOLO un elemento che contiene esclusivamente
 * testo. Su un elemento con figli, `textContent = ...` cancellerebbe il markup
 * interno.
 *
 * Uso: node scripts/i18n-codemod-html.mjs [file|dir] [--write]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// slice(2): argv[0] e' il binario node e argv[1] questo script — cercare "il
// primo che non e' un flag" li' dentro sceglierebbe il path di node.
const target = process.argv.slice(2).find((a) => !a.startsWith("--")) || "public";
const write = process.argv.includes("--write");

const IT_WORDS = [
  "il","lo","la","le","gli","un","una","del","della","dei","delle","per","con",
  "che","non","sei","hai","puoi","tuo","tua","questo","questa","ancora","nessun",
  "nessuna","sono","stai","devi","come","quando","tutti","tutte","vuoi","piu",
  "gia","anche","solo","oppure","senza","dal","alla","ai","tra","fra","suo","sua",
  // "di" ed "e" da soli valgono meta' dell'italiano. Restano fuori "a", "in",
  // "o", "no": sono parole inglesi e marcherebbero testo gia' in inglese.
  "di","e","ed","da","su","sul","sulla","nel","nella","negli","degli","dello",
  "si","ti","mi","ci","ma","se","ogni","dove","cosa","dopo","prima","ora","poi",
  "tuoi","tue","miei","mie","suoi","nostri","nostre","vostri","vostre","loro",
  "qui","quale","quali","altri","altre","altro","altra","meno","molto","troppo",
];
const IT_RE = new RegExp(`\\b(${IT_WORDS.join("|")})\\b`, "i");
const ACCENT_RE = /[àèéìòùÀÈÉÌÒÙ]/;

// Il catalogo iOS e il dizionario web sono elenchi di stringhe GIA' certificate
// come testo per l'utente. Coprono il buco dell'euristica: "Accetta analytics"
// non ha accenti ne' parole italiane comuni, ma e' evidentemente UI.
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

/** Verbi comuni dell'UI italiana senza accenti ne' stopword. */
const UI_VERBS = /^(accedi|registrati|salva|chiudi|annulla|conferma|continua|invia|cerca|aggiungi|rimuovi|elimina|modifica|apri|indietro|avanti|fatto|riprova|accetta|rifiuta|gestisci|condividi|segui|copia|carica|scarica|importa|esporta|filtra|ordina|vota|commenta|pubblica|impostazioni|notifiche|profilo|supporto)\b/i;

function isItalianUi(text) {
  const s = text.trim();
  if (s.length < 2 || s.length > 400) return false;
  if (!/[a-zA-ZÀ-ù]/.test(s)) return false;
  if (/^[\d\s.,:%+×·—–-]+$/.test(s)) return false;
  if (/^https?:\/\//.test(s)) return false;
  if (s.includes("@@I18N")) return false;
  return KNOWN.has(s) || ACCENT_RE.test(s) || IT_RE.test(s) || UI_VERBS.test(s);
}

const ATTRS = ["placeholder", "title", "aria-label", "alt"];

// Pagine da non toccare.
//
// - admin/QA e verifica Google: uso interno, restano in italiano (glossario).
// - legali: il testo ha valore contrattuale, serve revisione legale.
// - quelle con una gemella statica sotto /en/: hanno gia' la loro versione
//   inglese a un URL proprio. Tradurle anche a runtime farebbe rendere inglese
//   l'URL italiano, che l'hreflang dichiara italiano — segnale contraddittorio
//   per Google, e due pagine identiche in competizione.
const SKIP = new Set(["privacy.html", "terms.html", "cookies.html", "consent.html", "moderation.html"]);
try {
  for (const n of readdirSync("public/en")) if (n.endsWith(".html")) SKIP.add(n);
} catch {}
const SKIP_RE = /^(admin-|people_avatars|support-import|google[0-9a-f]{16})/;

function files(p) {
  if (statSync(p).isFile()) return [p];
  const out = [];
  for (const n of readdirSync(p)) {
    const f = join(p, n);
    if (statSync(f).isDirectory()) continue;
    if (extname(n) !== ".html") continue;
    if (SKIP.has(n) || SKIP_RE.test(n)) continue;
    out.push(f);
  }
  return out;
}

let totText = 0, totAttr = 0, totFiles = 0;

for (const file of files(target)) {
  let src = readFileSync(file, "utf8");
  const before = src;

  // Fuori: script, style e commenti — non sono testo per l'utente.
  const protect = [];
  src = src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, (m) => {
    protect.push(m);
    // Token univoco: un segnaposto come " 12 " matcherebbe qualunque numero
    // gia' presente nell'HTML e la ricostruzione esploderebbe.
    return `@@I18N${protect.length - 1}@@`;
  });

  // 1) elementi SOLO-testo
  src = src.replace(
    /<([a-z][a-z0-9]*)((?:\s[^<>]*)?)>([^<>]+)<\/\1>/gi,
    (whole, tag, attrs, text) => {
      if (/data-i18n(\s|=|$)/.test(attrs)) return whole;
      // `option` NON va escluso: il suo testo e' quello che l'utente legge nel
      // menu a tendina ("Tutti i tipi", "Tutti i generi").
      if (/^(script|style|title|code|pre)$/i.test(tag)) return whole;
      if (!isItalianUi(text)) return whole;
      totText++;
      return `<${tag}${attrs} data-i18n>${text}</${tag}>`;
    }
  );

  // 2) attributi leggibili dall'utente
  src = src.replace(/<([a-z][a-z0-9]*)((?:\s[^<>]*)?)(\/?)>/gi, (whole, tag, attrs, slash) => {
    if (/data-i18n-attr/.test(attrs)) return whole;
    const found = ATTRS.filter((a) => {
      const m = attrs.match(new RegExp(`\\b${a}="([^"]*)"`));
      return m && isItalianUi(m[1]);
    });
    if (!found.length) return whole;
    totAttr += found.length;
    return `<${tag}${attrs} data-i18n-attr="${found.join(",")}"${slash}>`;
  });

  src = src.replace(/@@I18N(\d+)@@/g, (_, i) => protect[Number(i)]);

  if (src !== before) {
    if (write) writeFileSync(file, src, "utf8");
    totFiles++;
    console.log(`  ${file}`);
  }
}

console.log(`\nPagine modificate : ${totFiles}`);
console.log(`Testi marcati     : ${totText}`);
console.log(`Attributi marcati : ${totAttr}`);
if (!write) console.log("\nDry-run. Rilancia con --write.");
