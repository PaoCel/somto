# Somto — Project Memory (CLAUDE.md)

Path canonico: root del checkout locale, fuori da cartelle sincronizzate cloud.

## Workflow agentico leggero

Usa i playbook in `docs/agent-playbook/` come team di sviluppo virtuale, ma non caricarli tutti di default. Per ogni task scegli un agente principale e aggiungi reviewer solo quando il rischio lo richiede.

Prima di modificare codice:
- Controlla `git status --short`.
- Leggi i file direttamente coinvolti.
- Per task piccoli usa solo checklist rapida, senza multi-agent.
- Per feature ampie proponi fasi piccole, verificabili e reversibili.
- Non modificare Firestore schema, rules, indexes o Cloud Functions senza proposta esplicita di sicurezza e migrazione.
- Non fidarti del frontend per privacy, ownership o permessi.

Routing agenti:
- Product Manager: scope, priorità, requisiti, tradeoff prodotto.
- UX Reviewer: flussi, stati vuoti, errori, copy, onboarding.
- UI Reviewer: layout, visual QA, componenti, responsive/accessibilità visiva.
- Software Architect: architettura, integrazioni, refactor, contratti tra moduli.
- Database Architect: Firestore schema, query, indexes, migrazioni, backfill.
- Security/Privacy Reviewer: auth, ownership, PII, rules, permessi, abuso.
- QA Tester: piano test, regressioni, casi limite, verifica manuale.
- Code Quality Reviewer: review finale, bug, maintainability, test mancanti.

Policy token:
- Leggi solo `CLAUDE.md`, i file coinvolti e il playbook dell'agente principale.
- Aggiungi altri playbook solo per rischi concreti.
- Per Firestore/security/dati coinvolgi sempre Database Architect + Security/Privacy Reviewer.
- Per UI utente coinvolgi UX Reviewer e, se cambia layout, UI Reviewer.
- Per bug production/data incident coinvolgi QA Tester e Code Quality Reviewer prima del report finale.

Formato report quando richiesto o quando il task è investigativo:
- Verdict: PASS / PASS WITH CONCERNS / BLOCKED
- Findings
- Required changes
- Risks
- Suggested implementation steps
- Tests needed

## Stack
- **App iOS**: SwiftUI iOS 17+, Swift 6, Xcode 15+. Progetto generato via **XcodeGen** da `ios/project.yml`. Target `Somto.app`, bundle `com.paolocelestini.twowatch.ios`, team `787YK9YUB3`.
- **Backend**: Firebase project `gia-visto`. Firestore + Functions (`functions/`, `functions-public-profile/`) + Storage + Auth.
- **Versioning**: `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` in `ios/project.yml`. Bump entrambi prima di ogni archive.

## Path principali
- iOS app: `ios/TwoWatch/`
- iOS project regen: `cd ios && xcodegen generate`
- Functions: `functions/index.js` + `functions/modules/`
- Firestore rules: `firestore.rules`
- Firestore indexes: `firestore.indexes.json`
- Firebase config root: `.firebaserc` (alias: `prod`/`production` = `gia-visto`, `staging` = `somto-staging`)

## Indice contesto — leggi solo il file che serve

Questo file e' l'unico caricato sempre. Tutto il resto si legge **su richiesta**,
quando il task lo tocca davvero. Se un dettaglio non e' qui sotto, sta in uno di
questi file: cercalo li' invece di ricostruirlo dal codice.

| Se il task tocca... | Leggi |
| --- | --- |
| **qualsiasi file Swift in `ios/`** | **`docs/context/IOS_CODE_STYLE.md`** |
| shell iOS, tab bar, header, onboarding | `docs/context/IOS_APP_MAP.md` |
| quiz (iOS/web, sfide, classifica, guest play) | `docs/context/QUIZ.md` |
| voti, aggregato community, emozioni, personaggi | `docs/context/RATINGS_AND_REACTIONS.md` |
| notifiche, push, token FCM, aggiornamenti titolo | `docs/context/NOTIFICATIONS.md` |
| ore viste, contatori profilo, progresso serie | `docs/context/USER_STATS_AND_PROGRESS.md` |
| TMDB proxy, arricchimento, titoli accorpati | `docs/context/TMDB.md` |
| PWA, service worker, SEO, pagine marketing/blog | `docs/context/PWA_WEB.md` |
| archive, TestFlight, numerazione versioni | `docs/context/RELEASE_PROCESS.md` |
| anti-spoiler, moderazione, GIF, profili guidati | `docs/context/SOCIAL_MODERATION.md` |
| gusti utente, suggerimenti, Match, affinita' piattaforma | `docs/context/TASTE_ENGINE.md` |
| backlog, debiti aperti, feature spente | `docs/PENDING.md` |

Riferimenti di dominio (piu' stabili, gia' esistenti):

