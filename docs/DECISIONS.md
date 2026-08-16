# Registro decisioni tecniche (ADR leggero)

Formato: data — decisione — motivazione — alternative scartate.
Aggiungere in cima. Le decisioni di prodotto restano in CLAUDE.md.

## 2026-08-15 — I link diretti alle piattaforme vengono da Wikidata

### Wikidata, non JustWatch
- **Decisione**: gli id delle piattaforme (Netflix, Disney+, Apple TV, Max) si
  prendono da Wikidata partendo dal TMDB id che abbiamo già, e diventano URL con
  il formatter dichiarato sulla proprietà stessa (P1630). Modulo:
  `functions/lib/wikidataStreamingLinks.js`.
- **Perché non JustWatch**: quei deep link sono il prodotto che JustWatch vende
  e le loro condizioni vietano la raccolta automatica. Wikidata è dato pubblico
  CC0 con un endpoint fatto per essere interrogato. Il link JustWatch/TMDB resta
  come ultimo ripiego, così com'è oggi.
- **Copertura misurata** (296 titoli del catalogo con provider italiani, 2026-08-15):
  almeno un link diretto sul **74%**. Netflix 90%, Disney+ 80%, Apple TV 83%,
  HBO Max 50%, Paramount+ 17%, Prime Video 20%.
- **Prime Video escluso dai link diretti**: gli id su Wikidata sono ASIN del
  catalogo USA. `amazon.com/gp/video/detail/<asin>` risponde 200, lo stesso id su
  `primevideo.com` e `amazon.it` dà 404. Per un utente italiano la ricerca
  nell'app è meglio di un link rotto.
- **iTunes Search API scartata**: interrogata il 2026-08-15 restituisce 0
  risultati anche per titoli in vendita (`country=IT` e `US`, film e stagioni).
  Gli id Apple TV di Wikidata (`umc.cmc.*`) funzionano e coprono l'83%.

### Il confine: TMDB dice QUALI, Wikidata dice DOVE
- Un id Netflix esiste anche per titoli che in Italia stanno altrove: è globale.
  Quindi i link risolti vengono **filtrati** sui provider che TMDB dichiara per
  la regione prima di essere salvati e mostrati. Senza quel filtro comparirebbe
  "Guarda su Netflix" su un titolo che qui è solo su Prime.

### Cache e interruttore
- I link stanno in `titleProviders/{titleId}.deepLinks` (+ `deepLinksAtMs`,
  TTL 30 giorni) e denormalizzati in `titles.watchDeepLinks` per chi non passa
  dalla callable (widget, liste). Nessuna collection nuova.
- Il primo utente che apre un titolo paga la risoluzione, gli altri leggono la
  cache; un backfill schedulato (20 titoli ogni 10 minuti) copre il resto senza
  farsi limitare — WDQS risponde 429 al terzo gruppo da 40 id consecutivo.
- Tutto dietro `STREAMING_DEEPLINKS_ENABLED`, **spento di default**: a
  interruttore spento l'app si comporta esattamente come prima.

## 2026-08-15 — Widget grande "riprendi da qui", e dove porta il play

### Il cambio serie è un tap sul widget, non "Modifica widget"
- **Decisione**: nella misura grande le altre serie stanno in fondo come
  locandine; toccarne una la porta in testa (`PinSeriesIntent` scrive l'id in
  `watchlist-widget-selection.json`, nell'App Group). La configurazione resta e
  vale come preferenza iniziale: appena si tocca, comanda il tap.
- **Perché**: la strada ufficiale (tieni premuto → Modifica widget → scegli) non
  la trova nessuno — constatato sul device: "non avevo idea di come si potesse
  cambiare serie". Un tap sulla locandina è la stessa azione senza istruzioni.
- **Nota di implementazione**: il riordino avviene PRIMA di scegliere quali
  righe disegnare. Riordinare dopo lascerebbe fuori una serie che il piano ha
  tagliato, e il tap sembrerebbe ignorato.

### Il tasto play: link diretto se c'è, altrimenti ricerca nell'app
- **Decisione**: `WidgetWatchLink` prova in ordine (1) il deep link diretto al
  titolo dentro la piattaforma, se il riassunto ce l'ha, (2) la ricerca sul sito
  del servizio, che è un universal link — con l'app installata iOS apre quella,
  non Safari. Se il servizio non è in tabella il tasto **non compare**.
- **Perché non si può fare (1) oggi**: serve l'id che il titolo ha *dentro*
  Netflix/Prime/Disney+. TMDB dà nome e logo del servizio, non quell'id. Le
  fonti che ce l'hanno sono JustWatch (partnership a pagamento), Amazon
  Associates per Prime, iTunes Search per Apple TV. Il campo `Row.watchUrl`
  esiste già vuoto: quando una fonte arriva si riempie lì e la vista non cambia.
- **Scartato**: aprire l'app del servizio alla sua home (nessun contesto, è
  peggio della ricerca); mandare alla pagina TMDB "dove guardare" (è un terzo
  sito in mezzo).

