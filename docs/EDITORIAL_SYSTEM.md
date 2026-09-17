# Sistema editoriale (aggiornamenti ufficiali)

Ultimo aggiornamento: 2026-08-28.

Canale con cui Somto comunica agli utenti: nuove stagioni, date di uscita,
rinnovi/cancellazioni, trailer, annunci di prodotto. Distinto da: dati TMDB
(catalogo), blog SEO (`blog/` → `public/blog/`, statico), notifiche
tecniche (import, sfide quiz).

## Principio editoriale: partire dall'evento

Il report settimanale non e' un calendario di post e non va pubblicato in
blocco. Serve a intercettare eventi ufficiali appena successi: teaser, trailer,
date, rinnovi, casting e annunci. Quando un evento puo' far cercare ai fan il
titolo o qualcuno con cui parlarne, l'aggiornamento va pubblicato il prima
possibile, idealmente entro 24 ore.

Ogni post deve:

- spiegare subito che cosa e' successo, senza introduzioni generiche;
- essere collegato alla nuova scheda e ai capitoli precedenti realmente
  pertinenti, cosi' raggiunge il pubblico della saga e compare nei relativi
  "Aggiornamenti";
- chiudere con una domanda specifica sull'annuncio, utile a far partire la
  conversazione;
- evitare targeting per semplice affinita' di genere finche' non esiste una
  regola affidabile nel fan-out.

Uno stesso titolo puo' ricevere piu' post solo per eventi distinti. Non si
ripubblica la stessa notizia solo per riempire il calendario.

## Architettura (esistente, estesa 2026-07-12)

### Backend — `functions/lib/officialUpdates.js` + `functions/modules/officialUpdates.js`

**`publishOfficialUpdate`** (callable europe-west1, **LIVE in prod**,
admin-only, rate limit 2/20s, 40/giorno):

Input: `{ title, text, summary?, slug?, updateType, linkedTitleIds (1..10,
obbligatori), sourceUrls? (max 6), audienceUids? (max 5000, per test),
status: "draft"|"published", dryRun?: bool, maxAudience?: number }`.

- `updateType` ∈ announcement, new_season, new_episode, release_date,
  renewal, cancellation, sequel, trailer, casting, rumor, not_confirmed.
- **dryRun** → nessuna scrittura, ritorna `recipientCount` (anteprima).
- **draft** → scrive solo il registro `officialUpdates/{slug}`.
- **published** →
  1. upsert utente sintetico `users/somto_official` (autore "Somto");
  2. post pubblico `posts/official_{slug}` con `isOfficialUpdate: true`;
  3. fan-out `feedEvents` ai soli utenti **interessati ai titoli linkati**
     (collectionGroup `titleStates`, cap 5000) — id doc deterministico
     `(ownerUid, eventKey=official_update:{slug})`;
  4. notifiche `users/{uid}/notifications/official_update_{slug}` (id
     deterministico → **ripubblicare lo stesso slug NON duplica mai**),
     TTL 90 giorni, ctaUrl `/community.html?post=official_{slug}`;
  5. registro `officialUpdates/{slug}` con audit (audienceCount,
     feedEventsWritten, notificationsWritten, requestedByUid, publishedAt).

**Programmazione (`scheduledAt`, 2026-07-28)**: su una bozza si può passare
`scheduledAt` (ISO string / epoch ms). Viene salvato come Timestamp sul
registro `officialUpdates/{slug}`; lo scheduler gen2
**`publishScheduledOfficialUpdates`** (europe-west1, ogni 15 min, timezone
Europe/Rome) prende le bozze scadute e le pubblica riusando
`publishOfficialUpdate`. Nessun secondo percorso di pubblicazione.

- Claim `scheduleClaimedAt` in transazione → due run sovrapposti non
  pubblicano due volte; un claim orfano viene riprovato dopo 10 minuti.
- Se il publish fallisce la bozza resta `draft` con `lastScheduleError` e
  viene riprovata al giro successivo.
- Da UI: campo **"Programma per"** in `/admin-official-updates.html`, attivo
  solo sul pulsante "Salva bozza". Da CLI: `--status draft --scheduled-at`
  su `functions/scripts/publish-official-update.cjs`.
