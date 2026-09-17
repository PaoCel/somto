# Quiz — piano "pushabile" (2026-09-06)

Esito dell'audit del 6 settembre (codice iOS + web + backend, dati prod, prova
reale guest nel browser e loggato nel simulatore). Verdetto: **PASS WITH
CONCERNS**. Il quiz funziona end-to-end, ma non regge ancora come leva di
acquisizione. Questo file e' il piano operativo, diviso per fase e per
esecutore. Aggiornare le caselle man mano.

## Numeri di partenza (prod, 2026-09-06)

| Metrica | Valore |
| --- | --- |
| Utenti / giocatori con `quizStats` | 410 / 41 |
| Partite loggate da sempre | 149 |
| Sfide totali / ultimi 30 gg | 20 / 3 |
| Inviti esterni creati / riscattati, 30 gg | 1 / 0 |
| Guest 30 gg: partite avviate / completate | 132 / 81 |
| `/quiz/*` render 30 gg / click GSC | 2.625 / 1 |
| Corpus | 10.393 `beta_pending_review`, 101 `approved`, 243 titoli |

## Fase A — sblocchi immediati (oggi)

Esecutore: Claude (main loop) per i deploy, agente Opus "web" per il codice.

- [x] **A1. Saghe live su prod.** `quizMeta/sagas` non esiste: le funzioni
  `rebuildQuizThemes` e `scheduledRebuildQuizThemes` deployate sono del 29/07,
  senza saghe. Fix: deploy delle due funzioni da main pulito
  (`firebase deploy --only functions:rebuildQuizThemes,functions:scheduledRebuildQuizThemes --project prod`)
  e prima scrittura con `node functions/scripts/rebuild-quiz-sagas.js --write`
  (da `functions/`, ADC). Verifica: `getGuestQuiz({sagaId:"harry-potter"})`
  risponde 200 e il picker guest mostra la sezione Saghe.
- [x] **A2. Web: `?titleId=` non valido non deve andare in loop.** In
  `public/js/pages/quiz-prova.page.js` il ramo `else` dell'errore di start
  deve tornare al picker con `pickerNotice`, come gia' fa il ramo saga.
- [x] **A3. Web: classifica da sloggato.** `quiz-leaderboard.page.js` apre la
  pagina con `requireAuth:false` ma la rule vuole `isSignedIn()`: intercettare
  il permission-denied con un empty state "Accedi per vedere la classifica"
  (o richiedere il login). Niente errore Firestore grezzo.
- [x] **A4. Web: la registrazione dal guest riporta al titolo giocato.**
  `signupHref()` deve passare `next=/quiz-play.html?titleId=...&count=...`
  (o `sagaId`) invece di `/quiz.html`.
- [x] **A5. Web: copy classifica.** "La classifica si aggiorna ogni lunedi'
  alle 00:00" descrive un job che non esiste: sostituire con una frase vera
  (es. "Classifica della settimana in corso"), stessa stringa su iOS
  (`QuizLeaderboardView.swift`) e web, chiave unica in `en.js` e
  `Localizable.xcstrings`.
- [x] **A6. Web: buchi i18n del quiz.** "Vittoria"/"Sconfitta",
  `CATEGORY_LABELS`, "Amico Somto"/"Invita esterno", "Carico i titoli…",
  "Impossibile caricare i titoli.", `showReportToast("Segnalazione inviata.
  Grazie.")` passano da `i18nT()` riusando le chiavi gia' esistenti.
- [x] **A7. Invito esterno via web.** `public/quiz-invite.html` (+ `.page.js`)
  non e' raggiungibile: `/quiz/invite/{token}` va sempre a
  `quizInvitePreview`, che offre solo App Store. Decisione: aggiungere in
  `functions/modules/quizInvite.js` un link "Continua nel browser" →
  `/quiz-invite.html?token=...` quando l'invito e' valido. Deploy di
  `quizInvitePreview` in Fase A.

Chiusura fase A: **fatta il 2026-09-06** (hosting SW v215 + `quizInvitePreview`,
`rebuildQuizThemes`, `scheduledRebuildQuizThemes` deployate, `quizMeta/sagas`
scritto: 8 saghe, 1.717 domande). iOS A5 resta nella fase B.

## Fase B — iOS (build TestFlight)

Esecutore: agente Opus "iOS". Stile: `docs/context/IOS_CODE_STYLE.md`.

