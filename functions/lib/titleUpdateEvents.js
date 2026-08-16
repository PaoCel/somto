const { buildTitleUpdateEventDocument } = require("./titleUpdateEventModel");

const MAX_EVENTS_PER_WRITE = 50;
const VOLATILE_FIELDS = new Set(["updatedAt"]);

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return Number(value.toMillis());
  if (typeof value?._seconds === "number") return value._seconds * 1000;
  return value;
}

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    const millis = toMillis(value);
    if (typeof millis === "number") return millis;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE_FIELDS.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, comparable(child)])
    );
  }
  return value;
}

function managedDocumentsEqual(left, right) {
  const keys = Object.keys(right || {});
  const existingManaged = Object.fromEntries(keys.map((key) => [key, left?.[key]]));
  return JSON.stringify(comparable(existingManaged)) === JSON.stringify(comparable(right));
}

/**
 * Applica i blocchi editoriali: i campi che una persona ha fissato tornano al
 * valore fissato, e se la fonte ne propone uno diverso il disaccordo viene
 * REGISTRATO invece che applicato.
 *
 * PERCHE' SI REGISTRA E NON SI IGNORA — chi cura i contenuti scrive di *cosa
 * esce e quando*. Se TMDB, dopo una correzione a mano, dice una data diversa,
 * spesso non e' rumore: il film e' stato spostato, ed e' una notizia. Ignorarlo
 * in silenzio significherebbe continuare a pubblicare una data vecchia
 * credendola giusta. Il valore mostrato resta quello editoriale; il conflitto
 * emerge in console.
 *
 * `detectedAt` si aggiorna SOLO quando il valore della fonte cambia davvero:
 * altrimenti ogni passata dello scanner (~ogni 2,5 giorni per titolo) darebbe
 * un documento diverso e quindi una scrittura, vanificando `managedDocumentsEqual`.
 */
function applyEditorialLocks(existing, next, now) {
  const editorial = existing?.editorial;
  const lockedFields = Array.isArray(editorial?.lockedFields) ? editorial.lockedFields : [];
  if (!lockedFields.length) return;

  let conflictField = null;
  let conflictValue;

  for (const field of lockedFields) {
    if (!Object.prototype.hasOwnProperty.call(next, field)) continue;

    const incomingValue = next[field];
    const lockedValue = existing[field];
    next[field] = lockedValue;

    // Si segnala il PRIMO campo in disaccordo: per un release_date sono
    // `effectiveAt` e il suo `sortAt` derivato, cioe' un fatto solo.
    if (!conflictField
      && JSON.stringify(comparable(incomingValue)) !== JSON.stringify(comparable(lockedValue))) {
      conflictField = field;
      conflictValue = incomingValue;
    }
  }

  const previous = editorial.sourceConflict || null;
  if (!conflictField) {
    // La fonte si e' riallineata alla correzione: il conflitto non esiste piu'.
    next.editorial = previous ? { ...editorial, sourceConflict: null } : editorial;
    return;
  }

  const sameAsBefore = previous
    && previous.field === conflictField
    && JSON.stringify(comparable(previous.sourceValue)) === JSON.stringify(comparable(conflictValue));

  next.editorial = {
    ...editorial,
    sourceConflict: {
      field: conflictField,
      sourceValue: conflictValue,
      detectedAt: sameAsBefore ? previous.detectedAt : now,
    },
  };
}

