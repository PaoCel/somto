# Voti personaggi ("Chi ti ha conquistato?") — Spec

Stato: **backend, UI iOS e UI web live dal 2026-07-25**; il flusso post-episodio centralizzato è stato completato il 2026-07-27.
Data: 2026-07-24; aggiornamento 2026-07-27.

Cosa esiste in codice (main): `functions/lib/characterVoteAggregate.js` (35 unit
test), i trigger `recomputeCharacterVoteAggregates` + `recomputeTitleCharacterAggregate`
in `functions/index.js`, le action `tmdbProxy` `seasoncredits`/`episodecredits`, e i
blocchi rules `characterVotes` / aggregati / `characterPicks` (test in
emulatore), picker iOS/web e risultati community. Il deploy produzione è stato
completato e verificato il 2026-07-25.

Feature per i rifugiati TV Time: scegliere i personaggi preferiti di un episodio /
film / serie. **Nessun voto numerico a persone reali** — solo pick positivi.

---

## 1. Perché così (ricerca, non ipotesi)

TV Time (chiuso il 2026-07-15) chiedeva, dopo aver segnato un episodio come visto,
tre cose separate: reazione all'episodio, **"favorite character"**, device usato.
Idem sui film. Mai un voto numerico agli attori. Fonti: Wikipedia "TV Time",
TechCrunch 2018-07-31. 130M voti-personaggio da 12M utenti (studio TV Time 2015-2017).

Prova nello schema reale del loro export GDPR
(`~/Desktop/tvtime-gdpr-test/show_character_episode_vote.csv`, 102 righe utente test):

```
user_id,episode_season_number,episode_id,show_character_id,created_at,updated_at,fb_action_id,tv_show_name,episode_number
14460101,3,198933,64077502,2025-01-07 12:54:38,2025-01-07 12:54:38,,McLeod's Daughters,29
```

Una riga per (utente, episodio) → **1 solo pick**, chiave = `show_character_id`
(il personaggio, non l'attore). Esisteva un badge "Serial actor voter" (3/5/10/15
episodi consecutivi votati).

Nessun concorrente lo ha: Trakt lo rifiuta da anni (richiesta aperta sul forum),
Simkl/Serializd/Letterboxd nulla, MyDramaList solo un sotto-voto "Acting/Cast"
collettivo, IMDb solo poll manuali. **Campo libero.**

### Divergenze volute da TV Time
- **Fino a 3 pick** per episodio (non 1): episodi corali.
- **Reazione opzionale** agganciata al pick (riusa le chiavi emozione esistenti).
- **Pick diretto a livello serie**, oltre a quello derivato dagli episodi.

### Vincolo di sicurezza (non negoziabile)
Solo pick **positivi**. Niente downvote, niente voto numerico, niente ranking
"peggior personaggio". Si vota un personaggio, mai la persona reale.

---

## 2. Modello dati

### 2.1 Voto — `characterVotes/{voteId}` (collection flat)

ID composito vincolato (come `titleEmotions`, non come `ratings` che l'id non lo
verifica): `{uid}__{titleId}__{level}__{season|0}__{episode|0}`, stessa
sanitizzazione char-per-char di `makeRatingId`.

**1 doc per (utente, oggetto votato)**, non per personaggio → la cardinalità è
1 doc/utente/episodio visto, stesso ordine dei voti episodio.

```jsonc
{
  "uid": "abc",
  "titleId": "the-last-of-us",
  "level": "episode",        // "title" | "episode"  (season predisposto, non usato in v1)
  "season": 1,               // 0 per level=title
  "episode": 5,              // 0 per level=title
  "picks": [                 // 1..3, personId unici
    { "personId": "1253360", "character": "Joel Miller", "reaction": "touched" }
  ],
  "source": "post_seen",     // opzionale: post_seen | title_page | import
  "createdAt": ts, "updatedAt": ts
}
```

- `personId` = **TMDB person id come stringa**, coerente con
  `titles.castWithCharacters[].personId`.
