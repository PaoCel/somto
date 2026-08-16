import { qs, escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { toast } from "../components/toast.js";
import { initAuthGuard } from "../components/authGuard.js";
import { getMyUserDoc } from "../api/users.api.js";
import { searchTitlesSmart } from "../api/titles.api.js";
import {
  publishOfficialUpdate as publishOfficialUpdateApi,
  unpublishOfficialUpdate as unpublishOfficialUpdateApi,
  listOfficialUpdates,
} from "../api/officialUpdates.api.js";

const gate = qs("#gate");
const mainContent = qs("#mainContent");

const titleInput = qs("#titleInput");
const titleCounter = qs("#titleCounter");
const slugInput = qs("#slugInput");
const textInput = qs("#textInput");
const textCounter = qs("#textCounter");
const summaryInput = qs("#summaryInput");
const summaryCounter = qs("#summaryCounter");
const typeSelect = qs("#typeSelect");
const titleSearchInput = qs("#titleSearchInput");
const titleSearchResults = qs("#titleSearchResults");
const linkedChips = qs("#linkedChips");
const linkedCountLabel = qs("#linkedCountLabel");
const sourceUrlsInput = qs("#sourceUrlsInput");
const audienceInput = qs("#audienceInput");
const scheduledAtInput = qs("#scheduledAtInput");

const previewBtn = qs("#previewBtn");
const draftBtn = qs("#draftBtn");
const publishBtn = qs("#publishBtn");
const previewPanel = qs("#previewPanel");
const previewSlug = qs("#previewSlug");
const previewPostId = qs("#previewPostId");
const previewRecipientCount = qs("#previewRecipientCount");
const previewWarnings = qs("#previewWarnings");

const reloadListBtn = qs("#reloadListBtn");
const updatesBody = qs("#updatesBody");

const MAX_LINKED_TITLES = 10;
const MAX_SOURCE_URLS = 6;

let me = null;
let selectedLinkedTitles = []; // [{id, name, year, type}]
let slugTouched = false;
let searchTimer = 0;
let lastPreview = null;

function fmtInt(value) {
  return new Intl.NumberFormat("it-IT").format(Math.round(Number(value || 0)));
}

function fmtDate(value) {
  if (!value) return "-";
  const d = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

// Stessa funzione dello slugify server (functions/lib/officialUpdates.js) —
// duplicata qui per UX immediata (auto-generazione mentre si scrive il
// titolo); il server ri-applica comunque lo slugify sul valore ricevuto,
// quindi un eventuale disallineamento client non puo' produrre uno slug
// invalido, solo un'anteprima leggermente diversa dal risultato finale.
function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

function parseLines(value, max) {
  return String(value || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function setButtonLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = !!loading;
  btn.dataset.loading = loading ? "true" : "false";
}

function bindCounter(input, counterEl, max) {
  if (!input || !counterEl) return;
  const update = () => {
    const len = input.value.length;
    counterEl.textContent = `${len}/${max}`;
    counterEl.classList.toggle("char-counter--warn", len > max);
  };
  input.addEventListener("input", update);
  update();
}

/* ===== Titoli collegati: ricerca + chip ===== */

function renderSearchResults(rows) {
  const selectedIds = new Set(selectedLinkedTitles.map((t) => t.id));
  const filtered = (rows || []).filter((r) => r?.id && !selectedIds.has(r.id));
  if (!filtered.length) {
    titleSearchResults.innerHTML = "";
    titleSearchResults.hidden = true;
    return;
  }
  titleSearchResults.hidden = false;
  titleSearchResults.innerHTML = filtered.map((r) => `
    <button type="button" class="editorial-search-result"
      data-id="${escapeHtml(r.id)}"
      data-name="${escapeHtml(r.name || r.id)}"
      data-year="${escapeHtml(r.year != null ? String(r.year) : "")}"
      data-type="${escapeHtml(r.type || "")}">
      <strong>${escapeHtml(r.name || r.id)}</strong>
      <span>${escapeHtml(r.year != null ? String(r.year) : "-")} · ${r.type === "tv" ? i18nT("Serie") : i18nT("Film")} · ${escapeHtml(r.id)}</span>
    </button>
  `).join("");
}

function renderChips() {
  if (!selectedLinkedTitles.length) {
    linkedChips.innerHTML = `<span class="analytics-muted">${i18nT("Nessun titolo collegato.")}</span>`;
  } else {
    linkedChips.innerHTML = selectedLinkedTitles.map((t) => `
      <span class="editorial-chip">
        <span class="editorial-chip-label">${escapeHtml(t.name || t.id)}</span>
        <span class="editorial-chip-id">${escapeHtml(t.id)}</span>
        <button type="button" class="editorial-chip-remove" data-remove-id="${escapeHtml(t.id)}" aria-label="Rimuovi ${escapeHtml(t.name || t.id)}">&times;</button>
      </span>
    `).join("");
  }
  linkedCountLabel.textContent = `${selectedLinkedTitles.length}/${MAX_LINKED_TITLES}`;
}

function addLinkedTitle(t) {
  if (!t?.id) return;
  if (selectedLinkedTitles.some((x) => x.id === t.id)) return;
  if (selectedLinkedTitles.length >= MAX_LINKED_TITLES) {
    toast(`Massimo ${MAX_LINKED_TITLES} titoli collegati.`, "Titoli collegati");
    return;
  }
  selectedLinkedTitles.push(t);
  renderChips();
}

function removeLinkedTitle(id) {
  selectedLinkedTitles = selectedLinkedTitles.filter((t) => t.id !== id);
  renderChips();
}

titleSearchInput?.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  const term = titleSearchInput.value.trim();
  if (term.length < 2) {
    renderSearchResults([]);
    return;
  }
  searchTimer = window.setTimeout(async () => {
    try {
      const rows = await searchTitlesSmart(term, 8);
      renderSearchResults(rows);
    } catch (err) {
      console.error(err);
      renderSearchResults([]);
    }
  }, 250);
});

titleSearchResults?.addEventListener("click", (event) => {
  const btn = event.target.closest(".editorial-search-result");
  if (!btn) return;
  addLinkedTitle({
    id: btn.dataset.id,
    name: btn.dataset.name,
    year: btn.dataset.year || null,
    type: btn.dataset.type || null,
  });
  titleSearchInput.value = "";
  renderSearchResults([]);
  titleSearchInput.focus();
});

document.addEventListener("click", (event) => {
  if (!titleSearchResults || titleSearchResults.hidden) return;
  if (event.target.closest(".editorial-search-wrap")) return;
  titleSearchResults.hidden = true;
});

linkedChips?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-remove-id]");
  if (!btn) return;
  removeLinkedTitle(btn.dataset.removeId);
});

