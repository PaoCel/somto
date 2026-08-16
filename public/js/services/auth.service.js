import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  EmailAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  reauthenticateWithRedirect,
  linkWithRedirect,
  getRedirectResult,
  reload,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import { auth } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";

const APPLE_PROVIDER_ID = "apple.com";
const SOCIAL_LOGIN_REDIRECT_KEY = "__somto_social_login_redirect__";
const DELETE_REAUTH_REDIRECT_KEY = "__somto_delete_reauth_redirect__";
const APPLE_LINK_STATE_KEY = "__2WATCH_APPLE_LINK_STATE__";
const APPLE_LINK_STATE_MAX_AGE_MS = 30 * 60 * 1000;

function getAppleProvider() {
  const provider = new OAuthProvider(APPLE_PROVIDER_ID);
  provider.addScope("email");
  provider.addScope("name");
  return provider;
}

function getSessionStorageSafe() {
  try {
    return window.sessionStorage || null;
  } catch (_) {
    return null;
  }
}

function readAppleLinkState() {
  const storage = getSessionStorageSafe();
  if (!storage) return null;
  try {
    const raw = storage.getItem(APPLE_LINK_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const uid = String(parsed?.uid || "").trim();
    const startedAt = Number(parsed?.startedAt || 0);
    if (!uid) {
      storage.removeItem(APPLE_LINK_STATE_KEY);
      return null;
    }
    if (startedAt && (Date.now() - startedAt) > APPLE_LINK_STATE_MAX_AGE_MS) {
      storage.removeItem(APPLE_LINK_STATE_KEY);
      return null;
    }
    return { uid, startedAt };
  } catch (_) {
    storage.removeItem(APPLE_LINK_STATE_KEY);
    return null;
  }
}

function writeAppleLinkState(uid) {
  const storage = getSessionStorageSafe();
  if (!storage) return;
  try {
    storage.setItem(APPLE_LINK_STATE_KEY, JSON.stringify({
      uid: String(uid || "").trim(),
      startedAt: Date.now(),
    }));
  } catch (_) {}
}

function clearAppleLinkState() {
  const storage = getSessionStorageSafe();
  if (!storage) return;
  try {
    storage.removeItem(APPLE_LINK_STATE_KEY);
  } catch (_) {}
}

function buildAppleLinkError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isAppleLinkCancelledError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return code.includes("cancel")
    || code.includes("popup-closed-by-user")
    || message.includes("cancel")
    || message.includes("access_denied");
}

export function getAppleLinkErrorMessage(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (
    code.includes("auth/credential-already-in-use")
    || code.includes("auth/email-already-in-use")
    || code.includes("auth/account-exists-with-different-credential")
  ) {
    return i18nT("Questo account Apple è già associato a un altro profilo.");
  }
  if (code.includes("auth/provider-already-linked")) {
    return i18nT("Apple è già collegato a questo account.");
  }
  if (code.includes("auth/no-current-user") || code.includes("auth/user-not-found")) {
    return i18nT("Devi prima accedere al tuo account.");
  }
  if (isAppleLinkCancelledError(error)) {
    return "Operazione annullata.";
  }
  if (code.includes("auth/network-request-failed")) {
    return i18nT("Rete non disponibile. Controlla la connessione e riprova.");
  }
  if (code.includes("auth/operation-not-allowed")) {
    return i18nT("Provider Apple non abilitato in Firebase Authentication.");
  }
  if (code.includes("auth/unauthorized-domain")) {
    return i18nT("Questo dominio non è autorizzato per Sign in with Apple.");
  }
  if (code.includes("auth/invalid-credential") && message.includes("invalid_client")) {
    return i18nT("Configurazione Apple non valida. Controlla i parametri Apple e Firebase.");
  }
  return message || i18nT("Collegamento Apple non riuscito. Riprova.");
}

export function onAuth(cb){
  return onAuthStateChanged(auth, cb);
}

export function getLinkedProviderIds(user) {
  const ids = new Set();
  const rows = Array.isArray(user?.providerData) ? user.providerData : [];
  rows.forEach((row) => {
    const providerId = String(row?.providerId || "").trim();
    if (providerId) ids.add(providerId);
  });
  return Array.from(ids);
}

export function isAppleLinked(user) {
  return getLinkedProviderIds(user).includes(APPLE_PROVIDER_ID);
}

export async function reauthenticateForAccountDeletion({ useRedirect = false } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error(i18nT("Nessun account autenticato."));
  const providerIds = getLinkedProviderIds(user);
  if (providerIds.includes("password")) {
    const password = window.prompt(i18nT("Per sicurezza, inserisci di nuovo la password:"));
    if (!password) return false;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email || "", password));
    return true;
  }
  const provider = providerIds.includes(APPLE_PROVIDER_ID) ? getAppleProvider() : new GoogleAuthProvider();
  if (useRedirect) {
    getSessionStorageSafe()?.setItem(DELETE_REAUTH_REDIRECT_KEY, String(Date.now()));
    await reauthenticateWithRedirect(user, provider);
    return false;
  }
  await reauthenticateWithPopup(user, provider);
  return true;
}

