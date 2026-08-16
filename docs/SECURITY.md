# Sicurezza — Somto

Postura di sicurezza del progetto (Firestore, Storage, Cloud Functions, PWA) e regole per chi sviluppa. Basato sull'audit del 2026-07-12 (aggiorna questo file quando cambia il modello, non solo quando trovi un bug).

Progetto Firebase: `gia-visto`. Regole in `firestore.rules` (Firestore) e `storage.rules` (Storage). Test: `functions/test/rules.spec.cjs`.

## 0. Superficie del sistema

Tre punti di enforcement, nessun altro:

1. **Firestore rules** (`firestore.rules`) — unico gate per le letture/scritture dirette da client (iOS + PWA). Se un client legge/scrive Firestore, passa da qui.
2. **Storage rules** (`storage.rules`) — unico gate per upload/download di file (avatar, poster, import grezzi).
3. **Cloud Functions** (`functions/index.js`, `functions/modules/*.js`) — logica privilegiata che gira con admin SDK (bypassa le rules di sopra) dietro un controllo `context.auth` esplicito nel codice, non nelle rules.

Non esiste un quarto livello: niente API Gateway, niente middleware custom, niente verifica di autorizzazione lato client che conti ai fini della sicurezza. Chi sviluppa un client (iOS/PWA) deve assumere che **qualunque richiesta diretta a Firestore/Storage possa arrivare da un client malevolo modificato** — la UI può nascondere un bottone, ma solo le rules possono negare la scrittura.

## 1. Modello admin

Non usiamo **custom claims** di Firebase Auth per i permessi admin. Il modello è interamente basato su un campo documento:

- Firestore: `users/{uid}.isAdmin == true`, verificato da `adminFlag(data)` in `firestore.rules` (riga ~43) e dagli helper `isAdmin()` / `isTrusted()` che leggono il doc utente via `get()`.
- Cloud Functions: `isAdminCaller(db, uid)` (`functions/index.js:4153`) fa lo stesso lookup lato server prima di eseguire operazioni privilegiate nelle callable (es. rebuild quiz themes, backfill, moderazione, `confirmSpoilerSuspect`).

Esiste anche un secondo ruolo, distinto da admin: `isTrusted()` (campo `users.trusted`) e `levelValue()` (`users.level`) per i permessi da curatore (editing editoriale titoli, generi, persone). `titles.create` invece è aperto a `isSignedIn()` per chiunque dal 2026-07-10 (vedi `verified-badge-and-open-title-create` in memoria) — `trusted` non è più gate di creazione, solo di editing editoriale.

**Inconsistenza nota (fail-safe, non sfruttabile)**: `storage.rules` ha un ramo per il delete di `peopleAvatars/{personId}/{fileName}` che controlla `request.auth.token.admin == true` (custom claim). Nessun punto del codebase chiama mai `admin.auth().setCustomUserClaims(...)` — verificato (`grep -r setCustomUserClaims functions/` non trova nulla). Il claim non esiste mai su nessun token, quindi quel ramo è **morto**: nessun utente, incluso un admin reale via `isAdmin`, può cancellare quell'asset. Effetto: fail-closed (nessuno può fare il delete), non un buco di sicurezza. Da sistemare quando si tocca quel path (o rimuovere il ramo morto, o farlo leggere `users/{uid}.isAdmin` come ovunque altro), ma non è urgente.

**Regola per chi sviluppa**: ogni nuovo controllo di ruolo (admin/trusted/livello) va scritto come lookup del doc `users/{uid}`, mai come custom claim, per restare coerente con l'unico modello esistente e testabile in emulatore.

## 2. Collection a lettura pubblica (by design)

Le seguenti collection hanno `allow read: if true` **intenzionalmente**, perché contengono catalogo/metadati non sensibili già esposti dalle pagine pubbliche SSR (`/film`, `/serie`, `/quiz`, `/lista`) o servono al guest play:

| Collection | Perché pubblica |
|---|---|
| `titles` | Schede titolo: SSR pubbliche, ricerca/quiz da ospite, condivisione link |
| `upcoming_manual` | Calendario uscite, editoriale non sensibile |
| `genres` | Tassonomia catalogo |
| `contentCategories` | Tassonomia catalogo |
| `people` | Attori/registi, dati pubblici (TMDB-derived) |
| `quizMeta` | Aggregato titoli con quiz giocabili (`quizMeta/themes`) — **nessuna risposta o spoiler dentro** |
| `leaderboard_weekly` | Classifica denormalizzata, sola lettura |
| `leaderboard_allTime` | Classifica denormalizzata, sola lettura |

