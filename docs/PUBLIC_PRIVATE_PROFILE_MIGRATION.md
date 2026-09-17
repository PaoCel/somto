# Separazione profilo pubblico, privato e server-only

Stato: **PROPOSTA DI SICUREZZA E MIGRAZIONE — non attiva**

Data inventario: 2026-08-23

Verdict: **PASS WITH CONCERNS**

## Finding

`users/{uid}` e oggi leggibile integralmente da qualunque utente autenticato.
Il documento e contemporaneamente profilo pubblico, sorgente di autorizzazione,
stato di presenza e contenitore legacy di consenso, onboarding, gusto ed
engagement. Le Rules congelano molti campi ma non possono nasconderne una parte:
una lettura Firestore restituisce sempre l'intero documento.

Web e iOS leggono `users/{uid}` direttamente. Le Cloud Functions lo usano anche
per scheduler, analytics, ruoli e contatori. Stringere subito la read rule o
rimuovere campi romperebbe client distribuiti e job backend.

## Classificazione campo per campo

La classificazione e fail-closed: un campo non elencato non entra nella
proiezione pubblica. `Pubblico` significa leggibile agli utenti autenticati,
come la directory attuale; non implica indicizzazione web anonima.

| Campo corrente | Uso corrente | Destinazione proposta | Motivazione |
|---|---|---|---|
| document ID / `uid` | identita e link profilo | pubblico | chiave tecnica necessaria alla directory |
| `displayName`, `displayNameLower` | nome, handle, ricerca | pubblico | identita scelta dall'utente |
| `photoURL`, `avatarURL` | avatar | pubblico | contenuto pubblicato dall'utente |
| `bio` | descrizione profilo | pubblico | contenuto pubblicato esplicitamente; server-owned oggi |
| `verified` | badge community | pubblico | segnale pubblico intenzionale, distinto dai ruoli |
| `accountType`, `isSynthetic` | disclosure profili guidati | pubblico, proiezione server-owned | impedisce di presentare un profilo sintetico come umano |
| `stats.ratingsCount`, `stats.reviewsCount`, `stats.watchedCount` | contatori profilo | pubblico, allowlist esplicita | contatori gia mostrati nel profilo |
| `followersCount`, `friendsCount` | contatori social | pubblico solo quando la sorgente e affidabile | oggi congelati ma non mantenuti in modo completo |
| `stats.titlesCreated` | contributi catalogo | pubblico opzionale | utile come contatore creator, non per autorizzazione |
| `favoriteGenres` | gusto mostrato nel profilo | privato, salvo futuro opt-in | preferenza personale; il target del piano esclude gusto privato |
| `stats.totalWatchMinutes`, `stats.rewatchCount`, `stats.derivedRatingsCount`, `stats.byCategory` | comportamento aggregato | privato | cronologia comportamentale non necessaria alla directory |
| `createdAt` | coorti e ordinamento | privato/server analytics | non necessario al profilo pubblico |
| `lastActiveAt` | presenza, scheduler engagement | server-only | segnale di presenza indiretto |
| `privacyDefault` | preferenza privacy | privato | impostazione personale, non contenuto pubblico |
| `communitySafetyAcceptedAt`, `communitySafetyVersion`, `communitySafetyAcceptedSource` | prova accettazione policy | privato/server verificabile | consenso/policy non appartiene alla directory |
| `onboardingStatus`, `onboardingMeta` | avanzamento onboarding legacy | privato | telemetria personale; copia canonica gia in `usersPrivate` |
| `tasteProfile` | preferenze e segnali gusto legacy | privato | profilazione; copia canonica gia in `usersPrivate` |
| `engagement.*` | cooldown e lifecycle nudges | server-only | telemetria operativa, non owner-editable |
| `trusted`, `isAdmin`, `level` | autorizzazione e ruolo editoriale | server-only; eventuale badge pubblico derivato | non usare dati pubblici come fonte di autorizzazione |
| `isDeleted`, `deletedAt`, `deletionReason` e tombstone | lifecycle cancellazione | server-only | stato operativo e di compliance |
| `updatedAt` e marker di migrazione | concorrenza/backfill | server-only | metadato tecnico |
| qualunque campo futuro non elencato | sconosciuto | privato/server-only | nessuna esposizione pubblica per default |

`usersPrivate/{uid}` contiene gia `email`, `onboardingStatus`, `onboardingMeta`,
`tasteProfile`, `marketingConsent`, lingua e conferma eta. La regola corrente
valida solo `language`: prima del tightening serve un inventario analogo delle
write owner e un allowlist compatibile. I token OAuth restano nella
subcollection `integrations`, deny-all ai client.

## Schema target

### `publicUserProfile/{uid}`

Proiezione server-owned, leggibile agli utenti autenticati:

