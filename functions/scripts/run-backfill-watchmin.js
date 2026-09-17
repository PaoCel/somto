const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
initializeApp({ projectId: "gia-visto" });
const firestore = getFirestore();
const titleCache = new Map();

async function getTitle(id) {
  if (titleCache.has(id)) return titleCache.get(id);
  const d = await firestore.collection("titles").doc(id).get();
  const data = d.exists ? d.data() : null;
  titleCache.set(id, data);
  return data;
}

function mins(t) {
  if (!t) return 0;
  const m = t.meta || {};
  if (t.type === "movie") return Math.max(0, m.durationMovie || 0);
  if (t.type === "tv") {
    const d = Math.max(0, m.durationEpisode || 0);
    const s = Math.max(0, m.seasonsCount || 0);
    const e = Math.max(0, m.episodesPerSeason || 0);
    return (d > 0 && s > 0 && e > 0) ? d * s * e : 0;
  }
  return 0;
}

(async () => {
  const snap = await firestore.collection("users").get();
  console.log("Users:", snap.size);
  for (const u of snap.docs) {
    const lib = await firestore.collection("users").doc(u.id).collection("library").get();
    if (lib.empty) continue;
    let total = 0;
    for (const e of lib.docs) {
      const tid = (e.data().titleId || e.id || "").trim();
      if (!tid) continue;
      total += mins(await getTitle(tid));
    }
    await firestore.collection("users").doc(u.id).update({
      "stats.totalWatchMinutes": total,
      "stats.watchedCount": lib.size,
    });
    const days = Math.floor(total / 1440);
    const hours = Math.floor((total % 1440) / 60);
    console.log(`  ${(u.data().displayName || u.id).padEnd(20)} -> ${lib.size} titoli, ${days}g ${hours}h (${total} min)`);
  }
  console.log("DONE");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
