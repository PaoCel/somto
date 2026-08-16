import { qs, escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { toast } from "../components/toast.js";
import { initAuthGuard } from "../components/authGuard.js";
import { getMyUserDoc } from "../api/users.api.js";
import { runWithButtonLoading } from "../utils/loading.js";

import {
  collection,
  query,
  orderBy,
  startAfter,
  limit,
  getDocs,
  doc,
  updateDoc,
  serverTimestamp,
  arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { ensurePersonAvatar, POPULAR_AVATAR_THRESHOLD } from "../api/people.api.js";
import { searchWikidataPersonCandidates, getCommonsImageUrl } from "../api/wikipedia.api.js";

const gate = qs("#gate");
const root = qs("#root");
const peopleList = qs("#peopleList");
const stats = qs("#stats");

const qInput = qs("#q");
const roleSel = qs("#role");
const onlyPopular = qs("#onlyPopular");
const onlyUnapproved = qs("#onlyUnapproved");

const btnReload = qs("#btnReload");
const btnMore = qs("#btnMore");
const btnAuto = qs("#btnAuto");

let me = null;
let meDoc = null;

let lastDoc = null;
let loaded = [];

// Per ogni person: state UI (candidates/selected/loading)
const st = new Map();

function canAdmin(){
  const level = String(meDoc?.level || "base").trim().toLowerCase();
  const isManagerLevel = level === "associate" || level === "doctor";
  return !!me && (!!meDoc?.isAdmin || (!!meDoc?.trusted && isManagerLevel));
}

function normalize(s){
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getApproval(p){
  return p?.avatar?.approval || "";
}

function hasRole(p, role){
  if (!role || role === "all") return true;
  const roles = Array.isArray(p.roles) ? p.roles : [];
  return roles.includes(role);
}

function getAvatarUrl(p){
  return p?.avatarUrl || p?.avatar?.url || p?.avatar?.externalUrl || "";
}

function getRejectedQids(p){
  const arr = p?.avatar?.rejectedWikidataIds;
  return Array.isArray(arr) ? arr.filter(Boolean).map(String) : [];
}

function ensureState(pid){
  if (!st.has(pid)) st.set(pid, { candidates: [], selectedQid: "", loading: false, term: "" });
  return st.get(pid);
}

function filterPeople(){
  const q = normalize(qInput?.value || "");
  const role = roleSel?.value || "actor";
  const wantPopular = !!onlyPopular?.checked;
  const wantUnapproved = !!onlyUnapproved?.checked;

  return loaded.filter(p => {
    if (wantPopular) {
      const occ = Number(p.occurrences || 0);
      if (occ < POPULAR_AVATAR_THRESHOLD) return false;
    }
    if (wantUnapproved) {
      if (getApproval(p) === "approved") return false;
    }
    if (!hasRole(p, role)) return false;
    if (q) {
      const n = normalize(p.name || "");
      if (!n.includes(q)) return false;
    }
    return true;
  });
}

function render(){
  const role = roleSel?.value || "all";
  const wantPopular = !!onlyPopular?.checked;
  const wantUnapproved = !!onlyUnapproved?.checked;
  const q = normalize(qInput?.value || "");

  const items = filterPeople();

  const total = loaded.length;
  const popularLoaded = loaded.filter(p => Number(p.occurrences || 0) >= POPULAR_AVATAR_THRESHOLD).length;
  const unapprovedLoaded = loaded.filter(p => getApproval(p) !== "approved").length;

  const bits = [
    `${items.length} mostrati`,
    `caricati: ${total}`,
    `popolari: ${popularLoaded}`,
    `da approvare: ${unapprovedLoaded}`,
  ];
  stats.textContent = bits.join(" · ");

  if (!items.length) {
    // Friendly empty-states that explain *why* the list is empty.
    let msg = i18nT("Nessuna persona da mostrare con i filtri correnti.");
    const actions = [];

    if (wantPopular && popularLoaded === 0) {
      msg = i18nT("Per ora non hai nessuna persona “popolare” (occ ≥ {POPULAR_AVATAR_THRESHOLD}).\n", { POPULAR_AVATAR_THRESHOLD }) +
            i18nT("Finché non aumentano le occurrences (aggiungendo titoli), questa lista resterà vuota con quel filtro.");
      actions.push(`<button class="btn small primary" data-act="toggle-popular">${i18nT("Mostra anche non popolari")}</button>`);
    }

    if (wantUnapproved && unapprovedLoaded === 0) {
      msg = i18nT("Sembra che tutte le persone caricate siano già approvate.");
      actions.push(`<button class="btn small ghost" data-act="toggle-unapproved">${i18nT("Mostra anche approvati")}</button>`);
    }

    if (q) {
      actions.push(`<button class="btn small ghost" data-act="clear-search">${i18nT("Pulisci ricerca")}</button>`);
    }

    if (role !== "all") {
      actions.push(`<button class="btn small ghost" data-act="set-role-all">${i18nT("Ruolo: tutti")}</button>`);
    }

    const actionsHtml = actions.length
      ? `<div style="margin-top: var(--space-sm); display:flex; gap: var(--space-sm); flex-wrap:wrap;">${actions.join("")}</div>`
      : "";

    peopleList.innerHTML = `
      <div style="padding: var(--space-md); border: 1px solid var(--border); border-radius: 16px; background: rgba(255,255,255,0.02);">
        <div class="hint" style="white-space: pre-line;">${escapeHtml(msg)}</div>
        ${actionsHtml}
      </div>
    `;
    return;
  }

  peopleList.innerHTML = items.map(p => {
    const pid = p.id;
    const s = ensureState(pid);
    const occ = Number(p.occurrences || 0);
    const approval = getApproval(p);
    const avatar = getAvatarUrl(p);
    const roles = Array.isArray(p.roles) ? p.roles.join(", ") : "";

    const selected = s.candidates.find(c => c.wikidataId === s.selectedQid) || null;

    const approvalBadge = approval === "approved"
      ? `<span style="font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--border);">✅ approvato</span>`
      : (approval ? `<span style="font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--border);">${escapeHtml(approval)}</span>` : `<span class="hint">${i18nT("(non approvato)")}</span>`);

    const currentActions = avatar && approval !== "approved"
      ? `<button class="btn small primary" data-act="approve-current" data-id="${escapeHtml(pid)}">Approva attuale</button>`
      : ``;

    const candHtml = s.candidates.length
      ? `
        <div style="margin-top: var(--space-sm); display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-sm);">
          ${s.candidates.map(c => {
            const isSel = c.wikidataId === s.selectedQid;
            const desc = c.description ? `<div class="hint" style="margin-top:.25rem;">${escapeHtml(c.description)}</div>` : ``;
            const wiki = c.wikipediaUrl ? `<a class="hint" href="${escapeHtml(c.wikipediaUrl)}" target="_blank" rel="noopener">Wikipedia</a>` : `<a class="hint" href="https://www.wikidata.org/wiki/${escapeHtml(c.wikidataId)}" target="_blank" rel="noopener">Wikidata</a>`;
            return `
              <div style="border:1px solid var(--border); border-radius: 14px; padding: var(--space-sm); background: rgba(255,255,255,0.02);">
                <div style="display:flex; gap: .6rem; align-items:flex-start;">
                  <img src="${escapeHtml(c.avatarUrl)}" alt="" style="width:56px;height:56px;border-radius:12px; object-fit:cover; background: rgba(255,255,255,0.03);" loading="lazy"/>
                  <div style="flex:1; min-width:0;">
                    <div style="font-weight:600; line-height:1.2;">${escapeHtml(c.label || p.name || "")}</div>
                    <div class="hint" style="margin-top:.15rem;">${escapeHtml(c.wikidataId)}</div>
                    ${desc}
                    <div style="margin-top:.35rem; display:flex; gap:.6rem; align-items:center; justify-content:space-between;">
                      <button class="btn small ${isSel ? "primary" : "ghost"}" data-act="select" data-id="${escapeHtml(pid)}" data-qid="${escapeHtml(c.wikidataId)}">${isSel ? i18nT("Selezionato") : i18nT("Seleziona")}</button>
                      <div style="display:flex; gap:.5rem; align-items:center;">
                        ${wiki}
                        <button class="btn small danger" data-act="reject" data-id="${escapeHtml(pid)}" data-qid="${escapeHtml(c.wikidataId)}">No</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      `
      : ``;

    const previewHtml = selected
      ? `
        <div style="margin-top: var(--space-sm); display:flex; gap: var(--space-sm); align-items:center; justify-content:space-between;">
          <div style="display:flex; gap: var(--space-sm); align-items:center;">
            <img src="${escapeHtml(getCommonsImageUrl(selected.imageFilename, 160) || selected.avatarUrl)}" alt="" loading="lazy" decoding="async" style="width:72px;height:72px;border-radius:16px; object-fit:cover; background: rgba(255,255,255,0.03);"/>
            <div>
              <div style="font-weight:600;">${escapeHtml(selected.label || p.name || "")}</div>
              <div class="hint">${i18nT("Pronto per approvazione")}</div>
            </div>
          </div>
          <button class="btn small primary" data-act="approve" data-id="${escapeHtml(pid)}">Approva immagine</button>
        </div>
      `
      : ``;

    return `
      <div class="mod-item" data-person-row="${escapeHtml(pid)}">
        <div class="mod-main" style="gap: var(--space-sm);">
          <div style="display:flex; gap: var(--space-sm); align-items:center;">
            ${avatar
              ? `<img src="${escapeHtml(avatar)}" alt="" style="width:44px;height:44px;border-radius:14px; object-fit:cover; background: rgba(255,255,255,0.03);" loading="lazy"/>`
              : `<div style="width:44px;height:44px;border-radius:14px; background: rgba(255,255,255,0.04); display:flex; align-items:center; justify-content:center; font-weight:700;">?</div>`
            }
            <div>
              <div class="name" style="display:flex; align-items:center; gap:.5rem;">${escapeHtml(p.name || i18nT("(senza nome)"))} ${approvalBadge}</div>
              <div class="sub">occurrences: <span class="mono">${escapeHtml(String(occ))}</span>${roles ? ` · ${escapeHtml(roles)}` : ""}</div>
              <div class="sub">id: <span class="mono">${escapeHtml(pid)}</span></div>
            </div>
          </div>

          <div style="margin-top: var(--space-sm);">
            <div style="display:flex; gap: var(--space-sm); align-items:center; flex-wrap: wrap;">
              <input class="input" id="term-${escapeHtml(pid)}" value="${escapeHtml(s.term || p.name || "")}" style="min-width: 220px;" />
              <button class="btn small ghost" data-act="search" data-id="${escapeHtml(pid)}">${s.loading ? "Cerco…" : "Trova immagine"}</button>
              ${currentActions}
            </div>
            ${candHtml}
            ${previewHtml}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

async function loadPeople({ reset = false } = {}) {
  if (reset) {
    loaded = [];
    lastDoc = null;
    st.clear();
  }

  peopleList.innerHTML = `<div class="hint">${i18nT("Caricamento…")}</div>`;

  const qx = lastDoc
    ? query(collection(db, "people"), orderBy("occurrences", "desc"), startAfter(lastDoc), limit(200))
    : query(collection(db, "people"), orderBy("occurrences", "desc"), limit(200));

  const snap = await getDocs(qx);
  if (snap.empty) {
    render();
    return;
  }

  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  loaded.push(...items);
  lastDoc = snap.docs[snap.docs.length - 1];

  // init state terms
  for (const p of items) {
    const s = ensureState(p.id);
    if (!s.term) s.term = p.name || "";
  }

  render();
}

async function fetchCandidates(personId) {
  const p = loaded.find(x => x.id === personId);
  if (!p) return;
  const s = ensureState(personId);

  const input = document.getElementById(`term-${personId}`);
  const term = String(input?.value || p.name || "").trim();
  if (!term) return;
  s.term = term;

  s.loading = true;
  s.candidates = [];
  s.selectedQid = "";
  render();

  try {
    const exclude = getRejectedQids(p);
    const candidates = await searchWikidataPersonCandidates(term, {
      lang: "it",
      width: 96,
      limit: 6,
      excludeQids: exclude,
    });

    s.candidates = candidates || [];
    s.selectedQid = (s.candidates[0]?.wikidataId || "");
    if (!s.candidates.length) {
      toast(i18nT("Nessun candidato con immagine trovato."), "Avatar people");
    }
  } catch (e) {
    console.error(e);
    toast(e?.message || i18nT("Errore ricerca Wikidata"), "Avatar people");
  } finally {
    s.loading = false;
    render();
  }
}

async function approveCandidate(personId) {
  const p = loaded.find(x => x.id === personId);
  if (!p) return;
  const s = ensureState(personId);
  const selected = s.candidates.find(c => c.wikidataId === s.selectedQid);
  if (!selected) {
    toast(i18nT("Seleziona un candidato prima."), "Avatar people");
    return;
  }

  try {
    // 1) Scrive avatarUrl + cache (se popular) + metadata
    const res = await ensurePersonAvatar(personId, {
      name: p.name,
      wikidataId: selected.wikidataId,
      cacheToStorage: true,
      occurrences: Number(p.occurrences || 0),
      popularOnly: true,
      popularThreshold: POPULAR_AVATAR_THRESHOLD,
    });

    // 2) Marca come approvato (senza sovrascrivere l'oggetto avatar)
    await updateDoc(doc(db, "people", personId), {
      "avatar.approval": "approved",
      "avatar.approvedAt": serverTimestamp(),
      "avatar.approvedBy": me.uid,
      "avatar.approvedWikidataId": selected.wikidataId,
      "avatar.approvedImageFilename": selected.imageFilename || null,
      updatedAt: serverTimestamp(),
    });

    // Update local
    if (res?.avatarUrl) p.avatarUrl = res.avatarUrl;
    if (res?.avatar) p.avatar = res.avatar;
    p.avatar = p.avatar || {};
    p.avatar.approval = "approved";

    toast("Avatar approvato ✅", "Avatar people");
    render();
  } catch (e) {
    console.error(e);
    toast(e?.message || i18nT("Errore approvazione"), "Avatar people");
  }
}

async function approveCurrent(personId) {
  const p = loaded.find(x => x.id === personId);
  if (!p) return;

  const url = getAvatarUrl(p);
  if (!url) {
    toast(i18nT("Questa persona non ha un avatar attuale."), "Avatar people");
    return;
  }

  try {
    await updateDoc(doc(db, "people", personId), {
      "avatar.approval": "approved",
      "avatar.approvedAt": serverTimestamp(),
      "avatar.approvedBy": me.uid,
      updatedAt: serverTimestamp(),
    });
    p.avatar = p.avatar || {};
    p.avatar.approval = "approved";
    toast(i18nT("Segnato come approvato ✅"), "Avatar people");
    render();
  } catch (e) {
    console.error(e);
    toast(e?.message || i18nT("Errore"), "Avatar people");
  }
}

async function rejectCandidate(personId, qid) {
  const p = loaded.find(x => x.id === personId);
  if (!p || !qid) return;

  try {
    await updateDoc(doc(db, "people", personId), {
      "avatar.rejectedWikidataIds": arrayUnion(String(qid)),
      "avatar.lastRejectedAt": serverTimestamp(),
      "avatar.lastRejectedBy": me.uid,
      updatedAt: serverTimestamp(),
    });

    // Update local + UI
    p.avatar = p.avatar || {};
    const arr = Array.isArray(p.avatar.rejectedWikidataIds) ? p.avatar.rejectedWikidataIds : [];
    if (!arr.includes(String(qid))) arr.push(String(qid));
    p.avatar.rejectedWikidataIds = arr;

    const s = ensureState(personId);
    s.candidates = (s.candidates || []).filter(c => c.wikidataId !== qid);
    if (s.selectedQid === qid) s.selectedQid = s.candidates[0]?.wikidataId || "";

    toast("Ok, tolto dai suggerimenti.", "Avatar people");
    render();
  } catch (e) {
    console.error(e);
    toast(e?.message || i18nT("Errore"), "Avatar people");
  }
}

function wire(){
  const runToolbarAction = (button, action, loadingLabel) => {
    button?.addEventListener("click", () => runWithButtonLoading(button, async () => {
      try {
        await action();
      } catch (err) {
        console.error(err);
        toast(err?.message || i18nT("Errore"), "Avatar people", { type: "error" });
      }
    }, { loadingLabel }));
  };
  runToolbarAction(btnReload, () => loadPeople({ reset: true }), i18nT("Aggiornamento..."));
  runToolbarAction(btnMore, () => loadPeople({ reset: false }), i18nT("Caricamento..."));
  runToolbarAction(btnAuto, async () => {
    const items = filterPeople().slice(0, 8);
    for (const p of items) {
      const s = ensureState(p.id);
      if (s.candidates?.length) continue;
      await fetchCandidates(p.id);
    }
  }, i18nT("Ricerca..."));

  qInput?.addEventListener("input", () => render());
  roleSel?.addEventListener("change", () => render());
  onlyPopular?.addEventListener("change", () => render());
  onlyUnapproved?.addEventListener("change", () => render());

  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target?.closest?.("[data-act]");
    if (!btn) return;
    // (we are already behind an admin gate, but keep checks for write actions)

    const act = btn.getAttribute("data-act");
    const id = btn.getAttribute("data-id");
    const qid = btn.getAttribute("data-qid");
    // Actions that don't need an id
    if (act === "toggle-popular") {
      onlyPopular.checked = false;
      render();
      return;
    }
    if (act === "toggle-unapproved") {
      onlyUnapproved.checked = false;
      render();
      return;
    }
    if (act === "clear-search") {
      qInput.value = "";
      render();
      return;
    }
    if (act === "set-role-all") {
      roleSel.value = "all";
      render();
      return;
    }

    // Write actions require admin
    if (!canAdmin()) return;
    if (!id) return;

    if (act === "search") {
      return runWithButtonLoading(btn, () => fetchCandidates(id), { loadingLabel: i18nT("Ricerca...") });
    }
    if (act === "select") {
      const s = ensureState(id);
      s.selectedQid = String(qid || "");
      render();
      return;
    }
    if (act === "approve") {
      return runWithButtonLoading(btn, () => approveCandidate(id), { loadingLabel: i18nT("Approvazione...") });
    }
    if (act === "approve-current") {
      return runWithButtonLoading(btn, () => approveCurrent(id), { loadingLabel: i18nT("Approvazione...") });
    }
    if (act === "reject") {
      return runWithButtonLoading(btn, () => rejectCandidate(id, qid), { loadingLabel: i18nT("Rifiuto...") });
    }
  });
}

wire();

initAuthGuard({ requireAuth: true, onReady: async (user) => {
  me = user;
  meDoc = await getMyUserDoc(me.uid).catch(() => null);
  if (!canAdmin()) {
    gate.style.display = "block";
    root.style.display = "none";
    return;
  }
  gate.style.display = "none";
  root.style.display = "block";
  await loadPeople({ reset: true });
}});
