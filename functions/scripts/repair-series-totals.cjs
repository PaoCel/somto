#!/usr/bin/env node
/**
 * repair-series-totals.cjs
 *
 * Riparazione una-tantum per le serie TV senza totali episodio in `meta`
 * (nessuna riga `meta.seasons`, `episodesPerSeason` nullo), tipicamente i
 * titoli creati da ricerca TMDB con la sola `seasonsCount`.
 *
 * Effetto del difetto (2026-08-19, "Muertos S.r.l."): `estimateTitleTotals`
 * restituisce `totalEpisodeCount: null`, quindi ogni "+1 episodio" scriveva un
 * progresso senza stagione, con percentuale 0. Sulla scheda titolo la card
 * restava identica e il foglio post-episodio non si apriva: sembrava che il
 * tasto non funzionasse.
 *
 * Cosa fa:
 *   1. per ogni serie senza totali, scarica /tv/{tmdbId} e riscrive i campi
 *      meta di durata/episodi con lo stesso builder usato dalle functions
 *      (lib/tmdbDurations.js), quindi nessuna logica duplicata;
 *   2. per gli utenti che hanno gia' un progresso su quei titoli, ricalcola
 *      le coordinate S·E e la percentuale dal contatore episodi.
 *
 * Non cambia MAI lo stato di visione: se il contatore risulta >= al totale
 * appena scoperto, lo segnala e basta (completare una serie e' una decisione
 * dell'utente, non di uno script).
 *
 * Uso (serve ADC o GOOGLE_APPLICATION_CREDENTIALS su gia-visto):
 *   cd functions
 *   node scripts/repair-series-totals.cjs                      # dry-run su tutte
 *   node scripts/repair-series-totals.cjs --write
 *   node scripts/repair-series-totals.cjs --title tmdb_tv_237964 --write
 */

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { estimateTitleTotals, locateSeriesPosition } = require("../lib/titleStates");
const { buildTitleDurationMetaPatch } = require("../lib/tmdbDurations");
const fs = require("node:fs");
const path = require("node:path");

// functions/.env non e' un modulo: qui basta leggere la chiave TMDB.
function readEnvKey(name) {
  if (process.env[name]) return String(process.env[name]).trim();
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const line = raw.split(/\r?\n/).find((row) => row.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

const WRITE = process.argv.includes("--write");
const ONLY_TITLE = (() => {
  const idx = process.argv.indexOf("--title");
  return idx >= 0 ? String(process.argv[idx + 1] || "").trim() : "";
})();
const TMDB_KEY = readEnvKey("TMDB_KEY");

initializeApp();
const db = getFirestore();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTmdbSeries(tmdbId) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=it-IT`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} su /tv/${tmdbId}`);
  return res.json();
}

function needsRepair(title) {
  if (String(title?.type || "").toLowerCase() !== "tv") return false;
  return !(estimateTitleTotals(title).totalEpisodeCount > 0);
}

/** Coordinate + percentuale ricalcolate dal solo contatore episodi. */
function repairedProgress(progress, totals) {
  const watched = Number(progress?.episodesWatchedCount || 0);
  const located = locateSeriesPosition(watched, totals);
  const next = {
    ...progress,
    totalEpisodeCount: totals.totalEpisodeCount,
    totalSeasonCount: totals.totalSeasonCount,
  };
  if (located) {
    next.lastWatchedSeasonNumber = located.season || null;
    next.lastWatchedEpisodeNumber = located.episode || null;
    next.lastWatchedEpisodeId = located.season && located.episode
      ? `s${located.season}e${located.episode}`
      : null;
    next.lastWatchedEpisodeName = located.season && located.episode
      ? `S${located.season} · E${located.episode}`
      : null;
    next.seasonsCompletedCount = Math.max(
      Number(progress?.seasonsCompletedCount || 0),
      located.seasonsCompleted
    );
  }
  next.percentComplete = totals.totalEpisodeCount
    ? Math.max(0, Math.min(1, watched / totals.totalEpisodeCount))
    : next.percentComplete ?? null;
  return next;
}

