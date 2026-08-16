# Release iOS — numerazione, comandi, ultima build

Leggi prima di ogni archive/upload TestFlight o invio App Store.
Storico completo: `docs/RELEASE_HISTORY.md`.

## Build / TestFlight

- **2026-08-16 — 1.7.1 build `2026081601` (TestFlight) — La piattaforma giusta, e il widget che resta pieno** Corretto il caso in cui Somto indicava Prime Video su titoli che stanno altrove: Prime li rivende come canale, ma la casa del titolo e' l'altro servizio (Ted Lasso, per esempio, e' su Apple TV). Ora il servizio giusto viene per primo e non compaiono piu' due loghi per la stessa piattaforma. Corretto anche il widget della watchlist, che dopo qualche apertura dell'app si svuotava e tornava a chiedere di aprire Somto. In Home arrivano le prossime uscite commentabili. Stato ASC alla verifica: `VALID`.

- **2026-08-15 — 1.7.1 build `2026081503` (TestFlight) — Ogni logo apre la sua piattaforma** Nella scheda titolo i loghi di 'Dove guardarlo' ora portano ognuno sulla propria piattaforma, e dove possibile direttamente sulla scheda del titolo dentro l'app (Netflix, Disney+, Apple TV, Max). Dove non abbiamo il link esatto si apre la ricerca nell'app giusta. Stessa cosa per il tasto guarda del widget grande. Stato ASC alla verifica: `VALID`.

- **2026-08-15 — 1.7.1 build `2026081502` (TestFlight) — Il tasto guarda non sparisce piu'** Nel widget grande il tasto per guardare c'e' anche quando la piattaforma non e' fra quelle che apriamo direttamente: in quel caso porta alla pagina 'dove guardare' del titolo, da cui si arriva al servizio giusto. Stato ASC alla verifica: `VALID`.

- **2026-08-15 — 1.7.1 build `2026081501` (TestFlight) — Widget grande: riprendi da qui** Il widget grande cambia forma: la serie che stai guardando in evidenza, con la locandina, il punto in cui sei, la barra di avanzamento e due tasti - guarda e segna episodio. Sotto trovi le altre serie: toccane una e prende il posto in cima, senza passare da 'Modifica widget'. Il tasto guarda apre l'app della piattaforma su quel titolo, quando sappiamo dove si vede. Stato ASC alla verifica: `VALID`.

- **2026-08-15 — 1.7.1 build `2026081404` (TestFlight) — Widget: piu' veloce, e una guida** Il widget 'Segna episodio' risponde subito e mostra il punto nuovo appena segni; il bottone resta pronto per l'episodio dopo. Toccando due volte di seguito non conta piu' due episodi. Ora puoi scegliere anche serie che non hai ancora iniziato, e l'elenco e' piu' lungo. La watchlist del widget si carica aprendo l'app, senza passare per forza dalla tab Watchlist. Toccando un widget vuoto trovi una guida che spiega come cambiare serie. Stato ASC alla verifica: `VALID`.

- **2026-08-14 — 1.7.1 build `2026081403` (TestFlight) — Segna l'episodio dal widget** Nuovo widget: scegli una serie che stai guardando e segni l'episodio appena visto direttamente dalla schermata Home, senza aprire l'app. Tieni premuto il widget per cambiare serie. L'elenco delle serie arriva dalla tua watchlist, quindi apri Somto almeno una volta dopo l'aggiornamento. Stato ASC alla verifica: `VALID`.

- **2026-08-14 — 1.7.1 build `2026081402` (TestFlight) — Widget watchlist e righe piu' leggibili** Nuovo widget: la tua watchlist in schermata Home. Mostra le serie che stai guardando col punto in cui sei rimasto, piu' una o due cose dalla coda; un tocco apre la scheda. Si aggiorna quando apri l'app. Il widget delle prossime uscite ha righe, locandine e testo piu' grandi, e il logo della piattaforma non sparisce piu' sul fondo scuro. Stato ASC alla verifica: `VALID`.

- **2026-08-14 — 1.7.1 build `2026081401` (TestFlight) — Widget: dove esce, e le serie che tornano** Il widget Prossime uscite ora dice anche DOVE esce un film - al cinema o in streaming - e mostra le serie che tornano con una stagione nuova, con il logo della piattaforma su cui la guardi. Restano fuori le uscite in DVD e le date non ancora confermate per l'Italia, che prima comparivano come certe. Stato ASC alla verifica: `VALID`.

- **2026-08-12 — 1.7.0 build `2026081204` (TestFlight) — Widget in tre misure e ricerca in Spotlight** Il widget Prossime uscite ora c'e' in tre misure, con la locandina anche nella piu' piccola: scegli quella che preferisce la tua schermata Home. E' l'inizio - nei prossimi aggiornamenti i widget cresceranno ancora. I titoli della tua watchlist si trovano dalla ricerca di sistema, con la locandina e il genere giusto. Sistemate le etichette della watchlist in vista elenco, che su alcune righe andavano a capo a meta' parola. Stato ASC alla verifica: `VALID`.

- **2026-08-12 — 1.7.0 build `2026081203` (TestFlight) — Widget Prossime uscite e ricerca in Spotlight** Arriva il primo widget di Somto: Prossime uscite, con i film in arrivo e la loro data, e un tocco ti porta sulla scheda. E' l'inizio - nei prossimi aggiornamenti i widget cresceranno. Da questa versione i titoli della tua watchlist si trovano anche dalla ricerca di sistema: cerchi un film dalla schermata Home e lo apri direttamente in Somto. Sistemate anche le etichette della watchlist in vista elenco, che su alcune righe andavano a capo a meta' parola. Stato ASC alla verifica: `VALID`.

- **2026-08-12 — 1.7.0 build `2026081202` (TestFlight) — Uscite in watchlist e segui titolo dai post** In watchlist i film che devono ancora uscire mostrano la data di uscita italiana, quando la conosciamo. Dalla card di un post puoi seguire un titolo con un tap e ricevere l'avviso il giorno in cui esce, anche se non ce l'hai in watchlist. I link agli aggiornamenti di Somto condivisi in chat ora aprono l'app sulla notizia giusta. Sotto il cofano: aprire la watchlist costa un terzo delle letture di prima, e gli errori delle azioni che passano dal server sono frasi leggibili invece di codici tecnici. Stato ASC alla verifica: `VALID`.

- **2026-08-12 — 1.7.0 build `2026081201` (TestFlight) — Siri, Scorciatoie e Spotlight: aggiungi alla watchlist** Puoi dire a Siri «Aggiungi a watchlist su Somto», oppure usare la stessa azione da Scorciatoie e da Spotlight, e salvare un film o una serie senza aprire l'app: scegli il titolo dall'elenco che ti propone e finisce nella tua watchlist. Se il titolo non e' ancora in catalogo, lo aggiunge. Migliorati anche i messaggi di errore delle azioni che passano dal server: dove poteva comparire un codice tecnico ora c'e' una frase leggibile. Stato ASC alla verifica: `VALID`.

- **2026-08-11 — 1.7.0 build `2026081101` (TestFlight) — Voto singolo episodio** Il voto su un episodio a volte spariva subito dopo averlo dato, e se il salvataggio falliva l'app non lo diceva. Ora il voto resta visibile subito e, se qualcosa va storto, il foglio lo segnala con un Riprova invece di richiudersi in silenzio. Stato ASC alla verifica: `VALID`.

- **2026-08-09 — 1.7.0 build `2026080902` (TestFlight) — Diagnostica interna e testo scalabile** Build soprattutto interna. Visibile: alcuni testi a dimensione fissa nei componenti condivisi ora seguono la dimensione del testo impostata nel sistema. Sotto il cofano: gli errori che l'app decideva di non mostrare ora vengono registrati invece di sparire, e i lettori dei dati segnalano quali vecchi formati di documento incontrano ancora — serve a capire cosa si puo' semplificare senza rompere il catalogo. Stato ASC alla verifica: `VALID`.

- **2026-08-09 — 1.7.0 build `2026080901` (TestFlight) — Refactoring interno + fix cambio account** Corretto il blocco che, uscendo da un account ed entrando con un altro sullo stesso dispositivo, lasciava l'app aperta ma vuota e il profilo che chiedeva di accedere. Un voto non ricarica piu' l'intera scheda titolo: si apre e risponde piu' in fretta. Avatar uniformati in tutta l'app. Sotto il cofano: la scheda titolo passa da un file da 10.437 righe a sette, e i test automatici salgono da 3 a 55. Stato ASC alla verifica: `VALID`.

- **2026-08-08 — 1.7.0 build `2026080801` (TestFlight) — Skeleton di caricamento e cast ordinato per voti** Aprendo una scheda, attori, dove guardare e trailer non erano vuoti per scelta: arrivano dopo il primo render e finche' non rispondevano le sezioni non c'erano affatto. Ora ognuna mostra un segnaposto della stessa forma del contenuto vero. L'anteprima del cast mette in testa i personaggi piu' votati dalla community, con la loro quota sulla card; il cast completo resta integrale dietro "Vedi tutto il cast". Stato ASC alla verifica: `VALID`.

- **2026-08-07 — 1.7.0 build `2026080703` (TestFlight) — Filmografia TMDB e "il più votato" in chiaro.** Aprendo un attore del cast completo si vedevano solo i titoli già in catalogo (quelle persone arrivano da TMDB e quasi nessuna è indicizzata da noi): ora la filmografia si legge da TMDB e il tap risolve il titolo come un risultato di ricerca. Il personaggio più votato dalla community è una riga in chiaro sulla scheda, non più solo dentro il foglio del cast. Sul web, corretto anche il link alla persona dal cast, che puntava a un parametro (`?person=`) che la ricerca non legge. Build Release verde, archive firmato, `Uploaded TwoWatch`.

- **2026-08-07 — 1.7.0 build `2026080702` (TestFlight) — Correzioni cast e voto.** Ricaricata perché la `2026080701` non era comparsa su TestFlight e non si riusciva a verificarne lo stato. Contenuto identico. **Rettifica 2026-08-08**: interrogando l'API di App Store Connect, la `2026080701` risulta caricata alle 15:13 del 06/08 e `VALID` — l'upload era andato a buon fine, quindi la ricarica era superflua e quel giorno si sono bruciati due numeri di build per niente. Anche l'issuer id dato per mancante c'è (`ca07a6dc-…`, ora in `~/.appstoreconnect/config.json` insieme alle `.p8`). Da qui nasce la verifica automatica post-upload descritta sotto: senza, `Uploaded TwoWatch` non distingue "mai arrivata" da "arrivata e non ancora visibile". Nel cast completo erano tappabili solo le persone gia' nel nostro catalogo: quelle che arrivano da TMDB non hanno un person indicizzato, ora si naviga per nome (stesso fallback delle card della scheda). Dopo aver votato un personaggio non compariva niente perche' l'etichetta di apprezzamento richiede 5 votanti: aggiunti "Il tuo voto" sulla propria scelta e i risultati community con le percentuali, visibili da subito. I voti nelle card Community non sono piu' testo "8/10 — ..." ma una pastiglia tonda senza scala. Build Release verde, archive firmato, `Uploaded TwoWatch`.

- **2026-08-06 — 1.7.0 build `2026080601` (TestFlight) — Onboarding v2 e vista cast.** L'onboarding non spiega piu' Somto: lo fa fare. Domanda d'ingresso sulla provenienza (TV Time / Trakt / Letterboxd / export Netflix / da zero), import-first che parte subito e lascia girare gli step mentre il job macina, watchlist e libreria con write vere, "Segui qualcuno" con suggeriti da chi ha in libreria i tuoi titoli, avatar, atterraggio sui commenti di un titolo appena salvato. Morti il tour a 3 slide e il chooser a 3 livelli. Nuovo stato dell'import in Home ("stiamo importando" + reveal "la tua libreria e' pronta"). Scheda titolo: il cast diventa una vista con personaggio, etichetta di apprezzamento dai pick community, "Vedi tutto il cast" (TMDB, non i 20 denormalizzati) e voto fino a 3 personaggi. Build Release verde, archive firmato, `Uploaded TwoWatch`.

- **2026-08-05 — 1.6.1 build `2026080501` (TestFlight) — Watchlist a schermata unica.** La Home della watchlist non ha piu' scaffali intermedi ne' card che rimandano altrove: serie aperte in cima, poi direttamente la coda con i suoi filtri, e le liste come voce singola in fondo. Allinea iOS alla spec gia' live sul web. Build Debug e Release verdi, archive firmato, `Uploaded TwoWatch`.
- **2026-08-04 — 1.6.1 build `2026080402` (TestFlight) — Watchlist: schermata liste e swipe indietro.** La ex "Condivise" diventa "Le tue liste": CTA di creazione, tre gruppi disgiunti (mie / condivise con me / salvate) con righe pulite e pill di visibilita' (Privata / Con amici / Pubblica), discovery pubblica relegata a una voce in fondo invece di cinque card inline. Aggiunto lo swipe dal bordo sinistro per tornare alla Home della watchlist: le sotto-schermate sono cambi di stato e non push di NavigationStack, quindi il gesto di sistema non esisteva e si usciva solo dal bottone. Build Debug e Release verdi, archive firmato e `Uploaded TwoWatch`. Warning dSYM dei framework Firebase/gRPC = rumore storico.
- **2026-08-04 — 1.6.1 build `2026080401` (TestFlight, in elaborazione) — Feedback azioni e Watchlist.** Tutte le principali azioni asincrone web/iOS comunicano caricamento, esito ed errore; login social con consenso termini guidato, ritaglio avatar, nuova entrata alla watchlist completa e stati dedicati per mutazioni Watchlist. Test web 15/15, test iOS 6/6, archive Release firmato e upload App Store Connect riusciti (`Upload succeeded`). dSYM dell'app presente; warning dSYM dei framework binari Firebase/Google/gRPC = rumore storico non bloccante.

- **2026-08-02 — 1.6.0 build `2026080201` (TestFlight → App Store) — Aggiornamenti titolo, notifiche e affinità piattaforme.** Le schede titolo espongono una timeline automatica di trailer, annunci e prossime uscite con testi localizzati e link sorgente sicuri; l'utente può seguire il titolo e scegliere gli eventi da ricevere, con deep link alla notizia esatta. I segnali di visione alimentano inoltre raccomandazioni basate sull'affinità implicita con le piattaforme. Test iOS 6/6, archive Release firmato e upload App Store Connect riusciti (`Upload succeeded`, pacchetto in elaborazione). Warning dSYM dei framework binari Firebase/Google/gRPC = rumore storico non bloccante; dSYM dell'app incluso. **Inviata in verifica App Store lo stesso giorno** (via ASC UI, versione pubblica 1.5.0 → 1.6.0, note di rilascio compilate IT/EN/ES): stato "In attesa di verifica", esito atteso entro 48h.

- **Storia completa dei rilasci precedenti**: vedi `docs/RELEASE_HISTORY.md` (spostata da qui il 2026-07-12 per tenere questo file snello). Aggiorna CLAUDE.md solo con l'ULTIMA build + eventuali gotcha nuovi; il bullet precedente scivola in RELEASE_HISTORY.

### Numerazione: TestFlight e App Store sono due binari diversi

Regola introdotta il 2026-07-29 dopo che la pubblica era ferma alla **1.4.2**
mentre TestFlight era arrivato a **1.4.21**: un invio come "1.4.21" sarebbe
stato tecnicamente valido (Apple confronta i componenti numericamente, 21 > 2)
ma avrebbe comunicato una bugia — accanto a 1.4.2 sembra un ritocco, mentre
portava mesi di lavoro. È uscita come **1.5.0**.

- **`CURRENT_PROJECT_VERSION` (build) è il binario interno.** Data-based
  (`YYYYMMDDNN`), si incrementa a ogni upload, non lo legge nessun utente.
  **Ogni upload vuole un valore nuovo**: un numero già consumato viene rifiutato,
  quindi va bumpato anche quando si ricarica la *stessa* versione marketing.
- **`MARKETING_VERSION` è il binario pubblico.** Non deve inseguire il conteggio
  delle build TestFlight: si muove **solo quando si pubblica**, e di uno scatto
  proporzionato a cosa vede l'utente.
  - patch (`1.5.0 → 1.5.1`): fix e rifiniture
  - minor (`1.5.0 → 1.6.0`): feature nuove visibili
  - major: cambio di impianto
- **Prima di ogni invio allo Store, guarda qual è la pubblica attuale** (ASC →
  Distribuzioni, o Cronologia) e scegli il numero rispetto a **quella**, non
  rispetto all'ultima build TestFlight. Le due si erano scollate di 19 build
  senza che nessuno se ne accorgesse.
- Corollario: iterare a lungo su TestFlight è normale e non deve inquinare la
  numerazione pubblica. Se TestFlight arriva a `1.5.0` build 12, la release
  pubblica resta `1.5.0`.

## Comando unico

```bash
scripts/ios-release.sh --title "Titolo breve della build" --body "Cosa cambia per l'utente."
```

Fa tutto in sequenza e si ferma al primo problema:

1. **preflight** — su `main`, tree pulito, niente commit non pushati, credenziali ASC valide
2. **numero di build** — `CURRENT_PROJECT_VERSION` lo decide App Store Connect, non `project.yml`: si prende il primo progressivo libero della giornata (`YYYYMMDDNN`). È ASC a rifiutare i duplicati, quindi è ASC la fonte di verità
3. **xcodegen generate**
4. **test** su simulatore iPhone (`--skip-tests` per saltarli)
5. **archive** Release firmato, poi controlla che il `CFBundleVersion` dentro l'archive sia davvero quello atteso
6. **upload** con chiave API esplicita (`-authenticationKey*`), non con le credenziali salvate nel Keychain di Xcode
7. **verifica** — attende che la build compaia su ASC ed esca da `PROCESSING`. Se non compare, il rilascio **fallisce**
8. **docs + commit + push** — aggiorna questo file e la riga "Ultima build iOS" di `CLAUDE.md` col numero **letto da ASC**, poi committa e pusha

Se un passo fallisce, `project.yml` viene ripristinato: un bump lasciato in giro da un archive fallito è come nascono i buchi tra i numeri.

Flag: `--marketing X.Y.Z` (muove la versione pubblica), `--skip-tests`, `--no-commit`, `--dry-run` (solo preflight + numero che verrebbe usato).

Escape hatch, da usare sapendo cosa si fa: `ALLOW_NON_MAIN_RELEASE=1`, `ALLOW_DIRTY_RELEASE=1`, `ALLOW_UNPUSHED_RELEASE=1`.

Log completi in `~/somto-deploy-logs/ios/`.

### Interrogare App Store Connect

```bash
python3 scripts/asc.py check          # credenziali, pubblica attuale, ultima build
python3 scripts/asc.py builds         # ultime build con stato reale
python3 scripts/asc.py next-build     # prossimo numero libero
python3 scripts/asc.py live-version   # versione pubblica sullo Store
```

Credenziali in `~/.appstoreconnect/config.json` (fuori dal repo, `chmod 600`), sovrascrivibili con `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_APP_ID` / `ASC_KEY_PATH`.

### Invio in verifica App Store

Passo separato e deliberato: TestFlight e Store sono due decisioni diverse.

```bash
CONFIRM_SUBMIT=1.7.0 python3 scripts/asc.py submit \
  --marketing 1.7.0 --build 2026080801 --notes-file note.json
```

`note.json` è `{"it": "...", "en-US": "...", "es-ES": "..."}`. Senza `CONFIRM_SUBMIT` uguale alla versione, il comando si rifiuta di partire — stessa convenzione di `CONFIRM_PROD` per i deploy Firebase. Prima di lanciarlo rileggi la regola di numerazione qui sopra: il numero si sceglie rispetto alla **pubblica attuale** (`asc.py live-version`), non all'ultima build TestFlight.

### Note

- `ExportOptions-AppStore.plist` ha `destination: upload` → `exportArchive` carica direttamente su TestFlight
- Warning dSYM dei framework binari Firebase/Google/gRPC = rumore storico, non bloccante
