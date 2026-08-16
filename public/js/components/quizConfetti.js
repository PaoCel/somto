/**
 * quizConfetti.js — Confetti leggero per la sezione Quiz (web).
 * Replica QuizConfettiView di QuizGamingKit.swift: ~36 pezzi brand-colored
 * che cadono, derivano, ruotano e svaniscono in ~1.6s. Pure CSS animations,
 * nessuna dipendenza, auto-cleanup dei nodi a fine animazione.
 */

const CONFETTI_COLORS = [
  "#E91E63", // brand-primary
  "#9C27B0", // brand-secondary
  "#F77737", // brand-warm
  "#00D9FF", // accent
  "#FFB300", // warning
  "#00E676", // success
];

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Spara una raffica di confetti dentro `host` (o in un overlay a tutto schermo).
 * @param {object} [opts]
 * @param {HTMLElement} [opts.host] - contenitore; di default un overlay fixed.
 * @param {number} [opts.pieceCount=36] - numero di pezzi.
 */
export function fireConfetti({ host = null, pieceCount = 36 } = {}) {
  // Rispetta la preferenza di movimento ridotto.
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch (_) { /* noop */ }

  let layer;
  let ownLayer = false;
  if (host instanceof HTMLElement) {
    layer = host;
  } else {
    layer = document.createElement("div");
    layer.className = "quiz-confetti";
    document.body.appendChild(layer);
    ownLayer = true;
  }

  let longest = 0;
  for (let i = 0; i < pieceCount; i += 1) {
    const piece = document.createElement("span");
    piece.className = "quiz-confetti-piece";

    const side = rand(5, 10);
    const duration = rand(1.2, 1.9);
    const delay = rand(0, 0.22);
    longest = Math.max(longest, duration + delay);

    piece.style.left = `${rand(4, 96)}%`;
    piece.style.width = `${side}px`;
    piece.style.height = `${side * rand(0.55, 1)}px`;
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.borderRadius = Math.random() > 0.5 ? "2px" : "50%";
    piece.style.setProperty("--quiz-drift", `${rand(-90, 90)}px`);
    piece.style.setProperty("--quiz-spin", `${rand(-540, 540)}deg`);
    piece.style.animationDuration = `${duration}s`;
    piece.style.animationDelay = `${delay}s`;

    layer.appendChild(piece);
  }

  // Pulizia: rimuove i nodi (e l'overlay se creato qui) a fine raffica.
  window.setTimeout(() => {
    if (ownLayer) {
      layer.remove();
    } else {
      layer.querySelectorAll(".quiz-confetti-piece").forEach((n) => n.remove());
    }
  }, Math.ceil((longest + 0.3) * 1000));
}
