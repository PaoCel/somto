import { qs, escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { toast } from "../components/toast.js";
import { initAuthGuard } from "../components/authGuard.js";
import { getMyUserDoc } from "../api/users.api.js";
import { db } from "../firebase.js";
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const gate = qs("#gate");
const errorState = qs("#errorState");
const errorText = qs("#errorText");
const dashboard = qs("#dashboard");
const noDataState = qs("#noDataState");
const metricsContent = qs("#metricsContent");
const kpiGrid = qs("#kpiGrid");
const trackingCohortGrid = qs("#trackingCohortGrid");
const trackingCohortNote = qs("#trackingCohortNote");
const funnelWrap = qs("#funnelWrap");
const chartWrap = qs("#chartWrap");
const dailyBody = qs("#dailyBody");
const reloadBtn = qs("#reloadBtn");

const MAX_DOCS = 30;

// Contatori giornalieri che possono comparire su productMetrics/{YYYY-MM-DD}.
// Tutti opzionali: un doc puo' avere solo un sottoinsieme di questi campi.
const COUNTER_KEYS = [
  "signup_started", "signups", "onboarding_started", "onboarding_completed",
  "onboarding_skipped", "import_started", "imports_completed", "imports_failed",
  "quiz_played", "guest_quiz_played", "empty_watchlist", "empty_feed",
];

const FUNNEL_STAGES = [
  { key: "signup_started", label: "Signup avviati" },
  { key: "signups", label: "Signup completati" },
  { key: "onboarding_completed", label: "Onboarding completato" },
  { key: "import_started", label: "Import avviato" },
  { key: "imports_completed", label: "Import completati" },
];

function fmtInt(value) {
  return new Intl.NumberFormat("it-IT").format(Math.round(Number(value || 0)));
}

function fmtDateKey(dateKey) {
  // dateKey e' YYYY-MM-DD (Europe/Rome). Formattiamo senza passare per Date()
  // per evitare shift di fuso orario sul parsing di una data "naked".
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!m) return escapeHtml(String(dateKey || "-"));
  return `${m[3]}/${m[2]}`;
}

function fmtTimestamp(value) {
  if (!value) return "-";
  const d = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(d);
}

/* ===== Fetch ===== */

async function fetchDailyDocs() {
  const qy = query(
    collection(db, "productMetrics"),
    orderBy("__name__", "desc"),
    limit(MAX_DOCS)
  );
  const snap = await getDocs(qy);
  // desc (piu' recente prima) -> reverse per ordine cronologico crescente,
  // piu' comodo per funnel/trend/tabella (che poi mostra piu'-recente-prima).
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
}

function isDocEmpty(d) {
  const hasCounters = COUNTER_KEYS.some((k) => Number(d?.[k] || 0) > 0);
  const hasSnapshot = !!d?.snapshot;
  return !hasCounters && !hasSnapshot;
}

function findLatestSnapshot(docs) {
  for (let i = docs.length - 1; i >= 0; i -= 1) {
    if (docs[i]?.snapshot) return docs[i].snapshot;
  }
  return null;
}

/* ===== KPI tiles ===== */

function kpiTileHtml(label, value, sub) {
  return `
    <article class="analytics-kpi">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${sub ? `<small>${escapeHtml(sub)}</small>` : ""}
    </article>
  `;
}

function renderKpis(docs) {
  const snap = findLatestSnapshot(docs);
  const totalUsers = snap ? fmtInt(snap.totalUsers) : "—";
  const wau = snap ? fmtInt(snap.wau) : "—";
  const dau = snap ? fmtInt(snap.dau) : "—";
  const newUsers24h = snap ? fmtInt(snap.newUsers24h) : "—";
  const cohortSize = Number(snap?.cohort48hSize || 0);
  const activationPct = snap && cohortSize > 0
    ? `${Math.round((Number(snap.activated48h || 0) / cohortSize) * 100)}%`
    : "—";
  const tracker7d = snap?.manualProgress
    ? fmtInt(snap.manualProgress.manualProgressUsers7d)
    : "—";

  kpiGrid.innerHTML = [
    kpiTileHtml("Utenti totali", totalUsers),
    kpiTileHtml("WAU", wau, "North Star · attivi 7g"),
    kpiTileHtml("DAU", dau, "attivi 24h"),
    kpiTileHtml("Nuovi (24h)", newUsers24h),
    kpiTileHtml("Attivazione 48h", activationPct, cohortSize > 0 ? `coorte ${fmtInt(cohortSize)} utenti` : "coorte vuota"),
    kpiTileHtml("Tracker attivi 7g", tracker7d, "progresso manuale reale"),
  ].join("");
}

function cohortRateTile(label, trackedRaw, eligibleRaw) {
  const tracked = Number(trackedRaw || 0);
  const eligible = Number(eligibleRaw || 0);
  const enoughSample = eligible >= 5;
  const value = enoughSample ? `${Math.round((tracked / eligible) * 100)}%` : "—";
  const sub = enoughSample
    ? `${fmtInt(tracked)} su ${fmtInt(eligible)}`
    : `campione ${fmtInt(eligible)} · attendo ≥5`;
  return kpiTileHtml(label, value, sub);
}

