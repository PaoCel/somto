#!/usr/bin/env node
/**
 * repair-legacy-series-episode-zero.js — Ripara le serie TV che risultano
 * viste/valutate ma con episodesWatchedCount=0 ("episodio zero"), NON causate
 * dall'import Netflix ma dalla vecchia migrazione legacy library→titleStates
 * (2026-05-17, source `legacy_watchlist_migration_v2`) e da qualche mark manuale
 * iOS: la migrazione impostava state=rated/completed + seasonsCompletedCount ma
 * lasciava episodesWatchedCount=0.
 *
 * REGOLE (mai regressione — tocca solo serie con ep=0):
 *  - state rated / completed_unrated: la serie è finita → episodesWatchedCount =
 *    totale episodi TMDB, seasonsCompletedCount = totale stagioni. I minuti per le
 *    serie completate NON dipendono da episodesWatchedCount (si calcolano sul full
 *    run) quindi restano invariati: è un fix di display.
 *  - state in_progress con seasonsCompletedCount>0: deriva episodesWatchedCount =
 *    seasonsCompletedCount × episodi-per-stagione (cap al totale) e RICALCOLA i
 *    minuti (questi erano sotto-contati, spesso 0).
 *  - in_progress con seasonsCompletedCount=0: nessun segnale → lasciata com'è.
 *  - titoli senza totale episodi TMDB: saltati (loggati), non inventiamo numeri.
 *
 * Dopo --write rilanciare: node scripts/recompute-user-stats.js --write
 *
 * Uso:
 *   cd functions
 *   node scripts/repair-legacy-series-episode-zero.js            # dry-run
 *   node scripts/repair-legacy-series-episode-zero.js --uid=UID  # un utente
 *   node scripts/repair-legacy-series-episode-zero.js --write    # applica
 */
"use strict";

const admin = require("firebase-admin");
const {
  estimateTitleTotals,
  computeWatchMinutesContribution,
  buildLegacyLibraryProjection,
  buildLegacyWatchlistProjection,
  isMeaningfulTitleState,
} = require("../lib/titleStates");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ONLY_UID = (args.find((a) => a.startsWith("--uid=")) || "").split("=")[1] || null;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const REPAIR_STATES = new Set(["rated", "completed_unrated", "in_progress"]);

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function buildProjectionPayload(basePayload, serverTimestampField, timestampKey) {
  const payload = { ...(basePayload || {}) };
  if (!payload || !Object.keys(payload).length) return null;
  payload.updatedAt = serverTimestampField;
  if (timestampKey && !payload[timestampKey]) payload[timestampKey] = serverTimestampField;
  return payload;
}

async function loadTitles(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    // eslint-disable-next-line no-await-in-loop
    const snaps = await Promise.all(chunk.map((id) => db.collection("titles").doc(id).get()));
    snaps.forEach((snap, idx) => { if (snap.exists) map.set(chunk[idx], snap.data() || {}); });
  }
  return map;
}

// Returns the repaired seriesProgress + minutes, or null if nothing to do / can't
// determine. Never lowers anything.
function planRepair(state, title, titleId) {
  const sp = state.seriesProgress;
  if (!sp || toPositiveInt(sp.episodesWatchedCount) > 0) return null;
  const totals = estimateTitleTotals({ ...title, id: titleId });
  const totalEp = toPositiveInt(totals.totalEpisodeCount);
  const totalSeas = toPositiveInt(totals.totalSeasonCount);
  const seasonsDone = toPositiveInt(sp.seasonsCompletedCount);

  const prevMinutes = toPositiveInt(state.watchMinutesContribution);
  let nextEp = 0;
  let nextSeasons = seasonsDone;
  // Completed/rated series: the watch-minutes are already stored and were
  // computed on the FULL RUN at completion time (independent of
  // episodesWatchedCount). Re-deriving them from CURRENT TMDB totals could
  // silently change a user's hours (e.g. Friends dropping ~270h), so we ONLY
  // fill the missing episode/season display and KEEP the stored minutes.
  const recomputeMinutes = state.state === "in_progress";
  if (state.state === "rated" || state.state === "completed_unrated") {
    if (!totalEp) return { skip: "no_total_episodes" };
    nextEp = totalEp;
    nextSeasons = totalSeas || seasonsDone;
  } else {
    // in_progress: episodes were under-counted (often 0) → derive from the
    // completed seasons and recompute minutes.
    if (seasonsDone <= 0) return null;
    const epPerSeason = toPositiveInt(totals.episodesPerSeason)
      || (totalEp && totalSeas ? Math.round(totalEp / totalSeas) : 0);
    if (!epPerSeason) return { skip: "no_episodes_per_season" };
    nextEp = epPerSeason * seasonsDone;
    if (totalEp) nextEp = Math.min(totalEp, nextEp);
  }
  if (nextEp <= 0) return null;

  const nextProgress = {
    ...sp,
    episodesWatchedCount: nextEp,
    seasonsCompletedCount: nextSeasons,
    totalEpisodeCount: totalEp || toPositiveInt(sp.totalEpisodeCount),
    totalSeasonCount: totalSeas || toPositiveInt(sp.totalSeasonCount),
    percentComplete: totalEp ? Math.min(1, nextEp / totalEp) : sp.percentComplete,
  };
  const nextState = { ...state, seriesProgress: nextProgress };
  const nextMinutes = recomputeMinutes
    ? computeWatchMinutesContribution({ ...title, id: titleId }, nextState)
    : prevMinutes;
  nextState.watchMinutesContribution = nextMinutes;
  return { nextState, nextProgress, nextMinutes, prevMinutes, minutesChanged: nextMinutes !== prevMinutes };
}

