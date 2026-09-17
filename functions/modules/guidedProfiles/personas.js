/**
 * Guided Profiles — archetipi editoriali (personas) e pool di nomi.
 *
 * Un profilo guidato = un nome normale + un archetipo editoriale + un livello di
 * attivita'. Gli archetipi guidano generi preferiti, tono e stile dei contenuti.
 *
 * Vincoli etici:
 *  - nomi normali ma NON identita' personali realistiche o sensibili;
 *  - niente foto realistiche: avatar = iniziali (gestito dal fallback esistente);
 *  - mai fingere persone reali specifiche.
 */

// 8 archetipi dal brief prodotto. `id` stabile (usato come guidedProfilePersonaId).
const PERSONA_TEMPLATES = [
  {
    id: "drama_emotional",
    label: "Drama & comfort show",
    genres: ["Dramma", "Sentimentale", "Commedia"],
    tone: "calda e personale",
    activityBias: "high",
    // frasi-stile specifiche dell'archetipo (oltre al pool generico)
    flavor: [
      "Mi ha lasciato addosso una sensazione che non passa.",
      "Personaggi scritti benissimo, mi ci sono affezionata subito.",
    ],
  },
  {
    id: "scifi_thriller",
    label: "Sci-fi, thriller, mind-bending",
    genres: ["Fantascienza", "Thriller", "Mystery"],
    tone: "analitica, voti severi",
    activityBias: "medium",
    flavor: [
      "Premessa interessante ma la tenuta finale mi ha convinto a meta'.",
      "Concettualmente forte, l'esecuzione poteva osare di piu'.",
    ],
  },
  {
    id: "indie_european",
    label: "Indie & cinema europeo",
    genres: ["Drammatico", "Indie", "Arthouse"],
    tone: "riflessiva",
    activityBias: "low",
    flavor: [
      "Ritmo lento ma voluto, mi ha dato spazio per pensare.",
      "Non per tutti, pero' certe immagini restano.",
    ],
  },
  {
    id: "action_marvel",
    label: "Action & mainstream",
    genres: ["Azione", "Avventura", "Supereroi"],
    tone: "breve e diretta",
    activityBias: "high",
    flavor: [
      "Intrattenimento puro, due ore volate.",
      "Niente di nuovo ma fa il suo, mi sono divertito.",
    ],
  },
  {
    id: "comedy_teen",
    label: "Comedy & teen drama",
    genres: ["Commedia", "Teen", "Sentimentale"],
    tone: "leggera",
    activityBias: "medium",
    flavor: [
      "Leggera al punto giusto, perfetta per staccare.",
      "Alcune battute reggono, altre meno, ma simpatica.",
    ],
  },
  {
    id: "horror_truecrime",
    label: "Horror, mistero, true crime",
    genres: ["Horror", "Mystery", "Crime"],
    tone: "ironica",
    activityBias: "medium",
    flavor: [
      "Tensione ben gestita, un paio di salti dalla sedia.",
      "Atmosfera top, finale telefonato pero'.",
    ],
  },
  {
    id: "romance_period",
    label: "Romantico & period drama",
    genres: ["Sentimentale", "Storico", "Dramma"],
    tone: "emotiva",
    activityBias: "low",
    flavor: [
      "Costumi e fotografia da sogno, mi ha presa.",
      "Storia classica raccontata con cura.",
    ],
  },
  {
    id: "fantasy_saga",
    label: "Fantasy & saghe",
    genres: ["Fantasy", "Avventura", "Fantascienza"],
    tone: "appassionata, paragoni tra franchise",
    activityBias: "high",
    flavor: [
      "Worldbuilding curato, voglio gia' il seguito.",
      "Regge il confronto con i grandi del genere, quasi.",
    ],
  },
];

// Pool di nomi propri italiani comuni. NON cognomi: niente identita' complete.
const NAME_POOL = [
  "Giulia", "Marco", "Sara", "Luca", "Martina", "Andrea", "Elena", "Fra",
  "Chiara", "Matteo", "Alice", "Davide", "Francesca", "Simone", "Beatrice",
  "Lorenzo", "Valentina", "Riccardo", "Federica", "Tommaso", "Giorgia",
  "Stefano", "Ilaria", "Alessio", "Camilla", "Gabriele", "Aurora", "Filippo",
  "Noemi", "Edoardo", "Greta", "Pietro", "Sofia", "Nicolo", "Emma", "Diego",
  "Arianna", "Cristian", "Viola", "Mattia", "Ludovica", "Samuele", "Marta",
  "Leonardo", "Bianca", "Giacomo", "Nina", "Antonio", "Rebecca", "Paolo",
];

function personaById(id) {
  return PERSONA_TEMPLATES.find((p) => p.id === id) || null;
}

// Distribuzione livelli di attivita' richiesta dal brief, su N profili:
//  ~15% high, ~30% medium, ~55% low/dormant.
function activityLevelForIndex(index, total) {
  const ratio = total > 0 ? index / total : 0;
  if (ratio < 0.18) return "high";
  if (ratio < 0.48) return "medium";
  if (ratio < 0.78) return "low";
  return "dormant";
}

module.exports = {
  PERSONA_TEMPLATES,
  NAME_POOL,
  personaById,
  activityLevelForIndex,
};
