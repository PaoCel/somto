# PWA, SEO pubblica e coerenza contenuti

Leggi per: web app `public/`, service worker, pagine marketing/blog, pagine titolo SSR, parita' contenuti marketing/app.

## PWA (web app)
- Directory `public/`, multipagina HTML **vanilla** (no framework/bundler), ES modules, Firebase Web SDK v10.12.5. Servita da Firebase Hosting.
- **Allineata 1:1 all'app iOS** (restyle 2026-05-16): design system, layout, componenti, sezione Quiz.
- **Design system**: `css/variables.css` allineato a `TwoWatchTheme.swift`; `css/base.css` + `css/components/*` matchano `DesignSystem/`. Dark theme unico.
- **App-shell condiviso**: `js/components/appShell.js` inietta header (equiv `BrandChromeBar`: pill bianca menu/ricerca/wordmark/chat/notifiche) + bottom tabbar 5 voci Home/Match/Watchlist/Quiz/Profilo. Montato da `js/utils/tabbar.bootstrap.js` su ogni pagina. View Transitions cross-document + speculation rules attive.
- **Quiz sul web**: pagine `quiz*.html` + controller `js/pages/quiz*.page.js` + `js/api/quiz.api.js` (replica `QuizRepository.swift`) + `css/pages/quiz.css` (kit gaming) + `js/components/quizUI.js`/`quizConfetti.js`.
- **Upcoming rimosso** da web e iOS.
- **Service worker**: `public/service-worker.js`, costante `VERSION` (attuale `v182-2026-08-05-quiz-session-v2-adapter`, cache tiered shell/runtime/images) — bumpare `VERSION` a ogni release di asset.
- **Pagina lista** `public/lista.html` + `lista.page.js` (in-app, auth): dettaglio lista pubblica/condivisa `/lista.html?id={listId}` con progresso personale (film visto/da vedere, serie per stagione → `listProgressEntries`), share/copy-link a `https://somto.it/lista/{slug}`.
- Deploy: `firebase deploy --only hosting` (backend Quiz già live, non serve ridepoyare).

## SEO pubblica / pagine indicizzabili
Obiettivo: traffico organico da Google. Dettaglio operativo nel brief `BRIEF-SEO.md` (root del repo).

- **SEO tecnico**: pagine pubbliche con title/description/canonical/OG/JSON-LD; `public/robots.txt`; `public/sitemap.xml` è un **sitemap index** → `sitemap-pages.xml` (statiche) + `sitemap-titoli.xml` (dinamica). Le schermate app private hanno `<meta name="robots" content="noindex,follow">`; landing + marketing + blog restano `index`.
- **Niente catch-all rewrite**: il rewrite `** → /index.html` è stato rimosso da `firebase.json` → gli URL inesistenti danno un 404 reale (`public/404.html`).
- **Pagine marketing** (`public/`, statiche, indicizzabili): `watchlist-film-serie.html`, `app-recensioni-film-serie.html`, `quiz-film-serie-tv.html`, `consigli-film-serie-amici.html`. Riusano `css/landing.bundle.css` (classi `lp-*`).
- **Pagine titolo SSR** — una pagina pubblica indicizzabile per ogni titolo del catalogo:
  - `functions/modules/titlePage.js` → Cloud Functions `titlePage` (HTML SSR + JSON-LD `Movie`/`TVSeries` + `AggregateRating` dal voto community) e `sitemapTitles` (`/sitemap-titoli.xml`).
  - Rewrite hosting: `/film/**` e `/serie/**` → `titlePage`; `/sitemap-titoli.xml` → `sitemapTitles`.
  - URL = slug leggibile: campo `slug` sui doc `titles` (es. `thor-love-and-thunder-2022`). Helper `functions/modules/titleSlug.js`; backfill storico `functions/scripts/backfill-title-slugs.js`; trigger `onTitleCreatedSlug` (in `index.js`) assegna lo slug ai nuovi titoli. Vecchi URL `/film/{docId}` → redirect 301 allo slug.
  - Rende solo titoli `status == "approved"`; altrimenti 404 noindex.
- **Blog editoriale** (`blog/`): progetto **Eleventy** separato (non tocca il runtime buildless della PWA). Articoli Markdown in `blog/src/articoli/`. Build: `cd blog && npm run build` → genera HTML statico in `public/blog/` (committato). `blog/node_modules/` in `.gitignore`.
- **Google Search Console**: proprietà `somto.it` verificata (file `public/google5648a820f2419854.html`), sitemap inviata.

## Coerenza contenuti marketing/blog ↔ app
I contenuti pubblici (pagine marketing `public/*-film-serie*.html`, articoli blog `blog/src/articoli/`) descrivono cosa fa Somto. **Regola: ogni funzionalità citata nei contenuti deve esistere nell'app.** Si citano solo feature reali; se un contenuto descrive qualcosa di non ancora presente, va aggiunto qui sotto come gap da implementare.

### Funzionalità reali (citabili nei contenuti)
- Watchlist: salva film/serie, stati (da vedere / da votare), filtri tipo/genere/anno, ordinamento (recenti / A-Z), ricerca; per le serie tracking di dove sei rimasto.
- Voto 1-10 ai titoli visti; "segna come visto senza voto"; catalogo personale.
- Match: scorri i titoli suggeriti per decidere cosa guardare.
- Quiz: XP, streak giornaliera, bonus, sfide con amici (anche esterni via link), classifica settimanale/all-time.
- Social: segui amici, feed attività, profili pubblici, consigli / suggerimento flash.
- Thread / discussioni con protezione anti-spoiler.
- Statistiche utente (titoli visti, ore, generi).
- Pagine titolo pubbliche (trama, cast, trailer, voto community).
- Gratis; web app + iOS sincronizzati.

### Gap — citati nei contenuti ma NON presenti (da implementare)
- **Nota / commento personale su un titolo in watchlist** — l'articolo blog "come organizzare la watchlist" raccomanda di annotare *perché* hai salvato un titolo. Somto non ha un campo nota. Da valutare l'aggiunta (campo testo sulla voce watchlist / `titleStates`; iOS + web + Firestore).
- **Raggruppamento watchlist per occasione / "tipo di serata"** — lo stesso articolo suggerisce di raggruppare i titoli per occasione (da soli, in coppia, maratona…). Somto ha filtri per genere/tipo/anno ma non tag/categorie per occasione. Da valutare.
