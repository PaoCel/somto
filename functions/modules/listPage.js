// Public, server-rendered, SEO-indexable pages for Somto user lists.
//
// Two HTTP functions:
//   listPage      -> /lista/{slug}  : one full HTML page per public list
//   sitemapLists  -> /sitemap-lista.xml : lists all public list slugs
//
// Design (same model as titlePage.js / quizPage.js):
//  * Admin SDK reads bypass Firestore rules; we render ONLY lists with
//    visibility === "public" — anything else is a real HTTP 404 with noindex.
//  * The page is fully server-rendered (no Firebase client SDK, no app shell):
//    visible content + JSON-LD so Google can index it.
//  * Every interpolated value is HTML-escaped, both in the markup and inside
//    the JSON-LD <script>, because user-generated data is untrusted.
//  * Slug resolution: query userLists where slug == param, then fallback
//    to editorialSlug == param, then 404.
//  * Legacy /lista/{listId} hits: if matched by docId and a slug exists,
//    redirect 301 to /lista/{slug}.

const functions = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const REGION = "europe-west1";
const SITE_URL = "https://somto.it";
const FALLBACK_IMAGE = `${SITE_URL}/icons/icon-512.png`;

// Max items to fetch and render on the public page (for perf + SEO quality).
const MAX_RENDER_ITEMS = 30;
// Max lists to include in the sitemap per scan.
const SITEMAP_SCAN_CAP = 5000;

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

function escapeXml(value) {
  return escapeHtml(value);
}

function jsonLdScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function asTrimmedString(value, max = 4000) {
  return String(value == null ? "" : value).slice(0, max).replace(/\s+/g, " ").trim();
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

// Reads the route param from the request: ?id= wins, otherwise the last
// non-empty path segment (e.g. /lista/mcu-cronologico-abc123 -> slug).
function readParam(req) {
  const fromQuery = asTrimmedString((req.query && req.query.id) || "", 256);
  if (fromQuery) return fromQuery;
  const parts = String(req.path || "").split("/").filter(Boolean);
  // /lista/{slug} -> last segment; ignore "lista"
  const last = parts.length ? parts[parts.length - 1] : "";
  if (!last || last.toLowerCase() === "lista") return "";
  return asTrimmedString(decodeURIComponent(last), 256);
}

// Resolves a userList document by slug (or editorialSlug as fallback).
// Returns { snap, matchedBy } or null.
// Resolution order:
//   1. where slug == param
//   2. where editorialSlug == param
//   3. direct doc get by param (legacy /lista/{listId} links)
async function resolveList(db, param) {
  const bySlug = await db
    .collection("userLists")
    .where("slug", "==", param)
    .limit(1)
    .get();
  if (!bySlug.empty) {
    return { snap: bySlug.docs[0], matchedBy: "slug" };
  }

  const byEditorial = await db
    .collection("userLists")
    .where("editorialSlug", "==", param)
    .limit(1)
    .get();
  if (!byEditorial.empty) {
    return { snap: byEditorial.docs[0], matchedBy: "editorialSlug" };
  }

  // Fallback: legacy /lista/{listId} direct-id hit.
  try {
    const byId = await db.collection("userLists").doc(param).get();
    if (byId.exists) {
      return { snap: byId, matchedBy: "docId" };
    }
  } catch (_) {
    // invalid doc id (e.g. path segments with /) — treat as 404
  }

  return null;
}

// Fetches up to MAX_RENDER_ITEMS title documents for the list, returning
// [{ titleId, name, year, posterPath, type }] in the list's item order.
async function fetchListTitleItems(db, listData) {
  // Prefer itemTitleIds array (denormalized on the list doc for fast reads).
  const itemTitleIds = asStringArray(listData.itemTitleIds, 200);
  let orderedIds = itemTitleIds.slice(0, MAX_RENDER_ITEMS);

  if (!orderedIds.length) {
    // Fall back to reading the items subcollection ordered by orderIndex.
    // This path is slower but keeps old data correct.
    try {
      // We need the list ref — caller passes listData which may not have ref.
      // The caller will pass listId so we can build the ref.
      return [];
    } catch (_) {
      return [];
    }
  }

  if (!orderedIds.length) return [];

  // getAll for the title docs.
  const refs = orderedIds.map((id) => db.collection("titles").doc(id));
  try {
    const snaps = await db.getAll(...refs);
    const results = [];
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      const titleId = orderedIds[i];
      if (!s || !s.exists) {
        // Include a placeholder so the position is preserved.
        results.push({ titleId, name: null, year: null, posterPath: null, type: null });
        continue;
      }
      const d = s.data() || {};
      results.push({
        titleId,
        name: asTrimmedString(d.name || d.originalName, 200) || null,
        year: Number.isFinite(Number(d.year)) && Number(d.year) > 0 ? Number(d.year) : null,
        posterPath: asTrimmedString(d.posterPath, 600) || null,
        type: asTrimmedString(d.type, 20) || null,
      });
    }
    return results;
  } catch (err) {
    logger.warn("[listPage] fetchListTitleItems error", { err: String(err) });
    return [];
  }
}

