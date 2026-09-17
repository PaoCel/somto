// mentionAutocomplete.js — picker menzioni @utente / #titolo, condiviso.
//
// PERCHE' ESISTE
// Il token che il backend riconosce e' `@{Nome Visibile}(uid)`
// (`functions/lib/mentions.js`): `@handle` scritto a mano NON e' una menzione e
// non produce nessuna notifica. Quel token lo sa comporre solo il picker,
// quindi un composer senza picker e' un composer in cui taggare non funziona —
// che e' esattamente il bug segnalato ("ho scritto @pulart e non e' successo
// niente").
//
// La stessa logica era copiata in tre punti (thread, composer post, commento a
// un post). Qui sta una volta sola: i composer la montano con una riga e i tre
// vecchi sono stati migrati a questo modulo.
//
// RETE DI SICUREZZA
// Anche col picker, chi digita `@pulart` e non seleziona dal menu resterebbe
// senza tag. Per questo `resolveMentionsForSend` risolve, al momento
// dell'invio, gli handle scritti a mano leggendo `usernames/{handle}` (una
// getDoc per handle, con lo stesso tetto del server). Gli handle inesistenti
// restano testo.

import { escapeHtml } from "../utils/dom.js";
import { searchUsersByPrefix, getUserByHandle } from "../api/users.api.js";
import { searchTitlesSmart } from "../api/titles.api.js";
import { searchPeopleByPrefix } from "../api/people.api.js";

// Stesso tetto del server (`MAX_MENTIONS_PER_TEXT` in functions/lib/mentions.js):
// oltre questa soglia il backend smette di notificare, quindi risolvere piu'
// handle di cosi' sarebbe solo rumore (e letture Firestore) a vuoto.
export const MAX_RESOLVED_HANDLES = 10;

// Un handle Somto: stesso alfabeto della reservation in `usernames`
// (firestore.rules) — alphanum con separatori singoli . _ -, 3..24 caratteri.
const TYPED_HANDLE_RE = /(^|[\s(])@([A-Za-z0-9](?:[._-]?[A-Za-z0-9]){2,23})/g;

export function normalizeMentionQuery(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function initialsOf(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  const a = (parts[0] || "?").slice(0, 1);
  const b = parts.length > 1 ? (parts[parts.length - 1] || "").slice(0, 1) : "";
  return (a + b).toUpperCase();
}

export function mentionIconForItem(it) {
  if (it?.kind === "user") return initialsOf(it.label);
  if (it?.kind === "person") return "👤";
  return "🎬";
}

export function mentionBadgeForItem(it) {
  return it?.kind === "user" ? "@" : "#";
}

/** Display token (cio' che si vede mentre si scrive) + real token (cio' che si salva). */
export function buildMentionToken(item) {
  const kind = item?.kind === "user" ? "user" : (item?.kind === "person" ? "person" : "title");
  const label = String(item?.label || "").trim();
  const id = String(item?.id || "").trim();
  if (!label || !id) return null;

  if (kind === "user") {
    return { display: `@${label}`, real: `@{${label}}(${id})` };
  }
  if (kind === "person") {
    return { display: `#${label}`, real: `#[${label}](person:${id})` };
  }
  return { display: `#${label}`, real: `#[${label}](${id})` };
}

/** Sostituisce i display token con i real token (dal piu' lungo, per evitare match parziali). */
export function resolveMentionText(raw, tokens = []) {
  let out = String(raw || "");
  const sorted = [...tokens].sort((a, b) => b.display.length - a.display.length);
  for (const { display, real } of sorted) {
    out = out.replace(display, real);
  }
  return out;
}

/** La menzione in corso di scrittura sotto il cursore, o null. */
export function getActiveMention(text, cursorPos, tokens = []) {
  const before = String(text || "").slice(0, cursorPos);
  const candidates = [];

  for (const sym of ["@", "#"]) {
    const idx = before.lastIndexOf(sym);
    if (idx < 0) continue;

    const prev = idx === 0 ? " " : before[idx - 1];
    if (idx > 0 && !(/\s|\(/.test(prev))) continue;

    const q = before.slice(idx + 1);

    // Per @ (utente): lo spazio chiude la menzione.
    // Per # (titolo/persona): lo spazio e' permesso (i titoli hanno spazi),
    // chiude solo su ] ) }.
    if (sym === "@" && /\s|\]|\)|\}/.test(q)) continue;
    if (sym === "#" && /\]|\)|\}/.test(q)) continue;

    if (sym === "@" && q.startsWith("{")) continue;
    if (sym === "#" && q.startsWith("[")) continue;

    // Ignora se il token corrisponde a una menzione gia' inserita.
    const fullDisplay = sym + q;
    const isAlreadyInserted = tokens.some((mt) => {
      if (!fullDisplay.startsWith(mt.display)) return false;
      const rest = fullDisplay.slice(mt.display.length);
      return rest === "" || /^[\s\n]/.test(rest);
    });
    if (isAlreadyInserted) continue;

    candidates.push({ sym, idx, q });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.idx - a.idx);
  const best = candidates[0];
  return {
    type: best.sym === "@" ? "user" : "topic",
    start: best.idx,
    query: best.q,
  };
}

