#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Genera le Open Graph image 1200x630 PNG per le landing pubbliche e per ogni
 * articolo del blog Somto.
 *
 * Stack:
 *  - satori          → JSX-like tree → SVG
 *  - @resvg/resvg-js → SVG → PNG
 *
 * Nota: `@vercel/og` non viene usato perché è pensato per l'Edge runtime di
 * Vercel/Next; sotto il cofano usa esattamente la stessa pipeline
 * satori + resvg, quindi qui andiamo diretti senza il wrapper Edge.
 *
 * Output:
 *  - public/og/<slug>.png            (landing pubbliche)
 *  - public/og/blog/<fileSlug>.png   (articoli blog)
 *
 * Uso: `node scripts/gen-og-images.js`
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import matter from 'gray-matter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const OG_DIR = path.join(PUBLIC_DIR, 'og');
const OG_BLOG_DIR = path.join(OG_DIR, 'blog');
const BLOG_ARTICLES_DIR = path.join(REPO_ROOT, 'blog', 'src', 'articoli');

const FONT_CACHE = path.join(REPO_ROOT, 'node_modules', '.cache', 'somto-og-fonts');

// --- 1. Font loading -------------------------------------------------------
//
// Satori richiede TTF/OTF già parsati (non legge file TTC). Usiamo Inter da
// Google Fonts (geometrico, moderno, vicino al look "rounded" del brand iOS),
// scaricato una volta e cachato in node_modules/.cache. Se la rete è KO, si
// ricade su Arial da /System/Library/Fonts (macOS).

// Mirror TTF di Inter da Google Fonts (gstatic). Satori non legge i .woff2,
// quindi servono TTF "puri". Questi 3 URL coincidono con i pesi 400/700/900
// di Inter v18 servita da Google Fonts.
const GOOGLE_TTF = {
  regular: 'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50ojIw2boKoduKmMEVuLyfMZg.ttf',
  bold:    'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50ojIw2boKoduKmMEVuGKYMZg.ttf',
  black:   'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50ojIw2boKoduKmMEVuFuYMZg.ttf',
};

