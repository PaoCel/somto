// Simple focus trap for modals/dialogs.
// Returns a cleanup function to remove listeners and restore previous focus.
export function trapFocus(modalEl, { initialFocus, onEscape } = {}) {
  if (!modalEl) return () => {};

  const focusableSelector = [
    "a[href]",
    "button:not([disabled])",
    "textarea:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  const getFocusable = () =>
    Array.from(modalEl.querySelectorAll(focusableSelector))
      .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);

  const previouslyFocused = document.activeElement;

  const focusFirst = () => {
    const candidates = getFocusable();
    const target =
      (initialFocus && modalEl.querySelector(initialFocus)) ||
      candidates[0];
    target?.focus({ preventScroll: true });
  };

  const handleKey = (event) => {
    if (event.key === "Escape" && typeof onEscape === "function") {
      onEscape(event);
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = getFocusable();
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeInside = modalEl.contains(document.activeElement);

    if (event.shiftKey) {
      const shouldLoop = !activeInside || document.activeElement === first;
      if (shouldLoop) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
    } else {
      const shouldLoop = !activeInside || document.activeElement === last;
      if (shouldLoop) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
  };

  modalEl.addEventListener("keydown", handleKey);
  focusFirst();

  return () => {
    modalEl.removeEventListener("keydown", handleKey);
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus({ preventScroll: true });
    }
  };
}
