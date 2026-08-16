// Public, server-rendered, SEO-indexable pages for the Somto catalog.
//
// Two HTTP functions:
//   titlePage      -> one full HTML page per title (route /film/** and /serie/**)
//   sitemapTitles  -> XML sitemap listing every approved title (/sitemap-titoli.xml)
//
// Design:
//  * Admin SDK reads bypass Firestore rules; we render ONLY titles with
//    status === "approved" — anything else is a real HTTP 404 with noindex.
//  * The page is fully server-rendered (no Firebase client SDK, no app shell):
//    visible content + JSON-LD so Google can index it. The unique value vs a
//    TMDB clone is the Somto community rating (ratingAvg / ratingCount).
//  * Every interpolated value is HTML-escaped, both in the markup and inside
//    the JSON-LD <script>, because title data is only semi-trusted.

const functions = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const REGION = "europe-west1";
const SITE_URL = "https://somto.it";
const FALLBACK_IMAGE = `${SITE_URL}/icons/icon-512.png`;
// Tetto di sicurezza, non una dimensione attesa: si scansiona a pagine finche'
// il catalogo finisce. Il vecchio valore (8000, "catalogue is in the low
// thousands") era diventato falso senza dirlo — a 20k titoli ne tagliava
// fuori 12k dalla sitemap. Se questo tetto viene toccato, si logga.
const SITEMAP_SCAN_CAP = 100000;
const SITEMAP_SCAN_PAGE = 2000;

// Storage layout for the prebuilt sitemap (refreshed by the scheduled
// `generateTitlesSitemap` job). `sitemapTitles` serves these files instead of
// scanning Firestore on every hit, so the response is cheap and fast.
const SITEMAP_STORAGE_PREFIX = "sitemaps";
const SITEMAP_INDEX_FILE = `${SITEMAP_STORAGE_PREFIX}/sitemap-titoli-index.xml`;
const SITEMAP_CHUNK_PREFIX = `${SITEMAP_STORAGE_PREFIX}/sitemap-titoli-`;
const SITEMAP_CHUNK_SIZE = 5000; // max URLs per chunk per sitemaps.org spec
const SITEMAP_MAX_CHUNKS = 10; // upper safety bound when assembling the index

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Escapes a value for safe interpolation inside HTML text/attributes.
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Escapes a value for safe interpolation inside an XML node.
function escapeXml(value) {
  return escapeHtml(value);
}

// Serialises an object as JSON-LD safe to embed inside a <script> tag:
// `<` is escaped so a malicious string can never close the script element.
function jsonLdScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function asString(value, max = 4000) {
  return String(value == null ? "" : value).slice(0, max);
}

function asTrimmedString(value, max = 4000) {
  return asString(value, max).replace(/\s+/g, " ").trim();
}

function asStringArray(value, max = 50) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const s = asTrimmedString(raw, 200);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// Quality gate per la sitemap dei titoli — esclude i doc thin-content per
// non sprecare il crawl budget di Google su pagine con poco valore unico.
// Inclusione = descrizione >= 200 char E (cast >= 3 OR ratingCount >= 1 OR trailer presente).
function passesSitemapQualityGate(title) {
  if (!title || typeof title !== "object") return false;
  const desc = String(title.description || "");
  const cast = Array.isArray(title.castWithCharacters)
    ? title.castWithCharacters
    : Array.isArray(title.cast)
      ? title.cast
      : [];
  const ratingCount = Number(title.ratingCount || title.ratingsCount || 0) || 0;
  const trailer = String(title.trailerUrl || title.trailer_url || "");
  return desc.length >= 200 && (cast.length >= 3 || ratingCount >= 1 || trailer.length > 0);
}

// Builds a meta-description from the title overview: trimmed at a word
// boundary near `limit` chars, with an ellipsis when truncated.
function buildMetaDescription(description, fallback, limit = 155) {
  const clean = asTrimmedString(description, 1000);
  if (!clean) return fallback;
  if (clean.length <= limit) return clean;
  const slice = clean.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 60 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s,;:.!?-]+$/, "")}…`;
}

// Returns an absolute https image URL, or the Somto fallback icon.
function resolveImageUrl(...candidates) {
  for (const candidate of candidates) {
    const raw = asTrimmedString(candidate, 600);
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${SITE_URL}${raw.startsWith("/") ? "" : "/"}${raw}`;
  }
  return FALLBACK_IMAGE;
}

