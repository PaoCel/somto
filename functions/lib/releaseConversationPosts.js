"use strict";

const { publishOfficialUpdate, slugify } = require("./officialUpdates");
const { safeArray } = require("./pureUtils");
const { DEFAULT_TASTE_AUDIENCE_LIMIT } = require("./tasteAudience");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 2 * DAY_MS;
const DEFAULT_LOOKAHEAD_MS = 45 * DAY_MS;
const DEFAULT_SYNC_LIMIT = 20;
// Quanto indietro si guarda per decidere che un post scritto a mano ha gia'
// coperto la stessa uscita. E' generoso apposta: un pezzo editoriale su un
// ritorno di stagione esce settimane prima della data, e in quella finestra il
// post automatico non aggiunge niente.
const DUPLICATE_LOOKBACK_MS = 60 * DAY_MS;
const MAX_EXISTING_PER_TITLE = 5;
// Anteprima di festival (1) e supporto fisico (5): nessuno dei due e' un
// "arriva dal". La fonte non li produce piu' (vedi pickRegionalMovieRelease),
// ma gli eventi gia' scritti restano, quindi il filtro serve lo stesso.
const SKIPPED_RELEASE_TYPES = new Set([1, 5]);

const ROME_DATE_FORMATTER = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "numeric",
  month: "long",
});

function safeText(value, max = 240) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return Number(value.toMillis());
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  if (typeof value?._seconds === "number") return value._seconds * 1000;
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function releaseConversationSlug(eventId) {
  return slugify(`uscita-${safeText(eventId, 220)}`);
}

function releaseConversationPostId(eventId) {
  const slug = releaseConversationSlug(eventId);
  return slug ? `official_${slug}` : "";
}

function providerName(title = {}) {
  const names = Array.isArray(title.watchProviderNames) ? title.watchProviderNames : [];
  const direct = names.map((name) => safeText(name, 60)).find((name) => name && !/\bchannel\b/i.test(name));
  if (direct) return direct;
  const logos = Array.isArray(title.watchProviderLogos) ? title.watchProviderLogos : [];
  return logos.map((row) => safeText(row?.name, 60)).find((name) => name && !/\bchannel\b/i.test(name))
    || logos.map((row) => safeText(row?.name, 60)).find(Boolean)
    || "";
}

function movieReleasePhrase(releaseType) {
  switch (Math.floor(Number(releaseType))) {
  case 2:
  case 3:
    return "al cinema";
  case 4:
    return "in streaming";
  case 6:
    return "in TV";
  default:
    return "";
  }
}

// Pagine editoriali di destinazione. Un post che esce sempre dallo stesso
// account non da' a nessuno un motivo per seguire qualcosa in particolare;
// dirottarlo per tema si': chi segue "Crime e thriller" riceve quello, non le
// uscite family.
const PAGE_UPCOMING_MOVIES = "page_uscite";
const PAGE_TRENDING_SERIES = "page_serie";
const PAGE_CRIME = "page_crime";
const PAGE_ANIME = "page_anime";

const TMDB_GENRE_ANIMATION = "tmdb_16";
const TMDB_GENRE_CRIME = "tmdb_80";
// "Animazione" da sola e' Pixar quanto Ghibli: serve anche la provenienza.
const ANIME_LANGUAGES = new Set(["ja"]);
const ANIME_COUNTRIES = new Set(["JP"]);

/**
 * A quale pagina appartiene un'uscita.
 *
 * Prima il tema (anime, crime), poi il formato: una serie crime va su "Crime e
 * thriller", non su "Serie del momento". Il genere thriller (53) NON entra nel
 * crime: e' appiccicato a mezzo catalogo horror e svuoterebbe le altre pagine.
 */
function pageForRelease(title = {}, mediaType = "movie") {
  const genres = new Set(safeArray(title.genres).map((value) => String(value)));
  const language = String(title.meta?.originalLanguage || "").trim().toLowerCase();
  const countries = safeArray(title.meta?.originCountry).map((value) => String(value).toUpperCase());

  if (genres.has(TMDB_GENRE_ANIMATION)
    && (ANIME_LANGUAGES.has(language) || countries.some((code) => ANIME_COUNTRIES.has(code)))) {
    return PAGE_ANIME;
  }
  if (genres.has(TMDB_GENRE_CRIME)) return PAGE_CRIME;
  return mediaType === "tv" ? PAGE_TRENDING_SERIES : PAGE_UPCOMING_MOVIES;
}


