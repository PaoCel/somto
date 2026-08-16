// Public, server-rendered page for ONE Somto editorial update.
//
//   officialUpdatePage -> /novita/{slug}
//
// Design (same model as titlePage.js / listPage.js):
//  * Admin SDK reads bypass Firestore rules. Questa e' esattamente la ragione
//    per cui il filtro va scritto a mano e stretto: su Somto
//    `visibility: "public"` su un post significa "pubblico fra gli iscritti",
//    non "leggibile dal web aperto" (le rules richiedono comunque isSignedIn).
//    Qui si serve SOLO il contenuto redazionale, cioe' i post scritti da
//    `somto_official` con `isOfficialUpdate === true`. Qualunque altro post e'
//    un 404 secco, senza rivelare se esiste.
//  * La pagina e' interamente server-rendered (niente SDK client, niente app
//    shell) e indicizzabile: e' contenuto editoriale pensato per essere
//    trovato e condiviso. I tag og:/twitter: sono il motivo per cui esiste —
//    servono l'anteprima su WhatsApp.
//  * Ogni valore interpolato e' HTML-escaped, anche dentro il JSON-LD.
//
// Il post vive in `posts/official_{slug}` (id deterministico costruito da
// functions/lib/officialUpdates.js). Il ritiro editoriale (unpublishOfficialUpdate)
// cancella quel documento, quindi un aggiornamento ritirato torna 404 da solo.

const functions = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { SOMTO_OFFICIAL_UID } = require("../lib/officialUpdates");

const REGION = "europe-west1";
const SITE_URL = "https://somto.it";
const FALLBACK_IMAGE = `${SITE_URL}/icons/icon-512.png`;
const PUBLIC_PATH = "/novita";
const POST_ID_PREFIX = "official_";
// Stesso tetto di MAX_LINKED_TITLES in lib/officialUpdates.js.
const MAX_LINKED_TITLES = 10;
const MAX_SOURCE_URLS = 6;

// Etichette allineate al select di public/admin-official-updates.html.
const UPDATE_TYPE_LABELS = {
  announcement: "Annuncio",
  new_season: "Nuova stagione",
  new_episode: "Nuovo episodio",
  release_date: "Data di uscita",
  renewal: "Rinnovo",
  cancellation: "Cancellazione",
  sequel: "Sequel",
  trailer: "Trailer",
  casting: "Casting",
  rumor: "Rumor",
  not_confirmed: "Non confermato",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Serializza JSON-LD sicuro dentro <script>: `<` escapato, cosi' una stringa
// non puo' chiudere l'elemento.
function jsonLdScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function asTrimmedString(value, max = 4000) {
  return String(value == null ? "" : value).slice(0, max).replace(/\s+/g, " ").trim();
}

// Come asTrimmedString ma conserva gli a capo (il corpo dell'articolo).
function asMultilineString(value, max = 4000) {
  return String(value == null ? "" : value)
    .slice(0, max)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function asStringArray(value, max = 50, maxLen = 600) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const s = asTrimmedString(raw, maxLen);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

// Slug ammessi: quelli prodotti da slugify() in lib/officialUpdates.js.
// Tutto il resto (slash, punti, unicode) e' rifiutato prima ancora di toccare
// Firestore: un doc id malformato non deve nemmeno diventare una query.
function normalizeSlug(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  if (!raw) return "";
  const withoutPrefix = raw.startsWith(POST_ID_PREFIX) ? raw.slice(POST_ID_PREFIX.length) : raw;
  return /^[a-z0-9][a-z0-9-]{0,127}$/.test(withoutPrefix) ? withoutPrefix : "";
}

// Legge lo slug dalla request: `?slug=`/`?id=` vince, altrimenti l'ultimo
// segmento non vuoto del path (/novita/insidious-al-cinema -> lo slug).
function readSlugParam(req) {
  const query = (req && req.query) || {};
  const fromQuery = asTrimmedString(query.slug || query.id || "", 256);
  if (fromQuery) return normalizeSlug(fromQuery);

  const parts = String((req && req.path) || "").split("/").filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : "";
  if (!last || last.toLowerCase() === "novita") return "";
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch (_) {
    return "";
  }
  return normalizeSlug(asTrimmedString(decoded, 256));
}

function officialPostIdForSlug(slug) {
  const normalized = normalizeSlug(slug);
  return normalized ? `${POST_ID_PREFIX}${normalized}` : "";
}

function buildOfficialUpdateUrl(slug) {
  const normalized = normalizeSlug(slug);
  return normalized ? `${SITE_URL}${PUBLIC_PATH}/${encodeURIComponent(normalized)}` : "";
}

// LA decisione di privacy della pagina, isolata perche' sia testabile e
// leggibile in un colpo d'occhio: si serve solo il post editoriale.
// Un post utente — anche `visibility: "public"` — qui e' 404.
function isServableOfficialPost(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (data.isOfficialUpdate !== true) return false;
  if (String(data.authorUid || "") !== SOMTO_OFFICIAL_UID) return false;
  if (String(data.visibility || "") !== "public") return false;
  const slug = normalizeSlug((data.officialUpdate || {}).slug);
  return !!slug;
}

function readCoverImage(data) {
  const single = asTrimmedString(data && data.mediaUrl, 600);
  if (single && isHttpUrl(single)) return single;
  const many = asStringArray(data && data.mediaUrls, 5, 600);
  const first = many.find(isHttpUrl);
  return first || "";
}

function toIsoDate(value) {
  try {
    if (value && typeof value.toDate === "function") return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  } catch (_) { /* data illeggibile: si omette, non si inventa */ }
  return "";
}

function formatItalianDate(iso) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("it-IT", {
      day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Rome",
    }).format(new Date(iso));
  } catch (_) {
    return "";
  }
}

