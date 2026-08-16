// blogPosts.api.js — Articoli blog DB-driven (Firestore `blogPosts/{slug}`).
// Schema doc (vedi anche firestore.rules → blogPosts):
//   { title, excerpt, coverImage?, body, publishedAt, updatedAt, tags[],
//     author{name,photoURL?}, status: "draft"|"published" }

import {
  collection,
  doc,
  query,
  where,
  orderBy,
  limit as fbLimit,
  getDoc,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";

const COLL = "blogPosts";

function timestampMs(v) {
  if (!v) return 0;
  if (typeof v?.toMillis === "function") return v.toMillis();
  if (typeof v?.seconds === "number") return (v.seconds * 1000) + Math.floor((v.nanoseconds || 0) / 1e6);
  const d = new Date(v); return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function normalizePost(id, data = {}) {
  return {
    id,
    slug: String(data.slug || id),
    title: String(data.title || ""),
    excerpt: String(data.excerpt || ""),
    coverImage: data.coverImage || null,
    body: String(data.body || ""),
    bodyFormat: data.bodyFormat === "html" ? "html" : "markdown",
    publishedAt: data.publishedAt || null,
    updatedAt: data.updatedAt || null,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    author: data.author && typeof data.author === "object"
      ? { name: String(data.author.name || ""), photoURL: data.author.photoURL || null }
      : null,
    status: data.status === "draft" ? "draft" : "published",
    _sortTime: timestampMs(data.publishedAt) || timestampMs(data.updatedAt),
  };
}

/**
 * Ultimi N articoli pubblicati (status==published) ordinati per publishedAt DESC.
 */
export async function listRecentBlogPosts(max = 6) {
  const snap = await getDocs(query(
    collection(db, COLL),
    where("status", "==", "published"),
    orderBy("publishedAt", "desc"),
    fbLimit(max),
  )).catch(() => null);
  if (!snap) return [];
  return snap.docs.map((d) => normalizePost(d.id, d.data() || {}));
}

/**
 * Singolo post per slug (== doc id).
 */
export async function getBlogPostBySlug(slug) {
  if (!slug) return null;
  const snap = await getDoc(doc(db, COLL, String(slug))).catch(() => null);
  if (!snap || !snap.exists()) return null;
  const post = normalizePost(snap.id, snap.data() || {});
  if (post.status !== "published") return null;
  return post;
}
