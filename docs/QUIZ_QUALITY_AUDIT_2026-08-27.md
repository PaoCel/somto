# Audit qualità quiz — 2026-08-27

Misurato sul corpus **live di produzione** (`gia-visto`), dump read-only di
`quizQuestions` (10.525 doc) + `quizMeta/themes` + `quizQuestionReports` +
`collectionGroup(quizAttempts)`. Nessuna scrittura.

## Numeri di partenza

| Metrica | Valore |
| --- | --- |
| Domande totali | 10.525 |
| Giocabili (`approved` + `beta_pending_review`) | 10.444 |
| `approved` | **1** |
| `flagged` (fuori dal pool) | 56 |
| `discarded` | 25 |
| Titoli con quiz | 242 |
| Partite registrate su `quizAttempts` (da sempre) | **143** |
| Segnalazioni utente (`quizQuestionReports`) | 5 |

Struttura: perfetta. 0 domande con ≠4 risposte, 0 opzioni duplicate, 0 opzioni
vuote, 0 `correctAnswerIndex` fuori range, 0 explanation mancanti, 2 duplicati
esatti. `correctAnswerIndex` distribuito uniforme (26,3 / 23,5 / 25,1 / 25,1%).
Le fix degli audit next50 e wave2 risultano applicate.

Il problema non è la struttura. È **la scrittura delle domande**.

## Finding 1 — la risposta giusta è la più lunga: 51,1%

| | domande | quota |
| --- | --- | --- |
| corretta = opzione più lunga | 5.336 | **51,1%** |
| corretta = unica più lunga E ≥1,5× la più corta | 3.483 | 33,3% |
| corretta = opzione più corta | 2.524 | 24,2% |

Chi non sa nulla e sceglie sempre la risposta più lunga prende ~51%. Il quiz è
**giocabile senza conoscere il titolo**: è il difetto singolo più grave, perché
toglie senso sia al punteggio sia alla classifica.

Causa: la risposta giusta viene scritta completa e argomentata, i distrattori
buttati lì corti. Esempio reale (`hp_azkaban_extra_001`):

```
Perche ha saltato la lezione di Trasfigurazione     (47)
Perche i Dursley non gli hanno firmato il permesso  (50)  <- corretta
Perche Silente teme un attacco dei Dissennatori     (47)
Perche e ancora in punizione da Piton               (37)
```

Qui va bene. Ma in un terzo del corpus lo scarto è del 50-100%.

Fix: riscrittura dei soli distrattori (non della risposta né della domanda) per
allineare la lunghezza. È un lavoro meccanico e batchabile, e **non tocca la
verità fattuale** — quindi non richiede un nuovo fact-check.

## Finding 2 — accenti mangiati, e proprio su Harry Potter

3.217 record (30,8%) non contengono **nessun** carattere accentato. Il controllo
stretto (parole che in italiano non esistono senza accento: *perche, puo, piu,
gia, cosi, citta, qual e*) trova 172 record certi, concentrati:

| famiglia id | rotti / totali |
| --- | --- |
| `hp_azkaban_*` | 12/25 (48%) |
| `hp_deathly1_*` | 12/25 (48%) |
| `hp_deathly2_*` | 10/25 (40%) |
| `hp_halfblood_*` | 10/25 (40%) |
| `hp_chamber_*` | 13/50 (26%) |
| `hp_goblet_*` | 11/50 (22%) |
| `family_classics_*` | 40/220 (18%) |
| `q_NNN` (import principali) | 63/9.324 (1%) |

I batch `disney_*` (2.725 doc, `accentAuditStatus: passed_pre_import_2026_06_19`)
sono puliti. I batch `hp_*` e `family_classics_*` sono entrati **senza** passare
dal check accenti: 7.719 doc giocabili non hanno `accentAuditStatus`.

Peso reale: i titoli Harry Potter sono i più giocabili come richiamo esterno, e
sono quelli che a schermo scrivono "Perche", "e ancora", "puo". Su un video
social è la prima cosa che si vede.

## Finding 3 — un quarto del corpus è trivia da scheda, non conoscenza della storia

| categoria | quota |
| --- | --- |
| `character` | 29,5% |
| `trivia` | 14,5% |
| `anagraphic` | 13,8% |
| `plot` | 12,5% |
| resto (object, scene, consequence, relationship, motivation, quote, chronology, episode) | 29,7% |

`trivia` + `anagraphic` = **28,3%**. Il match testuale su domande di produzione
(cast, regia, incassi, premi, rete, numero stagioni, doppiatori) ne conferma
1.044 = 10,0%, peggiori: SKAM Italia 16, Joker 12, Oppenheimer 12, Mare Fuori
12, Smetto quando voglio 12.

