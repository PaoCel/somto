# Runbook — Somto

Operazioni ricorrenti e incident response su prod (`gia-visto`). Per il flusso di rilascio vedi
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Regola d'oro: prod può divergere dal repo

**Prima di diagnosticare qualunque bug di comportamento/permessi in produzione, verificare che ciò che è
live sia davvero quello che c'è in `main`.** Non dedurlo dai commit o da `CLAUDE.md`: un deploy manuale dal
working tree (senza commit) può aver spedito qualcosa di diverso da HEAD. È già successo — rules hardening
deployate da tree non committato il 2026-07-02 hanno rotto la creazione liste per gli utenti iOS già in
produzione, scoperto solo giorni dopo da segnalazioni utente. La procedura sotto ("Verifica stato prod") è
quella usata con successo per accertare byte-per-byte cosa gira live.

## Verifica stato prod

### Service worker (hosting)

```bash
curl -s https://somto.it/service-worker.js | grep 'const VERSION'
grep -n 'const VERSION' public/service-worker.js
```

Se le due `VERSION` non coincidono, l'hosting live non riflette `main` — non fidarsi del comportamento web
osservato finché non si ridistribuisce hosting o si capisce cosa è stato spedito.

### Monitor automatico web

`npm run smoke:prod` controlla gli endpoint critici, gli header di sicurezza e scarica da
`somto.it` il grafo ES module delle pagine principali, validandolo con esbuild. Cattura quindi anche
gli import di export inesistenti che il 2026-08-22 lasciarono la PWA nel loader infinito.

Lo stesso comando gira:

- alla fine di ogni comando canonico di deploy hosting;
- ogni ora in `.github/workflows/production-monitor.yml`;
- manualmente da GitHub Actions (`workflow_dispatch`) o dalla root del repo.

Se il job fallisce apre o aggiorna una sola issue privata assegnata al proprietario del repository;
quando torna verde la chiude automaticamente. Questo evita sia il silenzio sia una nuova issue ogni ora.

Gli errori runtime successivi al bootstrap continuano a finire in `clientErrors`; la Function
`notifyAdminOnClientError` crea una push admin deduplicata per fingerprint/giorno, senza copiare
messaggio, stack, query string o user agent nella notifica. Gli errori che impediscono il bootstrap
sono invece coperti dal monitor remoto, perché in quel caso il reporter client non può avviarsi.

### Functions deployate

```bash
firebase functions:list --project gia-visto
```

Elenca ogni function live con trigger, region, memoria, runtime. Utile per: confrontare col source locale
prima di un full `--only functions` (vedi gotcha in `DEPLOYMENT.md`), o per leggere `updateTime` di una
singola function via API diretta:

```bash
TOKEN=$(gcloud auth application-default print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://cloudfunctions.googleapis.com/v1/projects/gia-visto/locations/europe-west1/functions/NOME_FUNCTION" \
  | grep -i updateTime
```

Confrontare `updateTime` con l'orario del commit/deploy per verificare che un fix sia davvero live.

### Ruleset live (Firestore/Storage)

Le rules deployate si scaricano dall'API `firebaserules.googleapis.com`, con un token ADC:

```bash
TOKEN=$(gcloud auth application-default print-access-token)

# 1. Trova il ruleset attivo (Firestore)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://firebaserules.googleapis.com/v1/projects/gia-visto/releases/cloud.firestore"
# → { "rulesetName": "projects/gia-visto/rulesets/<ID>", "updateTime": "..." }

# 2. Scarica il contenuto del ruleset
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://firebaserules.googleapis.com/v1/projects/gia-visto/rulesets/<ID>" \
  -o /tmp/live-ruleset.json

# 3. Estrai il testo (il contenuto è in source.files[0].content) e diffalo col repo
python3 -c "
import json
d = json.load(open('/tmp/live-ruleset.json'))
open('/tmp/live-firestore.rules','w').write(d['source']['files'][0]['content'])
"
diff /tmp/live-firestore.rules firestore.rules
```

Stesso pattern per Storage rules, sostituendo la release: `releases/firebase.storage/gia-visto.firebasestorage.app`.

