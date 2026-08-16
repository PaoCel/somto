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
   - cooldown per tipo in `users/{uid}/_system/pushCooldown_{type}`
     (tabella in `getPushCooldownMs`: 18-60s sul sociale, 1h su
     `title_update`/`official_update`/`new_season_available`, 24h sugli
     engagement);
   - i token in `users/{uid}/notificationTokens` — **se non ce ne sono, la
     push muore qui** e resta solo la campanella;
   - `admin.messaging().sendEach`, con pulizia dei token invalidi.
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

### Forensica rapida

- `users/{uid}/_system/pushCooldown_{type}` viene scritto **solo dopo una push
  riuscita**: la sua assenza dice che quel tipo non è mai arrivato a
  quell'utente, la sua data dice quando è arrivato l'ultima volta. È il modo
  più veloce per distinguere "non gliel'abbiamo mandata" da "non l'ha vista".
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

- **La prima scansione di un titolo è sempre backfill.** Alla prima passata
  TMDB ci restituisce tutto lo storico e non sapremmo distinguere una novità;
  il marcatore `titleProviders/{titleId}.titleUpdateScanAtMs` dice che quel
  titolo è già stato visto, e dalla scansione successiva si passa a live.
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
