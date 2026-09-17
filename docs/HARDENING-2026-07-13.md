# Hardening 2026-07-13 — risposta alla revisione critica

Interventi eseguiti contro i finding di `docs/SOMTO_CRITICAL_REVIEW.md` (revisione
indipendente di Fable). Sessione agentica: fix mirati di sicurezza, privacy,
osservabilità, correttezza, pulizia e SEO. Nessun refactor big-bang, nessuna
feature nuova (coerente con la raccomandazione "congelare l'ampiezza").

## Cosa è stato fatto (tutto committato+pushato su `main`)

| Finding | Intervento | Commit | File |
|---|---|---|---|
| **R6** — `titles.create` senza validazione (forgery `ratingAggregate`/`slug`/`mergedTmdbIds` → AggregateRating JSON-LD falso + slug-squatting su pagine SSR indicizzate) | Helper `titleServerFieldsCleanOnCreate` (campi server-owned assenti/vuoti su create) + test rules. Suite **122 pass/0 fail** in emulatore. | `de21f93` | `firestore.rules`, `functions/test/rules.spec.cjs` |
| **R2** — privacy policy senza titolare/minori/sub-processor (gap art. 13 GDPR) | Riscritta `privacy.html`: titolare = Paolo Celestini + contatto, responsabili esterni (Google/Firebase, Apple, TMDB, Brevo), soglia minori 14 (IT), basi giuridiche, portabilità art. 20, reclamo Garante. | `36820ce` | `public/privacy.html` |
| **R2 / privacy** — `moderationQueue` non ripulita alla cancellazione account (preview 280 char + uid residui) | `deleteMyAccount` ora cancella `moderationQueue` where `authorUid == uid`. | `b1af9f3` | `functions/index.js` |
| **R14** — SW forza il reload di tutte le tab a ogni deploy | Rimosso `skipWaiting()` incondizionato dall'`install`: il SW resta "waiting" finché l'utente non tocca "Aggiorna" (handler `SKIP_WAITING` già presente). | `b3af317` | `public/service-worker.js` |
| **D6** — trigger leaderboard legacy scrive `leaderboard_weekly`/`allTime` a vuoto a ogni partita (nessuna UI le legge) | Rimosso trigger `onQuizAttemptCreated`, modulo `quizLeaderboard.js` e index morto. `deleteMyAccount` continua a ripulire i doc legacy. | `b1af9f3` | `functions/index.js`, `functions/modules/quizLeaderboard.js`, `firestore.indexes.json` |
| **D12** — `functions-public-profile` sotto gli standard del principale | Rate-limit (`enforceCallableRateLimit` vendorizzato), logging strutturato, try/catch su entrambe le callable; `normalizeSeriesProgress` ora clampa ai totali e ricalcola `percentComplete` (frazione 0-1) invece di fidarsi del valore memorizzato. | `55e122e` | `functions-public-profile/index.js`, `functions-public-profile/rateLimiter.js` |
| **R1** — zero osservabilità errori web | Error tracking minimo: `clientErrors` (admin-read-only), scritto solo da pagine autenticate (no-op senza login, cap 8/sessione, dedup 60s, TTL 14gg, mai-throw). Wiring in `appShell.initAppShell` (mai su landing). +8 test rules (suite **130 pass/0 fail**). | `22be98f` | `public/js/api/errors.api.js`, `public/js/components/appShell.js`, `firestore.rules`, `functions/test/rules.spec.cjs` |
| **SEO / finestra TV Time** | Rinforzata landing `vieni-da-tv-time.html` (CTA → `/import.html` con utm, urgenza chiusura 15/7, FAQ estesa a 5 Q con JSON-LD), blog how-to export rinfrescato+ricostruito, sitemap lastmod aggiornati. | `b8a2cc2` | `public/vieni-da-tv-time.html`, blog, `public/sitemap-pages.xml` |
| bug correlato | Badge progresso serie (profilo + watchers scheda titolo) rendeva `percentComplete` come 0-100 mentre è una frazione 0-1: una serie al 42% mostrava "0%". `clamp(0,1)*100`. | `ec038f2` | `public/js/pages/user.page.js`, `public/js/pages/title.page.js` |
| **D11** — artefatti stale in repo | Rimosso `design/watchlist-redesign/patch/` (zero riferimenti); rimosso codice watchlist orfano morto da `account.page.js` (106 righe, solo la parte provabilmente morta). `public/dist/` è già gitignored (nessuna azione). | `682cf25`, `3823e41` | — |
| **D9** — hook pre-commit non installato su questo checkout | `scripts/hooks/install.sh` eseguito (`core.hooksPath=scripts/hooks`). | (config locale) | — |

## Deploy — ESEGUITI su prod (gia-visto) il 2026-07-13

Deploy mirati (mai un `--only functions` a tappeto, per non toccare le import
functions fragili). Tutti verdi:

- ✅ **Rules + indexes**: `firebase deploy --only firestore:rules,firestore:indexes`
  → `validTitleCreate` (R6) e `clientErrors` (R1) live.
- ✅ **Hosting**: `firebase deploy --only hosting` → privacy, SW v117, landing/blog/
  sitemap, appShell/errors.api, account/user/title.page.js live.
- ✅ **Functions publicprofile**: `firebase deploy --only functions:publicprofile`
  (3 callable aggiornate).
- ✅ **Functions default (mirato)**: `firebase deploy --only functions:deleteMyAccount`
  (moderationQueue) — nessuna import function toccata.
- ✅ **Trigger legacy rimosso**: `firebase functions:delete onQuizAttemptCreated
  --region europe-west1` + index `leaderboard_weekly` eliminato (`--force`, 1 index).

