# Aggiungere una lingua

La lingua sorgente è l'italiano. Le chiavi restano frasi italiane sia nel
catalogo iOS sia nella PWA.

## Flusso

1. Crea `public/js/i18n/<codice>.js` ed esporta il dizionario con il codice
   lingua. Aggiungi import e metadati soltanto in
   `public/js/i18n/locales.js`: selettore e validazione client derivano da lì.
2. Aggiungi il codice all'allowlist `usersPrivate.language` nelle Firestore
   Rules e al relativo test. È un confine di sicurezza e resta una modifica
   esplicita, non generata automaticamente.
3. Applica le traduzioni web e iOS con gli stessi tool per qualunque lingua:

   ```sh
   node scripts/i18n-apply-web.mjs batch.json --lang es --write
   node scripts/i18n-apply-translations.mjs batch.json --lang es --write
   node scripts/i18n-seed-web-from-ios.mjs --lang es --write
   ```

4. Verifica la lingua prima di abilitarla:

   ```sh
   node scripts/i18n-check-locales.mjs
   node scripts/i18n-coverage.mjs --lang es --gate
   ```

5. Completa le superfici che non sono semplici dizionari: stringhe privacy di
   `InfoPlist.strings`, copy push del backend, pagine SEO statiche e contenuti
   editoriali/quiz. Queste parti vanno revisionate nel loro contesto.

Il gate inglese completo gira in CI tramite `npm run i18n:check`. Una lingua
nuova non va aggiunta al registro pubblico finché il suo gate non è al 100%.
