# Quiz 1.0 — piano di uscita dalla beta

Stato: `BLOCKED` finché i gate P0 non sono soddisfatti.

## Obiettivi

- Utente: giocare quiz affidabili, senza spoiler inattesi, con risultati e sfide credibili.
- Prodotto: rendere stabile il quiz italiano e preparare il motore multilingua senza rallentare il rilascio 1.0.

## Scope 1.0

- Catalogo italiano soltanto; l'inglese è una fase successiva e non blocca la 1.0.
- Minimo 50 domande approvate per ogni titolo pubblicato.
- Target 100 domande per i titoli `hero`, scelti per domanda e riconoscibilità.
- Solo `approved` è pubblico e contribuisce a `quizMeta`.
- PWA, iOS, guest, sfide e classifiche usano lo stesso contratto server-authoritative.

## Baseline produzione — 2026-08-04

Comando read-only: `cd functions && npm run audit:quiz-corpus -- --project gia-visto --json`.

- 10.525 domande, tutte `it`: 1 `approved`, 10.443 `beta_pending_review`, 56 `flagged`, 25 `discarded`.
- 242 titoli; il pool legacy giocabile contiene 10.444 domande.
- 126 titoli raggiungono 50 domande; ne mancano 1.877 per portare tutti i titoli correnti a 50.
- Solo 2 titoli raggiungono 100 domande nel pool legacy.
- 1 domanda strutturalmente invalida e 2 gruppi di testo duplicato da correggere.
- 274 domande `confidence: medium`, 1 `low` e 1.170 `spoilerLevel: heavy` richiedono policy/revisione.

## Gate di rilascio

### P0 — obbligatori

- Il client non riceve `correctAnswerIndex` prima della risposta.
- Il server crea la sessione, valuta le risposte e aggiorna attempt, score, XP, streak e challenge in modo atomico e idempotente.
- I client non possono modificare score/statistiche o i campi dell'avversario.
- Il pool pubblico contiene zero `beta_pending_review`, `flagged` o `pending`.
- Ogni titolo pubblico ha almeno 50 domande strutturalmente valide e approvate.
- Tutti i test security/rules, callable, PWA E2E e smoke iOS della matrice di rilascio passano.
- Zero bug bloccanti, crash o bypass di permessi noti.

### P1 — richiesti, salvo workaround approvato

- Filtro spoiler applicato lato server; `heavy` non appare fuori dalla policy definita.
- Anti-repeat basato sulla cronologia recente dell'utente.
- Reporting funzionante su PWA e iOS, con deduplica, rate limit e coda di revisione.
- Inviti interni/esterni funzionano in entrambi gli ordini di completamento e con retry.
- Metriche minime: start, completion, answer rate, report rate, conversione guest, errori callable.

## Fasi verificabili

### 0. Baseline e freeze del contratto

- Eseguire l'audit read-only del corpus e conservare il report JSON nella CI o negli artifact.
- Definire titoli `hero`, soglia 50/100 e budget editoriale risultante.
- Non importare nuove domande nel pool pubblico durante la migrazione del contratto.

Uscita: baseline ripetibile; backlog ordinato per severità e deficit.

### 1. Sessioni server-authoritative v2

- Aggiungere `startQuizSessionV2` e `submitQuizSessionV2`.
- Salvare sessione, snapshot delle domande, utente, scadenza, stato e chiave di idempotenza lato server.
- Restituire domande/opzioni allo start; correttezza/spiegazione soltanto al submit.
- Aggiornare attempt, stats, XP e challenge in transazione.

Uscita: test callable per manomissione, replay, concorrenza e scadenza.

### 2. Migrazione client e chiusura accessi legacy

- Migrare prima PWA, poi iOS, allo stesso contratto v2.
- I client legacy possono giocare senza ranking/XP durante una finestra breve e misurata.
- Dopo adozione/versione minima: negare lettura diretta delle answer key e scritture client di score/stats/challenge.

Uscita: nessun client supportato dipende dal contratto legacy; rules emulator verde.

### 3. Qualità di gioco

- Applicare spoiler policy e anti-repeat lato server.
- Correggere il doppio write del report PWA; aggiungere deduplica e rate limit.
- Definire snapshot/policy per challenge che contengono domande poi ritirate.
- Eliminare il bias di selezione dei pool grandi.

Uscita: matrice guest/auth/challenge/report/spoiler completata.

### 4. Riparazione ed espansione editoriale italiana

- Revisionare prima le domande `medium`, `heavy`, segnalate e duplicate.
- Portare tutti i titoli pubblicati a 50 domande approvate.
- Portare i titoli `hero` a 100; aggiungere nuovi titoli solo se nascono già con almeno 50.
- Ricostruire `quizMeta` da sole domande `approved`.

Uscita: audit con zero errori strutturali, zero titoli sotto soglia e zero contenuti non approvati nel pool.

### 5. Release candidate e rimozione beta

- Test staging con account QA separati, PWA installata e TestFlight.
- Smoke produzione read-only dopo rilascio backend/rules/client.
- Rimuovere etichette beta solo dopo go/no-go firmato sui gate.

Uscita: tutti i P0 passano; eventuali P1 hanno owner, workaround e scadenza espliciti.

## Sequenza di sicurezza

1. Deploy dei callable v2 mantenendo il legacy.
2. Migrazione e telemetria PWA/iOS.
3. Versione minima o finestra di compatibilità conclusa.
4. Tightening delle rules e rimozione del ranking legacy.
5. Promozione del solo corpus revisionato a `approved` e rebuild di `quizMeta`.

Non modificare schema, rules, indexes o Cloud Functions senza proposta separata di sicurezza, migrazione e rollback.

## Matrice QA minima

| Area | Casi obbligatori |
|---|---|
| Guest | tema/random, 3/5/10, payload senza key, submit alterato/duplicato, rate limit, CTA signup |
| Auth | solo, XP/streak, reset giorno/settimana, owner/non-owner, logout/login |
| Challenge | interno/esterno, claim parallelo, scaduto, self-claim, entrambi gli ordini, retry |
| Contenuto | status matrix, soglia 50/100, duplicati, answer index, spoiler, domanda ritirata |
| Report | spoof, duplicato, rate limit, trigger counter, triage admin |
| Client | iPhone piccolo, Safari/PWA, deep link, background, offline durante fetch/submit |
| Concorrenza | due submit, due giocatori, transazione stats/challenge, idempotenza |

## Fuori scope 1.0

- Catalogo inglese. Dopo la stabilità italiana: pilot separato da 20 titoli globali × 50 domande, pool e metriche per lingua.
- Reset o ricalcolo delle classifiche beta: richiede decisione prodotto esplicita prima della migrazione.