- [x] **B1. Risultato onesto.** `QuizPlayViewModel.finish()`
  (`QuizPlayView.swift` ~246): se `submitAttempt`/`recordChallengePlay`
  falliscono, stato d'errore visibile con "Riprova" e `SilentFailure.record`,
  mai `.finished` con confetti e XP non salvati.
- [x] **B2. Guardia anti doppio tap** su `continueFromReveal()` e `finish()`
  (pattern `beginAction` gia' in uso nel repo): un solo submit per partita.
- [x] **B3. Errore dell'hub visibile.** `QuizHomeView.loadingError` e' scritta
  e mai letta: mostrarla con retry.
- [x] **B4. Copy.** "1 giorni di fila" → plurale corretto; motivi di
  `ReportProblemSheet` tutti localizzati.
- [x] **B5. Punteggio leggibile.** Nel risultato e nell'hub mostrare
  "N/5 · 60%" accanto (o al posto) del punteggio decimale 0.2/3.8, allineato
  al risultato guest web.
- [x] **B6. Chiudi dal risultato torna all'hub**, non al setup.
- [x] **B7. CTA sociale nel risultato**: "Sfida un amico su questo titolo"
  (apre il composer con `titleId` preimpostato).
- [x] **B8. Banner "Verifica consigliata" sotto l'header.** Chiuso il
  2026-09-06 sera togliendo l'overlay dallo shell: il consiglio e' una card in
  cima alla Home (stesso componente delle card nudge) e una riga in
  Impostazioni > Account. Il primo tentativo con `safeAreaInset` era stato
  revertito (`52e9365`): le tab ignorano gli inset custom.
- [x] **B9. Saghe su iOS** (`QuizTitlePicker` + `QuizGameSetupView`): leggere
  `quizMeta/sagas`, sezione "Saghe" nel picker, partita che pesca dai titoli
  della saga. Dipende da A1.

Chiusura fase B: codice su main il 2026-09-06 (`7b4b112`, `ios-ci.sh --full`
verde, A5 iOS incluso). Resta: bump versione in `ios/project.yml` e build
TestFlight (vedi `docs/context/RELEASE_PROCESS.md`).

## Sfide — chiusura del 2026-09-06 sera

Verifica reale nel simulatore e sul web dopo la prima build TestFlight:

- [x] **Picker "Amico Somto" su chi segui** (era la lista amici legacy, vuota
  per chi usa il follow): iOS `fbe3e7f`, web `2ad7522`, live.
- [x] **Sfida su una saga** (solo percorso amico): `sagaId`/`sagaName` sul doc,
  `sharedTitleIds` = titoli della saga, barra "Sfida su {nome}". iOS + web.
- [x] **Inviti inviati: ricondividi e annulla**: `inviteUrl` scritto dal server
  sul doc sfida, callable `cancelQuizExternalInvite` (cancella la sfida e
  revoca il token, landing "Invito annullato"). Funzioni deployate, iOS + web.
- [x] **Invito senza nome mostra la data** ("Invito del 6 set"), campo Nome in
  cima al percorso esterno.
- [ ] Sfida su saga anche per l'invito esterno (oggi le domande le sceglie il
  server sui titoli in comune).
