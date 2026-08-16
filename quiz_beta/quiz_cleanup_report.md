# Quiz Cleanup Report

Generato: 2026-05-11
Sorgente: [quiz_questions_beta.json](quiz_questions_beta.json) (500 domande, 20 titoli).
Output principale: [quiz_questions_import_ready.json](quiz_questions_import_ready.json).

Nessuna scrittura sul DB. Nessuna modifica al codice. Nessun deploy.

## 1. Totali

- Totale domande: **500**
- Domande modificate dal reshuffle: **500/500** (campo `answerOrderShuffled: true` su tutte)
- Domande modificate dalla normalizzazione italiana: **71**
- Domande eliminate: **0** (nessuna invalidità strutturale)

## 2. Reshuffle posizione risposta corretta

Tutte le 500 domande hanno avuto l'array `answers` mescolato (Fisher-Yates) e `correctAnswerIndex` riallineato sul testo della risposta corretta originale. Il contenuto delle risposte non è cambiato, solo l'ordine.

Distribuzione `correctAnswerIndex`:

| Index | Prima | Dopo |
|-------|-------|------|
| 0 | 126 (25.2%) | **114 (22.8%)** |
| 1 | 237 (47.4%) | **139 (27.8%)** |
| 2 |  87 (17.4%) | **134 (26.8%)** |
| 3 |  50 (10.0%) | **113 (22.6%)** |

Il bias sulla posizione B (47.4%) è stato eliminato: la distribuzione ora è uniforme intorno al 25% atteso per ciascun indice.

## 3. Normalizzazione italiana

Applicate solo regole formali deterministiche (regex `\b…\b`, case-preserving). Mai modifiche al significato, mai riscrittura.

Conteggi per tipo:

| Correzione | Occorrenze |
|------------|-----------:|
| `e'` → `è` | 61 |
| `E'` → `È` | 3 |
| `qual e` → `qual è` | 11 |
| `perche` → `perché` | 7 |
| `citta` → `città` | 6 |
| `piu` → `più` | 5 |
| `puo` → `può` | 2 |
| `realta` → `realtà` | 1 |
| `verita` → `verità` | 1 |
| `liberta` → `libertà` | 1 |
| `societa` → `società` | 1 |
| `autorita` → `autorità` | 1 |
| `capacita` → `capacità` | 1 |
| `gia` → `già` | 1 |
| `eta` → `età` | 1 |
| **Totale fix** | **102** |

Le correzioni sono state applicate ai campi: `questionText`, `answers[]`, `explanation`, `sourceBasis`, `riskNotes`, `title`. Domande uniche toccate: **71**.

Regole **non** applicate (troppo ambigue/rischiose, lasciate al revisore umano):
- `po` → `po'` (rischio di colpire frammenti di nomi propri)
- `meta` → `metà` (`meta` è anche sostantivo distinto)
- spazio singolo `e` → `è` (la `e` congiunzione è frequentissima — falsi positivi inevitabili)

Se queste classi servono, raccomando passaggio manuale o seconda iterazione con liste di sicurezza specifiche.

## 4. Distribuzioni dopo cleanup

### Confidence

| Livello | Count |
|---------|------:|
| high    | 484 |
| medium  | 16 |
| low     | 0 |

### Spoiler

| Livello | Count |
|---------|------:|
| none    | 136 |
| light   | 151 |
| medium  | 112 |
| heavy   | 101 |

### Difficoltà

| Livello | Count |
|---------|------:|
| easy    | 148 |
| medium  | 257 |
| hard    | 95 |

### Categoria

| Categoria | Count |
|-----------|------:|
| character | 89 |
| anagraphic | 87 |
| plot | 79 |
| consequence | 59 |
| scene | 47 |
| object | 39 |
| relationship | 33 |
| motivation | 24 |
| trivia | 21 |
| quote_paraphrase | 12 |
| chronology | 10 |
| episode | 0 |

## 5. File generati

| File | Descrizione | Domande |
|------|-------------|--------:|
| [quiz_questions_import_ready.json](quiz_questions_import_ready.json) | Set completo pulito, pronto per import (status invariato: `beta_pending_review`). | 500 |
| [quiz_questions_medium_review.json](quiz_questions_medium_review.json) | Subset `confidence == "medium"` per review manuale. Le stesse domande restano anche nel file principale. | 16 |
| [quiz_questions_heavy_spoiler_review.json](quiz_questions_heavy_spoiler_review.json) | Subset `spoilerLevel == "heavy"` per review manuale dello spoiler-gating. | 101 |

## 6. Validazione finale (import_ready)

| Check | Esito |
|-------|-------|
| JSON valido (parse OK) | ✅ |
| Totale domande = 500 | ✅ |
| `questionId` univoci | ✅ (500 distinti) |
| Ogni domanda ha 4 risposte non vuote | ✅ |
| `correctAnswerIndex` ∈ [0, 3] su tutte | ✅ |
| `answerOrderShuffled == true` su tutte | ✅ |
| `language == "it"` su tutte | ✅ |
| `status == "beta_pending_review"` su tutte | ✅ |
| Issue strutturali riscontrate | 0 |

## 7. Problemi rilevati durante il processing

Nessuno. 500/500 domande processate con successo, 0 strutture invalide, 0 risposte vuote post-normalizzazione, 0 perdite della risposta corretta nel reshuffle (verificato per identità testuale prima/dopo).

## 8. Dubbi contenutistici NON corretti (per revisione umana)

Per regola: niente correzioni inventate. I seguenti casi richiedono revisione manuale (non sono stati modificati):

- **Categoria `episode` assente** (0 domande) nonostante 5 serie TV nel set. Non è una correzione automatica: serve produrre nuove domande con categoria mirata.
- **16 domande `confidence: medium`** raccolte in `quiz_questions_medium_review.json` — vanno verificate contro fonti esterne (TMDB, Wikipedia, script).
- **`tmdbId` non riverificati** vs TMDB live. I valori usati provengono dal prompt sub-agent e non sono stati cross-checkati.
- Eventuali sfumature di significato (es. termini regionali, distrattori troppo vicini) **non** sono state toccate da normalizzazione: se il revisore vuole riformulare, va fatto manualmente sul file `import_ready`.

## 9. Reminder operativo

- Tutte le 500 domande mantengono `status: "beta_pending_review"`. **Nessuna è ancora pronta per la produzione utente** senza review umana.
- Prima dell'import: definire schema collection target Firestore e aggiornare `firestore.rules`. Non è stato fatto qui.
- I file `_cleanup_stats.json`, `_validation_stats.json`, `batch_*.json`, `cleanup.cjs`, `merge.cjs` sono di servizio (replay/debug) ed eliminabili.
