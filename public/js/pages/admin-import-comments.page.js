// admin-import-comments.page.js — Console admin "revisione 1-tap" per la
// ripubblicazione dei commenti-episodio importati da TV Time (vedi CLAUDE.md
// "TV Time comment republish"). Elenca le code `importCommentReview/{uid}__{importId}`
// (rules: read isAdmin, write server-only) con i loro contatori, permette di
// espandere i candidati, fare un'ANTEPRIMA (dryRun) e "Pubblica i risolti"
// (approveAll) che chiama la callable admin `publishImportComments` — l'unica
// che scrive davvero i messaggi sui thread-episodio pubblici (idempotente).
import { qs, escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { toast } from "../components/toast.js";
import { initAuthGuard } from "../components/authGuard.js";
import { getMyUserDoc, listUsersPublicByIds } from "../api/users.api.js";
import {
  collection,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { app, db } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
// publishImportComments puo' creare thread + scrivere molti messaggi in batch:
// timeout generoso come le altre callable pesanti.
const publishImportCommentsCallable = httpsCallable(functions, "publishImportComments", { timeout: 300000 });
// Scarta/ripristina singoli candidati (status rejected): la collection è
// deny-all per i client, si scrive solo via callable admin.
const reviewImportCommentsCallable = httpsCallable(functions, "reviewImportComments", { timeout: 120000 });

const gate = qs("#gate");
const mainContent = qs("#mainContent");
const listEl = qs("#queueList");
const emptyEl = qs("#emptyState");
const reloadBtn = qs("#reloadBtn");
const targetUid = String(new URLSearchParams(window.location.search).get("uid") || "").trim();
const targetImportId = String(new URLSearchParams(window.location.search).get("importId") || "").trim();

const nameCache = new Map();

function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return 0;
}
function fmtDate(ts) {
  const ms = tsMs(ts);
  if (!ms) return "—";
  try { return new Date(ms).toLocaleString("it-IT"); } catch { return "—"; }
}
function n(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
// Quanti candidati pubblicabili restano (risolti non ancora pubblicati né
// scartati dall'admin: rejectedResolved è mantenuto dal callable di review).
function pendingPublishable(r) { return Math.max(0, n(r.resolved) - n(r.published) - n(r.rejectedResolved)); }

function showGate() { gate.hidden = false; mainContent.hidden = true; }
function showMain() { gate.hidden = true; mainContent.hidden = false; }

async function resolveNames(uids) {
  const missing = uids.filter((u) => u && !nameCache.has(u));
  if (missing.length) {
    try {
      const users = await listUsersPublicByIds(missing);
      users.forEach((u) => nameCache.set(u.uid, u.displayName || u.uid));
    } catch { /* fallback all'uid */ }
  }
  uids.forEach((u) => { if (u && !nameCache.has(u)) nameCache.set(u, u); });
}

async function loadQueues() {
  listEl.innerHTML = `<p class='ic-muted'>${i18nT("Carico la coda…")}</p>`;
  emptyEl.hidden = true;
  let snap;
  try {
    snap = await getDocs(collection(db, "importCommentReview"));
  } catch (err) {
    listEl.innerHTML = `<p class='ic-error'>Errore lettura coda: ${escapeHtml(err?.code || err?.message || String(err))}</p>`;
    return;
  }
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!rows.length) { listEl.innerHTML = ""; emptyEl.hidden = false; return; }

  await resolveNames([...new Set(rows.map((r) => r.uid).filter(Boolean))]);

  // Ordina: prima le code con più candidati da pubblicare, poi le più recenti.
  const isTarget = (row) => targetUid && targetImportId
    && String(row.uid || "") === targetUid
    && String(row.importId || "") === targetImportId;
  rows.sort((a, b) => Number(isTarget(b)) - Number(isTarget(a))
    || (pendingPublishable(b) - pendingPublishable(a))
    || (tsMs(b.createdAt) - tsMs(a.createdAt)));

  listEl.innerHTML = "";
  rows.forEach((r) => listEl.appendChild(renderQueueCard(r)));
  if (targetUid && targetImportId) {
    const targetCard = listEl.querySelector(".ic-card-target");
    targetCard?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function statPill(label, value, kind = "") {
  return `<span class="ic-pill ${kind}">${escapeHtml(label)}: <strong>${n(value)}</strong></span>`;
}

function renderQueueCard(r) {
  const name = nameCache.get(r.uid) || r.uid || "—";
  const card = document.createElement("article");
  card.className = "ic-card";
  if (String(r.uid || "") === targetUid && String(r.importId || "") === targetImportId) {
    card.classList.add("ic-card-target");
  }
  const pend = pendingPublishable(r);
  card.innerHTML = `
    <header class="ic-card-head">
      <div>
        <h3 class="ic-name">${escapeHtml(name)}</h3>
        <p class="ic-sub">import <code>${escapeHtml(String(r.importId || "—"))}</code> · ${escapeHtml(fmtDate(r.createdAt))}</p>
      </div>
      <div class="ic-badge ${pend > 0 ? "ic-badge-on" : ""}">${pend} da pubblicare</div>
    </header>
    <div class="ic-pills">
      ${statPill("totali", r.total)}
      ${statPill("idonei", r.eligible)}
      ${statPill("risolti", r.resolved, "ok")}
      ${statPill("irrisolti", r.unresolved, "warn")}
      ${statPill("pubblicati", r.published, "ok")}
      ${statPill(i18nT("scartati"), r.rejected, "rej")}
      ${statPill(i18nT("scartati qualità"), r.qualityRejected)}
    </div>
    <div class="ic-actions">
      <button class="ic-btn" data-act="preview">Anteprima</button>
      <button class="ic-btn ic-btn-primary" data-act="publish" ${pend > 0 ? "" : "disabled"}>${i18nT("Pubblica i risolti")}</button>
      <button class="ic-btn ghost" data-act="toggle">Mostra candidati</button>
    </div>
    <div class="ic-candidates" hidden></div>
    <p class="ic-result" hidden></p>
  `;

  const resultEl = card.querySelector(".ic-result");
  const candEl = card.querySelector(".ic-candidates");

  card.querySelector('[data-act="preview"]').addEventListener("click", (e) => runPublish(r, { dryRun: true }, e.currentTarget, resultEl));
  card.querySelector('[data-act="publish"]').addEventListener("click", (e) => runPublish(r, { dryRun: false }, e.currentTarget, resultEl));
  card.querySelector('[data-act="toggle"]').addEventListener("click", (e) => toggleCandidates(r, candEl, e.currentTarget));

  return card;
}

async function runPublish(r, { dryRun }, btn, resultEl) {
  if (!dryRun && !window.confirm(i18nT("Pubblicare i commenti risolti di \"{v0}\" sui thread pubblici? L'azione è a nome suo (idempotente).", { v0: nameCache.get(r.uid) || r.uid }))) return;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = dryRun ? "Calcolo…" : "Pubblico…";
  try {
    const res = await publishImportCommentsCallable({ uid: r.uid, importId: r.importId, approveAll: true, dryRun });
    const p = res?.data || {};
    resultEl.hidden = false;
    if (dryRun) {
      resultEl.className = "ic-result";
      resultEl.textContent = i18nT("Anteprima: pubblicherei {v0} commenti in {v1} thread · irrisolti {v2} · già pubblicati {v3}.", { v0: n(p.selected), v1: n(p.threads), v2: n(p.skippedUnresolved), v3: n(p.skippedAlreadyPublished) });
    } else {
      resultEl.className = "ic-result ok";
      resultEl.textContent = `✓ Pubblicati ${n(p.published)} commenti in ${n(p.threads)} thread.`;
      toast(`Pubblicati ${n(p.published)} commenti`, "OK");
      await loadQueues();
      return;
    }
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "ic-result error";
    resultEl.textContent = `Errore: ${err?.code || err?.message || String(err)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Un candidato è selezionabile (checkbox) se sarebbe pubblicabile: risolto
// con coordinate valide, non pubblicato, non scartato — specchio esatto della
// selezione di publishImportComments lato server.
function candidateIsSelectable(c) {
  return Boolean(c.titleId) && Number(c.season) > 0 && Number(c.episode) > 0
    && c.published !== true && c.status !== "rejected";
}

function candidateTag(c) {
  if (c.published) return "<span class='ic-tag ok'>pubblicato</span>";
  if (c.status === "rejected") return `<span class='ic-tag rej'>${i18nT("scartato")}</span>`;
  if (c.titleId) return "<span class='ic-tag'>risolto</span>";
  return "<span class='ic-tag warn'>irrisolto</span>";
}

function renderCandidateRow(c) {
  const check = candidateIsSelectable(c)
    ? `<input type="checkbox" class="ic-cand-check" data-cid="${escapeHtml(c.id)}">`
    : "";
  const restore = (!c.published && c.status === "rejected")
    ? `<button class="ic-btn ghost ic-btn-small" type="button" data-restore="${escapeHtml(c.id)}">${i18nT("Ripristina")}</button>`
    : "";
  const loc = `${escapeHtml(String(c.seriesName || "—"))} · S${n(c.season)}E${n(c.episode)}`;
  return `<div class="ic-cand${c.status === "rejected" ? " is-rejected" : ""}">
    <div class="ic-cand-meta">${check}${candidateTag(c)} <span class="ic-cand-loc">${loc}</span>${restore}</div>
    <p class="ic-cand-text">${escapeHtml(String(c.text || "").slice(0, 400))}</p>
  </div>`;
}

async function toggleCandidates(r, candEl, btn) {
  if (!candEl.hidden) { candEl.hidden = true; btn.textContent = "Mostra candidati"; return; }
  candEl.hidden = false;
  btn.textContent = "Nascondi candidati";
  if (candEl.dataset.loaded === "1") return;
  candEl.innerHTML = "<p class='ic-muted'>Carico i candidati…</p>";
  try {
    const snap = await getDocs(collection(db, "importCommentReview", r.id, "comments"));
    const cands = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!cands.length) { candEl.innerHTML = `<p class='ic-muted'>${i18nT("Nessun candidato.")}</p>`; candEl.dataset.loaded = "1"; return; }
    // Prima i pendenti pubblicabili, poi gli irrisolti, poi scartati e pubblicati.
    const rank = (c) => (c.published ? 3 : c.status === "rejected" ? 2 : c.titleId ? 0 : 1);
    cands.sort((a, b) => rank(a) - rank(b));

    const anySelectable = cands.some(candidateIsSelectable);
    candEl.innerHTML = `
      ${anySelectable ? `<div class="ic-selbar">
        <label class="ic-selall"><input type="checkbox" data-role="selall"> ${i18nT("Seleziona tutti")}</label>
        <span class="ic-selcount" data-role="count"></span>
        <span class="ic-selbar-spacer"></span>
        <button class="ic-btn ic-btn-primary" type="button" data-role="publish-selected" disabled>${i18nT("Pubblica selezionati")}</button>
        <button class="ic-btn ic-btn-danger" type="button" data-role="reject-selected" disabled>${i18nT("Scarta selezionati")}</button>
      </div>` : ""}
      ${cands.map((c) => renderCandidateRow(c)).join("")}
    `;
    candEl.dataset.loaded = "1";
    wireCandidateActions(r, candEl);
  } catch (err) {
    candEl.innerHTML = `<p class='ic-error'>Errore: ${escapeHtml(err?.code || err?.message || String(err))}</p>`;
  }
}

function wireCandidateActions(r, candEl) {
  const checks = [...candEl.querySelectorAll(".ic-cand-check")];
  const selall = candEl.querySelector('[data-role="selall"]');
  const countEl = candEl.querySelector('[data-role="count"]');
  const publishBtn = candEl.querySelector('[data-role="publish-selected"]');
  const rejectBtn = candEl.querySelector('[data-role="reject-selected"]');

  const selectedIds = () => checks.filter((c) => c.checked).map((c) => c.dataset.cid);
  const refreshBar = () => {
    const count = selectedIds().length;
    if (countEl) countEl.textContent = i18nT("{v0} selezionati", { v0: count });
    if (publishBtn) publishBtn.disabled = count === 0;
    if (rejectBtn) rejectBtn.disabled = count === 0;
    if (selall) selall.checked = count > 0 && count === checks.length;
  };
  checks.forEach((c) => c.addEventListener("change", refreshBar));
  if (selall) {
    selall.addEventListener("change", () => {
      checks.forEach((c) => { c.checked = selall.checked; });
      refreshBar();
    });
  }
  refreshBar();

  const runAction = async (btn, fn) => {
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await fn();
      await loadQueues();
    } catch (err) {
      toast(`${err?.code || err?.message || err}`, "Errore");
      btn.disabled = false;
      btn.textContent = prev;
    }
  };

  if (publishBtn) {
    publishBtn.addEventListener("click", () => {
      const ids = selectedIds();
      if (!ids.length) return;
      if (!window.confirm(i18nT("Pubblicare {v0} commenti selezionati sui thread pubblici a nome di \"{v1}\"?", { v0: ids.length, v1: nameCache.get(r.uid) || r.uid }))) return;
      runAction(publishBtn, async () => {
        const res = await publishImportCommentsCallable({ uid: r.uid, importId: r.importId, commentIds: ids, dryRun: false });
        toast(`Pubblicati ${n(res?.data?.published)} commenti`, "OK");
      });
    });
  }
  if (rejectBtn) {
    rejectBtn.addEventListener("click", () => {
      const ids = selectedIds();
      if (!ids.length) return;
      if (!window.confirm(i18nT("Scartare {v0} commenti? Non verranno pubblicati (si può annullare con Ripristina).", { v0: ids.length }))) return;
      runAction(rejectBtn, async () => {
        const res = await reviewImportCommentsCallable({ uid: r.uid, importId: r.importId, commentIds: ids, action: "reject" });
        toast(i18nT("Scartati {v0} commenti", { v0: n(res?.data?.updated) }), "OK");
      });
    });
  }
  candEl.querySelectorAll("[data-restore]").forEach((btn) => {
    btn.addEventListener("click", () => {
      runAction(btn, async () => {
        await reviewImportCommentsCallable({ uid: r.uid, importId: r.importId, commentIds: [btn.dataset.restore], action: "unreject" });
        toast(i18nT("Candidato ripristinato"), "OK");
      });
    });
  });
}

if (reloadBtn) reloadBtn.addEventListener("click", loadQueues);

initAuthGuard({
  requireAuth: true,
  onReady: async (user) => {
    let meDoc = null;
    try { meDoc = await getMyUserDoc(user.uid); } catch { meDoc = null; }
    if (!meDoc?.isAdmin) { showGate(); return; }
    showMain();
    await loadQueues();
  },
});
