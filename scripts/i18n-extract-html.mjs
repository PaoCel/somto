#!/usr/bin/env node
/**
 * i18n-extract-html.mjs — elenca le chiavi marcate nell'HTML e quelle scoperte.
 *
 * Speculare a `i18n-codemod-html.mjs`: quello marca, questo legge i marcatori e
 * dice cosa manca in `public/js/i18n/en.js`. Sta in un file (e non in un `node
 * -e`) perche' le regex sugli attributi vanno costruite dinamicamente, e
 * passarle attraverso la shell le aveva gia' silenziosamente rotte una volta:
 * gli attributi risultavano tutti tradotti mentre non lo era nessuno.
 *
 * Uso: node scripts/i18n-extract-html.mjs [--json <file>]
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ATTRS = ["placeholder", "title", "aria-label", "alt"];
const keys = new Set();

for (const name of readdirSync("public").filter((n) => n.endsWith(".html"))) {
  const raw = readFileSync(join("public", name), "utf8");
  // Solo le pagine che il codemod ha marcato: le altre (admin, legali, e quelle
  // con gemella statica sotto /en/) restano fuori anche per il titolo.
  if (!/\sdata-i18n(?:\s|>|=)/.test(raw)) continue;

  // Il <title> non porta attributi utili: `applyStaticTranslations` lo traduce
  // usando il testo stesso come chiave, quindi va raccolto qui a mano.
  const title = raw.match(/<title>([^<]+)<\/title>/i);
  if (title) keys.add(title[1].trim());

  const html = raw.replace(
    /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g,
    ""
  );

  // Testo: elementi marcati `data-i18n` che contengono solo testo.
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)((?:\s[^<>]*)?)>([^<>]+)<\/\1>/gi)) {
    if (!/\sdata-i18n(?:\s|>|$)/.test("<x" + m[2] + ">")) continue;
    const text = m[3].trim();
    if (text) keys.add(text);
  }

  // Attributi: la lista vive in `data-i18n-attr`.
  for (const tag of html.matchAll(/<[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi)) {
    const decl = tag[0].match(/data-i18n-attr="([^"]*)"/);
    if (!decl) continue;
    for (const raw of decl[1].split(",")) {
      const attr = raw.trim();
      if (!ATTRS.includes(attr)) continue;
      const v = tag[0].match(new RegExp(`\\s${attr}="([^"]*)"`));
      if (v && v[1].trim()) keys.add(v[1].trim());
    }
  }
}

const en = readFileSync("public/js/i18n/en.js", "utf8");
const have = new Set();
for (const m of en.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)) {
  try { have.add(JSON.parse(`"${m[1]}"`)); } catch {}
}

const missing = [...keys].filter((k) => !have.has(k)).sort();
console.log(`marcate ${keys.size} · tradotte ${keys.size - missing.length} · da tradurre ${missing.length}`);

const out = process.argv.indexOf("--json");
if (out !== -1 && process.argv[out + 1]) {
  writeFileSync(process.argv[out + 1], JSON.stringify(missing, null, 1));
} else {
  for (const k of missing) console.log("  " + k);
}
