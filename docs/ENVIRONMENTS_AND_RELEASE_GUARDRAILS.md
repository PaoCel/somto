# Somto - Environments and Release Guardrails

Ultimo aggiornamento: 2026-07-07

## Obiettivo

Ridurre il rischio che sviluppo, test o deploy tocchino utenti live su `gia-visto`.

La regola operativa e':

1. `local` per sviluppo quotidiano e test veloci.
2. `staging` per verificare una release candidate su Firebase reale ma separato.
3. `prod` solo dopo test, smoke e conferma esplicita.

## Stato attuale

- Production Firebase project: `gia-visto`.
- `.firebaserc` espone alias `prod` e `production`, entrambi su `gia-visto`.
- Staging Firebase project: `somto-staging` (creato 2026-07-12, alias `staging` in `.firebaserc`). Firestore in `eur3` come prod. Hosting: https://somto-staging.web.app (noindex). `FIREBASE_STAGING_PROJECT` resta come override, fallback automatico sull'alias `.firebaserc`.
- Il deploy staging usa `firebase.staging.json` (niente rewrites verso functions: su staging le functions non sono deployate finche' il progetto resta su piano Spark). Dettagli operativi in `docs/STAGING.md`.
- Il repo puo' essere sporco per lavoro in corso di altri agenti: non mescolare guardrail/release con feature work.

## Comandi sicuri

### Local

```bash
npm run e2e
npm --prefix functions test
```

`npm run e2e` usa gli emulatori Firebase (`auth`, `firestore`, `storage`, `hosting`) e il project demo `demo-2watch`.

### Staging

Prima crea un progetto Firebase separato, poi:

```bash
export FIREBASE_STAGING_PROJECT="somto-staging"
npm run deploy:staging:hosting
npm run deploy:staging
```

Il check staging blocca il deploy se:

- `FIREBASE_STAGING_PROJECT` manca;
- punta a `gia-visto`;
- punta a un project id `demo-*`;
- il working tree e' sporco.

Per un test intenzionale con modifiche non committate:

```bash
ALLOW_DIRTY_STAGING=1 FIREBASE_STAGING_PROJECT="somto-staging" npm run deploy:staging:hosting
```

Usare `ALLOW_DIRTY_STAGING=1` solo per prove manuali, mai per candidati release.

### Production

```bash
CONFIRM_PROD=gia-visto npm run deploy:prod:hosting
CONFIRM_PROD=gia-visto npm run deploy:prod
```

Il check prod blocca il deploy se:

- non sei su `main`;
- il working tree e' sporco;
- manca `CONFIRM_PROD=gia-visto`;
- il project id atteso non e' `gia-visto`.

Le variabili `ALLOW_NON_MAIN_PROD=1` e `ALLOW_DIRTY_PROD=1` sono solo break-glass: usarle richiede una nota esplicita nel report di release.

## Setup staging Firebase

Checklist iniziale:

- creare un nuovo Firebase project, ad esempio `somto-staging`;
- abilitare Auth provider necessari;
- creare app web staging e copiare config staging;
- creare app iOS staging con bundle id separato, ad esempio `com.paolocelestini.twowatch.ios.staging`;
- abilitare Firestore, Storage, Functions e Hosting;
- configurare secrets Functions separati da prod;
- deployare rules/indexes/functions/hosting su staging;
- creare account QA staging;
- seedare dati sintetici;
- verificare che nessun client staging punti a `gia-visto`.

## Separazione client

### Web

Obiettivo:

- `local` usa emulatori;
- `staging` usa Firebase staging;
- `prod` usa `gia-visto`.

La config web corrente e' `public/firebaseConfig.js` e punta a prod. Prima di usare staging in modo stabile, separare le config in file sorgente dedicati e generare/copiarne una sola durante il deploy.

### iOS

Obiettivo:

- `DebugLocal`: bundle id dev/staging e `USE_EMULATORS=true`;
- `Staging`: bundle id staging e Firebase staging;
- `Release`: bundle id prod e Firebase prod.

Nota importante: `FirebaseConfig.plist` supporta gia' `USE_EMULATORS`, ma oggi il plist nel bundle punta a prod. Anche `CloudFunctionsCaller` va reso ambiente-aware, per evitare callable HTTP dirette verso `cloudfunctions.net` quando l'app e' in local/staging.

## Go / No-Go prima di prod

Prod passa solo se:

- branch `main`;
- working tree pulito;
- test locali rilevanti verdi;
- deploy staging completato;
- smoke web staging completato;
- smoke iOS staging completato quando il cambio riguarda iOS;
- nessun cambio a rules/schema/functions/backfill senza piano migrazione/rollback;
- backup o snapshot deciso per cambi ad alto rischio;
- report finale scritto.

## Report release

Formato minimo:

- Verdict: PASS / PASS WITH CONCERNS / BLOCKED
- Scope
- Commands run
- Staging checks
- Production deploy command
- Rollback plan
- Risks / follow-up

## Regola pratica

Se un comando puo' scrivere su utenti live, deve nominare esplicitamente prod.

Se non nomina prod, non deve poter arrivare a `gia-visto`.