- Il fan-out richiede l'indice collection-group su `titleStates.titleId`
  (`fieldOverrides` in `firestore.indexes.json`): senza, `publishOfficialUpdate`
  fallisce con `FAILED_PRECONDITION` appena si esce dall'audience di test.

### Acquisizione da fonti ufficiali (2026-08-23)

`scanOfficialSources` controlla ogni 6 ore due fonti allowlisted:

- `press.disney.co.uk/news/` tramite sitemap;
- `press.hulu.com/pressrelease/` tramite la pagina Press.

Il percorso è volutamente separato da TMDB: riconosce soltanto annunci
espliciti di rinnovo, cancellazione/fine, nuova stagione o casting, prova un
match **esatto** con un titolo `approved` e crea esclusivamente una bozza
`officialUpdates`. Non pubblica post, feed event o notifiche agli utenti. Le
bozze automatiche hanno `notificationsEnabled: false`, il prefisso visibile
`Da rivedere:` e un avviso nel testo: prima della pubblicazione un admin deve
verificare i fatti e riscrivere il copy.

Guardrail:

- solo HTTPS, host e path esplicitamente ammessi; redirect e canonical vengono
  validati di nuovo, risposta massima 5 MB e timeout 20 secondi;
- massimo 12 articoli per run e identificatori deterministici;
- deduplica per id fonte, URL fonte e coppia titolo/tipo/numero stagione;
- al primo run viene salvata una baseline, senza backfill storico;
- gli errori di rete vengono riprovati; gli annunci senza match non bloccano
  la coda e restano nel report finché una voce con lo stesso URL li copre;
- kill switch `OFFICIAL_SOURCE_INGESTION_ENABLED=false`; senza override è
  attivo solo sul progetto prod `gia-visto`.

`reportOfficialSourceCoverage` gira ogni giorno alle 10:15 (Europe/Rome),
salva il riepilogo in `systemJobs/officialSourceScanner.lastReport` e avvisa
gli uid di `ADMIN_UIDS` se ci sono bozze, annunci senza match, errori fonte o
segnali TMDB deboli. Il controllo TMDB è solo diagnostico: campiona serie con
stato `Returning Series` ma senza prossimo episodio e senza aggiornamenti
recenti; non crea e non pubblica contenuti.

Verifica manuale, senza scritture:

```bash
cd functions
npm run scan:official-sources -- --project gia-visto
npm run scan:official-sources -- --project gia-visto --url https://press.disney.co.uk/news/...
```

`--apply` crea la bozza o inizializza la baseline; `--allow-historical` è
necessario per acquisire intenzionalmente un articolo fuori dalla finestra di
14 giorni. La prova reale sul comunicato Disney di *Only Murders in the
Building 6* ha restituito il titolo corretto e `duplicate: source_url` rispetto
al post già pubblicato: nessuna seconda bozza.

**Avvisi editoriali (2026-08-13)**: `publishOfficialUpdate` restituisce
`warnings[]` sia in dry run sia in pubblicazione. Oggi ne esiste uno:
`season_already_started` — `updateType: "new_season"` su un titolo la cui
ultima stagione (`meta.seasons`) è partita da più di 2 giorni. La console lo
mostra nell'anteprima e nella conferma di "Pubblica". **Non blocca**: dice solo
che serve la voce di richiamo invece dell'annuncio (vedi
`docs/EDITORIAL_VOICE.md`). Nasce dal post su Ted Lasso 4, pubblicato con voce
da annuncio 9 giorni dopo la partenza della stagione.

**`unpublishOfficialUpdate`** (callable admin, `{slug}`, **LIVE dal 2026-07-12**): ritira un aggiornamento —
cancella il post, i feedEvents (ricavati per eventKey) e le notifiche dei
destinatari, marca il registro `status: "retired"` + retiredAt/retiredByUid.

### Firestore rules
`officialUpdates/{slug}`: read solo admin (**LIVE dal 2026-07-12**), write solo server. I client non possono
falsificare `isOfficialUpdate`/`officialUpdate` sui post (rule esistente).

