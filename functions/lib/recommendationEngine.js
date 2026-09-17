"use strict";

// Motore di raccomandazione — parte PURA.
//
// Estratto da functions/index.js (dove viveva in ~1200 righe non testabili) per
// due motivi: renderlo unit-testabile e permettere all'harness di benchmark
// offline (scripts/benchmark-recommendations.cjs) di far girare ESATTAMENTE lo
// scoring di produzione su un dataset storico. Se qui e in index.js le formule
// divergono, il benchmark misura un motore che non esiste.
//
// Qui NON c'e' I/O: niente admin, niente Firestore, niente fetch, niente logger.
// Le funzioni che leggono dati (collectCandidatePool, loadTasteProfile,
// computeCollaborativeSignals, loadUserSeenTitleIds, i loader di seed...)
// restano in index.js e passano qui i dati gia' caricati.
//
// Nondeterminismo: pickMatchDeck usa esplorazione casuale e freschezza. Le due
// sorgenti (`Math.random` e `Date.now`) sono ora INIETTABILI via opts, con i
// default storici — la produzione non cambia comportamento, il benchmark passa
// un PRNG con seed e un `nowMs` fisso e ottiene run riproducibili.

const {
  normalizeText,
  tokenizeNormalized,
  safeArray,
  safeString,
  clamp,
  toId,
  toMillis,
  tsToMs,
  shuffleRows,
} = require("./pureUtils");
const { resolveGenreLabel } = require("./genreLabels");

const DAY_MS = 24 * 60 * 60 * 1000;

// Costanti di tuning del motore (erano sparse in index.js).
const MATCH_TASTE_HALF_LIFE_MS = 120 * DAY_MS;
const MATCH_TASTE_MIN_WEIGHT = 0.15;
const MATCH_TASTE_MIN_COLD_START_CONFIDENCE = 18;

// Soglia di score sotto la quale un candidato non entra nel deck Match.
const MATCH_SCORE_THRESHOLD = 0.65;
const MATCH_SCORE_THRESHOLD_COLD_START = 0.35;
// Peso minimo del taste profile per applicare il bias di gusto.
const MATCH_TASTE_BIAS_MIN_WEIGHT = 0.4;

function buildSeedStats(seedTitles, opts = {}) {
  const genreSet = new Set();
  const genreTokenSet = new Set();
  const directorSet = new Set();
  const castSet = new Set();
  const relatedSet = new Set();
  const tokenSet = new Set();
  const typeCounts = new Map();
  let yearSum = 0;
  let yearCount = 0;

  for (const t of seedTitles) {
    safeArray(t.genres).forEach((g) => {
      const rawGenre = String(g || "").trim();
      if (!rawGenre) return;
      genreSet.add(rawGenre);
      const resolved = resolveGenreLabel(rawGenre, opts?.genreLabelMap) || rawGenre;
      const genreToken = normalizeText(resolved);
      if (genreToken) genreTokenSet.add(genreToken);
    });
    safeArray(t.directorIds).forEach((x) => directorSet.add(String(x)));
    safeArray(t.directors).forEach((x) => directorSet.add(normalizeText(String(x))));
    safeArray(t.castIds).forEach((x) => castSet.add(String(x)));
    safeArray(t.cast).forEach((x) => castSet.add(normalizeText(String(x))));
    safeArray(t.related).forEach((x) => relatedSet.add(String(x)));
    tokenizeNormalized([t.name, t.originalName, t.description].join(" ")).forEach((tok) => tokenSet.add(tok));

    if (t.type) {
      const k = String(t.type);
      typeCounts.set(k, (typeCounts.get(k) || 0) + 1);
    }
    if (Number.isFinite(Number(t.year))) {
      yearSum += Number(t.year);
      yearCount++;
    }
  }

  let dominantType = "";
  let dominantTypeCount = -1;
  for (const [k, count] of typeCounts.entries()) {
    if (count > dominantTypeCount) {
      dominantType = k;
      dominantTypeCount = count;
    }
  }

  return {
    genreSet,
    genreTokenSet,
    directorSet,
    castSet,
    relatedSet,
    tokenSet,
    dominantType,
    avgYear: yearCount ? (yearSum / yearCount) : null,
  };
}

function parseDecadeWindow(decadeValue) {
  const n = Number(String(decadeValue || "").trim());
  if (!Number.isFinite(n) || n < 1900 || n > 2100) return null;
  return { from: n, to: n + 9 };
}

function yearInsideDecade(yearValue, decadeWindow) {
  if (!decadeWindow) return true;
  const y = Number(yearValue || 0);
  if (!Number.isFinite(y) || y <= 0) return false;
  return y >= decadeWindow.from && y <= decadeWindow.to;
}