- [ ] Le azioni sulla riga iOS sono bottoni + context menu: le swipe actions
  richiederebbero una `List` (redesign dell'inbox).

## Widget — fix del 2026-09-06 sera

- [x] Il widget "si svuotava in un giorno": i file dell'App Group erano scritti
  con `.completeFileProtectionUnlessOpen`, illeggibili a telefono bloccato
  proprio quando WidgetKit rinfresca. Ora `UntilFirstUserAuthentication`,
  retry a 15 minuti se il file c'e' ma non si legge, retry a 30 minuti per il
  feed uscite non raggiungibile (`97fa44a`). Footgun annotato in CLAUDE.md.

## Fase C — corpus (batch su prod con dry-run)

Esecutore: Codex (tooling) + sessione dedicata per i batch LLM.

- [x] **C1. Tooling di triage** (dry-run su prod 2026-09-06: 10.575 lette,
  3.473 tell forte, 1.398 trivia di produzione, 2.956 candidate approved;
  report in `quiz_beta/triage/2026-09-06/`, JSON non tracciati) (`functions/scripts/quiz-corpus-triage.js`,
  logica pura in `functions/lib/quizCorpusAudit.js`, test su fixture):
  esporta (a) le domande con "tell" forte (corretta = unica piu' lunga e
  ≥1,5× la piu' corta) come batch JSON per la riscrittura dei distrattori,
  (b) le domande di trivia di produzione (cast, regia, incassi, premi, rete,
  doppiatori) come lista da `flagged`, (c) le domande che passano il filtro
  "pronta per schermo" come candidate a `approved`. Solo dry-run e report;
  `--write` con backup come `import-reviewed-quiz-packages.js`.
- [x] **C2. Riscrittura distrattori** dei 3.473 con tell forte: batch LLM,
  non tocca domanda ne' risposta, quindi niente nuovo fact-check.
  Fatto 2026-09-07: 3.473 domande su 3.473 riscritte su prod (3.202 + 180 dai retry Codex + 91 dai retry Sonnet) (solo `answers` +
  marker `distractorsRewrittenAt`/`distractorsRewriteBatch`), backup e
  report in `quiz_beta/triage/2026-09-06/c2/` (JSON non tracciati).
  Triage rifatto dopo la scrittura (`quiz_beta/triage/2026-09-07/`): tell
  forte 3.473 → 271, candidate approved 2.956 → 3.711. Pipeline:
  batch da 25 (Haiku/Sonnet/Codex) → `functions/lib/quizDistractorRewrite.js`
  (giusta identica e allo stesso indice, fascia di lunghezza, tell sparito,
  accenti, swap se la giusta e' spostata) → `apply-distractor-rewrites.js`
  con precondizione sulle answers correnti. Validazione finale 3.473 accettate / 0 rifiutate / 0 padding; triage
  finale (`quiz_beta/triage/2026-09-07/`): tell forte 0. Backup e riepilogo
  in `quiz_beta/triage/2026-09-06/c2/`, tooling in
  `quiz_beta/distractor-rewrite/`.
- [x] **C3. Potatura** delle trivia di produzione → `flagged`. Fatto
  2026-09-07: 1.398 domande flaggate (campione di 40 letto a mano: tutte
  cast/regia/anno/incassi/rete, nessun falso positivo; nessun titolo sotto
  le 10 domande), backup in `quiz_beta/triage/2026-09-07/`. Aggregati
  rigenerati subito: `quizMeta/themes` 243 titoli / 9.096 domande giocabili,
  `quizMeta/sagas` 8 saghe / 1.523 domande.
- [x] **C4. Gate `approved`**: promuovere cio' che passa i filtri; `quizPage`
  e `sitemapQuiz` gia' filtrano su `approved`. Fatto 2026-09-07: 3.750 + 25
  candidate promosse (le 25 emerse dopo l'ultimo giro di C2) (backup in `quiz_beta/triage/2026-09-07/`);
  `sitemap-quiz.xml` espone 233 pagine quiz.
- [ ] **C5. Ricalibrare `difficulty`** dal tasso reale su `quizAttempts`
  (serve volume, oggi 149 partite).

## Fase D — integrita' e distribuzione

- [ ] **D1. Session V2 server-authoritative** (`startQuizSessionV2` /
  `submitQuizSessionV2`, gia' scritte): App Check PWA, deploy backend/rules/
  TTL, smoke in staging, poi `QUIZ_SESSION_V2_ENABLED` su prod. Attenzione:
  l'API App Check risulta disabilitata su `gia-visto`.
- [ ] **D2. Read ristretta su `quizQuestions`**: oggi qualsiasi account
  scarica l'intero answer-key (rule read su status). Dipende da D1.
- [ ] **D3. Rate-limit sulle scritture dirette a `quizStats`** (oggi solo cap
  per scrittura in `quizStatsDeltaOk`).
- [ ] **D4. Attivazione interna**: quiz del titolo appena visto in Home e
  scheda titolo (iOS + web), CTA sfida nel risultato (B7), invito esterno
  fuori dal tab Quiz.
- [ ] **D5. Pulizia**: rules e riferimenti a `leaderboard_weekly`/
  `leaderboard_allTime` (collection morte), commento TODO obsoleto in
  `firestore.rules` sezione `quizQuestions`.

## Test di accettazione

- `?saga=harry-potter` da guest su prod → partita, non "Saga non disponibile".
- iOS: submit con rete spenta → errore con Riprova, nessuna vittoria finta;
  doppio tap su "Vedi risultato" → un solo doc in `quizAttempts`.
- Web: `?titleId=xxx` inesistente → picker con avviso; classifica da sloggato
  → invito al login; registrazione da guest → torna al titolo giocato.
- Rules in emulatore per ogni modifica a `quizQuestions`/`quizStats`.
- Rerun `functions/scripts/audit-quiz-corpus.cjs` dopo i batch di Fase C.
