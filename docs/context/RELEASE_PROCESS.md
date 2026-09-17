# Release iOS — numerazione, comandi, ultima build

Leggi prima di ogni archive/upload TestFlight o invio App Store.
Storico completo: `docs/RELEASE_HISTORY.md`.

## Build / TestFlight

- **2026-09-15 — 1.10.1 build `2026091501` (TestFlight) — Il tasto guarda anche nei post** Sotto i post del feed che parlano di un film o di una serie c'e' il tasto per andare a guardarlo: apre l'app della piattaforma sul titolo esatto quando il link ce l'abbiamo, altrimenti la sua ricerca. Lo stesso tasto sta nella pagina del post. Compare solo dove sappiamo aprire un'app: se il titolo non e' ancora in streaming la card resta com'era. Stato ASC alla verifica: `VALID`.

- **2026-09-09 — 1.10.1 build `2026090902` (TestFlight) — Diagnostica sulle notifiche** Niente di nuovo da vedere. L'app registra se il permesso per le notifiche e' stato negato, mai chiesto, oppure concesso senza che il dispositivo risulti registrato: da fuori le tre situazioni sembravano identiche, e chiedono rimedi opposti. Stato ASC alla verifica: `VALID`.

- **2026-09-09 — 1.10.1 build `2026090901` (TestFlight) — Il tasto guarda apre la piattaforma giusta** Dalla scheda di un film o di una serie c'e' un tasto che porta a guardarlo: apre l'app della piattaforma sul titolo esatto, quando il link ce l'abbiamo, altrimenti la sua ricerca. Lo stesso vale per il tasto play del widget grande, che prima apriva sempre una ricerca anche quando il link preciso ce l'avevamo gia'. Tolte le scorciatoie verso alcune piattaforme che portavano su una pagina di errore. Stato ASC alla verifica: `VALID`.

- **2026-09-08 — 1.11.0 build `2026090801` (TestFlight) — Il tasto guarda apre la piattaforma giusta** Dalla scheda di un film o di una serie c'e' un tasto che porta a guardarlo: apre l'app della piattaforma sul titolo esatto, quando il link ce l'abbiamo, altrimenti la sua ricerca. Lo stesso vale per il tasto play del widget grande, che prima apriva sempre una ricerca anche quando il link preciso ce l'avevamo gia'. Tolte le scorciatoie verso alcune piattaforme che portavano su una pagina di errore. Stato ASC alla verifica: `VALID`.

- **2026-09-06 — 1.10.0 build `2026090603` (TestFlight → App Store, in verifica dal 2026-09-06 sera, submission d52e614d) — Widget che resta pieno, verifica email in Home** Il widget non si svuota piu da solo: il riassunto della watchlist era illeggibile a telefono bloccato proprio quando il sistema lo rinfresca, e il widget mostrava Apri Somto pur avendo i dati. Il consiglio di verificare l email non copre piu le schermate: e una card in cima alla Home e una riga in Impostazioni, Account. Nel quiz, mentre si salva il risultato, la scritta dice che sta salvando. Stato ASC alla verifica: `VALID`.

- **2026-09-06 — 1.10.0 build `2026090602` (TestFlight) — Sfide: saghe, chi segui, link e annullamento** Nelle sfide scegli tra le persone che segui (prima vedevi solo gli amici della vecchia lista) e puoi sfidare su una saga intera. Negli inviti inviati ricondividi il link o annulli un invito ancora in attesa; un invito senza nome mostra la data. Il campo Nome sta in cima. Stato ASC alla verifica: `VALID`.

- **2026-09-06 — 1.10.0 build `2026090601` (TestFlight) — Quiz: saghe, sfide e risultato onesto** Nel quiz si gioca anche su intere saghe: Harry Potter, MCU, Dragon Ball, Star Wars e altre, dal picker del titolo. Il risultato dice quante ne hai azzeccate su quante, e se il salvataggio non riesce lo dice invece di festeggiare. Dal risultato sfidi un amico sullo stesso titolo, e nella sfida scegli tra le persone che segui. Chiudi dal risultato torna al Quiz. Stato ASC alla verifica: `VALID`.

