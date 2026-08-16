// Smoke test Storage rules contro Somto emulator (JDK 21+).
//
// Avvio:
//   Terminale 1: firebase emulators:start --only firestore,storage --project gia-visto-test
//   Terminale 2: cd scripts/test-storage && npm install && npm test
//
// IMPORTANTE: il flag `--project gia-visto-test` è OBBLIGATORIO (deve
// combaciare col `projectId` passato a initializeTestEnvironment qui sotto).
// Le funzioni cross-service `firestore.get()`/`firestore.exists()` usate da
// manualImports (vedi storage.rules) risolvono il progetto Firestore tramite
// l'Emulator Hub in base al progetto CLI attivo: se avvii l'emulatore senza
// `--project` (default da .firebaserc, es. "gia-visto") il cross-service
// lookup non trova il progetto giusto e fallisce silenziosamente (ogni
// upload manualImports risulterebbe DENIED anche a rules corrette) — non è
// un bug delle rules, è solo un mismatch di progetto tra CLI e test client.
// In produzione non si presenta mai (un solo progetto reale per sempre).
//
// Copre PACK A fix #5 (peopleAvatars scoped + SVG block + size cap),
// regression check su posters/{uid} e reviewPhotos/{uid}, e manualImports/
// (upload diretto Refract, gate cross-service su users/{uid}/imports/{id}.status).

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ref, uploadBytes, getDownloadURL,
} from "firebase/storage";
import { doc, setDoc } from "firebase/firestore";

const REPO = resolve(import.meta.dirname, "..", "..");
const rules = readFileSync(resolve(REPO, "storage.rules"), "utf8");

const env = await initializeTestEnvironment({
  projectId: "gia-visto-test",
  storage: {
    host: "127.0.0.1",
    port: 58081,
    rules,
  },
  firestore: {
    host: "127.0.0.1",
    port: 58080,
    rules: `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /{document=**} {
            allow read, write: if request.auth != null;
          }
        }
      }
    `,
  },
});

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`FAIL ${name}\n   ${e.message}`);
    fail++;
  }
}

const ALICE = "uid_alice";
const BOB = "uid_bob";

// Helper: crea un Uint8Array di N byte con valore costante (compress-resistant per
// metadata size purposes -- l'emulator legge la byteLength).
function bytesOfSize(sizeBytes) {
  const a = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) a[i] = (i & 0xff);
  return a;
}

const aliceStorage = env.authenticatedContext(ALICE).storage();
const bobStorage = env.authenticatedContext(BOB).storage();
const anonStorage = env.unauthenticatedContext().storage();

await env.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  await setDoc(doc(db, `users/${ALICE}/imports/import_uploading`), {
    status: "uploading",
    startedBy: ALICE,
  });
  await setDoc(doc(db, `users/${ALICE}/imports/import_done`), {
    status: "manual_processing",
    startedBy: ALICE,
  });
});

// =============================================================
// PACK A fix #5 - peopleAvatars scoped + SVG block + size cap
// =============================================================

await test("peopleAvatars/personX/avatar.jpg 100KB image/jpeg da signed-in -> OK", async () => {
  const r = ref(aliceStorage, "peopleAvatars/personX/avatar.jpg");
  await assertSucceeds(uploadBytes(r, bytesOfSize(100 * 1024), {
    contentType: "image/jpeg",
  }));
});

await test("peopleAvatars/personX/evil.svg image/svg+xml -> DENIED (SVG blocked)", async () => {
  const r = ref(aliceStorage, "peopleAvatars/personX/evil.svg");
  await assertFails(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "image/svg+xml",
  }));
});

await test("peopleAvatars/personX/big.jpg 400KB -> DENIED (>300KB cap)", async () => {
  const r = ref(aliceStorage, "peopleAvatars/personX/big.jpg");
  await assertFails(uploadBytes(r, bytesOfSize(400 * 1024), {
    contentType: "image/jpeg",
  }));
});

await test("peopleAvatars flat (peopleAvatars/old.jpg) -> DENIED (legacy read-only)", async () => {
  const r = ref(aliceStorage, "peopleAvatars/old.jpg");
  await assertFails(uploadBytes(r, bytesOfSize(50 * 1024), {
    contentType: "image/jpeg",
  }));
});

await test("peopleAvatars/personX/avatar.jpg read da anonimo -> OK (read public)", async () => {
  // L'upload soprastante l'ha gia messo. Anonimo legge URL pubblico.
  const r = ref(anonStorage, "peopleAvatars/personX/avatar.jpg");
  await assertSucceeds(getDownloadURL(r));
});

await test("peopleAvatars/personX/avatar.gif image/gif 50KB -> OK", async () => {
  const r = ref(aliceStorage, "peopleAvatars/personY/avatar.gif");
  await assertSucceeds(uploadBytes(r, bytesOfSize(50 * 1024), {
    contentType: "image/gif",
  }));
});

