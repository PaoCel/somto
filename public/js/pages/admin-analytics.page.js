import { qs, escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { toast } from "../components/toast.js";
import { initAuthGuard } from "../components/authGuard.js";
import { getPersonalAdminAnalytics } from "../api/adminAnalytics.api.js";

const gate = qs("#gate");
const errorState = qs("#errorState");
const errorText = qs("#errorText");
const dashboard = qs("#dashboard");
const generatedAt = qs("#generatedAt");
const scopeLabel = qs("#scopeLabel");
const kpiGrid = qs("#kpiGrid");
const usersBody = qs("#usersBody");
const reloadBtn = qs("#reloadBtn");
const limitSelect = qs("#limitSelect");
const searchInput = qs("#searchInput");
const platformFilter = qs("#platformFilter");
const lifecycleFilter = qs("#lifecycleFilter");
const activationFilter = qs("#activationFilter");

let payload = null;

function fmtInt(value) {
  return new Intl.NumberFormat("it-IT").format(Math.round(Number(value || 0)));
}

function fmtPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function fmtLongDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function fmtMinutes(value) {
  const minutes = Math.max(0, Number(value || 0));
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours <= 0) return `${fmtInt(mins)} min`;
  return mins ? `${fmtInt(hours)}h ${mins}m` : `${fmtInt(hours)}h`;
}

