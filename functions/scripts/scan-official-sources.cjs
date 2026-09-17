#!/usr/bin/env node
"use strict";

const admin = require("firebase-admin");
const {
  discoverOfficialSourceUrls,
  ingestOfficialSourceUrl,
  normalizeOfficialSourceUrl,
  parseOfficialArticle,
  classifyOfficialAnnouncement,
  extractTitleHints,
  fetchOfficialSourceText,
  resolveArticleTitle,
  runOfficialSourceIngestion,
} = require("../lib/officialSourceIngestion");

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      index++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectId = String(args.project || process.env.GCLOUD_PROJECT || "gia-visto");
  admin.initializeApp({ projectId });
  const db = admin.firestore();
  const url = normalizeOfficialSourceUrl(args.url);

  if (url && args.apply !== true) {
    const article = parseOfficialArticle(await fetchOfficialSourceText(url, { articleOnly: true }), url);
    const title = await resolveArticleTitle(db, article);
    console.log(JSON.stringify({
      readOnly: true,
      article,
      updateType: classifyOfficialAnnouncement(article),
      titleHints: extractTitleHints(article),
      matchedTitle: title,
    }, null, 2));
    console.log("\nAnteprima completata. Aggiungi --apply per creare la bozza.");
    return;
  }

  if (url) {
    const result = await ingestOfficialSourceUrl({
      db,
      admin,
      url,
      allowHistorical: args["allow-historical"] === true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.apply === true) {
    const result = await runOfficialSourceIngestion({ db, admin });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const discovery = await discoverOfficialSourceUrls();
  console.log(JSON.stringify({
    readOnly: true,
    discovered: discovery.urls.length,
    errors: discovery.errors,
    latestUrls: discovery.urls.slice(0, 30),
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Errore:", err?.message || err);
  process.exit(1);
});
