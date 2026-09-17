# Notifiche — mappa e trappole

Leggi questo file quando tocchi campanella in-app, push, preferenze notifiche
o gli aggiornamenti titolo (`title_update`).

## Catena, in ordine

1. **Un trigger scrive un doc** in `users/{uid}/notifications/{id}`
   (`functions/modules/notifications.js`, più `createTitlesImportNotification`
   in `functions/index.js` e il fanout aggiornamenti titolo in
   `functions/lib/titleUpdateNotifications.js`). Questa è la campanella:
   funziona anche senza push, e i client la leggono in realtime.
2. **`pushOnNotificationCreate`** (gen1, europe-west1) reagisce alla creazione
   del doc e manda la push. In ordine controlla:
   - `users/{uid}/_system/notificationPrefs.disabledTypes` (opt-out per tipo);
   - i token in `users/{uid}/notificationTokens` — **se non ce ne sono, la
     push muore qui** e resta solo la campanella;
   - cooldown per tipo in `users/{uid}/_system/pushCooldown_{type}`
     (tabella in `getPushCooldownMs`: 18-60s sul sociale, 1h su
     `title_update`/`official_update`/`new_season_available`, 24h sugli
     engagement). Dal 2026-09-10 viene **dopo** i token: prima si prenotava la
     finestra anche per chi non poteva ricevere niente. Sempre dal 2026-09-10,
     sulle uscite (`title_update`, `official_update`, `new_season_available`)
     la finestra e' **per titolo** (`pushCooldownScope`, mappa `byScope` nel
     doc di cooldown): due titoli diversi nella stessa ora arrivano entrambi,
     lo stesso titolo no. Il volume lo tengono i tetti dei fanout (3 al giorno
     sugli aggiornamenti titolo). Un'uscita senza `titleId` resta nella
     finestra del tipo;
   - `admin.messaging().sendEach`, con pulizia dei soli token **morti**
     (`lib/pushDelivery.js` → `isDeadTokenError`: `invalid-argument` conta solo
     se il messaggio parla del token, perche' FCM usa lo stesso codice anche
     per un payload malformato, e li' il device e' sano).

   A ogni uscita scrive l'esito sul doc notifica, campo **`pushDelivery`**
   (`status`: `delivered` | `failed` | `no_token` | `cooldown` | `prefs_off`,
   piu' `tokens`, `success`, `failure`, `deadTokens`, `errorCodes` con i soli
   rifiuti che non sono token morti, `at`). Scritto con `update()`: una
   notifica gia' cancellata dall'utente non rinasce. Il client non puo'
   toccarlo (rule sull'update delle notifiche, test in `rules.spec.cjs`).
3. **Client**: iOS `PushNotificationsCoordinator` + `SomtoAppDelegate`; web
   `public/js/pushTokens.js` (registrazione) e `public/service-worker.js`
   (`onBackgroundMessage`).

### Misura ricorrente

`reportPushCoverage` (schedulata, lunedì 9:00 Europe/Rome) calcola la copertura,
la salva in `systemJobs/pushCoverage` (`last` + `history`, ultime 12 settimane) e
manda agli admin una notifica `push_coverage_report` con il confronto rispetto
alla settimana prima. Stesso calcolo a mano, quando serve:

```
node functions/scripts/push-coverage-report.js [--json] [--history]
```

Guarda **due** numeri, non uno: la copertura sul totale utenti e quella sui soli
attivi degli ultimi 7 giorni. Il 2026-08-03 erano 50/328 (15,2%) e 26/65 (40%):
gran parte degli irraggiungibili è gente che non torna, non gente che ha detto
di no.

`reportOfficialSourceCoverage` (ogni giorno, 10:15 Europe/Rome) manda agli
admin `official_source_report` quando l'acquisizione Disney/Hulu ha bozze da
rivedere, annunci senza match, errori fonte o segnali TMDB deboli. La CTA apre
`/admin-official-updates.html`; `data.message` contiene il riepilogo usato sia
dalla campanella sia dalla push. È un avviso editoriale interno, non viene mai
inviato agli utenti interessati al titolo.

### Guardia giornaliera (dal 2026-09-10)

`checkNotificationHealth` (ogni giorno alle 11:30 Europe/Rome,
`modules/notificationHealth.js`, logica pura in `lib/notificationHealth.js`)
confronta le cose che devono andare insieme e avvisa gli admin con una
notifica `notification_health_alert`: campanella, push e un `logger.error` che
resta nei log anche quando la cosa rotta e' proprio la push.

| allarme | quando |
| --- | --- |
| `push_trigger_silent` | almeno 3 notifiche (e il 10%) delle ultime 24 ore ancora senza `pushDelivery` dopo 15 minuti: il trigger della push non le ha processate |
| `delivery_broken` | almeno 5 tentativi verso chi ha un token e nessuna consegna (chiave APNs scaduta, credenziali FCM) |
| `fcm_errors` | almeno 3 rifiuti FCM che non sono token morti |
| `token_drop` | token calati del 20% (e di almeno 3) dal giro prima |
| `social_silent_*` | nelle ultime 72 ore interazioni sopra soglia e zero notifiche del tipo giusto: follow ≥3, like ≥3, commenti ≥3, messaggi ≥8 (molti thread non hanno altri partecipanti) |
| `release_silent` | 72 ore senza nessuna notifica di uscite |

Un allarme nuovo parte subito, uno che dura si ricorda ogni 3 giorni, e quando
rientra arriva una sola notifica "di nuovo regolare". Stato e storico (30 giri)
in `systemJobs/notificationHealth`. Le interazioni si contano con query
collection-group su `createdAt` di `followers`, `messages`, `comments` (senza
la coda `importCommentReview`) e `likes`: indici in `firestore.indexes.json`.
La stessa misura a mano, senza scrivere niente:

```
cd functions && GCLOUD_PROJECT=gia-visto node scripts/notification-health-report.js [--json]
```

### Forensica rapida

- **Dal 2026-09-10 la risposta sta sul doc**:
  `users/{uid}/notifications/{id}.pushDelivery.status`. `delivered` = almeno
  un device l'ha accettata, `no_token` = solo campanella, `cooldown` =
  raggiungibile ma trattenuta dal cooldown del tipo. Le notifiche piu' vecchie
  non hanno il campo: per quelle vale ancora il metodo qui sotto.
- `users/{uid}/_system/pushCooldown_{type}` ha **due scritture diverse**, e
  confonderle porta a conclusioni sbagliate (correzione 2026-08-26: qui c'era
  scritto che il doc nasce solo dopo una push riuscita — non è vero).
  - `acquirePushCooldownWindow` scrive `lastPushAt` quando **prenota** la
    finestra, cioè *prima* di sapere se esistono token e se l'invio è andato.
    Un doc con il solo `lastPushAt` significa "ci abbiamo provato", non
    "è arrivata".
  - Il blocco `successCount > 0` aggiunge `type` e `updatedAt` **solo quando
    almeno un device ha ricevuto davvero**.

  Quindi la domanda "gli è arrivata?" si risponde confrontando le due date:
  `updatedAt` allineato a `lastPushAt` = consegnata; `updatedAt` più vecchio (o
  assente) = solo campanella. Attenzione al `merge: true`: `type` e `updatedAt`
  di una consegna vecchia **restano lì** anche quando il tentativo di oggi non
  consegna niente, quindi la loro presenza da sola non prova nulla.
  Misura reale del 2026-08-26 (annuncio *Mousetrap*, 10 destinatari):
  10 campanelle, **4 push consegnate**.
- `firebase functions:log --only pushOnNotificationCreate` mostra
  `[push] Results: success=N failure=M` e il motivo di ogni skip.
- Push di prova a un utente: `node functions/scripts/test-push.js --uid <UID>`.

## Copertura push (il numero che conta)

Misurata il 2026-08-03: **50 utenti su 361 (13,9%) avevano almeno un token**,
51 token in tutto, **tutti iOS, zero web**. Tutto il resto della catena
funzionava: il collo di bottiglia delle notifiche non è la logica, è quanti
device sono raggiungibili. Prima di indagare "perché non arriva X", conta i
token.

Cause storiche del buco, entrambe corrette il 2026-08-03:

- **Rules**: `notificationTokens` accettava l'update solo con `createdAt`
  identico all'originale, ma i client rimandano tutto il payload con
  `createdAt: serverTimestamp()`. Ogni refresh finiva in permission-denied,
  inghiottito dal `catch` del client → i doc token restavano congelati alla
  data di installazione e `updatedAt` non distingueva più un device vivo da un
  fantasma. Vedi anche la trappola `request.time` in `docs/SECURITY.md`.
- **Web**: il token si registrava **solo** al click sul banner, e il banner non
  ricompare una volta concesso il permesso (`Notification.permission !==
  "default"` → il banner non monta). Chi cambiava browser, puliva i dati o
  perdeva il token restava senza push per sempre. Ora `appShell.js`
  ri-registra a ogni sessione quando il permesso è già `granted`.

Resta aperto il pezzo di prodotto: la maggioranza degli utenti non ha **mai**
concesso il permesso. Vedi `docs/PENDING.md`.

### Misura del 2026-09-10: dove si perdono le push

30 giorni di log di `pushOnNotificationCreate` (5.992 tentativi) incrociati
con Firestore. Copertura quel giorno: 47 utenti su 372 con un token (13 dei 32
attivi della settimana), 43 iOS e 4 web.

| esito | tentativi |
| --- | --- |
| nessun token | 4.375 (73%) |
| consegnata | 992 |
| trattenuta dal cooldown | 603 (392 sono promemoria watchlist, per scelta) |
| fallita | 7, tutte token morti (app disinstallata) |

- La catena lato server era sana: 32 follow → 32 notifiche, 65 messaggi → 48
  (gli altri senza destinatari), commenti e like idem, zero crash del trigger.
  Zero like ai post nel mese: non un trigger rotto, nessuno ne aveva messi.
- Chi ha un token riceve: 31 push sociali su 34, 304 uscite su 378.
- Il singhiozzo di chi le push le riceve e' il **cooldown per tipo sulle
  uscite**: 51 delle 378 (13,5%) trattenute, quasi tutte fra le 9 e le 10,
  quando partono insieme episodi del giorno e post ufficiali. Il secondo
  aggiornamento della mattina restava solo in campanella. Dallo stesso giorno
  la finestra sulle uscite e' per titolo (vedi la catena, sopra).
- Buco trovato: i like ai commenti sotto un voto
  (`ratingFeed/*/comments/*/likes`) non avevano nessun trigger. Ora c'e'
  `notifyOnRatingCommentLike` (gen2, id notifica deterministico).

### Quando chiediamo il permesso

Il permesso si chiede dove il valore è appena stato consegnato, non a freddo.

- **iOS** (`PushPromptService`): pre-prompt one-shot post-onboarding e
  post-import, più il banner Home che ritorna dopo 14 giorni. È il motivo per
  cui tutti i token esistenti sono iOS.
- **Web** (`mountNotificationPermissionBanner`): banner generico con TTL di 14
  giorni su home, account, thread, community, import e notifiche; più due
  prompt contestuali `trigger` — `post_import` (riepilogo finale dell'import) e
  `post_rating` (dopo un voto) — che ignorano il TTL ma si mostrano **una volta
  sola per innesco** (`notifyPrompt_v1_{trigger}` in localStorage).

Su iOS Safari senza PWA installata il banner non propone l'attivazione (non
funzionerebbe): mostra il link all'App Store.

## Aggiornamenti titolo (`title_update`)

Pipeline: `scanTitleUpdates` (schedulata) → `titleUpdateEvents/{eventId}` →
`notifyOnTitleUpdatePublished` → `fanOutTitleUpdate` → doc notifica per utente.

Il fanout notifica chi ha il titolo in libreria/watchlist
(`titleStateEligibleForUpdate`) oppure una preferenza esplicita in
`users/{uid}/titleUpdatePrefs/{titleId}` (`follow` / `important` / `muted`).
Cap: 500 destinatari per evento, 3 notifiche al giorno per utente.

### Dove porta il tap (2026-08-20)

Se l'uscita ha gia' il suo post commentabile (`official_uscita-{eventId}`,
creato da `publishReleaseConversationPosts`), la notifica porta **al post**:
`/community.html?post=...` sul web, navigazione per `postId` su iOS. Senza post
si resta sulla scheda titolo con `focus=updates`, come prima.

Il motivo e' misurato: 42 post ufficiali in un mese avevano prodotto 2
commenti. La scheda titolo dice "e' uscito"; il post e' l'unico posto dove si
puo' rispondere a qualcuno. `titleUpdatePresentation` accetta solo queste due
destinazioni: la `ctaUrl` arriva da un doc, e senza allowlist basterebbe
scriverci dentro un'altra pagina per dirottare il tap.

### Rilevanza: chi merita uno dei 3 slot

I 3 slot giornalieri andavano a chi arrivava primo, quindi un teaser di un film
già visto bruciava lo slot che sarebbe servito alla nuova stagione della serie
in corso. `titleUpdateRelevance(stateData, event, mode)` pesa **evento ×
rapporto di quella persona con quel titolo**:

| | serie in corso | watchlist | già visto / finito |
| --- | --- | --- | --- |
| nuovo episodio, nuova stagione, rinnovo, cancellazione | **alta** | media | media |
| data di uscita | media | media | **nessuna notifica** |
| trailer, teaser | media | media | **nessuna notifica** |

Un `follow` o `important` esplicito è sempre alta: è una richiesta diretta, non
la declassiamo. La rilevanza "bassa" non notifica affatto — la novità resta
comunque nella timeline del titolo. Una rilevanza media non può consumare
l'ultimo slot del giorno (`MEDIUM_RELEVANCE_CAP_MARGIN`), così resta posto per
una notizia forte che arrivi più tardi.

Un evento notifica **solo se** `status: "published"`, `acquisitionMode: "live"`
e `notificationEligible: true`. Due regole da tenere a mente:

- **La prima scansione di un titolo è backfill, tranne per il futuro.** Alla
  prima passata TMDB ci restituisce tutto lo storico e non sapremmo distinguere
  una novità; il marcatore `titleProviders/{titleId}.titleUpdateScanAtMs` dice
  che quel titolo è già stato visto, e dalla scansione successiva si passa a
  live. **Eccezione dal 2026-08-26** (`splitFutureCandidates`): un candidato con
  data ancora da venire non *può* essere storia, quindi nasce live già al primo
  scan. Senza, un titolo che entra in catalogo poco prima della sua uscita non
  notifica mai nessuno: l'episodio 1 viene scoperto al primo scan, nasce
  backfill e `mergeExistingEvent` lo tiene non notificabile per sempre — cioè
  proprio le uscite che vogliamo annunciare. Il confronto è per giorno di
  calendario a Roma: un episodio che esce oggi non è "futuro".
- **Un evento nato backfill resta non notificabile per sempre**
  (`mergeExistingEvent`), anche quando lo scanner live lo reincontra.

### Cadenza e finestra devono restare accoppiate

Lo scanner scorre il catalogo a cursore (`systemJobs/titleUpdateScanner`):
`SCANNER_BATCH_SIZE` titoli per run. Con ~20k titoli, 30 titoli ogni 5 minuti
= giro completo in ~2,5 giorni. La finestra live (`SCANNER_LOOKBACK_MS`, 5
giorni) **deve restare più larga del giro completo**: un trailer uscito subito
dopo il passaggio dello scanner viene visto solo al giro dopo, e se nel
frattempo è uscito dalla finestra viene scartato e non diventa mai un evento.
Se cambi uno dei due valori, ricontrolla l'altro.

### Corsia prioritaria (dal 2026-09-02)

Oltre ai 30 titoli del giro tondo, ogni run ne scansiona `PRIORITY_BATCH_SIZE`
(6) presi fra quelli **con un'uscita gia' nota nei prossimi 150 giorni**
(`readPriorityTitleIds`, query su `titleUpdateEvents` per `release_date` e
`new_episode`, indice `eventType+status+effectiveAt` gia' esistente). Cursore
separato (`priorityCursorMs`, la data dell'ultimo evento guardato) che si
azzera quando la finestra finisce. Con ~300 titoli in finestra il ripasso e'
ogni ~4 ore invece di 2,5 giorni; sotto l'ora non ha senso, la cache TMDB ha
TTL 3600s.

Lo stesso giro aggiorna `titles.trailerUrl` quando scopre un video piu' recente
(`pickTrailerRefreshes`, `trailerSource: "title_update_event"`):
`enrichTitleAssets` scrive quel campo **solo se vuoto**, quindi senza questo
ogni scheda resta per sempre al primo trailer che avevamo visto.

Per forzare un singolo titolo senza aspettare il giro:
`node functions/scripts/rescan-titles.cjs --project gia-visto --title-id <id>`
(stessa pipeline dello scheduler, non tocca il cursore).

### Incidente 2026-09-02 (teaser Harry Potter)

Il teaser della serie esce alle 17:00, TMDB lo indicizza subito, noi avevamo
scansionato quel titolo il giorno prima: il cursore ci sarebbe tornato 15 ore
dopo. In piu' i canali YouTube coperti erano 6 e **HBO Max non c'era**, quindi
anche la strada veloce era cieca. Da qui la corsia prioritaria e i due canali
nuovi (`hbomax_it`, `warnerbros_it`).

Attenzione al riflesso: quei canali chiamano le opere nuove come le vecchie
("HARRY POTTER E LA PIETRA FILOSOFALE" e' il teaser della serie 2026, ma in
catalogo quel nome esatto ce l'ha il film del 2001, da solo). Un match esatto
su un titolo piu' vecchio di 3 anni ora non entra in scheda da solo:
`titleTooOldForNewTrailer` lo manda in coda di revisione.

### Incidente 2026-08-02/03

La feature è nata con il gate backfill/live **globale**: live solo dopo che lo
scanner aveva passato l'intero catalogo una volta. Al ritmo di allora (12
titoli ogni 15 minuti) servivano 17 giorni, e ogni evento scoperto nel
frattempo nasceva backfill, cioè bruciato per sempre. Risultato: 341 eventi,
333 pubblicati, **0 notificabili, 0 notifiche inviate**. In più la finestra
live era 72h contro un giro da ~18 giorni, quindi anche dopo lo sblocco l'~83%
dei trailer sarebbe stato scartato per "troppo vecchio".

Fix: gate per titolo, giro a ~2,5 giorni, finestra a 5 giorni, marcatore
seminato sui 1.090 titoli già scansionati
(`functions/scripts/seed-title-update-scan-marks.js`).

### Indice che serve

`titleUpdatePrefs.titleId` in **collection-group**. Mancava, la query nel
fanout falliva e un `catch` muto la degradava a lista vuota: i "muto" per
titolo sarebbero stati ignorati. Ora l'errore viene loggato invece che
inghiottito — se lo vedi nei log, manca l'indice.

### Gli episodi si notificano il giorno in cui escono

Pipeline normale: evento pubblicato → `notifyOnTitleUpdatePublished` → fanout
subito. Per `new_episode` **no**: se l'episodio è di un giorno futuro
(`titleUpdateWaitsForAirDate`, confronto per giorno di calendario a Roma) il
trigger non notifica nessuno, e ci pensa la sweep giornaliera
**`notifyDueTitleUpdates`** (9:00 Europe/Rome, `fanOutDueTitleUpdates`).

Il motivo: TMDB sposta `next_episode_to_air` sull'episodio successivo **appena
il precedente va in onda**. Notificando alla scoperta, su ogni serie settimanale
la notifica partiva un giorno dopo l'uscita dell'episodio che stavi per
guardare, per annunciarne uno a 5-6 giorni di distanza (incidente Ted Lasso
S4E3, 13-08-2026).

**Grazia e tetto vanno insieme**: in prod escono 20-50 eventi `new_episode` al
giorno (soap e daily comprese) e la query è ordinata per data crescente, quindi
una grazia larga con un tetto basso riempie il tetto con ieri e non arriva a
oggi. Oggi: grazia 1 giorno, tetto 200, e il report logga `capReached`.
L'arretrato del vecchio comportamento è stato marcato una volta con
`functions/scripts/seed-title-update-notified-marks.js` (308 eventi il
2026-08-13).

La sweep guarda gli eventi `new_episode` pubblicati con `effectiveAt` fra
`now - 1 giorno` e `now + 1 giorno`, scarta quelli di domani e quelli già fatti
(marcatore `notifiedAtMs` sull'evento, scritto in merge: lo scanner non lo
tocca) e per gli altri chiama lo stesso `fanOutTitleUpdate` del trigger. Due
livelli di idempotenza: il marcatore e l'id notifica deterministico
`title_update_{eventId}`. Indice già presente: `eventType + status +
effectiveAt`.

### Dal 2026-08-25 gli episodi vanno nel digest, le premiere no

La sweep per episodio e' spenta (`TITLE_UPDATE_DUE_SWEEP_ENABLED` assente) e
gli episodi viaggiano nel digest del giovedi'. **Eccezione dal 2026-09-10:
l'episodio 1 di una stagione** (`isSeasonPremiere`). E' l'uscita, non un
appuntamento: il trigger lo lascia passare come gli altri eventi e, se e' di
un giorno futuro, lo manda la sweep delle 9 il giorno giusto
(`fanOutDueTitleUpdates({ premieresOnly: true })`, indice `eventType + status +
episode + effectiveAt`). Il job
`firebase-schedule-notifyDueTitleUpdates-europe-west1` quindi deve restare
ENABLED. Il digest non la ripete: salta gli eventi che hanno gia' la loro
notifica `title_update_{eventId}`. Cosa l'ha fatto decidere: 37 premiere
notificabili in 30 giorni erano arrivate solo nel digest, mentre il commento
nel trigger diceva che le nuove stagioni restavano immediate.

### Fanout collegato (saga)

Ogni evento porta anche `linkedTitleIds` (titleId + film approvati della
stessa `titles.collectionId`, cap 12, `writeTitleUpdateEvent` in
`lib/titleUpdateEvents.js`, `resolveLinkedTitleIds`). Dopo aver notificato i
destinatari del titolo primario, `fanOutTitleUpdate` ripete la stessa
scansione (stato + `titleUpdatePrefs` + opt-out globale) per ogni altro id in
`linkedTitleIds`, **solo** se `eventType` è in `LINKED_FANOUT_EVENT_TYPES`
(`trailer`, `teaser`, `release_date` — non `new_episode`: un nuovo episodio
della serie A non è notizia per chi segue la serie B della stessa saga).

Chi è già stato scelto sul titolo primario (o su un altro titolo collegato
scansionato prima) non viene riconteggiato (`seenUids` condiviso fra tutte le
scansioni della stessa run) né ricontato nel tetto giornaliero. La rilevanza
scende di un passo rispetto a quella che avrebbe come destinatario del titolo
primario (`titleUpdateRelevance(..., { linked: true })`,
`high→medium→low→low`) — **tranne** un `follow`/`important` esplicito
sull'altro titolo, che resta alta come sempre. In pratica: oggi solo chi ha
una preferenza esplicita sul titolo collegato riceve la notifica, perché
`medium` degrada a `low` (che non notifica affatto) — voluto, per restare
coerenti con "poche notifiche molto mirate" (vedi memoria
`release_discovery_automation`).

Il doc notifica porta `linkedFromTitleId` (l'id del titolo a cui l'evento si
riferisce davvero — uguale a `data.titleId`, è solo una marca esplicita di
provenienza) e il messaggio aggiunge una frase ("Dalla stessa saga di
{titolo che segui}.") via `buildTitleUpdateMessageByLocale(..., { titleName })`.

## Copy

`buildTitleUpdateMessageByLocale` scrive it/en nel doc notifica. Per
`new_episode` il testo dipende dal **giorno** dell'uscita rispetto a oggi
(Europe/Rome):

| quando | it-IT |
| --- | --- |
| giorno futuro | `Nuovo episodio di Ted Lasso il 18 agosto.` |
| oggi | `Oggi nuovo episodio di Ted Lasso.` |
| già uscito | `È disponibile un nuovo episodio di Ted Lasso.` |

"In arrivo" senza data è stato rimosso: si legge come "è uscito adesso". Il caso
"giorno futuro" ormai capita solo su pubblicazione manuale, perché il resto lo
trattiene la sweep.

Per l'episodio 1 di una stagione dalla seconda in poi il copy dice la
stagione: `Oggi inizia la stagione 2 di Ted Lasso.`, `È iniziata la stagione 2
di Ted Lasso.`, `La stagione 2 di Ted Lasso inizia il 18 settembre.` Una serie
nuova (S1E1) resta sul copy dell'episodio: "uscito/uscita" dipenderebbe dal
titolo.
