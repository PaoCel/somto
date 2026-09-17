#!/usr/bin/env node
/**
 * fill-missing-tmdb-ids.js
 *
 * For each title in quiz_beta/quiz_next60_titles.json with empty tmdbId:
 *   1. If the titleId follows the pattern tmdb_(movie|tv)_NNNN, use NNNN.
 *   2. Otherwise call TMDB /search/movie or /search/tv (+ year) and pick the
 *      first reasonable match (closest by year, prefer Italian/original).
 *
 * Then:
 *   - Update titles/{titleId} in Firestore with tmdbId.
 *   - Patch the local quiz_next60_titles.json.
 *   - Patch every batch_*.json that contains questions for the affected titleIds
 *     so the tmdbId field is no longer empty.
 *
 * Usage:
 *   cd functions
 *   node scripts/fill-missing-tmdb-ids.js            # dry-run, prints proposal
 *   node scripts/fill-missing-tmdb-ids.js --write    # apply Firestore + JSON edits
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
// Load .env manually (avoid extra deps).
(function loadEnv() {
  const envPath = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})();

const WRITE = process.argv.includes('--write');
const TMDB_KEY = process.env.TMDB_KEY;
if (!TMDB_KEY) {
  console.error('TMDB_KEY not found in functions/.env');
  process.exit(1);
}

const QUIZ_BETA = path.resolve(__dirname, '../../quiz_beta');
const TITLES_FILE = path.resolve(QUIZ_BETA, 'quiz_next60_titles.json');

admin.initializeApp({ projectId: 'gia-visto' });
const db = admin.firestore();

function extractTmdbFromSlug(titleId) {
  const m = String(titleId || '').match(/^tmdb_(movie|tv)_(\d+)$/);
  if (m) return { id: m[2], media: m[1] };
  return null;
}

async function tmdbSearch({ mediaType, query, year }) {
  const endpoint = mediaType === 'tv' ? '/search/tv' : '/search/movie';
  const params = new URLSearchParams({
    api_key: TMDB_KEY,
    query,
    include_adult: 'false',
    language: 'it-IT',
  });
  if (year) {
    if (mediaType === 'tv') params.set('first_air_date_year', String(year));
    else params.set('year', String(year));
  }
  const url = `https://api.themoviedb.org/3${endpoint}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${endpoint} HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

function pickBest(results, { mediaType, year }) {
  if (!results.length) return null;
  const sorted = results.slice().sort((a, b) => {
    const ya = parseInt((mediaType === 'tv' ? a.first_air_date : a.release_date || '').slice(0, 4), 10) || 0;
    const yb = parseInt((mediaType === 'tv' ? b.first_air_date : b.release_date || '').slice(0, 4), 10) || 0;
    const da = year ? Math.abs(ya - Number(year)) : 0;
    const db = year ? Math.abs(yb - Number(year)) : 0;
    if (da !== db) return da - db;
    return (b.popularity || 0) - (a.popularity || 0);
  });
  return sorted[0];
}

async function resolveTmdbId(t) {
  const slug = extractTmdbFromSlug(t.titleId);
  if (slug && slug.media === t.mediaType) {
    return { tmdbId: slug.id, source: 'titleIdSlug', label: `(slug ${t.titleId})` };
  }
  const results = await tmdbSearch({ mediaType: t.mediaType, query: t.title, year: t.year });
  let best = pickBest(results, { mediaType: t.mediaType, year: t.year });
  if (!best && t.originalTitle && t.originalTitle !== t.title) {
    const r2 = await tmdbSearch({ mediaType: t.mediaType, query: t.originalTitle, year: t.year });
    best = pickBest(r2, { mediaType: t.mediaType, year: t.year });
  }
  if (!best) {
    // Fallback: keep only the first significant word(s) before ":" / "-" / "la storia di".
    const stripped = t.title
      .replace(/\s*[:\-–—]\s*.*$/, '')
      .replace(/\s+la storia.*$/i, '')
      .trim();
    if (stripped && stripped !== t.title) {
      const r3 = await tmdbSearch({ mediaType: t.mediaType, query: stripped, year: t.year });
      best = pickBest(r3, { mediaType: t.mediaType, year: t.year });
    }
  }
  if (!best) {
    // Last fallback: try the first word, no year constraint.
    const firstWord = t.title.split(/\s+/)[0];
    if (firstWord && firstWord.length >= 3) {
      const r4 = await tmdbSearch({ mediaType: t.mediaType, query: firstWord, year: null });
      best = pickBest(r4, { mediaType: t.mediaType, year: t.year });
    }
  }
  if (!best) return { tmdbId: '', source: 'not_found', label: '(no TMDB match)' };
  const matchYear = t.mediaType === 'tv'
    ? (best.first_air_date || '').slice(0, 4)
    : (best.release_date || '').slice(0, 4);
  return {
    tmdbId: String(best.id),
    source: 'tmdbSearch',
    label: `${best.title || best.name} (${matchYear}) — popularity ${Math.round(best.popularity || 0)}`,
  };
}

async function main() {
  if (!fs.existsSync(TITLES_FILE)) {
    console.error('Missing:', TITLES_FILE);
    process.exit(1);
  }
  const titles = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8'));
  const missing = titles.filter((t) => !t.tmdbId);
  console.log(`Resolving TMDB id for ${missing.length} titles (mode=${WRITE ? 'WRITE' : 'DRY-RUN'})…\n`);

  const resolutions = [];
  for (const t of missing) {
    const r = await resolveTmdbId(t);
    resolutions.push({ title: t, resolved: r });
    console.log(`  rank ${String(t.rank).padStart(2)} [${t.mediaType}] ${t.title} (${t.year})`);
    console.log(`     titleId   : ${t.titleId}`);
    console.log(`     → tmdbId  : ${r.tmdbId || '∅'}  via ${r.source}`);
    console.log(`     match     : ${r.label}\n`);
  }

  if (!WRITE) {
    console.log('[dry-run] no writes. Re-run with --write to apply.');
    return;
  }

  // 1) Firestore titles/{titleId} update
  let firestoreUpdates = 0;
  for (const { title, resolved } of resolutions) {
    if (!resolved.tmdbId) continue;
    const ref = db.collection('titles').doc(title.titleId);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`  ! titles/${title.titleId} not found — skipping firestore update`);
      continue;
    }
    await ref.update({ tmdbId: resolved.tmdbId, lastTmdbIdResolvedAt: admin.firestore.FieldValue.serverTimestamp() });
    firestoreUpdates++;
  }
  console.log(`Firestore: updated ${firestoreUpdates} title docs.\n`);

  // 2) Update local quiz_next60_titles.json
  for (const t of titles) {
    const r = resolutions.find((x) => x.title.titleId === t.titleId);
    if (r && r.resolved.tmdbId) t.tmdbId = r.resolved.tmdbId;
  }
  fs.writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
  console.log('Patched:', TITLES_FILE);

  // 3) Patch each batch_*.json — update tmdbId on questions matching titleId
  const idMap = {};
  for (const { title, resolved } of resolutions) {
    if (resolved.tmdbId) idMap[title.titleId] = resolved.tmdbId;
  }
  let batchPatched = 0;
  for (let i = 6; i <= 20; i++) {
    const f = path.resolve(QUIZ_BETA, `batch_${i}.json`);
    if (!fs.existsSync(f)) continue;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    let dirty = false;
    for (const q of data.questions) {
      if (idMap[q.titleId] && (!q.tmdbId || q.tmdbId === '')) {
        q.tmdbId = idMap[q.titleId];
        dirty = true;
      }
    }
    if (dirty) {
      fs.writeFileSync(f, JSON.stringify(data, null, 2));
      batchPatched++;
      console.log(`  patched batch_${i}.json`);
    }
  }
  console.log(`Batch files patched: ${batchPatched}`);
  console.log('\nNext: re-run `node ../quiz_beta/process_next60.cjs` to regenerate the import-ready file.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
  });