Procedura verificata e funzionante: eseguita il 2026-07-12, ruleset live risultato **byte-identico** a
`firestore.rules` su `main`. Se emerge un diff, quel diff è la fonte di verità per capire cosa fa realmente
prod — non il file nel repo.

**Auth**: serve `gcloud auth application-default login` fatto una volta (ADC); `gcloud` è disponibile in
questo ambiente (`/opt/homebrew/bin/gcloud`). In alternativa, qualunque script Node con `firebase-admin` può
ottenere lo stesso bearer token via `admin.credential.applicationDefault().getAccessToken()`.

## Signup lifecycle e audit sicurezza (parzialmente live)

Aggiornato al 2026-08-28.

**Produzione**: `registerPendingSignup`, `completeVerifiedSignup` e
`getSignupState` sono **live**, deployate d'urgenza il 28/08 perche' il client
web e iOS 1.8.0 le chiamava gia' e rispondevano 404: l'account Auth veniva
creato, la callable falliva e **l'email di verifica non partiva mai**. Restano
non deployati il nuovo `ensureUserDocsOnAuthCreate` e
`reconcileUserDataOnAuthDelete`; in prod gira ancora il trigger del 2026-08-06,
che crea profilo, chat e notifica anche per un password non verificato.
`SIGNUP_VERIFICATION_ENFORCEMENT=false`.

**Staging**: l'intero lifecycle e' deployato con
`SIGNUP_VERIFICATION_ENFORCEMENT=true` e verificato end-to-end (8/8, vedi
sotto). Due cose imparate qui:

- i trigger Auth gen1 (`auth.user().onDelete`) **si creano** anche su un
  progetto nuovo, a differenza dei trigger Firestore gen1;
- il cleanup richiede le esenzioni collection-group su `comments/messages/
  likes/shares .uid`. Senza, `reconcileUserDataOnAuthDelete` fallisce con
  `FAILED_PRECONDITION` e lascia `accountDeletionRequests` in `failed`. Prod
  le ha tutte e quattro; staging no, ed e' stato il primo esito rosso.

App Check e' predisposto sui client ma non configurato sul progetto
(`appCheck.enabled=false`, siteKey vuota): l'enforcement sulle tre callable e'
dietro `SIGNUP_APP_CHECK`, spento. Accenderlo senza prima registrare reCAPTCHA
v3 e App Attest **rompe di nuovo la registrazione**.

Nessuna flag Auth, policy IAM o configurazione Logging e stata modificata.

### Stato cloud letto senza mutazioni

Sia `somto-staging` sia `gia-visto` riportavano `auditConfigs: []`: Firestore
`DATA_READ` non e abilitato. In entrambi i progetti `_Default` e attivo,
globale, unlocked, retention 30 giorni; `_Required` e attivo, globale, locked,
retention 400 giorni. I sink sono quelli standard e non risultano exclusions.
La config Auth Admin v2 ha risposto `403` con le credenziali disponibili: non
dedurre subtype, activity logging o `disabledUserDeletion` dal silenzio.

L'abilitazione `DATA_READ`, la retention, bucket/sink/view e gli accessi IAM
sono modifiche cloud gated. Salvare sempre la policy corrente, modificare solo
`auditConfigs` e non ricostruire una IAM policy da zero.

### DATA_READ: cosa registra davvero (verificato 2026-08-29)

Attivato su **staging e produzione** il 2026-08-29, solo `DATA_READ` sul
servizio `datastore.googleapis.com`. Snapshot di rollback delle due IAM policy
presi prima della modifica.

**Trappola da ricordare**: `setIamPolicy` **ignora `auditConfigs` senza
`updateMask`**. La prima chiamata ha risposto 200 con i bindings intatti e
`auditConfigs: []`, cioe' sembrava riuscita e non aveva fatto niente. Serve:

```json
{"policy": {...policy completa..., "auditConfigs": [...]}, "updateMask": "auditConfigs"}
```

La configurazione impiega qualche minuto a propagarsi: letture fatte subito
dopo l'attivazione non compaiono.

