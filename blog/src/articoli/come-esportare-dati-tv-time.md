---
slug: come-esportare-dati-tv-time
title: "TV Time ha chiuso: cosa fare con i tuoi dati (e se non li hai esportati)"
description: "TV Time ha chiuso il 15 luglio 2026 e il tool di export non risponde più. Dove ritrovare l'archivio se l'avevi richiesto, cosa contiene file per file, cosa tentare se non l'hai scaricato in tempo e come riportare la cronologia in vita."
date: 2026-07-30
kicker: "Guida TV Time"
readingTime: "Lettura ~6 min"
lede: "TV Time ha chiuso il 15 luglio 2026 e lo strumento ufficiale di export non è più raggiungibile. Se l'archivio l'avevi richiesto in tempo, hai in mano anni di cronologia: ecco come usarlo. Se non l'hai fatto, qui trovi cosa si può ancora tentare — senza promesse false."
ctaTitle: "La tua cronologia merita una casa"
ctaText: "Su Somto importi l'export di TV Time — episodi, voti, rewatch, watchlist — e continui a tracciare film e serie su web e iOS, gratis."
relatedSlugs:
  - migliori-app-tenere-traccia-film-serie-tv
  - come-organizzare-watchlist-film-serie-tv
---

**Aggiornamento del 30 luglio 2026.** Questa guida è nata prima della chiusura, quando l'export era ancora possibile. Ora la situazione è cambiata: TV Time ha terminato il servizio il **15 luglio 2026** — lo aveva annunciato la <a href="https://whipmedia.freshdesk.com/support/solutions/articles/68000029988-tv-time-is-shutting-down">pagina ufficiale di supporto</a> — e il tool di export self-service (`gdpr.tvtime.com`) **non risponde più**: lo abbiamo verificato direttamente. L'app è stata rimossa dagli store.

Quindi oggi le strade sono due, e dipendono da una sola domanda: **hai richiesto l'export prima della chiusura?**

## Se hai l'export: ritrovalo e mettilo al sicuro

L'archivio che TV Time generava è un file compresso, quasi sempre uno `.zip`. Se l'avevi richiesto, non serve altro: è la copia completa della tua cronologia. Prima di tutto ritrovalo:

- cerca nella **email** dell'account TV Time: il link di download o la conferma della richiesta;
- guarda nella cartella **Download** del computer o del telefono da cui l'avevi richiesto;
- controlla il cloud (Drive, iCloud, Dropbox) se hai l'abitudine di salvarci i backup.

Trovato? Fai una verifica rapida:

- il file non deve pesare zero byte;
- l'archivio deve aprirsi senza errori;
- dentro devono esserci file leggibili (`.csv`, `.json` o simili): sono quelli che contano per un import;
- cerca riferimenti a serie, film o episodi che sai di aver tracciato.

## Cosa contiene l'export

Il contenuto esatto cambia da account ad account (gli account più vecchi hanno spesso un export più ricco). In generale l'archivio può includere:

- serie e film tracciati;
- episodi segnati come visti, con le date;
- rivisioni (rewatch) di serie e film;
- watchlist e liste salvate;
- voti, reazioni e commenti;
- dati dell'account e impostazioni.

Tieni l'archivio originale **intatto** ed estrai una copia in una cartella separata per guardarci dentro. Una struttura semplice che funziona:

```text
TV-Time-export-2026/
  originale/
    tv-time-export.zip
  estratto/
    ...
  note.txt
```

Nel file `note.txt` scrivi l'email usata per l'account e la data dell'export. Sembra banale, ma tra qualche mese ti ringrazierai.

## Se non hai l'export: cosa si può ancora tentare

Qui serve onestà: **la via automatica non esiste più.** Il tool self-service è irraggiungibile e con l'app chiusa non c'è un'altra procedura ufficiale documentata. Le opzioni rimaste:

1. **Ricontrolla di non averlo.** È il caso più frequente: la richiesta era stata fatta mesi fa e lo ZIP è ancora in una email o in Download. Cerca "tvtime" e "gdpr" nella posta.
2. **Scrivi al supporto di TV Time** citando il diritto di accesso ai dati (articolo 15 del GDPR), che resta valido finché l'azienda conserva i tuoi dati. Nessuna garanzia di risposta, ma è un tentativo gratuito.
3. **Ricostruisci a memoria le cose che contano.** Sembra un ripiego, ma per la maggior parte delle persone i titoli davvero importanti sono qualche decina: su un'app nuova si risegnano in un pomeriggio. Aiutati con i profili streaming (Netflix, Prime) che mostrano la cronologia di visione.

## Cosa fare con l'export: importalo su Somto

Su **Somto** puoi caricare l'archivio di TV Time così com'è — lo ZIP intero, dalla [pagina di import](/import.html) — e ritrovare la tua cronologia in pochi minuti. Leggiamo solo la cronologia: email, password e altri dati personali non lasciano mai il tuo dispositivo.

Cosa portiamo dentro: i film e le serie che hai visto (con le date precise), il progresso delle serie stagione per stagione, i **rewatch**, la watchlist e — quando presenti nell'export — i voti (convertiti dalla scala a 5 stelle di TV Time in un voto 1-10, sempre modificabile) e le recensioni che hai scritto, con il flag spoiler preservato. Gestiamo anche i casi che di solito fanno inciampare gli importer: le antologie che TV Time accorpa in un'unica serie, i titoli con nomi non latini, gli export vecchi con nomi file diversi.

Non importiamo le reazioni/emozioni per episodio né i commenti senza un voto abbinato: TV Time non li rende comparabili al modello di voto di Somto.

Se stai ancora valutando dove spostarti, leggi il confronto tra le [migliori app per tenere traccia di film e serie TV](/blog/migliori-app-tenere-traccia-film-serie-tv/) e la pagina dedicata all'[alternativa a TV Time](/vieni-da-tv-time.html).

## Dove conservare l'export (anche dopo l'import)

Tratta l'export come un documento personale: dentro ci sono anni di abitudini di visione.

- tieni il file `.zip` originale senza rinominarlo in modo confuso;
- salva una seconda copia su un servizio cloud affidabile;
- salva, se puoi, anche una copia locale su computer o disco esterno;
- non caricare l'archivio su strumenti sconosciuti solo per "provare";
- se usi un importer, fallo solo su servizi di cui ti fidi.

L'import su Somto non consuma né modifica l'archivio: la copia resta tua, e i dati che importi restano [sempre esportabili](/privacy.html) anche da Somto. Quello che è successo con TV Time — dati chiusi dentro un servizio che sparisce — qui non può succederti.

## Checklist veloce

- hai ritrovato l'archivio `.zip` dell'export (email, Download, cloud);
- hai verificato che si apra e contenga file leggibili;
- ne hai una copia in cloud e una locale;
- l'hai importato su un servizio di cui ti fidi;
- se non hai l'export: hai scritto al supporto di TV Time e intanto hai risegnato i titoli che contano.

Il punto non è scegliere l'app perfetta. Il punto è non perdere anni di cronologia — e da oggi, non restare mai più chiuso dentro un servizio che può sparire.
