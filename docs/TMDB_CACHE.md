# TMDB backend cache (Functions)

## Obiettivo
Ridurre chiamate dirette a TMDB dal client, abbassare latenza, e gestire meglio downtime/rate-limit.

## Punto di ingresso
- Callable: `tmdbProxy` (`functions/index.js`)
- Modulo centralizzato: `functions/modules/tmdb.js` (`fetchTmdbCachedJson`)

## Strategia cache
- L1: cache in-memory per runtime Functions (best effort).
- L2: cache Firestore su collezione `tmdbCache` (`docId` hash di path+params+scope).
- Su errore TMDB/circuit open: se disponibile, ritorna cache stale (`allowStaleOnError`).

## TTL attuali
- `searchMulti`: 4 ore
- `details` (movie/tv + credits): 7 giorni
- `videos` (trailers): 12 ore
- `upcomingCinema`: 6 ore
- `upcomingStreaming` (movie+tv discover): 6 ore

## Integrazione client
`public/js/api/tmdb.api.js` usa `tmdbProxy` come default.
Fallback diretto a TMDB resta solo se:
- callable non disponibile
- e in pagina è presente una chiave client (`window.tmdbConfig.apiKey`)

## Note operative
- Il circuit breaker (`functions/lib/circuitBreaker.js`) protegge le fetch TMDB lato backend.
- Il rate limiter callable è applicato agli utenti autenticati su bucket `tmdbProxy`.
