#!/usr/bin/env node
/**
 * seed-quiz-titles-wave2.js
 *
 * Crea i doc `titles/{tmdb_<type>_<id>}` mancanti per i titoli del batch quiz
 * acquisizione marcati needsTmdbImport in quiz_beta/quiz_wave2_titles.json.
 *
 * Strategia "seed + lazy refresh": scrive un doc `approved` con i metadati TMDB
 * essenziali (name, originalName, year, description, poster/backdrop, genres) +
 * tmdbSync con nextCheckAt nel passato. Questo:
 *   - fa esistere il titolo → il quiz si lega al titleId
 *   - fa scattare il trigger onTitleCreatedSlug → slug → pagina SSR indicizzabile
 *   - lascia che `refreshTitleFromTmdb` (on-view, cooldown-gated) riconcili al
 *     primo accesso cast/search/keywords con la pipeline reale.
 * NON sovrascrive doc già esistenti (merge:false guard via get()).
 *
 * Usage (da functions/):
 *   node scripts/seed-quiz-titles-wave2.js            # dry-run
 *   node scripts/seed-quiz-titles-wave2.js --write      # applica
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const KEY = (() => {
  for (const f of ['.env', '.env.gia-visto', '.env.production']) {
    try {
      const m = fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8').match(/^TMDB_KEY=(.+)$/m);
      if (m) return m[1].trim();
    } catch (_) {}
  }
  return process.env.TMDB_KEY || process.env.TMDB_API_KEY || '';
})();
if (!KEY) { console.error('TMDB key non trovata (functions/.env TMDB_KEY).'); process.exit(1); }

const TITLES = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../quiz_beta/quiz_wave2_titles.json'), 'utf8'))
  .filter((t) => t.needsTmdbImport);

admin.initializeApp({ projectId: 'gia-visto' });
const db = admin.firestore();

const IMG = (p, size) => (p ? `https://image.tmdb.org/t/p/${size}${p}` : '');

async function tmdbDetails(type, id, lang) {
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${KEY}&language=${lang}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${type}/${id} ${lang} -> ${res.status}`);
  return res.json();
}

function nameLower(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function main() {
  console.log('='.repeat(60));
  console.log('Seed titoli mancanti — batch quiz acquisizione');
  console.log('mode:', WRITE ? 'WRITE' : 'DRY-RUN', '| titoli:', TITLES.length);
  console.log('='.repeat(60));

  for (const t of TITLES) {
    const type = t.mediaType === 'tv' ? 'tv' : 'movie';
    const docId = t.titleId; // tmdb_<type>_<id>
    const ref = db.collection('titles').doc(docId);
    const existing = await ref.get();
    if (existing.exists) { console.log(`SKIP  ${docId} (già presente: "${(existing.data() || {}).name}")`); continue; }

    let it;
    try { it = await tmdbDetails(type, t.tmdbId, 'it-IT'); } catch (e) { console.log(`ERR   ${docId}: ${e.message}`); continue; }
    let en = null;
    if (!String(it.overview || '').trim()) { try { en = await tmdbDetails(type, t.tmdbId, 'en-US'); } catch (_) {} }

    const name = it.title || it.name || t.title;
    const originalName = it.original_title || it.original_name || '';
    const dateStr = it.release_date || it.first_air_date || '';
    const year = dateStr ? Number(dateStr.slice(0, 4)) : (t.year ? Number(t.year) : null);
    const description = String(it.overview || (en && en.overview) || '').trim();
    const genres = Array.isArray(it.genres) ? it.genres.map((g) => `tmdb_${g.id}`) : [];

    const doc = {
      name,
      originalName,
      type,
      year,
      status: 'approved',
      tmdbId: Number(t.tmdbId),
      tmdbRating: typeof it.vote_average === 'number' ? it.vote_average : null,
      description,
      posterPath: IMG(it.poster_path, 'w500'),
      backdropPath: IMG(it.backdrop_path, 'w780'),
      genres,
      nameLower: nameLower(name),
      source: 'manual_quiz_seed',
      search: { normalized: nameLower(name) },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      // refresh dovuto subito: il primo open chiama refreshTitleFromTmdb e
      // riconcilia cast/keywords/search con la pipeline reale.
      tmdbSync: {
        lastTmdbId: Number(t.tmdbId),
        lastMediaType: type,
        lastSource: 'manual_quiz_seed',
        nextCheckAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000),
        lastStatus: 'seed_pending_enrich',
        lastError: '',
      },
    };

    if (!WRITE) {
      console.log(`DRY   ${docId}  "${name}" (${year}) [${type}] genres=${genres.length} poster=${doc.posterPath ? 'y' : 'n'}`);
      continue;
    }
    await ref.set(doc, { merge: false });
    console.log(`WROTE ${docId}  "${name}" (${year}) [${type}]`);
  }
  console.log('\nFatto.', WRITE ? '' : '(dry-run: nessuna scrittura)');
}

main().then(() => process.exit(0)).catch((e) => { console.error('Failed:', e); process.exit(1); });