function renderTrackingCohorts(docs) {
  const snap = findLatestSnapshot(docs);
  const tracking = snap?.manualProgress || null;
  if (!tracking) {
    trackingCohortNote.textContent = i18nT("La raccolta prospettica non è ancora partita.");
    trackingCohortGrid.innerHTML = [
      cohortRateTile(i18nT("Dopo import"), 0, 0),
      cohortRateTile("D1 · ≥24h", 0, 0),
      cohortRateTile("D3 · ≥72h", 0, 0),
      cohortRateTile("D7 · ≥168h", 0, 0),
    ].join("");
    return;
  }

  const prospective = tracking.prospective || {};
  const legacy = tracking.legacyLowerBound || {};
  const useProspective = Number(prospective.successfulImporters || 0) >= 5;
  const cohort = useProspective ? prospective : tracking;
  trackingCohortNote.textContent = useProspective
    ? i18nT("Coorte prospettica esatta · {v0} importatori. D1/D3/D7 significa almeno 24/72/168 ore dopo l'import.", { v0: fmtInt(prospective.successfulImporters) })
    : i18nT("Baseline iniziale lower-bound: {v0} importatori legacy; la coorte prospettica esatta è ancora {v1}.", { v0: fmtInt(legacy.successfulImporters), v1: fmtInt(prospective.successfulImporters) });

  trackingCohortGrid.innerHTML = [
    cohortRateTile(i18nT("Dopo import"), cohort.trackedAfterImport, cohort.successfulImporters),
    cohortRateTile("D1 · ≥24h", cohort.trackedD1, cohort.eligibleD1),
    cohortRateTile("D3 · ≥72h", cohort.trackedD3, cohort.eligibleD3),
    cohortRateTile("D7 · ≥168h", cohort.trackedD7, cohort.eligibleD7),
  ].join("");
}

/* ===== Funnel (ultimi 7 giorni) ===== */

function aggregateLast7(docs) {
  const last7 = docs.slice(-7);
  const agg = {};
  for (const stage of FUNNEL_STAGES) {
    agg[stage.key] = last7.reduce((sum, d) => sum + Number(d?.[stage.key] || 0), 0);
  }
  return agg;
}

function renderFunnel(docs) {
  const agg = aggregateLast7(docs);
  const first = Number(agg[FUNNEL_STAGES[0].key] || 0);

  let html = "";
  FUNNEL_STAGES.forEach((stage, i) => {
    const value = Number(agg[stage.key] || 0);
    const pct = first > 0 ? Math.min(100, (value / first) * 100) : 0;

    if (i > 0) {
      const prevValue = Number(agg[FUNNEL_STAGES[i - 1].key] || 0);
      const dropoffPct = prevValue > 0 ? Math.round(((prevValue - value) / prevValue) * 100) : null;
      html += `<div class="metrics-funnel-dropoff">${dropoffPct != null ? `↓ ${fmtInt(dropoffPct)}% drop-off` : ""}</div>`;
    }

    html += `
      <div class="metrics-funnel-stage">
        <div class="metrics-funnel-stage-head">
          <span>${escapeHtml(stage.label)}</span>
          <strong>${fmtInt(value)}</strong>
        </div>
        <div class="metrics-funnel-track">
          <div class="metrics-funnel-bar" style="width:${pct.toFixed(1)}%"></div>
        </div>
      </div>
    `;
  });

  funnelWrap.innerHTML = html;
}

/* ===== Trend (SVG a mano, nessuna libreria) ===== */

const TREND_SERIES = [
  { key: "signups", label: "Signup/giorno", cls: "metrics-trend-signups" },
  { key: "wau", label: "WAU/giorno", cls: "metrics-trend-wau" },
  { key: "manualProgressUsers24h", label: "Tracker attivi 24h", cls: "metrics-trend-watch" },
];

function buildTrendPoints(docs) {
  return docs.map((d) => {
    const snap = d.snapshot || null;
    return {
      dateKey: d.id,
      signups: Number(d.signups || 0),
      wau: snap ? Number(snap.wau || 0) : null,
      manualProgressUsers24h: snap?.manualProgress
        ? Number(snap.manualProgress.manualProgressUsers24h || 0)
        : null,
    };
  });
}

