"use strict";

// Etichette di genere: risoluzione di una chiave grezza (id TMDB, slug, testo
// libero) nella label leggibile mostrata all'utente. Estratto da
// functions/index.js perche' e' logica PURA e serve identica al motore di
// raccomandazione e all'harness di benchmark offline.
//
// `loadGenreLabelMap` resta in index.js: legge Firestore, non e' pura. La mappa
// che produce viene passata qui come argomento `genreLabelMap`.


function toTmdbGenreKey(tmdbGenreId) {
  return `tmdb_${String(tmdbGenreId)}`;
}

const TMDB_GENRE_LABELS = Object.freeze({
  tmdb_28: "Azione",
  tmdb_12: "Avventura",
  tmdb_16: "Animazione",
  tmdb_35: "Commedia",
  tmdb_80: "Crime",
  tmdb_99: "Documentario",
  tmdb_18: "Dramma",
  tmdb_10751: "Famiglia",
  tmdb_10759: "Azione & Avventura (TV)",
  tmdb_14: "Fantasy",
  tmdb_10765: "Fantascienza & Fantasy (TV)",
  tmdb_36: "Storia",
  tmdb_27: "Horror",
  tmdb_10402: "Musica",
  tmdb_9648: "Mistero",
  tmdb_10749: "Romantico",
  tmdb_878: "Fantascienza",
  tmdb_10770: "Film TV",
  tmdb_53: "Thriller",
  tmdb_10752: "Guerra",
  tmdb_37: "Western",
  tmdb_10768: "Guerra & Politica (TV)",
  tmdb_10766: "Soap",
});

function normalizeGenreKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function prettyGenreLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw
    .replace(/^tmdb[_\s-]?\d+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized
    .split(" ")
    .map((part) => part ? (part[0].toUpperCase() + part.slice(1)) : "")
    .join(" ");
}

function isOpaqueGenreKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return true;
  if (/^tmdb[_\s-]?\d+$/.test(raw)) return false;
  if (raw.includes(" ")) return false;
  return /^[a-z0-9_-]{12,}$/.test(raw);
}

function resolveGenreLabel(value, genreLabelMap) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const map = genreLabelMap instanceof Map ? genreLabelMap : null;

  if (map) {
    const direct = map.get(raw);
    if (direct) return direct;
    const normalized = map.get(normalizeGenreKey(raw));
    if (normalized) return normalized;
  }

  const fallbackById = TMDB_GENRE_LABELS[raw];
  if (fallbackById) return fallbackById;

  const tmdbMatch = normalizeGenreKey(raw).match(/^tmdb\s*(\d+)$/);
  if (tmdbMatch) {
    return TMDB_GENRE_LABELS[`tmdb_${tmdbMatch[1]}`] || "";
  }

  if (isOpaqueGenreKey(raw)) return "";
  return prettyGenreLabel(raw);
}

module.exports = {
  TMDB_GENRE_LABELS,
  toTmdbGenreKey,
  normalizeGenreKey,
  prettyGenreLabel,
  isOpaqueGenreKey,
  resolveGenreLabel,
};