// Reads the cast as a normalised [{ name, character }] list. Prefers the
// structured `castWithCharacters` array, falls back to the plain `cast`
// string array. Capped at `max` entries (ordered by `order` when present).
function readCast(titleData, max = 20) {
  const structured = Array.isArray(titleData.castWithCharacters)
    ? titleData.castWithCharacters
    : [];
  if (structured.length > 0) {
    return structured
      .map((row, index) => {
        const obj = row && typeof row === "object" ? row : {};
        return {
          name: asTrimmedString(obj.name, 160),
          character: asTrimmedString(obj.character, 160),
          order: Number.isFinite(Number(obj.order)) ? Number(obj.order) : index,
        };
      })
      .filter((m) => m.name)
      .sort((a, b) => a.order - b.order)
      .slice(0, max);
  }
  return asStringArray(titleData.cast, max).map((name) => ({
    name,
    character: "",
  }));
}

// Resolves the document id from the request: `?id=` wins, otherwise the last
// non-empty path segment (e.g. /film/berlino -> "berlino").
function readDocId(req) {
  const fromQuery = asTrimmedString(req.query && req.query.id, 256);
  if (fromQuery) return fromQuery;
  const parts = String(req.path || "").split("/").filter(Boolean);
  return parts.length ? asTrimmedString(decodeURIComponent(parts[parts.length - 1]), 256) : "";
}

function isTv(type) {
  return String(type || "").toLowerCase() === "tv";
}

function typeLabel(type) {
  return isTv(type) ? "Serie TV" : "Film";
}

// Returns the title's stored `slug` if it is a usable non-empty string,
// otherwise "". The slug is computed once at create-time / by the backfill.
function readSlug(titleData) {
  const slug = asTrimmedString(titleData && titleData.slug, 256);
  return slug;
}

// Canonical public path for a title, by media type. Prefers the readable
// `slug`; falls back to the Firestore document id when no slug exists yet
// (keeps OLD /film/{docId} links working).
function canonicalPath(type, slugOrId) {
  return `${isTv(type) ? "/serie/" : "/film/"}${encodeURIComponent(slugOrId)}`;
}

// ---------------------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------------------

