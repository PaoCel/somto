# Signup verification enforcement matrix

Stato: **preparata, non attivata**. Il codice client compatibile e le callable
sono presenti nel repository, ma `SIGNUP_VERIFICATION_ENFORCEMENT` resta
`false` e l'helper Rules `isVerifiedOrLegacy()` non protegge ancora le
superfici esistenti. Qualunque deploy o cambio parametro richiede il gate
esplicito del piano signup.

## Principio di autorizzazione

Durante la migrazione una scrittura applicativa sensibile sarà consentita solo
se il token è verificato (`email_verified == true`) oppure contiene il bypass
temporaneo `legacyEmailUnverified == true`. Ownership, schema validation,
rate-limit e ruoli esistenti restano condizioni aggiuntive: il nuovo helper non
li sostituisce.

`pendingSignups/{uid}` e `users/{uid}/_system/signupAttribution` sono già
deny-all ai client nel changeset preparato. Le callable usano Admin SDK e non
dipendono dalle Rules.

## Matrice di rollout

| Slice | Collection/superficie | Read | Create | Update | Delete | Stato proposto |
|---|---|---:|---:|---:|---:|---|
| 0 | `pendingSignups`, signup attribution | deny client | deny client | deny client | deny client | Preparata, sicura da distribuire con callable |
| 1 | `users/{uid}` profilo proprio e `usernames` | invariata | verified-or-legacy + regole attuali | regole attuali; enforcement solo sui campi identità | regole attuali | Prima slice di enforcement |
| 2 | `users/{uid}/titleStates`, `ratings`, emozioni/personaggi | ownership attuale | verified-or-legacy | verified-or-legacy | verified-or-legacy | Dopo test web+iOS rating/watchlist |
| 3 | `userLists`, membership, progress e liste salvate | ACL attuale | verified-or-legacy | verified-or-legacy | verified-or-legacy | Separata per non rompere liste condivise |
| 4 | follow/friend/block, post, commenti, thread e messaggi | visibilità attuale | verified-or-legacy | verified-or-legacy | verified-or-legacy | Dopo test state machine e moderazione |
| 5 | import, support, notifiche token e azioni quiz personali | ownership attuale | callable + verified-or-legacy dove client-write | idem | idem | Ultima slice; maggiore superficie |
| 6 | letture private ad alto impatto | ownership attuale | n/a | n/a | n/a | Valutazione separata; nessun proxy generalizzato |

Le letture pubbliche di catalogo, profili minimi, blog e pagine SEO non devono
dipendere dalla verifica email. Le letture private già owner-only non vengono
ristrette nella prima finestra: bloccare subito i client legacy creerebbe un
guasto di compatibilità senza ridurre le scritture abusive.

## Migrazione e sicurezza

1. Fissare cutoff e conteggi Auth in dry-run.
2. Rivedere separatamente gli admin e gli UID esclusi.
3. Applicare `legacyEmailUnverified` in batch massimi da 50, conservando nel
   manifest esterno al repository l'intera mappa claim precedente.
4. Distribuire Functions con enforcement `false`, poi web e iOS compatibili.
5. Attendere la finestra di adozione concordata e verificare dashboard/errori.
6. Attivare il parametro in staging; eseguire matrice emulator/staging.
7. Applicare le Rules una slice alla volta, con rollback tra le slice.
8. Solo dopo approvazione ripetere in produzione.

Lo script `functions/scripts/migrate-legacy-unverified-claims.js` è dry-run per
default, non elenca email o UID nel report aggregato, preserva gli altri claim e
richiede progetto confermato più manifest esterno per scrivere. Il rollback
ripristina la mappa precedente per ogni UID.

## Rollback

- rimettere `SIGNUP_VERIFICATION_ENFORCEMENT=false` ripristina il trigger Auth
  create compatibile senza cambiare documenti;
- ripristinare la versione Rules della slice precedente riapre le sole
  scritture coinvolte;
- usare il manifest per ripristinare i claim precedenti;
- non eliminare `pendingSignups` o `accountDeletionRequests`: servono per retry,
  audit e riconciliazione;
- lasciare le callable idempotenti disponibili durante tutto il rollback.

## Gate prima dell'attivazione

- build web e iOS compatibili distribuite e adottate;
- dry-run claim rivisto, nessun admin dipendente dal bypass;
- suite Rules e Functions verde;
- test staging di password, Google, Apple, reset e cancellazione;
- dashboard distingue pending, legacy, active, auth-only e orphan;
- alert e rollback provati;
- autorizzazione esplicita per deploy/configurazione.
