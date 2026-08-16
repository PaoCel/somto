# Piano: aggiornamenti titoli e raccomandazioni per piattaforma

Stato: in implementazione su branch isolato; nessuna integrazione produzione.

Checkpoint Codex 2026-08-02: scanner bilingue, writer idempotente, rules/indice,
applicatore staging-only e fan-out notifiche implementati e testati sulla branch
Codex. Il backfill non è notificabile; il trigger live ha kill switch spento di
default. Nessuna parte è stata deployata o attivata.

Obiettivo: trasformare la tab Aggiornamenti in una timeline affidabile di
trailer, uscite e annunci ufficiali; notificare solo gli utenti realmente
interessati; usare i titoli consumati per migliorare i consigli, inclusa
l'affinità verso le piattaforme disponibili in Italia.

## Principi

- Un evento esterno viene acquisito una volta e poi distribuito in modo
  personalizzato: timeline, home, feed o push non sono la stessa cosa.
- Scritture e matching sono server-authoritative. I client leggono e gestiscono
  preferenze, ma non possono creare notizie ufficiali.
- Trailer e dati strutturati da fonti allowlisted possono essere automatici;
  fonti ambigue, rumor e associazioni incerte diventano bozze.
- Il backfill popola la timeline senza notifiche retroattive.
- "Affinità Netflix" non significa "abbonamento Netflix": l'inferenza resta
  privata, spiegabile, disattivabile e basata sulla disponibilità in Italia.
- Ogni fase deve essere piccola, reversibile e verificata in staging prima di
  qualunque deploy produzione.

## Divisione del lavoro

### Codex

- Contratti dati, proposta rules/indexes e migrazione.
- Scanner TMDB/YouTube, deduplica, matching e backfill.
- Fan-out notifiche, idempotenza, rate/cost caps e test backend.
- Provider affinity, dataset offline e benchmark raccomandazioni.
- Verifica sicurezza/privacy e runbook operativo.

### Claude

- UX web/iOS della timeline, loading/error/empty state e deep link.
- Controlli Segui/Silenzia e preferenze notifiche granulari.
- Superficie Home per novità e consigli da piattaforme affini.
- Console editoriale: fonti, bozze, revisione e pubblicazione.
- QA visuale e parità web/iOS.

### Regola di coordinamento

Codex congela prima il contratto dati della fase; Claude lavora sui consumer
solo dopo quel checkpoint. `functions/index.js`, rules, indexes e script dati
restano in ownership Codex; le UI restano in ownership Claude. File condivisi
si modificano in sequenza, mai contemporaneamente. Una fase corrisponde a un
branch/PR e non parte finché la precedente non è verificata.

## Fasi

### 1. Rendere affidabile ciò che esiste

- Fallback video `it-IT -> en-US/unfiltered` su web e iOS.
- Distinguere assenza di contenuti da errore rete/auth/rate limit.
- Mostrare nella tab i post ufficiali già collegati tramite `linkedTitleIds`.
- Aggiungere logging minimo per caricamento aggiornamenti.

Uscita: Avengers: Endgame mostra i trailer su web/iOS; un errore TMDB è
ritentabile e non appare come timeline vuota.

### 2. Introdurre il motore eventi

- Proposta esplicita per `titleUpdateEvents`, rules, indici, retention e
  rollback prima di modificare Firestore.
- Eventi iniziali: `trailer`, `teaser`, `release_date`, `new_episode`,
  `new_season`, `renewal`, `cancellation`, `sequel`, `casting`.
- ID deterministici per fonte e contenuto; stato `published` o `draft`;
  fonte, data evento, titolo collegato e confidence sempre conservati.
- Timeline titolo ordinata e paginata, senza fan-out in questa fase.

Uscita: ripetere lo stesso import non crea duplicati; i client non possono
scrivere eventi; solo eventi pubblicati sono visibili.

### 3. Acquisizione automatica e backfill

