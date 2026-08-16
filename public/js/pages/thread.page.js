import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT, formatTimeAgo } from "../i18n/index.js";
import { ensureUserDoc, getMyUserDoc, getUserPublic, searchUsersByPrefix, listFriends } from "../api/users.api.js";
import { getTitleById, searchTitlesByPrefix } from "../api/titles.api.js";
import { listenThreadMessages, sendThreadMessage, searchGifs, getThreadDetails, addParticipantToGroup, setTyping, clearTyping, listenTyping, toggleReaction, markThreadRead } from "../api/threads.api.js";
import { listCompletedTitleIDs, markTitleCompleted } from "../api/titleStates.api.js";
import { wrapSpoiler, attachSpoilerHandlers } from "../components/spoilerGate.js";
import { mountSpoilerComposer } from "../components/composerSpoiler.js";
import { attachMentionAutocomplete, renderMentionRichText } from "../components/mentionAutocomplete.js";
import { qs, escapeHtml } from "../utils/dom.js";
import { toast } from "../components/toast.js";
import { logSignal } from "../api/signals.api.js";
import { runWithButtonLoading } from "../utils/loading.js";
import { sendReport } from "../api/reports.api.js";

const els = {
  threadHeadCard: qs("#threadHeadCard"),
  threadBackBtn: qs("#threadBackBtn"),
  threadMenuBtn: qs("#threadMenuBtn"),
  threadPlainName: qs("#threadPlainName"),
  threadTitle: qs("#threadTitle"),
  threadSub: qs("#threadSub"),
  messages: qs("#messages"),
  messagesEmpty: qs("#messagesEmpty"),
  msgText: qs("#msgText"),
  btnSend: qs("#btnSend"),
  btnGif: qs("#btnGif"),
  composerWrap: qs(".composer-wrap"),
  composer: qs(".composer"),
  authGate: qs("#authGate"),
  threadApp: qs("#threadApp"),

  threadInfo: qs("#threadInfo"),
  btnAddMember: null,
  titleLink: qs("#titleLink"),

  mentionDropdown: qs("#mentionDropdown"),

  typingIndicator: qs("#typingIndicator"),
  typingText: qs("#typingText"),

  episodeSpoilerGate: qs("#episodeSpoilerGate"),
  episodeSpoilerGateText: qs("#episodeSpoilerGateText"),
  episodeSpoilerGateBack: qs("#episodeSpoilerGateBack"),
  episodeSpoilerGateEnter: qs("#episodeSpoilerGateEnter"),
};

const params = new URLSearchParams(location.search);
const tid = params.get("tid") || params.get("id");

let currentUser = null;
let myUserDoc = null;
let thread = null;
let unsubMessages = null;
let unsubTyping = null;

// Cleanup pool: unsub di onSnapshot al pagehide (anche oltre il beforeunload
// che gestisce solo il typing).
const _unsubs = [];
function trackUnsub(u) { if (typeof u === "function") _unsubs.push(u); return u; }
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    while (_unsubs.length) { try { _unsubs.pop()(); } catch {} }
  });
}
let isChatMode = false;
let lastMsgCount = 0;
let infoExpanded = false;

// True per thread pubblici scoped a un episodio (vedi getEpisodeScope più sotto):
// questi thread usano l'entry warning invece del blur per-messaggio.
let isEpisodeThread = false;
// Nome serie risolto in loadHeaderAndInfo (da titles/{titleId}), usato nella
// copy dell'entry warning episodio.
let resolvedThreadTitleName = "";

// Anti-spoiler: cache locale dei titoli completati dal viewer + controller del
// composer (montato lazy on demand). Refresha al caricamento e dopo che
// l'utente preme "Ho visto X" sul blur (markTitleCompleted).
let viewerCompletedTitleIDs = new Set();
let spoilerComposerCtrl = null;
const titleNameCache = new Map();

// ── Episode-scoped public thread detection ──
//
// Gli episode thread pubblici hanno id `public_{titleId}_s{s}e{e}` e
// `contextId` nella forma "s{n}e{m}" (vedi threads.api.js#threadIdForPublicEpisode
// / #ensurePublicThread). Per questi thread si usa un ENTRY WARNING una-tantum
// invece del blur per-messaggio (il gate adattivo `spoilerGate.js` resta
// invariato per thread title-level pubblici, DM e gruppi).
const EPISODE_CONTEXT_ID_RE = /^s(\d+)e(\d+)$/i;

function getEpisodeScope(th) {
  if (!th || th.visibility !== "public" || th.contextType !== "public") return null;
  const m = EPISODE_CONTEXT_ID_RE.exec(String(th.contextId || ""));
  if (!m) return null;
  const season = Number(m[1]);
  const episode = Number(m[2]);
  if (!Number.isFinite(season) || !Number.isFinite(episode) || season <= 0 || episode <= 0) return null;
  return { season, episode };
}

// Flag "già entrato in questa discussione episodio" per la sessione corrente
// (sessionStorage: non deve infastidire durante lo stesso open/scroll, ma
// ripropone l'avviso alla prossima visita/tab — nessun backend coinvolto).
function episodeGateSessionKey(threadId) {
  return `somto_thread_episode_gate_seen__${threadId}`;
}

function hasSeenEpisodeGate(threadId) {
  try {
    return sessionStorage.getItem(episodeGateSessionKey(threadId)) === "1";
  } catch (_) {
    return false;
  }
}

function markEpisodeGateSeen(threadId) {
  try {
    sessionStorage.setItem(episodeGateSessionKey(threadId), "1");
  } catch (_) { /* ignore (private mode / quota) */ }
}

async function refreshViewerCompletedTitleIDs() {
  if (!currentUser?.uid) return;
  viewerCompletedTitleIDs = await listCompletedTitleIDs(currentUser.uid);
}

function spoilerStateForMessage(msg) {
  return {
    containsSpoiler: msg?.containsSpoiler === true,
    spoilerTitleIds: Array.isArray(msg?.spoilerTitleIds) ? msg.spoilerTitleIds : [],
  };
}

// For restricted threads (dm / group)
let allowedUsers = [];

// Picker menzioni: la logica sta in `components/mentionAutocomplete.js`, qui
// resta solo il controller montato sul composer.
let mentionCtrl = null;

