# Voce editoriale di Somto

Ultimo aggiornamento: 2026-08-12.

Questa guida serve a scrivere contenuti editoriali che mantengano la voce di
Paolo. Non sostituisce la verifica delle fonti e non autorizza la pubblicazione
automatica.

## Da dove viene

Il profilo è stato ricavato da cinque raccolte di soli messaggi inviati da
Paolo tra il 2019 e il 2026. Nell'analisi:

- hanno avuto più peso i messaggi dal 2024 in poi;
- le cinque chat sono state bilanciate per evitare che quella più grande
  dominasse il risultato;
- sono stati distinti i tratti ricorrenti dalle abitudini legate a una sola
  persona o situazione;
- non sono stati copiati nel repository messaggi, nomi, link, recapiti o altri
  dettagli personali.

I contenuti Somto già esistenti sono stati usati come controllo per tradurre
questi tratti dalla conversazione ai diversi formati editoriali.

I messaggi originali non sono una fonte editoriale e non vanno inseriti nel
repository.

## La voce in una frase

Una persona appassionata che ha controllato i fatti, si è fatta un'idea e la
racconta come la racconterebbe a qualcuno che conosce, senza mettersi in posa da
critico e senza provare a vendere entusiasmo.

## Tratti fondamentali

### 1. Il ragionamento si deve sentire

Paolo non consegna soltanto una conclusione. Fa capire da dove arriva: parte da
un fatto, aggiunge quello che gli fa pensare e chiude con una conseguenza
concreta.

Connettivi naturali: `però`, `quindi`, `perché`, `comunque`, `in realtà`,
`alla fine`, `forse`, `secondo me`. Sono parte della voce, ma non devono
comparire tutti nello stesso paragrafo.

### 2. Prima le cose concrete

Meglio una data, un dettaglio del cast, una scelta produttiva o un confronto
preciso di un aggettivo generico. Se non c'è ancora abbastanza da dire, il
contenuto non va gonfiato.

### 3. L'opinione è esplicita, non assoluta

Formule come `secondo me`, `credo`, `mi sembra` e `forse` non sono debolezza:
distinguono un giudizio da un fatto. Quando una cosa è certa, invece, va detta
direttamente.

### 4. Il tono è tra pari

Paolo parla con chi legge, non a chi legge. Può fare una domanda vera, ammettere
un dubbio o dire che una cosa gli è piaciuta. Non insegna al pubblico come deve
sentirsi e non usa il plurale finto da presentatore.

Riconoscibile non significa confidenziale. Nei post la prima persona non è il
modo predefinito per dare voce al testo e non vanno aggiunti dettagli privati.
Usarla solo quando Paolo fornisce un'esperienza o un'opinione e vuole renderla
pubblica.

### 5. L'ironia è osservazione

Funziona quando nasce da un dettaglio, da una contraddizione o da
un'esagerazione riconoscibile. Non servono battute aggiunte a fine paragrafo e
non bisogna forzare il dialetto per sembrare spontanei.

### 6. Il testo respira

Frasi prevalentemente brevi o medie. Paragrafi brevi. Una frase molto corta può
isolare il punto importante, ma non ogni due righe. Gli elenchi servono per
orientare, non per dare al testo una falsa aria di completezza.

## Come adattarla ai formati Somto

### Aggiornamento ufficiale

- Aprire con la notizia, non con un'introduzione.
- Spiegare subito perché conta per chi segue quel titolo.
- Aggiungere al massimo un'osservazione o una domanda autentica.
- Niente entusiasmo automatico: una data non è sempre una grande notizia.

#### Se la notizia è già successa, cambia voce

Un aggiornamento pubblicato con più di due giorni di ritardo **non è più un
annuncio**: chi legge o l'ha già vista o se l'è persa. La notifica ripete il
sommario, quindi "la quarta stagione è iniziata su Apple TV" arriva a chi la
stagione l'ha iniziata dieci giorni prima e suona come una app che non sa cosa
sta guardando.

- Voce di annuncio (entro ~48h): *"Ted Lasso 4 è iniziata su Apple TV. Questa
  volta Ted allena una squadra femminile."*
- Voce di richiamo (dopo): *"Hai iniziato Ted Lasso? Nuovi episodi dal 4 agosto:
  questa volta Ted allena una squadra femminile."*

Il richiamo dice **la data esatta** e parte da chi legge, non dal fatto.
La console lo segnala da sola: su un `new_season` con la stagione già partita,
l'anteprima e la conferma di pubblicazione mostrano l'avviso calcolato da
`officialUpdateStaleness` (`functions/lib/officialUpdates.js`). È un avviso,
non un blocco: il testo lo riscrive chi pubblica.

### Post editoriale

- Scegliere un solo angolo.
- Non usare la prima persona per far sembrare il post più umano.
- Usarla soltanto quando c'è davvero un'esperienza o un'opinione di Paolo
  destinata alla pubblicazione.
- Lasciare almeno un dettaglio su cui il lettore possa farsi una propria idea.
- Chiudere con una domanda solo se Paolo avrebbe davvero voglia di leggere le
  risposte.

### Articolo blog

