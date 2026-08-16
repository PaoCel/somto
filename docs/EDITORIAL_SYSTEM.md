# Sistema editoriale (aggiornamenti ufficiali)

Ultimo aggiornamento: 2026-08-16.

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

## Stato operativo

- **Primo uso reale**: serie editoriale "film per categoria", 3 post
  programmati per il 29-31 luglio 2026 (vedi sotto). Prima di allora la
  collection `officialUpdates` era vuota e il fan-out non era mai stato
  eseguito — motivo per cui l'indice mancante è emerso solo ora.
- **Tutto deployato in prod il 2026-07-12** (rules + functions + hosting SW v109): il flusso completo compose→anteprima→bozza→pubblica→ritira è operativo dalla console.

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
