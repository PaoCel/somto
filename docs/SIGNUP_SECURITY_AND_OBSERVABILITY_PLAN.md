# Sicurezza e osservabilita del signup

Stato: **PARZIALMENTE LIVE — callable di signup in prod, resto gated**

Aggiornamento 2026-08-28: le tre callable del signup sono state deployate in
produzione fuori sequenza, per chiudere un incidente. Il client le chiamava gia'
(web e iOS 1.8.0) mentre in prod rispondevano 404: la registrazione
email/password era rotta dal 22/08 e l'email di verifica non partiva. Il piano
resta valido, ma l'ordine "server prima, client poi" era gia' stato invertito
dalla realta'. Dettagli e verifiche in `docs/RUNBOOK.md`.

Data: 2026-08-22

Esecuzione aggiornata: 2026-08-23

- Release 1: implementazione locale completa; audit cloud read-only eseguito,
  configurazioni e cleanup produzione ancora gated.
- Release 2: web/iOS implementati e verificati localmente; staging/TestFlight
  ancora gated.
- Release 3: Functions, claim migration, Rules matrix e scheduler preparati;
  claim, deploy ed enforcement non attivi.
- Release 4: attribution e metriche admin implementate; DATA_READ, activity
  logging, Identity Platform e alert cloud ancora gated/baseline-dependent.
- Release 5: inventario e proposta separata completati in
  `docs/PUBLIC_PRIVATE_PROFILE_MIGRATION.md`; schema/tightening richiedono il
  gate decisionale della release separata.

Origine: incidente dei due profili `gcpmap_*`

Verdict: **PASS WITH CONCERNS**

## Mandato per la prossima chat

Questo documento deve essere letto insieme a `CLAUDE.md` prima di modificare il
codice. La prossima chat deve:

1. controllare `git status --short` e non inglobare modifiche estranee;
2. leggere i file e i playbook indicati nella sezione "File coinvolti";
3. eseguire l'intero piano in ordine, in slice piccoli e reversibili;
4. partire da **Release 1**, verificarla, aggiornare le checkbox e continuare
   con tutte le parti tecnicamente implementabili senza attendere adozione;
5. fermarsi solo ai gate espliciti: deploy, modifiche di configurazione cloud o
   DNS, upgrade a Identity Platform, cancellazioni in produzione, custom claim
   su utenti reali ed enforcement che puo bloccare client distribuiti;
6. per ogni modifica a schema/rules/Functions produrre nel report finale:
   Verdict, Findings, Required changes, Risks, Suggested implementation steps,
   Tests needed.

Le release 1 e 2 possono essere implementate senza aspettare dati di adozione.
La Release 3 puo essere preparata, ma il suo enforcement deve attendere che i
client compatibili siano distribuiti. Le release 4 e 5 hanno gate decisionali
separati e non vanno accorpate a un deploy urgente.

## Obiettivo

Rendere il ciclo di registrazione coerente anche quando un utente usa Firebase
Auth direttamente, evitare profili Firestore orfani, richiedere la verifica
della casella email per i nuovi account password, distinguere signup reali da
account incompleti e raccogliere solo i dati utili a sicurezza e prodotto.

Il risultato atteso non e impedire in assoluto la creazione di un record Auth:
su un client pubblico nessuna barriera web e perfetta. Il risultato atteso e
che un account non verificato non ottenga profilo, directory, chat, notifica
admin o permessi applicativi e venga eliminato dopo una retention definita.

## Contesto verificato dell'incidente

Il 22 agosto 2026 sono comparsi a circa 78 minuti di distanza due profili con
nomi che iniziavano con `gcpmap_probe_` e `gcpmap_dp_`, entrambi associati a
indirizzi `example.com` sintetici.

Fatti accertati:

- `example.com` e un dominio riservato per documentazione e test, non una
  normale casella personale;
- entrambi gli utenti erano stati creati in Firebase Auth con email/password;
- il trigger `ensureUserDocsOnAuthCreate` aveva creato automaticamente
  `users/{uid}`, `usersPrivate/{uid}`, chat di assistenza e notifiche;
- in seguito i due record Firebase Auth sono stati eliminati, mentre i profili
  Firestore sono rimasti;
- non esiste alcuna `accountDeletionRequests/{uid}` per loro: non hanno usato
  `deleteMyAccount` di Somto;
- non risultano rating, titoli, watchlist, import, quiz, post, commenti,
  relazioni social, token push, errori client o file Storage;
- gli unici artefatti trovati sono quelli creati automaticamente dal backend;
- i log disponibili mostrano i trigger backend, ma non l'IP di origine e non
  permettono di dimostrare eventuali letture Firestore;
- non esiste oggi un trigger Firebase Auth `onDelete` che riconcili i dati.