function candidateGenreTokens(candidate, genreLabelMap) {
  return safeArray(candidate?.genres)
    .map((g) => {
      const raw = String(g || "").trim();
      if (!raw) return "";
      return normalizeText(resolveGenreLabel(raw, genreLabelMap) || raw);
    })
    .filter(Boolean);
}

const MOOD_GENRES = Object.freeze({
  light: new Set([
    "comedy", "commedia", "animation", "animazione", "family", "romance", "romantico", "musical", "musicale",
  ]),
  intense: new Set([
    "thriller", "horror", "crime", "crimine", "action", "azione", "war", "guerra", "noir", "western",
  ]),
  mind: new Set([
    "sci fi", "science fiction", "fantascienza", "mystery", "mistero", "drama", "drammatico", "documentary", "documentario",
  ]),
});

function moodScore(candidate, mood, genreLabelMap) {
  if (!mood || mood === "all") return { bonus: 0, reason: "" };
  const genreTokens = candidateGenreTokens(candidate, genreLabelMap);
  if (!genreTokens.length) return { bonus: 0, reason: "" };

  const target = MOOD_GENRES[mood];
  if (!target) return { bonus: 0, reason: "" };
  const hits = genreTokens.filter((x) => target.has(x));
  if (!hits.length) return { bonus: -0.7, reason: "" };

  const bonus = 1 + Math.min(1, (hits.length - 1) * 0.4);
  const label = mood === "light" ? "mood leggero" : mood === "intense" ? "mood intenso" : "mood mind-bending";
  return { bonus, reason: label };
}

function decayWeightFor(lastAtMs, nowMs) {
  if (!lastAtMs || lastAtMs <= 0) return 1;
  const age = Math.max(0, nowMs - lastAtMs);
  return Math.pow(0.5, age / MATCH_TASTE_HALF_LIFE_MS);
}

function buildAffinityMap(bucket, nowMs) {
  const out = new Map();
  if (!bucket || typeof bucket !== "object") return out;
  for (const [id, raw] of Object.entries(bucket)) {
    const key = String(id || "").trim();
    if (!key) continue;
    const sum = Number(raw?.sum || 0);
    const weight = Number(raw?.weight || 0);
    if (!Number.isFinite(sum) || !Number.isFinite(weight) || weight <= 0) continue;
    const decay = decayWeightFor(tsToMs(raw?.lastAt), nowMs);
    const effectiveWeight = weight * decay;
    if (effectiveWeight < MATCH_TASTE_MIN_WEIGHT) continue;
    const affinity = clamp(sum / (weight + 1.2), -1, 1);
    out.set(key, { affinity, weight: effectiveWeight, decay });
  }
  return out;
}

