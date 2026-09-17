/**
 * lista.page.js — Dettaglio lista pubblica/condivisa.
 * URL: /lista.html?id={listId}
 * Autenticazione richiesta (initAuthGuard).
 * Carica la lista via fetchListDetail, mostra cover, info, azioni,
 * e gli item con progresso personale (film: toggle visto/da vedere;
 * TV serie: barra stagioni con toggle per stagione).
 *
 * Progresso scritto su users/{uid}/listProgressEntries/{listId}__{titleId}
 * (schema allineato a iOS WatchlistRepository.publicListProgressRef).
 */

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { escapeHtml } from "../utils/dom.js";
import { toast } from "../components/toast.js";

import {
  collection,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { db } from "../firebase.js";

import {
  fetchListDetail,
  togglePublicListPin,
  fetchPinnedPublicListIds,
} from "../api/userLists.api.js";
import { getTitlesByIds } from "../api/titles.api.js";

/* ═══════════════════ state ═══════════════════ */

let currentUid = null;
let listId = null;
let listDetail = null;          // { list, items, members, progress }
let titlesMap = new Map();      // titleId -> titleDoc
let progressMap = new Map();    // titleId -> progressEntry
let isPinned = false;

const root = document.getElementById("listaRoot");

/* ═══════════════════ helpers ═══════════════════ */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v == null) return;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function svgIcon(html, size = 18) {
  const wrap = document.createElement("span");
  wrap.style.display = "inline-flex";
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${html}</svg>`;
  return wrap.firstChild;
}

function posterUrl(title) {
  if (!title) return null;
  return title.posterPath || title.backdropPath || null;
}

function safeArray(v) { return Array.isArray(v) ? v : []; }

function materializeSeasons(meta) {
  const perSeason = meta?.episodesPerSeason;
  const seasonsCount = Number(meta?.seasonsCount || 0) || 0;
  if (Array.isArray(perSeason) && perSeason.length > 0) {
    return perSeason.map((eps, i) => ({
      season: i + 1,
      episodes: Math.max(0, Number(eps || 0)),
    }));
  }
  if (seasonsCount > 0) {
    return Array.from({ length: seasonsCount }, (_, i) => ({
      season: i + 1,
      episodes: Math.max(0, Number(meta?.durationEpisode || meta?.episodesCount || 0) > 0 ? 1 : 0),
    }));
  }
  return [];
}

function progressDocId(listIdVal, titleId) {
  return `${listIdVal}__${titleId}`;
}

function progressRef(uid, listIdVal, titleId) {
  return doc(db, "users", uid, "listProgressEntries", progressDocId(listIdVal, titleId));
}

/* ═══════════════════ firestore progress ═══════════════════ */

async function loadProgressEntries() {
  if (!currentUid || !listId || !listDetail) return;
  const titleIds = listDetail.items.map((i) => i.titleId).filter(Boolean);
  if (!titleIds.length) return;

  const reads = titleIds.map(async (tid) => {
    const snap = await getDoc(progressRef(currentUid, listId, tid)).catch(() => null);
    if (snap?.exists()) {
      progressMap.set(tid, snap.data() || {});
    }
  });
  await Promise.all(reads);
}

async function saveProgressEntry(titleId, patch) {
  if (!currentUid || !listId || !titleId) return;
  const ref = progressRef(currentUid, listId, titleId);
  const existing = progressMap.get(titleId) || {};
  const next = {
    ...existing,
    listId,
    titleId,
    ...patch,
    updatedAt: serverTimestamp(),
    lastInteractionAt: serverTimestamp(),
  };
  await setDoc(ref, next, { merge: true });
  progressMap.set(titleId, next);
}

/* ═══════════════════ render cover ═══════════════════ */

function buildCover(list) {
  const posters = list.previewTitles
    ? list.previewTitles.map(posterUrl).filter(Boolean).slice(0, 4)
    : [];

  let coverInner;
  if (posters.length === 0) {
    coverInner = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`;
  } else {
    coverInner = posters.slice(0, 4)
      .map((url) => `<div class="ls-cover-cell" style="background-image:url(${escapeHtml(url)})"></div>`)
      .join("");
  }

  const isEditorial = list.editorial === true;
  const visibilityLabels = {
    private: i18nT("Privata"),
    shared: i18nT("Condivisa"),
    public: i18nT("Pubblica"),
  };
  const visibility = visibilityLabels[list.visibility] ? list.visibility : "private";
  const chipLabel = isEditorial ? "Editoriale" : visibilityLabels[visibility];
  const chipClass = isEditorial ? "ls-vis-chip editorial" : `ls-vis-chip ${visibility}`;

  return `
    <div class="ls-cover${posters.length === 0 ? " no-posters" : ""}">
      ${coverInner}
      <span class="${chipClass}">${escapeHtml(chipLabel)}</span>
    </div>
  `;
}

