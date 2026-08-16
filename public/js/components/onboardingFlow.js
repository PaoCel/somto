// Flusso onboarding v1. Il funnel del NUOVO utente e' passato a
// onboardingV2.js (docs/ONBOARDING_V2.md): qui restano solo le superfici di
// account.html — wizard identita' (nome/avatar) e wizard gusti, cioe' l'
// "affina i consigli" post-onboarding.
import { escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { toast } from "./toast.js";
import { uploadAvatar } from "../api/storage.api.js";
import { logSignal } from "../api/signals.api.js";
import { attachCharCounter } from "../utils/charCounter.js";
import {
  ONBOARDING_LEVEL,
  getOnboardingSnapshot,
  dismissOnboardingPrompt,
  startOnboardingSession,
  finalizeOnboarding,
  listOnboardingSeedTitles,
  validateDisplayName,
  checkDisplayNameAvailability,
  saveOnboardingTelemetry,
  saveOnboardingDraft,
  getNextUpgradeLevel,
  getOnboardingLevelLabel,
} from "../api/onboarding.api.js";
import { logEvent } from "../analytics.js";
import { trackProductEvent } from "../api/productAnalytics.js";

const VIBE_OPTIONS = [
  { id: "ridere", label: "Ridere" },
  { id: "intenso", label: "Intenso" },
  { id: "riflettere", label: "Riflettere" },
  { id: "avventura", label: "Avventura" },
  { id: "thriller", label: "Thriller" },
  { id: "romance", label: "Romance" },
  { id: "horror", label: "Horror" },
  { id: "feelgood", label: "Feel-good" },
];

const ERA_OPTIONS = [
  { id: "80s", label: "Anni 80" },
  { id: "90s", label: "Anni 90" },
  { id: "2000s", label: "Anni 2000" },
  { id: "modern", label: "Moderni" },
  { id: "classics", label: "Classici" },
];

const CONTEXT_OPTIONS = [
  { id: "solo", label: i18nT("Da solo") },
  { id: "coppia", label: "In coppia" },
  { id: "amici", label: i18nT("Con amici") },
];

const DISLIKES_OPTIONS = [
  { id: "musical", label: "Musical" },
  { id: "gore", label: "Gore" },
  { id: "teen-drama", label: "Teen drama" },
  { id: "reality-style", label: "Reality style" },
  { id: "slow-burn", label: "Troppo lento" },
  { id: "jump-scare", label: "Jump scare" },
  { id: "romcom", label: "Romcom" },
  { id: "superhero", label: "Superhero" },
];

const TOLERANCE_OPTIONS = [
  { id: "light", label: "Leggero" },
  { id: "heavy", label: i18nT("Anche pesante") },
  { id: "disturbing", label: i18nT("Anche disturbante") },
];

const MAX_SEEDS = 12;
const MIN_SEEDS = 4;
const MAX_VIBE = 2;
const MAX_CONTEXT = 3;
const MAX_DISLIKES = 5;
const SEED_DECK_TARGET = 20;
const SEED_FETCH_MAX = 64;

let activeOverlay = null;

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const chunks = s.split(/\s+/).filter(Boolean);
  const a = chunks[0]?.[0] || "?";
  const b = chunks.length > 1 ? chunks[chunks.length - 1]?.[0] : "";
  return (a + b).toUpperCase();
}