Conclusione tecnica piu probabile: creazione e cancellazione diretta tramite
API/SDK Firebase da parte di un controllo automatizzato. Non ci sono prove che
fosse un recruiter, che fosse un attacco mirato o che siano stati estratti dati.
Un test mirato dopo aver visto il CV resta possibile, ma non e dimostrabile con
la telemetria attuale.

Snapshot Auth del 2026-08-22, da non trattare come valore statico:

- 334 utenti Auth totali;
- 108 account password: 4 verificati, 104 non verificati;
- 226 account federati; i conteggi provider possono sovrapporsi per account
  collegati (`google.com`: 121, `apple.com`: 107);
- tra i 104 password non verificati, 17 hanno effettuato un accesso negli
  ultimi 30 giorni e 91 negli ultimi 90 giorni;
- 88 non risultavano tornati dopo la creazione.

Questo snapshot rende pericoloso un blocco globale immediato basato soltanto su
`email_verified`: romperebbe utenti esistenti e forse anche l'account admin.

## Principi e decisioni gia prese

1. **Email verification non e 2FA.** La prima prova il controllo della casella;
   la seconda protegge un account gia esistente. La priorita qui e la verifica
   email.
2. **Social login non richiede una seconda email Somto.** Google/Apple possono
   proseguire quando il token/provider indica email verificata. Casi anomali
   senza email verificata devono fallire chiusi e venire loggati.
3. **Il backend resta autoritativo.** Nascondere schermate nel client non basta:
   callable e Firestore Rules devono applicare lo stesso gate.
4. **Niente notifica admin prima della verifica.** Un record Auth non verificato
   non e ancora un nuovo iscritto Somto.
5. **Niente profiling invasivo.** Non salvare in Firestore IP grezzo, user-agent
   completo, URL referrer completo, fingerprint o identificatori pubblicitari
   per questo scopo.
6. **Sicurezza e analytics sono dataset separati.** I log di sicurezza hanno
   base giuridica, accessi e retention propri; analytics/marketing rispettano
   il consenso applicabile.
7. **I segnali sono indizi, non sentenze.** Dominio riservato, assenza di azioni,
   API diretta o user-agent insolito non devono provocare da soli un ban.
8. **Cleanup idempotente.** Una cancellazione ripetuta o concorrente deve
   terminare senza ricreare dati, doppi conteggi o errori irreversibili.
9. **Compatibilita prima dell'enforcement.** Prima si distribuiscono web/iOS,
   poi si osserva l'adozione, infine si stringono trigger e Rules.
10. **L'audit delle letture e server-side.** Usare Firestore Data Access Audit
    Logs; non chiedere al client di registrare autonomamente cio che legge.
11. **I log di sicurezza non vivono sotto il profilo.** Devono sopravvivere alla
    cancellazione per una retention limitata, con accesso IAM ristretto, e poi
    scadere automaticamente. Non conservarli per sempre.
12. **Cancellazione solo tramite backend Somto.** Disabilitare l'eliminazione
    Auth da SDK/API client dopo test staging; il frontend chiama
    `deleteMyAccount`, mentre Admin SDK e trigger lifecycle applicano la policy.

## Modello di stato desiderato

Usare questi concetti nel backend e nel pannello, anche se i nomi finali dei
campi possono essere adattati allo stile esistente:

| Stato | Auth | Email | Profilo Somto | Significato |
| --- | --- | --- | --- | --- |
| `pending_verification` | presente | non verificata | assente | registrazione password incompleta |
| `active` | presente | verificata/social | presente | iscritto Somto utilizzabile |
| `legacy_unverified` | presente | non verificata | presente | utente storico in finestra di migrazione |
| `orphan_profile` | assente | n/a | presente | difetto di lifecycle da riconciliare |
| `auth_only` | presente | verificata | assente | provisioning fallito da riparare |
| `deleted` | assente | n/a | assente/tombstone minimo | cancellazione conclusa |
| `synthetic_guided` | assente | n/a | presente | profilo guidato interno, non signup |

La dashboard non deve dedurre `active` dalla sola esistenza di `users/{uid}`.

## Schema proposto

### `pendingSignups/{uid}` — server-only, deny-all ai client

Creato/aggiornato solo da callable autenticata e protetta da App Check per i
nuovi signup password.

Campi minimi:

```text
schemaVersion: 1
uid
provider: "password"
status: "pending" | "completed" | "expired"
requestedDisplayName
ageConfirmed: true
communitySafetyAcceptedAt
communitySafetyAcceptedSource: "web_signup" | "ios_signup"
createdAt
updatedAt
expiresAt
attemptCount
attribution: { ...campi minimizzati... }
```

Non salvare la password. L'email resta in Firebase Auth e non deve essere
duplicata qui. Se serve mostrare il dominio nel pannello, ricavarlo server-side
al momento della risposta admin.

Retention proposta: 72 ore per i pending non verificati, poi eliminazione del
record e dell'utente Auth. Rendere la durata una costante testata e documentata.

