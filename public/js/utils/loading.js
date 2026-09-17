// Utility to wrap async actions with a button loading state + spinner.
// Usage: await runWithButtonLoading(btn, async () => { ... });
export async function runWithButtonLoading(btn, action, { loadingLabel } = {}) {
  if (typeof action !== "function") return;
  if (!btn) return action();

  const prevHTML = btn.innerHTML;
  const prevDisabled = btn.disabled;
  const prevAriaBusy = btn.getAttribute("aria-busy");
  const prevMinWidth = btn.style.minWidth;

  const width = btn.getBoundingClientRect()?.width || btn.offsetWidth;
  if (width) btn.style.minWidth = `${Math.ceil(width)}px`;

  if (loadingLabel) {
    btn.textContent = loadingLabel;
  }
  btn.dataset.loading = "true";
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  try {
    return await action();
  } finally {
    if (loadingLabel) {
      btn.innerHTML = prevHTML;
    }
    btn.style.minWidth = prevMinWidth;
    btn.disabled = prevDisabled;
    if (prevAriaBusy !== null) {
      btn.setAttribute("aria-busy", prevAriaBusy);
    } else {
      btn.removeAttribute("aria-busy");
    }
    delete btn.dataset.loading;
  }
}
