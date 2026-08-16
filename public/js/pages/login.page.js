import { qs } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { runWithButtonLoading } from "../utils/loading.js";
import { toast } from "../components/toast.js";
import { onAuth, loginEmail, signupEmail, loginGoogle, loginApple, resetPassword, consumeSocialLoginRedirect } from "../services/auth.service.js";
import { ensureUserDoc, updateMyDisplayName } from "../api/users.api.js";
import { reserveDisplayNameUnique, validateDisplayName } from "../api/onboarding.api.js";
import { logEvent, setAnalyticsUser } from "../analytics.js";
import { trackProductEvent } from "../api/productAnalytics.js";
import { sanitizeInternalPath } from "../utils/url.js";
import { shouldUseRedirectAuth } from "../utils/displayMode.js";
import { mountPosterWall } from "../components/posterWall.js";

// -------------------- Muro di locandine --------------------
// Stesso componente della landing (js/components/posterWall.js): il rimando ad
// Android non e' piu' un banner da chiudere ma la nota accanto a "Gratis per
// Android* e iPhone" che porta a /android.html.
mountPosterWall(document.getElementById("authWall"), { colClass: "auth-wall-col" });

// -------------------- DOM refs --------------------
const tabLogin = qs("#tabLogin");
const tabRegister = qs("#tabRegister");

const authForm = qs("#authForm");
const authCardTitle = qs("#authCardTitle");

const emailEl = qs("#email");
const passwordEl = qs("#password");
const fieldName = qs("#fieldName");
const displayNameEl = qs("#displayName");
const fieldConfirm = qs("#fieldConfirm");
const confirmPasswordEl = qs("#confirmPassword");
const fieldTerms = qs("#fieldTerms");
const acceptTermsEl = qs("#acceptTerms");
const fieldAge = qs("#fieldAge");
const ageConfirmEl = qs("#ageConfirm");

const btnSubmit = qs("#btnSubmit");
const linkReset = qs("#linkReset");
const linkToggleMode = qs("#linkToggleMode");
const linkGoAccount = qs("#linkGoAccount");

const socialCard = qs("#socialCard");
const btnApple = qs("#btnApple");
const btnGoogle = qs("#btnGoogle");

const authMessage = qs("#authMessage");
const authHint = qs("#authHint");

const regNameError = createFieldErrorElement(displayNameEl, "regNameError");

// Sanificato a monte: blocca open redirect via ?next=//evil.com o URL assoluto.
const nextUrl = sanitizeInternalPath(new URLSearchParams(location.search).get("next") || "");

// "signIn" | "signUp" — mirrors iOS AuthMode.
// Deep-link ?signup=1 (es. dal funnel quiz guest) → apre direttamente Registrati.
const wantsSignup = ["1", "true", "signup"].includes(
  (new URLSearchParams(location.search).get("signup") || "").toLowerCase()
);
let mode = wantsSignup ? "signUp" : "signIn";

// -------------------- Mode switching --------------------
function applyMode() {
  const isSignUp = mode === "signUp";

  tabLogin?.classList.toggle("active", !isSignUp);
  tabRegister?.classList.toggle("active", isSignUp);
  tabLogin?.setAttribute("aria-selected", isSignUp ? "false" : "true");
  tabRegister?.setAttribute("aria-selected", isSignUp ? "true" : "false");

  if (authCardTitle) authCardTitle.textContent = isSignUp ? i18nT("Crea account") : i18nT("Entra in Somto");
  if (btnSubmit) btnSubmit.textContent = isSignUp ? i18nT("Crea account") : i18nT("Accedi");
  // Il segmented Accedi/Registrati non c'e' piu': si cambia modalita' da qui.
  if (linkToggleMode) {
    linkToggleMode.textContent = isSignUp ? i18nT("Accedi") : i18nT("Crea un account");
  }

  // I Termini restano visibili in entrambe le modalità: anche un login social
  // può creare un nuovo account e il consenso non deve essere un blocco muto.
  if (fieldName) fieldName.hidden = !isSignUp;
  if (fieldConfirm) fieldConfirm.hidden = !isSignUp;
  if (fieldTerms) fieldTerms.hidden = false;
  if (fieldAge) fieldAge.hidden = !isSignUp;
  if (authHint) authHint.hidden = !isSignUp;
  // Hidden required controls block native form submission in modern Chrome.
  // Keep sign-up-only fields out of validation while the user is signing in.
  if (displayNameEl) displayNameEl.disabled = !isSignUp;
  if (confirmPasswordEl) confirmPasswordEl.disabled = !isSignUp;
  if (acceptTermsEl) acceptTermsEl.disabled = false;
  if (ageConfirmEl) {
    ageConfirmEl.disabled = !isSignUp;
    ageConfirmEl.required = isSignUp;
  }

  // Sign-in only blocks
  if (linkReset) linkReset.hidden = isSignUp;
  if (socialCard) socialCard.hidden = false;

  // Autocomplete hint depends on the mode
  if (passwordEl) passwordEl.setAttribute("autocomplete", isSignUp ? "new-password" : "current-password");

  clearMessage();
}

