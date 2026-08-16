# Staging — somto-staging

Ultimo aggiornamento: 2026-08-16 (configurazione QA rimossa dal sorgente).

## Cos'è

Progetto Firebase separato (`somto-staging`) per provare modifiche su
infrastruttura reale senza toccare gli utenti di produzione (`gia-visto`).

| Superficie | Prod | Staging |
|---|---|---|
| Project ID | `gia-visto` | `somto-staging` |
| Hosting | https://somto.it | https://somto-staging.web.app |
| Firestore | `(default)`, eur3 | `(default)`, eur3 — ATTIVO, seedato (120 titoli, generi, quiz) |
| Rules Firestore | deployate | deployate (stesso `firestore.rules`) |
| Indexes | deployati | deployati (stesso `firestore.indexes.json`) |
| Auth | attiva (email, Google, Apple) | Email/password **ATTIVA** (2026-07-12); Google/Apple no |
| Functions | attive | deployate (stesso source; tmdbProxy senza minInstances) |
| Storage | attivo (bucket US-CENTRAL1) | attivo (bucket US-CENTRAL1, stesse rules) |
| Piano | Blaze | Blaze (billing gestito fuori dal repository) |
| Indicizzazione | pubblica | bloccata (`X-Robots-Tag: noindex` da `firebase.staging.json`) |

## Come funziona lo switch ambiente

`public/firebaseConfig.js` sceglie il progetto **dall'hostname**:

- `somto-staging.web.app` / `somto-staging.firebaseapp.com` → config staging
- qualsiasi altro host (somto.it, gia-visto.web.app, localhost) → config prod

Nessuna build separata: lo stesso identico `public/` viene deployato su
entrambi gli hosting. `window.__SOMTO_ENV__` vale `"staging"` o `"production"`.

## Comandi

```bash
# tutto (firestore rules+indexes + hosting), tree pulito richiesto
npm run deploy:staging

# solo hosting
npm run deploy:staging:hosting

# con modifiche non committate (solo prove manuali)
ALLOW_DIRTY_STAGING=1 npm run deploy:staging:hosting
```

Il project id viene dall'alias `staging` in `.firebaserc` (override:
env `FIREBASE_STAGING_PROJECT`). Il deploy staging usa
**`firebase.staging.json`**: niente sezione functions/storage, niente
rewrites verso le Cloud Functions (non esistono su staging), header
`X-Robots-Tag: noindex` su tutto.

## Note operative (stato Blaze, dal 2026-07-12)

- **Functions attive** su staging: deploy con
  `firebase deploy --only functions --project staging` (usa lo STESSO
  source di prod; gli `.env` di `functions/` vengono caricati anche qui —
  le scheduled functions girano davvero, contro il DB di staging).
- **Chat assistenza**: `functions/.env.somto-staging` deve valorizzare
  `SUPPORT_UID` con l'UID dell'account supporto di test. Non riusare l'UID
  dell'account supporto di produzione: gli utenti Auth dei due progetti sono
  separati e l'inbox staging non riceverebbe i thread.
- **Costi attesi ~0-2€/mese** a traffico di test: `tmdbProxy` NON ha
  l'istanza calda su staging (minInstances solo su `gia-visto`), le
  scheduled girano su dati minuscoli. Controllare la fattura per-progetto
  nella console Billing (stesso account di prod, riga separata).
- **Storage attivo** (bucket `somto-staging.firebasestorage.app`,
  US-CENTRAL1 come prod, stesse `storage.rules`).
- L'**emulatore locale** resta il posto giusto per i test automatici e per
  iterare veloce; staging serve per la verifica "su Firebase vero" prima
  del deploy prod.

## Stato setup (2026-07-12 — tutto fatto salvo Google provider)

1. ✅ Email/password abilitato (console). Login verificato.
2. ✅ Utenti di test configurati fuori dal repository; credenziali e UID
   restano nel password manager e nella console Firebase.
3. ✅ Blaze; dettagli e account di fatturazione restano fuori dal repository.
4. ✅ Functions + Storage deployati.
5. ✅ Seed catalogo: 120 titoli top, 85 generi, `quizMeta/themes`,
   400 domande quiz (top 8 temi). Ri-seedabile: lo script è documentato
   sotto.
6. (Opzionale, aperto) **Google → Abilita** in Sign-in method. Apple su
   staging: sconsigliato (config Apple Developer dedicata) — usare
   email/password.

## Ri-seedare staging

Il seed copia SOLO catalogo pubblico da prod (titles/genres/
contentCategories/quizMeta/quizQuestions — mai dati utente/PII) via admin
SDK con ADC (account con accesso a entrambi i progetti):

```bash
SEED_PW="<password utenti QA>" \
STAGING_QA_USERS_JSON='[{"email":"qa.admin@example.com","name":"QA Admin","admin":true}]' \
NODE_PATH=functions/node_modules \
  node scripts/seed-staging.cjs
```

`STAGING_QA_USERS_JSON` accetta da 1 a 10 oggetti con `email`, `name`,
`admin` e, opzionalmente, `uid`. Usare valori reali solo nella shell o nel
password manager. Lo script è idempotente sui medesimi UID/account.

## Dati di test

Firestore staging è vuoto. Non copiare dati reali (PII) da prod.
Per seedare il minimo indispensabile (qualche titolo dal catalogo pubblico):
i doc `titles` sono leggibili pubblicamente da prod, quindi si può copiare
un piccolo campione con uno script admin ADC — da fare solo se/quando serve.

## Cosa NON è staging

- Non è l'ambiente per test automatici: quelli girano sugli **emulatori**
  (`npm run e2e`, `npm --prefix functions test`) col project fittizio
  `demo-2watch`.
- Non è un mirror dei dati prod: è volutamente vuoto/sintetico.
