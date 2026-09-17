import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  limit,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";

function slugify(s){
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function listGenres(max = 200){
  const q = query(collection(db, "genres"), orderBy("nameLower"), limit(max));
  const snap = await getDocs(q);
  const fromDb = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const tmdb = tmdbGenreCatalog();

  // Merge ensuring tmdb_* always present
  const seen = new Set(fromDb.map(g => g.id));
  const merged = [...fromDb];
  for (const g of tmdb) {
    if (!seen.has(g.id)) merged.push(g);
  }
  return merged;
}

export async function createGenre({ name, createdBy }){
  const id = slugify(name);
  if (!id) throw new Error(i18nT("Nome genere non valido."));
  const ref = doc(db, "genres", id);
  const snap = await getDoc(ref);
  if (snap.exists()) return { id, ...snap.data(), existed: true };

  const data = {
    name: String(name).trim(),
    nameLower: String(name).trim().toLowerCase(),
    slug: id,
    createdBy,
    createdAt: serverTimestamp(),
  };
  await setDoc(ref, data);
  return { id, ...data, existed: false };
}

// Fallback TMDB catalog (IT localization)
export function tmdbGenreCatalog() {
  const rows = [
    { id: "tmdb_28", name: "Azione" },
    { id: "tmdb_12", name: "Avventura" },
    { id: "tmdb_16", name: "Animazione" },
    { id: "tmdb_35", name: "Commedia" },
    { id: "tmdb_80", name: "Crime" },
    { id: "tmdb_99", name: "Documentario" },
    { id: "tmdb_18", name: "Dramma" },
    { id: "tmdb_10751", name: "Famiglia" },
    { id: "tmdb_10759", name: "Azione & Avventura (TV)" },
    { id: "tmdb_14", name: "Fantasy" },
    { id: "tmdb_10765", name: "Fantascienza & Fantasy (TV)" },
    { id: "tmdb_36", name: "Storia" },
    { id: "tmdb_27", name: "Horror" },
    { id: "tmdb_10402", name: "Musica" },
    { id: "tmdb_9648", name: "Mistero" },
    { id: "tmdb_10749", name: "Romantico" },
    { id: "tmdb_878", name: "Fantascienza" },
    { id: "tmdb_10770", name: "Film TV" },
    { id: "tmdb_53", name: "Thriller" },
    { id: "tmdb_10752", name: "Guerra" },
    { id: "tmdb_37", name: "Western" },
    { id: "tmdb_10768", name: "Guerra & Politica (TV)" },
    { id: "tmdb_10766", name: "Soap" },
  ];
  return rows.map(r => ({ ...r, nameLower: r.name.toLowerCase(), source: "tmdb" }));
}
