"use strict";

// Voti personaggi ("Chi ti ha conquistato?") — spec in docs/CHARACTER_VOTES_SPEC.md.
//
// Logica pura (nessuna dipendenza Firebase, nessun I/O) per i 2 hop server
// descritti in spec §3:
//   1. onWriteCharacterVote (characterVotes/{voteId}): delta sull'aggregato
//      episodio §2.2 (applyEpisodeAggregateDelta) + delta sul rollup
//      personale §2.4 (applyPersonalRollupDelta), che calcola gli
//      entered/left da propagare a monte.
//   2. onWriteCharacterPicks (users/{uid}/characterPicks/{titleId}): traduce
//      quegli entered/left in delta unique-user sull'aggregato serie/stagione
//      §2.3 (applyUniqueUserAggregateDelta).
//
// Stile e difensività a specchio di emotionAggregate.js / derivedRatingAggregate.js:
// input null/undefined/malformati non lanciano mai, degradano a "vuoto".

const { EMOTION_KEYS } = require("./emotionAggregate");

const MAX_PICKS = 3;
const MAX_BUCKET_PERSONS = 40;

// Reazione opzionale agganciata al pick: stessa whitelist delle emozioni
// post-visione, nessuna chiave nuova (spec §2.1). Stessa lista, non una copia.
const PICK_REACTION_KEYS = EMOTION_KEYS;
const PICK_REACTION_KEY_SET = new Set(PICK_REACTION_KEYS);

const VOTE_LEVELS = new Set(["title", "episode"]);

// Stessa sanitizzazione char-per-char di safePart/makeRatingId in
// public/js/api/ratings.api.js: qualunque cosa non sia [A-Za-z0-9_-] -> "_".
function safePart(v) {
  return String(v ?? "0").replace(/[^a-zA-Z0-9_-]/g, "_");
}

// --- normalizePicks ----------------------------------------------------------

// Normalizza il campo `picks` di un doc characterVotes: array 0..MAX_PICKS di
// { personId, character, reaction }. Difensivo (le rules dovrebbero già
// bloccare input cattivo lato client, ma admin SDK/import potrebbero
// divergere):
//   - input non-array -> []
//   - elementi non-oggetto (o array) -> scartati
//   - personId non stringa, vuoto (dopo trim) o >32 char -> scartati
//   - dedup su personId, tiene il primo incontrato
//   - character trim + troncato a 120 char, vuoto -> null
//   - reaction ammessa solo se in PICK_REACTION_KEYS, altrimenti null
//   - si ferma appena si raccolgono MAX_PICKS pick validi
function normalizePicks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();

  for (const item of raw) {
    if (out.length >= MAX_PICKS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const personId = typeof item.personId === "string" ? item.personId.trim() : "";
    if (!personId || personId.length > 32 || seen.has(personId)) continue;
    seen.add(personId);

    const rawCharacter = typeof item.character === "string" ? item.character.trim() : "";
    const character = rawCharacter ? rawCharacter.slice(0, 120) : null;

    const rawReaction = typeof item.reaction === "string" ? item.reaction : "";
    const reaction = PICK_REACTION_KEY_SET.has(rawReaction) ? rawReaction : null;

    out.push({ personId, character, reaction });
  }

  return out;
}

// --- id builders ---------------------------------------------------------------

// { uid, titleId, level, season, episode } -> "uid__titleId__level__season__episode".
// season/episode mancanti -> 0. level fuori da {title,episode} -> null (nessun
// id costruibile). uid/titleId non validati qui (solo char-sanitizzati, come
// makeRatingId): la presenza/validità resta responsabilità del chiamante.
function makeCharacterVoteId({ uid, titleId, level, season, episode } = {}) {
  if (!VOTE_LEVELS.has(level)) return null;
  return [
    safePart(uid),
    safePart(titleId),
    safePart(level),
    safePart(season ?? 0),
    safePart(episode ?? 0),
  ].join("__");
}

// (season, episode) -> "season_episode", chiave del bucket episodio sotto
// titles/{titleId}/characterVotes/{s}_{e}. Non interi (NaN, float, stringhe
// non numeriche) -> null.
function makeEpisodeBucketId(season, episode) {
  const s = Number(season);
  const e = Number(episode);
  if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
  return `${s}_${e}`;
}

// --- pruning -------------------------------------------------------------------

