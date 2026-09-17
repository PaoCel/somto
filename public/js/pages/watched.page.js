import { qs, escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { toast } from "../components/toast.js";
import { initAuthGuard } from "../components/authGuard.js";
import { listMyTitleStates } from "../api/titleStates.api.js";
import { getTitleById, getTitlesByIds } from "../api/titles.api.js";

const listEl = qs("#list");

function parseTimestampMs(value) {
  if (!value) return 0;
  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date ? d.getTime() : 0;
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function getStateSortTime(item) {
  return Math.max(
    parseTimestampMs(item?.lastInteractionAt),
    parseTimestampMs(item?.completedAt),
    parseTimestampMs(item?.ratedAt),
    parseTimestampMs(item?.seenAt),
    parseTimestampMs(item?.updatedAt),
    parseTimestampMs(item?.createdAt)
  );
}

function hasStateRating(item) {
  return item?.ratingValue !== null && item?.ratingValue !== undefined;
}

function isCompletedState(item) {
  if (!item) return false;
  if (Number(item.completedCount || 0) > 0) return true;
  return item.mediaType === "tv"
    ? ["completed_unrated", "rated"].includes(item.state)
    : ["seen_unrated", "rated"].includes(item.state);
}

function sortStatesForDisplay(items) {
  return [...items].sort((a, b) => {
    const aRated = hasStateRating(a);
    const bRated = hasStateRating(b);
    if (aRated !== bRated) return aRated ? -1 : 1;
    return getStateSortTime(b) - getStateSortTime(a);
  });
}

function watchedEmptyState(message) {
  return `
    <div class="watched-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
      <p class="watched-empty-title">${i18nT("Niente di visto per ora")}</p>
      <p class="watched-empty-text">${message}</p>
    </div>
  `;
}

async function renderWatched(uid){
  listEl.innerHTML = `<div class="hint">${i18nT("Caricamento…")}</div>`;

  try {
    const fetched = await listMyTitleStates(uid, { max: 250 });
    const items = sortStatesForDisplay(fetched.filter(isCompletedState));
    if (!items.length){
      listEl.innerHTML = watchedEmptyState(i18nT("Compare qui quando segni un titolo come visto, anche senza voto."));
      return;
    }

    // Batched read invece di N+1 (1 query/30 id, cache 60s).
    const ids = items.map(i => i.titleId).filter(Boolean);
    const titlesMap = await getTitlesByIds(ids).catch(() => new Map());

    const rows = [];
    for (let idx = 0; idx < items.length; idx++){
      const it = items[idx];
      const t = titlesMap.get(it.titleId);
      if (!t) continue;

      const typeLabel = t.type === "movie" ? i18nT("Film") : t.type === "tv" ? i18nT("Serie TV") : (t.type || "");
      const yearLabel = t.year ? String(t.year) : "";
      const poster = t.posterPath
        ? `<img alt="" src="${escapeHtml(t.posterPath)}" loading="lazy" />`
        : `<div class="poster-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"></rect><circle cx="12" cy="12" r="3"></circle></svg></div>`;

      const rating = it.ratingValue ?? null;
      const metaPills = [
        typeLabel ? `<span class="watchlist-meta-pill">${escapeHtml(typeLabel)}</span>` : "",
        yearLabel ? `<span class="watchlist-meta-pill is-mono">${escapeHtml(yearLabel)}</span>` : "",
        rating !== null ? `<span class="watchlist-meta-pill is-rating"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>${escapeHtml(String(rating))}</span>` : "",
      ].filter(Boolean).join("");

      const statusLabel = rating !== null
        ? i18nT("Hai votato questo titolo.")
        : i18nT("Segnato come visto, senza voto.");

      rows.push(`
        <a class="watched-item" href="/title.html?id=${encodeURIComponent(t.id)}">
          <div class="watched-poster">${poster}</div>
          <div class="watched-body">
            <div class="watched-head">
              <div class="watched-title">${escapeHtml(t.name || "")}</div>
              <svg class="watched-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </div>
            ${metaPills ? `<div class="watchlist-row-meta-pills">${metaPills}</div>` : ""}
            <div class="watched-status">${statusLabel}</div>
          </div>
        </a>
      `);
    }

    listEl.innerHTML = rows.join("") || watchedEmptyState(i18nT("Nessun elemento visualizzabile per ora."));
  } catch (e){
    console.error(e);
    toast(e?.message || i18nT("Errore caricamento"), i18nT("Visti"));
    listEl.innerHTML = `<div class="hint">${i18nT("Errore nel caricamento.")}</div>`;
  }
}

initAuthGuard({ requireAuth: true, onReady: async (user) => {
  await renderWatched(user.uid);
}});