/* ═══════════════════ render header ═══════════════════ */

function buildHeader(list) {
  const ownerName = list.owner?.displayName || i18nT("Somto");
  const ownerUid = list.ownerUid || "";
  const itemsText = i18nT("{count} titoli", { count: list.itemCount });
  const desc = list.description ? `<p class="ls-description">${escapeHtml(list.description)}</p>` : "";

  return `
    <div class="ls-header">
      ${buildCover(list)}
      <div class="ls-header-body">
        <h1 class="ls-title">${escapeHtml(list.title)}</h1>
        ${desc}
        <div class="ls-meta-row">
          <a class="ls-owner-link" href="/user.html?uid=${encodeURIComponent(ownerUid)}">${escapeHtml(ownerName)}</a>
          <span class="ls-dot">·</span>
          <span>${escapeHtml(itemsText)}</span>
          ${list.followersCount > 0 ? `<span class="ls-dot">·</span><span>${list.followersCount} follower</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

/* ═══════════════════ share / copy link ═══════════════════ */

function buildShareUrl(list) {
  const slug = list.slug || list.editorialSlug || list.id;
  return `https://somto.it/lista/${encodeURIComponent(slug)}`;
}

async function handleShare(list) {
  const url = buildShareUrl(list);
  try {
    if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
      await navigator.share({ title: list.title, url });
      return;
    }
  } catch (_) { /* user cancelled */ }
  try {
    await navigator.clipboard.writeText(url);
    toast(i18nT("Link copiato negli appunti"), i18nT("Lista"));
  } catch (_) {
    toast(`Link: ${url}`, i18nT("Lista"));
  }
}

/* ═══════════════════ pin / follow ═══════════════════ */

function buildPinRow(list) {
  if (list.isOwnedByCurrentUser) return "";
  if (list.visibility !== "public") return "";
  const btnLabel = isPinned ? "Salvata" : i18nT("Salva lista");
  const btnClass = isPinned ? "ls-pin-btn is-pinned" : "ls-pin-btn";
  return `
    <div class="ls-pin-row">
      <span class="ls-pin-text">${isPinned ? i18nT("Hai salvato questa lista.") : i18nT("Salva per trovare facilmente questa lista.")}</span>
      <button id="lsPinBtn" class="${btnClass}" type="button" aria-pressed="${isPinned ? "true" : "false"}">${escapeHtml(btnLabel)}</button>
    </div>
  `;
}

/* ═══════════════════ movie toggle ═══════════════════ */

function buildMovieToggle(titleId) {
  const prog = progressMap.get(titleId);
  const state = String(prog?.state || "").trim();
  const isSeen = state === "completed";
  const label = isSeen ? i18nT("Visto") : i18nT("Da vedere");
  return `
    <div class="ls-item-progress">
      <div class="ls-movie-toggle">
        <span class="ls-toggle-label">${isSeen ? i18nT("Hai visto questo film") : i18nT("Non ancora visto")}</span>
        <button
          class="ls-toggle-btn${isSeen ? " is-seen" : ""}"
          type="button"
          data-titleid="${escapeHtml(titleId)}"
          data-is-seen="${isSeen ? "1" : "0"}"
          aria-pressed="${isSeen}"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="${isSeen ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
          ${escapeHtml(label)}
        </button>
      </div>
    </div>
  `;
}

/* ═══════════════════ TV seasons progress ═══════════════════ */

