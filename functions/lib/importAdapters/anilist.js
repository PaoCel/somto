"use strict";

// AniList bridge for ROMAJI / fan-name anime titles the TMDB name cascade can't
// resolve. TV Time exports some anime in romaji ("Akagami no Shirayuki-hime")
// or English fan names — neither matches TMDB's official Japanese original_name
// (赤髪の白雪姫) nor its localized title, so token AND cjk similarity are both 0
// and the title stays unresolved. AniList (https://anilist.co) indexes anime BY
// ROMAJI natively, so one search maps the romaji → the native (CJK) + official
// English title + media format + year. We then feed THOSE back into the normal
// TMDB cascade (the native CJK string resolves via the char-bigram scorer; the
// format tells us movie-vs-tv). AniList only REWRITES the query — the final
// match still goes through TMDB + rankTmdbResults + the confidence threshold,
// so this adds no new false-positive surface.
//
// This is a PURE module: the network call is injected (`fetcher`) so callers
// wire it to their own throttle/cache and tests can stub it. AniList's public
// GraphQL API is unauthenticated but rate-limited (~30-90 req/min) — callers
// MUST cache + throttle (see importMatchCache / the matcher's ctx).

const ANILIST_ENDPOINT = "https://graphql.anilist.co";

// Minimal query: top few ANIME candidates with all title forms + format/year.
const ANILIST_QUERY =
  "query($s:String){Page(perPage:3){media(search:$s,type:ANIME){id idMal format seasonYear title{romaji english native}}}}";

function safeString(value, maxLen = 300) {
  return String(value ?? "").trim().slice(0, maxLen);
}

// AniList `format` -> Somto expected media type. Movies are their own type;
// everything episodic (TV/TV_SHORT/ONA/OVA/SPECIAL/MUSIC) is treated as tv.
function anilistFormatToType(format) {
  return String(format || "").toUpperCase() === "MOVIE" ? "movie" : "tv";
}

// AniList's public API is rate-limited (~30 req/min degraded, 90 normal). A
// bulk rematch of an anime-heavy library makes hundreds of calls, so we MUST
// pace them (a burst gets 429'd → empty results → titles wrongly left
// unresolved). Module-level throttle: serialize calls with a min gap, and
// retry a 429 honoring Retry-After.
// AniList currently enforces a DEGRADED 30 req/min (confirmed via
// X-RateLimit-Limit: 30). 2100ms ≈ 28/min keeps us safely under; the 429
// retry (honoring Retry-After) is the safety net if the window still trips.
const ANILIST_MIN_INTERVAL_MS = 2100;
let _anilistChain = Promise.resolve();
let _anilistLastAt = 0;

function _rawAnilistPost(search) {
  const https = require("https");
  const body = JSON.stringify({ query: ANILIST_QUERY, variables: { s: search } });
  return new Promise((resolve, reject) => {
    const req = https.request(
      ANILIST_ENDPOINT,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const retryAfter = Number(res.headers["retry-after"]);
          resolve({ status: res.statusCode, body: data, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared cooldown: when ANY call gets 429, we stamp `_blockedUntil` and EVERY
// subsequent call waits until then before firing. This makes a whole run pause
// through a rate-limit window (incl. a cold-start block left by an earlier
// burst) and resume cleanly, instead of each call independently burning its
// retries against a still-closed window and giving up empty.
let _blockedUntil = 0;
const ANILIST_MAX_ATTEMPTS = 8; // enough patience to outlast a cold-start block

// Default fetcher: throttled + shared-cooldown 429 handling. Calls are
// serialized through a promise chain so the throttle/cooldown is global.
function defaultAnilistFetcher(search) {
  const run = async () => {
    for (let attempt = 0; attempt < ANILIST_MAX_ATTEMPTS; attempt += 1) {
      // Respect BOTH the min inter-call gap AND any active rate-limit cooldown.
      const now = Date.now();
      const wait = Math.max(0, ANILIST_MIN_INTERVAL_MS - (now - _anilistLastAt), _blockedUntil - now);
      if (wait > 0) await _sleep(wait);
      _anilistLastAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const res = await _rawAnilistPost(search);
      if (res.status === 429) {
        // Cap a single wait so a bogus Retry-After can't hang the run; default
        // to a full 60s window when the header is absent.
        const waitMs = Math.min(Math.max((res.retryAfter || 60), 1), 65) * 1000 + 300;
        _blockedUntil = Date.now() + waitMs;
        continue;
      }
      try { return JSON.parse(res.body || "{}"); } catch (err) { return {}; }
    }
    return {}; // exhausted retries -> empty (caller treats as no match)
  };
  // Serialize so the throttle + cooldown are global across concurrent calls.
  const result = _anilistChain.then(run, run);
  _anilistChain = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Searches AniList for `name` and returns normalized anime candidates (best
 * first, as AniList ranks them):
 *   [{ malId, format, type, year, romaji, english, native }]
 * Empty array on no match or error (never throws — a bridge failure must not
 * break the import; the title just stays unresolved as before).
 * `fetcher(search) -> Promise<graphqlJson>` is injectable for throttle/test.
 */
async function searchAnilistAnime(name, { fetcher = defaultAnilistFetcher } = {}) {
  const query = safeString(name, 200);
  if (!query) return [];
  let json;
  try {
    json = await fetcher(query);
  } catch (err) {
    return [];
  }
  const media = json && json.data && json.data.Page && Array.isArray(json.data.Page.media) ? json.data.Page.media : [];
  return media.map((m) => {
    const t = m.title || {};
    return {
      malId: Number(m.idMal) || null,
      format: safeString(m.format, 20) || null,
      type: anilistFormatToType(m.format),
      year: Number(m.seasonYear) || null,
      romaji: safeString(t.romaji, 300) || null,
      english: safeString(t.english, 300) || null,
      native: safeString(t.native, 300) || null,
    };
  });
}

/**
 * The candidate query strings to try against TMDB for an AniList match, in
 * priority order: native (CJK — resolves via the char-bigram scorer) first,
 * then official English. De-duped, empty-filtered.
 */
function anilistQueryCandidates(candidate) {
  const out = [];
  for (const s of [candidate.native, candidate.english]) {
    const v = safeString(s, 300);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

module.exports = {
  ANILIST_ENDPOINT,
  ANILIST_QUERY,
  anilistFormatToType,
  defaultAnilistFetcher,
  searchAnilistAnime,
  anilistQueryCandidates,
};