export async function consumeAccountDeletionReauthRedirect() {
  const storage = getSessionStorageSafe();
  const startedAt = Number(storage?.getItem(DELETE_REAUTH_REDIRECT_KEY) || 0);
  if (!startedAt) return false;
  storage.removeItem(DELETE_REAUTH_REDIRECT_KEY);
  if (Date.now() - startedAt > 10 * 60 * 1000) return false;
  const result = await getRedirectResult(auth);
  return Boolean(result?.user || auth.currentUser);
}

export async function signupEmail({ email, password, displayName }){
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) {
    await updateProfile(cred.user, { displayName });
  }
  return cred.user;
}

export async function loginEmail({ email, password }){
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function loginGoogle({ useRedirect = false } = {}){
  const provider = new GoogleAuthProvider();
  if (useRedirect) {
    getSessionStorageSafe()?.setItem(SOCIAL_LOGIN_REDIRECT_KEY, JSON.stringify({
      provider: "google",
      startedAt: Date.now(),
    }));
    await signInWithRedirect(auth, provider);
    return null;
  }
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function consumeSocialLoginRedirect() {
  const storage = getSessionStorageSafe();
  const raw = storage?.getItem(SOCIAL_LOGIN_REDIRECT_KEY);
  if (!raw) return null;
  storage.removeItem(SOCIAL_LOGIN_REDIRECT_KEY);
  let state = null;
  try { state = JSON.parse(raw); } catch (_) {}
  if (!state?.startedAt || Date.now() - Number(state.startedAt) > 30 * 60 * 1000) return null;
  const result = await getRedirectResult(auth);
  return result?.user ? { user: result.user, provider: state.provider || "google" } : null;
}

export async function loginApple({ useRedirect = false } = {}){
  const provider = getAppleProvider();
  if (useRedirect) {
    getSessionStorageSafe()?.setItem(SOCIAL_LOGIN_REDIRECT_KEY, JSON.stringify({
      provider: "apple",
      startedAt: Date.now(),
    }));
    await signInWithRedirect(auth, provider);
    return null;
  }
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function startAppleLink(currentUser = auth.currentUser) {
  const user = currentUser || auth.currentUser;
  if (!user) {
    throw buildAppleLinkError("auth/no-current-user", i18nT("Devi prima accedere al tuo account."));
  }
  if (isAppleLinked(user)) {
    return { started: false, status: "already-linked", user };
  }
  writeAppleLinkState(user.uid);
  try {
    await linkWithRedirect(user, getAppleProvider());
  } catch (error) {
    clearAppleLinkState();
    throw error;
  }
  return { started: true, status: "redirect-started", user };
}

export async function handleAppleLinkRedirectResult(authInstance = auth) {
  const pendingState = readAppleLinkState();
  if (!pendingState) {
    return { status: "idle", message: "" };
  }

  try {
    const result = await getRedirectResult(authInstance);
    const currentUser = authInstance.currentUser || result?.user || null;
    if (currentUser) {
      await reload(currentUser).catch(() => {});
    }
    const nextUser = authInstance.currentUser || result?.user || currentUser || null;
    const currentUid = String(nextUser?.uid || "").trim();
    const uidChanged = !!pendingState.uid && !!currentUid && currentUid !== pendingState.uid;
    const appleLinked = isAppleLinked(nextUser);

    clearAppleLinkState();

    if (uidChanged) {
      return {
        status: "uid-mismatch",
        message: i18nT("Il collegamento Apple non è stato confermato sul profilo corretto."),
        expectedUid: pendingState.uid,
        currentUid,
        user: nextUser,
      };
    }

    if (appleLinked) {
      return {
        status: "success",
        message: i18nT("Apple collegato correttamente al tuo account."),
        expectedUid: pendingState.uid,
        currentUid: currentUid || pendingState.uid,
        user: nextUser,
        result,
      };
    }

    return {
      status: "cancelled",
      message: "Operazione annullata.",
      expectedUid: pendingState.uid,
      currentUid,
      user: nextUser,
      result,
    };
  } catch (error) {
    clearAppleLinkState();
    const code = String(error?.code || "");
    if (code.includes("auth/provider-already-linked")) {
      const currentUser = authInstance.currentUser || null;
      if (currentUser) {
        await reload(currentUser).catch(() => {});
      }
      return {
        status: "already-linked",
        message: i18nT("Apple è già collegato a questo account."),
        code,
        user: authInstance.currentUser || currentUser || null,
        error,
      };
    }
    return {
      status: isAppleLinkCancelledError(error) ? "cancelled" : "error",
      message: getAppleLinkErrorMessage(error),
      code,
      user: authInstance.currentUser || null,
      error,
    };
  }
}

export async function logout(){
  await signOut(auth);
}

export async function resetPassword(email){
  await sendPasswordResetEmail(auth, email);
}
