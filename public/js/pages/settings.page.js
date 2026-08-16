import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT, getLocale, setLocale } from "../i18n/index.js";
import { logout } from "../services/auth.service.js";
import { getMyUserDoc, setMarketingConsent, saveMyLanguage } from "../api/users.api.js";
import { exportMyData } from "../api/account.api.js";
import { requestAccountDeletion, resumeAccountDeletionAfterReauth } from "../components/accountDeletion.js";
import { toast } from "../components/toast.js";
import { setAnalyticsUser } from "../analytics.js";
import { qs, escapeHtml } from "../utils/dom.js";
import { runWithButtonLoading } from "../utils/loading.js";
import {
  canUseAnalytics,
  getConsentState,
  grantAnalyticsConsent,
  denyOptionalConsent,
  onConsentChange,
} from "../consent.js";

const settingsAvatar = qs("#settingsAvatar");
const settingsName = qs("#settingsName");
const settingsHandle = qs("#settingsHandle");
const settingsLogoutBtn = qs("#settingsLogoutBtn");
const settingsDeleteAccountBtn = qs("#settingsDeleteAccountBtn");
const consentStatus = qs("#consentStatus");
const consentAcceptBtn = qs("#consentAcceptBtn");
const consentRejectBtn = qs("#consentRejectBtn");
const marketingConsentToggle = qs("#marketingConsentToggle");
const exportDataBtn = qs("#exportDataBtn");

// Popolato in initAuthGuard.onReady: serve per persistere il toggle marketing.
let currentUid = null;

function initials(value) {
  const raw = String(value || "").trim();
  if (!raw) return "SM";
  const parts = raw.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] || "" : "";
  return `${a}${b}`.toUpperCase() || "SM";
}

function renderAvatar(photoURL, displayName) {
  if (!settingsAvatar) return;
  const photo = String(photoURL || "").trim();
  if (photo) {
    settingsAvatar.innerHTML = `<img src="${escapeHtml(photo)}" alt="Avatar" loading="lazy" decoding="async">`;
    return;
  }
  settingsAvatar.textContent = initials(displayName);
}

function renderConsent() {
  const state = getConsentState();
  if (consentStatus) {
    consentStatus.textContent = state.analytics
      ? i18nT("Analytics first-party attivi. Nessun tracking marketing abilitato.")
      : i18nT("Solo strumenti necessari attivi. Analytics opzionali disattivati.");
  }
  const analyticsOn = canUseAnalytics();
  if (consentAcceptBtn) {
    consentAcceptBtn.disabled = analyticsOn;
    consentAcceptBtn.classList.toggle("is-active", analyticsOn);   // marca esplicita la scelta corrente
  }
  if (consentRejectBtn) {
    consentRejectBtn.disabled = !analyticsOn && state.source !== "unset";
    consentRejectBtn.classList.toggle("is-active", !analyticsOn);
  }
}

consentAcceptBtn?.addEventListener("click", () => {
  grantAnalyticsConsent("settings");
  renderConsent();
  toast("Analytics di prodotto attivati.", "Privacy");
});

consentRejectBtn?.addEventListener("click", () => {
  denyOptionalConsent("settings");
  renderConsent();
  toast(i18nT("Restano attivi solo gli strumenti necessari."), "Privacy");
});

settingsLogoutBtn?.addEventListener("click", async () => {
  await runWithButtonLoading(settingsLogoutBtn, async () => {
    try {
      await logout();
      window.location.href = "/login.html";
    } catch (err) {
      console.error("settings logout error", err);
      toast(i18nT("Logout non riuscito. Riprova."), i18nT("Impostazioni"), { type: "error" });
    }
  }, { loadingLabel: i18nT("Uscita...") });
});

// Consenso marketing (email di aggiornamenti/novità). Default OFF, opt-in
// esplicito: persiste su usersPrivate/{uid}.marketingConsent.
marketingConsentToggle?.addEventListener("change", async () => {
  if (!currentUid) return;
  const enabled = Boolean(marketingConsentToggle.checked);
  marketingConsentToggle.disabled = true;
  marketingConsentToggle.setAttribute("aria-busy", "true");
  try {
    await setMarketingConsent(currentUid, enabled);
    toast(
      enabled ? "Comunicazioni email attivate." : "Comunicazioni email disattivate.",
      "Privacy"
    );
  } catch (err) {
    console.error("settings marketing consent error", err);
    marketingConsentToggle.checked = !enabled; // rollback ottimistico
    toast(i18nT("Impossibile salvare la preferenza. Riprova."), i18nT("Errore"));
  } finally {
    marketingConsentToggle.disabled = false;
    marketingConsentToggle.removeAttribute("aria-busy");
  }
});