### Quello che il mockup chiedeva e non si può dare
- **"32m left" non esiste**: Somto sa quale episodio hai visto, non a che minuto
  sei dentro il prossimo — non c'è integrazione col player di nessuna
  piattaforma. Al suo posto la durata di un episodio (`meta.durationEpisode`),
  che è un dato che abbiamo, e la barra di avanzamento sulla serie.

## 2026-08-14 sera — Il widget che scrive: token nostro, non sessione Firebase

### Il bottone "episodio visto" chiama la callable con un token depositato dall'app
- **Decisione**: `MarkEpisodeWatchedIntent` (nel target `SomtoWidgets`) chiama
  la stessa callable dell'app, `applyTitleStateAction` con
  `action: "mark_series_episode"`, via POST HTTPS. Il token arriva così: l'app
  salva il **refresh token** in un keychain access group condiviso
  (`$(AppIdentifierPrefix)com.paolocelestini.twowatch.shared`), l'estensione lo
  scambia per un id token su `securetoken.googleapis.com` e chiama.
- **Perché è possibile**: "episodio visto" non è mai stata una scrittura diretta
  su Firestore — `WatchlistRepository.markSeriesEpisodeWatched` passa dalla
  callable, e `CloudFunctionsCaller` la invoca già con un semplice
  `Authorization: Bearer`. Quindi all'estensione non serve nessun SDK Firebase:
  niente gRPC/BoringSSL nel processo con il budget di memoria più stretto.
- **Perché NON `Auth.auth().userAccessGroup`** (la via ufficiale Firebase):
  sposta *dove vive* la sessione di un'app già sullo Store. Se la migrazione va
  storta, la coorte si ritrova sloggata. Qui non si tocca niente di Firebase: si
  scrive un item nuovo, e nel caso peggiore il bottone non funziona.
- **Perché non una coda "scrivo al prossimo avvio"**: l'utente che tocca un
  bottone considera la cosa fatta. Se apre Somto tre giorni dopo, per tre giorni
  quell'episodio non esiste per il web, le statistiche e le notifiche.
