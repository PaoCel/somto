// admin-title-updates.page.js — Console admin delle date di uscita
// (`titleUpdateEvents`, eventType `release_date`).
//
// Risolve due problemi che oggi non hanno una UI:
//  1. un film senza release italiana confermata resta `draft` e non lo puo'
//     pubblicare nessuno, quindi i draft si accumulano;
//  2. la data automatica a volte e' sbagliata e va corretta a mano — e la
//     correzione deve reggere alle passate dello scanner TMDB (~ogni 2,5
//     giorni), cosa che fa `editorial.lockedFields`.
//
// INVARIANTE DELLA PAGINA: non si scrive senza aver prima visto `willNotify`.
// Pubblicare l'evento di un film che esce entro due settimane manda una push a
// chiunque abbia il titolo in watchlist, e non si annulla. Quindi il bottone che
// scrive resta disabilitato finche' non c'e' un dry run che corrisponde ESATTAMENTE
// ai valori attualmente nel form: cambiare un campo invalida la verifica.
import { qs, escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { toast } from "../components/toast.js";
import { initAuthGuard } from "../components/authGuard.js";
import { getMyUserDoc } from "../api/users.api.js";
import { getTitlesByIds, searchTitlesSmart } from "../api/titles.api.js";
import {
  listEditedReleaseDateEvents,
  listReleaseDateDrafts,
  listReleaseDateEventsForTitle,
  reviewTitleUpdateEvent,
  toMillis,
} from "../api/titleUpdatesAdmin.api.js";

const gate = qs("#gate");
const mainContent = qs("#mainContent");

const noSelection = qs("#noSelection");
const reviewForm = qs("#reviewForm");
const selectedSummary = qs("#selectedSummary");
const effectiveDateInput = qs("#effectiveDateInput");
const lockDateCheck = qs("#lockDateCheck");
const regionInput = qs("#regionInput");
const releaseTypeSelect = qs("#releaseTypeSelect");
const noteInput = qs("#noteInput");
const publishCheck = qs("#publishCheck");
const verifyBtn = qs("#verifyBtn");
const applyBtn = qs("#applyBtn");
const applyHint = qs("#applyHint");
const checkPanel = qs("#checkPanel");
const checkNotify = qs("#checkNotify");
const checkWarnings = qs("#checkWarnings");
const checkLocked = qs("#checkLocked");

const titleSearchInput = qs("#titleSearchInput");
const titleSearchResults = qs("#titleSearchResults");
const searchEvents = qs("#searchEvents");

const reloadListBtn = qs("#reloadListBtn");
const eventsBody = qs("#eventsBody");

// Stessa finestra del server (`MANUAL_NOTIFY_WINDOW_MS` in
// functions/lib/titleUpdateEditorial.js). Qui serve SOLO a etichettare le righe
// in elenco: la verita' su "parte una notifica?" resta il dry run.
const NOTIFY_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

let queueRows = [];
let selected = null;
// { signature, result }: il dry run vale solo per i valori con cui e' stato fatto.
let verified = null;
let searchTimer = 0;

/* ===== Formattazione ===== */

// Le date di calendario sono ancorate a mezzogiorno UTC (vedi
// titleUpdateEventModel.js): leggerle e scriverle in UTC evita lo scivolamento
// di un giorno a seconda del fuso del browser.
function calendarInputValue(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

function fmtCalendar(ms) {
  if (!Number.isFinite(ms)) return "-";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

function daysFromNow(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms - Date.now()) / DAY_MS);
}

function whenLabel(ms) {
  const days = daysFromNow(ms);
  if (days == null) return "";
  if (days < 0) return i18nT("uscita passata");
  if (days === 0) return i18nT("esce oggi");
  return i18nT("fra {count} giorni", { count: days });
}

/* ===== Modello di riga ===== */

function conflictOf(row) {
  return row?.editorial?.sourceConflict || null;
}

function isDraft(row) {
  return row?.status === "draft";
}

// Prima i conflitti (il film e' stato spostato: per l'editoriale e' una
// notizia), poi le bozze che nessuno puo' pubblicare, poi il resto. A parita',
// prima cio' che esce prima.
function priorityOf(row) {
  if (conflictOf(row)) return 0;
  if (isDraft(row)) return 1;
  return 2;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const byPriority = priorityOf(a) - priorityOf(b);
    if (byPriority) return byPriority;
    const aMs = Number.isFinite(a.effectiveAtMs) ? a.effectiveAtMs : Number.MAX_SAFE_INTEGER;
    const bMs = Number.isFinite(b.effectiveAtMs) ? b.effectiveAtMs : Number.MAX_SAFE_INTEGER;
    return aMs - bMs;
  });
}

