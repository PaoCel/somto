#!/usr/bin/env node
/**
 * Publish or draft an official Somto update.
 *
 * Examples:
 *   node functions/scripts/publish-official-update.cjs \
 *     --slug stranger-things-5-data \
 *     --title "Stranger Things 5 ha una data" \
 *     --body ./article.txt \
 *     --titleIds stranger-things-2016 \
 *     --updateType release_date \
 *     --dry-run
 *
 *   node functions/scripts/publish-official-update.cjs ... --publish
 *
 *   # bozza programmata (la pubblica lo scheduler quando scatta l'ora):
 *   node functions/scripts/publish-official-update.cjs ... \
 *     --status draft --scheduled-at 2026-07-29T10:00:00+02:00 --publish
 */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { publishOfficialUpdate } = require("../lib/officialUpdates");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readBody(args) {
  if (args.body) {
    const bodyPath = path.resolve(process.cwd(), String(args.body));
    if (!fs.existsSync(bodyPath)) throw new Error(`body file non trovato: ${bodyPath}`);
    return fs.readFileSync(bodyPath, "utf8");
  }
  if (args.text) return String(args.text);
  throw new Error("--body path oppure --text obbligatorio");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.title) throw new Error("--title obbligatorio");
  if (!args.titleIds && !args.linkedTitleIds) throw new Error("--titleIds obbligatorio");

  const dryRun = args["dry-run"] === true || args.dryRun === true || args.publish !== true;
  const status = String(args.status || "").trim() || (args.draft ? "draft" : "published");

  admin.initializeApp({ projectId: String(args.project || process.env.GCLOUD_PROJECT || "gia-visto") });
  const db = admin.firestore();

  const result = await publishOfficialUpdate({
    db,
    admin,
    dryRun,
    requestedByUid: String(args.requestedByUid || "local-script"),
    input: {
      slug: args.slug,
      title: args.title,
      text: readBody(args),
      summary: args.summary,
      updateType: args.updateType,
      status,
      // Solo con --status draft: la bozza viene pubblicata dallo scheduler
      // publishScheduledOfficialUpdates quando scatta l'orario.
      scheduledAt: args["scheduled-at"] || args.scheduledAt || undefined,
      linkedTitleIds: splitCsv(args.titleIds || args.linkedTitleIds),
      sourceUrls: splitCsv(args.sources || args.sourceUrls),
      audienceUids: splitCsv(args.audienceUids || args.testUids),
      maxAudience: args.maxAudience ? Number(args.maxAudience) : undefined,
    },
  });

  console.log(JSON.stringify(result, null, 2));
  if (dryRun) {
    console.log("\nDry-run completato. Aggiungi --publish per scrivere post/feed/notifiche.");
  } else if (status === "draft") {
    console.log(`\nBozza salvata: officialUpdates/${result.slug}`);
  } else {
    console.log(`\nPubblicato: https://somto.it/home.html?post=${encodeURIComponent(result.postId)}`);
  }
}

main().catch((err) => {
  console.error("Errore:", err?.message || err);
  process.exit(1);
});