Cosa contiene una voce reale di lettura utente:

| campo | dove sta | note |
| --- | --- | --- |
| uid | `protoPayload.authenticationInfo.thirdPartyPrincipal.payload.sub` | c'e' anche `firebase.sign_in_provider` e `email_verified` |
| IP | `protoPayload.requestMetadata.callerIp` | presente |
| metodo | `protoPayload.methodName` | GetDocument, BatchGetDocuments, RunQuery, Listen |
| documento | `protoPayload.request.name` | **non** in `resourceName`, che si ferma al database |
| query | `protoPayload.request.structuredQuery` | collection, filtri e limit |
| quanti documenti | `protoPayload.numResponseItems` | |

Due limiti misurati, non dedotti:

- **le letture negate non compaiono**: due filtri diversi (`status.code!=0` e
  `severity>=WARNING`) hanno restituito zero voci a fronte di un 403 reale.
  Un alert su "letture negate ripetute" **non si puo' costruire su DATA_READ**;
- l'unita' e' la richiesta. Un `GetDocument` identifica il documento esatto,
  una query dice cosa e' stato chiesto e quanti documenti sono tornati, non
  quali.

Volume e costo: la produzione fa **~166.000 richieste API Firestore al giorno**
(media 7 giorni, massimo 179.000), scritture incluse. Le voci di audit contano
le richieste, non i documenti: la stima e' nell'ordine dei 5-7 GB al mese,
dentro i 50 GiB gratuiti mensili di Cloud Logging. **Da misurare davvero dopo
una settimana** con `logging.googleapis.com/billing/bytes_ingested`.

Accesso: sul progetto prod l'unico essere umano con un ruolo e' l'account
owner (una persona sola); gli altri membri sono service account. I
log restano nel bucket `_Default` con retention 30 giorni. Un bucket dedicato
con IAM piu' stretto ha senso solo se un giorno accede qualcun altro.

### Query Logs Explorer dopo il gate DATA_READ

Base Firestore Data Access:

```text
logName="projects/PROJECT_ID/logs/cloudaudit.googleapis.com%2Fdata_access"
protoPayload.serviceName="firestore.googleapis.com"
```

Per metodo o target:

```text
protoPayload.methodName="google.firestore.v1.Firestore.GetDocument"
protoPayload.methodName="google.firestore.v1.Firestore.BatchGetDocuments"
protoPayload.methodName="google.firestore.v1.Firestore.RunQuery"
protoPayload.methodName="google.firestore.v1.Firestore.Listen"
SEARCH("users/UID")
```

Per identita/IP, aprire prima un log QA reale e confermare il path effettivo:

```text
protoPayload.authenticationInfo.thirdPartyPrincipal.payload.sub="UID"
protoPayload.requestMetadata.callerIp="IP"
```

Firebase Auth con JWT puo comparire in `thirdPartyPrincipal` e l'IP in
`requestMetadata.callerIp`, ma alcuni campi possono essere redatti. Limitare
l'accesso ai log per IAM/view: JWT e IP sono dati di sicurezza. Non copiare
questi valori in Firestore o nel pannello prodotto.

Limite forense: l'unita audit e la richiesta/target, non necessariamente ogni
documento restituito da una query. `Listen` registra il target iniziale e
aggiornamenti periodici; una resume puo non emettere di nuovo il primo target.
Quindi una query tracciata non prova l'elenco esatto dei documenti letti.

Dopo l'abilitazione in staging, provare con account QA GetDocument,
BatchGetDocuments, RunQuery, Listen consentiti e negati. Misurare ingestione e
costo per 1-2 settimane prima di definire alert o replicare in produzione.

### Activity logging Auth e alert

Identity Platform activity logging e un flusso distinto dai Firestore Audit
Logs e puo registrare `SignUp`, `SignInWithPassword`, `SignInWithIdp` e
`DeleteAccount`. E disabilitato per default e puo incidere sul billing: upgrade
e attivazione sono gate separati.