function clampLevel(level) {
  const n = Number(level || 0);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

function levelEta(level) {
  if (level === 1) return i18nT("1 minuto");
  if (level === 2) return i18nT("2-3 minuti");
  return i18nT("5 minuti");
}

function levelSubtitle(level) {
  if (level === 1) return i18nT("Nome pubblico + avatar opzionale + 20 card swipe");
  if (level === 2) return i18nT("Tutto il Lieve + vibe + film/serie + mainstream/scoperte");
  return i18nT("Tutto il Medio + epoca + contesto + anti-preferenze");
}

function getStepsForLevel(level) {
  const steps = [
    { id: "publicName", title: i18nT("Nome pubblico"), description: i18nT("Questo nome appare in app.") },
    { id: "avatar", title: "Avatar", description: i18nT("Facoltativo. Puoi anche saltare.") },
    { id: "seedTitles", title: i18nT("Titoli che ami"), description: i18nT("Swipe: sinistra no, destra preferito, su mi piace.") },
  ];
  if (level >= 2) {
    steps.push(
      { id: "vibe", title: "Vibe", description: i18nT("Scegli massimo 2 mood.") },
      { id: "format", title: "Formato", description: i18nT("Film/serie e mainstream/scoperte.") },
    );
  }
  if (level >= 3) {
    steps.push(
      { id: "advanced", title: "Preferenze avanzate", description: i18nT("Epoca, contesto, titolo del cuore.") },
      { id: "dislikes", title: "Anti-preferenze", description: i18nT("Cosa vuoi evitare.") },
    );
  }
  return steps;
}

function normalizeWizardScope(scope) {
  const raw = String(scope || "full").trim().toLowerCase();
  if (raw === "identity" || raw === "taste") return raw;
  return "full";
}

function getStepsForScope(level, scope = "full") {
  const safeScope = normalizeWizardScope(scope);
  const steps = getStepsForLevel(level);
  if (safeScope === "identity") {
    return steps.filter((step) => step.id === "publicName" || step.id === "avatar");
  }
  if (safeScope === "taste") {
    return steps.filter((step) => step.id !== "publicName" && step.id !== "avatar");
  }
  return steps;
}

function createOverlay() {
  if (activeOverlay) activeOverlay.remove();
  const overlay = document.createElement("div");
  overlay.className = "onboarding-overlay";
  document.body.appendChild(overlay);
  activeOverlay = overlay;
  return overlay;
}

function closeOverlay() {
  if (activeOverlay) activeOverlay.remove();
  activeOverlay = null;
}

function buildInitialAnswers(snapshot) {
  const doc = snapshot?.userDoc || {};
  const taste = snapshot?.tasteProfile || {};
  return {
    displayName: String(doc.displayName || "").trim(),
    avatarURL: String(doc.avatarURL || doc.photoURL || "").trim(),
    avatarRemoved: false,
    seedTitleIds: Array.isArray(taste.seedTitleIds) ? [...taste.seedTitleIds] : [],
    seedLikedTitleIds: Array.isArray(taste.seedLikedTitleIds) ? [...taste.seedLikedTitleIds] : [],
    vibe: Array.isArray(taste.vibe) ? [...taste.vibe] : [],
    filmVsSeries: taste.filmVsSeries || "mix",
    mainstream: taste.mainstream || "mix",
    era: taste.era || "",
    context: Array.isArray(taste.context) ? [...taste.context] : [],
    dislikes: Array.isArray(taste.dislikes) ? [...taste.dislikes] : [],
    favoriteTitleText: String(taste.favoriteTitleText || "").trim(),
    contentTolerance: taste.contentTolerance || "",
  };
}


function levelBadge(status) {
  const level = Number(status?.completedLevel || 0);
  if (level <= 0) return i18nT("Non completato");
  if (level === 1) return "Livello Lieve";
  if (level === 2) return "Livello Medio";
  return "Livello Avanzato";
}


function renderAccountPanel(container, snapshot, { onEditIdentity, onTaste, onChooseLevel } = {}) {
  if (!container) return;
  const level = Number(snapshot?.completedLevel || 0);
  const nextLevel = getNextUpgradeLevel(level);
  const confidence = Number(snapshot?.confidenceScore || 0);
  const badge = levelBadge(snapshot?.onboardingStatus);
  const tasteLabel = level < 1
    ? i18nT("Completa gusti ({level})", { level: getOnboardingLevelLabel(ONBOARDING_LEVEL.EASY) })
    : (level < 3 ? `Upgrade gusti (${getOnboardingLevelLabel(nextLevel)})` : "Aggiorna gusti");
  const helperBase = level < 1
    ? i18nT("Parti dal Lieve (1 minuto) e attiva raccomandazioni più pertinenti.")
    : i18nT("Ultimo livello completato: {level}.", { level: getOnboardingLevelLabel(level) });
  const helper = i18nT("{helperBase} Nome/avatar e gusti ora sono gestiti separatamente.", { helperBase });

  container.style.display = "block";
  container.innerHTML = `
    <div class="onboarding-account-card">
      <div class="onboarding-nudge-top">
        <span class="onboarding-pill">${escapeHtml(badge)}</span>
        <span class="onboarding-score">Confidence ${confidence}%</span>
      </div>
      <h3>${i18nT("Profilo e Preferenze")}</h3>
      <p>${escapeHtml(helper)}</p>
      <div class="onboarding-account-actions onboarding-account-actions-main">
        <button type="button" class="btn small ghost" data-ob-account-identity>${i18nT("Nome e avatar")}</button>
        <button type="button" class="btn small primary" data-ob-account-taste>${escapeHtml(tasteLabel)}</button>
      </div>
      <div class="onboarding-account-actions onboarding-account-actions-sub">
        <button type="button" class="btn small ghost" data-ob-account-choose>Scegli livello gusti</button>
      </div>
    </div>
  `;

  container.querySelector("[data-ob-account-identity]")?.addEventListener("click", () => onEditIdentity?.(level));
  container.querySelector("[data-ob-account-taste]")?.addEventListener("click", () => onTaste?.(nextLevel));
  container.querySelector("[data-ob-account-choose]")?.addEventListener("click", () => onChooseLevel?.());
}

function startStepTimer(state, stepId) {
  if (state.activeStepId === stepId && Number.isFinite(state.stepStartedAtMs)) {
    return;
  }
  state.stepStartedAtMs = Date.now();
  state.activeStepId = stepId;
  if (!state.telemetry.steps[stepId]) {
    state.telemetry.steps[stepId] = {
      startMs: state.stepStartedAtMs,
      endMs: null,
      dwellMs: 0,
      toggleCount: 0,
    };
    return;
  }
  if (!state.telemetry.steps[stepId].startMs) {
    state.telemetry.steps[stepId].startMs = state.stepStartedAtMs;
  }
}

function endStepTimer(state, stepId) {
  const now = Date.now();
  const row = state.telemetry.steps[stepId] || {
    startMs: state.stepStartedAtMs || now,
    endMs: null,
    dwellMs: 0,
    toggleCount: 0,
  };
  const startMs = Number.isFinite(state.stepStartedAtMs) ? state.stepStartedAtMs : row.startMs;
  row.endMs = now;
  row.dwellMs = Math.max(0, Number(row.dwellMs || 0) + Math.max(0, now - startMs));
  state.telemetry.steps[stepId] = row;
  state.activeStepId = null;
}

function bumpToggle(state, stepId) {
  const row = state.telemetry.steps[stepId] || {
    startMs: Date.now(),
    endMs: null,
    dwellMs: 0,
    toggleCount: 0,
  };
  row.toggleCount = Number(row.toggleCount || 0) + 1;
  state.telemetry.steps[stepId] = row;
  state.telemetry.counters.toggleCount = Number(state.telemetry.counters.toggleCount || 0) + 1;
}

function normalizeArrays(state) {
  const strongUnique = Array.from(new Set(state.answers.seedTitleIds || [])).slice(0, 24);
  const likedUnique = Array.from(new Set(state.answers.seedLikedTitleIds || [])).slice(0, 24);
  const strongLimited = strongUnique.slice(0, MAX_SEEDS);
  const overflowStrong = strongUnique.slice(MAX_SEEDS);
  const strongSet = new Set(strongLimited);
  state.answers.seedTitleIds = strongLimited;
  state.answers.seedLikedTitleIds = Array.from(new Set([...overflowStrong, ...likedUnique]))
    .filter(id => !strongSet.has(id))
    .slice(0, 24);
  state.answers.vibe = Array.from(new Set(state.answers.vibe || [])).slice(0, MAX_VIBE);
  state.answers.context = Array.from(new Set(state.answers.context || [])).slice(0, MAX_CONTEXT);
  state.answers.dislikes = Array.from(new Set(state.answers.dislikes || [])).slice(0, MAX_DISLIKES);
}

function validateCurrentStep(state) {
  const stepId = state.steps[state.currentStepIndex]?.id;
  if (!stepId) return { ok: true };

  if (stepId === "publicName") {
    const checked = validateDisplayName(state.answers.displayName);
    if (!checked.ok) return { ok: false, error: checked.error || i18nT("Nome non valido.") };
  }

  if (stepId === "seedTitles") {
    if (state.seedLoading) {
      return { ok: false, error: i18nT("Sto ancora caricando i titoli: attendi un attimo.") };
    }
    if (!Array.isArray(state.seedDeck) || !state.seedDeck.length) {
      // Se il catalogo non e' disponibile, non blocchiamo il completamento:
      // l'utente potra' arricchire il profilo in seguito.
      return { ok: true };
    }
    const strongCount = (state.answers.seedTitleIds || []).length;
    const likedCount = (state.answers.seedLikedTitleIds || []).length;
    const positiveCount = strongCount + likedCount;
    if (positiveCount < MIN_SEEDS) {
      return { ok: false, error: i18nT("Seleziona almeno {MIN_SEEDS} titoli che ti rappresentano (preferiti + mi piace).", { MIN_SEEDS }) };
    }
    if (strongCount > MAX_SEEDS) {
      return { ok: false, error: `Mantieni massimo ${MAX_SEEDS} preferiti.` };
    }
  }

  if (stepId === "advanced" && state.level >= ONBOARDING_LEVEL.ADVANCED) {
    const count = (state.answers.context || []).length;
    if (!count) {
      return { ok: false, error: i18nT("Seleziona almeno un contesto di visione.") };
    }
  }

  return { ok: true };
}

async function validateCurrentStepAsync(state) {
  const syncCheck = validateCurrentStep(state);
  if (!syncCheck.ok) return syncCheck;

  const stepId = state.steps[state.currentStepIndex]?.id;
  if (stepId !== "publicName") return { ok: true };

  const checked = validateDisplayName(state.answers.displayName);
  if (!checked.ok) {
    return { ok: false, error: checked.error || i18nT("Nome non valido.") };
  }

  try {
    const availability = await checkDisplayNameAvailability({
      desiredName: checked.displayName,
      uid: state.uid,
    });
    if (!availability?.ok) {
      return { ok: false, error: availability?.error || i18nT("Nome non valido.") };
    }
    if (!availability.available) {
      return { ok: false, error: i18nT("Nome pubblico gia' in uso. Scegline un altro.") };
    }
  } catch (_) {
    return { ok: false, error: i18nT("Non riesco a verificare il nome ora. Riprova.") };
  }

  return { ok: true };
}

function makeStepHeader(state) {
  const item = state.steps[state.currentStepIndex];
  const total = state.steps.length;
  const current = state.currentStepIndex + 1;
  return `
    <div class="onboarding-wizard-head">
      <div>
        <div class="onboarding-progress">Step ${current}/${total}</div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.description || "")}</p>
      </div>
      <button type="button" class="btn small ghost" data-ob-close>${i18nT("Chiudi")}</button>
    </div>
    <div class="onboarding-progress-track">
      <span style="width:${Math.round((current / total) * 100)}%"></span>
    </div>
  `;
}

function shuffleRows(rows) {
  const out = Array.isArray(rows) ? rows.slice() : [];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildSeedDeck(rows, target = SEED_DECK_TARGET) {
  const max = Math.max(12, Number(target || SEED_DECK_TARGET));
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => r?.id && r?.name)
    .slice(0, 120);
  if (!list.length) return [];

  const movies = list.filter(r => String(r.type || "").toLowerCase() === "movie");
  const series = list.filter(r => ["tv", "series"].includes(String(r.type || "").toLowerCase()));
  const others = list.filter(r => !movies.includes(r) && !series.includes(r));

  const out = [];
  const picked = new Set();
  const buckets = [movies, series, others, list];
  let cursor = 0;

  while (out.length < max) {
    let progressed = false;
    for (const bucket of buckets) {
      const row = bucket[cursor];
      if (!row) continue;
      progressed = true;
      if (picked.has(row.id)) continue;
      picked.add(row.id);
      out.push(row);
      if (out.length >= max) break;
    }
    if (!progressed) break;
    cursor += 1;
  }

  if (out.length < max) {
    for (const row of shuffleRows(list)) {
      if (out.length >= max) break;
      if (picked.has(row.id)) continue;
      picked.add(row.id);
      out.push(row);
    }
  }

  return out.slice(0, max);
}

function hydrateSeedDecisionState(state) {
  if (!(state.seedDecisionMap instanceof Map)) state.seedDecisionMap = new Map();
  if (!Array.isArray(state.seedDecisionHistory)) state.seedDecisionHistory = [];
  const favoriteIds = new Set(state.answers.seedTitleIds || []);
  const likedIds = new Set(state.answers.seedLikedTitleIds || []);
  for (const row of (state.seedDeck || [])) {
    if (favoriteIds.has(row.id)) state.seedDecisionMap.set(row.id, "like");
    else if (likedIds.has(row.id)) state.seedDecisionMap.set(row.id, "softlike");
  }
}

function recomputeSeedAnswersFromDecisions(state) {
  const deck = state.seedDeck || [];
  const deckIds = new Set(deck.map(r => r.id));
  const preservedFavorites = (state.answers.seedTitleIds || []).filter(id => !deckIds.has(id));
  const preservedLikes = (state.answers.seedLikedTitleIds || []).filter(id => !deckIds.has(id));

  const favorites = [...preservedFavorites];
  const likes = [...preservedLikes];
  for (const row of deck) {
    const decision = state.seedDecisionMap?.get(row.id);
    if (decision === "like") favorites.push(row.id);
    else if (decision === "softlike") likes.push(row.id);
  }

  const favoriteUnique = Array.from(new Set(favorites)).slice(0, 24);
  const favoriteLimited = favoriteUnique.slice(0, MAX_SEEDS);
  const overflowFavorites = favoriteUnique.slice(MAX_SEEDS);
  const favoriteSet = new Set(favoriteLimited);
  const likesUnique = Array.from(new Set([...overflowFavorites, ...likes]))
    .filter(id => !favoriteSet.has(id))
    .slice(0, 24);

  state.answers.seedTitleIds = favoriteLimited;
  state.answers.seedLikedTitleIds = likesUnique;
}

function findNextSeedCursor(state, startAt = 0) {
  const deck = state.seedDeck || [];
  const map = state.seedDecisionMap instanceof Map ? state.seedDecisionMap : new Map();
  for (let i = Math.max(0, Number(startAt || 0)); i < deck.length; i++) {
    const id = deck[i]?.id;
    if (!id) continue;
    if (!map.has(id)) return i;
  }
  return deck.length;
}

function seedDecisionCounts(state) {
  const deck = state.seedDeck || [];
  const map = state.seedDecisionMap instanceof Map ? state.seedDecisionMap : new Map();
  let decided = 0;
  let localDislikes = 0;
  let localFavorites = 0;
  let localLikes = 0;
  for (const row of deck) {
    const action = map.get(row.id);
    if (!action) continue;
    decided += 1;
    if (action === "dislike") localDislikes += 1;
    if (action === "like") localFavorites += 1;
    if (action === "softlike") localLikes += 1;
  }
  const strongTotal = (state.answers.seedTitleIds || []).length;
  const likedTotal = (state.answers.seedLikedTitleIds || []).length;
  return {
    deckTotal: deck.length,
    decided,
    localDislikes,
    localFavorites,
    localLikes,
    strongTotal,
    likedTotal,
    positiveTotal: strongTotal + likedTotal,
  };
}

function seedSwipeCardHtml(item, progressLabel = "") {
  const poster = item.posterPath
    ? `<img src="${escapeHtml(item.posterPath)}" alt="${escapeHtml(item.name || "")}" loading="lazy" />`
    : `<div class="onboarding-seed-fallback">${escapeHtml((item.name || "?").slice(0, 2).toUpperCase())}</div>`;
  const year = item.year ? ` · ${escapeHtml(String(item.year))}` : "";
  const type = String(item.type || "").toLowerCase() === "movie" ? i18nT("Film") : i18nT("Serie");
  const overview = String(item.description || "").trim()
    || i18nT("Scorri in base al tuo gusto: questa scelta aiuta le raccomandazioni.");
  return `
    <article class="onboarding-seed-swipe-card" data-seed-card="${escapeHtml(item.id)}">
      <div class="onboarding-seed-swipe-poster">
        ${poster}
        <div class="onboarding-seed-swipe-progress">${escapeHtml(progressLabel)}</div>
        <div class="onboarding-seed-swipe-indicator left">${i18nT("Non mi piace")}</div>
        <div class="onboarding-seed-swipe-indicator right">Preferito</div>
        <div class="onboarding-seed-swipe-indicator up">${i18nT("Mi piace")}</div>
      </div>
      <div class="onboarding-seed-swipe-meta">
        <strong>${escapeHtml(item.name || i18nT("Titolo"))}</strong>
        <span>${escapeHtml(type)}${year}</span>
        <p class="onboarding-seed-swipe-overview">${escapeHtml(overview)}</p>
      </div>
    </article>
  `;
}

function pushSeedTelemetryClick(state, itemId, action) {
  const orderIndex = (state.telemetry.clicks?.length || 0) + 1;
  state.telemetry.clicks = state.telemetry.clicks || [];
  state.telemetry.clicks.push({
    itemId,
    action,
    orderIndex,
    timestampMs: Date.now(),
  });
  if (state.telemetry.clicks.length > 120) {
    state.telemetry.clicks = state.telemetry.clicks.slice(-120);
  }
  state.telemetry.counters.clickCount = state.telemetry.clicks.length;
}

function applySeedDecision(state, item, action) {
  if (!item?.id) return;
  const allowed = new Set(["dislike", "softlike", "like"]);
  if (!allowed.has(action)) return;

  hydrateSeedDecisionState(state);
  recomputeSeedAnswersFromDecisions(state);

  const prev = state.seedDecisionMap.get(item.id) || "";
  let finalAction = action;
  if (finalAction === "like" && prev !== "like") {
    const strongCount = (state.answers.seedTitleIds || []).length;
    if (strongCount >= MAX_SEEDS) {
      finalAction = "softlike";
      toast(i18nT("Massimo {MAX_SEEDS} preferiti: salvato come \"mi piace\".", { MAX_SEEDS }), "Onboarding");
    }
  }

  state.seedDecisionMap.set(item.id, finalAction);
  state.seedDecisionHistory.push({
    itemId: item.id,
    prevAction: prev || null,
    nextAction: finalAction,
  });
  if (state.seedDecisionHistory.length > 80) {
    state.seedDecisionHistory = state.seedDecisionHistory.slice(-80);
  }

  recomputeSeedAnswersFromDecisions(state);
  bumpToggle(state, "seedTitles");
  pushSeedTelemetryClick(state, item.id, finalAction);
  state.seedDeckCursor = findNextSeedCursor(state, Number(state.seedDeckCursor || 0) + 1);

  // Log unified taste signal (non blocking)
  const actionTypeMap = {
    dislike: "match_dislike",
    softlike: "match_ok",
    like: "match_love",
  };
  const normalizedValue = finalAction === "dislike" ? -1 : 1;
  const actionType = actionTypeMap[finalAction];
  if (actionType && state?.uid) {
    logSignal({
      uid: state.uid,
      titleId: item.id,
      actionType,
      rawValue: null,
      normalizedValue,
      source: "onboarding",
    }).catch((err) => console.warn("logSignal seed", err));
  }
}

function undoLastSeedDecision(state) {
  hydrateSeedDecisionState(state);
  const last = state.seedDecisionHistory.pop();
  if (!last?.itemId) return false;

  if (last.prevAction) state.seedDecisionMap.set(last.itemId, last.prevAction);
  else state.seedDecisionMap.delete(last.itemId);

  recomputeSeedAnswersFromDecisions(state);
  bumpToggle(state, "seedTitles");
  pushSeedTelemetryClick(state, last.itemId, "undo");

  const idx = (state.seedDeck || []).findIndex(row => row.id === last.itemId);
  state.seedDeckCursor = idx >= 0 ? idx : findNextSeedCursor(state, 0);
  return true;
}

function wireSeedSwipe(card, onAction) {
  if (!card || typeof onAction !== "function") return;
  let activePointer = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;

  const reset = () => {
    card.classList.remove("swipe-left", "swipe-right", "swipe-up");
    card.style.transition = "transform 160ms ease";
    card.style.transform = "";
  };

  const onPointerDown = (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    activePointer = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    dx = 0;
    dy = 0;
    try {
      card.setPointerCapture(activePointer);
    } catch (_) {}
    card.style.transition = "none";
  };

  const onPointerMove = (ev) => {
    if (activePointer === null || ev.pointerId !== activePointer) return;
    dx = ev.clientX - startX;
    dy = ev.clientY - startY;
    const rot = clamp(dx / 16, -12, 12);
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;

    card.classList.toggle("swipe-right", dx > 40 && Math.abs(dx) >= Math.abs(dy));
    card.classList.toggle("swipe-left", dx < -40 && Math.abs(dx) >= Math.abs(dy));
    card.classList.toggle("swipe-up", dy < -65 && Math.abs(dx) < 95);
  };

  const onPointerEnd = async (ev) => {
    if (activePointer === null || ev.pointerId !== activePointer) return;
    try {
      card.releasePointerCapture(activePointer);
    } catch (_) {}
    activePointer = null;

    let action = "";
    if (dx >= 110 && Math.abs(dx) >= Math.abs(dy)) action = "like";
    else if (dx <= -110 && Math.abs(dx) >= Math.abs(dy)) action = "dislike";
    else if (dy <= -120 && Math.abs(dx) < 95) action = "softlike";

    if (!action) {
      reset();
      return;
    }
    card.classList.remove("swipe-left", "swipe-right", "swipe-up");
    await onAction(action, card);
  };

  card.addEventListener("pointerdown", onPointerDown);
  card.addEventListener("pointermove", onPointerMove);
  card.addEventListener("pointerup", onPointerEnd);
  card.addEventListener("pointercancel", onPointerEnd);
}

function animateSeedCardOut(card, action) {
  return new Promise((resolve) => {
    if (!card) {
      resolve();
      return;
    }
    let tx = 0;
    let ty = 0;
    let rot = 0;
    if (action === "dislike") {
      tx = -Math.max(window.innerWidth * 0.9, 420);
      rot = -16;
    } else if (action === "like") {
      tx = Math.max(window.innerWidth * 0.9, 420);
      rot = 16;
    } else {
      ty = -Math.max(window.innerHeight * 0.7, 460);
      rot = 6;
    }

    card.style.transition = "transform 190ms ease, opacity 190ms ease";
    card.style.opacity = "0";
    card.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
    window.setTimeout(resolve, 200);
  });
}

function renderPublicNameStep(state, body) {
  const checked = validateDisplayName(state.answers.displayName);
  const isValid = !!checked.ok;
  const help = isValid
    ? i18nT("Nome valido. Deve essere univoco: lo verifichiamo prima di passare allo step successivo.")
    : i18nT("3-24 caratteri, almeno una lettera o numero.");

  body.innerHTML = `
    <label class="label required" for="obDisplayName">Nome pubblico</label>
    <input id="obDisplayName" class="input" type="text" maxlength="24" placeholder="Es. PaoloMovieNerd" value="${escapeHtml(state.answers.displayName || "")}" />
    <div class="${isValid ? "success-msg" : "hint"}">${escapeHtml(help)}</div>
  `;

  const input = body.querySelector("#obDisplayName");
  if (input) attachCharCounter(input);
  input?.addEventListener("input", () => {
    state.answers.displayName = input.value;
  });
}

function renderAvatarStep(state, body) {
  const avatarURL = state.answers.avatarURL;
  const label = state.answers.displayName || state.snapshot?.userDoc?.displayName || "User";
  const avatarHtml = avatarURL
    ? `<img src="${escapeHtml(avatarURL)}" alt="Avatar" loading="lazy" decoding="async">`
    : `<span>${escapeHtml(initials(label))}</span>`;

  body.innerHTML = `
    <div class="onboarding-avatar-step">
      <div class="onboarding-avatar-preview">${avatarHtml}</div>
      <div class="onboarding-avatar-actions">
        <input type="file" accept="image/jpeg,image/png,image/webp" id="obAvatarInput" hidden />
        <button type="button" class="btn small primary" data-ob-upload>${i18nT("Carica avatar")}</button>
        <button type="button" class="btn small ghost" data-ob-remove ${avatarURL ? "" : "disabled"}>${i18nT("Rimuovi")}</button>
      </div>
      <p class="hint">${i18nT("Opzionale. Se salti, usiamo iniziali e fallback grafico.")}</p>
    </div>
  `;

  const input = body.querySelector("#obAvatarInput");
  const uploadBtn = body.querySelector("[data-ob-upload]");
  const removeBtn = body.querySelector("[data-ob-remove]");

  uploadBtn?.addEventListener("click", () => input?.click());
  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast(i18nT("Seleziona un'immagine valida."), "Onboarding");
      input.value = "";
      return;
    }
    try {
      uploadBtn.disabled = true;
      uploadBtn.textContent = i18nT("Upload...");
      const { url } = await uploadAvatar({ file, uid: state.uid });
      state.answers.avatarURL = url;
      state.answers.avatarRemoved = false;
      bumpToggle(state, "avatar");
      renderWizard(state);
      toast(i18nT("Avatar aggiornato."), "Onboarding");
    } catch (err) {
      console.error(err);
      toast(err?.message || i18nT("Upload avatar non riuscito."), "Onboarding");
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = i18nT("Carica avatar");
      input.value = "";
    }
  });

  removeBtn?.addEventListener("click", () => {
    if (!state.answers.avatarURL) return;
    state.answers.avatarURL = "";
    state.answers.avatarRemoved = true;
    bumpToggle(state, "avatar");
    renderWizard(state);
  });
}