// Typing debounce
let typingTimer = null;
let isTyping = false;

// Notification sound (lazy-loaded)
let notifSound = null;

function getNotifSound() {
  if (notifSound) return notifSound;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    notifSound = { ctx };
    return notifSound;
  } catch { return null; }
}

function playNotifBeep() {
  const s = getNotifSound();
  if (!s) return;
  try {
    const osc = s.ctx.createOscillator();
    const gain = s.ctx.createGain();
    osc.connect(gain);
    gain.connect(s.ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, s.ctx.currentTime);
    gain.gain.setValueAtTime(0.15, s.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, s.ctx.currentTime + 0.3);
    osc.start(s.ctx.currentTime);
    osc.stop(s.ctx.currentTime + 0.3);
  } catch { /* ignore */ }
}

// ── Reactions ──

const REACTION_EMOJIS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F62E}", "\u{1F92F}"];

function renderReactions(msgId, reactions) {
  if (!reactions) reactions = {};
  const myUid = currentUser?.uid;

  const pills = REACTION_EMOJIS
    .filter(emoji => reactions[emoji]?.length > 0)
    .map(emoji => {
      const uids = reactions[emoji] || [];
      const isMine = myUid && uids.includes(myUid);
      return `<button class="reaction-pill${isMine ? " mine" : ""}" data-msg="${escapeHtml(msgId)}" data-emoji="${emoji}">${emoji} <span class="reaction-count">${uids.length}</span></button>`;
    });

  const addBtn = `<button class="reaction-add-btn" data-msg="${escapeHtml(msgId)}">+</button>`;

  return `<div class="reactions-row">${pills.join("")}${addBtn}</div>`;
}

function renderReactionPicker(msgId) {
  const items = REACTION_EMOJIS.map(emoji =>
    `<button class="reaction-picker-item" data-msg="${escapeHtml(msgId)}" data-emoji="${emoji}">${emoji}</button>`
  ).join("");
  return `<div class="reaction-picker" data-msg="${escapeHtml(msgId)}">${items}</div>`;
}

function bindReactionEvents() {
  if (!els.messages) return;

  // Toggle existing reaction pill
  els.messages.querySelectorAll(".reaction-pill").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!currentUser || !thread) return;
      const msgId = btn.getAttribute("data-msg");
      const emoji = btn.getAttribute("data-emoji");
      await runWithButtonLoading(btn, async () => {
        try {
          await toggleReaction(thread.id, msgId, emoji, currentUser.uid);
        } catch (err) {
          console.error("[reactions] toggle error", err);
          toast(i18nT("Reazione non salvata. Riprova."), i18nT("Errore"), { type: "error" });
        }
      }, { loadingLabel: "…" });
    });
  });

  // Open picker
  els.messages.querySelectorAll(".reaction-add-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const msgId = btn.getAttribute("data-msg");
      // Close any open pickers first
      els.messages.querySelectorAll(".reaction-picker.open").forEach(p => p.classList.remove("open"));
      const picker = els.messages.querySelector(`.reaction-picker[data-msg="${msgId}"]`);
      if (picker) picker.classList.toggle("open");
    });
  });

  // Pick emoji from picker
  els.messages.querySelectorAll(".reaction-picker-item").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!currentUser || !thread) return;
      const msgId = btn.getAttribute("data-msg");
      const emoji = btn.getAttribute("data-emoji");
      const picker = btn.closest(".reaction-picker");
      await runWithButtonLoading(btn, async () => {
        try {
          await toggleReaction(thread.id, msgId, emoji, currentUser.uid);
          if (picker) picker.classList.remove("open");
        } catch (err) {
          console.error("[reactions] picker toggle error", err);
          toast(i18nT("Reazione non salvata. Riprova."), i18nT("Errore"), { type: "error" });
        }
      }, { loadingLabel: "…" });
    });
  });
}

// Close reaction pickers when clicking outside
document.addEventListener("click", () => {
  document.querySelectorAll(".reaction-picker.open").forEach(p => p.classList.remove("open"));
});

// ── Navigation: back ──
// Usato dal bottone back del header slim e da "Torna indietro" nel gate spoiler.
// Preferisce la history (torna a threads.html/title.html da cui si è arrivati);
// fallback all'elenco thread se non c'è history utile (deep link diretto).
function goBack() {
  if (window.history.length > 1 && document.referrer) {
    window.history.back();
  } else {
    window.location.href = "/threads.html";
  }
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function initials(name) {
  const n = String(name || "").trim();
  if (!n) return "?";
  const parts = n.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] || "");
  return (a + b).toUpperCase();
}

// Profili guidati (synthetic / AI-assisted): non ricevono DM personali.
function isGuidedProfile(userDoc) {
  if (!userDoc || typeof userDoc !== "object") return false;
  return userDoc.accountType === "guided_profile" || userDoc.isSynthetic === true;
}

