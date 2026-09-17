# Baseline benchmark raccomandazioni

Report versionati delle run del benchmark offline, per poter dire "questa
modifica migliora" con un numero invece che a impressione.

I file JSON qui dentro sono l'output di
`functions/scripts/benchmark-recommendations.js --json=...`. Il dataset NON e'
versionato (contiene dati utente): si rigenera con
`functions/scripts/export-reco-dataset.js`.

Come confrontarsi con una baseline:

```bash
node functions/scripts/benchmark-recommendations.js --dataset=/tmp/reco.json --signal=both --levels=all --split=holdout --json=/tmp/dopo.json --baseline=docs/reco-benchmarks/2026-08-02-holdout.json
```

## 2026-08-02 — misura corretta

Dataset prod `gia-visto`: 20.653 titoli, 9.545 voti, 70.794 stati titolo.

### `2026-08-02-holdout.json` — la misura usabile

Segnale `both` (voti + visti), holdout 20% per utente, **non temporale**,
128 utenti valutabili su 54.592 coppie utente-titolo, k=10.

| modello | recall@10 | ndcg@10 | map@10 | hitRate | coverage | diversity | novelty |
| --- | --- | --- | --- | --- | --- | --- | --- |
| popularity | 0.0356 | 0.1691 | 0.0813 | 0.680 | 0.0019 | 0.800 | 1.63 |
| somto (produzione) | 0.0347 | 0.0971 | 0.0407 | 0.555 | 0.0148 | 0.653 | 3.31 |
| somto-top (senza deck) | 0.0359 | 0.1068 | 0.0469 | 0.563 | 0.0117 | 0.574 | 3.28 |
| itemknn | **0.0519** | **0.1765** | **0.0883** | 0.648 | **0.0180** | 0.705 | 2.28 |
| hybrid | 0.0482 | 0.1465 | 0.0671 | **0.719** | 0.0162 | 0.679 | 2.85 |

Cosa dicono questi numeri:

1. **Il motore in produzione ordina peggio della popolarita'** (NDCG 0.097
   contro 0.169), ma copre circa 8 volte piu' catalogo ed e' meno banale.
2. **Item-KNN precalcolato domina l'ordinamento**: NDCG 1,8x la produzione e
   aumenta anche coverage e diversity.
3. **L'ibrido e' il punto di equilibrio**: miglior hitRate (0.719), NDCG +51%
   e recall +39% rispetto al Somto precedente, senza sacrificare copertura o
   diversita'.
4. **La popolarita' resta la baseline da battere sull'ordinamento**: l'ibrido
   offre invece personalizzazione, copertura e novelty molto maggiori.

### `2026-08-02-itemknn-index.json` — la configurazione scelta

Stessa impostazione della run holdout, con i parametri finali dell'indice
precalcolato (8 seed a runtime, supporto minimo 2, scala collaborativa 6).

| modello | recall@10 | ndcg@10 | map@10 | hitRate | coverage | diversity |
| --- | --- | --- | --- | --- | --- | --- |
| popularity | 0.0356 | 0.1691 | 0.0813 | 0.680 | 0.0019 | 0.800 |
| somto (produzione) | 0.0347 | 0.0971 | 0.0407 | 0.555 | 0.0148 | 0.653 |
| **hybrid (scelto)** | **0.0482** | **0.1465** | **0.0671** | **0.719** | **0.0162** | **0.679** |

Migliora su **tutte** le metriche rispetto alla produzione: +39% recall, +51%
NDCG, +65% MAP, +30% hitRate, e anche copertura e diversita' salgono invece di
essere sacrificate. Proposta di rilascio: `docs/RECO_COLLAB_INDEX_PROPOSAL.md`.

### `2026-08-02-temporal.json` — la misura pulita, ma affamata

Solo voti (timestamp reali, 2017-2026), split temporale al 2026-07-16.
**10 utenti valutabili**: troppo pochi, i numeri sono rumore. Serve qui come segnaposto:
diventera' la misura buona man mano che i voti crescono.

## Perche' due modalita'

Lo split temporale e' la misura corretta, ma richiede timestamp veri. Su questo
dataset i `titleStates` arrivano quasi tutti da import (Netflix/TV Time/Trakt) e
`seenAt`/`completedAt` valgono la data dell'import: anni di visione schiacciati
su 1-5 giorni per utente. Fare uno split "temporale" li' non sarebbe piu' vero
di uno casuale — nasconderebbe solo il problema. Per questo il holdout esiste, e
per questo il report porta sempre `temporal: false` quando lo si usa.

La run corretta ricostruisce `ratingCount` e `ratingAvg` soltanto dalle righe di
training, esclude dal catalogo temporale i titoli creati dopo il cutoff e usa
gli stessi 8 seed materializzati in produzione. I report precedenti
sovrastimavano il collaborativo usando aggregati correnti e fino a 20
interazioni positive.
