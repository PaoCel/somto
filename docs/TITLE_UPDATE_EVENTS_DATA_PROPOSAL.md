# Proposta dati: eventi di aggiornamento titolo

Stato: **approvata e implementata su branch; non deployata**
Owner backend: Codex
Consumer UI: Claude
Ambiente iniziale: emulatori, poi `somto-staging`

## Verdict

**PASS WITH CONCERNS** — il modello è additivo e non contiene dati personali.
Rules, indice e writer sono implementati e verificati in emulatore; nessuna
parte è stata deployata o attivata in produzione.

## Findings

- La tab attuale interroga TMDB al momento dell'apertura e non possiede uno
  storico affidabile né uno stato di errore persistibile.
- `officialUpdates` è un registro editoriale riservato agli admin e pubblica
  post/feed; non è adatto come timeline granulare di ogni titolo.
- Gli stati personali (`users/{uid}/titleStates`) sono privati e non devono
  essere copiati negli eventi pubblici.
- Le risposte video TMDB possono differire tra `it-IT`, `en-US` e richiesta
  globale. Per i film, `details.release_date` da solo non prova una data IT.

## Collection proposta

`titleUpdateEvents/{eventId}`

ID deterministico per impedire duplicati:

- video: `tmdb_video_{movie|tv}_{tmdbId}_{youtubeKey}`;
- uscita film: `tmdb_release_movie_{tmdbId}`;
- episodio: `tmdb_release_tv_{tmdbId}_s{season}_e{episode}`;
- fonti future: `{source}_{sourceContentId}` dopo sanitizzazione/hash.

Contratto v1:

```js
{
  schemaVersion: 1,
  titleId: "ted-lasso",
  tmdbId: 97546,
  mediaType: "tv",             // movie | tv
  eventType: "trailer",        // allowlist v1
  status: "published",         // draft | published | retired

  source: "tmdb",
  sourceId: "youtube-key",
  sourceUrl: "https://www.youtube.com/watch?v=...",
  sourceTrust: "official",      // official | structured | unverified
  official: true,
  confidence: 1,

  headlineByLocale: {
    "it-IT": "Trailer ufficiale",
    "en-US": "Official Trailer"
  },
  entityNameByLocale: {},       // nome episodio/annuncio, opzionale
  availableLocales: ["it-IT", "en-US"], // oppure "und" se TMDB non dichiara la lingua

  sourcePublishedAt: Timestamp, // video/comunicato, opzionale
  effectiveAt: Timestamp,       // uscita/episodio, opzionale
  region: "IT",                // obbligatoria per date regionali auto-published
  season: 4,                    // solo TV, opzionale
  episode: 1,                   // solo episodio

  acquisitionMode: "live",     // live | backfill | manual
  notificationEligible: true,   // sempre false per backfill
  reviewReason: null,
  discoveredAt: Timestamp,
  firstPublishedAt: Timestamp,
  updatedAt: Timestamp
}
```

Allowlist v1: `trailer`, `teaser`, `release_date`, `new_episode`. Gli eventi
`new_season`, `renewal`, `cancellation`, `sequel` e `casting` entrano solo con
un adapter ufficiale successivo, perché TMDB da solo non è una prova sufficiente.

### Regole di localizzazione

- Salvare soltanto testi realmente ricevuti o copy di sistema controllato; non
  etichettare come inglese una stringa italiana.
- Se manca la lingua richiesta, consumer e notifiche usano la catena
  `lingua utente -> en-US -> it-IT -> prima disponibile`.
- La risposta globale usa `iso_639_1`; una lingua assente/sconosciuta è `und`,
  mai etichettata artificialmente come inglese.
- Uno stesso YouTube ID in più risposte è un evento solo con più label; video
  diversi per mercato restano eventi distinti.
- Il testo editoriale libero futuro usa `bodyByLocale`; non è richiesto in v1.

### Regole di pubblicazione automatica

- Trailer/teaser: automatico solo se `site == YouTube` e TMDB riporta
  `official == true`; altrimenti `draft`.
- Episodio futuro: automatico solo con coordinate e `air_date` valide.
- Film: automatico solo con una voce `release_dates` per regione `IT` e tipo
  noto; `details.release_date` senza conferma regionale resta `draft` con
  `reviewReason: missing_it_release_date`.
- URL ammessi v1: `youtube.com`, `youtu.be`, `themoviedb.org`. Il writer server
  deve rifiutare host, protocolli e campi oltre i limiti previsti.
- Un cambio data aggiorna lo stesso documento deterministico; non crea una
  seconda notizia. Il writer conserva audit minimo della prima pubblicazione.

## Rules implementate sulla branch

```text
match /titleUpdateEvents/{eventId} {
  allow get, list: if resource.data.status == "published" || isAdmin();
  allow create, update, delete: if false;
}
```