function localizedText(map) {
  if (!map || typeof map !== "object") return "";
  return String(map["it-IT"] || map["en-US"] || map.und || Object.values(map).find(Boolean) || "");
}

/** Il nome vero viene da `titles/{titleId}`; l'evento tiene solo una headline. */
async function decorateWithTitles(rows) {
  const ids = [...new Set(rows.map((row) => row.titleId).filter(Boolean))];
  let byId = new Map();
  try {
    byId = await getTitlesByIds(ids, { max: 400 });
  } catch (err) {
    console.error(err);
  }
  return rows.map((row) => ({
    ...row,
    titleName: byId.get(row.titleId)?.name
      || localizedText(row.entityNameByLocale)
      || localizedText(row.headlineByLocale)
      || row.titleId
      || row.id,
  }));
}

/* ===== Badge ===== */

function statusBadgeHtml(status) {
  const map = {
    draft: [i18nT("Bozza"), "editorial-badge--draft"],
    published: [i18nT("Pubblicato"), "editorial-badge--published"],
  };
  const [label, cls] = map[status] || [status || "-", "editorial-badge--retired"];
  return `<span class="editorial-badge ${cls}">${escapeHtml(label)}</span>`;
}

function notifyWindowBadgeHtml(row) {
  const days = daysFromNow(row.effectiveAtMs);
  if (days == null || days < 0 || days > NOTIFY_WINDOW_DAYS) return "";
  return `<span class="editorial-badge editorial-badge--window">${escapeHtml(i18nT("finestra notifica"))}</span>`;
}

function editorialCellHtml(row) {
  const editorial = row.editorial || null;
  const parts = [];
  if (Array.isArray(editorial?.lockedFields) && editorial.lockedFields.length) {
    parts.push(`<span class="editorial-badge editorial-badge--locked">${escapeHtml(i18nT("bloccato"))}</span>`);
    const editedAt = toMillis(editorial.editedAt);
    if (Number.isFinite(editedAt)) {
      parts.push(`<div class="analytics-muted">${escapeHtml(i18nT("dal {date}", { date: fmtCalendar(editedAt) }))}</div>`);
    }
    if (editorial.note) {
      parts.push(`<div class="analytics-muted">${escapeHtml(editorial.note)}</div>`);
    }
  }
  const conflict = conflictOf(row);
  if (conflict) {
    const sourceMs = toMillis(conflict.sourceValue);
    const sourceLabel = Number.isFinite(sourceMs) ? fmtCalendar(sourceMs) : String(conflict.sourceValue ?? "-");
    const detectedMs = toMillis(conflict.detectedAt);
    parts.push(`
      <div class="editorial-conflict">
        <strong>${escapeHtml(i18nT("Conflitto con TMDB"))}</strong>
        <div>${escapeHtml(i18nT("la fonte dice {date}", { date: sourceLabel }))}</div>
        ${Number.isFinite(detectedMs) ? `<div class="analytics-muted">${escapeHtml(i18nT("visto il {date}", { date: fmtCalendar(detectedMs) }))}</div>` : ""}
      </div>
    `);
  }
  if (!parts.length) return `<span class="analytics-muted">-</span>`;
  return parts.join("");
}

