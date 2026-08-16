/**
 * quiz-challenges.page.js — Inbox sfide + composer (web).
 * Replica QuizChallengeInboxView.swift + QuizChallengeComposerView.swift:
 *  - segmented Ricevute/Inviate, righe sfida con stato/punteggio,
 *  - CTA "Invita un amico" tratteggiata,
 *  - composer modale a 2 path: amico Somto / invito esterno con link.
 */

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { escapeHtml } from "../utils/dom.js";
import { toast } from "../components/toast.js";
import {
  ICONS, formatScore, statusPill, avatarMarkup, initial,
  loadingState, emptyState, errorState,
} from "../components/quizUI.js";
import {
  fetchReceivedChallenges, fetchSentChallenges, sendChallenge,
  createExternalInvite, fetchPlayableQuestions, fetchPlayableQuestionsForTitles,
} from "../api/quiz.api.js";
import { listFriends, listUsersPublicByIds } from "../api/users.api.js";
import { getMyWatchlist } from "../api/watchlist.api.js";
import { createTitlePicker } from "../components/quizTitlePicker.js";
import { listCompletedTitleIDs } from "../api/titleStates.api.js";

const root = document.getElementById("quizChallenges");
const modalRoot = document.getElementById("quizComposerModal");

function uuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const state = {
  uid: null,
  section: "received",   // received | sent
  received: [],
  sent: [],
  usersByUid: {},
  status: "loading",     // loading | ready | error
  errorMessage: "",
  seenIds: new Set(),
};

/* ===== Stato sfida → pill/label/tint (QuizState) ===== */

function challengeIsComplete(c) {
  return c.fromScore != null && c.toScore != null;
}
function isAwaitingExternalSignup(c) {
  return c.inviteType === "external" && (!c.toUid);
}
/** Esito dal punto di vista del creator (creatorOutcome). */
function creatorOutcome(c) {
  if (c.fromScore == null || c.toScore == null) return null;
  if (c.fromScore > c.toScore) return "win";
  if (c.fromScore < c.toScore) return "loss";
  return "draw";
}
/** Esito dal punto di vista del viewer (flip se è lato `to`). */
function viewerOutcome(c, isReceived) {
  const creator = creatorOutcome(c);
  if (!creator) return null;
  if (!isReceived) return creator;
  if (creator === "win") return "loss";
  if (creator === "loss") return "win";
  return "draw";
}
function opponentLabel(c) {
  if (c.opponentDisplayName) return c.opponentDisplayName;
  if (c.opponentPlaceholderName) return c.opponentPlaceholderName;
  return c.inviteType === "external" ? i18nT("Invito esterno") : "Avversario";
}

/** Pill di stato per una sfida (QuizState.pill). */
function challengeStatePill(c, isReceived, hasPlayed) {
  if (challengeIsComplete(c)) {
    const o = viewerOutcome(c, isReceived);
    if (o === "win") return statusPill("Vittoria", { tint: "var(--success)", icon: "crown" });
    if (o === "loss") return statusPill("Sconfitta", { tint: "var(--brand-primary)", icon: "flag" });
    if (o === "draw") return statusPill("Pareggio", { tint: "var(--accent)", icon: "equal" });
    return statusPill(i18nT("Completata"), { tint: "var(--success)", icon: "check" });
  }
  if (isAwaitingExternalSignup(c)) {
    return statusPill(i18nT("In attesa registrazione"), { tint: "var(--warning)", icon: "hourglass" });
  }
  if (c.status === "pending_opponent_titles") {
    return statusPill(i18nT("In attesa titoli"), { tint: "var(--warning)", icon: "film" });
  }
  if (c.status === "expired") return statusPill("Scaduta", { tint: "var(--text-muted)", icon: "clock" });
  if (c.status === "cancelled") return statusPill("Annullata", { tint: "var(--text-muted)", icon: "close" });
  if (hasPlayed) return statusPill(i18nT("In attesa avversario"), { tint: "var(--text-muted)", icon: "hourglass" });
  if (c.questionIds && c.questionIds.length) {
    return statusPill("Gioca ora", { tint: "var(--brand-primary)", icon: "play", filled: true });
  }
  return statusPill("In preparazione", { tint: "var(--text-muted)", icon: "hourglass" });
}