function renderSeedTitlesStep(state, body) {
  if (state.seedLoading) {
    body.innerHTML = `<div class="hint">${i18nT("Caricamento titoli...")}</div>`;
    return;
  }

  if (!Array.isArray(state.seedDeck) || !state.seedDeck.length) {
    state.seedDeck = buildSeedDeck(state.seedCatalog, SEED_DECK_TARGET);
  }
  hydrateSeedDecisionState(state);
  recomputeSeedAnswersFromDecisions(state);

  if (!state.seedDeck.length) {
    body.innerHTML = `<div class="hint">${i18nT("Non riesco a caricare i titoli ora. Puoi continuare e completare questo step piu' tardi.")}</div>`;
    return;
  }

  state.seedDeckCursor = findNextSeedCursor(state, Number(state.seedDeckCursor || 0));
  const current = state.seedDeck[state.seedDeckCursor] || null;
  const counts = seedDecisionCounts(state);
  const total = counts.deckTotal;
  const canProceed = counts.positiveTotal >= MIN_SEEDS && counts.strongTotal <= MAX_SEEDS;
  const progress = current ? `${Math.min(total, counts.decided + 1)}/${total}` : `${total}/${total}`;
  const done = !current;

  const guideOverlay = state.seedGuideDismissed
    ? ""
    : `<div class=\"seed-instructions-overlay\" data-seed-guide>
         <div class=\"seed-guide-arrows\">
           <span class=\"left\">${i18nT("\u2190 non mi piace")}</span>
           <span class=\"up\">${i18nT("↑ mi piace")}</span>
           <span class=\"right\">preferito \u2192</span>
         </div>
         <p>Swipe o usa i pulsanti sotto.</p>
         <button type=\"button\" class=\"btn xs ghost\" data-seed-guide-dismiss>Capito</button>
       </div>`;

  body.innerHTML = `
    <div class="seed-stage-compact">
      ${done
        ? `<div class="onboarding-seed-complete">
            <strong>Carte completate.</strong>
            <p>${i18nT("Puoi andare avanti o usare \"Annulla ultima\" per correggere.")}</p>
          </div>`
        : `<div class="seed-card-wrap">
             ${guideOverlay}
             ${seedSwipeCardHtml(current, progress)}
           </div>`
      }
    </div>
    <div class="seed-actions-compact">
      <button type="button" class="btn small ghost" data-seed-act="dislike" ${done ? "disabled" : ""} aria-label="${i18nT("Non mi piace")}">${i18nT("\u2190 Non mi piace")}</button>
      <button type="button" class="btn small ghost" data-seed-act="softlike" ${done ? "disabled" : ""} aria-label="${i18nT("Mi piace")}">${i18nT("↑ Mi piace")}</button>
      <button type="button" class="btn small primary" data-seed-act="like" ${done ? "disabled" : ""} aria-label="Preferito">Preferito \u2192</button>
    </div>
    <div class="seed-tools-compact">
      <button type="button" class="btn xs ghost" data-seed-undo ${state.seedDecisionHistory?.length ? "" : "disabled"}>${i18nT("Annulla ultima")}</button>
      <span class="hint">Valutate: ${counts.decided}/${counts.deckTotal} • Positivi ${counts.positiveTotal}${canProceed ? " (ok)" : ""}</span>
    </div>
  `;

  body.querySelector("[data-seed-guide-dismiss]")?.addEventListener("click", () => {
    state.seedGuideDismissed = true;
    renderSeedTitlesStep(state, body);
  });

  const applyAndRerender = async (action, sourceCard = null) => {
    if (!current || state.seedAnimating) return;
    state.seedAnimating = true;
    await animateSeedCardOut(sourceCard || body.querySelector("[data-seed-card]"), action);
    applySeedDecision(state, current, action);
    state.seedGuideDismissed = true;
    state.seedAnimating = false;
    renderSeedTitlesStep(state, body);
  };

  body.querySelectorAll("[data-seed-act]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-seed-act");
      const card = body.querySelector("[data-seed-card]");
      await applyAndRerender(action, card);
    });
  });

  body.querySelector("[data-seed-undo]")?.addEventListener("click", () => {
    const ok = undoLastSeedDecision(state);
    if (!ok) return;
    renderSeedTitlesStep(state, body);
  });

  const swipeCard = body.querySelector("[data-seed-card]");
  if (swipeCard && current) {
    wireSeedSwipe(swipeCard, async (action, card) => {
      await applyAndRerender(action, card);
    });
  }
}