La query client deve includere `status == published`: le rules non filtrano i
risultati. La console editoriale non leggerà bozze con una query pubblica:
userà una callable admin oppure una regola separata `isAdmin()` dopo test rules.
Tutte le scritture passano da Admin SDK e validazione server-authoritative.

Non inserire negli eventi UID, destinatari, stato di visione, preferenze push,
token o inferenze di abbonamento. Il fan-out legge gli stati privati lato server
e scrive solo in `users/{uid}/notifications/title_update_{eventId}`. Il backfill
non entra mai nel fan-out; ogni utente ha un cap di tre notifiche titolo al
giorno.

Le preferenze per titolo vivono separatamente in
`users/{uid}/titleUpdatePrefs/{titleId}` con il solo contratto
`{ titleId, mode: follow|important|muted, updatedAt }`: sono owner-only, non
pubbliche e interrogate soltanto dal fan-out server. `follow` include ogni
evento, `important` esclude i singoli nuovi episodi, `muted` prevale su stato di
visione e watchlist. Il tipo globale `title_update` in `notificationPrefs`
prevale sempre sulla preferenza del singolo titolo.

## Query e indice implementati sulla branch

Timeline titolo pubblica:

```text
where titleId == X
where status == published
orderBy sortAt desc
limit 20
```

Indice composito:

```text
titleUpdateEvents: titleId ASC, status ASC, sortAt DESC
```

`sortAt` viene materializzato dal writer come `sourcePublishedAt`, altrimenti
`effectiveAt`, altrimenti `discoveredAt`. Un eventuale feed globale richiederà
un secondo indice `status ASC, sortAt DESC`, ma non va creato finché non esiste
un consumer reale.

## Migrazione e backfill

1. Aggiungere modulo writer e test unitari senza export di Function.
2. Aggiungere rules/index proposti e testarli negli emulatori.
3. Creare collection solo in staging tramite scanner manuale con massimo 20
   titoli e `acquisitionMode: backfill`.
4. Verificare duplicati, lingue, URL, date IT e costi.
5. Backfill 90-180 giorni per blocchi; sempre
   `notificationEligible: false` e nessun fan-out.
6. Attivare lettura UI dietro feature flag.
7. Solo dopo QA, valutare writer/scheduler live con kill switch disabilitato di
   default.

Non è necessaria una migrazione dei documenti `titles`, `officialUpdates` o
`titleStates`. La nuova collection è additiva.

## Retention e rollback

- Eventi pubblicati: mantenuti finché servono alla timeline; rivalutare dopo 24
  mesi con metriche reali.
- Bozze non revisionate: `expiresAt` a 90 giorni, eliminazione server-side solo
  dopo report.
- Report scanner: 30 giorni quando verranno persistiti; oggi restano stdout.
- Rollback: disabilitare feature flag/scheduler, mantenere i documenti per audit
  e rimuovere le rules di lettura soltanto dopo che i client non interrogano più
  la collection. Nessuna cancellazione massiva come primo rollback.

## Required changes prima dell'attivazione

- Deployare rules e indice prima di qualunque consumer reale.
- Eseguire il backfill staging a blocchi, verificando il report prima di ogni
  `--apply`.
- Validare il fan-out con account QA e kill switch spento di default.
- Allineare preferenze e rendering `title_update` su web/iOS prima di attivare
  `TITLE_UPDATE_NOTIFICATIONS_ENABLED=true`.

## Risks

- TMDB può marcare erroneamente un video come ufficiale: mantenere allowlist
  YouTube e possibilità di retire immediato.
- Date film globali possono essere scambiate per italiane: il guardrail regione
  `IT` è obbligatorio per l'auto-publish.
- Query senza filtro `status` falliscono per rules; web e iOS devono condividere
  lo stesso contratto.
- Un backfill collegato per errore al fan-out produrrebbe spam: il trigger futuro
  deve richiedere sia `acquisitionMode == live` sia transizione a `published`.
- Costi crescono linearmente con titoli × richieste lingua; usare TMDB Changes e
  limiti per run prima dello scheduler.

## Suggested implementation steps

1. Congelare questo contratto con Claude.
2. Eseguire lo scanner read-only su fixture e poi su 5 titoli staging.
3. Implementare writer/emulator tests in una PR separata.
4. Far consumare a web/iOS una fixture o staging, non dati prod.
5. Approvare backfill e infine scheduler come passaggi distinti.

## Tests needed

- Unit: dedup locale, ID stabile, date spostate, regione IT, URL/type allowlist,
  payload corrotti e risposte parziali.
- CLI: fixture senza credenziali, cap API, output senza scritture.
- Rules: matrice anon/utente/admin/server per draft/published/retired.
- Emulator integration: rerun idempotente e backfill senza notifiche.
- Staging smoke: trailer IT, trailer solo EN, film con/senza data IT, serie con
  prossimo episodio e titolo episodio localizzato diversamente.
