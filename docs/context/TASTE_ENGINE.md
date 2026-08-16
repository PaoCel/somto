# Motore gusti e suggerimenti

Leggi per: profilo gusti (`tasteProfile`), Match, consigli AI, scoring candidati,
segnali collaborativi, affinita' piattaforma.
Piano di evoluzione (fase 5, condiviso con Codex): `docs/TITLE_UPDATES_RECOMMENDATIONS_PLAN.md`.

## Mappa: dove vive cosa

| Pezzo | File |
| --- | --- |
| Matematica gusti (pura, testabile) | `functions/lib/tasteProfileAggregate.js` |
| **Scoring, seed stats, affinita', deck (puro)** | `functions/lib/recommendationEngine.js` |
| Etichette di genere (puro) | `functions/lib/genreLabels.js` |
| Helper minimi condivisi (puro) | `functions/lib/pureUtils.js` |
| **Indice collaborativo precalcolato** | `functions/lib/itemSimilarity.js` |
| **Benchmark offline** | `functions/lib/recoBenchmark.js` + `functions/scripts/benchmark-recommendations.js` |
| Export dataset per il benchmark | `functions/scripts/export-reco-dataset.js` |
| Trigger segnale → profilo | `updateTasteProfileOnSignal` (`functions/index.js`) |
| Fold import → profilo | `applyImportTasteProfile` + `finalizeImportResults` (`functions/index.js`) |
| Deck Match (I/O + orchestrazione) | `getMatchQueue` (`functions/index.js`) |
| Consigli AI (seed espliciti) | `recommendTitlesByTaste` (`functions/index.js`) |
| Segnali lato client | `public/js/api/signals.api.js`, iOS `UserRepository` |
| Consumer Match | `public/js/pages/match.page.js`, iOS `MatchRepository` + `MatchView` |
| Provider (piattaforme) | `functions/lib/watchProviders.js`, callable `suggestWatchProvider` |
| Unit test | `tasteProfileAggregate.test.cjs` (16), `recommendationEngine.test.cjs` (25), `recoBenchmark.test.cjs` (32), `itemSimilarity.test.cjs` (16) |

Dopo l'estrazione del 2026-08-02 in `functions/index.js` restano SOLO le funzioni
che leggono Firestore: `resolveSeedTitles`, `collectCandidatePool`,
`loadUserSeenTitleIds`, `loadGenreLabelMap`, `loadTasteProfile`,
`computeCollaborativeSignals`, `rerankCandidatesWithOpenAI`, i loader di seed
(`loadUserMatchSignals`, `loadUserWatchlistSignals`, `loadUserRatingSeedScores`,
`loadUserLibrarySeedScores`, `loadOnboardingSeedScores`, `loadMatchSeedTitleIds`)
e i due callable. Tutto il resto e' nel modulo puro.

**Regola**: una formula di scoring nuova va in `lib/recommendationEngine.js`, mai
in `index.js` — altrimenti esce dal perimetro del benchmark e smette di essere
misurabile.

## Modello dati

`users/{uid}/tasteProfile/agg`:

```
featureSums.<bucket>.<id> = { sum, weight, lastAt }
bucket ∈ { genres, people, directors, countries }
confidenceScore = clamp(onboardingLevel*15 + min(70, pesoCumulativo*12), 0, 100)
```

- **Affinita' a valle** = `sum / (weight + 1.2)`, clamp `[-1, 1]` (`buildAffinityMap`).
- **Decay** temporale su `lastAt`, half-life `MATCH_TASTE_HALF_LIFE_MS = 120 giorni`;
  sotto `MATCH_TASTE_MIN_WEIGHT = 0.15` di peso efficace la feature sparisce.
- **Cap bucket** (`BUCKET_CAPS`: genres 50, people 400, directors 250, countries 80)
  per non sfondare il limite doc dopo un import massivo: si tiene il top-K per peso.
- `confidenceScore` e' **cumulativo** dal 2026-07-13 (prima veniva sovrascritto col
  peso del singolo segnale — bug latente).

Pesi feature per titolo (`FEATURE_WEIGHTS`, take 3/3/1/1):
generi `[1.0,0.6,0.4]*0.60`, cast `[1.0,0.6,0.4]*0.30`, regista `[0.25]`, paese `[0.12]`.

Pesi azione (`ACTION_WEIGHTS`, `delta = normalized * weight`):

| azione | weight | normalized |
| --- | --- | --- |
| `rating` | 1.00 | voto reale → `(v-5.5)/4.5` |
| `suggest_to_friend` | 0.70 | +1 |
| `match_love` | 0.60 | +1 |
| `match_dislike` | 0.55 | -1 |
| `watchlist_add` / `watchlist_remove` | 0.45 | +1 / -1 |
| `thread_post` | 0.20 | +1 |
| `match_ok` | 0.15 | +1 |
| `import_seen` | 0.15 | +0.30 |
| `match_seen` | 0.05 | 0 (no-op) |

