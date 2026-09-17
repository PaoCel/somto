#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * gen-editorial-strips.js — copertina "a strisce" per un post editoriale.
 *
 * Una striscia per film: backdrop TMDB come sfondo, logo ufficiale del titolo
 * (endpoint /movie/{id}/images → `logos`, PNG trasparenti) e un'etichetta a
 * destra. Formato 1080x1080: la card del feed è `aspect-ratio: 1/1` con
 * object-fit cover, quindi un quadrato non viene tagliato.
 *
 * Stack: SVG composto a mano → @resvg/resvg-js (già usato da gen-og-images.js).
 * Le immagini sono incorporate come data URI, quindi il render è offline.
 *
 * Uso:
 *   node scripts/gen-editorial-strips.js                      # tutti gli slug
 *   node scripts/gen-editorial-strips.js --slug film-sullo-spazio
 *   node scripts/gen-editorial-strips.js --out /tmp/anteprima  # cartella output
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FONT_CACHE = path.join(REPO_ROOT, 'node_modules', '.cache', 'somto-og-fonts');
const DEFAULT_OUT = path.join(REPO_ROOT, 'tmp', 'editorial-strips');

const SIZE = 1080;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

// tmdbId + etichetta: il testo a destra dice perché quel film è nella lista.
const SERIES = {
  'film-che-fanno-riflettere': {
    heading: '6 film che fanno riflettere',
    films: [
      { tmdbId: 37165, label: 'Realtà' },
      { tmdbId: 5915, label: 'Libertà' },
      { tmdbId: 87827, label: 'Fede' },
      { tmdbId: 13, label: 'Destino' },
      { tmdbId: 956842, label: 'Verità' },
      { tmdbId: 423, label: 'Memoria' },
    ],
  },
  'film-sullo-spazio': {
    heading: '6 film sullo spazio',
    films: [
      { tmdbId: 157336, label: 'Tempo' },
      { tmdbId: 286217, label: 'Sopravvivenza' },
      { tmdbId: 568, label: 'Squadra' },
      { tmdbId: 381284, label: 'Calcolo' },
      { tmdbId: 687163, label: 'Missione' },
      { tmdbId: 13466, label: 'Ambizione' },
    ],
  },
  'film-imprenditoria-business': {
    heading: '7 film su imprenditoria e business',
    films: [
      { tmdbId: 37799, label: 'Ambizione' },
      { tmdbId: 310307, label: 'Esecuzione' },
      { tmdbId: 60308, label: 'Dati' },
      { tmdbId: 115782, label: 'Visione' },
      { tmdbId: 321697, label: 'Ego' },
      { tmdbId: 3293, label: 'Rivalità' },
      { tmdbId: 106646, label: 'Eccesso' },
    ],
  },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next; i++;
  }
  return out;
}

async function tmdbImages(tmdbId, key) {
  const url = `${TMDB_BASE}/movie/${tmdbId}/images?include_image_language=it,en,null&api_key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB images ${tmdbId} → HTTP ${res.status}`);
  return res.json();
}

// Backdrop: preferito quello SENZA testo impresso (iso_639_1 null), così il
// logo che sovrapponiamo non finisce sopra un titolo già stampato.
function pickBackdrop(images) {
  const all = images.backdrops || [];
  const textless = all.filter((b) => !b.iso_639_1);
  const pool = textless.length ? textless : all;
  return pool.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0] || null;
}

// Logo: italiano se esiste, altrimenti inglese. Solo PNG (trasparenti).
function pickLogo(images) {
  const pngs = (images.logos || []).filter((l) => /\.png$/i.test(l.file_path || ''));
  const byLang = (lang) => pngs.filter((l) => l.iso_639_1 === lang)
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0];
  return byLang('it') || byLang('en') || pngs[0] || null;
}

