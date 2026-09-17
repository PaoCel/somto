#!/usr/bin/env node
/**
 * preview-weekly-digest.js — mostra a chi arriverebbe il digest settimanale e
 * con che contenuto, **senza scrivere niente**.
 *
 * Usa la stessa selezione della funzione schedulata (`lib/weeklyDigest.js`), le
 * stesse regole di rilevanza degli aggiornamenti titolo e le stesse esclusioni:
 * titoli silenziati, opt-out globale su `title_update`, e novità che la sweep
 * giornaliera ha già mandato singolarmente.
 *
 * Uso:
 *   cd functions
 *   node scripts/preview-weekly-digest.js            # riepilogo + 8 esempi
 *   node scripts/preview-weekly-digest.js --samples 20
 *   node scripts/preview-weekly-digest.js --only <uid>
 *
 * NON ha un flag --write di proposito: la scrittura sta nella funzione
 * schedulata, che è l'unico posto da cui deve partire una notifica vera.
 */

const admin = require("firebase-admin");

const {
  DEFAULT_MAX_INACTIVITY_MS,
  digestWeekKey,
  selectDigestItems,
  buildDigestMessageByLocale,
} = require("../lib/weeklyDigest");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const SAMPLES = Number(arg("--samples", 8));
const ONLY = String(arg("--only", "") || "").trim();

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
// Finestra: la settimana appena passata più le due settimane davanti. Le
// novità future sono quelle che fanno tornare (un episodio che esce giovedì),
// quelle passate coprono la settimana che la persona si è persa.
const WINDOW_BACK_MS = 7 * DAY;
const WINDOW_FORWARD_MS = 14 * DAY;

async function loadEvents() {
  const snap = await db.collection("titleUpdateEvents")
    .where("effectiveAt", ">=", admin.firestore.Timestamp.fromMillis(NOW - WINDOW_BACK_MS))
    .where("effectiveAt", "<=", admin.firestore.Timestamp.fromMillis(NOW + WINDOW_FORWARD_MS))
    .orderBy("effectiveAt", "asc")
    .get();

  const rows = [];
  const titleIds = new Set();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (data.status && data.status !== "published") return;
    if (!data.titleId) return;
    rows.push({ id: doc.id, data });
    titleIds.add(data.titleId);
  });

  // I nomi in blocco: un digest che dice "questo titolo" non lo legge nessuno.
  const names = new Map();
  const ids = [...titleIds];
  for (let i = 0; i < ids.length; i += 250) {
    const refs = ids.slice(i, i + 250).map((id) => db.collection("titles").doc(id));
    // eslint-disable-next-line no-await-in-loop
    const docs = await db.getAll(...refs);
    docs.forEach((doc) => {
      if (doc.exists) names.set(doc.id, String(doc.data()?.name || ""));
    });
  }
  rows.forEach((row) => { row.titleName = names.get(row.data.titleId) || ""; });
  return rows;
}

async function loadUserContext(userRef, eventTitleIds) {
  const states = {};
  const prefs = {};
  const ids = [...eventTitleIds];

  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    // eslint-disable-next-line no-await-in-loop
    const [stateDocs, prefDocs] = await Promise.all([
      db.getAll(...chunk.map((id) => userRef.collection("titleStates").doc(id))),
      db.getAll(...chunk.map((id) => userRef.collection("titleUpdatePrefs").doc(id))),
    ]);
    stateDocs.forEach((doc) => { if (doc.exists) states[doc.id] = doc.data() || {}; });
    prefDocs.forEach((doc) => { if (doc.exists) prefs[doc.id] = doc.data() || {}; });
  }
  return { states, prefs };
}

async function alreadyNotified(userRef, eventIds) {
  const out = new Set();
  const ids = [...eventIds];
  for (let i = 0; i < ids.length; i += 250) {
    const refs = ids.slice(i, i + 250)
      .map((id) => userRef.collection("notifications").doc(`title_update_${id}`));
    // eslint-disable-next-line no-await-in-loop
    const docs = await db.getAll(...refs);
    docs.forEach((doc) => {
      if (doc.exists) out.add(String(doc.id).replace(/^title_update_/, ""));
    });
  }
  return out;
}