Il pannello admin usa soltanto aggregati minimizzati: Auth presenti, lifecycle,
provider, surface, conversione, mediane verifica/prima azione, scadenze,
cancellazioni per fonte, orphan/auth-only e quota attribution unknown. I valori
client di attribution non sono prove di sicurezza.

Alert da creare solo dopo baseline, non sui due eventi dell'incidente:

- signup per ora sopra baseline/p95 e soglia assoluta concordata;
- cancellazioni entro 24h e rapporto cancellazioni/signup;
- errori invio/verifica/completion e retry;
- domini IANA riservati;
- rapporto pending/completed e backlog oltre 72h;
- volume/costo Firestore `DATA_READ` e query directory anomale.

### Audit e cleanup per UID

Il comando e dry-run per default e accetta un solo UID, senza wildcard:

```bash
cd functions
node scripts/audit-signup-lifecycle.js --project gia-visto --uid <UID>
```

Il dry-run sui due profili `gcpmap_*` ha confermato `orphan_profile`, Auth
assente, profili public/private e support thread presenti, nessuna azione reale
e soli artefatti automatici. Nessuna cancellazione e stata eseguita. L'execute
richiede sia `--execute` sia `--confirm-project gia-visto` ed e un gate
esplicito per quei due target.

Claim legacy, dry-run aggregato:

```bash
cd functions
node scripts/migrate-legacy-unverified-claims.js \
  --project gia-visto --cutoff 2026-08-22T00:00:00Z
```

Snapshot dry-run del 2026-08-23: staging 3 Auth, 1 admin, 2 candidati; produzione
334 Auth, 5 admin, 104 candidati legacy. L'apply richiede `--execute`, conferma
progetto e manifest fuori dal repository; non e stato eseguito.

Lo scheduler `cleanupExpiredPendingSignups` resta disabilitato e dry-run per
default. Se autorizzato, attivarlo prima in staging, controllare esclusioni e
circuit breaker, poi verificare che ogni delete individuale produca il trigger
Auth `onDelete`. Non usare `deleteUsers(uids)`: il bulk Admin SDK non emette i
trigger di cancellazione per singolo utente.

### `disabledUserDeletion`

La config Identity Platform espone separatamente `disabledUserSignup` e
`disabledUserDeletion`. Se autorizzata, cambiare soltanto la seconda in staging
con update mask mirato, mantenendo signup consentito. Verificare che delete
client SDK/REST fallisca, mentre `deleteMyAccount` via Admin SDK completi Auth,
Firestore, Storage e audit trail. Salvare prima config e rollback; produzione
solo dopo regressione email/Google/Apple e conferma esplicita.

## Monitoraggio costi Firestore

Diagnosi via **Cloud Monitoring API**, stesso bearer token ADC di sopra (nessun bisogno di aprire la
console):

```bash
TOKEN=$(gcloud auth application-default print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://monitoring.googleapis.com/v3/projects/gia-visto/timeSeries?filter=metric.type%3D%22firestore.googleapis.com/document/read_count%22&interval.startTime=<ISO>&interval.endTime=<ISO>&aggregation.alignmentPeriod=86400s&aggregation.perSeriesAligner=ALIGN_SUM"
```

Metriche utili:
- `firestore.googleapis.com/document/{read,write,delete}_count` (`ALIGN_SUM`, `alignmentPeriod=86400s` =
  1 giorno) → trend giornaliero, quando spikea un costo.
- `cloudfunctions.googleapis.com/function/execution_count`, raggruppato per
  `resource.label.function_name` → **quale function** genera il carico.
- Combinare con la query `updateTime` di una function (sezione sopra) per correlare uno spike con un deploy
  specifico.

Come leggere la curva: un pattern giorno/notte (basso la notte, alto di giorno) è **user-driven**, normale.
Una curva **costante 24/7** è quasi sempre un loop lato server (trigger che richiama se stesso, fan-out non
guardato) — indaga lì per primo.

