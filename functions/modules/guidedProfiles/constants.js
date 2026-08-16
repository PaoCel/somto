/**
 * Guided Profiles — costanti condivise.
 *
 * "Profili guidati" (synthetic guided profiles): account interni supervisionati
 * da Somto, marcati come sintetici e ESCLUSI da tutte le metriche reali
 * (crescita, utenti attivi, retention, voto pubblico dei titoli, leaderboard).
 *
 * Identita': uid sintetici con prefisso `guided_`, NESSUN account Firebase Auth
 * (non inquinano il conteggio utenti Auth, non scatenano i trigger di signup).
 * Tutta l'attivita' e' scritta server-side via admin SDK (bypassa le rules).
 *
 * Terminologia UI: "Profilo guidato" / "Profilo supervisionato da Somto".
 * Mai "bot" nell'interfaccia principale.
 */

const GUIDED_UID_PREFIX = "guided_";

const ACCOUNT_TYPE = Object.freeze({
  REAL: "real_user",
  GUIDED: "guided_profile",
  ADMIN_TEST: "admin_test",
});

const GUIDED_PROFILE_STATUS = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  ARCHIVED: "archived",
});

const VISIBILITY_MODE = Object.freeze({
  PRIVATE_TEST: "private_test",
  LIMITED: "limited",
  PUBLIC_GUIDED: "public_guided",
});

// Modalita' globale della feature (config admin).
const GUIDED_MODE = Object.freeze({
  OFF: "off",
  STAGING_ONLY: "staging_only",
  PRIVATE_TEST: "private_test",
  PUBLIC_GUIDED: "public_guided",
});

const CONTENT_STATUS = Object.freeze({
  DRAFT: "draft",
  APPROVED: "approved",
  REJECTED: "rejected",
  PUBLISHED: "published",
});

const ACTIVITY_LEVEL = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  DORMANT: "dormant",
});

// Probabilita' che un profilo agisca in un dato run, per livello di attivita'.
// Randomizzazione controllata: niente pattern perfetti.
const ACTIVITY_LEVEL_ACT_PROBABILITY = Object.freeze({
  high: 0.85,
  medium: 0.45,
  low: 0.18,
  dormant: 0.04,
});

// Quante azioni max un profilo prova a fare in un singolo run, per livello.
const ACTIVITY_LEVEL_MAX_ACTIONS_PER_RUN = Object.freeze({
  high: 3,
  medium: 2,
  low: 1,
  dormant: 1,
});

const ACTION_TYPE = Object.freeze({
  MARK_SEEN: "mark_seen",
  ADD_WATCHLIST: "add_watchlist",
  RATE: "rate",
  REVIEW: "review", // voto + reviewText
  POST: "post",
  COMMENT: "comment",
  REACT: "react",
});

const ALL_ACTION_TYPES = Object.freeze(Object.values(ACTION_TYPE));

// Collection / doc Firestore. Tutte deny-all ai client (solo admin SDK scrive).
const COLLECTIONS = Object.freeze({
  APP_CONFIG: "appConfig",
  CONFIG_DOC_ID: "guidedProfiles",
  GUIDED_PROFILES: "guidedProfiles",
  CONTENT_DRAFTS: "guidedContentDrafts",
  RUNS: "guidedProfileRuns",
  DM_ATTEMPTS: "guidedDmAttempts",
});

// Disclosure (bio profilo). Sempre accessibile dal profilo pubblico.
const DISCLOSURE_LONG =
  "Profilo guidato da Somto. I contenuti possono essere creati con supporto AI e " +
  "revisionati prima della pubblicazione. Questo profilo serve a testare e migliorare " +
  "recensioni, consigli e conversazioni nell'app.";

const DISCLOSURE_SHORT =
  "Profilo guidato da Somto per testare e migliorare l'esperienza nell'app. " +
  "I contenuti possono essere generati con supporto AI e supervisionati prima della pubblicazione.";

// Risposta automatica quando un utente reale scrive in DM a un profilo guidato.
const DM_AUTO_REPLY =
  "Ciao! Questo è un profilo guidato da Somto 😊 Non rappresenta una persona reale e " +
  "non riceve messaggi personali. I suoi contenuti servono a testare e migliorare " +
  "recensioni, consigli e conversazioni nell'app.";

// Config di default. Persistita in `appConfig/guidedProfiles` al primo run.
// Default SICURO per il lancio: feature spenta (`enableGuidedProfiles=false`),
// kill switch pronto. Modalita' scelta dall'utente: public_guided.
const DEFAULT_CONFIG = Object.freeze({
  enableGuidedProfiles: false,
  guidedProfilesMode: GUIDED_MODE.PUBLIC_GUIDED,
  requireHumanReview: false,
  maxActionsPerRun: 40,
  maxActionsPerProfilePerDay: 4,
  allowedActionTypes: ALL_ACTION_TYPES.slice(),
  dryRun: false,
  killSwitch: false,
  // uid di account admin/test che vedono i contenuti guidati in private_test.
  testAccountUids: [],
});

module.exports = {
  GUIDED_UID_PREFIX,
  ACCOUNT_TYPE,
  GUIDED_PROFILE_STATUS,
  VISIBILITY_MODE,
  GUIDED_MODE,
  CONTENT_STATUS,
  ACTIVITY_LEVEL,
  ACTIVITY_LEVEL_ACT_PROBABILITY,
  ACTIVITY_LEVEL_MAX_ACTIONS_PER_RUN,
  ACTION_TYPE,
  ALL_ACTION_TYPES,
  COLLECTIONS,
  DISCLOSURE_LONG,
  DISCLOSURE_SHORT,
  DM_AUTO_REPLY,
  DEFAULT_CONFIG,
};
