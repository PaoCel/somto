import { escapeHtml } from "../utils/dom.js";

function ensureToastContainer() {
  let wrap = document.getElementById("toasts");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toasts";
    document.body.appendChild(wrap);
  }
  wrap.classList.add("toast-container");
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-live", "polite");
  wrap.setAttribute("aria-atomic", "false");
  return wrap;
}

function resolveToastType(title, requestedType) {
  if (["success", "error", "warning", "info"].includes(requestedType)) return requestedType;
  const normalized = String(title || "").trim().toLowerCase();
  if (/errore|error|non riusc|riprova/.test(normalized)) return "error";
  if (/attenzione|warning|serve|conferma/.test(normalized)) return "warning";
  if (/info|assistenza|login|onboarding/.test(normalized)) return "info";
  return "success";
}

const toastIcons = {
  success: "✓",
  error: "!",
  warning: "!",
  info: "i",
};

export function toast(message, title = "Ok", { timeout = 3400, type } = {}) {
  const wrap = ensureToastContainer();
  const resolvedType = resolveToastType(title, type);

  const el = document.createElement("div");
  el.className = `toast ${resolvedType}`;
  el.setAttribute("role", resolvedType === "error" ? "alert" : "status");
  el.innerHTML = `
    <div class="toast-badge" aria-hidden="true">${toastIcons[resolvedType]}</div>
    <div class="toast-message">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-body">${escapeHtml(message)}</div>
    </div>
  `;

  wrap.appendChild(el);

  const timerId = window.setTimeout(() => {
    el.classList.add("removing");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    window.setTimeout(() => el.remove(), 350);
  }, timeout);

  el.addEventListener("click", () => {
    window.clearTimeout(timerId);
    el.classList.add("removing");
    window.setTimeout(() => el.remove(), 260);
  }, { once: true });

  return el;
}
