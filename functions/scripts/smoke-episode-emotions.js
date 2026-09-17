"use strict";

// Smoke test reale per il trigger gen2 recomputeEpisodeEmotionAggregate.
//
// Usa Admin SDK intenzionalmente: le Firestore rules sono coperte dalla suite
// emulator, mentre questo script verifica il percorso Eventarc/Functions sul
// progetto deployato. Tutti i documenti hanno un prefisso riconoscibile e
// vengono eliminati nel finally.
//
// Esempi:
//   node scripts/smoke-episode-emotions.js --project somto-staging
//   node scripts/smoke-episode-emotions.js --project gia-visto \
//     --confirm-production gia-visto

const admin = require("firebase-admin");

const args = process.argv.slice(2);

function readArgument(name) {
  const exactIndex = args.indexOf(name);
  if (exactIndex >= 0) return args[exactIndex + 1] || "";
  const prefix = `${name}=`;
  const inline = args.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : "";
}

const projectId = readArgument("--project");
const productionConfirmation = readArgument("--confirm-production");

if (!projectId) {
  throw new Error("Passa --project <firebase-project-id>.");
}

if (projectId === "gia-visto" && productionConfirmation !== "gia-visto") {
  throw new Error(
    "Smoke production bloccato: passa --confirm-production gia-visto."
  );
}

if (projectId !== "gia-visto" && !/^somto-staging(?:[-a-z0-9]*)?$/.test(projectId)) {
  throw new Error(
    `Progetto non consentito per questo smoke test: ${projectId}`
  );
}

admin.initializeApp({ projectId });

const db = admin.firestore();
const suffix = `${Date.now()}_${process.pid}`;
const uid = `smoke_episode_emotions_${suffix}`;
const titleId = `smoke_episode_emotions_${suffix}`;
const emotionId = `${uid}__${titleId}__episode__1__1`;
const titleRef = db.doc(`titles/${titleId}`);
const emotionRef = db.doc(`episodeEmotions/${emotionId}`);
const aggregateRef = titleRef.collection("episodeEmotionAggregates").doc("1_1");

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function aggregateMatches(data, expected) {
  if (!data) return false;
  if (data.totalUsers !== expected.totalUsers) return false;
  if (data.totalSelections !== expected.totalSelections) return false;

  const counts = data.counts || {};
  const keys = Object.keys(counts).sort();
  const expectedKeys = Object.keys(expected.counts).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((key) => counts[key] === expected.counts[key])
  );
}

async function waitForAggregate(expected, label) {
  const timeoutAt = Date.now() + 90_000;
  let lastData = null;

  while (Date.now() < timeoutAt) {
    const snapshot = await aggregateRef.get();
    lastData = snapshot.exists ? snapshot.data() : null;
    if (aggregateMatches(lastData, expected)) return;
    await sleep(1_000);
  }

  throw new Error(
    `${label}: aggregate inatteso dopo 90s: ${JSON.stringify(lastData)}`
  );
}

async function cleanup() {
  await Promise.allSettled([
    emotionRef.delete(),
    aggregateRef.delete(),
  ]);
  await titleRef.delete().catch(() => {});
}

async function main() {
  console.log(`[episode-emotions smoke] project=${projectId}`);

  try {
    const now = admin.firestore.Timestamp.now();
    await titleRef.set({
      name: "Episode emotions trigger smoke",
      type: "tv",
      status: "approved",
      createdAt: now,
      updatedAt: now,
    });

    await emotionRef.set({
      uid,
      titleId,
      level: "episode",
      season: 1,
      episode: 1,
      emotions: ["touched", "tense"],
      source: "deployment_smoke",
      createdAt: now,
      updatedAt: now,
    });
    await waitForAggregate(
      {
        counts: { touched: 1, tense: 1 },
        totalSelections: 2,
        totalUsers: 1,
      },
      "create"
    );
    console.log("[episode-emotions smoke] create PASS");

    await emotionRef.update({
      emotions: ["amused"],
      updatedAt: admin.firestore.Timestamp.now(),
    });
    await waitForAggregate(
      {
        counts: { amused: 1 },
        totalSelections: 1,
        totalUsers: 1,
      },
      "update"
    );
    console.log("[episode-emotions smoke] update PASS");

    await emotionRef.delete();
    await waitForAggregate(
      {
        counts: {},
        totalSelections: 0,
        totalUsers: 0,
      },
      "delete"
    );
    console.log("[episode-emotions smoke] delete PASS");
  } finally {
    await cleanup();
    await admin.app().delete();
  }
}

main().catch((error) => {
  console.error(`[episode-emotions smoke] FAIL: ${error.message}`);
  process.exitCode = 1;
});