function render404() {
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Titolo non trovato | Somto</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <link rel="stylesheet" href="/css/landing.bundle.css">
</head>
<body class="lp-body">
  <main class="lp-section" style="min-height:70vh;display:flex;align-items:center;justify-content:center;text-align:center;">
    <div class="lp-container">
      <h1 class="lp-h2">Titolo non trovato</h1>
      <p class="lp-lead">Questo film o serie TV non è disponibile su Somto.</p>
      <p><a class="lp-btn lp-btn-primary" href="${SITE_URL}/">Vai alla home di Somto</a></p>
    </div>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Title page
// ---------------------------------------------------------------------------

function renderTitlePage(docId, t, opts = {}) {
  const type = t.type;
  const tv = isTv(type);
  const label = typeLabel(type);

  const name = asTrimmedString(t.name || t.originalName, 200) || "Senza titolo";
  const originalName = asTrimmedString(t.originalName, 200);
  const year = Number.isFinite(Number(t.year)) && Number(t.year) > 0 ? Number(t.year) : null;
  const description = asTrimmedString(t.description, 4000);
  const genres = asStringArray(t.genres, 20).filter((g) => !/^tmdb_/.test(g));
  const directors = asStringArray(t.directors, 10);
  const cast = readCast(t, 20);
  const trailerUrl = asTrimmedString(t.trailerUrl, 600);
  const trailerHref = /^https?:\/\//i.test(trailerUrl) ? trailerUrl : "";

  const ratingCount = Number.isFinite(Number(t.ratingCount)) ? Number(t.ratingCount) : 0;
  const ratingAvgRaw = Number(t.ratingAvg);
  const ratingAvg = Number.isFinite(ratingAvgRaw) && ratingAvgRaw > 0 ? ratingAvgRaw : 0;
  const hasRating = ratingCount > 0 && ratingAvg > 0;
  const reviewCount = Number.isFinite(Number(t.reviewCount)) ? Number(t.reviewCount) : 0;

  const meta = t.meta && typeof t.meta === "object" ? t.meta : {};
  const durationMovie = Number(meta.durationMovie) || 0;
  const durationEpisode = Number(meta.durationEpisode) || 0;
  const seasonsCount = Number(meta.seasonsCount) || 0;
  const network = asTrimmedString(meta.network, 120);

  const imageUrl = resolveImageUrl(t.posterPath, t.backdropPath);
  const hasPoster = /^https?:\/\//i.test(asTrimmedString(t.posterPath, 600));
  // Canonical URL: always the readable slug when the title has one, else the
  // document id (keeps legacy /film/{docId} links valid).
  const canonicalKey = readSlug(t) || docId;
  const canonicalUrl = `${SITE_URL}${canonicalPath(type, canonicalKey)}`;

  const pageTitle = `${name}${year ? ` (${year})` : ""} — ${label} | Somto`;
  const metaDescription = buildMetaDescription(
    description,
    `Scopri ${name}${year ? ` (${year})` : ""} su Somto: trama, cast, generi e il voto della community.`
  );

  // ---- structured metadata facts (visible chips) --------------------------
  const facts = [];
  facts.push(label);
  if (year) facts.push(String(year));
  if (tv && seasonsCount > 0) {
    facts.push(`${seasonsCount} stagion${seasonsCount === 1 ? "e" : "i"}`);
  }
  if (!tv && durationMovie > 0) facts.push(`${durationMovie} min`);
  if (tv && durationEpisode > 0) facts.push(`${durationEpisode} min/episodio`);
  if (network) facts.push(network);

  // ---- JSON-LD ------------------------------------------------------------
  const ld = {
    "@context": "https://schema.org",
    "@type": tv ? "TVSeries" : "Movie",
    name,
    url: canonicalUrl,
  };
  if (description) ld.description = metaDescription;
  if (imageUrl) ld.image = imageUrl;
  if (genres.length) ld.genre = genres;
  if (year) ld.datePublished = String(year);
  if (originalName && originalName !== name) ld.alternateName = originalName;
  if (directors.length) {
    ld.director = directors.map((d) => ({ "@type": "Person", name: d }));
  }
  if (cast.length) {
    ld.actor = cast.slice(0, 10).map((m) => ({ "@type": "Person", name: m.name }));
  }
  if (hasRating) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Math.round(ratingAvg * 10) / 10,
      ratingCount,
      bestRating: 10,
      worstRating: 1,
    };
  }

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      {
        "@type": "ListItem",
        position: 2,
        name: tv ? "Serie TV" : "Film",
        item: `${SITE_URL}${tv ? "/serie/" : "/film/"}`,
      },
      { "@type": "ListItem", position: 3, name, item: canonicalUrl },
    ],
  };

  // ---- visible content blocks --------------------------------------------
  const loginNext = `/login.html?next=${encodeURIComponent(`/title.html?id=${docId}`)}`;

  const factsHtml = facts
    .map((f) => `<span class="t-chip">${escapeHtml(f)}</span>`)
    .join("");

  const genresHtml = genres.length
    ? `<div class="t-block">
        <h2 class="t-h2">Generi</h2>
        <div class="t-tags">${genres
          .map((g) => `<span class="t-tag">${escapeHtml(g)}</span>`)
          .join("")}</div>
      </div>`
    : "";

  const descriptionHtml = description
    ? `<div class="t-block">
        <h2 class="t-h2">Trama</h2>
        <p class="t-text">${escapeHtml(description)}</p>
      </div>`
    : "";

  const directorsHtml = directors.length
    ? `<div class="t-block">
        <h2 class="t-h2">${directors.length > 1 ? "Regia" : "Regista"}</h2>
        <p class="t-text">${escapeHtml(directors.join(", "))}</p>
      </div>`
    : "";

  const castHtml = cast.length
    ? `<div class="t-block">
        <h2 class="t-h2">Cast</h2>
        <ul class="t-cast">${cast
          .map((m) => {
            const role = m.character
              ? ` <span class="t-cast-role">— ${escapeHtml(m.character)}</span>`
              : "";
            return `<li class="t-cast-item"><span class="t-cast-name">${escapeHtml(m.name)}</span>${role}</li>`;
          })
          .join("")}</ul>
      </div>`
    : "";

  const trailerHtml = trailerHref
    ? `<div class="t-block">
        <h2 class="t-h2">Trailer</h2>
        <p><a class="lp-btn lp-btn-ghost" href="${escapeHtml(trailerHref)}" target="_blank" rel="noopener nofollow">Guarda il trailer</a></p>
      </div>`
    : "";

  // Somto community rating — the unique editorial value of the page.
  const ratingHtml = hasRating
    ? `<div class="t-rating">
        <div class="t-rating-score">${escapeHtml((Math.round(ratingAvg * 10) / 10).toFixed(1))}</div>
        <div class="t-rating-meta">
          <strong>Voto della community Somto</strong>
          <span>${ratingCount} ${ratingCount === 1 ? "voto" : "voti"}${
        reviewCount > 0
          ? ` · ${reviewCount} ${reviewCount === 1 ? "recensione" : "recensioni"}`
          : ""
      }</span>
        </div>
      </div>`
    : `<div class="t-rating t-rating-empty">
        <div class="t-rating-meta">
          <strong>Ancora nessun voto su Somto</strong>
          <span>Sii il primo a votare ${escapeHtml(name)}.</span>
        </div>
      </div>`;

  const posterAlt = `Locandina di ${name}${year ? ` (${year})` : ""}`;

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(metaDescription)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta name="robots" content="index,follow">
  <meta name="theme-color" content="#0A0A0A">
  <meta name="author" content="Somto">

  <meta property="og:type" content="${tv ? "video.tv_show" : "video.movie"}">
  <meta property="og:site_name" content="Somto">
  <meta property="og:locale" content="it_IT">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(`${name}${year ? ` (${year})` : ""} — ${label}`)}">
  <meta property="og:description" content="${escapeHtml(metaDescription)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:alt" content="${escapeHtml(posterAlt)}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(`${name}${year ? ` (${year})` : ""} — ${label}`)}">
  <meta name="twitter:description" content="${escapeHtml(metaDescription)}">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">

  <link rel="icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180.png">
  <link rel="stylesheet" href="/css/landing.bundle.css">

  <link rel="preload" as="image" href="${escapeHtml(imageUrl)}" fetchpriority="high">

  <script type="application/ld+json">${jsonLdScript(ld)}</script>
  <script type="application/ld+json">${jsonLdScript(breadcrumbLd)}</script>

  <style>
    .t-wrap { max-width: 1000px; margin: 0 auto; padding: 96px 20px 64px; }
    .t-breadcrumb { font-size: 13px; color: var(--text-secondary, #A8A8A8); margin-bottom: 20px; }
    .t-breadcrumb a { color: var(--text-secondary, #A8A8A8); text-decoration: none; }
    .t-breadcrumb a:hover { color: var(--text-primary, #F5F5F5); }
    .t-head { display: flex; gap: 28px; flex-wrap: wrap; align-items: flex-start; }
    .t-poster {
      width: 240px; max-width: 100%; aspect-ratio: 2 / 3; border-radius: 18px;
      object-fit: cover; background: var(--bg-secondary, #15151C);
      border: 1px solid var(--border, rgba(255,255,255,0.09));
      box-shadow: 0 18px 50px rgba(0,0,0,0.45);
    }
    .t-head-main { flex: 1; min-width: 280px; }
    .t-h1 { font-size: clamp(28px, 5vw, 40px); line-height: 1.15; margin: 0 0 6px; font-weight: 800; }
    .t-original { color: var(--text-secondary, #A8A8A8); font-size: 15px; margin: 0 0 16px; }
    .t-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
    .t-chip {
      font-size: 13px; font-weight: 600; padding: 5px 12px; border-radius: 999px;
      background: rgba(255,255,255,0.06); border: 1px solid var(--border, rgba(255,255,255,0.09));
    }
    .t-rating {
      display: flex; align-items: center; gap: 16px; padding: 16px 18px;
      border-radius: 16px; background: rgba(255,255,255,0.05);
      border: 1px solid var(--border, rgba(255,255,255,0.09)); margin-bottom: 20px;
    }
    .t-rating-score {
      font-size: 34px; font-weight: 800; line-height: 1;
      background: linear-gradient(120deg, #F77737, #E91E63, #9C27B0);
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .t-rating-meta { display: flex; flex-direction: column; gap: 2px; }
    .t-rating-meta strong { font-size: 15px; }
    .t-rating-meta span { font-size: 13px; color: var(--text-secondary, #A8A8A8); }
    .t-rating-empty .t-rating-meta strong { font-weight: 700; }
    .t-cta-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
    .t-block { margin-top: 32px; }
    .t-h2 { font-size: 20px; font-weight: 700; margin: 0 0 10px; }
    .t-text { font-size: 16px; line-height: 1.65; color: var(--text-primary, #F5F5F5); margin: 0; }
    .t-tags { display: flex; flex-wrap: wrap; gap: 8px; }
    .t-tag {
      font-size: 13px; padding: 5px 12px; border-radius: 999px;
      background: rgba(255,255,255,0.06); border: 1px solid var(--border, rgba(255,255,255,0.09));
    }
    .t-cast { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
    .t-cast-item { font-size: 15px; }
    .t-cast-name { font-weight: 600; }
    .t-cast-role { color: var(--text-secondary, #A8A8A8); }
    .t-explore { margin-top: 40px; font-size: 15px; color: var(--text-secondary, #A8A8A8); }
    .t-explore a { color: var(--text-primary, #F5F5F5); }
    @media (max-width: 640px) {
      .t-wrap { padding-top: 84px; }
      .t-poster { width: 160px; margin: 0 auto; }
      .t-head { gap: 20px; }
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
    <article class="t-wrap">
      <nav class="t-breadcrumb" aria-label="Percorso">
        <a href="/">Home</a> ›
        <a href="${tv ? "/serie/" : "/film/"}">${tv ? "Serie TV" : "Film"}</a> ›
        <span>${escapeHtml(name)}</span>
      </nav>

      <div class="t-head">
        <img class="t-poster" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(posterAlt)}"
             width="240" height="360" fetchpriority="high" loading="eager" decoding="async">
        <div class="t-head-main">
          <h1 class="t-h1">${escapeHtml(name)}</h1>
          ${
            originalName && originalName !== name
              ? `<p class="t-original">Titolo originale: ${escapeHtml(originalName)}</p>`
              : ""
          }
          <div class="t-chips">${factsHtml}</div>
          ${ratingHtml}
          <div class="t-cta-row">
            ${opts.hasQuiz
              ? `<a class="lp-btn lp-btn-primary" href="/quiz-prova.html?titleId=${encodeURIComponent(docId)}">🎮 Gioca il quiz su ${escapeHtml(name)}</a>
                 <a class="lp-btn lp-btn-ghost" href="${escapeHtml(loginNext)}">Vota e salva su Somto</a>`
              : `<a class="lp-btn lp-btn-primary" href="${escapeHtml(loginNext)}">Vota e salva su Somto</a>
                 <a class="lp-btn lp-btn-ghost" href="/">Scopri Somto</a>`}
          </div>
        </div>
      </div>

      ${descriptionHtml}
      ${genresHtml}
      ${directorsHtml}
      ${castHtml}
      ${trailerHtml}

      <p class="t-explore">
        ${opts.hasQuiz ? `Fai il <a href="/quiz/${encodeURIComponent(canonicalKey)}">quiz su ${escapeHtml(name)}</a> e ` : ""}su Somto puoi <a href="/app-recensioni-film-serie.html">votare e recensire film e serie TV</a>,
        creare la tua <a href="/watchlist-film-serie.html">watchlist</a> e sfidare gli amici ai
        <a href="/quiz-film-serie-tv.html">quiz su film e serie TV</a>.
        Torna alla <a href="/">home di Somto</a> per scoprire tutto il catalogo.
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

// Resolves the route param to a title document.
//
// The URL param can be either a readable `slug` (new links) or a raw Firestore
// document id (legacy links). Resolution order:
//   1. query `titles where slug == {param}` limit 1  -> matched by slug
//   2. otherwise `titles.doc(param).get()`           -> matched by docId
//
// The `slug ==` equality query only needs the automatic single-field index.
// Returns `{ snap, matchedBy }` with `matchedBy` ∈ {"slug","docId"}, or null.
// Set dei titleId che hanno domande quiz giocabili, da quizMeta/themes.
// Cache in-process (10 min) → ~1 read ogni 10 min per istanza, non per hit.
let _quizTitleIdsCache = { ids: null, at: 0 };
async function getQuizTitleIds(db) {
  const now = Date.now();
  if (_quizTitleIdsCache.ids && now - _quizTitleIdsCache.at < 600000) {
    return _quizTitleIdsCache.ids;
  }
  try {
    const snap = await db.collection("quizMeta").doc("themes").get();
    const themes = (snap.exists && snap.data() && snap.data().themes) || [];
    const ids = new Set(themes.map((x) => x && x.titleId).filter(Boolean));
    _quizTitleIdsCache = { ids, at: now };
    return ids;
  } catch (err) {
    return _quizTitleIdsCache.ids || new Set();
  }
}

async function resolveTitle(db, param) {
  const bySlug = await db
    .collection("titles")
    .where("slug", "==", param)
    .limit(1)
    .get();
  if (!bySlug.empty) {
    return { snap: bySlug.docs[0], matchedBy: "slug" };
  }
  const byId = await db.collection("titles").doc(param).get();
  if (byId.exists) {
    return { snap: byId, matchedBy: "docId" };
  }
  return null;
}

function registerTitlePage(exports) {
  // -- titlePage : SSR public page for one catalogue title ------------------
  exports.titlePage = functions
    .region(REGION)
    .https.onRequest(async (req, res) => {
      try {
        const param = readDocId(req);
        if (!param) {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.status(404).send(render404());
          return;
        }

        const db = admin.firestore();
        const resolved = await resolveTitle(db, param);

        if (!resolved) {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.status(404).send(render404());
          return;
        }

        const { snap, matchedBy } = resolved;
        const data = snap.data() || {};
        if (asTrimmedString(data.status, 40) !== "approved") {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.status(404).send(render404());
          return;
        }

        // Legacy /film/{docId} hit on a title that now has a slug: 301 to the
        // canonical readable URL so search engines consolidate on one URL.
        const slug = asTrimmedString(data.slug, 256);
        if (matchedBy === "docId" && slug && slug !== param) {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.redirect(301, `${SITE_URL}${canonicalPath(data.type, slug)}`);
          return;
        }

        const quizIds = await getQuizTitleIds(db);
        const html = renderTitlePage(snap.id, data, { hasQuiz: quizIds.has(snap.id) });
        res.set("Content-Type", "text/html; charset=utf-8");
        res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
        res.status(200).send(html);
      } catch (err) {
        logger.error("[titlePage] error", err);
        res.set("Cache-Control", "no-store");
        res.status(500).send("Internal error");
      }
    });

  // -- sitemapTitles : serves prebuilt sitemap files from Storage -----------
  //
  // The actual generation runs once a day in `generateTitlesSitemap`, which
  // writes:
  //   gs://<bucket>/sitemaps/sitemap-titoli-index.xml  (sitemap index)
  //   gs://<bucket>/sitemaps/sitemap-titoli-1.xml      (chunk 1)
  //   gs://<bucket>/sitemaps/sitemap-titoli-2.xml      (chunk 2)
  //   ...
  //
  // Routing on this handler is by query param `?chunk=N` (matched by hosting
  // rewrites). Defaults to the first chunk when no param is supplied, which
  // keeps the legacy `/sitemap-titoli.xml` URL working. `?index=1` (or path
  // hint via `sitemap-titoli-index`) returns the sitemap index.
  exports.sitemapTitles = functions
    .region(REGION)
    .https.onRequest(async (req, res) => {
      try {
        const bucket = admin.storage().bucket();

        // Pick the file to serve. Path-based hints win, then query, then default.
        const path = String(req.path || "").toLowerCase();
        const wantIndex =
          path.includes("sitemap-titoli-index") ||
          String(req.query && req.query.index || "") === "1";
        const chunkRaw = Number(req.query && req.query.chunk);
        const chunkN = Number.isFinite(chunkRaw) && chunkRaw >= 1 ? Math.floor(chunkRaw) : 1;

        const objectPath = wantIndex
          ? SITEMAP_INDEX_FILE
          : `${SITEMAP_CHUNK_PREFIX}${chunkN}.xml`;

        const file = bucket.file(objectPath);
        const [exists] = await file.exists();
        if (!exists) {
          // No prebuilt sitemap yet — surface a small empty urlset instead of
          // a 500 so Google sees a valid (if empty) document until the first
          // scheduled run completes.
          const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
          res.set("Content-Type", "application/xml; charset=utf-8");
          res.set("Cache-Control", "public, max-age=300, s-maxage=600");
          res.status(200).send(fallback);
          return;
        }

        const [buffer] = await file.download();
        res.set("Content-Type", "application/xml; charset=utf-8");
        res.set("Cache-Control", "public, max-age=3600, s-maxage=21600");
        res.status(200).send(buffer);
      } catch (err) {
        logger.error("[sitemapTitles] error", err);
        res.set("Cache-Control", "no-store");
        res.status(500).send("Internal error");
      }
    });

  // -- generateTitlesSitemap : daily rebuild of the titles sitemap ----------
  //
  // Scans approved titles, applica il quality gate per escludere i doc
  // thin-content (`passesSitemapQualityGate`), chunks per 5000 URLs per file
  // (sitemap spec), e scrive ogni chunk in Storage + un index che li referenzia.
  // È la source-of-truth servita da `sitemapTitles`.
  exports.generateTitlesSitemap = functions
    .region(REGION)
    .runWith({ memory: "512MB", timeoutSeconds: 540 })
    .pubsub.schedule("every 24 hours")
    .timeZone("Europe/Rome")
    .onRun(async () => {
      const db = admin.firestore();
      const bucket = admin.storage().bucket();
      const generatedAt = new Date().toISOString();

      // Scan approved titles, a pagine. Per applicare il quality gate dobbiamo
      // leggere i campi description/cast/ratingCount/trailerUrl oltre a
      // type/slug.
      const baseQuery = db
        .collection("titles")
        .where("status", "==", "approved")
        .select(
          "type",
          "slug",
          "description",
          "castWithCharacters",
          "cast",
          "ratingCount",
          "trailerUrl"
        )
        .orderBy(admin.firestore.FieldPath.documentId());

      const urls = [];
      let total = 0;
      let excluded = 0;
      let cursor = null;
      let capReached = false;

      for (;;) {
        let page = baseQuery.limit(SITEMAP_SCAN_PAGE);
        if (cursor) page = page.startAfter(cursor);
        const snap = await page.get();
        if (snap.empty) break;
        cursor = snap.docs[snap.docs.length - 1];

        snap.forEach((doc) => {
          total += 1;
          const data = doc.data() || {};
          if (!passesSitemapQualityGate(data)) {
            excluded += 1;
            return;
          }
          const key = readSlug(data) || doc.id;
          urls.push(`${SITE_URL}${canonicalPath(data.type, key)}`);
        });

        if (snap.size < SITEMAP_SCAN_PAGE) break;
        if (total >= SITEMAP_SCAN_CAP) {
          capReached = true;
          break;
        }
      }

      if (capReached) {
        // Mai troncare in silenzio: se si arriva qui il catalogo ha superato il
        // tetto e la sitemap sta perdendo pagine.
        logger.warn(
          `Sitemap: raggiunto SITEMAP_SCAN_CAP (${SITEMAP_SCAN_CAP}), catalogo troncato`
        );
      }
      logger.info(
        `Sitemap: excluded ${excluded} thin-content titles out of ${total}`
      );

      // Chunk into files of SITEMAP_CHUNK_SIZE URLs each.
      const chunks = [];
      for (let i = 0; i < urls.length; i += SITEMAP_CHUNK_SIZE) {
        chunks.push(urls.slice(i, i + SITEMAP_CHUNK_SIZE));
        if (chunks.length >= SITEMAP_MAX_CHUNKS) break;
      }
      // Always produce at least chunk 1, even if empty, so the public URL
      // (`/sitemap-titoli.xml`) keeps returning a well-formed document.
      if (chunks.length === 0) chunks.push([]);

      const chunkContentType = "application/xml; charset=utf-8";
      const writeOptions = {
        contentType: chunkContentType,
        // Tell Hosting/CDN to cache for an hour; the bucket itself is
        // overwritten daily by this job.
        metadata: { cacheControl: "public, max-age=3600" },
        resumable: false,
        public: true,
      };

      // Write each chunk file.
      const chunkUrls = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const idx = i + 1;
        const rows = chunks[i]
          .map((loc) => `  <url><loc>${escapeXml(loc)}</loc></url>`)
          .join("\n");
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows}
</urlset>`;
        const objectPath = `${SITEMAP_CHUNK_PREFIX}${idx}.xml`;
        await bucket.file(objectPath).save(xml, writeOptions);
        chunkUrls.push(`${SITE_URL}/sitemap-titoli-${idx}.xml`);
      }

      // Build the sitemap index that references each chunk.
      const indexRows = chunkUrls
        .map(
          (loc) =>
            `  <sitemap><loc>${escapeXml(loc)}</loc><lastmod>${generatedAt}</lastmod></sitemap>`
        )
        .join("\n");
      const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexRows}
</sitemapindex>`;
      await bucket.file(SITEMAP_INDEX_FILE).save(indexXml, writeOptions);

      logger.info("[generateTitlesSitemap] done", {
        urlCount: urls.length,
        chunkCount: chunks.length,
      });
      return null;
    });
}

module.exports = { registerTitlePage };
