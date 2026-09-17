#!/usr/bin/env node
/**
 * Seed editorial public watchlists in userLists.
 *
 * Dry-run by default:
 *   node scripts/seed-editorial-public-lists.js
 *   node scripts/seed-editorial-public-lists.js --write
 */
const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const OWNER_UID = "somto-editorial";
const OWNER_DISPLAY_NAME = "Somto";

const LISTS = [
  {
    id: "00_editorial_mcu_release_order",
    title: "Marvel: film MCU in ordine di uscita",
    description: "La maratona dei film Marvel Studios, dall'inizio dell'MCU fino alle uscite piu recenti presenti su Somto.",
    kind: "ordered_path",
    accentHex: "#B4232A",
    items: [
      tmdb("movie", 1726),   // Iron Man
      tmdb("movie", 1724),   // The Incredible Hulk
      tmdb("movie", 10138),  // Iron Man 2
      tmdb("movie", 10195),  // Thor
      tmdb("movie", 1771),   // Captain America: The First Avenger
      tmdb("movie", 24428),  // The Avengers
      tmdb("movie", 68721),  // Iron Man 3
      tmdb("movie", 76338),  // Thor: The Dark World
      tmdb("movie", 100402), // Captain America: The Winter Soldier
      tmdb("movie", 118340), // Guardians of the Galaxy
      tmdb("movie", 99861),  // Avengers: Age of Ultron
      tmdb("movie", 102899), // Ant-Man
      tmdb("movie", 271110), // Captain America: Civil War
      tmdb("movie", 284052), // Doctor Strange
      tmdb("movie", 283995), // Guardians of the Galaxy Vol. 2
      tmdb("movie", 315635), // Spider-Man: Homecoming
      tmdb("movie", 284053), // Thor: Ragnarok
      tmdb("movie", 284054), // Black Panther
      tmdb("movie", 299536), // Avengers: Infinity War
      tmdb("movie", 363088), // Ant-Man and the Wasp
      tmdb("movie", 299537), // Captain Marvel
      tmdb("movie", 299534), // Avengers: Endgame
      tmdb("movie", 429617), // Spider-Man: Far From Home
      tmdb("movie", 497698), // Black Widow
      tmdb("movie", 566525), // Shang-Chi
      tmdb("movie", 524434), // Eternals
      tmdb("movie", 634649), // Spider-Man: No Way Home
      tmdb("movie", 453395), // Doctor Strange in the Multiverse of Madness
      tmdb("movie", 616037), // Thor: Love and Thunder
      tmdb("movie", 505642), // Black Panther: Wakanda Forever
      tmdb("movie", 640146), // Ant-Man and the Wasp: Quantumania
      tmdb("movie", 447365), // Guardians of the Galaxy Vol. 3
      tmdb("movie", 609681), // The Marvels
    ],
  },
  {
    id: "00_editorial_star_wars_timeline",
    title: "Star Wars: ordine della galassia",
    description: "Film e serie principali in un percorso narrativo comodo per una maratona Star Wars.",
    kind: "ordered_path",
    accentHex: "#1D4ED8",
    items: [
      tmdb("movie", 1893),
      tmdb("movie", 1894),
      tmdb("movie", 1895),
      tmdb("tv", 4194),
      tmdb("movie", 348350),
      tmdb("tv", 60554),
      tmdb("movie", 330459),
      tmdb("movie", 11),
      tmdb("movie", 1891),
      tmdb("movie", 1892),
      tmdb("movie", 140607),
      tmdb("movie", 181808),
      tmdb("movie", 181812),
    ],
  },
  {
    id: "00_editorial_harry_potter_maratona",
    title: "Harry Potter: maratona Hogwarts",
    description: "Gli otto film della saga principale, in ordine di uscita e di storia.",
    kind: "ordered_path",
    accentHex: "#7C3AED",
    items: [
      tmdb("movie", 671),
      tmdb("movie", 672),
      tmdb("movie", 673),
      tmdb("movie", 674),
      tmdb("movie", 675),
      tmdb("movie", 767),
      tmdb("movie", 12444),
      tmdb("movie", 12445),
    ],
  },
  {
    id: "00_editorial_sherlock_holmes",
    title: "Appassionati di Sherlock Holmes",
    description: "Adattamenti classici, moderni e derivativi per chi ama Holmes, Watson e misteri deduttivi.",
    kind: "collection",
    accentHex: "#334155",
    items: [
      tmdb("tv", 799),
      tmdb("movie", 108432),
      tmdb("movie", 79106),
      tmdb("movie", 10528),
      titleId("sherlock-holmes-gioco-di-ombre-2011"),
      tmdb("tv", 19885),
      tmdb("movie", 379170),
      tmdb("movie", 497582),
      tmdb("tv", 246461),
      tmdb("tv", 255661),
    ],
  },
  {
    id: "00_editorial_batman_multiverso",
    title: "Batman: dal gotico al multiverso",
    description: "Un percorso tra Batman classico, animazione, Nolan, Snyder e riletture recenti.",
    kind: "ordered_path",
    accentHex: "#111827",
    items: [
      tmdb("tv", 2287),
      tmdb("movie", 268),
      tmdb("movie", 364),
      tmdb("tv", 2098),
      tmdb("movie", 415),
      tmdb("tv", 513),
      tmdb("movie", 272),
      tmdb("movie", 209112),
      tmdb("movie", 414906),
      tmdb("movie", 1297763),
      tmdb("movie", 987400),
    ],
  },
  {
    id: "00_editorial_pixar_comfort_watch",
    title: "Pixar: comfort watch",
    description: "Classici Pixar e titoli recenti da recuperare quando vuoi una maratona animata senza sbagliare.",
    kind: "collection",
    accentHex: "#0EA5E9",
    items: [
      tmdb("movie", 862),
      tmdb("movie", 863),
      tmdb("movie", 585),
      tmdb("movie", 12),
      tmdb("movie", 9806),
      tmdb("movie", 920),
      tmdb("movie", 2062),
      tmdb("movie", 10681),
      tmdb("movie", 14160),
      tmdb("movie", 10193),
      tmdb("movie", 62177),
      tmdb("movie", 150540),
      tmdb("movie", 354912),
      tmdb("movie", 301528),
      tmdb("movie", 508442),
      tmdb("movie", 508947),
      tmdb("movie", 976573),
      tmdb("movie", 1022789),
    ],
  },
  {
    id: "00_editorial_terra_di_mezzo",
    title: "Terra di Mezzo: Tolkien sullo schermo",
    description: "Il Signore degli Anelli e le espansioni disponibili su Somto, per chi vuole tornare nella Terra di Mezzo.",
    kind: "collection",
    accentHex: "#166534",
    items: [
      tmdb("tv", 84773),
      tmdb("movie", 120),
      tmdb("movie", 121),
      tmdb("movie", 122),
      tmdb("movie", 839033),
    ],
  },
  {
    id: "00_editorial_commedia_italiana_cult",
    title: "Commedia italiana cult",
    description: "Da Zalone ai grandi successi corali: una lista leggera per recuperare commedie italiane popolari.",
    kind: "collection",
    accentHex: "#EA580C",
    items: [
      title("Cado dalle nubi", "movie"),
      title("Che bella giornata", "movie"),
      title("Sole a catinelle", "movie"),
      title("Quo vado?", "movie"),
      title("Tolo tolo", "movie"),
      title("Buen Camino", "movie"),
      title("Benvenuti al sud", "movie"),
      title("Benvenuti al Nord", "movie"),
      title("Perfetti sconosciuti", "movie"),
      title("Smetto quando voglio", "movie"),
      title("Notte prima degli esami", "movie"),
      title("Immaturi", "movie"),
      title("10 giorni senza mamma", "movie"),
      title("Mine vaganti", "movie"),
      title("Il primo Natale", "movie"),
      title("La vita è bella", "movie"),
    ],
  },
];