function scoreTasteBias(candidate, profile, opts = {}) {
  if (!profile) return { bonus: 0, penalty: 0, reasons: [] };
  const genreLabelMap = opts.genreLabelMap;
  const reasons = [];
  let bonus = 0;
  let penalty = 0;

  if (profile.genres.size) {
    const seen = new Set();
    let genreDelta = 0;
    let hitCount = 0;
    for (const g of safeArray(candidate.genres)) {
      const rawKey = toId(resolveGenreLabel(g, genreLabelMap) || g);
      const tokenKey = toId(g);
      const key = profile.genres.has(rawKey) ? rawKey : (profile.genres.has(tokenKey) ? tokenKey : "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = profile.genres.get(key);
      if (!entry) continue;
      const contrib = entry.affinity * 1.6;
      genreDelta += contrib;
      if (entry.affinity > 0.15) hitCount++;
    }
    if (genreDelta > 0) {
      bonus += Math.min(genreDelta, 3.2);
      if (hitCount) reasons.push("generi in linea con i tuoi gusti recenti");
    } else if (genreDelta < -0.2) {
      penalty += Math.min(Math.abs(genreDelta), 2.4);
    }
  }

  if (profile.people.size) {
    const seen = new Set();
    let castDelta = 0;
    const addCast = (rawKey) => {
      const key = toId(rawKey);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const entry = profile.people.get(key);
      if (!entry) return;
      castDelta += entry.affinity * 0.9;
    };
    for (const id of safeArray(candidate.castIds)) addCast(id);
    for (const name of safeArray(candidate.cast)) addCast(normalizeText(String(name)));
    if (castDelta > 0) bonus += Math.min(castDelta, 2.0);
    else if (castDelta < -0.2) penalty += Math.min(Math.abs(castDelta), 1.2);
  }

  if (profile.directors.size) {
    const seen = new Set();
    let dirDelta = 0;
    const addDir = (rawKey) => {
      const key = toId(rawKey);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const entry = profile.directors.get(key);
      if (!entry) return;
      dirDelta += entry.affinity * 1.8;
    };
    for (const id of safeArray(candidate.directorIds)) addDir(id);
    for (const name of safeArray(candidate.directors)) addDir(normalizeText(String(name)));
    if (dirDelta > 0) {
      bonus += Math.min(dirDelta, 2.6);
      reasons.push("regista che segui attivamente");
    } else if (dirDelta < -0.25) {
      penalty += Math.min(Math.abs(dirDelta), 1.6);
    }
  }

  return { bonus, penalty, reasons };
}

function scoreCandidate(candidate, seedStats, opts = {}) {
  let score = 0;
  const reasons = [];
  const mood = String(opts?.mood || "all");
  const collab = opts?.collab || null;
  const genreLabelMap = opts?.genreLabelMap;

  const candGenres = safeArray(candidate.genres).map((g) => String(g || "").trim()).filter(Boolean);
  const matchedGenres = [];
  const seenGenreTokens = new Set();
  for (const g of candGenres) {
    const token = normalizeText(resolveGenreLabel(g, genreLabelMap) || g);
    if (!token) continue;
    if (!seedStats.genreTokenSet?.has(token)) continue;
    if (seenGenreTokens.has(token)) continue;
    seenGenreTokens.add(token);
    matchedGenres.push(g);
  }
  if (matchedGenres.length) {
    score += matchedGenres.length * 2.2;
    const matchedLabels = matchedGenres
      .map((g) => resolveGenreLabel(g, genreLabelMap))
      .filter(Boolean)
      .filter((label, idx, arr) => arr.indexOf(label) === idx);
    if (matchedLabels.length) {
      reasons.push(`generi simili: ${matchedLabels.slice(0, 2).join(", ")}`);
    } else {
      reasons.push("generi simili");
    }
  }

  if (candidate.type && seedStats.dominantType && String(candidate.type) === seedStats.dominantType) {
    score += 1.2;
    reasons.push(`stesso formato (${seedStats.dominantType === "tv" ? "serie" : "film"})`);
  }

  const dirValues = new Set([
    ...safeArray(candidate.directorIds).map(String),
    ...safeArray(candidate.directors).map((x) => normalizeText(String(x))),
  ]);
  let sharedDir = 0;
  for (const d of dirValues) if (seedStats.directorSet.has(d)) sharedDir++;
  if (sharedDir > 0) {
    score += sharedDir * 2.6;
    reasons.push("regia in comune");
  }

  const castValues = new Set([
    ...safeArray(candidate.castIds).map(String),
    ...safeArray(candidate.cast).map((x) => normalizeText(String(x))),
  ]);
  let sharedCast = 0;
  for (const c of castValues) if (seedStats.castSet.has(c)) sharedCast++;
  if (sharedCast > 0) {
    score += Math.min(sharedCast, 3) * 1.1;
    reasons.push("cast affine");
  }

  if (seedStats.relatedSet.has(String(candidate.id))) {
    score += 3.4;
    reasons.push("collegato ai tuoi preferiti");
  }

  if (collab && collab.score > 0) {
    const collabBonus = clamp(collab.score * 0.8, 0, 4.8);
    score += collabBonus;
    reasons.push(`match utenti simili (${collab.voters})`);
  }

  const candTokens = new Set(tokenizeNormalized([candidate.name, candidate.originalName, candidate.description].join(" ")));
  let sharedTokens = 0;
  for (const tok of candTokens) if (seedStats.tokenSet.has(tok)) sharedTokens++;
  if (sharedTokens > 0) {
    score += Math.min(sharedTokens, 6) * 0.35;
  }

  const year = Number(candidate.year || 0);
  if (seedStats.avgYear && year > 0) {
    const diff = Math.abs(year - seedStats.avgYear);
    if (diff <= 2) score += 1.3;
    else if (diff <= 5) score += 0.8;
    else if (diff <= 10) score += 0.35;
  }

  const ratingAvg = Number(candidate.ratingAvg || 0);
  const ratingCount = Number(candidate.ratingCount || 0);
  score += clamp(ratingAvg / 5, 0, 2);
  score += clamp(Math.log10(ratingCount + 1), 0, 2) * 0.7;

  const moodFit = moodScore(candidate, mood, genreLabelMap);
  if (moodFit.bonus) score += moodFit.bonus;
  if (moodFit.reason) reasons.push(moodFit.reason);

  if (!reasons.length && ratingAvg >= 7.5 && ratingCount >= 15) {
    reasons.push("molto apprezzato dalla community");
  }

  if (!reasons.length) {
    reasons.push("affinità generale con i tuoi gusti");
  }

  return { score, reasons: reasons.slice(0, 3) };
}

function selectTopWithDiversity(rows, maxItems) {
  if (!rows.length) return [];
  const out = [];
  const typeCount = new Map();
  const capPerType = Math.max(2, Math.ceil(maxItems * 0.65));

  for (const row of rows) {
    if (out.length >= maxItems) break;
    const type = String(row.type || "unknown");
    const used = typeCount.get(type) || 0;
    if (used >= capPerType) continue;
    out.push(row);
    typeCount.set(type, used + 1);
  }

  if (out.length < maxItems) {
    for (const row of rows) {
      if (out.length >= maxItems) break;
      if (out.find(x => x.id === row.id)) continue;
      out.push(row);
    }
  }

  return out;
}

function mapRecommendedTitle(row) {
  return {
    id: row.id,
    name: safeString(row.name || "", 120),
    type: safeString(row.type || "", 12) || "movie",
    year: Number(row.year || 0) || null,
    posterPath: row.posterPath || null,
    ratingAvg: Number(row.ratingAvg || 0),
    ratingCount: Number(row.ratingCount || 0),
    overview: safeString(row.description || row.overview || "", 280),
    reasons: safeArray(row._reasons).slice(0, 3),
    score: Number(row._score || 0),
  };
}

function addSeedScore(scoreMap, titleId, value) {
  const id = toId(titleId);
  const weight = Number(value || 0);
  if (!id || !Number.isFinite(weight) || weight <= 0) return;
  scoreMap.set(id, (scoreMap.get(id) || 0) + weight);
}

function mergeSeedScores(target, source, factor = 1) {
  if (!(source instanceof Map)) return;
  for (const [titleId, score] of source.entries()) {
    addSeedScore(target, titleId, Number(score || 0) * Number(factor || 1));
  }
}

function buildPeopleAffinity(seedTitles, seedScoreByTitle = new Map()) {
  const directorWeights = new Map();
  const castWeights = new Map();

  const add = (map, key, weight) => {
    const k = String(key || "").trim();
    const w = Number(weight || 0);
    if (!k || !Number.isFinite(w) || w <= 0) return;
    map.set(k, (map.get(k) || 0) + w);
  };

  for (const title of seedTitles) {
    const titleId = toId(title?.id);
    const seedWeightRaw = Number(seedScoreByTitle.get(titleId) || 1);
    const seedWeight = clamp(seedWeightRaw, 0.8, 6.2);
    const dirBoost = 0.45 + (seedWeight * 0.18);
    const castBoost = 0.35 + (seedWeight * 0.14);

    safeArray(title.directorIds).forEach((id) => add(directorWeights, `id:${toId(id)}`, dirBoost * 1.25));
    safeArray(title.directors).forEach((name) => {
      const n = normalizeText(name);
      if (n) add(directorWeights, `name:${n}`, dirBoost);
    });

    safeArray(title.castIds).forEach((id) => add(castWeights, `id:${toId(id)}`, castBoost));
    safeArray(title.cast).forEach((name) => {
      const n = normalizeText(name);
      if (n) add(castWeights, `name:${n}`, castBoost * 0.9);
    });
  }

  const topDir = [...directorWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 36);
  const topCast = [...castWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100);

  return {
    directorWeights: new Map(topDir),
    castWeights: new Map(topCast),
  };
}

// Affinita' alle piattaforme derivata dai titoli-seed, non da un abbonamento
// dichiarato. Ogni titolo divide il proprio peso fra i provider disponibili:
// un titolo presente su cinque servizi non vale cinque volte un'esclusiva.
// Servono almeno due titoli distinti prima che una piattaforma sia esposta ai
// client o influenzi il ranking.
function buildProviderAffinity(seedTitles, seedScoreByTitle = new Map()) {
  const buckets = new Map();

  for (const title of safeArray(seedTitles)) {
    const titleId = toId(title?.id);
    if (!titleId) continue;
    const providers = [];
    const seenKeys = new Set();
    for (const rawName of safeArray(title?.watchProviderNames)) {
      const name = safeString(rawName, 120).trim();
      const key = normalizeText(name);
      if (!name || !key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      providers.push({ key, name });
    }
    if (!providers.length) continue;

    const seedWeight = clamp(Number(seedScoreByTitle.get(titleId) || 1), 0.6, 6.2);
    const splitWeight = seedWeight / providers.length;
    for (const provider of providers) {
      const current = buckets.get(provider.key) || {
        key: provider.key,
        name: provider.name,
        score: 0,
        titleIds: new Set(),
      };
      current.score += splitWeight;
      current.titleIds.add(titleId);
      buckets.set(provider.key, current);
    }
  }

  return [...buckets.values()]
    .filter((entry) => entry.titleIds.size >= 2 && entry.score >= 1.2)
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      score: entry.score,
      evidenceTitleCount: entry.titleIds.size,
    }))
    .sort((a, b) =>
      (b.score - a.score)
      || (b.evidenceTitleCount - a.evidenceTitleCount)
      || a.name.localeCompare(b.name)
    )
    .slice(0, 5);
}