/**
 * Risolve gli `@handle` battuti a mano in token canonici `@{Nome}(uid)`.
 *
 * Una getDoc per handle distinto su `usernames/{handle}`, leggibile da
 * qualunque utente loggato. Gli handle che non esistono restano testo: meglio
 * un `@pulart` inerte che un link a un profilo sbagliato.
 */
export async function resolveTypedHandles(text, { max = MAX_RESOLVED_HANDLES } = {}) {
  const source = String(text || "");
  if (!source.includes("@")) return source;

  const handles = [];
  const seen = new Set();
  const re = new RegExp(TYPED_HANDLE_RE.source, "g");
  let match;
  while ((match = re.exec(source)) !== null) {
    const handle = match[2];
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
    if (handles.length >= Math.max(0, max)) break;
  }
  if (!handles.length) return source;

  const resolved = await Promise.all(handles.map(async (handle) => {
    const row = await getUserByHandle(handle).catch(() => null);
    if (!row?.uid || !row?.displayName) return null;
    return { handle, uid: row.uid, displayName: row.displayName };
  }));

  const byHandle = new Map();
  resolved.filter(Boolean).forEach((row) => byHandle.set(row.handle.toLowerCase(), row));
  if (!byHandle.size) return source;

  return source.replace(new RegExp(TYPED_HANDLE_RE.source, "g"), (whole, lead, handle) => {
    const hit = byHandle.get(String(handle).toLowerCase());
    if (!hit) return whole;
    return `${lead}@{${hit.displayName}}(${hit.uid})`;
  });
}

/** Testo pronto per Firestore: token del picker + handle scritti a mano. */
export async function resolveMentionsForSend(raw, tokens = [], opts = {}) {
  const withTokens = resolveMentionText(raw, tokens);
  return resolveTypedHandles(withTokens, opts);
}

/**
 * Testo di un messaggio/post reso in HTML: URL, `@{Nome}(uid)` e `#[Nome](id)`
 * diventano link. Un token canonico mostrato con `escapeHtml` grezzo resta
 * testo inerte, che e' il modo piu' silenzioso di rompere le menzioni.
 */
export function renderMentionRichText(rawText, { lineBreaks = true } = {}) {
  const safe = escapeHtml(rawText || "");

  // Gli URL nudi girano PRIMA dei tag, cosi' non possono mai matchare gli href
  // interni che i tag inseriscono. La punteggiatura finale resta fuori dal link.
  let out = safe.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const trail = (url.match(/[.,;:!?)\]]+$/) || [""])[0];
    const core = url.slice(0, url.length - trail.length);
    if (!core) return url;
    let isSameOrigin = false;
    try { isSameOrigin = new URL(core, window.location.href).origin === window.location.origin; } catch (_) { /* no-op */ }
    const externalAttrs = isSameOrigin ? "" : ' target="_blank" rel="noopener noreferrer"';
    return `<a class="msg-link" href="${core}"${externalAttrs}>${core}</a>${trail}`;
  });

  out = out.replace(/@\{([^}]+)\}\(([^)]+)\)/g, (m, name, uid) => (
    `<a class="msg-user-tag" href="/user.html?uid=${encodeURIComponent(uid)}">@${name}</a>`
  ));

  out = out.replace(/#\[([^\]]+)\]\(([^)]+)\)/g, (m, name, rawId) => {
    const id = String(rawId || "");
    if (id.startsWith("person:")) {
      const personId = id.slice("person:".length);
      const href = `/search.html?scope=people&q=${encodeURIComponent(name)}&pid=${encodeURIComponent(personId)}`;
      return `<a class="msg-people-tag" href="${href}">#${name}</a>`;
    }
    return `<a class="msg-title-tag" href="/title.html?id=${encodeURIComponent(id)}">#${name}</a>`;
  });

  // Formato legacy dei primi thread: `@[Titolo](id)` era un tag titolo.
  out = out.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (m, name, id) => (
    `<a class="msg-title-tag" href="/title.html?id=${encodeURIComponent(id)}">#${name}</a>`
  ));

  return lineBreaks ? out.replace(/\n/g, "<br>") : out;
}