// In una DM con un profilo guidato: banner sopra il composer + input disabilitato.
function applyGuidedDmNotice() {
  if (!els.composerWrap || els.composerWrap.querySelector(".guided-dm-notice")) return;

  const notice = document.createElement("div");
  notice.className = "guided-dm-notice";
  notice.setAttribute("role", "note");
  notice.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
    <span>${i18nT("Questo è un profilo guidato da Somto e non riceve messaggi personali.")}</span>
  `;
  // Inserisci sopra il composer (dopo il mention dropdown).
  els.composerWrap.insertBefore(notice, els.composer || null);

  if (els.composer) els.composer.style.display = "none";
  if (els.msgText) {
    els.msgText.disabled = true;
    els.msgText.value = "";
  }
  if (els.btnSend) els.btnSend.disabled = true;
}

async function applyGuidedDmNoticeIfNeeded() {
  if (!thread || thread.contextType !== "dm") return;
  const otherUids = (thread.participants || []).filter((u) => u && u !== currentUser?.uid);
  if (!otherUids.length) return;

  const docs = await Promise.all(otherUids.map((u) => getUserPublic(u).catch(() => null)));
  if (docs.some((u) => isGuidedProfile(u))) {
    applyGuidedDmNotice();
  }
}

function isSupportThreadData(value = thread) {
  return value?.contextType === "group"
    && String(value?.contextId || "").startsWith("support_");
}

// ── Relative time formatting ──

function timeAgo(date) {
  return formatTimeAgo(date);
}

// ── Mention helpers ──

async function ensureAllowedUsers() {
  allowedUsers = [];
  if (!thread) return;
  if (thread.visibility === "public") return;

  const uids = Array.from(new Set([...(thread.participants || [])]));
  const docs = await Promise.all(
    uids.map((u) => getUserPublic(u).catch(() => null))
  );
  allowedUsers = docs
    .filter(Boolean)
    .map((u) => ({
      uid: u.uid,
      displayName: u.displayName || u.uid,
      displayNameLower: u.displayNameLower || normalize(u.displayName || u.uid),
    }));
}

// La ricerca resta locale al thread: in un thread privato si puo' taggare solo
// chi partecipa, che nessun'altra superficie deve sapere.
async function searchMention(type, query) {
  const q = normalize(query);
  if (!q) return [];

  if (type !== "user") {
    const rows = await searchTitlesByPrefix(q, 7).catch(() => []);
    return rows.map((t) => ({ id: t.id, label: t.name || i18nT("(senza titolo)"), kind: "title" }));
  }

  if (thread?.visibility === "public") {
    const rows = await searchUsersByPrefix(q, { max: 7 }).catch(() => []);
    return rows
      .filter((u) => u?.uid)
      .map((u) => ({ id: u.uid, label: u.displayName || u.uid, kind: "user" }));
  }

  return allowedUsers
    .filter((u) => u.displayNameLower.includes(q))
    .slice(0, 7)
    .map((u) => ({ id: u.uid, label: u.displayName, kind: "user" }));
}

// ── Message rendering ──

// URL nudi + `@{Nome}(uid)` + `#[Nome](id)` → link. Implementazione condivisa
// con Community e scheda titolo in `components/mentionAutocomplete.js`.
function renderMessageText(rawText) {
  return renderMentionRichText(rawText);
}

// Messaggi voto+recensione (sincronizzati da un voto): il testo inizia con
// "N/10 — …". Vengono resi come card: persona cliccabile (avatar+nome → profilo)
// + numero voto stiloso (senza "/10") + la recensione, invece di una bolla grezza
// "9,5/10 — …".
// Il voto non è sempre un numero puro: `formatMaskedRating` lo scrive a quarti
// di punto con dei modificatori, quindi esistono messaggi reali che iniziano
// con "8½/10", "7+/10", "9-/10". Senza `[+½-]` non venivano riconosciuti e il
// "/10" grezzo finiva a schermo dentro il testo.
// Il gruppo 2 cattura l'eventuale "· con Anna, Marco" che precede il commento.
// Il gruppo 2 è greedy di proposito: la classe esclude già i trattini lunghi,
// quindi si ferma da sola davanti al testo. Con il quantificatore pigro
// catturava una sola lettera ("c" invece di "con Jerusalemme").
const RATING_PREFIX_RE = /^\s*(\d{1,2}(?:[.,]\d+)?[+½-]?)\s*\/\s*10\b\s*(?:·\s*([^—–\n]{1,160}))?\s*[—–:.\-]*\s*/;

// Guardia client per gli URL delle GIF: renderizza SOLO https su host giphy.com
// (specchio di `validGifUrl` nelle firestore.rules — il proxy `gifSearch` serve
// solo questi). Blocca URL arbitrari finiti nel doc per qualunque via.
function isValidGifUrl(url) {
  if (typeof url !== "string") return false;
  const u = url.trim();
  return u.startsWith("https://") && u.includes("giphy.com");
}

function renderMessage(msg) {
  const mine = msg.uid === currentUser?.uid;
  const cls = mine ? "msg me" : "msg";
  const ts = msg.createdAt?.toDate ? msg.createdAt.toDate() : null;
  const time = timeAgo(ts);
  // Solo il rendering passa da i18n: il "Anonimo" scritto sul doc del messaggio
  // resta il valore salvato, non lo si traduce a posteriori.
  const name = escapeHtml(msg.displayName || i18nT("Anonimo"));
  const profileHref = msg.uid ? `/user.html?uid=${encodeURIComponent(msg.uid)}` : null;

  const reactionsHtml = renderReactions(msg.id, msg.reactions);
  const pickerHtml = renderReactionPicker(msg.id);
  const senderHtml = `<div class="sender-name">${name}</div>`;

  // Gate anti-spoiler condiviso (tranne nei thread per-episodio, gated all'ingresso).
  const gate = (html) => {
    if (isEpisodeThread) return html;
    const spoilerInfo = spoilerStateForMessage(msg);
    const titleNamesMap = Object.fromEntries(titleNameCache);
    return wrapSpoiler(html, spoilerInfo, viewerCompletedTitleIDs, titleNamesMap);
  };

  // Messaggio GIF: locandina animata DENTRO il gate anti-spoiler (una GIF
  // flaggata resta blur come i testi) + eventuale didascalia. Renderizza solo
  // se l'URL è valido; le reazioni continuano a funzionare come sui testi.
  if (msg.type === "gif" && isValidGifUrl(msg.gifUrl)) {
    const captionText = (msg.text || "").trim();
    const captionHtml = captionText
      ? `<div class="msg-gif-caption">${renderMessageText(captionText)}</div>`
      : "";
    const gifHtml = `<img class="msg-gif" src="${escapeHtml(msg.gifUrl.trim())}" loading="lazy" alt="${i18nT("GIF")}">${captionHtml}`;
    return `
      <div class="${cls}">
        ${senderHtml}
        ${gate(gifHtml)}
        <div class="meta">${time}</div>
        ${reactionsHtml}
        ${pickerHtml}
      </div>
    `;
  }

  const ratingMatch = (msg.text || "").match(RATING_PREFIX_RE);
  if (ratingMatch) {
    const score = escapeHtml(ratingMatch[1]);
    const people = String(ratingMatch[2] || "").trim();
    const reviewText = String(msg.text).slice(ratingMatch[0].length).trim();
    const avatarHtml = `<span class="msg-person-avatar">${escapeHtml(initials(msg.displayName || "?"))}</span>`;
    const personInner = `${avatarHtml}<span class="msg-person-name">${name}</span>`;
    const person = profileHref
      ? `<a class="msg-person" href="${profileHref}">${personInner}</a>`
      : `<div class="msg-person">${personInner}</div>`;
    // Voto DENTRO la bolla, in basso a destra (assoluto). Il testo è gated
    // per lo spoiler; il numero resta sempre visibile (non è uno spoiler).
    const textHtml = reviewText
      ? gate(`<div class="msg-rating-text">${renderMessageText(reviewText)}</div>`)
      : "";
    const scoreHtml = `<span class="msg-rating-score" aria-label="Voto ${score} su 10">${score}</span>`;
    return `
      <div class="${cls} msg-rating">
        <div class="msg-rating-head">${person}${
          people ? `<span class="msg-rating-people">${escapeHtml(people)}</span>` : ""
        }</div>
        <div class="bubble msg-rating-bubble">${textHtml}${scoreHtml}</div>
        <div class="meta">${time}</div>
        ${reactionsHtml}
        ${pickerHtml}
      </div>
    `;
  }

  const gatedBubble = gate(`<div class="bubble">${renderMessageText(msg.text)}</div>`);
  return `
    <div class="${cls}">
      ${senderHtml}
      ${gatedBubble}
      <div class="meta">${time}</div>
      ${reactionsHtml}
      ${pickerHtml}
    </div>
  `;
}

// ── Auto-scroll helper ──

function isNearPageBottom() {
  const scrollEl = document.scrollingElement || document.documentElement;
  return (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) < 220;
}

function scrollToBottom(force) {
  // The whole page scrolls (composer is sticky), mirror iOS ScrollViewReader.
  if (force || isNearPageBottom()) {
    requestAnimationFrame(() => {
      const scrollEl = document.scrollingElement || document.documentElement;
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  }
}

// ── Empty state ──

function updateEmptyState(msgCount) {
  if (!els.messagesEmpty) return;
  if (msgCount === 0) {
    els.messagesEmpty.style.display = "flex";
    if (els.messages) els.messages.style.display = "none";
  } else {
    els.messagesEmpty.style.display = "none";
    if (els.messages) els.messages.style.display = "flex";
  }
}

// ── Typing indicator ──

function handleTypingInput() {
  if (!thread || !currentUser) return;

  if (!isTyping) {
    isTyping = true;
    setTyping(thread.id, currentUser.uid, myUserDoc?.displayName || currentUser.displayName || "Qualcuno").catch(() => {});
  }

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isTyping = false;
    clearTyping(thread.id, currentUser.uid).catch(() => {});
  }, 3000);
}

function showTypingIndicator(typers) {
  if (!els.typingIndicator || !els.typingText) return;
  if (!typers.length) {
    els.typingIndicator.classList.remove("visible");
    return;
  }

  const names = typers.map(t => t.displayName).slice(0, 3);
  let text;
  if (names.length === 1) {
    text = i18nT("{v0} sta scrivendo…", { v0: names[0] });
  } else if (names.length === 2) {
    text = `${names[0]} e ${names[1]} stanno scrivendo…`;
  } else {
    text = `${names[0]} e altri stanno scrivendo…`;
  }

  els.typingText.textContent = text;
  els.typingIndicator.classList.add("visible");
}

// ── Header & info ──

async function loadHeaderAndInfo() {
  if (!thread) return;
  if (els.threadHeadCard) els.threadHeadCard.style.display = "flex";

  let title = null;
  if (thread.titleId) {
    title = await getTitleById(thread.titleId).catch(() => null);
  }
  resolvedThreadTitleName = title?.name || thread.titleName || "";

  const isPublic = thread.visibility === "public";
  const episodeScope = getEpisodeScope(thread);
  isEpisodeThread = !!episodeScope;

  // Title link row vs plain name — compact: nome (linea propria) su una riga,
  // poi tipo/anno + (per episodio) "S{n}·E{m}" su una seconda riga separata
  // (mai concatenati nello stesso nodo testo, cfr. bug "NomeSerie TV • anno").
  if (title && thread.titleId) {
    if (els.titleLink) {
      els.titleLink.href = `/title.html?id=${encodeURIComponent(thread.titleId)}`;
      els.titleLink.style.display = "flex";
    }
    if (els.threadPlainName) els.threadPlainName.style.display = "none";
    if (els.threadTitle) els.threadTitle.textContent = title.name || i18nT("(senza titolo)");
    if (els.threadSub) {
      const typeLabel = title.type === "tv" ? i18nT("Serie TV") : i18nT("Film");
      const yearLabel = title.year ? String(title.year) : "";
      const episodeLabel = episodeScope ? `S${episodeScope.season}·E${episodeScope.episode}` : "";
      const subText = [typeLabel, yearLabel, episodeLabel].filter(Boolean).join(" • ");
      els.threadSub.textContent = subText;
      els.threadSub.style.display = subText ? "block" : "none";
    }
  } else {
    if (els.titleLink) els.titleLink.style.display = "none";
    if (els.threadPlainName) {
      els.threadPlainName.style.display = "block";
      const otherUids = (thread.participants || []).filter(uid => uid && uid !== currentUser?.uid);
      let label = thread.contextType === "group" && thread.groupName ? thread.groupName : i18nT("Discussione");
      if (otherUids.length && !(thread.contextType === "group" && thread.groupName)) {
        const names = (await Promise.all(otherUids.map(u => getUserPublic(u).catch(() => null))))
          .filter(Boolean).map(u => u.displayName || u.uid);
        if (names.length) label = names.join(", ");
      }
      els.threadPlainName.textContent = label;
    }
  }

  // Chat mode for DM/group
  isChatMode = !isPublic;
  if (els.messages) els.messages.classList.toggle("chat-mode", isChatMode);

  // Info box (group & DM) — collapsed, opened via menu
  if (!els.threadInfo) return;

  const isPrivate = thread.contextType === "group" || thread.contextType === "dm";

  if (isPrivate) {
    const participants = thread.participants || [];

    const docs = await Promise.all(participants.map(u => getUserPublic(u).catch(() => null)));
    const chips = docs.filter(Boolean).map(u => {
      const nm = u.displayName || u.uid;
      const photo = u.photoURL;
      const avatarInner = photo
        ? `<img src="${escapeHtml(photo)}" alt="" loading="lazy" decoding="async" />`
        : escapeHtml(initials(nm));
      return `
        <span class="participant-chip">
          <span class="participant-avatar">${avatarInner}</span>
          <span>${escapeHtml(nm)}</span>
        </span>
      `;
    }).join("");

    const isGroup = thread.contextType === "group";
    const isSupportThread = isGroup && String(thread.contextId || "").startsWith("support_");
    const infoLabel = isGroup ? "Partecipanti" : i18nT("Conversazione con");
    const hintText = isGroup
      ? i18nT("Solo i partecipanti possono vedere questo thread.")
      : i18nT("Solo voi due potete vedere questo thread.");

    els.threadInfo.style.display = infoExpanded ? "block" : "none";
    els.threadInfo.innerHTML = `
      <div class="group-info-header">
        <div>
          <div class="group-info-label">${infoLabel}</div>
          <div class="hint" style="margin-top:4px;">${hintText}</div>
        </div>
        ${isGroup && !isSupportThread ? '<button id="btnAddMember" class="btn ghost small" type="button">Aggiungi</button>' : ''}
      </div>
      <div class="group-participants">${chips || '<span class="hint">Nessuno</span>'}</div>
    `;

    if (isGroup && !isSupportThread) {
      els.btnAddMember = qs("#btnAddMember");
      if (els.btnAddMember) {
        els.btnAddMember.style.display = (participants.includes(currentUser?.uid)) ? "inline-flex" : "none";
        els.btnAddMember.addEventListener("click", openAddMemberModal);
      }
    }
  } else {
    els.threadInfo.style.display = "none";
  }

  setupThreadMenu(isPrivate);
}

/**
 * Avviso una riga sopra il composer: quello che scrivi in una discussione
 * pubblica compare anche nel feed Community (post-eco, vedi
 * functions/lib/commentEcho.js). Solo per i thread pubblici: DM e gruppi
 * restano privati e non generano nulla.
 */
function mountPublicThreadFeedNotice() {
  if (!thread || thread.visibility !== "public") return;
  if (!els.composerWrap || !els.composer) return;
  if (document.getElementById("threadFeedNotice")) return;

  const notice = document.createElement("div");
  notice.id = "threadFeedNotice";
  notice.className = "composer-feed-notice";
  notice.textContent = i18nT("Quello che scrivi qui compare anche nel feed Community.");
  els.composerWrap.insertBefore(notice, els.composer);
}

// ── Episode spoiler entry gate ──
//
// Per i thread pubblici scoped a un episodio (isEpisodeThread), mostra un
// interstitial una-tantum per apertura ("per-thread-open", flag in
// sessionStorage) invece del blur per-messaggio. Se l'utente conferma
// ("Entra") i messaggi si vedono normalmente per tutta la sessione della tab;
// "Torna indietro" riporta alla pagina precedente senza entrare.
//
// Ritorna una Promise che risolve (nessun valore) quando si può procedere a
// mostrare l'app: subito se il gate non serve (thread non-episodio, o gate
// già superato in questa sessione), oppure quando l'utente preme "Entra". Se
// preme "Torna indietro" la promise non risolve mai — la pagina naviga via.
function showEpisodeSpoilerGateIfNeeded() {
  if (!isEpisodeThread || !thread) return Promise.resolve();
  if (hasSeenEpisodeGate(thread.id)) return Promise.resolve();

  const episodeScope = getEpisodeScope(thread);
  const seriesName = resolvedThreadTitleName || i18nT("questa serie");

  return new Promise((resolve) => {
    if (!els.episodeSpoilerGate) { resolve(); return; }

    if (els.episodeSpoilerGateText) {
      els.episodeSpoilerGateText.textContent = episodeScope
        ? i18nT("Questa discussione può contenere spoiler di {seriesName} fino a S{season}·E{episode}. Vuoi procedere?", { seriesName, season: episodeScope.season, episode: episodeScope.episode })
        : i18nT("Questa discussione può contenere spoiler di {seriesName}. Vuoi procedere?", { seriesName });
    }

    els.episodeSpoilerGate.style.display = "flex";
    if (els.threadApp) els.threadApp.style.display = "none";

    const onEnter = () => {
      markEpisodeGateSeen(thread.id);
      els.episodeSpoilerGate.style.display = "none";
      cleanup();
      resolve();
    };
    const onBack = () => {
      cleanup();
      goBack();
    };
    function cleanup() {
      els.episodeSpoilerGateEnter?.removeEventListener("click", onEnter);
      els.episodeSpoilerGateBack?.removeEventListener("click", onBack);
    }

    els.episodeSpoilerGateEnter?.addEventListener("click", onEnter);
    els.episodeSpoilerGateBack?.addEventListener("click", onBack);
  });
}

// ── Header menu (mirror: ThreadDetailView Menu) ──

let threadMenuPop = null;

function closeThreadMenu() {
  if (threadMenuPop) {
    threadMenuPop.remove();
    threadMenuPop = null;
  }
}

function setupThreadMenu(isPrivate) {
  if (!els.threadMenuBtn) return;
  els.threadMenuBtn.onclick = (ev) => {
    ev.stopPropagation();
    if (threadMenuPop) { closeThreadMenu(); return; }

    const items = [];
    if (isPrivate) {
      items.push({
        label: infoExpanded ? i18nT("Nascondi partecipanti") : i18nT("Mostra partecipanti"),
        icon: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>`,
        onClick: () => {
          infoExpanded = !infoExpanded;
          if (els.threadInfo) els.threadInfo.style.display = infoExpanded ? "block" : "none";
        },
      });
    }
    if (thread?.titleId) {
      items.push({
        label: i18nT("Vai al titolo"),
        icon: `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="3"/>`,
        onClick: () => { window.location.href = `/title.html?id=${encodeURIComponent(thread.titleId)}`; },
      });
    }
    items.push({
      label: i18nT("Segnala discussione"),
      danger: true,
      icon: `<path d="M4 21V4m0 0h12l-2 4 2 4H4"/>`,
      onClick: async () => {
        const reason = prompt(i18nT("Motivo della segnalazione:"))?.trim();
        if (!reason || !currentUser || !tid) return;
        try {
          await sendReport({ type: "thread", targetId: tid, reason, fromUid: currentUser.uid });
          toast(i18nT("Segnalazione inviata. Grazie."), i18nT("Sicurezza"));
        } catch (err) { toast(err?.message || i18nT("Segnalazione non riuscita"), "Sicurezza"); }
      },
    });
    items.push({
      label: i18nT("Tutti i thread"),
      icon: `<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>`,
      onClick: () => { window.location.href = "/threads.html"; },
    });

    const pop = document.createElement("div");
    pop.className = "thread-menu-pop";
    pop.innerHTML = items.map((it, i) => `
      <button type="button" data-menu-idx="${i}"${it.danger ? ' class="is-danger"' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.icon}</svg>
        <span>${escapeHtml(it.label)}</span>
      </button>
    `).join("");

    document.body.appendChild(pop);
    threadMenuPop = pop;

    const rect = els.threadMenuBtn.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = rect.right - pr.width;
    left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
    let top = rect.bottom + 6;
    if (top + pr.height > window.innerHeight - 8) top = rect.top - pr.height - 6;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    pop.querySelectorAll("[data-menu-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-menu-idx"));
        closeThreadMenu();
        items[idx]?.onClick?.();
      });
    });
  };
}

document.addEventListener("click", (e) => {
  if (threadMenuPop && !threadMenuPop.contains(e.target) && e.target !== els.threadMenuBtn) {
    closeThreadMenu();
  }
});

async function openAddMemberModal() {
  if (!thread || !currentUser) return;
  if (thread.contextType !== "group") return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>${i18nT("Aggiungi un amico")}</h3>
        <button class="btn btn-ghost btn-sm" id="closeModal" type="button">${i18nT("Chiudi")}</button>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">
        <input class="input" id="friendQ" placeholder="${i18nT("Cerca tra i tuoi amici")}" autocomplete="off" />
        <button class="btn btn-ghost btn-sm" id="refresh" type="button">Aggiorna</button>
      </div>
      <div class="add-member-list" id="list"></div>
    </div>
  `;

  const close = () => overlay.remove();
  overlay.querySelector("#closeModal")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);

  const listEl = overlay.querySelector("#list");
  const qEl = overlay.querySelector("#friendQ");

  const friends = await listFriends(currentUser.uid).catch(() => []);

  function render(rows) {
    const already = new Set(thread.participants || []);
    const cand = rows.filter(r => r?.uid && !already.has(r.uid));
    if (!cand.length) {
      listEl.innerHTML = `<div class="hint">${i18nT("Nessun amico aggiungibile.")}</div>`;
      return;
    }

    listEl.innerHTML = cand.map(u => {
      const nm = u.displayName || u.uid;
      return `
        <div class="add-member-row">
          <span class="participant-avatar">${escapeHtml(initials(nm))}</span>
          <span class="name">${escapeHtml(nm)}</span>
          <button class="btn btn-primary btn-sm" data-uid="${escapeHtml(u.uid)}" type="button">${i18nT("Aggiungi")}</button>
        </div>
      `;
    }).join("");

    listEl.querySelectorAll("button[data-uid]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const uid = btn.getAttribute("data-uid");
        try {
          btn.disabled = true;
          await addParticipantToGroup(thread.id, uid);
          toast("Aggiunto al gruppo", "Ok");
          close();
          thread = await getThreadDetails(thread.id).catch(() => thread);
          await ensureAllowedUsers();
          await loadHeaderAndInfo();
        } catch (err) {
          console.error(err);
          toast(err?.message || i18nT("Non sono riuscito ad aggiungere"), "Ops");
          btn.disabled = false;
        }
      });
    });
  }

  function applyFilter() {
    const q = normalize(qEl.value);
    if (!q) return render(friends);
    return render(friends.filter(f => normalize(f.displayName || f.uid).includes(q)));
  }

  qEl.addEventListener("input", applyFilter);
  overlay.querySelector("#refresh")?.addEventListener("click", () => applyFilter());

  render(friends);
}

// ── Skeleton loading ──

function showMessagesSkeleton() {
  if (!els.messages) return;
  els.messages.style.display = "flex";
  els.messages.innerHTML = `
    <div class="skeleton-msg"><div class="skeleton-bubble"></div><div class="skeleton-meta"></div></div>
    <div class="skeleton-msg right"><div class="skeleton-bubble"></div><div class="skeleton-meta"></div></div>
    <div class="skeleton-msg"><div class="skeleton-bubble"></div><div class="skeleton-meta"></div></div>
    <div class="skeleton-msg right"><div class="skeleton-bubble"></div><div class="skeleton-meta"></div></div>
  `;
}

let skeletonShown = true;

// ── Messages subscription ──

async function subscribeMessages() {
  if (!thread) return;

  if (unsubMessages) {
    try { unsubMessages(); } catch (_) {}
    unsubMessages = null;
  }

  unsubMessages = trackUnsub(listenThreadMessages(thread.id, {
    max: 500,
    onChange: (msgs) => {
      if (!els.messages) return;
      skeletonShown = false;

      const isNew = msgs.length > lastMsgCount && lastMsgCount > 0;
      const wasAtBottom = isNearPageBottom();

      els.messages.innerHTML = msgs.map(renderMessage).join("");
      bindReactionEvents();
      attachSpoilerHandlers(els.messages, {
        onMarkSeen: async (titleID) => {
          // Determina mediaType dal titolo del thread (best-effort).
          let mediaType = "movie";
          try {
            const t = await getTitleById(titleID);
            if (t && (t.type === "tv" || t.mediaType === "tv")) mediaType = "tv";
          } catch {}
          await markTitleCompleted(titleID, mediaType);
          viewerCompletedTitleIDs.add(titleID);
        },
      });
      updateEmptyState(msgs.length);

      // Auto-scroll: always on first load, or if near bottom
      if (lastMsgCount === 0 || wasAtBottom) {
        scrollToBottom(true);
      }

      // Notification sound if tab not focused and new messages arrived
      if (isNew && document.hidden) {
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg?.uid !== currentUser?.uid) {
          playNotifBeep();
        }
      }

      // Update read timestamp on each message batch
      markThreadRead(thread.id);

      lastMsgCount = msgs.length;
    }
  }));
}