## Due sorgenti, una matematica

1. **In-app**: il client scrive `users/{uid}/signals/{id}` → trigger
   `updateTasteProfileOnSignal` (gen1, europe-west1) applica il delta di UN titolo.
2. **Import** (Netflix/TV Time/Trakt): niente fan-out di segnali. `applyImportTasteProfile`
   fa **un fold di N titoli in una transazione** (`buildImportTasteInputs` +
   `foldTitleDeltas`): voto reale dove esiste, altrimenti `import_seen`.

Backfill una-tantum: `functions/scripts/backfill-import-taste.js` (idempotente via
marker `tasteBackfill`, `--force` per rifare). Eseguito su prod 2026-07-13: 112/251 utenti.

## Match: come si costruisce il deck (`getMatchQueue`)

1. **Seed** — `loadMatchSeedTitleIds` unisce voti alti, watchlist, like Match e
   onboarding (`loadUserRatingSeedScores` / `loadUserLibrarySeedScores` /
   `loadOnboardingSeedScores`), con recency `MATCH_SEED_RECENCY_MS = 180 giorni`.
2. **Pool candidati** — `collectCandidatePool` per popolari / recenti / genere /
   token / correlati (limiti dimezzati con `fastStart: true`).
3. **Esclusioni** — visti, watchlist, gia' piaciuti, skip in cooldown
   (`MATCH_SKIP_COOLDOWN_MS` 14gg), gia' mostrati (`MATCH_SHOWN_COOLDOWN_MS` 10h),
   piu' gli `excludeTitleIds` passati dal client (cap 600).
