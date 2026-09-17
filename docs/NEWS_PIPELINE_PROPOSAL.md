# Pipeline News titoli: sicurezza, migrazione e rollout

Stato: **implementata e distribuita in produzione**.

## Obiettivo

- Timeline persistente per ogni titolo, in italiano e inglese.
- Trailer/teaser ufficiali, date di uscita e nuovi episodi acquisiti
  automaticamente da TMDB e dalle relative fonti YouTube ufficiali.
- Post editoriali Somto collegabili a uno o più titoli.
- Notifica agli utenti che seguono il titolo o ne hanno iniziato/completato la
  visione, rispettando preferenza per titolo e opt-out globale.
- Affinità alle piattaforme ricavata in modo prudente dai titoli già guardati:
  è un segnale di ranking, non una dichiarazione di abbonamento.

## Architettura implementata

1. `scanTitleUpdates` gira ogni 15 minuti, a batch di 12 titoli e con cursore
   server-owned. Legge TMDB in IT/EN/fallback, aggiorna anche i provider IT e
   crea eventi deterministici/idempotenti. La function accetta una sola
   esecuzione alla volta per evitare corse sul cursore e richieste duplicate.
2. Solo trailer/teaser marcati `official` e dati strutturati affidabili possono
   essere pubblicati automaticamente. Le fonti non verificate restano draft.
3. `notifyOnTitleUpdatePublished` esegue un fan-out idempotente. Il primo giro
   completo del catalogo usa sempre `acquisitionMode=backfill` e forza
   `notificationEligible=false`; solo gli eventi live successivi possono
   generare notifiche.
4. Web e iOS uniscono eventi persistiti, post ufficiali collegati e fallback
   TMDB. Il fallback evita una scheda vuota durante la migrazione.
5. Il ranking usa `watchProviderNames` soltanto con almeno due titoli distinti
   di evidenza. La UI dice esplicitamente che l'inferenza non prova un
   abbonamento.

## Proposta di sicurezza approvata e applicata

Le modifiche dati sono additive:

- `titleUpdateEvents/{eventId}`: lettura pubblica solo per `status=published`;
  scrittura esclusivamente Admin SDK/backend.
- `users/{uid}/titleUpdatePreferences/{titleId}` e
  `users/{uid}/_system/notificationPrefs`: lettura/scrittura solo owner, campi
  con allow-list nelle rules.
- `systemJobs/titleUpdateScanner`: stato cursore e metriche solo backend;
  nessuna regola client lo rende leggibile o scrivibile.
- `titles.watchProviderNames/watchProviderLogos` e `titleProviders/{titleId}`:
  scritti dal backend da risposta TMDB normalizzata; nessun permesso client
  aggiuntivo.

Gli URL persistiti accettano solo HTTPS e host YouTube/TMDB consentiti. Il
frontend non decide privacy, ownership, eligibility o destinatari.

## Migrazione e backfill

1. Deploy di rules e index.
2. Deploy di function/hosting con entrambi i kill switch spenti.
3. Attivazione dello scanner in produzione e controllo del primo batch: errori,
   lingue, date e fonti.
4. Il cursore completa automaticamente il primo giro del catalogo con una
   finestra di 180 giorni passati/365 futuri, `acquisitionMode=backfill` e
   `notificationEligible=false`, quindi senza notifiche retroattive. Nello
   stesso passaggio popola progressivamente anche i provider.
5. Dal giro seguente lo scanner passa automaticamente alla finestra live
   (72 ore passate/60 giorni futuri); il fan-out resta protetto dal proprio
   kill switch e dai controlli di idempotenza, interesse e cap giornaliero.

In produzione (`gia-visto`) scanner e fan-out sono attivi per default anche se
un deploy futuro non porta con sé i file `.env` locali. Impostare esplicitamente
il relativo flag a `false` conserva il rollback immediato; staging e ambiente
locale restano spenti per default.

Rollback: spegnere i due flag. Gli eventi sono idempotenti e un evento `retired`
non viene ripubblicato dallo scanner.

## Limiti dichiarati

TMDB/YouTube coprono trailer, teaser, uscite e prossimi episodi, non ogni press
release di Netflix, Apple, Disney, Prime Video, ecc. L'estensione corretta è un
adapter per feed/API ufficiale per piattaforma che produca lo stesso modello di
candidato, con allow-list della fonte e deduplica; scraping generico e rumor non
devono essere auto-pubblicati.

## Estensione 2026-08-16 — evento come conversazione

`titleUpdateEvents` resta la fonte del fatto; per uscite italiane confermate e
premiere guardabili lo scheduler crea un solo `officialUpdate`/`post` con ID
derivato dall'evento. Home e Community non duplicano il contenuto: mostrano lo
stesso post e le stesse subcollection di commenti/like. Il fan-out feed resta
quello dei post ufficiali, mentre la notifica usa esclusivamente la pipeline
`title_update` già protetta da preferenze e cap.

La modifica è additiva e server-authoritative, non espone stati personali nel
feed pubblico e non richiede migrazioni, rules o indici nuovi. Il kill switch
dedicato consente rollback senza cancellazioni.