### `users/{uid}/_system/signupAttribution` — server-only

La collocazione definitiva puo anche essere sotto `usersPrivate`, ma deve avere
rules deny-all al client o sola lettura owner solo se emerge un vero requisito.
Default raccomandato: server-only.

```text
schemaVersion: 1
completedAt
provider: "password" | "google.com" | "apple.com"
surface: "web" | "ios" | "unknown"
appVersion
landingPath
referrerHost
utmSource
utmMedium
utmCampaign
language
analyticsConsent: true | false | null
selfReportedSource
```

Vincoli:

- `landingPath`: solo path interno, niente query string;
- `referrerHost`: solo hostname normalizzato, niente URL completo;
- UTM e appVersion con allowlist di caratteri e lunghezza massima;
- `selfReportedSource`: preferire una enum; eventuale "altro" corto e
  facoltativo;
- il client propone i valori ma il server valida, tronca e scrive;
- includere questi dati in export e cancellazione GDPR;
- definire retention o giustificare la conservazione per analisi aggregate.

### Claim di migrazione

Claim proposto: `legacyEmailUnverified: true`.

Va assegnato solo agli account password non verificati creati prima del cutoff,
tramite script con `--dry-run` predefinito. Lo script deve:

- leggere e preservare tutti i custom claims esistenti;
- escludere profili guidati e account senza Auth;
- produrre un manifest di rollback fuori dai file committati se contiene UID;
- non rimuovere ruoli admin/trusted;
- poter rimuovere solo il claim aggiunto;
- essere rieseguibile senza effetti collaterali.

Questo claim consente a Rules e client di distinguere un vecchio account da un
nuovo account non verificato. Va rimosso alla verifica e dismesso a fine
migrazione.

## Release 1 — Lifecycle, audit e dashboard

Priorita: immediata. Rischio prodotto basso, rischio dati medio.

### Implementazione

- [x] Estrarre la logica dati di `deleteMyAccount` in un modulo testabile e
  idempotente, separando nettamente `cleanup data` da `delete Auth user`.
- [x] Conservare reauth, rate limit e blocco admin nella callable self-service.
- [x] Gestire esplicitamente la concorrenza tra `deleteMyAccount` e il nuovo
  trigger Auth `onDelete`. Non eseguire due cleanup distruttivi in parallelo:
  usare lo stato di `accountDeletionRequests/{uid}` e una lease/idempotency key
  oppure far riconciliare al trigger solo le cancellazioni esterne.
- [x] Aggiungere `auth.user().onDelete` per le cancellazioni avvenute fuori da
  Somto. Deve rimuovere profilo pubblico/privato, subcollection personali,
  reservation username, file Storage e thread `support_{uid}`; deve eliminare o
  anonimizzare i riferimenti condivisi con la stessa policy GDPR gia usata da
  `deleteMyAccount`.
- [x] Se la policy mantiene un tombstone `users/{uid}`, renderlo minimo e
  sicuramente escluso da directory, ricerca, leaderboard e metriche; preferire
  la cancellazione del root doc quando i riferimenti condivisi sono gia stati
  anonimizzati e non esiste un requisito d'integrita che lo richieda.
- [x] Il trigger non deve mai ricreare documenti o notifiche.
- [x] Registrare in `accountDeletionRequests/{uid}` una traccia minima con
  `source: "auth-on-delete"`, stato, timestamp e contatori; niente email/IP/UA.
- [x] Verificare e rimuovere gli artefatti automatici di signup che oggi possono
  vivere sotto l'account support/admin (notifica `new_user`, notifica thread e
  cooldown). Non cancellare notifiche omonime di altri utenti: filtrare per UID
  sorgente e tipo.
- [x] Rendere il pannello admin capace di mostrare `Auth presente`, provider,
  `emailVerified`, data Auth, ultimo sign-in Auth, profilo presente e stato
  lifecycle.
- [x] Classificare chiaramente `orphan_profile`, `legacy_unverified`,
  `synthetic_guided` e `active`.
- [x] Separare "azioni reali" dagli artefatti automatici: chat di benvenuto,
  notifiche e cooldown non contano come attivazione.
- [x] Aggiungere un badge di rischio informativo per domini IANA riservati
  (`example.com`, `example.net`, `example.org`, `.invalid`, `.test`,
  `.localhost`), senza cancellazione automatica.
- [x] Creare uno script di audit/cleanup con `--dry-run` default e target UID
  esplicito. Nessun wildcard e nessun elenco di UID di produzione committato.
- [x] Eseguire solo il dry-run sui due profili `gcpmap_*`; mostrare a Paolo il
  report prima di usare `--execute` in produzione.
- [x] Aggiornare `docs/FIREBASE_DATA_MODEL.md`, `docs/SECURITY.md` e
  `docs/RUNBOOK.md`.

### Audit delle letture Firestore

