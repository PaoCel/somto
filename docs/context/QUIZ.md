# Quiz — feature completa + funnel acquisizione guest

Leggi per qualsiasi lavoro su quiz (iOS, web, sfide, classifica, guest play, quizMeta).

## Quiz feature
Path (`Features/Quiz/`):
- `QuizHomeView.swift` — hub (declutter 2026-06-18): hero "Gioca" snello (`QuizHeroPlayTile` con streak inline) + strip statistiche compatta (`QuizStatStrip`) + righe menu Sfide/Classifica (`QuizMenuRow`) + barra bonus (`QuizBonusBar`); hero abbassato dall'header (top padding 64). Consuma `pendingQuizInviteToken` (deep link invito).
- `QuizGameSetupView.swift` — fork pre-partita solo (redesign 2026-06-18): segmented **Casuale** (random dall'archivio) vs **Titolo specifico** + numero domande 3/5/10, poi avvia. Titolo specifico = vetrina `QuizTitlePickerView` (vedi sotto). Start bar contestuale ("Inizia partita" / "Gioca su {titolo}" / "Scegli un titolo"). `QuizPlayView`/`QuizPlayViewModel` accettano `selectedTitleId`/`questionCount`. Web equivalente: `quiz-setup.html` + `quiz-setup.page.js` (stesso fork; `quiz-play` legge `?titleId=&count=`).
- `QuizTitlePicker.swift` — vetrina riusabile "titolo specifico" (`QuizTitleCatalogStore` + `QuizTitlePickerView` + `QuizPosterCell`): ricerca su tutto il catalogo (`QuizRepository.fetchAllPlayableThemes()` → `quizMeta/themes`, lista completa in 1 read) + locandine (fetch lazy `titleRepository.listTitles(ids:)`), titoli visti-con-quiz prima (da `session.completedTitleIDs`), poi "Altri titoli con quiz". Usata da `QuizGameSetupView` e dal composer sfida. Web: `public/js/components/quizTitlePicker.js` (`createTitlePicker`, riusato da `quiz-setup.page.js` + `quiz-challenges.page.js`).
- `QuizPlayView.swift` — player domande + reveal + `QuizResultView` (reward XP/streak)
- `QuizLeaderboardView.swift` — segmented Settimanale/All time, podio top-3, legge via `collectionGroup("quizStats")`
- `QuizChallengeInboxView.swift` / `QuizChallengeComposerView.swift` — sfide; composer 2 path: amico Somto / invito esterno con share link
- `QuizChallengeResultView.swift` — confronto Tu vs Avversario
- `QuizInviteOnboardingView.swift` — "Prima di iniziare": l'invitato sceglie i titoli visti
- `QuizGamingKit.swift` — kit visivo condiviso (glow card, confetti, progress bar, status pill, stat tile, XP/streak/bonus card)
- `Components/QuizHubComponents.swift`, `Admin/AdminQuizListView.swift` + `AdminQuizEditorView.swift`

Models: `Domain/Models/QuizModels.swift` (include `QuizXP`, gamification su `QuizUserStats`, campi invito su `QuizChallenge`). Repo: `Data/Repositories/QuizRepository.swift`.

Gamification (su `users/{uid}/quizStats/agg`): XP separato dallo score classifica, streak giornaliero, bonus daily. XP: +10 quiz, +2 risposta, +15 sfida, +10 vittoria, +5 pareggio, ×1.2 con bonus daily (3 partite/giorno).

### QuizSession V2 — migrazione server-authoritative

- Backend implementato ma non deployato: `startQuizSessionV2` / `submitQuizSessionV2`, snapshot server-only, App Check, submit transazionale e idempotente. Spec: `docs/SOMTO_PRODUCT_SPEC/QUIZ_SESSION_V2_SECURITY_MIGRATION.md`.
- PWA adapter implementato in `public/js/api/quiz.api.js`; player solo predisposto in `quiz-play.page.js` con submit persistito in `sessionStorage`, retry con la stessa idempotency key e reveal differito al risultato server.
- Gate PWA intenzionalmente hard-off: `QUIZ_SESSION_V2_ENABLED = false`; inoltre il player ammette V2 solo su hostname staging e mai per `?challenge=`. Produzione e challenge restano legacy.
- Prima di abilitare staging: configurare App Check PWA, deployare backend/rules/TTL, seed approvato sufficiente e smoke test. Nessun fallback legacy è ammesso dopo uno start V2.

Invito esterno (sfida con persone non su Somto):
- Cloud Functions `functions/modules/quizInvite.js`: `createQuizExternalInvite`, `claimQuizExternalInvite`, `finalizeQuizExternalChallenge` (callable) + `quizInvitePreview` (HTTP landing). Deployate su `us-central1`.
- Link: `https://somto.it/quiz/invite/{token}` — universal link (path in AASA) + hosting rewrite → `quizInvitePreview`.
- Deep link: `AppDestination.quizInvite(token:)`; token in `AppShellStore.pendingQuizInviteToken`, sopravvive al signup.

Firestore:
- `quizQuestions/{id}` — read signed-in se status ∈ {approved, beta_pending_review}
- `users/{uid}/quizAttempts/{id}` — owner-only RW
- `users/{uid}/quizStats/agg` — cached counters + xp/streak/bonus; collectionGroup read signed-in per leaderboard
- `quizChallenges/{id}` — sender+receiver; `toUid` nullable (invito esterno non reclamato), `inviteType` internal/external; create client solo internal, esterni via admin SDK
- `quizInvites/{id}` — token hash invito esterno; **deny totale ai client** (solo Cloud Functions admin SDK)
- `quizQuestionReports/{id}` — signed-in create
- `leaderboard_weekly` / `leaderboard_allTime` — legacy, leaderboard usa collectionGroup quizStats
- `quizMeta/themes` — aggregato pubblico dei titoli con domande giocabili (`{themes:[{titleId,title,mediaType,count}], totalTitles, totalQuestions, updatedAt}`). **Read pubblica** (no risposte dentro), write solo server. Ricostruito da `scheduledRebuildQuizThemes` (24h) + `rebuildQuizThemes` (callable admin) + script `functions/scripts/rebuild-quiz-themes.js`. Usato da `fetchPlayableThemes` (web) per listing completo (130 titoli) + ricerca in 1 read.

## Quiz acquisizione: guest play + funnel (web, 2026-06-17)

Il quiz è la **leva di acquisizione** ([[project_quiz_acquisition]]). Funnel pubblico per far giocare i NON registrati e convertirli:
- **`public/quiz-prova.html` + `quiz-prova.page.js`** — quiz giocabile **senza login** (no authGuard). Picker temi (da `quizMeta`, con ricerca) o `?titleId=` deep-link → gioca → risultato server-scored → CTA "Registrati per salvare XP/classifica/sfide" (`/login.html?signup=1`). Pattern Duolingo.
- **Backend server-authoritative** (`functions/index.js`, europe-west1, NO auth richiesta): `getGuestQuiz({titleId?,count})` serve N domande random **SENZA `correctAnswerIndex`/`explanation`**; `submitGuestQuiz({answers})` valida lato server e ritorna punteggio + correttezza + spiegazioni. **Niente scrittura utente, niente leak answer-key, niente forge XP, niente anonymous-auth** (zero blast radius sulle rules `isSignedIn`). Cap 10 domande/call.
- **Entry point** (porte d'ingresso al funnel): pagina titolo SSR (`titlePage.js`) mostra CTA "Gioca il quiz su X" → `/quiz-prova.html?titleId=<docId>` quando il titolo è in `quizMeta` (membership cache 10min); landing `quiz-film-serie-tv.html` CTA primaria → `/quiz-prova.html`; `login.html` link "Prova un quiz senza registrarti".
- **Ricerca temi** in `quiz-setup.html` (loggati) + `quiz-prova.html` (guest): client-side su `quizMeta` (listing completo, non più campione random 300).
- `login.page.js`: deep-link `?signup=1` → apre tab Registrati.
- **Audit qualità next50**: 2500 domande fact-checkate (50 agenti), 98.9% pulite; 1 answer-key corretto, 19 domande flaggate (`status:flagged`, fuori dal pool, con `auditNote`) — vedi `quiz_beta/AUDIT-NEXT50-REPORT.md`. 86 minori a backlog.
- **Solo web**: il guest play su iOS è un cambio strutturale (gate globale `RootView` + sessione anon) → release iOS separata (vedi Pending). Il fix icona giganti era web-only (SwiftUI iOS non affetto).
