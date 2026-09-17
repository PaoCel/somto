# Somto — Revisione critica indipendente

## 1. Informazioni sull'analisi

- **Documento**: revisione critica di prodotto, codebase, mercato e strategia di Somto
- **Data analisi**: 2026-07-12
- **Commit di riferimento**: `083aa61` (branch `main`, working tree pulito)
- **Autore**: reviewer esterno indipendente (analisi AI multi-agente supervisionata), con lenti combinate: architettura software, product management, UX consumer, strategia startup, mercato app film/serie TV, sicurezza e scalabilità Firebase, growth early-stage
- **Perimetro**: intera repository (`public/` PWA, `ios/TwoWatch` app SwiftUI, `functions/` + `functions-public-profile/` backend, `firestore.rules`, `docs/`, script operativi, blog/SEO) + analisi di mercato con fonti web
- **Fuori perimetro**: nessuna modifica al codice; nessun accesso a dati di produzione, analytics o metriche utente reali (non disponibili al reviewer — dove servono, sono dichiarate come "non verificabile")

### Metodologia

1. **Skeleton first**: struttura completa del documento creata prima dell'analisi, aggiornata incrementalmente.
2. **Analisi parallela della codebase** su 10 aree (stack/deploy, PWA, iOS, backend Functions, modello dati/rules, test/ops, mappa feature, privacy/cancellazione account, docs-vs-realtà, debito tecnico) tramite agenti di lettura indipendenti, con riferimenti puntuali ai file.
3. **Verifica avversariale** dei finding critici/gravi: ogni claim severo è ri-verificato da un agente scettico indipendente prima di entrare nel registro rischi.
4. **Ricerca di mercato** con fonti web (concorrenti, mercato italiano, modelli di monetizzazione); dove il web non è raggiungibile viene dichiarato.
5. **Sintesi e giudizio** nel presente documento, distinguendo sempre: **[FATTO]** verificato nella codebase, **[DEDUZIONE]** ragionevole, **[IPOTESI]** di prodotto, **[NON VERIFICABILE]**, **[OPINIONE]** strategica.

### Scale di giudizio

- Punteggi 1–5 (1 = grave carenza, 3 = adeguato, 5 = eccellente), sempre motivati.
- Raccomandazioni: **Impatto** (basso/medio/alto/critico) × **Sforzo** (XS/S/M/L/XL) × **Urgenza** (ora/prossimo/dopo/parcheggiato) × **Confidenza** (bassa/media/alta).

---

## 2. Stato di avanzamento dell'analisi

| Area | Stato |
|---|---|
| Struttura e indice del documento | ✅ Completa |
| Analisi codebase (10 aree, multi-agente + verifica) | ✅ Completa |
| Ricerca di mercato (fonti web) | ✅ Completa |
| Sezioni 3–11 (sintesi, prodotto, forze/debolezze) | ✅ Completa |
| Sezioni 12–17 (tecnica: architettura, sicurezza, stabilità, debito, UX) | ✅ Completa |
| Sezioni 18–23 (mercato, business, rischi) | ✅ Completa |
| Sezioni 24–31 (feature triage, roadmap, esperimenti, piani 30/90) | ✅ Completa |
| Sezioni 32–35 (cose da non fare, domande aperte, conclusione, tabella priorità) | ✅ Completa |
| Consolidamento finale | ✅ Completo |

**Documento completo.** Tutte le 35 sezioni sono state redatte e consolidate nella sessione del 2026-07-12/13, sulla base di: 10 analisi di area sulla codebase con verifica avversariale dei finding critici, 3 ricerche di mercato con fonti web, esecuzione reale delle suite di test backend (423 unit + 121 rules, verdi).

---

## Indice

1. Informazioni sull'analisi
2. Stato di avanzamento
3. Executive summary
4. Verdetto sintetico
5. Metodologia e limiti
6. Che cos'è Somto oggi
7. Visione implicita e direzione del prodotto
8. Mappa delle funzionalità
9. Analisi del core loop
10. Punti di forza reali
11. Debolezze principali
12. Analisi dell'architettura
13. Qualità e manutenibilità della codebase
14. Sicurezza e privacy
15. Stabilità, performance e scalabilità
16. Debito tecnico
17. Analisi UX e prodotto
18. Analisi del mercato
19. Analisi dei concorrenti
20. Differenziazione e posizionamento
21. Potenzialità di business
22. Modelli di monetizzazione
23. Registro dei rischi
24. Feature da proteggere, migliorare, rimandare o eliminare
25. Nuove feature raccomandate
26. Roadmap tecnica
27. Roadmap prodotto e business
28. Esperimenti di validazione
29. Metriche consigliate
30. Piano dei primi 30 giorni
31. Piano dei successivi 90 giorni
32. Cose da non fare
33. Domande strategiche ancora aperte
34. Conclusione
35. Tabella riepilogativa delle priorità

---

## 3. Executive summary

Somto è un prodotto **reale, completo e funzionante**: un tracker di film e serie TV con strato social, quiz gamificato e import da servizi terzi, pubblicato su web/PWA (somto.it, live) e iOS (TestFlight v1.4.4), con distribuzione Android in preparazione. Sono ~210.000 righe di codice attivo su tre superfici (PWA vanilla JS, app SwiftUI, backend Firebase con ~80 Cloud Functions), 663 commit, mantenute nella pratica da **una sola persona**.

L'analisi ha prodotto quattro conclusioni principali:

