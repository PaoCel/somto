"use strict";

// Sagas quiz: raggruppa i titoli che hanno domande in franchise giocabili
// (es. Harry Potter = 8 film = 396 domande) così una partita puo' pescare da
// tutti i titoli della saga invece che da un solo titolo.
//
// Modulo puro: nessuna dipendenza da Firebase/Firestore, cosi' e' testabile
// senza credenziali (stesso approccio di functions/lib/quizCorpusAudit.js).
// Chi lo usa (functions/index.js) legge quizMeta/themes + i doc titles e
// passa i dati gia' pronti a buildQuizSagas.
//
// Due fonti di saghe:
//  - MANUAL_QUIZ_SAGAS: elenchi scritti a mano per i casi che TMDB non copre
//    (serie TV, o collection TMDB incomplete/mancanti su alcuni titoli).
//  - saghe derivate da TMDB: titles.collectionId/collectionName, per tutto
//    il resto (es. "Il Signore degli Anelli", "Avatar", "Il cavaliere
//    oscuro" non hanno bisogno di un elenco manuale perche' TMDB le
//    raggruppa gia' correttamente).
// Le saghe manuali hanno SEMPRE precedenza: un titleId elencato in una saga
// manuale non finisce mai anche in una saga TMDB, anche se la saga manuale
// stessa poi non supera la soglia di pubblicazione (vedi buildQuizSagas).

// ---------------------------------------------------------------------------
// Saghe manuali
//
// Id verificati su prod (progetto gia-visto) il 2026-08-27, leggendo
// quizMeta/themes + i doc titles con l'admin SDK (script temporaneo,
// cancellato dopo l'uso). Per rigenerare/aggiornare questi elenchi:
//   1. node scripts/tmp-list-quiz-themes.js (o equivalente): dump di
//      quizMeta/themes (titleId, mediaType, count, title).
//   2. Per ogni candidato, leggere titles/{titleId} e controllare
//      collectionId/collectionName: se TMDB raggruppa gia' tutti i titoli
//      della saga sotto lo stesso collectionId, NON serve una saga manuale
//      (buildQuizSagas la deriva da sola). Le saghe qui sotto esistono
//      perche' TMDB non basta: Dragon Ball/Star Wars sono in TV o hanno
//      titoli senza collectionId, MCU e' l'unione voluta di piu' collection
//      TMDB distinte (Iron Man, Avengers, Captain America, Thor, Guardiani,
//      Ant-Man, ...) che altrimenti resterebbero saghe separate.
// ---------------------------------------------------------------------------
const MANUAL_QUIZ_SAGAS = [
  {
    sagaId: "dragon-ball",
    name: "Dragon Ball",
    mediaType: "tv",
    // Le collection TMDB esistono solo per i film: le serie TV Dragon Ball
    // non hanno mai un collectionId, quindi TMDB da solo non le raggruppa.
    titleIds: [
      "tmdb_tv_12609", // Dragon Ball
      "tmdb_tv_12971", // Dragon Ball Z
      "tmdb_tv_62715", // Dragon Ball Super
    ],
  },
  {
    sagaId: "star-wars",
    name: "Star Wars",
    mediaType: "movie",
    // La collection TMDB 10 ("Star Wars - Collezione") copre solo i primi
    // due film con quiz: "Il ritorno dello Jedi" (tmdb_movie_1892) in prod
    // non ha collectionId valorizzato e resterebbe fuori da un raggruppamento
    // puramente TMDB.
    titleIds: [
      "tmdb_movie_11",   // Guerre stellari (Episodio IV - Una nuova speranza)
      "tmdb_movie_1891", // Guerre stellari - L'Impero colpisce ancora (Ep. V)
      "tmdb_movie_1892", // Il ritorno dello Jedi (Ep. VI) - senza collectionId
    ],
  },
  {
    sagaId: "animali-fantastici",
    name: "Animali Fantastici",
    mediaType: "movie",
    // Stesso problema di Star Wars: la collection TMDB 435259 copre solo 2
    // dei 3 film con quiz, "I crimini di Grindelwald" (tmdb_movie_338952)
    // non ha collectionId valorizzato su prod.
    titleIds: [
      "tmdb_movie_259316", // Animali fantastici e dove trovarli
      "tmdb_movie_338952", // Animali fantastici - I crimini di Grindelwald - senza collectionId
      "tmdb_movie_338953", // Animali fantastici - I segreti di Silente
    ],
  },
  {
    sagaId: "mcu",
    name: "Marvel Cinematic Universe",
    mediaType: "movie",
    // Questa saga assorbe DELIBERATAMENTE piu' collection TMDB distinte
    // (Iron Man 131292, Avengers 86311, Captain America 131295, Thor 131296,
    // Guardiani della Galassia 284433, Ant-Man 422834, + i film che su TMDB
    // sono "collection" a se stanti con un solo titolo nel corpus quiz:
    // Doctor Strange, Captain Marvel, L'incredibile Hulk): senza la saga
    // manuale resterebbero N sotto-saghe separate invece di un unico MCU.
    // Black Widow non ha nessuna collection TMDB. Spider-Man: No Way Home e'
    // incluso: il suo collectionId TMDB (531241) e' "Spider-Man (MCU) -
    // Collezione", distinto dalla trilogia Raimi pre-MCU (collectionId 556,
    // "Spider-Man - Collezione", ESCLUSA di proposito). WandaVision e Loki
    // sono MCU ma sono serie TV (mediaType "tv"): fuori scope per questa
    // saga, che e' mediaType "movie".
    titleIds: [
      "zqbaPX3pHXH3VfgcXu2L", // Iron Man
      "GYiDJJNsFx85TnQ05q4x", // Iron Man 2
      "olNTO6I6Iw94Wp0Xg0nO", // Iron Man 3
      "DWVQmSbZEck16t2oR68B", // The Avengers
      "R6R1B7iRYbizLe6bfX3Z", // Avengers: Age of Ultron
      "EbSt5Fmg8st2IVUBmWSG", // Avengers: Infinity War
      "qQ4r5r9cMIHAqPvxHZdP", // Avengers: Endgame
      "V5A72I9VSAPPg9sZVD63", // Captain America - Il primo vendicatore
      "OriQsuc6ynvyf9akXncH", // Captain America: The Winter Soldier
      "jaYlUwKfH1vr9LbDc5ct", // Captain America: Civil War
      "gE9O24xYJX3GW6mUgZ28", // Thor
      "odzIfRliBUUKCyvDmmaw", // Thor: The Dark World
      "u7IAl1NtdYnjiK7WTKgD", // Guardiani della Galassia
      "2aSooxHyUn8JWv5htSWg", // Guardiani della Galassia Vol. 2
      "SEX2mqkZidesO01tHw9i", // Ant-Man
      "UpVSI3B4o9cCZltZYLkr", // Ant-Man and the Wasp
      "CdhT1DVQVoj3JAdlm69O", // Doctor Strange
      "szd940awz1QStBrRdsrK", // Captain Marvel
      "DqJB47mczfg7BSEUVMY4", // Black Widow
      "tmdb_movie_1724",      // L'incredibile Hulk
      "vx1lDhBGcYtWFOHorkNS", // Deadpool & Wolverine
      "erJj0AxaAwYFzwgjTgrc", // Spider-Man: No Way Home
    ],
  },
];