### Unico step manuale rimasto (proprietario)
- **Console Firebase → Firestore → TTL**: abilitare la policy su
  `clientErrors.expiresAt` (auto-pulizia 14 giorni). Non fatto via CLI perché
  gcloud non è autenticato su questa macchina. Comando equivalente:
  `gcloud firestore fields ttls update expiresAt --collection-group=clientErrors --project=gia-visto --enable-ttl`.

## Batch 2 — urgentissimo/urgente (backup + GDPR enforcement) 2026-07-13

Secondo giro sui rischi R1/R2 residui. Committato + DEPLOYATO mirato.

| Item | Intervento | Stato |
|---|---|---|
| **R1 backup** | `scheduledFirestoreExport` (03:00 Rome): export completo Firestore su GCS via FirestoreAdminClient. | ✅ funzione creata (fallisce finché manca il setup owner, sotto) |
| **R2 art.20** | `exportMyData` callable (reauth+rate-limit) → JSON su Storage con token; bottone "Scarica i miei dati" in Impostazioni. | ✅ funzione + hosting live |
| **R2 minori** | Age gate 14+ obbligatorio al signup web → `ageConfirmed`/`ageConfirmedAt` su usersPrivate. | ✅ hosting live (render verificato) |
| **R2 marketing** | Toggle opt-in "Comunicazioni email" in Impostazioni → `usersPrivate.marketingConsent` (il blast Brevo era senza consenso documentato). | ✅ hosting live |
| **R2 gate community** | Signup web ora persiste `communitySafetyAcceptedAt/Version/Source` (prima solo iOS) + script `backfill-community-safety.js`. **Rules gate NON abilitato**: senza backfill lockerebbe tutti i web user. | codice live; gate da abilitare dopo backfill |

### Nuovi step manuali (proprietario)
- **Backup**: creare bucket GCS `gia-visto-backups` (o env `FIRESTORE_BACKUP_BUCKET`) con lifecycle 30gg + concedere al SA `gia-visto@appspot.gserviceaccount.com` i ruoli `roles/datastore.importExportAdmin` + write sul bucket. Finché manca, `scheduledFirestoreExport` fallisce ogni notte (log).
- **Export TTL**: lifecycle GCS sul prefisso `dataExports/` (es. 7gg), come `supportImports/`.
- **Gate community (quando si vuole enforce)**: `node functions/scripts/backfill-community-safety.js --write`, POI aggiungere la clausola nelle rules su create di messages/threads/posts (preservando l'esenzione support thread). Mai prima del backfill.

## Batch 3 — analytics prodotto (review §29) 2026-07-13

Osservabilità prodotto ("non misura nulla") — costruito + DEPLOYATO, privacy-safe
(contatori AGGREGATI e anonimi, nessun tracking per-utente nuovo).

- **Backend**: collection `productMetrics/{giorno}` (admin-read); `lib/productMetrics.bumpDailyMetric`; callable `logProductEvent` (whitelist eventi, no PII, rate-limit utente/IP); contatori server su eventi rari (`signups` da notifyAdminOnUserSignup, `imports_completed/failed` da createTitlesImportNotification); `computeProductMetricsSnapshot` schedulato 03:30 Rome (DAU/WAU/nuovi/attivazione-48h + totali cumulati dai campi esistenti `createdAt`/`lastActiveAt`/`stats`, sintetici esclusi). **Nessuna scrittura sul trigger caldo titleStates** → zero contention durante gli import.
- **Client**: `productAnalytics.trackProductEvent` su 9 step funnel (signup_started, onboarding_*, import_started, quiz_played, guest_quiz_played, empty_watchlist/feed) + eventi GA4 (import/quiz/rating) per esplorazione.
- **Dashboard**: `/admin-metrics.html` (admin-only) — KPI (WAU North Star, attivazione 48h…), funnel 7g con drop-off, trend SVG, tabella. Deploy: rules + 3 functions (`logProductEvent`/`computeProductMetricsSnapshot` create, `notifyAdminOnUserSignup` update) + hosting. Callable verificata live.
- **Privacy**: aggiunta a `privacy.html` la clausola "statistiche aggregate anonime, legittimo interesse art. 6.1.f".

### Note
- La dashboard mostra "nessun dato" finché **lo snapshot non gira** (prima esecuzione 03:30 di domani) e finché non si accumulano eventi.
- `imports_completed/failed` è nel codice ma si **attiva al prossimo deploy delle import functions** (non ridepoyate ora per non toccare le import functions fragili). Intanto l'import funnel è visibile via GA4.
- Contatore su doc singolo/giorno: ok a questa scala; a volumi molto alti valutare sharded counter.

## Follow-up noti (non fatti, richiedono decisione)

- **Rating Bottom Sheet in `account.page.js`** è probabilmente morto anch'esso
  (`openRatingSheet` era chiamato solo dal codice watchlist rimosso): rimuoverlo
  in un intervento dedicato sbloccherebbe la delezione degli helper watchlist
  ancora preservati. Da confermare.
- **Banner "Somto è giovane… può incepparsi"** in Home (`home.page.js`): la review
  (UX #4) suggerisce di rimuoverlo/spostarlo per i migranti TV Time in cerca di
  stabilità. Decisione di copy lasciata al proprietario.
- Restano aperti dalla review gli item infrastrutturali che richiedono accesso
  GCP/decisioni del proprietario: **alert policy** (error rate CF, spike reads/
  writes, budget), migrazione **gen1→gen2**, **App Check**. (Backup ed
  `exportMyData` ora fatti — vedi Batch 2.)
