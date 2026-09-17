#!/usr/bin/env node
/**
 * Copertura verificabile di una lingua su iOS e web.
 *
 * Conta anche le variation unit dei plurali nello String Catalog e confronta
 * il dizionario web con le chiavi realmente usate da t()/i18nT() e con il
 * markup data-i18n. A differenza del vecchio audit euristico non conta
 * commenti, URL o altre stringhe tecniche come UI.
 *
 * Uso:
 *   node scripts/i18n-coverage.mjs [--lang en]
 *   node scripts/i18n-coverage.mjs --lang en --gate
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const args = process.argv.slice(2);
const langIndex = args.indexOf("--lang");
const lang = (langIndex >= 0 ? args[langIndex + 1] : "en")?.trim().toLowerCase();
const gate = args.includes("--gate");

if (!/^[a-z]{2,3}$/.test(lang || "")) {
  console.error("Uso: node scripts/i18n-coverage.mjs [--lang en] [--gate]");
  process.exit(2);
}

const CATALOG = "ios/TwoWatch/Resources/Localizable.xcstrings";
const WEB_DICTIONARY = `public/js/i18n/${lang}.js`;

function stringUnits(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (value.stringUnit) out.push(value.stringUnit);
  for (const child of Object.values(value)) stringUnits(child, out);
  return out;
}

function isTranslated(entry) {
  const units = stringUnits(entry?.localizations?.[lang]);
  return units.length > 0 && units.every(
    (unit) => unit?.state === "translated" && String(unit.value || "").trim() !== ""
  );
}

function walk(dir, extension, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name !== "node_modules" && name !== "i18n") walk(full, extension, out);
    } else if (extname(name) === extension) {
      out.push(full);
    }
  }
  return out;
}

function decodeDoubleQuoted(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return null; }
}

function webRuntimeKeys() {
  const keys = new Set();
  for (const file of walk("public/js", ".js")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\b(?:i18nT|t)\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      const key = decodeDoubleQuoted(match[1]);
      if (key) keys.add(key);
    }
    for (const match of source.matchAll(/\b(?:i18nT|t)\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const key = match[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      if (key) keys.add(key);
    }
    for (const match of source.matchAll(/\b(?:i18nT|t)\(\s*`([^`$]*)`/g)) {
      if (match[1]) keys.add(match[1]);
    }
  }
  return keys;
}

function htmlKeys() {
  const keys = new Set();
  const attrs = ["placeholder", "title", "aria-label", "alt"];
  for (const name of readdirSync("public").filter((value) => value.endsWith(".html"))) {
    const raw = readFileSync(join("public", name), "utf8");
    if (!/\sdata-i18n(?:\s|>|=)/.test(raw)) continue;
    const title = raw.match(/<title>([^<]+)<\/title>/i);
    if (title?.[1]?.trim()) keys.add(title[1].trim());
    const html = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "");
    for (const match of html.matchAll(/<([a-z][a-z0-9]*)((?:\s[^<>]*)?)>([^<>]+)<\/\1>/gi)) {
      if (/\sdata-i18n(?:\s|>|$)/.test(`<x${match[2]}>`) && match[3].trim()) keys.add(match[3].trim());
    }
    for (const tag of html.matchAll(/<[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi)) {
      const declaration = tag[0].match(/data-i18n-attr="([^"]*)"/);
      if (!declaration) continue;
      for (const attr of declaration[1].split(",").map((value) => value.trim())) {
        if (!attrs.includes(attr)) continue;
        const value = tag[0].match(new RegExp(`\\s${attr}="([^"]*)"`))?.[1]?.trim();
        if (value) keys.add(value);
      }
    }
  }
  return keys;
}

function dictionaryKeys(path) {
  if (!existsSync(path)) return new Set();
  const source = readFileSync(path, "utf8");
  const keys = new Set();
  for (const match of source.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)) {
    const key = decodeDoubleQuoted(match[1]);
    if (key) keys.add(key);
  }
  return keys;
}

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
const catalogEntries = Object.entries(catalog.strings || {}).filter(([, entry]) => entry?.shouldTranslate !== false);
const missingIOS = catalogEntries.filter(([, entry]) => !isTranslated(entry)).map(([key]) => key).sort();

const runtimeKeys = webRuntimeKeys();
const markupKeys = htmlKeys();
const expectedWeb = new Set([...runtimeKeys, ...markupKeys]);
const availableWeb = dictionaryKeys(WEB_DICTIONARY);
const missingWeb = [...expectedWeb].filter((key) => !availableWeb.has(key)).sort((a, b) => a.localeCompare(b, "it"));

const iosDone = catalogEntries.length - missingIOS.length;
const webDone = expectedWeb.size - missingWeb.length;
const percent = (done, total) => total ? ((done / total) * 100).toFixed(1).replace(".0", "") : "100";

console.log(`Copertura i18n — ${lang}\n`);
console.log(`  iOS catalogo : ${iosDone}/${catalogEntries.length} (${percent(iosDone, catalogEntries.length)}%)`);
console.log(`  Web runtime  : ${runtimeKeys.size} chiavi usate`);
console.log(`  Web markup   : ${markupKeys.size} chiavi marcate`);
console.log(`  Web totale   : ${webDone}/${expectedWeb.size} (${percent(webDone, expectedWeb.size)}%)`);

if (missingIOS.length) {
  console.log(`\n  iOS senza ${lang} (${missingIOS.length}):`);
  for (const key of missingIOS.slice(0, 30)) console.log(`    ${key}`);
  if (missingIOS.length > 30) console.log(`    … e altre ${missingIOS.length - 30}`);
}
if (missingWeb.length) {
  console.log(`\n  Web senza ${lang} (${missingWeb.length}):`);
  for (const key of missingWeb.slice(0, 30)) console.log(`    ${key}`);
  if (missingWeb.length > 30) console.log(`    … e altre ${missingWeb.length - 30}`);
}

if (gate && (missingIOS.length || missingWeb.length || !existsSync(WEB_DICTIONARY))) {
  console.error(`\n✖ ${lang} non è completa: gate di rilascio fallito.`);
  process.exit(1);
}
if (gate) console.log(`\n✓ ${lang} completa nelle superfici iOS e web indicizzate.`);