// Export dati personali (GDPR art. 20). Richiede re-auth recente lato server,
// come l'eliminazione account.
function isReauthRequiredError(err) {
  const code = String(err?.code || "").toLowerCase();
  const message = String(err?.message || "").toLowerCase();
  return code.includes("failed-precondition") && message.includes("requires-recent-login");
}

exportDataBtn?.addEventListener("click", async () => {
  await runWithButtonLoading(exportDataBtn, async () => {
    try {
      const result = await exportMyData();
      if (result?.url) {
        window.open(result.url, "_blank", "noopener");
        toast("Export pronto: download avviato.", "Dati");
      } else {
        toast(i18nT("Export completato ma senza link di download. Riprova più tardi."), "Dati");
      }
    } catch (err) {
      console.error("settings export data error", err);
      if (isReauthRequiredError(err)) {
        toast(i18nT("Per sicurezza esci e rientra nell'account, poi riprova l'export."), i18nT("Conferma identità"));
      } else {
        toast(i18nT("Impossibile generare l'export ora. Riprova più tardi."), i18nT("Errore"), { type: "error" });
      }
    }
  }, { loadingLabel: i18nT("Preparo l'export...") });
});

// Eliminazione account (GDPR / requisito App Store). Stessa doppia conferma del
// menu Profilo (account.page.js): avviso irreversibile + digitazione di "ELIMINA".
settingsDeleteAccountBtn?.addEventListener("click", async () => {
  try {
    await requestAccountDeletion(settingsDeleteAccountBtn);
  } catch (e) {
    console.error("settings delete account error", e);
    settingsDeleteAccountBtn.disabled = false;
    toast(i18nT("Impossibile eliminare l'account ora. Riprova più tardi."), i18nT("Errore"));
  }
});

initAuthGuard({
  requireAuth: true,
  onReady: async (user) => {
    currentUid = user.uid;
    void setAnalyticsUser(user);
    const profile = await getMyUserDoc(user.uid).catch(() => null);
    const displayName = String(profile?.displayName || user.displayName || "Utente").trim();
    const handle = String(profile?.displayNameLower || user.uid || "").trim();
    const photoURL = String(profile?.photoURL || profile?.avatarURL || user.photoURL || "").trim();

    if (settingsName) settingsName.textContent = displayName;
    if (settingsHandle) settingsHandle.textContent = handle ? `@${handle}` : "@utente";
    renderAvatar(photoURL, displayName);
    renderConsent();
    // Default OFF (opt-in): rifletti lo stato salvato solo se true.
    if (marketingConsentToggle) marketingConsentToggle.checked = Boolean(profile?.marketingConsent);
    await resumeAccountDeletionAfterReauth(settingsDeleteAccountBtn).catch((err) => {
      console.error("settings deletion reauth resume error", err);
      toast(i18nT("Conferma identità non riuscita. Riprova."), i18nT("Errore"));
    });
  },
});

onConsentChange(() => {
  renderConsent();
});

/* ===== Lingua ===== */
// Il cambio lingua ricarica la pagina invece di ri-renderizzare a caldo: le
// stringhe sono gia' state scritte nel DOM da decine di funzioni diverse, e
// rifare quel giro sarebbe fragile. Un reload e' istantaneo e non lascia
// pezzi di UI nella lingua vecchia.
const languageSelect = document.getElementById("languageSelect");
if (languageSelect) {
  languageSelect.value = getLocale();
  languageSelect.addEventListener("change", () => {
    const next = setLocale(languageSelect.value);
    // Best-effort: la preferenza vale subito da localStorage; il salvataggio
    // su usersPrivate serve solo a ritrovarla su un altro dispositivo, quindi
    // un errore qui non deve bloccare il cambio lingua.
    saveMyLanguage(next).catch(() => {});
    window.location.reload();
  });
}