// Il copy scritto dalla routine editoriale locale, quando c'e' e regge.
//
// PERCHE' C'E' UN VALIDATORE — il template qui sotto e' povero ma ha due
// proprieta' che un testo scritto altrove non ha per forza, e sono quelle che
// tengono in piedi il resto del sistema:
//
//  1. **dice la data giusta.** Se il testo non contiene la data che stiamo
//     pubblicando, il post e la scheda titolo si contraddicono.
//  2. **resta vero prima e dopo l'uscita.** Il post viene aggiornato sullo
//     stesso slug se TMDB corregge la data: "esce domani" diventerebbe falso da
//     solo e ci obbligherebbe a creare una seconda notizia.
//
// In piu' non si esita su un fatto che noi abbiamo come `structured`: e' l'errore
// del 2026-08-28, un post che scriveva "non e' ancora confermato" mentre
// l'evento in database era pubblicato e la piattaforma aveva gia' annunciato.
//
// Un copy che non passa non blocca niente: si pubblica il template.
const TIME_RELATIVE_RE = /\b(oggi|domani|ieri|stasera|stanotte|questa settimana|la settimana prossima|fra pochi giorni|tra pochi giorni)\b/i;
const HEDGING_RE = /\b(forse|dovrebbe|sembrerebbe|non e' (?:ancora )?confermat|non ancora confermat|pare che|si vocifera)/i;
const MAX_COPY_TITLE = 120;
const MAX_COPY_TEXT = 1200;

function pickConversationCopy({ copy, date, fallback }) {
  const title = safeText(copy?.title, MAX_COPY_TITLE);
  const text = String(copy?.text == null ? "" : copy.text).trim().slice(0, MAX_COPY_TEXT);
  if (!title || !text) return fallback;
  if (!text.includes(date)) return fallback;
  if (TIME_RELATIVE_RE.test(text) || TIME_RELATIVE_RE.test(title)) return fallback;
  if (HEDGING_RE.test(text) || HEDGING_RE.test(title)) return fallback;

  const summary = safeText(copy?.summary, 240) || text.split(/[.?!]/)[0].trim().slice(0, 240);
  return { title, text, summary, source: "editorial" };
}

/**
 * Il template e' la voce di quasi tutto il feed delle uscite: con una frase
 * sola, dieci uscite di fila sono dieci fotocopie con dentro un nome diverso.
 * Le varianti qui sotto dicono lo stesso fatto in modi diversi.
 *
 * PERCHE' DETERMINISTICO E NON A CASO — la sync riscrive lo stesso slug a ogni
 * giro. Pescando a caso, il testo cambierebbe sotto gli occhi di chi l'ha gia'
 * letto ogni sei ore. L'indice esce da un hash dello slug, che per un evento
 * non cambia mai: stessa uscita, stessa frase, per sempre.
 *
 * Non tutte chiudono con una domanda: tre post di fila che chiedono qualcosa
 * suonano come un sondaggio, non come una notizia.
 */
function pickVariant(seed, variants) {
  let hash = 5381;
  const text = String(seed || "");
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return variants[hash % variants.length];
}

/**
 * Converte un fatto strutturato in copy editoriale volutamente neutro nel
 * tempo: la stessa frase resta vera prima e dopo il giorno di uscita, quindi
 * una correzione aggiorna lo stesso post senza creare una seconda notizia.
 */
function buildReleaseConversationInput({ eventId, event = {}, title = {}, nowMs = Date.now() } = {}) {
  const id = safeText(eventId || event.id, 240);
  const titleId = safeText(event.titleId, 160);
  const name = safeText(title.name || title.title, 160);
  const effectiveAtMs = toMillis(event.effectiveAt);
  const eventType = safeText(event.eventType, 40);
  const mediaType = safeText(event.mediaType || title.type, 20).toLowerCase();
  const season = Math.floor(Number(event.season));
  const episode = Math.floor(Number(event.episode));

  if (!id || !titleId || !name || title.status !== "approved") return null;
  if (event.status !== "published" || event.reviewReason) return null;
  if (!Number.isFinite(effectiveAtMs)) return null;
  if (effectiveAtMs < nowMs - DEFAULT_LOOKBACK_MS || effectiveAtMs > nowMs + DEFAULT_LOOKAHEAD_MS) return null;
  if (safeText(event.sourceTrust, 40) === "unverified") return null;

  const date = ROME_DATE_FORMATTER.format(new Date(effectiveAtMs));
  const slug = releaseConversationSlug(id);
  if (!slug) return null;
  let updateType;
  let headline;
  let text;

  if (eventType === "release_date" && mediaType !== "tv") {
    if (safeText(event.region, 2).toUpperCase() !== "IT") return null;
    if (SKIPPED_RELEASE_TYPES.has(Math.floor(Number(event.releaseType)))) return null;
    const destination = movieReleasePhrase(event.releaseType);
    const when = destination ? `${destination} dal ${date}` : `dal ${date}`;
    headline = `${name}: ${when}`;
    text = pickVariant(slug, [
      `${name} arriva ${when}. Lo aspettavi?`,
      `Data fissata per ${name}: ${when}.`,
      `${name} esce ${when}.`,
      `${name}, ${when}. Chi lo stava aspettando puo' segnarselo.`,
    ]);
    updateType = "release_date";
  } else if (eventType === "new_episode" && mediaType === "tv" && episode === 1 && season >= 1) {
    const platform = providerName(title);
    // Senza un segnale di disponibilita' italiana rischieremmo di annunciare
    // stagioni di serie che qui non sono distribuite.
    if (!platform) return null;
    const where = ` su ${platform}`;
    if (season === 1) {
      headline = `${name}: dal ${date}${where}`;
      text = pickVariant(slug, [
        `${name} debutta il ${date}${where}. Ti incuriosisce?`,
        `${name} parte il ${date}${where}: e' una prima stagione, quindi si comincia da zero.`,
        `Dal ${date}${where} c'e' ${name}.`,
      ]);
    } else {
      headline = `Stagione ${season} di ${name}: dal ${date}`;
      text = pickVariant(slug, [
        `La stagione ${season} di ${name} comincia il ${date}${where}. La guarderai subito?`,
        `${name} torna con la stagione ${season} il ${date}${where}.`,
        `Stagione ${season} di ${name}: si riparte il ${date}${where}.`,
      ]);
    }
    updateType = "new_season";
  } else {
    return null;
  }

  const copy = pickConversationCopy({
    copy: event.editorialCopy,
    date,
    fallback: { title: headline, text, summary: text.split("?")[0].trim().slice(0, 240), source: "template" },
  });
  return {
    slug,
    title: copy.title,
    text: copy.text,
    summary: copy.summary,
    copySource: copy.source,
    updateType,
    linkedTitleIds: [titleId],
    sourceUrls: [safeText(event.sourceUrl, 600)].filter(Boolean),
    status: "published",
    notificationsEnabled: false,
    // E' il caso che il pubblico per affinita' esiste per risolvere: un film
    // uscito ieri non ce l'ha in libreria nessuno, per costruzione. Solo feed:
    // `notificationsEnabled: false` sopra vale anche per loro.
    tasteAudienceLimit: DEFAULT_TASTE_AUDIENCE_LIMIT,
    authorUid: pageForRelease(title, mediaType),
    sourceEventId: id,
    sourceEffectiveAt: effectiveAtMs,
  };
}

/**
 * Un post automatico e' ridondante se sullo stesso titolo esiste gia' un post
 * pubblicato che dice la stessa cosa.
 *
 * PERCHE' — il 2026-08-28 un pacchetto editoriale ha pubblicato "The Diplomat 4"
 * con la data del 15 ottobre; due giorni dopo la stessa data sarebbe entrata
 * nella finestra di questa sync e avrebbe generato "Stagione 4 di The Diplomat:
 * dal 15 ottobre". Stessa notizia, stesso titolo, stesso link, due card di
 * fila: per chi legge non c'e' niente in piu' nella seconda.
 *
 * Vince sempre l'esistente, anche quando e' piu' povero: e' quello che puo'
 * avere contesto, fonti e commenti, e comunque riscriverlo qui significherebbe
 * sovrascrivere un pezzo scritto a mano con un template.
 *
 * Due modi di riconoscere la stessa notizia:
 *  - il post porta una data (`sourceEffectiveAt`): stessa data, stesso tipo.
 *  - il post non ce l'ha, cioe' e' scritto a mano: stesso tipo e pubblicato di
 *    recente. Senza data non c'e' modo di essere piu' precisi, e sbagliare per
 *    eccesso di prudenza qui costa un post automatico in meno, non un errore.
 */
function isRedundantConversation(input = {}, existingRows = [], nowMs = Date.now()) {
  const rows = Array.isArray(existingRows) ? existingRows : [];
  return rows.some((row) => {
    if (!row || row.status !== "published") return false;
    if (safeText(row.slug, 220) === input.slug) return false;
    if (safeText(row.updateType, 40) !== input.updateType) return false;

    const rowEffectiveAt = toMillis(row.sourceEffectiveAt);
    if (Number.isFinite(rowEffectiveAt)) {
      return romeDayKey(rowEffectiveAt) === romeDayKey(input.sourceEffectiveAt);
    }
    const publishedAt = toMillis(row.publishedAt) ?? toMillis(row.updatedAt);
    return Number.isFinite(publishedAt) && nowMs - publishedAt <= DUPLICATE_LOOKBACK_MS;
  });
}

/** `YYYYMMDD` a Roma: due post sullo stesso giorno sono lo stesso giorno. */
function romeDayKey(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Number(ms)));
}

