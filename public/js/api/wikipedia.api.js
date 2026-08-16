import { t as i18nT } from "../i18n/index.js";
/**
 * Wikipedia / Wikidata API helper
 * – Search titles via MediaWiki search API
 * – Fetch structured data from Wikidata entities
 * – All client-side, CORS enabled with origin=*
 */

// ─── Wikidata property IDs ────────────────────────────
const P = {
  instanceOf:    'P31',
  director:      'P57',
  castMember:    'P161',
  genre:         'P136',
  publicationDate: 'P577',
  originalTitle: 'P1476',
  originalLang:  'P364',
  countryOrigin: 'P495',
  distributor:   'P750',
  productionCo:  'P272',
  duration:      'P2047',
  numSeasons:    'P2437',
  numEpisodes:   'P1113',
  image:         'P18',
};

// Wikidata QIDs for type detection
const Q_FILM        = 'Q11424';
const Q_TV_SERIES   = 'Q5398426';
const Q_TV_MINISERIES = 'Q1259759';
const Q_WEB_SERIES  = 'Q526877';
const Q_ANIME_SERIES = 'Q63952888';

const TV_QIDS = new Set([Q_TV_SERIES, Q_TV_MINISERIES, Q_WEB_SERIES, Q_ANIME_SERIES]);

// ─── Helpers ──────────────────────────────────────────

