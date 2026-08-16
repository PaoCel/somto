# Deployment — Somto

Come si rilascia Somto: web (Firebase Hosting/Firestore/Functions) e iOS (TestFlight).
Vedi anche [`ENVIRONMENTS_AND_RELEASE_GUARDRAILS.md`](./ENVIRONMENTS_AND_RELEASE_GUARDRAILS.md) per il dettaglio
sui guardrail ambiente-per-ambiente; questo file è il riferimento operativo "come rilascio davvero".

## Principio

- **Prod = progetto Firebase `gia-visto`** (alias `prod`/`production` in `.firebaserc`, entrambi puntano a
  `gia-visto`). Si deploya **solo da `main` pulito**, con **conferma esplicita**.
- **Staging = progetto Firebase `somto-staging`** (alias `staging` in `.firebaserc`), per prove reali senza
  toccare utenti live. Staging è sul piano Blaze e `firebase.staging.json` include Functions, Firestore,
  Storage e Hosting; per feature isolate preferire comunque deploy mirati.
- Mai deploy dal working tree sporco. Incidente reale (2026-07-02, documentato in `CLAUDE.md`): rules
  deployate da un tree non committato hanno rotto la creazione liste per gli utenti iOS già in produzione
  (client rilasciato incompatibile con le nuove rules più strette). Da allora: commit + push **prima** del
  deploy, sempre.

## Comandi canonici (root `package.json`)

```bash
# Staging — stack completo, config firebase.staging.json
npm run deploy:staging
npm run deploy:staging:hosting     # solo hosting

# Prod — tutto (firestore, hosting, storage, functions), config firebase.json
CONFIRM_PROD=gia-visto npm run deploy:prod
CONFIRM_PROD=gia-visto npm run deploy:prod:hosting   # solo hosting
```