**Precedente reale (2026-07-11)**: reads passati da ~30k/giorno (baseline) a 7,5M/giorno durante un'ondata
di import TV Time/Trakt. Diagnosticato con questa procedura: causa non era un loop ma (a) un trigger di feed
(`onSeriesStartedFeedEvent`) senza guardia anti-bulk-import che generava un evento per ogni serie del
back-catalogo importato, e (b) utenti che ricaricavano più volte lo stesso file perché non capivano la coda
`awaiting_confirmation`, rieseguendo il matching completo ogni volta. Fix live: guardia sul trigger + rate
limit `assertNoConflictingImport` sui 3 entry point import (blocca import concorrente attivo o stessa fonte
già in coda conferma).

## Import bloccati — toolkit

Script in `functions/scripts/`, admin SDK, **dry-run di default** (serve `--write` per applicare), bucket
Storage `gia-visto.firebasestorage.app`:

- **`import-report.js --uid=UID --import=IMPORT_ID`** — report completo **read-only** di un import: stato,
  `totalRows`/`matchedCount`/`unresolvedCount`/`errorCount`/`tickCount`, breakdown per strategia di match,
  campione di righe non risolte, `ratingsSummary`. Primo comando da lanciare per capire cosa è successo a un
  import di un utente.
- **`kick-stuck-import.js --uid=UID --import=IMPORT_ID [--write]`** — sblocca un import fermo a
  `status:"uploading"`: i file sono su Storage ma `finalizeTitlesImportUpload` non è mai arrivato a buon
  fine (tipicamente un upload che supera il cap righe, o un file su N mai arrivato). Rimette l'import in
  `queued` e crea il primo tick (`importMatchTicks/{importId}_0`); il trigger `runImportMatchTick`
  deployato fa il resto. Verifica prima che `status=="uploading"`, che esista `payload/raw` e che i file
  core siano davvero su Storage.
- **`rematch-import-unresolved.js --uid=UID --import=IMPORT_ID [--write]`** (supporta anche
  `--all-awaiting`) — riprova il matching sugli item `resolved:false, skip:false` di un import già esistente,
  utile dopo i fix di matching successivi (altNames, CJK, AniList). **Attenzione**: le funzioni di matching
  sottostanti (`matchViaTmdb`/`matchViaTvdbId` in `functions/lib/importAdapters/matching.js`) scrivono
  comunque su Firestore/Storage anche in dry-run (creano stub titolo su match ad alta confidenza) — lo
  script mette una guardia esplicita solo attorno a quella singola chiamata di scrittura, quindi il dry-run
  reale è sicuro, ma **non chiamare direttamente le funzioni di matching.js fuori da questo script** in
  modalità "simulazione".

- **`import-health-scan.js [--uid=UID] [--skip-seasons]`** — passa in rassegna TUTTI gli import e segnala
  quelli andati male **anche se risultano "completed"**: 0 righe, 0 titoli scritti, file dei film assente,
  fermi, match sotto il 50%, serie completate per numerazione stagioni incompatibile. Lo `status` non è un
  indicatore di salute (a luglio 2026 tre utenti avevano "completed" con zero dati). Da lanciare dopo ogni
  ondata di import o quando arriva una segnalazione. La versione automatica è la Cloud Function
  `scanImportHealth` (settimanale, avvisa gli admin solo se trova qualcosa); lo script fa in più il
  censimento stagioni, che costa migliaia di letture.
- **`rescue-import-wrong-format.js --uid=UID --import=OLD_ID --source=tvtime_refract [--write]`** — quando
  un import è fallito perché i file erano validi ma letti col parser sbagliato (JSON Refract caricato negli
  slot CSV), ricrea l'import sugli **stessi file già su Storage** dichiarando il formato giusto: l'utente
  non deve ricaricare niente. I file di un import fallito NON vengono più cancellati proprio per questo.
- **`repair-import-season-mismatch.js --uid=UID [--import=ID] [--titleId=ID] [--write]`** — ricalcola le
  serie che l'import ha marcato completate per colpa della numerazione di stagione della sorgente (TV Time
  numera gli archi degli anime come stagioni). Senza `--import` usa le righe di **tutti** gli import
  dell'utente: chi ne ha fatti due ha gli episodi spalmati su più import e ripartire da uno solo farebbe
  regredire il progresso. Riscrive solo dove il ricalcolo cambia il risultato, quindi chi la serie l'ha
  finita davvero non viene toccato.