// Small text helpers (client-side)
function normalizeStr(s){
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function filterSearchResultsByTitle(term, results){
  const q = normalizeStr(term);
  if (!q) return results || [];
  const words = q.split(' ').filter(Boolean);
  return (results || []).filter(r => {
    const t = normalizeStr(r?.title || '');
    if (!t) return false;
    return words.every(w => t.includes(w));
  });
}


function mwUrl(lang = 'en') {
  return `https://${lang}.wikipedia.org/w/api.php`;
}

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── MediaWiki search ─────────────────────────────────

/**
 * Search Wikipedia for a film/tv title.
 * @param {string} term - search query
 * @param {'movie'|'tv'} type
 * @param {string} lang - Wikipedia language code
 * @returns {Promise<Array<{title:string, pageid:number, snippet:string}>>}
 */
export async function searchWikipedia(term, type = 'movie', lang = 'en') {
  // Small language-aware hint to improve relevance.
  // Keep it conservative: Wikipedia search is already good; hints should not hurt.
  const hints = {
    it: { movie: 'film', tv: 'serie TV' },
    en: { movie: 'film', tv: 'tv series' },
  };
  const typeHint = hints?.[lang]?.[type] || (type === 'tv' ? 'tv series' : 'film');

  const runSearch = async (srsearch) => {
    const params = new URLSearchParams({
      action:   'query',
      list:     'search',
      srsearch,
      srlimit:  '10',
      srprop:   'snippet',
      format:   'json',
      origin:   '*',
    });
    const data = await fetchJson(`${mwUrl(lang)}?${params}`);
    return (data?.query?.search || []).map(r => ({
      title:   r.title,
      pageid:  r.pageid,
      snippet: r.snippet?.replace(/<[^>]*>/g, '') || '',
    }));
  };

  // 1) Strict: title match + type hint.
  let results = await runSearch(`intitle:"${term}" ${typeHint}`);
  results = filterSearchResultsByTitle(term, results);
  if (results.length) return results.slice(0, 8);

  // 2) Less strict, but still require the term in the title.
  // Quoting the term reduces noisy matches (e.g., actor pages mentioning the title).
  results = await runSearch(`"${term}" ${typeHint}`);
  results = filterSearchResultsByTitle(term, results);
  return results.slice(0, 8);
}

// ─── Wikipedia REST summary (for thumbnails / better UX) ───────────────

/**
 * Fetch Wikipedia REST summary for a page.
 * Useful for thumbnails in search results.
 *
 * @param {string} pageTitle
 * @param {string} lang
 * @returns {Promise<{title:string, description:string, extract:string, thumbnailUrl:string}>}
 */
export async function getWikipediaSummary(pageTitle, lang = 'it') {
  // REST endpoint uses the canonical title (with spaces), URL-encoded.
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}?redirect=true`;
  const data = await fetchJson(url);
  return {
    title: data?.title || pageTitle,
    description: data?.description || '',
    extract: data?.extract || '',
    thumbnailUrl: data?.thumbnail?.source || '',
  };
}

// ─── Parse Wikipedia URL ──────────────────────────────

/**
 * Extract page title and language from a Wikipedia URL.
 * @param {string} url
 * @returns {{pageTitle:string, language:string, valid:boolean}}
 */
export function parseWikipediaUrl(url) {
  try {
    const u = new URL(url);
    const match = u.hostname.match(/^(\w+)\.wikipedia\.org$/);
    if (!match) return { pageTitle: '', language: '', valid: false };
    const lang = match[1];
    const path = decodeURIComponent(u.pathname.replace(/^\/wiki\//, ''));
    if (!path || path.startsWith('/')) return { pageTitle: '', language: '', valid: false };
    return { pageTitle: path, language: lang, valid: true };
  } catch {
    return { pageTitle: '', language: '', valid: false };
  }
}

// ─── Get Wikidata ID from Wikipedia page ──────────────

/**
 * Resolve a Wikipedia page title to its Wikidata QID.
 * @param {string} pageTitle
 * @param {string} lang
 * @returns {Promise<string|null>} Wikidata QID (e.g. "Q55452526")
 */
export async function getWikidataIdFromPage(pageTitle, lang = 'en') {
  const params = new URLSearchParams({
    action:  'query',
    titles:  pageTitle,
    prop:    'pageprops',
    ppprop:  'wikibase_item',
    format:  'json',
    origin:  '*',
  });
  const data = await fetchJson(`${mwUrl(lang)}?${params}`);
  const pages = data?.query?.pages || {};
  for (const page of Object.values(pages)) {
    if (page.pageprops?.wikibase_item) return page.pageprops.wikibase_item;
  }
  return null;
}

// ─── Fetch Wikidata entity ────────────────────────────

/**
 * Fetch a single Wikidata entity with claims and labels.
 * @param {string} qid - e.g. "Q55452526"
 * @returns {Promise<object>} Raw Wikidata entity
 */
export async function fetchWikidataEntity(qid) {
  const params = new URLSearchParams({
    action:    'wbgetentities',
    ids:       qid,
    props:     'labels|claims',
    languages: 'it|en',
    format:    'json',
    origin:    '*',
  });
  const data = await fetchJson(`${WIKIDATA_API}?${params}`);
  return data?.entities?.[qid] || null;
}

// ─── Batch fetch entity labels ────────────────────────

/**
 * Fetch Italian/English labels for a list of Wikidata QIDs.
 * Wikidata allows max 50 ids per request.
 * @param {string[]} qids
 * @returns {Promise<Map<string,string>>} Map of QID → label
 */
export async function fetchEntityLabels(qids) {
  const labels = new Map();
  if (!qids.length) return labels;

  // Batch in groups of 50
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const params = new URLSearchParams({
      action:    'wbgetentities',
      ids:       batch.join('|'),
      props:     'labels',
      languages: 'it|en',
      format:    'json',
      origin:    '*',
    });
    const data = await fetchJson(`${WIKIDATA_API}?${params}`);
    const entities = data?.entities || {};
    for (const [id, ent] of Object.entries(entities)) {
      const label = ent.labels?.it?.value || ent.labels?.en?.value || id;
      labels.set(id, label);
    }
  }
  return labels;
}

// ─── Extract data from Wikidata entity ────────────────

function getClaimValues(entity, prop) {
  const claims = entity?.claims?.[prop];
  if (!Array.isArray(claims)) return [];
  return claims.map(c => {
    const snak = c.mainsnak;
    if (!snak || snak.snaktype !== 'value') return null;
    return snak.datavalue;
  }).filter(Boolean);
}

function getEntityIds(entity, prop) {
  return getClaimValues(entity, prop)
    .filter(dv => dv.type === 'wikibase-entityid')
    .map(dv => dv.value?.id)
    .filter(Boolean);
}

function getLabel(entity, lang = 'it') {
  return entity?.labels?.[lang]?.value
    || entity?.labels?.en?.value
    || '';
}

function getMonolingualText(entity, prop) {
  const vals = getClaimValues(entity, prop);
  for (const dv of vals) {
    if (dv.type === 'monolingualtext') return dv.value?.text || '';
  }
  return '';
}

function getYear(entity) {
  const vals = getClaimValues(entity, P.publicationDate);
  for (const dv of vals) {
    if (dv.type === 'time') {
      const t = dv.value?.time; // "+2018-02-23T00:00:00Z"
      if (t) {
        const m = t.match(/\+?(\d{4})/);
        if (m) return parseInt(m[1], 10);
      }
    }
  }
  return null;
}

function getQuantity(entity, prop) {
  const vals = getClaimValues(entity, prop);
  for (const dv of vals) {
    if (dv.type === 'quantity') {
      const n = parseFloat(dv.value?.amount);
      if (!isNaN(n)) return Math.round(n);
    }
  }
  return null;
}

function getCommonsFilename(entity) {
  const vals = getClaimValues(entity, P.image);
  for (const dv of vals) {
    if (dv.type === 'string') return dv.value;
  }
  return null;
}

/**
 * Build a Commons image URL from a filename.
 * @param {string} filename
 * @param {number} width - desired width in px
 * @returns {string}
 */
export function getCommonsImageUrl(filename, width = 300) {
  if (!filename) return '';
  const name = filename.replace(/ /g, '_');
  return `https://commons.wikimedia.org/w/thumb.php?f=${encodeURIComponent(name)}&w=${width}`;
}

