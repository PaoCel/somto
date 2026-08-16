function buildKnownUsersMap(userDocs = []) {
  const knownUsers = {};
  for (const snap of userDocs) {
    const data = typeof snap?.data === "function" ? (snap.data() || {}) : (snap || {});
    const uid = String(snap?.id || data.uid || "").trim();
    if (!uid) continue;
    knownUsers[uid] = {
      displayName: data.displayName || "",
      photoURL: data.photoURL || "",
      ratingsCount: Number(data?.stats?.ratingsCount || 0) || 0,
    };
  }
  return knownUsers;
}

function collectMissingAdderProfileUids(adderEntries = [], knownUsers = {}) {
  const missing = new Set();
  for (const entry of adderEntries) {
    const uid = String(Array.isArray(entry) ? entry[0] : "").trim();
    if (!uid) continue;
    if (!knownUsers[uid]) missing.add(uid);
  }
  return missing;
}

module.exports = {
  buildKnownUsersMap,
  collectMissingAdderProfileUids,
};
