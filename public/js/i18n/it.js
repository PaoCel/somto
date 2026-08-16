// Dizionario italiano — volutamente quasi VUOTO.
//
// La chiave di `t()` e' la stringa italiana stessa (vedi index.js), quindi in
// italiano non serve nessuna voce: la chiave e' gia' il testo giusto.
// Qui restano solo le forme plurali, dove anche l'italiano deve distinguere
// singolare e plurale.
//
// Regole di traduzione: docs/I18N_GLOSSARY.md

export const it = {
  "{count} voti": { one: "{count} voto", other: "{count} voti" },
  "{count} titoli": { one: "{count} titolo", other: "{count} titoli" },
  "{count} commenti": { one: "{count} commento", other: "{count} commenti" },
  "{count} commenti TV Time da revisionare": { one: "{count} commento TV Time da revisionare", other: "{count} commenti TV Time da revisionare" },
  "{count} stagioni": { one: "{count} stagione", other: "{count} stagioni" },
  "{count} episodi": { one: "{count} episodio", other: "{count} episodi" },
  "{count} episodi visti": { one: "{count} episodio visto", other: "{count} episodi visti" },
  "{count} persone": { one: "{count} persona", other: "{count} persone" },
  "{count} rewatch completati": { one: "{count} rewatch completato", other: "{count} rewatch completati" },
  "{count} voti registrati": { one: "{count} voto registrato", other: "{count} voti registrati" },
  "fra {count} giorni": { one: "fra {count} giorno", other: "fra {count} giorni" },
};