```text
schemaVersion: 1
uid
displayName
displayNameLower
photoURL
avatarURL
bio
verified
accountType
isSynthetic
publicStats: {
  ratingsCount,
  reviewsCount,
  watchedCount,
  titlesCreated?
}
updatedAt
```

Nessun client usa questa collection come fonte di autorizzazione. `trusted`,
`isAdmin` e `level` restano in custom claims o in un documento server-only; se
serve un badge visibile, il backend proietta un valore non autorizzativo.

### Dati personali e operativi

- `usersPrivate/{uid}`: dati owner-readable con schema validato per slice;
- `users/{uid}`: sorgente legacy temporanea durante la migrazione;
- `users/{uid}/_system/*`: marker e telemetria server-only gia deny-all;
- `accountDeletionRequests`, `pendingSignups` e log Cloud: lifecycle separato,
  con accesso e retention propri.

## Piano di migrazione reversibile

1. **Contratto e test puri.** Introdurre un builder allowlisted della
   proiezione pubblica e testare che campi privati/ignoti non passino.
2. **Dual-write server.** Mantenere temporaneamente `users/{uid}` come sorgente
   di scrittura. Un trigger server idempotente proietta create/update/delete in
   `publicUserProfile/{uid}`. Signup e aggiornamenti amministrativi usano lo
   stesso builder. Nessun client scrive direttamente la proiezione.
3. **Backfill dry-run.** Script dry-run di default, paginato, con conteggi
   `scanned/create/update/unchanged/invalid`, circuit breaker e progetto
   confermato. In write mode salva un manifest UID + hash prima/dopo fuori dal
   repository; batch massimi 200. Nessuna rimozione dal legacy in questa fase.
4. **Dual-read client.** Web/iOS preferiscono `publicUserProfile`, con fallback
   a `users` dietro flag di compatibilita. Per il proprio account uniscono
   esclusivamente `usersPrivate`. Directory, follower, profili e suggestion
   devono usare lo stesso adapter.
5. **Migrazione Functions.** Separare i reader pubblici dai reader operativi.
   Scheduler, ruoli, analytics e cancellazione continuano a leggere il path
   server appropriato; i payload pubblici passano solo dal builder allowlisted.
6. **Osservazione.** Misurare miss/fallback per almeno una release web e una
   versione iOS adottata. Confrontare conteggi e hash tra sorgente e proiezione.
7. **Tightening Rules.** Solo dopo il gate, consentire read autenticata di
   `publicUserProfile`, rendere la write client deny-all e limitare
   `users/{uid}` all'owner/admin o al solo server. Aggiungere test negativi per
   presenza, consenso, gusto, ruoli e campi ignoti.
8. **Rimozione legacy.** Dopo due finestre client senza fallback significativo,
   spostare/eliminare i campi non pubblici da `users`. Eseguire sempre dry-run,
   backup/manifest e batch piccoli. Non cancellare i dati privati canonici.

## Rollback

- mantenere il fallback `publicUserProfile -> users` finche il tightening non e
  stabile;
- poter disabilitare il reader nuovo e il trigger di proiezione con flag
  server/client separati;
- non rimuovere campi legacy nello stesso deploy che cambia i reader;
- conservare manifest e conteggi del backfill per ricostruire la proiezione;
- in caso di regressione Rules, ripristinare la rule precedente prima di
  disattivare il dual-write; nessun rollback deve copiare campi privati nel doc
  pubblico.

## Gate decisionale

Prima di implementare schema, dual-write o Rules servono approvazione della
slice come progetto separato, versione minima iOS supportata e scelta esplicita
dei contatori pubblici. Il tightening e un gate di enforcement perche puo
bloccare client distribuiti. Non e incluso nel rollout urgente del signup.

## Test necessari

- unit builder: allowlist completa e assenza di campi ignoti/sensibili;
- Rules emulator: lettura pubblica solo della proiezione, private owner-only,
  server-only deny-all, write proiezione negata anche all'owner;
- integration trigger: create/update/delete idempotenti e retry;
- backfill: dry-run senza write, circuit breaker, resume, manifest e rollback;
- web/iOS: profilo proprio/altrui, ricerca, follower, profili guidati, offline e
  fallback legacy;
- Functions: analytics, scheduler engagement, ruoli, notifiche, export GDPR e
  cancellazione account;
- regressione: nessuna email, presenza, consenso, gusto, engagement o ruolo raw
  nel payload/documento pubblico.

## Stima dopo inventario

Cinque slice tecniche (builder/proiezione, backfill, web, iOS/Functions, Rules)
per circa 5-8 giorni di implementazione, piu la finestra di distribuzione e
adozione iOS. Lo strip dei campi legacy e un'operazione successiva, separata e
gated.
