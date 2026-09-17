#!/usr/bin/env node
/** Verifica che il registro web e l'allowlist Firestore delle lingue coincidano. */

import { existsSync, readFileSync } from "node:fs";

const registryPath = "public/js/i18n/locales.js";
const registry = readFileSync(registryPath, "utf8");
const codes = [...registry.matchAll(/\{\s*code:\s*"([a-z]{2,3})"/g)].map((match) => match[1]);
const uniqueCodes = [...new Set(codes)];
const errors = [];

if (!uniqueCodes.includes("it")) errors.push("il registro deve includere la lingua sorgente it");
if (uniqueCodes.length !== codes.length) errors.push("codici lingua duplicati nel registro");

for (const code of uniqueCodes) {
  const dictionary = `public/js/i18n/${code}.js`;
  if (!existsSync(dictionary)) errors.push(`dizionario mancante: ${dictionary}`);
  if (!new RegExp(`from\\s+"\\./${code}\\.js"`).test(registry)) {
    errors.push(`import mancante per ${code} in ${registryPath}`);
  }
  if (code !== "it" && !existsSync(`ios/TwoWatch/Resources/${code}.lproj/InfoPlist.strings`)) {
    errors.push(`privacy iOS mancante: ios/TwoWatch/Resources/${code}.lproj/InfoPlist.strings`);
  }
}

const rules = readFileSync("firestore.rules", "utf8");
const allowlist = rules.match(/request\.resource\.data\.language\s+in\s+\[([^\]]+)\]/)?.[1] || "";
const ruleCodes = [...allowlist.matchAll(/['"]([a-z]{2,3})['"]/g)].map((match) => match[1]);

const onlyRegistry = uniqueCodes.filter((code) => !ruleCodes.includes(code));
const onlyRules = ruleCodes.filter((code) => !uniqueCodes.includes(code));
if (onlyRegistry.length) errors.push(`mancano nelle Firestore Rules: ${onlyRegistry.join(", ")}`);
if (onlyRules.length) errors.push(`presenti nelle Rules ma non nel registro: ${onlyRules.join(", ")}`);

const notificationSource = readFileSync("functions/lib/notificationPresentation.js", "utf8");
const notificationList = notificationSource.match(/SUPPORTED_NOTIFICATION_LANGUAGES\s*=\s*Object\.freeze\(\[([^\]]+)\]\)/)?.[1] || "";
const notificationCodes = [...notificationList.matchAll(/["']([a-z]{2,3})["']/g)].map((match) => match[1]);
const missingPush = uniqueCodes.filter((code) => !notificationCodes.includes(code));
const extraPush = notificationCodes.filter((code) => !uniqueCodes.includes(code));
if (missingPush.length) errors.push(`copy push mancante per: ${missingPush.join(", ")}`);
if (extraPush.length) errors.push(`copy push presente ma lingua non esposta: ${extraPush.join(", ")}`);

if (errors.length) {
  console.error("✖ Configurazione lingue non allineata:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`✓ Lingue abilitate allineate: ${uniqueCodes.join(", ")}.`);