function providerAffinityForCandidate(candidate, providerAffinity) {
  const entries = safeArray(providerAffinity);
  if (!entries.length) return null;
  const providerKeys = new Set(
    safeArray(candidate?.watchProviderNames)
      .map((name) => normalizeText(safeString(name, 120)))
      .filter(Boolean)
  );
  if (!providerKeys.size) return null;
  return entries.find((entry) => providerKeys.has(entry.key)) || null;
}

function selectProviderRecommendationLane(scoredRows, providerAffinity, maxItems = 10) {
  const rows = safeArray(scoredRows);
  for (const provider of safeArray(providerAffinity)) {
    const matching = rows.filter((row) => {
      const keys = safeArray(row?.watchProviderNames)
        .map((name) => normalizeText(safeString(name, 120)))
        .filter(Boolean);
      return keys.includes(provider.key);
    });
    if (!matching.length) continue;
    return {
      provider: {
        name: provider.name,
        evidenceTitleCount: provider.evidenceTitleCount,
        inferred: true,
      },
      items: matching.slice(0, clamp(Number(maxItems || 10), 1, 20)).map(mapMatchTitle),
    };
  }
  return null;
}

function scorePeopleAffinity(candidate, peopleAffinity) {
  if (!peopleAffinity) return { bonus: 0, reasons: [] };
  const dirWeights = peopleAffinity.directorWeights || new Map();
  const castWeights = peopleAffinity.castWeights || new Map();
  if (!dirWeights.size && !castWeights.size) return { bonus: 0, reasons: [] };

  let dirHit = 0;
  let castHit = 0;
  let rawScore = 0;

  const dirSeen = new Set();
  safeArray(candidate.directorIds).forEach((id) => {
    const key = `id:${toId(id)}`;
    if (!key || dirSeen.has(key)) return;
    dirSeen.add(key);
    const w = Number(dirWeights.get(key) || 0);
    if (w > 0) {
      rawScore += w * 0.62;
      dirHit++;
    }
  });
  safeArray(candidate.directors).forEach((name) => {
    const n = normalizeText(name);
    if (!n) return;
    const key = `name:${n}`;
    if (dirSeen.has(key)) return;
    dirSeen.add(key);
    const w = Number(dirWeights.get(key) || 0);
    if (w > 0) {
      rawScore += w * 0.58;
      dirHit++;
    }
  });

  const castSeen = new Set();
  safeArray(candidate.castIds).forEach((id) => {
    const key = `id:${toId(id)}`;
    if (!key || castSeen.has(key)) return;
    castSeen.add(key);
    const w = Number(castWeights.get(key) || 0);
    if (w > 0) {
      rawScore += w * 0.32;
      castHit++;
    }
  });
  safeArray(candidate.cast).forEach((name) => {
    const n = normalizeText(name);
    if (!n) return;
    const key = `name:${n}`;
    if (castSeen.has(key)) return;
    castSeen.add(key);
    const w = Number(castWeights.get(key) || 0);
    if (w > 0) {
      rawScore += w * 0.28;
      castHit++;
    }
  });

  const bonus = clamp(rawScore, 0, 4.4);
  const reasons = [];
  if (dirHit > 0) reasons.push("registi affini ai tuoi gusti");
  if (castHit > 0) reasons.push("attori affini ai tuoi gusti");
  return { bonus, reasons };
}

