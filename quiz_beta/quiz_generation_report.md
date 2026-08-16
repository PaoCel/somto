# Quiz Beta — Report di generazione

Generato: 2026-05-11
Progetto Firebase: `gia-visto`
Operatore: AI (read-only sul DB, nessun deploy, nessun write).

## 1. Identificazione dei 20 titoli più visti

### Definizione operativa di "visto"

Nel DB di Somto/2watch **non esiste un flag esplicito `watched: true`**. La struttura reale (verificata in produzione) è:

- `users/{uid}/library/{titleId}` — libreria personale. Ogni doc rappresenta un titolo che l'utente ha **valutato** (campo `lastRating` presente). Non esistono i campi `status: watched|watching|planned|dropped` descritti nel vecchio `db-legenda.txt`. La libreria reale è popolata solo da titoli con rating.
- `ratings/{uid}__{titleId}__title__0__0` — rating canonici (level=`title`). Equivalenti alla libreria, con metadati aggiuntivi (rating, reviewText, watchedAt opzionale).
- `userLists/{listId}` — liste create dall'utente. Le liste con `title: "Da Vedere"` sono **watchlist** e sono state **escluse** dal conteggio.

Quindi il segnale "visto" usato qui è:
**`utenti unici che hanno il titolo in `ratings` con `level=title` o in `users/{uid}/library/{titleId}`** (unione).

Le watchlist (`userLists "Da Vedere"`) non sono mai contate come visto.

### Algoritmo di ranking

1. Carico tutto `ratings where level=="title"` (513 doc) → mappa `titleId -> {uniqueUsers, totalEvents, sumRating, ratingsCount, reviewsCount}`.
2. Carico collection group `library` (524 doc) → mappa parallela `titleId -> {libUsers, libTotal}`.
3. Unisco gli insiemi di utenti (set union) → `watchedByUniqueUsers`.
4. Sort:
   1. `watchedByUniqueUsers` desc
   2. `totalWatchedEvents` desc
   3. `averageRating` desc

### Path/collection usati

- `ratings` (root, `where level=="title"`)
- `users/{uid}/library/{titleId}` via `collectionGroup('library')`
- `titles/{titleId}` per enrich di `name`, `type`, `year`, `tmdbId`, `originalName`
- `userLists` (controllata e **esclusa** quando `title == "Da Vedere"`)

### Dubbi sul calcolo

- Il DB è **piccolo** (max 5 utenti unici per titolo, mediana ~3-4). La beta è in stato iniziale. Il ranking ha quindi molte parità risolte da rating medio.
- Non esiste un campo esplicito `watchedAt` su tutte le librerie. Si assume che la presenza in `library/ratings(level=title)` sia equivalente ad aver visto il titolo (l'app permette di valutare solo quel che è stato visto). Se in futuro venisse aggiunto un flag `watched` distinto dal rating, il ranking andrebbe rifatto.
- Alcuni `titleId` sono slug (`sole-a-catinelle-2013`, `suits-na-tv`, `a-beautiful-mind-2001`) anziché ID Firestore random — coesistenza di due convenzioni nei `titles`. Non impatta il conteggio.
- `tmdbId` nei titoli proviene dal campo root `tmdbId` (non `externalIds.tmdb`). Sempre presente per i top 20.

## 2. Top 20 titoli identificati

| Rank | Titolo | Tipo | Anno | Utenti unici | Eventi | Rating medio |
|------|--------|------|------|--------------|--------|--------------|
| 1 | Black Widow | movie | 2021 | 5 | 5 | 7.90 |
| 2 | The Greatest Showman | movie | 2017 | 4 | 4 | 9.88 |
| 3 | La fabbrica di cioccolato | movie | 2005 | 4 | 4 | 9.25 |
| 4 | Breaking Bad | tv | 2008 | 4 | 4 | 9.25 |
| 5 | The Avengers | movie | 2012 | 4 | 4 | 9.00 |
| 6 | Iron Man | movie | 2008 | 4 | 4 | 8.81 |
| 7 | Guardiani della Galassia | movie | 2014 | 4 | 4 | 8.38 |
| 8 | Ant-Man | movie | 2015 | 4 | 4 | 7.75 |
| 9 | Captain America - Il primo vendicatore | movie | 2011 | 4 | 4 | 7.69 |
| 10 | Iron Man 3 | movie | 2013 | 4 | 4 | 7.56 |
| 11 | Avengers: Age of Ultron | movie | 2015 | 4 | 3 | 9.00 |
| 12 | Guardiani della Galassia Vol. 2 | movie | 2017 | 4 | 3 | 8.17 |
| 13 | Interstellar | movie | 2014 | 3 | 3 | 10.00 |
| 14 | Better Call Saul | tv | 2015 | 3 | 3 | 9.58 |
| 15 | Sole a catinelle | movie | 2013 | 3 | 3 | 9.50 |
| 16 | Suits | tv | 2011 | 3 | 3 | 9.50 |
| 17 | Squid Game | tv | 2021 | 3 | 3 | 9.17 |
| 18 | A Beautiful Mind | movie | 2001 | 3 | 3 | 9.08 |
| 19 | La casa di carta | tv | 2017 | 3 | 3 | 9.08 |
| 20 | Sopravvissuto - The Martian | movie | 2015 | 3 | 3 | 8.67 |

Dataset corpose Marvel (10/20 titoli MCU) per via di un test/seed con quel cluster di rating. In produzione "vera" il top potrebbe cambiare velocemente.

## 3. Anti-allucinazione (sourceLevel)

| Livello | Titoli |
|---------|--------|
| GREEN   | 20/20 |
| YELLOW  | 0 |
| RED     | 0 |

Tutti i titoli sono **mainstream celebri** (cult MCU, blockbuster, serie premium). Nessuno richiede degradazione a YELLOW/RED.

## 4. Domande generate

- Totale domande: **500** (target: 500). 25 per titolo.
- File: [quiz_questions_beta.json](quiz_questions_beta.json)

### Distribuzione confidence

| Confidence | Count |
|------------|-------|
| high       | 484 |
| medium     | 16 |
| low        | 0 |

I 16 a `medium` sono concentrati su domande di micro-dettaglio (es. *Ant-Man* formiche specifiche, *Sole a catinelle* dettagli di scena) — segnati con `riskNotes` per revisione manuale prioritaria.

### Distribuzione difficoltà

| Difficulty | Count |
|------------|-------|
| easy       | 148 |
| medium     | 257 |
| hard       | 95 |

### Distribuzione spoiler

| Spoiler | Count |
|---------|-------|
| none    | 136 |
| light   | 151 |
| medium  | 112 |
| heavy   | 101 |

Spoiler `heavy` correttamente applicati a finali/morti/twist principali (es. Charles in *A Beautiful Mind*, finale di *Breaking Bad*, identità del Front Man in *Squid Game*).

### Distribuzione categorie

| Categoria | Count |
|-----------|-------|
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

Nessuna domanda categoria `episode` — pur essendoci 5 serie TV, gli agenti hanno preferito `plot`/`scene`/`character`. Non è bloccante ma se vuoi una sezione dedicata "Qual è l'episodio in cui …" è un possibile follow-up.

## 5. Validazione strutturale

Tutti i controlli passati (0 issue):
- ✅ JSON valido (parse OK)
- ✅ 500/500 domande con 4 risposte non vuote
- ✅ `correctAnswerIndex` ∈ [0,3] per tutte
- ✅ `questionId` univoci (pattern `q_<rank>_<index>`)
- ✅ `language: "it"` ovunque
- ✅ Nessun duplicato esatto di `questionText` nello stesso titolo
- ✅ `status: "beta_pending_review"` per tutte
- ✅ Mix di difficoltà e categorie rispettato per titolo

## 6. Rischi principali

1. **Distribuzione `correctAnswerIndex` sbilanciata.** Conteggio globale: 0=126, 1=237, 2=87, 3=50. L'indice 1 è scelto nel 47% dei casi, l'indice 3 solo nel 10%. Un utente attento potrebbe sviluppare bias di tipping. In particolare batch 1 (rank 1-4) non usa mai l'indice 3, e batch 4 (rank 13-16) ha 53 risposte su B / 0 su D. **Consiglio: rishuffle automatico delle risposte prima dell'import** (mantenendo `correctAnswerIndex` aggiornato).

2. **Domande di micro-dettaglio in `confidence: medium`** (16 totali). Andrebbero verificate manualmente contro le fonti (TMDB, Wikipedia, script ufficiale) prima di andare in produzione.

3. **Bias MCU.** 10/20 titoli sono Marvel: il quiz beta risulterà molto Marvel-skewed. È un fatto del DB attuale, ma per la beta utenti reali potresti voler mescolare i titoli per genere (es. estrarre top 10 movie + top 10 tv) per evitare monotonia.

4. **`tmdbId` da verificare.** Gli agenti hanno usato `tmdbId` dichiarati nel prompt; tutti sembrano corretti ma non sono stati cross-verificati live contro TMDB. Se servono link a TMDB nel runtime, vale la pena un controllo. (Il campo `tmdbId` proveniente dal DB è autoritativo: usa quello in `quiz_top20_titles.json` come fonte primaria.)

5. **Slug-id vs random-id.** Alcuni `titleId` sono slug (`sole-a-catinelle-2013` ecc.). Se la feature Quiz li joina con `titles/{titleId}`, deve gestire entrambi.

6. **Sample piccolo (max 5 utenti).** Il ranking è statisticamente fragile: bastano 1-2 nuovi rating per cambiarlo. Per beta va bene; per produzione ripeti l'estrazione vicino al lancio.

7. **Nessuna domanda categoria `episode`** per le serie TV. Non bloccante ma è un buco di copertura.

## 7. Cosa fare PRIMA di importare nel DB

1. **Reshuffle posizioni risposte** + ricalcolo `correctAnswerIndex` (script semplice, 10 righe di JS). Rimuove il bias di indice 1.
2. **Review umana dei 16 `confidence: medium`** (filtra `confidence==medium` nel JSON).
3. **Review umana di tutte le domande `spoilerLevel: heavy`** (101) per assicurarsi che la categoria/posizione UX sia corretta: la beta dovrebbe permettere all'utente di evitarle se non ha finito il titolo.
4. **Spot-check 1 domanda hard random per titolo** (20 domande totali) — sanity check sull'accuratezza fattuale.
5. **Definisci schema collection target** (es. `quizQuestions/{questionId}` o `titles/{titleId}/quizQuestions/{questionId}`) e aggiorna `firestore.rules` prima del primo write. Mantieni `status: "beta_pending_review"` per filtrare lato app.
6. **Aggiungi indice composto** se l'app farà `where titleId == X and where status == approved` (Firestore lo richiederà).
7. **Considera cap di esposizione** per i 16 medium-confidence finché non sono validati.

## 8. Titoli che consiglio per revisione manuale prioritaria

- **Sole a catinelle** (rank 15): film italiano less-mainstream-internazionale. Alcune domande di scena potrebbero contenere imprecisioni. Tutti i `medium confidence` di questo titolo da verificare per primi.
- **Ant-Man** (rank 8): dettagli sulle formiche e gadget specifici sono il punto debole noto. 2-3 domande da spot-check.
- **Suits** (rank 16) e **Better Call Saul** (rank 14): 9 e 6 stagioni rispettivamente. Le domande sono distribuite multi-stagione ma chronology esatta dei minor characters può scivolare — controllo consigliato su tutte le `confidence < high`.

## 9. Output prodotto

- `quiz_top20_titles.json` — i 20 titoli più visti
- `quiz_questions_beta.json` — le 500 domande quiz beta
- `quiz_generation_report.md` — questo report
- (file di servizio: `batch_1..5.json`, `_validation_stats.json`, `merge.cjs` — utili per replay/debug, eliminabili)

Tutti i file in: `./quiz_beta/`

**Nessuna modifica al DB, nessun deploy, nessuna modifica al codice dell'app.**
