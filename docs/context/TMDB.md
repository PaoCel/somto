# TMDB — proxy, arricchimento, merge manuale

Leggi per: tmdbProxy, enrichTitleAssets, refreshTitleFromTmdb, titoli accorpati (`mergedTmdbIds`).
Vedi anche `docs/TMDB_CACHE.md` e `docs/TMDB_AUTO_IMPORT.md`.

## TMDB
- Client lato Firestore: `tmdbCache/` per cache
- Callable `tmdbProxy` in `functions/index.js` — actions: `searchMulti`, `details`, `videos`, `upcomingCinema`, `upcomingStreaming`, **`personCredits`** (`/person/{id}/combined_credits`)
- Callable `enrichTitleAssets` — trailer + cast su `castWithCharacters`
- Callable `refreshTitleFromTmdb`
- Swift: `TitleRepository.fetchTMDBPersonCredits(personTMDBID:)` + `enrichLocalCatalog(forPersonTMDBID:currentUser:)` per import dinamico in Person page
- Cache import: `enrichedPersonTMDBIDs: Set<Int>` lato `TitleRepository`
- **Titoli merge manuale**: `tmdbSync.syncDisabled: true` su un titolo lo rende immune al sync TMDB (`refreshTitleFromTmdb` anche con force, `adminBackfillTitleMetadata` lo saltano). Campo root `mergedTmdbIds: [int]` = id TMDB assorbiti dentro quel titolo: `linkPersonToTitles` e `importRecentTmdbTitles`/`existsLogicalDuplicateTitle` risolvono il proprietario via `tmdbId`/`mergedTmdbIds` e non ricreano stub `tmdb_*`. Caso live: doc `berlino` accorpa TMDB 146176 (stagione 1, "i gioielli di Parigi") + 308014 (stagione 2, "la Dama con l'ermellino").

### Titoli fantasma: un doc `titles` senza `name` (fix 2026-09-09)

Le denormalizzazioni sul doc titolo erano scritte con
`set(..., { merge: true })`, che **crea il documento se non esiste**. Su un id
gia' cancellato (tipicamente un doppione accorpato) rinasceva cosi' un doc con i
soli campi di arricchimento: niente `name`, `type`, `posterPath`, `status`.

Il vettore accertato e' `scripts/backfill-watch-provider-names.js`: itera la
cache `titleProviders`, che **sopravvive alla cancellazione del titolo**, e
riscriveva `watchProviderNames` su ogni id trovato. Entrambi i fantasmi avevano
quel campo, e il dry-run della versione corretta segnala esattamente quei due id
come cache orfane. Anche `resolveDeepLinksForTitle` era esposto (gira nel ramo
"cache fresca" di `getWatchProviders`, **prima** del controllo di esistenza del
titolo); gli altri punti (`watchProviderNames` a valle del fetch, backfill
loghi, meta durate) erano gia' coperti da un controllo, ma passano dalla stessa
guardia per non doverci ripensare.

Cosa si vede: la card mostra **"Senza titolo"** senza poster (fallback in
`TitleParsing`), e il gate anti-spoiler **sfoca il commento anche a chi ha
finito la serie**, perche' cerca il progresso del viewer per `titleId` e il
progresso sta sul titolo canonico. Caso live: `tmdb_tv_308014`, doppione di
`berlino` gia' presente in `mergedTmdbIds`, con due librerie utente, un voto,
un post, un thread e 11 eventi feed appesi.

- Guardia: `lib/titleDocWrites.js` → `patchExistingTitle()` usa `update()` e
  salta loggando se il titolo non c'e'. **Ogni nuova denormalizzazione sul doc
  titolo passa da li'**: nessuna di queste scritture e' proprietaria del titolo.
  Gli script batch non possono usarlo (un `update` in batch fa fallire tutto il
  batch su un doc mancante): leggono i titoli a chunk con `getAll` e scrivono
  solo sugli esistenti, contando le cache orfane.
- Diagnosi: `functions/scripts/scan-ghost-titles.js [--refs]` — Firestore non sa
  interrogare "campo assente", quindi confronta gli id di `titles` con quelli di
  `titles.orderBy("name")`.
