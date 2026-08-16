export function isStandaloneApp() {
  if (typeof window === "undefined") return false;
  const displayMode = typeof window.matchMedia === "function"
    && ["standalone", "fullscreen", "minimal-ui"].some((mode) =>
      window.matchMedia(`(display-mode: ${mode})`).matches
    );
  const iosStandalone = typeof navigator !== "undefined" && navigator.standalone === true;
  const twaReferrer = typeof document !== "undefined"
    && String(document.referrer || "").startsWith("android-app://");
  return Boolean(displayMode || iosStandalone || twaReferrer);
}

export function shouldUseRedirectAuth() {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(String(navigator.userAgent || "")) && isStandaloneApp();
}
