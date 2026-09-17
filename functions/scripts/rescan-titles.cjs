#!/usr/bin/env node
/**
 * Scansione TMDB mirata di uno o piu' titoli, con scrittura degli eventi.
 *
 * PERCHE' ESISTE — lo scanner schedulato gira il catalogo a cursore: quando
 * esce qualcosa di grosso su un titolo appena superato dal cursore, il ritardo
 * puo' essere di ore. La corsia prioritaria in `modules/titleUpdates.js` copre
 * il caso generale; questo script copre quello singolo e urgente ("il teaser e'
 * uscito adesso, non aspetto il giro").
 *
 * Usa la STESSA funzione dello scheduler (`runScheduledTitleUpdateScan` con
 * `titleIds`), quindi valgono le stesse regole: live/backfill, finestre,
 * notificabilita'. Non tocca il cursore del giro tondo.
 *
 * Esempi:
 *   node scripts/rescan-titles.cjs --project gia-visto --title-id tmdb_tv_224377
 *   node scripts/rescan-titles.cjs --project somto-staging --title-id a --title-id b
 */

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const admin = require("firebase-admin");
const { runScheduledTitleUpdateScan } = require("../modules/titleUpdates");

const args = yargs(hideBin(process.argv))
  .strict()
  .option("project", { type: "string", default: "somto-staging", describe: "Firebase project" })
  .option("title-id", { type: "array", string: true, default: [], describe: "Document ID dei titoli da riscansionare" })
  .help()
  .parseSync();

async function main() {
  const titleIds = args.titleId.map((value) => String(value).trim()).filter(Boolean);
  if (!titleIds.length) throw new Error("Serve almeno un --title-id");
  if (titleIds.length > 20) throw new Error("Massimo 20 titoli per giro: usa lo scheduler");

  const projectId = String(args.project || "somto-staging").trim();
  admin.initializeApp({ projectId });
  const db = admin.firestore();

  const report = await runScheduledTitleUpdateScan({
    db,
    admin,
    logger: { info: (message, payload) => console.error(message, JSON.stringify(payload || {})) },
    titleIds,
  });
  console.log(JSON.stringify({ projectId, titleIds, report }, null, 1));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
