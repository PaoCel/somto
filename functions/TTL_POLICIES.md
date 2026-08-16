# TTL Policies — Firestore (gia-visto)

Da registrare via `gcloud` o dalla Firebase Console. Le TTL sono lato server
gestite da Google: nessuna costo per il delete (al di fuori delle write
quotas standard) e nessuna lambda da scalare. Configurarle **una volta**
e poi mantenere il campo `expiresAt` valorizzato in scrittura applicativa.

## Collection con `expiresAt` (timestamp)

### `notifications.expiresAt`

Scritto da:

- `index.js:345`  — `cleanupOldNotifications`-window TTL (config corrente
  `NOTIFICATION_TTL_MS`)
- `index.js:433`  — `notifyFriendsOnRating` (engagement_friend_watched, 90gg)
- `index.js:524`  — `sendWatchlistReminders` (engagement_watchlist_reminder, 90gg)
- `index.js:625`  — `sendFriendActivityDigest` (engagement_friend_activity, 90gg)
- `index.js:936/956` — base notification helper (NOTIFICATION_TTL_MS)
- `index.js:4557` — `detectNewSeasonsForUser` (new_season_available, 30gg)
- `modules/notifications.js:4/47` — helper `expiresAtValue()`
- `scripts/notify-admin.cjs:54/71` — admin push

Quasi tutto il payload notifications ha già `expiresAt`. **Buon candidato
per TTL** — sostituisce la cleanup function esistente.

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=notifications \
  --enable-ttl \
  --project=gia-visto
```

Una volta abilitata la TTL, **valuta se rimuovere** il blocco "Cleanup
notifications" in `cleanupOldNotifications` (functions/index.js intorno
a riga 660) — diventa ridondante. Lasciare per qualche giorno entrambi
attivi così se la TTL non scatta come previsto la cleanup function fa
da rete di sicurezza.

## Collection candidate (richiedono modifica codice prima)

### `tmdbCache.expiresAtMs`

Usa **numero** in millisecondi (`expiresAtMs`), non un `Timestamp`. Le TTL
di Firestore richiedono un campo di tipo `Timestamp`. Per migrare:

1. Aggiungere `expiresAt` (Timestamp) come campo parallelo in scrittura.
2. Backfill: `scripts/backfill-tmdb-cache-expiresAt.js` (TBD).
3. Abilitare TTL su `expiresAt`.
4. In una release successiva rimuovere `cleanupTmdbCache`.

### `users/{uid}/signals` (collection group)

Cleanup attuale: `createdAt + window` in `cleanupOldNotifications` (riga 675).
Non c'è `expiresAt`. Per migrare a TTL servono:

1. Aggiungere `expiresAt = createdAt + window` in tutti i punti che scrivono
   `signals` (cercare `collection("signals").doc(` e `signals/{`).
2. Abilitare TTL via gcloud.

### `feedEvents`

Cleanup `pruneOldFeedEvents` (in `lib/feedEvents.js`) usa criteri custom
(es. mantenere ultimi N per owner). **Sconsigliato migrare a TTL**: la
logica per-owner non si esprime con la TTL.

## Comandi utili

```bash
# Lista TTL attive
gcloud firestore fields ttls list --project=gia-visto

# Disabilitare se necessario
gcloud firestore fields ttls update expiresAt \
  --collection-group=notifications \
  --disable-ttl \
  --project=gia-visto
```

## Verifica post-attivazione

Dopo aver abilitato la TTL su `notifications.expiresAt`:

```bash
# Mostra lo stato della TTL (deve essere "Active")
gcloud firestore fields ttls describe expiresAt \
  --collection-group=notifications \
  --project=gia-visto
```

I delete avvengono in batch lato Google con latenza che può arrivare a
24-72h dal momento in cui `expiresAt` è passato. Non aspettarti delete
istantanei.

## TODO

- [ ] Abilitare TTL su `notifications.expiresAt` (READY).
- [ ] Una volta confermata, rimuovere il blocco notifications da
      `cleanupOldNotifications` per evitare write doppi.
- [ ] Pianificare migrazione `tmdbCache.expiresAtMs` → `expiresAt`
      Timestamp + TTL.
- [ ] Decidere se aggiungere `expiresAt` a `signals` per migrarli a TTL.
