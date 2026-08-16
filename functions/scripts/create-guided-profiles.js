#!/usr/bin/env node
/**
 * create-guided-profiles.js
 *
 * Crea un set di "profili guidati" (synthetic guided profiles): account interni
 * supervisionati da Somto, marcati come sintetici ed esclusi dalle metriche reali.
 *
 * Identita': uid sintetici `guided_*`, NESSUN account Firebase Auth (niente
 * inquinamento del conteggio utenti Auth, niente trigger di signup reale).
 *
 * Scrive 3 doc per profilo (admin SDK, bypassa le rules):
 *   - users/{uid}          -> doc pubblico (displayName, bio disclosure, accountType)
 *   - guidedProfiles/{uid} -> doc di controllo (persona, livello attivita', status)
 *   - usersPrivate/{uid}   -> tasteProfile.seedTitleIds (campione catalogo)
 *
 * Idempotente: l'uid e' derivato dal nome, re-run fa merge.
 *
 * Usage:
 *   cd functions
 *   node scripts/create-guided-profiles.js                 # dry-run (no writes)
 *   node scripts/create-guided-profiles.js --write         # crea 30 profili
 *   node scripts/create-guided-profiles.js --write --count=40
 */

const admin = require("firebase-admin");
const {
  ACCOUNT_TYPE, GUIDED_PROFILE_STATUS, VISIBILITY_MODE,
  DISCLOSURE_LONG, DISCLOSURE_SHORT, GUIDED_UID_PREFIX,
} = require("../modules/guidedProfiles/constants");
const { PERSONA_TEMPLATES, NAME_POOL, activityLevelForIndex } = require("../modules/guidedProfiles/personas");

const WRITE = process.argv.includes("--write");
const countArg = process.argv.find((a) => a.startsWith("--count="));
const COUNT = Math.max(1, Math.min(80, Number((countArg || "").split("=")[1]) || 30));

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

function slug(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function buildProfiles(count, seedTitleIds) {
  const out = [];
  const usedUids = new Set();
  for (let i = 0; i < count; i++) {
    const name = NAME_POOL[i % NAME_POOL.length];
    const persona = PERSONA_TEMPLATES[i % PERSONA_TEMPLATES.length];
    const activityLevel = activityLevelForIndex(i, count);

    let base = `${GUIDED_UID_PREFIX}${slug(name)}`;
    let uid = base;
    let n = 2;
    while (usedUids.has(uid)) { uid = `${base}_${n++}`; }
    usedUids.add(uid);

    const username = uid.replace(GUIDED_UID_PREFIX, "");
    const bio = i % 2 === 0 ? DISCLOSURE_LONG : DISCLOSURE_SHORT;
    // campione di seed titoli (best-effort)
    const seeds = seedTitleIds.length
      ? shuffle(seedTitleIds).slice(0, 6 + (i % 4))
      : [];

    out.push({ uid, name, username, persona, activityLevel, bio, seeds });
  }
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  console.log(`create-guided-profiles — ${WRITE ? "WRITE" : "DRY-RUN"} — count=${COUNT}`);

  // Campione titoli per i seedTitleIds.
  const titlesSnap = await db.collection("titles").where("status", "==", "approved").limit(80).get();
  const titleIds = titlesSnap.docs.map((d) => d.id);
  console.log(`Catalogo: ${titleIds.length} titoli approved campionati`);

  const profiles = buildProfiles(COUNT, titleIds);
  const now = admin.firestore.FieldValue.serverTimestamp();
  let created = 0;

  for (const p of profiles) {
    const publicDoc = {
      displayName: p.name,
      displayNameLower: p.name.toLowerCase(),
      username: p.username,
      photoURL: "",          // avatar = iniziali (fallback esistente), no foto realistiche
      avatarURL: "",
      bio: p.bio,            // disclosure sempre accessibile dal profilo
      accountType: ACCOUNT_TYPE.GUIDED,
      isSynthetic: true,
      createdAt: now,
      lastActiveAt: now,
      privacyDefault: "public",
      trusted: false,
      isAdmin: false,
      level: "base",
      favoriteGenres: p.persona.genres || [],
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0, totalWatchMinutes: 0, rewatchCount: 0 },
    };

    const controlDoc = {
      uid: p.uid,
      displayName: p.name,
      guidedProfilePersonaId: p.persona.id,
      personaLabel: p.persona.label,
      genres: p.persona.genres || [],
      tone: p.persona.tone || "",
      flavor: p.persona.flavor || [],
      activityLevel: p.activityLevel,
      status: GUIDED_PROFILE_STATUS.ACTIVE,
      visibilityMode: VISIBILITY_MODE.PUBLIC_GUIDED,
      isAiAssisted: true,
      humanReviewed: false,
      excludeFromRealUserMetrics: true,
      excludeFromGrowthStats: true,
      excludeFromEngagementStats: true,
      canReceiveDm: false,
      createdBySystem: true,
      dailyActions: { dateKey: "", count: 0 },
      createdAt: now,
      updatedAt: now,
    };

    const privateDoc = {
      onboardingStatus: {
        version: 1, startedAt: null, completedAt: now, completedLevel: 1,
        lastPromptAt: null, dismissedAt: null, confidenceScore: 50,
      },
      tasteProfile: {
        seedTitleIds: p.seeds, seedLikedTitleIds: [], vibe: [],
        filmVsSeries: "mix", mainstream: "mix", era: null, context: [],
        dislikes: [], favoriteTitleText: null, contentTolerance: null, updatedAt: now,
      },
      updatedAt: now,
    };

    console.log(`  ${p.uid}  [${p.activityLevel}]  ${p.persona.label}  seeds=${p.seeds.length}`);

    if (WRITE) {
      const batch = db.batch();
      batch.set(db.collection("users").doc(p.uid), publicDoc, { merge: true });
      batch.set(db.collection("guidedProfiles").doc(p.uid), controlDoc, { merge: true });
      batch.set(db.collection("usersPrivate").doc(p.uid), privateDoc, { merge: true });
      await batch.commit();
      created++;
    }
  }

  console.log(`\nDone. ${WRITE ? `${created} profili scritti` : "dry-run (nessuna scrittura)"}.`);
  if (!WRITE) console.log("Esegui con --write per applicare.");
}

main().catch((err) => { console.error(err); process.exit(1); });