// Tiene i `cap` personId col count più alto in `counts` (tie-break
// lessicografico crescente sul personId), ritorna un nuovo oggetto. Usata
// dentro applyEpisodeAggregateDelta e applyUniqueUserAggregateDelta per
// tenere i bucket community sotto il cap difensivo su titoli con cast enorme.
function pruneBucket(counts, cap = MAX_BUCKET_PERSONS) {
  const src = (counts && typeof counts === "object" && !Array.isArray(counts)) ? counts : {};
  const effectiveCap = Number.isFinite(cap) && cap >= 0 ? Math.trunc(cap) : MAX_BUCKET_PERSONS;

  const sorted = Object.keys(src).sort((a, b) => {
    const diff = (Number(src[b]) || 0) - (Number(src[a]) || 0);
    if (diff !== 0) return diff;
    return a < b ? -1 : (a > b ? 1 : 0);
  });

  const out = {};
  for (const key of sorted.slice(0, effectiveCap)) out[key] = src[key];
  return out;
}

// --- helper generici privati -----------------------------------------------------

function numberMapEquals(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

// Mappa personId -> count grezza: scarta chiavi non-numeriche/<=0, tronca a intero.
function sanitizeCounts(raw) {
  const out = {};
  const src = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  for (const key of Object.keys(src)) {
    const n = Math.trunc(Number(src[key]));
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

// --- §2.2 aggregato episodio (volume) --------------------------------------------

function sanitizeEpisodeAggregate(seed) {
  const counts = pruneBucket(sanitizeCounts(seed && seed.counts), MAX_BUCKET_PERSONS);
  const totalPicks = Object.values(counts).reduce((acc, n) => acc + n, 0);
  const totalUsers = Math.max(0, Math.trunc(Number(seed && seed.totalUsers)) || 0);
  return { counts, totalPicks, totalUsers };
}

function episodeAggregateEquals(a, b) {
  return a.totalPicks === b.totalPicks
    && a.totalUsers === b.totalUsers
    && numberMapEquals(a.counts, b.counts);
}

// Applica il delta before->after di UN doc characterVotes episodio
// all'aggregato volume (titles/{titleId}/characterVotes/{s}_{e}). Pura,
// O(#pick). `current` è il bucket esistente (o null/malformato -> vuoto).
// `changed` è false se il risultato coincide col bucket corrente (no-op
// guard del trigger: es. si è toccato solo reaction/character, non il set di
// personId).
function applyEpisodeAggregateDelta(current, { beforePicks, afterPicks } = {}) {
  const before = normalizePicks(beforePicks);
  const after = normalizePicks(afterPicks);
  const seed = sanitizeEpisodeAggregate(current);

  const counts = { ...seed.counts };
  for (const pick of before) {
    counts[pick.personId] = Math.max(0, (counts[pick.personId] || 0) - 1);
    if (counts[pick.personId] === 0) delete counts[pick.personId];
  }
  for (const pick of after) {
    counts[pick.personId] = (counts[pick.personId] || 0) + 1;
  }

  const prunedCounts = pruneBucket(counts, MAX_BUCKET_PERSONS);
  const totalPicks = Object.values(prunedCounts).reduce((acc, n) => acc + n, 0);

  let usersDelta = 0;
  if (before.length === 0 && after.length > 0) usersDelta = 1;
  if (before.length > 0 && after.length === 0) usersDelta = -1;
  const totalUsers = Math.max(0, seed.totalUsers + usersDelta);

  const next = { counts: prunedCounts, totalPicks, totalUsers };
  const changed = !episodeAggregateEquals(next, seed);
  return { next, changed };
}

// --- §2.4 rollup personale --------------------------------------------------------

function sanitizeRollupBySeason(raw) {
  const out = {};
  const src = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  for (const key of Object.keys(src)) {
    const seasonNum = Number(key);
    if (!Number.isInteger(seasonNum) || seasonNum <= 0) continue;
    out[String(seasonNum)] = sanitizeCounts(src[key]);
  }
  return out;
}

function bySeasonCountsEquals(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => b[k] && numberMapEquals(a[k], b[k]));
}

function topEquals(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.personId === b.personId && a.character === b.character && a.count === b.count;
}

// Applica il delta before->after (liste di pick normalizzati) a una mappa
// personId->count. Ritorna { next, entered, left }: entered/left sono i
// personId il cui count attraversa lo 0 (assente<->presente in QUESTA
// mappa), cioè le transizioni "utente unico" da propagare a monte (§2.3).
function applyMapDelta(map, before, after) {
  const beforeIds = before.map((p) => p.personId);
  const afterIds = after.map((p) => p.personId);
  const touched = new Set([...beforeIds, ...afterIds]);

  const prevCounts = {};
  for (const id of touched) prevCounts[id] = map[id] || 0;

  const next = { ...map };
  for (const id of beforeIds) next[id] = Math.max(0, (next[id] || 0) - 1);
  for (const id of afterIds) next[id] = (next[id] || 0) + 1;

  const entered = [];
  const left = [];
  for (const id of touched) {
    const prev = prevCounts[id];
    const now = next[id] || 0;
    if (prev === 0 && now > 0) entered.push(id);
    if (prev > 0 && now === 0) left.push(id);
    if (now === 0) delete next[id];
    else next[id] = now;
  }

  return { next, entered, left };
}

// personId col count più alto in seriesMap, tie-break lessicografico
// crescente. character: snapshot più recente in afterPicks (normalizzati),
// altrimenti quello del top corrente se stesso personId, altrimenti null.
function computeTop(seriesMap, afterPicks, currentTop) {
  const keys = Object.keys(seriesMap).sort();
  if (keys.length === 0) return null;

  let bestId = keys[0];
  let bestCount = seriesMap[bestId];
  for (const id of keys) {
    const count = seriesMap[id];
    if (count > bestCount) {
      bestCount = count;
      bestId = id;
    }
  }

  const afterMatch = afterPicks.find((p) => p.personId === bestId);
  let character = null;
  if (afterMatch && afterMatch.character) {
    character = afterMatch.character;
  } else if (currentTop && currentTop.personId === bestId && currentTop.character) {
    character = currentTop.character;
  }

  return { personId: bestId, character, count: bestCount };
}

// Applica il delta before->after di UN doc characterVotes al rollup
// personale users/{uid}/characterPicks/{titleId}. Pura. `current` è il doc
// esistente (o null/malformato -> vuoto).
//
// level="episode": aggiorna series + bySeason[season]; episodes +1/-1 quando
//   l'utente entra/esce dal set di pick di QUELL'episodio (clamp 0).
// level="title": aggiorna series + direct; non tocca bySeason né episodes.
// level non riconosciuto: no-op totale (nessuna mappa toccata), difensivo.
function applyPersonalRollupDelta(current, { level, season, beforePicks, afterPicks } = {}) {
  const before = normalizePicks(beforePicks);
  const after = normalizePicks(afterPicks);

  const seedSeries = sanitizeCounts(current && current.series);
  const seedBySeason = sanitizeRollupBySeason(current && current.bySeason);
  const seedDirect = sanitizeCounts(current && current.direct);
  const seedEpisodes = Math.max(0, Math.trunc(Number(current && current.episodes)) || 0);
  const seedTop = (current && current.top && typeof current.top === "object" && !Array.isArray(current.top))
    ? current.top
    : null;

  let nextSeries = seedSeries;
  let nextBySeason = seedBySeason;
  let nextDirect = seedDirect;
  let nextEpisodes = seedEpisodes;
  let seriesEntered = [];
  let seriesLeft = [];
  let seasonEntered = [];
  let seasonLeft = [];
  let seasonKey = null;

  if (level === "episode") {
    const seriesDelta = applyMapDelta(seedSeries, before, after);
    nextSeries = seriesDelta.next;
    seriesEntered = seriesDelta.entered;
    seriesLeft = seriesDelta.left;

    const seasonNum = Number(season);
    if (Number.isInteger(seasonNum) && seasonNum > 0) {
      seasonKey = String(seasonNum);
      const seasonDelta = applyMapDelta(seedBySeason[seasonKey] || {}, before, after);
      nextBySeason = { ...seedBySeason, [seasonKey]: seasonDelta.next };
      seasonEntered = seasonDelta.entered;
      seasonLeft = seasonDelta.left;
    }

    if (before.length === 0 && after.length > 0) nextEpisodes = seedEpisodes + 1;
    else if (before.length > 0 && after.length === 0) nextEpisodes = Math.max(0, seedEpisodes - 1);
  } else if (level === "title") {
    const seriesDelta = applyMapDelta(seedSeries, before, after);
    nextSeries = seriesDelta.next;
    seriesEntered = seriesDelta.entered;
    seriesLeft = seriesDelta.left;

    const directDelta = applyMapDelta(seedDirect, before, after);
    nextDirect = directDelta.next;
  }

  const nextTop = computeTop(nextSeries, after, seedTop);

  const next = {
    series: nextSeries,
    bySeason: nextBySeason,
    direct: nextDirect,
    top: nextTop,
    episodes: nextEpisodes,
  };

  const changed = !(
    next.episodes === seedEpisodes
    && topEquals(next.top, seedTop)
    && numberMapEquals(next.series, seedSeries)
    && numberMapEquals(next.direct, seedDirect)
    && bySeasonCountsEquals(next.bySeason, seedBySeason)
  );

  return { next, seriesEntered, seriesLeft, seasonEntered, seasonLeft, seasonKey, changed };
}

// --- §2.3 aggregato serie/stagione (utenti unici) --------------------------------

function sanitizeUniqueBucket(raw) {
  const counts = pruneBucket(sanitizeCounts(raw && raw.counts), MAX_BUCKET_PERSONS);
  const totalUsers = Math.max(0, Math.trunc(Number(raw && raw.totalUsers)) || 0);
  return { counts, totalUsers };
}

function sanitizeUniqueBySeason(raw) {
  const out = {};
  const src = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  for (const key of Object.keys(src)) {
    const seasonNum = Number(key);
    if (!Number.isInteger(seasonNum) || seasonNum <= 0) continue;
    out[String(seasonNum)] = sanitizeUniqueBucket(src[key]);
  }
  return out;
}

function uniqueBucketEquals(a, b) {
  return a.totalUsers === b.totalUsers && numberMapEquals(a.counts, b.counts);
}

function uniqueBySeasonEquals(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => b[k] && uniqueBucketEquals(a[k], b[k]));
}

// entered/left (liste personId) -> counts +1/-1 (clamp 0, chiave rimossa a
// 0). userEntered/userLeft (bool) -> totalUsers +1/-1 (clamp 0). Ritorna un
// nuovo bucket {counts, totalUsers}, pruned al cap.
function applyUniqueBucketDelta(bucket, entered, left, userEntered, userLeft) {
  const counts = { ...bucket.counts };
  for (const raw of left) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) continue;
    counts[id] = Math.max(0, (counts[id] || 0) - 1);
    if (counts[id] === 0) delete counts[id];
  }
  for (const raw of entered) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
  }

  let totalUsers = bucket.totalUsers;
  if (userEntered) totalUsers += 1;
  if (userLeft) totalUsers -= 1;
  totalUsers = Math.max(0, totalUsers);

  return { counts: pruneBucket(counts, MAX_BUCKET_PERSONS), totalUsers };
}