function renderVibeStep(state, body) {
  const selected = new Set(state.answers.vibe || []);
  body.innerHTML = `
    <p class="hint">Scegli fino a ${MAX_VIBE} vibe.</p>
    <div class="onboarding-chip-grid">
      ${VIBE_OPTIONS.map(opt => {
        const active = selected.has(opt.id) ? "active" : "";
        return `<button type="button" class="onboarding-chip ${active}" data-vibe="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</button>`;
      }).join("")}
    </div>
  `;

  body.querySelectorAll("[data-vibe]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-vibe");
      if (!id) return;
      const next = new Set(state.answers.vibe || []);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= MAX_VIBE) {
          toast(`Massimo ${MAX_VIBE} vibe.`, "Onboarding");
          return;
        }
        next.add(id);
      }
      state.answers.vibe = Array.from(next);
      bumpToggle(state, "vibe");
      renderWizard(state);
    });
  });
}

function choiceButton(active, value, label, attr) {
  return `<button type="button" class="onboarding-chip ${active === value ? "active" : ""}" data-${attr}="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
}

function renderFormatStep(state, body) {
  const filmVsSeries = state.answers.filmVsSeries || "mix";
  const mainstream = state.answers.mainstream || "mix";

  body.innerHTML = `
    <div class="onboarding-block">
      <h4>Film vs Serie</h4>
      <div class="onboarding-chip-grid">
        ${choiceButton(filmVsSeries, "film", i18nT("Più film"), "film-series")}
        ${choiceButton(filmVsSeries, "mix", "Mix", "film-series")}
        ${choiceButton(filmVsSeries, "series", i18nT("Più serie"), "film-series")}
      </div>
    </div>
    <div class="onboarding-block">
      <h4>Mainstream vs Scoperte</h4>
      <div class="onboarding-chip-grid">
        ${choiceButton(mainstream, "mainstream", "Mainstream", "mainstream")}
        ${choiceButton(mainstream, "mix", "Mix", "mainstream")}
        ${choiceButton(mainstream, "discover", "Scoperte", "mainstream")}
      </div>
    </div>
  `;

  body.querySelectorAll("[data-film-series]").forEach(btn => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-film-series");
      if (!value) return;
      state.answers.filmVsSeries = value;
      bumpToggle(state, "format");
      renderWizard(state);
    });
  });
  body.querySelectorAll("[data-mainstream]").forEach(btn => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-mainstream");
      if (!value) return;
      state.answers.mainstream = value;
      bumpToggle(state, "format");
      renderWizard(state);
    });
  });
}