// ── Typing subscription ──

function subscribeTyping() {
  if (!thread || !currentUser) return;

  if (unsubTyping) {
    try { unsubTyping(); } catch (_) {}
    unsubTyping = null;
  }

  unsubTyping = trackUnsub(listenTyping(thread.id, currentUser.uid, showTypingIndicator));
}

// ── Auto-resize textarea ──

function autoResizeTextarea() {
  if (!els.msgText) return;
  els.msgText.style.height = "auto";
  els.msgText.style.height = Math.min(els.msgText.scrollHeight, 140) + "px";
}

// ── Boot ──

async function bootSignedIn(user) {
  currentUser = user;
  await ensureUserDoc(user).catch(() => {});
  myUserDoc = await getMyUserDoc(user.uid).catch(() => null);

  if (!tid) {
    toast(i18nT("Thread non valido"), "Ops");
    return;
  }

  thread = await getThreadDetails(tid).catch(() => null);
  if (!thread) {
    toast(i18nT("Thread non trovato."), "Ops");
    return;
  }

  await ensureAllowedUsers();
  await loadHeaderAndInfo();

  els.authGate && (els.authGate.style.display = "none");

  // Episode-scoped public thread: mostra l'entry warning (una volta per
  // apertura) e attendi la conferma prima di rendere l'app dei messaggi.
  // Se l'utente sceglie "Torna indietro" la pagina naviga via e questa
  // promise non risolve mai (bootSignedIn resta semplicemente sospesa).
  await showEpisodeSpoilerGateIfNeeded();

  // DM con profilo guidato: blocca il composer e mostra l'avviso.
  await applyGuidedDmNoticeIfNeeded().catch(() => {});

  // Mark thread as read on entering
  markThreadRead(thread.id);

  // NB: .thread-app is `display:flex; flex-direction:column` in CSS (full-height
  // shell: #messages flex-grows + scrolls, composer pinned last) — must stay
  // "flex" here, not "block", or the composer collapses back into normal flow
  // and floats mid-page instead of pinning to the bottom.
  els.threadApp && (els.threadApp.style.display = "flex");

  // Discussione pubblica: da quando i commenti diventano card nel feed
  // Community (functions/lib/commentEcho.js), chi scrive qui deve saperlo
  // PRIMA di scrivere — il thread non è più una stanza separata.
  mountPublicThreadFeedNotice();

  // Anti-spoiler: cache iniziale completati + mount composer toggle SOPRA la riga
  // input (in .composer-wrap, prima di .composer). Montarlo dentro .composer — la
  // riga flex textarea+invia — schiacciava la larghezza del textarea.
  refreshViewerCompletedTitleIDs().catch(() => {});
  try {
    const sendBtn = els.btnSend;
    if (sendBtn && !sendBtn.__spoilerMounted && !isSupportThreadData()) {
      const composerHost = document.createElement("div");
      composerHost.id = "threadSpoilerComposer";
      if (els.composerWrap && els.composer) {
        els.composerWrap.insertBefore(composerHost, els.composer);
      } else {
        sendBtn.parentElement?.insertBefore(composerHost, sendBtn);
      }
      const candidates = thread.titleId
        ? [{ id: thread.titleId, name: thread.titleName || thread.titleId }]
        : [];
      if (thread.titleId && thread.titleName) {
        titleNameCache.set(thread.titleId, thread.titleName);
      }
      spoilerComposerCtrl = mountSpoilerComposer(composerHost, { candidateTitles: candidates });
      sendBtn.__spoilerMounted = true;
    }
  } catch (err) {
    console.warn("[thread] failed to mount spoiler composer", err);
  }

  // Show skeleton while messages load
  showMessagesSkeleton();

  await subscribeMessages();
  subscribeTyping();

  // Composer events
  els.btnSend?.addEventListener("click", onSend);

  mentionCtrl = attachMentionAutocomplete(els.msgText, els.mentionDropdown, {
    searchTargets: searchMention,
    onInsert: autoResizeTextarea,
    onEnterSubmit: onSend,
  });

  els.msgText?.addEventListener("input", () => {
    autoResizeTextarea();
    handleTypingInput();
  });
}

