# Pending residui

Backlog vivo: debiti, feature spente, fix deployati con coda aperta.
Aggiorna QUI (non in CLAUDE.md) quando chiudi o apri un pending.

## Pending residui
- **App Intent "Aggiungi a watchlist": NASCOSTO perche' rotto (aperto
  2026-08-12).** Su device risponde con l'errore **generico di sistema** ("c'e'
  stato un problema"), non con una delle frasi di `SomtoIntentError` — quindi il
  guasto sta **prima** di `perform()`: nella query dell'entity
  (`SomtoTitleLookup.entities(matching:)`) o nel bootstrap headless
  (`SomtoIntentContext`). Ipotesi da scartare in ordine: (1) il budget di tempo
  di App Intents superato dalla catena Firestore+TMDB; (2) `Auth.currentUser`
  non ancora ripopolato quando la query parte; (3) qualcosa in
  `FirebaseBootstrap` che in lancio headless non regge.
  Messo `isDiscoverable = false` su `AddToWatchlistIntent` e rimosso
  `SomtoShortcuts.swift` (recuperabile da git, commit `77d06cb`): sparisce da
  Siri, Spotlight **e** dall'app Scorciatoie. Il codice resta perche' i bottoni
  dei widget interattivi sono App Intent.
- **Widget "Prossime uscite": LIVE (feed + 1.7.0 su TestFlight), code aperte
  sui DATI.** Target `SomtoWidgets` (`ios/SomtoWidgets/`), tre famiglie, tap →
  scheda titolo via deep link. Non parla con Firebase: legge
  `https://somto.it/prossime-uscite.json` (Cloud Function
  `upcomingReleasesFeed`) — il perche' sta in `docs/DECISIONS.md` (2026-08-12).
  Indice, function e hosting sono deployati (il feed risponde con dati veri).
  **Resta da guardare su device**: taglie accessibility su `systemMedium`
  (mostra 2 righe invece di 3, mai verificato a schermo) e lo stato di errore.
  **Chiuso il 2026-08-14** (misure sul catalogo di quel giorno): il feed dice
  anche dove esce (`releaseKind` da `releaseType` TMDB → "Al cinema" / "In
  streaming" / "In TV"), include le **premiere di stagione** delle serie
  (`new_episode` con `episode == 1`, 109 su 209 eventi episodio futuri) e
  scarta le uscite in supporto fisico e le date marcate `reviewReason`
  (22 su 53 erano `missing_it_release_date`, cioe' la data globale mostrata
  come italiana). Vedi `docs/DECISIONS.md` (2026-08-14).
  **Resta aperto**: **niente logo della piattaforma** — 0 titoli su 40 in
  arrivo avevano `watchProviderNames`, perche' TMDB pubblica i provider quando
  il titolo e' disponibile e non prima. Serve una fonte che conosca la
  piattaforma *prima* dell'uscita; per le serie il `networks[0]` TMDB c'e' gia'
  in `titles.meta.network` ed e' il candidato piu' vicino.
- **Widget "Watchlist" (sola vista): FATTO il 2026-08-14.** Mostra le serie in
  corso col punto in cui sei ("Sei a S3·E7") piu' una o due voci di coda. Non
  legge Firebase: l'app scrive un riassunto in un App Group
  (`group.com.paolocelestini.twowatch.ios`) alla fine del caricamento della
  Watchlist, il widget legge quello. Zero letture Firestore, nessuna migrazione
  keychain; il prezzo e' la freschezza, che e' quella dell'ultima apertura
  dell'app. Il file viene cancellato al logout e a ogni cambio utente.
  **Da guardare su device**: che il riassunto arrivi davvero (la prima apertura
  dopo l'aggiornamento e' quella che lo crea) e che il tap apra la scheda.
- **Widget "Segna episodio" (col bottone): FATTO il 2026-08-14.** Widget
  configurabile su UNA serie in corso, con il bottone che segna l'episodio
  successivo. Chiama la callable `applyTitleStateAction` come fa l'app; il token
  arriva da un keychain access group condiviso in cui l'app deposita il refresh
  token (`WidgetAuthBridge.swift`). Nessun SDK Firebase nell'estensione, e la
  sessione dell'app non e' stata toccata — vedi `docs/DECISIONS.md`.
  **Da guardare su device**, perche' nessuna di queste cose si vede in
  simulatore: (1) che il tap scriva davvero (controlla `titleStates` o riapri
  l'app), (2) che dopo il tap compaia "Aggiornato in Somto" e il bottone si
  disattivi, (3) che a token mancante compaia "Non riuscito, apri Somto" invece
  di un widget che non reagisce, (4) che scegliendo la serie in configurazione
  l'elenco non sia vuoto (lo popola il riassunto, quindi serve aver aperto la
  Watchlist almeno una volta).
- **Correggere la data di un evento GIA' pubblicato non rinotifica (aperto
  2026-08-12).** `shouldFanOutTitleUpdate` scatta solo al passaggio a
  `published` (`before.status !== "published"`), di proposito: evita di
  rinotificare a ogni riscrittura. Ma se un film slitta da ottobre a dicembre e
  la data viene corretta, chi l'ha in watchlist non lo scopre — ed e' proprio il
  caso editorialmente interessante. Da decidere: notificare su un cambio di data
  **oltre una soglia** (es. spostamento > 7 giorni) e non piu' di una volta per
  evento.