function buildTvProgress(titleId, title) {
  const prog = progressMap.get(titleId);
  const sp = prog?.seriesProgress && typeof prog.seriesProgress === "object" ? prog.seriesProgress : null;
  const seasons = materializeSeasons(title?.meta || {});
  const seasonsCount = seasons.length;
  if (seasonsCount === 0) {
    // No season data: fall back to simple seen toggle
    const state = String(prog?.state || "").trim();
    const isSeen = state === "completed";
    return `
      <div class="ls-item-progress">
        <div class="ls-movie-toggle">
          <span class="ls-toggle-label">${isSeen ? i18nT("Serie completata") : i18nT("Non ancora vista")}</span>
          <button
            class="ls-toggle-btn${isSeen ? " is-seen" : ""}"
            type="button"
            data-titleid="${escapeHtml(titleId)}"
            data-mode="tv-simple"
            data-is-seen="${isSeen ? "1" : "0"}"
            aria-pressed="${isSeen}"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="${isSeen ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
            ${isSeen ? i18nT("Completata") : i18nT("Da vedere")}
          </button>
        </div>
      </div>
    `;
  }

  const doneSeasonsCount = sp?.seasonsCompletedCount || 0;
  const totalEps = seasons.reduce((s, x) => s + (x.episodes || 1), 0);
  const watchedEps = sp?.episodesWatchedCount || 0;
  const fraction = totalEps > 0 ? Math.min(1, watchedEps / totalEps) : 0;
  const pct = Math.round(fraction * 100);

  const progressBar = `
    <div class="ls-tv-progress-bar-row">
      <div class="ls-tv-progress-bar"><span style="width:${pct}%"></span></div>
      <span class="ls-tv-progress-label">${doneSeasonsCount}/${seasonsCount} stagioni</span>
    </div>
  `;

  const seasonsHtml = seasons.map((s) => {
    const sNum = s.season;
    const isDone = sNum <= doneSeasonsCount;
    return `
      <div class="ls-season-row">
        <span class="ls-season-label">Stagione ${sNum}</span>
        <button
          class="ls-season-toggle${isDone ? " is-done" : ""}"
          type="button"
          data-titleid="${escapeHtml(titleId)}"
          data-season="${sNum}"
          data-total-seasons="${seasonsCount}"
          aria-pressed="${isDone}"
        >${isDone ? i18nT("Completata") : i18nT("Segna completata")}</button>
      </div>
    `;
  }).join("");

  return `
    <div class="ls-item-progress">
      <div class="ls-tv-progress">
        ${progressBar}
        <div class="ls-seasons" id="ls-seasons-${escapeHtml(titleId)}" hidden>
          ${seasonsHtml}
        </div>
        <button class="ls-expand-btn" type="button"
          data-expand-titleid="${escapeHtml(titleId)}"
          aria-expanded="false"
          aria-controls="ls-seasons-${escapeHtml(titleId)}"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          Stagioni
        </button>
      </div>
    </div>
  `;
}

/* ═══════════════════ render item ═══════════════════ */

function buildItem(item, index) {
  const { titleId } = item;
  const title = titlesMap.get(titleId);
  const name = title?.name || titleId;
  const year = title?.year ? String(title.year) : null;
  const type = (title?.type || title?.mediaType || "").toLowerCase();
  const isTV = type === "tv";
  const poster = title ? posterUrl(title) : null;
  const genresMeta = year || "";

  const posterEl = poster
    ? `<img class="ls-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async">`
    : `<div class="ls-poster-ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`;

  const noteHtml = item.note ? `<p class="ls-item-note">${escapeHtml(item.note)}</p>` : "";

  const progressZone = isTV
    ? buildTvProgress(titleId, title)
    : buildMovieToggle(titleId);

  return `
    <article class="ls-item" data-titleid="${escapeHtml(titleId)}">
      <a class="ls-item-main" href="/title.html?id=${encodeURIComponent(titleId)}">
        ${posterEl}
        <div class="ls-item-body">
          <span class="ls-item-num">${index + 1}</span>
          <div class="ls-item-name">${escapeHtml(name)}</div>
          <div class="ls-item-meta">
            <span class="ls-type-chip">${isTV ? i18nT("Serie") : i18nT("Film")}</span>
            ${genresMeta ? `<span class="ls-item-sub">${escapeHtml(genresMeta)}</span>` : ""}
          </div>
          ${noteHtml}
        </div>
      </a>
      ${progressZone}
    </article>
  `;
}

/* ═══════════════════ full page render ═══════════════════ */

