// watchlistDashboard.api.js — Aggrega dashboard Watchlist (PWA), spec. matching
// WatchlistRepository.swift `fetchWatchlistDashboard(userID:)`.

import { listMyTitleStates } from "./titleStates.api.js";
import { t as i18nT } from "../i18n/index.js";
import {
  fetchOwnedAndSharedLists,
  fetchPublicLists,
  fetchPinnedPublicListIds,
  fetchPublicListProgressEntries,
  hydratePreviewTitles,
} from "./userLists.api.js";
import { getTitleById, getTitlesByIds } from "./titles.api.js";

const COMPLETED_MOVIE = new Set(["seen_unrated", "rated"]);
const COMPLETED_SERIES = new Set(["completed_unrated", "rated"]);
const STARTED_MOVIE = new Set(["seen_unrated", "rated"]);
const STARTED_SERIES = new Set(["in_progress", "completed_unrated", "rated"]);

export function isCompletedState(state) {
  if (!state) return false;
  const raw = String(state.state || "").toLowerCase();
  if (state.mediaType === "tv") return COMPLETED_SERIES.has(raw);
  return COMPLETED_MOVIE.has(raw);
}
export function hasStartedState(state) {
  if (!state) return false;
  const raw = String(state.state || "").toLowerCase();
  if (state.mediaType === "tv") return STARTED_SERIES.has(raw);
  return STARTED_MOVIE.has(raw);
}
export function isInToWatchQueue(state) {
  return !!state && state.generalWatchlist === true && !isCompletedState(state);
}
export function isAwaitingRating(state) {
  if (!state) return false;
  const raw = String(state.state || "").toLowerCase();
  if (state.mediaType === "tv") return raw === "completed_unrated";
  return raw === "seen_unrated";
}
export function isInRewatch(state) {
  return !!state && state.rewatchIntent === true && hasStartedState(state);
}
export function canResumeFromNewContent(state) {
  if (!state || state.mediaType !== "tv") return false;
  const raw = String(state.state || "").toLowerCase();
  return state.hasNewContent === true && (raw === "completed_unrated" || raw === "rated");
}

/** Serie aperte: iniziate e non finite. Alimenta lo scaffale "Sto guardando". */
export function isInProgressSeries(state) {
  if (!state || state.mediaType !== "tv") return false;
  return String(state.state || "").toLowerCase() === "in_progress";
}

/**
 * "A che punto è" di una serie, specchio di `TitleSeriesProgress.progressBadgeLabel`
 * (iOS) e di `resumeProgressLabel` in home.page.js: S{n}·E{n} → percentuale →
 * stagione → niente. Mai numeri inventati.
 */
export function seriesProgressLabel(state) {
  const sp = state?.seriesProgress;
  if (!sp) return null;
  const season = Number(sp.lastWatchedSeasonNumber);
  const episode = Number(sp.lastWatchedEpisodeNumber);
  if (Number.isFinite(season) && season > 0 && Number.isFinite(episode) && episode > 0) return `S${season}·E${episode}`;
  const percent = Number(sp.percentComplete);
  if (Number.isFinite(percent) && percent > 0) return `${Math.round(Math.max(0, Math.min(1, percent)) * 100)}%`;
  if (Number.isFinite(season) && season > 0) return `S${season}`;
  return null;
}

/** 0..1, solo se il dato c'è davvero (niente barra finta). */
export function seriesProgressRatio(state) {
  const percent = Number(state?.seriesProgress?.percentComplete);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return Math.max(0, Math.min(1, percent));
}

function sortByLastActivity(a, b) {
  return (Number(b._sortTime || 0) || 0) - (Number(a._sortTime || 0) || 0);
}

function hydrateListProgressCounts(list, stateMap) {
  // Per liste percorso (ordered_path) o collection: cerco di stimare completedCount
  // confrontando i titleIds dei items con titleStates locali. Senza items in memoria
  // mantiene il completedCount server (già scritto dai trigger Cloud Functions).
  // hydration items-aware si fa solo dopo openListDetail. Qui rispecchio iOS:
  return list;
}

function pinDecorate(list, pinnedSet) {
  list.isSavedByCurrentUser = pinnedSet.has(list.id);
  return list;
}