function fmtDurationMs(value) {
  const minutes = Math.max(0, Number(value || 0)) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) return "-";
  if (minutes < 60) return `${fmtInt(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = Math.round(minutes % 60);
  return remaining ? `${fmtInt(hours)}h ${remaining}m` : `${fmtInt(hours)}h`;
}

function providerLabel(ids = []) {
  const labels = ids.map((id) => {
    if (id === "password") return "email";
    if (id === "google.com") return "google";
    if (id === "apple.com") return "apple";
    return id.replace(".com", "");
  });
  return labels.length ? labels.join(", ") : "-";
}

function entrypointLabel(value) {
  const map = {
    netflix_import: "Netflix import",
    tv_time_import: "TV Time import",
    import: "Import",
    quiz: i18nT("Quiz"),
    watchlist_or_seen: "Watchlist/Visti",
    unknown: "Sconosciuta",
  };
  return map[value] || value || "Sconosciuta";
}

function platformLabel(value) {
  const map = { web: "Web", ios: "iOS", unknown: "Sconosciuta" };
  return map[value] || value || "Sconosciuta";
}

function lifecycleLabel(value) {
  const map = {
    active: "Attivo",
    pending_verification: i18nT("In verifica"),
    legacy_unverified: i18nT("Legacy non verificato"),
    orphan_profile: i18nT("Profilo orfano"),
    auth_only: i18nT("Solo Auth"),
    synthetic_guided: i18nT("Profilo guidato"),
    deleted: i18nT("Eliminato"),
    unknown: "Sconosciuto",
  };
  return map[value] || value || "Sconosciuto";
}

function hasUsefulActivity(user) {
  return Number(user.realActionCount || 0) > 0;
}

function contributionScore(user) {
  const s = user.summary || {};
  return (s.watched * 2) + s.ratings + (s.posts * 2) + (s.lists * 2) + (s.imports * 4) + (s.quizAttempts * 0.5);
}

function renderKpis(overview = {}) {
  const sums = overview.sums || {};
  const lifecycle = overview.lifecycleCounts || {};
  const signup = overview.signupLifecycle || {};
  const activation = overview.activationTiming || {};
  const items = [
    [i18nT("Lifecycle osservati"), fmtInt(signup.population || overview.sampleSize), `${fmtInt(signup.authCreatedCount)} Auth created`],
    [i18nT("Conversione verifica"), fmtPercent(signup.pendingToCompletedRate), `${fmtInt(signup.completedCount)} completed`],
    [i18nT("Tempo mediano verifica"), fmtDurationMs(signup.medianVerificationMs), `${fmtInt(signup.pendingCount)} pending`],
    [i18nT("Tempo mediano prima azione"), fmtDurationMs(activation.medianFirstUsefulMs), `${fmtInt(activation.observedCount)} osservati`],
    [i18nT("Lifecycle critici"), fmtInt(Number(lifecycle.orphan_profile || 0) + Number(lifecycle.auth_only || 0)), `${fmtInt(lifecycle.pending_verification)} pending`],
    [i18nT("Scaduti e cancellati"), fmtInt(signup.deletionCompletedCount), `${fmtInt(signup.expiredCount)} scaduti`],
    [i18nT("Attribuzione sconosciuta"), fmtPercent(signup.unknownAttributionRate), i18nT("{count} domini riservati", { count: fmtInt(signup.reservedDomainCount) })],
    ["Attivati 24h", fmtPercent(overview.activation24hRate), `${fmtInt(overview.activated24h)} utenti`],
    ["Attivi 7 giorni", fmtInt(overview.active7d), "sul campione caricato"],
    ["Titoli visti", fmtInt(sums.watched), fmtMinutes(sums.minutes)],
    ["Quiz giocati", fmtInt(sums.quizAttempts), `${fmtInt(sums.ratings)} voti totali`],
  ];

  kpiGrid.innerHTML = items.map(([label, value, sub]) => `
    <article class="analytics-kpi">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(sub)}</small>
    </article>
  `).join("");
}

function userMatchesFilters(user) {
  const q = String(searchInput?.value || "").trim().toLowerCase();
  const platform = platformFilter?.value || "all";
  const lifecycle = lifecycleFilter?.value || "all";
  const activation = activationFilter?.value || "all";
  const userPlatform = user.platform?.estimatedSignupSurface || "unknown";

  if (platform !== "all" && userPlatform !== platform) return false;
  if (lifecycle !== "all" && user.lifecycleStatus !== lifecycle) return false;
  if (activation === "active" && !hasUsefulActivity(user)) return false;
  if (activation === "quiet" && hasUsefulActivity(user)) return false;

  if (!q) return true;
  const haystack = [
    user.displayName,
    user.email,
    user.uid,
    userPlatform,
    user.entrypoint,
    providerLabel(user.providerIds),
    user.lifecycleStatus,
  ].join(" ").toLowerCase();
  return haystack.includes(q);
}

function renderDetailRow(user) {
  const imports = user.activity?.recentImports || [];
  const states = user.activity?.recentTitleStates || [];
  const tokenPlatforms = user.platform?.tokenPlatforms || [];
  const agents = user.platform?.userAgents || [];
  const activity = user.activity || {};
  const stats = user.stats || {};

  return `
    <tr class="analytics-detail-row" id="detail-${escapeHtml(user.uid)}" hidden>
      <td colspan="7">
        <div class="analytics-detail">
          <div>
            <h3>Segnali</h3>
            <dl>
              <dt>${i18nT("Email")}</dt><dd>${escapeHtml(user.email || "-")}</dd>
              <dt>Provider</dt><dd>${escapeHtml(providerLabel(user.providerIds))}</dd>
              <dt>Auth</dt><dd>${user.auth?.present ? "presente" : "assente"}</dd>
              <dt>Email verificata</dt><dd>${user.auth?.emailVerified ? "sì" : "no"}</dd>
              <dt>Creato Auth</dt><dd>${escapeHtml(fmtLongDate(user.auth?.createdAt))}</dd>
              <dt>Ultimo accesso Auth</dt><dd>${escapeHtml(fmtLongDate(user.auth?.lastSignInAt))}</dd>
              <dt>Profilo</dt><dd>${user.profilePresent ? "presente" : "assente"}</dd>
              <dt>Lifecycle</dt><dd>${escapeHtml(lifecycleLabel(user.lifecycleStatus))}</dd>
              <dt>Fonte stimata</dt><dd>${escapeHtml(entrypointLabel(user.entrypoint))}</dd>
              <dt>Attribuzione</dt><dd>${escapeHtml(user.attribution?.surface || "unknown")} / ${escapeHtml(user.attribution?.selfReportedSource || "unknown")}</dd>
              <dt>Token piattaforma</dt><dd>${escapeHtml(tokenPlatforms.join(", ") || "-")}</dd>
              <dt>User agent</dt><dd>${escapeHtml(agents.map((a) => `${a.device}/${a.browser}`).join(", ") || "-")}</dd>
            </dl>
          </div>
          <div>
            <h3>Contributi</h3>
            <dl>
              <dt>Title states</dt><dd>${fmtInt(activity.titleStatesCount)}</dd>
              <dt>${i18nT("Watchlist")}</dt><dd>${fmtInt(activity.watchlistCount)}</dd>
              <dt>${i18nT("In corso")}</dt><dd>${fmtInt(activity.inProgressCount)}</dd>
              <dt>Import</dt><dd>${fmtInt(activity.importsCount)}</dd>
              <dt>Post/commenti</dt><dd>${fmtInt(activity.postsCount)} / ${fmtInt(activity.commentsCount)}</dd>
              <dt>${i18nT("Liste")}</dt><dd>${fmtInt(activity.listsCount)}</dd>
              <dt>Consigli</dt><dd>${fmtInt(activity.recommendationsSentCount)} inviati, ${fmtInt(activity.recommendationsReceivedCount)} ricevuti</dd>
              <dt>${i18nT("Rewatch")}</dt><dd>${fmtInt(stats.rewatchCount)}</dd>
            </dl>
          </div>
          <div>
            <h3>Import recenti</h3>
            ${imports.length ? `
              <ul class="analytics-mini-list">
                ${imports.map((item) => `
                  <li>
                    <strong>${escapeHtml(item.source || "import")}</strong>
                    <span>${escapeHtml(item.status || "-")} · ${fmtInt(item.matchedCount)} match su ${fmtInt(item.totalRows)}</span>
                  </li>
                `).join("")}
              </ul>
            ` : `<p class="analytics-muted">${i18nT("Nessun import recente.")}</p>`}
          </div>
          <div>
            <h3>Ultimi titoli</h3>
            ${states.length ? `
              <ul class="analytics-mini-list">
                ${states.map((item) => `
                  <li>
                    <strong>${escapeHtml(item.titleId)}</strong>
                    <span>${escapeHtml(item.state || "-")} · ${fmtDate(item.updatedAt || item.createdAt)}</span>
                  </li>
                `).join("")}
              </ul>
            ` : `<p class="analytics-muted">${i18nT("Nessun titolo recente.")}</p>`}
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderRows() {
  const users = (payload?.users || []).filter(userMatchesFilters);
  if (!users.length) {
    usersBody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="analytics-empty">${i18nT("Nessun utente con questi filtri.")}</div>
        </td>
      </tr>
    `;
    return;
  }

  usersBody.innerHTML = users.map((user) => {
    const s = user.summary || {};
    const score = contributionScore(user);
    const detailId = `detail-${user.uid}`;
    return `
      <tr class="analytics-user-row" data-toggle="${escapeHtml(detailId)}" tabindex="0">
        <td>
          <div class="analytics-user">
            <img src="${escapeHtml(user.photoURL || "/icons/icon-192.png")}" alt="">
            <div>
              <strong>${escapeHtml(user.displayName || "User")}</strong>
              <span>${escapeHtml(user.email || user.uid)}</span>
            </div>
          </div>
        </td>
        <td>
          <strong class="analytics-lifecycle analytics-lifecycle-${escapeHtml(user.lifecycleStatus)}">${escapeHtml(lifecycleLabel(user.lifecycleStatus))}</strong>
          <span>${user.risk?.reservedEmailDomain ? i18nT("Dominio riservato") : (user.auth?.emailVerified ? i18nT("Email verificata") : i18nT("Email non verificata"))}</span>
        </td>
        <td>
          <strong>${escapeHtml(fmtLongDate(user.auth?.createdAt || user.createdAt))}</strong>
          <span>${escapeHtml(providerLabel(user.providerIds))}</span>
        </td>
        <td>
          <strong>${escapeHtml(platformLabel(user.platform?.estimatedSignupSurface))}</strong>
          <span>${escapeHtml(entrypointLabel(user.entrypoint))}</span>
        </td>
        <td>
          <strong>${fmtInt(score)}</strong>
          <span>${fmtInt(s.watched)} visti · ${fmtInt(s.ratings)} voti · ${fmtInt(s.imports)} import</span>
        </td>
        <td>
          <strong>${fmtInt(s.quizAttempts)}</strong>
          <span>${fmtInt(s.quizXp)} XP</span>
        </td>
        <td>
          <strong>${escapeHtml(fmtDate(user.lastActivityAt || user.lastActiveAt))}</strong>
          <span>prima azione: ${escapeHtml(fmtDate(user.firstUsefulAt))}</span>
        </td>
      </tr>
      ${renderDetailRow(user)}
    `;
  }).join("");
}

function showDashboard(data) {
  payload = data;
  gate.hidden = true;
  errorState.hidden = true;
  dashboard.hidden = false;
  generatedAt.textContent = `Aggiornato ${fmtLongDate(data.generatedAt)}`;
  scopeLabel.textContent = `${fmtInt(data.users?.length || 0)} utenti caricati`;
  renderKpis(data.overview || {});
  renderRows();
}

function showGate() {
  payload = null;
  dashboard.hidden = true;
  errorState.hidden = true;
  gate.hidden = false;
}

function showError(message) {
  dashboard.hidden = true;
  gate.hidden = true;
  errorState.hidden = false;
  errorText.textContent = message || i18nT("Non riesco a caricare i dati.");
}

async function load() {
  const limit = Number(limitSelect?.value || 40) || 40;
  reloadBtn.disabled = true;
  reloadBtn.textContent = "Carico...";
  try {
    const data = await getPersonalAdminAnalytics({ limit });
    showDashboard(data);
    toast("Analytics aggiornate.", "Admin");
  } catch (err) {
    const code = String(err?.code || "");
    if (code.includes("permission-denied")) {
      showGate();
    } else {
      console.error(err);
      showError(err?.message || i18nT("Errore durante il caricamento."));
    }
  } finally {
    reloadBtn.disabled = false;
    reloadBtn.textContent = "Aggiorna";
  }
}

usersBody?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-toggle]");
  if (!row) return;
  const detail = document.getElementById(row.dataset.toggle || "");
  if (detail) detail.hidden = !detail.hidden;
});

usersBody?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("[data-toggle]");
  if (!row) return;
  event.preventDefault();
  const detail = document.getElementById(row.dataset.toggle || "");
  if (detail) detail.hidden = !detail.hidden;
});

reloadBtn?.addEventListener("click", load);
limitSelect?.addEventListener("change", load);
[searchInput, platformFilter, lifecycleFilter, activationFilter].forEach((el) => {
  el?.addEventListener("input", renderRows);
  el?.addEventListener("change", renderRows);
});

initAuthGuard({
  requireAuth: true,
  onReady: () => void load(),
});
