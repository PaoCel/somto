#!/usr/bin/env node
/**
 * create-editorial-pages.js
 *
 * Crea le **pagine editoriali**: account sintetici che possono firmare post
 * ufficiali al posto di "Somto". Servono perche' un solo autore che pubblica
 * tutto assomiglia a un notiziario; pagine tematiche danno un motivo per
 * seguirle, e chi le segue riceve i loro post anche quando il titolo non e'
 * ancora nella sua libreria.
 *
 * Identita': uid `page_*`, NESSUN account Firebase Auth. `isSynthetic: true`
 * tiene le pagine fuori da metriche, leaderboard e notifica "nuovo iscritto"
 * (le guardie esistono gia': modules/guidedProfiles/guards.js).
 *
 * Scrive un solo doc per pagina: `users/{uid}`.
 * Idempotente: rilanciarlo fa merge, non duplica.
 *
 * Uso:
 *   cd functions
 *   node scripts/create-editorial-pages.js            # dry-run, non scrive
 *   node scripts/create-editorial-pages.js --write
 *   node scripts/create-editorial-pages.js --write --only=page_crime
 */

const admin = require("firebase-admin");
const { PAGE_ACCOUNT_TYPE } = require("../lib/officialUpdates");

const PROJECT_ID = "gia-visto";
const WRITE = process.argv.includes("--write");
const ONLY = (process.argv.find((arg) => arg.startsWith("--only=")) || "").split("=")[1] || "";

// Set iniziale. Non e' una scelta definitiva: aggiungere una pagina qui e
// rilanciare lo script e' tutto quello che serve.
const PAGES = [
  {
    uid: "page_uscite",
    displayName: "Uscite al cinema",
    username: "uscite",
    bio: "I film che arrivano in sala in Italia, con le date confermate. Canale editoriale di Somto.",
  },
  {
    uid: "page_serie",
    displayName: "Serie del momento",
    username: "serie",
    bio: "Nuove stagioni, ritorni e finali. Canale editoriale di Somto.",
  },
  {
    uid: "page_crime",
    displayName: "Crime e thriller",
    username: "crime",
    bio: "Indagini, processi e storie vere. Canale editoriale di Somto.",
  },
  {
    uid: "page_anime",
    displayName: "Anime",
    username: "anime",
    bio: "Stagioni, film e annunci dal Giappone. Canale editoriale di Somto.",
  },
];

function pageDoc(page, now) {
  return {
    displayName: page.displayName,
    displayNameLower: page.displayName.toLowerCase(),
    username: page.username,
    bio: page.bio,
    // Nessun avatar: l'iniziale del nome e' meglio di un logo finto, e su
    // web e iOS il fallback e' gia' lo stesso componente.
    photoURL: null,
    avatarURL: null,
    privacyDefault: "public",
    accountType: PAGE_ACCOUNT_TYPE,
    isOfficial: true,
    // Tiene la pagina fuori da metriche prodotto, leaderboard e dalla
    // notifica "nuovo iscritto" agli admin.
    isSynthetic: true,
    isAdmin: false,
    trusted: true,
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const targets = ONLY ? PAGES.filter((page) => page.uid === ONLY) : PAGES;

  if (!targets.length) {
    console.error(`nessuna pagina con uid ${ONLY}`);
    process.exit(1);
  }

  for (const page of targets) {
    const ref = db.collection("users").doc(page.uid);
    const existing = await ref.get();
    const label = existing.exists ? "aggiorna" : "crea";

    if (!WRITE) {
      console.log(`[dry-run] ${label} ${page.uid} — ${page.displayName}`);
      continue;
    }

    await ref.set(pageDoc(page, now), { merge: true });
    console.log(`${label} ${page.uid} — ${page.displayName}`);
  }

  if (!WRITE) console.log("\nnessuna scrittura: rilancia con --write");
  process.exit(0);
}

main().catch((err) => {
  console.error("errore:", err?.message || err);
  process.exit(1);
});