/**
 * Best-effort: resolve a person's avatar image from Wikidata/Wikimedia Commons.
 * - Prefer a human entity (Q5) that has an image (P18)
 * - If wikidataId is provided, skips search and fetches that entity directly
 *
 * @param {string} name - Person full name (used for search when wikidataId is missing)
 * @param {object} opts
 * @param {string} [opts.lang='it'] - preferred language for search/labels
 * @param {number} [opts.width=96] - desired thumbnail width
 * @param {string|null} [opts.wikidataId=null] - optional QID (e.g. Q123)
 * @returns {Promise<null|{wikidataId:string, imageFilename:string, avatarUrl:string, label:string}>}
 */
export async function resolvePersonAvatar(name, { lang = 'it', width = 96, wikidataId = null } = {}) {
  const Q_HUMAN = 'Q5';
  const term = String(name || '').trim();

  // Helper: pick best candidate entity
  function scoreCandidate(ent) {
    if (!ent) return -1;
    const inst = getEntityIds(ent, P.instanceOf);
    const isHuman = inst.includes(Q_HUMAN);
    const image = getCommonsFilename(ent);
    const hasImage = !!image;
    const sl = ent?.sitelinks || {};
    const hasWiki = !!(sl?.itwiki || sl?.enwiki);
    const label = getBestLabel(ent, lang);
    const exact = normalizeStr(label) === normalizeStr(term);

    // Score weights: human + image are must-haves.
    let s = 0;
    if (isHuman) s += 4;
    if (hasImage) s += 4;
    if (hasWiki) s += 1;
    if (exact) s += 2;
    return s;
  }

  async function fetchEntities(ids) {
    if (!ids?.length) return [];
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: ids.join('|'),
      props: 'labels|claims|sitelinks',
      languages: 'it|en',
      format: 'json',
      origin: '*',
    });
    const data = await fetchJson(`${WIKIDATA_API}?${params}`);
    const entities = data?.entities || {};
    return ids.map(id => entities?.[id]).filter(Boolean);
  }

  // 1) If we already know the QID, fetch and extract.
  if (wikidataId) {
    try {
      const [ent] = await fetchEntities([String(wikidataId).trim()]);
      const score = scoreCandidate(ent);
      if (score < 6) return null; // require at least human + image

      const imageFilename = getCommonsFilename(ent);
      const label = getBestLabel(ent, lang);
      const avatarUrl = getCommonsImageUrl(imageFilename, width);
      return { wikidataId: String(wikidataId).trim(), imageFilename, avatarUrl, label };
    } catch {
      return null;
    }
  }

  if (!term) return null;

  // 2) Search candidate entities
  async function search(langToUse) {
    const params = new URLSearchParams({
      action: 'wbsearchentities',
      search: term,
      language: langToUse,
      uselang: langToUse,
      type: 'item',
      limit: '8',
      format: 'json',
      origin: '*',
    });
    const data = await fetchJson(`${WIKIDATA_API}?${params}`);
    return (data?.search || []).map(r => r?.id).filter(Boolean);
  }

  let ids = [];
  try {
    ids = await search(lang || 'it');
  } catch {
    ids = [];
  }
  if (!ids.length && (lang || 'it') !== 'en') {
    try {
      ids = await search('en');
    } catch {
      ids = [];
    }
  }
  if (!ids.length) return null;

  const ents = await fetchEntities(ids.slice(0, 8));
  if (!ents.length) return null;

  // 3) Pick best candidate
  let best = null;
  let bestScore = -1;
  for (const ent of ents) {
    const s = scoreCandidate(ent);
    if (s > bestScore) {
      bestScore = s;
      best = ent;
    }
  }

  if (!best || bestScore < 6) return null; // require at least human + image

  const imageFilename = getCommonsFilename(best);
  const label = getBestLabel(best, lang);
  const avatarUrl = getCommonsImageUrl(imageFilename, width);
  return { wikidataId: best?.id || ids[0], imageFilename, avatarUrl, label };
}

