// peopleSuggestions.api.js — suggerimenti personalizzati di persone da seguire.
//
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

import { app } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const getPeopleSuggestionsCallable = httpsCallable(functions, "getPeopleSuggestions");

/**
 * @param {{max?: number, force?: boolean}} opts
 * @returns {Promise<{people: Array, reason: string|null}>}
 */
export async function getPeopleSuggestions({ max = 8, force = false } = {}) {
  try {
    const res = await getPeopleSuggestionsCallable({ max, force });
    const data = res?.data || {};
    return {
      people: Array.isArray(data.people) ? data.people : [],
      reason: data.reason || null,
    };
  } catch (err) {
    // Suggerimento mancato non e' un errore da mostrare: la sezione resta
    // nascosta e il resto della pagina non si accorge di niente.
    console.warn("[people] suggerimenti non disponibili", err?.message || err);
    return { people: [], reason: "error" };
  }
}
