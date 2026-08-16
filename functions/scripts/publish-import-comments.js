#!/usr/bin/env node
/**
 * publish-import-comments.js
 *
 * Ops tool per la RIPUBBLICAZIONE dei commenti-episodio TV Time come discussioni
 * Somto (vedi CLAUDE.md "TV Time comment republish"). Serve sia per i 6 utenti
 * già contattati (import PRIMA di questo codice → nessuna coda review scritta),
 * sia per rivedere/pubblicare code create dal nuovo flusso.
 *
 * Quattro modi (dry-run DEFAULT, --write per applicare):
 *   --build        (ri)costruisce la coda review da commentArchive/{uid}/{importId}/
 *                  episode_comments.csv (fallback: storagePaths.episodeComments
 *                  dell'import), risolvendo i titleId dagli `items` dell'import.
 *                  Scrive importCommentReview/{uid}__{importId}/comments/*.
 *   --support-zip  come --build ma legge lo ZIP grezzo caricato dall'utente su
 *                  somto.it/support-import.html (Storage supportImports/{uid}/…):
 *                  estrae episode_comment.csv + la CSV serie, risolve i titleId
 *                  col matcher (per-nome + tvdbSeriesId), e scrive la coda con
 *                  un importId sintetico `support_<zip>` (stampato a video).
 *                  Utile quando l'app del client NON ha caricato i commenti
 *                  (build vecchia o export via UI): recuperiamo lato server.
 *   --list         stampa i candidati + conteggi per un import (nessuna scrittura).
 *   --publish      pubblica i candidati sui thread episodio pubblici. Di default
 *                  pubblica solo quelli status=="approved"; --approve-all pubblica
 *                  tutti i pending risolti; --only=id1,id2 restringe a quei doc.
 *
 * SICUREZZA: scrive dati PUBBLICI a nome utente → usare SOLO dopo consenso +
 * revisione. Idempotente (id messaggio deterministico + guard `published`).
 *
 * Usage (da functions/):
 *   node scripts/publish-import-comments.js --uid=UID --import=IMPORT_ID --build           # dry-run
 *   node scripts/publish-import-comments.js --uid=UID --import=IMPORT_ID --build --write
 *   # rescue da zip support (--import derivato dallo zip, stampato):
 *   ( set -a; . ./.env; set +a; \
 *     node scripts/publish-import-comments.js --uid=UID --support-zip )                    # dry-run
 *   ( set -a; . ./.env; set +a; \
 *     node scripts/publish-import-comments.js --uid=UID --support-zip --write )
 *   node scripts/publish-import-comments.js --uid=UID --import=IMPORT_ID --list
 *   node scripts/publish-import-comments.js --uid=UID --import=IMPORT_ID --publish --approve-all         # dry-run
 *   node scripts/publish-import-comments.js --uid=UID --import=IMPORT_ID --publish --approve-all --write
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const admin = require("firebase-admin");
const { parseTvTimeEpisodeCommentsCsv } = require("../lib/importAdapters/tvTimeRatings");
const { parseCsv } = require("../lib/importAdapters/csv");
const { resolveRowMatch } = require("../lib/importAdapters/matching");
const {
  selectPublishableEpisodeComments,
  episodeCommentMessageId,
  buildReviewCandidate,
  buildThreadMessage,
} = require("../lib/importAdapters/tvTimeCommentsPublish");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const MODE_BUILD = args.includes("--build");
const MODE_SUPPORT = args.includes("--support-zip");
const MODE_LIST = args.includes("--list");
const MODE_PUBLISH = args.includes("--publish");
const APPROVE_ALL = args.includes("--approve-all");
function getArg(flag, def = "") {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : def;
}
const ARG_UID = getArg("--uid");
let ARG_IMPORT = getArg("--import"); // support-zip lo DERIVA dallo zip se assente
const ONLY = getArg("--only")
  ? new Set(getArg("--only").split(",").map((s) => s.trim()).filter(Boolean))
  : null;

const ANY_MODE = MODE_BUILD || MODE_SUPPORT || MODE_LIST || MODE_PUBLISH;
// --import è obbligatorio ovunque TRANNE --support-zip (che lo deriva dallo zip).
const NEEDS_IMPORT = MODE_BUILD || MODE_LIST || MODE_PUBLISH;
if (!ARG_UID || !ANY_MODE || (NEEDS_IMPORT && !ARG_IMPORT)) {
  console.error("Usage: node scripts/publish-import-comments.js --uid=UID [--import=IMPORT_ID] (--build | --support-zip | --list | --publish) [--approve-all] [--only=id,id] [--write]");
  process.exit(1);
}

const BUCKET = "gia-visto.firebasestorage.app";
admin.initializeApp({ projectId: "gia-visto", storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET);

function nameKey(s) { return String(s || "").trim().toLowerCase(); }

async function dl(path) {
  if (!path) return "";
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) return "";
  const [buf] = await file.download();
  return buf.toString("utf8");
}

async function loadEpisodeCommentsCsv(uid, importId) {
  // Preferred: the no-TTL archive. Fallback: the import's raw storage path.
  const archive = `commentArchive/${uid}/${importId}/episode_comments.csv`;
  const fromArchive = await dl(archive);
  if (fromArchive) return { csv: fromArchive, source: archive };
  const payloadSnap = await db.collection("users").doc(uid).collection("imports").doc(importId)
    .collection("payload").doc("raw").get();
  const sp = payloadSnap.exists ? (payloadSnap.data()?.storagePaths || {}) : {};
  if (sp.episodeComments) {
    const csv = await dl(sp.episodeComments);
    if (csv) return { csv, source: sp.episodeComments };
  }
  return { csv: "", source: null };
}

async function buildNameToTitleId(uid, importId) {
  const itemsSnap = await db.collection("users").doc(uid).collection("imports").doc(importId).collection("items").get();
  const map = new Map();
  itemsSnap.forEach((doc) => {
    const it = doc.data() || {};
    if (it.titleId && it.seriesNameGuess) {
      const k = nameKey(it.seriesNameGuess);
      if (!map.has(k)) map.set(k, it.titleId);
    }
  });
  return map;
}

async function displayNameFor(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const u = snap.data() || {};
  return (u.displayName || u.username || (u.email ? String(u.email).split("@")[0] : "") || "Utente Somto").slice(0, 80);
}

function sanitizeId(s) { return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120); }

// Trova lo ZIP più recente caricato dall'utente via support-import.html.
async function findLatestSupportUpload(uid) {
  const [files] = await bucket.getFiles({ prefix: `supportImports/${uid}/` });
  const zips = files.filter((f) => /\.zip$/i.test(f.name));
  if (!zips.length) throw new Error(`Nessuno ZIP in supportImports/${uid}/. Chiedi all'utente di caricarlo su somto.it/support-import.html`);
  const withTime = await Promise.all(zips.map(async (f) => { const [m] = await f.getMetadata(); return { f, t: m.updated }; }));
  withTime.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return withTime[0].f;
}

// name-key coerente con il matcher (trim + lowercase).
function nameKeyLc(s) { return String(s || "").trim().toLowerCase(); }

// Mappa nome-serie -> tvdbSeriesId (s_id) dalla CSV serie TV Time, così il
// match episodio parte dalla scorciatoia deterministica TMDB /find come nel
// flusso normale (non solo dal nome).
function buildSeriesTvdbMap(seriesCsv) {
  const table = parseCsv(seriesCsv || "");
  const map = new Map();
  if (table.length === 0) return map;
  const h = table[0].map((c) => nameKeyLc(c));
  const ci = (n) => h.indexOf(n);
  const iName = ci("series_name"); const iSid = ci("s_id");
  if (iName === -1 || iSid === -1) return map;
  for (let i = 1; i < table.length; i++) {
    const r = table[i]; if (!r) continue;
    const name = nameKeyLc(r[iName]); const sid = Number(r[iSid]);
    if (name && sid > 0 && !map.has(name)) map.set(name, sid);
  }
  return map;
}

async function runBuildFromSupportZip() {
  const file = await findLatestSupportUpload(ARG_UID);
  console.log(`ZIP support: ${file.name}`);
  // importId sintetico derivato dal nome dello zip (stabile → idempotente).
  const base = path.basename(file.name);
  ARG_IMPORT = ARG_IMPORT || `support_${sanitizeId(base.replace(/\.zip$/i, ""))}`;
  console.log(`importId (sintetico): ${ARG_IMPORT}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pic-"));
  const zipPath = path.join(tmp, "export.zip");
  await file.download({ destination: zipPath });
  // -j: flatten; -o: overwrite. episode_comment.csv = commenti; la CSV serie
  // serve solo per la mappa tvdbSeriesId.
  try {
    execFileSync("unzip", ["-o", "-j", zipPath, "episode_comment.csv", "tracking-prod-records-v2.csv", "-d", tmp], { stdio: "ignore" });
  } catch (_) { /* unzip esce !=0 se un file manca: gestito sotto dal read vuoto */ }
  const rd = (n) => { try { return fs.readFileSync(path.join(tmp, n), "utf8"); } catch { return ""; } };
  const commentsCsv = rd("episode_comment.csv");
  const seriesCsv = rd("tracking-prod-records-v2.csv");
  fs.rmSync(tmp, { recursive: true, force: true });

  if (!commentsCsv) {
    console.error("Lo ZIP NON contiene episode_comment.csv → nessun commento episodio da recuperare (l'utente non ne ha scritti, o l'export non lo include).");
    process.exit(2);
  }

  const { comments } = parseTvTimeEpisodeCommentsCsv(commentsCsv);
  const { counts, eligible } = selectPublishableEpisodeComments(comments);
  const tvdbByName = buildSeriesTvdbMap(seriesCsv);

  // Risolvi i titleId col matcher, una volta per nome-serie (cache).
  const resolvedCache = new Map();
  let resolved = 0;
  const candidates = [];
  for (const c of eligible) {
    const nk = nameKeyLc(c.seriesNameGuess);
    let titleId = resolvedCache.get(nk);
    if (titleId === undefined) {
      const row = { kind: "tv_episode", seriesNameGuess: c.seriesNameGuess, tvdbSeriesId: tvdbByName.get(nk) || null };
      const m = await resolveRowMatch(db, bucket, row).catch(() => ({ resolved: false, titleId: null }));
      titleId = (m && m.resolved && m.titleId) ? m.titleId : null;
      resolvedCache.set(nk, titleId);
    }
    if (titleId) resolved += 1;
    candidates.push({ comment: c, titleId });
  }

  console.log(`Commenti: total=${counts.total} standalone=${counts.standalone} selfThread=${counts.selfThread} replyOther=${counts.replyOther} qualityRejected=${counts.qualityRejected} eligible=${counts.eligible} resolved=${resolved} unresolved=${counts.eligible - resolved} (serie distinte=${resolvedCache.size})`);

  if (!WRITE) {
    console.log("DRY-RUN: nessuna scrittura. Aggiungi --write per creare la coda review.");
    console.log(`Poi: node scripts/publish-import-comments.js --uid=${ARG_UID} --import=${ARG_IMPORT} --list`);
    return;
  }

  const reviewRoot = db.collection("importCommentReview").doc(`${ARG_UID}__${ARG_IMPORT}`);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await reviewRoot.set({
    uid: ARG_UID, importId: ARG_IMPORT, source: "support_zip", sourceZip: file.name,
    total: counts.total, standalone: counts.standalone, selfThread: counts.selfThread,
    replyOther: counts.replyOther, qualityRejected: counts.qualityRejected,
    eligible: counts.eligible, resolved, unresolved: counts.eligible - resolved,
    consent: true, published: 0, status: "pending",
    backfilledBy: "publish-import-comments.js --support-zip", createdAt: now, updatedAt: now,
  }, { merge: true });

  let batch = db.batch(); let n = 0; let written = 0;
  for (const { comment, titleId } of candidates) {
    const { id, payload } = buildReviewCandidate({ uid: ARG_UID, importId: ARG_IMPORT, comment, titleId, now });
    batch.set(reviewRoot.collection("comments").doc(id), payload, { merge: true });
    written += 1;
    if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
  }
  if (n > 0) await batch.commit();
  console.log(`Scritti ${written} candidati in importCommentReview/${ARG_UID}__${ARG_IMPORT}/comments.`);
  console.log(`Revisiona/pubblica:`);
  console.log(`  node scripts/publish-import-comments.js --uid=${ARG_UID} --import=${ARG_IMPORT} --list`);
  console.log(`  node scripts/publish-import-comments.js --uid=${ARG_UID} --import=${ARG_IMPORT} --publish --approve-all --write`);
}

