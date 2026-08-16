import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";
import { sanitizeEmotions } from "./emotions.api.js";
import { makeRatingId } from "./ratings.api.js";

function normalizeEpisodeCoordinate(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(i18nT("{label} non valido", { label }));
  }
  return normalized;
}

export function makeEpisodeEmotionId({ uid, titleId, season, episode }) {
  return makeRatingId({
    uid,
    titleId,
    level: "episode",
    season,
    episode,
  });
}

export async function getMyEpisodeEmotions({ uid, titleId, season, episode }) {
  if (!uid || !titleId) return null;
  const normalizedSeason = normalizeEpisodeCoordinate(season, "stagione");
  const normalizedEpisode = normalizeEpisodeCoordinate(episode, "episodio");
  const ref = doc(db, "episodeEmotions", makeEpisodeEmotionId({
    uid,
    titleId,
    season: normalizedSeason,
    episode: normalizedEpisode,
  }));
  const snap = await getDoc(ref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function upsertEpisodeEmotions({
  uid,
  titleId,
  season,
  episode,
  emotions,
  source,
}) {
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");

  const normalizedSeason = normalizeEpisodeCoordinate(season, "stagione");
  const normalizedEpisode = normalizeEpisodeCoordinate(episode, "episodio");
  const clean = sanitizeEmotions(emotions).slice(0, 3);
  const ref = doc(db, "episodeEmotions", makeEpisodeEmotionId({
    uid,
    titleId,
    season: normalizedSeason,
    episode: normalizedEpisode,
  }));

  if (!clean.length) {
    const snap = await getDoc(ref);
    if (snap.exists()) await deleteDoc(ref);
    return { id: ref.id, emotions: [] };
  }

  const data = {
    uid,
    titleId,
    level: "episode",
    season: normalizedSeason,
    episode: normalizedEpisode,
    emotions: clean,
    updatedAt: serverTimestamp(),
  };
  if (source) data.source = String(source).slice(0, 40);

  const existing = await getDoc(ref);
  const payload = existing.exists()
    ? data
    : { ...data, createdAt: serverTimestamp() };
  await setDoc(ref, payload, { merge: true });
  return { id: ref.id, emotions: clean };
}
