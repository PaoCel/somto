# Proposta: indice collaborativo precalcolato

Stato: **LIVE su prod dal 2026-08-02.** Functions deployate, indice costruito
(4.352 titoli), verificato end-to-end. Rules invariate. Resta una coda aperta,
in fondo al documento.

## Il problema

`computeCollaborativeSignals` ricalcolava la similarita' fra titoli **a ogni
apertura di Match**: per 5 titoli seed leggeva `ratings` (cap 320 doc l'uno),
poi rileggeva i voti dei 24 utenti piu' simili (cap 220 doc l'uno). Fino a
**~6.900 letture Firestore per singola richiesta**, con un costo che cresce
insieme al catalogo e agli utenti — cioe' il contrario di quello che serve.

E, misurato: il deck Match ordinava **peggio di una classifica di popolarita'**
(NDCG@10 0.097 contro 0.169 nel benchmark corretto).

## La modifica

Il lavoro si fa **una volta** in un job schedulato e a runtime restano poche
letture per id.

| | prima | dopo |
| --- | --- | --- |
| letture per richiesta Match | fino a ~6.900 | **max 8** |
| costo per richiesta | cresce con utenti e catalogo | O(seed), costante |
| NDCG@10 (deck Match) | 0.0971 | **0.1465** (+51%) |
| recall@10 | 0.0347 | **0.0482** (+39%) |
| hitRate@10 | 0.555 | **0.719** (+30%) |
| coverage | 0.0148 | **0.0162** (+9%) |
| diversity | 0.653 | **0.679** (+4%) |

Non e' un compromesso: migliora su **tutte** le metriche, comprese copertura e
diversita' che la fase 5 del piano chiede esplicitamente di non peggiorare.

## Schema dati — nessuna regola nuova

L'indice sta in **`titles/{titleId}/aggregates/similar`**, cioe' dentro la
sottocollezione server-owned che esiste gia' (usata da `characters` dei voti
personaggi) e che nelle rules e' gia':

```
match /titles/{titleId}/aggregates/{docId} {
  allow read: if isSignedIn();
  allow write: if false;
}
```

Quindi: **`firestore.rules` non cambia**, nessuna collection nuova, nessuna
superficie nuova da revisionare, nessun indice composito da creare.

Forma del doc (~1,6 KB, max 40 vicini):

```
{ titleId, neighbors: [{ id, score }], version: 1, source: "cooccurrence", updatedAt }
```

Riepilogo dell'ultima esecuzione in `appConfig/titleSimilarity` (`appConfig` e'
gia' deny-all lato client).

## Sicurezza e privacy

- **Il client non puo' scrivere l'indice.** Chi potesse farlo deciderebbe cosa
  viene consigliato a tutti gli altri. Contratto pinnato da un rules test nuovo
  (`titles/{id}/aggregates/similar`: read signed-in, read anonimo negato, write
  client negata). 182 rules test verdi nell'emulatore.
- **Nessun dato personale nel doc**: solo id titolo e punteggi. Da un doc
  `similar` non si risale a chi ha visto cosa — sono aggregati su piu' utenti,
  e il supporto minimo di 2 co-visioni esclude per costruzione i legami
  riconducibili a una persona sola.
- **Profili guidati e contenuti sintetici esclusi** dalla costruzione
  (`isGuidedUid`, `isSynthetic`), come per gli altri aggregati pubblici.
- La callable di ricostruzione e' **admin-only** e in **dry-run di default**:
  una build tocca migliaia di doc, non deve partire per sbaglio.

## Costi

Build (settimanale): ~80k letture + ~4.900 scritture ≈ **$0,06 a esecuzione**.
Runtime: da ~6.900 a **8 letture** per apertura di Match — a regime si ripaga
dopo poche decine di richieste.

## Scalabilita': il limite e' esplicito, non a sorpresa

