const { createHash } = require("node:crypto");

function safeText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function safePagePath(value) {
  try {
    const pathname = new URL(String(value || "/"), "https://somto.it").pathname;
    return pathname.startsWith("/") ? pathname.slice(0, 160) : "/";
  } catch (_) {
    return "/";
  }
}

function isAlreadyExistsError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return code === "6" || code === "already-exists" || message.includes("already exists");
}

function buildClientErrorAlert({ errorId, error = {}, nowMs = Date.now() } = {}) {
  const pagePath = safePagePath(error.page);
  const fingerprintInput = [
    safeText(error.message, 500),
    safeText(error.source, 300),
    pagePath,
  ].join("\n");
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 16);
  const day = new Date(nowMs).toISOString().slice(0, 10).replaceAll("-", "");

  return {
    notificationId: `client_error_${day}_${fingerprint}`,
    fingerprint,
    pagePath,
    data: {
      fingerprint,
      pagePath,
      clientErrorId: safeText(errorId, 120),
      message: `Errore web rilevato su ${pagePath}`,
      ctaUrl: "/admin-analytics.html",
    },
  };
}

module.exports = {
  buildClientErrorAlert,
  isAlreadyExistsError,
  safePagePath,
};
