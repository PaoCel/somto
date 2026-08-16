# Glossario i18n IT → EN

Termbase condiviso per la traduzione di Somto. **Va letto prima di tradurre
qualunque stringa**, da persone e da agenti. Senza, cinque traduttori producono
cinque nomi diversi per la stessa cosa e l'app perde coerenza in una settimana.

Regola generale: **i nomi delle feature sono parte del prodotto, non testo**.
Se un termine è già inglese nell'interfaccia italiana, resta identico — non va
"ri-tradotto" né italianizzato.

## Invariati (brand e nomi di feature)

Non tradurre mai, in nessun contesto, e mantenere la capitalizzazione indicata.

| Termine | Nota |
|---|---|
| **Somto** | Nome del prodotto. Mai declinato, mai tradotto. |
| **Match** | La tab dello swipe. Non "Matching", non "Discover". |
| **Watchlist** | Già inglese nell'UI italiana. Una parola, minuscola dentro la frase. |
| **Rewatch** | Sostantivo e verbo. Non "re-watch". |
| **Superlike** | Una parola. |
| **Quiz** | Invariato anche al plurale (`quizzes` solo se davvero necessario). |
| **XP** | Maiuscolo, mai "exp" né "punti esperienza". |
| **streak** | Minuscolo dentro la frase. Non "serie", non "run". |
| **feed** | Minuscolo. |
| **thread** | Minuscolo. |
| **TV Time, Netflix, Trakt, TMDB** | Nomi di terze parti. |

## Da tradurre

| Italiano | Inglese | Nota |
|---|---|---|
| Visti | Watched | La griglia del profilo. Mai "Seen". |
| Da vedere | To watch | Stato watchlist. |
| Da votare | To rate | Stato watchlist. |
| Per te | For you | Sezione home. |
| Discussioni per te | Discussions for you | |
| Sfide | Challenges | Quiz. |
| Classifica | Leaderboard | Mai "Ranking". |
| Voto | Rating | È un 1-10, **mai "vote"**. |
| Vota | Rate | |
| Recensione | Review | |
| Consigli | Recommendations | Tra utenti. |
| Suggerimento flash | Quick pick | |
| Segna come visto | Mark as watched | |
| Titolo | Title | Film o serie. |
| Stagione / Episodio | Season / Episode | |
| Liste | Lists | Liste curate dall'utente. |
| Emozioni | Emotions | Le 12 chiavi canoniche sono **già** in inglese nel DB: tradurre solo le label. |
| Personaggi | Characters | Il pick positivo, mai un voto all'attore. |
| Aggiornamento ufficiale | Official update | Sistema editoriale. |
| Profilo guidato | Guided profile | **Mai "bot"**, in nessuna lingua. |
| Impostazioni | Settings | |
| Profilo | Profile | |
| Ricerca | Search | |
| Notifiche | Notifications | |
| Accedi | **Sign In** | Mai "Log in". Non e' una preferenza: il catalogo iOS ha gia' spedito "Sign In", e app e sito devono dire la stessa cosa per la stessa azione. |
| Registrati | Sign Up | |
| Esci | Sign Out | Coerente con Sign In. Non "Log out". |
| Entra | dipende dal contesto | **Non** e' il verbo di autenticazione. Sul gate anti-spoiler il catalogo lo rende "Continue". Cerca il call-site. |

## Anti-spoiler

| Italiano | Inglese |
|---|---|
| Contiene spoiler | Contains spoilers |
| Tocca per mostrare | Tap to reveal |
| Ho visto {titolo} | I've watched {title} |
| Protezione anti-spoiler | Spoiler protection |

## Una frase sola per un concetto solo (iOS e web)

**Se l'app e il sito dicono la stessa cosa, devono dirla con le stesse identiche
parole italiane.** Non e' pignoleria di stile: la chiave di traduzione *e'* la
stringa italiana, quindi due varianti dello stesso messaggio sono due chiavi,
due traduzioni da fare, due da mantenere, e due occasioni di divergere.

Esempi reali trovati in questo progetto:

| iOS | web | |
|---|---|---|
| `Thread non trovato.` | `Thread non trovato` | il punto finale raddoppia la chiave |
| `Salvataggio non riuscito` | `Salvataggio non riuscito.` | idem, al contrario |
| `Accedi per votare` | `Accedi per votare.` | idem |

Quindi, **scrivendo copy nuovo**:

1. Cerca prima se la frase esiste gia', in `ios/TwoWatch/Resources/Localizable.xcstrings`
   o in `public/js/i18n/en.js`. Se c'e', **riusala identica** invece di scriverne
   una variante.
2. Se devi proprio cambiarla, cambiala **su entrambe le piattaforme** insieme.
3. Preferisci la formulazione **piu' semplice e piu' corta** fra le due. Meno
   parole significa meno ambiguita' per chi traduce e meno rischio che le due
   superfici divergano al primo ritocco.
4. Non variare per gusto: "Nessun titolo trovato" e "Non ho trovato titoli"
   dicono la stessa cosa e costano il doppio.

Il guadagno e' composto: ogni frase condivisa si traduce una volta sola, per
sempre, in tutte le lingue future.

## Tono

L'italiano di Somto dà del **tu** ed è colloquiale ma non ammiccante
("Segni l'episodio e in un passaggio solo dai il voto"). L'inglese deve suonare
allo stesso modo: seconda persona, contrazioni ammesse (*you're*, *don't*),
frasi brevi. **Non** tradurre alla lettera i modi di dire — riscrivere l'intento.

Esempio: *"Se TV Time ti ha lasciato a piedi, qui ritrovi tutto"* →
*"If TV Time left you stranded, it's all here"*, non *"If TV Time left you on
foot..."*.

## Formattazione — non è traduzione, ma rompe uguale

- **Date**: mai `it-IT` hardcoded. Usare il locale corrente
  (`Intl.*` sul web, `Locale.current` su iOS). Oggi ci sono 26 chiamate hardcoded
  sul web e 6 su iOS.
- **Numeri**: il separatore decimale cambia (`8,5` → `8.5`).
  **Attenzione**: `RatingDisplayFormat.swift` scrive la virgola italiana dentro
  il *wire format* salvato sui post pubblici. Non è solo display — vedi la
  decisione aperta in `docs/I18N-ANALYSIS-2026-07-29.md` §7.
- **Plurali**: mai ternari a mano. iOS → `.stringsdict` o varianti del String
  Catalog; web → helper con `Intl.PluralRules`. Oggi ci sono 23 pluralizzazioni
  a mano su iOS e 12 sul web.
- **Ordine delle parole**: in 382 template literal web e 384 stringhe iOS la
  variabile sta *dentro* la frase, spesso in apertura
  (`${fromName} ti ha menzionato`). Il segnaposto va spostato, non sostituito
  in-place.

## Cosa NON tradurre

- Le chiavi canoniche nel database (emozioni, stati `titleStates`, `status` dei
  quiz): sono già in inglese e sono **dati**, non testo.
- Le 6 pagine admin/QA (`admin-*.html`, `people_avatars.html`,
  `support-import.html`): uso interno, restano in italiano.
- I contenuti scritti dagli utenti (post, recensioni, thread).
- Log, messaggi `console.*`, nomi di evento analytics.