- Riparazione: `functions/scripts/repair-ghost-title.js --ghost <id> --canonical
  <id>` (dry-run di default). Sposta messaggi, voti, stati libreria, eventi feed
  e post, poi cancella il fantasma. I post-eco li rifanno i trigger: id
  deterministico, `createdAt` preservato — ed e' proprio la data originale che
  tiene fuori le notifiche, perche' i trigger saltano i messaggi non
  contestuali all'evento.
- `merge-duplicate-title.js`: un controllo riferimenti **fallito** e' bloccante
  quanto un riferimento trovato. Prima finiva in una stringa "non verificabile"
  che il filtro sui valori numerici lasciava passare.

### `createdAt` si scrive solo alla creazione (fix 2026-08-26)

`buildTmdbTitleDoc` mette sempre `createdAt` e `upsertTmdbTitle` scrive in
merge: ogni **fusione** riportava quindi la data a "adesso", anche su titoli
creati da utenti veri anni prima. Non era cosmetico — `titles` si ordina per
`createdAt` desc in "aggiunti di recente" su web (`titles.api.js`), iOS
(`TitleRepository`) e nella home, quindi **~124 titoli vecchi risalivano in cima
tre volte al giorno**, uno per ogni run del cron. Trovato guardando il primo run
della corsia uscite: fra i "nuovi" comparivano *Reacher*, *Shameless* e *Avatar*.

Ora `upsertTmdbTitle` legge il doc di destinazione e toglie `createdAt` dal
payload se esiste gia'. **I valori vecchi sono persi**: erano stati sovrascritti
run dopo run e non c'e' una fonte da cui ricostruirli. L'ordinamento torna
sensato solo per i titoli aggiunti da qui in avanti.

## Due corsie di scoperta: recenti e in uscita (2026-08-26)

`importRecentTmdbTitles` (3 volte al giorno) popola il catalogo con **due**
query `discover` distinte, che rispondono a domande diverse.

| corsia | come scopre | perche' |
| --- | --- | --- |
| **recenti** (storica) | `vote_count.gte: 10`, cursore su 40 pagine | qualita': un titolo con voti veri non e' spazzatura |
| **in uscita** (nuova) | data futura + `popularity`, `vote_count` come seconda porta | i voti misurano il passato e un titolo che deve ancora uscire non ne ha |

**Il buco che chiude**: misurato il 2026-08-26, delle 167 uscite dei 60 giorni
successivi il **75% non era a catalogo**, e solo il **16%** raggiungeva i 10
voti. Senza il doc `titles` non esiste niente a valle — post, card in home,
pubblico per affinita', notifica `title_update` e nemmeno il feed
`/prossime-uscite.json` che alimenta il widget iOS "Prossime uscite".

Regole della corsia nuova (`fetchTmdbUpcomingCandidatesForType`):

- **`vote_count` resta, ma in OR**: si accetta chi e' abbastanza popolare
  **oppure** chi ha gia' abbastanza voti. Come cancello escluderebbe l'84%.
- **Finestra 45 giorni** (`TMDB_UPCOMING_AHEAD_DAYS`). Accoppiata al giro dello
  scanner aggiornamenti (~2,5 giorni sul catalogo): anche l'ultimo arrivato
  viene scansionato, e quindi produce l'evento di uscita **notificabile**, ben
  prima del debutto. Se cambi una delle due, ricontrolla l'altra.
- **Film**: `region=IT` + `with_release_type=2|3` (sala e uscita limitata).
- **Serie**: `without_genres` su soap, talk, news e reality — un quinto della
  finestra, mai un consiglio.
- **Le uscite entrano per prime** nella coda dell'import: sono l'unica cosa in
  quella funzione che ha una scadenza.
- Kill switch `TMDB_UPCOMING_IMPORT_ENABLED=false`. Se la corsia fallisce, viene
  loggata e l'import normale prosegue.

Due filtri **provati e scartati**, entrambi per lo stesso uovo-e-gallina:

- `watch_region=IT&with_watch_providers=...` restituisce **zero** risultati
  sulla finestra futura: una serie non ancora uscita non ha ancora provider.
- lingua o paese d'origine: toglierebbe le daily asiatiche ma anche i drama
  coreani, che qui hanno un pubblico misurato (un utente con 118 titoli coreani
  visti e 367 in watchlist).