async function repairUser(uid) {
  const userRef = db.collection("users").doc(uid);
  const user = (await userRef.get()).data() || {};
  const ts = await userRef.collection("titleStates").where("mediaType", "==", "tv").get();
  const candidates = [];
  ts.forEach((d) => {
    const s = d.data();
    const sp = s.seriesProgress;
    if (!sp) return;
    if (toPositiveInt(sp.episodesWatchedCount) > 0) return;
    if (!REPAIR_STATES.has(s.state)) return;
    candidates.push({ id: d.id, state: s });
  });
  if (!candidates.length) return { uid, planned: 0, wrote: 0, skipped: 0 };

  const titleById = await loadTitles(candidates.map((c) => c.id));
  const plan = [];
  const skips = [];
  for (const c of candidates) {
    const title = titleById.get(c.id) || {};
    const r = planRepair(c.state, title, c.id);
    if (!r) continue;
    if (r.skip) { skips.push({ id: c.id, name: title.name || c.id, reason: r.skip, state: c.state.state }); continue; }
    plan.push({ id: c.id, name: title.name || c.id, from: `${c.state.state}/ep0/min${r.prevMinutes}`, to: `${c.state.state}/ep${r.nextProgress.episodesWatchedCount}/min${r.nextMinutes}`, next: r.nextState });
  }

  console.log(`\n== ${user.displayName || uid} (${uid}) — ${plan.length} da correggere, ${skips.length} saltate`);
  plan.slice(0, 10).forEach((p) => console.log(`   ${p.name}: ${p.from} -> ${p.to}`));
  if (plan.length > 10) console.log(`   … +${plan.length - 10}`);
  skips.forEach((s) => console.log(`   [skip ${s.reason}] ${s.name} (${s.state})`));

  if (!WRITE || !plan.length) return { uid, planned: plan.length, wrote: 0, skipped: skips.length };

  const writeFns = [];
  for (const p of plan) {
    const stateRef = userRef.collection("titleStates").doc(p.id);
    // patch surgicale: solo i campi ricalcolati (merge preserva il resto)
    writeFns.push((batch) => batch.set(stateRef, {
      seriesProgress: p.next.seriesProgress,
      watchMinutesContribution: p.next.watchMinutesContribution,
    }, { merge: true }));
    if (isMeaningfulTitleState(p.next)) {
      const lib = buildProjectionPayload(buildLegacyLibraryProjection(p.next), FieldValue.serverTimestamp(), "createdAt");
      const wl = buildProjectionPayload(buildLegacyWatchlistProjection(p.next), FieldValue.serverTimestamp(), "addedAt");
      if (lib) writeFns.push((batch) => batch.set(userRef.collection("library").doc(p.id), lib, { merge: true }));
      if (wl) writeFns.push((batch) => batch.set(userRef.collection("watchlist").doc(p.id), wl, { merge: true }));
    }
  }
  for (let i = 0; i < writeFns.length; i += 200) {
    const batch = db.batch();
    writeFns.slice(i, i + 200).forEach((fn) => fn(batch));
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
  console.log(`   ✔ scritte ${plan.length} serie.`);
  return { uid, planned: plan.length, wrote: plan.length, skipped: skips.length };
}

(async () => {
  let uids;
  if (ONLY_UID) {
    uids = [ONLY_UID];
  } else {
    const usersSnap = await db.collection("users").get();
    uids = usersSnap.docs.map((d) => d.id);
  }
  console.log(`Modalità: ${WRITE ? "WRITE" : "DRY-RUN"} — utenti da scansionare: ${uids.length}`);
  let planned = 0, wrote = 0, skipped = 0, touchedUsers = 0;
  for (const uid of uids) {
    // eslint-disable-next-line no-await-in-loop
    const r = await repairUser(uid);
    planned += r.planned; wrote += r.wrote; skipped += r.skipped;
    if (r.planned > 0) touchedUsers += 1;
  }
  console.log(`\n===== ${WRITE ? "SCRITTE" : "DA CORREGGERE"}: ${WRITE ? wrote : planned} serie su ${touchedUsers} utenti | saltate: ${skipped} =====`);
  if (WRITE) console.log("Ora esegui: node scripts/recompute-user-stats.js --write");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