const MATCH_SAGA_STOPWORDS = new Set([
  "the", "la", "lo", "il", "i", "gli", "le", "un", "una", "uno", "di", "da", "del", "della", "dei", "delle", "e", "and",
  "parte", "part", "chapter", "capitolo", "episodio", "episode", "stagione", "season", "volume", "vol",
]);

function isSequelToken(token) {
  const t = String(token || "").trim().toLowerCase();
  if (!t) return false;
  if (/^\d+$/.test(t)) return true;
  if (/^[0-9]+(?:st|nd|rd|th)$/.test(t)) return true;
  if (/^(ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/.test(t)) return true;
  return false;
}

function matchSagaKey(row) {
  const name = safeString(row?.name || row?.originalName || "", 180);
  if (!name) return "";
  const head = String(name).split(/[:\-–|]/)[0] || String(name);
  const tokens = tokenizeNormalized(head)
    .filter((tok) => !MATCH_SAGA_STOPWORDS.has(tok))
    .filter((tok) => !isSequelToken(tok));
  if (!tokens.length) return "";
  return tokens.slice(0, Math.min(2, tokens.length)).join(" ");
}

function areMatchRowsTooSimilar(a, b) {
  const aId = toId(a?.id);
  const bId = toId(b?.id);
  if (!aId || !bId) return false;
  if (aId === bId) return true;

  const sagaA = matchSagaKey(a);
  const sagaB = matchSagaKey(b);
  if (sagaA && sagaB && sagaA === sagaB) return true;

  const nameA = normalizeText(a?.name || a?.originalName || "");
  const nameB = normalizeText(b?.name || b?.originalName || "");
  if (!nameA || !nameB) return false;
  if (nameA.length >= 8 && nameB.includes(nameA)) return true;
  if (nameB.length >= 8 && nameA.includes(nameB)) return true;
  return false;
}

function diversifyMatchRows(rows, maxItems, { minGap = 2 } = {}) {
  const max = clamp(Number(maxItems || rows?.length || 0), 1, 40);
  const gap = clamp(Number(minGap || 2), 1, 4);
  const pool = safeArray(rows).slice();
  const out = [];
  const sagaCounts = new Map();
  const earlyWindow = Math.min(max, 8);

  while (pool.length && out.length < max) {
    const recent = out.slice(Math.max(0, out.length - gap));
    let picked = -1;

    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      const conflicts = recent.some((r) => areMatchRowsTooSimilar(candidate, r));
      if (conflicts) continue;

      const saga = matchSagaKey(candidate);
      const seenSagaCount = saga ? Number(sagaCounts.get(saga) || 0) : 0;
      const allowEarlyRepeat = !saga || out.length >= earlyWindow || seenSagaCount === 0;
      if (allowEarlyRepeat) {
        picked = i;
        break;
      }
    }

    if (picked < 0) {
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i];
        const conflicts = recent.some((r) => areMatchRowsTooSimilar(candidate, r));
        if (!conflicts) {
          picked = i;
          break;
        }
      }
    }

    if (picked < 0) picked = 0;
    const selected = pool.splice(picked, 1)[0];
    out.push(selected);
    const saga = matchSagaKey(selected);
    if (saga) sagaCounts.set(saga, Number(sagaCounts.get(saga) || 0) + 1);
  }

  return out;
}

