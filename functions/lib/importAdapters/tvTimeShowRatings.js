"use strict";

// tv_show_rate.csv — i voti che l'utente ha dato alle SERIE su TV Time.
//
// Finora questo file non lo leggeva nessuno: importavamo i voti per episodio
// (ratings-3-prod-episode_votes.csv) e quelli dei film (ratings-live-votes.csv),
// ma il voto della serie — l'unico che molti utenti hanno davvero messo —
// finiva nel cestino. Su un account del 2016 e' addirittura l'unico voto
// esistente, perche' i voti per episodio non c'erano ancora.
//
// Colonne osservate: updated_at, tv_show_name, user_id, tv_show_id, rating,
// created_at. Come per gli altri CSV dell'export (dump DynamoDB) l'ORDINE
// delle colonne non e' garantito: si risolve sempre per NOME.
//
// SCALA — non e' dichiarata da nessuna parte nel file. L'unico esempio reale
// che abbiamo (account 2016) ha `3.50`, e TVShow Time votava le serie con 5
// stelle e mezze stelle. Ma un export futuro potrebbe usare i decimi. Invece
// di indovinare su un singolo valore si guarda TUTTO il file: se compare
// almeno un voto sopra 5, la scala e' 0-10; altrimenti 0-5. E' lo stesso
// criterio "scale-aware" gia' usato per i voti degli episodi
// (tvTimeRatings.js), dove indovinare la scala sbagliata aveva prodotto voti
// completamente falsati.

const { parseCsv } = require("./csv");

function safeString(value, maxLen = 500) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function toNumberOrNull(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseTvTimeDateTime(raw) {
  const trimmed = safeString(raw, 32);
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Somto usa i decimi con un decimale. 3.5/5 -> 7, 8.5/10 -> 8.5.
 * Il minimo e' 1: Somto non ammette lo zero (un voto 0 verrebbe rifiutato
 * dalle rules — vedi l'incidente dei voti sotto 1).
 */
function toSomtoDecimal(rating, scale) {
  if (rating == null || rating <= 0) return null;
  const raw = scale === 10 ? rating : rating * 2;
  const clamped = Math.min(10, Math.max(1, raw));
  return Math.round(clamped * 10) / 10;
}

function detectScale(values) {
  return values.some((v) => v != null && v > 5) ? 10 : 5;
}

/**
 * @returns {{ ratings: Array<{seriesName, decimalRating, ratedAt}>, scale: 5|10, errors: Array }}
 */
function parseTvTimeShowRatingsCsv(rawText) {
  const ratings = [];
  const errors = [];
  const table = parseCsv(rawText);
  if (table.length === 0) return { ratings, scale: 5, errors };

  const header = table[0].map((h) => safeString(h, 60).toLowerCase());
  const idx = {
    name: header.indexOf("tv_show_name"),
    rating: header.indexOf("rating"),
    createdAt: header.indexOf("created_at"),
    updatedAt: header.indexOf("updated_at"),
  };
  if (idx.name === -1 || idx.rating === -1) {
    return {
      ratings,
      scale: 5,
      errors: [{ line: 1, rawTitle: "", reason: "Header CSV voti serie inatteso (attese colonne tv_show_name,rating,...)." }],
    };
  }

  // Primo passaggio: raccolta grezza, serve tutto il file per la scala.
  const raw = [];
  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const seriesName = safeString(record[idx.name], 500);
    const value = toNumberOrNull(record[idx.rating]);
    if (!seriesName) {
      errors.push({ line: i + 1, rawTitle: "", reason: "Nome serie mancante nel file dei voti." });
      continue;
    }
    if (value == null) {
      errors.push({ line: i + 1, rawTitle: seriesName, reason: "Voto serie non numerico." });
      continue;
    }
    raw.push({
      seriesName,
      value,
      ratedAt: parseTvTimeDateTime(idx.createdAt !== -1 ? record[idx.createdAt] : "")
        || parseTvTimeDateTime(idx.updatedAt !== -1 ? record[idx.updatedAt] : ""),
    });
  }

  const scale = detectScale(raw.map((r) => r.value));
  for (const r of raw) {
    const decimalRating = toSomtoDecimal(r.value, scale);
    if (decimalRating == null) continue; // voto 0 = "non votata" su TV Time
    ratings.push({ seriesName: r.seriesName, decimalRating, ratedAt: r.ratedAt });
  }

  return { ratings, scale, errors };
}

module.exports = { parseTvTimeShowRatingsCsv, toSomtoDecimal, detectScale };