function tmdb(mediaType, tmdbId) {
  return { mediaType, tmdbId };
}

function title(name, mediaType) {
  return { name, mediaType };
}

function titleId(id) {
  return { id };
}

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function displayTitle(t) {
  return `${t.name || t.id}${t.year ? ` (${t.year})` : ""}`;
}

async function loadApprovedTitles(db) {
  const snap = await db.collection("titles")
    .where("status", "==", "approved")
    .select("name", "type", "year", "tmdbId", "status")
    .get();
  const titles = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const byId = new Map();
  const byTmdb = new Map();
  const byExact = new Map();
  for (const t of titles) {
    byId.set(t.id, t);
    const type = String(t.type || "").trim().toLowerCase();
    const tmdbId = Number(t.tmdbId || 0);
    if (type && tmdbId > 0) byTmdb.set(`${type}:${tmdbId}`, t);
    const normName = normalize(t.name);
    if (type && normName.length >= 2) byExact.set(`${type}:${normName}`, t);
  }
  return { titles, byId, byTmdb, byExact };
}

function resolveSpec(spec, indexes) {
  if (spec.id) {
    const found = indexes.byId.get(spec.id);
    return found || null;
  }
  if (spec.tmdbId) {
    const found = indexes.byTmdb.get(`${spec.mediaType}:${Number(spec.tmdbId)}`);
    return found || null;
  }
  if (spec.name) {
    const found = indexes.byExact.get(`${spec.mediaType}:${normalize(spec.name)}`);
    return found || null;
  }
  return null;
}