- `docs/ARCHITECTURE.md` — architettura e flussi chiave
- `docs/FIREBASE_DATA_MODEL.md` — schema Firestore/Storage, invarianti, indici
- `docs/LOCAL_DEVELOPMENT.md` — setup, emulatori, test
- `docs/DEPLOYMENT.md` — come si rilascia (web/functions/iOS), rollback
- `docs/STAGING.md` — ambiente somto-staging: cosa copre, checklist console
- `docs/SECURITY.md` — modello permessi, item aperti, regole per sviluppare
- `docs/RUNBOOK.md` — operazioni ricorrenti, incident response, script ops
- `docs/ANDROID_PWA_RELEASE.md` — percorso Play Store via PWABuilder/TWA
- `docs/EDITORIAL_SYSTEM.md` — aggiornamenti ufficiali (compose→publish→retire)
- `docs/EDITORIAL_VOICE.md` — voce di Paolo per post e articoli Somto
- `docs/TITLE_UPDATES_RECOMMENDATIONS_PLAN.md` — piano condiviso Codex/Claude per eventi titolo, notifiche e affinita' piattaforma
- `docs/TITLE_UPDATE_EVENTS_DATA_PROPOSAL.md` — contratto bilingue, rules/indici, migrazione e rollback degli eventi titolo
- `docs/CHARACTER_VOTES_SPEC.md` — spec estesa voti personaggi
- `docs/I18N_GLOSSARY.md` — copy condiviso iOS/web, casi reali
- `docs/IOS_REFACTOR_PLAN.md` — analisi tecnica iOS + piano di refactoring in 6 fasi (2026-08-08); lo **stile** sta in `docs/context/IOS_CODE_STYLE.md`
- `docs/DECISIONS.md` — registro decisioni tecniche (aggiungere qui le nuove)
- `docs/RELEASE_HISTORY.md` — log storico release
- `docs/SOMTO_CRITICAL_REVIEW.md` / `docs/AUDIT-2026-07-12.md` / `docs/HARDENING-2026-07-13.md` — audit e revisioni

**Regola di manutenzione**: quando una feature cresce, il dettaglio va nel file
di contesto, non qui. In CLAUDE.md resta al massimo una riga con il puntatore.

## Repo Git
- Questo repo pubblico (`https://github.com/PaoCel/somto.git`) è uno snapshot
  a storia fresca dello sviluppo privato: niente force-push, niente rewrite
  in-place, si pubblica ripetendo l'export quando serve.
- Default branch: `main`.
- La guardia locale è `scripts/check-deploy-safety.mjs` (prod solo da main
  pulito con `CONFIRM_PROD=gia-visto`) + CI, sul repo privato di sviluppo.
