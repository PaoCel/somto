# Resubmit App Store 1.5.0 — ESEGUITO il 2026-07-30 (~15:55)

> **Stato finale**: submission `40e437b0` re-inviata, "In attesa di verifica"
> con build `2026073001`. Video di Paolo ricompresso (H.264, 7MB, no audio) e
> caricato come `appStoreReviewAttachment` via ASC API sulle note review
> (`Somto-UGC-demo.mp4`); reply inviata dal Resolution Center. Il resto del
> documento è il runbook com'era prima dell'esecuzione, tenuto per riferimento.

Stato: rejection Guideline 1.2 (UGC) del 2026-07-29 **risolta nel codice**.
Build `1.5.0 (2026073001)` caricata, **già agganciata** alla versione in ASC
(stato "In preparazione per l'invio") e note App Review aggiornate in inglese
con l'elenco delle misure UGC. Manca UNA cosa sola, fisicamente impossibile
da remoto: lo screen recording da device reale che Apple ha chiesto
esplicitamente nella reply.

## 1. Registra il video (iPhone fisico, no simulatore)

Installa prima la build `2026073001` da TestFlight, poi registra lo schermo
(Impostazioni → Centro di Controllo → Registrazione schermo va benissimo)
con queste 3 scene di fila:

1. **EULA pre-login** — apri l'app da sloggato: schermata Accedi con il
   blocco "Accetto i Termini di servizio (EULA)"; mostra che i bottoni
   (Accedi/Apple/Google) sono disabilitati, attiva il toggle, si abilitano.
2. **Segnala** — Community → menu `⋯` su un post → "Segnala" → alert
   "Segnalazione inviata al team di moderazione."
3. **Blocca** — menu `⋯` → "Blocca utente" → conferma → il post sparisce
   subito dal feed.

## 2. Manda la reply ad Apple

ASC → Somto → Verifica dell'app → submission `40e437b0` → "Rispondi al team
di verifica delle app": allega il video e incolla questo testo:

---

Hello,

Thank you for the detailed review. We have addressed Guideline 1.2 in build 1.5.0 (2026073001):

- Terms of use (EULA) with an explicit zero-tolerance clause for objectionable content and abusive users must now be accepted BEFORE any registration or login: every sign-in method (email, Apple, Google) stays disabled until the user explicitly agrees on the auth screen. Terms: https://somto.it/terms.html
- Content filtering: a server-side automated filter now screens every new post, comment, chat message and suggestion for abusive language and files suspects to our human moderation queue, alerting the team in real time. Automated spoiler filtering and rate limits were already in place.
- Flagging: every piece of user-generated content (feed posts, post comments, chat messages, discussions, user profiles, quiz questions) has a visible "Report" action. Every report triggers an immediate in-app + push notification to the admin team.
- Blocking: users can block an author from posts, comments, chat messages and profiles. The block instantly removes all of the blocked user's content from the blocker's feed and notifies the developer team.
- We commit to acting on reports within 24 hours by removing content and ejecting offending users.

The attached screen recording, captured on a physical device, demonstrates the EULA gate, the report flow and the block flow.

Thank you!

---

## 3. Re-invia

Sulla pagina della versione 1.5.0: bottone **"Aggiorna la verifica" /
"Invia di nuovo al team di verifica"** (la build 2026073001 è già
selezionata, le note sono già salvate — non serve toccare altro).

## Contesto tecnico (per la storia)

- Il crash "invio suggerimento" era `RateLimitedCreate` `@MainActor` →
  assert di isolamento nel blocco `runTransaction` (SIGTRAP).
- Sotto il crash c'era un secondo bug: `createdAt` client-side non passa MAI
  la rule `createdAt == request.time` → suggerimenti E segnalazioni negati
  su iOS e web da quando le rules rate-limit sono live. Fix: transform
  `serverTimestamp()` (repro in `functions/test/rules-repro-suggestion.spec.cjs`).
- Dettaglio completo nel bullet 2026-07-30 di CLAUDE.md.
