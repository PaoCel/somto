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
- Cloud Functions `functions/modules/quizInvite.js`: `createQuizExternalInvite`, `claimQuizExternalInvite`, `cancelQuizExternalInvite`, `finalizeQuizExternalChallenge` (callable) + `quizInvitePreview` (HTTP landing). Region dichiarata: `europe-west1` (`REGION` in `quizInvite.js`; la riga "us-central1" qui era ferma a prima della migrazione region).
- **Ricondivisione**: `createQuizExternalInvite` scrive `inviteUrl` (link in chiaro) anche sul doc `quizChallenges/{id}`, cosi' il mittente riapre la sfida e ricondivide il link invece di vederlo solo nel return della create. In `quizInvites` resta solo l'hash del token; il doc sfida e' leggibile da `fromUid` e `toUid` e al claim il token e' consumato.
- **Annullamento**: `cancelQuizExternalInvite({challengeId})` — solo `fromUid`, solo `inviteType == "external"` e `status == "pending_external_signup"`, ritorna `{ok:true}`. In una batch **cancella** il doc sfida (niente stato nuovo: le build iOS sullo Store decodificano `status` come enum) e mette `status: "revoked"` + `revokedAt` sull'invito, ritrovato per `challengeId` (equality su singolo campo, nessun indice nuovo). Rules invariate.
- Dopo l'annullamento il link vecchio non gioca piu': `quizInvitePreview` mostra il titolo **"Invito annullato"** senza CTA App Store ne' "Continua nel browser", e `claimQuizExternalInvite` risponde `failed-precondition "Invito annullato"` (anche se la sfida e' sparita sotto la transazione). Coperto da `quizInvitePreview.test.cjs` + `quizInviteCancel.test.cjs`.
- Link: `https://somto.it/quiz/invite/{token}` — universal link (path in AASA) + hosting rewrite → `quizInvitePreview`.
- La landing offre "Scarica Somto" (primario) e, dal 2026-09-06, **"Continua nel browser"** → `/quiz-invite.html?token=...`: prima quella pagina esisteva ma era irraggiungibile, perche' l'intero path `/quiz/invite/**` finisce sulla function. Markup coperto da `functions/test/unit/quizInvitePreview.test.cjs`.
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
- **Backend server-authoritative** (`functions/index.js`, europe-west1, NO auth richiesta): `getGuestQuiz({titleId?,count})` serve N domande random **SENZA `correctAnswerIndex`/`explanation`** e rilascia un token casuale di sessione server-only; `submitGuestQuiz({sessionToken,answers})` accetta solo lo stesso set di domande emesso dal server, ricontrolla stato/lingua e ritorna punteggio + correttezza + spiegazioni. Le sessioni effimere vivono nella collection deny-all `guestRateLimits`, scadono logicamente dopo 30 minuti e hanno cleanup opportunistico. **Niente scrittura utente, niente query arbitrarie dell'answer-key, niente forge XP, niente anonymous-auth** (zero blast radius sulle rules `isSignedIn`). Cap 10 domande/call.
- **Entry point** (porte d'ingresso al funnel): pagina titolo SSR (`titlePage.js`) mostra CTA "Gioca il quiz su X" → `/quiz-prova.html?titleId=<docId>` quando il titolo è in `quizMeta` (membership cache 10min); landing `quiz-film-serie-tv.html` CTA primaria → `/quiz-prova.html`; `login.html` link "Prova un quiz senza registrarti".
- **Ricerca temi** in `quiz-setup.html` (loggati) + `quiz-prova.html` (guest): client-side su `quizMeta` (listing completo, non più campione random 300).
- `login.page.js`: deep-link `?signup=1` → apre tab Registrati.
- **Audit qualità next50**: 2500 domande fact-checkate (50 agenti), 98.9% pulite; 1 answer-key corretto, 19 domande flaggate (`status:flagged`, fuori dal pool, con `auditNote`) — vedi `quiz_beta/AUDIT-NEXT50-REPORT.md`. 86 minori a backlog.
- **Fase A del 2026-09-06** (`docs/QUIZ_PUSH_PLAN_2026-09-06.md`): dal risultato guest il `next=` della registrazione riporta alla partita vera sul titolo appena giocato (`/quiz-play.html?titleId=&count=`, per le saghe il titolo estratto dal server, che e' l'unico parametro che `quiz-play` accetta); un `?titleId=`/`?saga=` non piu' giocabile torna al picker con avviso e il parametro sparisce dall'URL, invece di ciclare sul "Riprova"; `quiz-leaderboard.html` da sloggato mostra un invito al login invece del permission-denied di `collectionGroup(quizStats)`.
- **Solo web**: il guest play su iOS è un cambio strutturale (gate globale `RootView` + sessione anon) → release iOS separata (vedi Pending). Il fix icona giganti era web-only (SwiftUI iOS non affetto).

## Qualità corpus e video social (2026-08-27)
- `docs/QUIZ_QUALITY_AUDIT_2026-08-27.md` — audit del corpus live: solo il 23,6% delle domande è "pronto per andare a schermo"; il 51,1% ha la risposta giusta come opzione più lunga; accenti mangiati nei batch `hp_*` e `family_classics_*`; saghe spezzate (Harry Potter = 8 titoli separati, ma `titles.collectionId` c'è già); 143 partite totali su `quizAttempts`.
- Da `functions/`, `node scripts/quiz-corpus-triage.js` legge il corpus e genera solo report locali in `quiz_beta/triage/<data>/` (dry-run predefinito).
- Per una prova ridotta usare `--limit N`; per scrivere usare separatamente `--write-flagged` o `--write-approved`.
- Le due write insieme richiedono `--yes`; prima delle scritture in batch da 400 lo script salva nella stessa cartella il backup JSON completo dei documenti originali.
- `docs/QUIZ_SOCIAL_VIDEO_SCRIPTS.md` — serie "Quanto ne sai di…": formato, regole e 6 script pronti (Harry Potter, Trono di Spade, Mare Fuori, Dragon Ball, I Cesaroni, Il Re Leone) con domande reali e id.
