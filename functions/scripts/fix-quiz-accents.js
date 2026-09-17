#!/usr/bin/env node
/**
 * fix-quiz-accents.js
 *
 * Applica a `quizQuestions` una patch di soli accenti. I batch `hp_*` e
 * `family_classics_*` sono entrati in produzione senza passare dal controllo
 * accenti (a differenza dei `disney_*`, che hanno accentAuditStatus
 * valorizzato): a schermo si leggeva "Perche", "puo", "non e", "identita'".
 *
 * LA GARANZIA DI QUESTO SCRIPT: una patch viene scritta solo se, togliendo
 * accenti e apostrofi, il testo nuovo e quello LIVE risultano identici
 * carattere per carattere. Quindi nessuna parola, nessun fatto, nessuna
 * virgola puo' cambiare passando di qui: al massimo cambia un accento. Chi
 * non passa la guardia viene scartato e riportato, non scritto.
 *
 * Il confronto e' sempre contro il documento LIVE, mai contro il dump da cui
 * la patch e' stata generata: se qualcuno ha modificato la domanda nel
 * frattempo, il record viene scartato invece di sovrascrivere.
 *
 * Usage (da functions/):
 *   node scripts/fix-quiz-accents.js                 # dry-run, non scrive
 *   node scripts/fix-quiz-accents.js --write         # applica
 *   node scripts/fix-quiz-accents.js --patch <file>  # patch alternativa
 *   node scripts/fix-quiz-accents.js --verbose       # stampa ogni diff
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const VERBOSE = argv.includes("--verbose");
const patchArgIndex = argv.indexOf("--patch");
const PATCH_PATH = patchArgIndex >= 0 && argv[patchArgIndex + 1]
  ? path.resolve(argv[patchArgIndex + 1])
  : path.join(__dirname, "..", "..", "quiz_beta", "accent-fixes", "accent-patch-2026-08-27.json");

const AUDIT_STATUS = "fixed_2026_08_27";
const BATCH_SIZE = 400;
const FIELDS = ["questionText", "explanation"];

// Confronto "a meno di accenti": togliamo i segni diacritici (NFD) e gli
// apostrofi, perche' una parte del corpus scriveva le tronche in ASCII
// ("identita'" invece di "identità") e la correzione toglie l'apostrofo.
function normalize(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "");
}

function buildUpdate(liveData, patch) {
  const update = {};
  const diffs = [];
  const problems = [];

  for (const field of FIELDS) {
    const next = patch[field];
    if (next == null) continue;
    if (typeof next !== "string") { problems.push(`${field}: non e' una stringa`); continue; }
    const current = liveData[field];
    if (typeof current !== "string") { problems.push(`${field}: assente sul doc live`); continue; }
    if (normalize(current) !== normalize(next)) { problems.push(`${field}: differenza non di accento`); continue; }
    if (current === next) continue; // gia' corretto (rilancio dello script)
    update[field] = next;
    diffs.push({ field, before: current, after: next });
  }

  if (patch.answers && typeof patch.answers === "object") {
    const liveAnswers = Array.isArray(liveData.answers) ? liveData.answers.slice() : null;
    if (!liveAnswers) {
      problems.push("answers: assenti sul doc live");
    } else {
      let touched = false;
      for (const [key, next] of Object.entries(patch.answers)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= liveAnswers.length) {
          problems.push(`answers[${key}]: indice fuori range`);
          continue;
        }
        if (typeof next !== "string") { problems.push(`answers[${index}]: non e' una stringa`); continue; }
        const current = String(liveAnswers[index]);
        if (normalize(current) !== normalize(next)) { problems.push(`answers[${index}]: differenza non di accento`); continue; }
        if (current === next) continue;
        liveAnswers[index] = next;
        diffs.push({ field: `answers[${index}]`, before: current, after: next });
        touched = true;
      }
      if (touched) update.answers = liveAnswers;
    }
  }

  return { update, diffs, problems };
}

async function main() {
  const patches = JSON.parse(fs.readFileSync(PATCH_PATH, "utf8"));
  if (!Array.isArray(patches) || !patches.length) throw new Error("patch vuota o non valida");

  admin.initializeApp({ projectId: "gia-visto" });
  const db = admin.firestore();

  console.log(`patch: ${PATCH_PATH}`);
  console.log(`record da valutare: ${patches.length}`);
  console.log(WRITE ? "modalita': SCRITTURA\n" : "modalita': dry-run (nessuna scrittura)\n");

  const toWrite = [];
  const rejected = [];
  const missing = [];
  let alreadyOk = 0;
  let fieldCount = 0;

  for (let i = 0; i < patches.length; i += 30) {
    const chunk = patches.slice(i, i + 30);
    const refs = chunk.map((p) => db.collection("quizQuestions").doc(p.id));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap, j) => {
      const patch = chunk[j];
      if (!snap.exists) { missing.push(patch.id); return; }
      const { update, diffs, problems } = buildUpdate(snap.data() || {}, patch);
      if (problems.length) { rejected.push({ id: patch.id, why: problems.join("; ") }); return; }
      if (!diffs.length) { alreadyOk += 1; return; }
      fieldCount += diffs.length;
      toWrite.push({ id: patch.id, update });
      if (VERBOSE) {
        console.log(`- ${patch.id}`);
        diffs.forEach((d) => console.log(`    ${d.field}\n      - ${d.before}\n      + ${d.after}`));
      }
    });
  }

  console.log(`da correggere: ${toWrite.length} doc, ${fieldCount} campi`);
  console.log(`gia' corretti: ${alreadyOk}`);
  console.log(`scartati dalla guardia: ${rejected.length}`);
  rejected.slice(0, 20).forEach((r) => console.log(`   X ${r.id} — ${r.why}`));
  if (missing.length) console.log(`doc inesistenti: ${missing.length} (${missing.slice(0, 10).join(", ")})`);

  if (!WRITE) {
    console.log("\n[dry-run] niente scritto. Rilancia con --write.");
    return;
  }
  if (!toWrite.length) {
    console.log("\nNiente da scrivere.");
    return;
  }

  for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const item of toWrite.slice(i, i + BATCH_SIZE)) {
      batch.update(db.collection("quizQuestions").doc(item.id), {
        ...item.update,
        accentAuditStatus: AUDIT_STATUS,
        accentAuditAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    console.log(`  scritti ${Math.min(i + BATCH_SIZE, toWrite.length)}/${toWrite.length}`);
  }
  console.log(`\nFatto: ${toWrite.length} domande corrette (${fieldCount} campi).`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("fix-quiz-accents fallito:", err?.message || err);
  process.exit(1);
});