function scoreCandidate(label, query) {
  const n = normalizeMentionQuery(label);
  if (n.startsWith(query)) return 3;
  if (n.includes(query)) return 2;
  return 1;
}

/**
 * Ricerca di default: `@` → utenti (gli amici passati in `friends` pesano di
 * piu'), `#` → titoli + persone. I composer con regole proprie (es. i thread
 * privati, dove si puo' taggare solo chi partecipa) passano il proprio
 * `searchTargets` ad `attachMentionAutocomplete`.
 */
export async function searchMentionTargets(type, query, { friends = [] } = {}) {
  const q = normalizeMentionQuery(query);
  if (!q) return [];

  if (type === "topic" || type === "title") {
    const [titleRows, peopleRows] = await Promise.all([
      searchTitlesSmart(q, 6).catch(() => []),
      searchPeopleByPrefix(q, { max: 6 }).catch(() => []),
    ]);

    const titleItems = (titleRows || [])
      .filter((t) => t?.id && t?.name)
      .map((t) => ({ id: t.id, label: t.name, kind: "title", _score: scoreCandidate(t.name, q) }));
    const peopleItems = (peopleRows || [])
      .filter((p) => p?.id && p?.name)
      .map((p) => ({ id: p.id, label: p.name, kind: "person", _score: scoreCandidate(p.name, q) }));

    const merged = [...titleItems, ...peopleItems];
    merged.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      if (a.kind !== b.kind) return a.kind === "title" ? -1 : 1;
      return String(a.label).localeCompare(String(b.label), "it");
    });
    return merged.slice(0, 8).map(({ _score, ...row }) => row);
  }

  const friendRows = (friends || [])
    .filter((u) => u?.uid && u?.displayName && normalizeMentionQuery(u.displayName).includes(q))
    .slice(0, 10)
    .map((u) => ({ id: u.uid, label: u.displayName, kind: "user", _score: scoreCandidate(u.displayName, q) + 1 }));

  const publicRows = await searchUsersByPrefix(q, { max: 10 }).catch(() => []);
  const publicItems = (publicRows || [])
    .filter((u) => u?.uid)
    .map((u) => ({
      id: u.uid,
      label: u.displayName || u.uid,
      kind: "user",
      _score: scoreCandidate(u.displayName || u.uid, q),
    }));

  const uniq = new Map();
  [...friendRows, ...publicItems].forEach((row) => {
    const prev = uniq.get(row.id);
    if (!prev || row._score > prev._score) uniq.set(row.id, row);
  });

  return Array.from(uniq.values())
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return String(a.label).localeCompare(String(b.label), "it");
    })
    .slice(0, 8)
    .map(({ _score, ...row }) => row);
}

export function mentionItemsHtml(items = [], selectedIndex = 0) {
  return items
    .map((it, i) => {
      const sel = i === selectedIndex ? "selected" : "";
      const icon = mentionIconForItem(it);
      const badge = mentionBadgeForItem(it);
      return `
        <div class="mention-item ${sel}" data-id="${escapeHtml(it.id)}" data-label="${escapeHtml(it.label)}" data-kind="${escapeHtml(it.kind || "")}">
          <span style="display:inline-flex;align-items:center;gap:10px;">
            <span class="participant-avatar" style="width:24px;height:24px;font-size:11px;">${escapeHtml(icon)}</span>
            <span><b>${badge}</b>${escapeHtml(it.label)}</span>
          </span>
        </div>
      `;
    })
    .join("");
}

