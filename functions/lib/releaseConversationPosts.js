"use strict";

const { publishOfficialUpdate, slugify } = require("./officialUpdates");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 2 * DAY_MS;
const DEFAULT_LOOKAHEAD_MS = 45 * DAY_MS;
const DEFAULT_SYNC_LIMIT = 20;
const SKIPPED_RELEASE_TYPES = new Set([5]);

const ROME_DATE_FORMATTER = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "numeric",
  month: "long",
});

function safeText(value, max = 240) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return Number(value.toMillis());
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  if (typeof value?._seconds === "number") return value._seconds * 1000;
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function releaseConversationSlug(eventId) {
  return slugify(`uscita-${safeText(eventId, 220)}`);
}

function releaseConversationPostId(eventId) {
  const slug = releaseConversationSlug(eventId);
  return slug ? `official_${slug}` : "";
}

function providerName(title = {}) {
  const names = Array.isArray(title.watchProviderNames) ? title.watchProviderNames : [];
  const direct = names.map((name) => safeText(name, 60)).find((name) => name && !/\bchannel\b/i.test(name));
  if (direct) return direct;
  const logos = Array.isArray(title.watchProviderLogos) ? title.watchProviderLogos : [];
  return logos.map((row) => safeText(row?.name, 60)).find((name) => name && !/\bchannel\b/i.test(name))
    || logos.map((row) => safeText(row?.name, 60)).find(Boolean)
    || "";
}

function movieReleasePhrase(releaseType) {
  switch (Math.floor(Number(releaseType))) {
  case 2:
  case 3:
    return "al cinema";
  case 4:
    return "in streaming";
  case 6:
    return "in TV";
  default:
    return "";
  }
}

/**
 * Converte un fatto strutturato in copy editoriale volutamente neutro nel
 * tempo: la stessa frase resta vera prima e dopo il giorno di uscita, quindi
 * una correzione aggiorna lo stesso post senza creare una seconda notizia.
 */
function buildReleaseConversationInput({ eventId, event = {}, title = {}, nowMs = Date.now() } = {}) {
  const id = safeText(eventId || event.id, 240);
  const titleId = safeText(event.titleId, 160);
  const name = safeText(title.name || title.title, 160);
  const effectiveAtMs = toMillis(event.effectiveAt);
  const eventType = safeText(event.eventType, 40);
  const mediaType = safeText(event.mediaType || title.type, 20).toLowerCase();
  const season = Math.floor(Number(event.season));
  const episode = Math.floor(Number(event.episode));

  if (!id || !titleId || !name || title.status !== "approved") return null;
  if (event.status !== "published" || event.reviewReason) return null;
  if (!Number.isFinite(effectiveAtMs)) return null;
  if (effectiveAtMs < nowMs - DEFAULT_LOOKBACK_MS || effectiveAtMs > nowMs + DEFAULT_LOOKAHEAD_MS) return null;
  if (safeText(event.sourceTrust, 40) === "unverified") return null;

  const date = ROME_DATE_FORMATTER.format(new Date(effectiveAtMs));
  let updateType;
  let headline;
  let text;

  if (eventType === "release_date" && mediaType !== "tv") {
    if (safeText(event.region, 2).toUpperCase() !== "IT") return null;
    if (SKIPPED_RELEASE_TYPES.has(Math.floor(Number(event.releaseType)))) return null;
    const destination = movieReleasePhrase(event.releaseType);
    const when = destination ? `${destination} dal ${date}` : `dal ${date}`;
    headline = `${name}: ${when}`;
    text = `${name} arriva ${when}. Lo aspettavi?`;
    updateType = "release_date";
  } else if (eventType === "new_episode" && mediaType === "tv" && episode === 1 && season >= 1) {
    const platform = providerName(title);
    // Senza un segnale di disponibilita' italiana rischieremmo di annunciare
    // stagioni di serie che qui non sono distribuite.
    if (!platform) return null;
    const where = ` su ${platform}`;
    if (season === 1) {
      headline = `${name}: dal ${date}${where}`;
      text = `${name} debutta il ${date}${where}. Ti incuriosisce?`;
    } else {
      headline = `Stagione ${season} di ${name}: dal ${date}`;
      text = `La stagione ${season} di ${name} comincia il ${date}${where}. La guarderai subito?`;
    }
    updateType = "new_season";
  } else {
    return null;
  }

  const slug = releaseConversationSlug(id);
  if (!slug) return null;
  return {
    slug,
    title: headline,
    text,
    summary: text.split("?")[0].trim().slice(0, 240),
    updateType,
    linkedTitleIds: [titleId],
    sourceUrls: [safeText(event.sourceUrl, 600)].filter(Boolean),
    status: "published",
    notificationsEnabled: false,
    sourceEventId: id,
    sourceEffectiveAt: effectiveAtMs,
  };
}