Non creare `users/{uid}/readLogs`: Firestore non espone trigger `onRead`, il
client potrebbe saltare o falsificare la scrittura, e il log sparirebbe insieme
al profilo. Il sistema canonico deve essere Cloud Audit Logs.

- [x] Leggere la configurazione IAM Audit Logs corrente di staging e produzione
  senza modificarla; salvare nel report servizi, log type, retention, bucket,
  esclusioni e stima volume/costo.
- [ ] In staging, abilitare soltanto `DATA_READ` per il servizio di
  configurazione `datastore.googleapis.com`; i record Firestore risultanti
  hanno `protoPayload.serviceName="firestore.googleapis.com"`.
- [ ] Non applicare una policy IAM ricostruita da zero: preservare bindings,
  `auditConfigs`, esclusioni ed `etag`, usando update mirato e rollback salvato.
- [ ] Verificare con un account QA una `GetDocument`, una `BatchGetDocuments`,
  una `RunQuery` e una `Listen`, sia consentite sia negate dove osservabile.
- [ ] Confermare su un log reale dove compaiono UID Firebase nel JWT
  `thirdPartyPrincipal`, `callerIp`, method, resource/query, timestamp, status e
  operation id. Non fissare nel codice un path JSON ipotizzato prima del test.
- [x] Documentare il limite: l'unita di audit e la richiesta. Un get puntuale
  identifica il documento; query e listener registrano query/target e conteggi,
  non garantiscono una riga separata per ogni documento restituito.
- [ ] Creare un log bucket o una route dedicata ai log di sicurezza, con accesso
  soltanto a Paolo e agli eventuali service account necessari. Il JWT e l'IP
  sono dati sensibili e non vanno copiati nel pannello o in Firestore.
- [ ] Partire con retention di 30 giorni; misurare ingestione e costo per almeno
  7 giorni, poi decidere esplicitamente se portarla a 90 giorni. Nessuna
  conservazione indefinita.
- [x] Creare in `docs/RUNBOOK.md` query salvabili per UID, intervallo, metodo,
  IP e status, piu la procedura di preservazione di un incidente confermato.
- [ ] Aggiungere alert su volume anomalo di `DATA_READ`, query directory da
  account appena creati e picchi per singolo UID/IP solo dopo una baseline.
- [ ] Verificare se escludere in modo sicuro letture Admin SDK/service account
  ad alto volume senza perdere accessi utente; niente esclusioni prima di avere
  campioni reali.
- [ ] Dopo approvazione costo/privacy, ripetere la configurazione in produzione
  e svolgere uno smoke non distruttivo con account QA.

Per collezioni realmente sensibili che richiedono il dettaglio documento per
documento, valutare una callable server-authoritative: Rules deny-all al client,
lettura via Admin SDK e audit server di UID, resource ID, decisione, timestamp e
correlation ID. Non applicare questo proxy a titoli o dati pubblici: aumenterebbe
latenza, costi e complessita senza vantaggio proporzionato.

### Cancellazione Auth solo tramite backend

Firebase espone due permessi distinti: `disabledUserSignup` e
`disabledUserDeletion`. Somto deve mantenere il primo `false` e portare il
secondo a `true` solo dopo aver verificato il percorso backend.

- [ ] Leggere la configurazione Auth completa di staging e produzione, incluso
  `subtype` (`FIREBASE_AUTH` o `IDENTITY_PLATFORM`) e valori correnti, senza
  modificarla.
- [ ] Verificare in staging che `deleteMyAccount` completi pulizia e chiamata
  Admin SDK con login recente, conservando rate limit e blocco admin.
- [ ] Impostare in staging soltanto
  `client.permissions.disabledUserDeletion=true`, con update mask mirata e
  snapshot di rollback; non cambiare `disabledUserSignup`.
- [ ] Dimostrare che `user.delete()` e `accounts:delete` con ID token utente
  falliscono con `auth/admin-restricted-operation`.
- [ ] Dimostrare che `deleteMyAccount` continua a eliminare Auth e dati e che il
  trigger `onDelete` non produce doppio cleanup.
- [ ] Eseguire regressione completa di signup password, Google e Apple: la
  disabilitazione della cancellazione non deve alterare la registrazione.
- [ ] Aggiornare web/iOS per gestire con messaggio generico l'errore soltanto se
  esiste ancora un percorso client diretto; il prodotto deve usare sempre la
  callable.
- [ ] Dopo approvazione, applicare la sola flag in produzione, fare smoke con
  account QA sacrificabile e verificare audit Auth + cleanup.

Il trigger `onDelete` resta obbligatorio anche con questa flag: Console Firebase,
Admin SDK, script operativi o future migrazioni possono ancora eliminare Auth.
La flag impedisce solo la cancellazione self-service diretta del client.

### Criteri di accettazione

- cancellare direttamente un Auth user nell'emulatore elimina i dati personali
  e il support thread senza lasciare un profilo ricercabile;