async function runBuild() {
  const { csv, source } = await loadEpisodeCommentsCsv(ARG_UID, ARG_IMPORT);
  if (!csv) { console.error("Nessun episode_comments.csv trovato (archivio o storage import)."); process.exit(2); }
  console.log(`Sorgente CSV: ${source}`);
  const { comments } = parseTvTimeEpisodeCommentsCsv(csv);
  const { counts, eligible } = selectPublishableEpisodeComments(comments);
  const nameToTitleId = await buildNameToTitleId(ARG_UID, ARG_IMPORT);

  let resolved = 0;
  const candidates = eligible.map((c) => {
    const titleId = nameToTitleId.get(nameKey(c.seriesNameGuess)) || null;
    if (titleId) resolved += 1;
    return { comment: c, titleId };
  });

  console.log(`Commenti: total=${counts.total} standalone=${counts.standalone} selfThread=${counts.selfThread} replyOther=${counts.replyOther} qualityRejected=${counts.qualityRejected} eligible=${counts.eligible} resolved=${resolved} unresolved=${counts.eligible - resolved}`);

  if (!WRITE) { console.log("DRY-RUN: nessuna scrittura. Aggiungi --write per creare la coda review."); return; }

  const reviewRoot = db.collection("importCommentReview").doc(`${ARG_UID}__${ARG_IMPORT}`);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await reviewRoot.set({
    uid: ARG_UID, importId: ARG_IMPORT,
    total: counts.total, standalone: counts.standalone, selfThread: counts.selfThread,
    replyOther: counts.replyOther, qualityRejected: counts.qualityRejected,
    eligible: counts.eligible, resolved, unresolved: counts.eligible - resolved,
    consent: true, published: 0, status: "pending",
    backfilledBy: "publish-import-comments.js", createdAt: now, updatedAt: now,
  }, { merge: true });

  let batch = db.batch(); let n = 0; let written = 0;
  for (const { comment, titleId } of candidates) {
    const { id, payload } = buildReviewCandidate({ uid: ARG_UID, importId: ARG_IMPORT, comment, titleId, now });
    batch.set(reviewRoot.collection("comments").doc(id), payload, { merge: true });
    written += 1;
    if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
  }
  if (n > 0) await batch.commit();
  console.log(`Scritti ${written} candidati in importCommentReview/${ARG_UID}__${ARG_IMPORT}/comments.`);
}