### Titoli non riconosciuti: perché il rematch resta manuale

Gli item non risolti restano nell'import in `awaiting_confirmation` e l'utente li rivede in-app dalla
notifica; l'import doc porta anche un warning leggibile (`warnings`) quando la quota di non risolti è alta.
Un rematch **automatico schedulato** è stato valutato e scartato: consuma quota TMDB, può creare stub
sbagliati e nessuno guarderebbe il risultato. Si lancia a mano con `rematch-import-unresolved.js` quando un
fix di matching lo rende utile.

Script correlati per casi più specifici (stesso pattern dry-run + `--write`):
- `reprocess-tvtime-votes.js --uid --import [--write]` — ri-decodifica voti/emozioni da Storage con il
  decoder scala-aware corretto.
- `purge-tvtime-import-ratings.js --uid --level=title|all [--write]` — rimuove rating di import corrotti.
- `recover-tvtime-lists.js --uid --import --listsFile=STORAGE_PATH [--write]` — recupera liste custom
  TV Time quando `lists.csv` non è mai arrivato su Storage nell'import originale.
- `process-support-import.js --uid=UID [--write] [--delete-upload]` — rescue re-import completo per un file
  caricato via `support-import.html` (vedi sotto): gestisce librerie grandi senza il cap righe/payload della
  callable standard, usa la mappa voti corretta per-file, e recupera anche le serie solo "seguite" che il
  parser automatico scarta.

## Scanner aggiornamenti titolo (solo lettura)

`functions/scripts/scan-title-updates.cjs` raccoglie candidati TMDB in
`it-IT`, `en-US` e lingua globale. Non espone `--write`, non usa la cache
Firestore e non pubblica eventi o notifiche. Il progetto predefinito è staging.

```bash
cd functions

# Smoke deterministico senza credenziali né rete
npm run scan:title-updates -- \
  --fixture test/fixtures/title-updates-scan.json \
  --include-candidates

# Lettura di titoli staging + TMDB live (servono ADC e TMDB_KEY)
TMDB_KEY=... npm run scan:title-updates -- \
  --project somto-staging \
  --title-id ted-lasso \
  --include-candidates
```

Guardrail: massimo 50 titoli e 300 chiamate TMDB per esecuzione; default 10/60.
Le date film sono auto-publish eligible soltanto con conferma `release_dates`
per regione `IT`. Una risposta generica senza regione viene riportata come
bozza da revisionare. Prima di aggiungere qualunque modalità di scrittura,
seguire e approvare `docs/TITLE_UPDATE_EVENTS_DATA_PROPOSAL.md`.

Applicazione dei candidati: comando distinto, dry-run di default e bloccato su
`somto-staging`. Produzione (`gia-visto`) viene rifiutata dal codice.

```bash
# 1. Genera scan.json includendo candidates[]
TMDB_KEY=... npm run scan:title-updates -- \
  --project somto-staging --title-id ted-lasso \
  --include-candidates > scan.json

# 2. Controlla la trasformazione, nessuna scrittura
npm run apply:title-updates -- --input scan.json --publish-eligible

# 3. Applica al solo staging; backfill resta non notificabile
npm run apply:title-updates -- --input scan.json \
  --project somto-staging --apply --confirm somto-staging \
  --publish-eligible
```

L'applicatore usa per default soltanto `candidateIdsInWindow` prodotto dallo
scanner: non importa trailer/date fuori dai 180 giorni passati e 365 futuri.
`--all-candidates` esiste solo per audit manuali espliciti in staging.

Il trigger gen2 `notifyOnTitleUpdatePublished` resta inerte salvo opt-in con
`TITLE_UPDATE_NOTIFICATIONS_ENABLED=true`. Prima di abilitarlo: deployare
rules/indice, usare account QA con titolo seguito o visto, creare un evento
`live`, verificare preferenze web/iOS e confermare che il retry non duplichi la
notifica. Il backfill usa sempre `acquisitionMode=backfill` e rimane non
notificabile anche dopo una scansione live successiva.

