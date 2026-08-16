// Invito amici: messaggio + link unici per tutte le superfici (drawer,
// empty-state amici). Il testo copre anche il percorso Android (PWA dal
// sito) così un solo share funziona per qualunque destinatario.
import { toast } from "../components/toast.js";
import { t as i18nT } from "../i18n/index.js";

export const INVITE_URL = "https://somto.it/";
export const INVITE_MESSAGE =
  i18nT("Ti va di provare Somto con me? È il social per film e serie TV: watchlist, voti, quiz e consigli tra amici 🎬 Su iPhone è su App Store, su Android funziona come app direttamente dal sito.");

export async function shareSomtoInvite() {
  try {
    if (navigator.share) {
      await navigator.share({ title: i18nT("Somto"), text: INVITE_MESSAGE, url: INVITE_URL });
      return;
    }
  } catch (_) { /* utente ha annullato — fallback alla copia */ }
  try {
    await navigator.clipboard.writeText(`${INVITE_MESSAGE} ${INVITE_URL}`);
    toast(i18nT("Messaggio d'invito copiato negli appunti."), i18nT("Invita un amico"));
  } catch (_) {
    toast(`Copia manualmente: ${INVITE_URL}`, i18nT("Invita un amico"));
  }
}