- **2026-09-04 — 1.10.0 build `2026090405` (TestFlight) — La ricerca si abbassa** La ricerca e' un foglio: si apre dal tasto a destra della tab bar (o dalla lente sopra la barra su iOS 17 e 18), il campo sta in fondo e la tastiera si apre da sola. Per uscire lo abbassi con un dito, e torni dov'eri senza passare dalla tab bar. Stato ASC alla verifica: `VALID`.

- **2026-09-04 — 1.10.0 build `2026090404` (TestFlight) — Una Home sola** La tab Community non c'e' piu': i post stanno nella Home, sotto le tue serie. In cima trovi cosa guardare stasera e le serie da riprendere, poi il feed: uscite, novita' e post di chi segui, con Per te, le prossime uscite e le persone da seguire in mezzo ai post. Per scrivere tocchi la riga sopra il feed. Dopo un voto rapido puoi pubblicarlo con un tocco. La tab bar ha quattro voci piu' la ricerca a destra; Tendenze e generi li trovi aprendo la ricerca. Stato ASC alla verifica: `VALID`.

- **2026-09-04 — 1.10.0 build `2026090403` (TestFlight) — Cerca dentro la tab bar** Su iOS 26 la ricerca sta nella tab bar: il tasto tondo a destra della barra, come in Apple TV. Toccalo e la barra si ritira in un tasto solo, il campo prende il suo posto e la tastiera si apre da sola; per tornare indietro tocchi il tasto rimasto a sinistra. Su iOS 17 e 18 la lente resta sopra la barra, in basso a destra, ora di vetro come la barra. Stato ASC alla verifica: `VALID`.

- **2026-09-04 — 1.10.0 build `2026090402` (TestFlight) — Cerca dal basso** La lente per cercare film, serie e persone non e' piu' nell'angolo in alto a sinistra: e' un tasto tondo sopra la tab bar, dove arriva il pollice. Toccalo e la tastiera si apre da sola, col campo in fondo allo schermo; la schermata da cui sei partito resta sotto e chiudendo torni esattamente li'. Stato ASC alla verifica: `VALID`.

- **2026-09-04 — 1.10.0 build `2026090401` (TestFlight) — Scheda titolo, ricerca e compagni di visione** Il cast resta disponibile anche nel voto, card cast uniformi, compagni di visione con default dai tuoi voti e ricerca persona, ricerca titoli che trova anche senza articolo e mette prima la corrispondenza esatta, correlati completi con suggerimenti della community, sezione saga e aggiornamenti dei titoli collegati. Stato ASC alla verifica: `VALID`.

- **2026-08-29 — 1.9.0 build `2026082902` (TestFlight) — Import TV Time senza istruzioni morte** TV Time ha chiuso a luglio: l'app non dice piu' di richiedere l'export a un servizio che non esiste. Chi ha gia' lo ZIP lo carica come prima. Stato ASC alla verifica: `VALID`.

- **2026-08-29 — 1.9.0 build `2026082901` (TestFlight) — Notifiche: il permesso torna a chiedersi** Dopo l'onboarding l'app torna a chiedere il permesso per le notifiche. Dal 6 agosto la richiesta non compariva piu' a chi si iscriveva, quindi nessun nuovo utente riceveva le push. Stato ASC alla verifica: `VALID`.

- **2026-08-26 — 1.9.0 build `2026082601` (TestFlight) — In Home: Per te** In Home arriva «Per te»: film e serie scelti da quello che guardi, a prescindere dalla piattaforma su cui stanno. Quei consigli esistevano gia' ma li vedevi solo ridotti a un servizio alla volta, quindi ne perdevi una parte. Via la riga «Novita'», che avrebbe dovuto mostrare i titoli aggiunti da poco e invece finiva per riproporre roba vecchia. Stato ASC alla verifica: `VALID`.