function stateTint(c) {
  if (challengeIsComplete(c)) return creatorOutcome(c) ? "var(--brand-primary)" : "var(--success)";
  if (isAwaitingExternalSignup(c)) return "var(--warning)";
  if (c.status === "pending_opponent_titles") return "var(--warning)";
  if (c.status === "expired" || c.status === "cancelled") return "var(--text-muted)";
  return "var(--brand-primary)";
}

/* ===== Render righe sfida ===== */

function otherUserFor(c) {
  const otherUid = c.fromUid === state.uid ? c.toUid : c.fromUid;
  return otherUid ? state.usersByUid[otherUid] : null;
}

function challengeRow(c) {
  const isReceived = c.toUid === state.uid;
  const myScore = isReceived ? c.toScore : c.fromScore;
  const theirScore = isReceived ? c.fromScore : c.toScore;
  const hasPlayed = myScore != null;
  const isComplete = challengeIsComplete(c);

  const playable = !!state.uid && c.questionIds && c.questionIds.length && !hasPlayed
    && ["pending", "pending_opponent_play", "in_progress", "played"].includes(c.status);

  const otherUser = otherUserFor(c);
  const label = opponentLabel(c);
  const ringTint = stateTint(c);

  // Avatar: foto utente, oppure iniziale, oppure glifo link/persona.
  let avatar;
  const photo = otherUser ? (otherUser.photoURL || otherUser.avatarURL) : null;
  if (photo) {
    avatar = `<img class="quiz-challenge-avatar" style="--quiz-ch-ring:${ringTint}" src="${escapeHtml(photo)}" alt="" loading="lazy">`;
  } else if (label !== i18nT("Invito esterno") && label !== "Avversario" && label.trim()) {
    avatar = `<span class="quiz-challenge-avatar quiz-avatar-fallback is-gradient" style="--quiz-ch-ring:${ringTint}">${escapeHtml(initial(label))}</span>`;
  } else {
    const glyph = c.inviteType === "external" ? ICONS.link : ICONS.people;
    avatar = `<span class="quiz-challenge-avatar quiz-avatar-fallback is-gradient" style="--quiz-ch-ring:${ringTint}">${glyph}</span>`;
  }

  // Score line (sfida completa).
  let scoreLine = "";
  if (isComplete && myScore != null && theirScore != null) {
    const total = Math.max(myScore + theirScore, 0.001);
    const minePct = Math.max(myScore, 0) / total * 100;
    const mineWins = myScore >= theirScore;
    scoreLine = `
      <div class="quiz-challenge-scoreline">
        <div class="nums">
          <span class="quiz-score-mine${mineWins ? "" : " is-losing"}">Tu ${formatScore(myScore)}</span>
          <span class="quiz-score-vs">vs</span>
          <span class="quiz-score-theirs${theirScore > myScore ? "" : " is-losing"}">${formatScore(theirScore)}</span>
        </div>
        <div class="quiz-score-meter"><div class="quiz-score-meter-fill" style="width:${minePct}%"></div></div>
      </div>`;
  } else if (hasPlayed) {
    scoreLine = `<span class="quiz-challenge-note">${i18nT("Hai già giocato. In attesa dell'avversario.")}</span>`;
  }

  const trailing = playable
    ? `<span class="quiz-challenge-play-glyph">${ICONS.play}</span>`
    : (isComplete ? `<span class="quiz-challenge-chevron">${ICONS.chevron}</span>` : "");

  const inner = `
    <div class="quiz-challenge-row${playable ? " is-playable" : ""}">
      ${avatar}
      <div class="quiz-challenge-body">
        <span class="quiz-challenge-header">${isReceived ? "SFIDA DA" : "SFIDA A"}</span>
        <span class="quiz-challenge-name">${escapeHtml(label)}</span>
        <div class="quiz-challenge-meta">
          ${challengeStatePill(c, isReceived, hasPlayed)}
          <span class="quiz-challenge-qcount">${ICONS.list}<span>${c.numQuestions}</span></span>
        </div>
        ${scoreLine}
      </div>
      ${trailing}
    </div>`;

  if (playable) {
    return `<a class="quiz-pressable" href="/quiz-play.html?challenge=${encodeURIComponent(c.challengeId)}">${inner}</a>`;
  }
  if (isComplete) {
    return `<a class="quiz-pressable" href="/quiz-challenge-result.html?id=${encodeURIComponent(c.challengeId)}">${inner}</a>`;
  }
  return inner;
}

