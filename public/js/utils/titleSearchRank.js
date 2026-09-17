/**
 * Scoring puro per la ricerca titoli web, condiviso da `searchTitlesSmart` /
 * `searchTitlesByPrefix` (public/js/api/titles.api.js). Specchio di
 * `TitleParsing.searchScore` su iOS (ios/TwoWatch/Data/Repositories/TitleParsing.swift)
 * — stessa scala e stesso ordine di priorità, va aggiornato in entrambi i posti.
 *
 * Nessuna dipendenza da Firestore: solo stringhe in ingresso, testabile con
 * `node --test` senza emulatore (v. test/web/title-search-rank.test.js).
 */

/**
 * Articoli guida (it/en/es/fr/de) usati SOLO per lo scoring e per una query
 * prefix aggiuntiva sulla query "spogliata": non vengono MAI tolti da
 * `search.tokens` (l'indice Firestore costruito da `buildTitleSearchSnapshot`
 * in functions/index.js resta invariato).
 */
export const ARTICLES = new Set([
  "il", "lo", "la", "i", "gli", "le", "l", "un", "uno", "una",
  "the", "a", "an",
  "el", "los", "las",
  "les", "des", "une",
  "der", "die", "das", "den", "dem", "ein", "eine", "einen", "einem", "einer", "eines",
]);

/** Stessa normalizzazione di `normalize()` in titles.api.js (duplicata qui per tenere il modulo autonomo/testabile). */
export function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token di ricerca (>=2 char, deduplicati) da una stringa già normalizzata. */
export function tokenize(normalized) {
  const parts = String(normalized || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(parts.filter((p) => p.length >= 2)));
}

/**
 * Toglie l'eventuale articolo guida iniziale da una stringa già normalizzata,
 * una parola sola e mai fino a svuotarla. Permette a "beekeeper" di trovare
 * "The Beekeeper" e a "il primo natale" di non scavalcare un match esatto
 * senza articolo.
 */
export function stripLeadingArticle(normalized) {
  const parts = String(normalized || "").split(" ").filter(Boolean);
  if (parts.length > 1 && ARTICLES.has(parts[0])) {
    return parts.slice(1).join(" ");
  }
  return normalized;
}

/**
 * Sceglie fino a `max` token "migliori" per interrogare `search.tokens`:
 * euristica "il più raro" senza una lettura extra per contare le occorrenze
 * reali, quindi si usa la lunghezza (i token lunghi sono tipicamente più
 * selettivi) escludendo sempre gli articoli guida. Se dopo il filtro non
 * resta nulla (query fatta solo di articoli), si ripiega sui token originali.
 */
export function bestSearchTokens(tokens, max = 2) {
  const list = Array.isArray(tokens) ? tokens : [];
  const candidates = list.filter((t) => !ARTICLES.has(t));
  const pool = candidates.length ? candidates : list;
  return [...pool]
    .sort((a, b) => (b.length !== a.length ? b.length - a.length : (a < b ? -1 : a > b ? 1 : 0)))
    .slice(0, max);
}

/**
 * Scoring puro di un titolo (doc Firestore grezzo `{id, ...data()}`) contro
 * una query normalizzata. Scala: exact 12 > prefix 10 > article-stripped
 * exact/prefix 9 > all-tokens-in-name 8 > alias/originalName 8 >
 * token-in-name 6 > contains 5 > description-only 3 > 0 (nessun match).
 *
 * `tokens`, se omesso, è ricalcolato da `normalized` via `tokenize`.
 */
export function scoreTitleMatch(title, normalized, tokens) {
  if (!normalized || !title) return 0;

  const nameLower = normalizeText(title.nameLower || title.name || "");
  if (!nameLower) return 0;

  const queryTokens = tokens || tokenize(normalized);
  const queryStripped = stripLeadingArticle(normalized);

  if (nameLower === normalized) return 12;
  if (nameLower.startsWith(normalized)) return 10;

  const nameStripped = stripLeadingArticle(nameLower);
  if (nameStripped === normalized || nameStripped === queryStripped || nameLower === queryStripped) {
    return 9;
  }
  if (
    nameStripped.startsWith(normalized)
    || (queryStripped && (nameStripped.startsWith(queryStripped) || nameLower.startsWith(queryStripped)))
  ) {
    return 9;
  }

  if (queryTokens.length > 1 && queryTokens.every((t) => nameLower.includes(t))) {
    return 8;
  }

  const originalNorm = normalizeText(title.originalName || "");
  const originalHit = Boolean(originalNorm) && originalNorm.includes(normalized);
  const aliasHit = (Array.isArray(title.aliases) ? title.aliases : []).some((a) => {
    const an = normalizeText(a);
    return an && an.includes(normalized);
  });
  if (originalHit || aliasHit) return 8;

  if (queryTokens.some((t) => !ARTICLES.has(t) && nameLower.includes(t))) {
    return 6;
  }

  if (nameLower.includes(normalized)) return 5;

  const collectionHit = normalizeText(title.collectionName || "").includes(normalized) && Boolean(title.collectionName);
  const keywordHit = (Array.isArray(title.keywords) ? title.keywords : []).some((k) => {
    const kn = normalizeText(k);
    return kn && kn.includes(normalized);
  });
  const searchableHit = normalizeText(title.searchableText || title.description || "").includes(normalized);
  if (collectionHit || keywordHit || searchableHit) return 3;

  return 0;
}