- **2026-08-25 — 1.8.0 build `2026082502` (TestFlight) — Attribuzione TMDB, e le novita di 1.8.0** Stessa 1.8.0 della build precedente, con in piu' la sezione 'Dati di film e serie' in Impostazioni: da dove arrivano i dati delle schede. Stato ASC alla verifica: `VALID`.

- **2026-08-25 — 1.8.0 build `2026082501` (TestFlight) — Salta a un episodio, e la review va in discussione** Nella scheda di una serie adesso c'e' scritto come si segna il punto in cui sei: tocchi la spunta dell'episodio dove sei arrivato e i precedenti diventano visti. E se sei a meta' della quinta stagione non devi piu' scorrere fin li': "Salta a un episodio" ti fa scegliere stagione ed episodio e sposta il segnalibro in un tocco. La review non ha piu' la casella per mandarla nella discussione pubblica del titolo: ci va sempre, e il composer lo dice prima che tocchi Pubblica. Chi hai visto insieme non e' piu' una colonna di spunte lunga quanto i tuoi seguiti: cerchi il nome e resta una pastiglia, come sul sito. Stato ASC alla verifica: `VALID`.

- **2026-08-24 — 1.7.1 build `2026082401` (TestFlight) — Commenti piu' leggibili** La schermata di un post con i suoi commenti e' stata rifatta: niente piu' riquadri dentro riquadri, il post in alto e sotto la discussione, con avatar e risposte collegate a chi rispondono. I commenti hanno la stessa forma ovunque, anche sotto le card in Community. E commentare non ricarica piu' il feed: resti esattamente dove eri. Stato ASC alla verifica: `VALID`.

- **2026-08-23 — 1.7.1 build `2026082301` (TestFlight) — Widget: icona avanti veloce** Nel widget il tasto per segnare l'episodio ha l'icona della doppia freccia, l'avanti veloce: prima la barra accanto al triangolo si leggeva come uno stop. Stato ASC alla verifica: `VALID`.

- **2026-08-20 — 1.7.1 build `2026082002` (TestFlight) — Persone da seguire, e le notifiche portano alla discussione** In Community, sopra il feed, c'e' una riga di persone da seguire: chi ha votato i tuoi stessi titoli, con quanti voti avete in comune e quali. In fondo alla riga ci sono le pagine di Somto — Uscite al cinema, Serie del momento, Crime e thriller, Anime — che pubblicano le uscite del loro tema: seguine una e i suoi post arrivano nel tuo feed anche quando quel titolo non ce l'hai in libreria. La notifica di un nuovo episodio, se quella stagione ha gia' una discussione aperta, ti porta li' invece che sulla scheda del titolo. Stato ASC alla verifica: `VALID`.

- **2026-08-20 — 1.7.1 build `2026082001` (TestFlight) — Il widget dice quando sta salvando** Dal widget, segnare un episodio adesso si vede: il bottone dice che sta salvando invece di restare immobile, e l'icona e' un avanti veloce - porta all'episodio dopo, non conferma qualcosa di gia' fatto. Al posto della barra ci sono i pallini: pieno l'episodio visto, vuoto quello che manca. Cambiare serie dalle miniature e' immediato, perche' le locandine non si riscaricano ogni volta. Nella scheda titolo il conteggio episodi si aggiorna anche sulle serie di cui non conosciamo stagione ed episodio, e il segnalibro rimette una serie iniziata in 'Da vedere' invece di proporre il rewatch. Stato ASC alla verifica: `VALID`.

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
- **La prova del titolo** (aggiunta 2026-09-09). "Feature nuova visibile" da
  sola non basta a decidere: quasi ogni release contiene almeno una cosa che si
  vede, quindi applicata alla lettera fa diventare minor tutto. Guarda invece
  **la riga che scriveresti nelle note** e chiediti se è un fix o una cosa nuova:
  - il titolo è un fix ⇒ **patch**, anche se il fix si porta dietro qualcosa di
    visibile. "Il tasto guarda apre la piattaforma giusta" è un fix con un
    bottone nuovo attaccato: `1.10.1`, non `1.11.0`.
  - il titolo è una capacità che prima non c'era ⇒ **minor**. "Per te" in Home,
    i widget, la ricerca dal basso, l'onboarding rifatto.

  *Perché*: dal 2026-07-29 al 2026-09-06 sono usciti **sei minor di fila in 39
  giorni** (1.5.0 → 1.10.0), uno ogni otto. Da fuori 1.7.0 (14 build TestFlight,
  onboarding rifatto da zero, vista cast, filmografia TMDB) e 1.8.0 (2 build,
  "salta a un episodio") sono lo stesso scatto. La seconda cifra era diventata
  un contatore di release — cioè lo stesso difetto della regola qui sopra,
  spostato di una posizione a sinistra.
