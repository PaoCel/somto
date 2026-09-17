# Where-to-watch (title page, regione IT)

## Backend
- Callable `getWatchProviders`:
  - input: `titleId`, `region` (default `IT`)
  - source primaria: TMDb `/movie/{id}/watch/providers` o `/tv/{id}/watch/providers`
  - cache documento: `titleProviders/{titleId}`
  - TTL app: 7 giorni (`expiresAtMs`)
  - fallback: ritorna cache stale se TMDb non disponibile

- Callable `suggestWatchProvider`:
  - richiede auth
  - rate limit bucket `watchProviderSuggestion`
  - salva suggerimenti in `titleProviders/{titleId}/suggestions/{suggestionId}` con `status: "pending"`

## Documento cache `titleProviders/{titleId}`
Campi principali:
- `titleId`, `tmdbId`, `type`, `region`
- `providers`: `flatrate`, `rent`, `buy`, `free`, `ads`, `link`
- `customAdmin`: lista suggerimenti admin (opzionale)
- `updatedAtMs`, `expiresAtMs`, `updatedAt`
- `suggestionsCount`

## Frontend
- API: `public/js/api/providers.api.js`
- UI: sezione “Dove vederlo” in `public/title.html`
- Rendering: `public/js/pages/title.page.js`
  - mostra categorie provider
  - mostra eventuali `customAdmin` (“Suggerito da admin”)
  - pulsante “Suggerisci piattaforma” per utenti autenticati
  - stato robusto quando provider assenti/non disponibili

## Attribution
La sezione include dicitura visibile: `Dati streaming forniti da TMDb / JustWatch.`
