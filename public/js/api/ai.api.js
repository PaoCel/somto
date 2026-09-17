import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { app } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const recommendByTasteCallable = httpsCallable(functions, "recommendTitlesByTaste");

export async function recommendTitlesByTaste(payload = {}) {
  const res = await recommendByTasteCallable(payload);
  return res?.data || { items: [] };
}