async function hasGlobalOptOut(userRef) {
  const snap = await userRef.collection("_system").doc("notificationPrefs").get().catch(() => null);
  const disabled = snap?.exists ? snap.data()?.disabledTypes : [];
  return Array.isArray(disabled) && disabled.includes("title_update");
}

(async () => {
  const events = await loadEvents();
  const eventTitleIds = new Set(events.map((row) => row.data.titleId));
  const eventIds = events.map((row) => row.id);
  console.log(`settimana ${digestWeekKey(NOW)} · eventi nella finestra: ${events.length} su ${eventTitleIds.size} titoli\n`);

  let users;
  if (ONLY) {
    const doc = await db.collection("users").doc(ONLY).get();
    users = doc.exists ? [doc] : [];
  } else {
    users = (await db.collection("users").get()).docs;
  }

  const stats = {
    utenti: 0,
    esclusiSintetici: 0,
    esclusiInattivi: 0,
    esclusiOptOut: 0,
    senzaNovita: 0,
    conDigest: 0,
    perNumeroNovita: { 1: 0, 2: 0, 3: 0 },
    novitaTotali: 0,
    perTipo: {},
  };
  const samples = [];

  for (const doc of users) {
    const u = doc.data() || {};
    if (u.isSynthetic || u.isDeleted || u.displayName === "Deleted user") {
      stats.esclusiSintetici += 1;
      continue;
    }
    stats.utenti += 1;

    const lastActive = u.lastActiveAt?.toMillis?.() || 0;
    if (!ONLY && (!lastActive || NOW - lastActive > DEFAULT_MAX_INACTIVITY_MS)) {
      stats.esclusiInattivi += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    if (await hasGlobalOptOut(doc.ref)) {
      stats.esclusiOptOut += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const { states, prefs } = await loadUserContext(doc.ref, eventTitleIds);
    if (!Object.keys(states).length) {
      stats.senzaNovita += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const notified = await alreadyNotified(doc.ref, eventIds);
    const items = selectDigestItems({
      events,
      statesByTitleId: states,
      prefsByTitleId: prefs,
      notifiedEventIds: notified,
      nowMs: NOW,
    });

    if (!items.length) {
      stats.senzaNovita += 1;
      continue;
    }

    stats.conDigest += 1;
    stats.perNumeroNovita[items.length] = (stats.perNumeroNovita[items.length] || 0) + 1;
    stats.novitaTotali += items.length;
    items.forEach((row) => {
      stats.perTipo[row.eventType] = (stats.perTipo[row.eventType] || 0) + 1;
    });

    if (samples.length < SAMPLES) {
      samples.push({
        nome: u.displayName || doc.id,
        giorniDaUltimoAccesso: Math.round((NOW - lastActive) / DAY),
        messaggio: buildDigestMessageByLocale(items)["it-IT"],
        righe: items.map((row) => `${row.relevance === "high" ? "●" : "○"} ${row.messageByLocale["it-IT"]}`),
      });
    }
  }

  console.log("=== a chi arriverebbe ===");
  console.log(`utenti veri:                 ${stats.utenti}`);
  console.log(`  fermi da oltre 60 giorni:  ${stats.esclusiInattivi} (fuori: sono il pubblico del risveglio, non del digest)`);
  console.log(`  hanno disattivato il tipo: ${stats.esclusiOptOut}`);
  console.log(`  senza novità questa settimana: ${stats.senzaNovita}`);
  console.log(`  RICEVONO IL DIGEST:        ${stats.conDigest}`);
  console.log(`\nnovità totali recapitate: ${stats.novitaTotali}`);
  console.log(`digest da 1 / 2 / 3 novità: ${stats.perNumeroNovita[1] || 0} / ${stats.perNumeroNovita[2] || 0} / ${stats.perNumeroNovita[3] || 0}`);
  console.log(`per tipo di novità: ${JSON.stringify(stats.perTipo)}`);

  console.log(`\n=== come suonerebbe (${samples.length} esempi) ===`);
  samples.forEach((s, i) => {
    console.log(`\n[${i + 1}] ${s.nome} · ultimo accesso ${s.giorniDaUltimoAccesso} giorni fa`);
    console.log(`    notifica: "${s.messaggio}"`);
    s.righe.forEach((r) => console.log(`      ${r}`));
  });

  console.log("\nDRY RUN — nessuna notifica scritta.");
})().catch((error) => {
  console.error("ERRORE", error.message);
  process.exit(1);
});