function setMode(next) {
  if (mode === next) return;
  mode = next;
  if (passwordEl) passwordEl.value = "";
  if (confirmPasswordEl) confirmPasswordEl.value = "";
  if (ageConfirmEl) ageConfirmEl.checked = false;
  clearFieldError(displayNameEl, regNameError);
  applyMode();
}

tabLogin?.addEventListener("click", () => setMode("signIn"));
tabRegister?.addEventListener("click", () => setMode("signUp"));
linkToggleMode?.addEventListener("click", () => setMode(mode === "signIn" ? "signUp" : "signIn"));

// -------------------- Inline message card --------------------
function showMessage(text, kind) {
  if (!authMessage) return;
  authMessage.textContent = String(text || "");
  authMessage.classList.toggle("is-error", kind === "error");
  authMessage.classList.toggle("is-success", kind === "success");
  authMessage.hidden = !text;
}
function clearMessage() {
  if (!authMessage) return;
  authMessage.hidden = true;
  authMessage.textContent = "";
  authMessage.classList.remove("is-error", "is-success");
}

function requireTermsAcceptance(context = "Login") {
  if (acceptTermsEl?.checked) return true;
  const msg = i18nT("Accetta i Termini di servizio per continuare.");
  showMessage(msg, "error");
  toast(msg, context);
  fieldTerms?.classList.remove("needs-attention");
  requestAnimationFrame(() => fieldTerms?.classList.add("needs-attention"));
  fieldTerms?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => acceptTermsEl?.focus({ preventScroll: true }), 300);
  return false;
}

acceptTermsEl?.addEventListener("change", () => {
  if (!acceptTermsEl.checked) return;
  fieldTerms?.classList.remove("needs-attention");
  if (authMessage?.textContent === i18nT("Accetta i Termini di servizio per continuare.")) {
    clearMessage();
  }
});

// -------------------- Auth state --------------------
onAuth(async (user) => {
  if (user) {
    if (linkGoAccount) linkGoAccount.hidden = false;
    await ensureUserDoc(user).catch(() => {});
    void setAnalyticsUser(user);
  } else {
    if (linkGoAccount) linkGoAccount.hidden = true;
    void setAnalyticsUser(null);
  }
});

// -------------------- Submit (login or signup) --------------------
authForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  if (mode === "signUp") return handleSignup();
  return handleLogin();
});

function handleLogin() {
  if (!requireTermsAcceptance("Login")) return;
  runWithButtonLoading(btnSubmit, async () => {
    const email = (emailEl?.value || "").trim();
    const password = (passwordEl?.value || "").trim();
    if (!email || !password) {
      showMessage(i18nT("Inserisci email e password."), "error");
      return toast(i18nT("Inserisci email e password."), "Login");
    }

    try {
      const user = await loginEmail({ email, password });
      await ensureUserDoc(user);
      toast("Accesso ok. Ti porto nell’account.", "Login");
      window.location.href = (nextUrl ? nextUrl : "/account.html");
    } catch (err) {
      console.error(err);
      const msg = mapAuthError(err);
      showMessage(msg, "error");
      toast(msg, "Login");
    }
  }, { loadingLabel: "Accesso..." });
}