async function onSend() {
  if (!thread || !currentUser) return;
  const rawText = (els.msgText?.value || "").trim();
  if (!rawText) return;

  // Display token → real token, piu' gli `@handle` battuti a mano: senza
  // questa risoluzione un tag scritto senza passare dal menu non notifica.
  const text = mentionCtrl ? await mentionCtrl.resolveForSend(rawText) : rawText;

  // Clear typing immediately
  isTyping = false;
  clearTimeout(typingTimer);
  clearTyping(thread.id, currentUser.uid).catch(() => {});

  const spoilerPayload = !isSupportThreadData() && spoilerComposerCtrl
    ? spoilerComposerCtrl.getState()
    : { containsSpoiler: false, spoilerTitleIds: [] };

  try {
    await runWithButtonLoading(els.btnSend, async () => {
      await sendThreadMessage({
        threadId: thread.id,
        senderUid: currentUser.uid,
        displayName: (myUserDoc?.displayName || currentUser.displayName || currentUser.email || "Anonimo"),
        text,
        containsSpoiler: spoilerPayload.containsSpoiler,
        spoilerTitleIds: spoilerPayload.spoilerTitleIds,
      });
      if (spoilerComposerCtrl) spoilerComposerCtrl.reset();
      if (thread?.titleId) {
        logSignal({
          uid: currentUser.uid,
          titleId: thread.titleId,
          actionType: "thread_post",
          source: "thread",
        }).catch(() => {});
      }
      els.msgText.value = "";
      els.msgText.style.height = "auto";
      mentionCtrl?.reset();
      scrollToBottom(true);
    }, { loadingLabel: "Invio…" });
  } catch (err) {
    console.error(err);
    toast(err?.message || i18nT("Non sono riuscito a inviare"), "Ops");
  }
}

