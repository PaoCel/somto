# Smoke test Firestore rules (post-PACK A/G/H)

Setup una-tantum:
```bash
cd scripts/test-rules
npm install
```

Esecuzione (richiede JDK 21+):
```bash
# Terminale 1 — emulator (resta su)
cd /path/to/somto
firebase emulators:start --only firestore,auth,storage

# Terminale 2 — test (chiudi quando finito)
cd scripts/test-rules
npm test
```

Aspettativa: tutti pass. 1+ fail = regressione, NON deployare le rules.

Cosa copre:
- quizQuestions filter status (PACK A)
- userLists memberUids == [creator] al create (PACK A)
- usernames regex stretto (PACK A)
- rate-limit recommendations al cap (PACK A)
- moderationQueue admin-only (PACK G)

Cosa NON copre (test manuali / functions emulator separato):
- callable auth gate tmdbProxy/enrichTitleAssets (functions)
- shareTitlePreview XSS escape (functions)
- peopleAvatars storage scope (storage emulator + rules)
- trigger flagSuspectedSpoiler* (functions trigger)
- trigger recomputeTitleRatingAggregate (functions trigger)