Il costo della build e' O(Σ min(item_utente, cap)²). Misurato sul dataset del
2026-08-02 (202 utenti, 54.590 interazioni positive): **6,0M coppie, 726 MB di
RSS, 2,1 s** — da cui `memory: "2GB"`, `timeoutSeconds: 540`.

Cresce col numero di utenti. Invece di scoprirlo con un OOM in produzione, il
builder **stima le coppie e abbassa da solo il cap per utente** finche' rientra
nel budget (9M coppie ≈ 1,1 GB, margine reale sui 2 GB), e **logga la
riduzione**. Quando quel warning compare nei log e' il segnale che serve una
build incrementale o a shard — non che si alza il numero.

## Migrazione e rollback

- **Nessuna migrazione dati.** Non si tocca niente di esistente.
- Fra il deploy e la prima build l'indice e' vuoto: Match perde solo il bonus
  collaborativo e continua a funzionare su generi, persone e taste profile.
  Per questo la prima build va lanciata **subito dopo** il deploy.
- **Rollback**: si ri-deploya la versione precedente delle functions. I doc
  `similar` rimasti sono inerti — nessuno li legge piu'.

## Rilascio eseguito (2026-08-02)

1. `firebase deploy --only functions:rebuildTitleSimilarities,functions:rebuildTitleSimilaritiesNow,functions:getMatchQueue,functions:recommendTitlesByTaste` — OK.
2. Dry-run: 54.591 interazioni, 162 utenti, 5,97M coppie, `capReduced: false`,
   4.352 titoli indicizzabili. 46,9 s.
3. Build reale (`node functions/scripts/rebuild-title-similarities.js --write`):
   **4.352 doc scritti in 99,4 s**.
4. Verifica end-to-end su prod con l'account QA: `getMatchQueue` risponde
   `engine: hybrid+collab+taste` — l'indice viene letto davvero.
5. Controllo qualita' a campione: Breaking Bad → La casa di carta (0,657),
   Stranger Things (0,650), Squid Game (0,637), Lost (0,598), Dark (0,592).
6. `firestore:indexes` deployato + le due functions ri-deployate dopo il
   refactor in `lib/titleSimilarityJob.js`.

## Code aperte

- ~~Indice collection-group `aggregates.version`~~ — **chiuso il 2026-08-02**:
  costruito e verificato (4.352 doc raggiungibili dalla query). La pulizia degli
  orfani funziona, il giro settimanale la usera'. Durante la prima build era
  ancora in costruzione: la guardia ha degradato a warning senza far fallire
  niente, e orfani non ce n'erano.
- **Match resta lento: 7-12 s a caldo.** NON e' il collaborativo (ora 8 letture
  totali, ~0,4 s): il tempo se ne va in `collectCandidatePool`, che per ogni
  richiesta scandisce ~1.000 doc del catalogo da 20.653 titoli. E' il collo di
  bottiglia successivo, preesistente a questa modifica.

## Passi di rilascio (riferimento)

1. `firebase deploy --only functions:rebuildTitleSimilarities,functions:rebuildTitleSimilaritiesNow,functions:getMatchQueue,functions:recommendTitlesByTaste --project prod`
2. `rebuildTitleSimilaritiesNow({ dryRun: true })` → controllare i contatori
   (attesi ~4.900 titoli indicizzati, `capReduced: false`).
3. `rebuildTitleSimilaritiesNow({ dryRun: false })` → prima build reale.
4. Aprire Match e verificare che `engine` contenga `collab`.
5. Da li' in poi il job settimanale mantiene l'indice.

## Cosa questa misura NON dice

I 128 utenti valutabili vengono da un holdout **non temporale**: i `titleStates`
importati portano la data dell'import, non della visione. E' la misura piu'
onesta disponibile oggi, non una prova definitiva. Lo split temporale — quello
corretto — ha 10 utenti e diventera' significativo man mano che i voti crescono.
Il guadagno e' grande e coerente su tutte le metriche, il che lo rende credibile,
ma va riverificato quando ci saranno piu' dati.