// `opts.nowMs` e `opts.random` esistono solo per rendere il deck riproducibile
// nel benchmark. I default sono il comportamento storico di produzione.
function pickMatchDeck(scoredRows, maxItems, opts = {}) {
  if (!scoredRows.length) return [];

  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const max = clamp(Number(maxItems || 18), 5, 36);
  const windowSize = Math.min(scoredRows.length, Math.max(max * 4, 80));
  const baseWindow = scoredRows.slice(0, windowSize);

  const explorationTarget = Math.max(1, Math.round(max * 0.2));
  const primaryTarget = Math.max(1, max - explorationTarget);
  const primary = selectTopWithDiversity(baseWindow, primaryTarget);

  const used = new Set(primary.map((row) => toId(row.id)));
  const usedGenres = new Set(
    primary.flatMap((row) => safeArray(row.genres).map((g) => String(g)))
  );

  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const tailStart = Math.floor(baseWindow.length * 0.35);
  const explorePool = shuffleRows(
    baseWindow.slice(tailStart).filter((row) => !used.has(toId(row.id))),
    random
  );

  const explore = [];
  for (const row of explorePool) {
    if (explore.length >= explorationTarget) break;
    const genres = safeArray(row.genres).map((g) => String(g));
    const introducesGenre = genres.some((g) => !usedGenres.has(g));
    const createdMs = toMillis(row.createdAt);
    const isFresh = createdMs && (nowMs - createdMs) <= (90 * DAY_MS);

    if (introducesGenre || isFresh || random() < 0.18) {
      explore.push(row);
      used.add(toId(row.id));
      genres.forEach((g) => usedGenres.add(g));
    }
  }

  if (explore.length < explorationTarget) {
    for (const row of explorePool) {
      if (explore.length >= explorationTarget) break;
      const id = toId(row.id);
      if (used.has(id)) continue;
      explore.push(row);
      used.add(id);
    }
  }

  const out = [];
  let pi = 0;
  let ei = 0;
  while (out.length < max && (pi < primary.length || ei < explore.length)) {
    if (pi < primary.length) out.push(primary[pi++]);
    if (pi < primary.length) out.push(primary[pi++]);
    if (ei < explore.length) out.push(explore[ei++]);
  }

  if (out.length < max) {
    for (const row of baseWindow) {
      if (out.length >= max) break;
      if (out.find((x) => x.id === row.id)) continue;
      out.push(row);
    }
  }

  const unique = [];
  const usedIds = new Set();
  for (const row of out) {
    const id = toId(row?.id);
    if (!id || usedIds.has(id)) continue;
    usedIds.add(id);
    unique.push(row);
  }

  const minGap = max >= 14 ? 3 : 2;
  const diversified = diversifyMatchRows(unique, max, { minGap });

  if (diversified.length < max) {
    const picked = new Set(diversified.map((row) => toId(row?.id)).filter(Boolean));
    for (const row of baseWindow) {
      if (diversified.length >= max) break;
      const id = toId(row?.id);
      if (!id || picked.has(id)) continue;
      diversified.push(row);
      picked.add(id);
    }
  }

  return diversifyMatchRows(diversified, max, { minGap }).slice(0, max);
}

