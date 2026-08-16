// lists-editor.page.js — Editor liste utente (Crea/Modifica/Elimina) + sheet
// aggiunta titoli. Replica UserListEditorView (iOS, WatchlistView.swift:2114+).
//
// API pubblica:
//   import { openListEditor } from "./lists-editor.page.js";
//   openListEditor({ mode: "create" });
//   openListEditor({ mode: "edit", list, onSaved });

import { createList, updateList, deleteList, fetchListDetail, addTitleToList, removeTitleFromList } from "../api/userLists.api.js";
import { t as i18nT } from "../i18n/index.js";
import { searchTitlesSmart } from "../api/titles.api.js";
import { searchUsersByPrefix } from "../api/users.api.js";
import { auth } from "../firebase.js";

let sheetEl = null;
let activeMode = "create";
let activeList = null;
let activeOnSaved = null;
let selectedTitles = [];
let selectedCollaborators = [];
let titleSearchTimer = null;
let collabSearchTimer = null;

const VISIBILITY_OPTIONS = [
  { value: "private", label: i18nT("Privata"), desc: i18nT("Solo per te") },
  { value: "shared", label: i18nT("Condivisa"), desc: "Tu e i collaboratori" },
  { value: "public", label: i18nT("Pubblica"), desc: i18nT("Visibile a tutti") },
];

const KIND_OPTIONS = [
  { value: "collection", label: i18nT("Raccolta"), desc: i18nT("Titoli senza ordine specifico") },
  { value: "ordered_path", label: i18nT("Percorso"), desc: "Ordine cronologico (maratona)" },
];

/* ============================= helpers ============================= */

function $(id) { return document.getElementById(id); }
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

function clearChildren(n) { if (!n) return; while (n.firstChild) n.removeChild(n.firstChild); }

function ensureSheet() {
  if (sheetEl) return sheetEl;

  sheetEl = el("div", { id: "wlListEditor", class: "wl-sheet", "aria-hidden": "true" });
  sheetEl.innerHTML = `
    <div class="wl-sheet-backdrop" data-action="close"></div>
    <section class="wl-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="wlEditorTitle">
      <div class="wl-sheet-handle"></div>
      <header class="wl-sheet-head">
        <button class="wl-sheet-nav-btn" type="button" data-action="close">${i18nT("Annulla")}</button>
        <h2 id="wlEditorTitle">${i18nT("Nuova lista")}</h2>
        <button id="wlListSave" class="wl-sheet-nav-btn primary" type="button">${i18nT("Salva")}</button>
      </header>

      <div class="wl-sheet-body">
        <label class="wl-form-row">
          <span class="wl-form-label">Titolo</span>
          <input id="wlListTitle" class="wl-form-input" type="text" maxlength="80" placeholder="Es. Maratona Marvel">
        </label>

        <label class="wl-form-row">
          <span class="wl-form-label">${i18nT("Descrizione")} <em>(opzionale)</em></span>
          <textarea id="wlListDescription" class="wl-form-input wl-form-textarea" rows="2" maxlength="280" placeholder="${i18nT("A cosa serve questa lista?")}"></textarea>
        </label>

        <div class="wl-form-row">
          <span class="wl-form-label">${i18nT("Tipo")}</span>
          <div id="wlListKind" class="wl-form-segments" role="radiogroup" aria-label=i18nT("Tipo lista")></div>
        </div>

        <div class="wl-form-row">
          <span class="wl-form-label">${i18nT("Visibilità")}</span>
          <div id="wlListVisibility" class="wl-form-segments" role="radiogroup" aria-label="${i18nT("Visibilità lista")}"></div>
        </div>

        <div id="wlCollaboratorsWrap" class="wl-form-row" hidden>
          <span class="wl-form-label">${i18nT("Collaboratori")}</span>
          <div class="wl-form-search">
            <input id="wlCollabInput" type="search" placeholder="${i18nT("Cerca utenti…")}" autocomplete="off">
          </div>
          <div id="wlCollabResults" class="wl-search-results"></div>
          <div id="wlSelectedCollabs" class="wl-selected-chips"></div>
        </div>

        <div class="wl-form-row">
          <span class="wl-form-label">${i18nT("Titoli")}</span>
          <div class="wl-form-search">
            <input id="wlTitleSearchInput" type="search" placeholder="${i18nT("Cerca film o serie…")}" autocomplete="off">
          </div>
          <div id="wlTitleSearchResults" class="wl-search-results"></div>
          <div id="wlSelectedTitles" class="wl-selected-titles"></div>
        </div>
      </div>

      <footer class="wl-sheet-foot">
        <button id="wlListDelete" class="wl-btn-danger" type="button" hidden>${i18nT("Elimina lista")}</button>
      </footer>
    </section>
  `;
  document.body.appendChild(sheetEl);

  // Render segments
  const kindRoot = $("wlListKind");
  KIND_OPTIONS.forEach((opt) => {
    const btn = el("button", {
      class: "wl-segment-btn",
      type: "button",
      role: "radio",
      "data-value": opt.value,
      onclick: () => setActiveSegment("wlListKind", opt.value),
    }, [
      el("strong", {}, [opt.label]),
      el("small", {}, [opt.desc]),
    ]);
    kindRoot.appendChild(btn);
  });
  const visRoot = $("wlListVisibility");
  VISIBILITY_OPTIONS.forEach((opt) => {
    const btn = el("button", {
      class: "wl-segment-btn",
      type: "button",
      role: "radio",
      "data-value": opt.value,
      onclick: () => {
        setActiveSegment("wlListVisibility", opt.value);
        toggleCollaboratorsField(opt.value === "shared");
      },
    }, [
      el("strong", {}, [opt.label]),
      el("small", {}, [opt.desc]),
    ]);
    visRoot.appendChild(btn);
  });

  // Bindings
  sheetEl.querySelectorAll("[data-action='close']").forEach((n) => n.addEventListener("click", closeSheet));
  $("wlTitleSearchInput").addEventListener("input", (e) => {
    if (titleSearchTimer) clearTimeout(titleSearchTimer);
    titleSearchTimer = setTimeout(() => runTitleSearch(String(e.target.value || "")), 220);
  });
  $("wlCollabInput").addEventListener("input", (e) => {
    if (collabSearchTimer) clearTimeout(collabSearchTimer);
    collabSearchTimer = setTimeout(() => runCollabSearch(String(e.target.value || "")), 220);
  });
  $("wlListSave").addEventListener("click", handleSave);
  $("wlListDelete").addEventListener("click", handleDelete);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheetEl?.getAttribute("aria-hidden") === "false") closeSheet();
  });

  return sheetEl;
}