function mergeExistingEvent(existing, incoming, now) {
  if (!existing) return incoming;
  const next = { ...incoming };

  next.discoveredAt = existing.discoveredAt || incoming.discoveredAt;
  next.acquisitionMode = existing.acquisitionMode || incoming.acquisitionMode;

  // Un backfill resta per sempre non notificabile, anche quando lo scanner live
  // incontra di nuovo lo stesso ID deterministico.
  if (next.acquisitionMode !== "live") {
    next.notificationEligible = false;
  } else if (existing.status === "published") {
    // Dopo la prima pubblicazione il gate di fanout è immutabile: un update di
    // copy/lingua non deve trasformarsi in una nuova notifica.
    next.notificationEligible = existing.notificationEligible === true;
  }

  // Una regressione/risposta parziale della fonte non nasconde una notizia già
  // pubblicata. La rimozione editoriale esplicita usa status retired.
  if (existing.status === "published" && next.status === "draft") {
    next.status = "published";
  }

  // Retire è una decisione editoriale: gli scanner automatici non la annullano.
  if (existing.status === "retired") {
    next.status = "retired";
    next.notificationEligible = false;
  }

  if (existing.firstPublishedAt) {
    next.firstPublishedAt = existing.firstPublishedAt;
  } else if (next.status === "published") {
    next.firstPublishedAt = now;
  } else {
    delete next.firstPublishedAt;
  }

  // Per ultimo: i blocchi editoriali vincono su tutto il resto del merge.
  applyEditorialLocks(existing, next, now);

  return next;
}

async function writeTitleUpdateEvent({
  db,
  candidate,
  acquisitionMode = "backfill",
  publishEligible = false,
  now = new Date(),
  dryRun = false,
} = {}) {
  const built = buildTitleUpdateEventDocument(candidate, {
    acquisitionMode,
    publishEligible,
    now,
  });
  if (dryRun) {
    return { id: built.id, created: false, updated: false, dryRun: true, document: built.document };
  }
  if (!db || typeof db.runTransaction !== "function" || typeof db.collection !== "function") {
    throw new Error("Firestore db obbligatorio");
  }

  const ref = db.collection("titleUpdateEvents").doc(built.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const exists = snap?.exists === true;
    const existing = exists ? (snap.data() || {}) : null;
    const next = mergeExistingEvent(existing, built.document, built.document.updatedAt);

    if (exists && managedDocumentsEqual(existing, next)) {
      return {
        id: built.id,
        created: false,
        updated: false,
        dryRun: false,
        status: existing.status,
        notificationEligible: existing.notificationEligible === true,
      };
    }

    tx.set(ref, next, { merge: true });
    return {
      id: built.id,
      created: !exists,
      updated: exists,
      dryRun: false,
      status: next.status,
      notificationEligible: next.notificationEligible === true,
    };
  });
}

async function writeTitleUpdateEvents({
  db,
  candidates,
  acquisitionMode = "backfill",
  publishEligible = false,
  now = new Date(),
  dryRun = false,
  maxEvents = MAX_EVENTS_PER_WRITE,
} = {}) {
  const cap = Math.max(1, Math.min(MAX_EVENTS_PER_WRITE, Math.floor(Number(maxEvents) || MAX_EVENTS_PER_WRITE)));
  const unique = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const id = String(candidate?.id || "").trim();
    if (!id || unique.has(id)) continue;
    unique.set(id, candidate);
    if (unique.size >= cap) break;
  }

  const results = [];
  const errors = [];
  for (const candidate of unique.values()) {
    try {
      results.push(await writeTitleUpdateEvent({
        db,
        candidate,
        acquisitionMode,
        publishEligible,
        now,
        dryRun,
      }));
    } catch (err) {
      errors.push({ id: String(candidate?.id || "").slice(0, 240), message: String(err?.message || err).slice(0, 240) });
    }
  }

  return {
    dryRun,
    requested: Array.isArray(candidates) ? candidates.length : 0,
    unique: unique.size,
    created: results.filter((row) => row.created).length,
    updated: results.filter((row) => row.updated).length,
    unchanged: results.filter((row) => !row.created && !row.updated && !row.dryRun).length,
    previewed: results.filter((row) => row.dryRun).length,
    errors,
    results,
  };
}

module.exports = {
  MAX_EVENTS_PER_WRITE,
  applyEditorialLocks,
  managedDocumentsEqual,
  mergeExistingEvent,
  writeTitleUpdateEvent,
  writeTitleUpdateEvents,
};