/** Hero unico per la lista vuota: spiega la meccanica + 1 sola CTA. */
function challengeEmptyHero(section) {
  return `
    <div class="quiz-challenge-empty">
      <span class="hero-icon">${ICONS.person2plus}</span>
      <div class="hero-title">${section === "received" ? i18nT("Nessuna sfida ricevuta") : i18nT("Nessuna sfida inviata")}</div>
      <p class="hero-desc">${i18nT("Stesse domande per entrambi, vince chi fa più punti.")}<br>${i18nT("Sfida un amico Somto o invita chiunque con un link.")}</p>
      <button type="button" class="btn primary" id="quizEmptyCreate">${ICONS.person2plus}<span>${i18nT("Crea una sfida")}</span></button>
    </div>`;
}

/** Affordance slim "nuova sfida" in coda alla lista (non duplica l'hero). */
function newChallengeButton() {
  return `
    <button type="button" class="quiz-new-challenge-row" id="quizNewChallengeRow">
      ${ICONS.plus}<span>${i18nT("Nuova sfida")}</span>
    </button>`;
}

/* ===== Render pagina ===== */

function renderSegmented() {
  const opts = [
    { key: "received", label: i18nT("Ricevute") },
    { key: "sent", label: i18nT("Inviate") },
  ];
  return `
    <div class="quiz-challenges-toolbar">
      <div class="quiz-segmented" role="tablist" aria-label="Sezione sfide" style="flex:1">
        ${opts.map((o) => `
          <button type="button" role="tab" data-section="${o.key}"
            class="${state.section === o.key ? "is-active" : ""}"
            aria-selected="${state.section === o.key}">${o.label}</button>`).join("")}
      </div>
      <button type="button" class="quiz-new-challenge-btn" id="quizNewChallengeBtn" aria-label="${i18nT("Nuova sfida")}">${ICONS.plus}</button>
    </div>`;
}

function render() {
  if (state.status === "loading") {
    root.innerHTML = `${renderSegmented()}${loadingState(i18nT("Carico le sfide…"))}`;
    bindToolbar();
    return;
  }
  if (state.status === "error") {
    root.innerHTML = `${renderSegmented()}${errorState({ title: i18nT("Impossibile caricare le sfide"), message: state.errorMessage })}`;
    bindToolbar();
    document.getElementById("quizRetry")?.addEventListener("click", load);
    return;
  }

  const list = state.section === "received" ? state.received : state.sent;
  let body;
  if (!list.length) {
    body = challengeEmptyHero(state.section);
  } else {
    body = `
      <div class="quiz-challenge-list">
        ${list.map(challengeRow).join("")}
        ${newChallengeButton()}
      </div>`;
  }

  root.innerHTML = `${renderSegmented()}${body}`;
  bindToolbar();
  bindBody();
}

/* ===== Dati ===== */

