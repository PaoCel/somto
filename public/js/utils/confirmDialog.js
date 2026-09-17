import { t as i18nT } from "../i18n/index.js";
export function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" aria-modal="true">
        <p class="confirm-msg">${message}</p>
        <div class="confirm-actions">
          <button class="btn btn--ghost" data-confirm="cancel">${i18nT("Annulla")}</button>
          <button class="btn btn--danger" data-confirm="ok">${i18nT("Conferma")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-confirm]");
      if (!btn) return;
      overlay.remove();
      resolve(btn.dataset.confirm === "ok");
    });
    overlay.querySelector("[data-confirm='cancel']").focus();
  });
}