Tutte hanno write ristretto (`isAdmin()`/`isTrusted()` o `if false`, scritte solo da Cloud Function con admin SDK). **Verificato**: zero occorrenze di `allow write: if true` o `allow create: if true` in tutto `firestore.rules` — nessuna collection è scrivibile senza autenticazione/ruolo.

Ogni altra collection (ratings, posts, threads, userLists, imports, ecc.) richiede `isSignedIn()` come minimo. Alcune restringono ulteriormente per ownership/relazione (es. DM solo tra i due partecipanti, `quizInvites` deny-total ai client — solo Cloud Function admin SDK).

## 3. Callable pubbliche (no auth richiesta)

Le seguenti Cloud Functions sono chiamabili **senza** `context.auth`, by design:

- `getGuestQuiz`, `submitGuestQuiz` — quiz da ospite (`functions/index.js`), server-authoritative: le domande servite non includono mai `correctAnswerIndex`/`explanation`; la validazione avviene solo server-side. Nessuna scrittura utente, nessuna anonymous-auth, cap 10 domande/call.
- `quizInvitePreview` — landing pubblica invito quiz esterno.
- `shareTitlePreview` — anteprima condivisione titolo.
- `titlePage`, `sitemapTitles`, `sitemapQuiz`, `sitemapLists`, `listPage`, `quizPage` — pagine SSR/sitemap pubbliche (HTTP function via hosting rewrite).

Tutte le altre ~40 callable in `functions/index.js` controllano `context.auth` (uid) prima di procedere. Rate limiting per-utente è implementato in `functions/lib/rateLimiter.js` (`enforceCallableRateLimit`, contatore transazionale su `users/{uid}/_system/rateLimit_{bucket}`, finestra + cap giornaliero, default 4 chiamate/12s e 160/giorno se non specificato) ed è usato in ~28 punti (`tmdbProxy`, `enrichTitleAssets`, `applyTitleStateAction`, `createTitlesImportUploadSession`, `sendThreadMessage`, `startTraktImport`, ecc.).

