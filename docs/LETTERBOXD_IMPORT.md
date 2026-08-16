# Import da Letterboxd

Stato: **fase 1.5 — lavorazione manuale con runner**. L'utente carica lo zip da
`/import.html`, noi lo lavoriamo a mano con
`functions/scripts/process-letterboxd-import.js` (parser + fasi con snapshot e
rollback). Il flusso automatico self-service resta da fare.

## Come si esporta (lato utente)

Solo dal sito, non dall'app. Settings → Data → **Export your data**, oppure
diretto: `https://letterboxd.com/settings/data/`. Letterboxd genera un **.zip di
CSV** e lo scarica.

Fonte ufficiale (Letterboxd help): *"there's an account export option in Settings
that bundles your entire account (including deleted content, and reviews for
deleted films) into a single ZIP file of CSV documents"*.

Non risulta essere una feature Pro: la pagina Pro elenca statistiche, filtri
sulle piattaforme e niente pubblicità, l'export non compare. Se qualche utente ci
segnala un paywall, va verificato e la guida in `import.page.js` va corretta.

## Cosa dovrebbe esserci dentro (da confermare sui file veri)

Fonti terze concordi su cinque CSV principali: `diary` (ogni visione loggata con
data, voto, flag rewatch, tag), `ratings`, `reviews`, `watchlist`, e le liste
personalizzate. Colonne ricorrenti citate: `Date`, `Name`, `Year`,
`Letterboxd URI`, `Rating`, `Rewatch`, `Tags`, `Watched Date`. CSV UTF-8,
separatore virgola.

**Niente di questo è verificato sui nostri dati.** Nomi file, presenza di
sottocartelle (liste, likes), header multipli nei CSV delle liste e formato del
voto (0.5–5.0 contro la nostra scala 1–10) vanno letti dagli zip raccolti.

## Dove finiscono gli zip caricati

`gs://<bucket>/supportImports/{uid}/letterboxd-{timestamp}-{nomefile}.zip`

Stesso path della pagina di rescue (`/support-import.html`), stesse rules
(`storage.rules`, owner-only, < 30 MB, nessun cambio necessario). I file hanno
`customMetadata.source = "letterboxd_zip"`, così si isolano dagli altri upload di
supporto.

Per elencarli:

```bash
gsutil ls -l "gs://gia-visto.firebasestorage.app/supportImports/**/letterboxd-*"
```

## Promessa fatta all'utente

La UI dice esplicitamente che l'import Letterboxd è **manuale** e che ci vogliono
**fino a 24 ore**, e che scriviamo in chat a lavorazione finita. È una promessa
operativa: se arrivano zip e nessuno li lavora, la promessa è rotta. Finché la
sorgente è attiva, controllare la cartella con cadenza giornaliera.

## Runner manuale (`functions/scripts/process-letterboxd-import.js`)

Contenuto reale di un export (verificato su zip veri, 2026-08): `profile.csv`,
`watched.csv`, `ratings.csv`, `diary.csv`, `reviews.csv`, `watchlist.csv`,
`comments.csv`, più `deleted/`, `orphaned/`, `likes/`. Leggiamo solo
`watched`, `ratings`, `diary`, `watchlist`, `reviews`; il resto è ignorato per
scelta.

Fasi, in ordine (ognuna vuole `--uid` e `--object`):

1. dry-run (nessun flag mutante) → stampa il piano e il `planHash`;
2. `--prepare-titles --plan=… --generation=… --confirm-project=gia-visto` →
   prepara i titoli globali, nessun dato utente;
3. `--write --plan=… --generation=… --confirm-project=gia-visto` → snapshot
   immutabile + scrittura di titleStates, watchlist e voti;
4. `--finalize=IMPORT_ID --write --confirm-project=gia-visto [--delete-upload]
   [--notify]` → verifica, ricalcolo stats, cancellazione upload, messaggio in
   chat assistenza;
5. `--rollback=IMPORT_ID --write --confirm-project=gia-visto` per annullare.

### Fase recensioni (separata)

`--reviews` (dry-run) e `--reviews --write --plan=… --generation=…
--confirm-project=gia-visto`, rollback con `--rollback-reviews=IMPORT_ID
--write --confirm-project=gia-visto`.

È separata dal resto **perché è contenuto pubblico**: visti, voti e watchlist
sono dati privati dell'utente, una recensione compare sulla scheda titolo e sul
profilo. Regole della fase:

- riempie solo un `reviewText` **vuoto** su un voto che l'utente ha già; testo
  esistente non viene mai sovrascritto (`skip_existing_review`);
- non crea voti: una recensione su un film senza voto resta fuori
  (`skip_no_rating`), perché `reviewText` vive dentro `ratings/{id}` e le rules
  vogliono un voto 1–10;
- `reviews.csv` si collega al film per nome+anno come `diary.csv` (il suo
  `Letterboxd URI` punta alla pagina della recensione, non al film); righe non
  collegabili o ambigue vengono riportate e saltate;
- un film recensito più volte (rewatch) tiene la recensione più recente, perché
  un voto Somto ha un solo `reviewText`;
- testi oltre 5000 char (cap delle rules) vengono saltati, mai troncati;
- i campi scritti sono `reviewText`, `reviewSource`, `reviewImportId`,
  `reviewImportedAt`, `reviewSourceDate`; `createdAt`/`updatedAt` del voto non
  si toccano, così la recensione resta datata quando è stata scritta;
- nessun evento feed né thread pubblico: i trigger su `ratings` saltano le
  sorgenti `import_*`.

Precedente: liukowski, import `letterboxd_reviews_acbe0c6201c4a1014455abc4_r1`
del 2026-08-09 — 63 righe recensione, 61 applicate, 1 duplicato da rewatch,
1 senza voto.

## Fase 2 (quando abbiamo abbastanza export)

1. Scaricare gli zip raccolti, aprirli, annotare nomi file e header reali.
2. Scrivere il parser server-side accanto agli altri
   (`functions/modules/`, stessa pipeline parse → match → write delle sorgenti
   esistenti), mappando: `watchlist` → `generalWatchlist`, `diary`/`watched` →
   stato visto + data, `ratings` → voto (riscalare 0.5–5.0 → 1–10),
   liste → `userLists`.
3. Matching per `Letterboxd URI` → slug → TMDB: da valutare, il CSV **non**
   contiene tmdbId. Fallback su titolo + anno, che è la parte fragile
   (vedi le trappole già viste sugli import TV Time).
4. Sostituire l'upload manuale con il flusso normale e togliere il copy sulle 24
   ore.