async function fetchToBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'somto-og-script' } }, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirectsLeft <= 0) {
          reject(new Error(`Troppi redirect per ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        fetchToBuffer(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} per ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
  });
}

async function ensureFontFile(name, url) {
  await fs.mkdir(FONT_CACHE, { recursive: true });
  const file = path.join(FONT_CACHE, `${name}.ttf`);
  try {
    const stat = await fs.stat(file);
    if (stat.size > 1024) return file;
  } catch {
    // not cached yet
  }
  console.log(`  ↓ scarico ${name} → ${url}`);
  const buf = await fetchToBuffer(url);
  await fs.writeFile(file, buf);
  return file;
}

async function loadFonts() {
  // Prima tentiamo Inter via Google Fonts.
  try {
    const [regularPath, boldPath, blackPath] = await Promise.all([
      ensureFontFile('inter-regular', GOOGLE_TTF.regular),
      ensureFontFile('inter-bold', GOOGLE_TTF.bold),
      ensureFontFile('inter-black', GOOGLE_TTF.black),
    ]);
    const [regular, bold, black] = await Promise.all([
      fs.readFile(regularPath),
      fs.readFile(boldPath),
      fs.readFile(blackPath),
    ]);
    return [
      { name: 'Inter', data: regular, weight: 400, style: 'normal' },
      { name: 'Inter', data: bold,    weight: 700, style: 'normal' },
      { name: 'Inter', data: black,   weight: 900, style: 'normal' },
    ];
  } catch (err) {
    console.warn(`  ⚠ download Inter fallito (${err.message}). Fallback su Arial.`);
    const arialPath = '/System/Library/Fonts/Supplemental/Arial.ttf';
    const arialBoldPath = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
    const arialBlackPath = '/System/Library/Fonts/Supplemental/Arial Black.ttf';
    const [reg, bold, black] = await Promise.all([
      fs.readFile(arialPath),
      fs.readFile(arialBoldPath),
      fs.readFile(arialBlackPath),
    ]);
    return [
      { name: 'Arial', data: reg,   weight: 400, style: 'normal' },
      { name: 'Arial', data: bold,  weight: 700, style: 'normal' },
      { name: 'Arial', data: black, weight: 900, style: 'normal' },
    ];
  }
}

// --- 2. Template OG --------------------------------------------------------

const SOMTO_BG = '#0A0A0A';
const SOMTO_PINK = '#E91E63';
const SOMTO_PURPLE = '#9C27B0';
const SOMTO_ORANGE = '#F77737';
const TEXT_PRIMARY = '#F5F5F5';
const TEXT_MUTED = '#A8A8A8';

/**
 * Costruisce l'albero satori per una OG card 1200x630.
 *  - sfondo dark
 *  - blob/gradient morbidi negli angoli (palette brand)
 *  - wordmark "Somto" in alto-sx
 *  - eyebrow opzionale
 *  - titolo grande
 *  - subtitle/description
 *  - footer "somto.it"
 */
function ogTree({ title, subtitle, kicker }) {
  const safeTitle = clampLines(title, 90); // hard char cap
  const safeSubtitle = subtitle ? clampLines(subtitle, 140) : null;

  return {
    type: 'div',
    props: {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        background: SOMTO_BG,
        color: TEXT_PRIMARY,
        fontFamily: 'Inter, Arial, sans-serif',
        padding: '64px 72px',
        overflow: 'hidden',
      },
      children: [
        // Decorativo: 2 cerchi sfumati negli angoli (gradient brand)
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              top: '-220px',
              right: '-180px',
              width: '620px',
              height: '620px',
              borderRadius: '50%',
              background: `radial-gradient(circle, ${SOMTO_PINK}55 0%, ${SOMTO_PURPLE}33 45%, transparent 70%)`,
              display: 'flex',
            },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              bottom: '-260px',
              left: '-200px',
              width: '680px',
              height: '680px',
              borderRadius: '50%',
              background: `radial-gradient(circle, ${SOMTO_ORANGE}44 0%, ${SOMTO_PINK}33 45%, transparent 70%)`,
              display: 'flex',
            },
          },
        },
        // Header — wordmark Somto + barretta gradient
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '20px',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 56,
                    fontWeight: 900,
                    letterSpacing: '-0.03em',
                    color: TEXT_PRIMARY,
                    display: 'flex',
                  },
                  children: 'Somto',
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    width: '6px',
                    height: '40px',
                    borderRadius: '4px',
                    background: `linear-gradient(180deg, ${SOMTO_ORANGE}, ${SOMTO_PINK}, ${SOMTO_PURPLE})`,
                    display: 'flex',
                  },
                },
              },
              kicker
                ? {
                    type: 'div',
                    props: {
                      style: {
                        fontSize: 24,
                        fontWeight: 700,
                        color: TEXT_MUTED,
                        textTransform: 'uppercase',
                        letterSpacing: '0.14em',
                        display: 'flex',
                      },
                      children: kicker,
                    },
                  }
                : null,
            ].filter(Boolean),
          },
        },
        // Spacer
        {
          type: 'div',
          props: { style: { flexGrow: 1, display: 'flex' } },
        },
        // Titolo
        {
          type: 'div',
          props: {
            style: {
              fontSize: pickTitleSize(safeTitle),
              fontWeight: 900,
              lineHeight: 1.08,
              letterSpacing: '-0.025em',
              color: TEXT_PRIMARY,
              display: 'flex',
              maxWidth: '1000px',
            },
            children: safeTitle,
          },
        },
        // Subtitle
        safeSubtitle
          ? {
              type: 'div',
              props: {
                style: {
                  marginTop: '24px',
                  fontSize: 28,
                  fontWeight: 400,
                  lineHeight: 1.35,
                  color: TEXT_MUTED,
                  display: 'flex',
                  maxWidth: '1000px',
                },
                children: safeSubtitle,
              },
            }
          : null,
        // Footer
        {
          type: 'div',
          props: {
            style: {
              marginTop: '48px',
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    width: '54px',
                    height: '6px',
                    borderRadius: '4px',
                    background: `linear-gradient(90deg, ${SOMTO_ORANGE}, ${SOMTO_PINK}, ${SOMTO_PURPLE})`,
                    display: 'flex',
                  },
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 24,
                    fontWeight: 700,
                    color: TEXT_MUTED,
                    letterSpacing: '0.04em',
                    display: 'flex',
                  },
                  children: 'somto.it',
                },
              },
            ],
          },
        },
      ].filter(Boolean),
    },
  };
}

function pickTitleSize(text) {
  if (text.length <= 32) return 76;
  if (text.length <= 56) return 64;
  if (text.length <= 80) return 54;
  return 46;
}

function clampLines(text, max) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

// --- 3. Render -------------------------------------------------------------

async function renderPNG({ title, subtitle, kicker, outPath, fonts }) {
  const tree = ogTree({ title, subtitle, kicker });
  const svg = await satori(tree, {
    width: 1200,
    height: 630,
    fonts,
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    background: SOMTO_BG,
  });
  const png = resvg.render().asPng();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, png);
  return png.length;
}

// --- 4. Inputs -------------------------------------------------------------

// Landing pubbliche → (titolo OG, sottotitolo OG, slug PNG)
const LANDINGS = [
  {
    htmlFile: 'index.html',
    slug: 'home',
    title: 'Scegli cosa guardare con gli amici',
    subtitle: 'Il social per chi ama film e serie TV: vota, salva, gioca, condividi.',
    kicker: null,
  },
  {
    htmlFile: 'watchlist-film-serie.html',
    slug: 'watchlist',
    title: 'La tua watchlist di film e serie TV',
    subtitle: 'Salva tutto in un posto solo, ritrova in un attimo cosa guardare stasera.',
    kicker: 'Watchlist',
  },
  {
    htmlFile: 'app-recensioni-film-serie.html',
    slug: 'recensioni',
    title: 'Vota e recensisci film e serie TV',
    subtitle: 'Tieni traccia di cosa hai visto, dai un voto e costruisci il tuo profilo da cinefilo.',
    kicker: 'Voti e recensioni',
  },
  {
    htmlFile: 'quiz-film-serie-tv.html',
    slug: 'quiz',
    title: 'Quiz su film e serie TV',
    subtitle: 'Sfide con gli amici, classifiche, XP e streak giornaliera.',
    kicker: 'Quiz',
  },
  {
    htmlFile: 'consigli-film-serie-amici.html',
    slug: 'consigli',
    title: 'Consigli su cosa guardare dai tuoi amici',
    subtitle: 'Segui le persone di cui ti fidi e scopri cosa stanno votando.',
    kicker: 'Consigli',
  },
  {
    htmlFile: 'somto-vs-letterboxd.html',
    slug: 'vs-letterboxd',
    title: "L'alternativa italiana a Letterboxd",
    subtitle: 'Gratis, social, in italiano. Film e serie TV, watchlist condivise, quiz.',
    kicker: 'Somto vs Letterboxd',
  },
  {
    htmlFile: 'somto-vs-justwatch.html',
    slug: 'vs-justwatch',
    title: 'Più di JustWatch: scopri cosa guardare con gli amici',
    subtitle: 'JustWatch dice dove. Somto aiuta a scegliere e a condividere.',
    kicker: 'Somto vs JustWatch',
  },
];

async function readBlogPosts() {
  const entries = await fs.readdir(BLOG_ARTICLES_DIR, { withFileTypes: true });
  const posts = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.md')) continue;
    const filePath = path.join(BLOG_ARTICLES_DIR, ent.name);
    const raw = await fs.readFile(filePath, 'utf8');
    const { data } = matter(raw);
    const slug = data.slug || ent.name.replace(/\.md$/, '');
    const title = data.title || slug;
    const description = data.description || data.lede || '';
    posts.push({ slug, title, description });
  }
  return posts.sort((a, b) => a.slug.localeCompare(b.slug));
}

// --- 5. Main ---------------------------------------------------------------

async function main() {
  await fs.mkdir(OG_BLOG_DIR, { recursive: true });

  console.log('→ Carico font…');
  const fonts = await loadFonts();
  console.log(`  font caricati: ${fonts.map((f) => `${f.name}@${f.weight}`).join(', ')}`);

  let okLanding = 0;
  let okBlog = 0;
  const failures = [];

  console.log('\n→ Genero OG per landing pubbliche…');
  for (const lp of LANDINGS) {
    const out = path.join(OG_DIR, `${lp.slug}.png`);
    try {
      const bytes = await renderPNG({
        title: lp.title,
        subtitle: lp.subtitle,
        kicker: lp.kicker,
        outPath: out,
        fonts,
      });
      console.log(`  ✓ ${path.relative(REPO_ROOT, out)}  (${(bytes / 1024).toFixed(1)} KB)`);
      okLanding += 1;
    } catch (err) {
      console.error(`  ✗ ${lp.slug}: ${err.message}`);
      failures.push({ where: `landing/${lp.slug}`, error: err.message });
    }
  }

  console.log('\n→ Genero OG per articoli blog…');
  const posts = await readBlogPosts();
  for (const post of posts) {
    const out = path.join(OG_BLOG_DIR, `${post.slug}.png`);
    try {
      const bytes = await renderPNG({
        title: post.title,
        subtitle: post.description,
        kicker: 'Blog',
        outPath: out,
        fonts,
      });
      console.log(`  ✓ ${path.relative(REPO_ROOT, out)}  (${(bytes / 1024).toFixed(1)} KB)`);
      okBlog += 1;
    } catch (err) {
      console.error(`  ✗ blog/${post.slug}: ${err.message}`);
      failures.push({ where: `blog/${post.slug}`, error: err.message });
    }
  }

  console.log('\n— Riepilogo —');
  console.log(`Landing OK : ${okLanding}/${LANDINGS.length}`);
  console.log(`Blog OK    : ${okBlog}/${posts.length}`);
  if (failures.length) {
    console.log(`Fallimenti : ${failures.length}`);
    for (const f of failures) console.log(`  - ${f.where}: ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log('Nessun fallimento.');
  }
}

main().catch((err) => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