function computeMatchPercent(row, topScore) {
  const top = topScore > 0 ? topScore : Math.max(1, Number(row?._score || 1));
  const ratio = clamp(Number(row?._score || 0) / top, 0, 1);
  const quality = clamp(Number(row?.ratingAvg || 0) / 10, 0, 1);
  return Math.round(clamp(42 + (ratio * 46) + (quality * 11), 35, 99));
}

function mapMatchTitle(row, topScore) {
  return {
    ...mapRecommendedTitle(row),
    genres: safeArray(row.genres).slice(0, 4).map((g) => safeString(g, 40)).filter(Boolean),
    matchPercent: computeMatchPercent(row, topScore),
  };
}

// Costruisce il profilo gusti "vivo" (affinita' decayate) dal doc
// users/{uid}/tasteProfile/agg. Parte pura di loadTasteProfile: il chiamante
// legge Firestore e passa qui i dati.
function buildTasteProfile(docData, nowMs = Date.now()) {
  const data = docData && typeof docData === "object" ? docData : {};
  const featureSums = data.featureSums || {};
  const profile = {
    genres: buildAffinityMap(featureSums.genres, nowMs),
    people: buildAffinityMap(featureSums.people, nowMs),
    directors: buildAffinityMap(featureSums.directors, nowMs),
    countries: buildAffinityMap(featureSums.countries, nowMs),
    confidenceScore: Number(data.confidenceScore || 0),
  };
  let totalWeight = 0;
  for (const m of [profile.genres, profile.people, profile.directors]) {
    for (const v of m.values()) totalWeight += v.weight;
  }
  profile.totalWeight = totalWeight;
  return profile;
}

// Un utente e' "cold start" se ha pochi seed o poca evidenza accumulata: in quel
// caso la soglia di score si abbassa e i titoli popolari-ben-votati prendono un
// bonus, per non servire un deck vuoto.
function isColdStartProfile(seedCount, confidenceScore) {
  return Number(seedCount || 0) < 3
    || Number(confidenceScore || 0) < MATCH_TASTE_MIN_COLD_START_CONFIDENCE;
}

