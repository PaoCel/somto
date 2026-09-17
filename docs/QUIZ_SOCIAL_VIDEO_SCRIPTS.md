# Script video social — serie "Quanto ne sai di…"

Serie di video verticali (TikTok / Reels / Shorts) per far scoprire il quiz di
Somto. Diversa dalla serie "Costruisco Somto con un'AI": lì si racconta il
dietro le quinte, qui si gioca. Le due serie possono convivere sullo stesso
profilo.

Tutte le domande di questi script sono **vere**, prese dal corpus di produzione:
l'id è indicato per ogni domanda, così si ritrovano in `quizQuestions` e in app.

---

## Il formato

Durata 35-40 secondi. Tre domande, difficoltà crescente.

```
0:00-0:03   HOOK        "Quanto ne sai di X?" + provocazione
0:03-0:13   DOMANDA 1   facile — la prende il 90%
0:13-0:24   DOMANDA 2   media — la prende il 50%
0:24-0:36   DOMANDA 3   difficile — la prende il 10%
0:36-0:40   CTA         "altre 50 su Somto, senza registrarti"
```

Per ogni domanda: 4-5 secondi di lettura, 3 secondi di countdown, 2 secondi di
reveal. Il countdown va **sempre** mostrato: è quello che tiene il dito fermo.

### Regole non negoziabili

1. **La terza domanda deve essere sbagliabile.** Il video funziona se chi guarda
   arriva in fondo con 2 su 3 e la voglia di commentare "la terza la sapevo".
   Un video dove si prende tutto non genera niente.
2. **Zero spoiler.** Solo domande con `spoilerLevel` `none` o `light`. Un video
   che spoilera si prende commenti negativi e zero installazioni.
3. **Testo corto a schermo.** Domanda entro due righe, risposte entro 34
   caratteri. Le domande scelte qui rispettano già il limite.
4. **Accenti giusti.** Nei batch Harry Potter e I Cesaroni il corpus ha accenti
   mangiati ("Perche", "e", "puo"): nei testi sotto sono già corretti a mano,
   ma quando peschi altre domande **controlla sempre** (vedi
   `docs/QUIZ_QUALITY_AUDIT_2026-08-27.md`, Finding 2).
5. **Una sola CTA, alla fine.** Il link in bio o nel commento fissato.

### Produzione

Stessa tecnica della serie esistente: schermate + voce fuori campo, montaggio in
CapCut. Serve poco:

- fondo fisso (poster del titolo sfocato, o il colore del brand)
- testo domanda in alto, quattro risposte a griglia 2×2
- countdown 3-2-1 come numero grande o barra
- reveal: risposta giusta in verde, le altre spente
- ultimo fotogramma: schermata vera del quiz Somto dal telefono

La voce fuori campo legge la domanda e **non** le risposte: si leggono a schermo.
Sotto, nei blocchi VO, c'è solo quello che va detto.

---

## Script 1 — Harry Potter

> Il video di punta. Harry Potter è il titolo con più domande in archivio (396)
> ed è quello che regge una serie intera se funziona.

**HOOK (0:00-0:03)**
- A schermo: `QUANTO NE SAI DI HARRY POTTER?`
- VO: «Tre domande su Harry Potter. La terza non la prende quasi nessuno.»

**DOMANDA 1 — facile** (`q_171_11`, Harry Potter e la pietra filosofale)
- Domanda: *Come si chiama il cane a tre teste che sorveglia la botola?*
- Risposte: Aragog · **Fuffi** · Lupin · Norbert
- VO: «Facile. Il cane a tre teste nel corridoio proibito.»
- Reveal: **Fuffi**

**DOMANDA 2 — media** (`hp_goblet_013`, Il calice di fuoco)
- Domanda: *Quale pianta permette a Harry di respirare sott'acqua nella seconda prova?*
- Risposte: Vischio del Diavolo · Mandragora · **Algabranchia** · Assenzio lunare
- VO: «Seconda prova del Torneo Tremaghi. Sott'acqua.»
- Reveal: **Algabranchia** — «gliela passa Neville, non Dobby: nel film è Neville.»

**DOMANDA 3 — difficile** (`hp_chamber_015`, La camera dei segreti)
- Domanda: *Quale incantesimo usa Draco per evocare un serpente nel duello?*
- Risposte: Vipera Evanesca · **Serpensortia** · Lacarnum Inflamari · Tarantallegra
- VO: «Ultima. Il duello con Draco, secondo film.»
- Reveal: **Serpensortia** — «Vipera Evanesca è l'incantesimo con cui Piton lo fa sparire. Non è la stessa cosa.»

**CTA (0:36-0:40)**
- A schermo: schermata del quiz + `somto.it`
- VO: «Ce ne sono altre quattrocento. Si gioca senza registrarsi, link in bio.»
- Link: `https://somto.it/quiz-prova.html?titleId=harry-potter-e-la-pietra-filosofale-2001`

