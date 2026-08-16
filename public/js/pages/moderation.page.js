import { qs, escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { toast } from "../components/toast.js";
import { initAuthGuard } from "../components/authGuard.js";
import { runWithButtonLoading } from "../utils/loading.js";
import { getMyUserDoc, getUserPublic } from "../api/users.api.js";

import {
  collection,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  getDocs,
  getDoc,
  getCountFromServer,
  doc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { approveTitleEdit, rejectTitleEdit } from "../api/titleEdits.api.js";
import { searchTitlesSmart, getTitleById, updateTitle } from "../api/titles.api.js";

const gate = qs("#gate");
const modRoot = qs("#modRoot");
const pendingTitles = qs("#pendingTitles");
const pendingEdits = qs("#pendingEdits");
const btnReloadTitles = qs("#btnReloadTitles");
const btnReloadEdits = qs("#btnReloadEdits");
const badgePendingTitles = qs("#badgePendingTitles");
const badgePendingEdits = qs("#badgePendingEdits");
const badgeTotalTitles = qs("#badgeTotalTitles");
const lastRefreshEl = qs("#lastRefresh");
const btnRefreshOverview = qs("#btnRefreshOverview");

// Users
const usersSearch = qs("#usersSearch");
const usersLevelFilter = qs("#usersLevelFilter");
const usersTrustedFilter = qs("#usersTrustedFilter");
const btnReloadUsers = qs("#btnReloadUsers");
const usersBody = qs("#usersBody");

// Titles manager
const tmSearch = qs("#tmSearch");
const btnTmSearch = qs("#btnTmSearch");
const tmResults = qs("#tmResults");
const tmForm = qs("#tmForm");
const tmName = qs("#tmName");
const tmYear = qs("#tmYear");
const tmStatus = qs("#tmStatus");
const tmGenres = qs("#tmGenres");
const tmDesc = qs("#tmDesc");
const btnTmSave = qs("#btnTmSave");

let me = null;
let meDoc = null;
let tmCurrent = null;

/* ===== CACHES ===== */
const usersCache = new Map();
const titlesCache = new Map();

async function ensureUsers(uids) {
  const uniq = [...new Set((uids || []).filter(Boolean))];
  const missing = uniq.filter(uid => !usersCache.has(uid));
  const batch = missing.slice(0, 40);
  const results = await Promise.all(
    batch.map(uid => getUserPublic(uid).catch(() => null))
  );
  results.forEach(u => { if (u?.uid) usersCache.set(u.uid, u); });
}

async function ensureTitles(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  const missing = uniq.filter(id => !titlesCache.has(id));
  const batch = missing.slice(0, 40);
  const results = await Promise.all(
    batch.map(async id => {
      try {
        const snap = await getDoc(doc(db, "titles", id));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
      } catch { return null; }
    })
  );
  results.forEach(t => { if (t?.id) titlesCache.set(t.id, t); });
}

function userName(uid) {
  if (!uid) return "—";
  const u = usersCache.get(uid);
  return u?.displayName || uid.slice(0, 8) + "…";
}

function titleLabel(id) {
  if (!id) return "—";
  const t = titlesCache.get(id);
  return t?.name || id.slice(0, 8) + "…";
}

/* ===== HELPERS ===== */

function canModerate() {
  const level = String(meDoc?.level || "base").trim().toLowerCase();
  const isManagerLevel = level === "associate" || level === "doctor";
  return !!me && (!!meDoc?.isAdmin || (!!meDoc?.trusted && isManagerLevel));
}

function canAdminUsers() {
  return !!meDoc?.isAdmin;
}

function canManageTitles() {
  const level = String(meDoc?.level || "base").trim().toLowerCase();
  return !!meDoc?.isAdmin || (meDoc?.trusted && level === "doctor");
}

const POSTER_PH_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;

function renderPosterThumb(posterPath, name) {
  if (posterPath) {
    return `<div class="mod-poster-thumb"><img src="${escapeHtml(posterPath)}" alt="${escapeHtml(name || "")}" loading="lazy" decoding="async"></div>`;
  }
  return `<div class="mod-poster-thumb"><div class="poster-ph">${POSTER_PH_SVG}</div></div>`;
}

function renderChips(arr) {
  if (!arr?.length) return "";
  return `<div class="mod-chips">${arr.map(g => `<span class="mod-genre-chip">${escapeHtml(g)}</span>`).join("")}</div>`;
}

function formatValue(val) {
  if (val === null || val === undefined) return `<span class="diff-empty">vuoto</span>`;
  if (Array.isArray(val)) return val.length ? escapeHtml(val.join(", ")) : `<span class="diff-empty">vuoto</span>`;
  if (typeof val === "object") return escapeHtml(JSON.stringify(val));
  return escapeHtml(String(val));
}

const DIFF_FIELDS = ["name", "type", "year", "genres", "originalName", "aliases", "posterPath"];
const FIELD_LABELS = {
  name: "Nome",
  type: "Tipo",
  year: "Anno",
  genres: i18nT("Generi"),
  originalName: "Nome orig.",
  aliases: "Alias",
  posterPath: "Poster",
};

function getEditSnapshots(editDoc) {
  const rootBefore = (editDoc?.before && typeof editDoc.before === "object") ? editDoc.before : null;
  const rootAfter = (editDoc?.after && typeof editDoc.after === "object") ? editDoc.after : null;
  const ch = (editDoc?.changes && typeof editDoc.changes === "object") ? editDoc.changes : null;
  const legacyBefore = (ch?._before && typeof ch._before === "object") ? ch._before : null;
  const legacyAfter = (ch?._after && typeof ch._after === "object") ? ch._after : null;
  return {
    before: rootBefore || legacyBefore,
    after: rootAfter || legacyAfter,
    rawChanges: ch,
  };
}

function renderDiff(before, after) {
  if (!before || !after) return "";
  const rows = [];
  const checkField = (label, bVal, aVal) => {
    const bStr = JSON.stringify(bVal);
    const aStr = JSON.stringify(aVal);
    if (bStr === aStr) return;
    rows.push(`
      <div class="diff-row">
        <div class="diff-field">${escapeHtml(label)}</div>
        <div class="diff-old">${formatValue(bVal)}</div>
        <div class="diff-new">${formatValue(aVal)}</div>
      </div>
    `);
  };

  for (const k of DIFF_FIELDS) {
    checkField(FIELD_LABELS[k] || k, before[k] ?? null, after[k] ?? null);
  }

  // Meta fields commonly editate
  const metaPairs = [
    ["Durata film (min)", before.meta?.durationMovie, after.meta?.durationMovie],
    ["Durata episodio (min)", before.meta?.durationEpisode, after.meta?.durationEpisode],
    ["Stagioni", before.meta?.seasonsCount, after.meta?.seasonsCount],
    ["Episodi/stagione", before.meta?.episodesPerSeason, after.meta?.episodesPerSeason],
  ];
  metaPairs.forEach(([label, b, a]) => checkField(label, b ?? null, a ?? null));

  // Status
  checkField("Status", before.status, after.status);

  if (!rows.length) return "";
  return `
    <div class="mod-diff">
      <div class="mod-diff-header"><span>Campo</span><span>${i18nT("Prima")}</span><span>${i18nT("Dopo")}</span></div>
      ${rows.join("")}
    </div>
  `;
}

function renderDiffFromChanges(rawChanges) {
  if (!rawChanges || typeof rawChanges !== "object") return "";
  const rows = [];
  const checkField = (label, aVal) => {
    rows.push(`
      <div class="diff-row">
        <div class="diff-field">${escapeHtml(label)}</div>
        <div class="diff-old"><span class="diff-empty">—</span></div>
        <div class="diff-new">${formatValue(aVal)}</div>
      </div>
    `);
  };

  for (const [k, v] of Object.entries(rawChanges)) {
    if (k.startsWith("_")) continue;
    if (k === "meta" && v && typeof v === "object") {
      const meta = v;
      if ("durationMovie" in meta) checkField("Durata film (min)", meta.durationMovie);
      if ("durationEpisode" in meta) checkField("Durata episodio (min)", meta.durationEpisode);
      if ("seasonsCount" in meta) checkField("Stagioni", meta.seasonsCount);
      if ("episodesPerSeason" in meta) checkField("Episodi/stagione", meta.episodesPerSeason);
      continue;
    }
    checkField(FIELD_LABELS[k] || k, v);
  }

  if (!rows.length) return "";
  return `
    <div class="mod-diff">
      <div class="mod-diff-header"><span>Campo</span><span>${i18nT("Prima")}</span><span>${i18nT("Dopo")}</span></div>
      ${rows.join("")}
    </div>
  `;
}

/* ===== CONFIRM DIALOG ===== */

function showConfirm({ title, message, confirmLabel = i18nT("Conferma"), danger = false, withReason = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "mod-confirm-overlay";

    const reasonHTML = withReason
      ? `<textarea placeholder="Motivo (opzionale)…" id="modConfirmReason"></textarea>`
      : "";

    const btnClass = danger ? "btn small danger" : "btn small primary";

    overlay.innerHTML = `
      <div class="mod-confirm-card">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        ${reasonHTML}
        <div class="mod-confirm-buttons">
          <button class="btn small ghost" data-confirm="cancel">${i18nT("Annulla")}</button>
          <button class="${btnClass}" data-confirm="ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;

    function close(result) {
      overlay.remove();
      resolve(result);
    }

    overlay.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-confirm]");
      if (!btn) {
        if (ev.target === overlay) close(null);
        return;
      }
      if (btn.dataset.confirm === "cancel") return close(null);
      const reason = withReason ? (overlay.querySelector("#modConfirmReason")?.value || "") : "";
      close({ confirmed: true, reason });
    });

    document.body.appendChild(overlay);
    const focusTarget = overlay.querySelector("textarea") || overlay.querySelector("[data-confirm='ok']");
    focusTarget?.focus();
  });
}

function formatTS(ms) {
  try {
    return new Date(ms).toLocaleString("it-IT", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  } catch {
    return "—";
  }
}

/* ===== OVERVIEW ===== */
async function loadOverview() {
  try {
    const [titlesCnt, editsCnt, totalTitlesCnt] = await Promise.all([
      getCountFromServer(query(collection(db, "titles"), where("status", "==", "pending"))),
      getCountFromServer(query(collection(db, "titleEdits"), where("status", "==", "pending"))),
      getCountFromServer(collection(db, "titles")),
    ]);
    if (badgePendingTitles) badgePendingTitles.textContent = titlesCnt.data().count;
    if (badgePendingEdits) badgePendingEdits.textContent = editsCnt.data().count;
    if (badgeTotalTitles) badgeTotalTitles.textContent = totalTitlesCnt.data().count;
    if (lastRefreshEl) lastRefreshEl.textContent = formatTS(Date.now());
  } catch (err) {
    console.warn("loadOverview", err);
    toast("Impossibile aggiornare i contatori");
  }
}

/* ===== USERS ===== */
async function loadUsers() {
  if (!usersBody) return;
  usersBody.innerHTML = `<div class="hint" style="padding:12px;">Caricamento…</div>`;
  try {
    const q = query(collection(db, "users"), orderBy("displayNameLower"), limit(60));
    const snap = await getDocs(q);
    const rows = snap.docs.map(d => ({ uid: d.id, ...d.data() }));

    const term = (usersSearch?.value || "").trim().toLowerCase();
    const levelFilter = usersLevelFilter?.value || "";
    const trustedFilter = usersTrustedFilter?.value || "";

    const filtered = rows.filter(u => {
      const matchesTerm = term ? (u.displayNameLower || "").includes(term) : true;
      const matchesLevel = levelFilter ? (String(u.level || "base").toLowerCase() === levelFilter) : true;
      const matchesTrusted = trustedFilter === "" ? true : (!!u.trusted === (trustedFilter === "true"));
      return matchesTerm && matchesLevel && matchesTrusted;
    });

    usersBody.innerHTML = filtered.map(u => {
      const level = String(u.level || "base").toLowerCase();
      const canEdit = canAdminUsers();
      return `
        <div class="table-row">
          <div data-label="Nome"><strong>${escapeHtml(u.displayName || "(senza nome)")}</strong></div>
          <div data-label="UID" class="hint" style="word-break:break-all;">${escapeHtml(u.uid)}</div>
          <div data-label="Trusted">
            <label style="display:flex;align-items:center;gap:6px;">
              <input type="checkbox" data-action="trusted" data-uid="${escapeHtml(u.uid)}" ${u.trusted ? "checked" : ""} ${canEdit ? "" : "disabled"}>
              <span class="hint">trusted</span>
            </label>
          </div>
          <div data-label="Level">
            <select class="input" data-action="level" data-uid="${escapeHtml(u.uid)}" ${canEdit ? "" : "disabled"}>
              ${["base","associate","doctor"].map(l => `<option value="${l}" ${l===level?"selected":""}>${l}</option>`).join("")}
            </select>
          </div>
          <div data-label="Azione">
            <button class="btn small ghost" data-action="save-user" data-uid="${escapeHtml(u.uid)}" ${canEdit ? "" : "disabled"}>${i18nT("Salva")}</button>
          </div>
        </div>
      `;
    }).join("") || `<div class="hint" style="padding:12px;">${i18nT("Nessun utente trovato")}</div>`;
  } catch (err) {
    console.error(err);
    usersBody.innerHTML = `<div class="hint" style="padding:12px;">Errore caricamento</div>`;
  }
}

async function saveUserRow(uid) {
  if (!canAdminUsers()) {
    toast(i18nT("Solo admin può modificare gli utenti"));
    return;
  }
  const row = usersBody.querySelector(`[data-action="save-user"][data-uid="${CSS.escape(uid)}"]`)?.closest(".table-row");
  if (!row) return;
  const trigger = row.querySelector('[data-action="save-user"]');
  const trustedInput = row.querySelector('[data-action="trusted"]');
  const levelSelect = row.querySelector('[data-action="level"]');
  const updates = {
    trusted: !!trustedInput?.checked,
    level: String(levelSelect?.value || "base").toLowerCase(),
    updatedAt: serverTimestamp(),
  };
  await runWithButtonLoading(trigger, async () => {
    try {
      await updateDoc(doc(db, "users", uid), updates);
      toast("Utente aggiornato", i18nT("Moderazione"), { type: "success" });
    } catch (err) {
      console.error(err);
      toast("Errore salvataggio utente", i18nT("Moderazione"), { type: "error" });
    }
  }, { loadingLabel: i18nT("Salvataggio...") });
}

/* ===== LOAD PENDING TITLES ===== */

async function loadPendingTitles() {
  pendingTitles.innerHTML = `<div class="hint">Caricamento…</div>`;
  const q = query(
    collection(db, "titles"),
    where("status", "==", "pending"),
    orderBy("createdAt", "desc"),
    limit(50)
  );
  const snap = await getDocs(q);
  if (snap.empty) {
    pendingTitles.innerHTML = `<div class="hint">${i18nT("Nessun titolo in pending.")}</div>`;
    return;
  }
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  await ensureUsers(rows.map(t => t.createdBy));

  pendingTitles.innerHTML = rows.map(t => {
    const year = t.year ? ` (${escapeHtml(String(t.year))})` : "";
    const typeLbl = t.type ? escapeHtml(t.type) : "";
    const creatorUid = t.createdBy || "";
    const creatorName = userName(creatorUid);
    const directors = (t.meta?.directors || []).map(d => d.name || d).filter(Boolean);
    const dirLine = directors.length ? `<div class="mod-meta">Regia: ${escapeHtml(directors.join(", "))}</div>` : "";

    return `
      <div class="mod-card">
        <div class="mod-card-body">
          ${renderPosterThumb(t.posterPath, t.name)}
          <div class="mod-info">
            <div class="mod-title">
              <a href="/title.html?id=${encodeURIComponent(t.id)}" target="_blank">${escapeHtml(t.name || "(senza titolo)")}${year}</a>
            </div>
            <div class="mod-meta">
              ${typeLbl ? typeLbl + " · " : ""}Proposto da
              <a class="mod-user-link" href="/user.html?uid=${encodeURIComponent(creatorUid)}" target="_blank">${escapeHtml(creatorName)}</a>
            </div>
            ${dirLine}
            ${renderChips(t.genres)}
          </div>
        </div>
        <div class="mod-actions">
          <button class="btn small primary" data-act="approve-title" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name || "")}">${i18nT("Approva")}</button>
          <button class="btn small danger" data-act="reject-title" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name || "")}">${i18nT("Rifiuta")}</button>
        </div>
      </div>
    `;
  }).join("");
}

/* ===== LOAD PENDING EDITS ===== */

async function loadPendingEdits() {
  pendingEdits.innerHTML = `<div class="hint">Caricamento…</div>`;
  const q = query(
    collection(db, "titleEdits"),
    where("status", "==", "pending"),
    orderBy("createdAt", "desc"),
    limit(50)
  );
  const snap = await getDocs(q);
  if (snap.empty) {
    pendingEdits.innerHTML = `<div class="hint">${i18nT("Nessuna proposta in pending.")}</div>`;
    return;
  }
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const userIds = rows.map(e => e.requestedBy || e.proposedBy).filter(Boolean);
  const titleIds = rows.map(e => e.targetTitleId || e.titleId).filter(Boolean);
  await Promise.all([ensureUsers(userIds), ensureTitles(titleIds)]);

  pendingEdits.innerHTML = rows.map(e => {
    const { before, after, rawChanges } = getEditSnapshots(e);
    const titleId = e.targetTitleId || e.titleId || "";
    const who = e.requestedBy || e.proposedBy || "";
    const type = e.type || "update";
    const isCreate = type === "create";

    const resolvedTitleLabel = titleLabel(titleId);
    const titleName = isCreate
      ? (after?.name || "(nuovo titolo)")
      : (resolvedTitleLabel !== "—" ? resolvedTitleLabel : (after?.name || "(titolo)"));

    const posterSrc = isCreate ? after?.posterPath : (titlesCache.get(titleId)?.posterPath || after?.posterPath);

    let diffHTML = "";
    if (!isCreate) {
      diffHTML = (before && after) ? renderDiff(before, after) : "";
      if (!diffHTML) diffHTML = renderDiffFromChanges(rawChanges);
    }

    const createPreview = isCreate && after ? `
      <div class="mod-meta">${after.type ? escapeHtml(after.type) : ""}${after.year ? " · " + escapeHtml(String(after.year)) : ""}</div>
      ${renderChips(after.genres)}
    ` : "";

    return `
      <div class="mod-card">
        <div class="mod-card-body">
          ${renderPosterThumb(posterSrc, titleName)}
          <div class="mod-info">
            <div class="mod-title">
              <span class="mod-type-badge ${escapeHtml(type)}">${isCreate ? i18nT("Nuovo") : i18nT("Modifica")}</span>
              ${titleId
                ? `<a href="/title.html?id=${encodeURIComponent(titleId)}" target="_blank">${escapeHtml(titleName)}</a>`
                : escapeHtml(titleName)
              }
            </div>
            <div class="mod-meta">
              Da <a class="mod-user-link" href="/user.html?uid=${encodeURIComponent(who)}" target="_blank">${escapeHtml(userName(who))}</a>
            </div>
            ${createPreview}
            ${diffHTML}
          </div>
        </div>
        <div class="mod-actions">
          ${titleId ? `<a class="btn small ghost" href="/title.html?id=${encodeURIComponent(titleId)}" target="_blank">${i18nT("Apri titolo")}</a>` : ""}
          <button class="btn small primary" data-act="approve-edit" data-id="${escapeHtml(e.id)}" data-name="${escapeHtml(titleName)}">${isCreate ? i18nT("Crea") : "Applica"}</button>
          <button class="btn small danger" data-act="reject-edit" data-id="${escapeHtml(e.id)}" data-name="${escapeHtml(titleName)}">${i18nT("Rifiuta")}</button>
        </div>
      </div>
    `;
  }).join("");
}

/* ===== TITLES MANAGER ===== */
function renderTmResults(list) {
  if (!tmResults) return;
  tmResults.innerHTML = list.map(t => `
    <div class="mod-card">
      <div class="mod-card-body">
        <div class="mod-info">
          <div class="mod-title">${escapeHtml(t.name || "(senza titolo)")}${t.year ? ` (${escapeHtml(String(t.year))})` : ""}</div>
          <div class="mod-meta">${escapeHtml(t.type || "")} · ${escapeHtml(t.status || "")}</div>
        </div>
      </div>
      <div class="mod-actions">
        <button class="btn small ghost" data-tid="${escapeHtml(t.id)}">${i18nT("Modifica")}</button>
      </div>
    </div>
  `).join("") || `<div class="hint">${i18nT("Nessun risultato")}</div>`;
}

async function searchTitlesManager() {
  if (!tmResults) return;
  const q = (tmSearch?.value || "").trim();
  if (!q) {
    tmResults.innerHTML = `<div class="hint">${i18nT("Inserisci un nome")}</div>`;
    return;
  }
  tmResults.innerHTML = `<div class="hint">${i18nT("Ricerca…")}</div>`;
  try {
    const res = await searchTitlesSmart(q, 12);
    renderTmResults(res);
  } catch (err) {
    console.error(err);
    tmResults.innerHTML = `<div class="hint">Errore ricerca</div>`;
  }
}

async function openTitleEditor(id) {
  if (!tmForm) return;
  tmForm.style.display = "none";
  tmForm.dataset.tid = "";
  tmCurrent = null;
  try {
    const t = await getTitleById(id);
    if (!t) {
      toast(i18nT("Titolo non trovato."));
      return;
    }
    tmCurrent = t;
    tmForm.dataset.tid = t.id;
    tmName.value = t.name || "";
    tmYear.value = t.year || "";
    tmStatus.value = t.status || "approved";
    tmGenres.value = Array.isArray(t.genres) ? t.genres.join(", ") : "";
    tmDesc.value = t.description || "";
    tmForm.style.display = "block";
  } catch (err) {
    console.error(err);
    toast("Errore apertura titolo");
  }
}

async function saveTitleEditor() {
  if (!tmCurrent) return;
  if (!canManageTitles()) {
    toast(i18nT("Solo admin/doctor possono modificare i titoli"));
    return;
  }
  btnTmSave.disabled = true;
  btnTmSave.textContent = i18nT("Salvataggio...");
  try {
    const genres = (tmGenres.value || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    const data = {
      name: tmName.value.trim() || tmCurrent.name,
      year: tmYear.value ? Number(tmYear.value) : null,
      status: tmStatus.value === "pending" ? "pending" : "approved",
      genres,
      description: tmDesc.value.trim() || null,
    };
    await updateTitle(tmCurrent.id, data);
    toast("Titolo aggiornato");
  } catch (err) {
    console.error(err);
    toast("Errore salvataggio titolo");
  } finally {
    btnTmSave.disabled = false;
    btnTmSave.textContent = i18nT("Salva");
  }
}

/* ===== ACTIONS ===== */

async function approveTitle(titleId) {
  await updateDoc(doc(db, "titles", titleId), {
    status: "approved",
    approvedAt: serverTimestamp(),
    approvedBy: me.uid,
  });
}

async function rejectTitle(titleId) {
  await updateDoc(doc(db, "titles", titleId), {
    status: "rejected",
    rejectedAt: serverTimestamp(),
    rejectedBy: me.uid,
  });
}

function wireActions() {
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target?.closest?.("[data-act]");
    if (!btn) return;
    if (!canModerate()) return;

    const act = btn.getAttribute("data-act");
    const id = btn.getAttribute("data-id");
    const name = btn.getAttribute("data-name") || id;
    if (!id) return;

    try {
      if (act === "approve-title") {
        const result = await showConfirm({
          title: "Approva titolo",
          message: i18nT("Vuoi approvare \"{name}\"? Sarà visibile a tutti.", { name }),
          confirmLabel: i18nT("Approva"),
        });
        if (!result) return;
        await runWithButtonLoading(btn, async () => {
          await approveTitle(id);
          toast("Titolo approvato.", i18nT("Moderazione"), { type: "success" });
          await loadPendingTitles();
        }, { loadingLabel: i18nT("Approvazione...") });
        return;
      }

      if (act === "reject-title") {
        const result = await showConfirm({
          title: "Rifiuta titolo",
          message: i18nT("Vuoi rifiutare \"{name}\"?", { name }),
          confirmLabel: i18nT("Rifiuta"),
          danger: true,
        });
        if (!result) return;
        await runWithButtonLoading(btn, async () => {
          await rejectTitle(id);
          toast("Titolo rifiutato.", i18nT("Moderazione"), { type: "success" });
          await loadPendingTitles();
        }, { loadingLabel: i18nT("Rifiuto...") });
        return;
      }

      if (act === "approve-edit") {
        const result = await showConfirm({
          title: "Applica modifica",
          message: i18nT("Vuoi applicare questa modifica a \"{name}\"? I dati del titolo saranno aggiornati.", { name }),
          confirmLabel: "Applica",
        });
        if (!result) return;
        await runWithButtonLoading(btn, async () => {
          await approveTitleEdit(id, me.uid);
          toast("Modifica applicata.", i18nT("Moderazione"), { type: "success" });
          await loadPendingEdits();
        }, { loadingLabel: i18nT("Applicazione...") });
        return;
      }

      if (act === "reject-edit") {
        const result = await showConfirm({
          title: "Rifiuta modifica",
          message: i18nT("Vuoi rifiutare questa proposta per \"{name}\"?", { name }),
          confirmLabel: i18nT("Rifiuta"),
          danger: true,
          withReason: true,
        });
        if (!result) return;
        await runWithButtonLoading(btn, async () => {
          await rejectTitleEdit(id, me.uid, result.reason || "");
          toast("Modifica rifiutata.", i18nT("Moderazione"), { type: "success" });
          await loadPendingEdits();
        }, { loadingLabel: i18nT("Rifiuto...") });
        return;
      }
    } catch (e) {
      console.error(e);
      toast(e?.message || i18nT("Errore"), i18nT("Moderazione"), { type: "error" });
    }
  });
}

function wireReloadButton(button, action) {
  button?.addEventListener("click", () => runWithButtonLoading(button, async () => {
    try {
      await action();
    } catch (err) {
      console.error(err);
      toast(i18nT("Errore durante l'aggiornamento."), i18nT("Moderazione"), { type: "error" });
    }
  }, { loadingLabel: i18nT("Aggiornamento...") }));
}

wireReloadButton(btnReloadTitles, loadPendingTitles);
wireReloadButton(btnReloadEdits, loadPendingEdits);

// Users
if (usersBody) {
  usersBody.addEventListener("click", (e) => {
    const uid = e.target?.dataset?.uid;
    if (!uid) return;
    if (e.target.dataset.action === "save-user") {
      saveUserRow(uid);
    }
  });
}
wireReloadButton(btnReloadUsers, loadUsers);
usersSearch?.addEventListener("input", () => loadUsers());
usersLevelFilter?.addEventListener("change", () => loadUsers());
usersTrustedFilter?.addEventListener("change", () => loadUsers());

// Overview
wireReloadButton(btnRefreshOverview, loadOverview);

// Titles manager
btnTmSearch?.addEventListener("click", () => searchTitlesManager());
tmResults?.addEventListener("click", (e) => {
  const tid = e.target?.dataset?.tid;
  if (tid) openTitleEditor(tid);
});
btnTmSave?.addEventListener("click", () => saveTitleEditor());

wireActions();

initAuthGuard({ requireAuth: true, onReady: async (user) => {
  me = user;
  meDoc = await getMyUserDoc(me.uid).catch(() => null);
  if (!canModerate()) {
    gate.style.display = "block";
    modRoot.style.display = "none";
    return;
  }
  gate.style.display = "none";
  modRoot.style.display = "block";
  await loadOverview();
  await loadPendingTitles();
  await loadPendingEdits();
  await loadUsers();
}});
