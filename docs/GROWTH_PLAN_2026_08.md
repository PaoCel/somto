# Piano crescita — agosto 2026

Misure prese il 2026-08-24/25 su prod (`gia-visto`). Ogni numero qui dentro è
verificato, non stimato: se lo rileggi fra un mese, confronta con la stessa
fonte (`productMetrics`, Search Console, `users`, `notifications`).

## Verdict

**Il problema non è l'acquisizione: è che il secchio perde.** Luglio 2026 non è
stato un canale, è stato un evento — la chiusura di TV Time ha portato 274
iscritti in un mese, di cui **75 sono ancora attivi a 30 giorni (27%)**. Finito
l'evento, l'acquisizione è tornata a ~1 iscritto al giorno e il WAU si è
**dimezzato in quattro settimane (82 → 37)**. Aprire rubinetti nuovi adesso
moltiplica lo spreco. L'ordine è: prima capire dove si perde la gente, poi darle
un motivo per tornare, poi attirarne di nuova.

## Findings

### Utenti e attività (2026-08-24)

| | |
|---|---|
| utenti reali | 350 (41 account cancellati, 4 sintetici) |
| attivi nelle 24h | 13 |
| attivi negli ultimi 7 giorni | 40 |
| attivi negli ultimi 30 giorni | 113 |
| WAU 26/07 → 24/08 | **82 → 37** |
| DAU 26/07 → 24/08 | ~17-22 → 9-13 |
| iscritti luglio 2026 | 274 (75 ancora attivi) |
| iscritti agosto 2026 | 30 (~1 al giorno) |
| con almeno un titolo visto | 199 su 350 |
| con almeno un voto | 72 su 350 |
| con almeno un import | 108 su 350 |
| attivati entro 48h (coorti agosto) | quasi sempre 0-2 su coorti da 1-3 |

### Acquisizione organica: praticamente zero

Search Console, 27/05 → 24/08 (90 giorni): **53 click, 1.177 impression** in
tutto. Ad agosto: **70 impression e 7 click** — due impression al giorno.

- unica query che porta click: `somto` (5 click, posizione 6,8);
- tutto il resto sta fra la posizione 60 e la 95, con 1-2 impression;
- le pagine che ricevono click sono home, `terms`, `support`, `privacy`: cioè
  chi cerca il marchio, non chi cerca film e serie;
- le sitemap **vengono scaricate** (titoli e quiz il 24/08, zero errori): il
  problema non è più l'annidamento del giugno scorso, è che il dominio non ha
  autorità e le pagine non hanno niente di unico da mostrare;
- in sitemap ci sono **2.318 pagine titolo su 21.115 titoli** in catalogo.

### Inventario di contenuto: c'è, ma non lo vede nessuno

- 21.115 titoli, 10.525 domande quiz su **242 titoli a tema** (I Cesaroni 121,
  Dragon Ball Z 100, Lucifer 75, Suits 75);
- 908 documenti di emozioni sui titoli, 783 eventi titolo notificabili;
- 62 aggiornamenti editoriali pubblicati (59 solo ad agosto), che però
  raggiungono **una mediana di 2 persone** e in 16 casi su 62 **zero**.

### Canali di ritorno: scarsi e, fino a ieri, sprecati

- push raggiungibili: **45 su 355 (12,7%)**, in calo di 4 in una settimana,
  tutti iOS tranne uno;
- tasso di lettura per tipo: `thread_message` 36,7%, `official_update` 5,1%,
  `engagement_watchlist_reminder` 2,1%, `engagement_nudge` **0,5%**;
- gli 11.116 nudge erano un bug, non una scelta (vedi `docs/PENDING.md`):
  i cooldown non hanno mai funzionato. Sistemato il 2026-08-24, primo run reale
  `sent=1 skippedExhausted=217`;
- quiz: **143 tentativi in tutto**, 18 sfide, 8 inviti. Il "magnete di
  acquisizione" oggi non gira.

### Il buco nella misurazione

`productMetrics` registra `onboarding_started` e `onboarding_completed` a **zero
quasi ogni giorno**, anche nei giorni con 5-6 iscritti. O la telemetria non
parte, o l'onboarding non parte: in entrambi i casi oggi **non sappiamo dove si
perde un nuovo utente**. Questo va risolto prima di spendere lavoro sul resto.

## Piano

### Fase 0 — Vedere ✅ fatta il 2026-08-25

| | |
|---|---|
| Obiettivo | sapere dove muore un nuovo iscritto |
| Misura | funnel completo per coorte giornaliera |

**Causa dello zero**: la callable `logProductEvent` era chiamata **solo dalla
PWA**. iOS logga su Firebase Analytics e basta, e la base utenti è iOS per
268 account su 281 con piattaforma nota. Il funnel non era rotto: era cieco
sul 95% degli utenti.

**Cosa è cambiato**: il ritorno per coorte adesso si **deriva dai dati**
(`createdAt` e `lastActiveAt`) dentro `computeProductMetricsSnapshot`, quindi
vale per tutti i client e vale anche all'indietro — non dipende più da un
evento che il client può non mandare. In dashboard admin ci sono tre riquadri
nuovi (ritorno a 1, 7, 30 giorni). In parallelo iOS ora inoltra gli eventi di
funnel alla callable (ponte in `FirebaseAnalyticsLogger`, esce con la prossima
build) e ogni account nuovo nasce con il campo `platform`; lo storico è stato
riempito con `functions/scripts/backfill-user-platform.js`.

**Cosa si vede adesso** (primo snapshot con i campi nuovi, 25/08):

| | |
|---|---|
| tornati dopo 1 giorno | **0 su 6** |
| tornati dopo 7 giorni | 2 su 11 |
| tornati dopo 30 giorni | 28 su 286 |
| senza nessun titolo visto | 191 su 386 |
| primo titolo entro un'ora dall'iscrizione | 49% |
| mediana iscrizione → primo titolo (coorti recenti) | 1-16 minuti |