function setActiveSegment(groupId, value) {
  const group = $(groupId);
  group?.querySelectorAll(".wl-segment-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.value === value);
    btn.setAttribute("aria-checked", btn.dataset.value === value ? "true" : "false");
  });
}

function getActiveSegmentValue(groupId) {
  const group = $(groupId);
  return group?.querySelector(".wl-segment-btn.is-active")?.dataset.value || null;
}

function toggleCollaboratorsField(show) {
  const wrap = $("wlCollaboratorsWrap");
  if (wrap) wrap.hidden = !show;
}

/* ============================= title search ============================= */

async function runTitleSearch(query) {
  const root = $("wlTitleSearchResults");
  if (!root) return;
  const q = String(query || "").trim();
  if (q.length < 2) { clearChildren(root); return; }
  root.innerHTML = '<div class="wl-search-hint">Cerco…</div>';
  try {
    const items = await searchTitlesSmart(q, 12);
    clearChildren(root);
    if (!items.length) {
      root.innerHTML = `<div class="wl-search-hint">${i18nT("Nessun risultato")}</div>`;
      return;
    }
    items.forEach((t) => {
      const already = selectedTitles.find((x) => x.id === t.id);
      const row = el("button", {
        class: "wl-search-row",
        type: "button",
        disabled: already ? "true" : null,
        onclick: () => addTitle(t),
      }, [
        t.posterPath
          ? el("img", { src: t.posterPath, alt: t.name })
          : el("div", { class: "wl-search-poster placeholder" }),
        el("div", { class: "wl-search-meta" }, [
          el("strong", {}, [t.name]),
          el("small", {}, [`${t.type === "tv" ? i18nT("Serie") : i18nT("Film")}${t.year ? ` · ${t.year}` : ""}`]),
        ]),
        already
          ? el("span", { class: "wl-search-already" }, [i18nT("Già aggiunto")])
          : el("span", { class: "wl-search-add" }, ["+"]),
      ]);
      root.appendChild(row);
    });
  } catch (err) {
    console.error("title search error", err);
    root.innerHTML = `<div class="wl-search-hint">${i18nT("Errore di ricerca")}</div>`;
  }
}

function addTitle(title) {
  if (selectedTitles.find((t) => t.id === title.id)) return;
  selectedTitles.push(title);
  renderSelectedTitles();
  runTitleSearch($("wlTitleSearchInput").value || "");
}

function removeTitle(titleId) {
  selectedTitles = selectedTitles.filter((t) => t.id !== titleId);
  renderSelectedTitles();
}

