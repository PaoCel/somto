# TMDB Auto Import (Cloud Function schedulata)

## Cosa fa
- Function: `importRecentTmdbTitles`
- Frequenza: `3 volte al giorno` (`0 2,10,18 * * *`, timezone `Europe/Rome`)
- Batch: default `150` nuovi titoli per run
- Fonte: TMDB discover (`movie` + `tv`) con random bias sui più recenti
- Storage: scarica locandine TMDB e le copia in `posters/system_tmdb/{type}/tmdb_{id}.{ext}`
- Firestore: salva i titoli in `titles/tmdb_{type}_{tmdbId}` con `status: "approved"`

## Limiti / protezioni API
- Gap minimo tra chiamate TMDB: `TMDB_IMPORT_MIN_REQ_GAP_MS` (default `130ms`)
- Tetto chiamate TMDB per run: `TMDB_IMPORT_MAX_API_CALLS` (default `150`)
- Retry automatico su `429` e errori transienti
- Report run salvato in:
  - `_system/tmdbAutoImport`
  - `_system/tmdbAutoImport/runs/{runId}`

## Configurazione

Zero-config: la function usa automaticamente la chiave TMDB già presente nel progetto (fallback hardcoded).

Override opzionale (priorità più alta):
1. `TMDB_API_KEY` (env var runtime)
2. `functions.config().tmdb.key` (legacy)

Parametri opzionali:
- `TMDB_IMPORT_LIMIT_PER_RUN` (default `150`)
- `TMDB_IMPORT_RECENT_PAGE_WINDOW` (default `40`)
- `TMDB_IMPORT_PAGES_PER_TYPE` (default `12`)
- `TMDB_IMPORT_MIN_REQ_GAP_MS` (default `130`)
- `TMDB_IMPORT_MAX_API_CALLS` (default `150`)

## Deploy
```bash
firebase deploy --only functions:importRecentTmdbTitles
```

## Note operative
- Il doc ID deterministico (`tmdb_movie_123`, `tmdb_tv_456`) evita duplicati.
- Se upload locandina fallisce, il titolo viene skippato (non salvato) per mantenere coerenza con il requisito “poster copiati su Storage”.
