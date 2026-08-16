import { test, expect } from "@playwright/test";
import { defaultEmulatorConfig, e2eActor, e2eUser } from "../config.mjs";

async function enableFirebaseEmulators(page) {
  await page.addInitScript((cfg) => {
    window.__USE_FIREBASE_EMULATORS__ = true;
    window.__FIREBASE_EMULATORS__ = cfg;
    localStorage.setItem("__2WATCH_USE_FIREBASE_EMULATORS__", "1");
    localStorage.setItem("__2WATCH_FIREBASE_EMULATORS__", JSON.stringify(cfg));
  }, defaultEmulatorConfig);
}

async function loginWithSeededUser(page) {
  await page.goto("/login.html?emulators=1");
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

test("thread comments and reactions are explicit and open the right discussion", async ({ page }) => {
  await loginWithSeededUser(page);
  await page.goto("/notifications.html?emulators=1");

  const comment = page.locator('[data-open-notif="e2e-thread-comment-notification"]');
  await expect(comment).toContainText(e2eActor.displayName);
  await expect(comment).toContainText("ha scritto nel thread");
  await expect(comment).toContainText("Sono d'accordo");
  await expect(comment).toHaveAttribute("href", "/thread.html?tid=public_e2e-title");

  const reaction = page.locator('[data-open-notif="e2e-thread-reaction-notification"]');
  await expect(reaction).toContainText("ha reagito al tuo commento");
  await expect(reaction).toContainText("❤️");
  await expect(reaction).toHaveAttribute("href", "/thread.html?tid=public_e2e-title");
});