async function repairStatesFor(titleId, totals, report) {
  const snap = await db.collectionGroup("titleStates").where("titleId", "==", titleId).get();
  for (const doc of snap.docs) {
    const state = doc.data() || {};
    if (String(state.mediaType || "") !== "tv") continue;
    const progress = state.seriesProgress || {};
    const watched = Number(progress.episodesWatchedCount || 0);
    if (watched <= 0) continue;

    if (totals.totalEpisodeCount && watched >= totals.totalEpisodeCount) {
      report.skippedComplete.push(`${doc.ref.path} (${watched}/${totals.totalEpisodeCount})`);
      continue;
    }

    const next = repairedProgress(progress, totals);
    report.states.push(
      `${doc.ref.path}: ${watched} ep → S${next.lastWatchedSeasonNumber ?? "?"}·E${next.lastWatchedEpisodeNumber ?? "?"}`
      + `, ${Math.round((next.percentComplete || 0) * 100)}%`
    );
    if (WRITE) {
      await doc.ref.set({ seriesProgress: next }, { merge: true });
    }
  }
}

async function main() {
  if (!TMDB_KEY) {
    console.error("TMDB_KEY mancante (functions/.env).");
    process.exit(1);
  }

  const docs = ONLY_TITLE
    ? [await db.collection("titles").doc(ONLY_TITLE).get()]
    : (await db.collection("titles").where("type", "==", "tv").get()).docs;

  const report = { titles: [], states: [], skippedComplete: [], failures: [] };
  let scanned = 0;

  for (const doc of docs) {
    if (!doc.exists) continue;
    scanned += 1;
    const title = { id: doc.id, ...(doc.data() || {}) };
    if (!needsRepair(title)) continue;

    // Molti doc storici non hanno `meta.tmdbId` ma l'id lo espone comunque
    // ("tmdb_tv_237964"): senza questo fallback resterebbero fuori 1170 serie.
    const tmdbId = Number(title?.meta?.tmdbId || 0)
      || Number(/^tmdb_tv_(\d+)$/.exec(doc.id)?.[1] || 0);
    if (!tmdbId) {
      report.failures.push(`${doc.id}: nessun tmdbId`);
      continue;
    }

    try {
      const details = await fetchTmdbSeries(tmdbId);
      const { nextMeta, changedFields } = buildTitleDurationMetaPatch(title.meta || {}, details, "tv");
      if (!changedFields.length) {
        report.failures.push(`${doc.id}: TMDB non espone stagioni utilizzabili`);
        continue;
      }

      const totals = estimateTitleTotals({ ...title, meta: nextMeta });
      report.titles.push(
        `${doc.id} "${title.name}": ${changedFields.join(", ")}`
        + ` → ${totals.totalEpisodeCount} ep / ${totals.totalSeasonCount} stagioni`
      );
      if (WRITE) {
        await doc.ref.set({ meta: nextMeta }, { merge: true });
      }
      await repairStatesFor(doc.id, totals, report);
      await sleep(120);
    } catch (err) {
      report.failures.push(`${doc.id}: ${err.message}`);
    }
  }

  console.log(`\nSerie esaminate: ${scanned}${WRITE ? "" : "  (DRY-RUN, nessuna scrittura)"}`);
  console.log(`\nTitoli riparati (${report.titles.length}):`);
  report.titles.forEach((row) => console.log(`  ${row}`));
  console.log(`\nProgressi utente ricalcolati (${report.states.length}):`);
  report.states.forEach((row) => console.log(`  ${row}`));
  if (report.skippedComplete.length) {
    console.log(`\nContatore >= totale, lasciati intatti (${report.skippedComplete.length}):`);
    report.skippedComplete.forEach((row) => console.log(`  ${row}`));
  }
  if (report.failures.length) {
    console.log(`\nNon riparabili (${report.failures.length}):`);
    report.failures.forEach((row) => console.log(`  ${row}`));
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
