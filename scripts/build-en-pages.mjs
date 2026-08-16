#!/usr/bin/env node
/**
 * build-en-pages.mjs — pubblica sotto /en/ le pagine pubbliche tradotte e
 * mette in ordine i marcatori di lingua su ENTRAMBE le versioni.
 *
 * La traduzione la fanno altri (agenti o persone) e arriva come copia HTML con
 * il markup intatto. Questo script fa il resto, che e' meccanico e va fatto in
 * modo identico ovunque:
 *
 *   - lang, og:locale, JSON-LD inLanguage
 *   - canonical che punta a se stessa
 *   - hreflang RECIPROCI: la pagina IT deve dichiarare la EN e viceversa.
 *     Google ignora in silenzio gli hreflang non reciproci — non da' errore,
 *     semplicemente smette di considerarli, e la versione inglese non viene
 *     mai associata a quella italiana.
 *   - link interni verso le pagine che ESISTONO in inglese, cosi' un utente
 *     non ricade in italiano al primo clic. Le pagine senza versione EN
 *     restano in italiano di proposito: meglio un link onesto che un 404.
 *
 * Uso: node scripts/build-en-pages.mjs <cartella-sorgente-tradotta> [--write]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = process.argv[2];
const write = process.argv.includes("--write");
const OUT = "public/en";
const IT_DIR = "public";
const BASE = "https://somto.it";

if (!SRC) {
  console.error("Uso: node scripts/build-en-pages.mjs <cartella-tradotta> [--write]");
  process.exit(2);
}

const pages = readdirSync(SRC).filter((f) => f.endsWith(".html")).sort();
const translated = new Set(pages);

function itUrl(name) {
  return name === "index.html" ? `${BASE}/` : `${BASE}/${name}`;
}
function enUrl(name) {
  return name === "index.html" ? `${BASE}/en/` : `${BASE}/en/${name}`;
}

/** Blocco hreflang completo e reciproco, identico su entrambe le versioni. */
function hreflangBlock(name) {
  return [
    `  <link rel="alternate" hreflang="it-IT" href="${itUrl(name)}">`,
    `  <link rel="alternate" hreflang="en" href="${enUrl(name)}">`,
    `  <link rel="alternate" hreflang="x-default" href="${itUrl(name)}">`,
  ].join("\n");
}

/** Toglie ogni <link rel="alternate" hreflang=...> esistente. */
function stripHreflang(html) {
  return html.replace(/[ \t]*<link[^>]+rel="alternate"[^>]+hreflang="[^"]*"[^>]*>\s*\n?/g, "");
}

/** Reinserisce il blocco subito dopo il canonical (o dopo <head> se manca). */
function injectHreflang(html, name) {
  const block = hreflangBlock(name) + "\n";
  const canonical = html.match(/[ \t]*<link[^>]+rel="canonical"[^>]*>\s*\n/);
  if (canonical) return html.replace(canonical[0], canonical[0] + block);
  return html.replace(/<head[^>]*>\s*\n/, (m) => m + block);
}

let touchedEn = 0;
let touchedIt = 0;

for (const name of pages) {
  // --- versione EN -------------------------------------------------------
  let en = readFileSync(join(SRC, name), "utf8");

  en = en.replace(/<html([^>]*)\slang="[^"]*"/, '<html$1 lang="en"');
  en = en.replace(/(property="og:locale"[^>]*content=")[^"]*(")/g, "$1en_US$2");
  en = en.replace(/(content=")[^"]*("[^>]*property="og:locale")/g, "$1en_US$2");
  // JSON-LD: segnalato da due revisori indipendenti, non era nella lista iniziale.
  en = en.replace(/("inLanguage"\s*:\s*")[^"]*(")/g, "$1en$2");
  en = en.replace(/(rel="canonical"[^>]*href=")[^"]*(")/, `$1${enUrl(name)}$2`);
  en = injectHreflang(stripHreflang(en), name);

  // Coerenza col catalogo iOS, che ha gia' spedito "Sign In".
  en = en.replace(/\bLog in\b/g, "Sign In").replace(/\bLog In\b/g, "Sign In");

  // Link interni: solo verso pagine che esistono davvero in inglese.
  en = en.replace(/href="\/([a-z0-9-]+\.html)"/g, (m, f) =>
    translated.has(f) ? `href="/en/${f}"` : m
  );
  en = en.replace(/href="\/"(?=[\s>])/g, 'href="/en/"');

  if (write) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, name), en, "utf8");
  }
  touchedEn++;

  // --- versione IT: deve dichiarare la sorella inglese --------------------
  const itPath = join(IT_DIR, name);
  if (existsSync(itPath)) {
    let it = readFileSync(itPath, "utf8");
    const next = injectHreflang(stripHreflang(it), name);
    if (next !== it) {
      if (write) writeFileSync(itPath, next, "utf8");
      touchedIt++;
    }
  }
}

console.log(`Pagine EN generate : ${touchedEn}`);
console.log(`Pagine IT aggiornate (hreflang reciproco): ${touchedIt}`);
if (!write) console.log("\nDry-run. Rilancia con --write per applicare.");