### Rendering lato utente (già live)
- Il post ufficiale appare nel feed Community; iOS mostra il badge
  "Ufficiale" (`CommunityView.swift`); la notifica `official_update` è
  gestita su web (`notifications.page.js`) e iOS (`NotificationRepository`).
- Push: il trigger notifiche esistente inoltra ai token holder.

### Console admin — `/admin-official-updates.html` (nuova, 2026-07-12)
Composer web (solo admin): titolo, slug auto, testo, sommario, tipo,
ricerca titoli collegati, fonti, audience di test; **Anteprima (dry run)**
con conteggio destinatari, **Salva bozza**, **Pubblica** (con conferma),
elenco pubblicati/bozze con **Ritira**. Tutte le funzioni sono operative
(rules+functions+hosting live dal 2026-07-12).

Questa console e' il punto editoriale indipendente dalle release client: un
admin puo' pubblicare, correggere, programmare o ritirare post senza una nuova
build iOS e senza un aggiornamento App Store. I client gia' distribuiti leggono
gli stessi normali post pubblici dalla Community e ricevono il fan-out server.
Una release serve solo per cambiare l'interfaccia, non per inviare contenuti.

### Script CLI (alternativa alla console)
`functions/scripts/publish-official-update.cjs` — pubblicazione da
terminale con admin SDK (usato per test, mai in produzione finora).