- `character` = snapshot del nome personaggio al momento del voto (resilienza:
  il cast del titolo può essere riscritto da `enrichTitleAssets`).
- `reaction` = opzionale, whitelist = le 12 `EMOTION_KEYS` esistenti
  (`functions/lib/emotionAggregate.js`). Nessuna chiave nuova.
- Deselezione totale = **delete** del doc (i client fanno get-prima-di-delete).
- `isSynthetic` solo admin SDK, escluso da tutti gli aggregati.

### 2.2 Aggregato episodio (volume) — `titles/{titleId}/characterVotes/{s}_{e}`

```jsonc
{ "counts": { "1253360": 42 }, "totalPicks": 97, "totalUsers": 51, "updatedAt": ts }
```

Percentuale mostrata = `counts[p] / totalUsers` (share di chi ha votato). Con max
3 pick la somma può superare il 100%: è corretto e va detto in UI.

### 2.3 Aggregato serie/stagione (utenti unici) — `titles/{titleId}/aggregates/characters`

```jsonc
{
  "series":   { "counts": { "1253360": 128 }, "totalUsers": 210 },
  "bySeason": { "1": { "counts": {...}, "totalUsers": 180 } },
  "direct":   { "counts": {...}, "totalUsers": 34 },   // pick diretti level=title
  "updatedAt": ts
}
```

**Qui si contano UTENTI UNICI, non voti.** Chi guarda 73 episodi e sceglie sempre
Joel conta 1, non 73. Il delta arriva dal rollup personale (§2.4) solo quando un
personaggio **entra o esce** dal set dell'utente per quel titolo/stagione.

Doc unico per titolo: ~20 personaggi × (1 serie + N stagioni). Anche una serie da
30 stagioni resta ben sotto 1MB. Cap difensivo: massimo 40 personId per bucket,
potatura dei minori come già si fa per `tasteProfile`.

### 2.4 Rollup personale — `users/{uid}/characterPicks/{titleId}`

Owner-read, **server-write only** (identico a `derivedRatings`).

```jsonc
{
  "series":   { "1253360": 12 },              // quante volte l'ho scelto
  "bySeason": { "1": { "1253360": 9 } },
  "top":      { "personId": "1253360", "character": "Joel Miller", "count": 12 },
  "episodes": 14,                              // episodi in cui ho votato
  "streak":   { "current": 5, "best": 11 },   // episodi consecutivi votati (badge)
  "updatedAt": ts
}
```

Serve a: "il tuo personaggio della stagione/serie", profilo, wrapped, badge stile
"Serial voter", e a emettere i delta unique-user di §2.3.

---

## 3. Pipeline server

Due hop, entrambi O(1), specchio esatto dei trigger già in produzione
(`recomputeTitleEmotionAggregate` / `recomputeUserDerivedRating`):

1. `onWriteCharacterVote` (`characterVotes/{voteId}`)
   - guard sintetici + no-op guard su `picks` invariati;
   - delta su **aggregato episodio** (§2.2) in transazione;
   - delta sul **rollup personale** (§2.4) in transazione, che calcola
     `enteredSet` / `leftSet` per (serie, stagione).
2. `onWriteCharacterPicks` (`users/{uid}/characterPicks/{titleId}`)
   - traduce `enteredSet`/`leftSet` in delta unique-user su §2.3.

Logica pura estratta in `functions/lib/characterVoteAggregate.js` (come
`emotionAggregate.js` / `derivedRatingAggregate.js`) → unit-testabile senza emulatore.

Reconcile/baseline: `scripts/backfill-characterVotes.cjs`, esclude i sintetici.

---

## 4. Rules

