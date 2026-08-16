import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

import { app, db } from "../firebase.js";
import { makeRatingId } from "./ratings.api.js";
import { EMOTION_KEYS } from "./emotions.api.js";

// Voti personaggi ("Chi ti ha conquistato?") — docs/CHARACTER_VOTES_SPEC.md.
// Gemello di emotions.api.js: stesso id composito (riusa makeRatingId, NON
// reimplementato qui), stesso pattern upsert/delete. Solo pick POSITIVI su
// personaggi immaginari, mai un voto su una persona reale.

const functions = getFunctions(app, "europe-west1");
const tmdbProxyCallable = httpsCallable(functions, "tmdbProxy");

const REACTION_KEY_SET = new Set(EMOTION_KEYS);
const MAX_PICKS = 3;

// La rule characterVotes confronta l'id doc con una concatenazione GREZZA di
// `titleId` (nessuna sanitizzazione lato regola): se titleId contiene
// caratteri fuori whitelist, qualunque write viene rifiutata. Va controllato
// PRIMA di tentare qualunque scrittura — degrado silenzioso, mai un errore
// mostrato per questo (vedi anche isSanitizedCharacterVoteTitleID lato iOS).
const TITLE_ID_SAFE_RE = /^[A-Za-z0-9_-]+$/;
export function isSanitizedCharacterVoteTitleId(titleId) {
  return typeof titleId === "string" && titleId.length > 0 && TITLE_ID_SAFE_RE.test(titleId);
}

// Mirror di normalizePicks in functions/lib/characterVoteAggregate.js: max 3,
// personId non vuoti/distinti (<=32 char), character troncato a 120 char
// (vuoto -> null), reaction ammessa solo se e' una delle 12 chiavi emozione
// esistenti (altrimenti scartata silenziosamente, mai un intero doc rifiutato
// per questo).
function normalizePicks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= MAX_PICKS) break;
    if (!item || typeof item !== "object") continue;
    const personId = typeof item.personId === "string" ? item.personId.trim() : "";
    if (!personId || personId.length > 32 || seen.has(personId)) continue;
    seen.add(personId);

    const rawCharacter = typeof item.character === "string" ? item.character.trim() : "";
    const character = rawCharacter ? rawCharacter.slice(0, 120) : null;

    const reaction = typeof item.reaction === "string" && REACTION_KEY_SET.has(item.reaction)
      ? item.reaction
      : null;

    out.push({ personId, character, reaction });
  }
  return out;
}

export function characterPicksEqual(a, b) {
  const na = normalizePicks(a).map((p) => `${p.personId}:${p.reaction || ""}`).sort();
  const nb = normalizePicks(b).map((p) => `${p.personId}:${p.reaction || ""}`).sort();
  if (na.length !== nb.length) return false;
  return na.every((v, i) => v === nb[i]);
}

/**
 * I pick dell'utente per UN item specifico (titolo o episodio). [] se non ha
 * ancora votato (o se titleId non e' nella forma sanitizzata attesa dalle
 * rules). `throwOnError` serve ai picker editabili: se la read fallisce,
 * impedisce di mostrare un falso stato vuoto che potrebbe sovrascrivere pick
 * preesistenti.
 */
export async function getMyCharacterPicks({
  uid,
  titleId,
  level,
  season = 0,
  episode = 0,
  throwOnError = false,
}) {
  if (!uid || !titleId || !isSanitizedCharacterVoteTitleId(titleId)) return [];
  try {
    const id = makeRatingId({ uid, titleId, level, season, episode });
    const snap = await getDoc(doc(db, "characterVotes", id));
    if (!snap.exists()) return [];
    return normalizePicks(snap.data()?.picks);
  } catch (err) {
    console.warn("[characterVotes] getMyCharacterPicks failed", err?.message || err);
    if (throwOnError) throw err;
    return [];
  }
}

