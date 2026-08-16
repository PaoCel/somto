import { toast } from "../components/toast.js";
import { t as i18nT } from "../i18n/index.js";
import { qs } from "../utils/dom.js";
import {
  canUseAnalytics,
  getConsentState,
  grantAnalyticsConsent,
  denyOptionalConsent,
  onConsentChange,
} from "../consent.js";

const consentStatus = qs("#publicConsentStatus");
const consentAcceptBtn = qs("#publicConsentAcceptBtn");
const consentRejectBtn = qs("#publicConsentRejectBtn");

function renderConsent() {
  const state = getConsentState();
  if (consentStatus) {
    consentStatus.textContent = state.analytics
      ? i18nT("Analytics first-party attivi. Nessuna profilazione marketing attiva.")
      : i18nT("Solo strumenti necessari attivi. Analytics opzionali disattivati.");
  }
  if (consentAcceptBtn) consentAcceptBtn.disabled = canUseAnalytics();
  if (consentRejectBtn) consentRejectBtn.disabled = !canUseAnalytics() && state.source !== "unset";
}

consentAcceptBtn?.addEventListener("click", () => {
  grantAnalyticsConsent("public-consent-page");
  renderConsent();
  toast("Analytics di prodotto attivati.", "Privacy");
});

consentRejectBtn?.addEventListener("click", () => {
  denyOptionalConsent("public-consent-page");
  renderConsent();
  toast(i18nT("Restano attivi solo gli strumenti necessari."), "Privacy");
});

renderConsent();
onConsentChange(() => {
  renderConsent();
});
