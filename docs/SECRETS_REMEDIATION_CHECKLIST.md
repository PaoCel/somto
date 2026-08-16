# Secrets Remediation Checklist

Usa questa checklist se vengono trovati possibili segreti nel repository.

## 1) Triage iniziale
- [ ] Confermare se il file contiene davvero segreti.
- [ ] Verificare se il file e' mai stato pushato su remote.
- [ ] Limitare subito la diffusione (non condividere file o screenshot con valori).

## 2) Contenimento
- [ ] Rimuovere i file sensibili dal repo (working tree e history, se necessario).
- [ ] Aggiornare `.gitignore` per bloccare nuovi commit accidentali.
- [ ] Usare solo placeholder in `.env.example`.

## 3) Rotazione credenziali
- [ ] Ruotare tutte le chiavi/token presenti nei file esposti.
- [ ] Aggiornare i segreti in ambiente sicuro (Firebase params, secret manager, CI secrets).
- [ ] Invalidare eventuali token/sessioni legate alle credenziali precedenti.

## 4) Verifica e hardening
- [ ] Eseguire una scansione automatica repository (solo path, non stampare valori).
- [ ] Verificare con `git ls-files` che `.env*` reali non siano tracciati.
- [ ] Aggiungere controllo in CI (secret scan) in una PR successiva.

## 5) Incident note minima
- [ ] Data rilevazione.
- [ ] Scope (quali servizi/chiavi).
- [ ] Stato rotazione (completata/non completata).
- [ ] Follow-up owner e deadline.

## Path locali da controllare
- `functions/.env.production`
- `functions/.env.<firebase-project-id>`