function handleSignup() {
  if (!requireTermsAcceptance("Registrazione")) return;
  trackProductEvent("signup_started");
  void logEvent("signup_started");
  runWithButtonLoading(btnSubmit, async () => {
    const checkedName = validateNameField({ showError: true });
    if (!checkedName.ok) {
      displayNameEl?.focus();
      const msg = checkedName.error || i18nT("Nome non valido.");
      showMessage(msg, "error");
      return toast(msg, "Registrazione");
    }
    const email = (emailEl?.value || "").trim();
    const password = (passwordEl?.value || "").trim();
    const confirmPassword = (confirmPasswordEl?.value || "").trim();
    if (!email || !password) {
      showMessage(i18nT("Inserisci email e password."), "error");
      return toast(i18nT("Inserisci email e password."), "Registrazione");
    }
    if (password !== confirmPassword) {
      showMessage(i18nT("Le password non coincidono."), "error");
      return toast(i18nT("Le password non coincidono."), "Registrazione");
    }
    if (!ageConfirmEl?.checked) {
      const msg = i18nT("Devi confermare di avere almeno 14 anni per registrarti.");
      showMessage(msg, "error");
      return toast(msg, "Registrazione");
    }

    try {
      const user = await signupEmail({
        email,
        password,
        displayName: checkedName.displayName,
      });
      await ensureUserDoc(user, { ageConfirmed: true });

      const reserved = await reservePublicDisplayName({
        uid: user.uid,
        desiredName: checkedName.displayName,
      });
      if (reserved?.autoFallback) {
        toast(i18nT("Nome pubblico aggiornato in {name}.", { name: reserved.displayName }), "Registrazione");
      }

      void logEvent("signup_completed", {
        provider: "email",
        has_display_name: true,
      });
      toast(i18nT("Account creato! Facciamo un onboarding veloce."), "Benvenuto");
      // Onboarding v2: si resta in Home, dove parte il flusso (l'atterraggio su
      // account.html diceva "sistemati il profilo" invece di "guarda cosa
      // puoi fare"). Vedi docs/ONBOARDING_V2.md.
      window.location.href = nextUrl || "/home.html";
    } catch (err) {
      console.error(err);
      const msg = mapAuthError(err);
      showMessage(msg, "error");
      toast(msg, "Registrazione");
    }
  }, { loadingLabel: "Creo..." });
}

// -------------------- Social login --------------------
async function finishSocialLogin(user, provider) {
  const ensured = await ensureUserDoc(user);
  const preferredName = ensured?.isNewUser ? inferDisplayNameForSocial(user) : null;
  if (preferredName) {
    const reserved = await reservePublicDisplayName({ uid: user.uid, desiredName: preferredName });
    if (reserved?.autoFallback) toast(i18nT("Nome pubblico impostato su {name}.", { name: reserved.displayName }), "Login");
  }
  if (ensured?.isNewUser) {
    void logEvent("signup_completed", { provider, has_display_name: Boolean(preferredName) });
    toast(i18nT("Account creato! Facciamo un onboarding veloce."), "Benvenuto");
    window.location.href = nextUrl || "/home.html";
    return;
  }
  toast(`Accesso ${provider === "apple" ? "Apple" : "Google"} ok.`, "Login");
  window.location.href = (nextUrl ? nextUrl : "/account.html");
}

btnApple?.addEventListener("click", () => {
  if (!requireTermsAcceptance(mode === "signUp" ? "Registrazione" : "Login")) return;
  runWithButtonLoading(btnApple, async () => {
    try {
      const user = await loginApple({ useRedirect: shouldUseRedirectAuth() });
      if (!user) return;
      await finishSocialLogin(user, "apple");
    } catch (err) {
      console.error(err);
      const msg = mapAuthError(err);
      showMessage(msg, "error");
      toast(msg, "Login");
    }
  }, { loadingLabel: "Attendo..." });
});

btnGoogle?.addEventListener("click", () => {
  if (!requireTermsAcceptance(mode === "signUp" ? "Registrazione" : "Login")) return;
  runWithButtonLoading(btnGoogle, async () => {
    try {
      const user = await loginGoogle({ useRedirect: shouldUseRedirectAuth() });
      if (!user) return;
      await finishSocialLogin(user, "google");
    } catch (err) {
      console.error(err);
      const msg = mapAuthError(err);
      showMessage(msg, "error");
      toast(msg, "Login");
    }
  }, { loadingLabel: "Attendo..." });
});

// -------------------- Reset password --------------------
linkReset?.addEventListener("click", async () => {
  let email = (emailEl?.value || "").trim();
  if (!email) {
    email = (prompt(i18nT("Inserisci la tua email per reimpostare la password:")) || "").trim();
    if (!email) return;
    if (emailEl) emailEl.value = email;
  }

  await runWithButtonLoading(linkReset, async () => {
    try {
      await resetPassword(email);
      const msg = i18nT("Ti abbiamo inviato il link per il reset. Controlla anche lo spam.");
      showMessage(msg, "success");
      toast(msg, i18nT("Reset password"), { type: "success" });
    } catch (err) {
      console.error(err);
      const msg = mapAuthError(err);
      showMessage(msg, "error");
      toast(msg, i18nT("Reset password"), { type: "error" });
    }
  }, { loadingLabel: i18nT("Invio...") });
});

// -------------------- Display name validation --------------------
displayNameEl?.addEventListener("input", () => {
  const raw = (displayNameEl.value || "").trim();
  if (!raw) {
    clearFieldError(displayNameEl, regNameError);
    return;
  }
  validateNameField({ showError: true });
});

