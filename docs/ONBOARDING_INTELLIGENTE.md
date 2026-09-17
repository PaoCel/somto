# Onboarding Intelligente 2watch (retroattivo + progressivo)

## 1) UX Flow completo

### Trigger retroattivo (utenti esistenti)
- Condizione: utente loggato e `users/{uid}.onboardingStatus.completedLevel` assente o `0`.
- Home:
  - Prima esposizione post-deploy: modal full-screen con scelta livello (`Facile`, `Medio`, `Avanzato`) + `Piu' tardi`.
  - `Piu' tardi`:
    - salva `onboardingStatus.dismissedAt` e `onboardingStatus.lastPromptAt`.
    - non mostra più full-screen ad ogni accesso.
    - mostra card persistente in Home finché `completedLevel < 1`.
- Card Home persistente:
  - testo: `Completa il profilo per suggerimenti migliori`.
  - CTA: `Inizia` (apre scelta livello) e `Non ora` (dismiss discreto, card nascosta nella sessione corrente).

### Trigger utenti nuovi
- Dopo signup/login e `ensureUserDoc`, stesso meccanismo del retroattivo.
- Il nome da registrazione è precompilato nello step 1, ma viene confermato/riservato con logica username unica.

### Wizard livelli
- Livello 1 `Facile` (~1 minuto):
  - Step `Nome pubblico` (obbligatorio)
  - Step `Avatar` (opzionale)
  - Step `8-12 titoli` (obbligatorio)
- Livello 2 `Medio` (~2-3 minuti):
  - Tutto il Facile +
  - Step `Vibe` (max 2)
  - Step `Film vs Serie` + `Mainstream vs Scoperte`
- Livello 3 `Avanzato` (~5 minuti):
  - Tutto il Medio +
  - Step `Epoca`, `Contesto visione` (multi), `Titolo del cuore` (opzionale), `Tolleranza contenuti` (opzionale)
  - Step `Anti-preferenze` (max 5, opzionale)

### Ripresa/Upgrade
- In `account.html` è presente pannello `Profilo e Preferenze`.
- Se `completedLevel=1`: CTA upgrade a `Medio`.
- Se `completedLevel=2`: CTA upgrade a `Avanzato`.
- Se `completedLevel=3`: CTA modifica preferenze.
- Dati già inseriti precompilati (nessuna ricompilazione forzata).

### Stati espliciti
- `completedLevel`: `0|1|2|3`
- `confidenceScore`: `0..100`
- `startedAt`, `completedAt`, `dismissedAt`, `lastPromptAt`
- Salvataggio draft intermedio (`Salva e chiudi`) per riprendere in seguito.

## 2) Data model Firestore (versionato)

### `users/{uid}` (chiave interna: UID, mai usato come nome pubblico)
- `displayName: string` (nome pubblico)
- `displayNameLower: string` (normalized key per ricerca/handle)
- `photoURL: string` (legacy compat)
- `avatarURL: string` (nuovo campo pubblico)
- `onboardingStatus: {`
  - `version: number`
  - `startedAt: timestamp|null`
  - `completedAt: timestamp|null`
  - `completedLevel: 0|1|2|3`
  - `lastPromptAt: timestamp|null`
  - `dismissedAt: timestamp|null`
  - `confidenceScore: number(0..100)`
  - `}`
- `tasteProfile: {`
  - `seedTitleIds: string[]`
  - `vibe: string[]`
  - `filmVsSeries: "film"|"mix"|"series"`
  - `mainstream: "mainstream"|"mix"|"discover"`
  - `era: string|null`
  - `context: string[]`
  - `dislikes: string[]`
  - `favoriteTitleText: string|null`
  - `contentTolerance: "light"|"heavy"|"disturbing"|null`
  - `updatedAt: timestamp`
  - `}`

### Username unico (recommended)
- `usernames/{displayNameLower}`
  - `uid`
  - `displayName`
  - `displayNameLower`
  - `createdAt`, `updatedAt`

Strategia adottata:
- riserva atomica in transaction (`runTransaction`) per evitare race conditions.
- se occupato: fallback automatico con suffisso numerico (`nome`, `nome2`, `nome3`, ...).

### Telemetry onboarding (scelta recommended)
- **Scelta adottata**: `users/{uid}/onboardingTelemetry/{sessionId}` (1 doc per sessione).
- Contiene:
  - `startedAt`, `endedAt`, `levelChosen`, `completed`
  - `steps.{stepId}.{startMs,endMs,dwellMs,toggleCount}`
  - `clicks[]` compresso/cappato (max 120)
  - `counters.toggleCount`, `counters.clickCount`
- Motivo: meno write rispetto a doc-per-evento, query semplice per audit sessioni, doc size controllata con cap.

## 3) Piano implementazione (PWA Firebase)

1. API onboarding:
- File: `public/js/api/onboarding.api.js`
- Funzioni: snapshot, dismiss, start session, finalize, draft, telemetry, confidence score, username reservation.

2. UI onboarding:
- File: `public/js/components/onboardingFlow.js`
- Modal chooser livelli + wizard step-by-step.
- Tracking implicito click/add/remove/ordine/dwell/toggle.

3. Integrazione pagine:
- Home trigger retroattivo + card:
  - `public/js/pages/home.page.js`
  - placeholder: `public/index.html`, `public/home.html`