async function load() {
  if (!state.uid) return;
  state.status = "loading";
  render();
  // Best-effort: popola i titoli completati per il picker specifico nel composer.
  try {
    state.seenIds = await listCompletedTitleIDs(state.uid);
  } catch (_) {
    state.seenIds = new Set();
  }
  try {
    const [received, sent] = await Promise.all([
      fetchReceivedChallenges(state.uid),
      fetchSentChallenges(state.uid),
    ]);
    state.received = received;
    state.sent = sent;
    // Carica i profili degli avversari interni.
    const uids = new Set();
    [...received, ...sent].forEach((c) => {
      if (c.fromUid && c.fromUid !== state.uid) uids.add(c.fromUid);
      if (c.toUid && c.toUid !== state.uid) uids.add(c.toUid);
    });
    const missing = [...uids].filter((u) => !state.usersByUid[u]);
    if (missing.length) {
      const users = await listUsersPublicByIds(missing).catch(() => []);
      users.forEach((u) => {
        const id = u.uid || u.id;
        if (id) state.usersByUid[id] = u;
      });
    }
    state.status = "ready";
  } catch (err) {
    console.error("[quiz-challenges] load error", err);
    state.status = "error";
    state.errorMessage = err?.message || i18nT("Errore imprevisto.");
  }
  render();
}

/* ===== Wiring pagina ===== */

function bindToolbar() {
  root.querySelectorAll("[data-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-section");
      if (next === state.section) return;
      state.section = next;
      render();
    });
  });
  document.getElementById("quizNewChallengeBtn")?.addEventListener("click", openComposer);
}

function bindBody() {
  document.getElementById("quizNewChallengeRow")?.addEventListener("click", openComposer);
  document.getElementById("quizEmptyCreate")?.addEventListener("click", openComposer);
}

/* ============================================================
   COMPOSER — QuizChallengeComposerView
   2 path: amico Somto / invito esterno.
   ============================================================ */

const composer = {
  path: "friend",        // friend | external
  friends: [],
  friendsLoaded: false,
  selectedFriend: null,
  questionMode: "random",   // random | specific
  specificTitleId: null,
  titlePicker: null,
  numQuestions: 5,
  externalName: "",
  inviteResult: null,
  isBusy: false,
  errorMessage: "",
};

const SHARE_MESSAGE = i18nT("Ti ho sfidato su Somto Quiz 🎬🔥 Registrati e giochiamo una sfida su film e serie!");

function openComposer() {
  // Reset stato composer a ogni apertura.
  composer.path = "friend";
  composer.selectedFriend = null;
  composer.questionMode = "random";
  composer.specificTitleId = null;
  composer.titlePicker = createTitlePicker({ seenIds: state.seenIds || new Set(), onChange: onPickTitle });
  composer.numQuestions = 5;
  composer.externalName = "";
  composer.inviteResult = null;
  composer.isBusy = false;
  composer.errorMessage = "";
  modalRoot.classList.add("is-open");
  document.body.classList.add("quiz-modal-open"); // blocca lo scroll (NON app-shell-menu-open: aprirebbe il drawer laterale)
  renderComposer();
  if (!composer.friendsLoaded) void loadFriends();
}

function closeComposer() {
  modalRoot.classList.remove("is-open");
  document.body.classList.remove("quiz-modal-open");
  modalRoot.innerHTML = "";
  // Ricarica le sfide: potrebbe esserne stata creata una.
  void load();
}