function renderPage() {
  if (!root || !listDetail) return;

  const { list, items } = listDetail;
  const canSharePublicly = list.visibility === "public";

  const shareUrl = buildShareUrl(list);
  const shareBtn = `
    <button class="ls-action-btn" type="button" id="lsShareBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
        <polyline points="16 6 12 2 8 6"/>
        <line x1="12" y1="2" x2="12" y2="15"/>
      </svg>
      ${i18nT("Condividi")}
    </button>
  `;

  const copyBtn = `
    <button class="ls-action-btn" type="button" id="lsCopyBtn"
      title="${escapeHtml(shareUrl)}"
      aria-label="${i18nT("Copia link lista")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      ${i18nT("Copia link")}
    </button>
  `;

  const itemsHtml = items.length
    ? items.map((item, i) => buildItem(item, i)).join("")
    : `<div class="ls-empty">
         <div class="ls-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></div>
         <h3>${i18nT("Lista vuota")}</h3>
         <p>${i18nT("Questa lista non contiene ancora nessun titolo.")}</p>
       </div>`;

  root.innerHTML = `
    ${buildHeader(list)}
    ${buildPinRow(list)}
    ${canSharePublicly ? `<div class="ls-actions">${shareBtn}${copyBtn}</div>` : ""}
    <div class="ls-section-head">
      <h2 class="ls-section-title">${i18nT("Titoli")}</h2>
      <span class="ls-count-badge">${items.length}</span>
    </div>
    <div class="ls-items">${itemsHtml}</div>
  `;

  bindActions(list);
}

/* ═══════════════════ event binding ═══════════════════ */

function bindActions(list) {
  // Share
  document.getElementById("lsShareBtn")?.addEventListener("click", () => handleShare(list));
  document.getElementById("lsCopyBtn")?.addEventListener("click", async () => {
    const url = buildShareUrl(list);
    try {
      await navigator.clipboard.writeText(url);
      toast(i18nT("Link copiato!"), "Lista");
    } catch (_) {
      toast(`Link: ${url}`, i18nT("Lista"));
    }
  });

  // Pin / follow
  const pinBtn = document.getElementById("lsPinBtn");
  if (pinBtn) {
    pinBtn.addEventListener("click", () => handlePinToggle(list));
  }

  // Movie toggles
  root.querySelectorAll(".ls-toggle-btn[data-titleid]").forEach((btn) => {
    btn.addEventListener("click", () => handleMovieToggle(btn));
  });

  // TV season toggles
  root.querySelectorAll(".ls-season-toggle[data-titleid]").forEach((btn) => {
    btn.addEventListener("click", () => handleSeasonToggle(btn));
  });

  // Expand/collapse seasons
  root.querySelectorAll(".ls-expand-btn[data-expand-titleid]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tid = btn.getAttribute("data-expand-titleid");
      const seasonsEl = document.getElementById(`ls-seasons-${tid}`);
      if (!seasonsEl) return;
      const isOpen = seasonsEl.hidden === false;
      seasonsEl.hidden = isOpen;
      btn.setAttribute("aria-expanded", String(!isOpen));
      btn.classList.toggle("is-open", !isOpen);
    });
  });
}

async function handleMovieToggle(btn) {
  const titleId = btn.getAttribute("data-titleid");
  const isSeen = btn.getAttribute("data-is-seen") === "1";
  const mode = btn.getAttribute("data-mode") || "movie";
  const newSeen = !isSeen;

  btn.disabled = true;

  // Stati ammessi da firestore.rules per listProgressEntries: not_started | in_progress | completed.
  const newState = newSeen ? "completed" : "not_started";

  try {
    const patch = { state: newState, mediaType: mode === "tv-simple" ? "tv" : "movie" };
    if (newSeen) {
      patch.completedAt = serverTimestamp();
    }
    await saveProgressEntry(titleId, patch);

    // Re-render only this item's progress zone
    const article = root.querySelector(`article[data-titleid="${CSS.escape(titleId)}"]`);
    if (article) {
      const oldProgress = article.querySelector(".ls-item-progress");
      const title = titlesMap.get(titleId);
      const isTV = (title?.type || "").toLowerCase() === "tv";
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = isTV ? buildTvProgress(titleId, title) : buildMovieToggle(titleId);
      const newProgress = tempDiv.firstElementChild;
      if (oldProgress && newProgress) {
        oldProgress.replaceWith(newProgress);
        // Re-bind events on new element
        newProgress.querySelectorAll(".ls-toggle-btn[data-titleid]").forEach((b) => {
          b.addEventListener("click", () => handleMovieToggle(b));
        });
        newProgress.querySelectorAll(".ls-season-toggle[data-titleid]").forEach((b) => {
          b.addEventListener("click", () => handleSeasonToggle(b));
        });
        newProgress.querySelectorAll(".ls-expand-btn[data-expand-titleid]").forEach((b) => {
          b.addEventListener("click", () => {
            const tid = b.getAttribute("data-expand-titleid");
            const seasonsEl = document.getElementById(`ls-seasons-${tid}`);
            if (!seasonsEl) return;
            const isOpen = !seasonsEl.hidden;
            seasonsEl.hidden = isOpen;
            b.setAttribute("aria-expanded", String(!isOpen));
            b.classList.toggle("is-open", !isOpen);
          });
        });
      }
    }
  } catch (err) {
    console.error("[lista] movie toggle failed", err);
    toast(i18nT("Errore nel salvare il progresso"), i18nT("Lista"));
  } finally {
    btn.disabled = false;
  }
}