- ripetere il cleanup restituisce successo e contatori zero, non errori;
- il self-delete continua a richiedere login recente e non puo cancellare admin;
- con la flag attiva il delete client fallisce, mentre `deleteMyAccount` riesce;
- il pannello non presenta un orfano come "nuovo iscritto attivo";
- una cancellazione esterna parzialmente fallita resta visibile come `failed` e
  puo essere ripresa;
- nessuna informazione privata viene resa leggibile dalle Firestore Rules.
- una lettura QA autorizzata e rintracciabile per UID e IP nei Cloud Audit Logs;
- query/listener sono descritti correttamente come target, senza promettere una
  falsa granularita per-documento.

### Rollback

- il trigger puo essere rimosso senza cambiare il formato dei profili;
- il modulo condiviso deve conservare un adapter per la callable esistente;
- non cancellare `accountDeletionRequests`: serve a riprendere operazioni
  fallite e a verificare la migrazione.

## Release 2 — Esperienza di verifica email su web e iOS

Priorita: alta. Deve precedere l'enforcement server della Release 3.

### Flusso password

1. L'utente compila email, password, nome, eta e termini.
2. Il client crea il record Firebase Auth.
3. Il client registra il pending signup tramite callable App Check e invia il
   link di verifica Firebase.
4. Il client mostra uno stato dedicato "Controlla la tua email", con indirizzo
   mascherato, reinvio con cooldown, cambio email/annulla ed esci.
5. Dopo il click, il client esegue `reload()` dell'utente e force refresh del
   token (`getIdToken(true)` / equivalente iOS).
6. Solo con `email_verified == true` chiama `completeVerifiedSignup`.
7. Il server crea una sola volta profili, username, consenso, attribution,
   support thread e notifica admin; poi il client entra in Home/onboarding.

Usare un link, non un codice numerico custom. Configurare un dominio email
Somto e il template solo dopo verifica DNS e test su staging. Il link deve
gestire apertura nello stesso device, in un altro device, scadenza, link gia
usato e sessione assente.

### Compatibilita legacy

- [x] I client riconoscono `legacyEmailUnverified` e permettono l'accesso durante
  la finestra di migrazione mostrando un invito non bloccante alla verifica.
- [x] I nuovi password non verificati non devono essere confusi con legacy.
- [x] Login Google/Apple invariato nel caso normale; provider senza email
  verificata fallisce con messaggio semplice e telemetria tecnica.
- [x] Non segnare `signup_completed` finche `completeVerifiedSignup` non ha
  risposto con successo.
- [x] Non avviare onboarding, push registration o support chat durante pending.

### UX minima da coprire

- email inviata, reinvio in cooldown, offline, email gia in uso;
- link scaduto/non valido, link aperto su altro device, sessione scaduta;
- verifica completata ma callable temporaneamente indisponibile: retry
  idempotente, senza perdere nome/consensi;
- cambio account e logout dal pending;
- VoiceOver/Dynamic Type su iOS e tastiera/focus su web;
- copy italiano/inglese riusando le chiavi esistenti quando possibile.

### Gate di rilascio

- PWA verificata su emulatori e staging;
- nuova build iOS verificata su simulatore e device/TestFlight;
- nessun enforcement server finche la versione iOS compatibile non ha una
  finestra di adozione concordata;
- monitorare errori di invio link, completamento e retry.

## Release 3 — Provisioning ed enforcement server

Priorita: alta, ma attivazione differita.

### Callable server-authoritative

#### `registerPendingSignup`

- richiede Auth e App Check;
- accetta solo account provider `password` non ancora verificati;
- valida nome, eta, accettazione termini e attribution;
- scrive solo `pendingSignups/{uid}` server-only;
- rate limit per UID e, dove disponibile nei log di sicurezza, difese aggregate;
- non crea `users`, `usersPrivate`, chat o notifiche.

#### `completeVerifiedSignup`

- richiede Auth, App Check e token fresco con `email_verified == true`;
- rilegge anche Firebase Auth con Admin SDK prima del provisioning;
- accetta password verificata oppure provider social approvato;
- usa transazione/idempotency marker per impedire doppio username, doppia chat,
  doppia notifica e doppio conteggio metriche;
- valida e riserva il display name con la policy corrente;
- crea/aggiorna `users`, `usersPrivate`, consenso, attribution e stato pending;
- rimuove `legacyEmailUnverified` preservando gli altri custom claims;
- restituisce `created`, `alreadyCompleted` e lo stato canonico.

### Trigger Auth create

Modificare `ensureUserDocsOnAuthCreate` soltanto dopo la distribuzione client:

- social verificato: puo continuare il provisioning compatibile o delegarlo alla
  stessa funzione idempotente;
- password non verificata: nessun profilo/chat/notifica;
- password gia verificata o import amministrativo: percorso esplicito e testato;
- profilo guidato: invariato, non e un Auth signup.

