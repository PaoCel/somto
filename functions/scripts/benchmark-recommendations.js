#!/usr/bin/env node
"use strict";

// Benchmark OFFLINE del motore di raccomandazione.
//
// Gira interamente su un file JSON prodotto da scripts/export-reco-dataset.js:
// zero letture Firestore, zero scritture, nessun effetto su produzione. Si puo'
// rilanciare quante volte serve mentre si tarano i pesi.
//
// Cosa risponde: "questa modifica migliora davvero i consigli, o mi sembra e
// basta?". Confronta piu' modelli sullo STESSO split temporale, sullo STESSO
// pool di candidati e con le STESSE esclusioni.
//
// Uso:
//   node scripts/benchmark-recommendations.js --dataset=/tmp/reco.json
//   node scripts/benchmark-recommendations.js --dataset=/tmp/reco.json --k=10 --test-fraction=0.2
//   node scripts/benchmark-recommendations.js --dataset=/tmp/reco.json --models=popularity,somto,itemknn
//   node scripts/benchmark-recommendations.js --dataset=/tmp/reco.json --json=/tmp/report.json
//
// Confronto fra due run (dopo aver cambiato i pesi):
//   node scripts/benchmark-recommendations.js ... --json=/tmp/prima.json
//   ...modifica lib/recommendationEngine.js...
//   node scripts/benchmark-recommendations.js ... --json=/tmp/dopo.json --baseline=/tmp/prima.json

const fs = require("fs");
const path = require("path");

const B = require("../lib/recoBenchmark");

const ALL_MODELS = ["popularity", "somto", "somto-top", "itemknn", "hybrid"];

function parseArgs(argv) {
  const out = {
    k: 10,
    testFraction: 0.2,
    minTrain: 5,
    seed: 1337,
    maxUsers: 0,
    levels: "title",
    signal: "both",
    split: "temporal",
    collabSeeds: B.MAX_COLLAB_SEEDS,
    minCoOcc: 2,
    collabWeight: 6,
    models: ["popularity", "somto", "somto-top", "itemknn"],
  };
  for (const raw of argv.slice(2)) {
    const [key, value = ""] = raw.replace(/^--/, "").split("=");
    switch (key) {
      case "dataset": out.dataset = value; break;
      case "k": out.k = Number(value) || 10; break;
      case "test-fraction": out.testFraction = Number(value) || 0.2; break;
      case "min-train": out.minTrain = Number(value) || 5; break;
      case "seed": out.seed = Number(value) || 1337; break;
      case "max-users": out.maxUsers = Number(value) || 0; break;
      case "models": out.models = value.split(",").map((s) => s.trim()).filter(Boolean); break;
      case "json": out.jsonOut = value; break;
      case "baseline": out.baseline = value; break;
      case "pool": out.pool = value; break;
      case "levels": out.levels = value; break;
      case "signal": out.signal = value; break;
      case "split": out.split = value; break;
      case "collab-seeds": out.collabSeeds = Number(value) || 0; break;
      case "min-cooc": out.minCoOcc = Number(value) || 0; break;
      case "collab-weight": out.collabWeight = Number(value) || 0; break;
      case "max-items-per-user": out.maxItemsPerUser = Number(value) || 0; break;
      default: break;
    }
  }
  return out;
}

function fmt(value) {
  if (!Number.isFinite(value)) return "-";
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(4);
}

function printTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");
  console.log(line(columns));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(columns.map((c) => row[c] ?? "")));
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.dataset) {
    console.error("Manca --dataset=/percorso/dataset.json (crealo con scripts/export-reco-dataset.js)");
    process.exit(1);
  }

  const unknown = args.models.filter((m) => !ALL_MODELS.includes(m));
  if (unknown.length) {
    console.error(`Modelli sconosciuti: ${unknown.join(", ")}. Disponibili: ${ALL_MODELS.join(", ")}`);
    process.exit(1);
  }

  const dataset = JSON.parse(fs.readFileSync(path.resolve(args.dataset), "utf8"));
  // --- interazioni ---------------------------------------------------------
  const useRatings = args.signal === "ratings" || args.signal === "both";
  const useWatched = args.signal === "watched" || args.signal === "both";
  const interactions = B.buildInteractions({
    ratings: dataset.ratings || [],
    watched: dataset.watched || [],
    levels: args.levels,
    useRatings,
    useWatched,
  });

  // --- split ---------------------------------------------------------------
  let evalUsers;
  let cutoffMs = 0;
  let train;
  let test;
  if (args.split === "holdout") {
    train = interactions;
    test = [];
    evalUsers = B.buildHoldoutUsers({
      interactions,
      testFraction: args.testFraction,
      minTrain: args.minTrain,
      random: B.seededRandom(args.seed),
    });
  } else {
    cutoffMs = B.pickCutoffByQuantile(interactions, args.testFraction);
    ({ train, test } = B.splitTemporal(interactions, cutoffMs));
    evalUsers = B.buildEvalUsers({ train, test, minTrain: args.minTrain });
  }
  const modelTrainRows = args.split === "holdout"
    ? evalUsers.flatMap((u) => u.trainRows)
    : (train || []);
  const titles = B.buildEvaluationCatalog(dataset.titles, modelTrainRows, {
    cutoffMs,
    temporal: args.split !== "holdout",
  });
  const titlesById = titles.byId;
  evalUsers = B.restrictEvalUsersToCatalog(evalUsers, titlesById);
  if (args.maxUsers) evalUsers = evalUsers.slice(0, args.maxUsers);
  const effectiveCollabSeeds = Math.min(args.collabSeeds, B.MAX_COLLAB_SEEDS);

  console.log("");
  console.log(`dataset      ${path.resolve(args.dataset)} (${dataset.source || "?"})`);
  console.log(`catalogo     ${titlesById.size}/${dataset.titles.length} titoli visibili al momento della predizione`);
  console.log(`segnale      ${args.signal} — ${dataset.ratings.length} voti (livelli=${args.levels}) + ${(dataset.watched || []).length} stati titolo`);
  console.log(`interazioni  ${interactions.length} coppie utente-titolo`);
  if (args.split === "holdout") {
    console.log(`split        holdout per utente ${args.testFraction} — ATTENZIONE: NON temporale.`);
    console.log(`             Usalo solo dove i timestamp sono date di import e un ordine temporale sarebbe finto.`);
  } else {
    console.log(`split        temporale, cutoff ${new Date(cutoffMs).toISOString().slice(0, 10)} (quantile ${args.testFraction}) — train ${train.length} / test ${test.length}`);
  }
  console.log(`utenti       ${evalUsers.length} valutabili (>= ${args.minTrain} voti prima, >= 1 titolo piaciuto dopo)`);
  console.log(`k            ${args.k} — seed ${args.seed}`);
  console.log("");

  if (!evalUsers.length) {
    console.error("Nessun utente valutabile: prova ad abbassare --min-train, alzare --test-fraction o usare --signal=both.");
    process.exit(1);
  }
  if (evalUsers.length < 30) {
    console.log(`ATTENZIONE: solo ${evalUsers.length} utenti valutabili. I numeri qui sotto sono indicativi,`);
    console.log("            non abbastanza per dichiarare un miglioramento. Servono piu' dati.");
    console.log("");
  }

  // "Adesso" fissato al cutoff: il decay del taste profile e il boost di recency
  // dei seed devono vedere il mondo com'era al momento della predizione, non
  // oggi. Altrimenti il futuro rientra dalla finestra.
  // Nello split temporale "adesso" e' il cutoff: decay del profilo e recency dei
  // seed devono vedere il mondo com'era al momento della predizione. Nel holdout
  // non c'e' un cutoff, quindi si usa l'ultima interazione del dataset.
  const nowMs = args.split === "holdout"
    ? Math.max(...interactions.map((r) => r.atMs), 0)
    : cutoffMs;

  // Popolarita' calcolata SOLO sul train: usare i conteggi globali del catalogo
  // significherebbe far sapere alla baseline quanti voti un titolo prendera'
  // dopo il cutoff.
  const popularityByTitle = titles.popularityByTitle;
  const totalTrainUsers = titles.totalTrainUsers;

  // L'indice item-item si costruisce SOLO sulle righe di training: includere il
  // test vorrebbe dire far vedere al modello le risposte.
  const knnRows = modelTrainRows.map((r) => ({ ...r, rating: r.kind === "watched" ? 9 : r.rating }));
  const itemKnnIndex = (args.models.includes("itemknn") || args.models.includes("hybrid"))
    ? B.buildItemKnnIndex(knnRows, { minCoOccurrence: args.minCoOcc, maxItemsPerUser: args.maxItemsPerUser })
    : null;
  if (itemKnnIndex) {
    const st = itemKnnIndex.stats;
    console.log(`indice knn   ${st.indexedItems} titoli con vicini (min co-visioni ${args.minCoOcc}, ${st.users} utenti, ${st.pairs} coppie) — max ${effectiveCollabSeeds} seed a runtime`);
    console.log("");
  }

  const runsByModel = new Map(args.models.map((m) => [m, []]));
  const startedAt = Date.now();

  for (const user of evalUsers) {
    const tasteProfile = B.buildOfflineTasteProfile(user.trainRows, titlesById, nowMs);
    const { seedTitles, seedScoreByTitle } = B.buildOfflineSeeds(user.trainRows, titlesById, nowMs);
    const seedStats = B.buildSeedStats(seedTitles, { genreLabelMap: null });
    const peopleAffinity = B.buildPeopleAffinity(seedTitles, seedScoreByTitle);

    const pool = args.pool === "full"
      ? titlesById
      : B.buildOfflineCandidatePool(titles, seedTitles, {
        byPopularity: titles.byPopularity,
        byRecency: titles.byRecency,
      });

    // Stesse esclusioni per tutti i modelli: gia' visto prima del cutoff + i
    // seed stessi (in produzione i seed sono per definizione gia' consumati).
    const excluded = new Set(user.seenTitleIds);
    for (const t of seedTitles) excluded.add(String(t.id));

    // La produzione interroga l'indice soltanto per i seed materializzati da
    // resolveSeedTitles (max 8), non per tutte le interazioni positive.
    const collabSeedIds = seedTitles.map((t) => String(t.id));

    for (const model of args.models) {
      let recommended = [];
      if (model === "popularity") {
        recommended = B.recommendPopularity({ pool, excluded, k: args.k });
      } else if (model === "somto") {
        recommended = B.recommendSomto({
          pool, excluded, k: args.k, seedStats, seedCount: seedTitles.length,
          peopleAffinity, tasteProfile, collabSignals: null,
          applyDeck: true, random: B.seededRandom(args.seed), nowMs,
        });
      } else if (model === "somto-top") {
        recommended = B.recommendSomto({
          pool, excluded, k: args.k, seedStats, seedCount: seedTitles.length,
          peopleAffinity, tasteProfile, collabSignals: null,
          applyDeck: false, random: B.seededRandom(args.seed), nowMs,
        });
      } else if (model === "itemknn") {
        recommended = B.recommendItemKnn({
          pool, excluded, k: args.k, likedTitleIds: collabSeedIds,
          index: itemKnnIndex, maxSeeds: effectiveCollabSeeds,
        });
      } else if (model === "hybrid") {
        // Scoring Somto con i vicini item-item passati come segnale collaborativo,
        // cioe' la forma che avrebbe un collaborativo PRECALCOLATO in produzione.
        // Il coseno vive su una scala diversa da quella per cui era tarato il
        // bonus collaborativo di scoreCandidate (clamp(score*0.8, 0, 4.8)):
        // senza riscalare, il segnale collaborativo verrebbe schiacciato dal
        // punteggio di genere. `--collab-weight` serve a trovare la scala giusta.
        const collab = B.collabSignalsFor(itemKnnIndex, collabSeedIds, {
          maxSeeds: effectiveCollabSeeds,
          excludedIds: excluded,
          scale: args.collabWeight,
        });
        recommended = B.recommendSomto({
          pool, excluded, k: args.k, seedStats, seedCount: seedTitles.length,
          peopleAffinity, tasteProfile, collabSignals: collab,
          applyDeck: true, random: B.seededRandom(args.seed), nowMs,
        });
      }
      runsByModel.get(model).push({ uid: user.uid, recommended, positives: user.positives });
    }
  }

  const report = {
    generatedAtMs: Date.now(),
    dataset: path.resolve(args.dataset),
    datasetSource: dataset.source || null,
    cutoffMs,
    split: args.split,
    signal: args.signal,
    collabSeeds: effectiveCollabSeeds,
    minCoOcc: args.minCoOcc,
    collabWeight: args.collabWeight,
    temporal: args.split !== "holdout",
    k: args.k,
    seed: args.seed,
    pool: args.pool === "full" ? "full" : "production-like",
    levels: args.levels,
    users: evalUsers.length,
    catalogSize: titlesById.size,
    models: {},
  };

  for (const model of args.models) {
    report.models[model] = B.summarizeRuns({
      runs: runsByModel.get(model),
      titlesById,
      catalogSize: titlesById.size,
      popularityByTitle,
      totalUsers: totalTrainUsers,
      k: args.k,
    });
  }

  const rows = args.models.map((model) => {
    const m = report.models[model];
    return {
      modello: model,
      [`recall@${args.k}`]: fmt(m[`recall@${args.k}`]),
      [`ndcg@${args.k}`]: fmt(m[`ndcg@${args.k}`]),
      [`map@${args.k}`]: fmt(m[`map@${args.k}`]),
      hitRate: fmt(m.hitRate),
      coverage: fmt(m.coverage),
      diversity: fmt(m.diversity),
      novelty: fmt(m.novelty),
      vuote: String(m.emptyLists),
    };
  });
  printTable(rows, ["modello", `recall@${args.k}`, `ndcg@${args.k}`, `map@${args.k}`, "hitRate", "coverage", "diversity", "novelty", "vuote"]);

  // Confronto con una run precedente: e' il modo per dire "questa modifica
  // migliora" senza fidarsi dell'impressione.
  if (args.baseline) {
    const base = JSON.parse(fs.readFileSync(path.resolve(args.baseline), "utf8"));
    console.log("");
    console.log(`delta vs baseline ${path.resolve(args.baseline)}`);
    const deltaRows = [];
    for (const model of args.models) {
      const now = report.models[model];
      const before = base.models?.[model];
      if (!before) continue;
      const d = (key) => {
        const a = Number(before[key] || 0);
        const b = Number(now[key] || 0);
        const diff = b - a;
        const pct = a ? ((diff / a) * 100) : 0;
        return `${diff >= 0 ? "+" : ""}${fmt(diff)} (${diff >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
      };
      deltaRows.push({
        modello: model,
        [`recall@${args.k}`]: d(`recall@${args.k}`),
        [`ndcg@${args.k}`]: d(`ndcg@${args.k}`),
        coverage: d("coverage"),
        diversity: d("diversity"),
      });
    }
    if (deltaRows.length) printTable(deltaRows, ["modello", `recall@${args.k}`, `ndcg@${args.k}`, "coverage", "diversity"]);
    else console.log("(nessun modello in comune con la baseline)");
  }

  console.log("");
  console.log(`completato in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  if (args.jsonOut) {
    const outPath = path.resolve(args.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`report salvato in ${outPath}`);
  }
}

main();
