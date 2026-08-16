// Feed JSON pubblico delle prossime uscite.
//
//   upcomingReleasesFeed -> /prossime-uscite.json
//
// PERCHE' ESISTE — il widget iOS "Prossime uscite" non puo' parlare con
// Firebase. `FirebaseBootstrap.configureIfNeeded()` cerca la config con
// `Bundle.main`, che dentro un'estensione e' il `.appex` e non l'app (quindi
// `fatalError`), il keychain non e' condiviso fra app ed estensione, e
// `FirebaseFirestore` si porta dietro gRPC/BoringSSL, cioe' la dipendenza che
// da sola domina il budget di memoria di un widget. I dati delle uscite sono
// globali e pubblici: niente di tutto cio' serve. Il widget fa una GET con
// URLSession e legge questo JSON.
//
// Design (stesso modello di officialUpdatePage.js / titlePage.js):
//  * Admin SDK: le letture bypassano le rules, quindi il filtro va scritto a
//    mano e stretto. Qui si servono SOLO eventi `status: "published"` — cioe'
//    esattamente cio' che `firestore.rules` gia' concede in lettura a chiunque,
//    anche sloggato (`match /titleUpdateEvents/{eventId}`). Nessuna
//    informazione nuova viene esposta al web aperto.
//  * Il consumatore e' un widget: il payload e' piatto, gia' formattato e senza
//    campi da interpretare. Ogni normalizzazione (URL del poster, percorso del
//    deep link, data ISO) avviene qui, cosi' il client resta stupido.
//  * Cache generosa: le uscite cambiano di rado e un widget si aggiorna ogni
//    poche ore.
//
// Gli eventi vivono in `titleUpdateEvents` (id deterministico, vedi
// functions/lib/titleUpdateEventModel.js). Un evento ritirato passa a
// `status: "retired"` e sparisce da qui da solo.

const functions = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { releaseConversationPostId } = require("../lib/releaseConversationPosts");

const REGION = "europe-west1";
const SITE_URL = "https://somto.it";

// Quante uscite escono dal feed. Il widget ne mostra al massimo 3: il resto e'
// margine per le famiglie piu' grandi e per il futuro, senza diventare un
// payload che un'estensione deve scorrere.
const MAX_ITEMS = 10;

// Si leggono piu' eventi di quanti ne servano, PER TIPO: alcuni cadranno
// (titolo non approvato, senza nome, data da verificare, serie senza provider
// italiano) e senza margine il feed uscirebbe corto. Il 2026-08-14 delle 109
// premiere future solo 61 avevano il provider.
const QUERY_LIMIT = 40;

// Larghezza poster richiesta a TMDB. Un widget disegna una miniatura: scaricare
// il `w500` del sito significherebbe far pagare all'estensione ~5x i byte per
// pixel che non vedra' mai.
const POSTER_WIDTH = "w185";
// Il logo di una piattaforma nel widget e' alto quanto una riga di testo: w92
// e' gia' il doppio di quel che serve su uno schermo 3x.
const PROVIDER_LOGO_WIDTH = "w92";
const TMDB_IMAGE_HOST = "image.tmdb.org";