/**
 * Upsert dei pick personaggio per un titolo/episodio. Deselezione totale
 * (`picks` vuoto dopo normalizzazione) -> delete del doc, con
 * get-prima-di-delete (delete su doc inesistente = deny dalle rules).
 *
 * `level`: "title" | "episode". Per "title", season/episode sono SEMPRE 0
 * (numeri, non null: la rule richiede `data.season is number`). Per
 * "episode", season/episode devono essere > 0.
 *
 * Se titleId non e' nella forma sanitizzata attesa dalle rules, degrada in
 * silenzio (nessun write tentato, nessun errore) — stesso contratto di
 * isSanitizedCharacterVoteTitleId.
 */
export async function upsertCharacterPicks({ uid, titleId, level, season = 0, episode = 0, picks, source }) {
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");
  if (!isSanitizedCharacterVoteTitleId(titleId)) {
    return { id: null, picks: [], skipped: true };
  }

  const normalizedSeason = level === "title" ? 0 : (Number(season) || 0);
  const normalizedEpisode = level === "title" ? 0 : (Number(episode) || 0);
  const ref = doc(db, "characterVotes", makeRatingId({
    uid, titleId, level, season: normalizedSeason, episode: normalizedEpisode,
  }));

  const clean = normalizePicks(picks);
  if (!clean.length) {
    const snap = await getDoc(ref);
    if (snap.exists()) await deleteDoc(ref);
    return { id: ref.id, picks: [] };
  }

  const data = {
    uid,
    titleId,
    level,
    season: normalizedSeason,
    episode: normalizedEpisode,
    picks: clean.map((p) => {
      const item = { personId: p.personId };
      if (p.character) item.character = p.character;
      if (p.reaction) item.reaction = p.reaction;
      return item;
    }),
    updatedAt: serverTimestamp(),
  };
  if (source) data.source = String(source).slice(0, 40);

  await setDoc(ref, { ...data, createdAt: serverTimestamp() }, { merge: true });
  return { id: ref.id, picks: clean };
}

/** Aggregato volume di un episodio — titles/{titleId}/characterVotes/{s}_{e}. null se nessuno ha ancora votato. */
export async function fetchEpisodeCharacterBucket(titleId, season, episode) {
  if (!titleId) return null;
  const s = Number(season), e = Number(episode);
  if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
  try {
    const snap = await getDoc(doc(db, "titles", titleId, "characterVotes", `${s}_${e}`));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn("[characterVotes] fetchEpisodeCharacterBucket failed", err?.message || err);
    return null;
  }
}

/**
 * Tutti i bucket episodio di un titolo, chiavati "{stagione}_{episodio}".
 * Una read di collection sola invece di un get per episodio: alimenta sia la
 * classifica del singolo episodio sia quella di stagione (che lato server non
 * esiste, si somma qui dagli episodi). Mirror di
 * `TitleRepository.fetchEpisodeCharacterBuckets` su iOS.
 */
export async function fetchEpisodeCharacterBuckets(titleId) {
  if (!titleId) return new Map();
  try {
    const snap = await getDocs(collection(db, "titles", titleId, "characterVotes"));
    const out = new Map();
    snap.forEach((d) => {
      const data = d.data() || {};
      const counts = (data.counts && typeof data.counts === "object") ? data.counts : {};
      const totalUsers = Number(data.totalUsers) || 0;
      if (!totalUsers && !Object.keys(counts).length) return;
      out.set(d.id, { counts, totalUsers });
    });
    return out;
  } catch (err) {
    console.warn("[characterVotes] fetchEpisodeCharacterBuckets failed", err?.message || err);
    return new Map();
  }
}

/**
 * Somma dei bucket episodio di una stagione: sono VOTI totali, non utenti
 * unici (chi vota lo stesso personaggio in cinque episodi conta cinque).
 * Chi la mostra deve dirlo.
 */
