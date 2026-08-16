import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { initTabbar } from "../utils/tabbar.js";
import { ensureUserDoc } from "../api/users.api.js";
import { addToWatchlist } from "../api/watchlist.api.js";
import { getMatchQueue, markMatchShown, saveMatchFeedback } from "../api/match.api.js";
import { listGenres, tmdbGenreCatalog } from "../api/genres.api.js";
import { toast } from "../components/toast.js";
import { qs, escapeHtml } from "../utils/dom.js";
import { logSignal } from "../api/signals.api.js";
import { logEvent, setAnalyticsUser } from "../analytics.js";
import { getExperimentVariant } from "../experiments.js";

initTabbar();

const retryBtn = qs("#matchRetryBtn");
const reloadBtn = qs("#matchReloadBtn");
const skeletonEl = qs("#matchSkeleton");
const errorEl = qs("#matchError");
const emptyEl = qs("#matchEmpty");
const deckEl = qs("#matchDeck");
const actionBarEl = qs("#matchActionBar");
const infoBtn = qs("#matchInfoBtn");
const infoSheetEl = qs("#matchInfoSheet");

const MATCH_HINT_STORAGE_KEY = "somto_match_hint_v1";

const state = {
  uid: "",
  queue: [],
  cursor: 0,
  loading: false,
  appending: false,
  submitting: false,
  fetchSeq: 0,
  seenIds: new Set(),
  shownTrackedIds: new Set(),
  genreMap: new Map(),
  firstActionDone: false,
  eventsBound: false,
  experimentVariant: "control",
  hintShown: false,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTitle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(value) {
  return normalizeTitle(value)
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

const TITLE_STOPWORDS = new Set([
  "the", "la", "lo", "il", "i", "gli", "le", "un", "una", "uno", "di", "da", "del", "della", "dei", "delle", "e", "and",
  "parte", "part", "chapter", "capitolo", "episodio", "episode", "stagione", "season", "volume", "vol",
]);

function sagaKey(item) {
  const name = String(item?.name || "").trim();
  if (!name) return "";
  const head = name.split(/[:\-–|]/)[0] || name;
  const tokens = titleTokens(head)
    .filter((t) => !TITLE_STOPWORDS.has(t))
    .filter((t) => !/^(ii|iii|iv|v|vi|vii|viii|ix|x|[0-9]+)$/.test(t));
  if (!tokens.length) return "";
  return tokens.slice(0, Math.min(2, tokens.length)).join(" ");
}

function areTooSimilar(a, b) {
  if (!a || !b) return false;
  if (String(a.id || "") === String(b.id || "")) return true;

  const keyA = sagaKey(a);
  const keyB = sagaKey(b);
  if (keyA && keyB && keyA === keyB) return true;

  const nameA = normalizeTitle(a.name);
  const nameB = normalizeTitle(b.name);
  if (!nameA || !nameB) return false;
  if (nameA.length >= 7 && nameB.includes(nameA)) return true;
  if (nameB.length >= 7 && nameA.includes(nameB)) return true;
  return false;
}

function currentItem() {
  return state.queue[state.cursor] || null;
}

function remainingCount() {
  return Math.max(0, state.queue.length - state.cursor);
}

function typeLabel(type) {
  return String(type || "").toLowerCase() === "tv" ? i18nT("Serie TV") : i18nT("Film");
}

function normalizeGenreKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function prettyGenreLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized
    .split(" ")
    .map((part) => part ? (part[0].toUpperCase() + part.slice(1)) : "")
    .join(" ");
}

function isOpaqueGenreKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return true;
  if (/^tmdb[_\s-]?\d+$/.test(raw)) return false;
  if (raw.includes(" ")) return false;
  return /^[a-z0-9_-]{12,}$/.test(raw);
}

function genreLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const direct = state.genreMap.get(raw);
  if (direct) return direct;
  const lower = state.genreMap.get(normalizeGenreKey(raw));
  if (lower) return lower;
  if (isOpaqueGenreKey(raw)) return "";
  return prettyGenreLabel(raw);
}