/**
 * Search Wikidata for PERSON candidates (best-effort) and return a ranked list with images.
 * Designed for admin review flows: show multiple options, let an admin pick the right one.
 *
 * We keep it strict-ish:
 * - Prefer humans (instance of Q5)
 * - Prefer entities with an image (P18)
 * - Prefer entities with itwiki/enwiki sitelinks
 *
 * @param {string} name
 * @param {object} opts
 * @param {string} [opts.lang='it']
 * @param {number} [opts.width=96]
 * @param {number} [opts.limit=6]
 * @param {string[]} [opts.excludeQids=[]]
 * @returns {Promise<Array<{wikidataId:string,label:string,description:string,imageFilename:string,avatarUrl:string,wikipediaUrl:string,wikipediaLang:string,wikipediaTitle:string,score:number}>>}
 */
export async function searchWikidataPersonCandidates(name, { lang = 'it', width = 96, limit = 6, excludeQids = [] } = {}) {
  const term = String(name || '').trim();
  if (!term) return [];

  const Q_HUMAN = 'Q5';
  const excluded = new Set((excludeQids || []).filter(Boolean).map(String));

  const search = async (langToUse) => {
    const params = new URLSearchParams({
      action: 'wbsearchentities',
      search: term,
      language: langToUse,
      uselang: langToUse,
      type: 'item',
      limit: '10',
      format: 'json',
      origin: '*',
    });
    const data = await fetchJson(`${WIKIDATA_API}?${params}`);
    return (data?.search || []).map(r => ({
      id: r?.id,
      label: r?.label || '',
      description: r?.description || '',
    })).filter(r => r.id && !excluded.has(r.id));
  };

  // Try preferred lang first, then fallback to EN.
  let results = [];
  try { results = await search(lang || 'it'); } catch { results = []; }
  if (!results.length && (lang || 'it') !== 'en') {
    try { results = await search('en'); } catch { results = []; }
  }
  if (!results.length) return [];

  const ids = results.map(r => r.id).slice(0, 10);

  // Batch fetch entities (single request)
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels|descriptions|claims|sitelinks',
    languages: 'it|en',
    format: 'json',
    origin: '*',
  });
  const data = await fetchJson(`${WIKIDATA_API}?${params}`);
  const entities = data?.entities || {};

  function getDesc(ent){
    return (
      ent?.descriptions?.it?.value ||
      ent?.descriptions?.en?.value ||
      ''
    );
  }

  function toWikipediaUrl(ent){
    const sl = ent?.sitelinks || {};
    const itTitle = sl?.itwiki?.title || '';
    const enTitle = sl?.enwiki?.title || '';
    const wikiLang = itTitle ? 'it' : (enTitle ? 'en' : '');
    const wikipediaTitle = itTitle || enTitle || '';
    if (!wikiLang || !wikipediaTitle) return { wikipediaUrl: '', wikipediaLang: '', wikipediaTitle: '' };
    const encoded = encodeURIComponent(String(wikipediaTitle).replace(/ /g, '_'));
    return {
      wikipediaUrl: `https://${wikiLang}.wikipedia.org/wiki/${encoded}`,
      wikipediaLang: wikiLang,
      wikipediaTitle,
    };
  }

  function score(ent){
    const inst = getEntityIds(ent, P.instanceOf);
    const isHuman = inst.includes(Q_HUMAN);
    const image = getCommonsFilename(ent);
    const hasImage = !!image;
    const sl = ent?.sitelinks || {};
    const hasWiki = !!(sl?.itwiki || sl?.enwiki);
    const label = getBestLabel(ent, lang);
    const exact = normalizeStr(label) === normalizeStr(term);

    let s = 0;
    if (isHuman) s += 4;
    if (hasImage) s += 4;
    if (hasWiki) s += 1;
    if (exact) s += 2;
    return s;
  }

  const out = [];
  for (const id of ids) {
    const ent = entities?.[id];
    if (!ent) continue;
    const imageFilename = getCommonsFilename(ent);
    // For avatar review we mostly care about candidates with images.
    if (!imageFilename) continue;

    const s = score(ent);
    if (s < 6) continue; // require at least human + image

    const label = getBestLabel(ent, lang);
    const description = getDesc(ent) || results.find(r => r.id === id)?.description || '';
    const avatarUrl = getCommonsImageUrl(imageFilename, width);
    const wiki = toWikipediaUrl(ent);

    out.push({
      wikidataId: id,
      label,
      description,
      imageFilename,
      avatarUrl,
      wikipediaUrl: wiki.wikipediaUrl,
      wikipediaLang: wiki.wikipediaLang,
      wikipediaTitle: wiki.wikipediaTitle,
      score: s,
    });
  }

  out.sort((a, b) => (b.score - a.score) || String(a.label).localeCompare(String(b.label), 'it'));
  return out.slice(0, Math.max(1, Number(limit || 6) || 6));
}

