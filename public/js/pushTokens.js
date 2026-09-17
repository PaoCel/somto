// /js/pushTokens.js
// Registrazione token push (FCM) su richiesta esplicita dell'utente (click).
// Importante: niente requestPermission automatico, altrimenti su Safari/IOS fallisce per mancanza di "user gesture".

import { getToken } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { db, getMessagingClient } from "./firebase.js";

const VAPID_PUBLIC_KEY =
  "BPVj_TUpemDxX4xhHdGFHnCLjV01s7yx2LwGVJ9q2bGY7o9_guhIF2qgLncDFsDFVSx1jz3fZWRWUP3hTdbvW4I";

function isPushSupported() {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

export async function registerPushToken(user) {
  if (!user) return { ok: false, reason: "no-user" };

  if (!isPushSupported()) {
    console.warn("[push] Push/Notification non supportate in questo browser.");
    return { ok: false, reason: "not-supported" };
  }

  // Richiede permesso SOLO se chiamata da click
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (e) {
      console.warn("[push] requestPermission fallita (serve user gesture)", e);
      return { ok: false, reason: "permission-error" };
    }
  }

  if (permission !== "granted") {
    return { ok: false, reason: "permission-not-granted" };
  }

  try {
    const messaging = getMessagingClient();

    // Usa la registration del SW principale della PWA (service-worker.js su scope /).
    const swReg = await navigator.serviceWorker.ready;

    console.log("[push] SW ready:", swReg.active?.scriptURL, "state:", swReg.active?.state);

    // Diagnostica: controlla push subscription PRIMA di getToken
    const existingSub = await swReg.pushManager.getSubscription();
    console.log("[push] Existing push subscription BEFORE getToken:", existingSub ? "YES" : "NULL");

    const token = await getToken(messaging, {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: swReg,
    });

    if (!token) {
      console.warn("[push] Token FCM non ottenuto");
      return { ok: false, reason: "no-token" };
    }

    // Diagnostica: controlla push subscription DOPO getToken
    const newSub = await swReg.pushManager.getSubscription();
    console.log("[push] Push subscription AFTER getToken:", newSub ? "YES" : "STILL NULL (!)");
    if (newSub) {
      console.log("[push] Push endpoint:", newSub.endpoint.slice(0, 80) + "...");
    }

    const tokenRef = doc(db, "users", user.uid, "notificationTokens", token);

    await setDoc(tokenRef, {
      token,
      platform: "web",
      userAgent: navigator.userAgent,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    console.log("[push] Token FCM registrato:", token);
    return { ok: true, token };
  } catch (error) {
    console.error("[push] Errore durante registrazione token FCM", error);
    return { ok: false, reason: "exception", error };
  }
}
