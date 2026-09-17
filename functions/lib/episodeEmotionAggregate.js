"use strict";

// Emozioni per episodio — logica pura condivisa dal trigger gen2 e dai test.
//
// I documenti individuali vivono in:
//   episodeEmotions/{uid}__{titleId}__episode__{season}__{episode}
// e alimentano un solo bucket server-owned:
//   titles/{titleId}/episodeEmotionAggregates/{season}_{episode}
//
// `titleEmotions` e il suo aggregato restano intenzionalmente separati:
// un'emozione espressa sulla serie non può essere attribuita retroattivamente
// a uno specifico episodio senza inventare informazione.

const {
  sanitizeEmotions,
  applyEmotionAggregateDelta,
  emotionSetsEqual,
} = require("./emotionAggregate");

function safePart(value) {
  return String(value ?? "0").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function makeEpisodeEmotionId({ uid, titleId, season, episode } = {}) {
  const seasonNumber = positiveInteger(season);
  const episodeNumber = positiveInteger(episode);
  if (!uid || !titleId || seasonNumber === null || episodeNumber === null) return null;
  return [
    safePart(uid),
    safePart(titleId),
    "episode",
    String(seasonNumber),
    String(episodeNumber),
  ].join("__");
}

function makeEpisodeEmotionBucketId(season, episode) {
  const seasonNumber = positiveInteger(season);
  const episodeNumber = positiveInteger(episode);
  if (seasonNumber === null || episodeNumber === null) return null;
  return `${seasonNumber}_${episodeNumber}`;
}

function aggregateEquals(a, b) {
  if (a.totalSelections !== b.totalSelections || a.totalUsers !== b.totalUsers) return false;
  const aKeys = Object.keys(a.counts);
  const bKeys = Object.keys(b.counts);
  return aKeys.length === bKeys.length && aKeys.every((key) => a.counts[key] === b.counts[key]);
}

function sanitizeEpisodeEmotionAggregate(current) {
  return applyEmotionAggregateDelta(current, null, null);
}

// Applica il delta di un singolo documento al bucket dell'episodio. Gli input
// sono sanitizzati in profondità: rules proteggono i client, ma import/admin SDK
// non devono poter corrompere un aggregato con chiavi sconosciute o contatori
// negativi. `changed` consente al trigger di evitare write inutili.
function applyEpisodeEmotionAggregateDelta(current, beforeEmotions, afterEmotions) {
  const seed = sanitizeEpisodeEmotionAggregate(current);
  const next = applyEmotionAggregateDelta(seed, beforeEmotions, afterEmotions);
  return { next, changed: !aggregateEquals(seed, next) };
}

module.exports = {
  makeEpisodeEmotionId,
  makeEpisodeEmotionBucketId,
  sanitizeEpisodeEmotionAggregate,
  applyEpisodeEmotionAggregateDelta,
  emotionSetsEqual,
  sanitizeEmotions,
};