### Firestore Rules

Aggiungere helper simile a:

```text
isVerifiedOrLegacy() = authenticated && (
  request.auth.token.email_verified == true ||
  request.auth.token.legacyEmailUnverified == true
)
```

Applicarlo alle superfici che trasformano l'account in utente applicativo:
creazione profilo, directory utenti, social, messaggi, rating, liste, import e
altre scritture sensibili. Non modificare tutto in un unico commit: preparare
una matrice collection x read/create/update/delete, aggiungere test rules e
chiudere per slice.

`pendingSignups` deve essere deny-all ai client. La callable usa Admin SDK.

### Scadenza degli account pending

Job schedulato giornaliero o meccanismo equivalente:

- lista gli Auth password non verificati piu vecchi di 72 ore;
- salta `legacyEmailUnverified`, admin e account esplicitamente esclusi;
- dry-run e metriche prima dell'attivazione;
- elimina Auth; il trigger `onDelete` riconcilia pending e dati residui;
- rate/limitazione per non fare cancellazioni massive per errore;
- alert e circuit breaker se il numero supera una soglia assoluta o percentuale.

### Migrazione legacy

1. Congelare cutoff e conteggi correnti.
2. Eseguire script claim in dry-run, con revisione account admin.
3. Applicare il claim in batch piccoli e verificare che i claims esistenti siano
   invariati.
4. Distribuire client che capiscono il claim.
5. Attivare provisioning solo-verificati per i nuovi account.
6. Tenere una finestra di 60-90 giorni con prompt morbido per i legacy.
7. Misurare quanti legacy attivi verificano e contattare gli utenti recuperabili.
8. Annunciare la data di sunset; poi richiedere verifica per le azioni sensibili.
9. Rimuovere il claim solo quando verificato o a fine policy, mai con un bulk
   non reversibile senza manifest.

### Gate di enforcement

- almeno una versione web e iOS compatibile distribuita;
- nessun account admin dipende dal bypass non verificato;
- script legacy verificato con dry-run e rollback;
- suite Rules verde;
- test emulator di trigger/callable verde;
- dashboard distingue nuovi pending da legacy;
- rollback testato prima del deploy Rules.

## Release 4 — Osservabilita, provenienza e abuso

Priorita: media. Non blocca la correzione del lifecycle.

### Attribuzione prodotto

Raccogliere al completamento verificato:

- web/iOS e versione app;
- landing path interno;
- hostname referrer;
- UTM source/medium/campaign;
- lingua e stato consenso analytics;
- domanda facoltativa nell'onboarding: "Come hai conosciuto Somto?" con valori
  brevi e aggregabili (ricerca, social, passaparola, TV Time, articolo, altro).

Questi dati rispondono a "come e perche e arrivato", non a "chi ha attaccato".
Un valore client puo essere assente o falsificato e va mostrato come
attribuzione, non come prova.

### Telemetria sicurezza

- valutare upgrade Firebase Authentication with Identity Platform per user
  activity logging, protezioni Auth/App Check e futura MFA TOTP admin;
- prima dell'upgrade verificare prezzi, quota, rollback, compatibilita e
  configurazione del progetto `gia-visto`;
- tenere i log in Cloud Logging con accesso ristretto e retention documentata,
  senza copiarli indiscriminatamente in Firestore;
- integrare i Firestore Data Access Audit Logs attivati in Release 1 con gli
  activity log Auth (`SignUp`, `SignIn`, `DeleteAccount`): sono due flussi
  diversi e servono entrambi per ricostruire una timeline;
- creare alert su spike di signup, cancellazioni immediate, errori di verifica,
  domini riservati e rapporto pending/completed;
- impostare soglie dopo 1-2 settimane di baseline, non sulla base dei due soli
  eventi;
- mantenere App Check per le nuove callable; l'enforcement Auth web e una
  barriera aggiuntiva, non una garanzia contro automazione reale.

### Metriche minime nel pannello

- Auth created, pending, verified completed, expired/deleted;
- provider e superficie;
- conversione pending -> verified;
- tempo mediano alla verifica;
- primo evento utile e tempo al primo evento;
- orphan e auth-only da riconciliare;
- cancellazioni self-service vs dirette Auth;
- percentuale unknown per attribution, senza inventare una provenienza.

## Release 5 — Separazione profilo pubblico/privato

Priorita: hardening separato. Non accorpare all'incidente.

Finding attuale: `users/{uid}` e leggibile per intero dagli utenti autenticati e
contiene piu metadati di quelli necessari a una directory pubblica. Non e
possibile dimostrare se i due account li abbiano letti, perche le letture non
sono loggate nel setup attuale.

### Obiettivo schema

Profilo pubblico minimo:

- uid, displayName/handle, avatar;
- badge e contatori scelti esplicitamente come pubblici;
- nessun `lastActiveAt`, consenso/policy, telemetria onboarding, gusto privato o
  metadato di engagement non necessario.