**Caption**: Se hai preso 3 su 3 scrivilo nei commenti, non ci credo 🪄 #harrypotter #quiz #hogwarts #potterhead #somto

---

## Script 2 — Il Trono di Spade

**HOOK**
- A schermo: `TRE DOMANDE SU GAME OF THRONES`
- VO: «Dicevi di averlo visto tutto. Vediamo.»

**DOMANDA 1 — facile** (`q_98_43`)
- Domanda: *Quale parola usa Daenerys per ordinare ai draghi di sputare fuoco?*
- Risposte: Khaleesi · Valar morghulis · **Dracarys** · Mhysa
- Reveal: **Dracarys**

**DOMANDA 2 — media** (`q_98_24`)
- Domanda: *Quale soprannome danno a Robb Stark i suoi sostenitori?*
- Risposte: Il Re della Notte · Il Re Folle · Il Re Corvo · **Il Giovane Lupo**
- Reveal: **Il Giovane Lupo**

**DOMANDA 3 — difficile** (`q_98_8`)
- Domanda: *Come si chiamano i tre draghi di Daenerys?*
- Risposte: Balerion, Meraxes e Vhagar · **Drogon, Rhaegal e Viserion** · Sunfyre, Tessarion e Dreamfyre · Syrax, Caraxes e Vermax
- VO: «Attenzione, tutti e quattro i gruppi sono nomi di draghi veri.»
- Reveal: **Drogon, Rhaegal e Viserion** — «gli altri sono di House of the Dragon e della Danza dei Draghi.»
- Nota montaggio: qui le risposte sono lunghe. Mostrale una alla volta, non a griglia.

**CTA**
- Link: `https://somto.it/quiz-prova.html?titleId=il-trono-di-spade`
- VO: «Altre cinquanta su Somto, senza registrarti.»

**Caption**: La terza divide i veri fan da quelli che hanno visto solo la serie ⚔️ #gameofthrones #tronodispade #quiz #somto

---

## Script 3 — Mare Fuori

> Pubblico giovane e italiano, quello che converte meglio. Domande di personaggi,
> non di trama: niente spoiler sulle morti.

**HOOK**
- A schermo: `SE NON PRENDI 3 SU 3 NON HAI VISTO MARE FUORI`
- VO: «Tre domande. Solo personaggi, niente spoiler.»

**DOMANDA 1 — facile** (`q_89_15`)
- Domanda: *Qual è il nome d'arte di Gianni Russo, l'aspirante musicista?*
- Risposte: **Cardiotrap** · Dobermann · Sangue Blu · 'o Chiattillo
- Reveal: **Cardiotrap**

**DOMANDA 2 — media** (`q_89_18`)
- Domanda: *Quale ruolo ha Beppe Romano dentro l'IPM?*
- Risposte: Cappellano · **Educatore** · Medico · Direttore
- Reveal: **Educatore**

**DOMANDA 3 — difficile** (`q_89_17`)
- Domanda: *Da quale imposizione familiare cerca di sottrarsi Naditza?*
- Risposte: Un trasferimento all'estero · L'ingresso in convento · **Un matrimonio combinato** · Un debito di gioco
- Reveal: **Un matrimonio combinato**

**CTA**
- Link: `https://somto.it/quiz-prova.html?titleId=mare-fuori`

**Caption**: Chi prende 3 su 3 mi scrive il personaggio preferito 🔵 #marefuori #quiz #ipm #somto

---

## Script 4 — Dragon Ball

> 200 domande in archivio fra Dragon Ball, Z e Super. Il pubblico anime italiano
> commenta molto e corregge: perfetto per l'algoritmo.

**HOOK**
- A schermo: `QUANTO NE SAI DI DRAGON BALL?`
- VO: «Tre domande. La terza è dalla serie originale, non da Z.»

**DOMANDA 1 — facile** (`q_86_7`)
- Domanda: *Qual è la tecnica più iconica di Goku, con le mani a coppa?*
- Risposte: Genkidama · Cannone Galick · Kaioken · **Kamehameha**
- Reveal: **Kamehameha**

**DOMANDA 2 — media** (`q_201_26`)
- Domanda: *Quale personaggio cambia personalità ogni volta che starnutisce?*
- Risposte: Mai · **Lunch** · Bulma · Chichi
- Reveal: **Lunch** — «bionda e cattiva, mora e gentile.»

**DOMANDA 3 — difficile** (`q_201_36`)
- Domanda: *Per quale motivo meschino il Comandante Red vuole le Sfere del Drago?*
- Risposte: **Diventare più alto** · Resuscitare un amico · Fermare Piccolo · Diventare immortale
- VO: «Ultima. E la risposta è ridicola.»
- Reveal: **Diventare più alto** — «tutto l'Esercito del Nastro Rosso, per venti centimetri.»

**CTA**
- Link: `https://somto.it/quiz-prova.html?titleId=tmdb_tv_12609`