```
match /characterVotes/{voteId} {
  allow read: if isSignedIn();
  allow create: if isSignedIn()
    && request.resource.data.uid == uid()
    && voteId == uid() + "__" + safe(titleId) + "__" + level + "__" + season + "__" + episode
    && data.keys().hasOnly([uid,titleId,level,season,episode,picks,source,createdAt,updatedAt])
    && level in ["title","episode"]
    && picks is list && picks.size() >= 1 && picks.size() <= 3
    && personIds distinti (toSet().size() == picks.size())
    && ogni pick: keys hasOnly([personId,character,reaction]), personId string non vuota
       <= 32 char, character string <= 120, reaction in EMOTION_KEYS
    && !('isSynthetic' in data);
  allow update: if ... (uid/titleId/level/season/episode immutabili);
  allow delete: if isOwner();
}
match /titles/{titleId}/characterVotes/{bucketId}   { allow read: if isSignedIn(); allow write: if false; }
match /titles/{titleId}/aggregates/{docId}          { allow read: if isSignedIn(); allow write: if false; }
match /users/{uid}/characterPicks/{titleId}         { allow read: if isOwner(uid); allow write: if false; }
```

Validazione del contenuto degli oggetti dentro `picks`: Firestore rules non hanno
loop, quindi si valida con `picks.size()` fisso + accesso indicizzato condizionale
(pattern già usato altrove) oppure si accetta il compromesso di validare solo
tipo/size e lasciare la normalizzazione al trigger. **Da decidere in implementazione,
con test nell'emulatore prima del deploy** (regola di progetto: le rules si testano,
non si deducono).

---

## 5. Anti-spoiler (obbligatorio)

I pick per episodio **sono uno spoiler**: rivelano chi è vivo/presente, e una guest
star nei risultati dell'episodio 5 brucia la sorpresa. TV Time gatava i contenuti
episodio dietro "l'ho visto".

Regola: i risultati community di un episodio si mostrano **solo a chi ha quell'episodio
già visto**; altrimenti stato coperto ("Risultati visibili dopo la visione"), non blur
con bypass. Il gate va lato client su entrambe le piattaforme (i dati restano leggibili
da signed-in, come `ratings`) — è protezione UX, non sicurezza.

Il picker mostra il cast principale + guest star di **quell'episodio**: già di per sé
va mostrato solo dopo la visione.

---

## 6. Cast per episodio (TMDB)

Oggi in DB c'è solo `titles.castWithCharacters` (top 20 del titolo). Servono 2 nuove
action in `tmdbProxy` (`functions/index.js`), stesso pattern di `seasonepisodes` con
cache in `tmdbCache`:

| action | endpoint TMDB | serve a |
|---|---|---|
| `seasoncredits` | `/tv/{id}/season/{n}/aggregate_credits` | cast ricorrente della stagione, con ruoli |
| `episodecredits` | `/tv/{id}/season/{n}/episode/{e}/credits` | cast + **guest_stars** dell'episodio |

Payload sfrondato a `{personId, name, character, profilePath, order}` — identico alla
forma di `castWithCharacters`, così il picker ha un solo modello.

Fallback quando TMDB non ha i credits dell'episodio (succede, specie su anime e serie
vecchie): si usa `castWithCharacters` del titolo. Mai schermata vuota.

---

## 7. UX

### Vincolo di ingombro (feedback utente sul mockup, 2026-07-24)
Il picker deve essere **compatto**, non una schermata a sé. Il flusso post-visione è
già lungo (voto → emozioni → quiz): un passo grosso in più fa smettere di segnare gli
episodi. Quindi:
- **una riga orizzontale di volti** scrollabile (~90pt), non una griglia a tutta pagina;
- **nessuno step dedicato**: la riga vive dentro lo step emozioni già esistente;
- la **reazione opzionale non è un passo**: si apre inline al secondo tap sul volto già
  scelto;
- sulla scheda titolo: top 3 + "vedi tutti", non la classifica completa aperta.

### iOS
- **Episodio**: riga personaggi dentro il flusso post-visione già esistente
  (`EpisodeSeenSheet`), cap 3, modellata su `EmotionGridPicker` + `CachedAsyncImage`.
  Secondo tap sul volto scelto → reazione opzionale inline.