async function fetchCandidateEvents({ db, admin, nowMs, lookbackMs, lookaheadMs, perTypeLimit }) {
  const start = admin.firestore.Timestamp.fromMillis(nowMs - lookbackMs);
  const end = admin.firestore.Timestamp.fromMillis(nowMs + lookaheadMs);
  const base = (eventType) => db.collection("titleUpdateEvents")
    .where("eventType", "==", eventType)
    .where("status", "==", "published");

  const releaseQuery = base("release_date")
    .where("effectiveAt", ">=", start)
    .where("effectiveAt", "<=", end)
    .orderBy("effectiveAt", "asc")
    .limit(perTypeLimit);
  const premiereQuery = base("new_episode")
    .where("episode", "==", 1)
    .where("effectiveAt", ">=", start)
    .where("effectiveAt", "<=", end)
    .orderBy("effectiveAt", "asc")
    .limit(perTypeLimit);

  const [releases, premieres] = await Promise.all([releaseQuery.get(), premiereQuery.get()]);
  const unique = new Map(
    [...(releases.docs || []), ...(premieres.docs || [])]
      .map((doc) => [doc.id, { id: doc.id, ...(doc.data() || {}) }])
  );
  return [...unique.values()]
    .sort((left, right) => (toMillis(left.effectiveAt) || 0) - (toMillis(right.effectiveAt) || 0));
}

async function fetchByRefs(db, refs) {
  if (!refs.length) return [];
  if (typeof db.getAll === "function") return db.getAll(...refs);
  return Promise.all(refs.map((ref) => ref.get()));
}

function samePublishedConversation(existing = {}, input = {}) {
  return existing.status === "published"
    && existing.sourceEventId === input.sourceEventId
    && toMillis(existing.sourceEffectiveAt) === input.sourceEffectiveAt
    && existing.title === input.title
    && existing.text === input.text;
}

function selectBalancedConversationInputs(inputs, limit) {
  const cap = Math.max(1, Math.floor(Number(limit) || DEFAULT_SYNC_LIMIT));
  const rows = Array.isArray(inputs) ? inputs : [];
  const perKind = Math.ceil(cap / 2);
  const selected = [
    ...rows.filter((input) => input.updateType === "release_date").slice(0, perKind),
    ...rows.filter((input) => input.updateType === "new_season").slice(0, perKind),
  ];
  const selectedIds = new Set(selected.map((input) => input.sourceEventId));
  const filler = rows
    .filter((input) => !selectedIds.has(input.sourceEventId))
    .slice(0, Math.max(0, cap - selected.length));
  return [...selected, ...filler]
    .sort((left, right) => left.sourceEffectiveAt - right.sourceEffectiveAt);
}

function planConversationSync(inputs, existingBySlug, limit) {
  const existing = existingBySlug instanceof Map ? existingBySlug : new Map();
  const skipped = [];
  const pending = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (samePublishedConversation(existing.get(input.slug) || {}, input)) {
      skipped.push(input.sourceEventId);
    } else {
      pending.push(input);
    }
  }
  return {
    skipped,
    selected: selectBalancedConversationInputs(pending, limit),
  };
}

async function syncReleaseConversationPosts({
  db,
  admin,
  nowMs = Date.now(),
  lookbackMs = DEFAULT_LOOKBACK_MS,
  lookaheadMs = DEFAULT_LOOKAHEAD_MS,
  limit = DEFAULT_SYNC_LIMIT,
  publish = publishOfficialUpdate,
} = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  const cap = Math.max(1, Math.min(50, Math.floor(Number(limit) || DEFAULT_SYNC_LIMIT)));
  const events = await fetchCandidateEvents({
    db,
    admin,
    nowMs,
    lookbackMs,
    lookaheadMs,
    perTypeLimit: Math.max(cap, 20),
  });

  const titleIds = [...new Set(events.map((event) => safeText(event.titleId, 160)).filter(Boolean))];
  const titleRefs = titleIds.map((id) => db.collection("titles").doc(id));
  const titleSnaps = await fetchByRefs(db, titleRefs);
  const titles = new Map(titleSnaps.filter((snap) => snap?.exists).map((snap) => [snap.id, snap.data() || {}]));
  const eligibleInputs = events
    .map((event) => buildReleaseConversationInput({
      eventId: event.id,
      event,
      title: titles.get(event.titleId) || {},
      nowMs,
    }))
    .filter(Boolean);
  const updateRefs = eligibleInputs.map((input) => db.collection("officialUpdates").doc(input.slug));
  const updateSnaps = await fetchByRefs(db, updateRefs);
  const existingBySlug = new Map(updateSnaps.filter((snap) => snap?.exists).map((snap) => [snap.id, snap.data() || {}]));
  // Si escludono PRIMA i thread gia' allineati: applicare il cap prima di
  // questo filtro riselezionerebbe per sempre lo stesso primo batch e
  // lascerebbe la coda successiva senza post.
  const plan = planConversationSync(eligibleInputs, existingBySlug, cap);
  const inputs = plan.selected;
  const report = {
    candidates: events.length,
    eligible: eligibleInputs.length,
    selected: inputs.length,
    published: [],
    updated: [],
    skipped: plan.skipped,
    failed: [],
  };

  for (const input of inputs) {
    const existing = existingBySlug.get(input.slug) || null;
    try {
      await publish({ db, admin, input, requestedByUid: "system:title-update" });
      (existing ? report.updated : report.published).push(input.sourceEventId);
    } catch (err) {
      report.failed.push({
        eventId: input.sourceEventId,
        error: safeText(err?.message || err, 240),
      });
    }
  }

  return report;
}

module.exports = {
  DEFAULT_LOOKAHEAD_MS,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_SYNC_LIMIT,
  buildReleaseConversationInput,
  movieReleasePhrase,
  providerName,
  planConversationSync,
  releaseConversationPostId,
  releaseConversationSlug,
  selectBalancedConversationInputs,
  samePublishedConversation,
  syncReleaseConversationPosts,
  toMillis,
};
