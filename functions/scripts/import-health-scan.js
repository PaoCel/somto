#!/usr/bin/env node
/**
 * import-health-scan.js — passa in rassegna TUTTI gli import e segnala quelli
 * che sono andati male ANCHE se risultano "completed" (read-only).
 *
 * Nasce dagli incidenti del 2026-07-22, dove tre utenti diversi avevano un
 * import formalmente riuscito e sostanzialmente vuoto o gonfiato. I sintomi da
 * cercare non sono nello `status`:
 *
 *   [VUOTO]      completed/failed con 0 righe utili -> parser sbagliato per
 *                quei file (JSON Refract negli slot CSV) o export illeggibile
 *   [NIENTE-FILM] parseError "File CSV film vuoto." -> il file dei film non e'
 *                mai arrivato (nome diverso nello zip, oppure l'account non ne
 *                aveva: si distingue solo guardando l'export)
 *   [ZERO-TITOLI] righe lette ma nessun titolo scritto
 *   [FERMO]      status non terminale e fermo da oltre 30 minuti
 *   [MATCH-BASSO] meno del 50% delle righe risolte
 *   [STAGIONI]   serie marcata completata da un import la cui numerazione di
 *                stagione non combacia col catalogo (vedi
 *                writeTitleStates.js#seasonNumberingLooksCompatible): la serie
 *                risulta vista tutta e accredita ore mai guardate
 *
 * Uso:
 *   node scripts/import-health-scan.js              # tutti gli import
 *   node scripts/import-health-scan.js --uid=UID    # un utente solo
 *   node scripts/import-health-scan.js --skip-seasons   # salta il controllo piu' costoso
 */
"use strict";

const admin = require("firebase-admin");
const { estimateTitleTotals } = require("../lib/titleStates");

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).trim() : "";
};
const ONLY_UID = flag("--uid");
const SKIP_SEASONS = args.includes("--skip-seasons");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const ts = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const STALE_MS = 30 * 60 * 1000;
const TERMINAL = new Set(["completed", "awaiting_confirmation", "failed"]);

// Cache dei titoli: gli stessi anime tornano su piu' utenti.
const titleCache = new Map();
async function getTitle(titleId) {
  if (titleCache.has(titleId)) return titleCache.get(titleId);
  const snap = await db.collection("titles").doc(titleId).get();
  const data = snap.exists ? { id: titleId, ...snap.data() } : null;
  titleCache.set(titleId, data);
  return data;
}