function splitRedundantConversations(inputs, existingByTitle, nowMs = Date.now()) {
  const byTitle = existingByTitle instanceof Map ? existingByTitle : new Map();
  const kept = [];
  const redundant = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    const titleId = safeArray(input.linkedTitleIds)[0] || "";
    if (isRedundantConversation(input, byTitle.get(titleId) || [], nowMs)) {
      redundant.push(input.sourceEventId);
    } else {
      kept.push(input);
    }
  }
  return { kept, redundant };
}

/** Una query per titolo: gira ogni sei ore su qualche decina di titoli. */
async function fetchExistingUpdatesByTitle({ db, titleIds }) {
  const ids = [...new Set(safeArray(titleIds).map((id) => safeText(id, 160)).filter(Boolean))];
  const out = new Map();
  await Promise.all(ids.map(async (titleId) => {
    try {
      const snap = await db.collection("officialUpdates")
        .where("linkedTitleIds", "array-contains", titleId)
        .where("status", "==", "published")
        .orderBy("publishedAt", "desc")
        .limit(MAX_EXISTING_PER_TITLE)
        .get();
      out.set(titleId, (snap.docs || []).map((doc) => ({ slug: doc.id, ...(doc.data() || {}) })));
    } catch (_) {
      // Una query che fallisce non deve bloccare la sync: al massimo torna il
      // comportamento di prima, cioe' nessuna deduplica per quel titolo.
      out.set(titleId, []);
    }
  }));
  return out;
}

