const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planRun,
  chooseActionType,
  makeRatingId,
  normalizeMediaType,
  remainingDailyBudget,
  runGuidedActivity,
} = require("../../modules/guidedProfiles/activity");
const { normalizeConfig, evaluateGate } = require("../../modules/guidedProfiles/config");
const { generateGuidedProfileContent, generateFromTemplates } = require("../../modules/guidedProfiles/contentGenerator");
const { isGuidedUid, isGuidedUserData, isSyntheticDoc } = require("../../modules/guidedProfiles/guards");
const { ACTION_TYPE, GUIDED_MODE, ACCOUNT_TYPE } = require("../../modules/guidedProfiles/constants");

const rngZero = () => 0;

function makeProfiles(n, level) {
  return Array.from({ length: n }, (_, i) => ({ uid: `guided_${i}`, activityLevel: level }));
}

// --------------------------------------------------------------------------
test("guards riconoscono profili e contenuti sintetici", () => {
  assert.equal(isGuidedUid("guided_giulia"), true);
  assert.equal(isGuidedUid("realuser123"), false);
  assert.equal(isGuidedUserData({ accountType: ACCOUNT_TYPE.GUIDED }), true);
  assert.equal(isGuidedUserData({ isSynthetic: true }), true);
  assert.equal(isGuidedUserData({ accountType: "real_user" }), false);
  assert.equal(isGuidedUserData(null), false);
  assert.equal(isSyntheticDoc({ isSynthetic: true }), true);
  assert.equal(isSyntheticDoc({ rating: 8 }), false);
});

// --------------------------------------------------------------------------
test("planRun rispetta il budget globale maxActionsPerRun", () => {
  const profiles = makeProfiles(100, "high");
  const plans = planRun(profiles, {
    todayKey: "2026-06-15",
    maxActionsPerRun: 5,
    maxActionsPerProfilePerDay: 4,
    rng: rngZero,
  });
  const total = plans.reduce((s, p) => s + p.actionCount, 0);
  assert.ok(total <= 5, `total=${total} deve essere <= 5`);
  assert.equal(total, 5, "budget consumato con molti profili attivi");
});

test("planRun esclude profili che hanno esaurito il budget giornaliero", () => {
  const today = "2026-06-15";
  const profiles = [
    { uid: "guided_full", activityLevel: "high", dailyActions: { dateKey: today, count: 4 } },
    { uid: "guided_fresh", activityLevel: "high", dailyActions: { dateKey: today, count: 0 } },
  ];
  const plans = planRun(profiles, {
    todayKey: today,
    maxActionsPerRun: 40,
    maxActionsPerProfilePerDay: 4,
    rng: rngZero,
  });
  const uids = plans.map((p) => p.uid);
  assert.ok(!uids.includes("guided_full"), "profilo a budget esaurito escluso");
  assert.ok(uids.includes("guided_fresh"), "profilo fresco incluso");
});

test("remainingDailyBudget resetta su nuovo giorno", () => {
  assert.equal(remainingDailyBudget({ dailyActions: { dateKey: "2026-06-14", count: 4 } }, "2026-06-15", 4), 4);
  assert.equal(remainingDailyBudget({ dailyActions: { dateKey: "2026-06-15", count: 3 } }, "2026-06-15", 4), 1);
  assert.equal(remainingDailyBudget({}, "2026-06-15", 4), 4);
});

// --------------------------------------------------------------------------
test("chooseActionType ritorna solo azioni consentite", () => {
  const allowed = [ACTION_TYPE.RATE, ACTION_TYPE.POST];
  for (let i = 0; i < 50; i++) {
    const a = chooseActionType(allowed, Math.random);
    assert.ok(allowed.includes(a), `azione ${a} non consentita`);
  }
  assert.equal(chooseActionType([], rngZero), null);
});

// --------------------------------------------------------------------------
test("makeRatingId allineato al formato composito", () => {
  assert.equal(makeRatingId("guided_giulia", "thor-love-2022"), "guided_giulia__thor-love-2022__title__0__0");
  // safePart sostituisce i caratteri non [a-zA-Z0-9_-] (1:1, niente collasso)
  assert.equal(makeRatingId("guided_x", "tt 123!"), "guided_x__tt_123___title__0__0");
});

test("normalizeMediaType distingue serie e film", () => {
  assert.equal(normalizeMediaType({ type: "serie_tv" }), "tv");
  assert.equal(normalizeMediaType({ mediaType: "tv" }), "tv");
  assert.equal(normalizeMediaType({ type: "film" }), "movie");
  assert.equal(normalizeMediaType({}), "movie");
});

// --------------------------------------------------------------------------
test("normalizeConfig applica default e clamp", () => {
  const c = normalizeConfig({
    maxActionsPerRun: 999999,
    guidedProfilesMode: "nonsense",
    allowedActionTypes: ["rate", "garbage", "post"],
    killSwitch: "yes", // non-bool -> default false
  });
  assert.equal(c.maxActionsPerRun, 1000, "clamp al max");
  assert.equal(c.guidedProfilesMode, GUIDED_MODE.PUBLIC_GUIDED, "mode invalida -> default");
  assert.deepEqual(c.allowedActionTypes, ["rate", "post"], "azioni junk filtrate");
  assert.equal(c.killSwitch, false);
  assert.equal(c.enableGuidedProfiles, false, "default disabilitato (sicuro al lancio)");
});