async function handleSeasonToggle(btn) {
  const titleId = btn.getAttribute("data-titleid");
  const season = Number(btn.getAttribute("data-season")) || 0;
  const totalSeasons = Number(btn.getAttribute("data-total-seasons")) || 0;
  const isDone = btn.classList.contains("is-done");
  const newDone = !isDone;

  btn.disabled = true;

  try {
    // Calculate new seasonsCompletedCount: mark all seasons up to `season` done if newDone,
    // or remove season from done set.
    const prog = progressMap.get(titleId) || {};
    const sp = prog?.seriesProgress && typeof prog.seriesProgress === "object"
      ? prog.seriesProgress
      : {};

    const prevCompleted = Number(sp.seasonsCompletedCount) || 0;
    let newCompleted;
    if (newDone) {
      // Complete this season and all previous
      newCompleted = Math.max(prevCompleted, season);
    } else {
      // Uncomplete this season (set to season - 1 if was >= season)
      newCompleted = prevCompleted >= season ? season - 1 : prevCompleted;
    }
    newCompleted = Math.max(0, Math.min(totalSeasons, newCompleted));

    const title = titlesMap.get(titleId);
    const seasons = materializeSeasons(title?.meta || {});
    const totalEps = seasons.reduce((s, x) => s + (x.episodes || 1), 0);
    // Estimate watched episodes from completed seasons
    const completedSeasons = seasons.slice(0, newCompleted);
    const watchedEps = completedSeasons.reduce((s, x) => s + (x.episodes || 1), 0);
    const lastSeason = seasons[newCompleted - 1];

    const newState = newCompleted >= totalSeasons ? "completed" : (newCompleted > 0 ? "in_progress" : "not_started");

    const patch = {
      state: newState,
      mediaType: "tv",
      seriesProgress: {
        ...(sp || {}),
        seasonsCompletedCount: newCompleted,
        episodesWatchedCount: watchedEps,
        totalSeasonCount: totalSeasons,
        totalEpisodeCount: totalEps,
        lastWatchedSeasonNumber: newCompleted > 0 ? newCompleted : (sp.lastWatchedSeasonNumber || null),
        lastWatchedEpisodeNumber: lastSeason?.episodes || sp.lastWatchedEpisodeNumber || null,
        percentComplete: totalEps > 0 ? watchedEps / totalEps : 0,
      },
    };
    if (newCompleted >= totalSeasons) {
      patch.completedAt = serverTimestamp();
    }

    await saveProgressEntry(titleId, patch);

    // Re-render this item's progress zone
    const article = root.querySelector(`article[data-titleid="${CSS.escape(titleId)}"]`);
    if (article) {
      const oldProgress = article.querySelector(".ls-item-progress");
      // Conserva lo stato di espansione: il template ricostruito è sempre collassato.
      const oldSeasons = oldProgress ? oldProgress.querySelector(".ls-seasons") : null;
      const wasOpen = !!(oldSeasons && !oldSeasons.hidden);
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = buildTvProgress(titleId, title);
      const newProgressEl = tempDiv.firstElementChild;
      if (oldProgress && newProgressEl) {
        oldProgress.replaceWith(newProgressEl);
        // Re-bind
        newProgressEl.querySelectorAll(".ls-toggle-btn[data-titleid]").forEach((b) => {
          b.addEventListener("click", () => handleMovieToggle(b));
        });
        newProgressEl.querySelectorAll(".ls-season-toggle[data-titleid]").forEach((b) => {
          b.addEventListener("click", () => handleSeasonToggle(b));
        });
        const expandBtn = newProgressEl.querySelector(".ls-expand-btn[data-expand-titleid]");
        if (expandBtn) {
          expandBtn.addEventListener("click", () => {
            const tid = expandBtn.getAttribute("data-expand-titleid");
            const seasonsEl = document.getElementById(`ls-seasons-${tid}`);
            if (!seasonsEl) return;
            const isOpen = !seasonsEl.hidden;
            seasonsEl.hidden = isOpen;
            expandBtn.setAttribute("aria-expanded", String(!isOpen));
            expandBtn.classList.toggle("is-open", !isOpen);
          });
          // Ripristina lo stato espanso precedente.
          if (wasOpen) {
            const seasonsEl = newProgressEl.querySelector(`#ls-seasons-${CSS.escape(titleId)}`)
              || document.getElementById(`ls-seasons-${titleId}`);
            if (seasonsEl) seasonsEl.hidden = false;
            expandBtn.setAttribute("aria-expanded", "true");
            expandBtn.classList.add("is-open");
          }
        }
      }
    }
  } catch (err) {
    console.error("[lista] season toggle failed", err);
    toast(i18nT("Errore nel salvare il progresso"), i18nT("Lista"));
  } finally {
    btn.disabled = false;
  }
}

