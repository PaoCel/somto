#!/usr/bin/env node
/**
 * create-blog-post.js — Crea o aggiorna un post nel collection `blogPosts/{slug}`.
 *
 * Uso:
 *   node functions/scripts/create-blog-post.js \
 *     --slug il-mio-post \
 *     --title "Titolo del post" \
 *     --excerpt "Breve riassunto (max 280 char)" \
 *     --body path/to/body.md \
 *     [--cover https://example.com/cover.jpg] \
 *     [--author "Nome Autore"] \
 *     [--tags tag1,tag2] \
 *     [--format markdown|html] \
 *     [--status draft|published] \
 *     [--published "2026-05-21"]
 *
 * Richiede credenziali admin (Application Default Credentials oppure
 * GOOGLE_APPLICATION_CREDENTIALS che punta al service account json).
 */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { out[key] = true; continue; }
    out[key] = next; i++;
  }
  return out;
}

function slugify(s) {
  return String(s || "")
    .trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.title) throw new Error("--title obbligatorio");
  if (!args.body) throw new Error("--body /path/to/file obbligatorio");

  const slug = slugify(args.slug || args.title);
  if (!slug) throw new Error("slug non valido");

  const bodyPath = path.resolve(process.cwd(), String(args.body));
  if (!fs.existsSync(bodyPath)) throw new Error(`body file non trovato: ${bodyPath}`);
  const body = fs.readFileSync(bodyPath, "utf8");

  const format = ["markdown", "html"].includes(String(args.format || "").toLowerCase())
    ? String(args.format).toLowerCase() : "markdown";

  const status = ["draft", "published"].includes(String(args.status || "").toLowerCase())
    ? String(args.status).toLowerCase() : "published";

  const tags = typeof args.tags === "string"
    ? args.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const publishedAtMs = args.published ? Date.parse(String(args.published)) : Date.now();
  if (!publishedAtMs) throw new Error(`--published invalid: ${args.published}`);

  admin.initializeApp({ projectId: "gia-visto" });
  const db = admin.firestore();

  const data = {
    slug,
    title: String(args.title),
    excerpt: String(args.excerpt || "").slice(0, 280),
    coverImage: args.cover ? String(args.cover) : null,
    body,
    bodyFormat: format,
    publishedAt: admin.firestore.Timestamp.fromMillis(publishedAtMs),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    tags,
    author: args.author ? { name: String(args.author), photoURL: null } : { name: "Somto", photoURL: null },
    status,
  };

  await db.collection("blogPosts").doc(slug).set(data, { merge: true });
  console.log(`✓ blog post "${slug}" salvato (status: ${status})`);
  console.log(`  URL: https://somto.it/blog/post/?slug=${encodeURIComponent(slug)}`);
}

main().catch((err) => {
  console.error("✗ errore:", err.message || err);
  process.exit(1);
});
