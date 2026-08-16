# Smoke test Cloud Functions (callable auth gate + triggers)

Setup una-tantum:
```bash
cd scripts/test-functions
npm install
```

Esecuzione (richiede JDK 21 + functions deps installate):
```bash
# Terminale 1 — emulator full stack
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
cd /path/to/somto
# functions/node_modules deve essere presente: cd functions && npm install
firebase emulators:start --only functions,auth,firestore --project gia-visto

# Terminale 2 — auth gate
cd scripts/test-functions
npm test            # run.mjs

# Terminale 2 — triggers (skip by default - vedi limitazione sotto)
node triggers.mjs
```

## Cosa copre `run.mjs`
- `tmdbProxy` senza auth -> unauthenticated
- `tmdbProxy` con auth -> supera il gate (no unauthenticated)
- `enrichTitleAssets` senza auth -> unauthenticated
- `getWatchProviders` senza auth -> unauthenticated
- `confirmSpoilerSuspect` senza auth -> unauthenticated
- `confirmSpoilerSuspect` signed-in non-admin -> permission-denied

## Cosa copre `triggers.mjs`
- `flagSuspectedSpoilerPost` -> moderationQueue entry creata
- `recomputeTitleRatingAggregate` -> titleLevel + bySeason + combined

**SKIP DI DEFAULT** per limitazione nota (vedi sotto). Per forzare:
```bash
SOMTO_FORCE_TRIGGER_TESTS=1 node triggers.mjs
```

## Limitazione nota — `admin.firestore.FieldValue` undefined nell'emulator

Quando il functions emulator esegue codice Somto che chiama
`admin.firestore.FieldValue.serverTimestamp()` (presente in `lib/rateLimiter.js`
e in vari trigger), tira `TypeError: Cannot read properties of undefined
(reading 'serverTimestamp')`.

Causa (verificata 2026-05-21):
- `firebase-tools` emulator wrappa `admin` in un `Proxy` che intercetta
  `admin.firestore` con `Proxied.getOriginal(target, "firestore")`. Per le
  funzioni torna `value.bind(target)`. Il bind perde le proprieta' attaccate
  via `Object.assign` / `Object.defineProperty` nel getter `firestore` di
  `firebase-admin/lib/app/firebase-namespace.js`.
- In produzione (Cloud Functions runtime) non c'e' Proxy stub -> tutto funziona.

Effetto sui test:
- `tmdbProxy con auth -> OK`: il gate auth pass, ma il rate limiter dentro la
  callable tira `internal`. Il test e' lenient: pass se NON e' `unauthenticated`.
- Tutti i trigger Somto sono affetti -> `triggers.mjs` skip di default.

Workaround proposto (NON applicato — richiede modifica prod code):
- Migrare `admin.firestore.FieldValue` -> `require("firebase-admin/firestore").FieldValue` in
  `lib/rateLimiter.js`, `lib/feedEvents.js`, `lib/titleStates.js`, e nelle
  ~50 occorrenze in `index.js`. Equivalente in prod, ma fa il `require()`
  del modulo concreto prima che il Proxy sovrascriva il namespace.

Region functions: `europe-west1`. Porte: functions 5001, auth 59099,
firestore 58080.
