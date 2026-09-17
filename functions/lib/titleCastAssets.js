"use strict";

// Cast e registi di un titolo, dalla risposta TMDB `credits`.
//
// PERCHE' STA QUI — la forma di questi campi era scritta una volta sola, dentro
// `enrichTitleAssets` (index.js), che gira solo alla prima apertura di una
// scheda. Un titolo importato a mano per essere promosso subito (una uscita
// imminente) resta quindi senza `castIds` e `directorIds` proprio nel momento in
// cui servono: sono i due segnali che il pubblico per affinita' usa per
// riconoscere "stesso regista di una cosa che hai visto". Su
// "Mousetrap - Identita' rubata" il regista era lo stesso di
// "La casa di carta: Corea", e chi l'aveva vista non e' stato raggiunto perche'
// il campo era vuoto.
//
// Logica PURA: chi chiama passa il JSON gia' scaricato e scrive lui su Firestore.

const { safeArray, safeString } = require("./pureUtils");

// Come `enrichTitleAssets`: i primi 20 del cast, ordinati per `order`.
const MAX_CAST = 20;

/**
 * @param {Object} credits  `credits` di TMDB (`{ cast: [], crew: [] }`)
 * @returns {{cast: Array, castIds: string[], directorIds: string[]}}
 */
function buildCastAssets(credits = {}) {
  const cast = safeArray(credits?.cast)
    .slice(0, MAX_CAST)
    .map((row) => {
      const personId = row?.id ? String(row.id) : "";
      const name = safeString(row?.name || row?.original_name || "", 120);
      if (!personId || !name) return null;
      return {
        personId,
        name,
        character: safeString(row?.character || "", 160),
        profilePath: row?.profile_path ? `https://image.tmdb.org/t/p/w500${row.profile_path}` : "",
        order: Number.isFinite(row?.order) ? Number(row.order) : 999,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);

  const directorIds = Array.from(new Set(
    safeArray(credits?.crew)
      .filter((row) => String(row?.job || "") === "Director" && row?.id)
      .map((row) => String(row.id))
      .filter(Boolean)
  ));

  return { cast, castIds: cast.map((row) => row.personId).filter(Boolean), directorIds };
}

module.exports = { MAX_CAST, buildCastAssets };
