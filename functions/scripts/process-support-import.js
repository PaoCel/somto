/**
 * process-support-import.js — RESCUE re-import di un export TV Time GDPR caricato
 * dall'utente via la pagina di assistenza (somto.it/support-import.html → Storage
 * `supportImports/{uid}/...`). Vedi memoria di sessione support-import-rescue-page.
 *
 * Fa TUTTO ciò che il flusso automatico dovrebbe fare, ma:
 *   - senza il limite 5000 righe / payload 1MB (legge i CSV in memoria, non da doc
 *     Firestore) → gestisce librerie grandi (vedi task 5000-row/1MB);
 *   - con la mappa voti CORRETTA per-file (ep_3level Wow=10/Good=7/Meh=5; i film
 *     hanno un namespace id non confermato → SKIP contati; vedi task VOTE_SCALES);
 *   - con il RECUPERO watchlist serie (le serie solo "seguite", is_followed ma non
 *     is_for_later, che il parser deployato scarta; vedi task watchlist).
 *
 * È un rescue tool admin: gira in locale con ADC + TMDB_KEY dal .env. DRY-RUN di
 * default. Prima di --write, LEGGERE il report a secco.
 *
 *   cd functions && set -a; . ./.env; set +a
 *   NODE_PATH="$(pwd)/node_modules" GOOGLE_CLOUD_PROJECT=gia-visto \
 *     node scripts/process-support-import.js --uid=UID            # dry-run
 *   ... --uid=UID --write            # scrive titleStates+proiezioni+ratings
 *   ... --uid=UID --write --delete-upload   # + cancella lo ZIP da Storage (PII)
 *
 * Flag opzionali:
 *   --derive-title-ratings   roll-up media voti episodio -> voto a livello TITOLO
 *                            (DEFAULT OFF: i voti title-level entrano nell'aggregato
 *                            pubblico della community — decisione di prodotto aperta).
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const admin = require("firebase-admin");

const F = path.resolve(__dirname, "..");
const { parseCsv } = require(F + "/lib/importAdapters/csv");
const { parseTvTimeGdprCsvs } = require(F + "/lib/importAdapters/tvTimeGdpr");
const { resolveRowMatch } = require(F + "/lib/importAdapters/matching");
const { buildImportTitleStateWrites } = require(F + "/lib/importAdapters/writeTitleStates");
const { buildNextTitleState, buildLegacyLibraryProjection, buildLegacyWatchlistProjection, isMeaningfulTitleState } = require(F + "/lib/titleStates");
const {
  parseTvTimeEpisodeVotesCsv, parseTvTimeMovieCommentsCsv, parseTvTimeEpisodeCommentsCsv, mergeVotesAndComments,
} = require(F + "/lib/importAdapters/tvTimeRatings");
const { buildTitleResolutionMap, resolveRatingWrites } = require(F + "/lib/importAdapters/tvTimeRatingsWriter");

// ── config ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const has = (k) => args.includes(`--${k}`);
const UID = arg("uid");
const WRITE = has("write");
const DELETE_UPLOAD = has("delete-upload");
const DERIVE_TITLE_RATINGS = has("derive-title-ratings");
const BUCKET = "gia-visto.firebasestorage.app";
const SOURCE = "tvtime_gdpr";
const IMPORT_OPTIONS = { countDuplicateRewatches: true, countExistingAsRewatch: false };
// Mappa voti episodi CORRETTA (scala TV Time a 3 livelli). Film esclusi.
const EP_RATING_MAP = { 3: 10, 27: 7, 29: 5 }; // Wow / Good / Meh

if (!UID) { console.error("Uso: --uid=UID [--write] [--delete-upload] [--derive-title-ratings]"); process.exit(1); }

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET);

function projPayload(base, serverTs, key) {
  const p = { ...(base || {}) };
  if (!Object.keys(p).length) return null;
  p.updatedAt = serverTs;
  if (key && !p[key]) p[key] = serverTs;
  return p;
}
async function commitInChunks(fns) {
  for (let i = 0; i < fns.length; i += 400) {
    const batch = db.batch();
    fns.slice(i, i + 400).forEach((fn) => fn(batch));
    await batch.commit();
  }
}

// Serie solo "seguite" (is_followed) senza episodi visti = watchlist "da vedere".
// Il parser deployato le scarta (emette solo se is_for_later); qui le recuperiamo.
function extractFollowedSeriesWatchlist(seriesCsv) {
  const table = parseCsv(seriesCsv || "");
  if (table.length === 0) return [];
  const h = table[0].map((c) => String(c || "").toLowerCase());
  const ci = (n) => h.indexOf(n);
  const idx = { key: ci("key"), name: ci("series_name"), sId: ci("s_id"), followed: ci("is_followed"), forLater: ci("is_for_later"), createdAt: ci("created_at") };
  if (idx.key === -1 || idx.name === -1) return [];
  const watchedSeries = new Set(); // s_id con almeno un episodio visto
  const follows = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i]; if (!r) continue;
    const key = String(r[idx.key] || "");
    const sId = idx.sId !== -1 ? Number(r[idx.sId]) || null : null;
    if (/^watch-episode-/.test(key)) { if (sId) watchedSeries.add(sId); continue; }
    if (/^user-series-/.test(key)) {
      const followed = String(r[idx.followed] || "").toLowerCase() === "true";
      const forLater = idx.forLater !== -1 && String(r[idx.forLater] || "").toLowerCase() === "true";
      const name = String(r[idx.name] || "").trim();
      if ((followed || forLater) && name) follows.push({ name, sId, dateRaw: idx.createdAt !== -1 ? r[idx.createdAt] : "" });
    }
  }
  // solo serie seguite SENZA episodi visti (le altre sono in-corso/finite)
  return follows.filter((f) => !(f.sId && watchedSeries.has(f.sId))).map((f) => ({
    rawTitle: f.name, kind: "tv_episode", seriesNameGuess: f.name, movieNameGuess: null,
    seasonNumber: null, episodeNumber: null, episodeNameGuess: null,
    watchedDate: new Date(), tvdbSeriesId: f.sId, releaseYear: null, runtimeMinutes: null, watchlistOnly: true,
  }));
}

async function findLatestUpload() {
  const [files] = await bucket.getFiles({ prefix: `supportImports/${UID}/` });
  if (!files.length) throw new Error(`Nessun upload in supportImports/${UID}/. Chiedi all'utente di ricaricare da somto.it/support-import.html`);
  const withTime = await Promise.all(files.map(async (f) => { const [m] = await f.getMetadata(); return { f, t: m.updated }; }));
  withTime.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return withTime[0].f;
}

(async () => {
  console.log(`[process-support-import] uid=${UID} WRITE=${WRITE} deriveTitleRatings=${DERIVE_TITLE_RATINGS}`);
  const file = await findLatestUpload();
  console.log("upload:", file.name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssi-"));
  const zipPath = path.join(tmp, "export.zip");
  await file.download({ destination: zipPath });
  const NEED = ["tracking-prod-records.csv", "tracking-prod-records-v2.csv", "ratings-3-prod-episode_votes.csv", "comments-prod-comments.csv", "episode_comment.csv"];
  try { execFileSync("unzip", ["-o", "-j", zipPath, ...NEED, "-d", tmp], { stdio: "ignore" }); } catch (_) {}
  const rd = (n) => { try { return fs.readFileSync(path.join(tmp, n), "utf8"); } catch { return ""; } };
  const moviesCsv = rd("tracking-prod-records.csv");
  const seriesCsv = rd("tracking-prod-records-v2.csv");

  // ── rows: watch history + watchlist serie recuperate ──
  const { rows: baseRows, errors } = parseTvTimeGdprCsvs({ moviesCsv, seriesCsv });
  const followedSeries = extractFollowedSeriesWatchlist(seriesCsv);
  const rows = [...baseRows, ...followedSeries];
  console.log(`rows base=${baseRows.length} +followedSeriesWatchlist=${followedSeries.length} total=${rows.length} parseErrors=${errors.length}`);

  // ── match (cache per titolo) ──
  const logicalDupCache = new Map(), resCache = new Map();
  const keyOf = (r) => [r.kind, (r.seriesNameGuess || r.movieNameGuess || r.rawTitle || "").toLowerCase(), r.tvdbSeriesId ?? "", r.releaseYear ?? ""].join("|");
  const matchResults = []; let n = 0;
  for (const row of rows) {
    const k = keyOf(row);
    let m = resCache.get(k);
    if (!m) { m = await resolveRowMatch(db, bucket, row, { logicalDupCache }).catch(() => ({ resolved: false, titleId: null })); resCache.set(k, m); }
    matchResults.push({ row, match: m });
    if (++n % 1000 === 0) console.log(`  match ${n}/${rows.length}`);
  }
  const resolved = matchResults.filter((x) => x.match?.resolved && x.match?.titleId);
  const unresolved = matchResults.filter((x) => !(x.match?.resolved && x.match?.titleId));
  console.log(`resolved=${resolved.length} unresolved=${unresolved.length}`);

  // DIAGNOSTICA: film watchlist non risolti (per capire il bug matching film)
  const wlMoviesUnres = unresolved.filter((x) => x.row.kind === "movie" && x.row.watchlistOnly).map((x) => x.row.movieNameGuess + (x.row.releaseYear ? ` (${x.row.releaseYear})` : " [NO YEAR]"));
  console.log(`\nFILM watchlist NON risolti: ${wlMoviesUnres.length}`);
  console.log(wlMoviesUnres.slice(0, 40).join("\n"));

  // ── split watched vs watchlist-only (mirror finalizeImportResults) ──
  const all = resolved.map(({ row, match }) => ({ titleId: match.titleId, title: match.title, row }));
  const wlRaw = all.filter((r) => r.row.watchlistOnly === true);
  const watched = all.filter((r) => r.row.watchlistOnly !== true);
  const watchedIds = new Set(watched.map((r) => r.titleId));
  const wlOnly = wlRaw.filter((r) => !watchedIds.has(r.titleId));
  console.log(`\nwatched rows=${watched.length} (titles=${watchedIds.size})  watchlistOnly titles=${new Set(wlOnly.map((r) => r.titleId)).size}`);

  // ── ratings (episodi, mappa corretta; film esclusi) ──
  const { votes: epVotesRaw } = parseTvTimeEpisodeVotesCsv(rd("ratings-3-prod-episode_votes.csv"));
  const epVotes = epVotesRaw.map((v) => ({ ...v, decimalRating: EP_RATING_MAP[v.voteOptionId] ?? null })).filter((v) => v.decimalRating != null);
  const { comments: mComments } = parseTvTimeMovieCommentsCsv(rd("comments-prod-comments.csv"));
  const { comments: eComments } = parseTvTimeEpisodeCommentsCsv(rd("episode_comment.csv"));
  const { intents } = mergeVotesAndComments(epVotes, [...mComments, ...eComments]);
  const titleResolutionMap = buildTitleResolutionMap(matchResults);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const { writes: ratingWrites } = resolveRatingWrites({ uid: UID, intents, titleResolutionMap, now });
  console.log(`\nepisode ratings mapped=${epVotes.length} -> writes=${ratingWrites.length} (withReview=${ratingWrites.filter((w) => w.payload.reviewText).length})`);

  if (!WRITE) { console.log("\n(DRY-RUN — niente scritture. Rilancia con --write)"); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }

  // ── WRITE titleStates + proiezioni ──
  const userRef = db.collection("users").doc(UID);
  const uniq = Array.from(new Set([...watched.map((r) => r.titleId), ...wlOnly.map((r) => r.titleId)]));
  const cur = new Map();
  for (let i = 0; i < uniq.length; i += 10) {
    const chunk = uniq.slice(i, i + 10);
    const snaps = await Promise.all(chunk.map((id) => userRef.collection("titleStates").doc(id).get()));
    snaps.forEach((s, j) => cur.set(chunk[j], s.exists ? s.data() : null));
  }
  const tsWrites = buildImportTitleStateWrites(watched, cur, { now: new Date(), ...IMPORT_OPTIONS });
  const wlByTitle = new Map();
  for (const { titleId, title } of wlOnly) {
    if (wlByTitle.has(titleId)) continue;
    wlByTitle.set(titleId, buildNextTitleState(cur.get(titleId) || null, { type: "toggle_watchlist", enabled: true, source: `import_${SOURCE}` }, { ...(title || {}), id: titleId }, { now: new Date() }));
  }
  const fns = [];
  const applyState = (titleId, next) => {
    fns.push((b) => b.set(userRef.collection("titleStates").doc(titleId), next, { merge: true }));
    if (isMeaningfulTitleState(next)) {
      const lib = projPayload(buildLegacyLibraryProjection(next), admin.firestore.FieldValue.serverTimestamp(), "createdAt");
      const wl = projPayload(buildLegacyWatchlistProjection(next), admin.firestore.FieldValue.serverTimestamp(), "addedAt");
      if (lib) fns.push((b) => b.set(userRef.collection("library").doc(titleId), lib, { merge: true }));
      if (wl) fns.push((b) => b.set(userRef.collection("watchlist").doc(titleId), wl, { merge: true }));
    }
  };
  tsWrites.forEach(({ titleId, next }) => applyState(titleId, next));
  wlByTitle.forEach((next, titleId) => applyState(titleId, next));
  await commitInChunks(fns);
  console.log(`✅ titleStates+proiezioni: ${tsWrites.length} watched + ${wlByTitle.size} watchlist.`);

  // ── WRITE ratings (episodi) — rimpiazza SOLO i voti a livello episodio ──
  // Cancella solo i vecchi voti `level==episode` (che questo adapter riscrive
  // da capo): i voti a livello titolo/film NON sono prodotti dall'adapter
  // episodi, quindi vanno PRESERVATI (altrimenti un re-import distruggerebbe i
  // voti sui film dell'utente — bug scoperto su Faberillo 2026-07-08).
  const old = await db.collection("ratings").where("uid", "==", UID).get();
  const oldEpisode = old.docs.filter((d) => String((d.data() || {}).level || "") === "episode");
  const preserved = old.size - oldEpisode.length;
  await commitInChunks(oldEpisode.map((d) => (b) => b.delete(d.ref)));
  await commitInChunks(ratingWrites.map(({ ratingId, payload }) => (b) => b.set(db.collection("ratings").doc(ratingId), payload, { merge: true })));
  console.log(`✅ ratings: cancellati ${oldEpisode.length} (episodio), preservati ${preserved} (titolo/film), scritti ${ratingWrites.length}.`);

  // ── (opzionale) roll-up voto a livello titolo (media episodi per serie) ──
  if (DERIVE_TITLE_RATINGS) {
    const byTitle = new Map();
    ratingWrites.forEach((w) => { const t = w.titleId; if (!byTitle.has(t)) byTitle.set(t, []); byTitle.get(t).push(w.payload.rating); });
    const { makeRatingId } = require(F + "/lib/importAdapters/tvTimeRatingsWriter"); // se esportato; altrimenti costruisci id title
    const titleFns = [];
    byTitle.forEach((vals, titleId) => {
      const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      const ratingId = typeof makeRatingId === "function" ? makeRatingId({ uid: UID, titleId, level: "title", season: null, episode: null }) : `${UID}__${titleId}__title__0__0`;
      titleFns.push((b) => b.set(db.collection("ratings").doc(ratingId), { uid: UID, titleId, level: "title", season: null, episode: null, rating: avg, source: "import_tvtime_gdpr", createdAt: now, updatedAt: now }, { merge: true }));
    });
    await commitInChunks(titleFns);
    console.log(`✅ roll-up: ${titleFns.length} voti a livello titolo (media episodi). NB entrano nell'aggregato pubblico.`);
  }

  if (DELETE_UPLOAD) { await file.delete().catch(() => {}); console.log("🗑  upload cancellato da Storage (PII)."); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nFatto.");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