- **Superficie di sicurezza, e cosa la limita**: è un credenziale a lunga vita in
  più sul dispositivo. `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (fuori
  dai backup e da iCloud); cancellato al logout, a ogni cambio utente, alla
  prima apertura dopo un'installazione pulita (il keychain sopravvive alla
  disinstallazione, `UserDefaults` no) e quando il token risulta revocato (400
  dall'endpoint). L'access group è raggiungibile solo dai bundle firmati con il
  nostro team id.
- **Perché non è l'App Intent che si era rotto**: `AddToWatchlistIntent` moriva
  *prima* di `perform()`, nel bootstrap headless di Firebase. Qui di bootstrap
  non ce n'è: due richieste HTTPS.

### Dopo il tap il widget non indovina il numero nuovo
- Dice "Aggiornato in Somto" e il bottone smette di essere premibile finché
  l'app non riscrive il riassunto. Scrivere "Sei a S3·E8" sarebbe indovinare: a
  fine stagione il prossimo episodio appartiene a un'altra stagione. Il
  marcatore vive in `watchlist-widget-pending.json` e lo cancella la prima
  scrittura del riassunto vero.

## 2026-08-14 — Il widget Watchlist legge un file, non Firebase

### L'app lascia un riassunto in un App Group, il widget lo legge
- **Decisione**: `WatchlistWidget` non parla con Firebase. Quando la Watchlist
  finisce di caricare, `WatchlistViewModel` scrive un riassunto (nome, tipo,
  stagione/episodio, locandina, percorso) in
  `group.com.paolocelestini.twowatch.ios`; il widget legge quel file e disegna.
- **Perché**: in un'estensione la sessione non c'è — keychain non condiviso,
  quindi niente `Auth.currentUser` — e portarcela vorrebbe dire migrare il
  keychain di un'app già sullo Store. In più `fetchWatchlistDashboard` costa
  ~1.500-2.000 letture Firestore per refresh, che moltiplicate per i risvegli
  di un widget sono un conto vero. Il file costa zero letture e zero rete.
- **Prezzo, accettato**: la freschezza è quella dell'ultima apertura dell'app.
  Per un elenco che cambia quando sei tu a segnare un episodio — cioè dentro
  l'app — è il compromesso giusto.
- **Privacy**: è l'unico posto dove dati personali vivono fuori dal sandbox
  dell'app. Cancellato al logout (`signOutEverywhere`) e a ogni cambio utente
  (`SessionStore.consumeAuthChange`), con la stessa rete a due livelli
  dell'indice Spotlight.
- **Scartato**: keychain condiviso + Firestore nell'estensione (gRPC/BoringSSL
  domina il budget di memoria di un widget, e la migrazione è a senso unico);
  un endpoint server con token (l'estensione dovrebbe comunque autenticarsi).

### Solo vista, nessun bottone
- Un bottone in un widget è un App Intent che scrive: stessa mancanza di
  sessione, ma su un'operazione che modifica dati. Resta in `docs/PENDING.md`.

## 2026-08-16 — Home e Community condividono la conversazione sulle uscite

- **Decisione**: un'uscita affidabile genera un normale post ufficiale
  pubblico con ID deterministico dall'evento. La corsia Home "In uscita" e il
  feed Community puntano allo stesso `postId`; commenti e like non vengono
  copiati.
- **Perché**: la Home resta un launchpad editoriale e Community resta la sede
  completa della conversazione, ma il contenuto non si spezza in due thread.
  In questa fase i post Somto non sono rumore da comprimere: danno alla
  Community occasioni concrete per partecipare.
- **Guardie**: film solo con data IT confermata; serie solo premiere con
  provider italiano; niente singoli episodi, supporti fisici o date da
  verificare. Nessuna seconda push: il post automatico disabilita
  `official_update` e conserva `title_update`.
- **Sicurezza e rollback**: nessuna collection/rule/indice nuovo; campi di
  collegamento solo server-owned; kill switch
  `RELEASE_CONVERSATION_POSTS_ENABLED`.

## 2026-08-14 — Cosa entra nel feed delle prossime uscite

### Delle serie entra solo la premiere di stagione
- **Decisione**: `upcomingReleasesFeed` legge `eventType in [release_date,
  new_episode]`, ma degli eventi episodio tiene solo quelli con `episode == 1`
  (`occasion: "season_premiere"`, col numero di stagione nel payload).
- **Perché**: al 2026-08-14 gli eventi episodio futuri pubblicati erano 209, di
  cui 109 premiere. Le serie in onda producono un evento a settimana e le soap
  uno al giorno: in un widget da tre righe, ordinato per data, vincerebbero
  sempre loro. Da li' si vuole sapere *quando torna*, non quando esce la
  puntata di giovedi.
- **Scartato**: due query separate film/serie con fusione a mano (il cap a 10
  taglierebbe la lista sbagliata); includere ogni episodio con un tetto per
  serie (complica il feed per un'informazione che nessuno cerca li').

### Una data marcata da verificare non entra
- **Decisione**: gli eventi con `reviewReason` valorizzato non entrano nel feed.
- **Perché**: erano 22 su 53, tutti `missing_it_release_date` — TMDB non ha una
  data italiana e quella mostrata è la globale, con headline "Data di uscita da
  verificare". Nella scheda titolo quella frase si legge; in un widget resta
  solo il numero, e un numero non ha sfumature. Restano visibili dove il dubbio
  si può leggere.
- **Scartato**: mostrarle con un segno grafico (in `systemSmall` non c'è lo
  spazio, e "circa" su una data è un'informazione che nessuno usa).

### Niente logo della piattaforma sulle uscite
- **Decisione**: il widget scrive "Al cinema" / "In streaming" / "In TV" dal
  `releaseType` TMDB, senza logo del servizio.
- **Perché**: misurato sul catalogo, **0 titoli su 40 in arrivo** avevano
  `watchProviderNames`. TMDB (via JustWatch) pubblica i provider quando il
  titolo è disponibile, non prima: il logo sarebbe uno spazio vuoto quasi
  sempre, e i byte di un'immagine in più per riga viaggiano dentro la timeline.
- **Ripreso quando**: esisterà una fonte che conosce la piattaforma prima
  dell'uscita. Per le serie `titles.meta.network` (da `networks[0]` TMDB) è già
  li' ed è il candidato più vicino.

## 2026-08-12 — Il widget iOS non parla con Firebase

### `SomtoWidgets` legge un endpoint HTTPS pubblico, non Firestore
- **Decisione**: il primo widget ("Prossime uscite") fa una `URLSession` su
  `https://somto.it/prossime-uscite.json`, servito dalla Cloud Function
  `upcomingReleasesFeed`. Il target `SomtoWidgets` non linka nessun prodotto
  Firebase né GoogleSignIn.
