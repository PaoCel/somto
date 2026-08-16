// Onboarding v2 — web. Specchio di ios/TwoWatch/Features/Onboarding/.
// Spec: docs/ONBOARDING_V2.md
//
// L'onboarding non spiega Somto, lo fa fare: una domanda sola all'ingresso
// ("hai gia' una cronologia da portare?"), poi step che sono azioni vere su
// dati veri — watchlist, libreria, seguiti — e l'atterraggio sui commenti di
// un titolo appena salvato.
//
// Il vecchio flusso (tour a slide + chooser a 3 livelli + swipe deck dei seed)
// resta in onboardingFlow.js SOLO per le superfici di account.html
// ("affina i consigli"), non parte piu' per il nuovo utente.

import { escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { logEvent } from "../analytics.js";
import { trackProductEvent } from "../api/productAnalytics.js";
import {
  getOnboardingSnapshot,
  markOnboardingSource,
  finalizeOnboarding,
} from "../api/onboarding.api.js";
import { listPopularTitles, searchTitlesSmart } from "../api/titles.api.js";
import { addToWatchlist } from "../api/watchlist.api.js";
import { listSuggestedProfiles, followUser, unfollowUser, listFollowing, updatePhotoURL } from "../api/users.api.js";
import { uploadAvatar } from "../api/storage.api.js";

const MIN_WATCHLIST = 3;
const MIN_LIBRARY = 1;
const MAX_PICK = 12;
const GRID_SIZE = 24;

// Sorgenti: Netflix non e' una provenienza ma una funzione, sta sotto la riga
// separatrice. Trakt per primo perche' e' OAuth, nessun file da estrarre.
// I monogrammi sono espliciti e non derivati dall'iniziale: "Trakt" e
// "TV Time" iniziano entrambi per T e hanno rossi quasi identici, quindi da
// derivati erano due righe indistinguibili. Stessi valori di iOS
// (TitlesImportSource.brandMonogram).
const PRIMARY_SOURCES = [
  { id: "trakt", label: "Trakt", monogram: "tr", hint: i18nT("Ti colleghi e basta, nessun file"), color: "#ED1C24" },
  { id: "tvtime_gdpr", label: "TV Time", monogram: "tv", hint: i18nT("Serve l'export dei dati, ti spieghiamo come"), color: "#F0264B" },
  { id: "letterboxd", label: "Letterboxd", monogram: "L", hint: i18nT("Lo lavoriamo a mano entro 24 ore"), color: "#14181C" },
];

let overlay = null;
let state = null;

function createOverlay() {
  closeOverlay();
  overlay = document.createElement("div");
  overlay.className = "onboarding-overlay onboarding-v2";
  document.body.appendChild(overlay);
  return overlay;
}

function closeOverlay() {
  if (overlay) overlay.remove();
  overlay = null;
}

function track(event, params = {}) {
  void logEvent(event, params);
  trackProductEvent(event, params);
}

// ---------------------------------------------------------------- ingresso

function renderSource() {
  const rows = PRIMARY_SOURCES.map((s) => `
    <button type="button" class="onb2-source-row" data-source="${s.id}">
      <span class="onb2-source-chip" style="background:${s.color}">${escapeHtml(s.monogram)}</span>
      <span class="onb2-source-text">
        <strong>${escapeHtml(s.label)}</strong>
        <small>${escapeHtml(s.hint)}</small>
      </span>
      <span class="onb2-chevron" aria-hidden="true">›</span>
    </button>
  `).join("");

  overlay.innerHTML = `
    <div class="onboarding-modal onb2-step">
      <h2>${i18nT("Hai già una cronologia da portare?")}</h2>
      <p>${i18nT("La importiamo mentre prepari Somto.")}</p>
      <div class="onb2-source-list">${rows}</div>
      <div class="onb2-divider"><span>${i18nT("oppure")}</span></div>
      <button type="button" class="onb2-source-row is-compact" data-source="netflix_csv">
        <span class="onb2-source-chip" style="background:#E50914">N</span>
        <span class="onb2-source-text"><strong>${i18nT("Ho un export Netflix")}</strong></span>
        <span class="onb2-chevron" aria-hidden="true">›</span>
      </button>
      <div class="onb2-footer">
        <button type="button" class="btn ghost" data-scratch>${i18nT("No, parto da zero")}</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll("[data-source]").forEach((btn) => {
    btn.addEventListener("click", () => chooseSource(btn.getAttribute("data-source")));
  });
  overlay.querySelector("[data-scratch]")?.addEventListener("click", () => chooseSource("none"));
}

async function chooseSource(source) {
  track("onboarding_source_chosen", { source });
  void markOnboardingSource(state.uid, source).catch(() => {});

  if (source === "none") {
    state.didStartImport = false;
    await renderPicker("watchlist");
    return;
  }

  // L'import parte SUBITO e in una pagina sua: gli step ripartono al rientro
  // (il flag sopravvive in sessionStorage, vedi resumeAfterImport).
  state.didStartImport = true;
  try {
    sessionStorage.setItem("onb2_resume", JSON.stringify({ source }));
  } catch (_) {}
  window.location.href = `/import.html?source=${encodeURIComponent(source)}&onboarding=1`;
}

// ------------------------------------------------------------------ picker

const PICKER_COPY = {
  watchlist: {
    title: i18nT("Salva 3 cose che vuoi vedere"),
    subtitle: i18nT("La watchlist è solo quello che vuoi vedere: da qui Somto ti dice cosa guardare stasera."),
    min: MIN_WATCHLIST,
    skippable: false,
  },
  library: {
    title: i18nT("E cosa hai già visto?"),
    subtitle: i18nT("Finisce nella libreria del tuo profilo, sotto «Visti»."),
    min: MIN_LIBRARY,
    skippable: true,
  },
};

async function renderPicker(mode) {
  const copy = PICKER_COPY[mode];
  state.mode = mode;
  state.picked = [];

  overlay.innerHTML = `
    <div class="onboarding-modal onb2-step">
      <h2>${escapeHtml(copy.title)}</h2>
      <p>${escapeHtml(copy.subtitle)}</p>
      <input type="search" class="onb2-search" data-onb2-search
             placeholder="${i18nT("Cerca un film o una serie")}" autocomplete="off">
      <div class="onb2-grid" data-onb2-grid aria-busy="true">
        <p class="onb2-muted">${i18nT("Carico i titoli")}</p>
      </div>
      <div class="onb2-footer">
        <span class="onb2-counter" data-onb2-counter></span>
        <button type="button" class="btn primary" data-onb2-continue disabled>${i18nT("Continua")}</button>
        ${copy.skippable ? `<button type="button" class="btn ghost" data-onb2-skip>${i18nT("Salta per ora")}</button>` : ""}
      </div>
    </div>
  `;

  const gridEl = overlay.querySelector("[data-onb2-grid]");
  const searchEl = overlay.querySelector("[data-onb2-search]");

  let searchTimer = null;
  searchEl?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const term = searchEl.value.trim();
    searchTimer = setTimeout(async () => {
      const titles = term
        ? await searchTitlesSmart(term, GRID_SIZE).catch(() => [])
        : await loadPopular();
      paintGrid(gridEl, titles);
    }, 300);
  });

  overlay.querySelector("[data-onb2-continue]")?.addEventListener("click", () => confirmPicker(mode));
  overlay.querySelector("[data-onb2-skip]")?.addEventListener("click", () => goToFollow());

  paintGrid(gridEl, await loadPopular());
  updateCounter();
}

async function loadPopular() {
  if (!state.popular) {
    state.popular = await listPopularTitles(GRID_SIZE).catch(() => []);
  }
  return state.popular;
}

function paintGrid(gridEl, titles) {
  if (!gridEl) return;
  gridEl.setAttribute("aria-busy", "false");

  if (!titles.length) {
    gridEl.innerHTML = `<p class="onb2-muted">${i18nT("Nessun titolo trovato")}</p>`;
    return;
  }

  gridEl.innerHTML = titles.map((title) => {
    const id = String(title.id || "");
    const poster = title.posterUrl || title.posterPath || "";
    const picked = state.picked.includes(id);
    return `
      <button type="button" class="onb2-poster${picked ? " is-picked" : ""}" data-title-id="${escapeHtml(id)}"
              aria-pressed="${picked ? "true" : "false"}">
        ${poster
          ? `<img src="${escapeHtml(poster)}" alt="" loading="lazy">`
          : `<span class="onb2-poster-fallback" aria-hidden="true">🎬</span>`}
        <span class="onb2-poster-name">${escapeHtml(title.name || "")}</span>
      </button>
    `;
  }).join("");

  gridEl.querySelectorAll("[data-title-id]").forEach((btn) => {
    btn.addEventListener("click", () => togglePick(btn.getAttribute("data-title-id"), btn));
  });
}

function togglePick(titleId, btn) {
  if (!titleId) return;
  const at = state.picked.indexOf(titleId);
  if (at >= 0) {
    state.picked.splice(at, 1);
  } else {
    if (state.picked.length >= MAX_PICK) return;
    state.picked.push(titleId);
  }
  btn.classList.toggle("is-picked", at < 0);
  btn.setAttribute("aria-pressed", at < 0 ? "true" : "false");
  updateCounter();
}

/** Contatore come progresso, non come muro: sotto soglia dice quanto manca. */
function updateCounter() {
  const min = PICKER_COPY[state.mode].min;
  const counterEl = overlay?.querySelector("[data-onb2-counter]");
  const continueEl = overlay?.querySelector("[data-onb2-continue]");
  const count = state.picked.length;
  const ok = count >= min;

  if (counterEl) {
    counterEl.textContent = ok
      ? i18nT("Ottimo, puoi continuare")
      : i18nT("Ancora {n} per iniziare", { n: min - count });
  }
  if (continueEl) continueEl.disabled = !ok;
}

async function confirmPicker(mode) {
  const picked = [...state.picked];
  setBusy(true);

  // Sequenziale: le due write toccano lo stesso doc di stats dell'utente, e
  // tre titoli non giustificano il rischio di contesa. Un errore su un titolo
  // non blocca gli altri — lo step e' un acceleratore, non un contratto.
  for (const titleId of picked) {
    await addToWatchlist(state.uid, titleId, {
      source: "web_onboarding",
      watchState: mode === "library" ? "to_rate" : "to_watch",
    }).catch(() => {});
  }

  setBusy(false);
  track(mode === "library" ? "onboarding_step_library" : "onboarding_step_watchlist", { count: picked.length });

  if (mode === "watchlist") {
    state.watchlistTitleIds = picked;
    // Chi ci ha appena consegnato la sua cronologia non deve dirci cosa ha
    // visto: con un import in corso lo step libreria non esiste.
    if (state.didStartImport) {
      await goToFollow();
    } else {
      await renderPicker("library");
    }
    return;
  }
  await goToFollow();
}

// ------------------------------------------------------------------ seguiti

async function goToFollow() {
  overlay.innerHTML = `
    <div class="onboarding-modal onb2-step">
      <p class="onb2-muted">${i18nT("Cerco profili per te")}</p>
    </div>
  `;

  const excluding = [state.uid];
  const following = await listFollowing(state.uid, { max: 60 }).catch(() => []);
  following.forEach((u) => excluding.push(u.uid || u.id));

  const suggested = await listSuggestedProfiles({
    seedTitleIds: state.watchlistTitleIds,
    excluding,
  }).catch(() => []);

  // Nessuno da proporre: si chiude invece di mostrare una schermata vuota.
  if (!suggested.length) {
    await finish();
    return;
  }

  const rows = suggested.map((row) => {
    const uid = row.user.uid;
    const name = String(row.user.displayName || "");
    const avatar = row.user.avatarURL || row.user.photoURL || "";
    const reason = row.sharedTitleCount > 0
      ? i18nT("Avete gusti simili")
      : i18nT("Tra i più attivi");
    return `
      <div class="onb2-follow-row">
        ${avatar
          ? `<img class="onb2-follow-avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy">`
          : `<span class="onb2-follow-avatar is-initials">${escapeHtml(name.slice(0, 1).toUpperCase() || "?")}</span>`}
        <span class="onb2-follow-text">
          <strong>${escapeHtml(name)}</strong>
          <small>${escapeHtml(reason)}</small>
        </span>
        <button type="button" class="btn small primary" data-follow="${escapeHtml(uid)}">${i18nT("Segui")}</button>
      </div>
    `;
  }).join("");

  overlay.innerHTML = `
    <div class="onboarding-modal onb2-step">
      <h2>${i18nT("Segui qualcuno")}</h2>
      <p>${i18nT("Il feed di Community è fatto da chi segui: senza nessuno resta vuoto.")}</p>
      ${state.hasAvatar ? "" : `
        <div class="onb2-avatar-card">
          <span class="onb2-avatar-thumb" data-avatar-thumb aria-hidden="true">+</span>
          <span class="onb2-follow-text">
            <strong>${i18nT("Metti una foto")}</strong>
            <small>${i18nT("Ti riconoscono quando commenti")}</small>
          </span>
          <label class="btn small ghost onb2-avatar-btn">
            ${i18nT("Scegli")}
            <input type="file" accept="image/*" hidden data-avatar-input>
          </label>
        </div>
      `}
      <div class="onb2-follow-list">${rows}</div>
      <div class="onb2-footer">
        <button type="button" class="btn primary" data-onb2-continue>${i18nT("Continua")}</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll("[data-follow]").forEach((btn) => {
    btn.addEventListener("click", () => toggleFollow(btn));
  });
  overlay.querySelector("[data-avatar-input]")?.addEventListener("change", (e) => {
    const file = e.target?.files?.[0];
    if (file) void handleAvatar(file);
  });
  overlay.querySelector("[data-onb2-continue]")?.addEventListener("click", () => finish());
}

/** Follow ottimistico: la riga cambia subito, se la write fallisce torna indietro. */
async function toggleFollow(btn) {
  const targetUid = btn.getAttribute("data-follow");
  if (!targetUid || btn.disabled) return;

  const wasFollowing = btn.classList.contains("is-following");
  btn.disabled = true;
  btn.classList.toggle("is-following", !wasFollowing);
  btn.textContent = wasFollowing ? i18nT("Segui") : i18nT("Seguito");

  try {
    if (wasFollowing) {
      await unfollowUser(state.uid, targetUid);
    } else {
      await followUser(state.uid, targetUid);
      track("onboarding_step_follow", {});
    }
  } catch (_) {
    btn.classList.toggle("is-following", wasFollowing);
    btn.textContent = wasFollowing ? i18nT("Seguito") : i18nT("Segui");
  }
  btn.disabled = false;
}

/** Richiesta leggera: nessun editor di ritaglio, chi vuole aggiustare la usa da account. */
async function handleAvatar(file) {
  const thumb = overlay?.querySelector("[data-avatar-thumb]");
  if (thumb) thumb.textContent = "…";
  try {
    const url = await uploadAvatar({ file, uid: state.uid });
    await updatePhotoURL(state.uid, url);
    track("onboarding_avatar_set", {});
    overlay?.querySelector(".onb2-avatar-card")?.remove();
  } catch (_) {
    if (thumb) thumb.textContent = "+";
  }
}

// ----------------------------------------------------------------- chiusura

function setBusy(busy) {
  const modal = overlay?.querySelector(".onb2-step");
  if (modal) modal.setAttribute("aria-busy", busy ? "true" : "false");
  overlay?.querySelectorAll("button").forEach((b) => { b.disabled = busy; });
}

async function finish() {
  setBusy(true);
  const seeds = state.watchlistTitleIds;
  track("onboarding_completed", {
    skipped: seeds.length === 0,
    seed_count: seeds.length,
    with_import: !!state.didStartImport,
  });

  await finalizeOnboarding({
    uid: state.uid,
    selectedLevel: 1,
    scope: "taste",
    answers: { seedTitleIds: seeds },
  }).catch(() => {});

  closeOverlay();
  state.onCompleted?.();

  // Ultimo passo: invece di spiegare i commenti, si atterra sulla scheda vera
  // di un titolo appena salvato, sui commenti. Se scrive bene, se non scrive
  // ha comunque visto che esistono.
  if (seeds[0]) {
    track("onboarding_step_comment", {});
    window.location.href = `/title.html?id=${encodeURIComponent(seeds[0])}&focus=community`;
  }
}

// -------------------------------------------------------------------- entry

/**
 * Avvia l'onboarding v2 per il nuovo utente. Sostituisce `initHomeOnboarding`
 * di onboardingFlow.js (tour a slide + chooser a 3 livelli), che resta in
 * piedi solo per le superfici di account.html.
 */
export async function initOnboardingV2({ uid, onCompleted } = {}) {
  if (!uid) return;

  const snapshot = await getOnboardingSnapshot(uid).catch(() => null);
  if (!snapshot) return;

  const resuming = consumeResumeFlag();
  if (!snapshot.shouldShowFullscreen && !resuming) return;

  state = {
    uid,
    onCompleted,
    picked: [],
    watchlistTitleIds: [],
    popular: null,
    mode: "watchlist",
    didStartImport: !!resuming,
    hasAvatar: !!(snapshot.userDoc?.avatarURL || snapshot.userDoc?.photoURL),
  };

  createOverlay();
  track("onboarding_started", {});

  // Rientro da /import.html: l'import e' gia' partito, si riprende dagli step.
  if (resuming) {
    await renderPicker("watchlist");
  } else {
    renderSource();
  }
}

/**
 * Il rientro da /import.html e' una navigazione vera (pagina nuova), quindi il
 * "sto tornando dall'import" deve sopravvivere fuori dal modulo. Letto una
 * volta sola: un refresh successivo non deve rifar partire il flusso.
 */
function consumeResumeFlag() {
  try {
    const raw = sessionStorage.getItem("onb2_resume");
    if (!raw) return null;
    sessionStorage.removeItem("onb2_resume");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