/**
 * Composizione dashboard ~equivalente a iOS:
 * { generalWatchlist, rewatch, toRate, toResume, myLists, sharedLists, publicLists }
 */
export async function fetchWatchlistDashboard(uid) {
  if (!uid) {
    return {
      generalWatchlist: [],
      rewatch: [],
      toRate: [],
      toResume: [],
      inProgress: [],
      myLists: [],
      sharedLists: [],
      publicLists: [],
    };
  }

  const [titleStates, memberLists, publicLists, pinnedPublicIds, _progressEntries] = await Promise.all([
    listMyTitleStates(uid, { max: 500 }).catch(() => []),
    fetchOwnedAndSharedLists(uid).catch(() => []),
    fetchPublicLists(uid).catch(() => []),
    fetchPinnedPublicListIds(uid).catch(() => []),
    fetchPublicListProgressEntries(uid).catch(() => []),
  ]);

  const stateMap = new Map(titleStates.map((s) => [s.titleId, s]));
  const pinnedSet = new Set(pinnedPublicIds);

  // Hydrate titoli (poster + meta) sui titleStates: batched read (1 query/30 id, cache 60s).
  const idsToFetch = titleStates
    .filter(s => !(s.titleSnapshot && s.titleSnapshot.name))
    .map(s => s.titleId)
    .filter(Boolean);
  const stateTitlesMap = idsToFetch.length
    ? await getTitlesByIds(idsToFetch).catch(() => new Map())
    : new Map();
  const enrichedStates = titleStates.map((s) => {
    if (s.titleSnapshot && s.titleSnapshot.name) {
      s.title = { id: s.titleId, ...s.titleSnapshot };
      return s;
    }
    const title = stateTitlesMap.get(s.titleId);
    if (title) s.title = title;
    return s;
  });

  // Re-build stateMap with enriched titles
  const enrichedMap = new Map(enrichedStates.map((s) => [s.titleId, s]));

  const general = enrichedStates.filter(isInToWatchQueue).sort(sortByLastActivity);
  const rewatch = enrichedStates.filter(isInRewatch).sort(sortByLastActivity);
  const toRate = enrichedStates.filter(isAwaitingRating).sort(sortByLastActivity);
  const toResume = enrichedStates.filter(canResumeFromNewContent).sort(sortByLastActivity);
  const inProgress = enrichedStates.filter(isInProgressSeries).sort(sortByLastActivity);

  // Liste membri: owner = mie, altrimenti shared
  const myLists = [];
  const sharedLists = [];
  memberLists.forEach((list) => {
    const decorated = pinDecorate(hydrateListProgressCounts(list, enrichedMap), pinnedSet);
    if (list.isOwnedByCurrentUser) myLists.push(decorated);
    else sharedLists.push(decorated);
  });

  // Watchlist "Default" virtuale (matching iOS default summary)
  const defaultWatchlist = {
    id: "__general__",
    title: i18nT("La mia watchlist"),
    description: null,
    visibility: "private",
    kind: "collection",
    ownerUid: uid,
    owner: null,
    memberUids: [uid],
    editorUids: [],
    cover: {
      imageURL: null,
      storagePath: null,
      fallbackTitleIds: general.slice(0, 4).map((s) => s.titleId),
      accentHex: null,
    },
    itemCount: general.length,
    completedCount: 0,
    followersCount: 0,
    isOwnedByCurrentUser: true,
    canEdit: true,
    isSavedByCurrentUser: false,
    isDefault: true,
    previewTitles: general.slice(0, 4).map((s) => s.title).filter(Boolean),
    _sortTime: Date.now(),
  };

  const publicListsDecorated = publicLists.map((list) => pinDecorate(list, pinnedSet));

  // Hydrate poster preview su liste reali (default già hydrato)
  await Promise.all([
    hydratePreviewTitles(myLists),
    hydratePreviewTitles(sharedLists),
    hydratePreviewTitles(publicListsDecorated),
  ]);

  return {
    generalWatchlist: general,
    rewatch,
    toRate,
    toResume,
    inProgress,
    myLists: [defaultWatchlist, ...myLists],
    sharedLists,
    publicLists: publicListsDecorated,
  };
}
