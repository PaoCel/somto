# Sviluppo locale

Guida pratica per lavorare sul repo in locale. Per il quadro architetturale vedi `docs/ARCHITECTURE.md`.

## Prerequisiti

- **Node 22+** — richiesto da `functions/package.json` (`engines.node: "22"`) e da `functions-public-profile/package.json`. Verifica: `node --version`.
- **JDK 21** — necessario solo per far girare gli emulatori Firestore/Storage (usati dai test rules e dalla suite e2e). La CI (`.github/workflows/ci.yml`) usa esplicitamente `java-version: 21` (Temurin).
- **firebase-tools** — CLI Firebase (`npm install -g firebase-tools`, o eseguibile locale). Serve per emulatori e deploy.
- **Xcode 15+** e **XcodeGen** (`brew install xcodegen`) — solo per l'app iOS. `ios/project.yml` richiede `minimumXcodeGenVersion: 2.38.0`.

## Setup

```bash
git clone <repo>
cd somto

# dipendenze root (script deploy, esbuild, playwright, satori/resvg per OG image)
npm install

# Cloud Functions (codebase "default")
cd functions && npm install && cd ..

# blog editoriale (Eleventy)
cd blog && npm install && cd ..
```

`functions-public-profile/` (la seconda codebase Functions) ha già `node_modules`/`package-lock.json` propri nel repo; se mancano o servono aggiornati: `cd functions-public-profile && npm install`. Serve solo se devi deployare/testare quella codebase — non è coinvolta nei test standard di `functions/`.

Non c'è build step per la PWA in sviluppo: i file in `public/` sono serviti così come sono (HTML + ES modules), niente bundler da lanciare prima di aprire una pagina.

## Sviluppo web (PWA)

### Opzione A — Emulatori Firebase (consigliata)

```bash
firebase emulators:start
```

Usa le porte dichiarate in `firebase.json` (non le default di firebase-tools): Auth `59099`, Firestore `58080`, Storage `58081`, Hosting `5500`, Hub `58400`, Logging `58401`. Con l'Hosting emulator attivo, apri `http://127.0.0.1:5500`.

`public/js/firebase.js` collega l'SDK Firebase agli emulatori **solo se richiesto esplicitamente**: apri una pagina con `?emulators=1` in querystring (il flag viene salvato in `localStorage` e resta attivo alle navigazioni successive) oppure imposta `window.__USE_FIREBASE_EMULATORS__ = true` prima del caricamento. Per tornare a puntare Firebase reale: `?emulators=0` (rimuove il flag salvato).

Il progetto usato dagli emulatori in questa modalità è quello di default (`gia-visto` per alias, ma è solo un identificatore locale: nessun dato reale viene toccato quando gira in emulatore). Per un progetto demo isolato esplicito, passa `--project demo-2watch` a `firebase emulators:start` (è quello usato dalla suite e2e).

### Opzione B — Server statico contro Firebase reale

È possibile servire `public/` con un qualunque server statico (es. `npx serve public`) senza emulatori. **Rischio**: senza il flag `?emulators=1`, `public/firebaseConfig.js` punta al progetto reale in base all'hostname — su `localhost` questo significa **prod (`gia-visto`)**. Ogni scrittura (rating, watchlist, post, ecc.) fatta così tocca dati reali di utenti reali. Usare solo per QA mirata con un account di test dedicato, mai per sviluppo/debug generico di feature che scrivono dati.

## Test

