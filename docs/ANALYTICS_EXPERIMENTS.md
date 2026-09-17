# Analytics + Experiments (PR-006)

## Wrapper analytics
- File: `public/js/analytics.js`
- API:
  - `setAnalyticsUser(user)` per associare UID quando disponibile
  - `logEvent(name, props)` con sanificazione nome/props e fallback no-op se analytics non supportato
- Auto-enrichment:
  - Aggiunge contesto flags/experiments cache (`ff_*`, `exp_*`) se disponibile.

## Eventi minimi implementati
- `signup_completed`
- `onboarding_started`
- `onboarding_completed`
- `match_deck_loaded`
- `match_action`
- `watchlist_item_added`
- `title_opened`
- `recommendation_sent`
- `notification_opened`
- `upcoming_trailer_played`
- `thread_message_sent`

Punti principali:
- Login/Signup: `public/js/pages/login.page.js`
- Onboarding: `public/js/api/onboarding.api.js`
- Match: `public/js/pages/match.page.js`
- Watchlist: `public/js/api/watchlist.api.js`
- Titolo: `public/js/pages/title.page.js`
- Recommendation: `public/js/api/recommendations.api.js`
- Notifiche: `public/js/pages/home.page.js`
- Upcoming: `public/js/pages/upcoming.page.js`
- Thread messages: `public/js/api/threads.api.js`

## Feature flags / experiments
- File: `public/js/experiments.js`
- Fonte remota: `experiments/global` su Firestore
- Cache:
  - memoria runtime
  - `localStorage` con TTL (default 5 minuti)
- API:
  - `preloadExperiments()`
  - `isFeatureEnabled(flagKey, fallback)`
  - `getExperimentVariant(experimentKey, { fallback })`

## Esempio doc Firestore (`experiments/global`)
```json
{
  "flags": {
    "match_hide_guide": true
  },
  "experiments": {
    "match_deck_variant": {
      "enabled": true,
      "variant": "dense",
      "rollout": 50
    }
  }
}
```

## Rules
- `firestore.rules`: read pubblico solo per `experiments/global`, write solo admin.
- Test rules aggiornati in `functions/test/rules.spec.cjs` (suite `Experiments flags`).