// Soglie di pubblicazione (manuali E derivate da TMDB): sotto questi valori
// una "saga" non aggiungerebbe niente di giocabile in piu' rispetto a
// giocare i singoli titoli, quindi non la mostriamo.
const MIN_SAGA_TITLES = 2;
const MIN_SAGA_QUESTION_COUNT = 10;

// Suffissi delle collection TMDB da togliere prima di slugificare (e per
// pulire il nome mostrato delle saghe derivate da TMDB): "Harry Potter -
// Collezione" / "Harry Potter Collection" / "Harry Potter - Saga" → "Harry
// Potter". Richiede uno spazio o un trattino prima del suffisso, cosi' non
// tocca per errore parole che contengono "saga" ecc. a caso.
const SAGA_SUFFIX_RE = /(\s*[-–—]\s*|\s+)(collezione|collection|saga)\s*$/i;

function stripSagaSuffix(name) {
  return String(name || "").trim().replace(SAGA_SUFFIX_RE, "").trim();
}

/**
 * Slug kebab-case senza accenti, per usare il nome di una saga come id
 * leggibile. Es. "Harry Potter - Collezione" -> "harry-potter".
 */
function buildSagaSlug(name) {
  const stripped = stripSagaSuffix(name);
  return stripped
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // rimuove i segni diacritici (accenti)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Stesso ordinamento di rebuildQuizThemesAggregate: count decrescente, poi
// nome (cosi' l'elenco titoli dentro una saga e' deterministico e stabile
// anche quando i conteggi sono identici, come i 25 di ogni film Marvel).
function sortMembers(members) {
  return members.slice().sort((a, b) => {
    const bc = Number(b.count) || 0;
    const ac = Number(a.count) || 0;
    if (bc !== ac) return bc - ac;
    return String(a.title || "").localeCompare(String(b.title || ""), "it");
  });
}

function finalizeSaga({ sagaId, name, mediaType, members, source }) {
  if (!Array.isArray(members) || members.length < MIN_SAGA_TITLES) return null;
  const count = members.reduce((sum, m) => sum + (Number(m.count) || 0), 0);
  if (count < MIN_SAGA_QUESTION_COUNT) return null;
  const sorted = sortMembers(members);
  return {
    sagaId,
    name,
    mediaType,
    titleIds: sorted.map((m) => m.titleId),
    titles: sorted.map((m) => m.title),
    count,
    source,
  };
}

/**
 * Costruisce l'elenco saghe a partire dai temi giocabili (quizMeta/themes)
 * e dai dati titles necessari a raggruppare per collection TMDB. Funzione
 * pura: nessuna chiamata Firestore qui dentro, cosi' e' testabile a secco.
 *
 * @param {Object} params
 * @param {Array<{titleId:string,title:string,mediaType:string,count:number}>} params.themes
 * @param {Map<string,Object>|Object<string,Object>} params.titlesById - titleId -> {collectionId, collectionName, name, type}
 * @param {Array} [params.manualSagas] - default MANUAL_QUIZ_SAGAS, override nei test
 * @returns {Array<{sagaId:string,name:string,mediaType:string,titleIds:string[],titles:string[],count:number,source:"tmdb"|"manual"}>}
 *   ordinato per count decrescente.
 */
function buildQuizSagas({ themes, titlesById, manualSagas = MANUAL_QUIZ_SAGAS } = {}) {
  const themeList = Array.isArray(themes) ? themes : [];
  const themeByTitleId = new Map();
  for (const theme of themeList) {
    if (theme && theme.titleId) themeByTitleId.set(theme.titleId, theme);
  }
  const titlesMap = titlesById instanceof Map ? titlesById : new Map(Object.entries(titlesById || {}));
  const manualList = Array.isArray(manualSagas) ? manualSagas : [];

  // Un titleId elencato in QUALSIASI saga manuale e' "riservato": non entra
  // mai nel raggruppamento TMDB, anche se quella saga manuale poi non supera
  // la soglia di pubblicazione (evita di far ricomparire come mini-saga TMDB
  // dei titoli che a mano abbiamo deciso di accorpare altrove).
  const claimedTitleIds = new Set();
  for (const saga of manualList) {
    for (const titleId of saga.titleIds || []) claimedTitleIds.add(titleId);
  }

  const sagas = [];

  for (const saga of manualList) {
    const members = (saga.titleIds || [])
      .map((titleId) => themeByTitleId.get(titleId))
      .filter(Boolean);
    const built = finalizeSaga({
      sagaId: saga.sagaId,
      name: saga.name,
      mediaType: saga.mediaType,
      members,
      source: "manual",
    });
    if (built) sagas.push(built);
  }

  // Raggruppamento TMDB: tutti i temi NON riservati da una saga manuale,
  // raggruppati per titles.collectionId (solo se titles ha sia collectionId
  // che collectionName valorizzati).
  const collectionGroups = new Map(); // collectionId (string) -> { collectionName, members: [] }
  for (const theme of themeList) {
    if (!theme || !theme.titleId || claimedTitleIds.has(theme.titleId)) continue;
    const titleInfo = titlesMap.get(theme.titleId);
    const collectionId = titleInfo && Number(titleInfo.collectionId) > 0 ? Number(titleInfo.collectionId) : 0;
    const collectionName = titleInfo && titleInfo.collectionName ? String(titleInfo.collectionName).trim() : "";
    if (!collectionId || !collectionName) continue;
    const key = String(collectionId);
    if (!collectionGroups.has(key)) collectionGroups.set(key, { collectionName, members: [] });
    collectionGroups.get(key).members.push(theme);
  }

  // Il sagaId e' la chiave del deep link (/quiz-prova.html?saga=harry-potter):
  // due saghe con lo stesso id renderebbero il link ambiguo e la seconda
  // irraggiungibile. Slug gia' preso -> si ripiega sul collectionId TMDB, che
  // e' unico per definizione.
  const usedSagaIds = new Set(sagas.map((s) => s.sagaId));

  for (const [collectionId, group] of collectionGroups) {
    const cleanName = stripSagaSuffix(group.collectionName) || group.collectionName;
    const slug = buildSagaSlug(group.collectionName);
    const sagaId = (!slug || usedSagaIds.has(slug)) ? `collection-${collectionId}` : slug;
    usedSagaIds.add(sagaId);
    const built = finalizeSaga({
      sagaId,
      name: cleanName,
      mediaType: group.members[0]?.mediaType || "movie",
      members: group.members,
      source: "tmdb",
    });
    if (built) sagas.push(built);
  }

  sagas.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.name).localeCompare(String(b.name), "it");
  });

  return sagas;
}

module.exports = {
  MANUAL_QUIZ_SAGAS,
  MIN_SAGA_TITLES,
  MIN_SAGA_QUESTION_COUNT,
  buildSagaSlug,
  buildQuizSagas,
};
