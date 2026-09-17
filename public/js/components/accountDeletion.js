import { deleteMyAccount } from "../api/account.api.js";
import { t as i18nT } from "../i18n/index.js";
import {
  consumeAccountDeletionReauthRedirect,
  logout,
  reauthenticateForAccountDeletion,
} from "../services/auth.service.js";
import { shouldUseRedirectAuth } from "../utils/displayMode.js";
import { toast } from "./toast.js";

function needsRecentLogin(error) {
  const value = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return value.includes("failed-precondition") || value.includes("requires-recent-login");
}

async function finishDeletion(button) {
  if (button) button.disabled = true;
  try {
    await deleteMyAccount();
    toast("Account eliminato. A presto.", i18nT("Fatto"));
    try { await logout(); } catch (_) {}
    window.location.replace("/");
    return true;
  } finally {
    if (button) button.disabled = false;
  }
}

export async function requestAccountDeletion(button) {
  const warned = window.confirm(
    i18nT("Eliminare il tuo account è IRREVERSIBILE.\n\n") +
    i18nT("Dati privati e file personali verranno cancellati; i contenuti condivisi necessari alle conversazioni saranno anonimizzati. Vuoi continuare?")
  );
  if (!warned) return false;
  // La parola di conferma DEVE passare dal dizionario come il testo che la
  // chiede: se il prompt dice "type DELETE" e il confronto resta su "ELIMINA",
  // un utente inglese digita esattamente quello che gli e' stato chiesto e
  // viene rifiutato — cioe' non riesce a cancellare il proprio account.
  const confirmWord = i18nT("ELIMINA");
  const typed = window.prompt(i18nT("Per confermare digita \"{word}\" (tutto maiuscolo):", { word: confirmWord }));
  if (String(typed || "").trim().toUpperCase() !== confirmWord.toUpperCase()) {
    toast(i18nT("Conferma non corretta. Account NON eliminato."), "Annullato");
    return false;
  }
  try {
    return await finishDeletion(button);
  } catch (error) {
    if (!needsRecentLogin(error)) throw error;
    toast(i18nT("Per sicurezza devi autenticarti di nuovo."), i18nT("Conferma identità"));
    const completed = await reauthenticateForAccountDeletion({ useRedirect: shouldUseRedirectAuth() });
    return completed ? finishDeletion(button) : false;
  }
}

export async function resumeAccountDeletionAfterReauth(button) {
  const completed = await consumeAccountDeletionReauthRedirect();
  if (!completed) return false;
  return finishDeletion(button);
}