## Backfill / reconcile

Da eseguire dopo il deploy del trigger corrispondente (baseline una-tantum) o come riconciliazione
anti-drift periodica:

- **`functions/scripts/recompute-user-stats.js`** — ricalcola da zero `users/{uid}.stats`
  (`watchedCount`/`ratingsCount`/`totalWatchMinutes`/`rewatchCount` + `byCategory`), fissando il baseline per
  i trigger incrementali `recomputeUserStatsFromTitleStates`/`recomputeUserStatsFromListProgress`.
  ```bash
  cd functions
  node scripts/recompute-user-stats.js            # dry-run, mostra il drift
  node scripts/recompute-user-stats.js --write     # applica
  ```
- **`scripts/backfill-titleRatingAggregate.cjs`** (root) — backfill di `titles/{id}.ratingAggregate` dopo
  il deploy del trigger `recomputeTitleRatingAggregate`. Idempotente (ricalcola da zero ogni volta).
  ```bash
  node scripts/backfill-titleRatingAggregate.cjs            # dry-run
  node scripts/backfill-titleRatingAggregate.cjs --write     # applica
  ```
- **`scripts/backfill-titleEmotionAggregate.cjs`** (root) — backfill/riconciliazione di
  `titles/{id}.emotionAggregate` dopo il deploy del trigger `recomputeTitleEmotionAggregate`, o dopo ogni
  import admin-SDK massivo che scrive `titleEmotions` direttamente. Esclude i doc sintetici (profili
  guidati).
  ```bash
  node scripts/backfill-titleEmotionAggregate.cjs            # dry-run
  node scripts/backfill-titleEmotionAggregate.cjs --write     # applica
  ```
- **`functions/scripts/rebuild-quiz-themes.js`** — ricostruisce `quizMeta/themes` (titoli con domande
  giocabili + conteggio) scansionando `quizQuestions` con `status in [approved, beta_pending_review]`. Da
  rilanciare come backfill iniziale o refresh on-demand dopo un import massivo di domande quiz.
  ```bash
  cd functions
  node scripts/rebuild-quiz-themes.js            # dry-run
  node scripts/rebuild-quiz-themes.js --write     # scrive quizMeta/themes
  ```

Tutti dry-run di default (`--write` per applicare), tutti admin SDK con `admin.initializeApp({projectId:
"gia-visto"})` — quindi puntano SEMPRE a prod: usarli con l'ADC del progetto giusto attivo.

## Utenti / supporto