function renderAdvancedStep(state, body) {
  const selectedContext = new Set(state.answers.context || []);
  const selectedTolerance = state.answers.contentTolerance || "";
  body.innerHTML = `
    <div class="onboarding-block">
      <h4>Epoca preferita</h4>
      <div class="onboarding-chip-grid">
        ${ERA_OPTIONS.map(opt => choiceButton(state.answers.era || "", opt.id, opt.label, "era")).join("")}
      </div>
    </div>
    <div class="onboarding-block">
      <h4>${i18nT("Contesto di visione")}</h4>
      <div class="onboarding-chip-grid">
        ${CONTEXT_OPTIONS.map(opt => {
          const active = selectedContext.has(opt.id) ? "active" : "";
          return `<button type="button" class="onboarding-chip ${active}" data-context="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</button>`;
        }).join("")}
      </div>
    </div>
    <div class="onboarding-block">
      <h4>Tolleranza contenuti (opzionale)</h4>
      <div class="onboarding-chip-grid">
        ${TOLERANCE_OPTIONS.map(opt => choiceButton(selectedTolerance, opt.id, opt.label, "tolerance")).join("")}
      </div>
    </div>
    <div class="onboarding-block">
      <h4>${i18nT("Titolo del cuore (opzionale)")}</h4>
      <input id="obFavoriteTitle" class="input" type="text" maxlength="120" placeholder="${i18nT("Es. Il Signore degli Anelli")}" value="${escapeHtml(state.answers.favoriteTitleText || "")}" />
    </div>
  `;

  body.querySelectorAll("[data-era]").forEach(btn => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-era");
      if (!value) return;
      state.answers.era = value;
      bumpToggle(state, "advanced");
      renderWizard(state);
    });
  });
  body.querySelectorAll("[data-context]").forEach(btn => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-context");
      if (!value) return;
      const set = new Set(state.answers.context || []);
      if (set.has(value)) set.delete(value);
      else {
        if (set.size >= MAX_CONTEXT) {
          toast(`Massimo ${MAX_CONTEXT} contesti.`, "Onboarding");
          return;
        }
        set.add(value);
      }
      state.answers.context = Array.from(set);
      bumpToggle(state, "advanced");
      renderWizard(state);
    });
  });
  body.querySelectorAll("[data-tolerance]").forEach(btn => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-tolerance");
      if (!value) return;
      state.answers.contentTolerance = state.answers.contentTolerance === value ? "" : value;
      bumpToggle(state, "advanced");
      renderWizard(state);
    });
  });

  const favoriteInput = body.querySelector("#obFavoriteTitle");
  favoriteInput?.addEventListener("input", () => {
    state.answers.favoriteTitleText = favoriteInput.value;
  });
}

function renderDislikesStep(state, body) {
  const selected = new Set(state.answers.dislikes || []);
  body.innerHTML = `
    <p class="hint">Opzionale ma utile: scegli fino a ${MAX_DISLIKES} cose che non ti piacciono.</p>
    <div class="onboarding-chip-grid">
      ${DISLIKES_OPTIONS.map(opt => {
        const active = selected.has(opt.id) ? "active" : "";
        return `<button type="button" class="onboarding-chip ${active}" data-dislike="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</button>`;
      }).join("")}
    </div>
  `;

  body.querySelectorAll("[data-dislike]").forEach(btn => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-dislike");
      if (!value) return;
      const set = new Set(state.answers.dislikes || []);
      if (set.has(value)) set.delete(value);
      else {
        if (set.size >= MAX_DISLIKES) {
          toast(`Massimo ${MAX_DISLIKES} anti-preferenze.`, "Onboarding");
          return;
        }
        set.add(value);
      }
      state.answers.dislikes = Array.from(set);
      bumpToggle(state, "dislikes");
      renderWizard(state);
    });
  });
}

function renderStepBody(state, body) {
  const stepId = state.steps[state.currentStepIndex]?.id;
  if (!stepId) return;

  if (stepId === "publicName") return renderPublicNameStep(state, body);
  if (stepId === "avatar") return renderAvatarStep(state, body);
  if (stepId === "seedTitles") return renderSeedTitlesStep(state, body);
  if (stepId === "vibe") return renderVibeStep(state, body);
  if (stepId === "format") return renderFormatStep(state, body);
  if (stepId === "advanced") return renderAdvancedStep(state, body);
  if (stepId === "dislikes") return renderDislikesStep(state, body);
}

function footerHtml(state) {
  const isFirst = state.currentStepIndex === 0;
  const isLast = state.currentStepIndex === state.steps.length - 1;
  let nextLabel = i18nT("Avanti");
  if (isLast) {
    if (state.scope === "identity") nextLabel = i18nT("Salva nome e avatar");
    else if (state.scope === "taste") nextLabel = i18nT("Salva gusti");
    else nextLabel = i18nT("Completa {v0}", { v0: getOnboardingLevelLabel(state.level) });
  }
  return `
    <div class="onboarding-wizard-footer">
      <button type="button" class="btn small ghost" data-ob-save-close>${i18nT("Salva bozza e chiudi")}</button>
      <div class="onboarding-wizard-nav">
        <button type="button" class="btn small ghost" data-ob-prev ${isFirst ? "disabled" : ""}>${i18nT("Indietro")}</button>
        <button type="button" class="btn small primary" data-ob-next>${escapeHtml(nextLabel)}</button>
      </div>
    </div>
  `;
}

async function closeWizardWithDraft(state, { markDismiss = false } = {}) {
  const currentStep = state.steps[state.currentStepIndex]?.id;
  if (currentStep) endStepTimer(state, currentStep);
  normalizeArrays(state);
  try {
    await saveOnboardingDraft({
      uid: state.uid,
      selectedLevel: state.level,
      answers: state.answers,
    });
    await saveOnboardingTelemetry({
      uid: state.uid,
      sessionId: state.sessionId,
      telemetry: state.telemetry,
      completed: false,
    });
    if (markDismiss) {
      await dismissOnboardingPrompt(state.uid, { source: "wizard-close" });
      trackProductEvent("onboarding_skipped");
      void logEvent("onboarding_skipped", { source: "wizard-close" });
    }
  } catch (err) {
    console.warn("onboarding close draft error", err);
  }
  toast(i18nT("Bozza salvata. Puoi completare dopo."), "Onboarding");
  closeOverlay();
  state.onClose?.();
}

async function submitWizard(state, nextBtn) {
  const check = await validateCurrentStepAsync(state);
  if (!check.ok) {
    toast(check.error || i18nT("Completa lo step corrente."), "Onboarding");
    return;
  }

  const stepId = state.steps[state.currentStepIndex]?.id;
  if (stepId) endStepTimer(state, stepId);
  normalizeArrays(state);

  nextBtn.disabled = true;
  nextBtn.textContent = i18nT("Salvataggio...");
  try {
    const result = await finalizeOnboarding({
      uid: state.uid,
      selectedLevel: state.level,
      scope: state.scope,
      answers: state.answers,
      telemetry: state.telemetry,
      sessionId: state.sessionId,
    });
    closeOverlay();
    if (result?.autoFallbackDisplayName) {
      toast(i18nT("Nome occupato: salvato come {displayName}.", { displayName: result.displayName }), "Onboarding");
    } else {
      toast(i18nT("Onboarding aggiornato."), "Onboarding");
    }
    state.onCompleted?.(result);
  } catch (err) {
    console.error(err);
    nextBtn.disabled = false;
    if (state.scope === "identity") nextBtn.textContent = i18nT("Salva nome e avatar");
    else if (state.scope === "taste") nextBtn.textContent = i18nT("Salva gusti");
    else nextBtn.textContent = i18nT("Completa {v0}", { v0: getOnboardingLevelLabel(state.level) });
    const rawMessage = String(err?.message || "");
    if (/permission|insufficient/i.test(rawMessage)) {
      toast(i18nT("Salvataggio bloccato dalle regole dati del profilo. Riprova: ora il salvataggio forza una normalizzazione completa."), "Onboarding");
    } else {
      toast(rawMessage || i18nT("Salvataggio non riuscito"), "Onboarding");
    }
    const restoreStep = state.steps[state.currentStepIndex]?.id;
    if (restoreStep) startStepTimer(state, restoreStep);
  }
}

function renderWizard(state) {
  const overlay = state.overlay;
  if (!overlay) return;
  const step = state.steps[state.currentStepIndex];
  if (!step) return;

  const currentStepId = step.id;
  startStepTimer(state, currentStepId);

  overlay.innerHTML = `
    <div class="onboarding-modal onboarding-modal-full">
      ${makeStepHeader(state)}
      <div class="onboarding-wizard-body" data-ob-body></div>
      ${footerHtml(state)}
    </div>
  `;

  const body = overlay.querySelector("[data-ob-body]");
  renderStepBody(state, body);

  overlay.querySelector("[data-ob-close]")?.addEventListener("click", () => {
    closeWizardWithDraft(state, {
      markDismiss: Number(state.snapshot?.completedLevel || 0) < 1,
    });
  });

  overlay.querySelector("[data-ob-save-close]")?.addEventListener("click", () => {
    closeWizardWithDraft(state, {
      markDismiss: Number(state.snapshot?.completedLevel || 0) < 1,
    });
  });

  overlay.querySelector("[data-ob-prev]")?.addEventListener("click", () => {
    const current = state.steps[state.currentStepIndex]?.id;
    if (current) endStepTimer(state, current);
    state.currentStepIndex = Math.max(0, state.currentStepIndex - 1);
    renderWizard(state);
  });

  overlay.querySelector("[data-ob-next]")?.addEventListener("click", async (event) => {
    if (state.isTransitioning) return;
    const nextBtn = event.currentTarget;
    const previousLabel = nextBtn.textContent;
    state.isTransitioning = true;
    nextBtn.disabled = true;
    nextBtn.setAttribute("aria-busy", "true");
    nextBtn.textContent = i18nT("Controllo...");

    try {
      const checked = await validateCurrentStepAsync(state);
      if (!checked.ok) {
        toast(checked.error || i18nT("Completa questo step."), "Onboarding");
        return;
      }
      const isLast = state.currentStepIndex === state.steps.length - 1;
      if (!isLast) {
        const current = state.steps[state.currentStepIndex]?.id;
        if (current) endStepTimer(state, current);
        state.currentStepIndex += 1;
        renderWizard(state);
        return;
      }
      await submitWizard(state, nextBtn);
    } finally {
      state.isTransitioning = false;
      if (nextBtn.isConnected && !nextBtn.closest("[hidden]")) {
        nextBtn.disabled = false;
        nextBtn.removeAttribute("aria-busy");
        if (nextBtn.textContent === i18nT("Controllo...")) nextBtn.textContent = previousLabel;
      }
    }
  });
}

async function openWizard({
  uid,
  level,
  scope = "full",
  snapshot,
  onCompleted,
  onClose,
} = {}) {
  const safeLevel = clampLevel(level);
  const safeScope = normalizeWizardScope(scope);
  const freshSnapshot = snapshot || await getOnboardingSnapshot(uid);
  const answers = buildInitialAnswers(freshSnapshot);
  const overlay = createOverlay();
  const session = await startOnboardingSession({ uid, level: safeLevel });
  const scopedSteps = getStepsForScope(safeLevel, safeScope);

  const state = {
    uid,
    level: safeLevel,
    scope: safeScope,
    overlay,
    snapshot: freshSnapshot,
    answers,
    sessionId: session.sessionId,
    currentStepIndex: 0,
    isTransitioning: false,
    steps: scopedSteps.length ? scopedSteps : getStepsForLevel(safeLevel),
    seedCatalog: [],
    seedDeck: [],
    seedLoading: true,
    seedDeckCursor: 0,
    seedDecisionMap: new Map(),
    seedDecisionHistory: [],
    seedAnimating: false,
    seedGuideDismissed: false,
    stepStartedAtMs: Date.now(),
    activeStepId: null,
    telemetry: {
      startedMs: Date.now(),
      levelChosen: safeLevel,
      steps: {},
      clicks: [],
      counters: {
        toggleCount: 0,
        clickCount: 0,
      },
    },
    onCompleted,
    onClose,
  };

  renderWizard(state);

  listOnboardingSeedTitles({ max: SEED_FETCH_MAX })
    .then(rows => {
      state.seedCatalog = Array.isArray(rows)
        ? rows.map((item, idx) => ({ ...item, _seedOrder: idx }))
        : [];
      state.seedDeck = buildSeedDeck(state.seedCatalog, SEED_DECK_TARGET);
      hydrateSeedDecisionState(state);
      recomputeSeedAnswersFromDecisions(state);
      state.seedDeckCursor = findNextSeedCursor(state, 0);
      state.seedLoading = false;
      const stepId = state.steps[state.currentStepIndex]?.id;
      if (stepId === "seedTitles") renderWizard(state);
    })
    .catch((err) => {
      console.warn("seed titles load error", err);
      state.seedCatalog = [];
      state.seedLoading = false;
      const stepId = state.steps[state.currentStepIndex]?.id;
      if (stepId === "seedTitles") renderWizard(state);
    });
}

async function openLevelChooser({
  uid,
  snapshot,
  source = "home",
  defaultLevel = 1,
  scope = "full",
  onCompleted,
  onDismiss,
} = {}) {
  const overlay = createOverlay();
  const completedLevel = Number(snapshot?.completedLevel || 0);
  const recLevel = clampLevel(defaultLevel || getNextUpgradeLevel(completedLevel));
  const title = completedLevel < 1
    ? i18nT("Personalizza Somto per suggerimenti migliori")
    : i18nT("Fai upgrade del tuo profilo gusti");

  overlay.innerHTML = `
    <div class="onboarding-modal onboarding-level-picker">
      <h2>${escapeHtml(title)}</h2>
      <p>${i18nT("Scegli il livello che vuoi completare adesso. Puoi fare upgrade in seguito.")}</p>
      <div class="onboarding-level-grid">
        ${[1, 2, 3].map(level => {
          const rec = level === recLevel ? '<span class="onboarding-pill rec">Consigliato</span>' : '';
          return `
            <button type="button" class="onboarding-level-btn ${level === recLevel ? "recommended" : ""}" data-level="${level}">
              <strong>${escapeHtml(getOnboardingLevelLabel(level))}</strong>
              <span>${escapeHtml(levelEta(level))}</span>
              <small>${escapeHtml(levelSubtitle(level))}</small>
              ${rec}
            </button>
          `;
        }).join("")}
      </div>
      <div class="onboarding-level-actions">
        <button type="button" class="btn small ghost" data-onb-later>${i18nT("Piu' tardi")}</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll("[data-level]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const level = clampLevel(btn.getAttribute("data-level"));
      await openWizard({
        uid,
        level,
        scope,
        snapshot,
        onCompleted,
        onClose: onDismiss,
      });
    });
  });

  overlay.querySelector("[data-onb-later]")?.addEventListener("click", async () => {
    try {
      await dismissOnboardingPrompt(uid, { source });
    } catch (_) {}
    closeOverlay();
    onDismiss?.();
  });
}

