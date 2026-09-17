# Contribuire a Somto

Grazie per l'interesse. Issue e pull request possono essere scritte in
italiano o inglese.

## Prima di iniziare

1. Per bug e modifiche piccole, apri una pull request focalizzata.
2. Per feature, cambi di schema, nuove dipendenze o refactor ampi, apri prima
   una issue con motivazione, impatto e piano di migrazione.
3. Per vulnerabilità non usare issue pubbliche: segui [SECURITY.md](SECURITY.md).

## Ambiente locale

Usa Node.js 22, Java 21 e Firebase Emulator Suite. Copia solo i placeholder
necessari da `.env.example` o `functions/.env.example`; non inserire mai valori
Somto reali.

```bash
npm ci
npm --prefix functions ci
npm test
npm --prefix functions run test:unit
npm --prefix functions run test:rules
```

Per i test browser esegui `npm run e2e`. Per iOS genera il progetto con
`cd ios && xcodegen generate`, poi usa `scripts/ios-ci.sh` su macOS.

## Regole per le modifiche

- Mantieni il cambiamento piccolo, verificabile e reversibile.
- Non affidare privacy, ownership o permessi al frontend.
- Ogni nuova superficie Firestore/Storage deve partire da default deny e avere
  test delle rules.
- Non includere dati reali, UID, email private, export utente o screenshot con
  informazioni personali.
- Non modificare logo, palette o marchio Somto.
- Non aggiungere dipendenze senza motivazione e verifica della licenza.
- Usa Conventional Commits e descrivi il perché quando non è evidente.

## Pull request

La PR deve includere scope, rischi, test eseguiti e screenshot quando cambia la
UI. Tutti i check CI devono passare. Le modifiche possono essere rielaborate o
rifiutate per sicurezza, privacy, coerenza prodotto o costo operativo.

Contribuendo, accetti che il tuo contributo sia distribuito con la licenza del
repository e dichiari di avere il diritto di inviarlo.
