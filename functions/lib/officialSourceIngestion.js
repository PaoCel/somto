"use strict";

const { createHash } = require("crypto");
const { normalizeText } = require("./pureUtils");
const { publishOfficialUpdate, slugify } = require("./officialUpdates");

const DISNEY_PRESS_ORIGIN = "https://press.disney.co.uk";
const DISNEY_SITEMAP_URL = `${DISNEY_PRESS_ORIGIN}/sitemap.xml`;
const HULU_PRESS_ORIGIN = "https://press.hulu.com";
const HULU_NEWS_URL = `${HULU_PRESS_ORIGIN}/`;
const SOURCE_STATE_PATH = "systemJobs/officialSourceScanner";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_DISCOVERED_PER_SOURCE = 120;
const MAX_PROCESSED_PER_RUN = 12;
const MAX_SEEN_URLS = 300;
const DEFAULT_LIVE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const REPORT_NOTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SOURCE_DEFINITIONS = Object.freeze({
  disney_press_uk: {
    name: "Disney UK Press",
    hostname: "press.disney.co.uk",
    articlePrefix: "/news/",
  },
  hulu_press: {
    name: "Hulu Press",
    hostname: "press.hulu.com",
    articlePrefix: "/pressrelease/",
  },
});

const TITLE_HINT_BLACKLIST = new Set([
  "disney", "disney plus", "hulu", "season", "season one", "season two",
  "season three", "season four", "season five", "season six", "official trailer",
  "teaser trailer", "new trailer", "final season", "new season",
]);

function clampText(value, maxLength = 500) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const radix = code[0].toLowerCase() === "x" ? 16 : 10;
      const number = Number.parseInt(radix === 16 ? code.slice(1) : code, radix);
      return Number.isFinite(number) && number >= 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : "";
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function stripHtml(value) {
  return clampText(decodeHtmlEntities(
    String(value || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ), 4000);
}

function sourceDefinitionForUrl(value, { articleOnly = true } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  const entry = Object.entries(SOURCE_DEFINITIONS)
    .find(([, definition]) => definition.hostname === parsed.hostname.toLowerCase());
  if (!entry) return null;
  const [provider, definition] = entry;
  if (articleOnly && !parsed.pathname.startsWith(definition.articlePrefix)) return null;
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  return { provider, definition, url: parsed.toString() };
}

function normalizeOfficialSourceUrl(value) {
  return sourceDefinitionForUrl(value)?.url || "";
}

function sourceIdForUrl(value) {
  const normalized = normalizeOfficialSourceUrl(value);
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function parseTagAttributes(tag) {
  const out = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(String(tag || "")))) {
    out[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? "");
  }
  return out;
}

function metaContent(html, key, value) {
  const targetKey = String(key || "").toLowerCase();
  const targetValue = String(value || "").toLowerCase();
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    const attributes = parseTagAttributes(tag);
    if (String(attributes[targetKey] || "").toLowerCase() === targetValue) {
      return clampText(attributes.content, 4000);
    }
  }
  return "";
}

function jsonLdArticles(html) {
  const rows = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    try {
      const parsed = JSON.parse(match[1]);
      const candidates = Array.isArray(parsed) ? parsed : parsed?.["@graph"] || [parsed];
      for (const candidate of candidates) {
        const type = Array.isArray(candidate?.["@type"])
          ? candidate["@type"].join(" ")
          : String(candidate?.["@type"] || "");
        if (/NewsArticle|Article/i.test(type)) rows.push(candidate);
      }
    } catch (_) {
      // JSON-LD rotto: i meta OpenGraph restano il fallback controllato.
    }
  }
  return rows;
}