(async () => {
  const importsSnap = await db.collectionGroup("imports").get();
  const imports = importsSnap.docs
    .map((d) => ({ uid: d.ref.parent.parent.id, id: d.id, ref: d.ref, data: d.data() || {} }))
    .filter((x) => !ONLY_UID || x.uid === ONLY_UID)
    .sort((a, b) => (ts(b.data.createdAt)?.getTime() || 0) - (ts(a.data.createdAt)?.getTime() || 0));

  const names = new Map();
  const displayName = async (uid) => {
    if (!names.has(uid)) {
      const snap = await db.collection("users").doc(uid).get();
      names.set(uid, snap.data()?.displayName || uid);
    }
    return names.get(uid);
  };

  const findings = [];
  const now = Date.now();

  // `importedTitleCount` non esiste sugli import piu' vecchi del campo: preso
  // da solo segnerebbe come falliti import perfettamente riusciti. Si scende
  // per gradi fino alla prova che conta davvero — quanti titoli ha l'utente.
  const stateCounts = new Map();
  const userTitleStateCount = async (uid) => {
    if (!stateCounts.has(uid)) {
      const c = await db.collection("users").doc(uid).collection("titleStates").count().get();
      stateCounts.set(uid, c.data().count);
    }
    return stateCounts.get(uid);
  };
  const titlesWritten = async (imp) => {
    const d = imp.data;
    if (Number.isFinite(Number(d.importedTitleCount))) return Number(d.importedTitleCount);
    if (Array.isArray(d.titleStateIdsWritten) && d.titleStateIdsWritten.length) return d.titleStateIdsWritten.length;
    return await userTitleStateCount(imp.uid);
  };

  for (const imp of imports) {
    const d = imp.data;
    const tags = [];
    const rows = Number(d.totalRows) || 0;
    const titles = await titlesWritten(imp);
    const matched = Number(d.matchedCount) || 0;
    const reasons = (d.parseErrors || []).map((e) => String(e.reason || ""));

    if (rows === 0 && d.status !== "uploading") tags.push("VUOTO");
    if (reasons.some((r) => /film vuoto/i.test(r))) tags.push("NIENTE-FILM");
    if (rows > 0 && titles === 0 && TERMINAL.has(d.status)) tags.push("ZERO-TITOLI");
    if (!TERMINAL.has(d.status)) {
      const updated = ts(d.updatedAt)?.getTime() || 0;
      if (updated && now - updated > STALE_MS) tags.push("FERMO");
    }
    if (rows > 20 && matched > 0 && matched / rows < 0.5) tags.push("MATCH-BASSO");

    if (tags.length) {
      findings.push({
        uid: imp.uid,
        name: await displayName(imp.uid),
        importId: imp.id,
        created: ts(d.createdAt)?.toISOString().slice(0, 16) || "?",
        source: d.source,
        status: d.status,
        rows,
        titles,
        tags,
        reason: reasons[0] || "",
      });
    }
  }

  console.log(`\n===== IMPORT: ${imports.length} totali, ${findings.length} da guardare =====\n`);
  for (const f of findings) {
    console.log(`[${f.tags.join("][")}] ${f.name} (${f.uid})`);
    console.log(`    ${f.importId} · ${f.source} · ${f.status} · ${f.created} · ${f.rows} righe → ${f.titles} titoli${f.reason ? ` · ${f.reason}` : ""}`);
  }
  if (!findings.length) console.log("  nessuna anomalia.\n");

  if (SKIP_SEASONS) {
    process.exit(0);
  }

  // ---- serie completate per numerazione di stagione incompatibile ----
  // Euristica economica: si guardano solo le serie marcate completate da un
  // import, e solo quelle il cui catalogo ha POCHE stagioni ma MOLTI episodi
  // (la forma tipica degli anime che TV Time spezza in archi). Solo per quelle
  // si legge il numero di stagione massimo negli items dell'import.
  console.log(`\n===== SERIE COMPLETATE CON STAGIONI SFASATE =====\n`);
  const uids = [...new Set(imports.map((i) => i.uid))];
  const victims = [];

  for (const uid of uids) {
    const statesSnap = await db.collection("users").doc(uid).collection("titleStates").get();
    for (const stateDoc of statesSnap.docs) {
      const state = stateDoc.data() || {};
      if (!String(state.source || "").startsWith("import_")) continue;
      if (state.state !== "completed_unrated" && state.state !== "rated") continue;

      const title = await getTitle(stateDoc.id);
      if (!title || title.type !== "tv") continue;
      const totals = estimateTitleTotals(title);
      const seasons = Number(totals.totalSeasonCount) || 0;
      const episodes = Number(totals.totalEpisodeCount) || 0;
      // forma "arco": poche stagioni dichiarate, tanti episodi dentro
      if (!(seasons > 0 && episodes >= 40 && episodes / seasons >= 30)) continue;

      // Numero di stagione massimo che l'import ha visto per questo titolo.
      let maxSeason = 0;
      for (const imp of imports.filter((i) => i.uid === uid)) {
        const itemsSnap = await imp.ref.collection("items").where("titleId", "==", stateDoc.id).get();
        itemsSnap.forEach((it) => {
          const s = Number(it.data()?.seasonNumber) || 0;
          if (s > maxSeason) maxSeason = s;
        });
      }
      if (maxSeason > seasons) {
        victims.push({
          uid,
          name: await displayName(uid),
          titleId: stateDoc.id,
          title: title.name,
          maxSeason,
          seasons,
          minutes: state.watchMinutesContribution || 0,
        });
      }
    }
  }

  for (const v of victims) {
    console.log(`${v.name} (${v.uid}) · ${v.title} [${v.titleId}]`);
    console.log(`    export dice stagione ${v.maxSeason}, il catalogo ne ha ${v.seasons} → completata a torto, ${v.minutes} min accreditati`);
  }
  console.log(`\n${victims.length} serie da riparare con repair-import-season-mismatch.js\n`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
