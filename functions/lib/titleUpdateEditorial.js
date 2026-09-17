"use strict";

const { buildEditorialOverride } = require("./titleUpdateEventModel");

// Una pubblicazione manuale notifica solo se l'uscita e' imminente.
//
// PERCHE' UNA SOGLIA — chi cura i contenuti smaltisce anche draft di film che
// escono fra mesi. Notificare "esce il 14 marzo" a chiunque abbia il titolo in
// watchlist brucerebbe uno dei 3 slot giornalieri per una notizia su cui non
// c'e' niente da fare. Entro due settimane invece e' azionabile: prenoti,
// pianifichi, ci vai.
const MANUAL_NOTIFY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function parseCalendarDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  // Mezzogiorno UTC come nel modello: una data di calendario non ha un'ora, e
  // ancorarla a mezzanotte la fa scivolare di un giorno a seconda del fuso.
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00.000Z` : raw);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return Number(value.toMillis());
  if (typeof value?._seconds === "number") return value._seconds * 1000;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Costruisce la patch di una correzione editoriale su un evento esistente.
 *
 * Funzione pura: non tocca Firestore. La callable si limita a leggere il
 * documento, chiamare questa, e scrivere il risultato.
 *
 * Ritorna anche `willNotify`, cosi' la console puo' DIRLO all'admin prima che
 * prema il bottone invece di fargli scoprire dopo che sono partite 400 push.
 */
function buildEditorialPatch({
  existing,
  effectiveDate,
  region,
  releaseType,
  publish = false,
  note,
  editedBy,
  now = new Date(),
} = {}) {
  if (!existing || typeof existing !== "object") throw new Error("Evento inesistente");
  if (existing.eventType !== "release_date") {
    // In v1 si corregge solo la data di uscita: trailer e new_episode hanno id
    // che includono la fonte, quindi non soffrono lo stesso problema.
    throw new Error("Correzione ammessa solo su eventi release_date");
  }

  const patch = { updatedAt: now };
  const lockedFields = [];
  const warnings = [];

  const parsedDate = effectiveDate === undefined ? null : parseCalendarDate(effectiveDate);
  if (effectiveDate !== undefined) {
    if (!parsedDate) throw new Error("Data non valida");
    patch.effectiveAt = parsedDate;
    // `sortAt` e' derivato da `effectiveAt`: fissare la data senza fissare
    // l'ordinamento lascerebbe l'evento in timeline nella posizione vecchia.
    patch.sortAt = parsedDate;
    lockedFields.push("effectiveAt", "sortAt");
  }

  if (region !== undefined) {
    const normalized = String(region || "").trim().toUpperCase().slice(0, 2);
    if (normalized.length !== 2) throw new Error("Region non valida");
    patch.region = normalized;
    lockedFields.push("region");
  }

  if (releaseType !== undefined) {
    const normalized = Math.floor(Number(releaseType));
    if (!(normalized > 0 && normalized <= 6)) throw new Error("releaseType non valido");
    patch.releaseType = normalized;
    lockedFields.push("releaseType");
  }

  if (!lockedFields.length && !publish) throw new Error("Niente da correggere");

  // Una persona ha messo le mani sull'evento: da qui in poi lo scanner non e'
  // piu' l'unica fonte, e il documento non torna mai "live".
  patch.acquisitionMode = "manual";

  const alreadyPublished = existing.status === "published";
  const effectiveMs = patch.effectiveAt ? patch.effectiveAt.getTime() : toMillis(existing.effectiveAt);
  const nowMs = now.getTime();
  const withinNotifyWindow = Number.isFinite(effectiveMs)
    && effectiveMs >= nowMs
    && effectiveMs <= nowMs + MANUAL_NOTIFY_WINDOW_MS;

  let willNotify = false;
  if (publish && !alreadyPublished) {
    patch.status = "published";
    if (!existing.firstPublishedAt) patch.firstPublishedAt = now;
    patch.notificationEligible = withinNotifyWindow;
    willNotify = withinNotifyWindow;
    if (!withinNotifyWindow) {
      warnings.push(
        Number.isFinite(effectiveMs) && effectiveMs < nowMs
          ? "Uscita gia' passata: pubblicato senza notifica."
          : "Uscita oltre due settimane: pubblicato senza notifica."
      );
    }
  } else if (publish && alreadyPublished) {
    warnings.push("Era gia' pubblicato: nessuna notifica.");
  }

  // Il blocco per ultimo, cosi' contiene la lista definitiva dei campi fissati.
  // Se questa correzione non fissa campi nuovi (es. solo publish), si preserva
  // il blocco esistente invece di cancellarlo.
  if (lockedFields.length) {
    patch.editorial = buildEditorialOverride({ lockedFields, editedBy, note, now });
  } else if (existing.editorial) {
    patch.editorial = { ...existing.editorial, sourceConflict: null };
  }

  return { patch, lockedFields: [...new Set(lockedFields)].sort(), willNotify, warnings };
}

module.exports = {
  MANUAL_NOTIFY_WINDOW_MS,
  buildEditorialPatch,
  parseCalendarDate,
};