async function toDataUri(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || 'image/jpeg';
  return `data:${type};base64,${buf.toString('base64')}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripSvg(entry, index, stripH) {
  const y = index * stripH;
  const id = `clip${index}`;

  // Backdrop 16:9 scalato a coprire la striscia in larghezza, centrato in
  // verticale sulla porzione più "piena" (leggermente sopra il centro).
  const bgW = SIZE;
  const bgH = Math.round(SIZE * 9 / 16);
  // bgH > stripH: fattore basso = si vede la parte alta del fotogramma (dove
  // di solito stanno i volti), invece di tagliarli.
  const bgY = y + Math.round((stripH - bgH) * 0.35);

  // Logo: alto al massimo il 46% della striscia, largo al massimo il 42%.
  const maxLogoH = Math.round(stripH * 0.46);
  const maxLogoW = Math.round(SIZE * 0.42);
  const ratio = entry.logo ? (entry.logo.aspect_ratio || (entry.logo.width / entry.logo.height) || 3) : 3;
  let logoH = maxLogoH;
  let logoW = Math.round(logoH * ratio);
  if (logoW > maxLogoW) { logoW = maxLogoW; logoH = Math.round(logoW / ratio); }
  const logoX = 44;
  const logoY = y + Math.round((stripH - logoH) / 2);

  const labelY = y + stripH - Math.round(stripH * 0.18);

  return `
  <defs>
    <clipPath id="${id}"><rect x="0" y="${y}" width="${SIZE}" height="${stripH}"/></clipPath>
  </defs>
  <g clip-path="url(#${id})">
    ${entry.backdropUri
      ? `<image href="${entry.backdropUri}" x="0" y="${bgY}" width="${bgW}" height="${bgH}" preserveAspectRatio="xMidYMid slice"/>`
      : `<rect x="0" y="${y}" width="${SIZE}" height="${stripH}" fill="#14100f"/>`}
    <rect x="0" y="${y}" width="${SIZE}" height="${stripH}" fill="#000000" opacity="0.18"/>
    <rect x="0" y="${y}" width="${SIZE}" height="${stripH}" fill="url(#shade)"/>
    ${entry.logoUri
      ? `<image href="${entry.logoUri}" x="${logoX}" y="${logoY}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMinYMid meet"/>`
      : `<text x="${logoX}" y="${y + stripH / 2 + 10}" font-family="Inter" font-size="34" font-weight="800" fill="#ffffff">${escapeXml(entry.name)}</text>`}
    <text x="${SIZE - 40}" y="${labelY}" text-anchor="end" font-family="Inter" font-size="26" font-weight="800" fill="#ffffff" letter-spacing="0.5">${escapeXml(entry.label)}</text>
  </g>
  <rect x="0" y="${y + stripH - 1}" width="${SIZE}" height="1" fill="#000000" opacity="0.85"/>`;
}

function buildSvg(entries) {
  const stripH = Math.floor(SIZE / entries.length);
  const total = stripH * entries.length;
  const pad = SIZE - total; // resto distribuito come bordo in basso
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <!-- Scuro a sinistra (dove va il logo) e a destra (etichetta): i backdrop
         chiari altrimenti si mangiano i loghi bianchi. -->
    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.88"/>
      <stop offset="38%" stop-color="#000000" stop-opacity="0.45"/>
      <stop offset="62%" stop-color="#000000" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.78"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="#0A0A0A"/>
  ${entries.map((e, i) => stripSvg(e, i, stripH)).join('\n')}
  ${pad > 0 ? `<rect x="0" y="${total}" width="${SIZE}" height="${pad}" fill="#0A0A0A"/>` : ''}
</svg>`;
}

async function renderSlug(slug, config, key, outDir) {
  const entries = [];
  for (const film of config.films) {
    const images = await tmdbImages(film.tmdbId, key);
    const backdrop = pickBackdrop(images);
    const logo = pickLogo(images);
    entries.push({
      ...film,
      logo,
      backdropUri: backdrop ? await toDataUri(`${IMG}/w1280${backdrop.file_path}`) : null,
      logoUri: logo ? await toDataUri(`${IMG}/w500${logo.file_path}`) : null,
      name: String(film.tmdbId),
    });
    console.log(`  · ${film.label.padEnd(14)} backdrop ${backdrop ? 'ok' : 'MANCA'} · logo ${logo ? `${logo.iso_639_1 || 'null'}` : 'MANCA'}`);
  }

  const svg = buildSvg(entries);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: SIZE },
    font: {
      fontFiles: [
        path.join(FONT_CACHE, 'inter-black.ttf'),
        path.join(FONT_CACHE, 'inter-bold.ttf'),
        path.join(FONT_CACHE, 'inter-regular.ttf'),
      ],
      loadSystemFonts: true,
      defaultFontFamily: 'Inter',
    },
  });
  const png = resvg.render().asPng();
  const outPath = path.join(outDir, `${slug}.png`);
  await fs.writeFile(outPath, png);
  console.log(`  → ${outPath} (${Math.round(png.length / 1024)} KB)`);
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = String(process.env.TMDB_KEY || process.env.TMDB_API_KEY || '').trim();
  if (!key) throw new Error('TMDB_KEY mancante (usa --env-file=functions/.env)');

  const outDir = String(args.out || DEFAULT_OUT);
  await fs.mkdir(outDir, { recursive: true });

  const slugs = args.slug ? [String(args.slug)] : Object.keys(SERIES);
  for (const slug of slugs) {
    const config = SERIES[slug];
    if (!config) throw new Error(`slug sconosciuto: ${slug}`);
    console.log(`\n${slug} — ${config.films.length} strisce`);
    await renderSlug(slug, config, key, outDir);
  }
}

main().catch((err) => {
  console.error('ERRORE:', err?.message || err);
  process.exit(1);
});
