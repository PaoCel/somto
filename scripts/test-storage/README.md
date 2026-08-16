# Smoke test Storage rules (post-PACK A fix #5)

Setup una-tantum:
```bash
cd scripts/test-storage
npm install
```

Esecuzione (richiede JDK 21+):
```bash
# Terminale 1 — storage emulator
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
cd /path/to/somto
firebase emulators:start --only storage,auth

# Terminale 2 — test
cd scripts/test-storage
npm test
```

Aspettativa: tutti pass. 1+ fail = regressione rules, NON deployare.

Cosa copre:
- PACK A fix #5: `peopleAvatars/{personId}/{fileName}` scoped, SVG bloccato (XSS), cap 300KB
- Legacy flat `peopleAvatars/{fileName}` -> read-only
- `posters/{uid}` e `reviewPhotos/{uid}` -> scope per owner, cap 6MB, contentType image-only
- Catch-all `{allPaths=**}` -> DENIED

Porta storage emulator: 58081 (vedi `firebase.json`).