- Scanner TMDB prima come script ops in dry-run, poi schedulato solo dopo QA.
- TMDB Changes per restringere il lavoro ai titoli modificati.
- Playlist dei canali YouTube ufficiali allowlisted per i trailer.
- Backfill silenzioso degli ultimi 90-180 giorni, prioritario sui titoli con
  `titleStates` e sulle uscite future; mai una scansione cieca di tutto lo
  storico.
- Limiti per run, retry, circuit breaker e report di esecuzione.

Uscita: eventi nuovi rilevati entro 6 ore; backfill con zero notifiche e report
di conteggi, duplicati, ambigui ed errori.

### 4. Interesse e notifiche

- Preferenze per titolo: segui, importanti soltanto, silenzia.
- Elegibilità per tipo evento: esplicito seguito, in corso/parziale, completato
  e watchlist hanno pesi diversi; i vecchi import non generano una valanga di
  push.
- Trigger sull'evento pubblicato, non sulla singola apertura dell'app.
- Notifiche con ID deterministico, deep link alla tab/evento, cooldown e cap
  giornaliero; preferenze globali web/iOS allineate.
- Generalizzare o ritirare `detectNewSeasonsForUser`, oggi limitato al profilo.

Uscita E2E: utente che ha completato Ted Lasso riceve una sola notifica per un
nuovo trailer; utente silenziato non la riceve; una seconda run non duplica.

Checkpoint backend: policy, deduplica, cap di 3 notifiche titolo/giorno, copy
IT/EN e trigger gen2 sono implementati. Il trigger richiede
`TITLE_UPDATE_NOTIFICATIONS_ENABLED=true`; restano il QA con audience staging
e l'allineamento dei consumer web/iOS assegnato a Claude.

### 5. Affinità piattaforma e raccomandazioni

- Estendere il profilo privato con provider/network/franchise, recency e tipo
  di disponibilità (`flatrate` distinto da noleggio/acquisto).
- Ripartire il credito quando un titolo è presente su più piattaforme.
- Tenere il motore Somto attuale come baseline e cold-start.
- Benchmark offline: baseline Somto, popolarità, Item-KNN, `implicit` ALS ed
  eventualmente LightFM; split temporale, non casuale.
- Il collaborativo entra in produzione con peso basso solo se migliora
  NDCG/Recall senza peggiorare copertura e diversità.
- Home: corsia spiegabile, es. "Disponibili su Netflix e in linea con i tuoi
  gusti", mai "sappiamo che sei abbonato".

Uscita: consigli escludono già visti/dismissed e titoli non disponibili in
Italia; ogni consiglio espone almeno una motivazione comprensibile.

### 6. Copertura editoriale delle piattaforme

- Adapter progressivi per pressroom/RSS/sitemap ufficiali delle piattaforme.
- Deduplica fra comunicato, video YouTube e aggiornamento TMDB.
- Auto-publish soltanto con fonte allowlisted e matching titolo non ambiguo;
  tutto il resto entra nella console come bozza.
- Eventi importanti possono essere promossi a `officialUpdates` per feed e
  notifica; gli altri restano nella timeline e nella Home personalizzata.

Uscita: ogni fonte ha owner, kill switch, ultimo successo, errori visibili e
procedura di disattivazione.

## Metriche minime

- Duplicati evento e notifica: zero.
- False push da backfill/import: zero.
- Latenza acquisizione v1: meno di 6 ore.
- Delivery per tipo: timeline, feed e push misurate separatamente.
- Raccomandazioni: Recall@10, NDCG@10, coverage, diversity, save/start rate e
  dismiss rate; confronto sempre con la baseline corrente.
- Costi: letture, chiamate esterne e fan-out riportati per run.

## Ordine di rilascio

1. Fase 1 senza schema nuovo.
2. Fase 2 in emulatori e staging.
3. Fase 3 manuale/dry-run, poi scheduler.
4. Fase 4 con audience QA prima della produzione.
5. Fase 5 inizialmente offline e shadow-only.
6. Fase 6 una piattaforma alla volta.

Nessuna fase autorizza implicitamente modifiche a schema, rules, indexes o
Cloud Functions: per quei passaggi serve la proposta di sicurezza/migrazione
prevista da `AGENTS.md` e un'approvazione esplicita.