async function handlePinToggle(list) {
  const pinBtn = document.getElementById("lsPinBtn");
  if (!pinBtn) return;
  pinBtn.disabled = true;
  pinBtn.setAttribute("aria-busy", "true");
  const newPinned = !isPinned;
  pinBtn.textContent = newPinned ? i18nT("Salvataggio…") : "Rimozione…";
  try {
    await togglePublicListPin(currentUid, list.id, newPinned);
    isPinned = newPinned;
    toast(newPinned ? i18nT("Lista salvata") : i18nT("Lista rimossa"), i18nT("Lista"));
    const pinRow = document.querySelector(".ls-pin-row");
    if (pinRow) {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = buildPinRow(list);
      const newRow = tempDiv.firstElementChild;
      pinRow.replaceWith(newRow);
      newRow.querySelector("#lsPinBtn")?.addEventListener("click", () => handlePinToggle(list));
    }
  } catch (err) {
    console.error("[lista] pin failed", err);
    toast(i18nT("Errore nel salvare la lista"), i18nT("Lista"));
    pinBtn.textContent = isPinned ? "Salvata" : i18nT("Salva lista");
  } finally {
    if (pinBtn.isConnected) {
      pinBtn.disabled = false;
      pinBtn.removeAttribute("aria-busy");
    }
  }
}

/* ═══════════════════ loading states ═══════════════════ */

function showLoading() {
  if (!root) return;
  root.innerHTML = `
    <div class="ls-loading">
      <div class="ls-loading-spinner"></div>
      <span>${i18nT("Caricamento lista…")}</span>
    </div>
  `;
}

function showError(msg = i18nT("Lista non trovata o non accessibile.")) {
  if (!root) return;
  root.innerHTML = `
    <div class="ls-error">
      <div class="ls-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg></div>
      <h3>Oops</h3>
      <p>${escapeHtml(msg)}</p>
      <a href="/watchlist.html" class="btn">${i18nT("Torna alla Watchlist")}</a>
    </div>
  `;
}

/* ═══════════════════ init ═══════════════════ */

async function loadList(uid) {
  const params = new URLSearchParams(window.location.search || "");
  listId = params.get("id") || null;

  if (!listId) {
    showError(i18nT("Nessun ID lista specificato."));
    return;
  }

  showLoading();

  try {
    listDetail = await fetchListDetail(listId, uid);
    if (!listDetail) {
      showError(i18nT("Lista non trovata."));
      return;
    }

    const { list, items } = listDetail;

    // Hydrate preview titles for cover collage (up to 4)
    const previewIds = safeArray(list.cover?.fallbackTitleIds).slice(0, 4);
    const allTitleIds = [...new Set([
      ...previewIds,
      ...items.map((i) => i.titleId).filter(Boolean),
    ])];

    if (allTitleIds.length > 0) {
      titlesMap = await getTitlesByIds(allTitleIds).catch(() => new Map());
    }

    // Hydrate preview titles on list object for cover render
    list.previewTitles = previewIds.map((id) => titlesMap.get(id)).filter(Boolean);

    // Load personal progress entries
    currentUid = uid;
    await loadProgressEntries();

    // Check if pinned
    const pinned = await fetchPinnedPublicListIds(uid).catch(() => []);
    isPinned = pinned.includes(listId);

    // Document title
    document.title = `${list.title} — Somto`;

    renderPage();
  } catch (err) {
    console.error("[lista] load failed", err);
    showError(i18nT("Errore nel caricamento della lista."));
  }
}

initAuthGuard({
  requireAuth: true,
  onReady: (user) => {
    if (user?.uid) {
      loadList(user.uid);
    }
  },
});