- **Film**: stesso step dentro `RatingPostComposerSheet` (level `title`).
- **Serie**: sezione "Personaggi preferiti" nella scheda titolo con classifica community
  (barre %) + "il tuo preferito" dal rollup personale + pick diretto se non hai votato
  episodi.
- Il `TitlePersonCard` esistente è `private` dentro `TitleDetailView.swift` (8954 righe):
  va estratto nel Design System prima di riusarlo.

### Web
Il cast oggi è **una riga di testo** in `#tFacts` — non esiste alcun componente cast.
Va costruito da zero: griglia volti + picker + sezione risultati. È il pezzo di UI più
grosso dell'intera feature.

### Copy (bozza)
- Prompt: "Chi ti ha conquistato in questo episodio?" — "Scegline fino a 3"
- Risultati: "Il preferito della community" / "Il tuo personaggio della serie"
- Vuoto: "Nessuno ha ancora votato. Apri le danze."

---

## 8. Import TV Time

`show_character_episode_vote.csv` è nell'export ma **`show_character_id` è un id interno
TV Time** e il servizio è morto → non risolvibile in un `personId` TMDB. Quindi:

- v1: **non importiamo identità**. Al massimo una statistica ("102 voti personaggio su
  TV Time") o niente.
- Da verificare (non bloccante): se `show_character_id` combacia con un id personaggio
  TheTVDB, il mapping personaggio → attore → TMDB diventa possibile. Se sì, è un
  differenziatore enorme perché nessun altro può più farlo.

---

## 9. Fasi

- **F1 — backend** (nessuna UI): modello + `characterVoteAggregate.js` + 2 trigger +
  rules + unit test + rules test in emulatore + le 2 action `tmdbProxy`. Deployabile a
  vuoto senza effetti visibili.
- **F2a — iOS**: picker post-visione + sezione scheda titolo. Estrazione `TitlePersonCard`.
- **F2b — web**: componente cast + picker + risultati (parità).
- **F3 — payoff**: pagina personaggio/attore pubblica indicizzabile (SEO: oggi non
  esiste né su Somto né sui concorrenti), badge "Serial voter" su infra XP/streak
  esistente, classifiche editoriali.

## 9-bis. Scelta conservativa sul gate anti-spoiler (da rivedere)

L'implementazione iOS v1 nasconde **l'intera sezione risultati** finché il titolo non
è completato (film visto / serie finita), e sotto soglia non fa nemmeno la fetch: sul
device non arriva alcun dato. Motivo: l'aggregato `series` somma tutti gli episodi di
tutte le stagioni, quindi mostrarlo a chi è alla stagione 1 rivelerebbe personaggi che
compaiono dopo.

Costo: chi segue una serie in corso non vede mai i risultati, cioè proprio il payoff
sociale della feature. **Follow-up naturale**: sbloccare per stagione usando `bySeason`
(che esiste già) — mostri la stagione 1 a chi ha finito la stagione 1. Da fare quando
ci sono abbastanza voti da rendere la sezione interessante.

## 10. Rischi aperti

1. **Contention** sul doc `titles/{id}/aggregates/characters` di un titolo molto caldo:
   a scala Somto (~250 utenti) è irrilevante, ma va sharded se il volume cresce.
2. **Costi Firestore**: 1 write voto → 3 write aggregati. Precedente da tenere a mente:
   l'ondata import ha portato le read da 30k a 7.5M/giorno. Da monitorare dopo il rilascio.
3. **Cast mancante o sbagliato** su titoli mergiati manualmente (`syncDisabled`) e stub
   `tmdb_*`: il picker deve degradare, mai bloccare.
4. **Validazione `picks` nelle rules** senza loop (§4) — verificare in emulatore.
5. **Nomi personaggio localizzati** (TMDB restituisce IT o EN a seconda della lingua):
   lo snapshot in `character` evita incoerenze retroattive ma può divergere dal cast live.
