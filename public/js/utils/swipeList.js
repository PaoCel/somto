/**
 * swipeList.js
 * Attacca swipe gestures orizzontali agli elementi .watchlist-row nel container.
 * Pattern pointer events adattato da match.page.js.
 *
 * @param {HTMLElement} container - Il contenitore della lista
 * @param {{ onSwipeRight: Function, onSwipeLeft: Function, confirmLeft: boolean }} handlers
 *   - onSwipeRight(entryId, titleId) → segna come visto
 *   - onSwipeLeft(entryId, titleId)  → rimuovi
 *   - confirmLeft: se true, chiede conferma prima di eseguire onSwipeLeft
 */
export function attachSwipeList(container, handlers) {
  if (!container) return;

  const THRESHOLD = 80;     // px per attivare l'azione
  const VISUAL_START = 20;  // px da cui inizia il feedback visivo

  let activePointer = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;
  let startMs = 0;
  let currentRow = null;
  let currentInner = null;
  let isVertical = null; // null = non ancora determinato

  function resetRow(row, inner) {
    const r = row || currentRow;
    const i = inner || currentInner;
    if (!r || !i) return;
    i.style.transition = "transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)";
    i.style.transform = "";
    r.classList.remove("swiping-left", "swiping-right");
    if (r === currentRow) {
      currentRow = null;
      currentInner = null;
    }
    isVertical = null;
  }

  function animateExit(row, inner, direction) {
    inner.style.transition = "transform 0.22s cubic-bezier(0.25, 1, 0.5, 1)";
    inner.style.transform = direction === "right" ? "translateX(110%)" : "translateX(-110%)";

    row.style.maxHeight = row.offsetHeight + "px";
    setTimeout(() => {
      row.style.transition = "max-height 0.28s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.28s";
      row.style.maxHeight = "0";
      row.style.opacity = "0";
      row.style.overflow = "hidden";
    }, 180);
  }

  function onPointerDown(ev) {
    // Solo tocco o tasto sinistro del mouse
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    // Ignora se si clicca su un pulsante o link
    if (ev.target.closest("button, a")) return;

    const row = ev.target.closest(".watchlist-row");
    if (!row || row.classList.contains("pending") || row.classList.contains("removing")) return;

    currentRow = row;
    currentInner = row.querySelector(".watchlist-row-inner");
    if (!currentInner) { currentRow = null; return; }

    activePointer = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    dx = 0;
    dy = 0;
    startMs = Date.now();
    isVertical = null;

    currentInner.style.transition = "none";
    currentRow.setPointerCapture(activePointer);
  }

  function onPointerMove(ev) {
    if (activePointer === null || ev.pointerId !== activePointer || !currentRow) return;

    dx = ev.clientX - startX;
    dy = ev.clientY - startY;

    // Determina direzione dominante al primo movimento significativo
    if (isVertical === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      isVertical = Math.abs(dy) > Math.abs(dx);
    }

    // Se è scroll verticale, non interferire
    if (isVertical) {
      resetRow();
      activePointer = null;
      return;
    }

    // Resistenza: la card si muove meno del gesto
    const move = dx * 0.85;
    currentInner.style.transform = `translateX(${move}px)`;

    // Feedback visivo sullo sfondo colorato
    if (move > VISUAL_START) {
      currentRow.classList.add("swiping-right");
      currentRow.classList.remove("swiping-left");
    } else if (move < -VISUAL_START) {
      currentRow.classList.add("swiping-left");
      currentRow.classList.remove("swiping-right");
    } else {
      currentRow.classList.remove("swiping-left", "swiping-right");
    }
  }

  async function onPointerEnd(ev) {
    if (activePointer === null || ev.pointerId !== activePointer || !currentRow) return;

    try { currentRow.releasePointerCapture(activePointer); } catch (_) {}
    activePointer = null;

    if (isVertical) { isVertical = null; return; }

    const row = currentRow;
    const inner = currentInner;
    const entryId = row.dataset.entryId;
    const titleId = row.dataset.titleId;

    // Determina azione
    let action = "";
    if (dx >= THRESHOLD && Math.abs(dx) > Math.abs(dy)) action = "right";
    else if (dx <= -THRESHOLD && Math.abs(dx) > Math.abs(dy)) action = "left";

    // Tap rapido: nessuna azione swipe (apre il link nel poster)
    if (!action) {
      resetRow();
      return;
    }

    currentRow = null;
    currentInner = null;
    isVertical = null;

    // Swipe LEFT con conferma
    if (action === "left" && handlers.confirmLeft) {
      // Tieni la card in posizione spostata (feedback visivo)
      inner.style.transition = "transform 0.15s ease-out";
      inner.style.transform = "translateX(-30%)";

      try {
        const confirmed = await handlers.onSwipeLeft(entryId, titleId);
        if (confirmed === false) {
          // Utente ha annullato → ripristina
          resetRow(row, inner);
          return;
        }
        // Confermato → anima uscita (l'handler ha già fatto la rimozione)
        animateExit(row, inner, "left");
      } catch (err) {
        console.error("swipeList handler error", err);
        resetRow(row, inner);
      }
      return;
    }

    // Swipe RIGHT o LEFT senza conferma
    animateExit(row, inner, action);

    try {
      if (action === "right" && handlers.onSwipeRight) {
        await handlers.onSwipeRight(entryId, titleId);
      } else if (action === "left" && handlers.onSwipeLeft) {
        await handlers.onSwipeLeft(entryId, titleId);
      }
    } catch (err) {
      console.error("swipeList handler error", err);
    }
  }

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove, { passive: true });
  container.addEventListener("pointerup", onPointerEnd);
  container.addEventListener("pointercancel", onPointerEnd);
}