async function loadFriends() {
  if (!state.uid) return;
  try {
    // I doc in users/{uid}/friends contengono solo lo stato: arricchiamo con
    // il profilo pubblico così la riga mostra nome, handle e avatar (come iOS).
    const friendDocs = await listFriends(state.uid);
    const ids = friendDocs.map((f) => f.uid).filter(Boolean);
    let profiles = [];
    if (ids.length) {
      profiles = await listUsersPublicByIds(ids).catch(() => []);
    }
    const profileByUid = {};
    profiles.forEach((p) => {
      const id = p.uid || p.id;
      if (id) profileByUid[id] = p;
    });
    composer.friends = friendDocs.map((f) => ({ ...(profileByUid[f.uid] || {}), ...f }));
  } catch (err) {
    console.error("[quiz-composer] loadFriends error", err);
    composer.errorMessage = err?.message || i18nT("Impossibile caricare gli amici.");
  }
  composer.friendsLoaded = true;
  if (modalRoot.classList.contains("is-open")) renderComposer();
}

function selectFriend(friend) {
  composer.selectedFriend = friend;
  composer.errorMessage = "";
  renderComposer();
}

async function sendFriendChallenge() {
  if (!state.uid || !composer.selectedFriend || composer.isBusy) return;
  composer.isBusy = true;
  composer.errorMessage = "";
  renderComposer();
  try {
    const toUid = composer.selectedFriend.uid || composer.selectedFriend.id;
    // Validazione sorgente domande.
    if (composer.questionMode === "specific" && !composer.specificTitleId) {
      composer.errorMessage = i18nT("Scegli un titolo per la sfida.");
      composer.isBusy = false;
      return renderComposer();
    }
    const titleIds = (composer.questionMode === "specific" && composer.specificTitleId)
      ? [composer.specificTitleId] : [];
    const questions = titleIds.length
      ? await fetchPlayableQuestionsForTitles(titleIds, composer.numQuestions)
      : await fetchPlayableQuestions(composer.numQuestions);
    if (!questions.length) {
      composer.errorMessage = i18nT("Non ho trovato domande disponibili.");
      composer.isBusy = false;
      return renderComposer();
    }
    await sendChallenge({
      challengeId: uuid(),
      fromUid: state.uid,
      toUid,
      questionIds: questions.map((q) => q.questionId),
      numQuestions: questions.length,
      sharedTitleIds: titleIds,
    });
    showSuccessBanner();
    window.setTimeout(closeComposer, 1200);
  } catch (err) {
    console.error("[quiz-composer] sendFriendChallenge error", err);
    composer.errorMessage = err?.message || i18nT("Invio non riuscito.");
    composer.isBusy = false;
    renderComposer();
  }
}

async function createExternal() {
  if (!state.uid || composer.isBusy) return;
  composer.isBusy = true;
  composer.errorMessage = "";
  renderComposer();
  try {
    // Titoli visti dell'invitante (dalla sua watchlist), per pre-compilare l'onboarding.
    let seenIds = [];
    try {
      const lib = await getMyWatchlist(state.uid, { max: 200 });
      seenIds = lib.map((e) => e.titleId || e.id).filter(Boolean).slice(0, 60);
    } catch (_) { seenIds = []; }
    const result = await createExternalInvite({
      placeholderName: composer.externalName.trim() || undefined,
      numQuestions: composer.numQuestions,
      inviterSeenTitleIds: seenIds,
    });
    composer.inviteResult = result;
  } catch (err) {
    console.error("[quiz-composer] createExternal error", err);
    composer.errorMessage = err?.message || i18nT("Creazione invito non riuscita.");
  }
  composer.isBusy = false;
  renderComposer();
}

function showSuccessBanner() {
  document.querySelector(".quiz-success-banner")?.remove();
  const banner = document.createElement("div");
  banner.className = "quiz-success-banner";
  banner.innerHTML = `
    ${ICONS.checkCircle}
    <div class="copy"><strong>${i18nT("Sfida inviata!")}</strong><small>${i18nT("La trovi nelle sfide inviate.")}</small></div>`;
  document.body.appendChild(banner);
  window.setTimeout(() => banner.remove(), 2400);
}