function getBestLabel(entity, preferredLang = 'it') {
  const labels = entity?.labels || {};
  return (
    labels?.[preferredLang]?.value ||
    labels?.it?.value ||
    labels?.en?.value ||
    ''
  );
}


// ─── Episodes (best-effort) ───────────────────────────

function countEpisodeRows(table){
  if (!table) return 0;
  const vevents = table.querySelectorAll('tr.vevent');
  if (vevents && vevents.length) return vevents.length;
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  // Heuristic: first row is usually header.
  if (rows.length >= 2) return Math.max(0, rows.length - 1);
  return 0;
}

function extractSeasonEpisodeCountsFromHtml(html, numSeasons){
  if (!html) return null;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Common case: one table per season.
    const tables = Array.from(doc.querySelectorAll('table.wikiepisodetable'));
    if (tables.length >= 2) {
      const counts = tables.map(t => countEpisodeRows(t)).filter(n => n > 0);
      return counts.length ? counts.slice(0, numSeasons || counts.length) : null;
    }

    // Alternative: find "Season 1/2/..." headings and count the next episode table.
    const headlines = Array.from(doc.querySelectorAll('h2 .mw-headline, h3 .mw-headline'))
      .filter(el => /^(Season|Series|Stagione)\s+\d+/i.test((el.textContent || '').trim()));

    const counts = [];
    for (const hl of headlines) {
      const h = hl.closest('h2, h3');
      if (!h) continue;
      let el = h.nextElementSibling;
      let table = null;
      while (el && !['H2','H3'].includes(el.tagName)) {
        if (el.tagName === 'TABLE' && el.classList.contains('wikiepisodetable')) {
          table = el;
          break;
        }
        const t = el.querySelector?.('table.wikiepisodetable');
        if (t) { table = t; break; }
        el = el.nextElementSibling;
      }
      const n = countEpisodeRows(table);
      if (n > 0) counts.push(n);
      if (numSeasons && counts.length >= numSeasons) break;
    }
    return counts.length ? counts : null;
  } catch {
    return null;
  }
}

