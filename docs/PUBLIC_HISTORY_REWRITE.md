# Bonifica della cronologia prima della pubblicazione

La cronologia privata contiene revisioni precedenti con identificativi utente,
account QA, path personali e vecchi script operativi. Cancellare o anonimizzare
questi dati sul branch corrente non li rimuove dagli oggetti Git.

La riscrittura della history è quindi un gate obbligatorio prima di cambiare
visibilità. Non è una normale operazione di sviluppo: cambia gli SHA, richiede
un force-push coordinato e invalida cloni, branch e pull request basati sulla
cronologia precedente.

## Preparazione

1. Congelare push e merge e concordare una finestra di manutenzione.
2. Committare la preparazione pubblica e annotarne lo SHA.
3. Creare un backup mirror verificato e conservarlo in uno spazio privato.
4. In un clone nuovo installare `git-filter-repo`.
5. Generare fuori dal repository due manifest privati:
   - i path degli script operativi e degli asset privati eliminati dal commit
     di preparazione;
   - le sostituzioni esatte per identificativi, account e valori storici.

I manifest non devono essere committati. Il primo può essere derivato con
`git diff --diff-filter=D --name-only <parent> <commit-preparazione>` e poi
limitato ai soli script operativi e asset privati da rimuovere da ogni
revisione.

## Riscrittura

Nel clone dedicato, usare `git filter-repo --sensitive-data-removal` per:

- rimuovere da ogni ref i path elencati nel manifest privato;
- sostituire email, UID, account QA, path home, identificativi di fatturazione
  e la credenziale TMDB già ruotata;
- eliminare ref obsolete che non devono essere pubblicate.

Non eseguire la riscrittura nel checkout di lavoro. Non pubblicare i manifest o
i valori trovati nei log della CI.

## Verifica prima del force-push

```bash
gitleaks git . --config .gitleaks.toml --redact --verbose
npm run check:public:history
git fsck --full
```

Ispezionare inoltre nomi di file e tag, perché una scansione del contenuto non
può stabilire se un nome appartenga a una persona reale.

## Pubblicazione della nuova history

Solo dopo approvazione esplicita del titolare:

1. riaggiungere il remote rimosso da `git-filter-repo`;
2. aggiornare tutti i ref remoti con force-push coordinato;
3. eliminare eventuali ref GitHub non riscritti e chiedere la rimozione delle
   cache quando applicabile;
4. far riclonare il repository a ogni collaboratore;
5. ripetere Gitleaks e i gate da un clone anonimo nuovo.

Il repository può diventare pubblico solo dopo questi controlli. Tornare
privato in seguito non revoca fork o cloni già creati.