- **Perché**: tre fatti indipendenti, ognuno da solo sufficiente.
  (1) `FirebaseBootstrap.configureIfNeeded()` cerca la config con `Bundle.main`,
  che in un'estensione è il `.appex` e non l'app → `fatalError`.
  (2) Il keychain non è condiviso fra app ed estensione: `Auth.currentUser` qui
  non esisterebbe comunque, e migrare il keychain di un'app già sullo Store è
  rischioso.
  (3) `FirebaseFirestore` trascina gRPC/BoringSSL, cioè la dipendenza che da
  sola domina il budget di memoria di un widget.
  I dati delle uscite sono globali e pubblici (`titleUpdateEvents` con
  `status: "published"` è già leggibile da chiunque, `firestore.rules:2672`):
  nessuno dei tre costi comprerebbe qualcosa.
- **Scartato**: App Group + keychain sharing per riusare la sessione (serve
  solo ai widget che mostrano dati dell'utente, e va deciso quando si farà
  quello "serie in corso" — vedi `docs/PENDING.md`); leggere Firestore via
  REST dall'estensione (stessa esposizione di un endpoint nostro, ma senza
  poter dare al widget un payload già pronto, e con la forma dei documenti
  come contratto pubblico).
- **Conseguenza operativa**: il widget dipende da un deploy di
  `functions:upcomingReleasesFeed` + hosting + **un indice Firestore nuovo**
  (`titleUpdateEvents`: `eventType`, `status`, `effectiveAt`). Senza l'indice
  la function risponde 500.

## 2026-07-12 sera — Staging su Blaze

### Blaze su somto-staging
- Billing configurato fuori dal repository, con costi separati per progetto.
  Identificativi del billing account e degli altri progetti non sono
  documentazione pubblica e restano nella console Google Cloud.
- `tmdbProxy` ha `minInstances:1` SOLO su prod (condizione su GCLOUD_PROJECT):
  staging non paga l'istanza calda.

### Trigger Firestore gen1 non deployabili su staging (limite Google)
- Sul progetto nuovo la creazione di trigger Firestore gen1 fallisce con
  "region eur3-europe-west1 not supported": Google non supporta più trigger
  gen1 su progetti nuovi. Callable/scheduled/https deployate regolarmente.
- Conseguenza: su staging gli aggregati mantenuti dai trigger (ratingAggregate,
  notifiche automatiche, feed fan-out da trigger) NON si aggiornano — testarli
  in emulatore. Fix strutturale = migrazione gen2 (in backlog, vedi CLAUDE.md).

## 2026-07-12 — Consolidamento base tecnica

### Staging = progetto Firebase separato con switch per hostname
- **Decisione**: creato `somto-staging`; `public/firebaseConfig.js` sceglie
  prod/staging dall'hostname a runtime. Stesso artefatto deployato ovunque.
- **Perché**: la PWA è buildless (niente bundler/env injection); lo switch a
  runtime è l'unico meccanismo che non introduce una pipeline di build e
  garantisce zero impatto su prod (il ramo staging si attiva solo su host
  staging).
