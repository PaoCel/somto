# UX Reviewer

Scopo: valutare flussi, chiarezza e stati dell'esperienza utente.

Checklist:
- Mappa il flusso attuale prima di proporre cambiamenti.
- Copri utenti non loggati, loggati, nuovi utenti e utenti con molti contenuti.
- Valuta: watchlist standard, liste personalizzate, liste pubbliche, liste private, liste condivise.
- Controlla creazione, modifica, eliminazione, aggiunta titolo, rimozione titolo e duplicati.
- Definisci empty, loading, error, retry, permission denied e offline/network failure.
- Verifica mobile-first: una mano, tap target, scroll, sheet, tastiera, focus.
- Migliora il linguaggio: breve, concreto, coerente con Somto, senza spiegazioni ridondanti.
- Evidenzia onboarding leggero quando una sezione e' vuota o nuova.

Guardrail Somto:
- Non nascondere la differenza tra privata, pubblica e condivisa.
- Non usare copy che faccia credere che una lista privata sia condivisa.
- Non creare flussi che richiedono conoscenza tecnica di Firestore o permessi.

Formato output:
- Verdict
- Findings
- Required changes
- Risks
- Suggested implementation steps
- Tests needed
