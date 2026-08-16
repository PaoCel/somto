"use strict";

// Avvisi leggibili da mostrare all'utente a fine import.
//
// Un import puo' riuscire e aver comunque lasciato indietro qualcosa di
// grosso — ed e' il caso che ci e' costato piu' assistenza: l'export senza il
// file dei film importa tutte le serie, chiude con "completato", e dell'assenza
// dei film non fa parola. L'utente se ne accorge da solo giorni dopo, guardando
// la libreria, e scrive all'assistenza (successo tre volte a luglio 2026).
//
// Modulo PURO: nessun Firestore, nessuna I/O. Prende il risultato del parse +
// i conteggi del match e produce Array<{code, message}> gia' in italiano, che
// finalizeImportResults salva sull'import doc (`warnings`) e i client mostrano
// nel riepilogo.

// Oltre questa quota di righe non riconosciute vale la pena dirlo: sotto e'
// il normale rumore di titoli oscuri, sopra e' un problema di matching che
// l'utente deve poter vedere (e che noi possiamo recuperare col rematch).
const UNRESOLVED_WARN_RATIO = 0.2;
const UNRESOLVED_WARN_MIN = 20;

function countRowsByKind(rows = []) {
  let movies = 0;
  let episodes = 0;
  for (const row of rows) {
    if (row?.kind === "movie") movies += 1;
    else if (row?.kind === "tv_episode") episodes += 1;
  }
  return { movies, episodes };
}

function hasMoviesFileError(errors = []) {
  return errors.some((e) => /film vuot|header csv film/i.test(String(e?.reason || "")));
}

/**
 * @returns Array<{code: string, message: string}> — vuoto se non c'e' niente
 * da segnalare. L'ordine e' quello di importanza: i client possono mostrarne
 * solo il primo se hanno poco spazio.
 */
function buildImportWarnings({ source = "", rows = [], errors = [], matchedCount = 0, unresolvedCount = 0 } = {}) {
  const warnings = [];
  const { movies, episodes } = countRowsByKind(rows);
  const isTvTime = source === "tvtime_gdpr" || source === "tvtime_refract";

  // 1. Nessun film nell'export, ma le serie ci sono: o il file dei film non
  //    era nello ZIP (nome diverso, estrazione fallita), o l'account non ne
  //    aveva. Da qui non si distingue — e infatti il messaggio non lo afferma.
  if (isTvTime && movies === 0 && episodes > 0) {
    warnings.push({
      code: "no_movies_in_export",
      message: hasMoviesFileError(errors)
        ? "Nel file caricato non c'era nessun film: sono state importate solo le serie. Se su TV Time seguivi anche i film, scrivici e li recuperiamo."
        : "Non abbiamo trovato film nell'export: sono state importate solo le serie.",
    });
  }

  // 2. Troppi titoli non riconosciuti: non e' un fallimento, ma va detto —
  //    l'utente altrimenti crede che quei titoli non li avesse.
  const total = matchedCount + unresolvedCount;
  if (total > 0 && unresolvedCount >= UNRESOLVED_WARN_MIN && unresolvedCount / total >= UNRESOLVED_WARN_RATIO) {
    warnings.push({
      code: "many_unresolved",
      message: `${unresolvedCount} titoli non sono stati riconosciuti automaticamente e non sono ancora nella tua libreria.`,
    });
  }

  return warnings;
}

module.exports = {
  buildImportWarnings,
  UNRESOLVED_WARN_RATIO,
  UNRESOLVED_WARN_MIN,
};
