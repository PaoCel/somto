#!/usr/bin/env node
/**
 * purge-tvtime-import-ratings.js
 *
 * Cancella i rating scritti da un import TV Time GDPR (`source ==
 * "import_tvtime_gdpr"`) per UN singolo utente, opzionalmente filtrati per
 * livello. Serve a rimuovere i rating SBAGLIATI prodotti dal vecchio decoder:
 * fino al 2026-07-09 il file `emotions-live-votes.csv` (che contiene le
 * EMOZIONI del film, non un voto) veniva importato come voto-stella via una
 * mappa {26..30} → es. emozione "Sad" (id 30) diventava un 10/10, "Shocked"
 * (id 28) un 7/10. Quei rating `level=title` sono corrotti e vanno rimossi;
 * i rating `level=episode` (dal file ratings-3, veri voti episodio) sono
 * legittimi e NON vanno toccati.
 *
 * SICUREZZA:
 *   - dry-run DEFAULT: senza --write stampa solo cosa cancellerebbe.
 *   - un solo utente per run (--uid obbligatorio).
 *   - --level=title|episode|season|all (default: title) → cancella SOLO quel
 *     livello. Per un utente TV Time i film corrotti sono `level=title`; usa
 *     --level=title per NON toccare i voti episodio legittimi.
 *   - tocca SOLO ratings con `source == "import_tvtime_gdpr"`: i voti dati a
 *     mano dall'utente (source assente/diverso) NON vengono toccati.
 *   - i rating level=title alimentano titles/{id}.ratingAggregate → il trigger
 *     recomputeTitleRatingAggregate applica il delta di rimozione da solo
 *     (onWrite/onDelete, O(1)) → il voto pubblico community si auto-corregge.
 *   - i rating level=episode NON entrano nell'aggregato pubblico.
 *
 * Usage (da functions/):
 *   node scripts/purge-tvtime-import-ratings.js --uid=UID                    # dry-run, level=title
 *   node scripts/purge-tvtime-import-ratings.js --uid=UID --level=all --write
 */

"use strict";

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
function getArg(flag, def = "") {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : def;
}
const ARG_UID = getArg("--uid");
const ARG_LEVEL = (getArg("--level", "title") || "title").toLowerCase();

if (!ARG_UID) {
  console.error("Manca --uid=UID. Es: node scripts/purge-tvtime-import-ratings.js --uid=abc123 [--level=title|episode|season|all] [--write]");
  process.exit(1);
}
if (!["title", "episode", "season", "all"].includes(ARG_LEVEL)) {
  console.error(`--level non valido: ${ARG_LEVEL} (title|episode|season|all)`);
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const IMPORT_SOURCE = "import_tvtime_gdpr";

async function main() {
  console.log(`[purge-tvtime-import-ratings] uid=${ARG_UID} level=${ARG_LEVEL} mode=${WRITE ? "WRITE" : "DRY-RUN"}`);

  // Un solo utente (nessun indice composito): query per uid, filtro in memoria.
  const snap = await db.collection("ratings").where("uid", "==", ARG_UID).get();
  const imported = snap.docs.filter((d) => (d.get("source") || "") === IMPORT_SOURCE);
  const toDelete = imported.filter((d) => ARG_LEVEL === "all" || (d.get("level") || "") === ARG_LEVEL);

  const byLevel = { title: 0, season: 0, episode: 0, other: 0 };
  for (const d of imported) {
    const lvl = d.get("level");
    if (lvl in byLevel) byLevel[lvl] += 1; else byLevel.other += 1;
  }

  console.log(`  rating totali utente: ${snap.size} | source=${IMPORT_SOURCE}: ${imported.length}`);
  console.log(`    tutti i livelli import -> title:${byLevel.title} season:${byLevel.season} episode:${byLevel.episode} altro:${byLevel.other}`);
  console.log(`  da cancellare (level=${ARG_LEVEL}): ${toDelete.length}`);

  if (toDelete.length === 0) { console.log("  Nulla da rimuovere."); return; }

  if (!WRITE) {
    for (const d of toDelete.slice(0, 10)) {
      console.log(`    - ${d.id} (level=${d.get("level")} rating=${d.get("rating")} titleId=${d.get("titleId")})`);
    }
    if (toDelete.length > 10) console.log(`    … e altri ${toDelete.length - 10}`);
    console.log("  DRY-RUN: nessuna scrittura. Rilancia con --write per cancellare.");
    return;
  }

  let done = 0;
  for (let i = 0; i < toDelete.length; i += 400) {
    const batch = db.batch();
    for (const d of toDelete.slice(i, i + 400)) batch.delete(d.ref);
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
    done += Math.min(400, toDelete.length - i);
    console.log(`  cancellati ${done}/${toDelete.length}`);
  }
  console.log("  Fatto. Gli aggregati pubblici si auto-correggono via trigger onDelete.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[purge-tvtime-import-ratings] errore:", err);
  process.exit(1);
});