function rowHtml(row) {
  return `
    <tr${conflictOf(row) ? ' class="editorial-row--conflict"' : ""}>
      <td>
        <strong>${escapeHtml(row.titleName || row.titleId || row.id)}</strong>
        <div class="analytics-muted">${escapeHtml(row.titleId || "-")}</div>
      </td>
      <td>
        ${escapeHtml(fmtCalendar(row.effectiveAtMs))}
        <div class="analytics-muted">${escapeHtml(whenLabel(row.effectiveAtMs))}</div>
        ${notifyWindowBadgeHtml(row)}
      </td>
      <td>${statusBadgeHtml(row.status)}</td>
      <td>${editorialCellHtml(row)}</td>
      <td><button class="btn small secondary" type="button" data-select-id="${escapeHtml(row.id)}">${escapeHtml(i18nT("Correggi"))}</button></td>
    </tr>
  `;
}

/* ===== Elenco ===== */

function renderQueue(rows) {
  if (!rows.length) {
    eventsBody.innerHTML = `<tr><td colspan="5"><div class="analytics-empty">${escapeHtml(i18nT("Niente da rivedere: nessuna bozza e nessun conflitto."))}</div></td></tr>`;
    return;
  }
  eventsBody.innerHTML = rows.map(rowHtml).join("");
}

async function loadQueue() {
  eventsBody.innerHTML = `<tr><td colspan="5"><div class="analytics-empty">${escapeHtml(i18nT("Carico..."))}</div></td></tr>`;
  try {
    const [drafts, edited] = await Promise.all([
      listReleaseDateDrafts(),
      listEditedReleaseDateEvents(),
    ]);
    // Un evento puo' stare in entrambe le liste (bozza gia' corretta a mano).
    const byId = new Map();
    for (const row of [...drafts, ...edited]) byId.set(row.id, row);
    // Gli eventi gia' corretti e senza conflitto non hanno niente da rivedere:
    // restano fuori dalla coda, ci si arriva dalla ricerca per titolo.
    const relevant = [...byId.values()].filter((row) => isDraft(row) || conflictOf(row));
    queueRows = sortRows(await decorateWithTitles(relevant));
    renderQueue(queueRows);
  } catch (err) {
    console.error(err);
    eventsBody.innerHTML = `<tr><td colspan="5"><div class="analytics-empty">${escapeHtml(i18nT("Errore durante il caricamento."))} ${escapeHtml(err?.message || "")}</div></td></tr>`;
  }
}

/* ===== Selezione + form ===== */

function selectedSummaryHtml(row) {
  return `
    <h3>${escapeHtml(row.titleName || row.titleId || row.id)}</h3>
    <dl>
      <dt>${escapeHtml(i18nT("Evento"))}</dt><dd>${escapeHtml(row.id)}</dd>
      <dt>${escapeHtml(i18nT("Data attuale"))}</dt><dd>${escapeHtml(fmtCalendar(row.effectiveAtMs))} <span class="analytics-muted">${escapeHtml(whenLabel(row.effectiveAtMs))}</span></dd>
      <dt>${escapeHtml(i18nT("Stato"))}</dt><dd>${statusBadgeHtml(row.status)}</dd>
      <dt>${escapeHtml(i18nT("Editoriale"))}</dt><dd>${editorialCellHtml(row)}</dd>
    </dl>
  `;
}