async function fetchWikipediaParseHtml(pageTitle, lang){
  const params = new URLSearchParams({
    action: 'parse',
    page: pageTitle,
    prop: 'text',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  const data = await fetchJson(`${mwUrl(lang)}?${params}`);
  return data?.parse?.text || '';
}

async function findEpisodesPageTitle(seriesTitle, lang){
  const title = String(seriesTitle || '').trim();
  if (!title) return null;

  const candidates = [];
  if (lang === 'en') {
    candidates.push(`List of ${title} episodes`);
    candidates.push(`${title} episodes`);
  } else if (lang === 'it') {
    candidates.push(`Episodi di ${title}`);
    candidates.push(`${title} episodi`);
  }

  const search = async (q) => {
    const params = new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: `intitle:"${q}"`,
      srlimit: '5',
      srprop: 'snippet',
      format: 'json',
      origin: '*',
    });
    const data = await fetchJson(`${mwUrl(lang)}?${params}`);
    return (data?.query?.search || []).map(r => ({ title: r.title, snippet: (r.snippet || '').replace(/<[^>]*>/g, '') }));
  };

  for (const c of candidates) {
    try {
      const res = await search(c);
      const hit = res.find(r => /episodes|episodi/i.test(r.title));
      if (hit) return hit.title;
    } catch {
      // ignore
    }
  }

  // Broad fallback: search "<title> episodes" and pick something plausible.
  try {
    const res = await search(`${title} episodes`);
    const hit = res.find(r => /episodes|episodi/i.test(r.title));
    return hit?.title || null;
  } catch {
    return null;
  }
}

async function getSeasonEpisodeCounts(seriesTitle, lang, numSeasons){
  // Some series keep the episode table directly on the main page,
  // or don't have a dedicated "List of ... episodes" page.
  // So: try the dedicated episodes page first, then fallback to the main page.
  let html = '';
  try {
    const epPage = await findEpisodesPageTitle(seriesTitle, lang);
    if (epPage) {
      html = await fetchWikipediaParseHtml(epPage, lang);
    } else {
      html = await fetchWikipediaParseHtml(seriesTitle, lang);
    }
  } catch {
    return null;
  }

  const counts = extractSeasonEpisodeCountsFromHtml(html, numSeasons);
  return counts && counts.length ? counts : null;
}

// ─── Search results refinement (avoid people pages etc.) ─────────────

/**
 * Refine MediaWiki search results using Wikidata instance-of.
 * This helps avoid false positives (e.g. actor pages) when a title exists only in EN.
 *
 * Adds:
 *  - _qid, _detectedType, _year, _label
 */
export async function refineWikipediaSearchResults(results, desiredType = 'movie', lang = 'en') {
  const items = Array.isArray(results) ? results : [];
  if (!items.length) return [];

  // Parallelize all Wikidata lookups for speed (avoids sequential round-trips)
  const settled = await Promise.allSettled(items.map(async (r) => {
    const qid = await getWikidataIdFromPage(r.title, lang);
    if (!qid) return null;
    const entity = await fetchWikidataEntity(qid);
    if (!entity) return null;

    const instanceIds = new Set(getEntityIds(entity, P.instanceOf));
    if (instanceIds.has('Q5')) return null; // skip humans / actor pages

    const raw = extractTitleDataRaw(entity);
    if (!raw) return null;
    if (desiredType === 'tv' && raw.type !== 'tv') return null;
    if (desiredType === 'movie' && raw.type !== 'movie') return null;

    return {
      ...r,
      _qid: qid,
      _detectedType: raw.type,
      _year: raw.year,
      _label: raw.name || r.title,
    };
  }));

  return settled
    .filter(s => s.status === 'fulfilled' && s.value !== null)
    .map(s => s.value);
}

// ─── Detect type from Wikidata ────────────────────────

function detectType(entity) {
  const instanceIds = getEntityIds(entity, P.instanceOf);
  for (const qid of instanceIds) {
    if (TV_QIDS.has(qid)) return 'tv';
    if (qid === Q_FILM) return 'movie';
  }
  return 'movie'; // default
}

// ─── Main extraction function ─────────────────────────

