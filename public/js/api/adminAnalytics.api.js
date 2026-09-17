import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { app } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const getPersonalAdminAnalyticsCallable = httpsCallable(functions, "getPersonalAdminAnalytics");

export async function getPersonalAdminAnalytics({ limit = 40 } = {}) {
  const res = await getPersonalAdminAnalyticsCallable({ limit });
  return res.data || {};
}
