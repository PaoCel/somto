# Baseline citazioni AI — 29 luglio 2026

## Cosa ho potuto misurare e cosa no

**Non posso interrogare ChatGPT, Perplexity e Gemini**: non ho accesso a quei
modelli. La rilevazione diretta va fatta a mano — è gratis, servono ~20 minuti
per giro, e resta il pezzo più noioso di tutto il sistema (la guida di Amadora
lo dice apertamente, ed è il motivo per cui vendono il loro strumento).

Quello che **ho** potuto misurare è il livello sotto, che nei modelli con
ricerca web determina in larga parte la risposta: **cosa trova un motore di
ricerca sulle nostre query di acquisto.** Se le fonti non ci nominano, i
modelli che le leggono non ci nominano.

## Cosa ho verificato

| Query | Somto compare? | Chi occupa la risposta |
|---|---|---|
| "app per tenere traccia dei film e serie tv viste" | **no** | TV Time, Movie Tracker, Letterboxd, Series Guide, JustWatch |
| "alternativa a TV Time app serie tv italiana 2026" | **no** | Trakt, Serializd, Simkl, Sofa Time, SeriesGuide, Showly, Next Episode, Moviebase |
| "somto app film serie tv watchlist italiana" | **sì** | somto.it e il nostro blog in cima |

Traduzione: **esistiamo solo per chi già ci conosce.** Su tutte le query di
scoperta e di migrazione — quelle che portano utenti nuovi — non compariamo.

## Le fonti che i modelli leggono, e cosa dicono

Le liste di alternative a TV Time in italiano, tutte pubblicate intorno al
2 luglio 2026:

| Fonte | App citate | Somto |
|---|---|---|
| saggiamente.com | Refract, Sofa Time, Kineo, Serializd, SIMKL | assente |
| daninseries.it | 12 app: Trakt, Serializd, Sofa Time, Simkl, Refract, BetaSeries, BingeBoxd, SeriesGuide, Cynopsys, Showly, Next Episode, CouchTime | assente |
| iphoneitalia.com | (lista alternative) | assente |
| tuttoandroid.net | (lista alternative) | assente |
| hallofseries.com | 5 app | assente |
| alternativeto.net | oltre 50 voci | assente |

**Nessuna delle app citate è italiana.** È lo spazio libero più grande che
abbiamo, e nessun concorrente può occuparlo.

Dettaglio che vale il piano intero: daninseries dichiara che la sua lista viene
da "discussioni, classifiche e consigli" su Reddit e X, non da prove sul campo.
Le liste giornalistiche sono a valle della community. Il punto di leva è Reddit
e alternativeto.net, non le redazioni — quelle vengono dopo, da sole.

## Il punteggio di partenza

**0 citazioni su 6 fonti** che dominano le query di migrazione.
**0 apparizioni su 2 query di scoperta su 2.**

La guida dice che la maggior parte dei marchi parte sotto il 20%. Noi siamo a
zero, il che è coerente con un prodotto giovane di cui nessuna fonte parla.

## L'unica azione da fare adesso

Farsi inserire su **alternativeto.net** come alternativa a TV Time. È la fonte
con più autorità delle sei, è ad inserimento libero, è gratis e si fa in 45
minuti. Procedura in `seo/outreach/directory-e-community.md`.

## Da rifare a mano (gratis, ~20 minuti)

Chiedi le stesse domande a ChatGPT, Perplexity e Gemini, prendendo le prime tre
righe di `seo/ai-visibility/buyer-queries.csv`, e segna per ciascuna se Somto
compare e in che posizione. Registra il risultato in
`seo/competitors/share-of-voice.csv`. È il numero "prima" contro cui misureremo
tutto fra un mese.