**Il buco non è dove pensavamo.** L'ingresso funziona: chi aggiunge un titolo
lo fa entro pochi minuti, e il 64% ne aggiunge almeno uno. Quello che non
succede è **il ritorno il giorno dopo**: 46% storico, e nelle ultime coorti
praticamente zero. Questo sposta il peso dalla Fase 2 (ingresso) alla Fase 1
(motivo per tornare), che resta la prossima cosa da fare.

**Resta aperto di questa fase**: `onboarding_started` continuerà a valere poco
finché la build iOS con il ponte non è sullo Store, e la domanda "l'onboarding
parte davvero su iOS?" si risponde solo con quei numeri. Non blocca la Fase 1:
il ritorno per coorte, che è la misura che conta, adesso c'è.

### Fase 1 — Dare un motivo per tornare (settimane 1-2)

Il canale editoriale è **il miglior canale automatico** (5,1% contro lo 0,5% dei
nudge), ma parla a 2-14 persone per volta. Il contenuto per parlare a tutti c'è
già: 783 eventi titolo notificabili.

1. **Digest settimanale personale** — una notifica a settimana, non una al
   giorno: le 3 novità più rilevanti sui titoli che hai in libreria. Usa
   `titleUpdateEvents` + la libreria, zero lavoro editoriale.
   *Misura: lettura ≥ 15%, WAU in risalita.*
2. **Risveglio della coorte di luglio** — 274 iscritti, 199 con libreria, 75
   ancora attivi: ci sono **~124 persone dormienti con dati veri dentro**. Un
   colpo solo, non una campagna: "mentre non c'eri, 3 novità sui tuoi titoli".
   *Misura: quanti tornano entro 7 giorni.*
3. **Sbloccare le push** — 12,7% è il tappo di tutto il resto. Chiedere il
   permesso **dopo il primo gesto di valore** (primo titolo aggiunto, import
   completato), mai al primo caricamento.
   *Misura: copertura push dal 12,7% al 30%.*

### Fase 2 — Attivare chi arriva (settimane 2-4)

Oggi il valore di Somto arriva **solo se importi**: l'hanno fatto 108 su 350, e
richiede un export da TV Time o Trakt. Chi non importa resta davanti a un'app
vuota.

1. **On-ramp senza import**: "dimmi 5 serie che hai visto", con suggerimenti, in
   meno di un minuto. Libreria minima → consigli e aggiornamenti immediati.
2. **Primo aggiornamento entro 24h**: appena la libreria tocca 3 titoli, parte
   il primo aggiornamento pertinente. Lega l'attivazione al canale che funziona.
3. *Misura: attivati entro 48h dal ~10% attuale al 40%.*

### Fase 3 — Attirarne di nuovi (settimane 3-8)

Solo dopo che il secchio tiene. In ordine di rapporto valore/fatica:

1. **Quiz come esca** — è il pezzo più cercabile che abbiamo: "quiz Stranger
   Things" è una query che esiste, "Somto" no. Ci sono 242 titoli a tema e
   10.525 domande, ma solo 232 URL in sitemap e 143 tentativi in tutto. Servono
   pagina per titolo, risultato condivisibile e immagine OG (lo script
   `scripts/gen-og-images.js` c'è già).
2. **SEO selettivo, non massivo** — pubblicare 21.115 pagine titolo sottili
   peggiora il dominio invece di aiutarlo. Prendere i ~500 titoli dove Somto ha
   contenuto **suo** (emozioni, aggiornamenti, quiz, voti) e curare quelli.
3. **Condivisione come canale** — oggi si condivide solo un invito a una sfida
   (8 usati in tutto). Il risultato del quiz e "la tua settimana" sono i due
   pezzi che una persona manda davvero agli amici.
4. **Presidiare "alternativa a TV Time"** — l'evento è passato, la query no.
   Serve una pagina di confronto onesta, più la scheda AlternativeTo rimasta in
   sospeso da luglio.

## Cosa NON fare adesso

- Paid: con il 27% di ritenzione a 30 giorni si paga per riempire un secchio bucato.
- Redesign globale (vincolo di progetto, e non è lì il problema).
- Feature social nuove: i post ufficiali hanno **0 commenti e 0 reazioni**; il
  problema non è la mancanza di superfici, è che non c'è abbastanza gente viva.
- ASO / spinta App Store prima che l'attivazione funzioni.

## Risks

- **Il digest diventa l'ennesimo canale ignorato** se il contenuto è debole. Gate
  esplicito: sotto il 15% di lettura non si ritara, si smette e si guarda il
  prodotto.
- **Espandere le pagine titolo può peggiorare il dominio**: pagine sottili e
  duplicate su un dominio senza autorità sono un danno, non un'opportunità.
- **Il risveglio dei dormienti funziona una volta sola**: ripetuto brucia la
  lista e alza le disinstallazioni.
- **La copertura push può continuare a scendere** mentre lavoriamo: è già -4 in
  una settimana. Va misurata ogni settimana, non a fine piano.

## Gate a 30 giorni (24/09/2026)

| metrica | oggi | obiettivo |
|---|---|---|
| WAU | 37 | 60 |
| attivati entro 48h | ~10% | 40% |
| copertura push | 12,7% | 30% |
| iscritti al giorno | ~1 | 3 |
| click organici / mese | 7 | 50 |
| lettura del digest | — | ≥ 15% |

Se a 30 giorni il digest è sotto il 15% e il WAU non si muove, la diagnosi è
sbagliata: il problema non sono i canali di richiamo ma il motivo per esistere
del prodotto, e il piano va riscritto da lì.