- Pulizia 2026-07-12: tutti i branch storici (codex/*, feat/*, reconcile/*,
  claude/*) erano già mergiati e sono stati eliminati (hash in
  `docs/DECISIONS.md`). Tag di ripristino: `snapshot-2026-07-12-consolidamento`.

## Ambienti
- **prod** = progetto Firebase `gia-visto` (somto.it). Utenti reali.
- **staging** = progetto `somto-staging` (https://somto-staging.web.app,
  noindex, **Blaze**): hosting+Firestore+Storage+functions attivi (callable/
  scheduled/https; i trigger Firestore gen1 NON sono deployabili su progetti
  nuovi → si testano in emulatore). Seed: 120 titoli + quiz. Account QA e
  credenziali sono configurati fuori dal repository. Deploy: `npm run deploy:staging[:hosting]`,
  functions: `firebase deploy --only functions --project staging`.
  Vedi `docs/STAGING.md`.
- **locale** = emulatori (`firebase emulators:start`, project `demo-2watch`,
  porte custom in firebase.json; PWA con `?emulators=1`).
- La PWA sceglie il progetto dall'hostname in `public/firebaseConfig.js`:
  host staging → somto-staging, tutto il resto (incluso localhost) → prod.
- Deploy prod: `npm run deploy:prod[:hosting]` (chiede `CONFIRM_PROD`), o
  deploy mirati `--only` documentati in `docs/DEPLOYMENT.md`. MAI da tree
  sporco, MAI da branch ≠ main.

## Vincoli sempre
- NON cambiare logo Somto
- NON redesign globale
- Riusa componenti esistenti
- Style/palette/typography invariati
- Niente deploy senza dirlo PRIMA all'utente (eccetto se l'utente lo richiede esplicitamente per il task corrente)
- Filesystem ora locale (no iCloud) → operazioni veloci
- **Copy: una frase sola per un concetto solo, su iOS e web.** La chiave di
  traduzione È la stringa italiana, quindi "Thread non trovato" e "Thread non
  trovato." sono due chiavi, due traduzioni, due cose da mantenere. Prima di
  scrivere copy nuovo cerca se esiste già in `Localizable.xcstrings` o in
  `public/js/i18n/en.js` e **riusala identica**; se va cambiata, cambiala su
  entrambe le piattaforme. A parità di senso scegli sempre la formulazione più
  corta e più semplice. Dettagli e casi reali in `docs/I18N_GLOSSARY.md`.

### Footgun Swift da evitare
- **Mai `Dictionary(uniqueKeysWithValues:)` su chiavi *derivate*** (lowercase, `SearchNormalizer.normalize`, hash, slug, nome, ecc.): crasha con `fatalError` su chiavi duplicate. Usa sempre `Dictionary(_:uniquingKeysWith: { first, _ in first })`. Permesso solo su doc id Firestore (`.id`, `.titleId`, `.uid`, `.documentID`, `.tmdbId`).
  - Incidente: v0.3.22, "La Casa di Carta Korea" crashava ogni apertura su `mergeCharacters` (collisione cast con nome normalizzato uguale). Fix in v0.3.23.
  - Guardia attiva: `scripts/hooks/pre-commit` blocca i commit che aggiungono `uniqueKeysWithValues:` su chiavi non-id. Attivato via `scripts/hooks/install.sh` (set `core.hooksPath`). Da rilanciare dopo ogni clone fresh.

### Hooks git versionati
- `scripts/hooks/` contiene gli hook git del repo. Attiva con `scripts/hooks/install.sh` (one-shot, set `git config core.hooksPath scripts/hooks`).
- Mai bypassare con `--no-verify` se non per emergenza giustificata.

---

## Git workflow standing rules

### Session hygiene (lavora su main, niente lavoro "esterno")
Per evitare che il lavoro di una sessione resti stranded su un branch/worktree
e vada riconciliato dopo:
- **Lavora sempre direttamente su `main`** nel checkout principale
  (checkout principale). **NON creare branch o worktree separati**
  salvo richiesta esplicita dell'utente.
- **Committa e pusha su `main`** dopo ogni pezzo di lavoro (vedi passi sotto).
- **A fine sessione lascia il working tree pulito e tutto pushato**: `git status
  --short` vuoto **e** `git log origin/main..HEAD` vuoto (niente non-pushato).
- **Una sola sessione per volta** sullo stesso checkout: sessioni parallele si
  pestano i piedi (albero sporco, conflitti). Se inevitabile, ognuna committa
  solo i propri file (`git add` mirato) e pusha prima che parta l'altra.
- **Background task / agenti isolati** (worktree `.claude/worktrees/*`): quando
  finiscono, il loro lavoro va **mergiato in `main`** (cherry-pick o merge) e il
  branch/worktree rimosso, se no resta esterno.

Quando completi un task (anche piccolo) **fai sempre** in sequenza, senza chiedere conferma:

1. `git status --short` per vedere lo stato.
2. `git add` mirato (mai `git add -A` per evitare di committare segreti o build artifacts). Per le aree note:
   - codice iOS: `git add ios/TwoWatch/...`
   - functions: `git add functions/index.js functions/modules/... firestore.rules firestore.indexes.json`
   - config: `git add ios/project.yml ios/ExportOptions-AppStore.plist`
   - mai aggiungere: `ios/build/`, `**/node_modules/`, `*.log`, `firebase-debug.log`, `firestore-debug.log`, `pglite-debug.log`, files con "TwoWatch 2.xcodeproj" o "package-lock 2.json" (duplicati iCloud)
3. Commit con **Conventional Commits** in italiano. Subject ≤ 50 char. Body solo se "perché" non è ovvio.
   - Esempi: `feat(quiz): leaderboard via collectionGroup`, `fix(header): chrome bar trasparente`, `chore(deploy): bump 0.3.4 + tmdbProxy personCredits`
   - Co-author footer obbligatorio: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
4. `git push origin main` subito dopo il commit.
5. Mai `git push --force`. Mai `git reset --hard`. Mai `--no-verify`.

Quando un task tocca più aree distinte (es. backend + iOS + rules), fai **commit separati** per area così il diff resta leggibile.

Se il task richiede deploy (`firebase deploy`, `xcodebuild archive/exportArchive`):
- Prima committi e pushi il codice.
- Poi annunci all'utente che stai per deployare e procedi.
- Aggiorna CLAUDE.md con la nuova versione TestFlight dopo l'upload.

## File da NON committare mai
- Segreti / chiavi: nessun file `.env` (già in `.gitignore`)
- Build artifacts: `ios/build/`, `ios/TwoWatch.xcodeproj/xcuserdata/`, `*.xcarchive`, `*.ipa`
- node_modules
- Log: `*-debug.log`, `firestore-debug.log`, `pglite-debug.log`, `~/somto-deploy-logs/`
- Duplicati iCloud: `* 2.json`, `*TwoWatch 2.xcodeproj`

## Stato corrente (una riga per ambito)

- Sistema editoriale: console `/admin-official-updates.html` e post automatici
  sulle uscite **live in prod**; pubblicazione/bozze/programmazione non
  richiedono build client. Dettagli e runbook in `docs/EDITORIAL_SYSTEM.md`.
- Ultima build iOS: **1.7.1 `2026081601`** — caricata su **TestFlight** il
  2026-08-16 (stato ASC `VALID`). La piattaforma giusta, e il widget che resta
  pieno. La **1.7.0** resta live su App Store. Dettagli e regole di numerazione
  in `docs/context/RELEASE_PROCESS.md`.
- Backlog e debiti aperti: `docs/PENDING.md` (aggiorna li', non qui).