- Profilo/Preferenze + upgrade:
  - `public/js/pages/account.page.js`
  - placeholder: `public/account.html`

4. Avatar path:
- `public/js/api/storage.api.js` -> `avatars/{uid}/avatar.jpg`
- compatibilità mantenuta su `photoURL` + `avatarURL`.

5. Sicurezza:
- `firestore.rules`: validazioni su `displayName`, `onboardingStatus`, `tasteProfile`, telemetry, `usernames`.
- `storage.rules` + `firebase.json` aggiornato.

6. Stile:
- `public/css/components/onboarding.css`
- import in `public/css/main.css`.

## 4) Snippet reali (JS)

### Gating retroattivo Home
```js
await initHomeOnboarding({
  uid: user.uid,
  onCompleted: async () => {
    await buildHomeFeed(user.uid).catch(() => {});
  },
});
```
File: `public/js/pages/home.page.js`

### Salvataggio displayName + avatar
```js
const reserved = await reserveDisplayNameUnique({
  uid,
  desiredName: chosenDisplayName,
  previousKey: userData.displayNameLower || null,
});

await setDoc(userRef, {
  displayName: reserved.displayName,
  displayNameLower: reserved.displayNameLower,
  avatarURL,
  photoURL: avatarURL, // legacy compat
}, { merge: true });
```
File: `public/js/api/onboarding.api.js`

### Telemetry onboarding
```js
await setDoc(doc(db, "users", uid, "onboardingTelemetry", sessionId), {
  version: 1,
  levelChosen,
  completed,
  steps,
  clicks: clicks.slice(0, 120),
  counters,
  updatedAt: serverTimestamp(),
}, { merge: true });
```
File: `public/js/api/onboarding.api.js`

### Confidence score
```js
const base = [0, 30, 55, 72][completedLevel] || 0;
score = base
  + (hasDisplayName ? 10 : 0)
  + (hasAvatar ? 6 : 0)
  + Math.min(22, seedTitleIds.length * 2)
  + ...;
```
File: `public/js/api/onboarding.api.js`

## 5) Security rules aggiornate

### Firestore
- Owner può aggiornare solo il proprio `users/{uid}` mantenendo blocco su `trusted/isAdmin/level`.
- Validazioni campi onboarding/taste profile (size, enum, timestamp/null).
- Nuova collection `usernames`:
  - create/update/delete solo per owner del mapping.
  - chiave `displayNameLower` validata.
- Telemetry:
  - `users/{uid}/onboardingTelemetry/{sessionId}` scrivibile solo da owner.
  - limiti su dimensione payload (`clicks <= 120`).

### Storage
- `avatars/{uid}/...` write/delete solo owner + image-only + size limit.
- compatibilità path esistenti:
  - `posters/{uid}/...` owner-only.
  - `peopleAvatars/...` authenticated write (size limit).
  - `users/{uid}/...` legacy compat.

## 6) Acceptance Criteria testabili

- [ ] Utente esistente con `completedLevel` assente/0 vede full-screen chooser al primo accesso post-deploy.
- [ ] Click `Piu' tardi` salva `dismissedAt/lastPromptAt` e non ripete full-screen a ogni login.
- [ ] Home mostra card persistente finché `completedLevel < 1`.
- [ ] Step nome pubblico obbligatorio e non usa mai `uid` come nome pubblico.
- [ ] Username reservation evita collisioni concorrenti (`usernames/{displayNameLower}`).
- [ ] Se nome occupato, fallback automatico con suffisso numerico.
- [ ] Upload avatar salva URL in `avatarURL` e `photoURL`.
- [ ] Facile richiede 8-12 seed titles.
- [ ] Medio/Avanzato precompilano i dati già presenti e salvano solo delta.
- [ ] Telemetry sessione contiene start, livello, dwell per step, click add/remove con orderIndex, toggleCount.
- [ ] `confidenceScore` aggiornato dopo completamento.
- [ ] Regole Firestore/Storage impediscono scritture su risorse altrui.
- [ ] Compatibile con utenti legacy (nessuna migrazione distruttiva richiesta).

## 7) Edge cases e comportamento atteso

### Utente skippa 10 volte
- Full-screen mostrato solo alla prima esposizione.
- Card Home resta disponibile finché non completa almeno livello Facile.

### Utente cambia displayName
- Transaction aggiorna `users/{uid}` e mapping `usernames/{displayNameLower}`.
- Se il nuovo nome è occupato, fallback automatico numerico.
- Mappatura precedente dell’utente viene rilasciata.

### Avatar upload fallisce
- Toast errore, wizard non si blocca.
- Utente può proseguire senza avatar (fallback iniziali).

### Offline / rete lenta
- `Salva e chiudi` salva draft best-effort.
- In caso failure network, viene mostrato errore e i dati restano nel form corrente per retry.

### Doc troppo grande / troppi eventi
- `clicks` cappato a 120 eventi per sessione.
- `steps` struttura compatta per id step.

### Compatibilità utenti esistenti (like/amici/genres dedotti)
- Nessuna rimozione di campi legacy.
- `photoURL` mantenuto e sincronizzato con `avatarURL`.
- `tasteProfile` merge non distruttivo (mantiene dati preesistenti).
