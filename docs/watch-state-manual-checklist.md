# Watch-State Manual Checklist

- Film: apri una scheda titolo, usa `Segna visto` senza voto e verifica che il titolo compaia tra i visti, che il profilo mostri minuti/ore aggiornati e che iOS mostri lo stesso totale.
- Film votato: assegna un voto titolo e verifica che il feed/notifiche rating continuino a funzionare, mentre `titleStates` passi a `rated` senza logica client-side aggiuntiva.
- Serie in progresso: dalla scheda titolo usa `+1 episodio` e `+1 stagione`, poi verifica che il progresso personale sia visibile nella UI stagioni/episodi e che il titolo non dipenda da rating episodio/stagione.
- Serie completata senza voto: usa `Segna completata` e verifica stato `completed_unrated`, presenza coerente in web/iOS e minuti cumulati nel profilo.
- Serie completata con voto: assegna poi un voto titolo e verifica transizione a `rated` senza perdere `completedCount`, minuti o compatibilità con `library/watchlist`.
- Rewatch film: su un film già visto usa `Aggiungi a rewatch`, poi `Segna rewatch`; verifica incremento di `completedCount`, `rewatchCount` profilo e `totalWatchMinutes`.
- Rewatch serie: su una serie completata usa `Aggiungi a rewatch`, avanza con `+1 episodio`, poi completa; verifica che i minuti non diminuiscano durante il rewatch e che aumentino ancora a completamento.
- Profilo web: verifica che `Ore viste` arrivi da `users.stats.totalWatchMinutes` e non da somme locali della `library`.
- Profilo iOS: verifica che il totale minuti/ore coincida con il web sullo stesso account, con fallback locale solo se `users.stats` è assente.
- Backfill: esegui `npm run backfill:title-states-metrics -- --write` da `functions/`, poi controlla alcuni utenti legacy.
- Audit: esegui `npm run audit:title-states` da `functions/` e risolvi eventuali utenti con `stats` mancanti, `library` incoerente o metadata TV insufficienti.