// ── GIF: invio ──
//
// Invia una GIF come messaggio `type:"gif"` (didascalia vuota). Riusa lo stato
// del composer anti-spoiler (una GIF può contenere spoiler come un testo).
async function sendGif(gifUrl) {
  if (!thread || !currentUser) return;
  if (!isValidGifUrl(gifUrl)) return;

  const spoilerPayload = !isSupportThreadData() && spoilerComposerCtrl
    ? spoilerComposerCtrl.getState()
    : { containsSpoiler: false, spoilerTitleIds: [] };

  try {
    await sendThreadMessage({
      threadId: thread.id,
      senderUid: currentUser.uid,
      displayName: (myUserDoc?.displayName || currentUser.displayName || currentUser.email || "Anonimo"),
      type: "gif",
      gifUrl: gifUrl.trim(),
      text: "",
      containsSpoiler: spoilerPayload.containsSpoiler,
      spoilerTitleIds: spoilerPayload.spoilerTitleIds,
    });
    if (spoilerComposerCtrl) spoilerComposerCtrl.reset();
    if (thread?.titleId) {
      logSignal({
        uid: currentUser.uid,
        titleId: thread.titleId,
        actionType: "thread_post",
        source: "thread",
      }).catch(() => {});
    }
    scrollToBottom(true);
  } catch (err) {
    console.error(err);
    toast(err?.message || i18nT("Non sono riuscito a inviare la GIF"), "Ops");
  }
}