function renderSelectedTitles() {
  const root = $("wlSelectedTitles");
  if (!root) return;
  clearChildren(root);
  if (selectedTitles.length === 0) {
    root.innerHTML = `<p class="wl-search-hint">${i18nT("Nessun titolo selezionato")}</p>`;
    return;
  }
  selectedTitles.forEach((t, idx) => {
    const card = el("div", { class: "wl-selected-card" }, [
      t.posterPath ? el("img", { src: t.posterPath, alt: t.name }) : el("div", { class: "wl-selected-placeholder" }),
      el("div", { class: "wl-selected-meta" }, [
        el("strong", {}, [t.name]),
        el("small", {}, [`#${idx + 1}`]),
      ]),
      el("button", { class: "wl-selected-remove", type: "button", onclick: () => removeTitle(t.id), "aria-label": i18nT("Rimuovi titolo") }, ["×"]),
    ]);
    root.appendChild(card);
  });
}

/* ============================= collab search ============================= */

async function runCollabSearch(query) {
  const root = $("wlCollabResults");
  if (!root) return;
  const q = String(query || "").trim();
  if (q.length < 2) { clearChildren(root); return; }
  root.innerHTML = '<div class="wl-search-hint">Cerco…</div>';
  try {
    const users = await searchUsersByPrefix(q, { max: 8 });
    clearChildren(root);
    if (!users.length) {
      root.innerHTML = `<div class="wl-search-hint">${i18nT("Nessun utente")}</div>`;
      return;
    }
    users.forEach((u) => {
      if (u.uid === auth.currentUser?.uid) return;
      const already = selectedCollaborators.find((x) => x.uid === u.uid);
      const row = el("button", {
        class: "wl-search-row",
        type: "button",
        disabled: already ? "true" : null,
        onclick: () => addCollab(u),
      }, [
        u.photoURL
          ? el("img", { src: u.photoURL, alt: u.displayName || u.uid, class: "wl-collab-avatar" })
          : el("div", { class: "wl-collab-avatar placeholder" }),
        el("div", { class: "wl-search-meta" }, [
          el("strong", {}, [u.displayName || u.uid]),
          el("small", {}, [`@${u.displayNameLower || u.uid}`]),
        ]),
        already
          ? el("span", { class: "wl-search-already" }, ["Aggiunto"])
          : el("span", { class: "wl-search-add" }, ["+"]),
      ]);
      root.appendChild(row);
    });
  } catch (err) {
    console.error("collab search error", err);
    root.innerHTML = `<div class="wl-search-hint">${i18nT("Errore di ricerca")}</div>`;
  }
}

function addCollab(user) {
  if (selectedCollaborators.find((x) => x.uid === user.uid)) return;
  selectedCollaborators.push(user);
  renderSelectedCollabs();
}
function removeCollab(uid) {
  selectedCollaborators = selectedCollaborators.filter((u) => u.uid !== uid);
  renderSelectedCollabs();
}
function renderSelectedCollabs() {
  const root = $("wlSelectedCollabs");
  if (!root) return;
  clearChildren(root);
  selectedCollaborators.forEach((u) => {
    root.appendChild(el("span", { class: "wl-collab-chip" }, [
      el("span", {}, [u.displayName || u.uid]),
      el("button", { class: "wl-collab-chip-remove", type: "button", onclick: () => removeCollab(u.uid), "aria-label": i18nT("Rimuovi collaboratore") }, ["×"]),
    ]));
  });
}

/* ============================= save / delete ============================= */

/** Messaggio d'errore leggibile: distingue permission-denied (regole Firestore)
 * dagli altri errori (validazione client, rete, ecc. hanno già un messaggio chiaro). */
function describeSaveError(err) {
  const code = String(err?.code || "").toLowerCase();
  const message = String(err?.message || "");
  if (code.includes("permission-denied") || /permission-denied/i.test(message)) {
    return i18nT("Non hai i permessi per questa operazione. Riprova o contatta l'assistenza.");
  }
  if (message) return message;
  return i18nT("Errore durante il salvataggio. Riprova.");
}

