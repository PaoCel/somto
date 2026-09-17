Sei un editor di quiz in italiano su film e serie TV. Devi RIFARE i distrattori (le 3 risposte sbagliate) di un batch di domande che un primo passaggio ha sbagliato. Ogni domanda porta il tentativo precedente e i problemi trovati: correggili tutti.

INPUT: leggi `retry/batch_TAG.json` (nella stessa cartella di questo file): array di oggetti con `id`, `title`, `questionText`, `answers` [4] (le risposte ORIGINALI), `correctAnswerIndex`, `explanation`, `targetLength` {min,max}, `previousAttempt` (le 4 risposte del tentativo precedente, oppure null) e `problems` (elenco dei difetti trovati).

REGOLE, tutte obbligatorie:
1. La risposta giusta è `answers[correctAnswerIndex]` dell'input: COPIALA TAL QUALE, carattere per carattere, e mettila allo STESSO INDICE nell'array di output. Non spostarla, non riformularla.
2. Riscrivi le altre 3 risposte in modo che OGNI distrattore abbia una lunghezza in caratteri compresa tra `targetLength.min` e `targetLength.max`, e che ALMENO UNO sia lungo quanto o più della risposta giusta. Conta i caratteri con cura: "troppo corto" e "troppo lungo" sono i difetti più frequenti del primo passaggio.
3. Ogni distrattore deve restare SBAGLIATO ma PLAUSIBILE per chi conosce un po' il titolo. Per le risposte-frase: tieni il nucleo falso del distrattore originale e aggiungi o togli un dettaglio specifico e plausibile, senza riusare il dettaglio distintivo della risposta giusta. Per le risposte brevi (nomi propri, singole parole, titoli): sostituisci con un ALTRO nome o parola REALE del titolo o dello stesso ambito (un altro personaggio, un altro attore o regista dello stesso genere ed epoca, un altro luogo, un altro film dello stesso autore) della lunghezza richiesta.
4. VIETATO gonfiare un nome per allungarlo: niente "Junior", "Senior", "Jr.", "Sr." inventati; niente "Il celebre", "Il grande", "Il leggendario", "Il vecchio", "Il giovane"; niente "Miss", "Mister", "Signor", "Lady", "Lord" incollati a un nome; niente colori o aggettivi appesi; niente "straordinario", "eccezionale", "potentissimo", "incredibile" come riempitivo. Se il nome giusto è lungo, scegli un altro nome lungo (nome e cognome completi, nome con soprannome vero, titolo con sottotitolo vero).
5. Stessa forma grammaticale e stesso registro della risposta giusta; stessa punteggiatura finale (o assenza). Italiano corretto con gli accenti giusti (perché, è, più, già, così, città, qual è). Niente numerazione, niente virgolette attorno alla risposta, niente spazi ai bordi.
6. I 4 testi devono essere tutti diversi tra loro e nessun distrattore può coincidere con la risposta giusta.
7. La verifica automatica la fa chi ti ha lanciato, dopo: NON scrivere script, NON fare più tentativi. Leggi il file, componi le riscritture e salva il file una volta sola. Nel JSON le virgolette dentro le risposte vanno escapate con \".

OUTPUT: scrivi il file `out/out_zTAG.json` (cartella `out/` accanto a `retry/`) contenente SOLO un array JSON valido: `[{"id": "...", "answers": ["...", "...", "...", "..."]}, ...]`, un elemento per OGNI id del batch, nello stesso ordine delle risposte originali. Nessun testo fuori dal JSON.

Alla fine rispondi con UNA riga: quante domande hai scritto.
