/**
 * Guided Profiles — generatore di contenuti testuali.
 *
 * Adapter astratto: `generateGuidedProfileContent(...)` funziona SUBITO con
 * template/mock (nessuna API esterna) ed e' predisposto per un LLM futuro.
 *
 * LLM: NESSUNA chiave hardcodata. Se in futuro si abilita, la chiave arriva da
 * env/secret (es. `defineSecret("GUIDED_LLM_API_KEY")`) e si attiva con
 * `GUIDED_LLM_ENABLED=true`. Finche' non configurato, fallback ai template.
 *
 * Stile richiesto: realistico ma NON perfetto. Niente recensioni lunghe, niente
 * toni da comunicato stampa, niente spoiler non segnalati, niente claim del tipo
 * "sono andato al cinema ieri" (i profili non rappresentano persone reali).
 */

const LLM_ENABLED = String(process.env.GUIDED_LLM_ENABLED || "").toLowerCase() === "true";

// Banca di frasi generiche, riusabili da tutti gli archetipi.
const REVIEW_POSITIVE = [
  "Mi ha preso subito, non me l'aspettavo.",
  "Bello, anche se il finale mi ha convinto meno.",
  "Visivamente assurdo, alcune scene fortissime.",
  "Non e' il mio genere, ma capisco perche' piace cosi' tanto.",
  "Mi sono divertito piu' del previsto.",
  "Ritmo giusto, l'ho finito in un fiato.",
];

const REVIEW_MIXED = [
  "Mi aspettavo una cosa piu' lenta, invece mi ha preso subito.",
  "Alcuni dialoghi li ho trovati deboli, pero' regge.",
  "Lo devo rivedere, secondo me mi sono perso meta' delle cose.",
  "Parte bene poi si siede un po', ma vale la visione.",
  "Idee interessanti, esecuzione altalenante.",
];

const REVIEW_CRITICAL = [
  "Per me sopravvalutato, anche se alcune scene sono fortissime.",
  "Carino ma dimenticabile, niente di che.",
  "Premessa migliore dello sviluppo.",
  "Mi ha lasciato indifferente, peccato.",
  "Troppo lungo per quello che racconta.",
];

const POST_OPENERS = [
  "Stasera recupero finalmente questo.",
  "Qualcuno l'ha visto? Cerco un parere.",
  "Aggiunto in lista da troppo tempo.",
  "Rivisto dopo anni, regge ancora.",
  "Consiglio random per chi non sa cosa guardare.",
];

const COMMENT_BANK = [
  "Concordo, soprattutto sulla seconda parte.",
  "A me era piaciuto meno, ma capisco il punto.",
  "Bella, l'avevo persa, la recupero.",
  "Esatto, anche per me il finale e' la parte migliore.",
  "Vero, certe scene restano impresse.",
  "Non ci avevo pensato, buona osservazione.",
];

function pick(list, rngInt) {
  if (!list || !list.length) return "";
  const i = typeof rngInt === "number"
    ? Math.abs(rngInt) % list.length
    : Math.floor(Math.random() * list.length);
  return list[i];
}

function clamp(text, maxLength) {
  const s = String(text || "").trim();
  const cap = Number(maxLength) > 0 ? Number(maxLength) : 280;
  if (s.length <= cap) return s;
  return s.slice(0, cap - 1).trimEnd() + "…";
}

/**
 * Sceglie la banca giusta in base al voto (se presente).
 *  >= 8 -> positivo, 5-7 -> misto, <= 4 -> critico.
 */
function reviewBankForRating(rating) {
  const r = Number(rating);
  if (Number.isFinite(r)) {
    if (r >= 8) return REVIEW_POSITIVE;
    if (r <= 4) return REVIEW_CRITICAL;
    return REVIEW_MIXED;
  }
  return REVIEW_MIXED;
}

function generateFromTemplates({ persona, actionType, title, rating, seed } = {}) {
  const flavor = persona && Array.isArray(persona.flavor) ? persona.flavor : [];
  const titleName = title && (title.name || title.title) ? String(title.name || title.title) : "";

  switch (actionType) {
    case "review": {
      const base = pick(reviewBankForRating(rating), seed);
      const s = Math.abs(Number(seed) || 0);
      // ~40% recensione a due frasi: piu' "scritta", come un utente vero.
      if (s % 5 < 2) {
        const second = flavor.length && s % 2 === 0
          ? pick(flavor, seed + 1)
          : pick(reviewBankForRating(rating), seed + 7);
        if (second && second !== base) return `${base} ${second}`;
      }
      // Ogni tanto usa direttamente il flavor dell'archetipo.
      const useFlavor = flavor.length && (s % 3 === 0);
      return useFlavor ? pick(flavor, seed) : base;
    }
    case "post": {
      const opener = pick(POST_OPENERS, seed);
      return titleName ? `${opener} ${titleName}.` : opener;
    }
    case "comment":
      return pick(COMMENT_BANK, seed);
    default:
      return pick(reviewBankForRating(rating), seed);
  }
}

/**
 * Adapter LLM (placeholder). Non configurato di default: niente chiavi nel
 * codice. Quando si vorra' integrare un LLM, implementare qui leggendo la chiave
 * da env/secret e mantenendo lo stile (breve, imperfetto, no spoiler).
 */
async function generateWithLLM(_opts) {
  // Intenzionalmente non implementato: forza il fallback ai template finche'
  // non esiste un adapter reale con chiave sicura via env/secret.
  throw new Error("guided-llm-adapter-not-configured");
}

/**
 * API pubblica dell'adapter.
 * @param {object} opts
 * @param {object} opts.persona     archetipo (genres/tone/flavor)
 * @param {string} opts.actionType  "review" | "post" | "comment"
 * @param {object} [opts.title]     { id, name, ... } titolo di contesto
 * @param {object} [opts.context]   contesto extra (es. testo del post commentato)
 * @param {string} [opts.tone]      override tono
 * @param {number} [opts.rating]    voto associato (orienta il sentiment)
 * @param {number} [opts.maxLength] cap caratteri (default 280)
 * @param {number} [opts.seed]      intero per scelta deterministica (test/dry-run)
 * @returns {Promise<{text:string, source:"template"|"llm", actionType:string}>}
 */
async function generateGuidedProfileContent(opts = {}) {
  const { actionType, maxLength } = opts;
  let text = "";
  let source = "template";

  if (LLM_ENABLED) {
    try {
      text = await generateWithLLM(opts);
      source = "llm";
    } catch (_) {
      text = generateFromTemplates(opts);
      source = "template";
    }
  } else {
    text = generateFromTemplates(opts);
  }

  return { text: clamp(text, maxLength), source, actionType: String(actionType || "") };
}

module.exports = {
  LLM_ENABLED,
  generateGuidedProfileContent,
  // esportati per test
  generateFromTemplates,
  reviewBankForRating,
};
