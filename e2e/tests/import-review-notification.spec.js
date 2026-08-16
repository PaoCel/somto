import { test, expect } from "@playwright/test";
import { defaultEmulatorConfig, e2eUser } from "../config.mjs";

const EMULATOR_FLAG_KEY = "__2WATCH_USE_FIREBASE_EMULATORS__";
const EMULATOR_CONFIG_KEY = "__2WATCH_FIREBASE_EMULATORS__";

async function enableFirebaseEmulators(page) {
  await page.addInitScript(([flagKey, cfgKey, cfg]) => {
    window.__USE_FIREBASE_EMULATORS__ = true;
    window.__FIREBASE_EMULATORS__ = cfg;
    try {
      localStorage.setItem(flagKey, "1");
      localStorage.setItem(cfgKey, JSON.stringify(cfg));
    } catch (_) {}
  }, [EMULATOR_FLAG_KEY, EMULATOR_CONFIG_KEY, defaultEmulatorConfig]);
}

async function loginWithSeededUser(page) {
  await page.goto("/login.html?emulators=1");
  await expect(page.locator("#authForm")).toBeVisible();
  await page.waitForFunction(() => window.__2WATCH_EMULATORS_CONNECTED__ === true, null, {
    timeout: 20_000,
  });
  await page.fill("#email", e2eUser.email);
  await page.fill("#password", e2eUser.password);
  await page.click("#btnSubmit");
  await page.waitForURL((url) => url.pathname.endsWith("/account.html"), { timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  await enableFirebaseEmulators(page);
});

test("notification leads to the actionable import review screen", async ({ page }) => {
  await loginWithSeededUser(page);
  await page.goto("/notifications.html?emulators=1");

  const notification = page.locator('[data-open-notif="e2e-import-review-notification"]');
  await expect(notification).toBeVisible();
  await expect(notification).toContainText("Import TV Time da controllare");
  await expect(notification).toContainText("41 titoli aggiornati, 2 da controllare");
  await expect(notification).toHaveAttribute("href", "/import.html?id=e2e-import-review");

  await notification.click();
  await page.waitForURL((url) => url.pathname.endsWith("/import.html")
    && url.searchParams.get("id") === "e2e-import-review");

  await expect(page.getByRole("heading", { name: "Quasi fatto" })).toBeVisible();
  await expect(page.getByText("41 titoli sono già nel tuo profilo.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Importa i titoli trovati" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Controlla i titoli dubbi (2)" })).toBeVisible();

  await page.getByRole("button", { name: "Controlla i titoli dubbi (2)" }).click();
  await expect(page.getByRole("heading", { name: "Da confermare" })).toBeVisible();
  await expect(page.getByText("le voci ancora da decidere vengono saltate", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Conferma e salta 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Usa i suggerimenti migliori (1)" })).toHaveCount(0);
});
