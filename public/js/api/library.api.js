import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

import { app, db } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const getPublicProfileActivitySummaryCallable = httpsCallable(functions, "getPublicProfileActivitySummary");
const getPublicProfileSeriesProgressCallable = httpsCallable(functions, "getPublicProfileSeriesProgress");
const getTitleWatchersProgressCallable = httpsCallable(functions, "getTitleWatchersProgress");

export async function listMyLibrary(uid, { max = 500 } = {}){
  const q = query(
    collection(db, "users", uid, "library"),
    orderBy("updatedAt", "desc"),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data() || {};
    const titleId = String(data.titleId || "").trim() || d.id;
    return { id: d.id, ...data, titleId };
  });
}

export async function getPublicProfileActivitySummary(userId) {
  const res = await getPublicProfileActivitySummaryCallable({ userId });
  const data = res?.data && typeof res.data === "object" ? res.data : {};
  return {
    watchedTitlesCount: Number(data.watchedTitlesCount || 0) || 0,
    ratedTitlesCount: Number(data.ratedTitlesCount || 0) || 0,
    totalWatchMinutes: Number(data.totalWatchMinutes || 0) || 0,
    rewatchCount: Number(data.rewatchCount || 0) || 0,
    byCategory: data.byCategory && typeof data.byCategory === "object" ? data.byCategory : {},
  };
}

/**
 * Progresso serie pubblico di un utente ("a che punto è").
 * Mappa { "<titleId>": { state, episodesWatchedCount, seasonsCompletedCount,
 *   totalEpisodeCount|null, totalSeasonCount|null, lastWatchedSeasonNumber|null,
 *   lastWatchedEpisodeNumber|null, percentComplete|null } } — solo titoli TV
 * effettivamente iniziati/finiti dall'utente. Default difensivo {}.
 */
export async function getPublicProfileSeriesProgress(userId) {
  if (!userId) return {};
  try {
    const res = await getPublicProfileSeriesProgressCallable({ userId });
    const data = res?.data && typeof res.data === "object" ? res.data : {};
    return data.progress && typeof data.progress === "object" ? data.progress : {};
  } catch (err) {
    console.warn("[library.api] getPublicProfileSeriesProgress failed", err);
    return {};
  }
}

/**
 * Amici/seguiti del viewer che stanno guardando una serie.
 * Array pre-ordinato (cap 60) di { uid, displayName, photoURL|null,
 * isSynthetic, state, seriesProgress:{...}|null }. Default difensivo [].
 */
export async function getTitleWatchersProgress(titleId) {
  if (!titleId) return [];
  try {
    const res = await getTitleWatchersProgressCallable({ titleId });
    const data = res?.data && typeof res.data === "object" ? res.data : {};
    return Array.isArray(data.watchers) ? data.watchers : [];
  } catch (err) {
    console.warn("[library.api] getTitleWatchersProgress failed", err);
    return [];
  }
}