async function handleSave() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  const titleInput = $("wlListTitle").value.trim();
  if (titleInput.length < 2) {
    alert(i18nT("Il titolo della lista deve avere almeno 2 caratteri."));
    return;
  }
  const description = $("wlListDescription").value.trim();
  const kind = getActiveSegmentValue("wlListKind") || "collection";
  const visibility = getActiveSegmentValue("wlListVisibility") || "private";

  const saveBtn = $("wlListSave");
  saveBtn.disabled = true;
  saveBtn.textContent = i18nT("Salvataggio…");

  try {
    if (activeMode === "create") {
      const result = await createList(uid, {
        title: titleInput,
        description,
        kind,
        visibility,
        selectedTitleIDs: selectedTitles.map((t) => t.id),
        collaboratorIDs: selectedCollaborators.map((u) => u.uid),
      });
      closeSheet();
      if (typeof activeOnSaved === "function") activeOnSaved({ created: result.id });
    } else if (activeMode === "edit") {
      await updateList(activeList.id, {
        title: titleInput,
        description: description || null,
        kind,
        visibility,
        collaboratorIDs: selectedCollaborators.map((u) => u.uid),
      });
      // Per ora non aggiungiamo/rimuoviamo singoli titoli in edit (vincolo iOS:
      // si fa dalla detail view). I titoli aggiunti qui vanno scritti a parte.
      // Niente catch silenzioso: un fallimento (es. permission-denied) deve
      // arrivare all'outer catch → alert(describeSaveError), non sparire
      // lasciando credere che il titolo sia stato aggiunto.
      for (const t of selectedTitles) {
        await addTitleToList(activeList.id, t.id, { uid });
      }
      closeSheet();
      if (typeof activeOnSaved === "function") activeOnSaved({ updated: activeList.id });
    }
  } catch (err) {
    console.error("save list error", err);
    alert(describeSaveError(err));
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = i18nT("Salva");
  }
}

async function handleDelete() {
  if (activeMode !== "edit" || !activeList) return;
  if (!confirm(i18nT("Eliminare la lista \"{title}\"? L'azione non è reversibile.", { title: activeList.title }))) return;
  const delBtn = $("wlListDelete");
  delBtn.disabled = true;
  delBtn.textContent = "Eliminazione…";
  try {
    await deleteList(activeList.id);
    closeSheet();
    if (typeof activeOnSaved === "function") activeOnSaved({ deleted: activeList.id });
  } catch (err) {
    console.error("delete list error", err);
    alert(describeSaveError(err));
  } finally {
    delBtn.disabled = false;
    delBtn.textContent = i18nT("Elimina lista");
  }
}

/* ============================= public API ============================= */

export async function openListEditor(opts = {}) {
  ensureSheet();

  activeMode = opts.mode === "edit" ? "edit" : "create";
  activeList = opts.list || null;
  activeOnSaved = opts.onSaved || null;
  selectedTitles = [];
  selectedCollaborators = [];
  sheetEl.dataset.mode = activeMode;

  $("wlEditorTitle").textContent = activeMode === "edit" ? i18nT("Modifica lista") : i18nT("Nuova lista");
  // Preset da tip creazione liste (solo in create): pre-compilano nome + kind + visibility.
  // Spec C — nessun filtro media-type (il modello dati non li ha).
  const presetTitle = activeMode === "create" ? String(opts.presetTitle || "") : "";
  const presetKind = activeMode === "create" ? String(opts.presetKind || "collection") : "collection";
  const presetVisibility = activeMode === "create" ? String(opts.presetVisibility || "private") : "private";
  $("wlListTitle").value = activeList?.title || presetTitle;
  $("wlListDescription").value = activeList?.description || "";
  setActiveSegment("wlListKind", activeList?.kind || presetKind);
  setActiveSegment("wlListVisibility", activeList?.visibility || presetVisibility);
  toggleCollaboratorsField((activeList?.visibility || presetVisibility) === "shared");
  $("wlListDelete").hidden = activeMode !== "edit";
  $("wlTitleSearchInput").value = "";
  $("wlCollabInput").value = "";
  clearChildren($("wlTitleSearchResults"));
  clearChildren($("wlCollabResults"));

  // Pre-popola titoli/collab se in edit
  if (activeMode === "edit" && activeList?.id) {
    const detail = await fetchListDetail(activeList.id, auth.currentUser?.uid).catch(() => null);
    if (detail) {
      // No fetch titoli completi: in edit aggiungere/rimuovere singoli titoli è una feature minore.
      // Lista titoli esistenti gestita in detail page; qui solo metadata + collab.
      detail.members.forEach((m) => {
        if (m.uid !== auth.currentUser?.uid) {
          selectedCollaborators.push({ uid: m.uid, displayName: m.displayName, photoURL: m.photoURL });
        }
      });
    }
  }
  renderSelectedTitles();
  renderSelectedCollabs();

  document.body.classList.add("wl-sheet-open");
  sheetEl.setAttribute("aria-hidden", "false");
}

export function closeSheet() {
  if (!sheetEl) return;
  sheetEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("wl-sheet-open");
}