/**
 * Extract structured title data from a Wikidata entity.
 * Returns an object matching the app's formData shape.
 *
 * Note: directors, cast, genres are returned as QID arrays.
 * You must call fetchEntityLabels() separately to resolve names.
 *
 * @param {object} entity - Raw Wikidata entity
 * @returns {object}
 */
export function extractTitleDataRaw(entity) {
  if (!entity) return null;

  return {
    name:           getLabel(entity, 'it') || getLabel(entity, 'en'),
    type:           detectType(entity),
    year:           getYear(entity),
    originalName:   getMonolingualText(entity, P.originalTitle),
    directorQids:   getEntityIds(entity, P.director),
    castQids:       getEntityIds(entity, P.castMember).slice(0, 10),
    genreQids:      getEntityIds(entity, P.genre),
    languageQids:   getEntityIds(entity, P.originalLang),
    countryQids:    getEntityIds(entity, P.countryOrigin),
    networkQids:    [...getEntityIds(entity, P.distributor), ...getEntityIds(entity, P.productionCo)].slice(0, 3),
    durationMinutes: getQuantity(entity, P.duration),
    numSeasons:     getQuantity(entity, P.numSeasons),
    numEpisodes:    getQuantity(entity, P.numEpisodes),
    posterFilename: getCommonsFilename(entity),
  };
}

// ─── High-level: full import pipeline ─────────────────

/**
 * Full pipeline: from a Wikipedia search result (pageid + title + lang)
 * to a fully resolved title object with human-readable labels.
 *
 * @param {{pageid:number, title:string}} result - from searchWikipedia()
 * @param {string} lang - Wikipedia language code
 * @returns {Promise<object>} Resolved title data
 */
export async function importFromSearchResult(result, lang = 'en') {
  // 1. Get Wikidata QID
  const qid = result?._qid || await getWikidataIdFromPage(result.title, lang);

  // If no Wikidata entity, fall back to basic Wikipedia summary data
  if (!qid) {
    return importFallbackFromSummary(result.title, lang);
  }

  return importFromWikidataId(qid, { sourceTitle: result.title, sourceLang: lang });
}

/**
 * Full pipeline: from a Wikipedia URL to resolved title data.
 *
 * @param {string} url
 * @returns {Promise<object>} Resolved title data
 */
export async function importFromUrl(url) {
  const { pageTitle, language, valid } = parseWikipediaUrl(url);
  if (!valid) throw new Error(i18nT("URL Wikipedia non valido."));

  const qid = await getWikidataIdFromPage(pageTitle, language);

  // If no Wikidata entity, fall back to basic Wikipedia summary data
  if (!qid) {
    return importFallbackFromSummary(pageTitle, language);
  }

  return importFromWikidataId(qid, { sourceTitle: pageTitle, sourceLang: language });
}

/**
 * Fallback import: use Wikipedia REST summary when Wikidata is unavailable.
 * Returns minimal but usable data (name, type guess, year from description).
 */
async function importFallbackFromSummary(pageTitle, lang = 'en') {
  let summary;
  try {
    summary = await getWikipediaSummary(pageTitle, lang);
  } catch {
    // summary API failed entirely
  }

  // If the summary redirected to a disambiguation page or doesn't exist, use the raw pageTitle
  const isDisambig = (summary?.description || '').toLowerCase().includes('disambiguation')
    || (summary?.title || '').toLowerCase().includes('disambiguation');

  // Clean up the title: use pageTitle as base (underscores → spaces), strip disambiguation
  let name = (isDisambig || !summary?.title)
    ? pageTitle.replace(/_/g, ' ')
    : summary.title;

  name = name
    .replace(/\s*\((?:film|serie[_ ](?:televisiva|tv)|tv[_ ]series|miniseries|web[_ ]series|disambiguation)[^)]*\)/i, '')
    .trim();

  if (!name) throw new Error(i18nT("Impossibile determinare il titolo dalla pagina Wikipedia."));

  // Try to guess type from the original pageTitle disambiguation + description
  const fullText = (pageTitle + ' ' + (summary?.title || '') + ' ' + (summary?.description || '')).toLowerCase();
  let type = 'movie'; // default
  if (/serie|tv[_ ]series|television|miniseries|web[_ ]series/i.test(fullText)) {
    type = 'tv';
  }

  // Try to extract year from description (e.g. "2018 British television series")
  let year = null;
  const yearMatch = (summary?.description || '').match(/\b(19|20)\d{2}\b/);
  if (yearMatch) year = parseInt(yearMatch[0], 10);

  return {
    name,
    type,
    year,
    originalName: '',
    directors: [],
    cast: [],
    genreLabels: [],
    language: '',
    country: '',
    network: '',
    durationMinutes: null,
    numSeasons: null,
    numEpisodes: null,
    episodesPerSeason: null,
    seasonsMeta: null,
    posterUrl: '',
    posterFilename: null,
    wikidataId: null,
    _partial: true, // flag to indicate this is a partial import
    sourceWikipedia: { pageTitle, lang },
  };
}