// Same as above but also reads from the items subcollection when itemTitleIds
// is missing. This is the full version used by the CF.
async function fetchListItems(db, listId, listData) {
  const itemTitleIds = asStringArray(listData.itemTitleIds, 200);
  let orderedIds = itemTitleIds.slice(0, MAX_RENDER_ITEMS);

  if (!orderedIds.length) {
    try {
      const itemsSnap = await db
        .collection("userLists")
        .doc(listId)
        .collection("items")
        .orderBy("orderIndex")
        .limit(MAX_RENDER_ITEMS)
        .get();
      orderedIds = itemsSnap.docs.map((d) => d.id);
    } catch (_) {
      return [];
    }
  }

  if (!orderedIds.length) return [];

  const refs = orderedIds.map((id) => db.collection("titles").doc(id));
  try {
    const snaps = await db.getAll(...refs);
    const results = [];
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      const titleId = orderedIds[i];
      if (!s || !s.exists) {
        results.push({ titleId, name: null, year: null, posterPath: null, type: null });
        continue;
      }
      const d = s.data() || {};
      results.push({
        titleId,
        name: asTrimmedString(d.name || d.originalName, 200) || null,
        year: Number.isFinite(Number(d.year)) && Number(d.year) > 0 ? Number(d.year) : null,
        posterPath: asTrimmedString(d.posterPath, 600) || null,
        type: asTrimmedString(d.type, 20) || null,
      });
    }
    return results;
  } catch (err) {
    logger.warn("[listPage] fetchListItems error", { err: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------------------

function render404() {
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Lista non trovata | Somto</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <link rel="stylesheet" href="/css/landing.bundle.css">
</head>
<body class="lp-body">
  <main class="lp-section" style="min-height:70vh;display:flex;align-items:center;justify-content:center;text-align:center;">
    <div class="lp-container">
      <h1 class="lp-h2">Lista non trovata</h1>
      <p class="lp-lead">Questa lista non è disponibile o non è pubblica su Somto.</p>
      <p><a class="lp-btn lp-btn-primary" href="${SITE_URL}/">Vai alla home di Somto</a></p>
    </div>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// List page renderer
// ---------------------------------------------------------------------------

function renderListPage(listId, listData, items) {
  const title = asTrimmedString(listData.title, 120) || "Lista senza nome";
  const description = asTrimmedString(listData.description, 280) || "";
  const ownerName = asTrimmedString(listData.ownerDisplayName || listData.ownerName, 80) || "Somto";
  const kind = asTrimmedString(listData.kind, 40);
  const isOrderedPath = kind === "ordered_path";
  const itemCount = Number(listData.itemCount) || items.length;

  // Canonical URL: prefer slug, then editorialSlug, then listId.
  const slugCanonical =
    asTrimmedString(listData.slug, 256) ||
    asTrimmedString(listData.editorialSlug, 256) ||
    listId;
  const canonicalUrl = `${SITE_URL}/lista/${encodeURIComponent(slugCanonical)}`;

  // In-app interactive URL (signed-in).
  const appUrl = `/lista.html?id=${encodeURIComponent(listId)}`;
  const loginNext = `/login.html?signup=1&next=${encodeURIComponent(appUrl)}`;

  const pageTitle = `${title} — Lista di ${ownerName} | Somto`;
  const metaDescription = description
    ? (description.length <= 155 ? description : description.slice(0, 152) + "…")
    : `Scopri la lista "${title}" di ${ownerName} su Somto: ${itemCount > 0 ? `${itemCount} ${itemCount === 1 ? "titolo" : "titoli"}` : "film e serie TV"} da vedere.`;

  // Best poster image: use the first item's posterPath, then cover, then fallback.
  let ogImageUrl = FALLBACK_IMAGE;
  const coverImageUrl = listData.cover &&
    typeof listData.cover === "object" &&
    listData.cover.imageUrl ? asTrimmedString(listData.cover.imageUrl, 600) : null;
  if (coverImageUrl && /^https?:\/\//i.test(coverImageUrl)) {
    ogImageUrl = coverImageUrl;
  } else {
    const firstWithPoster = items.find((it) => it.posterPath && /^https?:\/\//i.test(it.posterPath));
    if (firstWithPoster) ogImageUrl = firstWithPoster.posterPath;
  }

  // ---- JSON-LD: schema.org ItemList + BreadcrumbList ----------------------
  const itemListElements = items
    .filter((it) => it.name)
    .map((it, index) => {
      const typePrefix = it.type && it.type.toLowerCase() === "tv" ? "/serie/" : "/film/";
      const titleUrl = `${SITE_URL}${typePrefix}${encodeURIComponent(it.titleId)}`;
      return {
        "@type": "ListItem",
        position: index + 1,
        name: it.name,
        url: titleUrl,
      };
    });

  const ld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    url: canonicalUrl,
    inLanguage: "it",
    author: { "@type": "Person", name: ownerName },
  };
  if (description) ld.description = metaDescription;
  if (itemCount > 0) ld.numberOfItems = itemCount;
  if (isOrderedPath) ld.itemListOrder = "https://schema.org/ItemListOrderedByPosition";
  if (itemListElements.length) ld.itemListElement = itemListElements;

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Liste", item: `${SITE_URL}/watchlist-film-serie.html` },
      { "@type": "ListItem", position: 3, name: title, item: canonicalUrl },
    ],
  };

  // ---- items HTML ----------------------------------------------------------
  const itemsHtml = items.length
    ? items
        .map((it, index) => {
          const nameDisplay = it.name ? escapeHtml(it.name) : "<em>Titolo rimosso</em>";
          const yearDisplay = it.year ? ` (${it.year})` : "";
          const posterSrc = it.posterPath && /^https?:\/\//i.test(it.posterPath)
            ? escapeHtml(it.posterPath)
            : FALLBACK_IMAGE;
          const typePrefix = it.type && it.type.toLowerCase() === "tv" ? "/serie/" : "/film/";
          const titleHref = `${typePrefix}${encodeURIComponent(it.titleId)}`;
          const position = isOrderedPath
            ? `<span class="li-position">${index + 1}</span>`
            : "";
          return `<li class="li-item">
          ${position}
          <a class="li-poster-link" href="${escapeHtml(titleHref)}" tabindex="-1" aria-hidden="true">
            <img class="li-poster" src="${posterSrc}" alt="${it.name ? `Locandina di ${escapeHtml(it.name)}` : "Titolo"}" width="60" height="90" loading="lazy" decoding="async">
          </a>
          <div class="li-info">
            <a class="li-title" href="${escapeHtml(titleHref)}">${nameDisplay}</a>
            <span class="li-year">${escapeHtml(yearDisplay)}</span>
          </div>
        </li>`;
        })
        .join("\n")
    : `<li class="li-empty">Nessun titolo in questa lista.</li>`;

  const itemCountChip = itemCount > 0
    ? `<span class="t-chip">${itemCount} ${itemCount === 1 ? "titolo" : "titoli"}</span>`
    : "";
  const kindChip = isOrderedPath
    ? `<span class="t-chip">Percorso ordinato</span>`
    : `<span class="t-chip">Raccolta</span>`;

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

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Somto">
  <meta property="og:locale" content="it_IT">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(metaDescription)}">
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}">

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
    .t-wrap { max-width: 860px; margin: 0 auto; padding: 96px 20px 64px; }
    .t-breadcrumb { font-size: 13px; color: var(--text-secondary, #A8A8A8); margin-bottom: 20px; }
    .t-breadcrumb a { color: var(--text-secondary, #A8A8A8); text-decoration: none; }
    .t-breadcrumb a:hover { color: var(--text-primary, #F5F5F5); }
    .t-h1 { font-size: clamp(24px, 5vw, 36px); line-height: 1.2; margin: 0 0 8px; font-weight: 800; }
    .t-meta { font-size: 14px; color: var(--text-secondary, #A8A8A8); margin: 0 0 16px; }
    .t-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
    .t-chip {
      font-size: 13px; font-weight: 600; padding: 5px 12px; border-radius: 999px;
      background: rgba(255,255,255,0.06); border: 1px solid var(--border, rgba(255,255,255,0.09));
    }
    .t-description { font-size: 16px; line-height: 1.65; color: var(--text-primary, #F5F5F5); margin: 0 0 28px; }
    .t-cta-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 32px; }
    .li-list {
      list-style: none; margin: 0; padding: 0;
      border: 1px solid var(--border, rgba(255,255,255,0.09)); border-radius: 16px;
      overflow: hidden;
    }
    .li-item {
      display: flex; align-items: center; gap: 14px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    }
    .li-item:last-child { border-bottom: none; }
    .li-position {
      font-size: 13px; font-weight: 700; color: var(--text-secondary, #A8A8A8);
      min-width: 24px; text-align: right; flex-shrink: 0;
    }
    .li-poster-link { flex-shrink: 0; display: block; }
    .li-poster {
      width: 40px; height: 60px; border-radius: 6px; object-fit: cover;
      background: var(--bg-secondary, #15151C);
      border: 1px solid var(--border, rgba(255,255,255,0.09));
      display: block;
    }
    .li-info { flex: 1; min-width: 0; }
    .li-title {
      display: block; font-size: 15px; font-weight: 600;
      color: var(--text-primary, #F5F5F5); text-decoration: none;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .li-title:hover { text-decoration: underline; }
    .li-year { font-size: 13px; color: var(--text-secondary, #A8A8A8); }
    .li-empty { padding: 24px 16px; font-size: 15px; color: var(--text-secondary, #A8A8A8); }
    .t-block { margin-top: 32px; }
    .t-h2 { font-size: 18px; font-weight: 700; margin: 0 0 14px; }
    .t-explore { margin-top: 40px; font-size: 15px; color: var(--text-secondary, #A8A8A8); }
    .t-explore a { color: var(--text-primary, #F5F5F5); }
    @media (max-width: 640px) {
      .t-wrap { padding-top: 84px; }
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
        <a href="/watchlist-film-serie.html">Liste</a> ›
        <span>${escapeHtml(title)}</span>
      </nav>

      <h1 class="t-h1">${escapeHtml(title)}</h1>
      <p class="t-meta">Lista di <strong>${escapeHtml(ownerName)}</strong></p>
      <div class="t-chips">${kindChip}${itemCountChip}</div>
      ${description ? `<p class="t-description">${escapeHtml(description)}</p>` : ""}

      <div class="t-cta-row">
        <a class="lp-btn lp-btn-primary" href="${escapeHtml(loginNext)}">Accedi per seguire la lista</a>
        <a class="lp-btn lp-btn-ghost" href="${escapeHtml(appUrl)}">Apri in Somto</a>
      </div>

      <div class="t-block">
        <h2 class="t-h2">Titoli in questa lista${itemCount > items.length ? ` (${items.length} di ${itemCount} mostrati)` : ""}</h2>
        <ul class="li-list">${itemsHtml}</ul>
      </div>

      <p class="t-explore">
        Su Somto puoi creare le tue <a href="/watchlist-film-serie.html">liste di film e serie TV</a>,
        <a href="/app-recensioni-film-serie.html">votare e recensire</a> i titoli visti,
        sfidare gli amici ai <a href="/quiz-film-serie-tv.html">quiz</a> e
        scoprire cosa guardare con il <a href="/consigli-film-serie-amici.html">Match con gli amici</a>.
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

function registerListPage(exports) {
  // -- listPage : SSR public page for one list --------------------------------
  exports.listPage = functions
    .region(REGION)
    .https.onRequest(async (req, res) => {
      try {
        const param = readParam(req);
        if (!param) {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.status(404).send(render404());
          return;
        }

        const db = admin.firestore();
        const resolved = await resolveList(db, param);

        if (!resolved) {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.status(404).send(render404());
          return;
        }

        const { snap, matchedBy } = resolved;
        const data = snap.data() || {};

        // Only public lists are served (editorial lists also use visibility=="public").
        if (data.visibility !== "public") {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.status(404).send(render404());
          return;
        }

        // Redirect /lista/{listId} -> /lista/{slug} when a slug exists.
        const storedSlug = asTrimmedString(data.slug || data.editorialSlug, 256);
        if (matchedBy === "docId" && storedSlug && storedSlug !== param) {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.redirect(301, `${SITE_URL}/lista/${encodeURIComponent(storedSlug)}`);
          return;
        }

        // Also redirect editorialSlug match -> slug when they differ.
        if (matchedBy === "editorialSlug") {
          const primarySlug = asTrimmedString(data.slug, 256);
          if (primarySlug && primarySlug !== param) {
            res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
            res.redirect(301, `${SITE_URL}/lista/${encodeURIComponent(primarySlug)}`);
            return;
          }
        }

        // 404 if the list has no items at all (thin content, not worth indexing).
        const itemCount = Number(data.itemCount) || 0;
        const hasItemTitleIds = Array.isArray(data.itemTitleIds) && data.itemTitleIds.length > 0;
        if (itemCount === 0 && !hasItemTitleIds) {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.status(404).send(render404());
          return;
        }

        const items = await fetchListItems(db, snap.id, data);

        const html = renderListPage(snap.id, data, items);
        res.set("Content-Type", "text/html; charset=utf-8");
        res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
        res.status(200).send(html);
      } catch (err) {
        logger.error("[listPage] error", err);
        res.set("Cache-Control", "no-store");
        res.status(500).send("Internal error");
      }
    });

  // -- sitemapLists : /sitemap-lista.xml listing all public list slugs --------
  exports.sitemapLists = functions
    .region(REGION)
    .https.onRequest(async (req, res) => {
      try {
        const db = admin.firestore();

        // Read all public lists (visibility=="public"), selecting only the
        // slug/editorialSlug/updatedAt fields to keep the read cheap.
        const snap = await db
          .collection("userLists")
          .where("visibility", "==", "public")
          .select("slug", "editorialSlug", "updatedAt", "itemCount")
          .limit(SITEMAP_SCAN_CAP)
          .get();

        const urls = [];
        snap.forEach((doc) => {
          const d = doc.data() || {};
          // Skip lists with no items (thin content).
          const count = Number(d.itemCount) || 0;
          if (count === 0) return;

          const slug = asTrimmedString(d.slug || d.editorialSlug, 256);
          if (!slug) return;

          let lastmod = "";
          try {
            const ts = d.updatedAt && typeof d.updatedAt.toDate === "function"
              ? d.updatedAt.toDate() : null;
            if (ts) lastmod = ts.toISOString().slice(0, 10);
          } catch (_) { /* ignore */ }

          urls.push({ loc: `${SITE_URL}/lista/${encodeURIComponent(slug)}`, lastmod });
        });

        const rows = urls
          .map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`)
          .join("\n");
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows}
</urlset>`;
        res.set("Content-Type", "application/xml; charset=utf-8");
        res.set("Cache-Control", "public, max-age=3600, s-maxage=21600");
        res.status(200).send(xml);
      } catch (err) {
        logger.error("[sitemapLists] error", err);
        res.set("Cache-Control", "no-store");
        res.status(500).send("Internal error");
      }
    });
}

module.exports = {
  registerListPage,
  // Test seam (mirrors quizPage._renderQuizPage pattern):
  _renderListPage: renderListPage,
  _render404: render404,
};