- **Scartato**: build separata con sostituzione config (introduce bundler e
  drift tra ambienti); progetto unico con prefissi nelle collection (rules
  ingestibili, rischio dati).

### ~~Staging resta su piano Spark~~ — SUPERATA la sera stessa
- Il proprietario ha autorizzato Blaze (vedi entry "2026-07-12 sera" sopra).
  `firebase.staging.json` ora è lo specchio completo di `firebase.json`
  (functions+storage+rewrites) + header noindex.

### Niente branch protection GitHub
- **Vincolo**: repo privato su piano Free — GitHub non permette branch
  protection/rulesets. Alternativa attiva: guardia `check-deploy-safety.mjs`
  (prod solo da main pulito con `CONFIRM_PROD`) + CI su push/PR.
- **Se in futuro**: GitHub Pro (~4$/mese) o repo pubblico sbloccano la
  protezione vera di `main`.

### Niente ESLint/Prettier per ora
- **Perché**: zero config esistente; introdurlo ora su ~330 file JS vanilla
  produrrebbe migliaia di segnalazioni e diff giganti senza valore
  immediato. La CI copre: unit 418 + rules 121 + syntax check + build blog.
- **Rivalutare**: quando si tocca in modo esteso `public/js/`, partire con
  eslint flat-config e regole minime (no-undef, no-unused-vars).

### Storia release fuori da CLAUDE.md
- **Decisione**: i bullet storici di build/release vivono in
  `docs/RELEASE_HISTORY.md`; CLAUDE.md resta guida operativa snella.
- **Perché**: CLAUDE.md era ~122KB, quasi tutto log storico — costoso da
  caricare per ogni agente e difficile da mantenere.

### Branch e stash eliminati (2026-07-12)
Tutti verificati **byte-equivalenti a contenuto già in main** (via
`git cherry`/`git patch-id`/ancestry) prima della rimozione:
- `claude/stoic-boyd-599da9` @ d16bea1 (= 82ea25e in main)
- `codex/tvtime-import-release` @ 5113275 (ancestor di main via 2abe25c)
- `feat/ios-title-redesign` @ 34a316d origin (mergiato via f67efec) —
  il ref locale sopravvive solo nel worktree `../somto-ios`
- `reconcile/community-restore` @ 2abe25c (ancestor di main)
- `reconcile/tvtime-de` @ 84cef24 (= 32b1d85 in main)
- stash@{0} "pre-release mixed WIP" e stash@{1} "WIP iOS pre-rebase":
  contenuto verificato già presente in main in forma uguale o più evoluta.
Punto di ripristino: tag `snapshot-2026-07-12-consolidamento` su origin.

### File privati fuori dal versionamento
- I 5 appunti personali in root (docx/analisi/piano/db-legenda) sono usciti
  da git (`git rm --cached`) e ignorati; restano su disco. La history NON è
  stata riscritta (repo privato, force-push vietato dalle regole del repo).

### Sistema editoriale: estendere, non rifare
- La pipeline `publishOfficialUpdate` (live in prod, mai usata) è solida:
  dedup deterministico, audience per interesse sui titoli, bozze, dryRun.
  Aggiunti: callable `unpublishOfficialUpdate`, rules admin-read su
  `officialUpdates`, console web `/admin-official-updates.html`, fix del
  ctaUrl morto delle notifiche. Scheduling: rimandato (vedi
  docs/EDITORIAL_SYSTEM.md).

## Decisioni preesistenti confermate (contesto storico in CLAUDE.md)

- **Firestore resta il database**: nessuna migrazione SQL — il modello
  documentale con denormalizzazioni mantenute da trigger O(1) + script di
  reconcile regge il carico attuale; i costi sono monitorati (incidente
  import wave 2026-07-11 risolto con guardie, non con un cambio di db).
- **iOS: mai `HTTPSCallable.call async` del SDK Firebase** → sempre
  `CloudFunctionsCaller` (crash `async let`, incidente 1.4.3).
- **Mai `Dictionary(uniqueKeysWithValues:)` su chiavi derivate** (crash
  v0.3.22); guardia pre-commit in `scripts/hooks/`.
- **Deploy prod solo da tree committato** (incidente rules 2026-07-02).
- **Il quiz è la leva di acquisizione**; guest play web-only by design.

