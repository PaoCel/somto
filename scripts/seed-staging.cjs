// Seed staging: copia catalogo PUBBLICO da prod (gia-visto, SOLO LETTURA)
// verso somto-staging (scrittura). Nessuna PII: titles/genres/categorie/
// quizMeta/quizQuestions sono contenuto catalogo. Crea anche utenti QA.
const admin = require("firebase-admin");

const prodApp = admin.initializeApp({ projectId: "gia-visto" }, "prod");
const stagApp = admin.initializeApp({ projectId: "somto-staging" }, "staging");
const prodDb = prodApp.firestore();
const stagDb = stagApp.firestore();

function readQaUsers() {
  const raw = String(process.env.STAGING_QA_USERS_JSON || "").trim();
  if (!raw) throw new Error("STAGING_QA_USERS_JSON mancante");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error("STAGING_QA_USERS_JSON non e JSON valido");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 10) {
    throw new Error("STAGING_QA_USERS_JSON deve contenere da 1 a 10 utenti");
  }

  return parsed.map((user, index) => {
    const email = String(user?.email || "").trim().toLowerCase();
    const name = String(user?.name || "").trim();
    const uid = String(user?.uid || "").trim();
    if (!email.includes("@") || !name) {
      throw new Error(`Utente QA ${index + 1} non valido`);
    }
    return { email, name, uid: uid || undefined, admin: user?.admin === true };
  });
}

async function copyDocs(label, docs) {
  const writer = stagDb.bulkWriter();
  let n = 0;
  for (const d of docs) {
    writer.set(stagDb.doc(d.ref.path), d.data());
    n++;
  }
  await writer.close();
  console.log(`${label}: ${n} doc copiati`);
  return n;
}

async function main() {
  // 1. Top titoli approvati
  const titles = await prodDb.collection("titles")
    .where("status", "==", "approved")
    .orderBy("ratingCount", "desc")
    .limit(120)
    .get();
  await copyDocs("titles", titles.docs);

  // 2. Generi + categorie (piccole, integrali)
  for (const coll of ["genres", "contentCategories"]) {
    const snap = await prodDb.collection(coll).get();
    await copyDocs(coll, snap.docs);
  }

  // 3. quizMeta/themes
  const themesSnap = await prodDb.collection("quizMeta").doc("themes").get();
  if (themesSnap.exists) {
    await stagDb.collection("quizMeta").doc("themes").set(themesSnap.data());
    console.log("quizMeta/themes: copiato");
  }

  // 4. Domande quiz per i top 8 temi
  const themes = ((themesSnap.data() || {}).themes || [])
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 8);
  let q = 0;
  for (const t of themes) {
    const qs = await prodDb.collection("quizQuestions")
      .where("titleId", "==", t.titleId)
      .where("status", "in", ["approved", "beta_pending_review"])
      .limit(50)
      .get();
    q += await copyDocs(`quizQuestions[${t.titleId}]`, qs.docs);
  }
  console.log(`quizQuestions totali: ${q}`);

  // 5. Utenti QA
  const auth = stagApp.auth();
  const users = readQaUsers();
  const pw = process.env.SEED_PW;
  if (!pw) throw new Error("SEED_PW mancante");
  for (const u of users) {
    let uid = u.uid;
    if (!uid) {
      try {
        const created = await auth.createUser({ email: u.email, password: pw, displayName: u.name });
        uid = created.uid;
        console.log(`auth: creato ${u.email} → ${uid}`);
      } catch (e) {
        if (e.code === "auth/email-already-exists") {
          uid = (await auth.getUserByEmail(u.email)).uid;
          console.log(`auth: esiste già ${u.email} → ${uid}`);
        } else throw e;
      }
    }
    const lower = u.name.toLowerCase().replace(/\s+/g, "_");
    await stagDb.collection("users").doc(uid).set({
      displayName: u.name,
      displayNameLower: lower,
      isAdmin: u.admin,
      privacyDefault: "public",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`users/${uid}: doc creato (admin=${u.admin})`);
  }

  console.log("SEED COMPLETO");
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e); process.exit(1); });
