# 2watch – Smoke & sicurezza

## Sicurezza (P0)
- **Rules**: deploy `firestore.rules` e `storage.rules` su staging, poi:
  - Tentare creazione notifica via client SDK (write su `users/{other}/notifications`) → deve fallire.
  - Tentare update thread rimuovendo un participant → deve fallire.
  - Tentare delete `peopleAvatars/*` con user non admin → deve fallire.
- **Friendship**: create pending da A→B, accetta da B; verifica che A non possa auto-accettare.

## Notifiche (P1)
- Segui un utente: l’altro riceve notifica in-app + push con link profilo.
- Richiesta amicizia: B vede `friend_request`, accetta → A vede `friend_accept`.
- Raccomandazione: crea doc in `recommendations` → destinatario vede notifica con titleId linkato.
- Mention: menziona @utente in post o commento → notifica `post_mention` con link al post.

## SEO index/home
- `index.html`: `canonical=https://2watch.it/`, indicizzabile.
- `home.html`: `noindex,follow` e canonical su `/home.html`.

## Performance quick win
- Badge notifiche: verifica che il count si aggiorni (usa query count server-side, meno read).

## Comandi utili
- Deploy userLists hardening: `npm --prefix functions run deploy`, poi `firebase deploy --only firestore:indexes`, poi `npm --prefix functions run backfill:public-user-lists` e `npm --prefix functions run backfill:public-user-lists -- --write`, poi `firebase deploy --only firestore:rules,storage`.
- Deploy rules: `firebase deploy --only firestore:rules,storage`
- Functions: `npm --prefix functions run deploy` (quando pronte altre modifiche)