### Migrazione

1. Inventario campo-per-campo e classificazione public/private/server-only.
2. Nuovo reader compatibile e dual-write temporaneo.
3. Backfill con dry-run, conteggi e manifest.
4. Verifica web/iOS/functions.
5. Tightening Rules per collection e test di non-regressione.
6. Rimozione dei campi legacy solo dopo adozione client.
7. Rollback tramite dual-read finche la migrazione non e conclusa.
8. Per dati privati ad alto impatto, valutare read tramite callable con audit
   per-documento; mantenere accesso diretto ai soli dati intenzionalmente
   pubblici o personali gia protetti da ownership stretta.

## File coinvolti

Prima di agire rileggere almeno:

- `CLAUDE.md`
- `docs/agent-playbook/database-architect.md`
- `docs/agent-playbook/security-privacy-reviewer.md`
- per Release 2: `docs/agent-playbook/ux-reviewer.md` e
  `docs/context/IOS_CODE_STYLE.md`
- per incident/production: `docs/agent-playbook/qa-tester.md` e
  `docs/agent-playbook/code-quality-reviewer.md`
- `functions/index.js`
- `functions/modules/notifications.js`
- `functions/scripts/complete-failed-account-deletions.js`
- `firestore.rules`
- `functions/test/rules.spec.cjs`
- `public/js/services/auth.service.js`
- `public/js/pages/login.page.js`
- `public/js/api/users.api.js`
- `public/js/pages/admin-analytics.page.js`
- `ios/TwoWatch/Data/Repositories/AuthenticationRepository.swift`
- `ios/TwoWatch/Features/Auth/AuthView.swift`
- `ios/TwoWatch/App/SessionStore.swift`
- `ios/TwoWatch/Data/Repositories/UserRepository.swift`
- `docs/FIREBASE_DATA_MODEL.md`
- `docs/SECURITY.md`
- `docs/RUNBOOK.md`
- `docs/DEPLOYMENT.md`
- `docs/STAGING.md`

Non modificare `ios/TwoWatch.xcodeproj` a mano: aggiornare le sorgenti o
`ios/project.yml` e rigenerare con XcodeGen solo se necessario.

## Test richiesti

### Unit Functions

- classificazione provider/password/social e dominio riservato;
- validazione/troncamento attribution;
- provisioning idempotente e singola notifica;
- cleanup idempotente, fonte cancellazione e stato richiesta;
- preservazione custom claims;
- scheduler: cutoff, legacy/admin skip, circuit breaker;
- nessun dato sensibile nei log strutturati.

### Emulator integration

- Auth create password non verificato -> pending senza profilo;
- verifica simulata -> complete -> profili/chat/notifica una volta;
- complete senza token verificato -> permission denied;
- Auth delete diretto -> cleanup completo;
- self-delete -> niente corsa/doppio cleanup;
- errore a meta cleanup -> stato failed e retry riuscito;
- `pendingSignups` e attribution server-only;
- utente nuovo non verificato bloccato, legacy consentito durante migrazione;
- altri utenti non leggono dati privati o lifecycle.

### Configurazione cloud e staging

- lettura config IAM/Auth senza mutazioni e snapshot di rollback;
- Firestore `DATA_READ`: get, batch get, query e listener rintracciabili;
- UID Firebase e IP individuabili soltanto da ruoli IAM autorizzati;
- retention iniziale 30 giorni e misurazione volume/costo documentata;
- delete diretto SDK/REST bloccato da `disabledUserDeletion`;
- `deleteMyAccount` via Admin SDK ancora funzionante;
- signup email/Google/Apple invariati con `disabledUserSignup=false`;
- disabilitazione delle nuove flag ripristina il comportamento precedente.

### Web

- test modulo stato verifica e retry;
- signup non emette `signup_completed` prima del server;
- referrer/UTM minimizzati;
- E2E link con emulatori per quanto supportato;
- `npm test`, `npm run check:pwa-modules`, `npm run check:public`.

### iOS

- unit test ViewModel/repository per pending, resend, reload e retry;
- verifica manuale VoiceOver, Dynamic Type, offline e link cross-device;
- build da progetto rigenerato;
- non entra in Home/onboarding prima del completamento;
- legacy continua ad accedere nella finestra prevista.

### Regressione

- Google e Apple signup/login;
- reset password e reauth per delete/export;
- username reservation;
- support thread e notifiche admin;
- export e cancellazione GDPR;
- dashboard admin con active, orphan, pending, deleted e guided profile.

Comandi di base:

```bash
cd functions && npm run test:unit
cd functions && npm run test:rules
npm test
npm run check:pwa-modules
npm run check:public
npm run e2e
```

Non eseguire test locali iOS contro produzione: configurare emulatori o usare
account QA dedicati secondo `docs/LOCAL_DEVELOPMENT.md` e `docs/STAGING.md`.