async function shareInviteLink(url) {
  try {
    if (navigator.share) {
      await navigator.share({ title: i18nT("Somto Quiz"), text: SHARE_MESSAGE, url });
      return;
    }
  } catch (_) { /* utente ha annullato — fallback alla copia */ }
  try {
    await navigator.clipboard.writeText(`${SHARE_MESSAGE} ${url}`);
    toast(i18nT("Link copiato negli appunti."), i18nT("Invito"));
  } catch (_) {
    toast(i18nT("Copia manualmente il link mostrato."), i18nT("Invito"));
  }
}

/* ===== Callback picker titolo ===== */

function onPickTitle(id) {
  composer.specificTitleId = id || null;
  // Aggiorna solo il bottone di invio senza ri-renderizzare (conserva focus/scroll del picker).
  const btn = document.getElementById("composerSendFriend");
  if (btn) {
    const canSend = composer.questionMode === "random" || !!composer.specificTitleId;
    btn.disabled = composer.isBusy || !canSend;
    const span = btn.querySelector("span");
    if (span) span.textContent = (composer.questionMode === "specific" && !composer.specificTitleId) ? i18nT("Scegli un titolo") : i18nT("Invia sfida");
  }
}

/* ===== Render composer ===== */

function composerPathPicker() {
  const opts = [
    { key: "friend", label: "Amico Somto" },
    { key: "external", label: "Invita esterno" },
  ];
  return `
    <div class="quiz-field">
      <span class="quiz-field-label">${i18nT("Come vuoi sfidare?")}</span>
      <div class="quiz-segmented" role="tablist" aria-label="${i18nT("Tipo di sfida")}">
        ${opts.map((o) => `
          <button type="button" role="tab" data-path="${o.key}"
            class="${composer.path === o.key ? "is-active" : ""}"
            aria-selected="${composer.path === o.key}">${o.label}</button>`).join("")}
      </div>
      <span class="quiz-field-hint">${composer.path === "friend"
        ? i18nT("Scegli un amico già iscritto a Somto.")
        : i18nT("Crea un link per chi non è ancora su Somto.")}</span>
    </div>`;
}

function questionCountPicker() {
  return `
    <div class="quiz-field">
      <span class="quiz-field-label">${i18nT("Numero domande")}</span>
      <div class="quiz-segmented" role="group" aria-label="${i18nT("Numero domande")}">
        ${[5, 10].map((n) => `
          <button type="button" data-qcount="${n}"
            class="${composer.numQuestions === n ? "is-active" : ""}">${n} domande</button>`).join("")}
      </div>
    </div>`;
}

function friendAvatarMarkup(friend) {
  const url = friend.photoURL || friend.avatarURL;
  if (url) return `<img class="quiz-friend-avatar" src="${escapeHtml(url)}" alt="" loading="lazy">`;
  return `<span class="quiz-friend-avatar quiz-avatar-fallback is-gradient">${escapeHtml(initial(friend.displayName))}</span>`;
}

