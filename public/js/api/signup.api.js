import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { app } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const registerPendingSignupCallable = httpsCallable(functions, "registerPendingSignup");
const completeVerifiedSignupCallable = httpsCallable(functions, "completeVerifiedSignup");
const getSignupStateCallable = httpsCallable(functions, "getSignupState");

export async function registerPendingSignup(payload) {
  const result = await registerPendingSignupCallable(payload || {});
  return result.data || {};
}

export async function completeVerifiedSignup(payload = {}) {
  const result = await completeVerifiedSignupCallable(payload);
  return result.data || {};
}

export async function getSignupState() {
  const result = await getSignupStateCallable({});
  return result.data || {};
}