Costo reale a regime: **6 chiamate TMDB per run**, ~46 titoli nuovi al primo
giro e poi un rivolo, perche' `enqueueCandidates` scarta quello che esiste.

## Termini API: cache a 6 mesi e attribuzione (2026-08-25)

I [termini API TMDB](https://www.themoviedb.org/api-terms-of-use) vietano di
tenere in cache i loro dati **oltre 6 mesi** e chiedono **logo + frase**
("not endorsed, certified, or otherwise approved by TMDB"), non una delle due.
L'uso commerciale vuole un accordo scritto separato.

- **Rinfresco**: `tmdbSync.nextCheckAt` sul doc titolo, intervallo 15 giorni.
  Il lavoro sta in `refreshTitleFromTmdbCore` (functions/index.js), usato sia
  dalla callable `refreshTitleFromTmdb` (client, all'apertura della scheda) sia
  dallo scheduler `refreshStaleTmdbTitles` (gen2, 4:40 Europe/Rome). Senza lo
  scheduler i titoli che non apre nessuno non venivano rinfrescati mai.
  Lo scheduler fa due passaggi: i titoli scaduti, e — con un cursore in
  `systemJobs/tmdbRefreshSweep` — quelli a cui `nextCheckAt` manca del tutto,
  che nessuna query puo' trovare.
- **Attribuzione**: logo ufficiale in `public/img/tmdb-logo.svg` e
  `TMDBLogo.imageset`. Compare in fondo alla scheda titolo web, nel footer
  delle pagine pubbliche (`functions/modules/titlePage.js`, che NON e' hosting:
  va deployata con `--only functions:titlePage`) e in Impostazioni su iOS.

## Dove porta "guarda su …" (2026-09-08)

TMDB dice **quali** piattaforme mostrare (watch provider, per regione). **Dove**
porta il bottone lo decide un livello solo, in due gemelli dichiarati:

- iOS: `ios/TwoWatch/Domain/Services/StreamingDestination.swift`
- web: `public/js/utils/streamingDestination.js`

Catena, in ordine di precisione:

1. **link diretto** — `titles.watchDeepLinks` (denormalizzato) e
   `titleProviders.deepLinks` (risposta della callable `getWatchProviders`),
   risolti da Wikidata dal server. Aprono la scheda del titolo dentro l'app.
   Copertura misurata l'8/9/2026 su prod: **1121 titoli su 2825** con provider
   italiani (Netflix e Disney+ sono il grosso; Prime Video non ne ha di validi
   per l'Italia, vedi `docs/DECISIONS.md` 2026-08-15).
2. **ricerca nell'app della piattaforma** — solo per le piattaforme il cui URL
   di ricerca e' stato **aperto davvero**. Le altre non hanno una riga.
3. **pagina "dove guardare" di TMDB** — l'ultimo ripiego.

**Regola per chi aggiunge una piattaforma a `searchTemplates`**: aprire l'URL
prima di scriverlo. `curl -o /dev/null -w "%{http_code}"` con uno User-Agent di
browser; se risponde 403 e' Cloudflare, va aperto per davvero. Un modello
inventato non fallisce da nessuna parte: manda l'utente su un 404 della
piattaforma, che da fuori sembra un bug di Somto. Disney+, NOW, Sky Go, Mediaset
Infinity, discovery+ e TIMVISION erano cosi' fino all'8/9/2026.

**Cosa non si puo' promettere**: la puntata. Gli id sono di serie e film, non di
episodi, e nessuna piattaforma espone un id episodio ricavabile da TMDB. Il
bottone apre la scheda della serie; Netflix e Disney+ riprendono da soli.

Chi mostra il bottone: `TitleWatchNowButton` (scheda titolo iOS, sopra le tab;
dal 15/9/2026 anche in misura `.compact` sulle card del feed con un titolo solo
e nella pagina del post — decide `TitleWatchNowDestination`, con i soli campi
denormalizzati sul titolo, senza chiamare la callable), `#watchNowBtn` in
`public/title.html` (stesso posto sul web; la card del feed web non ce l'ha
ancora), il tasto play del widget grande Watchlist
(`SomtoWidgets/WatchlistWidget.swift`) e i loghi di "Dove guardarlo" su
entrambe le piattaforme.
