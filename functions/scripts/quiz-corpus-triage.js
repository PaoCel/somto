#!/usr/bin/env node
"use strict";

/**
 * Esporta il triage di quizQuestions e, solo con flag espliciti, applica le
 * transizioni di stato già valutate dalla logica pura.
 *
 * Uso (da functions/):
 *   node scripts/quiz-corpus-triage.js
 *   node scripts/quiz-corpus-triage.js --limit 100
 *   node scripts/quiz-corpus-triage.js --write-flagged
 *   node scripts/quiz-corpus-triage.js --write-approved
 *   node scripts/quiz-corpus-triage.js --write-flagged --write-approved --yes
 *
 * Il default è dry-run: legge Firestore e scrive solo report locali. Ogni
 * operazione remota salva prima un backup JSON completo e create-only.
 */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { triageQuizCorpus } = require("../lib/quizCorpusTriage");

const PROJECT_ID = "gia-visto";
const BATCH_SIZE = 400;
const ROOT = path.resolve(__dirname, "../..");

const args = yargs(hideBin(process.argv))
  .strict()
  .option("write-flagged", {
    type: "boolean",
    default: false,
    describe: "Imposta a flagged le trivia di produzione",
  })
  .option("write-approved", {
    type: "boolean",
    default: false,
    describe: "Promuove ad approved le candidate pronte",
  })
  .option("yes", {
    type: "boolean",
    default: false,
    describe: "Conferma l'esecuzione con entrambe le write",
  })
  .option("limit", {
    type: "number",
    describe: "Limita i documenti letti per una prova",
  })
  .check((values) => {
    if (values.limit !== undefined && (!Number.isInteger(values.limit) || values.limit <= 0)) {
      throw new Error("--limit deve essere un intero positivo");
    }
    if (values.writeFlagged && values.writeApproved && !values.yes) {
      throw new Error("Le due write insieme richiedono --yes");
    }
    return true;
  })
  .help()
  .parseSync();

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function encodeFirestore(value) {
  if (value instanceof admin.firestore.Timestamp) {
    return { __somtoType: "timestamp", millis: value.toMillis() };
  }
  if (value instanceof Date) return { __somtoType: "date", iso: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeFirestore);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeFirestore(item)]));
  }
  return value;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatSummary(summary, options = {}) {
  const mode = options.writeFlagged || options.writeApproved ? "WRITE" : "DRY-RUN";
  const limit = options.limit ? String(options.limit) : "nessuno";
  const lines = [
    "# Triage corpus quiz",
    "",
    `- Data: ${options.date || dateStamp()}`,
    `- Progetto: ${PROJECT_ID}`,
    `- Modalità: ${mode}`,
    `- Limite lettura: ${limit}`,
    `- Domande lette: ${summary.totalQuestions}`,
    `- Tell forte: ${summary.counts.tellStrong}`,
    `- Trivia di produzione: ${summary.counts.productionTrivia}`,
    `- Candidate approved: ${summary.counts.approvedCandidates}`,
    "",
    "## Conteggi per titolo",
    "",
    "| titleId | titolo | totale | tell forte | trivia produzione | candidate approved |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];

  for (const row of summary.byTitle) {
    lines.push(`| ${markdownCell(row.titleId)} | ${markdownCell(row.title)} | ${row.totalQuestions} | ${row.tellStrong} | ${row.productionTrivia} | ${row.approvedCandidates} |`);
  }
  return `${lines.join("\n")}\n`;
}

function writeJson(filePath, value, options = {}) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...options,
  });
}

function writeReports(report, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, "tell-strong.json"), report.tellStrong);
  writeJson(path.join(outputDir, "production-trivia.json"), report.productionTrivia);
  writeJson(path.join(outputDir, "approved-candidates.json"), report.approvedCandidates);
  fs.writeFileSync(path.join(outputDir, "summary.md"), formatSummary(report.summary, {
    date: path.basename(outputDir),
    limit: args.limit,
    writeFlagged: args.writeFlagged,
    writeApproved: args.writeApproved,
  }));
}

async function readQuizQuestions(db) {
  let query = db.collection("quizQuestions");
  if (args.limit) query = query.limit(args.limit);
  const snapshot = await query.get();
  return {
    rows: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    snapshotsById: new Map(snapshot.docs.map((doc) => [doc.id, doc])),
  };
}

function backupOperation(outputDir, operation, rows, snapshotsById) {
  const documents = rows.map((row) => {
    const snapshot = snapshotsById.get(row.id);
    if (!snapshot?.exists) throw new Error(`Documento ${row.id} non disponibile per il backup`);
    return {
      id: snapshot.id,
      updateTime: snapshot.updateTime?.toDate().toISOString() || null,
      data: encodeFirestore(snapshot.data()),
    };
  });
  const backupPath = path.join(outputDir, `backup-${operation}-${timestamp()}.json`);
  writeJson(backupPath, {
    schemaVersion: 1,
    project: PROJECT_ID,
    operation,
    createdAt: new Date().toISOString(),
    documentCount: documents.length,
    documents,
  }, { flag: "wx", mode: 0o600 });
  return backupPath;
}

async function applyUpdates(db, operation, rows, snapshotsById, updateForRow) {
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const chunk = rows.slice(index, index + BATCH_SIZE);
    const batch = db.batch();
    for (const row of chunk) {
      const snapshot = snapshotsById.get(row.id);
      if (!snapshot?.exists) throw new Error(`Documento ${row.id} non disponibile per la write`);
      batch.update(snapshot.ref, updateForRow(row), { lastUpdateTime: snapshot.updateTime });
    }
    await batch.commit();
    process.stdout.write(`${operation}: scritti ${Math.min(index + BATCH_SIZE, rows.length)}/${rows.length}\n`);
  }
}

async function main() {
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();
  const { rows, snapshotsById } = await readQuizQuestions(db);
  const report = triageQuizCorpus(rows);
  const outputDir = path.join(ROOT, "quiz_beta", "triage", dateStamp());
  writeReports(report, outputDir);

  process.stdout.write(formatSummary(report.summary, {
    date: dateStamp(),
    limit: args.limit,
    writeFlagged: args.writeFlagged,
    writeApproved: args.writeApproved,
  }));
  process.stdout.write(`Report scritti in ${path.relative(ROOT, outputDir)}\n`);

  const operations = [];
  if (args.writeFlagged) {
    operations.push({
      name: "flagged",
      rows: report.productionTrivia,
      updateForRow: (row) => ({
        status: "flagged",
        auditNote: `Trivia di produzione (${row.matchedPattern}); triage ${dateStamp()}.`,
      }),
    });
  }
  if (args.writeApproved) {
    operations.push({
      name: "approved",
      rows: report.approvedCandidates,
      updateForRow: () => ({ status: "approved" }),
    });
  }

  if (!operations.length) {
    process.stdout.write("[dry-run] Nessun documento Firestore scritto.\n");
    return;
  }

  for (const operation of operations) {
    const backupPath = backupOperation(outputDir, operation.name, operation.rows, snapshotsById);
    process.stdout.write(`Backup ${operation.name}: ${path.relative(ROOT, backupPath)}\n`);
  }
  for (const operation of operations) {
    await applyUpdates(db, operation.name, operation.rows, snapshotsById, operation.updateForRow);
  }
  process.stdout.write("Write completata. Nessun deploy eseguito.\n");
}

main().catch((error) => {
  process.stderr.write(`quiz-corpus-triage fallito: ${error?.message || error}\n`);
  process.exitCode = 1;
});