// Dove esce, non solo quando.
//
// `titleUpdateEvents.releaseType` e' il tipo TMDB della data scelta per l'Italia
// (vedi pickRegionalMovieRelease in lib/titleUpdateCandidates.js): 1 anteprima,
// 2 cinema limitato, 3 cinema, 4 digitale, 5 supporto fisico, 6 TV.
//
//  * 2 e 3 diventano "cinema": per chi guarda il widget la differenza fra
//    uscita piena e uscita limitata non cambia cosa fara' domani.
//  * 1 (anteprima) resta senza etichetta: una proiezione di festival non e'
//    un'uscita, e scriverci "Al cinema" prometterebbe un biglietto che non si
//    puo' comprare.
//  * 5 non e' un'uscita e basta: un Blu-ray in arrivo non va in vetrina fra le
//    prossime uscite. Vedi SKIPPED_RELEASE_TYPES.
//
// IL LOGO DELLA PIATTAFORMA CE L'HANNO SOLO LE SERIE, e la ragione e' nel dato:
// TMDB (via JustWatch) pubblica i provider quando il titolo e' *disponibile*.
// Un film che deve uscire non lo e' — 0 su 40 titoli in arrivo aveva
// `watchProviderNames` il 2026-08-14 — mentre una serie che torna con una
// stagione nuova e' gia' in catalogo su qualcuno: 61 premiere su 109 avevano il
// provider italiano. Quindi per i film si scrive dove esce ("Al cinema"), per
// le serie si mostra su cosa (vedi pickProvider).
const RELEASE_KIND_BY_TYPE = new Map([[2, "cinema"], [3, "cinema"], [4, "streaming"], [6, "tv"]]);
const SKIPPED_RELEASE_TYPES = new Set([5]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asTrimmedString(value, max = 600) {
  return String(value == null ? "" : value).slice(0, max).replace(/\s+/g, " ").trim();
}

function isTv(type) {
  return String(type || "").toLowerCase() === "tv";
}

function toIsoDate(value) {
  try {
    if (value && typeof value.toDate === "function") return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === "string" && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  } catch (_) { /* data illeggibile: si omette, non si inventa */ }
  return "";
}

/**
 * URL del poster, ridotto alla misura che serve a un widget.
 *
 * `titles.posterPath` su Somto contiene di norma un URL TMDB assoluto
 * (`https://image.tmdb.org/t/p/w500/xyz.jpg`), non un path relativo: si
 * riscrive solo il segmento della misura. Qualsiasi altro host https passa
 * intatto; tutto il resto e' `null`, cosi' il widget non deve difendersi da
 * uno schema http o da una stringa vuota.
 */
function normalizeTmdbImageUrl(value, width) {
  const raw = asTrimmedString(value, 600);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname.toLowerCase() === TMDB_IMAGE_HOST) {
    url.pathname = url.pathname.replace(/^\/t\/p\/[^/]+\//, `/t/p/${width}/`);
  }
  return url.toString().slice(0, 600);
}

function normalizePosterUrl(value) {
  return normalizeTmdbImageUrl(value, POSTER_WIDTH);
}

/**
 * La piattaforma su cui si vede, quando si sa.
 *
 * `titles.watchProviderLogos` e' gia' denormalizzato dallo scanner ed e' gia'
 * ordinato come TMDB lo serve per l'Italia (abbonamento, poi gratis, poi con
 * pubblicita'). Si prende il primo, con una preferenza: i "canali" venduti
 * dentro un altro servizio ("HBO Max Amazon Channel") sono lo stesso marchio
 * con una etichetta piu' lunga e un logo meno riconoscibile — se nella lista
 * c'e' anche la versione diretta, vince quella.
 */
function pickProvider(title) {
  const rows = Array.isArray(title && title.watchProviderLogos) ? title.watchProviderLogos : [];
  const usable = rows
    .map((row) => ({
      name: asTrimmedString(row && row.name, 60),
      logoUrl: normalizeTmdbImageUrl(row && row.logoUrl, PROVIDER_LOGO_WIDTH),
    }))
    .filter((row) => row.name && row.logoUrl);
  if (!usable.length) return null;
  return usable.find((row) => !/\bchannel\b/i.test(row.name)) || usable[0];
}

/**
 * Percorso in-app/web del titolo.
 *
 * Due forme, e la seconda non e' un ripiego estetico: su iOS
 * `nativeDestination(path:)` mappa `/film|/serie/<slug>` su `.titleSlug`, che
 * viene risolto con una query su `titles.slug` — un doc id li' non trova nulla
 * e il deep link muore in silenzio. `/share/title/<docId>` mappa invece
 * direttamente su `.title(id:)`. Quindi: slug quando c'e', altrimenti la forma
 * che funziona lo stesso.
 */
function titlePath(type, slug, docId) {
  const cleanSlug = asTrimmedString(slug, 256);
  if (cleanSlug) return `${isTv(type) ? "/serie/" : "/film/"}${encodeURIComponent(cleanSlug)}`;
  const cleanId = asTrimmedString(docId, 256);
  return cleanId ? `/share/title/${encodeURIComponent(cleanId)}` : "";
}

/**
 * L'occasione della riga: un film che esce, o una serie che torna.
 *
 * Serve al widget per scegliere cosa scrivere sotto al nome, e vale la pena
 * tenerlo separato da `releaseKind`: quello dice DOVE esce, questo COSA esce.
 * Un evento episodio che non e' una premiere torna `null` e viene scartato.
 */
function occasionForEvent(event) {
  const eventType = asTrimmedString(event && event.eventType, 40);
  if (eventType === "release_date") return "release";
  if (eventType !== "new_episode") return null;
  return Math.floor(Number(event && event.episode)) === 1 ? "season_premiere" : null;
}

function seasonNumber(event) {
  const season = Math.floor(Number(event && event.season));
  return season > 0 ? season : null;
}

function releaseKindFromType(value) {
  const type = Math.floor(Number(value));
  if (!Number.isFinite(type)) return null;
  return RELEASE_KIND_BY_TYPE.get(type) || null;
}

function isSkippedReleaseType(value) {
  const type = Math.floor(Number(value));
  return Number.isFinite(type) && SKIPPED_RELEASE_TYPES.has(type);
}

/**
 * Costruisce le voci del feed. Isolata dal trasporto perche' e' qui che stanno
 * le tre decisioni che contano, e sono tutte testabili senza Firestore:
 *
 *  1. **le uscite passate non entrano.** La query Firestore filtra gia'
 *     `effectiveAt > now`, ma questa risposta e' cacheata fino a un'ora e un
 *     widget puo' leggerla ancora piu' tardi: un film uscito ieri non e' una
 *     "prossima uscita". Il filtro va rifatto qui, sull'istante di rendering.
 *  2. **un titolo compare una volta sola.** Lo stesso film puo' avere piu'
 *     eventi `release_date` (uscite regionali, cinema + streaming): in ordine
 *     crescente vince il primo, cioe' la data piu' vicina.
 *  3. **si linka solo cio' che si apre.** Titolo non `approved` o senza nome =
 *     riga saltata: una card che porta a un 404 e' peggio di una card in meno.
 *  4. **una data da verificare non e' una data.** Un evento con `reviewReason`
 *     e' uno che la pipeline stessa ha marcato come non confermato — 22 su 53
 *     al 2026-08-14, tutti `missing_it_release_date`: TMDB non ha una data
 *     italiana e quella mostrata e' la globale. In un widget la data non ha
 *     sfumature: o e' quella, o non si scrive. Restano nella scheda titolo,
 *     dove l'headline dice "Data di uscita da verificare".
 *  5. **una serie che torna deve dire su cosa.** Senza provider italiano non
 *     entra: e' anche il filtro che tiene fuori il rumore. Fra le 109 premiere
 *     del 2026-08-14, le 48 senza provider erano soap e reality esteri mai
 *     arrivati in Italia (Ulice, Familie, Koh-Lanta), le 61 con provider erano
 *     serie che qualcuno qui puo' davvero guardare.
 */
function buildFeedItems({ events, titlesById, now = new Date(), max = MAX_ITEMS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const cap = Math.max(1, Math.min(MAX_ITEMS, Math.floor(Number(max) || MAX_ITEMS)));
  const titles = titlesById instanceof Map
    ? titlesById
    : new Map(Object.entries(titlesById || {}));

  const seenTitles = new Set();
  const items = [];
  // Si raccoglie piu' del cap perche' la selezione finale bilancia film e serie
  // (vedi selectBalanced): fermarsi a `cap` qui vorrebbe dire scegliere fra
  // quello che e' gia' stato scelto.
  const gathered = cap * 3;

  for (const event of Array.isArray(events) ? events : []) {
    if (items.length >= gathered) break;

    const titleId = asTrimmedString(event && event.titleId, 160);
    if (!titleId || seenTitles.has(titleId)) continue;
    // Prima di tutto il resto: un'uscita in DVD non e' una prossima uscita, un
    // episodio a meta' stagione non e' un ritorno, e una data che la pipeline
    // ha marcato da verificare non si mostra come certa.
    if (isSkippedReleaseType(event && event.releaseType)) continue;
    if (asTrimmedString(event && event.reviewReason, 120)) continue;
    const occasion = occasionForEvent(event);
    if (!occasion) continue;

    const releaseDate = toIsoDate(event && event.effectiveAt);
    if (!releaseDate) continue;
    const releaseMs = Date.parse(releaseDate);
    if (!Number.isFinite(releaseMs) || !Number.isFinite(nowMs) || releaseMs <= nowMs) continue;

    const title = titles.get(titleId);
    if (!title) continue;
    if (asTrimmedString(title.status, 40) !== "approved") continue;

    const name = asTrimmedString(title.name || title.originalName, 200);
    if (!name) continue;

    const path = titlePath(title.type, title.slug, titleId);
    if (!path) continue;

    const provider = pickProvider(title);
    // Una stagione che torna senza dire su cosa e' una riga a cui manca meta'
    // della risposta: si salta, e con lei il rumore delle soap estere.
    if (occasion === "season_premiere" && !provider) continue;

    seenTitles.add(titleId);
    items.push({
      id: asTrimmedString(event.id, 240) || titleId,
      // Identita' sociale condivisa fra Home e Community. E' deterministica,
      // quindi resta la stessa anche se TMDB corregge la data dell'evento.
      postId: releaseConversationPostId(event.id),
      titleId,
      name,
      type: isTv(title.type) ? "tv" : "movie",
      releaseDate,
      // Campi aggiunti senza toccare `version`: sono opzionali e i widget gia'
      // installati li ignorano. Alzare la versione li spegnerebbe tutti per
      // un'etichetta in piu'.
      releaseKind: releaseKindFromType(event.releaseType),
      occasion,
      season: occasion === "season_premiere" ? seasonNumber(event) : null,
      provider,
      posterUrl: normalizePosterUrl(title.posterPath),
      path,
      url: `${SITE_URL}${path}`,
    });
  }

  return selectBalanced(items, cap);
}

/**
 * Sceglie le voci finali tenendo insieme film e serie.
 *
 * Il feed e' ordinato per data, e le serie in onda hanno date fitte: senza un
 * tetto, dieci righe su dieci sarebbero premiere di stagione e il primo film in
 * uscita non si vedrebbe mai. Il tetto e' meta' delle righe — ma solo finche'
 * c'e' altro con cui riempirle: se di film non ce n'e' nessuno, le serie si
 * riprendono tutto lo spazio invece di lasciare il widget mezzo vuoto.
 */
function selectBalanced(items, cap) {
  const premiereCap = Math.ceil(cap / 2);
  const chosen = [];
  const leftovers = [];
  let premieres = 0;

  for (const item of items) {
    if (chosen.length >= cap) break;
    if (item.occasion === "season_premiere" && premieres >= premiereCap) {
      leftovers.push(item);
      continue;
    }
    if (item.occasion === "season_premiere") premieres += 1;
    chosen.push(item);
  }

  for (const item of leftovers) {
    if (chosen.length >= cap) break;
    chosen.push(item);
  }

  // Gli scarti rientrano in coda: si rimette tutto in ordine di data, che e'
  // l'unico ordine che un elenco di uscite puo' avere.
  return chosen.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
}

function buildFeedPayload(items, now = new Date()) {
  return {
    // Il client controlla la versione prima di fidarsi della forma: cambiarla
    // e' il modo di rompere il contratto senza rompere i widget installati.
    version: 1,
    generatedAt: toIsoDate(now) || new Date().toISOString(),
    count: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items) ? items : [],
  };
}

// ---------------------------------------------------------------------------
// Lettura
// ---------------------------------------------------------------------------

// DUE QUERY, NON UNA CON `in`.
//
// Provata prima la strada corta (`eventType in [release_date, new_episode]`,
// stesso indice, un ordinamento solo) e il feed live e' uscito con 4 voci su 10:
// gli eventi episodio sono fitti — le serie in onda ne fanno uno a settimana —
// e le prime 80 righe per data erano quasi tutte puntate di meta' stagione, che
// poi il filtro scarta. Leggere di piu' sarebbe stato pagare letture per
// buttarle. Le premiere si filtrano invece nell'indice (`episode == 1`), e i
// film hanno la loro finestra garantita.
async function fetchPublishedReleaseEvents(db, now, limit = QUERY_LIMIT) {
  const [releases, premieres] = await Promise.all([
    db.collection("titleUpdateEvents")
      .where("eventType", "==", "release_date")
      .where("status", "==", "published")
      .where("effectiveAt", ">", now)
      .orderBy("effectiveAt", "asc")
      .limit(limit)
      .get(),
    db.collection("titleUpdateEvents")
      .where("eventType", "==", "new_episode")
      .where("status", "==", "published")
      .where("episode", "==", 1)
      .where("effectiveAt", ">", now)
      .orderBy("effectiveAt", "asc")
      .limit(limit)
      .get(),
  ]);

  return [...releases.docs, ...premieres.docs]
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .sort((a, b) => {
      const left = toIsoDate(a.effectiveAt);
      const right = toIsoDate(b.effectiveAt);
      return left.localeCompare(right);
    });
}

async function fetchTitlesById(db, titleIds) {
  const ids = [...new Set(
    (Array.isArray(titleIds) ? titleIds : [])
      .map((id) => asTrimmedString(id, 160))
      .filter(Boolean)
  )];
  const out = new Map();
  if (!ids.length) return out;

  const snaps = await db.getAll(...ids.map((id) => db.collection("titles").doc(id)));
  for (const snap of snaps) {
    if (snap && snap.exists) out.set(snap.id, snap.data() || {});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerUpcomingReleasesFeed(exports) {
  exports.upcomingReleasesFeed = functions
    .region(REGION)
    .https.onRequest(async (req, res) => {
      res.set("Content-Type", "application/json; charset=utf-8");
      // Feed pubblico e di sola lettura: nessun dato dell'utente, nessun
      // cookie. L'`*` serve a un eventuale consumo dal web, non al widget.
      res.set("Access-Control-Allow-Origin", "*");

      try {
        const now = new Date();
        const db = admin.firestore();
        const events = await fetchPublishedReleaseEvents(db, now);
        const titlesById = await fetchTitlesById(db, events.map((event) => event.titleId));
        const items = buildFeedItems({ events, titlesById, now });

        // Le uscite si muovono di rado: mezz'ora sul device, un'ora sulla CDN.
        res.set("Cache-Control", "public, max-age=1800, s-maxage=3600");
        res.status(200).send(JSON.stringify(buildFeedPayload(items, now)));
      } catch (err) {
        logger.error("[upcomingReleasesFeed] error", err);
        // Un errore non si cachea: il widget riproverebbe su una risposta rotta
        // per un'ora.
        res.set("Cache-Control", "no-store");
        res.status(500).send(JSON.stringify({ error: "internal" }));
      }
    });
}

module.exports = {
  registerUpcomingReleasesFeed,
  // Test seam (stesso pattern di officialUpdatePage/listPage).
  MAX_ITEMS,
  QUERY_LIMIT,
  _buildFeedItems: buildFeedItems,
  _buildFeedPayload: buildFeedPayload,
  _normalizePosterUrl: normalizePosterUrl,
  _releaseKindFromType: releaseKindFromType,
  _occasionForEvent: occasionForEvent,
  _titlePath: titlePath,
  _toIsoDate: toIsoDate,
  _fetchPublishedReleaseEvents: fetchPublishedReleaseEvents,
};