async function refreshSnapshotSafe(uid) {
  try {
    return await getOnboardingSnapshot(uid);
  } catch (err) {
    console.warn("onboarding snapshot error", err);
    return null;
  }
}


export async function openAccountIdentityWizard({
  uid,
  onCompleted,
  onClose,
} = {}) {
  if (!uid) return false;
  const snapshot = await refreshSnapshotSafe(uid);
  if (!snapshot) return false;

  await openWizard({
    uid,
    level: Math.max(1, Number(snapshot.completedLevel || 1)),
    scope: "identity",
    snapshot,
    onCompleted,
    onClose,
  });
  return true;
}

export async function openAccountTasteWizard({
  uid,
  source = "account-inline",
  defaultLevel,
  onCompleted,
  onDismiss,
} = {}) {
  if (!uid) return false;
  const snapshot = await refreshSnapshotSafe(uid);
  if (!snapshot) return false;

  await openLevelChooser({
    uid,
    snapshot,
    source,
    defaultLevel: defaultLevel || getNextUpgradeLevel(snapshot.completedLevel || 0),
    scope: "taste",
    onCompleted,
    onDismiss,
  });
  return true;
}

export async function initAccountOnboardingPanel({
  uid,
  containerSelector = "#onboardingAccountPanel",
  onCompleted,
} = {}) {
  if (!uid) return;
  const panel = document.querySelector(containerSelector);
  if (!panel) return;

  async function rerender() {
    const snapshot = await refreshSnapshotSafe(uid);
    if (!snapshot) return;

    renderAccountPanel(panel, snapshot, {
      onEditIdentity: async (completedLevel) => {
        await openWizard({
          uid,
          level: Math.max(1, Number(completedLevel || snapshot.completedLevel || 1)),
          scope: "identity",
          snapshot,
          onCompleted: async (result) => {
            onCompleted?.(result);
            await rerender();
          },
          onClose: async () => {
            await rerender();
          },
        });
      },
      onTaste: async (level) => {
        await openLevelChooser({
          uid,
          snapshot,
          source: "account-panel-start",
          defaultLevel: level || getNextUpgradeLevel(snapshot.completedLevel || 0),
          scope: "taste",
          onCompleted: async (result) => {
            onCompleted?.(result);
            await rerender();
          },
          onDismiss: async () => {
            await rerender();
          },
        });
      },
      onChooseLevel: async () => {
        await openLevelChooser({
          uid,
          snapshot,
          source: "account-panel",
          defaultLevel: getNextUpgradeLevel(snapshot.completedLevel || 0),
          scope: "taste",
          onCompleted: async (result) => {
            onCompleted?.(result);
            await rerender();
          },
          onDismiss: async () => {
            await rerender();
          },
        });
      },
    });
  }

  await rerender();
}
