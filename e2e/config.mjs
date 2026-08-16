function parsePort(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(65535, Math.trunc(n)));
}

export const emulatorHost = String(process.env.E2E_EMULATOR_HOST || "127.0.0.1").trim() || "127.0.0.1";
export const authPort = parsePort(process.env.E2E_AUTH_PORT, 59099);
export const firestorePort = parsePort(process.env.E2E_FIRESTORE_PORT, 58080);
export const storagePort = parsePort(process.env.E2E_STORAGE_PORT, 58081);
export const hostingPort = parsePort(process.env.E2E_HOSTING_PORT, 5500);
export const projectId = String(process.env.E2E_PROJECT_ID || "demo-2watch").trim() || "demo-2watch";

export const baseURL = String(process.env.E2E_BASE_URL || `http://${emulatorHost}:${hostingPort}`);

export const defaultEmulatorConfig = Object.freeze({
  host: emulatorHost,
  projectId,
  authPort,
  firestorePort,
  storagePort,
});

export const e2eUser = Object.freeze({
  uid: String(process.env.E2E_USER_UID || "e2e-user"),
  email: String(process.env.E2E_USER_EMAIL || "e2e.user@2watch.local"),
  password: String(process.env.E2E_USER_PASSWORD || "E2ePass!123"),
  displayName: String(process.env.E2E_USER_DISPLAY_NAME || "E2E User"),
});

export const e2eActor = Object.freeze({
  uid: String(process.env.E2E_ACTOR_UID || "e2e-actor"),
  email: String(process.env.E2E_ACTOR_EMAIL || "e2e.actor@2watch.local"),
  password: String(process.env.E2E_ACTOR_PASSWORD || "E2ePass!123"),
  displayName: String(process.env.E2E_ACTOR_DISPLAY_NAME || "E2E Actor"),
});
