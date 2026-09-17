# Feed Events (PR-007)

## Obiettivo
Ridurre merge/sort client nella home usando una sorgente server-driven append-only: `feedEvents`.

## Schema (`feedEvents/{docId}`)
- `ownerUid` (string): utente che vede l'evento nel feed.
- `actorUid` (string): utente che ha generato l'azione.
- `eventType` (string): `rating`, `post`, `post_share`, `recommendation`, `follow`, `post_comment`.
- `createdAt` (timestamp): timestamp origine evento (fallback server timestamp).
- `ingestedAt` (timestamp): timestamp ingestione trigger.
- Facoltativi: `titleId`, `postId`, `recommendationId`, `targetUid`, `rating`, `text`, `snippet`, `postKind`, `sharedPost`, `sourceId`, `sourcePath`, `eventKey`.

## Trigger che producono eventi
In `./functions/index.js`:
- `onRatingCreatedFeedEvent`
- `onPostCreatedFeedEvent`
- `onRecommendationCreatedFeedEvent`
- `onFollowCreatedFeedEvent`
- `onPostCommentCreatedFeedEvent`

Recipient strategy:
- owner = attore stesso (`actorUid`)
- + followers di `actorUid`
- + amici accettati di `actorUid`
- + destinatari extra per eventi specifici (es. `toUid` recommendation, target follow, autore post commentato)

## Query client
In `./public/js/api/feed.api.js`:
- `where("ownerUid","==",uid)`
- `orderBy("createdAt","desc")`
- `startAfter(cursorDoc)` + `limit(pageSize)`

Home (`./public/js/pages/home.page.js`):
- prova prima server feed (`feedEvents`)
- fallback automatico al feed legacy se vuoto/errore
- infinite scroll con paging server quando `feedMode === "server"`

## Rules e indici
- Rules read-only owner: `./firestore.rules`
- Index composito: `./firestore.indexes.json` (`ownerUid + createdAt desc`)