Sono le domande che spengono la partita: chi ama il titolo non le sa e chi le sa
non ama il titolo. Su Aladdin ci sono quattro domande di fila su chi presta la
voce **inglese** ai personaggi, in un quiz italiano.

## Finding 4 — le saghe sono spezzate

Harry Potter esiste come **8 titoli separati** da ~50 domande. Non si può
giocare "Harry Potter": si gioca "Harry Potter e il calice di fuoco".

I `titles` hanno già `collectionId` + `collectionName` da TMDB. Raggruppando:

| domande | film | saga | collectionId |
| --- | --- | --- | --- |
| 396 | 8 | Harry Potter | 1241 |
| 100 | 2 | Il Signore degli Anelli | 119 |
| 100 | 2 | Il cavaliere oscuro | 263 |
| 100 | 4 | Avengers | 86311 |
| 100 | 2 | Animali Fantastici | 435259 |
| 97 | 2 | Star Wars | 10 |
| 75 | 3 | Avatar | 87096 |
| 75 | 3 | Iron Man | 131292 |
| 75 | 3 | Captain America | 131295 |
| 50 | 2 | Thor | 131296 |
| 50 | 2 | Guardiani della Galassia | 284433 |
| 50 | 2 | Ant-Man | 422834 |

12 saghe, gratis, dai dati già presenti (72 dei 232 titoli quiz hanno un
`collectionId`). Le saghe TV (Dragon Ball / Z / Super = 200 domande) servono una
mappa manuale, poche righe.

Questo è anche il blocco numero uno per i video: **"Quanto ne sai di Harry
Potter" oggi non ha una pagina dove atterrare.**

## Finding 5 — il gate `approved` non esiste

1 domanda `approved` su 10.444 giocabili. Le rules ammettono
`approved` **o** `beta_pending_review`, quindi tutto il corpus gira in beta da
sempre e la promozione non è mai avvenuta. O si usa il gate o si toglie: così
com'è dà una falsa sensazione di controllo qualità.

## Finding 6 — domande rotte ancora vive

Trovate a campione, non da audit sistematico:

- `q_46_22` — "Quale film MCU/altro paragone NON è pertinente alla saga Harry Potter?" (Dune / Iron Man / Star Wars / Pirati dei Caraibi). Domanda senza senso.
- `q_46_24` — "Quanto dura la pausa narrativa prima del finale di Parte 2?" → "Circa 8 mesi". Non verificabile, formulazione oscura.
- `q_171_50` — incasso al box office di Harry Potter, in un quiz sulla storia.
- `family_classics_cesaroni_006` == `q_72_10` e `family_classics_cesaroni_005` == `q_72_18` — duplicati esatti su I Cesaroni.

## KPI sintetico: "pronta per andare a schermo"

Filtro: spoiler ≤ light, domanda ≤95 caratteri, opzione più lunga ≤34 caratteri,
niente accenti mancanti, niente trivia di produzione, niente tell della risposta
più lunga.

**Passano 2.465 su 10.444 = 23,6%.**

| motivo di scarto | domande | quota |
| --- | --- | --- |
| corretta = più lunga | 5.336 | 51,1% |
| opzione oltre 34 caratteri | 3.116 | 29,8% |
| spoiler medium/heavy | 2.641 | 25,3% |
| domanda oltre 95 caratteri | 1.362 | 13,0% |
| trivia di produzione | 1.044 | 10,0% |
| accento mancante (check stretto) | 132 | 1,3% |

Su Harry Potter passano 66 domande su 396 (17%). Basta e avanza per i video, ma
dice quanto è stretto il sottoinsieme davvero pubblicabile.

## Ordine consigliato

1. **Saghe** (`collectionId` + mappa TV) — sblocca i video e non tocca il corpus.
2. **Accenti** su `hp_*` e `family_classics_*` — ~600 doc, visibile subito.
3. **Distrattori** dei 3.483 con tell forte — la fix che rende il quiz un quiz.
4. **Potatura** trivia di produzione: `flagged` sulle ~1.000 domande da scheda.
5. **Gate**: promuovere ad `approved` ciò che passa i controlli, o rimuovere lo stato.
6. **Calibrazione**: aggregare `quizAttempts` per domanda (i dati per-domanda ci
   sono già) e ricalcolare `difficulty` sul tasso di risposta reale. Serve
   volume: oggi sono 143 partite.

I punti 2-4 sono batch su Firestore in produzione: vanno fatti con script
dedicato, dry-run e report, come gli audit next50/wave2.
