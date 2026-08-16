// Public, server-rendered, SEO-indexable quiz pages — one per quizzable title.
//
// Two HTTP functions:
//   quizPage     -> /quiz/{slug}  : landing SEO per il quiz di un titolo, con
//                   CTA "Gioca ora" verso il guest play (/quiz-prova.html).
//   sitemapQuiz  -> /sitemap-quiz.xml : elenca le pagine /quiz/{slug} giocabili.
//
// Design (stesso modello di titlePage.js):
//  * Admin SDK bypassa le rules; renderizziamo SOLO titoli `approved` E presenti
//    in quizMeta/themes (= hanno domande giocabili). Altrimenti 404 noindex.
//  * Pagina interamente server-rendered (no SDK client, no app-shell) → Google
//    la indicizza. Valore unico vs scraper: intro + anteprima domande + voto.
//  * Mostriamo SOLO il TESTO di alcune domande (questionText), MAI le opzioni o
//    la risposta corretta → nessun leak dell'answer-key (coerente col guest BE).
//  * Ogni valore interpolato è HTML-escaped (markup + JSON-LD).

const functions = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const REGION = "europe-west1";
const SITE_URL = "https://somto.it";
const FALLBACK_IMAGE = `${SITE_URL}/icons/icon-512.png`;
const PLAYABLE_STATUSES = ["approved", "beta_pending_review"];
const SAMPLE_QUESTIONS = 6; // anteprima domande (solo testo)