async function fetchCandidateEvents({ db, admin, nowMs, lookbackMs, lookaheadMs, perTypeLimit }) {
  const start = admin.firestore.Timestamp.fromMillis(nowMs - lookbackMs);
  const end = admin.firestore.Timestamp.fromMillis(nowMs + lookaheadMs);
  const base = (eventType) => db.collection("titleUpdateEvents")
    .where("eventType", "==", eventType)
    .where("status", "==", "published");

  const releaseQuery = base("release_date")
    .where("effectiveAt", ">=", start)
    .where("effectiveAt", "<=", end)
    .orderBy("effectiveAt", "asc")
    .limit(perTypeLimit);
  const premiereQuery = base("new_episode")
    .where("episode", "==", 1)
    .where("effectiveAt", ">=", start)
    .where("effectiveAt", "<=", end)
    .orderBy("effectiveAt", "asc")
    .limit(perTypeLimit);

  const [releases, premieres] = await Promise.all([releaseQuery.get(), premiereQuery.get()]);
  const unique = new Map(
    [...(releases.docs || []), ...(premieres.docs || [])]
      .map((doc) => [doc.id, { id: doc.id, ...(doc.data() || {}) }])
  );
  return [...unique.values()]
    .sort((left, right) => (toMillis(left.effectiveAt) || 0) - (toMillis(right.effectiveAt) || 0));
}

async function fetchByRefs(db, refs) {
  if (!refs.length) return [];
  if (typeof db.getAll === "function") return db.getAll(...refs);
  return Promise.all(refs.map((ref) => ref.get()));
}

function samePublishedConversation(existing = {}, input = {}) {
  return existing.status === "published"
    && existing.sourceEventId === input.sourceEventId
    && toMillis(existing.sourceEffectiveAt) === input.sourceEffectiveAt
    && existing.title === input.title
    && existing.text === input.text;
}

function selectBalancedConversationInputs(inputs, limit) {
  const cap = Math.max(1, Math.floor(Number(limit) || DEFAULT_SYNC_LIMIT));
  const rows = Array.isArray(inputs) ? inputs : [];
  const perKind = Math.ceil(cap / 2);
  const selected = [
    ...rows.filter((input) => input.updateType === "release_date").slice(0, perKind),
    ...rows.filter((input) => input.updateType === "new_season").slice(0, perKind),
  ];
  const selectedIds = new Set(selected.map((input) => input.sourceEventId));
  const filler = rows
    .filter((input) => !selectedIds.has(input.sourceEventId))
    .slice(0, Math.max(0, cap - selected.length));
  return [...selected, ...filler]
    .sort((left, right) => left.sourceEffectiveAt - right.sourceEffectiveAt);
}