function composerFriendBody() {
  if (composer.selectedFriend) {
    const f = composer.selectedFriend;
    const canSend = composer.questionMode === "random" || !!composer.specificTitleId;
    const sourceFork = `
      <div class="quiz-field">
        <span class="quiz-field-label">${i18nT("Da dove arrivano le domande?")}</span>
        <div class="quiz-segmented" role="group" aria-label="Sorgente domande">
          <button type="button" data-qmode="random" class="${composer.questionMode === "random" ? "is-active" : ""}" aria-pressed="${composer.questionMode === "random"}">Casuale</button>
          <button type="button" data-qmode="specific" class="${composer.questionMode === "specific" ? "is-active" : ""}" aria-pressed="${composer.questionMode === "specific"}">Titolo specifico</button>
        </div>
      </div>
      ${composer.questionMode === "random"
        ? `<div class="quiz-composer-card"><span class="icon is-purple">${ICONS.shuffle}</span><div class="copy"><div class="title">${i18nT("Tema a sorpresa")}</div><div class="desc">${i18nT("Le domande arrivano a caso dall'intero archivio, uguali per entrambi.")}</div></div></div>`
        : (composer.titlePicker ? composer.titlePicker.html() : "")}`;
    return `
      <div class="quiz-composer-card">
        ${friendAvatarMarkup(f)}
        <div class="copy">
          <div class="eyebrow">${i18nT("AVVERSARIO")}</div>
          <div class="title">${escapeHtml(f.displayName || "Amico")}</div>
        </div>
        <button type="button" class="clear-btn" id="composerClearFriend" aria-label="${i18nT("Cambia avversario")}">${ICONS.close}</button>
      </div>
      ${sourceFork}
      ${questionCountPicker()}
      <div class="quiz-composer-sendbar">
        <button type="button" class="btn primary full" id="composerSendFriend" ${composer.isBusy || !canSend ? "disabled" : ""}>
          ${composer.isBusy ? "Invio…" : `${ICONS.paperplane}<span>${composer.questionMode === "specific" && !composer.specificTitleId ? i18nT("Scegli un titolo") : i18nT("Invia sfida")}</span>`}
        </button>
      </div>`;
  }
  // Friend picker
  if (!composer.friendsLoaded) {
    return loadingState(i18nT("Carico gli amici…"));
  }
  if (!composer.friends.length) {
    return emptyState({
      icon: "people",
      title: i18nT("Nessun amico su Somto"),
      message: i18nT("Puoi comunque sfidare chiunque: crea un link d'invito e giocate insieme."),
      actionLabel: i18nT("Crea un link d'invito"),
      actionId: "composerGoExternal",
    });
  }
  return `
    <div class="quiz-field">
      <span class="quiz-field-label">${i18nT("Scegli un amico")}</span>
      <div class="quiz-friend-list">
        ${composer.friends.map((f, i) => `
          <button type="button" class="quiz-friend-row" data-friend-index="${i}">
            ${friendAvatarMarkup(f)}
            <span class="quiz-friend-meta">
              <span class="quiz-friend-name">${escapeHtml(f.displayName || "Amico")}</span>
              <span class="quiz-friend-handle">@${escapeHtml(f.displayNameLower || f.uid || f.id || "")}</span>
            </span>
            <span class="chev">${ICONS.chevron}</span>
          </button>`).join("")}
      </div>
    </div>`;
}

function composerExternalBody() {
  const intro = `
    <div class="quiz-composer-card">
      <span class="icon is-gradient">${ICONS.paperplane}</span>
      <div class="copy">
        <div class="title">${i18nT("Invita chi non è su Somto")}</div>
        <div class="desc">${i18nT("Crei un link da condividere: chi lo apre si registra e gioca la sfida con te.")}</div>
      </div>
    </div>`;

  const nameField = `
    <div class="quiz-field">
      <label class="quiz-field-label" for="composerExternalName">${i18nT("Nome (facoltativo)")}</label>
      <input type="text" id="composerExternalName" placeholder="${i18nT("Es. Marco")}" value="${escapeHtml(composer.externalName)}" autocomplete="off">
      <span class="quiz-field-hint">${i18nT("Aiuta a riconoscere l'invito mentre aspetti che si registri.")}</span>
    </div>`;

  if (composer.inviteResult) {
    return `
      ${intro}
      ${nameField}
      ${questionCountPicker()}
      <div class="quiz-external-ready quiz-glow-card glow-success">
        <div class="head">
          ${ICONS.checkCircle}
          <div class="copy">
            <div class="title">${i18nT("Invito pronto!")}</div>
            <div class="desc">${i18nT("Condividilo per far partire la sfida.")}</div>
          </div>
        </div>
        <div class="quiz-invite-link">
          <input type="text" id="composerInviteLink" value="${escapeHtml(composer.inviteResult.inviteUrl)}" readonly>
        </div>
        <button type="button" class="btn primary full" id="composerShareInvite">${ICONS.share}<span>${i18nT("Condividi invito")}</span></button>
        <button type="button" class="btn ghost full" id="composerDoneInvite">${i18nT("Fatto")}</button>
      </div>`;
  }
  return `
    ${intro}
    ${nameField}
    ${questionCountPicker()}
    <button type="button" class="btn primary full" id="composerCreateExternal" ${composer.isBusy ? "disabled" : ""}>
      ${composer.isBusy ? "Creo l'invito…" : `${ICONS.link}<span>${i18nT("Crea invito")}</span>`}
    </button>`;
}