**Lacuna nota**: `getGuestQuiz`/`submitGuestQuiz` **non hanno rate limit** (non essendo autenticate, non c'è un `uid` su cui appendere il contatore per-utente). Mitigazione parziale: answer-key mai esposta, cap 10 domande/call. Rischio: scraping del pool domande o abuso di risorse (letture Firestore) da IP anonimo. Backlog: valutare Firebase App Check o un rate-limit per IP (es. header + Cloud Armor, o contatore su hash IP con TTL).

## 4. Pattern da non replicare: allowlist email hardcoded

`getPersonalAdminAnalytics` (`functions/index.js`, costante `PERSONAL_ANALYTICS_ALLOWED_EMAIL` intorno alla riga 10715) fa il gate su una singola email hardcoded nel codice, invece che su `users.isAdmin`/`users.trusted`. Funziona (è un endpoint personale, non uno strumento condiviso), ma **non è il pattern da seguire per nuove funzioni**: qualunque nuova callable ad accesso ristretto deve usare `isAdminCaller(db, uid)` come tutte le altre, non una stringa email in una costante. Se in futuro serve un ruolo intermedio, aggiungerlo come campo su `users/{uid}` (come `verified`/`trusted`), non come allowlist statica nel codice.

## 5. Item aperti (priorità media)

1. **CSP solo Report-Only** (`firebase.json`): l'header attivo è `Content-Security-Policy-Report-Only`, non `Content-Security-Policy` — non blocca nulla, solo logga violazioni. Contiene inoltre `'unsafe-inline'` su `script-src`/`style-src`, che vanifica gran parte della protezione anti-XSS anche se venisse promossa a enforcing. Serve un giro di hardening (nonce/hash sugli inline script, poi flip a enforcing) prima di considerarla protezione reale.
2. **Guest quiz senza rate limit** — vedi §3.
3. **Vulnerabilità transitive moderate**: il refresh del 2026-08-16 ha
   eliminato tutti i finding high/critical compatibili senza downgrade.
   Restano advisory moderate nella catena `firebase-admin`/Google Cloud per i
   quali `npm audit` propone cambi major o downgrade non sicuri. Dependabot e
   CodeQL sono configurati; aggiornare quando la catena upstream pubblica una
   versione compatibile e rieseguire unit/rules test prima del merge.

## 6. Item già risolti (audit precedente, 2026-06-14)

- `ratings` read: era pubblico, ristretto a `isSignedIn()`.
- Open redirect: parametri di redirect lato web ora passano da `sanitizeInternalPath()` (`public/js/utils/url.js`) — blocca URL assoluti cross-origin, `//evil.com` (protocol-relative) e schemi tipo `javascript:`, ammette solo path interni stesso-origin.

Tenere questa sezione aggiornata: quando chiudi un item del §5, spostalo qui con data e descrizione della fix, invece di cancellarlo — serve a chi farà il prossimo audit per non riaprire la stessa domanda.

## 7. Segreti

- **Mai committare segreti nel repo.** `functions/.env`, `functions/.env.gia-visto`, `functions/.env.production` sono in `.gitignore` (pattern `.env`, `.env.*`, `functions/.env*`) e contengono le credenziali Trakt/Brevo/TMDB server-side.
- La **Firebase Web config** (apiKey, authDomain, projectId, ecc.) è pubblica **by design**: non è un segreto, è identificativa del progetto e protetta dalle Firestore/Storage rules, non dalla sua segretezza.
- **Chiave TMDB client-side — footgun documentato, non attivare mai**: `public/js/api/tmdb.api.js` ha un fallback `window.tmdbConfig?.apiKey || ""` pensato per uno scenario di sviluppo locale. Se qualcuno popola `window.tmdbConfig.apiKey` con una chiave TMDB reale in produzione, quella chiave finisce nel bundle servito al browser, leggibile da chiunque. **Non impostare mai `tmdbConfig.apiKey` in un ambiente pubblicamente servito**: le chiamate TMDB in produzione passano dalla callable `tmdbProxy` (server-side), che è l'unico punto autorizzato a tenere la chiave.
- Vedi anche `docs/SECRETS_REMEDIATION_CHECKLIST.md` per il playbook di remediation in caso di leak sospetto (rotazione chiave, audit accessi, comunicazione).

## 8. Storage rules — limiti per path

Ogni path scritto da utenti ha size cap + content-type check + scoping per uid (`storage.rules`):

| Path | Cap size | Content-type | Note |
|---|---|---|---|
| `avatars/{userId}/...` | 2 MB | immagine | owner-only write/delete |
| `posters/{userId}/...` | 6 MB | immagine | owner-only write/delete |
| `reviewPhotos/{userId}/...` | 6 MB | immagine | owner-only write/delete |
| `peopleAvatars/{personId}/...` | 300 KB | jpg/png/webp/gif (no SVG, anti-XSS via `foreignObject`/script) | delete gated su custom claim admin — vedi §1, di fatto irraggiungibile |
| `manualImports/{userId}/{importId}/...` | 50 MB | json/csv whitelisted per filename | write solo se l'import Firestore corrispondente è `status:"uploading"` |
| `supportImports/{userId}/...` | 30 MB | qualunque (MIME variabile su iOS Safari) | rescue upload, owner-only |
| `listCovers/{listId}/...` | — | — | read pubblico/condizionato a visibilità lista, write sempre `false` (scritto solo da Cloud Function) |
| tutto il resto (`{allPaths=**}`) | — | — | `allow read, write: if false` — default deny |

Nota SVG: il blocco esplicito su `peopleAvatars` è l'unico path con whitelist di content-type stretta senza SVG — gli altri path immagine (`avatars`, `posters`, `reviewPhotos`) accettano `image/.*` generico via `isImageUpload()`. Se in futuro emerge un vettore XSS via SVG su uno di questi path, applicare lo stesso pattern di whitelist esplicita.

## 9. Campi server-owned: pattern e checklist

Esempi di campi o documenti che un client non deve mai poter scrivere direttamente: `users.stats` (contatori aggregati, scritti solo dai trigger `recomputeUserStatsFromTitleStates`/`recomputeUserStatsFromListProgress`), `users.isAdmin`/`users.verified`/`users.trusted`, `titles.ratingAggregate`/`titles.emotionAggregate` (denormalizzati dai trigger `recomputeTitleRatingAggregate`/`recomputeTitleEmotionAggregate`), `titles/{titleId}/episodeEmotionAggregates/*` (trigger gen2 `recomputeEpisodeEmotionAggregate`), `userLists.followersCount` (trigger `syncListFollowersCount`).

Il pattern nelle rules è sempre lo stesso: un helper `xServerFieldsUnchanged(before, after)` che confronta i valori pre/post e nega l'update se il client ha provato a toccarli, richiamato dentro il blocco `allow update`. **Checklist quando aggiungi un nuovo campo aggregato/calcolato**:

1. Il trigger/Cloud Function che lo scrive usa admin SDK (bypassa le rules) — verifica che NON esista un path client che lo scriva anche in buona fede.
2. Aggiungi il campo al guard `*ServerFieldsUnchanged` corrispondente (o creane uno nuovo) in `firestore.rules`.
3. Aggiungi un test in `functions/test/rules.spec.cjs` che tenta di scriverlo dal client e verifica il deny.
4. Se il campo parte da uno stato vuoto su documenti storici, valuta se serve un backfill (`scripts/backfill-*.js`, pattern dry-run default + `--write`).

## 10. Regole per chi sviluppa

- **Mai fidarsi del frontend** per permessi, ownership o privacy. Ogni check di autorizzazione deve vivere nelle rules (Firestore/Storage) o nel codice server delle Cloud Functions, mai solo nella UI.
- **Ogni collection nuova parte da default deny.** Prima di leggere/scrivere una nuova collection dal client, scrivi le rules corrispondenti e i test in `functions/test/rules.spec.cjs`. Nessuna eccezione "la aggiungo dopo".
- **Campi server-owned restano congelati nelle rules** — vedi §9.
- **PII mai nei log** (`logger.info/error` in Cloud Functions): niente email, token, contenuto import grezzo. Solo uid/id documento/contatori.
- **Test rules obbligatori** prima di ogni deploy che tocca `firestore.rules` o `storage.rules`: `cd functions && npm run test:rules` (usa l'emulatore Firestore+Storage, richiede JDK 17+). Non dedurre il comportamento delle rules leggendole: verificale in emulatore.
- **Non modificare Firestore schema, rules, indexes o Cloud Functions senza proposta esplicita di sicurezza e migrazione** (vedi anche `CLAUDE.md` root).
- **Non introdurre allowlist email hardcoded** per nuovi permessi — vedi §4.

## 11. Verificare le rules live vs quelle nel repo

Il repo può divergere dal deployato (è già successo, vedi incidente rules 2026-07-02 in memoria di progetto: rules + hosting deployati dal working tree senza commit). Prima di diagnosticare un problema di permessi in produzione, scarica il ruleset **effettivamente attivo**:

```bash
# Token da Application Default Credentials (utente con accesso al progetto gia-visto)
TOKEN=$(gcloud auth application-default print-access-token)

# Elenca i ruleset e trova quello release corrente per cloud.firestore
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://firebaserules.googleapis.com/v1/projects/gia-visto/rulesets" | less

# Scarica il contenuto di un ruleset specifico (sostituisci RULESET_ID)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://firebaserules.googleapis.com/v1/projects/gia-visto/rulesets/RULESET_ID" | less
```

Confronta l'output con `git show HEAD:firestore.rules` (o `storage.rules`). Se divergono, il deploy vivo vince come fonte di verità finché non fai un deploy allineato al repo — non assumere mai che "quello che c'è in `main`" sia quello che gira in produzione senza controllarlo.

Per un sospetto specifico su un permesso negato in prod (es. "perché questo utente prende permission-denied"), riprodurre con una richiesta REST diretta usando le credenziali dell'account coinvolto è più affidabile che leggere le rules a occhio — vedi il caso reale documentato in `rating_star_floor_incident.md` (memoria di progetto).

## Riferimenti

- `firestore.rules`, `storage.rules` — sorgente delle regole.
- `functions/test/rules.spec.cjs` — suite test rules (emulatore).
- `docs/SECRETS_REMEDIATION_CHECKLIST.md` — playbook remediation leak.
- `docs/watchlist-custom-lists-security-plan.md` — piano sicurezza liste custom (contesto storico).