function planConversationSync(inputs, existingBySlug, limit) {
  const existing = existingBySlug instanceof Map ? existingBySlug : new Map();
  const skipped = [];
  const pending = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (samePublishedConversation(existing.get(input.slug) || {}, input)) {
      skipped.push(input.sourceEventId);
    } else {
      pending.push(input);
    }
  }
  return {
    skipped,
    selected: selectBalancedConversationInputs(pending, limit),
  };
}

async function syncReleaseConversationPosts({
  db,
  admin,
  nowMs = Date.now(),
  lookbackMs = DEFAULT_LOOKBACK_MS,
  lookaheadMs = DEFAULT_LOOKAHEAD_MS,
  limit = DEFAULT_SYNC_LIMIT,
  publish = publishOfficialUpdate,
} = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  const cap = Math.max(1, Math.min(50, Math.floor(Number(limit) || DEFAULT_SYNC_LIMIT)));
  const events = await fetchCandidateEvents({
    db,
    admin,
    nowMs,
    lookbackMs,
    lookaheadMs,
    perTypeLimit: Math.max(cap, 20),
  });

  const titleIds = [...new Set(events.map((event) => safeText(event.titleId, 160)).filter(Boolean))];
  const titleRefs = titleIds.map((id) => db.collection("titles").doc(id));
  const titleSnaps = await fetchByRefs(db, titleRefs);
  const titles = new Map(titleSnaps.filter((snap) => snap?.exists).map((snap) => [snap.id, snap.data() || {}]));
  const eligibleInputs = events
    .map((event) => buildReleaseConversationInput({
      eventId: event.id,
      event,
      title: titles.get(event.titleId) || {},
      nowMs,
    }))
    .filter(Boolean);
  // Prima del cap: un doppione che occupa uno slot toglierebbe il posto a
  // un'uscita che non ha ancora nessun post.
  const existingByTitle = await fetchExistingUpdatesByTitle({
    db,
    titleIds: eligibleInputs.map((input) => safeArray(input.linkedTitleIds)[0]),
  });
  const { kept, redundant } = splitRedundantConversations(eligibleInputs, existingByTitle, nowMs);

  const updateRefs = kept.map((input) => db.collection("officialUpdates").doc(input.slug));
  const updateSnaps = await fetchByRefs(db, updateRefs);
  const existingBySlug = new Map(updateSnaps.filter((snap) => snap?.exists).map((snap) => [snap.id, snap.data() || {}]));
  // Si escludono PRIMA i thread gia' allineati: applicare il cap prima di
  // questo filtro riselezionerebbe per sempre lo stesso primo batch e
  // lascerebbe la coda successiva senza post.
  const plan = planConversationSync(kept, existingBySlug, cap);
  // Una pagina mancante non deve far fallire l'intero giro: si pubblica come
  // Somto, che e' sempre presente. Una lettura per pagina, non per post.
  const wantedPages = [...new Set(plan.selected.map((input) => input.authorUid).filter(Boolean))];
  const pageSnaps = await fetchByRefs(db, wantedPages.map((uid) => db.collection("users").doc(uid)));
  const livePages = new Set(pageSnaps
    .filter((snap) => snap?.exists && snap.data()?.accountType === "page")
    .map((snap) => snap.id));
  const inputs = plan.selected.map((input) => (
    livePages.has(input.authorUid) ? input : { ...input, authorUid: undefined }
  ));
  const report = {
    candidates: events.length,
    eligible: eligibleInputs.length,
    redundant,
    selected: inputs.length,
    published: [],
    updated: [],
    skipped: plan.skipped,
    failed: [],
  };

  for (const input of inputs) {
    const existing = existingBySlug.get(input.slug) || null;
    try {
      await publish({ db, admin, input, requestedByUid: "system:title-update" });
      (existing ? report.updated : report.published).push(input.sourceEventId);
    } catch (err) {
      report.failed.push({
        eventId: input.sourceEventId,
        error: safeText(err?.message || err, 240),
      });
    }
  }

  return report;
}

module.exports = {
  DEFAULT_LOOKAHEAD_MS,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_SYNC_LIMIT,
  buildReleaseConversationInput,
  isRedundantConversation,
  pickConversationCopy,
  splitRedundantConversations,
  pageForRelease,
  movieReleasePhrase,
  providerName,
  planConversationSync,
  releaseConversationPostId,
  releaseConversationSlug,
  selectBalancedConversationInputs,
  samePublishedConversation,
  syncReleaseConversationPosts,
  toMillis,
};