- Ogni utente reale ha un thread di supporto `support_{uid}` in Firestore (creato al primo bisogno,
  visibile nell'app come chat "Scrivici"). È il canale principale per rispondere a segnalazioni.
- **Pagina rescue import**: `https://somto.it/support-import.html` (`public/support-import.html`,
  `noindex`) — per utenti bloccati sul flusso import normale (TV Time/Netflix). Login inline
  email/password (o Google/Apple), upload grezzo del file (.zip/.csv/.json, cap 30MB) su Storage
  `supportImports/{uid}/{timestamp}-{nome}`, owner-only, nessun parsing lato pagina — bypassa tutti i punti
  fragili del flusso automatico (estrazione ZIP client, body callable, rate-limit).
  Per processare un upload: elencare `supportImports/{uid}/` via admin SDK, scaricare il file, darlo alla
  pipeline import (adapter in `functions/lib/importAdapters/`, o direttamente
  `functions/scripts/process-support-import.js --uid=UID`). **Cancellare il file da Storage dopo** —
  contiene PII (lo ZIP GDPR ha email/hash password/IP).

## Emergenze

- **Kill switch profili guidati** — se i "profili guidati" (account interni supervisionati) si comportano
  male: callable admin `setGuidedProfilesConfig({killSwitch: true})` (`functions/modules/guidedProfiles/index.js`,
  region `europe-west1`, richiede auth admin). Config persistita in `appConfig/guidedProfiles` (deny-all
  client). Nota: la feature è **spenta di default** (`enableGuidedProfiles: false`) finché non attivata
  esplicitamente.
- **Gate versione minima iOS** — per bloccare o solo consigliare l'aggiornamento a build vecchie: doc
  Firestore `experiments/global`, campo `appUpdate.ios.minBuild` (blocco hard, mostra `RequiredAppUpdate` e
  impedisce l'uso dell'app — valutato in `AppUpdatePolicyStore.evaluate()`,
  `ios/TwoWatch/Features/AppShell/RootView.swift`) e `appUpdate.ios.recommendedBuild` (nudge soft
  dismissibile, mostrato solo se non c'è già un blocco hard e l'utente non l'ha già rimandato per quel
  build). **Importante**: questi gate ships solo nelle build iOS che già contengono il codice di lettura —
  non raggiungono retroattivamente le build più vecchie già installate.
- **Blast notifiche "aggiorna l'app"** — dopo una release App Store, per spingere tutti gli utenti ad
  aggiornare (non bloccante):
  ```bash
  node functions/scripts/blast-app-update.cjs --build <CURRENT_PROJECT_VERSION>            # dry-run
  node functions/scripts/blast-app-update.cjs --build <CURRENT_PROJECT_VERSION> --write     # invia
  ```
  Notifica in-app `engagement_nudge` a tutti gli utenti reali (esclude admin e profili sintetici), push
  automatico ai token holder via il trigger fan-out esistente, idempotente per build (marker
  `users/{uid}.engagement.appUpdateNudgeBuild`). **Prerequisito**: `public/aggiorna.html` deve essere già
  live su hosting (i tap dal notification link farebbero 404 altrimenti — niente rewrite catch-all).
  **Gotcha**: il `ctaUrl` passato deve essere un path interno (es. `/aggiorna.html`), mai un URL App Store
  raw — `functions/modules/notifications.js:729` forza `link = https://somto.it${ctaUrl}` per il push web.

## Regola d'oro (ripetuta)

Prima di diagnosticare, **verifica sempre che prod == repo** (sezione "Verifica stato prod" sopra). Un
comportamento anomalo osservato in produzione può essere spiegato da un deploy manuale non tracciato molto
più spesso di quanto sembri — controllarlo costa due comandi, non controllarlo costa ore di diagnosi sul
codice sbagliato.


## Modifiche manuali in console (registro)

- **2026-07-12 — Nome pubblico OAuth**: Firebase Console → gia-visto →
  Impostazioni progetto → Generali → "Nome per il pubblico":
  `project-538597925021` → **Somto**. È il nome che Google mostra nel
  popup "Accedi con Google" ("per continuare su …"). Non è nel repo:
  se si ricrea il progetto va reimpostato a mano. Nota: la riga piccola
  del popup può ancora mostrare `gia-visto.firebaseapp.com` (authDomain);
  per mostrare `somto.it` servirebbe un auth domain custom
  (auth.somto.it) — cambio più invasivo, non fatto.
- **2026-07-12 — Staging**: Authentication Email/password abilitata su
  somto-staging (console); dettagli Blaze e billing restano nella console
  Google Cloud, non nel repository.
- **2026-07-12 — Auth domain custom somto.it** (il popup social mostra
  somto.it, SW v110). Registrazioni manuali fatte a supporto:
  (a) Google Cloud Console → Credentials → "Web client (auto created by
  Google Service)": aggiunti origin `https://somto.it` e redirect URI
  `https://somto.it/__/auth/handler`;
  (b) Apple Developer → Services ID `com.paolocelestini.somto.signin` →
  Sign In with Apple → Configure: aggiunti dominio `somto.it` e Return URL
  `https://somto.it/__/auth/handler` (8 Website URLs totali).
  Gli URL vecchi (gia-visto.firebaseapp.com) restano registrati: rollback
  = revert di `authDomain` in public/firebaseConfig.js + deploy hosting.
  ⚠️ Se si cambia di nuovo authDomain, ripetere (a)+(b) PRIMA del deploy.
