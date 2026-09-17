/**
 * Ripara i riferimenti a un "titolo fantasma" spostandoli sul titolo canonico,
 * poi cancella il fantasma.
 *
 * COS'E' UN FANTASMA — un doc `titles/{id}` senza `name`, nato da una
 * denormalizzazione `set(..., { merge: true })` su un id che non esisteva piu'
 * (tipicamente un doppione gia' accorpato e cancellato). Vedi
 * `scan-ghost-titles.js` per come si trovano e `lib/titleDocWrites.js` per la
 * guardia che impedisce di ricrearli.
 *
 * COSA VEDE L'UTENTE FINCHE' RESTA — la scheda e le card mostrano "Senza
 * titolo" senza poster, e il gate anti-spoiler sfoca il commento anche a chi ha
 * finito la serie: il progresso e' registrato sul titolo canonico, il commento
 * punta al fantasma, e il gate confronta gli id.
 *
 * ORDINE DELLE OPERAZIONI (conta: alcuni trigger scrivono sul doc fantasma)
 *   1. messaggi dei thread pubblici → thread canonico
 *      (il post-eco gemello lo rifanno i trigger: id deterministico, `createdAt`
 *      preservato, niente notifiche perche' il messaggio non e' "recente")
 *   2. voti → voto canonico (o cancellati se il canonico ha gia' lo stesso)
 *   3. stati libreria → stato canonico (o cancellati se esiste gia')
 *   4. eventi feed → cancellati se il canonico ha gia' l'evento gemello,
 *      altrimenti ripuntati
 *   5. post non-eco → ripuntati
 *   6. attesa che i trigger si assestino, poi thread fantasma
 *   7. doc titolo fantasma
 *
 * Dry-run di default: senza `--apply` non scrive niente.
 *
 * Uso:
 *   node scripts/repair-ghost-title.js --ghost tmdb_tv_308014 --canonical berlino
 *   node scripts/repair-ghost-title.js --ghost tmdb_tv_308014 --canonical berlino --apply
 *
 * Un fantasma senza riferimenti si cancella e basta:
 *   node scripts/repair-ghost-title.js --ghost <id> --delete-only --apply
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const yargs = require("yargs/yargs");

const args = yargs(process.argv.slice(2))
  .option("ghost", { type: "string", demandOption: true, describe: "id del titolo fantasma" })
  .option("canonical", { type: "string", describe: "id del titolo canonico su cui spostare i riferimenti" })
  .option("delete-only", { type: "boolean", default: false, describe: "il fantasma non ha riferimenti: cancellalo e basta" })
  .option("project", { type: "string", default: "gia-visto" })
  .option("apply", { type: "boolean", default: false })
  .option("settle-ms", { type: "number", default: 15000, describe: "attesa prima delle cancellazioni, per i trigger" })
  .option("log", { type: "string", default: "", describe: "file JSONL delle operazioni (default: ./repair-ghost-<id>.jsonl)" })
  .help().argv;

const GHOST = String(args.ghost || "").trim();
const CANONICAL = String(args.canonical || "").trim();
const APPLY = args.apply === true;

const logPath = args.log || path.join(process.cwd(), `repair-ghost-${GHOST}.jsonl`);
const logStream = APPLY ? fs.createWriteStream(logPath, { flags: "a" }) : null;

// Checkpoint su file: in sessione agente il processo puo' essere interrotto e
// lo stdout bufferizzato si perde. Ogni scrittura effettuata finisce qui.
function record(op, detail) {
  const line = { at: new Date().toISOString(), op, ...detail };
  console.log(`  ${APPLY ? "✔" : "·"} ${op} ${JSON.stringify(detail)}`);
  if (logStream) logStream.write(`${JSON.stringify(line)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ghostToCanonicalId(docId) {
  return docId.split(GHOST).join(CANONICAL);
}

async function moveThreadMessages(db) {
  const threads = await db.collection("threads").where("titleId", "==", GHOST).get();
  console.log(`\n[1] thread del fantasma: ${threads.size}`);
  const threadIds = [];

  for (const threadDoc of threads.docs) {
    const targetThreadId = ghostToCanonicalId(threadDoc.id);
    threadIds.push(threadDoc.id);
    if (targetThreadId === threadDoc.id) {
      throw new Error(`l'id del thread ${threadDoc.id} non contiene il fantasma: migrazione non deducibile`);
    }
    const targetThread = await db.collection("threads").doc(targetThreadId).get();
    // Non si inventano thread: senza il gemello canonico la conversazione
    // finirebbe in un contenitore senza partecipanti ne' storia.
    if (!targetThread.exists) {
      throw new Error(`thread canonico assente: ${targetThreadId} — creane uno prima, o escludi questo thread`);
    }

    const messages = await threadDoc.ref.collection("messages").get();
    let newest = null;
    for (const message of messages.docs) {
      const targetRef = db.collection("threads").doc(targetThreadId).collection("messages").doc(message.id);
      const already = await targetRef.get();
      if (already.exists) {
        record("messaggio già presente nel thread canonico, salto", { from: message.ref.path, to: targetRef.path });
        continue;
      }
      const data = message.data() || {};
      if (APPLY) {
        // `createdAt` invariato: e' quello che tiene fuori le notifiche
        // (i trigger saltano i messaggi non contestuali all'evento) e che fa
        // rinascere il post-eco con la data giusta.
        await targetRef.set(data);
        await message.ref.delete();
      }
      record("messaggio spostato", { from: message.ref.path, to: targetRef.path, uid: data.uid || null });
      const at = data.createdAt?.toMillis?.() || 0;
      if (!newest || at > newest.at) newest = { at, id: message.id, data };
    }

    // I campi `lastMessage*` del thread li scrive il client quando invia, non
    // un trigger: senza questo la discussione canonica resterebbe ferma
    // all'anteprima vecchia pur avendo il messaggio nuovo dentro.
    if (newest) {
      const targetData = targetThread.data() || {};
      const targetLastAt = targetData.lastMessageAt?.toMillis?.() || 0;
      if (newest.at > targetLastAt) {
        const patch = {
          lastMessageAt: newest.data.createdAt,
          lastMessageId: newest.id,
          lastSenderUid: newest.data.uid || null,
          lastMessagePreview: String(newest.data.text || "").slice(0, 100),
        };
        if (APPLY) await db.collection("threads").doc(targetThreadId).update(patch);
        record("anteprima thread canonico aggiornata", { thread: targetThreadId, messaggio: newest.id });
      }
    }
  }
  return threadIds;
}

async function moveRatings(db) {
  const ratings = await db.collection("ratings").where("titleId", "==", GHOST).get();
  console.log(`\n[2] voti sul fantasma: ${ratings.size}`);
  for (const rating of ratings.docs) {
    const targetId = ghostToCanonicalId(rating.id);
    const target = await db.collection("ratings").doc(targetId).get();
    if (target.exists) {
      // Stesso utente, stesso livello: il voto canonico c'e' gia' (di solito e'
      // lo stesso voto dato due volte, una per id). Il duplicato se ne va.
      if (APPLY) await rating.ref.delete();
      record("voto duplicato cancellato", {
        id: rating.id, canonico: targetId, valore: rating.get("rating"), valoreCanonico: target.get("rating"),
      });
      continue;
    }
    if (APPLY) {
      await db.collection("ratings").doc(targetId).set({ ...rating.data(), titleId: CANONICAL });
      await rating.ref.delete();
    }
    record("voto spostato", { from: rating.id, to: targetId, valore: rating.get("rating") });
  }
}

async function moveTitleStates(db) {
  const states = await db.collectionGroup("titleStates").where("titleId", "==", GHOST).get();
  console.log(`\n[3] stati libreria sul fantasma: ${states.size}`);
  for (const state of states.docs) {
    const userRef = state.ref.parent.parent;
    const targetRef = userRef.collection("titleStates").doc(CANONICAL);
    const target = await targetRef.get();
    if (target.exists) {
      // Il titolo vero e' gia' in libreria: il fantasma e' una seconda riga
      // spuria (spesso con `mediaType: "movie"` e nessun progresso). Va via.
      if (APPLY) await state.ref.delete();
      record("stato duplicato cancellato", {
        uid: userRef.id,
        statoFantasma: state.get("state"),
        statoCanonico: target.get("state"),
      });
      continue;
    }
    const data = state.data() || {};
    const snapshot = data.titleSnapshot && typeof data.titleSnapshot === "object" ? data.titleSnapshot : null;
    if (APPLY) {
      await targetRef.set({
        ...data,
        titleId: CANONICAL,
        ...(snapshot ? { titleSnapshot: { ...snapshot, titleId: CANONICAL } } : {}),
      });
      await state.ref.delete();
    }
    record("stato spostato", { uid: userRef.id, stato: data.state || null });
  }
}

async function moveFeedEvents(db) {
  const events = await db.collection("feedEvents").where("titleId", "==", GHOST).get();
  console.log(`\n[4] eventi feed sul fantasma: ${events.size}`);
  const canonicalEvents = await db.collection("feedEvents").where("titleId", "==", CANONICAL).get();
  const seen = new Set(canonicalEvents.docs.map((d) => [d.get("ownerUid"), d.get("actorUid"), d.get("eventType")].join("|")));

  for (const event of events.docs) {
    const key = [event.get("ownerUid"), event.get("actorUid"), event.get("eventType")].join("|");
    if (seen.has(key)) {
      // Il gemello canonico c'e' gia': ripuntare mostrerebbe la stessa riga due
      // volte nel feed di quella persona.
      if (APPLY) await event.ref.delete();
      record("evento feed duplicato cancellato", { id: event.id, chiave: key });
      continue;
    }
    if (APPLY) await event.ref.update({ titleId: CANONICAL });
    record("evento feed ripuntato", { id: event.id, chiave: key });
  }
}

async function movePosts(db) {
  const posts = await db.collection("posts").where("titleId", "==", GHOST).get();
  console.log(`\n[5] post sul fantasma: ${posts.size}`);
  for (const post of posts.docs) {
    // I post-eco dei commenti li rigenera il trigger sul messaggio spostato
    // (id deterministico thread+messaggio): toccarli a mano creerebbe un
    // doppione che nessuna cancellazione a valle raggiunge.
    if (post.get("sourceKind") === "thread_comment" || post.get("sourceThreadId")) {
      record("post-eco lasciato ai trigger", { id: post.id, thread: post.get("sourceThreadId") || null });
      continue;
    }
    const scope = post.get("spoilerScope");
    const patch = { titleId: CANONICAL };
    if (scope && typeof scope === "object") patch.spoilerScope = { ...scope, titleId: CANONICAL };
    if (APPLY) await post.ref.update(patch);
    record("post ripuntato", { id: post.id });
  }
}

async function deleteGhostThreads(db, threadIds) {
  console.log(`\n[6] thread fantasma da cancellare: ${threadIds.length}`);
  for (const threadId of threadIds) {
    const ref = db.collection("threads").doc(threadId);
    const messages = await ref.collection("messages").limit(1).get();
    // In dry-run i messaggi sono ancora al loro posto per definizione: la
    // guardia vale solo quando si sta scrivendo davvero.
    if (APPLY && !messages.empty) {
      throw new Error(`il thread ${threadId} ha ancora messaggi: non lo cancello`);
    }
    if (APPLY) await db.recursiveDelete(ref);
    record("thread cancellato", { id: threadId });
  }
}

async function deleteGhostTitle(db) {
  const ref = db.collection("titles").doc(GHOST);
  const snap = await ref.get();
  if (!snap.exists) {
    record("titolo fantasma già assente", { id: GHOST });
    return;
  }
  if (snap.get("name")) {
    throw new Error(`titles/${GHOST} ora ha un name: non e' piu' un fantasma, mi fermo`);
  }
  const subs = await ref.listCollections();
  console.log(`\n[7] titolo fantasma (sottocollezioni: ${subs.map((c) => c.id).join(", ") || "nessuna"})`);
  if (APPLY) await db.recursiveDelete(ref);
  record("titolo fantasma cancellato", { id: GHOST });

  // La cache provider sopravvive alla cancellazione del titolo ed e' proprio da
  // li' che il backfill lo faceva rinascere: se ne va con lui.
  const cacheRef = db.collection("titleProviders").doc(GHOST);
  if ((await cacheRef.get()).exists) {
    if (APPLY) await cacheRef.delete();
    record("cache provider cancellata", { id: GHOST });
  }
}

async function verify(db) {
  const checks = {};
  for (const col of ["ratings", "posts", "threads", "feedEvents", "characterVotes", "titleEmotions", "recommendations"]) {
    // eslint-disable-next-line no-await-in-loop
    checks[col] = (await db.collection(col).where("titleId", "==", GHOST).get()).size;
  }
  checks.titleStates = (await db.collectionGroup("titleStates").where("titleId", "==", GHOST).get()).size;
  checks.titleDoc = (await db.collection("titles").doc(GHOST).get()).exists ? 1 : 0;
  const residui = Object.entries(checks).filter(([, v]) => v > 0);
  console.log(`\nverifica finale: ${residui.length ? JSON.stringify(Object.fromEntries(residui)) : "nessun riferimento residuo"}`);
  return residui.length === 0;
}

(async () => {
  if (!args["delete-only"] && !CANONICAL) {
    throw new Error("serve --canonical (oppure --delete-only per un fantasma senza riferimenti)");
  }
  admin.initializeApp({ projectId: args.project });
  const db = admin.firestore();

  const ghostSnap = await db.collection("titles").doc(GHOST).get();
  if (!ghostSnap.exists) throw new Error(`titles/${GHOST} non esiste`);
  if (ghostSnap.get("name")) throw new Error(`titles/${GHOST} ha un name ("${ghostSnap.get("name")}"): non e' un fantasma`);

  console.log(`fantasma  ${GHOST}  campi: ${Object.keys(ghostSnap.data() || {}).sort().join(", ")}`);

  if (!args["delete-only"]) {
    const canonicalSnap = await db.collection("titles").doc(CANONICAL).get();
    if (!canonicalSnap.exists) throw new Error(`titles/${CANONICAL} non esiste`);
    if (!canonicalSnap.get("name")) throw new Error(`titles/${CANONICAL} non ha name: non e' un canonico valido`);
    console.log(`canonico  ${CANONICAL}  "${canonicalSnap.get("name")}"  tmdbId=${canonicalSnap.get("tmdbId")}  mergedTmdbIds=${JSON.stringify(canonicalSnap.get("mergedTmdbIds") || [])}`);

    // Il legame dev'essere dichiarato nel dato, non dedotto da chi lancia lo
    // script: per un id `tmdb_<type>_<n>` il canonico deve possedere quel
    // tmdbId, direttamente o via merge.
    const match = /^tmdb_(movie|tv)_(\d+)$/.exec(GHOST);
    if (match) {
      const tmdbId = Number(match[2]);
      const owned = Number(canonicalSnap.get("tmdbId")) === tmdbId
        || (Array.isArray(canonicalSnap.get("mergedTmdbIds")) && canonicalSnap.get("mergedTmdbIds").includes(tmdbId));
      if (!owned) {
        throw new Error(`${CANONICAL} non dichiara il tmdbId ${tmdbId} (ne' in tmdbId ne' in mergedTmdbIds)`);
      }
    }
  }

  console.log(APPLY ? `\nAPPLICO (log: ${logPath})` : "\n(dry-run: nessuna scrittura)");

  let threadIds = [];
  if (!args["delete-only"]) {
    threadIds = await moveThreadMessages(db);
    await moveRatings(db);
    await moveTitleStates(db);
    await moveFeedEvents(db);
    await movePosts(db);

    if (APPLY && args["settle-ms"] > 0) {
      console.log(`\nattendo ${args["settle-ms"]}ms che i trigger si assestino...`);
      await sleep(args["settle-ms"]);
    }
    await deleteGhostThreads(db, threadIds);
  }

  await deleteGhostTitle(db);

  if (APPLY) {
    await sleep(3000);
    const clean = await verify(db);
    if (logStream) logStream.end();
    process.exit(clean ? 0 : 3);
  }

  console.log("\n(dry-run) rilancia con --apply per eseguire.");
  process.exit(0);
})().catch((err) => {
  console.error("errore:", err.message);
  process.exit(1);
});