function selectEvent(row) {
  selected = row;
  noSelection.hidden = true;
  reviewForm.hidden = false;
  selectedSummary.innerHTML = selectedSummaryHtml(row);
  effectiveDateInput.value = calendarInputValue(row.effectiveAtMs);
  lockDateCheck.checked = false;
  regionInput.value = String(row.region || "").toUpperCase();
  releaseTypeSelect.value = "";
  noteInput.value = "";
  publishCheck.checked = false;
  // Una bozza si apre gia' pronta a pubblicare: e' il motivo principale per cui
  // questa console esiste. La verifica resta comunque obbligatoria.
  if (isDraft(row)) publishCheck.checked = true;
  invalidateCheck();
  syncApplyLabel();
  reviewForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearSelection() {
  selected = null;
  verified = null;
  reviewForm.hidden = true;
  noSelection.hidden = false;
  checkPanel.hidden = true;
}

function syncApplyLabel() {
  applyBtn.textContent = publishCheck.checked ? i18nT("Pubblica") : i18nT("Salva correzione");
}

function invalidateCheck() {
  verified = null;
  applyBtn.disabled = true;
  checkPanel.hidden = true;
  applyHint.textContent = i18nT("Prima di scrivere serve la verifica: dice se parte una notifica.");
}

/**
 * Costruisce il payload della callable. Omettere un campo significa "non
 * toccarlo": si manda solo cio' che cambia davvero, cosi' una pubblicazione non
 * blocca per sbaglio campi che l'admin non ha guardato.
 */
function buildPayload() {
  if (!selected) return { errors: [i18nT("Nessun evento selezionato.")] };
  const errors = [];
  const payload = { eventId: selected.id, publish: publishCheck.checked };

  const currentDate = calendarInputValue(selected.effectiveAtMs);
  const inputDate = String(effectiveDateInput.value || "").trim();
  if (inputDate && (inputDate !== currentDate || lockDateCheck.checked)) {
    payload.effectiveDate = inputDate;
  } else if (!inputDate && lockDateCheck.checked) {
    errors.push(i18nT("Manca la data da bloccare."));
  }

  const currentRegion = String(selected.region || "").toUpperCase();
  const inputRegion = String(regionInput.value || "").trim().toUpperCase();
  if (inputRegion && inputRegion !== currentRegion) {
    if (inputRegion.length !== 2) errors.push(i18nT("La region vuole due lettere, es. IT."));
    else payload.region = inputRegion;
  }

  const releaseType = Number(releaseTypeSelect.value || 0);
  if (releaseType && releaseType !== Number(selected.releaseType || 0)) {
    payload.releaseType = releaseType;
  }

  const note = String(noteInput.value || "").trim();
  const touchesFields = payload.effectiveDate !== undefined
    || payload.region !== undefined
    || payload.releaseType !== undefined;
  if (note) payload.note = note;
  if (note && !touchesFields) {
    // La nota vive dentro il blocco `editorial`, che il server scrive solo
    // quando c'e' almeno un campo bloccato: da sola andrebbe persa in silenzio.
    errors.push(i18nT("La nota si salva solo insieme a una correzione."));
  }

  if (!touchesFields && !payload.publish) {
    errors.push(i18nT("Non c'è niente da applicare: cambia un campo o spunta Pubblica."));
  }

  return { payload, errors };
}

function signatureOf(payload) {
  return JSON.stringify([
    payload.eventId,
    payload.effectiveDate ?? null,
    payload.region ?? null,
    payload.releaseType ?? null,
    payload.note ?? null,
    payload.publish === true,
  ]);
}

function renderCheck(result, payload) {
  checkPanel.hidden = false;

  if (result?.willNotify) {
    checkNotify.className = "editorial-alert editorial-alert--notify";
    checkNotify.textContent = i18nT("Parte una notifica push a chi ha il titolo in watchlist. Non si annulla.");
  } else if (payload.publish) {
    checkNotify.className = "editorial-alert editorial-alert--quiet";
    checkNotify.textContent = i18nT("Nessuna notifica: l'evento viene pubblicato in silenzio.");
  } else {
    checkNotify.className = "editorial-alert editorial-alert--quiet";
    checkNotify.textContent = i18nT("Nessuna notifica: questa correzione non pubblica niente.");
  }

  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  checkWarnings.innerHTML = warnings.length
    ? `<ul class="editorial-warnings">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`
    : "";

  const locked = Array.isArray(result?.lockedFields) ? result.lockedFields : [];
  checkLocked.textContent = locked.length ? locked.join(", ") : i18nT("nessuno");
}

function setButtonLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = !!loading;
  btn.dataset.loading = loading ? "true" : "false";
}

