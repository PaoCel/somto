"use strict";

// Perche' esiste: un `titles/{id}.set(..., { merge: true })` di
// denormalizzazione CREA il documento se non esiste. Su un id cancellato (per
// esempio un doppione gia' accorpato in un titolo canonico) rinasce cosi' un
// "titolo fantasma" senza `name`, `type`, `posterPath` ne' `status`. I client
// lo rendono come "Senza titolo" e il gate anti-spoiler, che cerca il progresso
// del viewer PER titleId, lo blocca per chiunque: il progresso e' sul titolo
// canonico, il commento sul fantasma.
//
// Incidente 2026-09-09 — `titles/tmdb_tv_308014`, doppione di `berlino` gia'
// presente in `mergedTmdbIds`, cancellato e poi resuscitato senza nome dalla
// denormalizzazione dei provider. Due librerie utente e un voto sono rimasti
// appesi al fantasma.
//
// Regola: **le denormalizzazioni sul doc titolo non creano mai il documento.**
// `update()` fallisce con NOT_FOUND e qui diventa "salta e logga": nessuna di
// queste scritture e' proprietaria del titolo, quindi non ha titolo per
// inventarlo. Il warn e' il segnale che da qualche parte gira un id morto.

const logger = require("firebase-functions/logger");

const FIRESTORE_NOT_FOUND = 5;

function isNotFound(error) {
  return Number(error?.code) === FIRESTORE_NOT_FOUND || String(error?.code) === "not-found";
}

/**
 * Applica un patch a `titles/{titleId}` solo se il documento esiste gia'.
 *
 * @returns {Promise<boolean>} true se ha scritto, false se il titolo non c'e'.
 */
async function patchExistingTitle(db, titleId, patch, { context = "" } = {}) {
  const id = String(titleId || "").trim();
  if (!id) return false;
  if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) return false;

  try {
    await db.collection("titles").doc(id).update(patch);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      logger.warn("[titles] denormalizzazione su titolo inesistente, saltata", {
        titleId: id,
        context: String(context || "").slice(0, 80),
      });
      return false;
    }
    throw error;
  }
}

module.exports = { patchExistingTitle };