Dal 2026-08-26 accetta anche `--authorUid` (pagina editoriale che firma) e
`--tasteAudienceLimit` (pubblico per affinita', 0 = spento): erano gia' in
console, mancavano solo da riga di comando.

## Stato operativo

- **Primo uso reale**: serie editoriale "film per categoria", 3 post
  programmati per il 29-31 luglio 2026 (vedi sotto). Prima di allora la
  collection `officialUpdates` era vuota e il fan-out non era mai stato
  eseguito — motivo per cui l'indice mancante è emerso solo ora.
- **Tutto deployato in prod il 2026-07-12** (rules + functions + hosting SW v109): il flusso completo compose→anteprima→bozza→pubblica→ritira è operativo dalla console.
- **Batch W34 (2026-08-19)**: dal pacchetto editoriale esterno (7 post lunghi +
  33 brevi) sono usciti 30 aggiornamenti reali — 2 pubblicati subito
  (`twisted-metal-italia`, `the-gentlemen-2`) e 28 programmati su due slot
  giornalieri (12:00 e 19:00 Roma) dal 19/08 al 05/09. Per 19 di questi il
  titolo non era in catalogo ed è stato creato da TMDB con `upsertTmdbTitle`
  (stesso percorso di `importRecentTmdbTitles`: docId `tmdb_{type}_{id}`,
  `status: approved`, poster su Storage). Sono rimasti fuori solo i 9 doppioni
  dei post automatici sulle uscite.
- **Only Murders in the Building 6 (2026-08-23)**: comunicato ufficiale Disney
  pubblicato come `only-murders-in-the-building-6-ufficiale`, 21 destinatari;
  il successivo test dell'adattatore lo ha riconosciuto come duplicato.

### Prima di un post manuale: due controlli obbligatori

1. **Dedup contro i post automatici.** Da quando gira
   `publishReleaseConversationPosts`, ogni uscita affidabile ha già il suo
   `uscita-{eventId}`. Un `release_date` manuale sullo stesso titolo è un
   doppione che rinotifica le stesse persone. Si controlla leggendo
   `officialUpdates` e incrociando `linkedTitleIds` (nel batch W34 ha eliminato
   6 post su 7 dei film).
2. **Risolvere i `linkedTitleIds` sul catalogo prod.** Servono id di titoli
   `approved`: si cercano su `titles` per `nameLower` (normalizzato con
   `pureUtils.normalizeText`). Un pacchetto scritto senza match TMDB arriva con
   i soli nomi, e i titoli non ancora in catalogo (film di festival, spin-off
   appena annunciati) vanno creati prima o il post non si pubblica: si crea da
   TMDB con `upsertTmdbTitle` di `functions/modules/tmdb.js`, non a mano.
   Attenzione ai falsi negativi della ricerca per prefisso: il nome del
   pacchetto è spesso diverso da quello di catalogo (*«Monster (antologia
   Netflix)»* contro *«Monster: La storia di Lizzie Borden»*, già presente).
   Verifica anche il **tipo**: TMDB dava `Unabomber` come film mentre il
   pacchetto lo raccontava come serie, e il testo è stato corretto prima di
   programmarlo.

## Conversazioni automatiche sulle uscite (LIVE in prod dal 2026-08-16)

Le uscite affidabili possono diventare automaticamente post ufficiali
commentabili, senza introdurre un secondo modello sociale:

- film: `release_date` pubblicato, regione `IT`, senza `reviewReason` e senza
  uscita in solo supporto fisico;
- serie: solo `new_episode` con `episode == 1`, stagione positiva e almeno un
  provider italiano noto;
- finestra: dai 2 giorni precedenti ai 45 successivi all'istante di scansione;
  lo scheduler `publishReleaseConversationPosts` gira ogni 6 ore e lavora a
  batch di 20 per tenere costi e fan-out controllabili;
- ID deterministico `official_uscita-{eventId}`: una correzione aggiorna lo
  stesso post e conserva commenti, like e `createdAt`;
- il post usa `visibility: public` e le subcollection social standard;
- `notificationsEnabled: false`: la push resta quella `title_update`, con
  follow/mute e cap giornaliero. Non parte una seconda `official_update`;
- Home (`In uscita`), Community e scheda titolo possono puntare allo stesso
  `postId` esposto da `/prossime-uscite.json`.

Sicurezza/migrazione: nessuna nuova collection, rule o indice. I nuovi campi
`sourceEventId`, `sourceEffectiveAt` e `notificationsEnabled` vivono nel
registro server-only `officialUpdates` e nel metadata server-owned del post;
i client non possono falsificare `isOfficialUpdate`/`officialUpdate`. Nessun
backfill distruttivo: al primo run entrano al massimo 20 eventi eleggibili e i
run successivi completano la finestra. Rollback immediato con
`RELEASE_CONVERSATION_POSTS_ENABLED=false`; i post già creati restano normali
post pubblici e possono essere ritirati con `unpublishOfficialUpdate`.

Deploy iniziale verificato il 2026-08-16: Function scheduler e feed aggiornati,
38 candidati e 25 eleggibili pubblicati in due batch (20 + 5), senza errori.
Tutte le 10 card restituite dalla Home avevano il thread gia' presente prima
del deploy Hosting. Un terzo run di controllo ha riportato `selected: 0` e 25
skip idempotenti; lo scheduler e' `ENABLED`.

## Superficie SEO: /novita (2026-08-28)

Ogni aggiornamento pubblicato ha una pagina pubblica server-rendered
`/novita/{slug}` (`functions/modules/officialUpdatePage.js`): indicizzabile,
con canonical, JSON-LD `NewsArticle` e og tags. Esisteva da tempo, ma fino al
28/08 **nessuna era mai arrivata a Google**: URL Inspection rispondeva "URL is
unknown to Google" su tutte, 0 impression in 30 giorni. Tre cause, tutte
sistemate:

- **nessuna sitemap**: aggiunto `sitemapNovita` -> `/sitemap-novita.xml`
  (hub + fino a 1000 URL, `lastmod` da `publishedAt`) e la riga nell'index
  `public/sitemap.xml`;
- **pagine orfane**: l'unico link viveva in `community.html`, che e' `noindex`
  e monta i link in JavaScript. Ora la **scheda titolo** elenca gli ultimi
  aggiornamenti collegati (`fetchTitleUpdates` in `titlePage.js`) e c'e' un hub
  `/novita`. E' il percorso di crawl: le schede `/film|/serie` sono gia'
  indicizzate;
- **48 post su 80 rispondevano 404**: il gate accettava solo `somto_official`,
  quindi tutti i post firmati dalle pagine editoriali (`page_uscite`,
  `page_serie`, `page_crime`) non avevano pagina pubblica. Ora passa anche una
  pagina, ma **verificata con una lettura su `users` (`accountType: "page"`)**,
  non per prefisso nell'uid: un post che si dichiarasse firmato da
  `page_qualcosa` inesistente resta 404.

Indici richiesti (gia' in `firestore.indexes.json`): `officialUpdates` su
`status + publishedAt desc` (hub e sitemap) e `linkedTitleIds array-contains +
status + publishedAt desc` (scheda titolo). Appena deployati le pagine danno
500 finche' l'indice non finisce di costruirsi: e' normale, ~2 minuti.

**Resta manuale**: l'invio della sitemap in Search Console. L'ADC locale ha
scope `webmasters.readonly`, il PUT risponde 403 (vedi la ricetta in
`docs/RUNBOOK.md` / memoria SEO). Va fatto dalla UI, insieme a "Richiedi
indicizzazione" su hub e due o tre articoli.

## Pagine editoriali (2026-08-20)

Un post ufficiale puo' uscire da **Somto** o da una **pagina tematica**
(`users/page_*`, `accountType: "page"`, `isSynthetic: true`). La pagina e' un
normale doc utente: ha profilo, follower e post come chiunque altro, senza un
secondo modello sociale da mantenere.

- `publishOfficialUpdate` accetta `authorUid` (default `somto_official`).
  `resolvePublisher` rifiuta un uid che non sia una pagina registrata: senza
  quel controllo basterebbe passare l'uid di un utente vero per pubblicare a
  suo nome. La validazione avviene anche **sulle bozze**, cosi' un autore
  sbagliato non esplode quando scatta lo scheduler.
- Il fan-out somma **chi ha il titolo in libreria** e **i follower della
  pagina** (tetto 2000). Su un'audience di test i follower non si aggiungono:
  "manda solo a me" deve restare esattamente quello.
- `isSynthetic: true` tiene le pagine fuori da metriche prodotto, leaderboard
  e dalla notifica "nuovo iscritto" agli admin (guardie gia' esistenti in
  `modules/guidedProfiles/guards.js`).
- Creazione: `node functions/scripts/create-editorial-pages.js --write`
  (dry-run senza flag, idempotente). Il set iniziale sta nel file.
- Console: campo **Autore** in `/admin-official-updates.html`, popolato dalle
  pagine esistenti. Somto resta la prima opzione e il default.

### Chi firma le uscite automatiche

`pageForRelease` decide la pagina guardando **prima il tema, poi il formato**:

| condizione | pagina |
| --- | --- |
| animazione (`tmdb_16`) + lingua `ja` o paese `JP` | `page_anime` |
| genere crime (`tmdb_80`) | `page_crime` |
| serie | `page_serie` |
| film | `page_uscite` |

Il thriller (`tmdb_53`) **non** entra nel crime: sta su mezzo catalogo horror e
svuoterebbe le altre pagine. Se una pagina non esiste il post esce come Somto,
invece di far fallire il giro.

Distribuzione al 2026-08-20 sui 29 post gia' pubblicati, spostati una tantum con
`scripts/reassign-release-posts-to-pages.js`: 15 uscite, 10 serie, 4 crime, 0
anime. Lo script tocca solo `authorUid`/`authorName`: i `feedEvents` gia'
scritti conservano `actorUid: somto_official`, perche' rifarli consumerebbe i
tetti del pubblico per affinita' senza mostrare niente di nuovo.

**Dove si scoprono**: in coda a "Persone da seguire" su web e iOS, con badge
"Pagina" e la prima frase della bio al posto dei voti in comune (il ranking per
voti non vale per una pagina, che non vota). Chi non ha voti vede solo quelle:
per un utente nuovo e' l'unica cosa che si possa suggerire onestamente.

## Pubblico per affinita' di gusto (2026-08-20)

Il pubblico di un post e' sempre stato "chi ha il titolo in libreria o
watchlist". Per un'uscita nuova quella lista e' vuota per costruzione: il post
su Insidious aveva **1 destinatario**, mentre fra i 196 profili gusti c'e' chi
guarda horror e voleva saperlo.

- `tasteAudienceLimit` (0 = spento) aggiunge al fan-out chi ha affinita' con
  generi, cast e regista del primo titolo collegato. Acceso di default sui post
  automatici delle uscite, opzionale in console (spunta **Estendi per affinita'
  di gusto**).
- **Solo feed**: niente notifica e niente push. La campanella resta al pubblico
  per libreria, che e' un canale scarso (3 al giorno).
- Si sceglie per **classifica**, non per soglia: i punteggi assoluti dipendono
  da quanti generi ha un titolo, e una soglia fissa taglierebbe interi generi.
- **Tetto di 2 post per affinita' al giorno a persona.** Senza, i primi 25 di
  titoli diversi si sovrapponevano al 61%: chi ha visto molto ha affinita' alta
  su tutto. Normalizzare il punteggio per il peso del profilo e' stato provato e
  scartato — abbassa la sovrapposizione al 27% ma promuove i profili quasi
  vuoti, che "somigliano" a tutto.
- Esclusi: account cancellati e sintetici (pagine, profili guidati).
- Costo: una lettura per profilo gusti (196 su 387 iscritti), una volta per
  post. Oltre `MAX_TASTE_PROFILE_SCAN` serve un indice invertito genere→utenti.

### La provenienza (2026-08-26)

Il ranking per soli generi sbagliava bersaglio sulle uscite non anglosassoni.
Misurato su *Mousetrap - Identita' rubata* (serie coreana Netflix) con i 205
profili veri: chi aveva **118 titoli coreani visti e 367 in watchlist** finiva
al **#51**, e la motivazione era sempre "generi in linea" — cioe' Mistero,
Crime e Dramma, meta' catalogo. Sovrapposizione con chi guarda davvero
coreano: **1 su 15**.

Tre buchi in fila, uno dentro l'altro:

1. il paese esisteva solo in `meta.originCountry`, mentre
   `extractTitleFeatures` lo cercava in campi top-level mai popolati;
2. quindi il bucket `countries` era **vuoto su 205 profili su 205**;
3. e `scoreTasteBias` non lo leggeva comunque.

Non basta trattare il paese come gli altri bucket. L'affinita'
`sum/(weight+1.2)` e' una **media**: con `import_seen` normalizzato a 0.30
satura li' sopra sia per chi ha 118 titoli coreani sia per chi ne ha due.
Risponde a "quando ne vedi uno ti piace?", non a "quanto lo cerchi?" — e sposta
la classifica da 1/15 a 2/15, praticamente niente.

Quello che funziona e' lo **scostamento dalla media di popolazione**: la quota
di quel paese nel profilo diviso la quota che ha su tutti i profili, in log2.
Baseline reale: US 68,1%, JP 10,1%, GB 6,9%, IT 5,0%, KR 1,28%. Cosi' US e IT
restano vicini a zero per tutti (bonus massimo misurato 0,44, mediano 0,11,
**0 profili su 205 sopra 1,5x**) e la provenienza pesa solo quando e' rara —
che e' quando significa qualcosa. Il bonus e' smorzato dall'evidenza fino a
`PROVENANCE_MIN_TITLES` (8) titoli di quel paese: senza, in cima finisce chi ha
UN titolo coreano e una libreria da un titolo, la stessa trappola dei profili
quasi vuoti gia' scartata per il punteggio normalizzato.

Risultato sulla stessa misura: primi 20 da **1/15 a 9/15**, notifica da
**0/10 a 7/10** destinatari che guardano davvero coreano.

**Limite noto**: e' un segnale di quota, quindi non vede il caso "pochi titoli
ma centratissimi". Chi ha 14 coreani su 1912 non prende bonus nemmeno se fra
quei 14 c'e' *La casa di carta: Corea*, stesso regista dell'uscita. Quel caso
lo coprirebbe il bucket registi — vedi il debito sulla copertura cast/registi
in `docs/PENDING.md`.

Backfill dei profili esistenti:
`node functions/scripts/backfill-taste-countries.js --write` (dry-run senza
flag, `--reset` per svuotare). Ricalcola il bucket da zero e lo sostituisce,
quindi rilanciarlo non raddoppia niente. Non tocca `confidenceScore`:
`cumulativeWeight` esclude di proposito il bucket paesi.

## Come si pubblica (runbook admin)

1. Aprire `/admin-official-updates.html` da account admin.
2. Compilare: titolo, testo, tipo, almeno 1 titolo collegato.
3. **Anteprima** → controllare `recipientCount` (chi ha quel titolo in
   watchlist/visti riceve feed + notifica).
4. Per un test reale senza spam: mettere il proprio uid in "Audience di
   test" e pubblicare — il fan-out va solo a quegli uid.
5. **Pubblica**. Errori di battitura? Correggere e ripubblicare lo stesso
   slug (sovrascrive, non duplica). Ritiro completo: **Ritira** (o
   `unpublishOfficialUpdate` da CLI).

## Misurare un aggiornamento

`functions/scripts/report-official-updates.js` (sola lettura, `--slug` per
filtrare) riporta per ogni voce del registro: reach (`audienceCount`,
feedEvents e notifiche scritte), **notifiche lette** (proxy di "l'hanno
aperta"), like, commenti con testo e autore, condivisioni, link al post.

Le **impression sui post non esistono** come dato: Somto non traccia
visualizzazioni nel feed. Il blog è servito da pagine statiche che non
caricano Firebase Analytics → il traffico degli articoli si legge solo da
Search Console.

Like e commenti su un post ufficiale generano notifiche verso
`somto_official`, che non è un account reale: i trigger gen2
`notifyAdminsOnOfficialPostLike` / `notifyAdminsOnOfficialPostComment` le
girano agli uid in **`ADMIN_UIDS`** (in-app + push tramite
`pushOnNotificationCreate`), con id notifica deterministico. Volutamente
**non** si usa `users.isAdmin == true`: in prod include anche curatori.

## Serie editoriale (esempio d'uso reale)

`functions/scripts/schedule-editorial-film-series.js` programma i 3 post
"film per categoria" del 29-31 luglio 2026 (uno al giorno, 19:00 Roma).
Mostra il pattern consigliato per una serie:

- un post per giorno, creato come bozza con `scheduledAt`;
- i film taggati nel testo con `#[Nome](titleDocId)` → sul web diventano link
  alla scheda, su iOS il collage delle locandine (`MultiTitleCollageView`);
- l'immagine della card è la **copertina a strisce** generata da
  `scripts/gen-editorial-strips.js`: una striscia per film con backdrop TMDB
  (preferito quello senza testo impresso, `iso_639_1` null), logo ufficiale del
  titolo (`/movie/{id}/images` → `logos`, italiano se disponibile) ed
  etichetta. Formato **1080x1080** perché la card del feed è `aspect-ratio: 1/1`
  con `object-fit: cover`. Si carica su Storage (`editorial/{slug}.jpg`, JPEG
  ~250 KB: il PNG di resvg pesa 1,5 MB) e si passa come `mediaUrl` —
  `publishOfficialUpdate` accetta solo host Storage/somto.it. Senza `mediaUrl`
  la card ricade sul poster di `linkedTitleIds[0]`;
- su iOS la copertina **non** si vede finché i titoli taggati sono più di uno:
  `CommunityView` mostra il collage delle locandine e ignora il media del post.
  Da sistemare in una prossima build;
- URL dell'articolo blog nel testo (ora cliccabile nel feed) **e** in
  `sourceUrls` per il registro;
- lo script verifica che ogni `linkedTitleId` esista e sia `approved` prima
  di scrivere, e che il testo stia sotto i 1000 caratteri.

## Limiti noti / estensioni future (in ordine di valore)

1. **Immagine di copertina propria**: oggi la card usa il poster del primo
   titolo collegato. Per una grafica editoriale dedicata servirebbe un campo
   media sul post (`mediaUrl` è già letto dal feed web).
2. **Badge "Ufficiale" sul web feed** (iOS ce l'ha già).
3. **Segmentazione** oltre "interessati al titolo" (es. tutti gli utenti
   attivi): oggi c'è solo `audienceUids` esplicita o interesse per titolo.
4. **Modifica post-pubblicazione**: oggi = ripubblicare lo stesso slug.
5. **URL cliccabili su iOS**: nel feed iOS il testo del post è plain
   (`Text`), quindi l'URL dell'articolo non è tappabile — i titoli taggati
   sì. Da sistemare in una prossima build iOS.