function renderTrend(docs) {
  const points = buildTrendPoints(docs);
  const n = points.length;

  if (n < 2) {
    chartWrap.innerHTML = `<p class="analytics-muted">${i18nT("Servono almeno 2 giorni di dati per il grafico.")}</p>`;
    return;
  }

  const width = 720;
  const height = 220;
  const padL = 8;
  const padR = 8;
  const padT = 14;
  const padB = 24;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const x = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * innerW);

  const seriesRender = TREND_SERIES.map((series) => {
    const values = points.map((p) => p[series.key]);
    const known = values.filter((v) => v != null);
    const max = known.length ? Math.max(...known, 1) : 1;
    const y = (v) => padT + innerH - (v / max) * innerH;

    const segments = [];
    let current = [];
    values.forEach((v, i) => {
      if (v == null) {
        if (current.length > 1) segments.push(current);
        current = [];
        return;
      }
      current.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (current.length > 1) segments.push(current);

    const latest = known.length ? known[known.length - 1] : null;
    const polylines = segments
      .map((pts) => `<polyline class="${series.cls}" points="${pts.join(" ")}" fill="none" stroke-width="2" />`)
      .join("");

    return { ...series, latest, polylines };
  });

  const labelIdxs = n <= 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];
  const xLabels = labelIdxs
    .map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 6}" class="metrics-trend-axis-label" text-anchor="middle">${fmtDateKey(points[i].dateKey)}</text>`)
    .join("");

  const baselineY = (padT + innerH).toFixed(1);

  chartWrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="metrics-trend-svg" role="img" aria-label="${i18nT("Andamento giornaliero di signup, WAU e utenti attivi nel tracker")}">
      <line x1="${padL}" y1="${baselineY}" x2="${width - padR}" y2="${baselineY}" class="metrics-trend-axis" />
      ${seriesRender.map((s) => s.polylines).join("")}
      ${xLabels}
    </svg>
    <div class="metrics-trend-legend">
      ${seriesRender.map((s) => `
        <span class="metrics-trend-legend-item">
          <i class="${s.cls}"></i>
          ${escapeHtml(s.label)} <strong>${s.latest != null ? fmtInt(s.latest) : "—"}</strong>
        </span>
      `).join("")}
    </div>
  `;
}

/* ===== Tabella giornaliera ===== */

function renderTable(docs) {
  const rows = [...docs].reverse(); // piu' recente prima
  if (!rows.length) {
    dailyBody.innerHTML = `<tr><td colspan="10"><div class="analytics-empty">${i18nT("Nessun dato.")}</div></td></tr>`;
    return;
  }
  dailyBody.innerHTML = rows.map((d) => {
    const snap = d.snapshot || null;
    const dauWau = snap ? `${fmtInt(snap.dau)} / ${fmtInt(snap.wau)}` : "—";
    const quiz = `${fmtInt(d.quiz_played)} (+${fmtInt(d.guest_quiz_played)})`;
    const tracker24h = snap?.manualProgress
      ? fmtInt(snap.manualProgress.manualProgressUsers24h)
      : "—";
    return `
      <tr>
        <td><strong>${escapeHtml(d.id)}</strong></td>
        <td>${fmtInt(d.signup_started)}</td>
        <td>${fmtInt(d.signups)}</td>
        <td>${fmtInt(d.onboarding_completed)}</td>
        <td>${fmtInt(d.import_started)}</td>
        <td>${fmtInt(d.imports_completed)}</td>
        <td>${fmtInt(d.imports_failed)}</td>
        <td>${escapeHtml(quiz)}</td>
        <td>${escapeHtml(tracker24h)}</td>
        <td>${escapeHtml(dauWau)}</td>
      </tr>
    `;
  }).join("");
}

/* ===== Orchestrazione ===== */

function showGate() {
  gate.hidden = false;
  errorState.hidden = true;
  dashboard.hidden = true;
}

function showError(message) {
  errorText.textContent = message || i18nT("Non riesco a caricare le metriche.");
  errorState.hidden = false;
  gate.hidden = true;
  dashboard.hidden = true;
}

function showDashboard() {
  gate.hidden = true;
  errorState.hidden = true;
  dashboard.hidden = false;
}

async function loadAndRender() {
  try {
    const docs = await fetchDailyDocs();
    const noData = !docs.length || docs.every(isDocEmpty);

    showDashboard();

    if (noData) {
      noDataState.hidden = false;
      metricsContent.hidden = true;
      return;
    }

    noDataState.hidden = true;
    metricsContent.hidden = false;

    renderKpis(docs);
    renderTrackingCohorts(docs);
    renderFunnel(docs);
    renderTrend(docs);
    renderTable(docs);
  } catch (err) {
    console.error("[admin-metrics] load error", err);
    showError(err?.message);
  }
}

reloadBtn?.addEventListener("click", async () => {
  reloadBtn.disabled = true;
  const originalText = reloadBtn.textContent;
  reloadBtn.textContent = "Carico...";
  try {
    await loadAndRender();
    toast("Metriche aggiornate.", "Admin");
  } catch (err) {
    console.error("[admin-metrics] reload error", err);
    toast(err?.message || "Errore durante l'aggiornamento.", i18nT("Errore"));
  } finally {
    reloadBtn.disabled = false;
    reloadBtn.textContent = originalText;
  }
});

initAuthGuard({
  requireAuth: true,
  onReady: async (user) => {
    let meDoc = null;
    try {
      meDoc = await getMyUserDoc(user.uid);
    } catch (err) {
      console.error("[admin-metrics] getMyUserDoc error", err);
      meDoc = null;
    }
    if (!meDoc?.isAdmin) {
      showGate();
      return;
    }
    await loadAndRender();
  },
});
