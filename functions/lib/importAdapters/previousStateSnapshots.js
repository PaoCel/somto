"use strict";

const SNAPSHOT_STORAGE = "subcollection_v1";
const SNAPSHOT_SCHEMA_VERSION = 1;

function isAlreadyExistsError(error) {
  const code = error?.code;
  return code === 6 || code === "6" || code === "already-exists" || code === "ALREADY_EXISTS";
}

function buildPreviousStateSnapshot(titleId, state, capturedAt) {
  return {
    titleId,
    existed: Boolean(state),
    state: state || null,
    capturedAt,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  };
}

/**
 * Persists immutable, per-title snapshots before an import mutates titleStates.
 * create-only writes make retries and concurrent confirmation calls reuse the
 * first observed state. A partial failure leaves no parent "ready" marker and
 * throws, so callers must not continue with title-state writes.
 */
async function persistPreviousTitleStates({
  db,
  importRef,
  currentStatesByTitleId,
  capturedAt,
  markerCapturedAt = null,
  logger = null,
  logContext = {},
}) {
  const entries = Array.from(currentStatesByTitleId || []);
  let created = 0;
  let reused = 0;

  if (entries.length > 0) {
    const writer = db.bulkWriter();
    const operations = entries.map(([titleId, state]) => writer
      .create(
        importRef.collection("previousStates").doc(titleId),
        buildPreviousStateSnapshot(titleId, state, capturedAt)
      )
      .then(() => ({ created: true }))
      .catch((error) => (isAlreadyExistsError(error) ? { reused: true } : { error })));

    await writer.close();
    const results = await Promise.all(operations);
    const failure = results.find((result) => result.error);
    if (failure) {
      logger?.error?.("[titlesImport] previous title-state snapshot failed", {
        ...logContext,
        expected: entries.length,
        created: results.filter((result) => result.created).length,
        error: failure.error?.stack || failure.error?.message || String(failure.error),
      });
      throw failure.error;
    }
    created = results.filter((result) => result.created).length;
    reused = results.filter((result) => result.reused).length;
  }

  const countSnap = await importRef.collection("previousStates").count().get();
  const count = Number(countSnap.data().count || 0);
  await importRef.set({
    previousStateSnapshot: {
      storage: SNAPSHOT_STORAGE,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      status: "ready",
      count,
      capturedAt: markerCapturedAt || capturedAt,
      verifiedAt: capturedAt,
    },
  }, { merge: true });

  logger?.info?.("[titlesImport] previous title-state snapshots ready", {
    ...logContext,
    expected: entries.length,
    created,
    reused,
    count,
  });
  return { expected: entries.length, created, reused, count };
}

module.exports = {
  SNAPSHOT_STORAGE,
  SNAPSHOT_SCHEMA_VERSION,
  isAlreadyExistsError,
  buildPreviousStateSnapshot,
  persistPreviousTitleStates,
};