// ── GIF: picker modale (Giphy via callable gifSearch) ──

let gifPickerOverlay = null;

function closeGifPicker() {
  if (gifPickerOverlay) {
    gifPickerOverlay.remove();
    gifPickerOverlay = null;
  }
}

function openGifPicker() {
  if (gifPickerOverlay) return;

  const overlay = document.createElement("div");
  overlay.className = "gif-picker-overlay";
  overlay.innerHTML = `
    <div class="gif-picker-box" role="dialog" aria-label="${i18nT("Scegli una GIF")}">
      <div class="gif-picker-head">
        <input class="gif-picker-search" id="gifSearchInput" type="search" placeholder="${i18nT("Cerca una GIF…")}" autocomplete="off" aria-label="${i18nT("Cerca una GIF")}" />
        <button class="gif-picker-close" id="gifPickerClose" type="button">${i18nT("Chiudi")}</button>
      </div>
      <div class="gif-picker-status" id="gifPickerStatus" style="display:none;"></div>
      <div class="gif-picker-grid" id="gifPickerGrid"></div>
      <div class="gif-picker-attribution">GIF via GIPHY</div>
    </div>
  `;

  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeGifPicker(); });
  document.body.appendChild(overlay);
  gifPickerOverlay = overlay;

  const inputEl = overlay.querySelector("#gifSearchInput");
  const gridEl = overlay.querySelector("#gifPickerGrid");
  const statusEl = overlay.querySelector("#gifPickerStatus");
  overlay.querySelector("#gifPickerClose")?.addEventListener("click", closeGifPicker);

  let currentQuery = "";
  let nextOffset = 0;
  let loading = false;
  let exhausted = false;
  let reqToken = 0;

  function setStatus(msg) {
    if (!statusEl) return;
    if (msg) {
      statusEl.textContent = msg;
      statusEl.style.display = "block";
    } else {
      statusEl.textContent = "";
      statusEl.style.display = "none";
    }
  }

  function appendResults(results) {
    const frag = document.createDocumentFragment();
    results.forEach((r) => {
      if (!r || !isValidGifUrl(r.gifUrl)) return;
      const previewSrc = isValidGifUrl(r.previewUrl) ? r.previewUrl.trim() : r.gifUrl.trim();
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gif-picker-item";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = r.title || i18nT("GIF");
      img.src = previewSrc;
      btn.appendChild(img);
      btn.addEventListener("click", () => {
        closeGifPicker();
        sendGif(r.gifUrl.trim());
      });
      frag.appendChild(btn);
    });
    gridEl.appendChild(frag);
  }

  async function load(reset) {
    // Un `reset` (nuova query) supera qualunque richiesta in volo bumpando il
    // token; la paginazione (`!reset`) si ferma se già in corso o esaurita.
    if (!reset && (loading || exhausted)) return;
    const myToken = ++reqToken;
    loading = true;
    if (reset) {
      nextOffset = 0;
      exhausted = false;
      gridEl.innerHTML = "";
      gridEl.scrollTop = 0;
      setStatus("Carico…");
    }
    try {
      const { results, next } = await searchGifs(currentQuery, nextOffset);
      if (myToken !== reqToken) return; // superata da una richiesta più recente
      const list = Array.isArray(results) ? results.filter((r) => r && isValidGifUrl(r.gifUrl)) : [];
      if (reset && !list.length) {
        setStatus(currentQuery ? i18nT("Nessuna GIF trovata") : i18nT("Nessuna GIF disponibile al momento."));
      } else {
        setStatus("");
      }
      appendResults(list);
      if (!list.length) {
        exhausted = true;
      } else {
        nextOffset = Number.isFinite(next) ? next : nextOffset + list.length;
      }
    } catch (err) {
      if (myToken !== reqToken) return;
      console.warn("[gifPicker] search failed", err);
      if (reset) {
        gridEl.innerHTML = "";
        setStatus(i18nT("GIF non disponibili al momento."));
      }
      exhausted = true;
    } finally {
      if (myToken === reqToken) loading = false;
    }
  }

  let debounceTimer = null;
  inputEl?.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentQuery = inputEl.value.trim();
      load(true);
    }, 350);
  });

  gridEl?.addEventListener("scroll", () => {
    if (loading || exhausted) return;
    if (gridEl.scrollTop + gridEl.clientHeight >= gridEl.scrollHeight - 120) {
      load(false);
    }
  });

  inputEl?.focus();
  load(true);
}

els.btnGif?.addEventListener("click", () => {
  if (!currentUser || !thread) return;
  openGifPicker();
});

els.threadBackBtn?.addEventListener("click", () => goBack());

initAuthGuard({ requireAuth: false, onReady: async (user) => {
  if (!user) {
    currentUser = null;
    if (els.threadApp) els.threadApp.style.display = "none";
    if (els.threadHeadCard) els.threadHeadCard.style.display = "none";
    if (els.threadInfo) els.threadInfo.style.display = "none";
    if (els.episodeSpoilerGate) els.episodeSpoilerGate.style.display = "none";
    if (els.authGate) els.authGate.style.display = "block";
    return;
  }

  if (els.authGate) els.authGate.style.display = "none";
  await bootSignedIn(user);
}});

// Clean up typing on page unload
window.addEventListener("beforeunload", () => {
  if (thread && currentUser && isTyping) {
    clearTyping(thread.id, currentUser.uid).catch(() => {});
  }
});
