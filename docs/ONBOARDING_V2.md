# Onboarding v2 — azioni, non spiegazioni

Sostituisce `docs/ONBOARDING_INTELLIGENTE.md` (v1: tour a slide + chooser a 3
livelli + taste picker). La v1 resta nel repo solo come storia del data model.

## Principio

L'onboarding non spiega Somto: lo fa fare. Ogni step è un'azione vera su dati
veri, con risultato immediato. Le quattro cose che devono passare sono, in
ordine: **watchlist**, **libreria del profilo (Visti)**, **seguiti**,
**commenti sui titoli**.

Corollario: chi arriva da TV Time / Trakt / Letterboxd non vuole "scegliere 8
titoli", vuole ritrovare la sua storia dentro Somto. L'import è il vero
onboarding e va **prima**, non in fondo. Il tempo di lavorazione dell'import è
il tempo in cui si fanno gli step.

## Flusso

### Ingresso — una domanda sola

> **Hai già una cronologia da portare?**
> [TV Time] [Trakt] [Letterboxd] · [Ho un export Netflix] · [No, parto da zero]

Netflix non è una provenienza, è una funzione: sta su una riga sotto, non è
pari agli altri. Trakt è in evidenza perché è OAuth, trenta secondi, zero file.

- **Sorgente scelta** → parte l'import, e appena il job è in lavorazione si
  torna al flusso: gli step girano mentre l'import macina.
- **Da zero** → gli stessi step, subito.

### Gli step

| # | Step | Azione | Salta se |
| --- | --- | --- | --- |
| 1 | Watchlist | "Salva 3 cose che vuoi vedere" — griglia popolari + ricerca, tap per salvare | mai (unico non skippabile) |
| 2 | Libreria | "E cosa hai già visto?" — stessa griglia, tap = visto | c'è un import in corso |
| 3 | Seguiti | "Segui qualcuno" — profili suggeriti, un tap ciascuno | mai |
| 4 | Commenti | atterraggio sulla scheda vera di un titolo dello step 1, commenti già popolati, campo aperto | mai |

Lo step 1 assorbe il vecchio taste picker: quei titoli restano i seed di
`tasteProfile.seedTitleIds`. Una azione, tre risultati — watchlist non vuota,
seed per i consigli, concetto capito senza spiegarlo.

Lo step 4 non chiede di scrivere. Mostra il thread pieno e il campo aperto: se
scrive bene, se non scrive ha comunque visto che esiste.

### Atterraggio

- **Con import**: Home con lo stato "sto importando, 840 di 1.240". A fine
  import, reveal *"La tua libreria è pronta: 1.240 titoli, 312 ore"* + push se
  l'app è chiusa.
- **Senza import**: Home già popolata dai titoli dello step 1 — niente empty
  state al primo avvio.

## Cosa muore

- Il tour a 3 slide "Il giro di Somto" (iOS `OnboardingWelcomeView`, web
  `tutorialTour.js`): funnel nuovo utente, auto-show utenti esistenti e replay
  da menu.
- Il chooser a 3 livelli e il gergo che espone il data model: "Livello
  Lieve/Medio/Avanzato", "Confidence 42%", "Personalizza Somto".
- Il taste picker come step separato (assorbito dallo step 1).
- Il redirect web del signup su `/account.html?onboarding=1`: si resta in Home.

Vibe, epoca, formato e anti-preferenze non spariscono dal data model: escono
dall'onboarding e diventano un "affina i consigli" nel profilo.

## Stato dati

Invariato dove possibile — si continua a scrivere `usersPrivate/{uid}`:

- `onboardingStatus.completedLevel` — 1 a flusso completato, come oggi.
- `onboardingStatus.flowVersion: 2` — distingue chi ha fatto la v2.
- `onboardingStatus.source` — `tvtime_gdpr | trakt | letterboxd | netflix_csv | none`.
- `onboardingStatus.stepsDone: string[]` — `watchlist | library | follow | comment`.
- `tasteProfile.seedTitleIds` — dallo step 1, come prima.

`tourSeenVersion` resta sui doc esistenti: non lo leggiamo più, non lo
cancelliamo (nessuna migrazione distruttiva).

## Fasi

Ogni fase è un commit separato, spedibile e reversibile da sola.

1. ✅ **iOS — scheletro**: coordinatore a step machine, schermata sorgente,
   import-first, morte del tour.
2. ✅ **iOS — step 1 e 2**: picker generalizzato con write vere su watchlist e
   `titleStates`, soglia a 3, step 2 saltato se c'è import.
3. ✅ **iOS — step 3**: seguiti, suggeriti da chi ha in libreria i titoli
   appena scelti (collection-group su `library`) con fallback sui profili più
   attivi. **Rules e indice committati ma NON deployati**: finché non lo sono,
   la query primaria fallisce in silenzio e resta solo il fallback.
4. ✅ **iOS — step 4**: atterraggio sulla scheda titolo, tab Community.
5. ✅ **iOS — avatar** dentro lo step seguiti. L'upload esisteva già
   (`UserRepository.updateProfile` + editor di ritaglio in `EditProfileView`):
   mancava solo il punto d'ingresso. Il formato è ora in `AvatarImageEncoder`,
   condiviso dai due percorsi.
6. ⬜ **iOS — atterraggio**: stato import in Home, reveal di fine import, push.
7. ✅ **Web — mirror** del flusso in `public/js/components/onboardingV2.js`,
   copy IT+EN allineata a iOS parola per parola.
8. ⬜ **Pulizia**: rimozione livelli 2/3 dal web, spostati in "affina i consigli".
   Restano anche le regole CSS `.onboarding-tour-*`, orfane da quando il tour
   è morto.

## Aperti

- **Letterboxd su iOS non esiste**: l'import nativo copre TV Time, Netflix,
  Trakt (`TitlesImportSource`). Sul web è live dal 2026-08-04 ma è lavorazione
  manuale entro 24h. In fase 1 la riga Letterboxd apre `/import.html` in-app.
- **Nome e avatar**: oggi il web li chiede, iOS mai. Servono prima dello step 3
  — si segue e si commenta *come qualcuno*. Nome dal form di registrazione,
  richiesta avatar leggera dentro lo step 3.
- **Profili suggeriti**: non esiste una query "chi seguire". Con ~360 utenti la
  scelta è una lista curata su Firestore, non un ranking.