/**
 * Core import: from Wikidata QID to fully resolved title data.
 *
 * @param {string} qid
 * @returns {Promise<object>}
 */
async function importFromWikidataId(qid, ctx = {}) {
  // 1. Fetch main entity
  const entity = await fetchWikidataEntity(qid);
  if (!entity) throw new Error(i18nT("Entità Wikidata non trovata."));

  // 2. Extract raw data
  const raw = extractTitleDataRaw(entity);

  // 3. Collect all QIDs that need label resolution
  const allQids = [
    ...raw.directorQids,
    ...raw.castQids,
    ...raw.genreQids,
    ...raw.languageQids,
    ...raw.countryQids,
    ...raw.networkQids,
  ];

  // 4. Batch fetch labels
  const labels = await fetchEntityLabels([...new Set(allQids)]);

  // 5. Resolve
  const resolve = (qids) => qids.map(id => labels.get(id) || id);
  const resolveMeta = (qids) => qids.map(id => ({ qid: id, name: labels.get(id) || id }));
  // 6. Best-effort: derive episodes per season for TV series
  let seasonsMeta = null;
  let episodesPerSeason = null;

  if (raw.type === 'tv') {
    try {
      const sourceTitle = ctx?.sourceTitle || raw.name;
      const sourceLang = ctx?.sourceLang || 'en';
      let counts = await getSeasonEpisodeCounts(sourceTitle, sourceLang, raw.numSeasons || null);

      // Fallback: if not found and we weren't already on EN, try EN.
      if ((!counts || !counts.length) && sourceLang !== 'en') {
        counts = await getSeasonEpisodeCounts(sourceTitle, 'en', raw.numSeasons || null);
      }

      if (counts && counts.length) {
        seasonsMeta = counts.map((n, i) => ({ season: i + 1, episodes: n }));
        const allSame = seasonsMeta.every(s => s.episodes === seasonsMeta[0].episodes);
        if (allSame) episodesPerSeason = seasonsMeta[0].episodes;
      }
    } catch {
      // ignore
    }

    // If we still don't have a per-season value, use a safe heuristic only when divisible.
    if (!episodesPerSeason && raw.numEpisodes && raw.numSeasons && raw.numEpisodes % raw.numSeasons === 0) {
      episodesPerSeason = Math.round(raw.numEpisodes / raw.numSeasons);
    }
  }



  return {
    name:           raw.name,
    type:           raw.type,
    year:           raw.year,
    originalName:   raw.originalName,
    directors:      resolve(raw.directorQids),
    directorsMeta:  resolveMeta(raw.directorQids),
    cast:           resolve(raw.castQids),
    castMeta:       resolveMeta(raw.castQids),
    genreLabels:    resolve(raw.genreQids),   // display labels (may be English)
    language:       resolve(raw.languageQids).join(', '),
    country:        resolve(raw.countryQids).join(', '),
    network:        resolve(raw.networkQids).join(', '),
    durationMinutes: raw.durationMinutes,
    numSeasons:     raw.numSeasons,
    numEpisodes:    raw.numEpisodes,
    episodesPerSeason,
    seasonsMeta,
    posterUrl:      getCommonsImageUrl(raw.posterFilename, 400),
    posterFilename: raw.posterFilename,
    wikidataId:     qid,
    sourceWikipedia: { pageTitle: ctx?.sourceTitle || '', lang: ctx?.sourceLang || '' },
  };
}