function posterFallbackSvg() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"></path>
      <path d="M4 9.5h16"></path>
      <path d="M9 4v16"></path>
      <path d="M15 4v16"></path>
    </svg>
  `;
}

function setView(view) {
  const showSkeleton = view === "skeleton";
  const showError = view === "error";
  const showEmpty = view === "empty";
  const showDeck = view === "deck";

  if (skeletonEl) skeletonEl.style.display = showSkeleton ? "" : "none";
  if (errorEl) errorEl.style.display = showError ? "" : "none";
  if (emptyEl) emptyEl.style.display = showEmpty ? "" : "none";
  if (deckEl) deckEl.style.display = showDeck ? "" : "none";
  if (actionBarEl) actionBarEl.style.display = showDeck ? "" : "none";
}

function updateControls() {
  if (!actionBarEl) return;
  const lock = state.submitting || state.loading;
  actionBarEl.classList.toggle("is-disabled", lock);
  actionBarEl.querySelectorAll(".match-action").forEach((btn) => {
    btn.disabled = lock;
  });
}

function normalizePoster(path) {
  const p = String(path || "").trim();
  return p ? escapeHtml(p) : "";
}

function renderCard(item, depth) {
  const poster = normalizePoster(item.posterPath);
  const title = escapeHtml(item.name || i18nT("(senza titolo)"));
  const year = item.year ? ` · ${escapeHtml(String(item.year))}` : "";
  const type = escapeHtml(typeLabel(item.type));
  const subtitle = `${type}${year}`;
  const ratingAvg = Number(item.ratingAvg || 0);
  const overview = escapeHtml(item.overview || i18nT("Nessuna overview disponibile al momento."));
  const genres = Array.isArray(item.genres)
    ? item.genres
      .slice(0, 3)
      .map((g) => genreLabel(g))
      .filter(Boolean)
    : [];
  const genreText = escapeHtml(genres.slice(0, 2).join(" • "));
  const cast = Array.isArray(item.cast)
    ? item.cast.map((c) => String(c || "").trim()).filter(Boolean)
    : [];
  const castText = escapeHtml(cast.slice(0, 2).join(" • "));

  const classes = [
    "match-card",
    depth === 0 ? "match-card-enter" : "",
    depth === 0 ? "match-card-top" : `depth-${depth}`,
  ].join(" ");
  const tabIndex = depth === 0 ? "0" : "-1";

  const communityBadge = ratingAvg > 0
    ? `<span class="match-pill match-pill-rating">
         <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M12 2l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.02 6.1 20.17l1.13-6.57L2.45 8.94l6.6-.96L12 2z"></path></svg>
         <strong>${escapeHtml(ratingAvg.toFixed(1))}</strong>
         <em>${"community"}</em>
       </span>`
    : "";

  return `
    <article class="${classes}" data-card-id="${escapeHtml(item.id)}" data-depth="${depth}" role="button" tabindex="${tabIndex}" aria-label="${i18nT("Apri scheda di {title}", { title })}">
      <div class="match-card-media">
        ${poster
          ? `<img src="${poster}" alt="" loading="${depth === 0 ? "eager" : "lazy"}">`
          : `<div class="match-poster-fallback" aria-hidden="true">${posterFallbackSvg()}</div>`}
        <div class="match-card-shade"></div>
      </div>
      <div class="match-card-info">
        <div class="match-pills">
          <span class="match-pill">${subtitle}</span>
          ${communityBadge}
        </div>
        <h2 class="match-card-title">${title}</h2>
        ${genreText ? `<p class="match-card-genres">${genreText}</p>` : ""}
        ${castText ? `<p class="match-card-cast">${castText}</p>` : ""}
        <p class="match-card-overview">${overview}</p>
      </div>
      <div class="match-swipe-stamp left" aria-hidden="true">NOPE</div>
      <div class="match-swipe-stamp right" aria-hidden="true">LIKE</div>
      <div class="match-swipe-stamp up" aria-hidden="true">SUPERLIKE</div>
      <div class="match-swipe-stamp down" aria-hidden="true">VISTO</div>
    </article>
  `;
}

function renderDeck() {
  const remain = state.queue.slice(state.cursor);

  if (!remain.length) {
    setView("empty");
    if (deckEl) deckEl.innerHTML = "";
    return;
  }

  const cards = remain.slice(0, 3).map((item, idx) => renderCard(item, idx)).join("");
  if (deckEl) deckEl.innerHTML = cards;
  setView("deck");
  updateControls();
  wireTopCardSwipe();
  void markTopAsShown();
  maybeShowMatchHint();
}

function collectExcludeIds() {
  const out = new Set(state.seenIds);
  for (let i = state.cursor; i < state.queue.length; i++) {
    const id = String(state.queue[i]?.id || "").trim();
    if (id) out.add(id);
  }
  return Array.from(out);
}

function diversifyQueue(items, minGap = 2) {
  const pool = safeArray(items).slice();
  if (pool.length <= 2) return pool;

  const out = [];
  while (pool.length) {
    const recent = out.slice(Math.max(0, out.length - minGap));
    let picked = -1;

    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      const conflict = recent.some((r) => areTooSimilar(candidate, r));
      if (!conflict) {
        picked = i;
        break;
      }
    }

    if (picked < 0) picked = 0;
    out.push(pool.splice(picked, 1)[0]);
  }
  return out;
}

function pushSimilarTailAfterSkip(seedItem) {
  const pivot = state.cursor + 1;
  if (!seedItem || pivot >= state.queue.length) return;

  const head = state.queue.slice(0, pivot);
  const tail = state.queue.slice(pivot);
  const similar = [];
  const others = [];

  for (const row of tail) {
    if (areTooSimilar(seedItem, row)) similar.push(row);
    else others.push(row);
  }

  if (!similar.length) return;
  state.queue = head.concat(others, similar);
}

function dedupeAndAppend(items) {
  if (!Array.isArray(items) || !items.length) return 0;

  const existing = new Set(state.queue.map((x) => String(x?.id || "").trim()).filter(Boolean));
  const ordered = diversifyQueue(items, 2);
  let added = 0;
  for (const item of ordered) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    if (existing.has(id)) continue;
    if (state.seenIds.has(id)) continue;
    state.queue.push(item);
    existing.add(id);
    added++;
  }
  return added;
}

function resolveDeckMax({ append = false, isFirstWindow = false, variant = "control" } = {}) {
  if (variant === "dense") {
    if (append) return 18;
    return isFirstWindow ? 14 : 10;
  }
  if (variant === "lean") {
    if (append) return 10;
    return isFirstWindow ? 8 : 6;
  }
  if (append) return 14;
  return isFirstWindow ? 10 : 8;
}

async function fetchDeck({ append = false, resetCursor = false } = {}) {
  if (!state.uid) return;
  if (append && (state.loading || state.appending)) return;
  if (!append && state.loading) return;

  const seq = ++state.fetchSeq;
  if (append) {
    state.appending = true;
  } else {
    state.loading = true;
    if (resetCursor) {
      state.queue = [];
      state.cursor = 0;
    }
    setView("skeleton");
  }
  updateControls();

  let loadedOk = false;
  try {
    const isFirstWindow = !append && (resetCursor || (state.cursor === 0 && state.queue.length === 0));
    const payload = {
      max: resolveDeckMax({
        append,
        isFirstWindow,
        variant: state.experimentVariant,
      }),
      fastStart: isFirstWindow,
      excludeTitleIds: collectExcludeIds(),
    };
    const data = await getMatchQueue(payload);
    if (seq !== state.fetchSeq) return;

    let itemsLoaded = 0;
    if (append) {
      itemsLoaded = dedupeAndAppend(data?.items || []);
      if (remainingCount() > 0) renderDeck();
    } else {
      state.queue = [];
      state.cursor = 0;
      itemsLoaded = dedupeAndAppend(data?.items || []);
      renderDeck();
    }

    void logEvent("match_deck_loaded", {
      append,
      fast_start: isFirstWindow,
      items_loaded: itemsLoaded,
      items_total: remainingCount(),
      engine: data?.engine || "hybrid",
      variant: state.experimentVariant,
    });
    loadedOk = true;
  } catch (err) {
    console.error("[match] fetchDeck error:", err);
    if (!append) {
      setView("error");
    } else {
      toast(i18nT("Non riesco a caricare altri match adesso"), i18nT("Match"));
    }
  } finally {
    if (append) state.appending = false;
    else state.loading = false;
    updateControls();

    if (!append && loadedOk && remainingCount() <= 5) {
      window.setTimeout(() => {
        void fetchDeck({ append: true });
      }, 60);
    }
  }
}

async function markTopAsShown() {
  const item = currentItem();
  if (!item || !state.uid) return;
  if (state.shownTrackedIds.has(item.id)) return;

  state.shownTrackedIds.add(item.id);
  state.seenIds.add(item.id);
  try {
    await markMatchShown(state.uid, item);
  } catch (err) {
    console.warn("[match] mark shown failed:", err?.message || err);
  }
}

function animateCardOut(card, action) {
  return new Promise((resolve) => {
    if (!card) {
      resolve();
      return;
    }

    let tx = 0;
    let ty = 0;
    let rot = 0;
    if (action === "skip") {
      tx = -Math.max(window.innerWidth * 0.9, 420);
      rot = -16;
    } else if (action === "like") {
      tx = Math.max(window.innerWidth * 0.9, 420);
      rot = 16;
    } else if (action === "seen") {
      ty = Math.max(window.innerHeight * 0.72, 500);
      rot = -6;
    } else {
      ty = -Math.max(window.innerHeight * 0.7, 460);
      rot = 6;
    }

    card.style.transition = "transform 180ms ease, opacity 180ms ease";
    card.style.opacity = "0";
    card.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
    window.setTimeout(resolve, 190);
  });
}

async function persistAction(item, action) {
  const tasks = [saveMatchFeedback(state.uid, item, action)];
  if (action === "like" || action === "superlike" || action === "seen") {
    const isSeen = action === "seen";
    tasks.push(
      addToWatchlist(state.uid, item.id, {
        priority: isSeen
          ? "low"
          : (action === "superlike" ? "high" : "normal"),
        watchState: isSeen ? "to_rate" : "to_watch",
        source: isSeen ? "match_seen" : "match",
      })
    );
  }
  await Promise.all(tasks);
  // unified signals
  const actionType = action === "skip"
    ? "match_dislike"
    : action === "superlike"
      ? "match_love"
      : action === "seen"
        ? "match_seen"
        : "match_ok";
  const normalizedValue = action === "skip" ? -1 : action === "seen" ? 0 : 1;
  logSignal({
    uid: state.uid,
    titleId: item.id,
    actionType,
    rawValue: null,
    normalizedValue,
    source: "match",
  }).catch((err) => console.warn("logSignal match", err));
}

async function performAction(action) {
  if (state.submitting || state.loading) return;
  const item = currentItem();
  if (!item) return;

  const card = deckEl?.querySelector(".match-card-top");
  state.submitting = true;
  updateControls();

  try {
    await Promise.all([
      persistAction(item, action),
      animateCardOut(card, action),
    ]);

    void logEvent("match_action", {
      action,
      title_type: item?.type || "movie",
      match_percent: Number(item?.matchPercent || 0) || 0,
      score: Number(item?.score || 0) || 0,
      variant: state.experimentVariant,
    });

    if (action === "skip") toast("Passato", i18nT("Match"));
    if (action === "like") toast(i18nT("Salvato in Da vedere"), i18nT("Match"));
    if (action === "superlike") toast(i18nT("Super match in Da vedere"), i18nT("Match"));
    if (action === "seen") toast(i18nT("Salvato in Da votare"), i18nT("Match"));

    if (action === "skip") {
      pushSimilarTailAfterSkip(item);
    }

    state.cursor += 1;
    if (!state.firstActionDone) {
      state.firstActionDone = true;
      // Primo swipe riuscito: se la sheet hint è ancora aperta, chiudila e ricordalo.
      if (infoSheetEl?.classList.contains("is-open")) closeInfoSheetAndMarkSeen();
      else markMatchHintSeen();
    }
    renderDeck();

    if (remainingCount() <= 5) {
      void fetchDeck({ append: true });
    }
  } catch (err) {
    console.error("[match] action error:", err);
    toast(i18nT("Errore salvataggio, riprova"), i18nT("Match"));
    renderDeck();
  } finally {
    state.submitting = false;
    updateControls();
  }
}

function resetCardPosition(card) {
  if (!card) return;
  card.classList.remove("swipe-left", "swipe-right", "swipe-up", "swipe-down");
  card.style.transition = "transform 150ms ease";
  card.style.transform = "";
}

function wireTopCardSwipe() {
  const card = deckEl?.querySelector(".match-card-top");
  if (!card) return;
  const depthOne = deckEl?.querySelector(".match-card.depth-1");
  const depthTwo = deckEl?.querySelector(".match-card.depth-2");

  let activePointer = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;
  let startMs = 0;

  const openCardDetails = () => {
    const titleId = String(card.getAttribute("data-card-id") || "").trim();
    if (!titleId) return;
    window.location.href = `/title.html?id=${encodeURIComponent(titleId)}`;
  };

  const clearDeckDragging = () => {
    deckEl?.classList.remove("is-dragging");
  };

  const syncDepthCards = () => {
    const pullX = clamp(dx / 16, -8, 8);
    const pullY = clamp(Math.abs(dy) / 18, 0, 9);
    const energy = clamp(Math.abs(dx) / 120, 0, 1);

    if (depthOne) {
      depthOne.style.transition = "none";
      depthOne.style.transform =
        `translateY(${12 - (pullY * 0.55)}px) scale(${0.96 + (energy * 0.014)})`;
      depthOne.style.opacity = String((0.92 + (energy * 0.05)).toFixed(2));
    }

    if (depthTwo) {
      depthTwo.style.transition = "none";
      depthTwo.style.transform =
        `translateY(${24 - (pullY * 0.45)}px) scale(${0.92 + (energy * 0.012)})`;
      depthTwo.style.opacity = String((0.84 + (energy * 0.05)).toFixed(2));
    }
  };

  const resetDepthCards = () => {
    if (depthOne) {
      depthOne.style.transition = "";
      depthOne.style.transform = "";
      depthOne.style.opacity = "";
    }
    if (depthTwo) {
      depthTwo.style.transition = "";
      depthTwo.style.transform = "";
      depthTwo.style.opacity = "";
    }
  };

  const onPointerDown = (ev) => {
    if (state.submitting || state.loading) return;
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    activePointer = ev.pointerId;
    card.classList.remove("match-card-enter");
    startX = ev.clientX;
    startY = ev.clientY;
    dx = 0;
    dy = 0;
    startMs = Date.now();
    card.setPointerCapture(activePointer);
    card.style.transition = "none";
    deckEl?.classList.add("is-dragging");
  };

  const onPointerMove = (ev) => {
    if (activePointer === null || ev.pointerId !== activePointer) return;
    dx = ev.clientX - startX;
    dy = ev.clientY - startY;
    const rot = clamp(dx / 18, -12, 12);
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    syncDepthCards();

    card.classList.toggle("swipe-right", dx > 40 && Math.abs(dx) >= Math.abs(dy));
    card.classList.toggle("swipe-left", dx < -40 && Math.abs(dx) >= Math.abs(dy));
    card.classList.toggle("swipe-up", dy < -65 && Math.abs(dx) < 95);
    card.classList.toggle("swipe-down", dy > 65 && Math.abs(dx) < 95);
  };

  const onPointerEnd = async (ev) => {
    if (activePointer === null || ev.pointerId !== activePointer) return;
    try {
      card.releasePointerCapture(activePointer);
    } catch (_) {}
    activePointer = null;
    clearDeckDragging();

    if (state.submitting || state.loading) {
      resetCardPosition(card);
      resetDepthCards();
      return;
    }

    let action = "";
    if (dx >= 110 && Math.abs(dx) >= Math.abs(dy)) action = "like";
    else if (dx <= -110 && Math.abs(dx) >= Math.abs(dy)) action = "skip";
    else if (dy <= -120 && Math.abs(dx) < 95) action = "superlike";
    else if (dy >= 130 && Math.abs(dx) < 95) action = "seen";

    if (!action) {
      const dist = Math.hypot(dx, dy);
      const elapsed = Date.now() - startMs;
      if (dist < 10 && elapsed < 350) {
        resetDepthCards();
        openCardDetails();
        return;
      }
      resetCardPosition(card);
      resetDepthCards();
      return;
    }

    card.classList.remove("swipe-left", "swipe-right", "swipe-up", "swipe-down");
    resetDepthCards();
    await performAction(action);
  };

  const onKeyDown = (ev) => {
    if (state.submitting || state.loading) return;
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    openCardDetails();
  };

  card.addEventListener("pointerdown", onPointerDown);
  card.addEventListener("pointermove", onPointerMove);
  card.addEventListener("pointerup", onPointerEnd);
  card.addEventListener("pointercancel", onPointerEnd);
  card.addEventListener("keydown", onKeyDown);
}

/* ===== Info sheet ("Come funziona") ===== */
function openInfoSheet() {
  if (!infoSheetEl) return;
  infoSheetEl.classList.add("is-open");
  infoSheetEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("match-sheet-open");
}

function closeInfoSheet() {
  if (!infoSheetEl) return;
  infoSheetEl.classList.remove("is-open");
  infoSheetEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("match-sheet-open");
}

function markMatchHintSeen() {
  try {
    localStorage.setItem(MATCH_HINT_STORAGE_KEY, "1");
  } catch (_) { /* storage non disponibile, ignora */ }
}

function closeInfoSheetAndMarkSeen() {
  closeInfoSheet();
  markMatchHintSeen();
}

/** Mostra la sheet "Come funziona" una sola volta, dopo il primo deck caricato con successo. */
function maybeShowMatchHint() {
  if (state.hintShown) return;
  let alreadySeen = false;
  try {
    alreadySeen = !!localStorage.getItem(MATCH_HINT_STORAGE_KEY);
  } catch (_) {
    alreadySeen = false;
  }
  if (alreadySeen) return;
  state.hintShown = true;
  openInfoSheet();
}

async function warmGenreMap() {
  try {
    const rows = await listGenres(400).catch(() => []);
    const allRows = safeArray(rows).concat(tmdbGenreCatalog());
    const map = new Map();
    for (const row of allRows) {
      const id = String(row?.id || "").trim();
      const name = String(row?.name || "").trim();
      if (!id || !name) continue;
      map.set(id, name);
      map.set(normalizeGenreKey(id), name);
      map.set(normalizeGenreKey(name), name);
    }
    state.genreMap = map;
    if (remainingCount() > 0) renderDeck();
  } catch (err) {
    console.warn("[match] genre map load failed:", err?.message || err);
  }
}

function bindEvents() {
  if (state.eventsBound) return;
  state.eventsBound = true;

  retryBtn?.addEventListener("click", () => {
    void fetchDeck({ append: false, resetCursor: false });
  });

  reloadBtn?.addEventListener("click", () => {
    state.seenIds.clear();
    state.shownTrackedIds.clear();
    void fetchDeck({ append: false, resetCursor: true });
  });

  actionBarEl?.querySelectorAll(".match-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = String(btn.getAttribute("data-action") || "").trim();
      if (!action) return;
      void performAction(action);
    });
  });

  infoBtn?.addEventListener("click", openInfoSheet);
  infoSheetEl?.querySelectorAll("[data-sheet-dismiss]").forEach((node) => {
    node.addEventListener("click", closeInfoSheetAndMarkSeen);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && infoSheetEl?.classList.contains("is-open")) {
      closeInfoSheetAndMarkSeen();
    }
  });
}

async function bootstrap(user) {
  state.uid = user.uid;
  state.seenIds.clear();
  state.shownTrackedIds.clear();
  state.firstActionDone = false;
  await ensureUserDoc(user).catch(() => {});
  void setAnalyticsUser(user);
  const experimentVariant = await getExperimentVariant("match_deck_variant", { fallback: "control" })
    .catch(() => "control");
  state.experimentVariant = experimentVariant || "control";
  bindEvents();
  void warmGenreMap();
  await fetchDeck({ append: false, resetCursor: true });
}

initAuthGuard({
  requireAuth: true,
  onReady: (user) => {
    if (!user) return;
    void bootstrap(user);
  },
});
