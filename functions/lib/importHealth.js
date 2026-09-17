"use strict";

// Diagnosi di un import a partire dal SUO documento — modulo puro, testabile.
//
// Lo `status` non e' un indicatore di salute: a luglio 2026 tre utenti avevano
// import "completed" con zero dati importati, e li abbiamo scoperti solo perche'
// uno di loro ha scritto all'assistenza. I sintomi veri stanno nei conteggi.
//
// Volutamente basato sui soli campi del doc: costo zero letture aggiuntive,
// quindi la scansione periodica resta O(numero di import), non O(titoli).

const UNRESOLVED_RATIO = 0.5;
const STALE_MS = 60 * 60 * 1000;
const TERMINAL = new Set(["completed", "awaiting_confirmation", "failed"]);

/**
 * `importedTitleCount` non esiste sugli import piu' vecchi del campo: preso da
 * solo farebbe risultare fallito un import perfettamente riuscito. Si ripiega
 * su titleStateIdsWritten; se manca anche quello si restituisce null =
 * "non lo so", e il chiamante NON deve dedurne un fallimento.
 */
function titlesWrittenFromDoc(data = {}) {
  if (Number.isFinite(Number(data.importedTitleCount))) return Number(data.importedTitleCount);
  if (Array.isArray(data.titleStateIdsWritten)) return data.titleStateIdsWritten.length;
  return null;
}

/**
 * @returns string[] — sintomi in italiano, vuoto se l'import sta bene.
 */
function diagnoseImportDoc(data = {}, nowMs = Date.now()) {
  const symptoms = [];
  const rows = Number(data.totalRows) || 0;
  const matched = Number(data.matchedCount) || 0;
  const titles = titlesWrittenFromDoc(data);
  const terminal = TERMINAL.has(data.status);

  if (terminal && rows === 0) symptoms.push("zero righe lette");
  if (terminal && rows > 0 && titles === 0) symptoms.push("nessun titolo scritto");
  if (!terminal) {
    const updatedMs = typeof data.updatedAt?.toMillis === "function" ? data.updatedAt.toMillis() : 0;
    if (updatedMs && nowMs - updatedMs > STALE_MS) symptoms.push("fermo da oltre un'ora");
  }
  if (rows > 20 && matched > 0 && matched / rows < UNRESOLVED_RATIO) {
    symptoms.push(`solo ${Math.round((matched / rows) * 100)}% delle righe risolte`);
  }
  return symptoms;
}

function importFailureErrorCount(errors = [], current = 0) {
  const parsed = Array.isArray(errors) ? errors.length : 0;
  const existing = Number.isFinite(Number(current)) ? Math.max(0, Math.trunc(Number(current))) : 0;
  return Math.max(1, parsed, existing);
}

function computeParseErrorRatio(rowCount = 0, errors = []) {
  const rows = Number.isFinite(Number(rowCount)) ? Math.max(0, Number(rowCount)) : 0;
  const errorCount = Array.isArray(errors) ? errors.length : 0;
  const total = rows + errorCount;
  return total > 0 ? errorCount / total : 0;
}

module.exports = {
  diagnoseImportDoc,
  titlesWrittenFromDoc,
  importFailureErrorCount,
  computeParseErrorRatio,
  UNRESOLVED_RATIO,
  STALE_MS,
};