function buildMetaDescription(summary, text, fallback, limit = 155) {
  const clean = asTrimmedString(summary, 1000) || asTrimmedString(text, 1000);
  if (!clean) return fallback;
  if (clean.length <= limit) return clean;
  const slice = clean.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 60 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s,;:.!?-]+$/, "")}…`;
}

// Corpo dell'articolo: paragrafi su riga vuota, <br> sui singoli a capo.
// L'escaping viene prima, cosi' l'unico markup che sopravvive e' il nostro.
function paragraphsHtml(text) {
  const clean = asMultilineString(text, 4000);
  if (!clean) return "";
  return clean
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p class="nv-p">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function isTv(type) {
  return String(type || "").toLowerCase() === "tv";
}

// Path pubblico del titolo, stesso schema di titlePage.canonicalPath:
// slug leggibile quando c'e', altrimenti il doc id (i vecchi link reggono).
function titlePath(type, slugOrId) {
  return `${isTv(type) ? "/serie/" : "/film/"}${encodeURIComponent(slugOrId)}`;
}

// Legge i titoli collegati. Si linkano solo i titoli `approved`: le pagine
// /film|/serie 404-ano su tutto il resto, e un link morto e' peggio di nessun
// link. Gli altri restano visibili come testo.
async function fetchLinkedTitles(db, linkedTitleIds) {
  const ids = asStringArray(linkedTitleIds, MAX_LINKED_TITLES, 120);
  if (!ids.length) return [];

  try {
    const snaps = await db.getAll(...ids.map((id) => db.collection("titles").doc(id)));
    const out = [];
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i];
      if (!snap || !snap.exists) continue;
      const d = snap.data() || {};
      const name = asTrimmedString(d.name || d.originalName, 200);
      if (!name) continue;
      const year = Number(d.year);
      const approved = asTrimmedString(d.status, 40) === "approved";
      const key = asTrimmedString(d.slug, 256) || snap.id;
      out.push({
        titleId: snap.id,
        name,
        year: Number.isFinite(year) && year > 0 ? year : null,
        posterPath: asTrimmedString(d.posterPath, 600) || null,
        type: asTrimmedString(d.type, 20) || null,
        href: approved ? titlePath(d.type, key) : "",
      });
    }
    return out;
  } catch (err) {
    logger.warn("[officialUpdatePage] fetchLinkedTitles error", { err: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

function render404() {
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Aggiornamento non trovato | Somto</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <link rel="stylesheet" href="/css/landing.bundle.css">
</head>
<body class="lp-body">
  <main class="lp-section" style="min-height:70vh;display:flex;align-items:center;justify-content:center;text-align:center;">
    <div class="lp-container">
      <h1 class="lp-h2">Aggiornamento non trovato</h1>
      <p class="lp-lead">Questa pagina non è disponibile su Somto.</p>
      <p><a class="lp-btn lp-btn-primary" href="${SITE_URL}/">Vai alla home di Somto</a></p>
    </div>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Pagina
// ---------------------------------------------------------------------------

function renderOfficialUpdatePage(postId, postData, titles) {
  const data = postData || {};
  const meta = data.officialUpdate || {};
  const slug = normalizeSlug(meta.slug);
  const canonicalUrl = buildOfficialUpdateUrl(slug);

  const title = asTrimmedString(meta.title, 160) || "Aggiornamento da Somto";
  const summary = asTrimmedString(meta.summary, 240);
  const body = asMultilineString(data.text, 2000);
  const typeLabel = UPDATE_TYPE_LABELS[asTrimmedString(meta.updateType, 40)] || "Aggiornamento";
  const sourceUrls = asStringArray(meta.sourceUrls, MAX_SOURCE_URLS, 600).filter(isHttpUrl);
  const items = Array.isArray(titles) ? titles : [];

  const publishedIso = toIsoDate(data.createdAt);
  const modifiedIso = toIsoDate(data.updatedAt) || publishedIso;
  const publishedLabel = formatItalianDate(publishedIso);

  const cover = readCoverImage(data);
  const firstPoster = items.find((it) => it.posterPath && isHttpUrl(it.posterPath));
  const ogImageUrl = cover || (firstPoster ? firstPoster.posterPath : FALLBACK_IMAGE);

  const metaDescription = buildMetaDescription(
    summary,
    body,
    `Le novità su film e serie TV, dalla redazione di Somto.`
  );
  const pageTitle = `${title} | Somto`;

  // URL in-app (richiede login) e percorso di ingresso per chi non ha account.
  const appUrl = `/community.html?post=${encodeURIComponent(postId)}`;
  const loginNext = `/login.html?signup=1&next=${encodeURIComponent(appUrl)}`;

  // ---- JSON-LD ------------------------------------------------------------
  const ld = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: title,
    url: canonicalUrl,
    mainEntityOfPage: canonicalUrl,
    inLanguage: "it",
    description: metaDescription,
    image: [ogImageUrl],
    author: { "@type": "Organization", name: "Somto", url: `${SITE_URL}/` },
    publisher: {
      "@type": "Organization",
      name: "Somto",
      logo: { "@type": "ImageObject", url: `${SITE_URL}/icons/icon-512.png` },
    },
  };
  if (publishedIso) ld.datePublished = publishedIso;
  if (modifiedIso) ld.dateModified = modifiedIso;
  const about = items
    .filter((it) => it.name)
    .map((it) => ({
      "@type": isTv(it.type) ? "TVSeries" : "Movie",
      name: it.name,
      ...(it.href ? { url: `${SITE_URL}${it.href}` } : {}),
    }));
  if (about.length) ld.about = about;

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Novità", item: `${SITE_URL}${PUBLIC_PATH}/` },
      { "@type": "ListItem", position: 3, name: title, item: canonicalUrl },
    ],
  };

  // ---- markup -------------------------------------------------------------
  const coverHtml = cover
    ? `<img class="nv-cover" src="${escapeHtml(cover)}" alt="${escapeHtml(title)}" loading="eager" decoding="async">`
    : "";

  const titlesHtml = items.length
    ? `<div class="nv-block">
        <h2 class="nv-h2">${items.length === 1 ? "Il titolo di cui si parla" : "I titoli di cui si parla"}</h2>
        <ul class="nv-titles">${items.map((it) => {
    const label = `${escapeHtml(it.name)}${it.year ? ` <span class="nv-year">(${it.year})</span>` : ""}`;
    const poster = it.posterPath && isHttpUrl(it.posterPath) ? escapeHtml(it.posterPath) : FALLBACK_IMAGE;
    const kind = isTv(it.type) ? "Serie TV" : "Film";
    const inner = `
            <img class="nv-poster" src="${poster}" alt="" width="40" height="60" loading="lazy" decoding="async">
            <span class="nv-title-info">
              <span class="nv-title-name">${label}</span>
              <span class="nv-title-kind">${kind}</span>
            </span>`;
    return it.href
      ? `<li class="nv-title-item"><a class="nv-title-link" href="${escapeHtml(it.href)}">${inner}</a></li>`
      : `<li class="nv-title-item"><span class="nv-title-link">${inner}</span></li>`;
  }).join("\n")}</ul>
      </div>`
    : "";

  const sourcesHtml = sourceUrls.length
    ? `<div class="nv-block">
        <h2 class="nv-h2">Fonti</h2>
        <ul class="nv-sources">${sourceUrls.map((url) => {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (_) { /* usa l'url */ }
    return `<li><a href="${escapeHtml(url)}" rel="nofollow noopener external" target="_blank">${escapeHtml(host)}</a></li>`;
  }).join("\n")}</ul>
      </div>`
    : "";

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(metaDescription)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <meta name="theme-color" content="#0A0A0A">
  <meta name="author" content="Somto">

  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Somto">
  <meta property="og:locale" content="it_IT">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(metaDescription)}">
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}">
  <meta property="og:image:alt" content="${escapeHtml(title)}">
  ${publishedIso ? `<meta property="article:published_time" content="${escapeHtml(publishedIso)}">` : ""}
  ${modifiedIso ? `<meta property="article:modified_time" content="${escapeHtml(modifiedIso)}">` : ""}

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(metaDescription)}">
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}">

  <link rel="icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180.png">
  <link rel="stylesheet" href="/css/landing.bundle.css">

  <script type="application/ld+json">${jsonLdScript(ld)}</script>
  <script type="application/ld+json">${jsonLdScript(breadcrumbLd)}</script>

  <style>
    .nv-wrap { max-width: 760px; margin: 0 auto; padding: 96px 20px 64px; }
    .nv-breadcrumb { font-size: 13px; color: var(--text-secondary, #A8A8A8); margin-bottom: 20px; }
    .nv-breadcrumb a { color: var(--text-secondary, #A8A8A8); text-decoration: none; }
    .nv-breadcrumb a:hover { color: var(--text-primary, #F5F5F5); }
    .nv-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .nv-chip {
      font-size: 13px; font-weight: 600; padding: 5px 12px; border-radius: 999px;
      background: rgba(255,255,255,0.06); border: 1px solid var(--border, rgba(255,255,255,0.09));
    }
    .nv-h1 { font-size: clamp(26px, 5vw, 38px); line-height: 1.18; margin: 0 0 10px; font-weight: 800; }
    .nv-meta { font-size: 14px; color: var(--text-secondary, #A8A8A8); margin: 0 0 22px; }
    .nv-cover {
      width: 100%; height: auto; border-radius: 16px; display: block; margin: 0 0 24px;
      border: 1px solid var(--border, rgba(255,255,255,0.09));
    }
    .nv-summary { font-size: 18px; line-height: 1.6; font-weight: 600; margin: 0 0 20px; }
    .nv-p { font-size: 16px; line-height: 1.7; margin: 0 0 16px; }
    .nv-cta-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 28px 0 8px; }
    .nv-block { margin-top: 32px; }
    .nv-h2 { font-size: 18px; font-weight: 700; margin: 0 0 14px; }
    .nv-titles { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .nv-title-item { margin: 0; }
    .nv-title-link {
      display: flex; align-items: center; gap: 14px; padding: 10px 14px;
      border: 1px solid var(--border, rgba(255,255,255,0.09)); border-radius: 14px;
      text-decoration: none; color: inherit;
    }
    a.nv-title-link:hover { border-color: var(--text-secondary, #A8A8A8); }
    .nv-poster {
      width: 40px; height: 60px; border-radius: 6px; object-fit: cover; flex-shrink: 0;
      background: var(--bg-secondary, #15151C);
      border: 1px solid var(--border, rgba(255,255,255,0.09));
    }
    .nv-title-info { display: flex; flex-direction: column; min-width: 0; }
    .nv-title-name { font-size: 15px; font-weight: 600; }
    .nv-year { font-weight: 400; color: var(--text-secondary, #A8A8A8); }
    .nv-title-kind { font-size: 13px; color: var(--text-secondary, #A8A8A8); }
    .nv-sources { margin: 0; padding-left: 18px; font-size: 14px; }
    .nv-sources a { color: var(--text-secondary, #A8A8A8); }
    .nv-explore { margin-top: 40px; font-size: 15px; color: var(--text-secondary, #A8A8A8); }
    .nv-explore a { color: var(--text-primary, #F5F5F5); }
    @media (max-width: 640px) {
      .nv-wrap { padding-top: 84px; }
    }
  </style>
</head>
<body class="lp-body">

  <header class="lp-nav" id="lpNav">
    <div class="lp-nav-inner">
      <a class="lp-nav-logo" href="/" aria-label="Somto — home">
        <img src="/icons/somto-wordmark.png" alt="Somto">
      </a>
      <a class="lp-nav-cta" href="${escapeHtml(loginNext)}">Entra</a>
    </div>
  </header>

  <main>
    <article class="nv-wrap">
      <nav class="nv-breadcrumb" aria-label="Percorso">
        <a href="/">Home</a> ›
        <span>Novità</span>
      </nav>

      <div class="nv-chips"><span class="nv-chip">${escapeHtml(typeLabel)}</span></div>
      <h1 class="nv-h1">${escapeHtml(title)}</h1>
      <p class="nv-meta">Dalla redazione di <strong>Somto</strong>${publishedLabel ? ` · ${escapeHtml(publishedLabel)}` : ""}</p>

      ${coverHtml}
      ${summary ? `<p class="nv-summary">${escapeHtml(summary)}</p>` : ""}
      ${paragraphsHtml(body)}

      <div class="nv-cta-row">
        <a class="lp-btn lp-btn-primary" href="${escapeHtml(loginNext)}">Continua su Somto</a>
        <a class="lp-btn lp-btn-ghost" href="${escapeHtml(appUrl)}">Apri nell'app</a>
      </div>

      ${titlesHtml}
      ${sourcesHtml}

      <p class="nv-explore">
        Su Somto segui i film e le serie TV che ti interessano e ricevi gli aggiornamenti che contano:
        <a href="/watchlist-film-serie.html">watchlist</a>,
        <a href="/app-recensioni-film-serie.html">voti e recensioni</a>,
        <a href="/quiz-film-serie-tv.html">quiz</a> e
        <a href="/consigli-film-serie-amici.html">consigli tra amici</a>.
        Torna alla <a href="/">home di Somto</a>.
      </p>
    </article>
  </main>

  <footer class="lp-footer">
    <div class="lp-footer-inner">
      <div class="lp-footer-brand">
        <img src="/icons/somto-wordmark.png" alt="Somto">
        <p>Il social per chi ama film e serie TV. Vota, scopri e decidi cosa guardare con gli amici.</p>
      </div>
      <nav class="lp-footer-cols" aria-label="Link del sito">
        <div class="lp-footer-col">
          <h4>Somto</h4>
          <a href="/">Home</a>
          <a href="${escapeHtml(loginNext)}">Accedi</a>
        </div>
        <div class="lp-footer-col">
          <h4>Scopri</h4>
          <a href="/watchlist-film-serie.html">Watchlist</a>
          <a href="/app-recensioni-film-serie.html">Voti e recensioni</a>
          <a href="/quiz-film-serie-tv.html">Quiz</a>
          <a href="/consigli-film-serie-amici.html">Consigli tra amici</a>
        </div>
        <div class="lp-footer-col">
          <h4>Legale</h4>
          <a href="/privacy.html">Privacy</a>
          <a href="/terms.html">Termini</a>
          <a href="/cookies.html">Cookie</a>
        </div>
        <div class="lp-footer-col">
          <h4>Supporto</h4>
          <a href="/support.html">Centro assistenza</a>
        </div>
      </nav>
    </div>
    <div class="lp-footer-base">© 2026 Somto. Tutti i diritti riservati.</div>
  </footer>

  <script>
    (function () {
      var nav = document.getElementById("lpNav");
      if (!nav) return;
      var onScroll = function () { nav.classList.toggle("is-scrolled", window.scrollY > 12); };
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerOfficialUpdatePage(exports) {
  exports.officialUpdatePage = functions
    .region(REGION)
    .https.onRequest(async (req, res) => {
      const notFound = () => {
        res.set("Content-Type", "text/html; charset=utf-8");
        res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
        res.status(404).send(render404());
      };

      try {
        const slug = readSlugParam(req);
        if (!slug) {
          notFound();
          return;
        }

        const db = admin.firestore();
        const postId = officialPostIdForSlug(slug);
        const snap = await db.collection("posts").doc(postId).get();
        if (!snap.exists) {
          notFound();
          return;
        }

        const data = snap.data() || {};
        // Il gate di privacy: solo contenuto editoriale. Un post utente
        // (anche "public", che su Somto vuol dire "pubblico fra gli iscritti")
        // esce da qui con lo stesso 404 di uno slug inesistente.
        if (!isServableOfficialPost(data)) {
          notFound();
          return;
        }

        const titles = await fetchLinkedTitles(db, data.linkedTitleIds || []);
        const html = renderOfficialUpdatePage(snap.id, data, titles);
        res.set("Content-Type", "text/html; charset=utf-8");
        res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
        res.status(200).send(html);
      } catch (err) {
        logger.error("[officialUpdatePage] error", err);
        res.set("Cache-Control", "no-store");
        res.status(500).send("Internal error");
      }
    });
}

module.exports = {
  registerOfficialUpdatePage,
  // Test seam (stesso pattern di listPage/quizPage).
  _normalizeSlug: normalizeSlug,
  _readSlugParam: readSlugParam,
  _officialPostIdForSlug: officialPostIdForSlug,
  _buildOfficialUpdateUrl: buildOfficialUpdateUrl,
  _isServableOfficialPost: isServableOfficialPost,
  _escapeHtml: escapeHtml,
  _paragraphsHtml: paragraphsHtml,
  _renderOfficialUpdatePage: renderOfficialUpdatePage,
  _render404: render404,
};