## 2026-07-27 — Emozioni per episodio separate dalle emozioni della serie

- **Decisione**: aggiungere `episodeEmotions` con un documento deterministico
  per utente/episodio e un bucket community server-owned per episodio.
  `titleEmotions` resta la risposta generale sul titolo.
- **Perché**: riutilizzare o migrare automaticamente `titleEmotions` avrebbe
  inventato quale episodio ha provocato una reazione e avrebbe reso ambiguo
  il significato dei dati già raccolti.
- **Sicurezza**: ownership e id canonico sono verificati nelle Firestore
  rules; coordinate e `createdAt` sono immutabili; il client può scegliere
  solo 1-3 chiavi canoniche. Gli aggregati sono deny-write e aggiornati dal
  trigger gen2 `recomputeEpisodeEmotionAggregate`.
- **Migrazione**: nessun backfill semantico. La modifica è additiva; rollback
  UI significa smettere di scrivere la nuova collection senza alterare
  `titleEmotions`. La collection e i bucket possono essere conservati per
  audit o rimossi successivamente con uno script esplicito.

## 2026-07-28 — Programmazione degli aggiornamenti ufficiali (serie editoriale)

- **Decisione**: la pubblicazione differita si fa con una bozza
  `officialUpdates/{slug}` che porta `scheduledAt`, pubblicata dallo scheduler
  gen2 `publishScheduledOfficialUpdates` (europe-west1, ogni 15 min) che
  riusa `publishOfficialUpdate`. Nessun modello dati nuovo, nessun secondo
  percorso di pubblicazione: è il design già previsto in
  `docs/EDITORIAL_SYSTEM.md` §Limiti #1.
- **Perché**: la serie editoriale (3 post in 3 giorni) richiedeva uscite a ora
  fissa. L'alternativa — pubblicare a mano un post al giorno — non lasciava
  niente di riusabile e dipendeva da un intervento umano puntuale.
- **Idempotenza**: il claim `scheduleClaimedAt` in transazione evita run
  sovrapposti (riprovabile dopo 10 minuti se un run muore a metà); anche in
  caso di doppia pubblicazione gli id deterministici di post, feedEvents e
  notifiche rendono la scrittura non duplicante.
- **Indice mancante trovato in prod**: `collectInterestedUserUids` usa
  `collectionGroup("titleStates").where("titleId","in",…)` e l'indice
  collection-group su `titleStates.titleId` non esisteva → il fan-out sarebbe
  fallito alla prima pubblicazione reale (il sistema non era mai stato usato).
  Aggiunto come `fieldOverride` in `firestore.indexes.json`.
- **Testo dei post**: il feed web troncava a 500 caratteri mentre rules e
  `publishOfficialUpdate` ne ammettono 1000 → allineato a 1000. Gli URL nei
  post ora diventano link (stessa logica già usata nei messaggi thread).

## 2026-07-28 — Indici collection-group: fallire in silenzio è la norma, non l'eccezione

- **Contesto**: pubblicando il primo aggiornamento ufficiale sono emerse due
  query collection-group senza indice in prod. Uno sweep su tutte le query
  del backend ne ha trovate **7 rotte**, alcune da mesi.
- **Perché non se n'era accorto nessuno**: una query collection-group senza
  indice non fallisce al deploy, fallisce a runtime con `FAILED_PRECONDITION`.
  Dove il chiamante ha un `.catch()` (deduplica token push) l'errore sparisce
  e la feature semplicemente non fa nulla; dove non ce l'ha
  (`cleanupOldNotifications`) la scheduled function erra ogni giorno senza che
  nessuno guardi i log.
- **Conseguenze reali trovate**: fan-out degli aggiornamenti ufficiali
  impossibile; stesso device registrato su più account → push duplicate;
  `notifications` e `signals` mai potate; `deleteMyAccount` non anonimizzava i
  commenti e non cancellava like e condivisioni.
- **Decisione**: gli indici mancanti sono `fieldOverrides` in
  `firestore.indexes.json`, e prima di dare per funzionante una feature che usa
  `collectionGroup(...)` si lancia
  `functions/scripts/check-collection-group-indexes.js`, che esegue le query
  reali su prod e dice quali non hanno indice.
