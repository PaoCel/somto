#!/usr/bin/env node
/**
 * report-official-updates.js — quanto ha girato un aggiornamento ufficiale.
 *
 * Sola lettura. Per ogni voce del registro `officialUpdates` riporta:
 *   - reach:     a quanti utenti e' arrivato (feedEvents + notifiche scritte)
 *   - aperture:  notifiche marcate `read` (proxy di "l'ha vista davvero")
 *   - reazioni:  like, commenti, condivisioni sul post, con nomi
 *
 * NB: le *visualizzazioni* del post nel feed non esistono come dato — Somto
 * non traccia impression sui post. Le metriche sopra sono quelle reali.
 *
 * Uso:
 *   cd functions
 *   node scripts/report-official-updates.js
 *   node scripts/report-official-updates.js --slug film-sullo-spazio
 */

const admin = require("firebase-admin");

const PROJECT_ID = "gia-visto";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

async function displayNames(db, uids) {
  const unique = [...new Set(uids.filter(Boolean))];
  if (!unique.length) return new Map();
  const refs = unique.map((uid) => db.collection("users").doc(uid));
  const snaps = await db.getAll(...refs);
  return new Map(snaps.map((s) => [s.id, String(s.data()?.displayName || s.id)]));
}

async function countReadNotifications(db, slug, recipientHint) {
  // Le notifiche hanno id deterministico `official_update_{slug}` sotto ogni
  // utente: si legge solo la manciata di destinatari, non tutta la collection.
  const uids = recipientHint.length
    ? recipientHint
    : (await db.collection("feedEvents").where("eventKey", "==", `official_update:${slug}`).get())
      .docs.map((d) => d.data()?.ownerUid).filter(Boolean);

  const unique = [...new Set(uids)];
  if (!unique.length) return { delivered: 0, read: 0 };

  let delivered = 0;
  let read = 0;
  for (let i = 0; i < unique.length; i += 300) {
    const chunk = unique.slice(i, i + 300);
    const refs = chunk.map((uid) => db.collection("users").doc(uid)
      .collection("notifications").doc(`official_update_${slug}`));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      delivered++;
      if (snap.data()?.read === true) read++;
    }
  }
  return { delivered, read };
}

async function reportOne(db, docSnap) {
  const slug = docSnap.id;
  const data = docSnap.data() || {};
  const postId = String(data.postId || `official_${slug}`);

  console.log("─".repeat(72));
  console.log(`${slug}  [${data.status}]`);
  if (data.scheduledAt?.toDate) {
    console.log(`  programmato : ${data.scheduledAt.toDate().toLocaleString("it-IT", { timeZone: "Europe/Rome" })} (Roma)`);
  }
  if (data.publishedAt?.toDate) {
    console.log(`  pubblicato  : ${data.publishedAt.toDate().toLocaleString("it-IT", { timeZone: "Europe/Rome" })} (Roma)`);
  }
  if (data.lastScheduleError) {
    console.log(`  ⚠ ultimo errore scheduler: ${data.lastScheduleError}`);
  }

  if (data.status !== "published") {
    console.log("  (non ancora pubblicato: nessuna metrica)");
    return;
  }

  console.log(`  reach       : ${data.audienceCount || 0} utenti interessati ai titoli collegati`);
  console.log(`                ${data.feedEventsWritten || 0} in home feed · ${data.notificationsWritten || 0} notifiche+push`);

  const feedSnap = await db.collection("feedEvents")
    .where("eventKey", "==", `official_update:${slug}`).get();
  const recipients = feedSnap.docs.map((d) => d.data()?.ownerUid).filter(Boolean);
  const { delivered, read } = await countReadNotifications(db, slug, recipients);
  const pct = delivered ? Math.round((read / delivered) * 100) : 0;
  console.log(`  aperture    : ${read}/${delivered} notifiche lette (${pct}%)`);

  const [likesSnap, commentsSnap, sharesSnap] = await Promise.all([
    db.collection("posts").doc(postId).collection("likes").get(),
    db.collection("posts").doc(postId).collection("comments").orderBy("createdAt", "asc").get(),
    db.collection("posts").where("sharedPost.postId", "==", postId).get().catch(() => ({ size: 0, docs: [] })),
  ]);

  const names = await displayNames(db, [
    ...likesSnap.docs.map((d) => d.id),
    ...commentsSnap.docs.map((d) => d.data()?.uid),
  ]);

  console.log(`  like        : ${likesSnap.size}${likesSnap.size ? ` — ${likesSnap.docs.map((d) => names.get(d.id) || d.id).join(", ")}` : ""}`);
  console.log(`  condivisioni: ${sharesSnap.size || 0}`);
  console.log(`  commenti    : ${commentsSnap.size}`);
  for (const c of commentsSnap.docs) {
    const cd = c.data() || {};
    const who = names.get(cd.uid) || cd.authorName || cd.uid;
    console.log(`     · ${who}: ${String(cd.text || "").replace(/\s+/g, " ").slice(0, 140)}`);
  }
  console.log(`  post        : https://somto.it/community.html?post=${encodeURIComponent(postId)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();

  // Niente orderBy sul registro: un doc senza `scheduledAt` (es. pubblicato a
  // mano invece che dallo scheduler) sparirebbe dall'elenco senza dirlo.
  const docs = args.slug
    ? [await db.collection("officialUpdates").doc(String(args.slug)).get()]
    : (await db.collection("officialUpdates").get()).docs.sort((a, b) => {
      const at = (x) => x.data()?.publishedAt?.toMillis?.() || x.data()?.scheduledAt?.toMillis?.() || 0;
      return at(a) - at(b);
    });

  const found = docs.filter((d) => d && d.exists);
  if (!found.length) {
    console.log("Nessun aggiornamento ufficiale trovato.");
    return;
  }
  for (const docSnap of found) {
    await reportOne(db, docSnap);
  }
  console.log("─".repeat(72));
  console.log("Traffico del blog: Search Console (impression/click). Le pagine blog");
  console.log("sono statiche e non caricano Firebase Analytics.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("ERRORE:", err?.message || err);
  process.exit(1);
});