/**
 * Toglie lo stato di caricamento dal bottone che scrive SENZA riabilitarlo a
 * scatola chiusa: dopo una scrittura riuscita la verifica e' stata azzerata, e
 * un `setButtonLoading(applyBtn, false)` lo rimetterebbe cliccabile senza dry
 * run — cioe' esattamente il caso che questa pagina deve impedire.
 */
function refreshApplyState() {
  applyBtn.dataset.loading = "false";
  applyBtn.disabled = !verified;
}

verifyBtn?.addEventListener("click", async () => {
  const { payload, errors } = buildPayload();
  if (errors.length) {
    toast(errors[0], i18nT("Modulo incompleto"));
    return;
  }
  setButtonLoading(verifyBtn, true);
  try {
    const result = await reviewTitleUpdateEvent({ ...payload, dryRun: true });
    verified = { signature: signatureOf(payload), result };
    renderCheck(result, payload);
    applyBtn.disabled = false;
    applyHint.textContent = result?.willNotify
      ? i18nT("Leggi l'esito qui sopra prima di applicare.")
      : i18nT("Verifica fatta: puoi applicare.");
  } catch (err) {
    console.error(err);
    invalidateCheck();
    toast(err?.message || i18nT("Errore durante la verifica."), i18nT("Errore"));
  } finally {
    setButtonLoading(verifyBtn, false);
    if (!verified) applyBtn.disabled = true;
  }
});

applyBtn?.addEventListener("click", async () => {
  const { payload, errors } = buildPayload();
  if (errors.length) {
    toast(errors[0], i18nT("Modulo incompleto"));
    return;
  }
  // Cintura di sicurezza: il bottone e' gia' disabilitato finche' la verifica
  // non corrisponde, ma il controllo va rifatto qui perche' e' l'unico punto in
  // cui si scrive davvero.
  if (!verified || verified.signature !== signatureOf(payload)) {
    invalidateCheck();
    toast(i18nT("I valori sono cambiati: rifai la verifica."), i18nT("Verifica scaduta"));
    return;
  }

  if (verified.result?.willNotify) {
    const ok = window.confirm(
      i18nT("Parte una notifica push a chi ha il titolo in watchlist. Non si annulla.")
      + "\n\n"
      + i18nT("Procedere?")
    );
    if (!ok) return;
  }

  setButtonLoading(applyBtn, true);
  try {
    const result = await reviewTitleUpdateEvent({ ...payload, dryRun: false });
    toast(
      payload.publish ? i18nT("Evento pubblicato.") : i18nT("Correzione salvata."),
      i18nT("Date di uscita")
    );
    if (Array.isArray(result?.warnings) && result.warnings.length) {
      toast(result.warnings[0], i18nT("Nota"));
    }
    const titleId = selected?.titleId || null;
    const eventId = selected?.id || null;
    invalidateCheck();
    await loadQueue();
    await reselectAfterWrite(titleId, eventId);
  } catch (err) {
    console.error(err);
    toast(err?.message || i18nT("Errore durante il salvataggio"), i18nT("Errore"));
  } finally {
    refreshApplyState();
    syncApplyLabel();
  }
});

/** Rilegge l'evento appena scritto: conferma che la patch e' andata a segno. */
async function reselectAfterWrite(titleId, eventId) {
  if (!titleId || !eventId) {
    clearSelection();
    return;
  }
  try {
    const rows = await decorateWithTitles(await listReleaseDateEventsForTitle(titleId));
    const fresh = rows.find((row) => row.id === eventId);
    if (fresh) selectEvent(fresh);
    else clearSelection();
  } catch (err) {
    console.error(err);
    clearSelection();
  }
}