Ogni comando `deploy:*` esegue prima `node scripts/check-deploy-safety.mjs <staging|prod>` (script
`deploy:check:staging` / `deploy:check:prod`), poi lancia `firebase deploy` con `--project` risolto da
`scripts/print-deploy-project.mjs` (prod → sempre `gia-visto`; staging → `$FIREBASE_STAGING_PROJECT` o,
in fallback, l'alias `staging` di `.firebaserc`).

**Guardia prod** (`check-deploy-safety.mjs`, blocca se una condizione non è vera):
- branch corrente `main` (bypass solo con `ALLOW_NON_MAIN_PROD=1`, da annotare nel report);
- working tree pulito, `git status --porcelain` vuoto (bypass solo con `ALLOW_DIRTY_PROD=1`);
- variabile `CONFIRM_PROD=gia-visto` impostata esplicitamente;
- project id risolto deve essere `gia-visto`.

**Guardia staging**:
- `FIREBASE_STAGING_PROJECT` deve essere valorizzata (o presente l'alias `staging` in `.firebaserc`);
- non può puntare a `gia-visto` né a un project id `demo-*` (emulatori);
- working tree sporco blocca comunque, a meno di `ALLOW_DIRTY_STAGING=1` (solo per prove manuali volute,
  mai per un candidate di release).

Non esistono script `npm` per deploy parziali di prod (es. solo `firestore:rules`) — per quelli si usa la
CLI Firebase direttamente (vedi sotto), sempre con `--project gia-visto` esplicito.

## Deploy mirati manuali

Quando serve deployare solo una parte (una singola function, solo le rules, solo hosting):

```bash
firebase deploy --only functions:NOME_FUNCTION --project gia-visto
firebase deploy --only firestore:rules --project gia-visto
firebase deploy --only firestore:indexes --project gia-visto
firebase deploy --only storage --project gia-visto
firebase deploy --only hosting --project gia-visto
```

Il progetto ha **due codebase functions** dichiarate in `firebase.json`: `default` (`functions/`) e
`publicprofile` (`functions-public-profile/`). Per targettare una function della seconda codebase serve
il prefisso codebase: `firebase deploy --only functions:publicprofile:NOME --project gia-visto`.

**Regole pratiche**:
- **Mai deploy dal working tree sporco** (vedi incidente sopra). Se una sessione parallela ha modifiche non
  committate nello stesso checkout, deployare da una **worktree pulita a HEAD** (`git worktree add` in una
  directory temporanea) invece di rischiare di spedire codice non voluto — pattern già usato più volte in
  produzione, vedi CLAUDE.md "sessioni parallele stesso checkout".
- Il **full `--only functions` può abortire** se in prod esistono function deployate che non sono più nel
  source locale (Firebase tenta una delete non interattiva e si rifiuta). È già successo con feature WIP
  non committate (es. `publishOfficialUpdate`). In quel caso: **deploy targeted** solo delle function che
  servono davvero (`--only functions:a,functions:b,...`), non il full deploy.
- Un deploy che abortisce sul passo `functions` **non finalizza l'hosting** nello stesso comando: se serve
  anche l'hosting, ridare `firebase deploy --only hosting --project gia-visto` a parte.
- `functions/` richiede `npm install` fatto (incl. `functions-public-profile/node_modules` se si deploya
  da una worktree fresca) e i file `.env*` copiati (non tracciati in git, servono per i secrets locali tipo
  `TMDB_KEY`, `TRAKT_CLIENT_ID/SECRET`).

## Checklist pre-deploy prod

1. `git status --short` pulito, sei su `main`, `main` allineato con `origin/main` (push già fatto).
2. Test verdi in locale:
   ```bash
   cd functions
   npm run test:unit    # node --test ./test/unit/*.test.cjs
   npm run test:rules   # firebase emulators:exec --only firestore,storage "node --test ./test/rules.spec.cjs" (richiede JDK 21)
   ```
3. CI verde su `main` (workflow `.github/workflows/ci.yml`: job `unit`, `rules`, `blog-build` — quest'ultimo
   protegge il deploy hosting, buildando il blog Eleventy).
4. Se sono cambiati asset web (JS/CSS/HTML serviti dal service worker): **bump `VERSION`** in
   `public/service-worker.js` (riga `const VERSION = "vNN-..."`) — altrimenti i client con SW già installato
   continuano a servire cache stale.
5. Se sono cambiati articoli del blog (`blog/src/articoli/`): rebuildare **prima** del deploy hosting (vedi
   sezione Blog sotto) — l'output committato in `public/blog/` è quello che Hosting serve davvero.
6. `git status` pulito subito prima di lanciare il comando di deploy (ultima verifica, la guardia lo blocca
   comunque ma meglio saperlo prima).

## iOS — build e TestFlight

```bash
cd ios && xcodegen generate
```

Bump versione in `ios/project.yml` prima dell'archive: `MARKETING_VERSION` (es. `1.4.4`) e
`CURRENT_PROJECT_VERSION` (build number, es. `2026071206`), entrambi sotto
`PRODUCT_BUNDLE_IDENTIFIER: com.paolocelestini.twowatch.ios` / `DEVELOPMENT_TEAM: "787YK9YUB3"`.

```bash
xcodebuild archive -project TwoWatch.xcodeproj -scheme TwoWatch -configuration Release \
  -archivePath build/Somto-<tag>.xcarchive -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates

xcodebuild -exportArchive -archivePath build/Somto-<tag>.xcarchive \
  -exportPath build/Somto-<tag>-export -exportOptionsPlist ExportOptions-AppStore.plist \
  -allowProvisioningUpdates
```

`ExportOptions-AppStore.plist` ha `destination: upload` + `method: app-store-connect` + `teamID: 787YK9YUB3`
→ `exportArchive` carica **direttamente** su TestFlight, non serve un passaggio manuale. `dSYM` mancanti per
`Firebase`/`grpc`/`GoogleAppMeasurement` in fase di upload sono un warning benigno ricorrente, non un errore.

Verifica sempre un **build Debug/simulatore verde** prima di archiviare in Release. Dopo l'upload, aggiornare
la sezione "Build / TestFlight" di `CLAUDE.md` con versione, build number ed esito.

Per il trigger delle emozioni episodio, dopo il deploy mirato eseguire anche:

```bash
cd functions
node scripts/smoke-episode-emotions.js --project somto-staging
# In produzione la conferma esplicita è obbligatoria:
node scripts/smoke-episode-emotions.js --project gia-visto \
  --confirm-production gia-visto
```

Lo script usa Admin SDK e verifica Eventarc (create/update/delete + cleanup); non sostituisce i test
delle Firestore rules, che restano nella suite emulator.

## Blog

Il blog (`blog/`) è un progetto **Eleventy separato** che genera HTML statico committato in `public/blog/`
(servito da Firebase Hosting come file statici, nessun rewrite dedicato). Se sono cambiati articoli:

```bash
cd blog && npm run build
```

Farlo **prima** di `firebase deploy --only hosting` (o del deploy prod completo) — altrimenti si spedisce
la vecchia versione statica anche se le sorgenti Markdown sono aggiornate. Il job CI `blog-build` verifica
solo che la build non rompa, non pubblica nulla da solo.

## Rollback

- **Hosting**: le release precedenti restano conservate da Firebase Hosting. La CLI di questo progetto
  **non ha** un comando `firebase hosting:rollback` diretto (non presente in questa versione di
  `firebase-tools`) — il rollback si fa dalla **Firebase Console** (Hosting → cronologia release → azione
  "Rollback" sulla release precedente), oppure con `firebase hosting:clone <source-version> <target-site>`
  per clonare una release passata su un canale/sito e poi promuoverla.
- **Firestore rules**: ridistribuire il file dal commit precedente:
  ```bash
  git show <commit-buono>:firestore.rules > firestore.rules
  firebase deploy --only firestore:rules --project gia-visto
  git checkout -- firestore.rules   # ripristina il working tree a HEAD dopo il deploy
  ```
  Verificare **sempre** in emulatore prima (`npm run test:rules` con quel file), non solo per sicurezza ma
  perché client iOS già in TestFlight/App Store non si aggiornano col deploy — un rules-rollback deve
  restare compatibile anche con la build più recente rilasciata.
- **Functions**: `git checkout <commit-buono> -- functions/` (o lavorare da una worktree su quel commit),
  poi deploy targeted della/e function coinvolte. Non fare `git reset --hard`: usare worktree o checkout
  scoped per non perdere lavoro non committato nello stesso checkout.
- **Punto di ripristino noto buono**: tag `snapshot-2026-07-12-consolidamento` su `origin` (main =
  v1.4.4 build `2026071206`, prima di qualsiasi intervento di consolidamento successivo). Da usare come
  riferimento per diff/rollback se una modifica successiva risulta problematica:
  ```bash
  git diff snapshot-2026-07-12-consolidamento -- firestore.rules
  ```
- **iOS**: non esiste rollback lato App Store/TestFlight per una build già distribuita ai tester — l'unica
  leva è pubblicare una build successiva con il fix, o (se già in review/pubblicata su App Store) ritirare
  la versione dalla verifica e re-inviare (vedi precedenti in `CLAUDE.md`, es. v1.3.2 ritirata e re-inviata
  con build diversa). Per bug gravi su build già in mano agli utenti: gate `experiments/global.appUpdate.ios`
  (vedi `docs/RUNBOOK.md`, sezione Emergenze).

## Cosa NON fare mai

- Deploy da working tree sporco (prod **e** staging: la guardia lo blocca, non aggirarla senza un motivo
  reale e annotato).
- `git push --force`, `git reset --hard`, `--no-verify` sui hook.
- Deploy rules/schema/Cloud Functions senza aver letto l'impatto sui client già rilasciati (iOS non si
  aggiorna al deploy: vedi principio "verificare stato deployato" in `docs/RUNBOOK.md`).
- Full `--only functions` "alla cieca" quando si sa che in prod esistono function WIP non nel source locale.