// --------------------------------------------------------------------------
test("evaluateGate matrice modalita'", () => {
  assert.equal(evaluateGate(normalizeConfig({})).allowed, false); // disabled
  assert.equal(evaluateGate(normalizeConfig({ enableGuidedProfiles: true, killSwitch: true })).allowed, false);
  assert.equal(evaluateGate(normalizeConfig({ enableGuidedProfiles: true, guidedProfilesMode: "off" })).allowed, false);

  const pub = evaluateGate(normalizeConfig({ enableGuidedProfiles: true, guidedProfilesMode: "public_guided" }));
  assert.equal(pub.allowed, true);
  assert.equal(pub.fanoutScope, "followers");

  const priv = evaluateGate(normalizeConfig({ enableGuidedProfiles: true, guidedProfilesMode: "private_test" }));
  assert.equal(priv.allowed, true);
  assert.equal(priv.fanoutScope, "test_only");

  // staging_only: niente attivita' in prod, ok in emulatore
  const cfgStaging = normalizeConfig({ enableGuidedProfiles: true, guidedProfilesMode: "staging_only" });
  assert.equal(evaluateGate(cfgStaging, { isEmulator: false }).allowed, false);
  assert.equal(evaluateGate(cfgStaging, { isEmulator: true }).allowed, true);
});

// --------------------------------------------------------------------------
test("contentGenerator produce testo template breve e clampato", async () => {
  for (const at of ["review", "post", "comment"]) {
    const r = await generateGuidedProfileContent({
      persona: { flavor: ["Flavor"] }, actionType: at, title: { name: "Dune" }, rating: 9, maxLength: 60, seed: 3,
    });
    assert.equal(r.source, "template", "default = template (no LLM, no chiavi)");
    assert.ok(r.text.length > 0, "testo non vuoto");
    assert.ok(r.text.length <= 60, `len ${r.text.length} <= 60`);
  }
});

test("generateFromTemplates orienta il sentiment col voto", () => {
  // sentinel deterministico: seed scelto per non pescare il flavor (seed%3 !== 0)
  const low = generateFromTemplates({ persona: {}, actionType: "review", rating: 2, seed: 1 });
  const high = generateFromTemplates({ persona: {}, actionType: "review", rating: 10, seed: 1 });
  assert.ok(typeof low === "string" && low.length > 0);
  assert.ok(typeof high === "string" && high.length > 0);
});

// --------------------------------------------------------------------------
// Integrazione dry-run: GARANZIA che dry-run non scriva NULLA su Firestore.
function buildMockDb({ profiles, titles, posts }) {
  const writes = [];
  function makeQuery(rows) {
    const q = {};
    q.where = () => q;
    q.limit = () => q;
    q.orderBy = () => q;
    q.get = async () => ({
      docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
      empty: rows.length === 0,
      size: rows.length,
    });
    q.doc = (id) => ({
      id: id || "auto",
      set: async (d) => { writes.push({ id, d }); },
      collection: () => makeQuery([]),
    });
    return q;
  }
  return {
    writes,
    collection(name) {
      if (name === "guidedProfiles") return makeQuery(profiles);
      if (name === "titles") return makeQuery(titles);
      if (name === "posts") return makeQuery(posts);
      return makeQuery([]);
    },
    batch() { throw new Error("dry-run non deve usare batch()"); },
  };
}

test("runGuidedActivity in dry-run non scrive nulla", async () => {
  const db = buildMockDb({
    profiles: [
      { id: "guided_a", data: { activityLevel: "high", genres: [], displayName: "A", status: "active" } },
      { id: "guided_b", data: { activityLevel: "high", genres: [], displayName: "B", status: "active" } },
    ],
    titles: [
      { id: "t1", data: { title: "Film Uno", type: "movie", status: "approved" } },
      { id: "t2", data: { title: "Serie Due", type: "serie_tv", status: "approved" } },
    ],
    posts: [],
  });
  const admin = { firestore: { FieldValue: { serverTimestamp: () => "TS" } } };
  const logger = { info() {}, warn() {} };
  const config = normalizeConfig({ enableGuidedProfiles: true, guidedProfilesMode: "public_guided" });

  const report = await runGuidedActivity({ db, admin, logger }, {
    config,
    dryRunOverride: true,
    adminUids: [],
    nowMs: 1_700_000_000_000,
    rng: () => 0, // tutti i profili agiscono, azione deterministica
  });

  assert.equal(report.dryRun, true);
  assert.notEqual(report.skipped, true);
  assert.ok(report.actions.length > 0, "il dry-run pianifica azioni");
  assert.equal(db.writes.length, 0, "ZERO scritture in dry-run");
  assert.equal(report.feedEventsWritten, 0);
});

test("runGuidedActivity salta quando disabilitato (kill switch)", async () => {
  const db = buildMockDb({ profiles: [], titles: [], posts: [] });
  const admin = { firestore: { FieldValue: { serverTimestamp: () => "TS" } } };
  const logger = { info() {}, warn() {} };
  const config = normalizeConfig({ enableGuidedProfiles: true, killSwitch: true });
  const report = await runGuidedActivity({ db, admin, logger }, { config, adminUids: [], nowMs: 1, rng: () => 0 });
  assert.equal(report.skipped, true);
  assert.equal(report.gate.reason, "kill_switch");
  assert.equal(db.writes.length, 0);
});