/* ===== Slug auto-generato dal titolo (finche' non lo si edita a mano) ===== */

slugInput?.addEventListener("input", () => {
  slugTouched = true;
});

titleInput?.addEventListener("input", () => {
  if (!slugTouched) slugInput.value = slugify(titleInput.value);
});

bindCounter(titleInput, titleCounter, 160);
bindCounter(textInput, textCounter, 2000);
bindCounter(summaryInput, summaryCounter, 240);

/* ===== Form: raccolta + validazione ===== */

// `datetime-local` non porta fuso: il valore e' l'ora locale dell'admin.
// new Date(value) lo interpreta nel fuso del browser → ISO corretto.
function readScheduledAtIso() {
  const raw = String(scheduledAtInput?.value || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function buildPayload({ dryRun, status }) {
  const sourceUrls = parseLines(sourceUrlsInput.value, MAX_SOURCE_URLS);
  const audienceUids = parseCsv(audienceInput.value);
  const scheduledAt = status === "draft" ? readScheduledAtIso() : "";
  return {
    ...(scheduledAt ? { scheduledAt } : {}),
    title: titleInput.value.trim().slice(0, 160),
    slug: slugInput.value.trim() || slugify(titleInput.value),
    text: textInput.value.trim().slice(0, 2000),
    summary: summaryInput.value.trim().slice(0, 240),
    updateType: typeSelect.value,
    linkedTitleIds: selectedLinkedTitles.map((t) => t.id),
    sourceUrls,
    audienceUids,
    status,
    dryRun,
  };
}

function validateForm() {
  const errors = [];
  const title = titleInput.value.trim();
  const text = textInput.value.trim();
  if (!title) errors.push(i18nT("Il titolo è obbligatorio."));
  else if (title.length > 160) errors.push(i18nT("Il titolo supera i 160 caratteri."));
  if (!text) errors.push(i18nT("Il testo è obbligatorio."));
  else if (text.length > 2000) errors.push(i18nT("Il testo supera i 2000 caratteri."));
  if (summaryInput.value.trim().length > 240) errors.push(i18nT("Il sommario supera i 240 caratteri."));
  if (!selectedLinkedTitles.length) errors.push(i18nT("Collega almeno un titolo."));
  if (selectedLinkedTitles.length > MAX_LINKED_TITLES) errors.push(`Massimo ${MAX_LINKED_TITLES} titoli collegati.`);
  return errors;
}

function renderPreviewPanel(result) {
  if (!result) {
    previewPanel.hidden = true;
    return;
  }
  previewPanel.hidden = false;
  previewSlug.textContent = result.slug || "-";
  previewPostId.textContent = result.postId || "-";
  previewRecipientCount.textContent = `${fmtInt(result.recipientCount)} utenti`;
  renderWarnings(result.warnings);
}

// La notifica ripete il sommario: un annuncio scritto in ritardo arriva a chi
// la stagione l'ha gia' iniziata. Il backend lo segnala, qui si vede.
function renderWarnings(warnings) {
  if (!previewWarnings) return;
  const messages = (Array.isArray(warnings) ? warnings : [])
    .map((row) => String(row?.message || "").trim())
    .filter(Boolean);
  previewWarnings.hidden = !messages.length;
  previewWarnings.textContent = messages.join(" ");
}

/* ===== Azioni: anteprima / bozza / pubblica ===== */

previewBtn?.addEventListener("click", async () => {
  const errors = validateForm();
  if (errors.length) {
    toast(errors[0], "Modulo incompleto");
    return;
  }
  setButtonLoading(previewBtn, true);
  try {
    const payload = buildPayload({ dryRun: true, status: "published" });
    const res = await publishOfficialUpdateApi(payload);
    lastPreview = res;
    renderPreviewPanel(res);
    toast(`Raggiungerebbe ${fmtInt(res?.recipientCount)} utenti.`, "Anteprima");
  } catch (err) {
    console.error(err);
    toast(err?.message || "Errore durante l'anteprima.", i18nT("Errore"));
  } finally {
    setButtonLoading(previewBtn, false);
  }
});

draftBtn?.addEventListener("click", async () => {
  const errors = validateForm();
  if (errors.length) {
    toast(errors[0], "Modulo incompleto");
    return;
  }
  setButtonLoading(draftBtn, true);
  try {
    const payload = buildPayload({ dryRun: false, status: "draft" });
    const res = await publishOfficialUpdateApi(payload);
    toast(
      payload.scheduledAt
        ? i18nT("Bozza programmata per {v0}.", { v0: new Date(payload.scheduledAt).toLocaleString("it-IT") })
        : "Bozza salvata.",
      "Aggiornamenti ufficiali"
    );
    void loadUpdatesList();
    return res;
  } catch (err) {
    console.error(err);
    toast(err?.message || i18nT("Errore durante il salvataggio della bozza."), i18nT("Errore"));
  } finally {
    setButtonLoading(draftBtn, false);
  }
});

publishBtn?.addEventListener("click", async () => {
  const errors = validateForm();
  if (errors.length) {
    toast(errors[0], "Modulo incompleto");
    return;
  }
  const recipientsNote = lastPreview
    ? ` (ultima anteprima: ${fmtInt(lastPreview.recipientCount)} utenti)`
    : "";
  const warningNote = (lastPreview?.warnings || [])
    .map((row) => String(row?.message || "").trim())
    .filter(Boolean)
    .join("\n");
  const ok = window.confirm(
    i18nT("Pubblicare questo aggiornamento ufficiale?{recipientsNote}\n\n", { recipientsNote }) +
    i18nT("Verrà creato un post pubblico e notificati gli utenti interessati ai titoli collegati.") +
    (warningNote ? `\n\n${warningNote}` : "")
  );
  if (!ok) return;

  setButtonLoading(publishBtn, true);
  try {
    const payload = buildPayload({ dryRun: false, status: "published" });
    const res = await publishOfficialUpdateApi(payload);
    toast(
      `Pubblicato. Feed: ${fmtInt(res?.feedEventsWritten)}, notifiche: ${fmtInt(res?.notificationsWritten)}.`,
      "Pubblicato"
    );
    void loadUpdatesList();
  } catch (err) {
    console.error(err);
    toast(err?.message || i18nT("Errore durante la pubblicazione."), i18nT("Errore"));
  } finally {
    setButtonLoading(publishBtn, false);
  }
});

/* ===== Elenco pubblicati/bozze ===== */

function statusBadgeHtml(status) {
  const map = {
    draft: ["Bozza", "editorial-badge--draft"],
    published: ["Pubblicato", "editorial-badge--published"],
    retired: ["Ritirato", "editorial-badge--retired"],
  };
  const [label, cls] = map[status] || [status || "-", "editorial-badge--draft"];
  return `<span class="editorial-badge ${cls}">${escapeHtml(label)}</span>`;
}

// Una bozza con `scheduledAt` non resta ferma: la pubblica lo scheduler.
// Mostrarlo in elenco evita di ripubblicarla a mano per sbaglio.
function scheduledHintHtml(row) {
  if (row?.status !== "draft" || !row?.scheduledAt) return "";
  const when = fmtDate(row.scheduledAt);
  if (!when || when === "-") return "";
  return `<div class="analytics-muted">Programmata: ${escapeHtml(when)}</div>`;
}

function renderUpdatesList(rows) {
  if (!rows.length) {
    updatesBody.innerHTML = `<tr><td colspan="6"><div class="analytics-empty">${i18nT("Nessun aggiornamento ancora.")}</div></td></tr>`;
    return;
  }
  updatesBody.innerHTML = rows.map((row) => {
    const slug = row.slug || row.id;
    const title = row.title || slug;
    return `
      <tr>
        <td><strong>${escapeHtml(title)}</strong></td>
        <td>${escapeHtml(slug)}</td>
        <td>${statusBadgeHtml(row.status)}${scheduledHintHtml(row)}</td>
        <td>${escapeHtml(fmtDate(row.updatedAt))}</td>
        <td>${fmtInt(row.audienceCount)}</td>
        <td>
          ${row.status === "published"
            ? `<button class="btn small danger" type="button" data-unpublish="${escapeHtml(slug)}" data-title="${escapeHtml(title)}">Ritira</button>`
            : ""}
        </td>
      </tr>
    `;
  }).join("");
}

async function loadUpdatesList() {
  updatesBody.innerHTML = `<tr><td colspan="6"><div class="analytics-empty">Carico...</div></td></tr>`;
  try {
    const rows = await listOfficialUpdates({ max: 30 });
    renderUpdatesList(rows);
  } catch (err) {
    const code = String(err?.code || "");
    if (code.includes("permission-denied")) {
      updatesBody.innerHTML = `<tr><td colspan="6"><div class="analytics-empty">${i18nT("L'elenco richiede il deploy delle rules aggiornate. Puoi comunque comporre, vedere l'anteprima e pubblicare.")}</div></td></tr>`;
    } else {
      console.error(err);
      updatesBody.innerHTML = `<tr><td colspan="6"><div class="analytics-empty">Errore nel caricamento dell'elenco: ${escapeHtml(err?.message || "sconosciuto")}</div></td></tr>`;
    }
  }
}

updatesBody?.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-unpublish]");
  if (!btn) return;
  const slug = btn.dataset.unpublish;
  const title = btn.dataset.title || slug;
  const ok = window.confirm(i18nT("Ritirare l'aggiornamento \"{title}\"? Il post pubblico verrà rimosso e le notifiche cancellate.", { title }));
  if (!ok) return;

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Ritiro...";
  try {
    const res = await unpublishOfficialUpdateApi({ slug });
    toast(
      `Ritirato. Feed rimossi: ${fmtInt(res?.feedEventsDeleted)}, notifiche rimosse: ${fmtInt(res?.notificationsDeleted)}.`,
      "Ritirato"
    );
    void loadUpdatesList();
  } catch (err) {
    const code = String(err?.code || "");
    if (code.includes("not-found") || code.includes("internal")) {
      toast(i18nT("Richiede il deploy delle functions aggiornate."), "Aggiornamenti ufficiali");
    } else {
      console.error(err);
      toast(err?.message || i18nT("Errore durante il ritiro."), i18nT("Errore"));
    }
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

reloadListBtn?.addEventListener("click", () => {
  void loadUpdatesList();
});

/* ===== Gate admin ===== */

function showGate() {
  gate.hidden = false;
  mainContent.hidden = true;
}

function showMain() {
  gate.hidden = true;
  mainContent.hidden = false;
}

initAuthGuard({
  requireAuth: true,
  onReady: async (user) => {
    me = user;
    let meDoc = null;
    try {
      meDoc = await getMyUserDoc(user.uid);
    } catch (err) {
      console.error(err);
      meDoc = null;
    }
    if (!meDoc?.isAdmin) {
      showGate();
      return;
    }
    showMain();
    renderChips();
    await loadUpdatesList();
  },
});