async function runList() {
  const reviewRoot = db.collection("importCommentReview").doc(`${ARG_UID}__${ARG_IMPORT}`);
  const snap = await reviewRoot.collection("comments").get();
  if (snap.empty) { console.log("Nessun candidato. Esegui prima --build."); return; }
  const rows = [];
  snap.forEach((doc) => {
    const c = doc.data() || {};
    rows.push({ id: doc.id, status: c.status, published: c.published, resolved: c.resolved, titleId: c.titleId, s: c.season, e: c.episode, series: c.seriesName, text: String(c.text || "").slice(0, 60) });
  });
  console.table(rows);
  console.log(`Totale ${rows.length}. Pubblicati: ${rows.filter((r) => r.published).length}. Risolti: ${rows.filter((r) => r.resolved).length}.`);
}

async function runPublish() {
  const reviewRoot = db.collection("importCommentReview").doc(`${ARG_UID}__${ARG_IMPORT}`);
  const snap = await reviewRoot.collection("comments").get();
  const displayName = await displayNameFor(ARG_UID);
  const plan = { candidates: snap.size, selected: 0, published: 0, threads: 0, skippedUnresolved: 0, skippedAlreadyPublished: 0, skippedNotApproved: 0, skippedRejected: 0 };

  const selected = [];
  snap.forEach((doc) => {
    const c = doc.data() || {};
    if (ONLY && !ONLY.has(doc.id)) return;
    if (c.published === true) { plan.skippedAlreadyPublished += 1; return; }
    if (c.status === "rejected") { plan.skippedRejected += 1; return; }
    if (!c.titleId) { plan.skippedUnresolved += 1; return; }
    const season = Number(c.season), episode = Number(c.episode);
    if (!(season > 0 && episode > 0)) { plan.skippedUnresolved += 1; return; }
    if (!APPROVE_ALL && !ONLY && c.status !== "approved") { plan.skippedNotApproved += 1; return; }
    selected.push({ id: doc.id, ...c, season, episode });
  });
  plan.selected = selected.length;

  if (!WRITE) {
    console.log("DRY-RUN piano pubblicazione:", JSON.stringify(plan, null, 2));
    console.log("Aggiungi --write per pubblicare.");
    return;
  }

  // Group per episode thread.
  const threadOps = new Map();
  for (const c of selected) {
    const threadId = `public_${c.titleId}_s${c.season}e${c.episode}`;
    const msgId = episodeCommentMessageId({ uid: ARG_UID, titleId: c.titleId, season: c.season, episode: c.episode, commentId: c.sourceCommentId });
    const msg = buildThreadMessage({ uid: ARG_UID, displayName, candidate: c });
    const createdAtDate = c.originalCreatedAt && typeof c.originalCreatedAt.toDate === "function" ? c.originalCreatedAt.toDate() : null;
    let entry = threadOps.get(threadId);
    if (!entry) { entry = { titleId: c.titleId, season: c.season, episode: c.episode, messages: [] }; threadOps.set(threadId, entry); }
    entry.messages.push({ candidateId: c.id, msgId, msg, createdAtDate });
  }

  // Dedup per CONTENUTO, non solo per id. L'id del messaggio e' deterministico
  // (uid+titolo+stagione+episodio+commentId) e rende la ripubblicazione
  // idempotente... solo per i messaggi scritti DA QUESTO script. Il backfill
  // one-off via REST di luglio 2026 ha scritto gli stessi commenti con id
  // casuali: ripubblicando, 129 candidati su 140 hanno prodotto un gemello
  // identico nel thread. Prima di scrivere si controlla se un messaggio con
  // lo stesso autore e lo stesso testo e' gia' li'.
  const duplicateReviewWrites = [];
  for (const [threadId, entry] of threadOps) {
    const existing = await db.collection("threads").doc(threadId)
      .collection("messages").where("uid", "==", ARG_UID).get().catch(() => null);
    if (!existing || existing.empty) continue;
    const existingByText = new Map(
      existing.docs.map((d) => [String(d.data()?.text || "").trim(), d.id])
    );
    const before = entry.messages.length;
    entry.messages = entry.messages.filter((m) => {
      const existingMessageId = existingByText.get(String(m.msg?.text || "").trim());
      if (!existingMessageId) return true;
      duplicateReviewWrites.push({
        candidateId: m.candidateId,
        messageId: existingMessageId,
        threadId,
      });
      return false;
    });
    plan.skippedAlreadyPublished += before - entry.messages.length;
  }
  for (const [threadId, entry] of [...threadOps]) {
    if (entry.messages.length === 0) threadOps.delete(threadId);
  }

  const nowServer = admin.firestore.FieldValue.serverTimestamp();
  const unknownImportDate = admin.firestore.Timestamp.fromMillis(Date.UTC(2000, 0, 1));
  let batch = db.batch(); let n = 0;
  const flush = async () => { if (n > 0) { await batch.commit(); batch = db.batch(); n = 0; } };
  for (const duplicate of duplicateReviewWrites) {
    batch.set(reviewRoot.collection("comments").doc(duplicate.candidateId), {
      published: true,
      publishedMessageId: duplicate.messageId,
      publishedThreadId: duplicate.threadId,
      status: "approved",
      updatedAt: nowServer,
    }, { merge: true });
    n += 1;
    if (n >= 400) await flush();
  }
  for (const [threadId, entry] of threadOps) {
    const threadRef = db.collection("threads").doc(threadId);
    const threadSnap = await threadRef.get().catch(() => null);
    if (!threadSnap || !threadSnap.exists) {
      batch.set(threadRef, {
        titleId: entry.titleId, visibility: "public", contextType: "public",
        contextId: `s${entry.season}e${entry.episode}`, participants: [],
        groupName: "Discussione episodio", createdBy: ARG_UID, createdAt: nowServer,
        lastMessageAt: null, lastMessagePreview: "", lastSenderUid: null, lastMessageId: null,
      }, { merge: true });
      n += 1;
    }
    plan.threads += 1;

    const existingLastMs = (threadSnap && threadSnap.exists && threadSnap.data()?.lastMessageAt && typeof threadSnap.data().lastMessageAt.toMillis === "function")
      ? threadSnap.data().lastMessageAt.toMillis() : 0;
    let newest = null;
    for (const m of entry.messages) {
      const createdAt = m.createdAtDate ? admin.firestore.Timestamp.fromDate(m.createdAtDate) : unknownImportDate;
      batch.set(threadRef.collection("messages").doc(m.msgId), { ...m.msg, createdAt }, { merge: true }); n += 1;
      batch.set(reviewRoot.collection("comments").doc(m.candidateId), {
        published: true, publishedMessageId: m.msgId, publishedThreadId: threadId, status: "approved", updatedAt: nowServer,
      }, { merge: true }); n += 1;
      plan.published += 1;
      const ms = m.createdAtDate ? m.createdAtDate.getTime() : unknownImportDate.toMillis();
      if (!newest || ms >= newest.ms) newest = { ms, m, createdAt };
      if (n >= 400) await flush();
    }
    // Don't regress a thread that already has newer real messages.
    if (newest && newest.ms > existingLastMs) {
      batch.set(threadRef, {
        lastMessageId: newest.m.msgId, lastMessageAt: newest.createdAt,
        lastMessagePreview: String(newest.m.msg.text || "").slice(0, 100), lastSenderUid: ARG_UID,
      }, { merge: true }); n += 1;
    }
    if (n >= 400) await flush();
  }
  await flush();
  await reviewRoot.set({ published: admin.firestore.FieldValue.increment(plan.published), status: "published", updatedAt: nowServer }, { merge: true });
  console.log("Pubblicazione completata:", JSON.stringify(plan, null, 2));
}

(async () => {
  try {
    if (MODE_SUPPORT) await runBuildFromSupportZip();
    else if (MODE_BUILD) await runBuild();
    else if (MODE_LIST) await runList();
    else if (MODE_PUBLISH) await runPublish();
  } catch (err) {
    console.error("ERRORE:", err?.message || err);
    process.exit(1);
  }
})();