- **Nota per il futuro**: quando si aggiunge una query collection-group, va
  aggiunta anche una riga in quello script. Un `.catch()` attorno a una query
  del genere nasconde esattamente questa classe di bug.

## 2026-07-29 — Versione EN: si fa, in fasi, e non è un lavoro di traduzione

- **Contesto**: analisi completa dello stato i18n
  (`docs/I18N-ANALYSIS-2026-07-29.md`). Non esiste internazionalizzazione su
  nessuna superficie. Il catalogo iOS `Localizable.xcstrings` (339 chiavi già
  tradotte EN+ES) **non è mai stato nel bundle**: `project.yml` esclude
  `Resources/**` dal primo commit del repo. Verificato sull'archivio spedito
  1.4.21: nessun `.lproj` dell'app.
- **Decisione — scope**: si fa la EN completa, in 4 fasi spedibili
  (fondamenta → app → server → dati e acquisizione). ~110-150 giornate-persona.
  Fermarsi all'interfaccia sarebbe la stessa finzione di oggi, più grande.
- **Decisione — quiz**: si mantengono **due corpus vivi**, IT ed EN. Costo
  ricorrente accettato: ogni futuro batch di domande costa +1-2 giornate.
  L'Italia resta il mercato principale, l'inglese si aggiunge.
- **Decisione — spagnolo: no.** Le 339 chiavi ES del catalogo morto coprono
  comunque solo l'11% delle stringhe iOS reali: non è un asset, è un'illusione.
  Si riconsidera a dati alla mano.
- **Il grosso non è traduzione** (meno di un quinto del totale): è refactor.
  Il server non ha modo di sapere la lingua dell'utente, 7-8 tipi di notifica
  congelano la frase italiana dentro `data.message` in Firestore, e il catalogo
  TMDB è persistito una volta sola in italiano.
- **Tre difetti che sono tali già oggi**, in un'app monolingua, e vanno chiusi
  a prescindere dalla EN: lo spoiler checker è 6 regex italiane (un post in
  inglese bypassa la moderazione senza lasciare traccia); `quizQuestions` ha un
  campo `language` che nessuna query filtra; il parser Netflix gestisce
  `Stagione|Season` alla riga 56 ma solo `Episodio` alla 67 (export da account
  inglese → progressi di visione sbagliati, nessun crash).
- **URL**: sottocartella `somto.it/en/`. Il vincolo vero è che `.it` è un ccTLD
  con geo-targeting italiano non disattivabile, e International Targeting non
  esiste per le proprietà ccTLD — né sottodominio né sottocartella lo
  risolvono, solo un `.com` nuovo, che però parte da zero backlink. La
  sottocartella costa quasi nulla in infra e non preclude un `.com` più avanti.

## 2026-07-29 — Grafo amicizie: dismesso, in tre fasi

- **Contesto**: il grafo `users/{uid}/friends` (richieste con
  `status: pending|accepted`) è stato sostituito dal solo follow/following.
  Il 2026-07-29, rimuovendo il contatore "Amici" dalla hero del profilo per
  allinearla al profilo pubblico, è emerso che intorno a quel grafo era
  rimasto un misto di codice orfano e codice **ancora live**: la voce "Amici"
  nel drawer web apriva una modale che elencava un grafo vuoto, e l'inbox
  profilo iOS accettava ancora richieste.
- **Decisione**: il grafo si dismette, ma in tre fasi, perché rules e trigger
  non si possono toccare finché la coorte App Store non è aggiornata.
- **Fase 1 (fatta)**: via tutta la UI e tutte le write dai client, zero
  modifiche a rules, Cloud Functions e dati. Le build iOS già sullo Store
  continuano quindi a funzionare — semplicemente sono le ultime che possono
  creare un'amicizia. Rimossa anche la visibilità "Amici" dai composer post:
  con `isFriendWith` di fatto sempre falsa, un post friends-only non lo
  leggerebbe nessuno.