// Pipeline di ranking del deck Match. E' il corpo che stava dentro getMatchQueue,
// senza I/O: il chiamante ha gia' caricato candidati, esclusioni, seed, taste
// profile e segnali collaborativi.
//
// Ritorna { scored, isColdStart, hasTasteBias, threshold, usedFiller }:
// `scored` e' ordinato per score decrescente e va passato a pickMatchDeck.
function rankMatchCandidates({
  candidates,
  excludedIds,
  seedStats,
  seedCount = 0,
  peopleAffinity = null,
  tasteProfile = null,
  collabSignals = null,
  providerAffinity = null,
  genreLabelMap = null,
  max = 18,
} = {}) {
  const excluded = excludedIds instanceof Set ? excludedIds : new Set(safeArray(excludedIds));
  const collab = collabSignals instanceof Map ? collabSignals : new Map();
  const rows = candidates instanceof Map ? Array.from(candidates.values()) : safeArray(candidates);

  const confidenceScore = Number(tasteProfile?.confidenceScore || 0);
  const isColdStart = isColdStartProfile(seedCount, confidenceScore);
  const hasTasteBias = !!tasteProfile && Number(tasteProfile.totalWeight || 0) > MATCH_TASTE_BIAS_MIN_WEIGHT;
  const threshold = isColdStart ? MATCH_SCORE_THRESHOLD_COLD_START : MATCH_SCORE_THRESHOLD;

  const scored = [];
  for (const candidate of rows) {
    const candidateId = toId(candidate?.id);
    if (!candidateId || excluded.has(candidateId)) continue;

    const collabRow = collab.get(candidateId) || null;
    const base = scoreCandidate(candidate, seedStats, { mood: "all", collab: collabRow, genreLabelMap });
    const reasons = safeArray(base.reasons).slice(0, 4);
    let adjusted = Number(base.score || 0);

    const people = scorePeopleAffinity(candidate, peopleAffinity);
    if (people.bonus > 0) {
      adjusted += people.bonus;
      for (const reason of people.reasons) {
        if (!reasons.includes(reason)) reasons.push(reason);
      }
    }

    if (hasTasteBias) {
      const bias = scoreTasteBias(candidate, tasteProfile, { genreLabelMap });
      if (bias.bonus) adjusted += bias.bonus;
      if (bias.penalty) adjusted -= bias.penalty;
      for (const reason of bias.reasons) {
        if (!reasons.includes(reason)) reasons.push(reason);
      }
    }

    const provider = providerAffinityForCandidate(candidate, providerAffinity);
    if (provider) {
      const topProviderScore = Math.max(1, Number(safeArray(providerAffinity)[0]?.score || 1));
      adjusted += clamp((Number(provider.score || 0) / topProviderScore) * 1.15, 0.25, 1.15);
      const reason = `spesso presente nei titoli che guardi su ${provider.name}`;
      if (!reasons.includes(reason)) reasons.push(reason);
    }

    const ratingCount = Number(candidate.ratingCount || 0);
    if (ratingCount < 2) adjusted -= 0.35;
    if (ratingCount >= 45) adjusted += 0.45;

    const year = Number(candidate.year || 0);
    if (year >= 2019) adjusted += 0.25;

    if (isColdStart) {
      const ratingAvg = Number(candidate.ratingAvg || 0);
      if (ratingCount >= 80 && ratingAvg >= 7) adjusted += 0.8;
      else if (ratingCount >= 25 && ratingAvg >= 6.5) adjusted += 0.4;
    }

    if (adjusted <= threshold) continue;
    scored.push({ ...candidate, _score: adjusted, _reasons: reasons.slice(0, 3) });
  }

  // Fallback: se lo scoring ha lasciato pochi titoli (catalogo nuovo con pochi
  // voti, o account senza taste data) riempiamo dal pool popolare gia' caricato,
  // cosi' il deck Match non e' mai vuoto al primo accesso.
  let usedFiller = false;
  if (scored.length < max) {
    const alreadyScored = new Set(scored.map((row) => toId(row.id)));
    const filler = [];
    for (const candidate of rows) {
      const candidateId = toId(candidate?.id);
      if (!candidateId || excluded.has(candidateId) || alreadyScored.has(candidateId)) continue;
      filler.push(candidate);
    }
    filler.sort((a, b) =>
      (Number(b.ratingCount || 0) - Number(a.ratingCount || 0))
      || (Number(b.ratingAvg || 0) - Number(a.ratingAvg || 0))
      || (Number(b.year || 0) - Number(a.year || 0))
    );
    for (const candidate of filler) {
      if (scored.length >= max) break;
      usedFiller = true;
      scored.push({
        ...candidate,
        _score: 0.05 + Math.min(0.25, Number(candidate.ratingCount || 0) * 0.003),
        _reasons: ["popolare su Somto"],
      });
    }
  }

  scored.sort((a, b) => b._score - a._score);
  return { scored, isColdStart, hasTasteBias, threshold, usedFiller, confidenceScore };
}

module.exports = {
  DAY_MS,
  MATCH_TASTE_HALF_LIFE_MS,
  MATCH_TASTE_MIN_WEIGHT,
  MATCH_TASTE_MIN_COLD_START_CONFIDENCE,
  MATCH_SCORE_THRESHOLD,
  MATCH_SCORE_THRESHOLD_COLD_START,
  MATCH_TASTE_BIAS_MIN_WEIGHT,
  MOOD_GENRES,
  MATCH_SAGA_STOPWORDS,
  buildSeedStats,
  parseDecadeWindow,
  yearInsideDecade,
  candidateGenreTokens,
  moodScore,
  decayWeightFor,
  buildAffinityMap,
  buildTasteProfile,
  isColdStartProfile,
  scoreTasteBias,
  scoreCandidate,
  selectTopWithDiversity,
  mapRecommendedTitle,
  addSeedScore,
  mergeSeedScores,
  buildPeopleAffinity,
  buildProviderAffinity,
  providerAffinityForCandidate,
  selectProviderRecommendationLane,
  scorePeopleAffinity,
  isSequelToken,
  matchSagaKey,
  areMatchRowsTooSimilar,
  diversifyMatchRows,
  pickMatchDeck,
  computeMatchPercent,
  mapMatchTitle,
  rankMatchCandidates,
};
