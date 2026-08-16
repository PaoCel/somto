import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { app } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const getWatchProvidersCallable = httpsCallable(functions, "getWatchProviders");
const suggestWatchProviderCallable = httpsCallable(functions, "suggestWatchProvider");

export async function getWatchProviders(titleId, { region = "IT" } = {}) {
  const cleanTitleId = String(titleId || "").trim();
  if (!cleanTitleId) throw new Error("titleId mancante");

  const res = await getWatchProvidersCallable({
    titleId: cleanTitleId,
    region: String(region || "IT").trim().toUpperCase(),
  });

  return res?.data || null;
}

export async function suggestWatchProvider(titleId, payload = {}) {
  const cleanTitleId = String(titleId || "").trim();
  if (!cleanTitleId) throw new Error("titleId mancante");

  const name = String(payload?.name || "").trim();
  const url = String(payload?.url || "").trim();
  const note = String(payload?.note || "").trim();
  const region = String(payload?.region || "IT").trim().toUpperCase();

  if (!name) throw new Error("nome piattaforma mancante");

  const res = await suggestWatchProviderCallable({
    titleId: cleanTitleId,
    name,
    url,
    note,
    region,
  });

  return res?.data || { ok: false };
}