displayNameEl?.addEventListener("blur", () => {
  if (mode !== "signUp") return;
  validateNameField({ showError: true });
});

function createFieldErrorElement(inputEl, id) {
  if (!inputEl) return null;
  const parent = inputEl.closest(".auth-field");
  if (!parent) return null;

  let node = parent.querySelector(`#${id}`);
  if (!node) {
    node = document.createElement("div");
    node.id = id;
    node.className = "auth-field-error";
    node.hidden = true;
    parent.appendChild(node);
  }
  inputEl.setAttribute("aria-describedby", id);
  return node;
}

function setFieldError(inputEl, errorEl, message) {
  if (!inputEl || !errorEl) return;
  const text = String(message || "").trim();
  if (!text) return clearFieldError(inputEl, errorEl);

  inputEl.classList.add("error");
  inputEl.setAttribute("aria-invalid", "true");
  errorEl.textContent = text;
  errorEl.hidden = false;
}

function clearFieldError(inputEl, errorEl) {
  if (!inputEl || !errorEl) return;
  inputEl.classList.remove("error");
  inputEl.removeAttribute("aria-invalid");
  errorEl.textContent = "";
  errorEl.hidden = true;
}

function validateNameField({ showError = false } = {}) {
  const checked = validateDisplayName((displayNameEl?.value || "").trim());
  if (checked.ok) {
    clearFieldError(displayNameEl, regNameError);
    return checked;
  }
  if (showError) {
    setFieldError(displayNameEl, regNameError, checked.error || i18nT("Nome non valido."));
  }
  return checked;
}

async function reservePublicDisplayName({ uid, desiredName }) {
  return reserveDisplayNameUnique({
    uid,
    desiredName,
  }).catch(async () => {
    await updateMyDisplayName(uid, desiredName).catch(() => {});
    return null;
  });
}

function inferDisplayNameForSocial(user) {
  const localPart = String(user?.email || "").split("@")[0] || "";
  const candidates = [
    String(user?.displayName || "").trim(),
    localPart.replace(/[._-]+/g, " ").trim(),
    "User",
  ];
  for (const raw of candidates) {
    const checked = validateDisplayName(raw);
    if (checked.ok) return checked.displayName;
  }
  return "User";
}

function mapAuthError(e){
  const code = e?.code || "";
  const message = String(e?.message || "");
  if (code.includes("invalid-display-name")) return i18nT("Nome pubblico non valido.");
  if (code.includes("display-name-taken")) return i18nT("Nome pubblico non disponibile.");
  if (code.includes("permission-denied")) return i18nT("Permessi insufficienti. Riprova dopo il login.");
  if (code.includes("auth/invalid-email")) return i18nT("Email non valida.");
  if (code.includes("auth/user-not-found")) return i18nT("Utente non trovato.");
  if (code.includes("auth/wrong-password")) return "Password errata.";
  if (code.includes("auth/account-exists-with-different-credential")) {
    return i18nT("Questa email esiste gia con un altro metodo di accesso. Entra prima con quel metodo e poi colleghiamo Apple.");
  }
  if (code.includes("auth/invalid-credential") && message.includes("invalid_client")) {
    return i18nT("Configurazione Apple non valida. Controlla Service ID, Team ID, Key ID, chiave privata e return URL Apple/Firebase.");
  }
  if (code.includes("auth/invalid-credential")) return i18nT("Credenziali non valide.");
  if (code.includes("auth/email-already-in-use")) return i18nT("Email già registrata.");
  if (code.includes("auth/weak-password")) return "Password troppo debole (min 6 caratteri).";
  if (code.includes("auth/network-request-failed")) return i18nT("Rete non disponibile. Controlla la connessione.");
  if (code.includes("auth/too-many-requests")) return i18nT("Troppi tentativi. Riprova tra poco.");
  if (code.includes("auth/popup-closed-by-user")) return i18nT("Accesso annullato prima del completamento.");
  if (code.includes("auth/popup-blocked")) return i18nT("Il browser ha bloccato il popup di accesso.");
  if (code.includes("auth/operation-not-allowed")) return i18nT("Provider non abilitato in Firebase Auth.");
  return e?.message || i18nT("Errore sconosciuto.");
}

// -------------------- Init --------------------
applyMode();
consumeSocialLoginRedirect()
  .then((result) => result?.user ? finishSocialLogin(result.user, result.provider) : null)
  .catch((err) => {
    console.error(err);
    const msg = mapAuthError(err);
    showMessage(msg, "error");
    toast(msg, "Login");
  });