4. **Scoring** — `scoreCandidate` (overlap generi/token/persone + collab) poi
   `scorePeopleAffinity` e `scoreTasteBias` (bonus/penalita' da profilo gusti),
   piu' correttivi grezzi: `ratingCount < 2` → -0.35, `>= 45` → +0.45, anno >= 2019 → +0.25.
5. **Cold start** — `seedTitles < 3` o `confidenceScore < 18` → soglia 0.35 (invece
   di 0.65) e bonus ai titoli popolari con voto alto.
6. **Deck** — `pickMatchDeck`: 80% sfruttamento + 20% esplorazione (finestra dal
   35% in giu', preferendo generi nuovi o titoli freschi < 90gg), poi
   `diversifyMatchRows` con gap minimo su saga/genere. `computeMatchPercent`
   converte lo score in "% match" mostrata in UI (range 35-99).
7. **Fallback** — se lo scoring lascia meno di `max` titoli si riempie dai popolari,
   cosi' il deck non e' mai vuoto.

Risposta: `{ engine, rationale, items, seedCount, poolCount, generatedAtMs }` —
`engine` e' la stringa diagnostica `hybrid[+collab][+taste][+cold]`.

## Segnali collaborativi — indice precalcolato

**LIVE dal 2026-08-02** (vedi `docs/RECO_COLLAB_INDEX_PROPOSAL.md`): la
similarita' fra titoli non si ricalcola piu' a ogni richiesta. Indice costruito
su 4.352 titoli; `getMatchQueue` in prod risponde `engine: hybrid+collab+taste`.

- **Build**: job settimanale `rebuildTitleSimilarities` (+ callable admin
  `rebuildTitleSimilaritiesNow` e script ops
  `functions/scripts/rebuild-title-similarities.js [--write]`, entrambi dry-run
  di default; logica condivisa in `lib/titleSimilarityJob.js`). Legge i `titleStates`
  consumati e i voti >= 7, calcola il coseno sulle co-occorrenze, scrive
  `titles/{id}/aggregates/similar` (max 40 vicini, ~1,6 KB a doc).
- **Runtime**: `computeCollaborativeSignals` legge un doc per seed, **max 8
  letture** invece di ~6.900. Costo per richiesta O(seed), indipendente da quanto
  crescono catalogo e utenti.
- **Rules invariate**: `titles/{id}/aggregates/{docId}` era gia' server-owned
  (read `isSignedIn`, write `false`).
- **Parametri verificati sul benchmark corretto**: 8 seed a runtime, uguali agli
  8 titoli materializzati da `resolveSeedTitles`; supporto minimo 2 co-visioni;
  scala del punteggio collaborativo 6; 400 titoli per utente in build. Il
  benchmark deriva gli aggregati soltanto dal train e non usa piu' dati futuri.
- **Guardia di scala**: il costo di build e' O(Σ min(item, cap)²). Il builder
  stima le coppie e abbassa da solo il cap per utente per stare nel budget
  (9M coppie ≈ 1,1 GB su una function da 2 GB), loggando la riduzione. Quel
  warning nei log = e' ora di una build incrementale, non di alzare il budget.

## Consigli AI (`recommendTitlesByTaste`)

Seed **espliciti** passati dal client (min 3 titoli), filtri `preferredType` /
`decade` / `mood`, stesso `scoreCandidate` + collab, poi `selectTopWithDiversity`.
Se `OPENAI_API_KEY` e' presente fa un rerank semantico (`rerankCandidatesWithOpenAI`);
senza chiave resta deterministico. Rate limit: 3/15s, 60/giorno.

## Benchmark offline

Serve a rispondere a "questa modifica migliora i consigli o mi sembra e basta?".
Gira su uno snapshot JSON locale: **nessuna lettura Firestore a ogni run, nessuna
scrittura, nessun effetto su produzione**.

```bash
node functions/scripts/export-reco-dataset.js --out=/tmp/reco.json --project=gia-visto
```

```bash
node functions/scripts/benchmark-recommendations.js --dataset=/tmp/reco.json --signal=both --levels=all --split=holdout
```

Per provare l'harness senza toccare prod: `--synthetic=300` sull'export genera un
dataset finto in cui gli utenti hanno un genere preferito.

**Risultati e baseline versionate: `docs/reco-benchmarks/`.** Misura corretta
del 2026-08-02: il motore in produzione ordina peggio di una classifica di
popolarita' (NDCG 0.097 contro 0.169) ma copre circa 8 volte piu' catalogo;
l'ibrido porta NDCG a 0.147 e ha il miglior hitRate tenendo alta la copertura.

Due modalita' di split, e vanno tenute distinte:

- `--split=temporal` (default) — la misura corretta, ma oggi ha **10 utenti
  valutabili**: i voti sono pochi. Rumore, per ora.
- `--split=holdout` — holdout 20% per utente, **non temporale**, 128 utenti.
  Esiste perche' i `titleStates` arrivano quasi tutti da import e
  `seenAt`/`completedAt` valgono la data dell'import: anni di visione schiacciati
  su 1-5 giorni. Uno split "temporale" li' sarebbe finto quanto uno casuale, con
  in piu' l'illusione del rigore. Il report porta `temporal: false`.

Segnali (`--signal`): `ratings` (esplicito, voto >= 7 = positivo), `watched`
(implicito, stati `completed_unrated`/`seen_unrated`/`rated`/`in_progress`;
la watchlist NON conta, e' intenzione non consumo), `both` (default, il voto
esplicito vince sullo stato implicito).

Come si legge il risultato — modelli a confronto sullo **stesso** split, **stesso**
pool di candidati, **stesse** esclusioni:

- `popularity` — baseline senza personalizzazione. Se il motore non la batte, non
  sta aggiungendo niente.
- `somto` — la pipeline di produzione, deck incluso (esplorazione 20% + diversita').
- `somto-top` — stesso scoring senza il deck: isola quanto costa in accuratezza la
  varieta' che introduciamo di proposito.
- `itemknn` — collaborativo item-item precalcolato, il candidato per sostituire
  `computeCollaborativeSignals`.
- `hybrid` — scoring Somto con i vicini item-item passati come segnale collaborativo.

Metriche: Recall@K, NDCG@K, MAP@K, hitRate, coverage (quanto catalogo viene
davvero raggiunto), diversity (1 - Jaccard medio sui generi), novelty (quanto sono
di nicchia i consigli), liste vuote.

Scelte che rendono la misura onesta, da non allentare:

- **Split temporale, mai casuale**: si allena su cio' che stava prima di una data
  e si valuta su cio' che e' venuto dopo.
- **`nowMs` fissato al cutoff**: decay del profilo e recency dei seed devono
  vedere il mondo com'era al momento della predizione.
- **Popolarita' calcolata solo sul train**: altrimenti la baseline saprebbe quanti
  voti un titolo prendera' dopo il cutoff.
- **Positivo = voto >= 7**: un titolo visto e non gradito non e' un successo.
- **PRNG con seed**: due run identiche danno lo stesso numero, cosi' un
  miglioramento si distingue dal rumore.

Per confrontare prima/dopo una modifica ai pesi:

```bash
node functions/scripts/benchmark-recommendations.js --dataset=/tmp/reco.json --json=/tmp/dopo.json --baseline=/tmp/prima.json
```

## Limiti noti (input per la fase 5)

- **Niente affinita' piattaforma.** `watchProviders` esiste per la scheda titolo
  (`suggestWatchProvider`) ma non entra nel profilo gusti ne' nello scoring; manca
  la distinzione `flatrate` vs noleggio/acquisto e la ripartizione del credito
  quando un titolo sta su piu' piattaforme.
- **Niente franchise/network** fra le feature: solo generi, persone, registi, paesi.
- **Motivazioni sommarie**: i `reasons` sono stringhe fisse, non legate al peso
  effettivo della feature che ha spinto il titolo.
- **Non c'e' segnale negativo dal dismiss** oltre a `match_dislike`: chiudere una
  corsia o ignorare un consiglio non lascia traccia.