- **Quando vale un major.** Quando cambia **la prima schermata e la frase con
  cui descrivi l'app**, non quando arriva una funzione grossa: una funzione si
  aggiunge accanto a quello che c'è, un major è quando quello che c'era smette
  di essere il centro. Il numero si spende una volta sola, e si spende quando
  cambia la descrizione sull'App Store.

  Per Somto, l'esempio che vale: oggi sei un archivio con dei consigli
  attaccati ("tieni traccia di quello che guardi"). Il 2.0 è quando apri e c'è
  **una cosa sola** — "stasera guarda questo, è su Netflix, dura 1h48" — e
  watchlist, voti e import diventano il carburante di quella schermata invece
  che il prodotto. Cioè quando Match smette di essere una tab e diventa l'app.

  NON sono major: il quiz che diventa competitivo (feature accanto), Android o
  il web rifatto (non è la stessa app), un refactor dell'impianto dati o
  l'offline-first (l'utente non vede niente), il social messo al centro (i
  numeri dicono di no: 23 utenti su 343 avevano seguito qualcuno).

  Arrivare a `1.30` non è un problema: l'assurdo è spendere il 2.0 su un tasto.
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

### L'app id non si prende dal default (gotcha 2026-08-26)

`~/.appstoreconnect/config.json` sta **fuori dal repo ed e' condiviso da tutti i
progetti iOS di Paolo**: chiave e issuer valgono per l'intero account Apple, e il
campo `app_id` di primo livello e' solo "su quale app puntano gli script adesso".
E' una variabile globale mutabile che piu' progetti si contendono.

Cosa e' successo: il **2026-08-25**, dopo l'upload di Somto `2026082502`, una
sessione su un altro prodotto (*One Day Cup*) ha spostato quel default sulla
propria app e l'ha annotato come una correzione — dal suo punto di vista lo era.
La release di Somto del giorno dopo ha quindi letto **numero di build, versione
pubblica e verifica post-upload dall'app sbagliata**, riportando "pubblica 2.0.1,
ultima build 77" con la massima serenita'. Numeri plausibili, prodotto diverso.
Il rischio vero non e' l'upload (lo instrada il bundle id dell'archive) ma la
**verifica finale**, che aspetta una build in un'app dove non arrivera' mai — e
soprattutto un umano che legge la versione pubblica sbagliata e sceglie il numero
di release su un dato falso.

Dal 2026-08-26 `scripts/asc.py` **non si fida piu' del default**: risolve l'app
dal bundle che questo repo spedisce (`com.paolocelestini.twowatch.ios`) cercandolo
nel registro `apps` del config, e se il default punta altrove lo dice:

```
[asc] app risolta dal bundle com.paolocelestini.twowatch.ios: Somto (6760966564).
      Il default del config punta altrove (6761762177): ignorato.
```

Precedenza: `ASC_APP_ID` esplicito > risoluzione per bundle > `app_id` del config.
Se il registro `apps` non c'e', si ricade sul comportamento di prima.

**Non serve piu' correggere il default a mano**, e non ha senso farlo: sarebbe una
gara a chi lo tocca per ultimo. Se un giorno serve puntare a un'altra app, si usa
`ASC_APP_ID` per quel comando.

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
