# QuizSession V2 — sicurezza, migrazione e rollback

Stato: backend Fase 1 e adapter PWA Fase 2 implementati e testati; non deployati. Il gate PWA è hard-off e i client restano sul legacy.

Implementazione: `functions/lib/quizSessionV2.js`, `functions/modules/quizSessionV2.js`, test unitari e integrazione Firestore emulator. Il gate produzione resta chiuso.

Adapter PWA: `public/js/api/quiz.api.js`, `public/js/pages/quiz-play.page.js` e `public/js/utils/quizSessionV2State.js`. Il solo V2 conserva il pending submit in `sessionStorage`, riusa la stessa idempotency key dopo timeout/refresh e non ricade mai sulle scritture legacy. Challenge escluse dal gate.

## Confine del primo slice

- Modalità: solo partita `solo` autenticata; challenge e guest restano invariati.
- Callable: `startQuizSessionV2` e `submitQuizSessionV2`, regione `europe-west1`.
- Pool: soltanto `status: approved`, `language: it`, quattro risposte valide e indice corretto `0...3`.
- Conteggi ammessi: 3, 5 o 10.
- Nessun client viene migrato e nessuna rule legacy viene chiusa in questo slice.
- Nessun deploy finché App Check, corpus approvato e client non sono pronti.

## Threat model

Il server non si fida di question ID, score, outcome, XP, stato, timestamp o answer key inviati dal client. Deve impedire:

- lettura della risposta corretta prima del submit;
- aggiunta, rimozione o duplicazione di domande;
- indici risposta fuori range o payload sovradimensionati;
- uso della sessione di un altro utente;
- submit dopo scadenza;
- replay o submit concorrenti con doppio accredito;
- ricalcolo diverso se una domanda viene modificata o ritirata dopo lo start;
- scritture parziali tra sessione, attempt e statistiche.

## Contratto V2

### Start

Request:

```json
{
  "contractVersion": 2,
  "clientRequestId": "uuid",
  "mode": "solo",
  "titleId": "opzionale",
  "count": 5,
  "language": "it"
}
```

Response:

```json
{
  "contractVersion": 2,
  "sessionId": "opaque-id",
  "status": "active",
  "expiresAt": "RFC3339",
  "questions": [{
    "questionId": "id",
    "titleId": "id",
    "title": "titolo",
    "mediaType": "tv|movie",
    "questionText": "testo",
    "answers": ["a", "b", "c", "d"],
    "difficulty": "medium",
    "spoilerLevel": "none"
  }]
}
```

Lo start non restituisce mai `correctAnswerIndex` o `explanation`.

### Submit

Request:

```json
{
  "contractVersion": 2,
  "sessionId": "opaque-id",
  "idempotencyKey": "uuid",
  "answers": [{
    "questionId": "id",
    "selectedIndex": 0,
    "timeMs": 1200
  }]
}
```

`selectedIndex: null` rappresenta una risposta saltata. Il set dei question ID deve coincidere esattamente con lo snapshot.

Response:

```json
{
  "contractVersion": 2,
  "sessionId": "opaque-id",
  "status": "completed|already_completed",
  "score": 0.8,
  "counts": { "correct": 1, "wrong": 1, "skipped": 0 },
  "results": [{
    "questionId": "id",
    "selectedIndex": 0,
    "correctIndex": 1,
    "outcome": "wrong",
    "explanation": "testo"
  }],
  "reward": {
    "xpAwarded": 12,
    "dailyStreak": 1,
    "dailyBonusActive": false
  }
}
```

## Schema server-only

`quizSessions/{sessionId}`:

- `schemaVersion: 2`
- `ownerUid`
- `status: active | completed | expired`
- `mode: solo`
- `titleId: string | null`
- `language: it`
- `questionCount`
- `questions[]`: snapshot completo, inclusi `correctAnswerIndex` ed `explanation`
- `createdAt`, `expiresAt`, `ttlAt`
- `clientRequestId`
- `submittedAt`, `submitIdempotencyKey`, `submitPayloadHash`
- `result`: risposta canonica persistita per retry idempotente
- `attemptPath`

Le sessioni sono deny-all ai client. Nessun indice è necessario: i client non le interrogano e i callable usano il document ID.

Attempt finale: `users/{uid}/quizAttempts/{sessionId}`. Contiene outcome e tempi, non answer key né testo completo.

## Transazioni

Start:

1. Auth, App Check e rate limit.
2. Validazione stretta del payload.
3. Selezione casuale dal pool approvato.
4. Creazione della sessione server-only con scadenza a 20 minuti.

Submit, in una sola transazione:

1. Leggere sessione e stats.
2. Verificare owner, scadenza, stato, question ID e payload hash.
3. Se stessa chiave e stesso hash: restituire il risultato persistito senza scrivere.
4. Se completata con chiave/hash differenti: `failed-precondition`.
5. Calcolare outcome, score, XP e streak soltanto dallo snapshot.
6. Scrivere sessione completata, attempt e stats atomici.

Score: `+1` corretta, `-0,2` errata, `0` saltata. XP solo: `10 + 2 × corrette`, con bonus giornaliero esistente dalla terza partita.

## Sicurezza Firestore e retention

- Aggiungere `match /quizSessions/{id} { allow read, write: if false; }` prima del deploy.
- Non cambiare ancora gli accessi legacy a domande, attempt, stats o challenge: servono ai client distribuiti correnti.
- `expiresAt` è verificato sincronicamente dal callable usando il clock server.
- `ttlAt`: sessione attiva `expiresAt + 7 giorni`; completata `submittedAt + 30 giorni`.
- La policy TTL Firestore è un passaggio infrastrutturale separato; il codice non dipende dalla puntualità del TTL.

## App Check

Le nuove callable devono richiedere App Check, ma non vanno deployate prima dello smoke staging PWA reCAPTCHA e iOS App Attest/DeviceCheck. Mancanza o errore del token deve fallire chiuso. Il rate limit per UID resta una seconda barriera.

## Migrazione

1. Implementare backend e test senza deploy.
2. Aggiungere deny-all `quizSessions`, configurare TTL e verificare App Check in staging.
3. Portare un corpus minimo approvato sufficiente ai test.
4. Deploy callable V2, senza toccare legacy.
5. Migrare PWA dietro capability flag, poi iOS.
6. Misurare adozione/errori e imporre una versione minima.
7. Chiudere direct read delle answer key e direct write di attempt/stats/challenge.
8. Rendere `quizMeta` approved-only e rimuovere le etichette beta soltanto dopo i gate QA.

## Rollback

- Prima della chiusura legacy: disabilitare il flag V2; le callable e le sessioni rimangono isolate.
- Dopo la chiusura legacy: rollback coordinato di client e rules; non cancellare sessioni o attempt.
- Nessun rollback deve riaccreditare XP o rieseguire sessioni completate.

## Gate prima del deploy

- Test unitari: validazione, answer-key omission, scoring, expiry, payload hash e idempotenza.
- Test emulator: owner, concorrenza, una sola applicazione stats/XP, deny-all sessioni.
- Smoke App Check su PWA e iOS staging.
- Almeno un titolo con 10 domande `approved` in staging; produzione oggi non soddisfa questo gate.