function parseOfficialArticle(html, requestedUrl) {
  const source = sourceDefinitionForUrl(requestedUrl);
  if (!source) throw new Error("URL fonte ufficiale non consentito");
  const jsonLd = jsonLdArticles(html)[0] || {};
  const jsonLdCanonical = typeof jsonLd.mainEntityOfPage === "object"
    ? jsonLd.mainEntityOfPage?.["@id"]
    : jsonLd.mainEntityOfPage;
  const canonical = normalizeOfficialSourceUrl(
    jsonLdCanonical
      || metaContent(html, "property", "og:url")
      || requestedUrl
  );
  if (!canonical || sourceDefinitionForUrl(canonical)?.provider !== source.provider) {
    throw new Error("Canonical fuori dalla fonte consentita");
  }

  const rawTitle = jsonLd.headline
    || metaContent(html, "property", "og:title")
    || String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || "";
  const rawDescription = jsonLd.description
    || metaContent(html, "property", "og:description")
    || "";
  const huluDate = String(html || "").match(/class=["'][^"']*posted-on[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1];
  const publishedRaw = jsonLd.datePublished
    || metaContent(html, "property", "article:published_time")
    || stripHtml(huluDate || "");
  const publishedMs = Date.parse(String(publishedRaw || ""));
  const title = clampText(stripHtml(rawTitle).replace(/\s*\|\s*(?:UK Press|Hulu Press)\s*$/i, ""), 240);
  const description = clampText(stripHtml(rawDescription || jsonLd.articleBody || ""), 1200);
  if (!title) throw new Error("Titolo articolo ufficiale mancante");

  return {
    provider: source.provider,
    sourceName: source.definition.name,
    sourceUrl: canonical,
    sourceId: sourceIdForUrl(canonical),
    headline: title,
    description,
    publishedAtMs: Number.isFinite(publishedMs) ? publishedMs : null,
  };
}

function classifyOfficialAnnouncement(article = {}) {
  const text = normalizeText(`${article.headline || ""} ${article.description || ""}`);
  if (!text) return null;
  if (/\b(cancelled|canceled|will not return|not returning)\b/.test(text)) return "cancellation";
  if (/\b(final season|concludes? with (?:its )?\w+ season)\b/.test(text)) return "cancellation";
  if (/\b(renew|renews|renewed|renewal|greenlit|greenlight|commissioned)\b/.test(text)) return "renewal";
  if (/\b(returning|returns|premieres|debut)\b.{0,45}\bseason\b|\bseason\b.{0,30}\b(returns|premieres|debut)\b/.test(text)) {
    return "new_season";
  }
  if (/\b(joins?|added to|rounds out)\b.{0,50}\bcast\b|\bcast\b.{0,50}\b(joins?|announced|revealed)\b/.test(text)) {
    return "casting";
  }
  return null;
}

function seasonNumberFromArticle(article = {}) {
  const text = normalizeText(`${article.headline || ""} ${article.description || ""}`);
  const wordNumbers = new Map([
    ["one", 1], ["first", 1], ["two", 2], ["second", 2], ["three", 3], ["third", 3],
    ["four", 4], ["fourth", 4], ["five", 5], ["fifth", 5], ["six", 6], ["sixth", 6],
    ["seven", 7], ["seventh", 7], ["eight", 8], ["eighth", 8], ["nine", 9], ["ninth", 9],
    ["ten", 10], ["tenth", 10],
    ["una", 1], ["prima", 1], ["due", 2], ["seconda", 2], ["tre", 3], ["terza", 3],
    ["quattro", 4], ["quarta", 4], ["cinque", 5], ["quinta", 5], ["sei", 6], ["sesta", 6],
    ["sette", 7], ["settima", 7], ["otto", 8], ["ottava", 8], ["nove", 9], ["nona", 9],
    ["dieci", 10], ["decima", 10],
  ]);
  const numberWords = "one|first|two|second|three|third|four|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|una|prima|due|seconda|tre|terza|quattro|quarta|cinque|quinta|sei|sesta|sette|settima|otto|ottava|nove|nona|dieci|decima";
  const match = text.match(new RegExp(`\\b(?:season|stagione)\\s+(\\d{1,2}|${numberWords})\\b`))
    || text.match(new RegExp(`\\b(\\d{1,2}|${numberWords})\\s+(?:season|stagione)\\b`));
  if (!match) return null;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : wordNumbers.get(match[1]) || null;
}

function cleanTitleHint(value) {
  const raw = clampText(value, 120)
    .replace(/^[\s'"“”‘’\-–—:]+|[\s'"“”‘’\-–—:,]+$/g, "")
    .replace(/^(?:disney\+|hulu|fx(?:'s|’s)?|original series)\s+/i, "")
    .replace(/\s+(?:season|series)\s+\d{1,2}$/i, "");
  const normalized = normalizeText(raw);
  if (!normalized || TITLE_HINT_BLACKLIST.has(normalized) || normalized.length < 2) return "";
  return raw;
}

function extractTitleHints(article = {}) {
  const headline = clampText(article.headline, 400);
  const description = clampText(article.description, 1200);
  const hints = [];
  const push = (value) => {
    const clean = cleanTitleHint(value);
    const normalized = normalizeText(clean);
    if (!clean || hints.some((row) => row.normalized === normalized)) return;
    hints.push({ value: clean, normalized });
  };

  const quoted = /["“‘]([^"”’]{2,120})["”’]/g;
  for (const text of [headline, description]) {
    let match;
    while ((match = quoted.exec(text))) push(match[1]);
  }

  // Nei casting headline come "Actor joins cast of Show" il testo prima di
  // "joins" e' una persona, non il titolo. Senza virgolette e' piu' sicuro
  // lasciare la voce nel report degli unmatched che collegarla male.
  if (classifyOfficialAnnouncement(article) === "casting") return hints.slice(0, 16);

  const marker = headline.match(/^(.*?)(?:\bRENEWED\b|\bGREENLIT\b|\bGREENLIGHT\b|\bRETURNS?\b|\bCANCELLED\b|\bCANCELED\b|\bPREMIERES?\b|\bJOINS?\b)/i)?.[1];
  if (marker) {
    const words = cleanTitleHint(marker).split(/\s+/).filter(Boolean);
    for (let length = Math.min(10, words.length); length >= 1; length--) {
      push(words.slice(-length).join(" "));
    }
  }

  return hints.slice(0, 16);
}

async function resolveArticleTitle(db, article) {
  if (!db || typeof db.collection !== "function") throw new Error("Firestore db obbligatorio");
  const hints = extractTitleHints(article);
  const updateType = classifyOfficialAnnouncement(article);
  const wantsTV = updateType === "renewal" || updateType === "new_season" || updateType === "cancellation";

  for (const hint of hints) {
    const queries = [
      ["search.normalized", hint.normalized],
      ["nameLower", hint.value.toLowerCase()],
    ];
    const matches = new Map();
    for (const [field, value] of queries) {
      const snapshot = await db.collection("titles").where(field, "==", value).limit(4).get();
      for (const doc of snapshot.docs || []) {
        const data = doc.data() || {};
        if (data.status !== "approved") continue;
        if (wantsTV && String(data.type || "") !== "tv") continue;
        matches.set(doc.id, { id: doc.id, name: clampText(data.name, 240), type: data.type, matchedHint: hint.value });
      }
    }
    if (matches.size === 1) return [...matches.values()][0];
    if (matches.size > 1) return null;
  }
  return null;
}

function announcementKey(article, title, updateType) {
  const season = seasonNumberFromArticle(article);
  return `${updateType}:${title.id}:season-${season || "unknown"}`;
}

function buildOfficialSourceDraft(article, title) {
  const updateType = classifyOfficialAnnouncement(article);
  if (!updateType) throw new Error("Articolo non classificabile");
  const sourceId = article.sourceId || sourceIdForUrl(article.sourceUrl);
  const summary = clampText(article.description || article.headline, 700);
  const season = seasonNumberFromArticle(article);
  return {
    // slugify anche qui: `publishOfficialUpdate` normalizza lo slug, e un
    // provider con underscore finiva su un doc diverso da quello del merge
    // `ingestion` (bozza orfana + report copertura cieco).
    slug: slugify(`source-${article.provider}-${sourceId}`),
    title: clampText(`Da rivedere: ${article.headline}`, 160),
    text: clampText(
      `Bozza acquisita automaticamente da ${article.sourceName}. Verifica i fatti e riscrivi il testo prima di pubblicare. Sintesi originale: ${summary}`,
      2000
    ),
    summary: clampText(`Bozza da verificare · ${summary}`, 240),
    updateType,
    status: "draft",
    linkedTitleIds: [title.id],
    sourceUrls: [article.sourceUrl],
    notificationsEnabled: false,
    sourceEventId: `official-source:${announcementKey(article, title, updateType)}`,
    sourceEffectiveAt: article.publishedAtMs || undefined,
    ingestion: {
      provider: article.provider,
      sourceId,
      sourceUrl: article.sourceUrl,
      headline: article.headline,
      articlePublishedAtMs: article.publishedAtMs,
      matchedHint: title.matchedHint,
      matchedTitleName: title.name,
      announcementKey: announcementKey(article, title, updateType),
      season,
      reviewRequired: true,
    },
  };
}

async function findDuplicateAnnouncement(db, draft) {
  const direct = await db.collection("officialUpdates").doc(draft.slug).get();
  if (direct.exists) return { slug: direct.id, reason: "source_id" };

  const snapshot = await db.collection("officialUpdates")
    .where("linkedTitleIds", "array-contains", draft.linkedTitleIds[0])
    .limit(40)
    .get();
  for (const doc of snapshot.docs || []) {
    const data = doc.data() || {};
    if ((data.sourceUrls || []).includes(draft.sourceUrls[0])) return { slug: doc.id, reason: "source_url" };
    if (!draft.ingestion.season || String(data.updateType || "") !== draft.updateType) continue;
    const existingSeason = seasonNumberFromArticle({ headline: data.title, description: data.text });
    if (existingSeason === draft.ingestion.season) return { slug: doc.id, reason: "title_type_season" };
  }
  return null;
}

async function fetchText(url, { fetchImpl = globalThis.fetch, articleOnly = false } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch non disponibile");
  const source = sourceDefinitionForUrl(url, { articleOnly });
  if (!source) throw new Error("URL fonte non consentito");
  const response = await fetchImpl(source.url, {
    redirect: "follow",
    headers: { "user-agent": "SomtoOfficialSourceScanner/1.0", accept: "text/html,application/xml,text/xml;q=0.9" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response?.ok) throw new Error(`Fonte HTTP ${response?.status || "unknown"}`);
  const finalSource = sourceDefinitionForUrl(response.url || source.url, { articleOnly });
  if (!finalSource || finalSource.provider !== source.provider) throw new Error("Redirect fonte non consentito");
  const declaredLength = Number(response.headers?.get?.("content-length") || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error("Risposta fonte troppo grande");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Risposta fonte troppo grande");
  return text;
}

function extractLocUrls(xml) {
  const out = [];
  const seen = new Set();
  const pattern = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let match;
  while ((match = pattern.exec(String(xml || "")))) {
    const value = clampText(decodeHtmlEntities(match[1]), 1000);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function extractArticleLinks(html, provider) {
  const definition = SOURCE_DEFINITIONS[provider];
  if (!definition) return [];
  const out = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    let absolute;
    try {
      absolute = new URL(match[1] || match[2], `https://${definition.hostname}`).toString();
    } catch (_) {
      continue;
    }
    const normalized = normalizeOfficialSourceUrl(absolute);
    if (!normalized || sourceDefinitionForUrl(normalized)?.provider !== provider || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function discoverOfficialSourceUrls({ fetchImpl = globalThis.fetch } = {}) {
  const errors = [];
  let disney = [];
  let hulu = [];
  try {
    const indexXml = await fetchText(DISNEY_SITEMAP_URL, { fetchImpl, articleOnly: false });
    const sitemapUrls = extractLocUrls(indexXml)
      .filter((url) => sourceDefinitionForUrl(url, { articleOnly: false })?.provider === "disney_press_uk")
      .filter((url) => /\/sitemap-[^/]+\.xml$/i.test(new URL(url).pathname));
    const sitemapUrl = sitemapUrls.at(-1);
    if (!sitemapUrl) throw new Error("Sitemap Disney figlio mancante");
    const sitemapXml = await fetchText(sitemapUrl, { fetchImpl, articleOnly: false });
    disney = extractLocUrls(sitemapXml)
      .map(normalizeOfficialSourceUrl)
      .filter(Boolean)
      .slice(-MAX_DISCOVERED_PER_SOURCE)
      .reverse();
  } catch (err) {
    errors.push({ provider: "disney_press_uk", error: clampText(err?.message || err, 240) });
  }
  try {
    const homepage = await fetchText(HULU_NEWS_URL, { fetchImpl, articleOnly: false });
    hulu = extractArticleLinks(homepage, "hulu_press").slice(0, MAX_DISCOVERED_PER_SOURCE);
  } catch (err) {
    errors.push({ provider: "hulu_press", error: clampText(err?.message || err, 240) });
  }
  return { urls: [...new Set([...disney, ...hulu])], errors };
}

async function ingestOfficialSourceUrl({
  db,
  admin,
  url,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  lookbackMs = DEFAULT_LIVE_LOOKBACK_MS,
  allowHistorical = false,
  publishDraft = publishOfficialUpdate,
} = {}) {
  const normalizedUrl = normalizeOfficialSourceUrl(url);
  if (!normalizedUrl) return { status: "rejected", url: String(url || ""), reason: "source_url" };
  const html = await fetchText(normalizedUrl, { fetchImpl, articleOnly: true });
  const article = parseOfficialArticle(html, normalizedUrl);
  const updateType = classifyOfficialAnnouncement(article);
  if (!updateType) return { status: "ignored", url: article.sourceUrl, reason: "event_type", article };
  if (!allowHistorical && article.publishedAtMs && article.publishedAtMs < nowMs - lookbackMs) {
    return { status: "ignored", url: article.sourceUrl, reason: "outside_window", article };
  }
  const title = await resolveArticleTitle(db, article);
  if (!title) return { status: "unmatched", url: article.sourceUrl, reason: "title_match", article };
  const draft = buildOfficialSourceDraft(article, title);
  const duplicate = await findDuplicateAnnouncement(db, draft);
  if (duplicate) return { status: "duplicate", url: article.sourceUrl, duplicate, article, title };

  await publishDraft({
    db,
    admin,
    requestedByUid: "official-source-scanner",
    input: draft,
  });
  await db.collection("officialUpdates").doc(draft.slug).set({
    ingestion: {
      ...draft.ingestion,
      articlePublishedAt: draft.ingestion.articlePublishedAtMs
        ? admin.firestore.Timestamp.fromMillis(draft.ingestion.articlePublishedAtMs)
        : null,
      acquiredAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  }, { merge: true });
  return { status: "drafted", url: article.sourceUrl, slug: draft.slug, article, title };
}

function mergeSeenUrls(previous, processed) {
  const out = [];
  const seen = new Set();
  for (const url of [...processed, ...previous]) {
    const normalized = normalizeOfficialSourceUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_SEEN_URLS) break;
  }
  return out;
}

function mergeUnmatchedAnnouncements(previous, results, nowMs = Date.now()) {
  const rows = [];
  const seen = new Set();
  const current = (results || [])
    .filter((row) => row?.status === "unmatched")
    .map((row) => ({
      url: normalizeOfficialSourceUrl(row.url),
      headline: clampText(row.article?.headline, 240),
      detectedAtMs: nowMs,
    }));
  for (const row of [...current, ...(previous || [])]) {
    const url = normalizeOfficialSourceUrl(row?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push({
      url,
      headline: clampText(row?.headline, 240),
      detectedAtMs: Number(row?.detectedAtMs || nowMs),
    });
    if (rows.length >= 50) break;
  }
  return rows;
}

async function runOfficialSourceIngestion({
  db,
  admin,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  maxPerRun = MAX_PROCESSED_PER_RUN,
} = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  const stateRef = db.doc(SOURCE_STATE_PATH);
  const [stateSnap, discovery] = await Promise.all([
    stateRef.get().catch(() => null),
    discoverOfficialSourceUrls({ fetchImpl }),
  ]);
  const state = stateSnap?.data?.() || {};
  const previousSeen = Array.isArray(state.seenUrls) ? state.seenUrls : [];
  const previousUnmatched = Array.isArray(state.unresolvedAnnouncements)
    ? state.unresolvedAnnouncements
    : [];

  // Primo deploy: fotografa l'esistente. Il backfill si fa solo da CLI con
  // `allowHistorical`, perche' pubblicare o anche solo creare decine di bozze
  // storiche non e' un side effect accettabile di un deploy.
  if (state.initialized !== true) {
    const seenUrls = mergeSeenUrls([], discovery.urls);
    await stateRef.set({
      initialized: true,
      initializedAt: admin.firestore.FieldValue.serverTimestamp(),
      seenUrls,
      lastDiscoveryCount: discovery.urls.length,
      lastErrors: discovery.errors,
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      lastRunAtMs: nowMs,
    }, { merge: true });
    return { baseline: true, discovered: discovery.urls.length, processed: 0, drafted: 0, unmatched: 0, errors: discovery.errors };
  }

  const seenSet = new Set(previousSeen);
  const pending = discovery.urls.filter((url) => !seenSet.has(url));
  const selected = pending.slice(0, Math.max(1, Math.min(MAX_PROCESSED_PER_RUN, Number(maxPerRun) || MAX_PROCESSED_PER_RUN)));
  const results = [];
  for (const url of selected) {
    try {
      results.push(await ingestOfficialSourceUrl({ db, admin, url, fetchImpl, nowMs }));
    } catch (err) {
      results.push({ status: "error", url, reason: clampText(err?.message || err, 240) });
    }
  }
  // Gli errori transitori non entrano nei visti: verranno riprovati al run
  // successivo. Gli annunci senza match, invece, non bloccano la coda ma
  // restano nel report finche' una pubblicazione con la stessa fonte li copre.
  const processedUrls = results
    .filter((row) => row.status !== "error")
    .map((row) => row.url)
    .filter(Boolean);
  const unmatchedRows = mergeUnmatchedAnnouncements(previousUnmatched, results, nowMs);
  const errors = [
    ...discovery.errors,
    ...results.filter((row) => row.status === "error").map((row) => ({ provider: sourceDefinitionForUrl(row.url)?.provider || "unknown", error: row.reason })),
  ].slice(0, 20);
  await stateRef.set({
    seenUrls: mergeSeenUrls(previousSeen, processedUrls),
    lastDiscoveryCount: discovery.urls.length,
    lastPendingCount: Math.max(0, pending.length - selected.length),
    lastDraftedCount: results.filter((row) => row.status === "drafted").length,
    lastUnmatchedCount: unmatchedRows.length,
    lastUnmatched: unmatchedRows,
    unresolvedAnnouncements: unmatchedRows,
    lastErrors: errors,
    lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
    lastRunAtMs: nowMs,
  }, { merge: true });
  return {
    baseline: false,
    discovered: discovery.urls.length,
    pending: pending.length,
    processed: results.length,
    drafted: results.filter((row) => row.status === "drafted").length,
    duplicates: results.filter((row) => row.status === "duplicate").length,
    ignored: results.filter((row) => row.status === "ignored").length,
    unmatched: unmatchedRows.length,
    errors,
    results,
  };
}

function romeDayKey(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}${map.month}${map.day}`;
}

function valueToMillis(value) {
  if (!value) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value.toMillis === "function") return Number(value.toMillis()) || 0;
  if (typeof value._seconds === "number") return value._seconds * 1000;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function auditReturningSeriesCoverage({
  db,
  nowMs = Date.now(),
  recentWindowMs = 120 * 24 * 60 * 60 * 1000,
  sampleLimit = 25,
} = {}) {
  const snapshot = await db.collection("titleProviders")
    .where("tmdbSeriesStatus", "==", "Returning Series")
    .limit(Math.max(1, Math.min(50, Number(sampleLimit) || 25)))
    .get();
  const candidates = (snapshot.docs || [])
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter((row) => !String(row.tmdbNextEpisodeAirDate || "").trim());
  const gaps = [];
  for (const candidate of candidates) {
    const [officialSnap, eventsSnap] = await Promise.all([
      db.collection("officialUpdates")
        .where("linkedTitleIds", "array-contains", candidate.titleId || candidate.id)
        .limit(20)
        .get(),
      db.collection("titleUpdateEvents")
        .where("titleId", "==", candidate.titleId || candidate.id)
        .limit(20)
        .get(),
    ]);
    const times = [
      ...(officialSnap.docs || []).flatMap((doc) => {
        const data = doc.data() || {};
        return [data.publishedAt, data.updatedAt];
      }),
      ...(eventsSnap.docs || []).flatMap((doc) => {
        const data = doc.data() || {};
        return data.status === "published" ? [data.firstPublishedAt, data.updatedAt, data.sortAt] : [];
      }),
    ].map(valueToMillis);
    if (times.some((ms) => ms >= nowMs - recentWindowMs)) continue;
    gaps.push({
      titleId: candidate.titleId || candidate.id,
      tmdbId: Number(candidate.tmdbId || 0) || null,
      seasonsCount: Math.max(0, Number(candidate.tmdbSeasonsCount || 0)),
      reason: "returning_without_upcoming_or_recent_update",
    });
  }
  return { sampled: candidates.length, gaps: gaps.slice(0, 25) };
}

async function reportOfficialSourceIngestion({ db, admin, getAdminUids, nowMs = Date.now() } = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  const [draftsSnap, stateSnap, weakCoverage] = await Promise.all([
    db.collection("officialUpdates").where("status", "==", "draft").limit(100).get(),
    db.doc(SOURCE_STATE_PATH).get().catch(() => null),
    auditReturningSeriesCoverage({ db, nowMs }).catch((err) => ({
      sampled: 0,
      gaps: [],
      error: clampText(err?.message || err, 240),
    })),
  ]);
  const drafts = (draftsSnap.docs || []).filter((doc) => doc.data()?.ingestion?.reviewRequired === true);
  const state = stateSnap?.data?.() || {};
  const unresolved = Array.isArray(state.unresolvedAnnouncements)
    ? state.unresolvedAnnouncements.slice(0, 50)
    : [];
  const coverageChecks = await Promise.all(unresolved.map(async (row) => {
    const covered = await db.collection("officialUpdates")
      .where("sourceUrls", "array-contains", row.url)
      .limit(1)
      .get()
      .catch(() => null);
    return covered?.empty === false ? null : row;
  }));
  const unresolvedAnnouncements = coverageChecks.filter(Boolean);
  const unmatched = unresolvedAnnouncements.length;
  const errors = Array.isArray(state.lastErrors) ? state.lastErrors.length : 0;
  const weakSignals = weakCoverage.gaps.length;
  const message = `${drafts.length} bozze da rivedere, ${unmatched} annunci senza titolo, ${weakSignals} segnali TMDB deboli, ${errors} errori fonte.`;
  const report = {
    pendingDrafts: drafts.length,
    unmatched,
    weakSignals,
    weakCoverage,
    errors,
    message,
    generatedAtMs: nowMs,
  };
  await db.doc(SOURCE_STATE_PATH).set({
    unresolvedAnnouncements,
    lastUnmatched: unresolvedAnnouncements,
    lastUnmatchedCount: unmatched,
    lastReport: report,
    lastReportAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  const configuredAdminUids = typeof getAdminUids === "function" ? getAdminUids() : [];
  const adminUids = Array.isArray(configuredAdminUids) ? configuredAdminUids.filter(Boolean) : [];
  if ((drafts.length || unmatched || weakSignals || errors) && adminUids.length) {
    const batch = db.batch();
    const expiresAt = admin.firestore.Timestamp.fromMillis(nowMs + REPORT_NOTIFICATION_TTL_MS);
    for (const uid of adminUids) {
      const ref = db.collection("users").doc(uid).collection("notifications")
        .doc(`official_source_report_${romeDayKey(nowMs)}`);
      batch.set(ref, {
        toUid: uid,
        fromUid: "system",
        type: "official_source_report",
        data: { message, ctaUrl: "/admin-official-updates.html", ...report },
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt,
      }, { merge: true });
    }
    await batch.commit();
  }
  return report;
}

module.exports = {
  DEFAULT_LIVE_LOOKBACK_MS,
  DISNEY_SITEMAP_URL,
  HULU_NEWS_URL,
  SOURCE_DEFINITIONS,
  SOURCE_STATE_PATH,
  announcementKey,
  auditReturningSeriesCoverage,
  buildOfficialSourceDraft,
  classifyOfficialAnnouncement,
  decodeHtmlEntities,
  discoverOfficialSourceUrls,
  extractArticleLinks,
  extractLocUrls,
  extractTitleHints,
  fetchOfficialSourceText: fetchText,
  findDuplicateAnnouncement,
  ingestOfficialSourceUrl,
  mergeSeenUrls,
  mergeUnmatchedAnnouncements,
  normalizeOfficialSourceUrl,
  parseOfficialArticle,
  reportOfficialSourceIngestion,
  resolveArticleTitle,
  runOfficialSourceIngestion,
  seasonNumberFromArticle,
  sourceIdForUrl,
};