- Partire da un problema, un'esperienza o un'idea concreta.
- Procedere per passaggi logici visibili, come in un ragionamento parlato ma
  ripulito.
- Alternare fatti e giudizi senza confonderli.
- Usare esempi specifici e arrivare a una conclusione utile, non a una morale.
- Inserire Somto dove risolve davvero il problema raccontato, non come blocco
  promozionale appiccicato alla fine.

## Intensità della voce

La stessa voce cambia leggermente in base al contenuto:

| Formato | Personale | Ironia | Dialetto | Emozioni | Dettaglio |
| --- | --- | --- | --- | --- | --- |
| Aggiornamento ufficiale | basso | basso | assente | basso | essenziale |
| Post editoriale | medio | medio | quasi assente | medio | selettivo |
| Articolo in prima persona | alto | medio | leggero, se naturale | alto | concreto |
| Guida SEO | medio | basso | assente | medio | alto |

`Rega`, le forme romanesche troncate e le espressioni da gruppo di amici non
sono vietate in assoluto, ma non rappresentano da sole la voce. Usarle soltanto
quando il contesto le rende inevitabili; mai come decorazione.

## Segnali che il testo sta diventando artificiale

Riscrivere se compaiono uno o più di questi segnali:

- apertura come `Preparatevi`, `È finalmente arrivato il momento` o
  `Gli amanti di... possono gioire`;
- aggettivi non dimostrati: `imperdibile`, `attesissimo`, `iconico`,
  `mozzafiato`, `epico`, `incredibile`;
- formule come `un viaggio emozionante`, `non resta che attendere`,
  `promette scintille` o `farà parlare di sé`;
- tre frasi consecutive costruite tutte allo stesso modo;
- abuso di contrasti prefabbricati: `non è solo X, è Y`;
- frasi che annunciano la propria analisi, la spiegano dopo i due punti e
  chiudono con un contrasto ordinato: `È questo il dettaglio che...: prima X,
  adesso Y`;
- interpretazioni aggiunte soltanto per far sembrare più profonda una trama che
  può essere raccontata direttamente;
- elenchi da tre elementi usati per dare ritmo anche quando non servono;
- troppe domande retoriche o domande di chiusura senza una risposta davvero
  interessante;
- tono da comunicato stampa, da enciclopedia o da fan account;
- opinioni attribuite a Paolo che Paolo non ha espresso;
- una sicurezza maggiore di quella consentita dalle fonti;
- invito forzato a commentare, condividere o aggiungere alla watchlist;
- emoji decorative, punti esclamativi ripetuti o maiuscole promozionali.

## Metodo di scrittura

1. Separare fatti verificati, dubbi e opinioni.
2. Decidere in una frase perché vale la pena parlarne adesso.
3. Scegliere il dettaglio che rende la notizia meno generica.
4. Scrivere una prima versione diretta, senza cercare subito una frase a
   effetto.
5. Aggiungere il punto di vista di Paolo solo se è noto o può essere validato.
6. Rileggere ad alta voce e togliere tutto ciò che suona come pubblicità o come
   una persona che prova a sembrare Paolo.

Se manca il punto di vista personale, fare una domanda precisa a Paolo invece
di inventarlo. Esempi: `Ti interessa più il legame con il DCU o il tono crime?`
oppure `Hai già visto la prima stagione e vuoi dirne qualcosa?`.

## Prova rapida

Prima di consegnare un testo, verificare:

- Direbbe questa cosa anche in una conversazione?
- Il giudizio appartiene davvero a Paolo?
- C'è almeno un dettaglio concreto?
- Si capisce quali parti sono fatti e quali opinioni?
- Ho lasciato qualche frase soltanto perché “suona bene”?
- La stessa notizia poteva essere pubblicata identica da qualunque pagina di
  cinema e serie TV?

Se l'ultima risposta è sì, manca ancora la voce.

## Esempio di calibrazione

Troppo generico:

> Il nuovo attesissimo capitolo del DCU sta finalmente per arrivare. Preparatevi
> a un viaggio ricco di mistero e azione che promette di conquistare tutti i
> fan.

Più vicino a Paolo:

> *Lanterns* arriva il 17 agosto su HBO Max, con un episodio a settimana. La
> cosa che mi incuriosisce è che, almeno da come l'hanno presentata, sembra più
> una serie crime che il solito racconto di supereroi. E forse è proprio la
> scelta giusta per far funzionare Lanterna Verde anche fuori dai fumetti.

La seconda versione non va pubblicata automaticamente: la frase in prima
persona richiede che Paolo condivida davvero quell'opinione e tutti i fatti
devono essere verificati al momento della pubblicazione.

## Manutenzione

Questa guida è una prima versione, non una gabbia. Dopo ogni contenuto:

- annotare le correzioni di Paolo che rivelano una preferenza stabile;
- non trasformare in regola una singola modifica occasionale;
- conservare pochi esempi approvati, scelti per formati diversi;
- aggiornare la guida quando la voce editoriale evolve.

La prova decisiva non è la somiglianza statistica con le chat. È che Paolo legga
il testo e non senta il bisogno di tradurlo di nuovo nella propria lingua.