function renderComposer() {
  const body = composer.path === "friend" ? composerFriendBody() : composerExternalBody();
  const errorBox = composer.errorMessage
    ? `<div class="quiz-error-box">${ICONS.warn}<span>${escapeHtml(composer.errorMessage)}</span></div>`
    : "";
  modalRoot.innerHTML = `
    <div class="quiz-modal-backdrop" data-close></div>
    <div class="quiz-modal-sheet">
      <div class="quiz-modal-head">
        <h2>${i18nT("Nuova sfida")}</h2>
        <button type="button" class="quiz-modal-close" data-close aria-label="${i18nT("Chiudi")}">&times;</button>
      </div>
      <div class="quiz-modal-body">
        ${composerPathPicker()}
        ${body}
        ${errorBox}
      </div>
    </div>`;
  bindComposer();
}

function bindComposer() {
  modalRoot.querySelectorAll("[data-close]").forEach((n) => n.addEventListener("click", closeComposer));
  modalRoot.querySelectorAll("[data-path]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-path");
      if (next === composer.path) return;
      composer.path = next;
      composer.errorMessage = "";
      renderComposer();
    });
  });
  modalRoot.querySelectorAll("[data-qcount]").forEach((btn) => {
    btn.addEventListener("click", () => {
      composer.numQuestions = Number(btn.getAttribute("data-qcount"));
      renderComposer();
    });
  });
  modalRoot.querySelectorAll("[data-friend-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-friend-index"));
      const friend = composer.friends[idx];
      if (friend) void selectFriend(friend);
    });
  });
  document.getElementById("composerClearFriend")?.addEventListener("click", () => {
    composer.selectedFriend = null;
    composer.specificTitleId = null;
    renderComposer();
  });
  document.getElementById("composerGoExternal")?.addEventListener("click", () => {
    composer.path = "external";
    renderComposer();
  });
  document.getElementById("composerSendFriend")?.addEventListener("click", sendFriendChallenge);
  document.getElementById("composerCreateExternal")?.addEventListener("click", createExternal);
  document.getElementById("composerDoneInvite")?.addEventListener("click", closeComposer);
  document.getElementById("composerShareInvite")?.addEventListener("click", () => {
    if (composer.inviteResult) void shareInviteLink(composer.inviteResult.inviteUrl);
  });
  const nameInput = document.getElementById("composerExternalName");
  if (nameInput) {
    nameInput.addEventListener("input", () => { composer.externalName = nameInput.value; });
  }
  const linkInput = document.getElementById("composerInviteLink");
  if (linkInput) {
    linkInput.addEventListener("focus", () => linkInput.select());
  }
  // Wiring pulsanti sorgente domande (random / specifico).
  modalRoot.querySelectorAll("[data-qmode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-qmode");
      if (next === composer.questionMode) return;
      composer.questionMode = next;
      renderComposer();
    });
  });
  // Picker titolo specifico: bind dopo il render, carica dati se la modalità è attiva.
  if (composer.path === "friend" && composer.selectedFriend && composer.questionMode === "specific" && composer.titlePicker) {
    composer.titlePicker.bind(modalRoot);
    void composer.titlePicker.loadData();
  }
}

/* ===== Init ===== */

initAuthGuard({
  requireAuth: true,
  onReady: (user) => {
    if (!user) return;
    state.uid = user.uid;
    void load();
  },
});