## Rischi principali

- blocco accidentale dei 104 account password non verificati;
- rimozione o sovrascrittura di custom claim admin;
- doppia notifica/conteggio per retry concorrenti;
- race tra callable di cancellazione e trigger Auth onDelete;
- perdita del nome/consenso quando il link viene aperto su altro device;
- Rules troppo ampie o troppo restrittive durante la migrazione;
- cancellazione massiva errata da scheduler;
- sovrascrittura accidentale di IAM bindings o config Auth usando update non
  mirati;
- crescita inattesa di costi/volume dei `DATA_READ` log per listener realtime;
- esposizione di JWT/IP concedendo accesso troppo ampio ai log;
- interpretare una query auditata come elenco certo di ogni documento letto;
- bloccare anche signup o la callable di cancellazione impostando male i
  permessi Auth client;
- raccolta di dati non necessaria o presentazione di attribution come fatto
  forense;
- affidarsi ad App Check web come se impedisse ogni script;
- modificare contemporaneamente profilo pubblico/privato e signup, rendendo il
  rollback difficile.

## Ordine operativo e stima

1. Release 1: lifecycle + dashboard + dry-run + configurazione audit/delete in
   staging — 2-3 giorni.
2. Release 2: web/iOS verification UX — 1,5-2 giorni.
3. Release 3: callable, claims, Rules e scheduler — 1-2 giorni tecnici, poi
   2-4 settimane di finestra distribuzione/adozione prima dell'enforcement.
4. Release 4: logging/analytics e decisione Identity Platform — 0,5-1,5 giorni
   oltre agli eventuali tempi di configurazione console/DNS.
5. Release 5: migrazione public/private — progetto separato da stimare dopo
   inventario campo-per-campo.

Le stime sono indicative e non includono attese App Store, DNS o raccolta della
baseline.

## Gate che richiedono conferma esplicita di Paolo

- cancellare in produzione i due profili `gcpmap_*`;
- applicare custom claims agli utenti reali;
- deploy Firebase in staging o produzione;
- inviare una build TestFlight;
- modificare DNS/template email;
- fare upgrade a Identity Platform;
- abilitare Firestore `DATA_READ` Audit Logs in staging o produzione;
- cambiare retention, bucket, sink o IAM dei log di sicurezza;
- impostare `disabledUserDeletion` in staging o produzione;
- attivare Rules/enforcement che possono bloccare client distribuiti;
- attivare lo scheduler che elimina account pending.

## Riferimenti tecnici ufficiali

- IANA reserved domains: <https://www.iana.org/domains/reserved>
- Firebase email verification: <https://firebase.google.com/docs/auth/web/manage-users>
- Firebase custom email domain: <https://firebase.google.com/docs/auth/email-custom-domain>
- Firebase App Check: <https://firebase.google.com/docs/app-check>
- App Check enforcement: <https://firebase.google.com/docs/app-check/enable-enforcement>
- Firebase security checklist: <https://firebase.google.com/support/guides/security-checklist>
- Firestore audit logging: <https://docs.cloud.google.com/firestore/native/docs/audit-logging>
- Enable Data Access audit logs: <https://docs.cloud.google.com/logging/docs/audit/configure-data-access>
- Cloud Logging retention: <https://docs.cloud.google.com/logging/quotas>
- Cloud Logging routing: <https://docs.cloud.google.com/logging/docs/routing/overview>
- Identity Platform/Firebase Auth client permissions:
  <https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/Config>
- Identity Platform activity logging:
  <https://docs.cloud.google.com/identity-platform/docs/activity-logging>
- Firebase Delete User Data extension, utile come confronto ma non sostituisce
  la policy custom Somto: <https://firebase.google.com/docs/extensions/official/delete-user-data>

## Definition of done complessiva

- un account password non verificato non appare come iscritto e non accede ai
  dati/applicazione Somto;
- il click sul link completa il provisioning una sola volta su web e iOS;
- social login continua a funzionare senza verifica Somto duplicata;
- la cancellazione Auth diretta non lascia profili o PII orfani;
- la cancellazione Auth da SDK/REST client e bloccata e il percorso backend
  continua a soddisfare il diritto di cancellazione;
- letture Firestore future sono ricercabili per UID, IP, metodo e target entro
  la retention dichiarata, con limiti di granularita documentati;
- account e profilo possono essere cancellati senza eliminare subito il log di
  sicurezza, che resta separato e scade automaticamente;
- gli utenti legacy non vengono bloccati senza migrazione e preavviso;
- Paolo vede stato Auth, provider, verifica, provenienza disponibile e prima
  azione reale, con `unknown` quando il dato non esiste;
- sicurezza e analytics hanno minimizzazione, accessi e retention documentati;
- test unit, Rules, emulator, web, iOS e rollback sono verdi;
- documentazione e runbook riflettono il comportamento realmente deployato.