- **BUG FIXATO su main, non ancora in build TestFlight — il voto di un singolo
  episodio non "teneva" (segnalato da Paolo 2026-08-11).** Sintomo: da
  `EpisodeRatingSheet` ("Voto episodio", S·E) le stelline si riempivano
  durante il gesto e tornavano vuote appena si lasciava. Tre difetti in
  `Features/TitleDetail/`, tutti chiusi:
  1. **Mancava lo stato ottimistico (commit `5b46f96`) — questo da solo
     spiegava il sintomo.** `EpisodeRatingSheet` (`EpisodeListSection.swift:258`)
     passava `personalRating` letto da `viewModel.rating(level:"episode",…)`
     e non teneva stato locale. Al `onEnded` `SomtoStarRatingRow` azzerava
     `liveValue` e ricadeva sulla prop, che restava nil finche' la scrittura
     non tornava → stelline vuote. Fix: `@State localRating` copiato da
     `EpisodeSeenSheet.swift:145/304` (inizializzato in `init` da
     `personalRating`, aggiornato nel callback di `SomtoStarRatingRow`
     **prima** di chiamare `onSelect`, usato anche per la visibilita' del
     bottone "Annulla voto" cosi' i due controlli non leggono due fonti
     diverse).
  2. **Il drag poteva emettere un voto invalido — falso allarme, gia' fixato
     dal 2026-07-10.** Diagnosi iniziale: `SomtoStarRatingRow`
     (`TitleProgressModules.swift:518`), passo 0,5, avrebbe potuto emettere
     `0.5` col drag mentre `firestore.rules` pretende `rating >= 1` (righe
     1476/1492) → permission-denied, e solo `accessibilityAdjustableAction`
     clampava. **Verificato sul codice attuale: falso.** `roundedValue(_:)`
     (`TitleProgressModules.swift:672`, commit `acce7bc4`) fa gia'
     `max(1, min(10, rounded))` ed e' l'unica funzione usata sia da
     `onChanged` che da `onEnded` del drag — il floor era gia' corretto su
     entrambi i percorsi prima ancora di questo bug report. Nessun codice
     cambiato per questo punto.
  3. **L'errore non era visibile — FIXATO (commit `f71c695`).**
     `submitRating` scriveva `errorMessage` sul VM della scheda titolo, che
     sta **dietro** il foglio: con lo sheet aperto l'utente non vedeva
     niente. Fix: `onSelect` e' diventato `(Double) async -> Bool` fino a
     `EpisodeRatingSheet` (stesso pattern di `onSaveEmotions`/
     `onSaveCharacterPicks` in `EpisodeSeenSheet`); il foglio mostra
     "Voto non salvato" + bottone "Riprova" sullo stesso valore invece di
     richiudersi in silenzio. Tocca la firma `TitleDetailActions
     .onQuickRateEpisode` e `TitleDetailView.quickRateEpisode`, unico call
     site.
  **Resta**: build TestFlight che include `5b46f96`/`f71c695` (release
  successiva alla 1.7.0 `2026080902` gia' in TestFlight).
- **Tre scritture che falliscono in silenzio, da guardare quando arrivano i
  dati Crashlytics (aperto 2026-08-11).** Sono `try? await` su **scritture**
  innescate dall'utente, ora strumentate ma ancora mute in schermo:
  `TitleEmotions.submitEmotions` e `TitleEmotions.submitPicks`
  (`Features/TitleDetail/TitleDetailSheets.swift`) e
  `EpisodeSeen.submitRating` (`Features/TitleDetail/EpisodeSeenSheet.swift`),
  piu' `Root.signOut` (`Features/AppShell/RootView.swift`).
  Sulle prime due il silenzio e' documentato e difendibile — il voto e' gia'
  salvato, l'errore non deve impedire la chiusura del composer. Sul voto
  episodio e sul sign-out no: se falliscono, l'utente crede di aver votato o
  di essere uscito, e non lo e'.
  **Cosa serve per chiuderlo**: una build in mano ai tester, qualche giorno di
  Crashlytics, e poi decidere quali meritano un errore visibile. Deciderlo
  adesso a tavolino significa indovinare, e ogni messaggio d'errore in piu' e'
  attrito per il 99% a cui la chiamata funziona.
- **`try? await` rimasti: 24 nei repository + ~37 sparsi (aperto 2026-08-11).**
  Non e' una dimenticanza. Nei repository `try?` e' quasi sempre un fallback
  legittimo (prova l'arricchimento, se non c'e' vai avanti): strumentarli
  riempirebbe Crashlytics di rumore su cui non si puo' agire, ed e' il modo in
  cui un reporting viene silenziato entro una settimana. I ~37 sparsi uno o due
  per file (quiz, onboarding, import, thread) valgono poco singolarmente.
- **Chiavi `UserDefaults` legacy da cancellare, non prima che passi la coorte
  App Store (aperto 2026-08-09).** `SomtoDefaultsMigration`
  (`ios/TwoWatch/Core/Persistence/SomtoDefaults.swift`) **copia** i valori dai
  nomi vecchi a quelli canonici e **non cancella**, di proposito: su un device
  dell'utente non si torna indietro, e se la copia avesse un difetto con la
  legacy gia' rimossa il dato sarebbe perso per sempre. Tenendola, una build
  precedente installata sopra ritrova i suoi dati.
  Chiavi ancora presenti in doppia copia: `somto_watchtime_unit`,
  `titleDetailVNextTourVersion`, `recommendedUpdateDismissedBuild`,
  `twowatch_thread_reads`, `somto.matchHintSeen`, `pushPromptSeenV1`,
  `wlWelcomeDismissed`, `wlCreateTipDismissed`, i 5 `rating_prompt_*`,
  `search.history.v1.*`, `home_import_reveal_seen_*`.
  **Quando chiuderlo**: quando la coorte sullo Store e' oltre la prima build che
  contiene la migrazione. Allora si aggiunge un passo di sola cancellazione con
  una sentinella nuova (`somto.defaultsCleanup.v1`), e si aggiornano i test.
  Costo del rinvio: qualche centinaio di byte per device. Costo di farlo
  adesso: irreversibile.
- **Import Letterboxd: fase 1 manuale, gli zip vanno lavorati a mano
  (LIVE 2026-08-04).** La UI di `/import.html` ha la sorgente Letterboxd con la
  guida all'export e l'upload dello zip grezzo su
  `supportImports/{uid}/letterboxd-*` (customMetadata `source=letterboxd_zip`,
  rules invariate). **Alla UI promettiamo lavorazione entro 24 ore e un
  messaggio in chat**: finché la sorgente è attiva la cartella va controllata
  ogni giorno, se no la promessa è rotta. Fase 2 (parser server-side, mapping
  voti 0.5–5.0 → 1–10, matching senza tmdbId) in `docs/LETTERBOXD_IMPORT.md`.
- **userLists: campi server-only fuori dalla hasOnly = lista immodificabile
  (FIXATO+DEPLOYATO 2026-07-31, lezione generale).** `backfill-list-followers.js`
  scriveva `followersCountUpdatedAt` sul root via admin SDK; il campo (e
  `isTestSeed` su una lista storica) non era in `validUserListDoc.hasOnly` →
  dal primo follower OGNI update client del root (owner e admin inclusi,
  "aggiungi a una lista" di iOS/web) falliva permission-denied (incidente
  "Marvel cronologico" di Paolo). Fix rules deployato (campi ammessi in
  presenza, immutabili dal client, vietati in create; repro spec
  `rules-repro-list-poisoned.spec.cjs`, 181 rules test verdi). **REGOLA: ogni
  campo scritto lato server su doc con hasOnly client va aggiunto ANCHE alla
  hasOnly** — altrimenti si avvelena il doc. Restano da fare: revisione UX
  watchlist/liste richiesta da Paolo ("renderla più semplice e farla
  funzionare davvero bene" — sessione dedicata) + valutare rimozione compat
  rule liste pubbliche (coorte ormai su 1.5.x, vedi bullet watchlist-tab).
- **Motore consigli: collaborativo precalcolato LIVE (2026-08-02).** Motore
  estratto in `lib/recommendationEngine.js` (25 test) + benchmark offline
  (`lib/recoBenchmark.js`, 32 test, baseline in `docs/reco-benchmarks/`) +
  indice item-item (`lib/itemSimilarity.js` 16 test, job in
  `lib/titleSimilarityJob.js`). `computeCollaborativeSignals` non ricalcola piu'
  nulla: legge `titles/{id}/aggregates/similar` (**8 letture** invece di
  ~6.900). Deployato e verificato: 4.352 titoli indicizzati, `getMatchQueue`
  risponde `engine: hybrid+collab+taste`. Benchmark corretto per leakage e
  parita' runtime: NDCG@10 0.097 -> 0.147, recall +39%, hitRate +30%, copertura
  e diversita' in salita. Rules invariate, 182 rules test + 717 unit test verdi.
  **Aperti**: (1) **Match resta lento, 7-12s a
  caldo**: non e' il collaborativo (~0,4s) ma `collectCandidatePool`, che
  scandisce ~1.000 doc su 20.653 titoli a ogni richiesta — prossimo collo di
  bottiglia; (2) la misura viene da un holdout non temporale su 128 utenti, da
  riverificare quando i voti cresceranno.
- **Tracker episodi: escludere le stagioni non uscite dai totali
  (`estimateTitleTotals`) — proposta da scrivere.** Oggi una stagione futura
  annunciata su TMDB (Reacher S4, air 2026-08-12) entra in
  `totalEpisodeCount/totalSeasonCount`: una serie completata scivola a
  "in corso 75%" e il force-fill delle completate mostrerebbe visti episodi
  mai usciti. I client ora GATANO la spunta sull'air date (build `2026073102`
  + web SW v163), ma il fix vero è nei totali server+client (tocca completion
  semantics, import, percentuali → serve proposta con test dedicati).
- **Serie "in corso a 0 episodi" da import — LIVE 2026-07-31 (fix deployati +
  dati riparati; resta solo iOS in prossima build).** Erano 50 serie su 29
  utenti prod con `in_progress` a 0 episodi (iOS rendeva "0%"/"in corso"
  nonsense; la PWA le nascondeva; nessun S0/E0 letterale nei doc). Due cause:
  (1) righe kind `movie` mis-matchate a titoli TV dal fallback AniList (41
  casi: film "My Fault" → anime WataMote, "Mom or Dad?" → 父は英雄…) — il
  writer fabbricava una serie senza episodi; (2) parser Netflix perdeva
  "Miniserie/Stagione N: Parte M" (strip suffisso svuotava tutto: Alias Grace
  6 parti, When They See Us 4). Fix: `netflixCsv.js` (lone "Parte N" = numero
  episodio; mai 0 nei campi numerici), `writeTitleStates.js` (righe film su
  titolo TV → NESSUNO stato; zero contabile → toggle_watchlist mai
  in_progress-0; episodi senza stagione contano season-agnostici; mai
  lastWatchedEpisode senza season), clamp >0 in `functions-public-profile`
  `normalizeSeriesProgress`, guardie badge iOS (`progressBadgeLabel` +
  `ProfileComponents.progressLabel`: >0 e floor 1%, build Release verificata)
  e floor 1% web. 13 unit test nuovi (641 verdi). DEPLOYATO 2026-07-31:
  functions `startTitlesImport,runImportMatchTick,confirmTitlesImport` +
  `publicprofile:getPublicProfileSeriesProgress,getTitleWatchersProgress` +
  hosting. Riparazione ESEGUITA con `repair-series-progress-zero.js --write`:
  50/50 (41 delete mis-match, 4 → watchlist, 5 recuperi veri con minuti —
  Alias Grace ×2 e When They See Us completate), re-scan = 0 anomalie. Ops:
  `scan-series-progress-zero.js` (censimento read-only, riusabile). Il
  mis-match AniList a monte resta a backlog (memoria
  tvtime_gdpr_parser_improvement_spec §3); guardie badge iOS pending
  prossima build TestFlight.
- **Grafo amicizie: FASE 1 FATTA (2026-07-29), fase 2 bloccata sulla coorte App
  Store.** Deciso di dismettere `users/{uid}/friends`; piano in 3 fasi in
  `docs/DECISIONS.md`. Fase 1 = via tutta la UI e tutte le **write** dai client
  (web: modale + voce drawer "Amici" e "Richieste amicizia" + badge + 7 funzioni
  di `users.api.js`; iOS: sezione "Richieste" dell'inbox profilo, 5 write di
  `UserRepository`, tab `.friends` della ConnectionsSheet, `FriendshipState`),
  **rules/functions/dati intatti** → le build iOS già sullo Store non si
  rompono. Tolta anche la visibilità "Amici" dai composer post (con
  `isFriendWith` sempre falsa quei post non li leggerebbe nessuno). **Fase 2**
  (precondizione: coorte App Store aggiornata): migrare i post
  `visibility:"friends"` esistenti, poi togliere `isFriendWith` dalle rules, i 2
  trigger notifica **gen1** (cancellarli è a senso unico, vedi gotcha gen1) e il
  ramo friends di `collectFeedRecipientUids`; migrare a `following` i lettori
  rimasti: `listFriends` web (scheda titolo, community, thread, sfide quiz) e
  `listAcceptedFriends` iOS (picker sfide, menzioni). **Fase 3**: cancellazione
  dati (tenere il cleanup in `deleteMyAccount` fino a lì). **iOS in build
  `2026073001` (2026-07-30). Nota: il modal "Suggerisci" web è già migrato ai
  seguiti (2026-07-30), fuori dalla lista fase-2.**
- **Resubmit App Store 1.5.0: APPROVATA (constatato 2026-07-31).** L'upload
  TestFlight del 31/07 è stato respinto con "previously approved version
  [1.5.0]" / "train closed" = la submission `40e437b0` (build `2026073001`) è
  passata. Rilascio automatico impostato → verificare su ASC che sia live,
  poi blast "aggiorna app" (script `blast-app-update.cjs`, vedi memoria) e
  valutare la rimozione della rule compat watchlist legata alla coorte.
  Storia submission: era stata re-inviata il 2026-07-30 (~15:55) con la build
  `2026073001`. Video demo di Paolo (91s, iPhone fisico: EULA gate → Segnala
  con la push admin visibile → Blocca con rimozione dal feed) ricompresso
  H.264 7MB e caricato come `appStoreReviewAttachment` **via ASC API**
  (`Somto-UGC-demo.mp4` sulle note review — gotcha: le PUT dei chunk sono
  presigned S3, NIENTE header Authorization o danno 400); reply in Resolution
  Center inviata. Rilascio automatico dopo approvazione. Dettagli in
  `docs/ASC-RESUBMIT-1.5.0.md`.
- **Debito i18n web: 933 stringhe in baseline.** Sono wrappate e tradotte, ma non
  esistono nel catalogo iOS: misurano la divergenza di copy fra app e sito (la
  regola "una frase sola per un concetto solo"). Non sono un buco in inglese.
- **Ripubblicazione commenti-episodio TV Time — pipeline LIVE + surfacing fix + revisione admin (2026-07-18, iOS pending TestFlight).** L'import conserva i commenti-episodio e, ora **sempre** (toggle consenso rimosso), scrive candidati in coda `importCommentReview/{uid}__{importId}` (rules admin-read/server-write) → **NIENTE auto-publish**, publish dietro revisione umana. **L1** archivia `episode_comment.csv` in `commentArchive/{uid}/{importId}/` (Storage no-TTL) + summary coda; **L2** scrive candidati risolti per nome serie. Parser `parseTvTimeEpisodeCommentsCsv` (classification standalone/self_thread/reply_other; solo i primi due) + modulo puro `functions/lib/importAdapters/tvTimeCommentsPublish.js` (quality gate no-emoji/1-parola/<8char; NB **NON** filtra @-risposte top-level — se ricapitano aggiungere `text.startsWith("@")`). Solo `bySeriesName` per il match (unresolved contati).
  - **Publish**: callable admin `publishImportComments({uid,importId,approveAll?,commentIds?,dryRun?})` → thread-episodio `public_{titleId}_s{S}e{E}` (`createdAt`=publish time, `lastMessageAt`=**data originale** del commento). Due vie: **pagina admin `/admin-import-comments.html`** (Track B, LIVE: elenca code + contatori, Anteprima dryRun + "Pubblica i risolti") oppure script `functions/scripts/publish-import-comments.js` (`--build`/`--list`/`--publish --approve-all`, dry-run default, idempotente).
  - **Revisione per-commento (2026-07-31, LIVE su prod)**: callable admin `reviewImportComments({uid,importId,commentIds,action:"reject"|"unreject"})` — primo writer di `status:"rejected"` sui candidati (publish callable e script CLI lo saltavano già via `skippedRejected`); dopo la scrittura riconta ESATTI `rejected`/`rejectedResolved` sul doc coda (niente increment). Console aggiornata: checkbox per candidato, "Pubblica selezionati" (usa `commentIds`, che bypassa il gate `status=="approved"` — già supportato dal callable publish), "Scarta selezionati", "Ripristina" sui scartati, pill "scartati", "da pubblicare" = `resolved − published − rejectedResolved`. Rules invariate (deny-all client). SW **v162**. Lo script CLI non ha ancora `--reject` (parità rimandata, la console copre il flusso).
  - **Toggle consenso RIMOSSO** (2026-07-18, meno attrito): `import.page.js` + iOS `TitlesImportView` = nota informativa (no checkbox); `normalizeTitlesImportOptions.importComments` default ON (`!== false`). Disclosure mantenuta; publish resta admin-gated.
  - **Surfacing fix** (2026-07-18): "Discussioni per te" fetchava solo i 40 thread pubblici più recenti per `lastMessageAt` → gli import (data vecchia) non emergevano. Ora fa ANCHE una query sui thread pubblici dei **titoli in libreria** a qualsiasi età: `listPublicThreadsByTitleIDs`/`listPublicThreadsByTitleIds` (`visibility==public && titleId in`), nuovo **indice `threads visibility+titleId`**, merge dedup + cap 2/titolo (`CommunityView`/`community.page.js`). iOS+web.
  - **Deploy 2026-07-18**: `firestore:indexes` + `hosting` (SW v127) + `functions` mirato (`createTitlesImportUploadSession,startTitlesImport,runImportMatchTick`). Commit a56a94a (surfacing) / f637eb5 (toggle) / 8551741 (admin page). **iOS pending prossima build TestFlight** (surfacing + nota).
  - **Stato dati**: **136 commenti backfill LIVE** in 96 thread-episodio (one-off REST sessione prec., 7 utenti). Coda `importCommentReview` attualmente **VUOTA** — i 13 import 15-17/07 non hanno prodotto commenti (export senza `episode_comment.csv`, o import iOS da build pre-1.4.11). Si popolerà coi nuovi import.
- **Taste profile da import — LIVE dal 2026-07-13.** Prima l'import (Netflix/TV Time/Trakt) NON alimentava `users/{uid}/tasteProfile/agg` (solo swipe/voti/onboarding in-app scrivono `signals` → trigger). Fix: modulo condiviso `functions/lib/tasteProfileAggregate.js` (estratta la matematica del trigger `updateTasteProfileOnSignal`); il trigger e `finalizeImportResults` ora lo riusano. L'import fa **un fold in una transazione** su `tasteProfile/agg` (no fan-out segnali): voto reale dove c'è, altrimenti `import_seen` (positivo debole) → i visti spostano davvero i suggerimenti. `confidenceScore` resa **cumulativa** (era sovrascritta col peso del singolo segnale — bug latente). Bucket potati (cap) per non sforare il limite doc. Deploy mirato fatto: `functions:runImportMatchTick,updateTasteProfileOnSignal,backfillTasteSignals`. **Backfill una-tantum ESEGUITO** su prod il 2026-07-13 (`functions/scripts/backfill-import-taste.js --all --write`): 112/251 utenti popolati dai `library`+`ratings`, idempotente via marker `tasteBackfill` su `tasteProfile/agg` (un re-run li salta; `--force` per rifare). Unit test `functions/test/unit/tasteProfileAggregate.test.cjs` (16). Nota: la coppia `signals`→`tasteProfile` in-app resta la fonte "viva"; l'import ora è un fold diretto equivalente.
- Rewatch per-titolo non tracciato (solo globale `stats.rewatchCount`): per badge "↺N" per titolo servirebbe campo su `titleStates` + trigger incrementale + UI "segna rewatch".
- Review manuale domande quiz `confidence: medium` (16) + `spoilerLevel: heavy` (101) prima di flip a `approved`
- **Guest play iOS** — il quiz da ospite è solo web (`quiz-prova.html`). Su iOS serve allentare il gate globale `RootView.requiresAuthentication` + sessione guest in `SessionStore` + adattare `QuizPlayViewModel.finish`/`QuizRepository` → release iOS. La ricerca temi va replicata in `QuizGameSetupView` leggendo `quizMeta`.
- **Guest quiz anti-abuso** — `getGuestQuiz`/`submitGuestQuiz` callable NON autenticate (App Check off). Scraping del pool mitigato (answer-key non esposto, cap 10/call) ma senza rate-limit. Valutare App Check / rate-limit per IP.
- **Audit quiz next50** (`quiz_beta/AUDIT-NEXT50-REPORT.md`, 2026-06-17): 2500 domande fact-checkate, 1 answer-key corretto, 19 flaggate (`status:flagged`, fuori dal pool, con `auditNote`/`auditFix` — da riscrivere/eliminare). Backlog 86 minori (explanation/spoiler-label/distrattori, non risposte sbagliate).
- Quiz invito esterno — XP bonus vittoria/pareggio non assegnato a chi finisce per primo (l'avversario è ancora ignoto); edge minore, XP solo cosmetico
- `QuizInviteOnboardingView` — se l'invitato torna nel player a sfida già completata la schermata resta su "Preparo la sfida…" (edge minore, basta Chiudi)
- `importTMDBTitle` (iOS client-side) non controlla `mergedTmdbIds`: un import
  manuale via ricerca di un id TMDB già accorpato (es. 308014) potrebbe
  ricreare uno stub `tmdb_*`. Chiusura completa = modifica iOS + release.
  **Nota 2026-08-11: questa riga diceva "solo admin", ed era stale.** Il gate
  è `permissions.canAutoApproveTitles` (`TitleRepository.swift:1077`), che
  `AppUser.permissions` mette a `true` per **ogni** utente loggato
  (`AppUser.swift:92`), in linea con le rules (`titles.create` a `isSignedIn()`,
  `firestore.rules:1295`). Quindi non richiede azione admin: lo fa chiunque
  aggiunga un titolo dalla ricerca — e ora anche dall'App Intent "Aggiungi a
  watchlist", che passa dallo stesso `resolveTMDBSearchResult`.
- Blog / pagine SEO — ritocchi di formattazione da fare (segnalati dall'utente 2026-05-19): l'header del blog è allineato a sinistra invece che centrato come il resto del sito; il logo Somto nel chrome è troppo piccolo. Da sistemare.
- `ratingAggregate.combined` — modello "ogni voto pesa 1". Una vera media-di-medie-per-utente (peso uguale a chi vota stagioni separate vs chi vota solo il titolo) richiede una sub-map `seasonUsers` per `{uid → media-stagioni-utente}` e una query secondaria. Da valutare se il modello attuale genera squilibri reali su catalogo (probabile NO finché i voti per stagione restano una minoranza).
- Composer rating su livello `episode` ha API e rule pronte, ma la UI iOS resta sullo "star picker" senza testo/photo/condivisione. Da aggiungere quando esistono use case concreti (oggi il volume di rating per episodio è marginale).
- Migrazione bulk per power user: oggi "Sposta su Stagione N" è 1-tap per il singolo voto title-level. Per utenti con molti voti, una rotta admin/self callable che migra tutti i title-level di una serie in un sweep aiuterebbe — non urgente.
- **Profili guidati** — implementati ma **feature spenta** (`enableGuidedProfiles:false`). Per attivare: deploy functions+rules, `node scripts/create-guided-profiles.js --write`, poi `setGuidedProfilesConfig({enableGuidedProfiles:true})`. Verifica visiva PWA del badge/disclosure richiede login + un profilo guidato esistente (pagine dietro auth). LLM non integrato: contenuti da template (predisposto via env, nessuna chiave). Human review default off (template pre-vagliati).

- **Sistema editoriale: TUTTO LIVE dal 2026-07-12** (rules+functions+hosting deployati, SW v109). Console: `/admin-official-updates.html`. Primo publish reale ancora mai fatto: usare l'audience di test (proprio uid) per la prova — runbook in `docs/EDITORIAL_SYSTEM.md`.
- **PWA→Android**: manca solo `public/.well-known/assetlinks.json` (fingerprint da PWABuilder) + screenshot nel manifest. Procedura completa in `docs/ANDROID_PWA_RELEASE.md`.
- **Staging**: Email/password e account QA configurati fuori dal repository. Aperto: Google provider opzionale.
- **Migrazione functions gen1→gen2**: i trigger Firestore gen1 non sono più creabili su progetti Firebase nuovi (constatato su somto-staging: "region eur3-europe-west1 not supported") — **confermato ora anche su prod** (2026-07-25, feature voti personaggi): i trigger gen1 **nuovi** non sono creabili (quelli **esistenti** continuano a funzionare senza problemi); un deploy gen1 fallito lascia uno stub col nome occupato che va rimosso a mano prima di poter creare il gen2. I **primi 2 trigger gen2** del progetto esistono già (`functions/lib/characterVoteAggregate.js`, region `europe-west1`) e fanno da modello; la migrazione dei trigger gen1 restanti (firebase-functions v2 API) resta debito aperto — finché non si fa, si testano SOLO in emulatore.
- **Play Console**: account developer da creare a mano dal proprietario (fee 25$ una tantum) — procedura completa in `docs/ANDROID_PWA_RELEASE.md`.
- **Copertura push: 86% degli utenti non è raggiungibile (aperto, 2026-08-03).**
  50 utenti su 361 hanno almeno un token FCM, tutti iOS, zero web. Senza token
  la push muore in `pushOnNotificationCreate` e resta solo la campanella: è
  questo, non la logica delle notifiche, il motivo per cui "molti non ricevono
  niente". I due bug silenziosi (rule di update che negava il refresh, web che
  registrava solo al click sul banner) sono **fixati e deployati**; resta il
  pezzo di prodotto: la maggioranza non ha **mai** concesso il permesso. Da
  decidere quando e come chiederlo (momento nel flusso, motivazione mostrata,
  recupero di chi ha già negato — sul web un `denied` non è più
  ri-promptabile). Misura di partenza e forensica in
  `docs/context/NOTIFICATIONS.md`; il numero da rimisurare è "utenti con
  almeno un token / utenti totali".
- **iOS: fix token push non ancora nella coorte (2026-08-03).** `saveToken`
  non riscrive più `createdAt` a ogni refresh: è su `main` ma **non** nella
  1.6.0, che è già live su App Store, quindi entra nella build successiva. Nel
  frattempo la rule tollerante copre anche le build vecchie, che continuano a
  mandare `createdAt` a ogni refresh. **Da verificare**: che `updatedAt` sui
  doc token ricominci davvero a muoversi (è il segnale di device vivo che
  `reportPushCoverage` conta come `freshTokens`); al 3/08 il token dell'admin
  era ancora fermo al 22 marzo perché l'app non era stata riaperta dopo il
  deploy delle rules.
- **Commenti come post nel feed: web fatto, iOS da fare (2026-08-05).** I
  messaggi dei thread pubblici diventano post-eco in `posts`
  (`visibility:"comment"`) e compaiono nel feed Community **solo sul web**, con
  gate anti-spoiler per progresso. Su iOS gli eco sono volutamente invisibili
  (`PostsRepository.listPublicPostsPage` filtra `visibility == "public"`):
  portare card + gate su `CommunityView` prima di dire che la feature è
  completa. Da fare nella fase iOS: (a) query sulla visibilità `comment`,
  (b) porting di `spoilerProgress.js` in Swift con la stessa regola,
  (c) risposta inline che scrive nel thread, (d) cap "Discussioni per te"
  3 → 1 (`CommunityDiscussionsRanking.cap`), (e) rimozione delle card
  "ha scritto nel thread" come sul web (mostravano il commento in chiaro).
  Dettagli in `docs/context/SOCIAL_MODERATION.md`.
- **Backfill eco commenti storici: da lanciare in prod dopo il deploy
  functions.** `node functions/scripts/backfill-comment-echo-posts.js` (dry-run)
  poi `--write`. Idempotente; le date restano quelle originali.

- **Preferenze locali: tre pattern per la stessa cosa (nota 2026-08-09, non urgente).**
  3 `@AppStorage` contro 31 usi diretti di `UserDefaults`, e la divisione non
  segue una regola: dipende da chi ha scritto quel pezzo. Nessun impatto utente,
  ma chi tocca uno di quei file copia la forma accanto — è così che sono nate le
  varianti. Regola proposta quando si passa di lì:
  - View che deve **reagire** a una preferenza → `@AppStorage`
  - logica con regole (scadenze, dismissal condizionali) → servizio con
    `UserDefaults` **iniettato**, come `MatchHintService` — l'unico dei tre
    pattern che sia testabile
  - repository → `UserDefaults` diretto, ma iniettato
  Caso storto noto: `HomeView:80` legge in `@State` all'init e poi scrive a
  mano, quindi non si sincronizza se il valore cambia altrove.