Tutti i comandi test vanno lanciati da `functions/` (tranne l'e2e):

```bash
cd functions

npm run test:unit    # 416 test, node:test puro, nessun emulatore richiesto
npm run test:rules   # 120 test sulle Firestore/Storage rules, richiede JDK (wrappa firebase emulators:exec)
npm test             # equivalente a test:unit && test:rules
```

E2E (Playwright, dalla root del repo):

```bash
npm run e2e:install   # una tantum: scarica Chromium per Playwright
npm run e2e           # firebase emulators:exec (auth+firestore+storage+hosting, project demo-2watch) → seed dati → playwright test
```

## iOS

```bash
cd ios
xcodegen generate
```

Poi apri `TwoWatch.xcodeproj` in Xcode e builda il target `TwoWatch` (Debug, simulatore o device). Il progetto Xcode è generato: non editarlo a mano, modifica `ios/project.yml` e rilancia `xcodegen generate`.

`FirebaseConfig.plist`/`GoogleService-Info.plist` sono committati e puntano a **prod** (`gia-visto`) con `USE_EMULATORS=false`: in Debug locale l'app parla comunque col backend reale, salvo cambiare manualmente `USE_EMULATORS`/`EMULATOR_HOST`/porte nel plist per puntare agli emulatori.

Comandi archive + upload TestFlight (da `ios/`):

```bash
xcodebuild archive -project TwoWatch.xcodeproj -scheme TwoWatch -configuration Release \
  -archivePath build/Somto-<tag>.xcarchive -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates

xcodebuild -exportArchive -archivePath build/Somto-<tag>.xcarchive \
  -exportPath build/Somto-<tag>-export -exportOptionsPlist ExportOptions-AppStore.plist \
  -allowProvisioningUpdates
```

`ExportOptions-AppStore.plist` ha `destination: upload`, quindi `-exportArchive` carica direttamente su TestFlight/App Store Connect (team `787YK9YUB3`). Prima di ogni archive: bump di `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in `ios/project.yml` e rigenerazione (`xcodegen generate`).

## Blog

```bash
cd blog
npm install     # una tantum
npm run build   # genera HTML statico in ../public/blog/ (committato)
npm run serve   # dev server Eleventy con live reload
npm run clean   # rm -rf ../public/blog
```

`public/blog/` va rigenerato e committato dopo ogni modifica agli articoli in `blog/src/articoli/` — non si edita a mano.

## Variabili d'ambiente Functions

`functions/.env`, `functions/.env.production`, `functions/.env.gia-visto` **non sono versionati** (`functions/.gitignore` esclude `*.env` e `*.env.*`) e vanno creati a mano in locale. Chiavi lette dal codice (`process.env.*` in `functions/index.js`/`lib/`/`modules/`), senza valori:

- `ADMIN_UIDS` — UID separati da virgola con permessi admin nelle Functions.
- `SUPPORT_UID` — UID dell'account di supporto (chat assistenza).
- `TMDB_KEY` (e tuning opzionale `TMDB_IMPORT_LIMIT_PER_RUN`, `TMDB_IMPORT_RECENT_PAGE_WINDOW`, `TMDB_IMPORT_PAGES_PER_TYPE`, `TMDB_IMPORT_MIN_REQ_GAP_MS`, `TMDB_IMPORT_MAX_API_CALLS`) — chiave TMDB per import/enrichment metadati.
- `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` — app OAuth Trakt per l'import device-flow.
- `OPENAI_API_KEY` / `OPENAI_MODEL` — opzionali, hook LLM per i profili guidati (`GUIDED_LLM_ENABLED` per attivarlo; senza chiave il generatore usa i template di fallback).

Il file `.env.example` in root elenca lo stesso tipo di chiavi come riferimento/template (mai valori reali). Senza queste env, gran parte delle Functions gira comunque per i test unit/rules (che mockano o non toccano questi path); servono per emulare/testare import TMDB/Trakt o funzionalità admin end-to-end.

## Git hooks

```bash
scripts/hooks/install.sh
```

Da rilanciare **dopo ogni clone fresh** (imposta `git config core.hooksPath scripts/hooks`). Attiva un pre-commit che blocca i commit Swift che introducono `Dictionary(uniqueKeysWithValues:)` su chiavi derivate (lowercase, normalizzate, hash, slug...) invece di `.id`/`.uid`/`.titleId`/`.documentID` — pattern che ha già causato un crash in produzione (v0.3.22, vedi `CLAUDE.md`). Non bypassare con `--no-verify` se non per emergenza giustificata.