export function seasonCharacterCounts(buckets, seasonNumber) {
  const merged = {};
  const target = Number(seasonNumber);
  (buckets instanceof Map ? buckets : new Map()).forEach((bucket, key) => {
    const [s] = String(key).split("_");
    if (Number(s) !== target) return;
    Object.entries(bucket?.counts || {}).forEach(([personId, count]) => {
      const n = Number(count) || 0;
      if (n > 0) merged[personId] = (merged[personId] || 0) + n;
    });
  });
  return rankCharacterCounts(merged);
}

/** Aggregato community serie/stagione a utenti unici — titles/{titleId}/aggregates/characters. null se nessun voto. */
export async function fetchTitleCharacterAggregate(titleId) {
  if (!titleId) return null;
  try {
    const snap = await getDoc(doc(db, "titles", titleId, "aggregates", "characters"));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn("[characterVotes] fetchTitleCharacterAggregate failed", err?.message || err);
    return null;
  }
}

/** Rollup personale privato — users/{uid}/characterPicks/{titleId}. null se l'utente non ha ancora votato nulla. */
export async function fetchMyCharacterPicksRollup(uid, titleId) {
  if (!uid || !titleId) return null;
  try {
    const snap = await getDoc(doc(db, "users", uid, "characterPicks", titleId));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn("[characterVotes] fetchMyCharacterPicksRollup failed", err?.message || err);
    return null;
  }
}

/**
 * personId ordinati per popolarita' decrescente (tie-break personId
 * crescente), solo count > 0. Mirror di CharacterVoteBucket.rankedCounts
 * (iOS) / stessa logica lato server.
 */
