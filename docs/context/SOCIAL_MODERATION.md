# Social: anti-spoiler, GIF, profili guidati

Leggi per: gate anti-spoiler, moderazione, picker GIF nei thread, account sintetici guidati, commenti come post nel feed.

## Commenti dei thread come post nel feed (2026-08-05)

Ogni messaggio scritto in un thread pubblico (commento su film / serie /
episodio) genera un **post gemello** in `posts`, così popola il feed Community
senza duplicare card, like, condivisione e deep-link.

- **Modulo puro**: `functions/lib/commentEcho.js` (parse dell'id thread, id
  deterministico `tm_<sha1(threadId::messageId)>`, shape del doc). Unit test:
  `functions/test/unit/comment-echo.test.cjs`.
- **Trigger** (gen2, europe-west1, in `functions/index.js`):
  `onPublicThreadMessageEchoPost` (onCreate) e
  `onPublicThreadMessageEchoPostDeleted` (onDelete, rimuove l'eco).
  Solo thread `public_*`: DM e gruppi non generano mai un eco.
- **Doc**: `visibility: "comment"` (NON `public`) + `sourceKind:"thread_message"`,
  `sourceThreadId`, `sourceMessageId`, `spoilerScope {titleId, level, season,
  episode}`, `skipAutoFeedFanout:true` (niente `feedEvents`, niente notifica
  "ha pubblicato un post"), `createdAt` = data del messaggio originale.
  La visibilità dedicata serve a **non far vedere gli eco ai client vecchi**
  (iOS sullo Store, tab Community del profilo) che non conoscono il gate per
  progresso e li mostrerebbero in chiaro.
- **Rules**: `canReadPost` tratta `comment` come pubblico in lettura per chi è
  loggato; `validPostPayload` non accetta quel valore né i campi `source*`/
  `spoilerScope`, quindi nessun client può forgiarli o stripparli.
- **Feed web** (`community.page.js`): kind `title_comment`, due sorgenti —
  commenti sui titoli in libreria a qualunque età (`listCommentPostsByTitleIds`,
  indice `posts(visibility, titleId, createdAt↓)`) + finestra per recency
  (`listCommentPostsPage`). Cap `COMMENT_ITEMS_CAP` per build. Le vecchie card
  "ha scritto nel thread" sono state rimosse: mostravano lo stesso commento una
  seconda volta e **in chiaro** (`lastMessagePreview`), aggirando il gate.
- **Risposte**: il composer della card scrive nel **thread** (`sendThreadMessage`),
  non nei commenti del post gemello — una sola conversazione per titolo.
- **Backfill**: `functions/scripts/backfill-comment-echo-posts.js` (dry-run di
  default, `--write`, `--thread=`, `--since=`, `--limit=`). Idempotente grazie
  all'id deterministico; mantiene le date originali.
- **Pendente iOS**: card + gate per progresso non ancora portati su iOS (gli
  eco restano invisibili lì finché non arrivano). Cap "Discussioni per te"
  ridotto a 1 sul web, ancora 3 su iOS (`CommunityDiscussionsRanking.cap`).

## Gate anti-spoiler per PROGRESSO (2026-08-05)

Diverso dal gate manuale qui sotto (flag dell'autore): il contenuto porta le
coordinate (`spoilerScope`) e il client le confronta con il progresso reale del
viewer (`users/{uid}/titleStates`). Implementazione web:
`public/js/components/spoilerProgress.js` (riusa il markup `.spoiler-gate` e
`attachSpoilerHandlers`), letture mirate via
`titleStates.api.js#getMyTitleStatesByIds` (chunk da 30, solo i titoli a
schermo).

Regola:
- film → sbloccato se visto (`seen_unrated`/`rated`);
- serie, commento su episodio SxEy → sbloccato se la serie è completata oppure
  se `seriesProgress` è ≥ (stagione, episodio);
- serie, commento di stagione → serve aver superato quella stagione;
- serie, commento a livello titolo → basta aver iniziato la serie;
- titolo non in libreria → **bloccato**;
- commento scritto da te → mai sfocato.

Blocca solo alla vista: niente bottone "Ho visto X" (falsificherebbe la
libreria), si sblocca il singolo contenuto con "Tocca per mostrare". Come il
gate manuale, è **cortesia UX lato client**: il testo resta pubblico in
Firestore.

**Nota su `fetchCompletedTitleIDs`/`listCompletedTitleIDs`**: leggevano
`movieStatus`/`seriesStatus`, che sono proprietà del modello iOS e **non**
campi Firestore (il doc ha solo `state`). Il set usciva sempre vuoto e il gate
manuale non si sbloccava mai. Corretto su web e iOS il 2026-08-05.

## Anti-spoiler adattivo

Modello: ogni doc social (`threads/{tid}/messages/{mid}`, `posts/{id}`, `posts/{id}/comments/{cid}`, `recommendations/{id}`) può avere due campi opzionali:
- `containsSpoiler: bool` (default false) — flag manuale dell'autore via toggle nel composer
- `spoilerTitleIds: [string]` (default [], max 5) — titoli su cui c'è lo spoiler

Viewer logic (gate adattivo): il contenuto è in chiaro solo se `containsSpoiler == false` OPPURE il viewer ha completato TUTTI i titoli in `spoilerTitleIds` (`titleStates[T].state in {seen_unrated, rated, completed_unrated, rated}`). Altrimenti blur + overlay "Tocca per mostrare" con bottoni "Ho visto X" per ogni titolo mancante (tap → callable `applyTitleStateAction` con `mark_movie_seen` / `mark_series_completed`).

Implementazione:
- iOS: `DesignSystem/Components/SpoilerComposerSection.swift` (composer toggle + multi-picker) + `DesignSystem/Components/SpoilerGate.swift` (wrapper di rendering). Cache `SessionStore.completedTitleIDs` aggiornata al boot e su `markTitleCompletedLocally`. Helper `WatchlistRepository.fetchCompletedTitleIDs` + `markTitleCompletedByID`. Modelli `ThreadMessage`, `AppPost`, `PostComment`, `RecommendationItem` hanno i 2 nuovi campi con default `false`/`[]`.
- PWA: `public/js/components/spoilerGate.js` (`wrapSpoiler` + `attachSpoilerHandlers`) + `public/js/components/composerSpoiler.js` (toggle + multi-picker) + `public/js/api/titleStates.api.js#listCompletedTitleIDs/markTitleCompleted` + `public/css/components/spoiler.css`. Wirato su `thread.page.js` (composer + rendering) e `home.page.js` (composer post).
- Firestore rules (`firestore.rules`): helper condiviso `spoilerFieldsOptional()` chiamato in tutti i `valid*Create`/`valid*Payload` (`hasOnly(...)` esteso con `containsSpoiler` + `spoilerTitleIds`). Update di recommendation richiede `recommendationSpoilerFieldsUnchanged()` per evitare che il recipient possa rimuovere il flag.

Auto-checker server-side (`functions/modules/spoilerChecker.js`): regex deterministica con pattern italiani (`muore`, `finale`, `si scopre che`, `plot twist`, ...) + anchor specifici per titolo (`SPOILER_KEYWORDS_BY_TITLE`: `il trono di spade`, `breaking bad`, `lost`, ...). Triggers onCreate in `functions/index.js`:
- `flagSuspectedSpoilerThreadMessage` → `threads/{tid}/messages/{mid}`
- `flagSuspectedSpoilerPost` → `posts/{id}`
- `flagSuspectedSpoilerComment` → `posts/{pid}/comments/{cid}`
- `flagSuspectedSpoilerRecommendation` → `recommendations/{id}`

Se il contenuto NON è flaggato (`containsSpoiler !== true`) e il matcher trova un hit, viene scritto un doc in `moderationQueue` con `type: "spoiler_suspect"`, `status: "pending"`, `preview` (280 char), `matchedPattern` + `matchedText`, `docPath` originale. Rule: `moderationQueue` è read-only per admin, write riservato al server (admin SDK).

Admin review:
- iOS `Features/Admin/AdminSpoilerQueueView.swift` lista i pendenti
- callable `confirmSpoilerSuspect(queueId, decision)` con `decision in ["confirmed", "false_positive"]`. `confirmed` → update del doc originale con `containsSpoiler: true` + `spoilerConfirmedBy: "admin"` (rendering blur si attiva retroattivamente).

Le rules ammettono `containsSpoiler` su update solo se invariato dal valore precedente (su recommendations) o solo via admin SDK (su threads.messages, posts, comments: niente update consentito ai client salvo reactions, che sono ortogonali al flag).

## GIF nei commenti (thread)

Le GIF nei messaggi thread/commenti (inclusi i commenti per-episodio) arrivano da un **picker Giphy**, NON dall'SDK Giphy: i client chiamano un nostro proxy server-side, così serve **una sola API key** (copre iOS+web+Android).

- **Provider/proxy**: callable `gifSearch` in `functions/index.js` (europe-west1, signed-in, rate-limited come tmdbProxy). Chiama l'**API HTTP Giphy** con `GIPHY_API_KEY` (in `functions/.env`, gitignored; caricata anche in prod). Forza **SFW** (`rating=pg`, `bundle=messaging_non_clips`). Request `{action:"search"|"trending", query, limit≤30, offset}` → `{results:[{id,gifUrl,previewUrl,width,height,title}], next}`. `gifUrl`/`previewUrl` normalizzati (query strippata) e filtrati a host `giphy.com`. Key attuale = **beta** (≈1000 ricerche/giorno globali sull'app) → per il lancio richiedere la **Production key** dalla stessa app Giphy (cambia solo il valore di `GIPHY_API_KEY`, niente altro).
- **Modello messaggio**: doc `threads/{tid}/messages/{mid}` può avere `type:"gif"` + `gifUrl` (https su giphy.com). `text` = caption opzionale (può essere ""). 
- **Rules** (`firestore.rules`, testate in `functions/test/rules.spec.cjs`): helper `validGifUrl` (https + host `giphy.com` + ≤500 char); `validThreadMessageCreate` accetta `type ∈ {text, gif}`, `gifUrl` ammesso **solo** con `type:"gif"` e vietato sul testo, `text` non vuoto solo per il testo; `validThreadReactionUpdate` tiene `gifUrl` immutabile. Whitelist host = anti-abuso (no URL arbitrari/tracking pixel).
- **Invio**: **web** scrive diretto (`sendThreadMessage` in `public/js/api/threads.api.js`, coperto dalle rules); **iOS** passa dal callable **`sendThreadMessage`** (admin SDK, in `functions/index.js`) che ora accetta `type:"gif"`+`gifUrl` (valida host, caption opzionale, preview "GIF"). Due path diversi, stesso risultato.
- **Rendering**: web `<img class="msg-gif">` (anima nativo); iOS `AnimatedGIFView` (`DesignSystem/Components/AnimatedGIFView.swift`) via ImageIO `CGAnimateImageDataWithBlock` (**nessuna dipendenza SPM**), rispetta reduce-motion (primo frame statico). In **entrambi** la GIF è dentro lo **[[anti-spoiler-adattivo|SpoilerGate]]** come il testo → una GIF flaggata spoiler si sfoca.
- **Picker UI**: iOS `Features/Threads/GifPickerSheet.swift` (search debounced + grid preview + paginazione); web modal in `thread.page.js` (`openGifPicker`/`searchGifs`). Se `GIPHY_API_KEY` manca → `failed-precondition` gestito con empty state "GIF non disponibili", nessun crash.

## Profili guidati (synthetic guided profiles)

Account interni supervisionati ("Profilo guidato" in UI, **mai** "bot") per popolare/testare l'app. Marcati sintetici ed **esclusi da tutte le metriche reali**.

- **Identita'**: uid sintetici `guided_*`, **nessun account Firebase Auth** (niente inquinamento del conteggio utenti Auth, niente trigger signup reale). Tutta l'attivita' scritta server-side via admin SDK.
- **Schema**: su `users/{uid}` campi server-only `accountType:"guided_profile"` + `isSynthetic:true` + `bio` (disclosure). Doc di controllo `guidedProfiles/{uid}` (persona, `activityLevel` high/medium/low/dormant, `status`, `dailyActions`, flag `excludeFrom*`/`canReceiveDm`). Tutti i contenuti generati portano `isSynthetic:true`.
- **Modulo**: `functions/modules/guidedProfiles/` — `constants.js`, `personas.js` (8 archetipi + name pool), `config.js` (doc `appConfig/guidedProfiles`), `contentGenerator.js` (template bank IT; hook LLM via env `GUIDED_LLM_ENABLED`+secret, **nessuna chiave hardcoded**, fallback template), `activity.js` (routine), `dmResponder.js`, `guards.js`, `index.js` (registrazione CF).
- **Cloud Functions** (europe-west1): `runGuidedProfileActivity` (scheduled 11:00+19:00 Rome), `runGuidedProfileActivityNow` (callable admin, supporta `{dryRun:true}`), `setGuidedProfilesConfig` (callable admin, kill switch), `guidedProfileDmAutoResponder` (trigger DM auto-reply).
- **Config** `appConfig/guidedProfiles` (deny-all client): `enableGuidedProfiles` (default **false**), `guidedProfilesMode` (off|staging_only|private_test|public_guided, default public_guided), `requireHumanReview`, `maxActionsPerRun`, `maxActionsPerProfilePerDay`, `allowedActionTypes`, `dryRun`, `killSwitch`, `testAccountUids`. Fan-out feed: private_test→solo admin/test, public_guided→follower del profilo.
- **Esclusione metriche** (guard): `recomputeTitleRatingAggregate` salta i rating `isSynthetic` (voto pubblico titoli NON inquinato), `computeGlobalLeaderboard` filtra i guided, `notifyAdminOnUserSignup` salta i guided.
- **DM**: utente reale scrive a un guidato → 1 auto-reply canned (disclosure) una volta, thread `guidedLocked`, log in `guidedDmAttempts`. I guidati non aprono mai DM verso reali.
- **Human review**: con `requireHumanReview` i contenuti testuali vanno in `guidedContentDrafts` (draft|approved|rejected|published); pubblicazione via `scripts/approve-guided-content.js`.
- **Script** (admin SDK, dry-run default): `functions/scripts/create-guided-profiles.js [--write] [--count=N]`, `functions/scripts/approve-guided-content.js [--approve|--reject]`.
- **Dry-run routine**: `node -e` su `runGuidedActivity({dryRunOverride:true})` o callable `runGuidedProfileActivityNow({dryRun:true})` → ZERO scritture (garantito da unit test).
- **UI disclosure**: iOS `AppUser.isGuidedProfile` + chip "Profilo guidato" + card bio (UserProfileDetailView) + banner DM (ThreadDetailView). PWA badge+disclosure (`user.page.js`) + banner DM (`thread.page.js`), CSS `social.css`.
- **Test**: `functions/test/unit/guided-profiles.test.cjs` (13) + casi in `rules.spec.cjs` (deny-all + campi server-only).
- **Rules nuove**: `appConfig`/`guidedProfiles`/`guidedContentDrafts`/`guidedProfileRuns`/`guidedDmAttempts` = read admin / write server-only; `users` create/update bloccano `accountType`/`isSynthetic`/`bio` lato client (`guidedFieldsRealOnCreate`/`guidedFieldsUnchanged`).

**Per attivare**: deploy functions+rules → `node scripts/create-guided-profiles.js --write` → `setGuidedProfilesConfig({enableGuidedProfiles:true})`. **Kill switch**: `setGuidedProfilesConfig({killSwitch:true})`. Default attuale = spento.