await test("peopleAvatars unauth user -> DENIED (richiede isSignedIn)", async () => {
  const r = ref(anonStorage, "peopleAvatars/personZ/avatar.jpg");
  await assertFails(uploadBytes(r, bytesOfSize(50 * 1024), {
    contentType: "image/jpeg",
  }));
});

// =============================================================
// posters/{uid}/... scope check
// =============================================================

await test("posters/alice/poster.jpg upload da Alice -> OK", async () => {
  const r = ref(aliceStorage, `posters/${ALICE}/poster.jpg`);
  await assertSucceeds(uploadBytes(r, bytesOfSize(200 * 1024), {
    contentType: "image/jpeg",
  }));
});

await test("posters/alice/poster.jpg upload da Bob -> DENIED (cross-user write)", async () => {
  const r = ref(bobStorage, `posters/${ALICE}/poster.jpg`);
  await assertFails(uploadBytes(r, bytesOfSize(100 * 1024), {
    contentType: "image/jpeg",
  }));
});

await test("posters/alice/big.jpg 7MB -> DENIED (>6MB cap)", async () => {
  const r = ref(aliceStorage, `posters/${ALICE}/big.jpg`);
  await assertFails(uploadBytes(r, bytesOfSize(7 * 1024 * 1024), {
    contentType: "image/jpeg",
  }));
});

await test("posters/alice/script.exe contentType non-image -> DENIED", async () => {
  const r = ref(aliceStorage, `posters/${ALICE}/script.exe`);
  await assertFails(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "application/octet-stream",
  }));
});

// =============================================================
// reviewPhotos/{uid}/... scope check
// =============================================================

await test("reviewPhotos/alice/p.jpg upload da Alice -> OK", async () => {
  const r = ref(aliceStorage, `reviewPhotos/${ALICE}/p.jpg`);
  await assertSucceeds(uploadBytes(r, bytesOfSize(100 * 1024), {
    contentType: "image/jpeg",
  }));
});

await test("reviewPhotos/alice/p.jpg upload da Bob -> DENIED (cross-user write)", async () => {
  const r = ref(bobStorage, `reviewPhotos/${ALICE}/p.jpg`);
  await assertFails(uploadBytes(r, bytesOfSize(100 * 1024), {
    contentType: "image/jpeg",
  }));
});

// =============================================================
// manualImports/{uid}/{importId}/... direct upload
// =============================================================

await test("manualImports/alice/import_uploading/movies.json da Alice -> OK", async () => {
  const r = ref(aliceStorage, `manualImports/${ALICE}/import_uploading/movies.json`);
  await assertSucceeds(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "application/json;charset=utf-8",
  }));
});

await test("manualImports/alice/import_uploading/movies.json da Bob -> DENIED", async () => {
  const r = ref(bobStorage, `manualImports/${ALICE}/import_uploading/movies.json`);
  await assertFails(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "application/json;charset=utf-8",
  }));
});

await test("manualImports/alice/import_missing/movies.json senza sessione -> DENIED", async () => {
  const r = ref(aliceStorage, `manualImports/${ALICE}/import_missing/movies.json`);
  await assertFails(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "application/json;charset=utf-8",
  }));
});

await test("manualImports/alice/import_done/movies.json dopo finalize -> DENIED", async () => {
  const r = ref(aliceStorage, `manualImports/${ALICE}/import_done/movies.json`);
  await assertFails(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "application/json;charset=utf-8",
  }));
});

await test("manualImports/alice/import_uploading/show_ratings.csv (voti serie) -> OK", async () => {
  const r = ref(aliceStorage, `manualImports/${ALICE}/import_uploading/show_ratings.csv`);
  await assertSucceeds(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "text/csv;charset=utf-8",
  }));
});

// La whitelist dei nomi e' il vero controllo: senza, un utente potrebbe
// depositare qualsiasi file nel proprio prefisso di import.
await test("manualImports/alice/import_uploading/qualsiasi.csv (fuori whitelist) -> DENIED", async () => {
  const r = ref(aliceStorage, `manualImports/${ALICE}/import_uploading/qualsiasi.csv`);
  await assertFails(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "text/csv;charset=utf-8",
  }));
});

await test("manualImports/alice/import_uploading/evil.html contentType non-json -> DENIED", async () => {
  const r = ref(aliceStorage, `manualImports/${ALICE}/import_uploading/evil.html`);
  await assertFails(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "text/html",
  }));
});

// =============================================================
// catch-all DENIED
// =============================================================

await test("path random (random/file.jpg) -> DENIED (catch-all)", async () => {
  const r = ref(aliceStorage, "random/file.jpg");
  await assertFails(uploadBytes(r, bytesOfSize(10 * 1024), {
    contentType: "image/jpeg",
  }));
});

await env.cleanup();
console.log(`\n=== ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