async function buildPlan(db) {
  const indexes = await loadApprovedTitles(db);
  const lists = [];
  const missing = [];
  for (const list of LISTS) {
    const seen = new Set();
    const resolved = [];
    for (const item of list.items) {
      const titleDoc = resolveSpec(item, indexes);
      if (!titleDoc) {
        missing.push({ listId: list.id, listTitle: list.title, item });
        continue;
      }
      if (seen.has(titleDoc.id)) continue;
      seen.add(titleDoc.id);
      resolved.push(titleDoc);
    }
    lists.push({ ...list, resolved });
  }
  return { lists, missing };
}

async function writeLists(db, lists) {
  await db.collection("users").doc(OWNER_UID).set({
    uid: OWNER_UID,
    displayName: OWNER_DISPLAY_NAME,
    displayNameLower: OWNER_DISPLAY_NAME.toLowerCase(),
    isEditorial: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  for (const list of lists) {
    if (list.resolved.length < 5) {
      console.warn(`[skip] ${list.id}: only ${list.resolved.length} resolved titles`);
      continue;
    }

    const listRef = db.collection("userLists").doc(list.id);
    const existing = await listRef.get();
    const existingItems = await listRef.collection("items").get();
    const titleIds = list.resolved.map((t) => t.id);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const previewTitleIds = titleIds.slice(0, 4);
    const batch = db.batch();

    for (const docSnap of existingItems.docs) batch.delete(docSnap.ref);

    batch.set(listRef, {
      ownerUid: OWNER_UID,
      ownerDisplayName: OWNER_DISPLAY_NAME,
      owner: {
        uid: OWNER_UID,
        displayName: OWNER_DISPLAY_NAME,
        photoURL: null,
      },
      title: list.title,
      description: list.description,
      visibility: "public",
      kind: list.kind === "ordered_path" ? "ordered_path" : "collection",
      memberUids: [OWNER_UID],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: titleIds,
      previewTitleIds,
      itemCount: titleIds.length,
      completedCount: 0,
      followersCount: Number(existing.data()?.followersCount || 0) || 0,
      cover: {
        imageUrl: null,
        storagePath: null,
        fallbackTitleIds: previewTitleIds,
        accentHex: list.accentHex || null,
      },
      editorial: true,
      editorialSlug: list.id.replace(/^00_editorial_/, ""),
      createdAt: existing.exists ? (existing.data().createdAt || now) : now,
      updatedAt: now,
    }, { merge: true });

    batch.set(listRef.collection("members").doc(OWNER_UID), {
      uid: OWNER_UID,
      role: "owner",
      displayName: OWNER_DISPLAY_NAME,
      photoURL: null,
      joinedAt: now,
    }, { merge: true });

    titleIds.forEach((titleIdValue, index) => {
      batch.set(listRef.collection("items").doc(titleIdValue), {
        titleId: titleIdValue,
        orderIndex: (index + 1) * 1000,
        addedByUid: OWNER_UID,
        note: null,
        addedAt: now,
        updatedAt: now,
      }, { merge: true });
    });

    await batch.commit();
    console.log(`[write] ${list.title}: ${titleIds.length} titoli`);
  }
}

async function main() {
  admin.initializeApp({ projectId: "gia-visto" });
  const db = admin.firestore();
  const plan = await buildPlan(db);

  console.log("=".repeat(72));
  console.log("Editorial public watchlists");
  console.log("=".repeat(72));
  console.log("mode:", WRITE ? "WRITE" : "DRY-RUN");
  for (const list of plan.lists) {
    console.log(`\n- ${list.title} [${list.kind}]`);
    console.log(`  id: ${list.id}`);
    console.log(`  resolved: ${list.resolved.length}/${list.items.length}`);
    console.log(`  preview: ${list.resolved.slice(0, 6).map(displayTitle).join(" | ")}`);
  }
  if (plan.missing.length) {
    console.log("\nMissing items:");
    plan.missing.forEach((m) => console.log(`- ${m.listTitle}: ${JSON.stringify(m.item)}`));
  }

  if (!WRITE) {
    console.log("\n[dry-run] no writes. Re-run with --write.");
    return;
  }

  await writeLists(db, plan.lists);
  console.log("\nDone.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