// ---------------------------------------------------------------------------
// Helpers (duplicati minimi da titlePage.js: i moduli non esportano helper)
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
function isTv(type) {
  return String(type || "").toLowerCase() === "tv";
}
function typeLabel(type) {
  return isTv(type) ? "serie TV" : "film";
}
function readSlug(titleData) {
  return asTrimmedString(titleData && titleData.slug, 256);
}
function titlePath(type, slugOrId) {
  return `${isTv(type) ? "/serie/" : "/film/"}${encodeURIComponent(slugOrId)}`;
}
function quizPath(slugOrId) {
  return `/quiz/${encodeURIComponent(slugOrId)}`;
}
function resolveImageUrl(...candidates) {
  for (const candidate of candidates) {
    const raw = asTrimmedString(candidate, 600);
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${SITE_URL}${raw.startsWith("/") ? "" : "/"}${raw}`;
  }
  return FALLBACK_IMAGE;
}
function readParam(req) {
  const fromQuery = asTrimmedString(req.query && req.query.id, 256);
  if (fromQuery) return fromQuery;
  const parts = String(req.path || "").split("/").filter(Boolean);
  // /quiz/{slug} -> ultimo segmento; ignora "quiz"
  const last = parts.length ? parts[parts.length - 1] : "";
  if (!last || last.toLowerCase() === "quiz") return "";
  return asTrimmedString(decodeURIComponent(last), 256);
}

// quizMeta/themes: mappa titleId -> { count, title, mediaType }. Cache 10 min.
let _themesCache = { map: null, at: 0 };
async function getThemesMap(db) {
  const now = Date.now();
  if (_themesCache.map && now - _themesCache.at < 600000) return _themesCache.map;
  try {
    const snap = await db.collection("quizMeta").doc("themes").get();
    const themes = (snap.exists && snap.data() && snap.data().themes) || [];
    const map = new Map();
    for (const x of themes) {
      if (x && x.titleId) map.set(x.titleId, { count: Number(x.count) || 0, title: x.title || "", mediaType: x.mediaType || "" });
    }
    _themesCache = { map, at: now };
    return map;
  } catch (err) {
    return _themesCache.map || new Map();
  }
}

async function resolveTitle(db, param) {
  const bySlug = await db.collection("titles").where("slug", "==", param).limit(1).get();
  if (!bySlug.empty) return { snap: bySlug.docs[0], matchedBy: "slug" };
  const byId = await db.collection("titles").doc(param).get();
  if (byId.exists) return { snap: byId, matchedBy: "docId" };
  return null;
}

// Fino a SAMPLE_QUESTIONS testi-domanda (SOLO questionText) per l'anteprima SEO.
// Query single-field (titleId) + filtro status lato server → nessun indice composito.
async function fetchSampleStems(db, titleId) {
  try {
    const snap = await db.collection("quizQuestions").where("titleId", "==", titleId).limit(60).get();
    const stems = [];
    snap.forEach((doc) => {
      if (stems.length >= SAMPLE_QUESTIONS) return;
      const d = doc.data() || {};
      if (!PLAYABLE_STATUSES.includes(asTrimmedString(d.status, 40))) return;
      const q = asTrimmedString(d.questionText, 240);
      if (q) stems.push(q);
    });
    return stems;
  } catch (err) {
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
  <title>Quiz non trovato | Somto</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <link rel="stylesheet" href="/css/landing.bundle.css">
</head>
<body class="lp-body">
  <main class="lp-section" style="min-height:70vh;display:flex;align-items:center;justify-content:center;text-align:center;">
    <div class="lp-container">
      <h1 class="lp-h2">Quiz non trovato</h1>
      <p class="lp-lead">Non c'è ancora un quiz per questo titolo su Somto.</p>
      <p><a class="lp-btn lp-btn-primary" href="${SITE_URL}/quiz-film-serie-tv.html">Vedi tutti i quiz</a></p>
    </div>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Quiz page
// ---------------------------------------------------------------------------

function renderQuizPage(docId, t, theme, stems) {
  const type = t.type;
  const tv = isTv(type);
  const label = typeLabel(type);
  const name = asTrimmedString(t.name || t.originalName, 200) || "Senza titolo";
  const year = Number.isFinite(Number(t.year)) && Number(t.year) > 0 ? Number(t.year) : null;
  const count = Number(theme.count) || 0;
  const imageUrl = resolveImageUrl(t.posterPath, t.backdropPath);
  const canonicalKey = readSlug(t) || docId;
  const canonicalUrl = `${SITE_URL}${quizPath(canonicalKey)}`;
  const titleUrl = `${SITE_URL}${titlePath(type, canonicalKey)}`;
  const playUrl = `/quiz-prova.html?titleId=${encodeURIComponent(docId)}`;

  const pageTitle = `Quiz su ${name}${year ? ` (${year})` : ""}: quanto ne sai? | Somto`;
  const metaDescription = `Metti alla prova quanto conosci ${name} con il quiz di Somto: ${count > 0 ? `${count} domande` : "tante domande"} su trama, personaggi e dettagli. Gioca gratis, senza registrazione.`;
  const posterAlt = `Locandina di ${name}${year ? ` (${year})` : ""}`;

  const robots = stems.length ? "index,follow" : "noindex,follow";
  const ld = {
    "@context": "https://schema.org",
    "@type": "Quiz",
    name: `Quiz su ${name}`,
    url: canonicalUrl,
    inLanguage: "it",
    about: { "@type": tv ? "TVSeries" : "Movie", name, url: titleUrl },
    educationalLevel: "beginner",
  };
  if (count > 0) {
    ld.description = metaDescription;
    ld.numberOfQuestions = count;
  }
  if (stems.length) {
    ld.hasPart = stems.map((s) => ({ "@type": "Question", name: s }));
  }
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Quiz", item: `${SITE_URL}/quiz-film-serie-tv.html` },
      { "@type": "ListItem", position: 3, name: `Quiz su ${name}`, item: canonicalUrl },
    ],
  };

  const facts = [`Quiz ${label}`];
  if (year) facts.push(String(year));
  if (count > 0) facts.push(`${count} domande`);
  facts.push("Gratis · senza registrazione");
  const factsHtml = facts.map((f) => `<span class="t-chip">${escapeHtml(f)}</span>`).join("");

  const stemsHtml = stems.length
    ? `<div class="t-block">
        <h2 class="t-h2">Un assaggio delle domande</h2>
        <ul class="q-stems">${stems
          .map((s) => `<li>${escapeHtml(s)}</li>`)
          .join("")}</ul>
        <p class="q-stems-note">…e molte altre. Le risposte le scopri giocando.</p>
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
  <meta name="robots" content="${robots}">
  <meta name="theme-color" content="#0A0A0A">
  <meta name="author" content="Somto">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Somto">
  <meta property="og:locale" content="it_IT">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(`Quiz su ${name}${year ? ` (${year})` : ""}`)}">
  <meta property="og:description" content="${escapeHtml(metaDescription)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:alt" content="${escapeHtml(posterAlt)}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(`Quiz su ${name}`)}">
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
      width: 200px; max-width: 100%; aspect-ratio: 2 / 3; border-radius: 18px;
      object-fit: cover; background: var(--bg-secondary, #15151C);
      border: 1px solid var(--border, rgba(255,255,255,0.09));
      box-shadow: 0 18px 50px rgba(0,0,0,0.45);
    }
    .t-head-main { flex: 1; min-width: 280px; }
    .t-h1 { font-size: clamp(28px, 5vw, 40px); line-height: 1.15; margin: 0 0 10px; font-weight: 800; }
    .t-lead { font-size: 17px; line-height: 1.6; color: var(--text-primary, #F5F5F5); margin: 0 0 18px; }
    .t-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
    .t-chip {
      font-size: 13px; font-weight: 600; padding: 5px 12px; border-radius: 999px;
      background: rgba(255,255,255,0.06); border: 1px solid var(--border, rgba(255,255,255,0.09));
    }
    .t-cta-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
    .t-block { margin-top: 32px; }
    .t-h2 { font-size: 20px; font-weight: 700; margin: 0 0 10px; }
    .q-stems { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
    .q-stems li { font-size: 16px; line-height: 1.5; }
    .q-stems-note { font-size: 14px; color: var(--text-secondary, #A8A8A8); margin: 12px 0 0; }
    .t-explore { margin-top: 40px; font-size: 15px; color: var(--text-secondary, #A8A8A8); }
    .t-explore a { color: var(--text-primary, #F5F5F5); }
    @media (max-width: 640px) {
      .t-wrap { padding-top: 84px; }
      .t-poster { width: 150px; margin: 0 auto; }
    }
  </style>
</head>
<body class="lp-body">

  <header class="lp-nav" id="lpNav">
    <div class="lp-nav-inner">
      <a class="lp-nav-logo" href="/" aria-label="Somto — home">
        <img src="/icons/somto-wordmark.png" alt="Somto">
      </a>
      <a class="lp-nav-cta" href="${escapeHtml(playUrl)}">Gioca</a>
    </div>
  </header>

  <main>
    <article class="t-wrap">
      <nav class="t-breadcrumb" aria-label="Percorso">
        <a href="/">Home</a> ›
        <a href="/quiz-film-serie-tv.html">Quiz</a> ›
        <span>${escapeHtml(name)}</span>
      </nav>

      <div class="t-head">
        <img class="t-poster" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(posterAlt)}"
             width="200" height="300" fetchpriority="high" loading="eager" decoding="async">
        <div class="t-head-main">
          <h1 class="t-h1">Quiz su ${escapeHtml(name)}: quanto ne sai?</h1>
          <p class="t-lead">Metti alla prova la tua conoscenza di <strong>${escapeHtml(name)}</strong>${year ? ` (${year})` : ""}${count > 0 ? ` con <strong>${count} domande</strong>` : ""} su trama, personaggi e dettagli. Si gioca <strong>gratis e senza registrazione</strong>.</p>
          <div class="t-chips">${factsHtml}</div>
          <div class="t-cta-row">
            <a class="lp-btn lp-btn-primary" href="${escapeHtml(playUrl)}">🎮 Gioca ora gratis</a>
            <a class="lp-btn lp-btn-ghost" href="${escapeHtml(titlePath(type, canonicalKey))}">Scheda di ${escapeHtml(name)}</a>
          </div>
        </div>
      </div>

      ${stemsHtml}

      <div class="t-block">
        <h2 class="t-h2">Come funziona</h2>
        <p class="t-text" style="font-size:16px;line-height:1.65;color:var(--text-primary,#F5F5F5);margin:0">
          Rispondi alle domande a scelta multipla: alla fine vedi il punteggio e le spiegazioni.
          Registrandoti su Somto salvi i tuoi XP, scali la classifica e puoi <a href="/consigli-film-serie-amici.html">sfidare gli amici</a>
          sullo stesso quiz. Tutto gratis.
        </p>
      </div>

      <p class="t-explore">
        Scopri altri <a href="/quiz-film-serie-tv.html">quiz su film e serie TV</a>, vai alla
        <a href="${escapeHtml(titlePath(type, canonicalKey))}">scheda di ${escapeHtml(name)}</a>
        o torna alla <a href="/">home di Somto</a>.
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
          <a href="/quiz-film-serie-tv.html">Quiz</a>
        </div>
        <div class="lp-footer-col">
          <h4>Scopri</h4>
          <a href="/watchlist-film-serie.html">Watchlist</a>
          <a href="/app-recensioni-film-serie.html">Voti e recensioni</a>
          <a href="/consigli-film-serie-amici.html">Consigli tra amici</a>
        </div>
        <div class="lp-footer-col">
          <h4>Legale</h4>
          <a href="/privacy.html">Privacy</a>
          <a href="/terms.html">Termini</a>
          <a href="/cookies.html">Cookie</a>
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

function registerQuizPage(exports) {
  // -- quizPage : SSR landing SEO del quiz di un titolo ---------------------
  exports.quizPage = functions
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

        // Deve avere domande quiz giocabili.
        const themes = await getThemesMap(db);
        const theme = themes.get(snap.id);
        // Niente quiz per questo titolo (assente da quizMeta o aggregato stale a 0).
        if (!theme || (Number(theme.count) || 0) <= 0) {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.status(404).send(render404());
          return;
        }

        // Legacy /quiz/{docId} con slug disponibile → 301 al canonical slug.
        const slug = readSlug(data);
        if (matchedBy === "docId" && slug && slug !== param) {
          res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          res.redirect(301, `${SITE_URL}${quizPath(slug)}`);
          return;
        }

        const stems = await fetchSampleStems(db, snap.id);
        const html = renderQuizPage(snap.id, data, theme, stems);
        res.set("Content-Type", "text/html; charset=utf-8");
        res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
        res.status(200).send(html);
      } catch (err) {
        logger.error("[quizPage] error", err);
        res.set("Cache-Control", "no-store");
        res.status(500).send("Internal error");
      }
    });

  // -- sitemapQuiz : /sitemap-quiz.xml (pagine /quiz/{slug} giocabili) -------
  exports.sitemapQuiz = functions
    .region(REGION)
    .https.onRequest(async (req, res) => {
      try {
        const db = admin.firestore();
        const themes = await getThemesMap(db);
        const titleIds = [...themes.keys()];
        const urls = [];
        // getAll a chunk di 300 per leggere slug/status/type.
        for (let i = 0; i < titleIds.length; i += 300) {
          const refs = titleIds.slice(i, i + 300).map((id) => db.collection("titles").doc(id));
          if (!refs.length) continue;
          const snaps = await db.getAll(...refs);
          for (const s of snaps) {
            if (!s.exists) continue;
            const d = s.data() || {};
            if (asTrimmedString(d.status, 40) !== "approved") continue;
            const key = readSlug(d) || s.id;
            let lastmod = "";
            try {
              const ts = d.updatedAt && typeof d.updatedAt.toDate === "function" ? d.updatedAt.toDate() : null;
              if (ts) lastmod = ts.toISOString().slice(0, 10);
            } catch (_) { /* ignore */ }
            urls.push({ loc: `${SITE_URL}${quizPath(key)}`, lastmod });
          }
        }
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
        logger.error("[sitemapQuiz] error", err);
        res.set("Cache-Control", "no-store");
        res.status(500).send("Internal error");
      }
    });
}

module.exports = { registerQuizPage, _renderQuizPage: renderQuizPage, _render404: render404 };