[effectiveDateInput, regionInput, noteInput].forEach((el) => {
  el?.addEventListener("input", invalidateCheck);
});
releaseTypeSelect?.addEventListener("change", invalidateCheck);
lockDateCheck?.addEventListener("change", invalidateCheck);
publishCheck?.addEventListener("change", () => {
  invalidateCheck();
  syncApplyLabel();
});

eventsBody?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-select-id]");
  if (!btn) return;
  const row = queueRows.find((r) => r.id === btn.dataset.selectId);
  if (row) selectEvent(row);
});

/* ===== Ricerca per titolo ===== */
// Serve per il caso "la data automatica e' sbagliata": quell'evento e' gia'
// pubblicato e mai toccato, quindi non e' ne' una bozza ne' un conflitto e non
// compare nella coda.

function renderSearchResults(rows) {
  if (!rows?.length) {
    titleSearchResults.innerHTML = "";
    titleSearchResults.hidden = true;
    return;
  }
  titleSearchResults.hidden = false;
  titleSearchResults.innerHTML = rows.map((r) => `
    <button type="button" class="editorial-search-result" data-id="${escapeHtml(r.id)}">
      <strong>${escapeHtml(r.name || r.id)}</strong>
      <span>${escapeHtml(r.year != null ? String(r.year) : "-")} · ${r.type === "tv" ? escapeHtml(i18nT("Serie")) : escapeHtml(i18nT("Film"))} · ${escapeHtml(r.id)}</span>
    </button>
  `).join("");
}

let searchRows = [];

async function loadTitleEvents(titleId) {
  searchEvents.innerHTML = `<div class="analytics-empty">${escapeHtml(i18nT("Carico..."))}</div>`;
  try {
    const rows = await decorateWithTitles(await listReleaseDateEventsForTitle(titleId));
    searchRows = sortRows(rows);
    if (!searchRows.length) {
      searchEvents.innerHTML = `<div class="analytics-empty">${escapeHtml(i18nT("Questo titolo non ha eventi data di uscita."))}</div>`;
      return;
    }
    searchEvents.innerHTML = `
      <div class="analytics-table-wrap">
        <table class="analytics-table">
          <thead>
            <tr>
              <th>${escapeHtml(i18nT("Titolo"))}</th>
              <th>${escapeHtml(i18nT("Data"))}</th>
              <th>${escapeHtml(i18nT("Stato"))}</th>
              <th>${escapeHtml(i18nT("Editoriale"))}</th>
              <th>${escapeHtml(i18nT("Azioni"))}</th>
            </tr>
          </thead>
          <tbody>${searchRows.map(rowHtml).join("")}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    console.error(err);
    searchEvents.innerHTML = `<div class="analytics-empty">${escapeHtml(i18nT("Errore durante il caricamento."))}</div>`;
  }
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
      renderSearchResults(await searchTitlesSmart(term, 8));
    } catch (err) {
      console.error(err);
      renderSearchResults([]);
    }
  }, 250);
});

titleSearchResults?.addEventListener("click", (event) => {
  const btn = event.target.closest(".editorial-search-result");
  if (!btn) return;
  renderSearchResults([]);
  titleSearchInput.value = "";
  void loadTitleEvents(btn.dataset.id);
});

searchEvents?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-select-id]");
  if (!btn) return;
  const row = searchRows.find((r) => r.id === btn.dataset.selectId);
  if (row) selectEvent(row);
});

document.addEventListener("click", (event) => {
  if (!titleSearchResults || titleSearchResults.hidden) return;
  if (event.target.closest(".editorial-search-wrap")) return;
  titleSearchResults.hidden = true;
});

reloadListBtn?.addEventListener("click", () => {
  void loadQueue();
});

/* ===== Gate admin ===== */
// Cosmetico: l'autorizzazione vera e' server-side (rules per la lettura,
// `isAdminCaller` dentro la callable per la scrittura).

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
    await loadQueue();
  },
});