/**
 * Monta il picker su un input/textarea + un contenitore `.mention-dropdown`.
 *
 * Ritorna il controller:
 *  - `resolveTokens(raw)`  → testo canonico dai soli token del picker (sincrono)
 *  - `resolveForSend(raw)` → testo canonico + handle scritti a mano (async)
 *  - `reset()` / `close()` / `isOpen()` / `destroy()`
 *
 * Idempotente: montarlo due volte sullo stesso input restituisce il controller
 * gia' esistente invece di duplicare i listener.
 */
export function attachMentionAutocomplete(input, dropdown, {
  searchTargets = (type, query) => searchMentionTargets(type, query),
  onInsert = null,
  onEnterSubmit = null,
  minQueryLength = 1,
} = {}) {
  if (!input || !dropdown) return null;
  if (input.__mentionCtrl) return input.__mentionCtrl;

  const state = {
    open: false,
    type: null,
    start: -1,
    items: [],
    selected: 0,
    tokens: [],
  };

  function close() {
    state.open = false;
    state.type = null;
    state.start = -1;
    state.items = [];
    state.selected = 0;
    dropdown.style.display = "none";
    dropdown.innerHTML = "";
  }

  function render() {
    if (!state.open || !state.items.length) {
      close();
      return;
    }
    dropdown.style.display = "block";
    dropdown.innerHTML = mentionItemsHtml(state.items, state.selected);
    dropdown.querySelectorAll(".mention-item").forEach((row) => {
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        insert({
          id: row.getAttribute("data-id"),
          label: row.getAttribute("data-label"),
          kind: row.getAttribute("data-kind"),
        });
      });
    });
  }

  function insert(picked) {
    const token = buildMentionToken(picked);
    if (!token) return;

    const raw = input.value;
    const cursor = input.selectionStart ?? raw.length;
    const before = raw.slice(0, state.start);
    const after = raw.slice(cursor);

    state.tokens.push(token);

    const insertText = `${token.display} `;
    input.value = before + insertText + after;
    const pos = (before + insertText).length;
    input.focus();
    try { input.setSelectionRange(pos, pos); } catch (_) { /* input type non selezionabile */ }
    close();
    if (typeof onInsert === "function") onInsert();
  }

  async function onInput() {
    const text = input.value;
    const pos = input.selectionStart ?? text.length;
    const active = getActiveMention(text, pos, state.tokens);

    if (!active || !active.query || active.query.length < minQueryLength) {
      close();
      return;
    }

    state.type = active.type;
    state.start = active.start;
    const items = await searchTargets(active.type, active.query);
    state.items = Array.isArray(items) ? items : [];
    state.selected = 0;
    state.open = state.items.length > 0;
    render();
  }

  async function onKeyDown(e) {
    if (state.open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.selected = Math.min(state.selected + 1, state.items.length - 1);
        render();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.selected = Math.max(state.selected - 1, 0);
        render();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && state.items.length) {
        e.preventDefault();
        insert(state.items[state.selected]);
        return;
      }
      if (e.key === "Escape") {
        close();
        return;
      }
    }

    if (typeof onEnterSubmit === "function" && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      await onEnterSubmit();
    }
  }

  function onDocMouseDown(e) {
    if (!state.open) return;
    const inside = dropdown.contains(e.target) || input.contains(e.target) || e.target === input;
    if (!inside) close();
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  document.addEventListener("mousedown", onDocMouseDown);

  const ctrl = {
    get tokens() { return state.tokens; },
    isOpen: () => state.open,
    close,
    reset() {
      state.tokens = [];
      close();
    },
    resolveTokens(raw) {
      return resolveMentionText(raw ?? input.value, state.tokens);
    },
    async resolveForSend(raw) {
      return resolveMentionsForSend(raw ?? input.value, state.tokens);
    },
    destroy() {
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onDocMouseDown);
      delete input.__mentionCtrl;
    },
  };

  input.__mentionCtrl = ctrl;
  return ctrl;
}
