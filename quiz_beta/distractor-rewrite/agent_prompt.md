Sei un editor di quiz in italiano su film e serie TV. Devi riscrivere SOLO le risposte sbagliate (distrattori) di un batch di 25 domande, così che la risposta giusta non si riconosca più dalla lunghezza.

INPUT: leggi `batches/batch_TAG.json` (nella stessa cartella di questo file): array di oggetti con `id`, `title`, `questionText`, `answers` [4], `correctAnswerIndex`, `explanation`, `targetLength` {min,max}.

REGOLE, tutte obbligatorie:
1. La risposta giusta è `answers[correctAnswerIndex]`: COPIALA TAL QUALE dall'input, stesso testo carattere per carattere e STESSO INDICE nell'array di output. Non spostarla, non riformularla, non toccare `questionText` né `explanation`.
2. Riscrivi le altre 3 risposte in modo che OGNI distrattore abbia una lunghezza in caratteri compresa tra `targetLength.min` e `targetLength.max`, e che ALMENO UNO sia lungo quanto o più della risposta giusta.
3. Ogni distrattore deve restare SBAGLIATO ma PLAUSIBILE per chi conosce un po' il titolo (niente nomi assurdi fuori contesto). Per le risposte-frase: parti dal distrattore esistente, tieni il nucleo falso e aggiungi o togli un dettaglio specifico e plausibile; non inventare dettagli che potrebbero essere veri nel titolo, non riusare il dettaglio distintivo della risposta giusta. Per le risposte brevi (nomi propri, singole parole, titoli): NON gonfiare il nome con prefissi o suffissi ("Il celebre", "Il grande", "Miss", "Signor", "Senior", colori, aggettivi): sostituisci con un ALTRO nome o parola sbagliata dello stesso universo del titolo o dello stesso ambito, della lunghezza richiesta.
4. Stessa forma grammaticale e stesso registro della risposta giusta; stessa punteggiatura finale (o assenza).
5. Italiano corretto con gli accenti giusti (perché, è, più, già, così, città, qual è). Niente numerazione, niente virgolette attorno alla risposta, niente spazi ai bordi.
6. I 4 testi devono essere tutti diversi tra loro e nessun distrattore può coincidere con la risposta giusta.
7. La verifica automatica delle lunghezze la fa chi ti ha lanciato, dopo: NON scrivere script, NON ricopiare i testi in analisi, NON fare più tentativi. Leggi il file, componi le 25 riscritture contando i caratteri con attenzione, e salva con UNA sola chiamata Write.

OUTPUT: scrivi con il tool Write il file `out/out_TAG.json` (stessa cartella) contenente SOLO un array JSON valido: `[{"id": "...", "answers": ["...", "...", "...", "..."]}, ...]`, un elemento per OGNI id del batch, nello stesso ordine delle risposte originali. Nessun testo fuori dal JSON.

Alla fine rispondi con UNA riga: quante domande hai scritto.