export function rankCharacterCounts(counts) {
  const src = (counts && typeof counts === "object") ? counts : {};
  return Object.entries(src)
    .map(([personId, count]) => ({ personId, count: Number(count) || 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => (b.count - a.count) || (a.personId < b.personId ? -1 : (a.personId > b.personId ? 1 : 0)));
}

/**
 * Bucket community da mostrare per un titolo: preferisce i pick derivati
 * dagli episodi (`series`), altrimenti i pick diretti a livello titolo
 * (`direct`, film). null se nessuno dei due ha voti.
 */
export function pickCommunityBucket(aggregate) {
  if (!aggregate) return null;
  const series = aggregate.series;
  if (series && Number(series.totalUsers) > 0) return series;
  const direct = aggregate.direct;
  if (direct && Number(direct.totalUsers) > 0) return direct;
  return null;
}

/**
 * Campione minimo sotto il quale non mostriamo nessuna etichetta: "Amato" da
 * un voto solo e' rumore, e su una scheda titolo sembra un dato.
 */
export const APPRECIATION_MIN_USERS = 5;

/**
 * Grado di apprezzamento di un personaggio dai pick della community, come
 * chiave (la copy vive nella UI, non qui).
 *
 * Solo positivo e mai comparativo verso il basso: si votano personaggi, mai
 * le persone reali, e non esistono downvote (docs/CHARACTER_VOTES_SPEC.md).
 * La quota e' su UTENTI unici che hanno scelto quel personaggio, quindi con
 * tre pick a testa la somma di tutte le quote puo' superare il 100%: e'
 * corretto, non e' una ripartizione.
 *
 * @returns {{key: "top"|"high"|"some", share: number}|null}
 */
export function characterAppreciation(bucket, personId) {
  const totalUsers = Number(bucket?.totalUsers || 0);
  if (totalUsers < APPRECIATION_MIN_USERS) return null;

  const count = Number(bucket?.counts?.[String(personId)] || 0);
  if (count <= 0) return null;

  const share = count / totalUsers;
  if (share >= 0.5) return { key: "top", share };
  if (share >= 0.25) return { key: "high", share };
  if (share >= 0.1) return { key: "some", share };
  return null;
}

function normalizeCandidate(raw, isGuest) {
  if (!raw || typeof raw !== "object") return null;
  const personId = raw.personId != null ? String(raw.personId).trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!personId || !name) return null;
  const character = typeof raw.character === "string" ? raw.character.trim() : "";
  return {
    personId,
    name,
    character: character || null,
    profilePath: typeof raw.profilePath === "string" ? raw.profilePath.trim() : "",
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 999,
    isGuest: Boolean(isGuest),
  };
}

/**
 * Candidati per il pick a livello titolo (film, o pick diretto serie): il
 * cast principale gia' denormalizzato su titles/{id}.castWithCharacters,
 * nessuna chiamata di rete. Nessuna guest star a questo livello (concetto
 * solo episodio, spec §6).
 */
export function characterCandidatesFromTitle(title) {
  const list = Array.isArray(title?.castWithCharacters) ? title.castWithCharacters : [];
  return list
    .map((m) => normalizeCandidate(m, false))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

/**
 * Cast COMPLETO del titolo, per il "vedi tutto il cast" della scheda.
 * `castWithCharacters` in DB e' il top-20 denormalizzato: va bene come
 * anteprima, non come "tutti". Fallback SILENZIOSO su quei 20 se il titolo
 * non ha tmdbId, se la chiamata fallisce o se TMDB non ha i credits — la
 * lista non deve mai restare vuota per un errore di rete.
 */
export async function fetchFullTitleCast(title) {
  const fallback = characterCandidatesFromTitle(title);
  const tmdbId = Number(title?.tmdbId || title?.meta?.tmdbId || 0);
  if (!tmdbId) return fallback;

  const mediaType = String(title?.type || "").toLowerCase() === "tv" ? "tv" : "movie";

  let payload;
  try {
    const res = await tmdbProxyCallable({ action: "titlecredits", tmdbId, mediaType, language: "it-IT" });
    const data = res?.data;
    payload = (data && typeof data === "object" && "payload" in data) ? data.payload : data;
  } catch (err) {
    console.warn("[characterVotes] titlecredits failed, fallback su cast titolo", err?.message || err);
    return fallback;
  }

  if (!payload || payload.missing === true) return fallback;

  const seen = new Set();
  const full = (Array.isArray(payload.cast) ? payload.cast : [])
    .map((row) => normalizeCandidate(row, false))
    .filter((c) => {
      if (!c || seen.has(c.personId)) return false;
      seen.add(c.personId);
      return true;
    });

  return full.length ? full : fallback;
}

/**
 * Candidati per il picker "Chi ti ha conquistato?" di un episodio: guest star
 * PRIMA (motivo d'essere della feature), poi il cast fisso dell'episodio,
 * via tmdbProxy action `episodecredits`. Fallback SILENZIOSO su
 * castWithCharacters del titolo (mai un errore mostrato, mai una riga vuota)
 * se: il titolo non ha tmdbId, la chiamata fallisce, TMDB segnala `missing`,
 * o non restituisce nessun credit utilizzabile.
 */
export async function fetchEpisodeCharacterCandidates(title, season, episode) {
  const fallback = characterCandidatesFromTitle(title);

  const tmdbId = Number(title?.tmdbId || title?.meta?.tmdbId || 0);
  const s = Number(season);
  const e = Number(episode);
  if (!tmdbId || !Number.isFinite(s) || s <= 0 || !Number.isFinite(e) || e <= 0) {
    return fallback;
  }

  let payload;
  try {
    const res = await tmdbProxyCallable({ action: "episodecredits", tmdbId, season: s, episode: e, language: "it-IT" });
    const data = res?.data;
    payload = (data && typeof data === "object" && "payload" in data) ? data.payload : data;
  } catch (err) {
    console.warn("[characterVotes] episodecredits failed, fallback su cast titolo", err?.message || err);
    return fallback;
  }

  if (!payload || payload.missing === true) return fallback;

  const seen = new Set();
  const dedupNormalize = (list, isGuest) => (Array.isArray(list) ? list : [])
    .map((row) => normalizeCandidate(row, isGuest))
    .filter((c) => {
      if (!c || seen.has(c.personId)) return false;
      seen.add(c.personId);
      return true;
    });

  const guests = dedupNormalize(payload.guestStars, true);
  const cast = dedupNormalize(payload.cast, false);
  const combined = [...guests, ...cast];

  return combined.length ? combined : fallback;
}
