# E2E Tests (Emulator-first)

Questa suite E2E usa **solo emulatori Firebase** (`auth`, `firestore`, `storage`, `hosting`) e crea utenti/dati test in automatico.  
Nessuna credenziale reale va inserita nel repo.

## Prerequisiti
- Node.js 20+
- Firebase CLI installata
- Dipendenze root installate (`npm install`)

## Install browser Playwright (una volta)
```bash
npm run e2e:install
```

## Esecuzione E2E completa
```bash
npm run e2e
```

Lo script esegue:
1. `firebase emulators:exec` con `auth,firestore,storage,hosting`
2. seed automatico (`e2e/scripts/seed-emulator.mjs`)
3. test Playwright (`e2e/tests/login-home.spec.js`)

## Variabili opzionali
- `E2E_USER_EMAIL`, `E2E_USER_PASSWORD`, `E2E_USER_UID`
- `E2E_ACTOR_EMAIL`, `E2E_ACTOR_PASSWORD`, `E2E_ACTOR_UID`
- `E2E_AUTH_PORT`, `E2E_FIRESTORE_PORT`, `E2E_STORAGE_PORT`, `E2E_HOSTING_PORT`
- `E2E_PROJECT_ID` (default: `demo-2watch`, deve combaciare con `--project` di `firebase emulators:exec`)
- `E2E_BASE_URL`

Esempio:
```bash
E2E_USER_EMAIL=e2e.custom@2watch.local E2E_USER_PASSWORD='CustomPass!123' npm run e2e
```

## Troubleshooting
- Porte occupate: modifica la sezione `emulators` in `firebase.json` e riallinea le variabili `E2E_*_PORT`.
- Se vedi warning su projectId multipli (`gia-visto` vs `demo-2watch`), imposta `E2E_PROJECT_ID` uguale al project usato dagli emulatori.
- Se i test falliscono per stato sporco, rilancia `npm run e2e` (il seed riscrive i doc principali con ID stabili).