**Caption**: Il motivo di Red è la cosa più assurda dell'anime 🐉 #dragonball #anime #quiz #somto

---

## Script 5 — I Cesaroni

> 121 domande, il titolo più coperto dell'intero archivio. Nostalgia italiana
> pura, pubblico 25-40, nessun concorrente ci fa quiz sopra.

**HOOK**
- A schermo: `QUANTO NE SAI DEI CESARONI?`
- VO: «Se hai passato i pomeriggi alla Garbatella, tre domande.»

**DOMANDA 1 — facile** (`family_classics_cesaroni_013`)
- Domanda: *Come si chiama il fratello di Giulio?*
- Risposte: Ezio · **Cesare** · Sergio · Augusto
- Reveal: **Cesare**

**DOMANDA 2 — media** (`family_classics_cesaroni_026`)
- Domanda: *Di chi si innamora Marco fin dall'inizio della serie?*
- Risposte: Marta Cesaroni · **Eva Cudicini** · Carlotta Alberti · Lucia Liguori
- Reveal: **Eva Cudicini**

**DOMANDA 3 — difficile** (`family_classics_cesaroni_075`)
- Domanda: *Come si chiamava il gruppo musicale di Giulio, Cesare ed Ezio da giovani?*
- Risposte: Senza Nome · **Gladiators** · Flaminio Maphia · Romulana
- VO: «Questa la sanno in tre.»
- Reveal: **Gladiators** — «Senza Nome è la band dei ragazzi, non la loro.»

**CTA**
- Link: `https://somto.it/quiz-prova.html?titleId=z3rLPYOstLsgH50OJ804`

**Caption**: 121 domande sui Cesaroni. Centoventuno. 🏠 #icesaroni #garbatella #quiz #nostalgia #somto

---

## Script 6 — Il Re Leone

> Pubblico ampio, buono per allargare fuori dalla nicchia serie TV.

**HOOK**
- A schermo: `QUANTO NE SAI DEL RE LEONE?`
- VO: «Lo hai visto cinquanta volte da bambino. Tre domande.»

**DOMANDA 1 — facile** (`q_125_3`)
- Domanda: *Che animale è Pumbaa?*
- Risposte: Cinghiale · Ippopotamo · **Facocero** · Rinoceronte
- Reveal: **Facocero** — «non cinghiale. Facocero.»

**DOMANDA 2 — media** (`q_125_8`)
- Domanda: *Come si chiama la madre di Simba?*
- Risposte: **Sarabi** · Sarafina · Nala · Kiara
- Reveal: **Sarabi** — «Sarafina è la mamma di Nala.»

**DOMANDA 3 — difficile** (`q_125_13`)
- Domanda: *A quale opera di Shakespeare si ispira la trama?*
- Risposte: **Amleto** · Macbeth · Otello · Il Re Lear
- Reveal: **Amleto** — «zio che uccide il re e usurpa il trono, figlio che torna a vendicarlo.»

**CTA**
- Link: `https://somto.it/quiz-prova.html?titleId=tmdb_movie_8587`

**Caption**: Quella su Pumbaa la sbagliano tutti 🦁 #ilreleone #disney #quiz #somto

---

## Varianti di formato da provare dopo i primi sei

- **"Solo i veri fan"** — una domanda sola, molto difficile, 12 secondi. Costa
  niente da produrre e si testa in serie da cinque.
- **Risposta nei commenti** — non si rivela la terza risposta nel video, si mette
  fissata nei commenti. Alza i commenti, irrita una parte del pubblico: da
  usare con parsimonia.
- **Duello** — due titoli a confronto ("Sei più Trono di Spade o più House of the
  Dragon?"), tre domande miste, si conta chi vince. Buono per i sondaggi.
- **Sbagliata di proposito** — si dà una risposta sbagliata nel reveal e si
  aspettano le correzioni. Funziona benissimo sull'anime. Rischio: sembrare
  inaffidabili, quindi mai sul video di punta.

## Cosa serve dall'app prima di pubblicare

1. **Link di saga.** Oggi "Quanto ne sai di Harry Potter" atterra su un singolo
   film: il video promette la saga, il link dà un titolo. È il primo lavoro da
   fare (vedi audit, Finding 4: i dati per raggruppare ci sono già).
2. **Verifica accenti sulle domande usate.** Le sei sopra sono corrette nel
   testo di questo file, ma in app alcune si vedono ancora senza accenti.
3. **Contatore reale.** Nella CTA dire il numero vero di domande del titolo
   (Harry Potter 396, Cesaroni 121, Dragon Ball 200 fra le tre serie): il numero
   grosso è metà del motivo per cui uno clicca.
4. **Guest play su iOS non c'è.** Chi arriva da iPhone e scarica l'app deve
   registrarsi per giocare, mentre dal browser no. Finché è così, la CTA porta
   al sito, non allo Store.