- **Fase 2 (bloccata)**: precondizione = coorte App Store aggiornata. In
  ordine: migrare i post esistenti con `visibility: "friends"` (a `private` o
  `public`, decisione da prendere sui volumi reali), poi togliere
  `isFriendWith` dalle rules, i due trigger notifica su
  `users/{userId}/friends/{friendUid}` e il ramo friends di
  `collectFeedRecipientUids`. Vanno migrati a `following` anche i lettori
  rimasti: `listFriends` sul web (scheda titolo, community, thread, sfide
  quiz) e `listAcceptedFriends` su iOS (picker sfide, menzioni).
- **Fase 3**: cancellazione dei doc `users/{uid}/friends`. La pulizia dentro
  `deleteMyAccount` resta fino a quel momento, altrimenti gli account
  cancellati lascerebbero mezzi archi in giro.
- **Attenzione ai trigger**: `notifyOnFriendRequest` e `notifyOnFriendAccept`
  sono **gen1**. Su prod i trigger gen1 nuovi non sono più creabili (vedi
  2026-07-25), quindi cancellarli in fase 2 è un'operazione a senso unico: se
  servisse tornare indietro andrebbero riscritti gen2.

## 2026-08-03 — Notifiche: il gate degli aggiornamenti titolo è per titolo

- **Contesto**: la pipeline `title_update` è andata in produzione il 2026-08-02
  e non ha mai mandato una notifica. Il gate backfill/live era **globale**
  (`systemJobs/titleUpdateScanner.initialBackfillCompleted`): live solo dopo
  che lo scanner aveva passato in rassegna l'intero catalogo. Con ~20k titoli
  a 12 titoli ogni 15 minuti servivano 17 giorni, e nel frattempo ogni evento
  nasceva `acquisitionMode: "backfill"`, cioè non notificabile **per sempre**
  (`mergeExistingEvent` non lo riabilita mai). Stato al momento della
  diagnosi: 341 eventi, 333 pubblicati, 0 notificabili.
- **Decisione**: il gate diventa **per titolo**
  (`titleProviders/{titleId}.titleUpdateScanAtMs`). La prima scansione di un
  titolo resta backfill — è l'unico giro in cui non sappiamo distinguere una
  novità dallo storico che TMDB ci restituisce — dalla seconda in poi è live.
  Nessuna attesa del catalogo intero, nessuna raffica: gli eventi già visti
  mantengono il loro id deterministico e restano backfill.
- **Cadenza e finestra sono accoppiate**: 30 titoli ogni 5 minuti = giro
  completo in ~2,5 giorni, finestra live alzata da 72h a 5 giorni. Con la
  cadenza vecchia (~18 giorni per giro) contro una finestra di 72h, ~83% dei
  trailer sarebbe stato scartato per "troppo vecchio" **anche dopo** lo
  sblocco. Se in futuro si tocca uno dei due valori va ricontrollato l'altro.
- **Marcatore seminato** sui 1.090 titoli già scansionati con
  `functions/scripts/seed-title-update-scan-marks.js`, per non far ripartire
  l'attesa da zero.

## 2026-08-03 — Il token push si ri-registra da solo, e updatedAt torna a dire la verità

- **Contesto**: 50 utenti su 361 (13,9%) avevano un token FCM, tutti iOS, zero
  web. Con un token assente la push muore in `pushOnNotificationCreate` e resta
  solo la campanella in-app: era questa, non la logica delle notifiche, la
  ragione per cui "molti non ricevono niente".
- **Due difetti, entrambi silenziosi**:
  - la rule di update su `notificationTokens` pretendeva `createdAt` identico
    all'originale, mentre i client rimandano l'intero payload con
    `createdAt: serverTimestamp()`. Ogni refresh finiva in permission-denied,
    inghiottito dal `catch` del client: i doc token restavano fermi alla data
    di installazione (quello di Paolo al 22 marzo) e `updatedAt` non
    distingueva più un device vivo da un fantasma;
  - sul web il token si registrava **solo** al click sul banner, e il banner
    non ricompare dopo che il permesso è stato concesso. Perdere il token
    (browser nuovo, dati puliti, rotazione FCM, pulizia dei token invalidi)
    significava restare senza push per sempre, senza alcun segnale.
- **Decisione**: la rule accetta `createdAt` invariato **oppure**
  `request.time`; il client iOS scrive `createdAt` solo alla prima
  registrazione; la PWA ri-registra il token a ogni sessione quando il permesso
  è già `granted`. `updatedAt` torna a essere un heartbeat affidabile.