1. **La base tecnica è sopra la media per un progetto di questa dimensione e team** — ma con buchi precisi. Il backend è disciplinato (logging strutturato al 100%, rate limiting transazionale su ~30 callable, 423 unit test + 121 test sulle security rules, tutti verdi ed eseguiti durante questa analisi; pipeline di import genuinamente robusta con cursori e watchdog). I punti deboli sono altrettanto netti: **zero test automatici sui due client che gli utenti toccano** (0 test iOS su 61k righe, 1 solo spec e2e web mai eseguito in CI), **zero osservabilità in produzione** (nessun error tracking web, nessun alerting, nessun backup Firestore schedulato: l'ultimo incidente rules è stato scoperto "giorni dopo, da segnalazioni utenti"), e alcuni monoliti fuori controllo (`functions/index.js` 12.503 righe, `TitleDetailView.swift` 8.748, `title.page.js` 5.055).

2. **Il prodotto è più largo della squadra che lo mantiene.** Quattro sistemi paralleli di raccomandazione ("Match", hero della Home, spunti Community, consigli amico-a-amico) che non condividono codice né modello; feature complete costruite e mai accese (profili guidati, roll-up voti derivati, sistema editoriale mai usato per un publish reale); logica di business duplicata — a volte triplicata — tra iOS, web e rules (es. il calcolo XP quiz esiste in 3 posti scollegati). Ogni nuova feature d'ora in poi costa tre volte.

3. **La conformità privacy non è pronta per un lancio pubblico italiano.** La privacy policy live non identifica il titolare del trattamento (art. 13 GDPR); non esiste export dati (art. 20); non c'è alcuna età minima dichiarata o verificata per un social con chat e DM (in Italia soglia 14 anni); il gate "termini community" è bypassabile su web; un invio email marketing a 69 utenti è avvenuto senza consenso documentato. Nulla di tutto questo è difficile da sistemare — ma va fatto **prima** di spingere l'acquisizione, non dopo.

4. **La finestra di mercato è irripetibile e si sta aprendo adesso.** TV Time — il tracker mainstream di riferimento, 25M+ utenti — **chiude il 15 luglio 2026** (tra pochi giorni rispetto alla data di questa analisi), con cancellazione dei dati utente. È in corso una migrazione di massa; le alternative (Simkl, Serializd) scricchiolano sotto il carico; **nessun concorrente è localizzato bene in italiano**; le pagine editoriali italiane ad alto traffico che consigliavano TV Time (Aranzulla, Hall of Series) dovranno essere riscritte nelle prossime settimane. Somto ha già l'asset perfetto per questa finestra: un import TV Time da export GDPR testato e con pagina di soccorso dedicata. La finestra dura settimane, non anni.

**Raccomandazione in una frase**: congelare l'espansione di feature, concentrare i prossimi 90 giorni su un solo posizionamento — *"il posto italiano dove salvi la tua storia di film e serie, e la vivi con gli amici"* — cavalcando l'esodo TV Time con l'import come porta d'ingresso, chiudendo i gap legali e di osservabilità prima di spingere l'acquisizione, e misurando finalmente la retention invece del numero di feature.

## 4. Verdetto sintetico

**Verdetto complessivo: PASS WITH CONCERNS** — il progetto merita di continuare, ma solo cambiando modalità: da "costruire ampiezza" a "concentrare, stabilizzare, misurare".

| Dimensione | Voto (1–5) | Motivazione sintetica |
|---|---|---|
| Qualità tecnica | **3,5** | Backend disciplinato e testato; client senza rete di sicurezza; monoliti da migliaia di righe come convenzione di fatto. |
| Sicurezza | **3** | Rules mature (121 test, pattern server-owned congelati, deny-all documentati); ma `titles.create` senza validazione schema, voti enumerabili tra utenti loggati, XP quiz client-authoritative, App Check assente ovunque. |
| Stabilità | **2,5** | Storia recente di incidenti (crash SIGABRT in prod, costi 30k→7,5M letture/giorno, rules divergenti dal repo) tutti scoperti da utenti o a posteriori; il ciclo iOS "spedisci → il tester trova il bug → patcha" è documentato nei fatti. |
| Scalabilità | **3** | Firestore regge bene a questa scala e oltre; i pattern di costo a rischio sono noti e puntuali (`getMatchQueue` fino a migliaia di letture/chiamata, `getTitleWatchersProgress` ~600 letture senza rate limit). |
| Manutenibilità | **2** | Bus factor 1, tre implementazioni della stessa logica, monoliti, documentazione ottima ma che decade in ore quando i fix corrono più veloci dei doc. |
| UX | **3** | Cura visiva reale e parità web/iOS sorprendente; ma densità alta (scheda titolo con 8+ moduli), doppio grafo sociale (amici + follow) concettualmente confuso, 4 risposte diverse alla stessa domanda "cosa guardo?". |
| Chiarezza del posizionamento | **2** | La landing promette 4 cose in una riga ("vota, salva, discuti, gioca"); il codice ne implementa 8. Identità in via di definizione (il pivot Match→Community è il primo segnale di razionalizzazione). |
| Differenziazione | **2,5** | Presa singolarmente, nessuna feature è unica; il pacchetto "tracker serio + social in italiano + import senza attrito" lo è, oggi, per il mercato italiano. |
| Retention potenziale | **3** | Gli ingredienti ci sono (tracking serie, streak quiz, notifiche digest); non è mai stata misurata: nessuna metrica di retention esiste. |
| Monetizzazione potenziale | **2** | Nessuna leva attiva; benchmark di categoria brutali (Letterboxd converte <1–2% con 30M utenti). Non è un problema di oggi, ma il percorso è lungo. |
| Prontezza per la crescita | **2** | Se domani arrivassero 10.000 utenti da TV Time: i costi sarebbero gestibili, ma i bug sarebbero invisibili (zero error tracking), la moderazione sarebbe artigianale e la compliance esposta. |

Le risposte estese alle 12 domande del verdetto sono nella sezione 34.

## 5. Metodologia e limiti

**Come è stata condotta l'analisi.** Oltre alla lettura diretta dei file chiave, sono stati impiegati 32 agenti di analisi indipendenti: 10 analisti su aree della codebase (stack/deploy, PWA, iOS, backend, modello dati/rules, test/operazioni, mappa feature, privacy/cancellazione, docs-vs-realtà, debito tecnico), ciascuno con obbligo di ancorare ogni affermazione a file e righe; i finding critici e gravi sono stati poi sottoposti a **verifica avversariale** da agenti scettici indipendenti istruiti a refutarli (esito: la maggior parte confermata, alcune severità ridimensionate — segnalato nel testo dove rilevante). Tre ricercatori hanno svolto l'analisi di mercato **con accesso web e fonti citate** (luglio 2026). I test backend (423 unit + 121 rules) sono stati **eseguiti realmente** durante l'analisi, non solo letti.

**Cosa questa analisi NON ha potuto verificare** (dichiarato esplicitamente, mai dedotto in silenzio):

- **Lo stato realmente deployato in produzione** (ruleset live, hosting, functions attive su `gia-visto`): l'analisi è read-only sul repository. Il progetto ha una storia documentata di divergenza repo↔prod (incidente rules 2026-07-02), quindi le affermazioni "live" si basano sull'audit interno del 2026-07-12 (che dichiarava il ruleset byte-identico a main) più i commit successivi.
- **Qualunque metrica reale**: numero di utenti, retention, costi Firebase correnti, traffico SEO. Non esistono dashboard accessibili da questa analisi — e in gran parte non esistono affatto (vedi sezione 29).
- **L'esperienza d'uso autenticata end-to-end** su prod (pagine dietro login).
- Le stime di mercato di fonti terze (ricavi JustWatch, conversione Letterboxd) sono dichiarate come stime con fonte, non fatti.

Nel testo: **[FATTO]** = verificato nel codice con riferimento; **[DEDUZIONE]** = inferenza ragionevole; **[IPOTESI]**/**[OPINIONE]** = giudizio; **[NON VERIFICABILE]** = fuori dalla portata di questa analisi.

## 6. Che cos'è Somto oggi

Spogliato del marketing, Somto oggi è — in ordine di completezza osservata nel codice:

1. **Un tracker personale di film e serie TV** (watchlist, stati visto/da vedere, progresso per stagione/episodio, voti 1–10 su tre livelli titolo/stagione/episodio, recensioni, statistiche ore/titoli) — la parte più solida e stabile del codice.
2. **Una macchina di importazione** da TV Time (export GDPR), Trakt (OAuth) e Netflix (CSV, solo web): è la superficie di codice più grande del prodotto (~1.500+ righe per piattaforma client, decine di Cloud Functions, pipeline riavviabile con cursori e watchdog, pagina di soccorso `support-import.html`) e anche l'area storicamente più incidentata, oggi la più testata.
3. **Un social network verticale**: feed community, post con generi, thread di discussione per titolo/episodio con anti-spoiler adattivo, DM e gruppi (stessa collection unificata), amici + follower (due grafi distinti), profili pubblici con badge di progresso serie.
4. **Un quiz gamificato** (XP, streak, bonus giornaliero, sfide con amici e inviti esterni via link, classifica, modalità ospite senza registrazione sul web) — trattato dichiaratamente come leva di acquisizione, con un investimento ingegneristico visibilmente sproporzionato (14 file iOS dedicati contro 2 della Home).
5. **Un'infrastruttura SEO** già più matura del prodotto stesso: pagine titolo/quiz/liste server-rendered con sitemap dedicate, blog Eleventy con 17 articoli, landing comparative (`somto-vs-letterboxd.html`, `somto-vs-justwatch.html`), Search Console attiva.

Numeri essenziali **[FATTO]**: 956 file tracciati; ~61k righe Swift (109 file), ~87k righe web (48 pagine HTML, 106 JS, 46 CSS), ~38k righe backend core + 2.482 righe di security rules; 663 commit, di cui 655 dallo stesso autore; iOS 17+, Swift 6, Firebase Web SDK 10.12.5, Cloud Functions gen1 (Node 22). Web live su somto.it; iOS in TestFlight (1.4.4, non ancora su App Store secondo la documentazione di release); Android non ancora distribuito (percorso PWABuilder/TWA documentato, manca `assetlinks.json`).

Maturità: **un prodotto in beta avanzata con ambizioni da lancio pubblico imminente** — funzionante, curato, ma con la rete di sicurezza operativa (test client, monitoring, backup, compliance) tipica di un prototipo.

## 7. Visione implicita e direzione del prodotto

La visione non è scritta in nessun documento strategico del repo; va dedotta. Dal codice emergono **tre anime**:

- **Il TV Time italiano** (tracker mainstream di serie, episodi, progresso — con import proprio da TV Time): è l'anima più coerente con l'infrastruttura costruita (import, titleStates, stats, notifiche).
- **Il Letterboxd sociale** (recensioni, feed, discussioni, profili come identità culturale): è l'anima verso cui il prodotto sta pivotando — il tab "Match" è stato retrocesso a scorciatoia e sostituito dal tab "Community" nella settimana precedente questa analisi **[FATTO: `AppShellStore.swift` enum AppTab, `appShell.js`; commit 47c16b1 web, 846226f iOS]**.
- **Il Duolingo dei telefilm** (quiz, XP, streak, sfide): dichiarata internamente "leva di acquisizione", ma con una profondità (kit visivo dedicato, sfide esterne, inviti universal-link, audit editoriale di 2.500 domande) che va molto oltre una leva — è un secondo prodotto.

**Dove il prodotto è coerente**: il nucleo tracker→voto→community regge come catena unica (guardo → segno → voto → se ne parla). L'anti-spoiler adattivo — il contenuto si sblocca quando *tu* hai visto il titolo — è l'idea più originale del prodotto e lega tracker e social in modo che nessun concorrente fa così bene **[OPINIONE fondata su confronto competitor, sez. 19]**.

**Dove la direzione confonde**: quattro motori di "cosa guardo stasera" costruiti in tempi diversi e mai consolidati (Match, hero Home, spunti Community, consigli tra amici — `getSuggestionForMe` esiste perfino duplicata in due file con logiche indipendenti **[FATTO: `home.page.js`, `community.page.js`]**); il quiz che compete per attenzione con il core invece di alimentarlo; la landing che promette quattro cose in una riga. Il pivot Match→Community dimostra che la capacità di togliere esiste — ma è stato applicato una volta sola.

**La promessa centrale più credibile** (proposta, vedi sez. 20): la memoria completa della tua vita da spettatore — importata da dove eri, al sicuro, in italiano, condivisa con i tuoi amici veri. Il quiz e il match sono amplificatori, non il prodotto.

## 8. Mappa delle funzionalità

Mappa ricostruita dal codice (non dalla documentazione). Legenda stato: ✅ completa · 🟡 parziale · ⚠️ fragile · 👻 nascosta (esiste ma difficile da scoprire) · 🔌 costruita-ma-spenta · 🪦 legacy.

| Feature | Stato | Piattaforme | Giudizio |
|---|---|---|---|
| Watchlist / stati titolo | ✅ | web + iOS | Nucleo stabile, nessun segnale di fragilità. Da proteggere. |
| Voti multi-livello + recensioni | ✅ | web + iOS | Modello dati sofisticato (aggregati O(1) via trigger, migrazione 1-tap tra livelli). `combined` pesa ogni voto 1 — TODO dichiarato. |
| Progresso serie / watchers | ✅ | web + iOS | Due callable dedicate, resta nel grafo del chiamante. Solo TV, niente rewatch per-titolo. |
| Emozioni post-visione | ✅ | web + iOS | Rules + trigger presenti in main (CLAUDE.md li dichiara ancora "non deployati": nota stale). |
| Import TV Time / Trakt / Netflix | ⚠️ | web + iOS (Netflix solo web) | Superficie più grande e più incidentata del prodotto; oggi la più testata. Pipeline riavviabile ben progettata. **Asset strategico n.1** vista la chiusura di TV Time. |
| Ricerca (titoli/persone/utenti/generi) | ✅ | web + iOS | Solida, 4 scope, paginazione. |
| Pagina titolo | ✅ | web + iOS | Superficie UI più grande: 8+ moduli in un file da 5.055 righe (web) / 8.748 (iOS). Funziona, ma è il monolite più rischioso da toccare. |
| Community (feed, post, discussioni) | ✅ | web + iOS | Nuovo secondo tab (ha sostituito Match). Redesign hero rifinito nelle ultime ore prima dell'analisi. |
| Thread / DM / gruppi | ✅ | web + iOS | Architettura unificata elegante (una collection parametrizzata). Reactions, typing, read-map. |
| Anti-spoiler adattivo | ✅ | web + iOS + server | La feature meglio progettata del prodotto: gate su ciò che il viewer ha visto davvero + detector server-side unico (zero duplicazione). |
| Amici + follower | ✅ | web + iOS | Due grafi sociali paralleli mai fusi: complessità concettuale reale per l'utente. |
| Profili pubblici | ✅ | web + iOS | Buona profondità (categorizzazione automatica libreria, share card). |
| Quiz (gioco, XP, streak) | ✅ | web + iOS | Rifinito oltre la media del prodotto. Scoring/XP client-authoritative: vulnerabile a farming (ammesso nei commenti delle rules). |
| Quiz sfide + inviti esterni | ✅ | web + iOS | 4 CF dedicate, universal link. Edge minori noti. |
| Quiz classifica | ✅ | web + iOS | collectionGroup, esclude account sintetici. |
| Quiz guest play (funnel) | 🟡 | **solo web** | Il funnel di acquisizione dichiarato prioritario non esiste su iOS (gate globale auth). Server-authoritative, rate-limitato per IP. |
| Match (swipe deck) | 👻 | web + iOS | Retrocesso da tab a scorciatoia nel menu/watchlist in una settimana. Logica ricca ma ora quasi introvabile. |
| Consigli/raccomandazioni | 🟡 | web + iOS | 4 sistemi non convergenti; `getSuggestionForMe` duplicata in 2 file. |
| Liste personalizzate/condivise | ✅ | web + iOS | Parità reale (contro le attese), pagina pubblica SSR con sitemap non documentata in CLAUDE.md. |
| Notifiche push + digest | ✅ | web + iOS | Push reale FCM, preferenze per tipo, 3 digest schedulati. Modulo da 1.350 righe. |
| Statistiche utente | ✅ | web + iOS | Cache server-owned + riconciliazione settimanale anti-drift. Buona disciplina. |
| Onboarding | ✅ | web + iOS | Soft-gate skippabile, taste picker 4–12 titoli. Non raccoglie generi espliciti. |
| SEO (SSR, blog, landing) | ✅ | server | Tre famiglie di pagine indicizzabili + blog + comparative. Sproporzionato rispetto alla base utenti — ma è l'investimento giusto per la finestra TV Time. |
| Admin tools | 🟡 | spezzati | Quiz editor solo iOS; moderazione e analytics solo web; spoiler queue solo iOS. Nessuna logica dichiarata nello split. |
| Sistema editoriale | 🔌 | web (admin) | Completo e live, **mai usato per un publish reale**. |
| Profili guidati (sintetici) | 🔌 | tutte | Feature completa end-to-end (8 file backend, UI disclosure su entrambi i client, 13 test) con l'interruttore spento dal giorno zero. |
| Roll-up voti derivati | 🔌 | backend | Codice pronto (318 unit test citati), mai deployato. |
| Leaderboard legacy | 🪦 | backend | Trigger `onQuizAttemptCreated` scrive ancora su `leaderboard_weekly/allTime` che **nessuna UI legge più**: scritture e indici a vuoto a ogni partita. |
| Cancellazione account | ✅ | web + iOS | Genuinamente estesa (~24 subcollection, Storage, Auth) con reauth. Lacune puntuali: `moderationQueue` non toccata. |
| Impostazioni / consenso | ✅ | web + iOS | Consenso analytics opt-in reale (default off). Web minimale. |

**Tre pattern emergono dalla mappa**: (1) parità web/iOS alta sulle feature utente ma amministrazione spezzata a caso tra piattaforme; (2) tre feature complete tenute spente — investimento congelato che pesa su rules, test e superficie cognitiva senza produrre valore; (3) la ridondanza si concentra tutta su un solo job utente ("cosa guardo?"), il segnale più chiaro di direzione non risolta.

## 9. Analisi del core loop

Il loop implicito nel codice:

**Registrati → (onboarding soft) → importa la tua storia (TV Time/Trakt/Netflix) → segna/vota quello che guardi → il feed e gli amici reagiscono → il quiz ti dà un motivo quotidiano (streak) → i digest ti riportano dentro.**

Valutazione anello per anello (dal codice; nessuna metrica reale esiste per validarli):

| Passaggio | Cosa dovrebbe spingerlo | Stato reale |
|---|---|---|
| **Registrazione** | Quiz guest (web), pagine SEO titolo, invito sfida, passaparola | Funnel guest ben fatto ma solo web; le pagine SSR sono la porta SEO giusta. **Con la chiusura di TV Time, il motivo più forte per registrarsi nelle prossime settimane è "salva i tuoi dati prima che spariscano" — e il codice ce l'ha già.** |
| **Primo valore** | Import → libreria piena + statistiche immediate | L'anello più forte del prodotto **e** il più fragile storicamente: se l'import inciampa, il primo contatto è una delusione. La pagina rescue esiste ma è un cerotto. |
| **Ritorno D1** | Streak quiz, notifiche | La streak quiz è l'unico meccanismo D1 esplicito. Il "cosa guardo stasera" — il vero bisogno quotidiano — è diluito su 4 sistemi. |
| **Ritorno mensile** | Digest attività amici, promemoria watchlist, nuove stagioni | I digest esistono (3 scheduled functions). Manca il trigger più naturale della categoria: "è uscita la nuova stagione di una serie che segui" come notifica di prodotto ben visibile. |
| **Invito** | Sfide quiz esterne (universal link), liste condivise, watchers | Meccanica c'è; ma il valore sociale dipende dall'avere amici dentro → problema cold-start classico (sez. 18). |

**Giudizio**: il loop esiste sulla carta ed è più completo di quello di molti concorrenti — ma è un loop *progettato*, mai *misurato*. Non esiste un solo numero di attivazione o retention nel progetto. Il rischio non è che il loop sia sbagliato: è che nessuno sappia dove si rompe.

## 10. Punti di forza reali

In ordine di valore strategico, tutti verificati nel codice:

1. **La pipeline di import è un asset raro, arrivato al momento giusto.** Matching a finestre con cursore persistito, claim transazionale anti-doppio-processing, scritture idempotenti, watchdog ogni 10 minuti che rianima gli import bloccati, cap di sicurezza, test dedicati **[FATTO: `functions/index.js:5791-7154`, `importResume.test.cjs`]** — più una pagina di soccorso per i casi disperati. Nessuna delle app che stanno raccogliendo i profughi di TV Time ha investito così tanto proprio sull'ingresso dei dati (Simkl ha appena messo l'import ZIP dietro paywall per sovraccarico; Serializd non ha importer diretto).
2. **Disciplina backend da team più grande**: logging 100% strutturato (zero `console.log` su 38k righe), rate limiting transazionale su ~30 callable (incluso per-IP sulle guest), circuit breaker su TMDB, riconciliazione settimanale anti-drift delle statistiche, guardie di deploy reali (`check-deploy-safety.mjs`: branch, tree pulito, conferma esplicita) **[FATTO]**.
3. **Security rules mature e testate**: 2.482 righe con pattern sistematico "campi server-owned congelati", collection deny-all documentate, 121 test che girano in CI, e persino tecniche anti-enumerazione dove servivano (`ratingFeed`: get sì, list no) **[FATTO: `firestore.rules`, `rules.spec.cjs`]**.
4. **L'anti-spoiler adattivo è un'idea di prodotto originale eseguita bene**: il gate dipende da cosa il *lettore* ha visto davvero, non da un flag binario; il detector server-side esiste una sola volta (zero duplicazione client) e alimenta una coda di moderazione umana invece di censurare in automatico **[FATTO: `spoilerChecker.js`, `SpoilerGate.swift`, `spoilerGate.js`]**.
5. **Documentazione interna eccezionale per densità e onestà**: SECURITY.md con procedure per verificare il deployato reale, RUNBOOK con incidenti veri e comandi verificati, DECISIONS.md come registro ADR con alternative scartate, FIREBASE_DATA_MODEL.md i cui 38 indici combaciano al 100% con `firestore.indexes.json` (verificato programmaticamente). Il limite: decade in ore (vedi sez. 16).
6. **Infrastruttura SEO già pronta per la finestra di mercato**: pagine titolo/quiz/liste server-rendered con slug leggibili, redirect 301 dai vecchi URL, sitemap dinamiche, blog, landing comparative. È il canale di acquisizione a costo marginale zero già costruito.
7. **Parità web/iOS reale sulle feature utente** — incluso dove non era scontato (liste condivise con editor completo su entrambe): il valore promesso "web e iOS sincronizzati" è mantenuto.
8. **Velocità di esecuzione fuori scala per una persona sola**: 8 build TestFlight in una settimana, feature complete end-to-end (rules+backend+2 client+test) in giorni. È la risorsa più preziosa del progetto — e quella più a rischio burnout/dispersione.

## 11. Debolezze principali

In ordine di gravità:

1. **Zero visibilità su ciò che si rompe in produzione.** Nessun error tracking web (1 sola pagina su 34 ha un listener `window.onerror`, che logga solo in console locale), zero `Crashlytics.record(error:)` a fronte di 188 blocchi `catch` silenziosi su iOS, nessuna alert policy su Cloud Functions/Firestore, nessun backup/export Firestore schedulato **[FATTO, verificato avversarialmente: 4 finding confermati]**. Il runbook stesso documenta che l'ultimo incidente rules è stato scoperto "giorni dopo, da segnalazioni utente". Per un prodotto che vuole assorbire un'ondata di migranti da TV Time, questa è la debolezza numero uno.
2. **I due client non hanno rete di sicurezza.** 0 test su 61k righe Swift (`testTargets: []` esplicito), 1 spec e2e web mai eseguito in CI. Conseguenza documentata nei fatti: la 1.4.3 ha corretto un crash SIGABRT scoperto da un crashlog di un tester *dopo* l'upload; la 1.4.4 ha corretto testo nero-su-nero scoperto da uno screenshot *dopo* l'upload **[FATTO: RELEASE_HISTORY.md]**.
3. **Compliance GDPR non pronta per il lancio italiano** (dettaglio in sez. 14): titolare non identificato nella privacy policy, export dati inesistente, nessuna età minima, gate termini community bypassabile su web, email marketing senza consenso documentato. Il team aveva già mappato quasi tutti questi gap nei propri draft (marcati TODO, datati marzo 2026) senza chiuderli.
4. **L'ampiezza è il nemico**: ogni feature va scritta 2 volte (iOS+web) più le rules, e la storia recente mostra il drift sistematico che ne deriva (guest quiz solo web, Netflix import solo web, emozioni "non deployate" secondo la doc ma nel codice, XP quiz triplicato in 3 posti con valori copiati a mano). Con bus factor 1, ogni riga aggiunta oggi è manutenzione sottratta al 2027.
5. **Quattro motori di raccomandazione, nessuna risposta.** Il bisogno quotidiano che potrebbe generare ritorno D1 ("cosa guardo?") è la parte più frammentata del prodotto — il contrario di quello che serve.
6. **Monoliti come convenzione**: `functions/index.js` (12.503 righe, 79 funzioni), `TitleDetailView.swift` (8.748), `title.page.js` (5.055), `community.page.js` (4.701). Non è un problema estetico: è il motivo per cui ogni modifica alla scheda titolo è rischiosa e ogni review è superficiale.
7. **Il service worker forza il reload di tutte le tab a ogni deploy** (`skipWaiting()` incondizionato + `clients.claim()` + reload su `controllerchange`): con la cadenza di deploy attuale, gli utenti web subiscono reload non richiesti nel mezzo dell'uso; il banner "Aggiorna" è un'illusione di scelta **[FATTO, confermato riga per riga: `service-worker.js:119-157`, `pwa.js:99-127`]**.
8. **Il cold-start social è davanti, non alle spalle**: feed, watchers, sfide e discussioni sono costruiti per una massa critica che non c'è ancora; senza una strategia di densità (sez. 27), le superfici sociali appariranno vuote proprio ai primi utenti che decideranno se restare.

## 12. Analisi dell'architettura

**Impianto** [FATTO]: tre client (PWA multipagina vanilla JS senza framework né bundler; app iOS SwiftUI nativa con pattern Repository+Store e Observation framework; blog Eleventy statico) sopra un backend interamente Firebase: Firestore come unico database, ~80 Cloud Functions gen1 (Node 22, quasi tutte europe-west1), Storage, Auth, Hosting, FCM. Nessun livello intermedio: la sicurezza vive in `firestore.rules`/`storage.rules` + controlli `context.auth` nelle callable.

Giudizi sulle scelte strutturali:

- **Vanilla JS senza bundler** [OPINIONE]: scelta difendibile per velocità di iterazione di un singolo sviluppatore e per il posizionamento SEO (pagine leggere, niente hydration), ma il costo è visibile: nessun meccanismo di condivisione di stato oltre helper e moduli, duplicazione tra pagine, `main.css` che importa 29 fogli di stile per 34 pagine su 48 (≈358KB non minificati anche su pagine che non li usano), e la landing SEO che carica l'intero SDK Firebase (6 moduli gstatic incl. Storage e Messaging) solo per decidere "Entra vs loggato" [FATTO: `main.css:1-44`, `index.html:289-291`].
- **Doppio client nativo senza layer condiviso** [FATTO]: 12 repository Swift (9.986 righe) reimplementano ciò che 35 moduli `api.js` fanno sul web. La verifica avversariale ha ridimensionato la gravità (gli aggregati critici sono già centralizzati nei trigger server), ma il punto resta: le regole di business che vivono nei client (XP quiz, gate spoiler lato composizione) driftano, ed è già successo.
- **Ambienti**: separazione pulita prod/staging/emulatore con un colpo di genio semplice — la PWA sceglie il progetto dall'hostname, quindi un solo bundle serve entrambi gli ambienti, zero drift di build [FATTO: `firebaseConfig.js`]. Il debito gen1→gen2 è reale e già morde: i trigger Firestore gen1 non sono deployabili su staging (progetto nuovo), quindi si testano solo in emulatore.
- **Anomalia di region** [FATTO]: Firestore/Functions/Hosting in europe-west1, ma il bucket Storage di default in us-central1 — ogni upload di import attraversa due continenti. Non risolvibile senza migrazione bucket; da conoscere, non urgente.
- **Monoliti**: `functions/index.js` concentra 79 funzioni su 12.503 righe mentre il pattern modulare (`modules/`, `lib/`) esiste ed è usato per le feature recenti — il refactor organico (estrarre quando si tocca) è già la convenzione dichiarata, va solo applicata davvero.

**Voto architettura: 3/5** — scelte coerenti col vincolo "una persona, tre piattaforme", con costi noti e accettati; perde punti per i monoliti e per l'assenza di qualunque strato di osservabilità.

## 13. Qualità e manutenibilità della codebase

**Il paradosso di Somto**: igiene micro eccellente, struttura macro fragile.

Micro (tutto [FATTO]): zero blocchi di codice commentato rilevati; 8 `console.log` + 7 `print(` residui su ~200k righe; solo 6 TODO/FIXME genuini nel sorgente (il debito è tracciato nei doc, non inline); `escapeHtml` centralizzato e usato da 35/44 file che fanno `innerHTML`; 4 soli `fatalError` (tutti su invarianti di boot), zero `as!`; `.gitignore` coerente con il disco.

Macro:

- **File giganti come convenzione**: su iOS *nessun* ViewModel esiste come file separato — 46 ViewModel incorporati nei file delle View; le feature grandi sono "un file enorme per feature" (TitleDetail 9.924 righe in 4 file). Sul web, 3 pagine superano le 2.900 righe.
- **Duplicazione a tre teste** [FATTO]: XP quiz definito in `QuizModels.swift:377`, `quiz.api.js:53` e implicitamente nei cap di `firestore.rules:162-193` — tre fonti, sincronizzate a mano, nessun test di parità. `getSuggestionForMe` implementata due volte sul solo web. `normalizeSeriesProgress` esiste in due versioni *divergenti* tra `functions/lib/titleStates.js` e `functions-public-profile/index.js` (firme e comportamento diversi).
- **Codice orfano vivo**: `account.page.js` contiene un'intera watchlist parallela (filtri/sort/swipe, ~200 righe) apparentemente non più raggiungibile da alcun link, divergente da `watchlist.page.js` [FATTO: `account.page.js:2242-2374`].
- **Bus factor 1**: 655/663 commit dallo stesso autore. La documentazione mitiga (è il vero onboarding di un eventuale secondo dev), i monoliti aggravano.
- **Repo hygiene**: `quiz_beta/` (220 file, 16MB di dati inerti — più righe di tutto il codice applicativo messo insieme), ~30MB di zip screenshot App Store in `docs/`, `.git` a 118MB, `public/dist/` generato da uno script esbuild che nessuna pagina usa, `design/watchlist-redesign/patch/` con copie statiche già divergenti dai file reali.

**Voto manutenibilità: 2/5** — oggi il progetto si muove veloce *perché* c'è una sola testa che sa tutto; la struttura attuale non è trasferibile a un team senza un investimento serio.

## 14. Sicurezza e privacy

### Sicurezza (voto 3/5)

Il lavoro fatto è sopra la media della categoria "app Firebase indie" — e i problemi residui sono precisi, non sistemici.

Cosa regge [FATTO]: modello admin coerente (doc-based, niente custom claims orfani), 8 sole collection a lettura pubblica tutte giustificate, zero `allow write: if true`, campi server-owned congelati con checklist, rate limiting per-utente e per-IP, segreti fuori dal repo, storage rules con cap dimensione/content-type per path, anti-XSS con whitelist SVG dove serviva.

Cosa non regge, in ordine di priorità:

1. **`titles.create` senza validazione di schema** [FATTO, confermato avversarialmente]: qualunque utente loggato può creare un titolo `status:"approved"` con `ratingAggregate`, `slug` e `mergedTmdbIds` forgiati — il guard che congela quei campi esiste solo in update. La verifica ha confermato anche la catena completa: lo slug forgiato non viene deduplicato dal trigger e finisce su **pagine SSR pubbliche indicizzabili** → spam/slug-squatting sul dominio con SEO curata. Fix a basso sforzo (una `validTitleCreate` con `hasOnly`).
2. **Voti enumerabili tra utenti loggati** [FATTO, severità ridimensionata in verifica]: `ratings` è leggibile da ogni utente registrato e l'ID è deterministico (`uid__titleId__...`), quindi la storia completa di voti/recensioni/`watchedWith` di chiunque è ricostruibile per enumerazione. La verifica ha chiarito che è una **scelta consapevole del team** (restrizione da `public` a `isSignedIn` già fatta a giugno), ma resta una decisione di prodotto mai dichiarata all'utente: nessuna impostazione privacy la governa, e il campo `privacyDefault` è decorativo.
3. **`users/{uid}` interamente leggibile dai loggati incluso `tasteProfile`/`engagement`** — gap auto-documentato nelle rules come `TODO(security H1)` con piano di refactor, mai eseguito e assente dalla lista item-aperti di SECURITY.md [FATTO: `firestore.rules:775-789`].
4. **Grafo sociale pubblico ai loggati** (amicizie accettate leggibili da chiunque, following/followers idem) — by design e testato, ma non documentato come tradeoff [FATTO: `firestore.rules:971-1023`].
5. **XP/score quiz client-authoritative** [FATTO, ammesso nei commenti delle rules]: farming possibile con scritture ripetute sotto i cap. Mitigato, non risolto; il fix (callable server-side, come già fatto per il guest play) è dichiarato follow-up.
6. **App Check assente su tutte le callable** (non solo sulle guest, come la doc lascia intendere) e **CSP solo Report-Only con `unsafe-inline`** [FATTO].
7. Rischi minori: secrets via `.env` anziché Secret Manager; possibili indici collectionGroup mancanti per `deleteMyAccount` (da verificare contro il deployato — se mancano, la cancellazione può morire a metà senza try/catch) [DEDUZIONE da verificare live].

### Privacy / GDPR (voto 2/5)

Qui il quadro è meno maturo della sicurezza tecnica, e i gap sono in parte **auto-mappati e mai chiusi** (i draft in `docs/SOMTO_GO_LIVE/step_2/`, datati 2026-03-31, marcavano già quasi tutto come TODO):

| Gap | Stato | Riferimento |
|---|---|---|
| Privacy policy senza titolare del trattamento, sub-processor, sezione minori | [FATTO, confermato] | `public/privacy.html` (76 righe) |
| Nessun export/portabilità dati (art. 20) | [FATTO; grep esaustivo, zero risultati] | nessuna callable/UI |
| Nessuna età minima dichiarata/verificata (soglia IT: 14 anni) | [FATTO, confermato] | signup senza campo età |
| Gate "termini community" bypassabile su web (il client scrive direttamente su Firestore, la callable che fa il check non viene chiamata) | [FATTO, nucleo confermato] | `threads.api.js:399-449` vs `functions/index.js:2440` |
| Blast email marketing (Brevo) a 69 utenti con CSV da Auth, senza consenso documentato né menzione in privacy policy | [FATTO: registrato in RELEASE_HISTORY.md] | evento 2026-07-06 |
| `moderationQueue` conserva indefinitamente preview (280 char) e uid di utenti cancellati | [FATTO] | assente da `deleteMyAccount` |
| Blocco utenti enforced solo sulle recommendation (non su amicizie, follow, e — su web — messaggi) | [FATTO] | `targetHasBlocked` usato 1 volta |

Cosa invece è già giusto: email isolata in `usersPrivate` e mai esposta; consenso analytics **realmente** opt-in (SDK non parte senza accettazione); cancellazione account estesa con anonimizzazione corretta dei contenuti condivisi; pagina di cancellazione raggiungibile senza login.

**[OPINIONE]** Nessuno di questi gap è costoso da chiudere — è forse una settimana di lavoro totale più una decisione legale sul titolare — ma **vanno chiusi prima di qualunque spinta di acquisizione**, perché l'esposizione (Garante, store review, fiducia) cresce linearmente con gli utenti.

## 15. Stabilità, performance e scalabilità

**Stabilità (voto 2,5/5).** La storia recente documentata: un crash SIGABRT in produzione scoperto da crashlog di tester (1.4.3), bug visivi scoperti da screenshot di tester (1.4.4), un incidente costi con letture da 30k a 7,5M/giorno per un'ondata di import e un deploy rules divergente dal repo scoperto giorni dopo. I vecchi script one-off contenenti riferimenti a singoli utenti sono stati rimossi prima della pubblicazione del repository. Il sistema si autocura in modo reattivo, incidente per incidente. Con zero alerting, il tempo di scoperta di un problema dati è misurato in giorni — e passa dall'utente.

**Performance percepita (web).** Buone pratiche presenti (lazy loading su 64/66 immagini dinamiche, cache tiered nel SW con eviction LRU, View Transitions). Contropartite: CSS catch-all da ~358KB su 34 pagine, catena `@import` seriale, landing con 19 richieste al primo load incluso l'SDK Firebase completo, e soprattutto il **reload forzato di tutte le tab a ogni deploy** (sez. 11.7) che con la cadenza attuale di release è un problema di esperienza reale, non teorico.

**Scalabilità e costi (voto 3/5).** Alla scala attuale e per i prossimi 10-50k utenti Firestore regge senza drammi (benchmark: app social con qualche migliaio di DAU tipicamente $50–300/mese). I pattern a rischio sono localizzati e noti:
- `getMatchQueue`: fino a ~990 documenti da pool + 1.600 da segnali collaborativi + 1.400 da stato utente **per singola invocazione interattiva**, con le query "popular/recent" identiche per tutti e mai cachate [FATTO: `functions/index.js:9276-10520`];
- `getTitleWatchersProgress` (codebase secondario): fino a ~600 letture/chiamata **senza rate limit, senza logging, senza try/catch** — l'unico angolo del backend senza gli standard del principale [FATTO: `functions-public-profile/index.js`];
- trigger di aggregato (`ratingAggregate`/`emotionAggregate`) senza guard di deduplicazione evento né job di riconciliazione (a differenza di `userStats` che ha entrambi): un retry del trigger applica il delta due volte e il drift resta per sempre [FATTO];
- il costo reale di Firestore nei social sono i listener realtime su collection ampie: il feed è l'area da monitorare quando arriveranno utenti.

**Verdetto della sezione**: nessun blocco strutturale alla crescita; il collo di bottiglia non è la scalabilità tecnica, è **la capacità di accorgersi dei problemi**.

## 16. Debito tecnico

Registro del debito, ordinato per interesse composto (quanto costa ogni mese in cui resta):

| # | Debito | Costo ricorrente | Intervento |
|---|---|---|---|
| D1 | Zero test client (iOS 0, e2e 1 spec fuori CI) | Ogni release è una scommessa; regressioni scoperte dai tester | Smoke XCTest su logica pura + job e2e in CI (S/M) |
| D2 | Zero osservabilità (error tracking, alerting, backup) | Giorni di ritardo su ogni incidente | 2-3 alert policy + listener errori globale web + export Firestore schedulato (S) |
| D3 | Monolite `functions/index.js` (12.503 righe, 79 fn) | Merge conflict, review superficiali | Estrazione organica a ogni tocco (in corso di fatto per le feature nuove) |
| D4 | Duplicazione business logic ×3 (XP quiz il caso peggiore) | Drift silenzioso tra piattaforme | Callable server-side `submitQuizAttempt` (M) |
| D5 | Migrazione gen1→gen2 functions | Staging non può testare i trigger; debito che Google renderà obbligatorio | Pianificare finestra dedicata (L) |
| D6 | Trigger leaderboard legacy scrive a vuoto a ogni partita | Costo scritture+indici che scala con la leva di acquisizione | Rimozione trigger+indici (XS) |
| D7 | Feature spente (guided profiles, derived ratings, editoriale mai usato) | Superficie rules/test/cognitiva mantenuta senza valore | Decidere: accendere entro 90 giorni o congelare esplicitamente (decisione, non codice) |
| D8 | `quiz_beta/` 16MB + 30MB zip in docs + `.git` 118MB | Cloni lenti, repo confuso | Archivio esterno (XS) |
| D9 | Hook pre-commit anti-crash **non installato** su questo checkout (documentato come attivo) | La protezione contro una classe di crash già avvenuta non sta operando | `scripts/hooks/install.sh` + check equivalente in CI (XS) |
| D10 | Doc che decade in ore (SECURITY.md e CLAUDE.md dichiarano "aperto" il rate-limit guest quiz **già fixato lo stesso giorno**, commit 009967c; cheat-sheet tab bar non aggiornato al pivot Community; SW "v56" vs v112 reale) | Ogni decisione presa fidandosi dei doc rischia di essere sbagliata | Regola: il commit che chiude un item aggiorna il doc nello stesso commit |
| D11 | Watchlist duplicata orfana in `account.page.js`, `dist/` orfano, `design/patch/` stale | Falsa fonte di verità per chi esplora | Pulizia (XS) |
| D12 | `functions-public-profile` sotto gli standard del principale | Incoerenza silenziosa profilo/watchers | Allineare logging+rate limit+helper condivisi (S) |

Nota positiva [FATTO]: il debito è quasi tutto **tracciato e consapevole** (CLAUDE.md "Pending residui", commenti TODO nelle rules con piani di refactor). Il problema non è la consapevolezza: è che la coda non viene mai drenata perché le feature nuove passano sempre davanti.

## 17. Analisi UX e prodotto

Basata su lettura del codice delle superfici, mockup, CSS e flussi — non su sessioni utente reali [DEDUZIONE dove non diversamente indicato].

**Cosa funziona**: design system coerente tra piattaforme (variabili CSS allineate al tema SwiftUI); pattern feedback unificato (toast — con 3 `alert()` nativi residui in lists-editor); skeleton loading; stati vuoti curati nelle aree recenti; onboarding soft e skippabile (scelta giusta: il valore arriva dall'import, non dal questionario).

**Problemi concreti, in ordine di priorità d'intervento**:

1. **La densità della scheda titolo**: voti multi-livello + emozioni + watchers + thread + provider + cast + trailer + raccomandazioni in un'unica pagina. È la pagina più visitata (ogni percorso ci passa) e chiede all'utente di capire troppe possibilità insieme. Intervento: gerarchia — un'azione primaria sopra la piega (segna/vota), il resto progressivamente rivelato.
2. **Due grafi sociali senza spiegazione**: "amico" (richiesta+accettazione) e "follow" (asimmetrico) coesistono con permessi diversi in punti diversi (i watchers usano amici∪seguiti). Nessun concorrente chiede all'utente di gestire entrambi. Intervento: sceglierne uno come primario nell'UI (il follow, più adatto al cold-start) e retrocedere l'altro.
3. **"Cosa guardo stasera?" senza una casa**: 4 sistemi (sez. 7). L'utente che apre l'app con il bisogno più frequente della categoria non ha un posto ovvio dove andare — Match, che era la risposta, ora è nascosto nel menu. Intervento: una sola superficie "Per te stasera" (nella Home), alimentata dal motore migliore, e le altre ritirate o fuse.
4. **Il banner "Somto è giovane… qualcosa può ancora incepparsi" in Home** [FATTO: `home.page.js` ~632]: onestà apprezzabile in beta chiusa, ma per i migranti TV Time in cerca di una casa *stabile* è il messaggio sbagliato nel posto sbagliato. Da rimuovere o spostare in una pagina "stato del progetto".
5. **Accessibilità iOS incompleta**: zero `.dynamicTypeSize`, 172 frame a dimensione fissa, 85 Button contro 19 accessibilityLabel nella sola scheda titolo [FATTO] — già segnalato in un audit interno di giugno e non risolto. Rischio concreto in App Store review e con utenti reali over-40 (target naturale del tracker serie).
6. **Scoperta feature**: liste condivise, import Netflix, guest quiz — esistono e non si trovano. La mappa feature (sez. 8) conta 2 feature "nascoste" e 3 "spente": prima di costruire altro, far trovare quello che c'è.
7. **Terminologia**: "Match", "Consigli", "Spunti", "Suggerimenti" sono quattro parole per lo stesso job — il lessico riflette la frammentazione del motore (fix a costo zero quando si consolida).

**Valore percepito al primo accesso**: per chi importa, alto (libreria piena + statistiche in minuti — il momento "wow" c'è già); per chi parte da zero, debole (feed vuoto, amici assenti, watchlist vuota). L'onboarding dovrebbe biforcare esplicitamente: "arrivo da TV Time/Trakt" (percorso d'oro) vs "parto da zero" (seed guidato: 5 titoli → subito 3 raccomandazioni).

## 18. Analisi del mercato

Analisi condotta **con accesso web** (luglio 2026); ogni claim di mercato ha fonte citata nella sezione 19 o qui.

**L'evento che ridefinisce tutto: TV Time chiude il 15 luglio 2026.** La controllante Whip Media (acquisita dal fondo Blue Torch Capital, pivot su AI enterprise) spegne l'app: rimossa dagli store, sito offline, **dati utente cancellati** salvo export GDPR self-service ([TechCrunch](https://techcrunch.com/2026/07/02/popular-tv-tracking-app-tv-time-is-shutting-down-as-company-focuses-on-ai/)). Parliamo del tracker mainstream di riferimento: 26,4M installazioni storiche, 25M+ utenti dichiarati, ancora ~29k download/mese fino all'annuncio. La motivazione ufficiale — "il modello free ad-supported non è sostenibile e non c'era domanda per una versione a pagamento" — è anche un memento per Somto (sez. 21).

**Conseguenze in corso**: migrazione di massa con i riceventi in affanno — Simkl ha messo l'import ZIP dietro paywall per sovraccarico server; Serializd (100k+ utenti, l'alternativa "social") non ha importer diretto e scala male; Trakt raccoglie i power user ma si porta dietro una crisi di fiducia (rincaro VIP fino a +300% sui piani legacy, promessa esplicita del fondatore tradita, migliaia di cancellazioni). Il mercato dei "profughi" è **frammentato, senza un vincitore** — condizione rara.

**Il mercato italiano in particolare**:
- Nessun concorrente è localizzato bene: Trakt è solo in inglese; Letterboxd non ha localizzazione ufficiale IT; Serializd ha aggiunto l'italiano solo di recente (release notes v1.962) ed è acerbo.
- La stampa tech italiana sta già coprendo la chiusura (TuttoAndroid, iSpazio); le pagine editoriali ad alto traffico che raccomandano app di tracking — [Aranzulla](https://www.aranzulla.it/app-per-segnare-film-visti-1640815.html), Hall of Series (435k visite/mese, 77,6% traffico IT), CheDonna — citavano sistematicamente TV Time come prima scelta e **verranno riscritte nelle prossime settimane**: finestra concreta di digital PR per entrare in quelle liste.
- Il pubblico esiste ed è già aggregato altrove: Daninseries (~5M pageviews/mese, 300k+ follower IG), VictorLaszlo88 (320k YouTube), più un ecosistema di micro-creator cinema/serie. Il 65% degli utenti TikTok si dichiara interessato a contenuti cinema/TV e uno su due sceglie un film in base ai social (ricerca Univ. Cattolica).
- SEO: "dove guardare X" è monopolizzata da JustWatch (inutile attaccarla frontalmente); "quiz film/serie tv" è frammentata senza dominatore — coerente con l'investimento quiz di Somto; "app per segnare le serie viste" è la query in riscrittura post-TV Time.

**Dinamiche strutturali della categoria**:
- **Effetti di rete moderati**: un tracker funziona da solo (single-player value), il social scatta con densità locale — per questo il playbook giusto è quello di Letterboxd/Andrew Chen: nuclei densi prima della scala (fan-base di un creator, una community esistente), non lancio nazionale diffuso.
- **Dipendenza da terzi**: TMDB per i metadati (mitigata da cache+proxy+titoli manuali con `syncDisabled`); gli import dipendono dai formati export altrui (già oggi la parte più fragile).
- **Rischio clone**: reale — "l'ennesimo tracker" è la percezione di default. La difesa è il pacchetto (italiano + import + anti-spoiler + amici veri), non la singola feature.
- **Rischio finestra**: se Trakt o Letterboxd localizzassero in italiano per assorbire l'esodo, il vantaggio "unico prodotto davvero italiano" si riduce in fretta. La finestra è di **settimane/pochi mesi** [stima della ricerca di mercato].

## 19. Analisi dei concorrenti

| Capacità | **Somto** | TV Time † | Letterboxd | Trakt | Serializd | Simkl | JustWatch | IMDb |
|---|---|---|---|---|---|---|---|---|
| Tracking serie/episodi | ✅ | ✅ | ⚠️ (in arrivo, community contraria) | ✅ | ✅ | ✅ | ⚠️ | 🆕 ("Watched" 2026) |
| Film | ✅ | ✅ | ✅✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Voti multi-livello (stagione/episodio) | ✅✅ | ⚠️ | ❌ | ✅ | ✅ | ✅ | ❌ | ⚠️ |
| Recensioni | ✅ | ⚠️ | ✅✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Commenti/discussioni | ✅ (anti-spoiler adattivo) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ⚠️ |
| Community/feed | ✅ | ✅ | ✅✅ | ⚠️ | ✅ | ⚠️ | ❌ | ❌ |
| Messaggi privati | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Import da altri servizi | ✅✅ (TV Time GDPR, Trakt, Netflix) | ❌ | ⚠️ | ✅ (95% accuratezza) | ❌ | ✅ (ora premium) | ❌ | ❌ |
| Raccomandazioni | ⚠️ (4 sistemi) | ✅ | ⚠️ | ✅ | ❌ | ✅ | ✅✅ | ✅ |
| Gamification | ✅✅ (quiz/XP/streak) | ⚠️ (badge) | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ |
| Identità sociale del profilo | ✅ | ⚠️ | ✅✅ | ⚠️ | ✅ | ⚠️ | ❌ | ❌ |
| Semplicità percepita | ⚠️ | ✅ | ✅ | ❌ (power user) | ✅ | ⚠️ | ✅ | ⚠️ |
| Multipiattaforma | ✅ web+iOS (Android in arrivo) | ✅ | ✅ | ✅ | ⚠️ (web-first) | ✅ | ✅ | ✅ |
| Italiano nativo | ✅✅ | ⚠️ | ❌ | ❌ | 🆕 acerbo | ⚠️ | ✅ | ✅ |
| Monetizzazione attiva | ❌ | † (mai riuscita) | Pro $19 / Patron $49 | VIP $60 | ❌ | VIP ~$70 | B2B/affiliate | ads Amazon |

† TV Time chiude il 15/7/2026. Fonti principali: [Letterboxd 30M+ membri, in vendita ~$250M](https://variety.com/2026/digital/news/letterboxd-sales-talks-netflix-sony-paramount-1236806379/) · [Trakt price hike](https://www.neowin.net/news/trakt-vip-receives-up-to-300-price-hike-going-back-on-promise-to-honor-legacy-subs/) · [Serializd](https://www.serializd.com/about) · [Simkl VIP](https://simkl.com/vip/) · [JustWatch B2B](https://www.justwatch.com/blog/post/justwatch-audience-as-a-service/) · [IMDb Watched](https://help.imdb.com/article/imdb/new-features-updates/mark-as-watched-faq/GR2SD7Y4LZVNHUVH). Nuovi entranti minori sull'onda TV Time (Bingebase, Cineswipe, Sofa Time): nessuno a scala.

**Lettura della matrice**: Somto non vince su nessuna riga contro lo specialista di quella riga — ma è l'unico con la **colonna completa** (tracking serio + social + import + italiano). E le tre celle dove ha un doppio ✅ (import, gamification, italiano, più i DM e l'anti-spoiler che nessuno ha) sono esattamente quelle che contano nella finestra attuale.

## 20. Differenziazione e posizionamento

**Il posizionamento oggi comunicato** ("il social per film e serie TV: vota, salva in watchlist, discuti, gioca ai quiz e scegli cosa guardare con gli amici" — landing) elenca le feature invece di promettere un risultato: sono 5 promesse in 20 parole, nessuna memorabile.

**Elementi che rafforzano un'identità distintiva**: import senza attrito ("porta via la tua storia"), anti-spoiler adattivo (unico), amici veri + DM (nessun tracker li ha), italiano nativo (nessun concorrente ce l'ha), voti per stagione (i tracker seri sì, i social no).

**Elementi che la diluiscono**: quiz presentato come co-protagonista (è un canale, non la promessa), 4 lessici per la raccomandazione, "Match" come brand interno di una feature ora nascosta, landing-elenco.

**Posizionamento proposto** [OPINIONE]:

> **"Somto è la memoria di tutto quello che hai visto. Portala via da qualsiasi app in un tap, tienila al sicuro, vivila con i tuoi amici — in italiano, senza spoiler."**

Con la variante tattica per le prossime settimane: **"TV Time chiude. La tua storia no. Portala su Somto in 5 minuti."** — su landing dedicata, blog post "come esportare i dati da TV Time prima del 15 luglio" (contenuto ad altissimo intento di ricerca *in questo momento*), e outreach alle testate che stanno riscrivendo le liste.

**Pubblico iniziale più adatto** [OPINIONE]: appassionati italiani di *serie TV* 20–40 anni già utenti di tracker (migranti TV Time in primis) — non i cinefili puri (presidiati da Letterboxd) né il mainstream generalista (serve massa). È un pubblico che: ha già l'abitudine (zero educazione al prodotto), ha un dolore acuto *adesso* (dati in scadenza), ed è raggiungibile via 3-4 creator e 5-6 pagine SEO.

## 21. Potenzialità di business

Premessa onesta: **oggi Somto non ha alcuna leva di monetizzazione attiva, e va bene così.** Con la base utenti attuale, qualunque paywall produrrebbe cifre irrilevanti soffocando la crescita. La chiusura di TV Time insegna anche il rovescio: "gratis con ads per sempre, senza mai un piano a pagamento" finisce con lo spegnimento — la monetizzazione va *pianificata* ora e *attivata* dopo.

Benchmark di categoria (fonti in sez. 22): Letterboxd con 30M+ utenti genera ~$5,5M/anno stimati → conversione implicita ~1% o meno; benchmark freemium consumer mobile ~2,1%; per una nicchia italiana la fascia realistica è 1–3%. Tradotto: **per €1.000/mese di ricavi premium servono ~4–8.000 utenti attivi paganti-esposti** — obiettivo da 12+ mesi, non da oggi.

Cosa serve PRIMA di investire in monetizzazione: retention misurata (D1 ~35-40%, D7 ~15-20%, DAU/MAU >0,2 come soglie di viabilità di settore), costi Firebase strumentati, una base attiva a 4 cifre. Le ipotesi di business da validare prima di tutte: (1) i migranti TV Time restano dopo l'import? (2) il quiz converte davvero ospiti in utenti attivi del tracker? (3) gli utenti italiani pagano per un prodotto di nicchia locale?

## 22. Modelli di monetizzazione

| Modello | Potenziale | Prerequisiti | Rischi | Quando |
|---|---|---|---|---|
| **Affiliazione Amazon Prime Video** (bounty €3/trial, programma reale IT) | Basso ma immediato, sforzo ~zero (link "guardalo su" già naturali nelle schede) | Nessuno tecnico; disclosure in privacy | Percezione commerciale se invadente | **Ora** (come esperimento, non come business) |
| **Premium non-bloccante stile Letterboxd Pro** (statistiche avanzate, personalizzazione profilo, badge sostenitore, import prioritario) | Il modello di riferimento della categoria; €15–25/anno | Retention solida, 5–10k utenti attivi, feature premium che non tolgono nulla ai free | Conversione ~1–2%: numeri piccoli a lungo | 6–12 mesi |
| **Sky via Awin** (unico altro programma affiliate streaming confermato in IT) | Marginale | Come sopra | Catalogo query limitato | Dopo Amazon |
| Pubblicità display | Basso a questa scala, danneggia il posizionamento "casa pulita post-TV Time" | Scala | Il motivo per cui TV Time è morta senza affezione | **Sconsigliata** salvo native/editoriale |
| Partnership editoriali / promozione uscite (sistema editoriale già costruito!) | Interessante a medio termine: canale "aggiornamenti ufficiali" già live e mai usato | Base utenti che renda il canale appetibile a distributori IT | Conflitto di interesse percepito se non dichiarato | 6–12 mesi |
| Insight aggregati / B2B data (modello JustWatch) | Il moat economico vero della categoria — ma richiede una scala (100k+ utenti) lontana | Scala, legale (aggregazione anonima), qualità dati | Fiducia utenti se mal comunicato | 18+ mesi, parcheggiato |
| Creator program / community premium / white label / API | Prematuri | — | Distrazione | Parcheggiati |

**Regola che vale più di ogni modello** (lezione Trakt, documentata: "predatory", migliaia di cancellazioni): **mai mettere retroattivamente a pagamento ciò che era gratis**. Definire *ora*, per iscritto, cosa sarà per sempre gratuito (tracking, import, export) e cosa potrà diventare premium — ed esporlo come promessa pubblica: nel clima post-TV Time/post-Trakt, una "carta dei diritti dell'utente" è essa stessa marketing.

## 23. Registro dei rischi

Gravità = probabilità × impatto. Ordinati per gravità.

| ID | Rischio | Evidenza | Prob. | Impatto | Gravità | Conseguenza | Intervento | Urgenza |
|---|---|---|---|---|---|---|---|---|
| R1 | **Incidente dati invisibile per giorni** (nessun alerting/error tracking/backup) | Sez. 15; incidente rules scoperto da utenti | Alta | Critico | **Critica** | Perdita fiducia proprio durante l'ondata migranti; recovery impossibile senza backup | Alert policy + error listener web + export Firestore schedulato | **Ora** |
| R2 | **Esposizione GDPR al lancio pubblico** (titolare, export, minori, consenso marketing) | Sez. 14 | Media | Critico | **Alta** | Contestazione Garante, blocco store, danno reputazionale | Pacchetto compliance (1 settimana) | **Ora** |
| R3 | **Finestra TV Time sprecata** | Chiusura 15/7; concorrenti in affanno; nessuna landing dedicata nel repo | Alta | Alto | **Alta** | L'occasione di acquisizione a costo ~zero più grande della storia della categoria passa ai concorrenti | Landing + blog + PR outreach questa settimana | **Ora** |
| R4 | **Regressione client spedita in prod** (zero test client) | Crash 1.4.3, bug 1.4.4 scoperti da tester | Alta | Medio | **Alta** | Churn dei nuovi utenti al primo bug | Smoke test iOS + e2e in CI | Prossimo |
| R5 | **Burnout/bus factor 1** | 655/663 commit; 8 build/settimana; ampiezza ×3 piattaforme | Media | Critico | **Alta** | Il progetto si ferma | Congelare ampiezza; documentazione già buona come mitigazione | Prossimo |
| R6 | **Spam/abuso su `titles.create` + slug squatting su pagine indicizzate** | Sez. 14.1, confermato | Media | Alto | **Media-alta** | Contenuti spazzatura sul dominio SEO; bonifica costosa | `validTitleCreate` nelle rules | **Ora** (fix XS) |
| R7 | **Costi Firestore da pattern non cachati** (`getMatchQueue`, listener feed, watchers senza rate limit) | Sez. 15; precedente 7,5M reads/g | Media | Medio | **Media** | Bolletta improvvisa a crescita partita | Cache aggregata popular/recent; rate limit publicprofile; budget alert | Prossimo |
| R8 | **Percezione privacy** (voti/grafo/tasteProfile leggibili tra iscritti, nessuna impostazione) | Sez. 14.2-4 | Media | Medio | **Media** | Storia negativa "l'app italiana che espone cosa guardi" | Decidere e dichiarare; chiudere TODO H1 | Prossimo |
| R9 | **Farming XP quiz** (client-authoritative) | Sez. 14.5 | Media | Basso-medio | **Media** | Classifica falsata → la leva sociale del quiz perde credibilità | Callable server-side | Dopo |
| R10 | **Divergenza repo↔prod** (già successa) | SECURITY.md §11 | Media | Medio | **Media** | Diagnosi sbagliate, fix su codice non deployato | Procedura esiste: renderla check pre-deploy automatico | Dopo |
| R11 | **Dipendenza TMDB** | Proxy+cache+circuit breaker già presenti | Bassa | Alto | **Media** | Catalogo congelato se TMDB cambia termini | Mitigazioni già buone; monitorare | Parcheggiato |
| R12 | **Moderazione artigianale con crescita** (coda spoiler su iOS-only, report senza SLA, blocco utenti incompleto) | Sez. 8, 14 | Media (se cresce) | Medio | **Media** | Contenuti abusivi visibili troppo a lungo | Consolidare admin su web; completare blocco | Dopo |
| R13 | **Cold-start social** | Sez. 11.8 | Alta | Medio | **Media** | Superfici sociali vuote → churn | Strategia nuclei densi (sez. 27); profili guidati come opzione tattica | Prossimo |
| R14 | **SW reload forzato** | Sez. 11.7 | Alta (ad ogni deploy) | Basso | **Media** | Utenti interrotti; percezione instabilità | Fix 3 righe (skipWaiting solo su richiesta) | **Ora** (XS) |
| R15 | **Job non idempotenti su retry trigger** (aggregati senza dedup) | Sez. 15 | Bassa | Basso-medio | **Bassa** | Drift aggregati permanente | Guard eventId o reconcile schedulato | Dopo |

## 24. Feature da proteggere, migliorare, rimandare o eliminare

### Core da proteggere (investire, non toccare la direzione)

| Feature | Perché |
|---|---|
| **Import (TV Time/Trakt/Netflix) + rescue** | L'asset strategico nella finestra attuale; la porta d'ingresso del posizionamento "porta via la tua storia". Ogni ora spesa qui ha il ROI più alto del progetto. |
| **Tracker (watchlist, titleStates, progresso serie, voti multi-livello)** | Il valore single-player che regge anche senza rete sociale; il motivo per cui l'utente resta quando gli amici non ci sono ancora. |
| **Anti-spoiler adattivo** | L'unica feature davvero originale; da promuovere a argomento di marketing, non solo a dettaglio tecnico. |
| **SEO (SSR titolo/quiz/liste, blog)** | Canale di acquisizione a costo marginale zero già costruito, decisivo nelle prossime settimane. |
| **Statistiche utente** | Alimenta il momento "wow" post-import e la share card (viralità). |

### Da migliorare (funzionano, ma sotto il loro potenziale)

| Feature | Intervento |
|---|---|
| Notifiche/digest | Aggiungere il trigger di categoria che manca: "nuova stagione/episodio di una serie che segui" ben visibile. È il re della retention nella categoria serie. |
| Quiz guest funnel | Misurarne la conversione reale prima di investire altro; portarlo su iOS solo se i numeri web lo giustificano. |
| Onboarding | Biforcare: "arrivo da un'altra app" (percorso import) vs "parto da zero" (seed 5 titoli → 3 raccomandazioni immediate). |
| Community/feed | Consolidare il lessico e collegarla al tracker (il feed deve nascere dall'attività di visione, non competere con essa). |
| Scheda titolo | Gerarchia: un'azione primaria, resto progressivo. Nel farlo, spezzare i due monoliti (web/iOS). |
| Cancellazione account | Chiudere `moderationQueue`; aggiungere export dati accanto (stessa superficie). |
| Blocco utenti | Estendere a amicizie/follow/messaggi (oggi copre solo le recommendation). |

### Da rimandare (congelare esplicitamente, con data di revisione)

| Feature | Perché |
|---|---|
| Profili guidati | Costruiti e spenti: tenerli spenti finché la strategia community non li richiede esplicitamente; sono una risposta tattica al cold-start, non una priorità. Revisione a 90 giorni. |
| Roll-up voti derivati | Pronto ma non deployato; nessun utente lo ha chiesto. Deploy solo in una finestra calma. |
| Guest quiz su iOS | Cambio strutturale (gate auth globale) per un funnel non ancora misurato sul web. |
| Localizzazione EN | La finestra attuale è italiana; l'i18n ora diluirebbe l'unico vantaggio. Lo scaffolding parziale EN/ES esistente va dichiarato dormiente. |
| Rating per episodio con testo/foto | API pronte, volume marginale dichiarato. |
| Migrazione bulk voti per power user | Nice-to-have ammesso dallo stesso CLAUDE.md. |

### Da eliminare o ridimensionare

| Feature | Azione |
|---|---|
| **Trigger leaderboard legacy** | Eliminare (scrive a vuoto a ogni partita, con indici mantenuti). XS, guadagno immediato. |
| **3 dei 4 motori di raccomandazione** | Sceglierne uno (il taste-based che alimenta l'hero Home), fondere Match come *superficie* di quello, ritirare gli altri. Ridurre = migliorare. |
| **Watchlist duplicata in account.page.js** | Rimuovere (~200 righe orfane e divergenti). |
| **Doppio grafo sociale nell'UI** | Ridimensionare: un concetto primario per l'utente (follow), l'amicizia come caso speciale o viceversa — decisione di prodotto, poi semplificazione. |
| **Sistema editoriale** | Non eliminarlo (è live e costato poco da tenere): dargli **una** occasione di provarsi (primo publish reale entro 30 giorni) o dichiararlo dormiente. |
| **quiz_beta/, zip screenshot, design/patch stale, dist/** | Fuori dal repo. |

## 25. Nuove feature raccomandate

Poche, e ognuna deve giustificarsi. In ordine di priorità:

1. **Landing + percorso "Arrivo da TV Time"** (valore: acquisizione; sforzo S; rischio basso; differenziazione alta *questa settimana*). Non è una feature nuova — è impacchettare l'import esistente: landing dedicata, blog post "salva i tuoi dati TV Time prima del 15 luglio", CTA dall'onboarding, misurazione end-to-end del funnel. Dipendenze: nessuna. È l'unica "feature" che ha una scadenza reale.
2. **Export dati utente** (valore: compliance art. 20 + fiducia + posizionamento; sforzo S — una callable JSON sul pattern reauth/rate-limit già esistente). Nel mercato post-TV Time, "da noi i tuoi dati escono quando vuoi" è una promessa che nessun competitor fa con orgoglio. Trasforma un obbligo legale in marketing.
3. **Notifica "nuova stagione/episodio delle tue serie"** (valore: retention mensile — il trigger naturale della categoria; sforzo M: i dati TMDB e l'infrastruttura push esistono già). Criterio di successo: % di utenti dormienti che rientrano dalla notifica.
4. **Nota personale sulla voce watchlist** (valore: retention + coerenza contenuti — il blog la promette già, il prodotto non ce l'ha [FATTO: gap dichiarato in CLAUDE.md]; sforzo S: campo su `titleStates`, iOS+web+rules). Chiude anche un debito di onestà editoriale.
5. **Digest settimanale "la tua settimana / la settimana dei tuoi amici"** (valore: ritorno + condivisione; sforzo S sopra i digest esistenti).
6. **Profilo del gusto visibile + compatibilità tra amici** (valore: social hook differenziante, dati già in `tasteProfile`; sforzo M). Solo dopo il consolidamento del motore di raccomandazione — ne è la vetrina.

Esplicitamente **non** raccomandate ora: nuovi contenuti editoriali in-app, secondo tipo di gamification, feature community aggiuntive (sondaggi, club…), watch party, contenuti per titoli fuori TMDB, App Android *nativa* (la TWA basta).

## 26. Roadmap tecnica

Vincolo assunto: 1 persona, il prodotto resta in produzione, la finestra di mercato detta le priorità. Sforzo: XS <½ giorno · S 1–2 giorni · M ~1 settimana · L 2–4 settimane · XL >1 mese.

### Interventi immediati (questa settimana — non negoziabili prima di spingere acquisizione)

| Intervento | Sforzo | Motivazione / criterio di completamento |
|---|---|---|
| Fix SW: `skipWaiting` solo su richiesta utente | XS | Basta rimuovere la chiamata incondizionata (il message handler c'è già). Fatto quando: deploy non ricarica le tab aperte. |
| `validTitleCreate` nelle rules + test | XS/S | Chiude R6. Fatto quando: test rules che tenta la forgeria fallisce. |
| Alert minimi: error rate CF, spike reads/writes, budget giornaliero | S | Chiude metà di R1. Fatto quando: un'email/canale riceve l'alert di test. |
| Export Firestore schedulato (Cloud Scheduler + `gcloud firestore export`, retention 7–30gg) | S | Chiude l'altra metà di R1. Fatto quando: un export esiste nel bucket e un restore è stato provato una volta. |
| Error listener globale web (in `appShell.js` → collection admin-only con TTL) | S | Gli errori JS di prod diventano visibili. Fatto quando: un errore di test appare nella collection. |
| `scripts/hooks/install.sh` + check `uniqueKeysWithValues` in CI | XS | La protezione documentata torna vera. |
| Pacchetto GDPR: titolare in privacy.html, sezione minori + checkbox 14+, consenso marketing in settings, `moderationQueue` in deleteMyAccount | M (spalmabile) | Chiude R2 salvo export (sotto). Richiede un input business: identità del titolare. |

### Prossimi 30 giorni

| Intervento | Sforzo | Note |
|---|---|---|
| Callable `exportMyData` | S | Art. 20 + posizionamento. |
| e2e Playwright in CI (job su PR verso main, contro emulatori) | S | L'infrastruttura esiste, manca il collegamento. |
| Primo target XCTest iOS su logica pura (parser, policy update, gamification) | M | Non serve UI test: serve una rete sotto la business logic. |
| Gate community-safety enforced nelle rules (o web→callable) + estensione blocco utenti a friends/following | S/M | Chiude i due gap di enforcement. |
| Rate limit + logging su `functions-public-profile` | S | Allineamento agli standard del principale. |
| Rimozione trigger leaderboard legacy + indici | XS | |
| Pulizia repo (quiz_beta, zip, dist, patch stale, watchlist orfana) | S | |
| Verifica indici collectionGroup deployati vs `deleteMyAccount` | XS | Procedura REST già in SECURITY.md §11. |

### 30–90 giorni

| Intervento | Sforzo | Note |
|---|---|---|
| `submitQuizAttempt` server-side (XP/score/streak calcolati in CF) | M | Chiude R9 e la triplicazione XP; i client diventano thin. |
| Cache aggregata popular/recent per `getMatchQueue` (pattern `quizMeta/themes`) | S/M | Chiude il pattern di costo peggiore. |
| Spezzare `title.page.js` e `TitleDetailView.swift` per sezioni (refactor organizzativo, zero logica) | L (incrementale) | Farlo *insieme* al redesign gerarchia scheda titolo per pagare il costo una volta sola. |
| Estrazione `ratingAggregate` in lib/ + unit test; guard dedup eventi sui trigger aggregato | S | Parità con emotionAggregate. |
| Passata accessibilità iOS (Dynamic Type, label sui Button icon-only nelle 2 view peggiori) | M | Pre-requisito App Store review serena. |
| CSS: `<link>` paralleli al posto di `@import`; bundle scoped per le 5 pagine più pesanti | S/M | |
| Distribuzione Android TWA (assetlinks + screenshot manifest + Play listing) | M | Il percorso è già documentato; i migranti TV Time sono in maggioranza Android [DEDUZIONE dalla base storica TV Time]. |
| Job CI `xcodebuild build` (non archive) su PR che toccano ios/ | S | Intercetta rotture di compilazione. |
| Secrets → `defineSecret`/Secret Manager | S | |

### 3–6 mesi

- **Migrazione gen1→gen2 delle functions** (L/XL): pianificarla come progetto a sé con finestra dedicata; sblocca anche i trigger su staging.
- Refactor `functions/index.js` per estrazione organica continua (regola: ogni PR che tocca una funzione la estrae).
- App Check in modalità monitor → enforcement sulle callable costose.
- Moderazione consolidata su web (coda spoiler + report + utenti in un pannello unico).
- CSP enforcing (nonce sugli inline, poi flip).
- Strategia listener feed (paginazione vs realtime) guidata dai dati di costo reali.

### Oltre 6 mesi

- i18n EN se e solo se il playbook italiano ha funzionato (retention provata) — con estrazione stringhe pianificata, non retrofit.
- Valutazione layer condiviso di business logic client (o consolidamento su PWA come client primario Android/web).
- B2B data/API se la scala lo giustifica.

## 27. Roadmap prodotto e business

### Fase 0 — La finestra (adesso → 15 luglio + settimane successive)
- **Posizionamento operativo**: "TV Time chiude. La tua storia no." Landing dedicata, blog post how-to export (query in esplosione *ora*), guida import passo-passo.
- **Digital PR**: outreach mirato alle pagine italiane in riscrittura (Aranzulla, Hall of Series, TuttoAndroid, CheDonna, Eroica) per essere nella lista delle alternative. Costo ~zero, deadline reale.
- **Creator seeding**: 3–5 micro/mid creator serie-TV italiani (Daninseries e fascia sotto) con accesso anticipato + import assistito, non adv a pagamento.
- **Un canale di supporto visibile** (import assistito umano): ogni migrante salvato in questa fase è un evangelista; la pagina rescue esiste già, va presidiata.

### Fase 1 — Attivazione e densità (30–90 giorni)
- **Pubblico iniziale**: nuclei densi, non lancio ampio — la fan-base di 1–2 creator, e i migranti TV Time come coorte tracciata a parte.
- **Attivazione**: definire l'evento di attivazione (proposta: *import completato OPPURE ≥5 titoli segnati entro 48h*) e ottimizzare solo quello.
- **Retention**: notifica nuove stagioni + digest settimanale; la streak quiz come secondo pilastro.
- **Referral**: le sfide quiz esterne e le liste condivise sono già meccaniche di invito — strumentarle (chi invita, chi converte) prima di costruirne altre.
- **Community**: finché la densità è bassa, la community va *animata a mano* (l'editoriale mai usato serve esattamente a questo: 1 publish/settimana "cosa guardare questa settimana" — primo uso reale del sistema già costruito).
- **Store**: pubblicazione App Store (uscire da TestFlight) + Play Store via TWA. ASO in italiano su "traccia serie TV", "segna film visti", "alternativa TV Time".

### Fase 2 — Crescita misurata (90+ giorni)
- Raddoppiare sui canali che i dati della Fase 1 promuovono (SEO quiz? creator? referral sfide?).
- Esperimento premium non-bloccante solo se DAU/MAU >0,2 e D30 >10%.
- Internazionalizzazione: decisione dati-alla-mano a fine fase, non prima.

## 28. Esperimenti di validazione

| # | Ipotesi | Pubblico | Intervento | Metrica | Successo se | Decisione conseguente |
|---|---|---|---|---|---|---|
| E1 | I migranti TV Time si attivano meglio di ogni altro canale | Visitatori landing "TV Time chiude" | Landing + funnel import misurato | Visita→signup→import completato | >25% signup→import | Raddoppiare PR/SEO migranti; import assistito umano |
| E2 | L'import è il momento "wow" | Nuovi iscritti con import | Screen statistiche post-import + share card immediata | D7 coorte import vs coorte no-import | D7 import ≥ 2× no-import | Onboarding biforcato che spinge tutti verso import/seed |
| E3 | Il quiz guest converte in utenti tracker (non solo giocatori) | Visitatori quiz-prova | Tracciare guest→signup→primo titolo segnato entro 7g | % guest che diventano tracker attivi | >5% | Investire su quiz iOS; altrimenti il quiz resta SEO-only |
| E4 | La notifica "nuova stagione" riattiva i dormienti | Utenti inattivi 14g+ con serie seguite | Implementare notifica + misurare rientro | % rientro entro 48h | >15% | Farne il pilastro retention; espandere trigger |
| E5 | Il posizionamento "memoria sicura" batte "social" | Traffico landing | A/B due hero copy | Signup rate | Delta >20% | Riscrivere landing e store listing sul vincitore |
| E6 | Affiliazione Amazon non danneggia la fiducia | Utenti attivi | Link "Guardalo su Prime Video" nelle schede dove disponibile | CTR + feedback/segnalazioni | CTR >2%, zero backlash | Tenere; valutare Sky/Awin |

## 29. Metriche consigliate

Oggi il progetto non misura **nulla** della propria salute di prodotto (Analytics è consenso-gated e usato per eventi, ma non esiste una dashboard di retention/attivazione). Prima metrica da costruire: la pipeline stessa.

- **North Star Metric proposta**: **Weekly Active Trackers** — utenti che registrano ≥1 evento di visione (episodio visto, film segnato, voto) in una settimana. È l'atto che prova il valore core, correla con la retention, e non è gonfiabile dal quiz o dal feed.
- **Acquisizione**: signup/settimana *per canale* (SEO titolo, quiz guest, landing TV Time, invito sfida, creator) — mai il totale senza il canale.
- **Attivazione**: % nuovi iscritti che completano import o segnano ≥5 titoli entro 48h.
- **Retention**: D1/D7/D30 per coorte settimanale, separando coorte-import da coorte-organica; DAU/MAU (soglia di viabilità: >0,2).
- **Social**: % attivi con ≥1 amico/seguito; % con ≥1 interazione ricevuta entro 7g (il momento "qualcuno mi ha visto").
- **Qualità**: crash-free rate iOS (Crashlytics c'è già), errori JS/1000 sessioni (dopo l'error listener), tasso import riusciti al primo colpo vs rescue.
- **Costo**: € Firebase/settimana e letture/utente attivo (budget alert = anche telemetria).
- **Business (dormiente, da attivare in Fase 2)**: CTR affiliazione; più avanti conversione premium.

Anti-vanity: mai riportare "utenti totali" o "download" senza attivi; mai "domande quiz giocate" senza conversione a tracker.

## 30. Piano dei primi 30 giorni

Settimana 1 — **La finestra e la rete di sicurezza** (in quest'ordine perché l'acquisizione senza rete è un rischio, ma la finestra non aspetta):
1. Landing + blog "TV Time chiude: porta la tua storia su Somto" + outreach alle 5–6 testate italiane in riscrittura. **Ha una scadenza fisica: il 15/7.**
2. I fix XS/S della roadmap immediata: SW reload, `validTitleCreate`, alert minimi, export Firestore schedulato, error listener web, hook pre-commit.
3. Input business: identità titolare → privacy policy conforme; checkbox età; consenso marketing.

Settimane 2–3 — **Attivazione misurabile**:
4. Pipeline metriche minime (attivazione, D1/D7 per coorte, funnel import) — anche solo eventi Analytics + una query BigQuery/foglio settimanale.
5. `exportMyData`; gate community-safety nelle rules; e2e in CI.
6. Creator seeding (3–5 contatti, accesso + import assistito).
7. Primo publish reale del sistema editoriale ("cosa guardare questa settimana") — il canale community si anima.

Settimana 4 — **Consolidamento**:
8. Decisione documentata sui 4 motori di raccomandazione (quale resta) e sul doppio grafo sociale (quale è primario).
9. Rimozione trigger legacy + pulizia repo.
10. Review dei numeri della finestra: quanti migranti, quanti attivati, dove si rompe il funnel. **Questa review decide il piano dei 90 giorni.**

## 31. Piano dei successivi 90 giorni

Condizionato dai numeri della settimana 4; ossatura:

- **Mese 2**: App Store pubblico + Play Store (TWA). Notifica nuove stagioni. Quiz server-side (`submitQuizAttempt`). Primo target XCTest + job build iOS in CI. Cache `getMatchQueue`. Passata accessibilità. Consolidamento raccomandazione implementato (non solo deciso).
- **Mese 3**: Redesign gerarchia scheda titolo + spezzatura dei due monoliti (insieme). Digest settimanale. Nota personale su watchlist. Esperimento affiliazione Amazon. Se densità sociale insufficiente: decisione esplicita sui profili guidati (accendere con disclosure o archiviare).
- **Mese 4**: Migrazione gen1→gen2 (finestra dedicata). App Check monitor→enforce. Review strategica con i dati: retention per coorte, canale migliore, costo/utente. **Qui si decide se il progetto ha dimostrato trazione** (criteri in sez. 34, domanda 12).

## 32. Cose da non fare

Altrettanto importanti delle cose da fare:

1. **Non costruire nuove feature per 90 giorni** al di fuori della lista della sez. 25. Ogni feature nuova costa ×2 client + rules + doc, e il collo di bottiglia non è la mancanza di funzioni.
2. **Non lanciare marketing a pagamento** prima di avere retention misurata: comprare traffico verso un funnel non strumentato brucia cassa e non insegna nulla.
3. **Non introdurre pubblicità display** — il posizionamento post-TV Time è "la casa pulita e sicura"; le ads lo negherebbero il giorno uno.
4. **Non mettere mai a pagamento retroattivamente ciò che è gratis** (lezione Trakt): scrivere ora la promessa pubblica di cosa resterà gratuito per sempre.
5. **Non internazionalizzare ora**: l'italiano è l'unico fossato; l'inglese apre la concorrenza con tutti senza il vantaggio della finestra locale.
6. **Non accendere i profili guidati "di nascosto"**: se si usano per il cold-start, con disclosure visibile com'è già progettata — un caso "bot mascherati" distruggerebbe la fiducia proprio del pubblico in fuga da piattaforme che hanno tradito.
7. **Non fare refactor big-bang** (né del monolite functions né della PWA verso un framework): estrazione organica sì, riscritture no — il prodotto deve restare spedibile ogni settimana.
8. **Non aggiungere un quinto motore di raccomandazione** (nemmeno "con l'AI"): prima consolidare i quattro esistenti in uno.
9. **Non deployare mai più da tree sporco / bypassando le guardie** — la disciplina esiste ed è già stata la differenza tra incidenti contenuti e disastri.
10. **Non fidarsi dei documenti "pending/aperti" senza verificare il codice** — dimostrato in questa stessa analisi (2 item su 3 di SECURITY.md §5 erano già risolti).

## 33. Domande strategiche ancora aperte

Domande che questa analisi non può chiudere e che meritano una risposta esplicita del proprietario:

1. **Chi è il titolare del trattamento?** — ✅ **RISPOSTA (2026-07-13): Paolo Celestini, persona fisica.** Sblocca la privacy policy: vanno ora inseriti in `public/privacy.html` nome del titolare + un recapito di contatto dedicato (email), più sub-processor (Google/Firebase, TMDB, Brevo) e sezione minori. Resta aperta la domanda collegata sulla forma futura (hobby, side-business o startup) — rilevante se il progetto cresce.
2. **Qual è l'obiettivo a 12 mesi?** 1.000 utenti attivi felici e sostenibili (lifestyle product), o crescita da venture (che richiederebbe team, capitale, e un'ambizione internazionale oggi prematura)? Le due strade divergono presto — ad esempio su quanto investire in monetizzazione vs crescita.
3. **Il quiz è un canale o un prodotto?** Se dopo E3 la conversione guest→tracker è bassa, si accetta di declassarlo a contenuto SEO? L'investimento emotivo e ingegneristico accumulato renderà la decisione difficile: meglio dichiarare ora il criterio.
4. **Serie-first o anche cinefili?** Il posizionamento proposto punta sulle serie (spazio lasciato libero da TV Time, non presidiato da Letterboxd). Includere i cinefili duri significa competere con Letterboxd sul suo terreno: da evitare o abbracciare consapevolmente.
5. **Che rapporto con i dati aggregati?** Il modello B2B (JustWatch) è il più redditizio della categoria ma tocca la fiducia. Decidere presto la linea ("mai" / "solo aggregati anonimi dichiarati") permette di scriverla nella carta dei diritti dell'utente.
6. **Chi è la seconda persona?** Bus factor 1 non è sostenibile oltre i 12 mesi se il prodotto cresce. Co-founder, collaboratore, o accettare il tetto che ne consegue.

## 34. Conclusione

Le risposte esplicite alle dodici domande del mandato:

1. **Somto ha oggi una base tecnica sufficientemente solida?** Sì per il backend e il modello dati (sopra la media della categoria per disciplina e test); no per la rete operativa attorno ai client: zero test iOS/e2e effettivi, zero osservabilità, zero backup. La base regge il prodotto di oggi; non reggerebbe, senza i fix della sezione 26, l'ondata di utenti che il momento di mercato può portare.
2. **Il prodotto ha una direzione riconoscibile?** Non ancora: ha tre anime (tracker, social, quiz) e quattro risposte alla stessa domanda. Ma la direzione sta emergendo (pivot Community, quiz dichiarato "leva") e il pacchetto ha una coerenza latente che il posizionamento proposto può rendere esplicita.
3. **Esiste un'opportunità reale di mercato?** Sì, ed è la più concreta che questa categoria abbia offerto da anni: 25M utenti orfani di TV Time dal 15/7/2026, alternative in affanno, zero player localizzati in italiano, pagine editoriali italiane in riscrittura. Ma è una finestra di settimane, non una rendita.
4. **Qual è la parte migliore del progetto?** La pipeline di import (robusta, testata, con rescue) — per valore strategico nel momento attuale; a pari merito la disciplina backend/rules e l'anti-spoiler adattivo come idea di prodotto originale.
5. **Qual è il rischio più grave?** L'invisibilità operativa (R1): un incidente dati durante l'ondata di migranti, scoperto giorni dopo dagli utenti, senza backup da cui ripristinare, distruggerebbe l'unica cosa che il pubblico in fuga sta cercando: affidabilità. Subito dietro: l'esposizione GDPR (R2) e lo spreco della finestra (R3).
6. **Quale feature/area andrebbe migliorata prima di tutte?** Nessuna feature: l'osservabilità (alert, error tracking, backup) e il funnel di import misurato. La prima feature utente: la notifica "nuova stagione".
7. **Quale feature andrebbe rimandata o eliminata?** Eliminare: il trigger leaderboard legacy e 3 dei 4 motori di raccomandazione (consolidamento). Rimandare: guest quiz iOS, i18n, profili guidati, roll-up derivati. Congelare: ogni nuova feature per 90 giorni.
8. **Quale dovrebbe essere il pubblico iniziale?** Appassionati italiani di serie TV, 20–40 anni, già utenti di tracker — i migranti TV Time come prima coorte, raggiunti via SEO/PR sulle pagine in riscrittura e 3–5 creator, in nuclei densi.
9. **Quale potrebbe essere il vantaggio competitivo?** Nel breve: l'unico prodotto nativo italiano con import senza attrito, nel momento esatto in cui serve. Nel medio: il pacchetto "memoria completa + amici veri + anti-spoiler" che nessun concorrente offre insieme, difeso da una promessa pubblica di portabilità e trasparenza che il mercato (TV Time, Trakt) ha appena tradito.
10. **Ha senso continuare a investire nel progetto?** Sì — a condizione di cambiare modalità. L'asset costruito (prodotto funzionante multi-piattaforma + import + SEO + finestra di mercato) vale molto più del costo dei gap rimasti, che sono precisi e chiudibili. Sarebbe insensato invece continuare *come ora*: ampiezza crescente, zero misurazione, compliance rimandata.
11. **A quali condizioni?** (a) I fix di sicurezza operativa e GDPR chiusi prima di spingere acquisizione; (b) congelamento feature 90 giorni con le energie sulla finestra TV Time; (c) metriche di attivazione/retention in piedi entro 30 giorni: da lì in poi si decide con i numeri, non con l'entusiasmo; (d) una risposta alla domanda 1 e 2 della sezione 33 (titolare e obiettivo a 12 mesi).
12. **Quali risultati concreti nei prossimi 90 giorni per considerare positiva la direzione?** Proposta di soglie oneste per una nicchia italiana [OPINIONE]: ≥1.000 iscritti nel trimestre di cui ≥40% attivati (import o 5+ titoli in 48h); D7 ≥15% e D30 ≥8% sulla coorte-import; ≥200 Weekly Active Trackers a fine trimestre con trend crescente; zero incidenti dati non rilevati dagli alert; app pubblica su entrambi gli store; costi Firebase <€150/mese. Se a fine trimestre l'attivazione c'è ma la retention no → problema di prodotto, si itera sul loop. Se non c'è nemmeno l'acquisizione con una finestra così favorevole → il segnale di mercato è chiaro e va ascoltato.

**Chiusura.** Somto non è l'ennesimo side project: è un prodotto vero, costruito con una qualità che molti team non raggiungono, arrivato — in parte per merito, in parte per fortuna — al posto giusto nel momento giusto. Il suo nemico non è la concorrenza: è la dispersione. Se nei prossimi tre mesi sceglie di essere una cosa sola ("la memoria italiana di quello che guardi, al sicuro e con gli amici"), protegge quella cosa con la rete operativa che oggi manca, e misura invece di costruire, ha una possibilità concreta di conquistare una nicchia difendibile. Tutte le alternative — continuare ad allargare, rimandare la compliance, ignorare la finestra — portano allo stesso posto: un ottimo prodotto che nessuno ha mai usato.

## 35. Tabella riepilogativa delle priorità

| # | Intervento | Impatto | Sforzo | Urgenza | Confidenza |
|---|---|---|---|---|---|
| 1 | Landing/PR/SEO "TV Time chiude" + funnel import misurato | Critico | S | Ora | Alta |
| 2 | Backup Firestore schedulato + alert minimi + error tracking web | Critico | S | Ora | Alta |
| 3 | Pacchetto GDPR (titolare, minori, consenso marketing, moderationQueue) | Critico | M | Ora | Alta |
| 4 | Fix SW reload forzato | Medio | XS | Ora | Alta |
| 5 | `validTitleCreate` anti-forgeria/spam | Alto | XS | Ora | Alta |
| 6 | Hook pre-commit installato + check in CI | Medio | XS | Ora | Alta |
| 7 | Pipeline metriche attivazione/retention per coorte | Critico | S/M | Prossimo | Alta |
| 8 | `exportMyData` (art. 20 + posizionamento) | Alto | S | Prossimo | Alta |
| 9 | e2e in CI + primo target XCTest | Alto | M | Prossimo | Alta |
| 10 | Gate community-safety nelle rules + blocco utenti completo | Alto | S/M | Prossimo | Alta |
| 11 | Creator seeding (3–5) + primo publish editoriale | Alto | S | Prossimo | Media |
| 12 | Consolidamento motori di raccomandazione (decisione + implementazione) | Alto | M | Prossimo | Media |
| 13 | Notifica "nuova stagione/episodio" | Alto | M | Prossimo | Alta |
| 14 | App Store pubblico + Play Store TWA | Alto | M | Prossimo | Alta |
| 15 | Rimozione leaderboard legacy + pulizia repo | Basso | XS | Prossimo | Alta |
| 16 | Quiz server-side (`submitQuizAttempt`) | Medio | M | Dopo | Alta |
| 17 | Cache `getMatchQueue` + rate limit publicprofile | Medio | S/M | Dopo | Alta |
| 18 | Spezzatura monoliti scheda titolo (con redesign gerarchia) | Medio | L | Dopo | Media |
| 19 | Accessibilità iOS (Dynamic Type, label) | Medio | M | Dopo | Alta |
| 20 | Chiusura TODO H1 (users read) + dichiarazione privacy voti/grafo | Medio | M | Dopo | Media |
| 21 | Migrazione functions gen1→gen2 | Medio | XL | Dopo | Alta |
| 22 | App Check monitor→enforce | Medio | M | Dopo | Media |
| 23 | Esperimento affiliazione Amazon | Basso | XS | Dopo | Media |
| 24 | Premium non-bloccante | Medio | L | Parcheggiato | Media |
| 25 | i18n inglese | Medio | XL | Parcheggiato | Alta |

---

*Fine del documento. Analisi condotta il 2026-07-12/13 su commit `083aa61`. Per la metodologia completa e i limiti, vedere le sezioni 1 e 5.*