// Applica un delta unique-user su titles/{titleId}/aggregates/characters.
// `scope` (series|season|direct) sceglie il bucket toccato; gli altri due
// passano invariati (solo sanitizzati) in `next`. `current` null/malformato
// -> vuoto. `seasonKey` richiesto solo per scope="season" (non intero/<=0 ->
// no-op su quel bucket). `changed` è false se nessun bucket è cambiato
// davvero (es. scope sconosciuto, o entered/left senza reali transizioni).
function applyUniqueUserAggregateDelta(current, {
  scope,
  seasonKey,
  entered,
  left,
  userEntered,
  userLeft,
} = {}) {
  const enteredList = Array.isArray(entered) ? entered : [];
  const leftList = Array.isArray(left) ? left : [];

  const seedSeries = sanitizeUniqueBucket(current && current.series);
  const seedBySeason = sanitizeUniqueBySeason(current && current.bySeason);
  const seedDirect = sanitizeUniqueBucket(current && current.direct);

  let nextSeries = seedSeries;
  let nextBySeason = seedBySeason;
  let nextDirect = seedDirect;

  const wantsEnter = userEntered === true;
  const wantsLeave = userLeft === true;

  if (scope === "series") {
    nextSeries = applyUniqueBucketDelta(seedSeries, enteredList, leftList, wantsEnter, wantsLeave);
  } else if (scope === "direct") {
    nextDirect = applyUniqueBucketDelta(seedDirect, enteredList, leftList, wantsEnter, wantsLeave);
  } else if (scope === "season") {
    const seasonNum = Number(seasonKey);
    if (Number.isInteger(seasonNum) && seasonNum > 0) {
      const key = String(seasonNum);
      const bucket = seedBySeason[key] || { counts: {}, totalUsers: 0 };
      const updated = applyUniqueBucketDelta(bucket, enteredList, leftList, wantsEnter, wantsLeave);
      nextBySeason = { ...seedBySeason, [key]: updated };
    }
  }

  const next = { series: nextSeries, bySeason: nextBySeason, direct: nextDirect };
  const changed = !(
    uniqueBucketEquals(next.series, seedSeries)
    && uniqueBucketEquals(next.direct, seedDirect)
    && uniqueBySeasonEquals(next.bySeason, seedBySeason)
  );

  return { next, changed };
}

module.exports = {
  MAX_PICKS,
  MAX_BUCKET_PERSONS,
  PICK_REACTION_KEYS,
  normalizePicks,
  makeCharacterVoteId,
  makeEpisodeBucketId,
  applyEpisodeAggregateDelta,
  applyPersonalRollupDelta,
  applyUniqueUserAggregateDelta,
  pruneBucket,
};
